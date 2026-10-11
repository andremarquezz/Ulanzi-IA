import path from 'node:path';

/**
 * The Code.exe process becoming available does not mean its first editor window
 * is ready. Sending the next invocation immediately can lose subsequent windows.
 * This helper waits for each requested project before asking for the next.
 */
export function windowMatchesTarget(window, target) {
  const basename = path.basename(target)
    .replace(/\.code-workspace$/i, '')
    .trim()
    .toLocaleLowerCase();
  const title = String(window?.title || '').toLocaleLowerCase();
  if (!basename || !title) return false;
  return title === basename
    || title.includes(' - ' + basename + ' - ')
    || title.startsWith(basename + ' - ')
    || title.endsWith(' - ' + basename)
    || title.includes('[' + basename + ']');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function restoreProjectWindows({
  targets,
  expectedCount,
  openTarget,
  openNative,
  listWindows,
  pause = sleep,
  log = () => {},
  pollAttempts = 12,
  pollDelayMs = 850,
}) {
  const expected = Math.max(0, Number(expectedCount) || 0);
  const explicit = targets.length >= expected && expected > 0;

  const inspect = async () => {
    try {
      return await listWindows();
    } catch (error) {
      log('reopen-check-error', error?.message || String(error));
      return [];
    }
  };

  const pollFor = async (target, minimumCount) => {
    let windows = [];
    for (let n = 0; n < pollAttempts; n++) {
      await pause(pollDelayMs);
      windows = await inspect();

      // Require a newly visible window before dispatching the next project.
      // Match the window title when possible, but support localized titles and
      // other VS Code window naming schemes through the count fallback.
      if (windows.some((window) => windowMatchesTarget(window, target))
        || windows.length >= minimumCount) {
        return windows;
      }
    }
    return windows;
  };

  log('restore', 'windowsBefore=' + expected
    + ' capturedTargets=' + targets.length
    + ' mode=' + (explicit ? 'explicit' : 'native'));

  let windows = await inspect();

  if (explicit) {
    let processed = 0;
    // Do not launch a second VS Code instance while the first is booting.
    // Each --new-window command is awaited until a corresponding editor opens.
    for (const target of targets) {
      processed++;
      if (windows.some((window) => windowMatchesTarget(window, target))) {
        log('reopen-skip', target + ' already visible.');
        continue;
      }

      for (let attempt = 1; attempt <= 2; attempt++) {
        const minimumCount = Math.max(windows.length + 1, processed);
        log('reopen-request', target + ' attempt=' + attempt);
        await openTarget(target);
        windows = await pollFor(target, minimumCount);
        log('reopen-observed', 'target=' + target
          + ' attempt=' + attempt
          + ' visibleWindows=' + windows.length);

        if (windows.some((window) => windowMatchesTarget(window, target))
          || windows.length >= minimumCount) {
          break;
        }
        if (attempt === 1) log('reopen-retry', target + ' did not create a visible editor.');
      }
    }
  } else {
    log('reopen-request', 'Native session restoration requested.');
    await openNative();
    windows = await pollFor(null, Math.max(1, expected));
    // When the native restore is incomplete but we know some folders, try to
    // recover each missing folder explicitly without killing current windows.
    if (windows.length < expected && targets.length > 0) {
      for (const target of targets) {
        if (windows.some((window) => windowMatchesTarget(window, target))) continue;
        const minimumCount = windows.length + 1;
        log('reopen-recover', target);
        await openTarget(target);
        windows = await pollFor(target, minimumCount);
      }
    }
  }

  // One more settling period for delayed extension hosts / restored windows.
  for (let i = 0; i < 5 && windows.length < expected; i++) {
    await pause(pollDelayMs);
    windows = await inspect();
  }

  log('reopen-check', 'visibleWindows=' + windows.length + ' expected=' + expected
    + ' titles=' + JSON.stringify(windows.map((w) => w.title)));
  const restored = windows.length >= expected;

  return {
    restored,
    visibleWindows: windows.length,
    expectedWindows: expected,
    requested: explicit ? targets : [],
    restoreMode: explicit ? 'explicit' : 'native',
  };
}
