import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ACCOUNTS, profileHomes } from './accounts.js';
import { startGoalRPC } from './goal-rpc.js';
import { acquireLock, authID, GOAL_DIR, goalFile, isGoalMonitorRunning, readJSON, writeJSON, replaceFile, goalLog } from './goal-store.js';
import { redactExecutionText } from './goal-events.js';

export function profileStatus() {
  const seen = new Set();
  return ACCOUNTS.map(({ id, label }) => {
    const account = authID(profileHomes[id]);
    const duplicate = Boolean(account && seen.has(account));
    if (account) seen.add(account);
    return { id, label, configured: Boolean(account), duplicate, available: Boolean(account && !duplicate) };
  });
}

// Sign in within a temporary CODEX_HOME; publish only a distinct completed login.
// Existing profiles and the live Codex login are never changed by this ceremony.
export function createHBSetup({ connect = startGoalRPC, isSwitching = () => false, timeoutMs = 10 * 60000 } = {}) {
  let client, stage, release, timer, completing = false, loginID, earlyCompletion;
  let info = { state: 'idle' };
  const status = () => ({ ...info });
  const busy = () => ['starting', 'waiting', 'saving'].includes(info.state);
  const cleanup = async () => {
    clearTimeout(timer);
    const old = client; client = null;
    try { if (old) await old.stop(); }
    finally {
      try {
        if (stage) {
          const resolved = path.resolve(stage);
          if (path.dirname(resolved) === path.resolve(GOAL_DIR) && path.basename(resolved).startsWith('hb-login-')) fs.rmSync(resolved, { recursive: true, force: true });
          stage = null;
        }
      } finally { release?.(); release = null; }
    }
  };
  const fail = async (message) => {
    info = { state: 'error', error: redactExecutionText(message) };
    try { await cleanup(); } catch {} // Never leave an unhandled notification rejection.
  };
  const complete = async (result) => {
    if (info.state === 'starting') { earlyCompletion = result; return; }
    if (!busy() || completing || result.loginId !== loginID) return;
    completing = true;
    try {
      if (!result.success) throw Error(result.error || 'Login não concluído. Tente novamente.');
      info = { state: 'saving' };
      // Stop the auth writer before copying its final file.
      await client.stop(); client = null;
      const id = authID(stage);
      if (!id) throw Error('O CLI não salvou um login ChatGPT válido.');
      if (ACCOUNTS.some((a) => a.id !== 'hb' && authID(a.home) === id)) throw Error('Esse login já é Jey ou Americano. Entre com a conta da HB. Os perfis anteriores foram preservados.');
      if (isGoalMonitorRunning() || isSwitching()) throw Error('Pause a execução antes de salvar o login da HB.');
      fs.mkdirSync(profileHomes.hb, { recursive: true, mode: 0o700 });
      const temporary = path.join(profileHomes.hb, 'auth.' + crypto.randomUUID() + '.tmp');
      try {
        fs.copyFileSync(path.join(stage, 'auth.json'), temporary);
        replaceFile(temporary, path.join(profileHomes.hb, 'auth.json'));
      } finally { try { fs.unlinkSync(temporary); } catch {} }
      const holds = readJSON(goalFile('holds.json'));
      delete holds.hb;
      writeJSON(goalFile('holds.json'), holds);
      info = { state: 'complete', message: 'HB conectada. A troca automática já pode usar as três contas.' };
      goalLog('account-setup', 'HB conectada com login independente.');
      await cleanup();
    } catch (error) { await fail(error.message); }
    finally { completing = false; }
  };
  const start = async ({ method = 'device' } = {}) => {
    if (!['device', 'browser'].includes(method)) throw Error('Método de login inválido.');
    if (busy()) return status();
    const operation = acquireLock('command.lock');
    if (isGoalMonitorRunning() || isSwitching()) { operation(); throw Error('Pause o Goal antes de configurar a HB.'); }
    release = operation;
    info = { state: 'starting' }; loginID = null; earlyCompletion = null;
    try {
      fs.mkdirSync(GOAL_DIR, { recursive: true });
      stage = fs.mkdtempSync(path.join(GOAL_DIR, 'hb-login-'));
      client = await connect(stage, { onGlobalNotification: (name, params) => {
        if (name === 'account/login/completed') void complete(params);
      } });
      const result = await client.call('account/login/start', { type: method === 'device' ? 'chatgptDeviceCode' : 'chatgpt' }, 50000);
      const url = new URL(result.verificationUrl || result.authUrl);
      if (url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname) || !result.loginId) throw Error('O CLI retornou um endereço de login inesperado.');
      loginID = result.loginId;
      info = { state: 'waiting', method, url: url.href, code: result.userCode || null, expiresAt: Date.now() + timeoutMs };
      timer = setTimeout(() => { if (!completing) void fail('O login expirou. Gere um novo código ou link.'); }, timeoutMs);
      timer.unref?.();
      if (earlyCompletion) void complete(earlyCompletion);
      return status();
    } catch (error) { await fail(error.message); throw Error(info.error); }
  };
  const cancel = async () => {
    if (completing || info.state === 'starting') throw Error('Aguarde a preparação ou gravação do login terminar.');
    info = { state: 'cancelled' };
    try { if (client && loginID) await client.call('account/login/cancel', { loginId: loginID }, 5000); }
    catch {} finally { await cleanup(); }
    return status();
  };
  return { start, cancel, status, busy };
}
