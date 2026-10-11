import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { restoreProjectWindows } from './window-restore.js';

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
    const error = new AccountSwitchError(
      'BACKGROUND_PROCESS',
      'As janelas fecharam, mas ' + backgroundCount
      + ' processo(s) Code.exe continuaram em segundo plano. A conta nao foi alterada. Veja o switch.log.',
    );
    error.windowsBefore = count;
    throw error;
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

  const common = ['--profile', VSCODE_PROFILE];
  const result = await restoreProjectWindows({
    targets,
    expectedCount,
    openTarget: (target) => launchCode(exe, [...common, '--new-window', target]),
    openNative: () => launchCode(exe, common),
    listWindows: inspectVisibleVsCodeWindows,
    pause: wait,
    log: (step, detail) => writeLog(run, step, detail),
  });

  if (!result.restored) {
    const error = new AccountSwitchError(
      'REOPEN_INCOMPLETE',
      'A conta foi trocada, mas so ' + result.visibleWindows
        + ' de ' + result.expectedWindows + ' janela(s) do VS Code foram restauradas.'
        + ' Verifique o log para identificar os projetos pendentes.',
    );
    error.windowsRestored = result.visibleWindows;
    error.windowsExpected = result.expectedWindows;
    throw error;
  }

  writeLog(run, 'reopen-ok', 'Restored ' + result.visibleWindows + ' VS Code windows.');
  return result;
}

export async function switchCodexAccount(id, { onProgress = () => {} } = {}) {
  const run = new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + id;
  const progress = (message) => {
    writeLog(run, 'progress', message);
    onProgress(message);
  };

  writeLog(run, 'start', 'target=' + id);
  let credentialsApplied = false;
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
      try {
        originalWindows = await closeAllVsCode(run, progress);
      } catch (error) {
        // The auth has not been modified. If every editor window did close
        // but a background process stayed alive, try restoring the original
        // projects so a failed switch does not leave the desktop empty.
        if (error.code === 'BACKGROUND_PROCESS' && error.windowsBefore > 0) {
          writeLog(run, 'rollback', 'Background process remained. Reopening unchanged account.');
          try {
            await reopenVsCode(run, targetsBeforeClose, error.windowsBefore, progress);
            writeLog(run, 'rollback-ok', 'Original Codex account was kept and editors were reopened.');
          } catch (restoreError) {
            writeLog(run, 'rollback-error', restoreError.message || String(restoreError));
          }
        }
        throw error;
      }
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
    credentialsApplied = true;
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
    // Restart errors happen after auth.json was replaced. Do not imply that
    // authentication failed when only the editor restoration was incomplete.
    error.accountChanged = credentialsApplied && activeAccount() === id;
    error.activeAccount = activeAccount();
    writeLog(run, 'ERROR', (error.code || 'UNKNOWN')
      + ' accountChanged=' + error.accountChanged
      + ' activeAccount=' + error.activeAccount + ' '
      + (error.stack || error.message || String(error)));
    throw error;
  }
}
