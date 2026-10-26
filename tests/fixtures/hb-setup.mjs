import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = process.env.LOCALAPPDATA;
if (!root || !path.basename(root).startsWith('ulanzi-hb-setup-')) throw Error('Isolated home required.');
const { createHBSetup, profileStatus } = await import('../../src/goal-accounts.js');
const { profileHomes, liveHome, acquireLock, GOAL_DIR, authID } = await import('../../src/goal-store.js');
const auth = (id) => JSON.stringify({ tokens: { account_id: id, access_token: 'fixture-secret-should-not-leak' } });
for (const [home, id] of [[liveHome, 'jey-id'], [profileHomes.jey, 'jey-id'], [profileHomes.americano, 'americano-id'], [profileHomes.hb, 'old-hb-id']]) {
  fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'auth.json'), auth(id));
}
const originals = [liveHome, profileHomes.jey, profileHomes.americano].map((h) => fs.readFileSync(path.join(h, 'auth.json'), 'utf8'));
let notify, stage, stopped = 0, mode;
const manager = createHBSetup({ timeoutMs: 2000, connect: async (home, hooks) => {
  stage = home; notify = hooks.onGlobalNotification;
  assert.notEqual(home, liveHome); assert.notEqual(home, profileHomes.hb);
  return { stop: async () => { stopped++; }, call: async (method, params) => {
    if (method === 'account/login/start') { mode = params.type; return { loginId: 'login-fixture', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-1234' }; }
    if (method === 'account/login/cancel') notify('account/login/completed', { loginId: 'login-fixture', success: true });
    return {};
  } };
} });
const wait = async () => { const end = Date.now() + 5000; while (manager.busy() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); assert.equal(manager.busy(), false); };
const preserved = () => { [liveHome, profileHomes.jey, profileHomes.americano].forEach((h, i) => assert.equal(fs.readFileSync(path.join(h, 'auth.json'), 'utf8'), originals[i])); };
await manager.start(); assert.equal(mode, 'chatgptDeviceCode');
assert.throws(() => acquireLock('command.lock'), /opera/);
assert.doesNotMatch(JSON.stringify(manager.status()), /fixture-secret/);
fs.writeFileSync(path.join(stage, 'auth.json'), auth('jey-id'));
notify('account/login/completed', { loginId: 'login-fixture', success: true });
await wait(); assert.equal(manager.status().state, 'error'); assert.equal(authID(profileHomes.hb), 'old-hb-id'); preserved();
assert.equal(fs.existsSync(stage), false);
await manager.start({ method: 'browser' }); assert.equal(mode, 'chatgpt');
await manager.cancel(); assert.equal(manager.status().state, 'cancelled'); assert.equal(authID(profileHomes.hb), 'old-hb-id'); preserved();
await manager.start();
fs.writeFileSync(path.join(stage, 'auth.json'), auth('new-hb-id'));
notify('account/login/completed', { loginId: 'another-attempt', success: true }); assert.equal(manager.status().state, 'waiting');
notify('account/login/completed', { loginId: 'login-fixture', success: true });
await wait(); assert.equal(manager.status().state, 'complete'); assert.equal(authID(profileHomes.hb), 'new-hb-id'); preserved();
assert.equal(profileStatus().filter((p) => p.available).length, 3);
assert.equal(fs.readdirSync(GOAL_DIR).some((f) => f.startsWith('hb-login-')), false);
const release = acquireLock('command.lock'); release(); assert.ok(stopped >= 3);
console.log('HB setup isolated, duplicate rejected, cancel preserved, success published.');
