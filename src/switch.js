import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const homes = {
  jey: path.join(os.homedir(), '.codex-jey'),
  americano: path.join(os.homedir(), '.codex-americano'),
};

const liveHome = path.join(os.homedir(), '.codex');

function digest(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

export function activeAccount() {
  const live = digest(path.join(liveHome, 'auth.json'));
  if (!live) return null;

  for (const [id, home] of Object.entries(homes)) {
    if (digest(path.join(home, 'auth.json')) === live) return id;
  }

  return null;
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

function restartVsCode() {
  if (process.platform !== 'win32') return false;
  if (!isVsCodeRunning()) return false;

  spawnSync('taskkill.exe', ['/IM', 'Code.exe', '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });

  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
  ];

  const exe = candidates.find((candidate) => {
    try { return candidate && fs.existsSync(candidate); } catch { return false; }
  });

  try {
    const child = exe
      ? spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('cmd.exe', ['/d', '/s', '/c', 'start "" code'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
    child.unref();
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

  fs.mkdirSync(liveHome, { recursive: true });

  const target = path.join(liveHome, 'auth.json');
  const tmp = path.join(liveHome, 'auth.json.jey-switch.tmp');

  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, target);

  const vscodeWasRunning = isVsCodeRunning();
  const vscodeRestarted = vscodeWasRunning ? restartVsCode() : false;

  return {
    ok: true,
    activeAccount: id,
    vscodeWasRunning,
    vscodeRestarted,
  };
}
