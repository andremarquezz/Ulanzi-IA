import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreProjectWindows, windowMatchesTarget } from '../src/window-restore.js';

test('recognizes workspace and folder titles', () => {
  assert.equal(windowMatchesTarget({ title: 'icone.svg - booking - Visual Studio Code' }, '/dev/booking'), true);
  assert.equal(windowMatchesTarget({ title: 'nossa-agenda - Visual Studio Code' }, '/dev/nossa-agenda'), true);
  assert.equal(windowMatchesTarget({ title: 'booking - Visual Studio Code' }, '/dev/nossa-agenda'), false);
  assert.equal(windowMatchesTarget({ title: 'booking - Visual Studio Code' }, null), false);
});

test('waits for the first visible VS Code window before opening the second', async () => {
  const windows = [];
  const launches = [];
  const targets = ['/work/booking', '/work/nossa-agenda'];
  const result = await restoreProjectWindows({
    targets,
    expectedCount: 2,
    openTarget: async (target) => {
      launches.push({ target, visibleBefore: windows.length });
      windows.push({ title: target.split('/').at(-1) + ' - Visual Studio Code' });
    },
    openNative: async () => { throw new Error('should not need fallback'); },
    waitForWindows: async () => [...windows],
  });

  assert.equal(result.restored, true);
  assert.equal(result.partial, false);
  assert.deepEqual(launches, [
    { target: targets[0], visibleBefore: 0 },
    { target: targets[1], visibleBefore: 1 },
  ]);
});

test('reports one window as a partial success, without repeatedly retrying', async () => {
  const windows = [];
  const launches = [];
  const result = await restoreProjectWindows({
    targets: ['/work/booking', '/work/nossa-agenda'],
    expectedCount: 2,
    openTarget: async (target) => {
      launches.push(target);
      if (target.includes('booking')) windows.push({ title: 'booking - Visual Studio Code' });
    },
    openNative: async () => { throw new Error('fallback should not reopen a working editor'); },
    waitForWindows: async () => [...windows],
  });

  assert.equal(result.restored, false);
  assert.equal(result.partial, true);
  assert.equal(result.visibleWindows, 1);
  assert.deepEqual(launches, ['/work/booking', '/work/nossa-agenda']);
});

test('requests one native fallback when initial folder does not become visible', async () => {
  const windows = [];
  const launches = [];
  const result = await restoreProjectWindows({
    targets: ['/work/booking', '/work/nossa-agenda'],
    expectedCount: 2,
    openTarget: async (target) => { launches.push(target); },
    openNative: async () => { windows.push({ title: 'booking - Visual Studio Code' }); },
    waitForWindows: async () => [...windows],
  });

  assert.equal(result.partial, true);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.visibleWindows, 1);
  assert.deepEqual(launches, ['/work/booking', '/work/nossa-agenda']);
});

test('can fall back to one known folder after native restore returns no windows', async () => {
  const windows = [];
  const result = await restoreProjectWindows({
    targets: ['/work/booking'],
    expectedCount: 2,
    openTarget: async (target) => { windows.push({ title: target.split('/').at(-1) + ' - Visual Studio Code' }); },
    openNative: async () => {},
    waitForWindows: async () => [...windows],
  });

  assert.equal(result.restoreMode, 'native');
  assert.equal(result.partial, true);
  assert.equal(result.visibleWindows, 1);
  assert.equal(result.fallbackUsed, true);
});

test('never opens VS Code more than twice when two folders were requested', async () => {
  const calls = [];
  const result = await restoreProjectWindows({
    targets: ['/work/booking', '/work/nossa-agenda'],
    expectedCount: 2,
    openTarget: async (target) => { calls.push('folder ' + target); },
    openNative: async () => { calls.push('native'); },
    waitForWindows: async () => [],
  });
  assert.deepEqual(calls, ['folder /work/booking', 'native']);
  assert.equal(result.visibleWindows, 0);
  assert.equal(result.restored, false);
  assert.equal(result.partial, false);
});
