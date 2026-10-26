import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
const exec = promisify(execFile);
const bundle = fileURLToPath(new URL('../dist/com.ulanzi.ulanzistudio.jeycodex.ulanziPlugin/plugin/goal-worker.js', import.meta.url));
for (const mode of ['source', 'bundle', 'paused']) test('detached Goal worker lifecycle: ' + mode, { skip: mode === 'bundle' && !fs.existsSync(bundle) }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-goals-lifecycle-'));
  try {
    const args = [fileURLToPath(new URL('./fixtures/worker-lifecycle.mjs', import.meta.url)), ...(mode === 'bundle' ? [bundle] : mode==='paused'?['--paused']:[])];
    const { stdout } = await exec(process.execPath, args, { env: { ...process.env, USERPROFILE: root, HOME: root, LOCALAPPDATA: root }, windowsHide: true, timeout: 25000 });
    assert.match(stdout, /Detached worker started/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
