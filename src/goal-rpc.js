import { spawn } from 'node:child_process';
import { codexSpawnTarget } from './codex.js';
import { redactExecutionText } from './goal-events.js';

export function goalSpawnArgs(target) {
  return target.commandLine
    ? [...target.argsPrefix, '"' + target.commandLine + ' -c cli_auth_credentials_store=file"']
    : [...target.argsPrefix, 'app-server', '-c', 'cli_auth_credentials_store=file'];
}

const interactive = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput']);
export async function startGoalRPC(home, {
  spawnProcess = spawn, target = codexSpawnTarget(), onApproval = () => {},
  threadId = null, onNotification = () => {}, onGlobalNotification = () => {}, interactiveApprovals = false,
} = {}) {
  const child = spawnProcess(target.command, goalSpawnArgs(target), {
    env: { ...process.env, CODEX_HOME: home }, cwd: home,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    windowsVerbatimArguments: Boolean(target.commandLine),
  });
  let nextID = 0, buffer = '', ended = false, shuttingDown = false, approvalRequired = false, stderr = '', exitCode = null, spawnError = '';
  let activeTurnId = null, threadStatus = 'notLoaded';
  const pending = new Map(), requests = new Map();
  const send = (frame) => child.stdin.write(JSON.stringify(frame) + '\n');
  const diagnostic = () => redactExecutionText([spawnError, stderr.trim()].filter(Boolean).join('\n')).slice(-4000);
  const fail = () => {
    if (ended) return;
    ended = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Conexão com Codex encerrada' + (exitCode != null ? ' (código ' + exitCode + ')' : '') + (diagnostic() ? ': ' + diagnostic() : '.'))); }
    pending.clear();
    requests.clear();
    if (threadId && !shuttingDown) onNotification('client/disconnected', { threadId, message: diagnostic() || 'Conexão com Codex encerrada.' });
  };
  child.on('error', (error) => { spawnError = error.message; fail(); });
  child.on('exit', (code) => { exitCode = code; });
  // close follows stdout/stderr draining, preserving the final response and diagnostics.
  child.on('close', fail);
  child.stdin.on('error', (error) => { spawnError = error.message; fail(); });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) { spawnError = 'Resposta do Codex excedeu o limite de leitura.'; fail(); child.kill(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let frame; try { frame = JSON.parse(line); } catch { continue; }
      if (frame.method && frame.id != null) {
        if (interactiveApprovals && threadId && frame.params?.threadId === threadId && interactive.has(frame.method)) {
          requests.set(String(frame.id), { id: frame.id, method: frame.method, params: frame.params });
          onApproval({ id: frame.id, method: frame.method, params: frame.params });
        } else {
          approvalRequired = true;
          try { send({ id: frame.id, error: { code: -32001, message: 'Solicitação não suportada pelo controlador.' } }); onApproval(frame.method); } catch {}
        }
      } else if (frame.id != null) {
        const request = pending.get(frame.id); if (!request) continue;
        pending.delete(frame.id); clearTimeout(request.timer);
        if (frame.error) request.reject(new Error(frame.error.message || 'Falha na chamada Codex.'));
        else request.resolve(frame.result);
      } else if (['windowsSandbox/setupCompleted', 'account/login/completed', 'account/updated'].includes(frame.method)) {
        onGlobalNotification(frame.method, frame.params);
      } else if (frame.method && frame.params?.threadId === threadId && threadId) {
        if (frame.method === 'serverRequest/resolved') requests.delete(String(frame.params.requestId));
        if (frame.method === 'turn/started') activeTurnId = frame.params.turn?.id || null;
        if (frame.method === 'turn/completed') activeTurnId = null;
        if (frame.method === 'thread/status/changed') threadStatus = frame.params.status?.type || 'idle';
        onNotification(frame.method, frame.params);
      }
    }
  });
  const call = (method, params = {}, timeout = 30000) => new Promise((resolve, reject) => {
    if (ended) { reject(new Error('Codex desconectado.' + (diagnostic() ? ' ' + diagnostic() : ''))); return; }
    const id = ++nextID;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Tempo esgotado em ' + method + (diagnostic() ? ': ' + diagnostic() : ''))); }, timeout);
    pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
  const respond = (id, decision, answers) => {
    const request = requests.get(String(id));
    if (!request || ended) throw new Error('Solicitação expirada. Atualize o painel.');
    let result;
    if (request.method === 'item/tool/requestUserInput') {
      if (decision !== 'answer') throw new Error('Responda às perguntas do Codex.');
      const validated = Object.create(null);
      for (const q of request.params.questions || []) {
        if (typeof answers?.[q.id] !== 'string' || !answers[q.id].trim() || answers[q.id].length > 8000) throw new Error('Responda a todas as perguntas.');
        validated[q.id] = { answers: [answers[q.id]] };
      }
      result = { answers: validated };
    } else if (request.method === 'item/permissions/requestApproval') {
      if (!['accept', 'decline'].includes(decision)) throw new Error('Decisão inválida.');
      const p = request.params.permissions || {};
      result = { permissions: decision === 'accept' ? { ...(p.network ? { network: p.network } : {}), ...(p.fileSystem ? { fileSystem: p.fileSystem } : {}) } : {}, scope: 'turn' };
    } else {
      if (!['accept', 'decline'].includes(decision)) throw new Error('Decisão inválida.');
      const offered = request.params.availableDecisions;
      if (offered && !offered.includes(decision)) throw new Error('Esta decisão não está disponível para a solicitação.');
      result = { decision };
    }
    send({ id: request.id, result }); requests.delete(String(id));
  };
  const stop = async () => {
    if (ended) return;
    shuttingDown = true;
    child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      new Promise((resolve) => { const timer = setTimeout(resolve, 2000); timer.unref(); }),
    ]);
    if (!ended) {
      if (process.platform === 'win32' && target.commandLine) {
        await new Promise((resolve) => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          const timer = setTimeout(resolve, 3000); timer.unref();
          const done = () => { clearTimeout(timer); resolve(); };
          killer.once('error', done); killer.once('exit', done);
        });
      }
      child.kill();
    }
    fail();
  };
  try {
    await call('initialize', { clientInfo: { name: 'ulanzi_goals', title: 'Ulanzi Goals', version: '1.4.0' }, capabilities: { experimentalApi: true } }, 15000);
    send({ method: 'initialized', params: {} });
  } catch (error) { await stop(); throw error; }
  return { call, stop, respond, get closed() { return ended; }, get pendingApprovals() { return [...requests.values()]; }, get approvalRequired() { return approvalRequired; }, get activeTurnId() { return activeTurnId; }, get threadStatus() { return threadStatus; } };
}
