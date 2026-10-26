import fs from 'node:fs';
import path from 'node:path';
import { startGoalRPC } from './goal-rpc.js';
import { authID, fingerprint, liveAccount, profileHomes, liveHome, goalFile, readJSON, writeJSON, goalLog, replaceFile } from './goal-store.js';
import { quotaFromResponse, chooseAccount, accountRotation, eligibleQuota, nextCheck, RESUME_COOLDOWN } from './goal-policy.js';

export function defaultGoalDependencies() {
  return {
    connect: startGoalRPC, current: liveAccount, fingerprint, authID,
    homes: profileHomes, liveHome,
    stopped: () => fs.existsSync(goalFile('stop')),
    holds: () => readJSON(goalFile('holds.json')),
    saveHolds: (holds) => writeJSON(goalFile('holds.json'), holds),
    autoSwitch: () => readJSON(goalFile('settings.json'), { autoSwitch: true }).autoSwitch !== false,
    saveSelection: (selection) => writeJSON(goalFile('selection.json'), selection),
    log: goalLog,
    replaceAuth: (source, destination) => {
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      const file = path.join(destination, 'auth.json');
      const temp = file + '.ulanzi.tmp';
      try { fs.copyFileSync(path.join(source, 'auth.json'), temp); replaceFile(temp, file); }
      finally { try { fs.unlinkSync(temp); } catch {} }
    },
    sleep: async (until) => {
      while (Date.now() < until && !fs.existsSync(goalFile('stop'))) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, until - Date.now())));
      }
    },
    now: Date.now,
    onNotification: () => {}, onApproval: () => {}, onClient: () => {},
  };
}

export async function runGoalEngine(selection, emit, overrides = {}) {
  const d = { ...defaultGoalDependencies(), ...overrides };
  let rpc, failures = 0, quotas = {}, hold = d.holds();
  let goalStatus = null;
  const state = (name, detail, next = null) => emit({ state: name, detail, account: d.current(), title: selection.title, threadId: selection.id, runId: selection.runId, goalStatus, quotas, holds: hold, nextCheck: next, updatedAt: d.now(), pid: process.pid });
  const connectLive = async () => {
    const client = await d.connect(d.liveHome, { threadId: selection.id, interactiveApprovals: true, onNotification: d.onNotification, onApproval: d.onApproval });
    d.onClient(client); return client;
  };
  const assertIdentity = () => {
    if (!selection.fingerprint || d.fingerprint() !== selection.fingerprint) throw new Error('Conta alterada fora do monitor. Monitoramento encerrado.');
    if (d.stopped()) throw new Error('Parada solicitada.');
  };
  const getGoal = async () => (await rpc.call('thread/goal/get', { threadId: selection.id })).goal;
  const readQuota = async (client, home) => quotaFromResponse(await client.call('account/rateLimits/read', { excludeResetCreditDetails: true }), d.now(), d.authID(home));
  const activate = async (expected) => {
    assertIdentity();
    await rpc.call('thread/resume', { threadId: selection.id, excludeTurns: true }, 50000);
    const fresh = await getGoal();
    if (fresh?.status !== expected) throw new Error('O estado do Goal mudou antes da ativação. Confira o painel e clique em Executar novamente.');
    assertIdentity();
    await rpc.call('thread/goal/set', { threadId: selection.id, origin: 'user', status: 'active' });
  };
  const pauseOwned = async () => {
    if (!rpc || d.fingerprint() !== selection.fingerprint) throw new Error('Conta ou conexão alterada; não foi possível confirmar a pausa.');
    const goal = await getGoal();
    if (goal?.status === 'active') {
      await rpc.call('thread/goal/set', { threadId: selection.id, origin: 'user', status: 'paused' });
      if (rpc.activeTurnId) await rpc.call('turn/interrupt', { threadId: selection.id, turnId: rpc.activeTurnId }, 15000);
      goalStatus = 'paused';
    }
    d.log('pause', 'Execução pausada pelo usuário; Goal preservado.');
  };
  const attemptSwitch = async (target) => {
    assertIdentity();
    const source = d.current(), targetID = d.authID(d.homes[target]);
    if (!d.homes[source] || !targetID || d.authID(d.liveHome) === targetID) throw new Error('Perfis inválidos para troca automática.');
    state('switching', 'Ativando ' + target.toUpperCase() + ' após confirmar capacidade.');
    await rpc.stop(); rpc = null;
    assertIdentity();
    // Preserve the latest refreshed source session, then switch. The saved
    // source is also the rollback copy; it never leaves this computer.
    d.replaceAuth(d.liveHome, d.homes[source]);
    try {
      d.replaceAuth(d.homes[target], d.liveHome);
      if (d.authID(d.liveHome) !== targetID) throw new Error('Identidade da conta de destino não confere.');
      rpc = await connectLive();
      const fresh = await readQuota(rpc, d.liveHome);
      if (!eligibleQuota(fresh, 0, d.now())) throw new Error('Conta de destino perdeu a capacidade de uso.');
      const goal = await getGoal();
      if (goal?.status !== 'usageLimited') throw new Error('O estado do Goal mudou durante a troca.');
      selection = { ...selection, fingerprint: d.fingerprint() };
      d.saveSelection(selection);
      d.log('account-switched', source + ' -> ' + target);
    } catch (error) {
      if (rpc) { await rpc.stop(); rpc = null; }
      try { d.replaceAuth(d.homes[source], d.liveHome); }
      catch { throw new Error('Falha na troca e na restauração da sessão anterior. Verifique os perfis no PC.'); }
      throw new Error('Troca cancelada; sessão anterior restaurada. ' + error.message);
    }
  };
  try {
    assertIdentity();
    const resumePaused = selection.resumePaused === true;
    selection = { ...selection, resumePaused: false };
    d.saveSelection(selection);
    state('starting', 'Assumindo o Goal selecionado.');
    rpc = await connectLive();
    let goal = await getGoal();
    if (!goal) throw new Error('Esta conversa não possui um Goal persistente.');
    goalStatus = goal.status;
    if (goal.status === 'paused' && resumePaused && selection.resumeVersion != null && goal.updatedAt != null && selection.resumeVersion !== goal.updatedAt) throw new Error('O Goal foi alterado depois do clique em Executar. Confira e confirme novamente.');
    if (goal.status === 'active' || (goal.status === 'paused' && resumePaused)) {
      state('resuming', 'Carregando conversa e ativando o Goal pelo Codex CLI.');
      await activate(goal.status);
    }
    while (!d.stopped()) {
      assertIdentity();
      let next = d.now() + 15000;
      try { goal = await getGoal(); failures = 0; }
      catch (error) {
        if (rpc.closed) throw error;
        failures++;
        if (failures >= 5) throw error;
        next = nextCheck({}, {}, failures, d.now());
        state('retrying', 'Conexão instável; aguardando antes de consultar novamente.', next);
        await d.sleep(next); continue;
      }
      if (!goal) throw new Error('Goal não encontrado.');
      goalStatus = goal.status;
      if (rpc.approvalRequired) { state('attention', 'O CLI enviou uma solicitação não suportada. Consulte os eventos no painel.'); return; }
      if (goal.status === 'complete') { state('complete', 'Goal concluído.'); return; }
      if (goal.status === 'paused') { state('paused', 'Goal pausado. Clique em Executar para retomar por este painel.'); return; }
      if (['blocked', 'budgetLimited'].includes(goal.status)) { state('attention', 'Goal em ' + goal.status + '. Confira os eventos e o objetivo no painel.'); return; }
      if (goal.status === 'usageLimited') {
        const current = d.current();
        if (!current) throw new Error('Conta atual não reconhecida. Configure Jey, Americano ou HB.');
        quotas = {};
        try { quotas[current] = await readQuota(rpc, d.liveHome); }
        catch { quotas[current] = { known: false, allowed: false, checkedAt: d.now() }; }
        const auto = d.autoSwitch();
        const order = Object.keys(d.homes);
        let target = chooseAccount(current, quotas, hold, false, d.now(), order);
        if (!target && auto) {
          const identities = new Set([d.authID(d.liveHome)]);
          for (const other of accountRotation(current, order)) {
            if (d.stopped() || !d.autoSwitch()) break;
            const id = d.authID(d.homes[other]);
            if (!id || identities.has(id)) continue; // Unconfigured or duplicate login is never another quota.
            identities.add(id);
            let probe;
            try { probe = await d.connect(d.homes[other]); quotas[other] = await readQuota(probe, d.homes[other]); }
            catch { quotas[other] = { known: false, allowed: false, checkedAt: d.now() }; }
            finally { if (probe) await probe.stop(); }
            target = chooseAccount(current, quotas, hold, d.autoSwitch(), d.now(), order);
            if (target) break;
          }
        }
        if (d.stopped()) break;
        assertIdentity();
        if (!target) {
          const unknown = Object.values(quotas).some((q) => !q.known);
          // Separate quota error counter from successful Goal reads.
          const previousFailures = hold._quotaFailures || 0;
          hold._quotaFailures = unknown ? previousFailures + 1 : 0;
          d.saveHolds(hold);
          next = nextCheck(quotas, hold, hold._quotaFailures, d.now());
          state('waiting_quota', unknown ? 'Cota não confirmada. Aguardando nova leitura.' : 'Contas sem capacidade ou em proteção. Aguardando sem alternar.', next);
        } else {
          hold[target] = d.now() + RESUME_COOLDOWN;
          hold._quotaFailures = 0;
          d.saveHolds(hold);
          if (target !== current) {
            // Recheck the live switch setting immediately before mutation.
            if (!d.autoSwitch()) continue;
            await attemptSwitch(target);
          }
          assertIdentity();
          goal = await getGoal();
          if (goal?.status !== 'usageLimited') continue;
          state('resuming', 'Retomando o mesmo Goal com ' + target.toUpperCase());
          try {
            await activate('usageLimited');
            state('waiting_codex', 'Goal ativado com ' + target.toUpperCase() + '. Aguardando evento de execução do CLI.', next);
          } catch {
            next = d.now() + 3 * 60000;
            state('retrying', 'Retomada não confirmada; proteção de 10 minutos aplicada à conta.', next);
          }
        }
      } else if (goal.status === 'active') {
        next = d.now() + 5000;
        const awaiting = rpc.pendingApprovals?.length > 0;
        state(awaiting ? 'waiting_approval' : rpc.activeTurnId ? 'running' : 'waiting_codex', awaiting ? 'Aguardando sua decisão no painel.' : rpc.activeTurnId ? 'Turno do Codex em execução. Acompanhe a saída ao vivo.' : 'Goal ativo; aguardando o CLI iniciar o próximo turno. Nenhum turno confirmado em execução.', next);
      } else { throw new Error('Estado do Goal não reconhecido: ' + goal.status); }
      await d.sleep(next);
    }
    await pauseOwned();
    state('stopped', 'Execução pausada pelo usuário. Goal preservado para retomada.');
  } catch (error) {
    state(d.stopped() ? 'stopped' : 'error', error.message);
  } finally { if (rpc) await rpc.stop(); }
}
