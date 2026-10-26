import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createHBSetup, profileStatus } from './goal-accounts.js';
import { startGoalRPC } from './goal-rpc.js';
import { acquireLock, goalFile, goalLog, readJSON, writeJSON, isGoalMonitorRunning, liveHome, fingerprint, liveAccount, processAlive } from './goal-store.js';

const workerFile = fileURLToPath(new URL('./goal-worker.js', import.meta.url));
const terminal = new Set(['blocked', 'budgetLimited', 'complete']);

export function createGoalController({ connect = startGoalRPC, isSwitching = () => false, spawnWorker = spawn, workerPath = workerFile } = {}) {
  const hbSetup = createHBSetup({ connect, isSwitching });
  const exclusive = async (fn) => {
    const release = acquireLock('command.lock');
    try { return await fn(); } finally { release(); }
  };
  const status = () => {
    const selection = readJSON(goalFile('selection.json'));
    const settings = readJSON(goalFile('settings.json'), { autoSwitch: true });
    const previous = readJSON(goalFile('state.json'));
    const saved = previous.threadId === selection.id ? previous : {};
    const running = isGoalMonitorRunning();
    return {
      ...saved, running, account: liveAccount(), autoSwitch: settings.autoSwitch !== false,
      selected: selection.id ? { id: selection.id, title: selection.title, cwd: selection.cwd, objective: selection.objective, goalStatus: saved.goalStatus || selection.goalStatus } : null,
      readyToStart: Boolean(selection.id && selection.exclusiveConfirmed),
      state: !running && ['running', 'waiting_codex', 'waiting_approval', 'starting', 'waiting_quota', 'resuming', 'switching', 'retrying'].includes(saved.state) ? 'interrupted' : saved.state || 'idle',
      execution: (() => { const e = readJSON(goalFile('execution.json')); return e.threadId === selection.id && e.runId === selection.runId ? { ...e, events: undefined } : null; })(),
      profilesReady: profileStatus().filter((p) => p.available).length >= 2,
      profiles: profileStatus(), accountSetup: hbSetup.status(),
      environment: readJSON(goalFile('environment.json'), null),
    };
  };
  const listThreads = async () => {
    const rpc = await connect(liveHome);
    try {
      const threads = [];
      let cursor;
      for (let page = 0; page < 3; page++) {
        const result = await rpc.call('thread/list', { limit: 100, sortKey: 'updated_at', sortDirection: 'desc', ...(cursor ? { cursor } : {}) }, 35000);
        threads.push(...(result.data || []));
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return threads.map((t) => ({ id: t.id, title: String(t.name || t.preview || 'Conversa sem título').replace(/[\r\n]/g, ' ').slice(0, 180), cwd: t.cwd || '', updatedAt: t.updatedAt }));
    } finally { await rpc.stop(); }
  };
  const selectGoal = (id) => exclusive(async () => {
    if (isSwitching() || isGoalMonitorRunning()) throw new Error('Pare o monitor ou aguarde a troca antes de selecionar outro Goal.');
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('ID de conversa inválido.');
    const threads = await listThreads();
    const thread = threads.find((t) => t.id === id);
    if (!thread) throw new Error('Conversa não encontrada. Atualize a lista.');
    const rpc = await connect(liveHome);
    try {
      const goal = (await rpc.call('thread/goal/get', { threadId: id })).goal;
      if (!goal) throw new Error('Esta conversa não possui um Goal persistente.');
      if (!fingerprint()) throw new Error('Login atual não reconhecido. Configure os perfis do Codex.');
      writeJSON(goalFile('selection.json'), { ...thread, fingerprint: fingerprint(), goalStatus: goal.status, objective: goal.objective });
      return { ...status(), objective: goal.objective };
    } finally { await rpc.stop(); }
  });
  const start = ({ confirmed = false } = {}) => exclusive(async () => {
    if (isSwitching()) throw new Error('Aguarde a troca de conta terminar.');
    if (isGoalMonitorRunning()) return status();
    const selection = readJSON(goalFile('selection.json'));
    if (!selection.id) throw new Error('Abra Goals e selecione uma conversa primeiro.');
    if (!confirmed && !selection.exclusiveConfirmed) throw new Error('Confirme no painel Goals que a execução foi encerrada nas outras interfaces.');
    if (!fingerprint()) throw new Error('Login atual não reconhecido.');
    const current = status();
    if (current.autoSwitch && (!current.profilesReady || !liveAccount())) throw new Error('Configure pelo menos duas contas diferentes entre Jey, Americano e HB antes de ativar a troca automática.');
    // A deliberate new start may use the account currently selected by the
    // user, but cooldowns remain in their separate persistent ledger.
    selection.fingerprint = fingerprint();
    selection.exclusiveConfirmed = true;
    const rpc = await connect(liveHome);
    let goal;
    try { goal = (await rpc.call('thread/goal/get', { threadId: selection.id })).goal; }
    finally { await rpc.stop(); }
    if (!goal) throw new Error('Esta conversa não possui um Goal persistente.');
    if (terminal.has(goal.status)) throw new Error('Goal em ' + goal.status + '. Confira os detalhes ou crie um novo Goal.');
    selection.resumePaused = goal.status === 'paused'; // One explicit click, never a later automatic unpause.
    selection.goalStatus = goal.status;
    selection.objective = goal.objective || selection.objective;
    selection.resumeVersion = goal.updatedAt;
    selection.runId = crypto.randomUUID();
    writeJSON(goalFile('selection.json'), selection);
    for (const name of ['stop', 'worker-ready']) { try { fs.unlinkSync(goalFile(name)); } catch {} }
    const child = spawnWorker(process.execPath, [workerPath], { detached: true, windowsHide: true, stdio: 'ignore', env: process.env });
    let spawnError;
    child.on('error', (error) => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error('Não foi possível iniciar o monitor: ' + spawnError.message);
      if (fs.existsSync(goalFile('worker-ready')) && Number(fs.readFileSync(goalFile('worker-ready'), 'utf8')) === child.pid) return status();
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (child.pid && !processAlive(child.pid)) throw new Error('O processo do monitor encerrou. Consulte os logs no painel.');
    }
    // Leave a live worker alone; never spawn a second one after a timeout.
    if (isGoalMonitorRunning()) return status();
    throw new Error('O monitor não confirmou a inicialização. Consulte os logs.');
  });
  const stop = () => exclusive(async () => {
    fs.mkdirSync(path.dirname(goalFile('stop')), { recursive: true });
    fs.writeFileSync(goalFile('stop'), new Date().toISOString());
    return { ...status(), stopRequested: true };
  });
  const setAutomatic = (autoSwitch) => exclusive(async () => {
    if (typeof autoSwitch !== 'boolean') throw new Error('Opção de troca automática inválida.');
    if (['switching', 'resuming'].includes(status().state) && isGoalMonitorRunning()) throw new Error('Aguarde a troca ou retomada terminar antes de alterar essa opção.');
    if (autoSwitch && !status().profilesReady) throw new Error('Configure pelo menos duas contas com logins diferentes.');
    writeJSON(goalFile('settings.json'), { autoSwitch });
    return status();
  });
  const logs = () => {
    const read = (file) => { try { return fs.readFileSync(goalFile(file), 'utf8').slice(-120000); } catch { return ''; } };
    return (read('execution.log') + '\n\n--- Diagnóstico do controlador ---\n' + read('monitor.log')).trim() || 'Nenhum evento da execução ainda.';
  };
  const createGoal = (payload) => exclusive(async () => {
    if (isSwitching() || isGoalMonitorRunning()) throw new Error('Pause a execução atual antes de criar outro Goal.');
    const objective = String(payload.objective || '').trim();
    const cwd = String(payload.cwd || '').trim();
    if (!objective || objective.length > 16000) throw new Error('Informe um objetivo de até 16000 caracteres.');
    if (!path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Informe o caminho completo de uma pasta existente no PC.');
    const rpc = await connect(liveHome);
    try {
      const { thread } = await rpc.call('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' }, 50000);
      if (!thread?.id) throw new Error('O CLI não criou a conversa.');
      await rpc.call('thread/goal/set', { threadId: thread.id, objective, status: 'paused', origin: 'user' });
      writeJSON(goalFile('selection.json'), { id: thread.id, title: objective.slice(0, 180), cwd, objective, goalStatus: 'paused', fingerprint: fingerprint(), exclusiveConfirmed: true });
      goalLog('create', 'Goal criado pelo painel; aguardando clique em Executar.');
      return status();
    } finally { await rpc.stop(); }
  });
  const execution = () => {
    const selection = readJSON(goalFile('selection.json'));
    const value = readJSON(goalFile('execution.json'));
    return value.threadId === selection.id && value.runId === selection.runId ? value : { events: [], pending: [], threadId: selection.id };
  };
  const decide = (payload) => exclusive(async () => {
    const value = execution();
    if (!isGoalMonitorRunning() || value.runId !== payload.runId || !value.pending.some((p) => String(p.id) === String(payload.id))) throw new Error('Solicitação expirada. Atualize o painel.');
    if (!['accept', 'decline', 'answer'].includes(payload.decision)) throw new Error('Decisão inválida.');
    writeJSON(goalFile('decision.json'), { runId: value.runId, id: payload.id, decision: payload.decision, answers: payload.answers });
    return { queued: true };
  });
  const confirmSelection = (payload) => exclusive(async () => {
    const selection = readJSON(goalFile('selection.json'));
    if (isGoalMonitorRunning() || selection.id !== payload.threadId || typeof payload.confirmed !== 'boolean') throw new Error('Seleção alterada ou execução já iniciada. Atualize o painel.');
    selection.exclusiveConfirmed = payload.confirmed;
    writeJSON(goalFile('selection.json'), selection);
    return status();
  });
  const setupSandbox = (payload) => exclusive(async () => {
    if (payload.confirmed !== true || process.platform !== 'win32') throw new Error('Confirme a preparação do isolamento no Windows.');
    if (isGoalMonitorRunning()) throw new Error('Pause a execução antes de preparar o ambiente do CLI.');
    let completed;
    const rpc = await connect(liveHome, { onGlobalNotification: (method, result) => { if (method === 'windowsSandbox/setupCompleted') completed = result; } });
    try {
      await rpc.call('windowsSandbox/setupStart', { mode: 'elevated' });
      const deadline = Date.now() + 90000;
      while (!completed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
      const result = { at: Date.now(), success: completed?.success === true, error: completed?.error || (!completed ? 'A preparação não confirmou o resultado. Verifique a janela do Windows.' : null) };
      writeJSON(goalFile('environment.json'), result);
      goalLog('windows-setup', result.success ? 'Preparação do sandbox concluída.' : result.error);
      if (!result.success) throw new Error(result.error || 'Falha na preparação do sandbox.');
      return result;
    } finally { await rpc.stop(); }
  });
  return { status, listThreads, selectGoal, start, stop, setAutomatic, logs, execution, decide, createGoal, confirmSelection, setupSandbox, connectHB: hbSetup.start, cancelHB: hbSetup.cancel };
}
