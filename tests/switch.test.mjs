import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { switchIconSvg } from '../src/switch-icons.js';
import { targetsFromStorage } from '../src/switch.js';

test('Codex buttons show graphical identity and state without large text', () => {
  const jey = switchIconSvg('jey', 'idle');
  const americano = switchIconSvg('americano', 'idle');
  const active = switchIconSvg('jey', 'active');
  const switching = switchIconSvg('americano', 'switching', 'FECHANDO');
  const error = switchIconSvg('americano', 'error');

  for (const svg of [jey, americano, active, switching, error]) {
    assert.match(svg, /<svg/);
    assert.match(svg, /<path d=/);
    assert.equal((svg.match(/<text /g) || []).length, 1, 'only a small monogram is allowed');
    assert.doesNotMatch(svg, /CODEX|SELECIONAR|TROCANDO|ATIVO|ERRO|AMERICANO|JEY/);
  }

  assert.ok(jey.includes('>J</text>'));
  assert.ok(americano.includes('>A</text>'));
  assert.match(jey, /#38cfff/i);
  assert.match(americano, /#80e86a/i);
  assert.match(active, /#34d399/i);
  assert.match(switching, /#fbbf24/i);
  assert.match(error, /#fb556c/i);
  assert.notEqual(switchIconSvg('jey', 'switching', 'FECHANDO'),
    switchIconSvg('jey', 'switching', 'ABRINDO'), 'phase indicator should change');
});

test('VS Code window snapshot reads all folder and workspace URI formats', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-test-'));
  try {
    const folderA = path.join(temp, 'a');
    const folderB = path.join(temp, 'b');
    const workspace = path.join(temp, 'projects.code-workspace');
    fs.mkdirSync(folderA);
    fs.mkdirSync(folderB);
    fs.writeFileSync(workspace, '{"folders": []}');

    const storage = path.join(temp, 'storage.json');
    fs.writeFileSync(storage, JSON.stringify({
      windowsState: {
        openedWindows: [
          { folder: pathToFileURL(folderA).href },
          { folderUri: pathToFileURL(folderB).href },
        ],
        lastActiveWindow: {
          workspaceIdentifier: { configURIPath: pathToFileURL(workspace).href },
        },
      },
    }));

    const paths = targetsFromStorage(storage);
    assert.equal(paths.length, 3);
    assert.deepEqual(paths, [folderA, folderB, workspace]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
