import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreProjectWindows, windowMatchesTarget } from '../src/window-restore.js';

test('recognizes a workspace name inside editor titles', () => {
  assert.equal(windowMatchesTarget({ title: 'icone.svg - booking - Visual Studio Code' }, '/dev/booking'), true);
  assert.equal(windowMatchesTarget({ title: 'nossa-agenda - Visual Studio Code' }, '/dev/nossa-agenda'), true);
  assert.equal(windowMatchesTarget({ title: 'booking - Visual Studio Code' }, '/dev/nossa-agenda'), false);
  assert.equal(windowMatchesTarget({ title: 'booking - Visual Studio Code' }, null), false);
});

test('waits for each VS Code window before launching another project', async () => {
  const windows = [];
  const pending = [];
  const launches = [];
  const targets = ['/work/booking', '/work/nossa-agenda'];
  const result = await restoreProjectWindows({
    targets,
    expectedCount: 2,
    openTarget: async (target) => {
      launches.push({ target, alreadyOpen: windows.length });
      pending.push(target);
    },
    openNative: async () => { throw new Error('native restore was not expected'); },
    listWindows: async () => [...windows],
    pause: async () => {
      const target = pending.shift();
      if (target) windows.push({ title: target.split('/').at(-1) + ' - Visual Studio Code' });
    },
    pollAttempts: 3,
    pollDelayMs: 0,
  });

  assert.equal(result.restored, true);
  assert.equal(result.visibleWindows, 2);
  assert.equal(result.restoreMode, 'explicit');
  assert.deepEqual(launches, [
    { target: targets[0], alreadyOpen: 0 },
    { target: targets[1], alreadyOpen: 1 },
  ]);
});

test('retries opening missing editor rather than treating a reused window as success', async () => {
  const windows = [];
  const pending = [];
  const launches = [];
  let attemptsForSecond = 0;
  const result = await restoreProjectWindows({
    targets: ['/work/booking', '/work/nossa-agenda'],
    expectedCount: 2,
    openTarget: async (target) => {
      launches.push(target);
      if (target.includes('nossa-agenda') && ++attemptsForSecond === 1) {
        // First attempt was swallowed by the already running VS Code process.
        return;
      }
      pending.push(target);
    },
    openNative: async () => {},
    listWindows: async () => [...windows],
    pause: async () => {
      if (pending.length) {
        const target = pending.shift();
        windows.push({ title: target.split('/').at(-1) + ' - Visual Studio Code' });
      }
    },
    pollAttempts: 2,
    pollDelayMs: 0,
  });

  assert.equal(result.restored, true);
  assert.equal(result.visibleWindows, 2);
  assert.deepEqual(launches, ['/work/booking', '/work/nossa-agenda', '/work/nossa-agenda']);
});

test('keeps incomplete restore as a distinct failure', async () => {
  const windows = [];
  let first = true;
  const result = await restoreProjectWindows({
    targets: ['/work/booking', '/work/nossa-agenda'],
    expectedCount: 2,
    openTarget: async () => {
      if (first) {
        windows.push({ title: 'booking - Visual Studio Code' });
        first = false;
      }
    },
    openNative: async () => {},
    listWindows: async () => [...windows],
    pause: async () => {},
    pollAttempts: 2,
    pollDelayMs: 0,
  });
  assert.equal(result.restored, false);
  assert.equal(result.visibleWindows, 1);
  assert.equal(result.expectedWindows, 2);
});

test('native session restore can recover a missing known project', async () => {
  const windows = [];
  const result = await restoreProjectWindows({
    targets: ['/work/booking'],
    expectedCount: 2,
    openTarget: async () => {
      windows.push({ title: 'booking - Visual Studio Code' });
    },
    openNative: async () => {
      windows.push({ title: 'outro-projeto - Visual Studio Code' });
    },
    listWindows: async () => [...windows],
    pause: async () => {},
    pollAttempts: 2,
    pollDelayMs: 0,
  });

  assert.equal(result.restoreMode, 'native');
  assert.equal(result.restored, true);
  assert.equal(result.visibleWindows, 2);
});
