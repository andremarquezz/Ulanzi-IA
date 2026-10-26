import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const GOAL_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CodexLimits', 'goals');
export const goalFile = (name) => path.join(GOAL_DIR, name);
import { profileHomes } from './accounts.js';
export { profileHomes } from './accounts.js';
export const liveHome = path.join(os.homedir(), '.codex');
export function readJSON(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function replaceFile(source, destination, { rename = fs.renameSync, pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  // Windows scanners/readers can briefly deny replacement. Retry the same
  // atomic operation; never delete the valid destination as a fallback.
  for (let attempt = 0; ; attempt++) {
    try { rename(source, destination); return; }
    catch (error) {
      if (attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      pause(Math.min(100, 20 * (attempt + 1)));
    }
  }
}
export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    replaceFile(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
export function authID(home) { const auth = readJSON(path.join(home, 'auth.json')); return auth.tokens?.account_id || auth.account_id || null; }
export function fingerprint(home = liveHome) {
  const id = authID(home);
  return id ? crypto.createHash('sha256').update(id).digest('hex') : null;
}
export function liveAccount() {
  const id = authID(liveHome);
  return Object.keys(profileHomes).find((key) => id && authID(profileHomes[key]) === id) || null;
}
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export function isGoalMonitorRunning() {
  const lock = readJSON(goalFile('monitor.lock'));
  if (processAlive(lock.pid)) return true;
  const state = readJSON(goalFile('state.json'));
  return ['starting', 'running', 'waiting_codex', 'waiting_approval', 'waiting_quota', 'resuming', 'switching', 'retrying'].includes(state.state) && processAlive(state.pid);
}
export function acquireLock(name) {
  const file = goalFile(name);
  fs.mkdirSync(GOAL_DIR, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(fd); }
      return () => { if (readJSON(file).token === token) fs.unlinkSync(file); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readJSON(file);
      // Treat a just-created, not-yet-written lock as owned, too.
      if (processAlive(owner.pid) || Date.now() - fs.statSync(file).mtimeMs < 30000) throw new Error('Já existe uma operação de Goals em andamento.');
      // Serialize stale-lock recovery too. Otherwise two processes could both
      // inspect the stale owner and one could unlink the other's fresh lock.
      const recoveryFile = file + '.recovery';
      let recovery;
      try { recovery = fs.openSync(recoveryFile, 'wx', 0o600); }
      catch { throw new Error('Recuperação de monitor em andamento. Tente novamente em instantes.'); }
      try {
        const latest = readJSON(file);
        if (processAlive(latest.pid)) throw new Error('Já existe uma operação de Goals em andamento.');
        try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        // Acquire while holding the recovery lock so another recovery cannot
        // race the handoff. A normal competing creator may win safely.
        const fd = fs.openSync(file, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(fd); }
        return () => { if (readJSON(file).token === token) fs.unlinkSync(file); };
      } finally { fs.closeSync(recovery); fs.unlinkSync(recoveryFile); }
    }
  }
  throw new Error('Não foi possível obter o controle exclusivo de Goals.');
}
export function goalLog(event, detail) {
  fs.mkdirSync(GOAL_DIR, { recursive: true, mode: 0o700 });
  const file = goalFile('monitor.log');
  if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.old');
  fs.appendFileSync(file, `${new Date().toISOString()} | ${event} | ${String(detail).replaceAll('\n', ' ')}\n`, { mode: 0o600 });
}
