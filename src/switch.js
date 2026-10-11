import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const homes = {
  jey: path.join(os.homedir(), '.codex-jey'),
  americano: path.join(os.homedir(), '.codex-americano'),
};

const liveHome = path.join(os.homedir(), '.codex');
const VSCODE_PROFILE = process.env.JEY_VSCODE_PROFILE || 'Jey';
const LOG_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CodexLimits');
export const SWITCH_LOG_FILE = path.join(LOG_DIR, 'switch.log');
const closeScript = path.join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'vscode-close-all.ps1');

function writeLog(run, stage, detail = '') {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });

    if (fs.existsSync(SWITCH_LOG_FILE) && fs.statSync(SWITCH_LOG_FILE).size > 1024 * 1024) {
      fs.renameSync(SWITCH_LOG_FILE, SWITCH_LOG_FILE + '.old');
    }

    const line = [new Date().toISOString(), 'run=' + run, stage, String(detail).replaceAll('\n', ' ')].join(' | ');
    fs.appendFileSync(SWITCH_LOG_FILE, line + '\n', 'utf8');
  } catch {
    // Logging must never prevent a safe switch.
  }
}

export class AccountSwitchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountSwitchError';
    this.code = code;
  }
}

function readAccountId(file) {
  try {
    const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
    return auth?.tokens?.account_id || auth?.account_id || null;
  } catch {
    return null;
  }
}

export function activeAccount() {
  const live = readAccountId(path.join(liveHome, 'auth.json'));
  if (!live) return null;
  for (const [id, home] of Object.entries(homes)) {
    if (readAccountId(path.join(home, 'auth.json')) === live) return id;
  }
  return null;
}

function preserveCurrentAuth(run) {
  const account = activeAccount();
  const source = path.join(liveHome, 'auth.json');
  if (!fs.existsSync(source)) return;

  if (!account) {
    // Never overwrite either dedicated login when we cannot identify the live account.
    const backup = path.join(liveHome, 'auth-unknown-before-switch.bak');
    fs.copyFileSync(source, backup);
    writeLog(run, 'auth', 'Unknown current account backed up locally.');
    return;
  }

  const destination = path.join(homes[account], 'auth.json');
  fs.copyFileSync(source, destination);
  writeLog(run, 'auth', 'Saved current credential to ' + account + ' vault.');
}

async function isVsCodeRunning() {
  if (process.platform !== 'win32') return false;
  const { stdout } = await execFileAsync('tasklist.exe', ['/FI', 'IMAGENAME eq Code.exe', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  return /Code\.exe/i.test(stdout);
}

function codeExecutable() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft VS Code', 'Code.exe'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function uriOrPath(value) {
  if (!value) return null;

  if (typeof value === 'object') {
    return uriOrPath(value.configPath || value.uri || value.external || value.fsPath || value.path);
  }

  const raw = String(value);
  if (!raw) return null;
  if (/^file:/i.test(raw)) {
    try { return path.normalize(fileURLToPath(raw)); } catch { return null; }
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : null;
}

export function targetsFromStorage(file) {
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }

  const state = json?.windowsState ?? {};
  const entries = [
    ...(Array.isArray(state.openedWindows) ? state.openedWindows : []),
    state.lastActiveWindow,
  ].filter(Boolean);

  const results = [];
  for (const entry of entries) {
    const candidates = [
      entry?.workspace?.configPath,
      entry?.workspaceIdentifier?.configURIPath,
      entry?.workspace,
      entry?.workspaceUri,
      entry?.folder,
      entry?.folderUri,
      entry?.folderPath,
    ];

    const target = candidates.map(uriOrPath).find((value) => value && fs.existsSync(value));
    if (target) results.push(target);
  }
  return results;
}

function captureVsCodeTargets() {
  const appData = process.env.APPDATA || '';
  const files = [
    path.join(appData, 'Code', 'storage.json'),
    path.join(appData, 'Code', 'User', 'globalStorage', 'storage.json'),
    path.join(appData, 'Code - Insiders', 'storage.json'),
    path.join(appData, 'Code - Insiders', 'User', 'globalStorage', 'storage.json'),
  ];

  const seen = new Set();
  const results = [];
  for (const file of files) {
    for (const target of targetsFromStorage(file)) {
      const key = target.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(target);
    }
  }
  return results;
}

async function closeAllVsCode(run, progress) {
  if (!fs.existsSync(closeScript)) {
    throw new AccountSwitchError('HELPER_MISSING', 'Arquivo auxiliar de fechamento nao foi encontrado. Reinstale o plugin.');
  }

  progress('Fechando todas as janelas...');
  writeLog(run, 'close', 'Requesting WM_CLOSE for every real Code.exe window.');

  let stdout;
  try {
    const response = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', closeScript,
      '-Mode', 'close',
      '-TimeoutSeconds', '35',
    ], { encoding: 'utf8', windowsHide: true, timeout: 48000, maxBuffer: 1024 * 1024 });
    stdout = response.stdout;
  } catch (error) {
    writeLog(run, 'close-error', error.message);
    throw new AccountSwitchError('CLOSE_COMMAND', 'Falha ao fechar o VS Code. Consulte switch.log.');
  }

  let outcome;
  try { outcome = JSON.parse(stdout.trim()); } catch {
    writeLog(run, 'close-error', 'Invalid close helper response: ' + String(stdout).slice(0, 350));
    throw new AccountSwitchError('CLOSE_RESPONSE', 'Nao foi possivel verificar as janelas do VS Code.');
  }

  const count = outcome.windowsBefore?.length || 0;
  const remaining = outcome.windowsRemaining?.length || 0;
  const backgroundCount = outcome.processesRemaining || 0;
  writeLog(run, 'windows', 'before=' + count
    + ' remaining=' + remaining
    + ' processesRemaining=' + backgroundCount
    + ' backgroundStops=' + (outcome.backgroundStopAttempts || 0)
    + ' remainingPids=' + JSON.stringify(outcome.backgroundProcessesRemaining || []));
  for (const window of outcome.windowsBefore || []) {
    writeLog(run, 'window', window.title);
  }
  for (const detail of outcome.backgroundErrors || []) {
    writeLog(run, 'background-stop-error', detail);
  }

  if (!outcome.success) {
    if (remaining > 0) {
      throw new AccountSwitchError(
        'WINDOWS_OPEN',
        'Ainda existem ' + remaining + ' janela(s) do VS Code abertas. Salve os arquivos e feche os dialogos pendentes.',
      );
    }
    throw new AccountSwitchError(
      'BACKGROUND_PROCESS',
      'As janelas fecharam, mas ' + backgroundCount
      + ' processo(s) Code.exe continuaram em segundo plano. A conta nao foi alterada. Veja o switch.log.',
    );
  }

  return count;
}

async function inspectVisibleVsCodeWindows() {
  const response = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', closeScript,
    '-Mode', 'list',
  ], { encoding: 'utf8', windowsHide: true, timeout: 18000, maxBuffer: 1024 * 1024 });

  const result = JSON.parse(response.stdout.trim());
  return Array.isArray(result.windows) ? result.windows : [];
}

async function launchCode(exe, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: liveHome },
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reopenVsCode(run, targets, expectedCount, progress) {
  progress('Reabrindo projetos...');

  const exe = codeExecutable();
  if (!exe) {
    throw new AccountSwitchError('CODE_MISSING', 'Conta alterada, mas Code.exe nao foi encontrado.');
  }

  // The storage file is captured after all windows finish closing and the session is persisted.
  // If it lists fewer projects than editor windows, leave restoration to VS Code itself
  // rather than reopening only a partial set of projects.
  const explicit = targets.length > 0 && targets.length >= expectedCount;
  writeLog(run, 'restore', 'windowsBefore=' + expectedCount + ' capturedTargets=' + targets.length + ' mode=' + (explicit ? 'explicit' : 'native'));

  const common = ['--profile', VSCODE_PROFILE];
  if (explicit) {
    for (const target of targets) {
      await launchCode(exe, [...common, '--new-window', target]);
      writeLog(run, 'reopen-request', target);
      await wait(750);
    }
  } else {
    await launchCode(exe, common);
    writeLog(run, 'reopen-request', 'Native window/session restoration requested.');
  }

  // Check real editor windows, not just Code.exe background processes.
  // A launch is not considered successful when only one of three windows returns.
  for (let attempt = 0; attempt < 3; attempt++) {
    await wait(attempt === 0 ? 3500 : 4500);

    try {
      const opened = await inspectVisibleVsCodeWindows();
      writeLog(run, 'reopen-check', 'attempt=' + (attempt + 1) + ' visibleWindows=' + opened.length + ' expected=' + expectedCount);
      if (opened.length >= expectedCount) {
        writeLog(run, 'reopen-ok', 'All ' + expectedCount + ' VS Code windows detected.');
        return { requested: explicit ? targets : [], restoreMode: explicit ? 'explicit' : 'native' };
      }
    } catch (error) {
      writeLog(run, 'reopen-check-error', error.message);
    }
  }

  const codeAlive = await isVsCodeRunning();
  const reason = codeAlive
    ? 'O VS Code iniciou, mas nao foi possivel confirmar todas as ' + expectedCount + ' janelas. Confira os projetos e consulte o log.'
    : 'A conta foi trocada, mas o VS Code nao iniciou. Abra-o normalmente e consulte o log.';

  throw new AccountSwitchError(codeAlive ? 'REOPEN_INCOMPLETE' : 'REOPEN_TIMEOUT', reason);
}

export async function switchCodexAccount(id, { onProgress = () => {} } = {}) {
  const run = new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + id;
  const progress = (message) => {
    writeLog(run, 'progress', message);
    onProgress(message);
  };

  writeLog(run, 'start', 'target=' + id);
  try {
    if (process.platform !== 'win32') {
      throw new AccountSwitchError('OS_UNSUPPORTED', 'A troca automatica so esta disponivel no Windows.');
    }

    if (!homes[id]) {
      throw new AccountSwitchError('INVALID_ACCOUNT', 'Conta invalida: ' + id);
    }

    const source = path.join(homes[id], 'auth.json');
    if (!fs.existsSync(source) || !readAccountId(source)) {
      throw new AccountSwitchError('LOGIN_MISSING', 'O login do Codex ' + id.toUpperCase() + ' nao foi encontrado. Configure essa conta primeiro.');
    }

    const jeyId = readAccountId(path.join(homes.jey, 'auth.json'));
    const americanoId = readAccountId(path.join(homes.americano, 'auth.json'));
    if (jeyId && americanoId && jeyId === americanoId) {
      throw new AccountSwitchError('SAME_LOGIN', 'Jey e Americano estao com o mesmo login. Confira o configurador.');
    }

    if (activeAccount() === id) {
      writeLog(run, 'already-active', id);
      return { ok: true, activeAccount: id, alreadyActive: true, vscodeWasRunning: await isVsCodeRunning(), vscodeRestarted: false, reopenedTargets: [] };
    }

    const wasRunning = await isVsCodeRunning();
    const targetsBeforeClose = wasRunning ? captureVsCodeTargets() : [];
    writeLog(run, 'pre-close-targets', 'found=' + targetsBeforeClose.length);
    let originalWindows = 0;
    if (wasRunning) {
      progress('Identificando janelas abertas...');
      originalWindows = await closeAllVsCode(run, progress);
      // Never modify the auth if the editor is still running.
      if (await isVsCodeRunning()) {
        throw new AccountSwitchError('PROCESS_STILL_RUNNING', 'Ainda existe Code.exe em execucao. Troca cancelada.');
      }
    }

    // Credentials are swapped only after all windows are safely closed.
    progress('Aplicando conta ' + id.toUpperCase() + '...');
    preserveCurrentAuth(run);
    fs.mkdirSync(liveHome, { recursive: true });

    const destination = path.join(liveHome, 'auth.json');
    const backup = path.join(liveHome, 'auth.before-last-switch.bak');
    if (fs.existsSync(destination)) fs.copyFileSync(destination, backup);
    const temp = path.join(liveHome, 'auth.switching.tmp');
    fs.copyFileSync(source, temp);
    fs.renameSync(temp, destination);
    writeLog(run, 'auth-swapped', 'live auth now points to ' + id);

    // Read the persisted state again after the editor closes. Keep the pre-close
    // snapshot as an additional source in case the last window overwrites storage.
    const targetsAfterClose = wasRunning && originalWindows > 0 ? captureVsCodeTargets() : [];
    const targetMap = new Map();
    for (const value of [...targetsAfterClose, ...targetsBeforeClose]) {
      targetMap.set(value.toLowerCase(), value);
    }
    const targets = originalWindows > 0 ? [...targetMap.values()] : [];

    writeLog(run, 'targets', 'before=' + targetsBeforeClose.length
      + ' after=' + targetsAfterClose.length + ' union=' + targets.length);
    for (const target of targets) writeLog(run, 'target', target);

    let restart = { requested: [], restoreMode: 'none' };
    if (originalWindows > 0) {
      restart = await reopenVsCode(run, targets, originalWindows, progress);
    }

    progress('Concluido');
    writeLog(run, 'success', 'target=' + id + ' reopenMode=' + restart.restoreMode);

    return {
      ok: true,
      activeAccount: id,
      alreadyActive: false,
      vscodeWasRunning: wasRunning,
      vscodeRestarted: originalWindows > 0,
      reopenedTargets: restart.requested,
      restoreMode: restart.restoreMode,
    };
  } catch (error) {
    writeLog(run, 'ERROR', (error.code || 'UNKNOWN') + ' ' + (error.stack || error.message || String(error)));
    throw error;
  }
}
