import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const homes = {
  jey: path.join(os.homedir(), '.codex-jey'),
  americano: path.join(os.homedir(), '.codex-americano'),
};

const liveHome = path.join(os.homedir(), '.codex');
const VSCODE_PROFILE = process.env.JEY_VSCODE_PROFILE || 'Jey';

function readAccountId(file) {
  try {
    const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
    return auth?.tokens?.account_id || auth?.account_id || null;
  } catch {
    return null;
  }
}

export function activeAccount() {
  const liveId = readAccountId(path.join(liveHome, 'auth.json'));
  if (!liveId) return null;

  for (const [id, home] of Object.entries(homes)) {
    if (readAccountId(path.join(home, 'auth.json')) === liveId) return id;
  }

  return null;
}

function preserveCurrentAuth() {
  const id = activeAccount();
  if (!id) return;

  const source = path.join(liveHome, 'auth.json');
  const target = path.join(homes[id], 'auth.json');
  if (!fs.existsSync(source)) return;

  fs.mkdirSync(homes[id], { recursive: true });
  fs.copyFileSync(source, target);
}

function isVsCodeRunning() {
  if (process.platform !== 'win32') return false;

  try {
    const result = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq Code.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /Code\.exe/i.test(result.stdout || '');
  } catch {
    return false;
  }
}

function visibleVsCodeWindowCount() {
  if (process.platform !== 'win32') return 0;

  const command = "@(Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count";
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const count = Number.parseInt(String(result.stdout || '').trim(), 10);
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function codeExecutable() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft VS Code', 'Code.exe'),
  ];

  return candidates.find((candidate) => {
    try { return candidate && fs.existsSync(candidate); } catch { return false; }
  }) || null;
}

function uriOrPath(value) {
  if (!value) return null;

  if (typeof value === 'object') {
    return uriOrPath(
      value.configPath
      || value.uri
      || value.external
      || value.fsPath
      || value.path,
    );
  }

  const raw = String(value);
  if (!raw) return null;

  try {
    if (/^file:/i.test(raw)) return path.normalize(fileURLToPath(raw));
  } catch {}

  if (path.isAbsolute(raw)) return path.normalize(raw);
  return null;
}

function targetsFromStorage(file) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }

  const state = data?.windowsState || {};
  const entries = [
    ...(Array.isArray(state.openedWindows) ? state.openedWindows : []),
    state.lastActiveWindow,
  ].filter(Boolean);

  const result = [];
  for (const entry of entries) {
    const candidates = [
      entry?.workspace?.configPath,
      entry?.workspace,
      entry?.workspaceUri,
      entry?.folder,
      entry?.folderUri,
      entry?.folderPath,
    ];

    const target = candidates.map(uriOrPath).find(Boolean);
    if (!target) continue;

    try {
      if (fs.existsSync(target)) result.push(target);
    } catch {}
  }

  return result;
}

function captureVsCodeTargets() {
  if (process.platform !== 'win32') return [];

  const appData = process.env.APPDATA || '';
  const storageFiles = [
    path.join(appData, 'Code', 'storage.json'),
    path.join(appData, 'Code - Insiders', 'storage.json'),
  ];

  const seen = new Set();
  const targets = [];

  for (const file of storageFiles) {
    for (const target of targetsFromStorage(file)) {
      const key = target.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }
  }

  return targets;
}

function closeVsCodeGracefully() {
  if (process.platform !== 'win32') return true;
  if (!isVsCodeRunning()) return true;

  const closeCommand = "Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }";
  spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', closeCommand], {
    stdio: 'ignore',
    windowsHide: true,
  });

  const deadline = Date.now() + 15000;
  while (visibleVsCodeWindowCount() > 0 && Date.now() < deadline) sleep(300);

  if (visibleVsCodeWindowCount() > 0) return false;

  if (isVsCodeRunning()) {
    spawnSync('taskkill.exe', ['/IM', 'Code.exe', '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }

  const backgroundDeadline = Date.now() + 5000;
  while (isVsCodeRunning() && Date.now() < backgroundDeadline) sleep(250);
  return !isVsCodeRunning();
}

function spawnCode(exe, args) {
  const child = exe
    ? spawn(exe, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, CODEX_HOME: liveHome },
      })
    : spawn('cmd.exe', ['/d', '/s', '/c', 'start "" code ' + args.map((arg) => '"' + arg.replaceAll('"', '\\"') + '"').join(' ')], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, CODEX_HOME: liveHome },
      });
  child.unref();
}

function restartVsCode(targets) {
  if (process.platform !== 'win32') return false;

  const exe = codeExecutable();
  const common = ['--profile', VSCODE_PROFILE];

  try {
    if (targets.length > 0) {
      targets.forEach((target, index) => {
        const args = [...common, ...(index > 0 ? ['--new-window'] : []), target];
        spawnCode(exe, args);
        if (index === 0) sleep(650);
      });
    } else {
      spawnCode(exe, common);
    }
    return true;
  } catch {
    return false;
  }
}

export async function switchCodexAccount(id) {
  const sourceHome = homes[id];
  if (!sourceHome) throw new Error('Conta invalida.');

  const source = path.join(sourceHome, 'auth.json');
  if (!fs.existsSync(source)) {
    throw new Error('auth.json nao encontrado para ' + id.toUpperCase());
  }

  const current = activeAccount();
  if (current === id) {
    return {
      ok: true,
      activeAccount: id,
      alreadyActive: true,
      vscodeWasRunning: isVsCodeRunning(),
      vscodeRestarted: false,
      reopenedTargets: [],
    };
  }

  const vscodeWasRunning = isVsCodeRunning();
  const targets = vscodeWasRunning ? captureVsCodeTargets() : [];

  if (vscodeWasRunning && !closeVsCodeGracefully()) {
    throw new Error('Feche ou salve as janelas pendentes do VS Code e tente novamente.');
  }

  preserveCurrentAuth();

  fs.mkdirSync(liveHome, { recursive: true });
  const target = path.join(liveHome, 'auth.json');
  const tmp = path.join(liveHome, 'auth.json.jey-switch.tmp');
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, target);

  const vscodeRestarted = vscodeWasRunning ? restartVsCode(targets) : false;

  return {
    ok: true,
    activeAccount: id,
    alreadyActive: false,
    vscodeWasRunning,
    vscodeRestarted,
    reopenedTargets: vscodeRestarted ? targets : [],
  };
}
