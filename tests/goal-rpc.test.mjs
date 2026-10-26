import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startGoalRPC, goalSpawnArgs } from '../src/goal-rpc.js';

test('RPC initializes a real local subprocess, times out and declines approvals', async () => {
  const approvals = [];
  const rpc = await startGoalRPC(os.tmpdir(), {
    target: { command: process.execPath, argsPrefix: [fileURLToPath(new URL('./fixtures/fake-goal-rpc.mjs', import.meta.url))], commandLine: null },
    onApproval: (method) => approvals.push(method),
  });
  try {
    const response = await rpc.call('thread/goal/get', { threadId: 'exact-thread' });
    assert.equal(response.goal.threadId, 'exact-thread');
    await assert.rejects(rpc.call('test/error'), /simulated error/);
    await assert.rejects(rpc.call('test/timeout', {}, 30), /Tempo esgotado/);
    await rpc.call('test/approval');
    assert.equal(rpc.approvalRequired, true);
    assert.deepEqual(approvals, ['item/commandExecution/requestApproval']);
    const quota = await rpc.call('account/rateLimits/read');
    assert.equal(quota.ordinaryUsageAllowed, false);
  } finally { await rpc.stop(); }
  await assert.rejects(rpc.call('thread/goal/get'), /desconectado/);
});

test('live requests remain pending until an explicit decision and notifications expose the real turn', async () => {
  const notifications = [], prompts = [];
  const rpc = await startGoalRPC(os.tmpdir(), {
    target: { command: process.execPath, argsPrefix: [fileURLToPath(new URL('./fixtures/fake-goal-rpc.mjs', import.meta.url))], commandLine: null },
    threadId: 'exact-thread', interactiveApprovals: true,
    onNotification: (method) => notifications.push(method), onApproval: (request) => prompts.push(request),
  });
  try {
    await rpc.call('test/interactiveApproval');
    assert.equal(prompts.length, 1); assert.equal(rpc.pendingApprovals.length, 1);
    assert.equal((await rpc.call('test/decision')).decision, null, 'no automatic approval');
    assert.throws(() => rpc.respond('interactive-test', 'acceptForSession'), /Decisão inválida/);
    rpc.respond('interactive-test', 'accept');
    assert.deepEqual((await rpc.call('test/decision')).decision, { decision: 'accept' });
    assert.equal(rpc.pendingApprovals.length, 0);
    assert.throws(() => rpc.respond('interactive-test', 'accept'), /expirada/);
    await rpc.call('test/event');
    assert.equal(rpc.activeTurnId, 'owned-turn'); assert.ok(notifications.includes('turn/started'));
  } finally { await rpc.stop(); }
});

test('disconnection errors include drained server diagnostics', async () => {
  const rpc = await startGoalRPC(os.tmpdir(), { target: { command: process.execPath, argsPrefix: [fileURLToPath(new URL('./fixtures/fake-goal-rpc.mjs', import.meta.url))], commandLine: null } });
  await assert.rejects(rpc.call('test/exit'), /fake diagnostic from app-server/);
  await rpc.stop();
});

test('cmd shim quoting preserves paths with spaces and avoids nested TOML quotes', () => {
  const args = goalSpawnArgs({ commandLine: '"C:\\Codex CLI\\codex.cmd" app-server', argsPrefix: ['/d', '/s', '/c'] });
  assert.deepEqual(args, ['/d', '/s', '/c', '""C:\\Codex CLI\\codex.cmd" app-server -c cli_auth_credentials_store=file"']);
});

test('account authentication notifications are routed without requiring a selected thread', async () => {
  const events = [];
  const rpc = await startGoalRPC(os.tmpdir(), {
    target: { command: process.execPath, argsPrefix: [fileURLToPath(new URL('./fixtures/fake-goal-rpc.mjs', import.meta.url))], commandLine: null },
    onGlobalNotification: (method, params) => events.push({ method, params }),
  });
  try {
    await rpc.call('test/login');
    assert.deepEqual(events, [{ method: 'account/login/completed', params: { loginId: 'test-login-id', success: true, error: null } }]);
  } finally { await rpc.stop(); }
});
