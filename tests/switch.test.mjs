import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { switchIconSvg } from '../src/switch-icons.js';
import { targetsFromStorage } from '../src/switch.js';

test('Codex buttons identify the account and status', () => {
  const cases = [
    ['jey', 'active', 'JEY', 'ATIVO'],
    ['americano', 'switching', 'AMERICANO', 'TROCANDO'],
    ['jey', 'error', 'JEY', 'ERRO'],
  ];

  for (const [account, status, expectedName, expectedStatus] of cases) {
    const svg = switchIconSvg(account, status);
    assert.match(svg, /<svg/);
    assert.ok(svg.includes(expectedName), 'account label must be included in the rendered image');
    assert.ok(svg.includes(expectedStatus), 'status must be included in the rendered image');
  }
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
