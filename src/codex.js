import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const REQUEST_ID = 2;
const TIMEOUT_MS = 7000;

export const ACCOUNTS = [
  { id: 'jey', label: 'JEY', home: path.join(os.homedir(), '.codex-jey') },
  { id: 'americano', label: 'AMERICANO', home: path.join(os.homedir(), '.codex-americano') },
];

function isScoped(limit) {
  return typeof limit?.limitName === 'string' && limit.limitName.trim().length > 0;
}

function rawWindowMinutes(win) {
  if (!win) return undefined;
  if (typeof win.windowDurationMins === 'number') return win.windowDurationMins;
  if (typeof win.windowMinutes === 'number') return win.windowMinutes;
  return undefined;
}

function hasWindow(limit) {
  return [limit?.primary, limit?.secondary].some((win) => typeof rawWindowMinutes(win) === 'number');
}

function pickAccountWide(result) {
  const top = result?.rateLimits;
  if (top && !isScoped(top) && hasWindow(top)) return top;

  const values = Object.values(result?.rateLimitsByLimitId ?? {});
  const withWindows = values.find((limit) => limit && !isScoped(limit) && hasWindow(limit));
  if (withWindows) return withWindows;

  return values.find((limit) => limit && !isScoped(limit)) ?? null;
}

function normalizeWindow(raw) {
  if (!raw || typeof raw.usedPercent !== 'number') return null;
  const windowMinutes = rawWindowMinutes(raw);
  if (typeof windowMinutes !== 'number') return null;

  return {
    usedPercent: Math.max(0, Math.min(100, raw.usedPercent)),
    windowMinutes,
    resetsAt:
      typeof raw.resetsAt === 'number' && raw.resetsAt > 0
        ? new Date(raw.resetsAt * 1000).toISOString()
        : undefined,
  };
}

function normalizeLimits(result) {
  const limits = pickAccountWide(result);
  if (!limits) return null;

  const windows = [normalizeWindow(limits.primary), normalizeWindow(limits.secondary)].filter(Boolean);
  const fiveHour =
    windows.find((w) => w.windowMinutes === 300)
    ?? windows.find((w) => w.windowMinutes > 0 && w.windowMinutes < 1440);
  const sevenDay =
    windows.find((w) => w.windowMinutes === 10080)
    ?? windows.find((w) => w.windowMinutes >= 1440);

  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

function existingFile(file) {
  try { return file && fs.existsSync(file) ? file : null; } catch { return null; }
}

function resolveCodexBinary() {
  if (process.env.JEY_CODEX_BIN) return process.env.JEY_CODEX_BIN;

  if (process.platform !== 'win32') return 'codex';

  try {
    const found = spawnSync('where.exe', ['codex'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (found.status === 0 && found.stdout) {
      const paths = found.stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      const executable = paths.find((value) => /\.exe$/i.test(value));
      if (executable) return executable;
      const cmd = paths.find((value) => /\.(cmd|bat)$/i.test(value));
      if (cmd) return cmd;
    }
  } catch {}

  const extensionRoots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
  ];

  for (const root of extensionRoots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }

    const openaiDirs = dirs
      .filter((entry) => entry.isDirectory() && /openai|chatgpt|codex/i.test(entry.name))
      .map((entry) => path.join(root, entry.name));

    for (const dir of openaiDirs) {
      for (const relative of [
        path.join('bin', 'windows-x86_64', 'codex.exe'),
        path.join('bin', 'windows-arm64', 'codex.exe'),
        path.join('bin', 'codex.exe'),
      ]) {
        const hit = existingFile(path.join(dir, relative));
        if (hit) return hit;
      }
    }
  }

  return 'codex';
}

function codexSpawnTarget() {
  const binary = resolveCodexBinary();

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    return {
      command: comspec,
      argsPrefix: ['/d', '/s', '/c'],
      commandLine: '"' + binary + '" app-server',
      shell: false,
      display: binary,
    };
  }

  if (process.platform === 'win32' && !/\.exe$/i.test(binary) && !path.isAbsolute(binary)) {
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    return {
      command: comspec,
      argsPrefix: ['/d', '/s', '/c'],
      commandLine: binary + ' app-server',
      shell: false,
      display: binary,
    };
  }

  return {
    command: binary,
    argsPrefix: [],
    commandLine: null,
    shell: false,
    display: binary,
  };
}

function stopTree(child, shell) {
  try { child.kill('SIGKILL'); } catch {}
  if (process.platform === 'win32' && shell && child.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {});
    } catch {}
  }
}

async function queryRateLimits(home) {
  const target = codexSpawnTarget();

  return new Promise((resolve) => {
    let child;
    try {
      const args = target.commandLine
        ? [...target.argsPrefix, target.commandLine]
        : ['app-server'];
      child = spawn(target.command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env: { ...process.env, CODEX_HOME: home },
      });
    } catch (error) {
      resolve({ limits: null, error: 'spawn failed (' + target.display + '): ' + String(error) });
      return;
    }

    let done = false;
    let buffer = '';
    let stderr = '';
    let initialized = false;

    const finish = (limits, error = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopTree(child, target.commandLine !== null);
      resolve({ limits, error });
    };

    const timer = setTimeout(() => {
      const detail = stderr.trim();
      finish(null, detail ? 'timeout: ' + detail : 'timeout waiting for app-server');
    }, TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (error) => finish(null, 'process error: ' + String(error)));
    child.on('exit', (code) => {
      if (!done) {
        const detail = stderr.trim();
        finish(null, 'app-server exited code=' + String(code) + (detail ? ': ' + detail : ''));
      }
    });
    child.stdin?.on('error', (error) => finish(null, 'stdin error: ' + String(error)));

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    const send = (frame) => {
      child.stdin?.write(JSON.stringify(frame) + '\n');
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;

        let message;
        try { message = JSON.parse(line); } catch { continue; }

        if (message?.id === 1) {
          if (message.error) {
            finish(null, 'initialize failed: ' + JSON.stringify(message.error));
            return;
          }
          if (initialized) continue;
          initialized = true;

          try {
            send({ jsonrpc: '2.0', method: 'initialized', params: {} });
            send({ jsonrpc: '2.0', id: REQUEST_ID, method: 'account/rateLimits/read' });
          } catch (error) {
            finish(null, 'request write failed: ' + String(error));
          }
          continue;
        }

        if (message?.id === REQUEST_ID) {
          if (message.error) {
            finish(null, 'rate limits failed: ' + JSON.stringify(message.error));
            return;
          }

          const limits = normalizeLimits(message.result);
          if (!limits) {
            finish(null, 'rate limits response had no 5H/7D windows');
            return;
          }

          finish(limits);
          return;
        }
      }
    });

    try {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'jey-codex-d200h',
            title: 'Jey Codex D200H',
            version: '1.0.0',
          },
          capabilities: {
            experimentalApi: true,
          },
        },
      });
    } catch (error) {
      finish(null, 'initialize write failed: ' + String(error));
    }
  });
}

export async function queryAccount(account) {
  if (!fs.existsSync(path.join(account.home, 'auth.json'))) {
    return { id: account.id, label: account.label, status: 'login', fiveHour: null, sevenDay: null };
  }

  const query = await queryRateLimits(account.home);
  if (!query.limits) {
    return {
      id: account.id,
      label: account.label,
      status: 'error',
      error: query.error ?? 'unknown app-server error',
      fiveHour: null,
      sevenDay: null,
    };
  }

  return {
    id: account.id,
    label: account.label,
    status: 'ok',
    fiveHour: query.limits.fiveHour,
    sevenDay: query.limits.sevenDay,
  };
}

export async function queryAllAccounts() {
  const results = await Promise.all(ACCOUNTS.map(queryAccount));
  return new Map(results.map((result) => [result.id, result]));
}
