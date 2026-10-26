import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionRecorder, redactExecutionText } from '../src/goal-events.js';

test('execution output is scoped, streamed, readable and not duplicated on completion', () => {
  let persisted, text = '';
  const recorder = createExecutionRecorder('chosen', { now: () => 1800000000000, persist: (s) => { persisted = structuredClone(s); }, appendLog: (chunk) => { text += chunk; } });
  const emit = (method, params) => recorder.record(method, { threadId: 'chosen', ...params });
  emit('item/agentMessage/delta', { threadId: 'other', delta: 'OTHER THREAD' });
  emit('turn/started', { turn: { id: 'turn-1' } });
  assert.equal(recorder.snapshot().turnActive, true);
  emit('item/agentMessage/delta', { itemId: 'message', delta: 'Olá ' });
  emit('item/agentMessage/delta', { itemId: 'message', delta: 'mundo' });
  emit('item/completed', { item: { id: 'message', type: 'agentMessage', text: 'Olá mundo' } });
  emit('item/started', { item: { id: 'cmd', type: 'commandExecution', command: 'npm test' } });
  emit('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'PASS\n' });
  emit('item/completed', { item: { id: 'files', type: 'fileChange', changes: [{ path: 'app.js', diff: '+ fixed' }] } });
  emit('turn/completed', { turn: { status: 'failed', error: { message: 'test failure' } } });
  recorder.close();
  assert.equal(persisted.turnActive, false);
  assert.equal(persisted.events.filter((e) => e.kind === 'message').length, 1);
  assert.equal(text.split('Olá mundo').length - 1, 1);
  for (const expected of ['npm test', 'PASS', 'app.js', 'test failure']) assert.ok(text.includes(expected));
  assert.ok(!text.includes('OTHER THREAD'));
});

test('visible buffers are bounded and common credentials are redacted', () => {
  const recorder = createExecutionRecorder('chosen', { persist: () => {} });
  for (let i = 0; i < 300; i++) recorder.append('output', 'x'.repeat(24000), String(i));
  assert.ok(recorder.snapshot().events.reduce((n, e) => n + e.text.length, 0) <= 500000);
  recorder.close();
  const safe = redactExecutionText('OPENAI_API_KEY=sk-' + 'a'.repeat(30) + '\nBearer abc.def.ghi');
  assert.ok(!safe.includes('sk-')); assert.ok(!safe.includes('abc.def.ghi'));
});
