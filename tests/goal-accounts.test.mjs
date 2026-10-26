import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
test('HB authentication preserves live and existing profiles, rejects duplicate, supports cancellation and releases locks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-hb-setup-'));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/hb-setup.mjs', import.meta.url))], {
      env: { ...process.env, USERPROFILE: root, HOME: root, LOCALAPPDATA: root }, windowsHide: true, timeout: 15000,
    });
    assert.match(stdout, /success published/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
