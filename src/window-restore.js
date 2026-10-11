import path from 'node:path';

export function windowMatchesTarget(window, target) {
  if (!target) return false;
  const basename = path.basename(target).replace(/\.code-workspace$/i, '').toLowerCase();
  const title = String(window?.title || '').toLowerCase();
  return Boolean(basename) && (
    title === basename
    || title.includes(' - ' + basename + ' - ')
    || title.startsWith(basename + ' - ')
    || title.endsWith(' - ' + basename)
  );
}

/**
 * Relaunch at most once per project, with one native fallback if the first
 * command fails. Do not turn a successful auth switch into a minute-long error.
 * Window-waiting is delegated to one persistent PowerShell process per launch,
 * rather than compiling the Win32 helper on every poll.
 */
export async function restoreProjectWindows({
  targets,
  expectedCount,
  openTarget,
  openNative,
  waitForWindows,
  log = () => {},
  firstWaitSeconds = 8,
  nextWaitSeconds = 5,
}) {
  const expected = Math.max(0, Number(expectedCount) || 0);
  const explicit = targets.length >= expected && expected > 0;
  const selected = explicit ? targets : targets.slice(0, 1);
  const mode = explicit ? 'explicit' : 'native';
  log('restore', 'windowsBefore=' + expected + ' capturedTargets=' + targets.length
    + ' mode=' + mode);

  let windows = [];
  let triedFallback = false;
  const wait = async (count, seconds) => {
    try {
      const observed = await waitForWindows(count, seconds);
      windows = Array.isArray(observed) ? observed : [];
    } catch (error) {
      log('reopen-wait-error', error?.message || String(error));
      windows = [];
    }
    log('reopen-observed', 'visible=' + windows.length + ' expected=' + count
      + ' titles=' + JSON.stringify(windows.map((w) => w.title)));
    return windows;
  };

  if (explicit) {
    // Wait for the first editor to be *visible* before sending the next folder.
    // A premature second Code.exe may be swallowed by the first-startup process.
    for (let index = 0; index < selected.length; index++) {
      const target = selected[index];
      if (windows.some((w) => windowMatchesTarget(w, target))) {
        log('reopen-skip', target + ' already open');
        continue;
      }
      const required = windows.length + 1;
      log('reopen-request', target + ' index=' + index);
      await openTarget(target);
      await wait(required, index === 0 ? firstWaitSeconds : nextWaitSeconds);

      // One fallback only. No repeated 20-second retries.
      if (windows.length < required && index === 0) {
        log('reopen-fallback', 'First editor missing. Request native restore.');
        await openNative();
        triedFallback = true;
        await wait(1, 4);
      }
      if (windows.length < 1) break;
    }
  } else {
    log('reopen-request', 'Native session restore');
    await openNative();
    await wait(1, firstWaitSeconds);
    if (windows.length === 0 && selected.length) {
      log('reopen-fallback', 'Native restore did not produce a window. Opening known project.');
      await openTarget(selected[0]);
      triedFallback = true;
      await wait(1, 4);
    }
  }

  const restored = windows.length >= expected;
  const partial = expected > 0 && !restored && windows.length > 0;
  log(restored ? 'reopen-ok' : partial ? 'reopen-partial' : 'reopen-missing',
    'visible=' + windows.length + ' expected=' + expected + ' fallback=' + triedFallback);

  return {
    restored,
    partial,
    visibleWindows: windows.length,
    expectedWindows: expected,
    requested: selected,
    restoreMode: mode,
    fallbackUsed: triedFallback,
  };
}
