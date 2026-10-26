import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readCodexDashboard } from '../src/activity.js';

test('mobile dashboard inline JavaScript parses', () => {
  const html = fs.readFileSync(new URL('../plugin/resources/mobile.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
  assert.ok(script, 'inline mobile script is present');
  assert.doesNotThrow(() => new vm.Script(script.replaceAll('__JEY_TOKEN__', '"test-token"')));
});

test('Codex dashboard returns multiple active sessions without local file paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-test-'));
  const previous = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = root;
    const now = new Date().toISOString();
    const fixtures = [
      { name: 'session-alpha.jsonl', type: 'task_start', cwd: path.join(root, 'projeto-alpha'), message: 'Executando testes' },
      { name: 'session-beta.jsonl', type: 'exec_approval_request', cwd: path.join(root, 'projeto-beta'), message: 'Preciso da sua permissão' },
    ];
    for (const file of fixtures) {
      fs.writeFileSync(
        path.join(root, file.name),
        JSON.stringify({
          type: file.type,
          timestamp: now,
          payload: { cwd: file.cwd, message: file.message, session_id: file.name },
        }) + '\n',
      );
    }

    const result = readCodexDashboard({ force: true });
    const alpha = result.sessions.find((s) => s.project === 'projeto-alpha');
    const beta = result.sessions.find((s) => s.project === 'projeto-beta');
    assert.ok(alpha);
    assert.ok(beta);
    assert.equal(alpha.active, true);
    assert.equal(beta.active, true);
    assert.equal(beta.status, 'waiting');
    assert.ok(result.waitingSessionCount >= 1);
    assert.ok(result.activeSessionCount >= 2);
    assert.equal(Object.hasOwn(alpha, 'source'), false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
