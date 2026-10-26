import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_DEPTH = 8;
const MAX_TAIL_BYTES = 256 * 1024;
const MAX_FILES = 64;
const ACTIVE_MS = 15 * 60 * 1000;
const HISTORY_LIMIT = 8;

function codexRoots() {
  const home = os.homedir();
  return [
    process.env.CODEX_HOME,
    path.join(home, '.codex-jey'),
    path.join(home, '.codex-americano'),
    path.join(home, '.codex-hb'),
    path.join(home, '.codex'),
  ].filter((root, index, values) => root && values.indexOf(root) === index);
}

function recentJsonlFiles(root) {
  const result = [];

  function visit(dir, depth) {
    if (depth > MAX_DEPTH) return;

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) continue;

      try {
        const stat = fs.statSync(full);
        result.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {}
    }
  }

  visit(root, 0);
  return result;
}

function readTail(file, size) {
  let handle = null;

  try {
    handle = fs.openSync(file, 'r');
    const length = Math.min(size, MAX_TAIL_BYTES);
    const start = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, start);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch {}
    }
  }
}

function textOf(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ');

  if (value && typeof value === 'object') {
    return textOf(value.text)
      || textOf(value.content)
      || textOf(value.summary)
      || textOf(value.message)
      || textOf(value.title)
      || '';
  }

  return '';
}

function short(value, max = 240) {
  const text = textOf(value);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function timestampOf(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function projectName(cwd) {
  if (!cwd) return '';
  const clean = String(cwd).replace(/[\\/]+$/, '');
  return clean.split(/[\\/]/).filter(Boolean).pop() || '';
}

function commandText(payload) {
  if (!payload || typeof payload !== 'object') return '';

  const args = payload.arguments || payload.input || payload.params;
  if (typeof args === 'string') {
    try { return commandText({ ...payload, arguments: JSON.parse(args) }); } catch {}
  }

  if (args && typeof args === 'object') {
    return short(args.command || args.cmd || args.commandLine || args.script || args.input);
  }

  return short(payload.command || payload.cmd || payload.commandLine);
}

function recordType(record) {
  const payload = record?.payload || record?.data || {};
  return [
    record?.type,
    record?.event,
    record?.name,
    payload?.type,
    payload?.event,
    payload?.name,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' ');
}

function describe(record) {
  const payload = record?.payload || record?.data || {};
  const type = recordType(record);

  if (/permission|approval|approve|exec_approval_request/.test(type)) {
    return {
      status: 'waiting',
      message: short(payload.text || payload.message || payload.reason) || 'Aguardando permissão',
      terminal: false,
    };
  }

  if (/(task|turn|session)[_-]?(complete|completed|end|ended)|(?:complete|completed)[_-]?(task|turn|session)|shutdown|process_exit|session_exit|turn_aborted|task_aborted/.test(type)) {
    let message = 'Tarefa concluída';
    if (/aborted|cancel|interrupt/.test(type)) message = 'Tarefa interrompida';
    if (/error|failed/.test(type)) message = short(payload.text || payload.message || payload.error) || 'Codex reportou um erro';

    return {
      status: 'stopped',
      message,
      terminal: true,
    };
  }

  if (/error|failed/.test(type)) {
    return {
      status: 'stopped',
      message: short(payload.text || payload.message || payload.error) || 'Codex reportou um erro',
      terminal: true,
    };
  }

  if (/exec_command_begin|command_begin|shell_command|apply_patch|patch_apply|file_write/.test(type)) {
    const command = commandText(payload);
    return {
      status: 'running',
      message: command ? 'Executando: ' + command : 'Executando comando',
      terminal: false,
    };
  }

  if (/exec_command_end|command_end|function_call_output|tool_result/.test(type)) {
    return {
      status: 'running',
      message: 'Comando concluído',
      terminal: false,
    };
  }

  if (/function_call|tool_call|tool_use/.test(type)) {
    return {
      status: 'running',
      message: commandText(payload) || short(payload.name || payload.tool) || 'Executando uma ação',
      terminal: false,
    };
  }

  if (/task[_-]?start|turn[_-]?start|session[_-]?start|user[_-]?message|prompt/.test(type)) {
    return {
      status: 'running',
      message: short(payload.text || payload.message || payload.prompt) || 'Codex iniciou uma tarefa',
      terminal: false,
    };
  }

  if (/reasoning|thinking|agent_message|assistant_message|response/.test(type)) {
    return {
      status: 'running',
      message: short(payload.text || payload.summary || payload.content || payload.message) || 'Codex pensando',
      terminal: false,
    };
  }

  if (payload?.type === 'message' || record?.type === 'message') {
    const message = short(payload.text || payload.content || payload.message);
    if (message) {
      return {
        status: 'running',
        message,
        terminal: false,
      };
    }
  }

  return null;
}

function parseFile(item) {
  const lines = readTail(item.file, item.size).split(/\r?\n/).filter(Boolean);
  const events = [];
  let cwd = '';
  let sessionId = '';
  let latestTimestamp = item.mtimeMs;

  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }

    const payload = record?.payload || record?.data || {};
    cwd ||= payload.cwd || payload.workdir || record.cwd || '';
    sessionId ||= payload.id || payload.session_id || record.session_id || record.id || '';

    const timestamp = timestampOf(
      record.timestamp || record.created_at || payload.timestamp || payload.created_at,
      item.mtimeMs,
    );
    latestTimestamp = Math.max(latestTimestamp, timestamp);

    const description = describe(record);
    if (!description) continue;

    const event = {
      status: description.status,
      message: description.message,
      terminal: description.terminal,
      updatedAt: new Date(timestamp).toISOString(),
      timestamp,
    };

    const previous = events[events.length - 1];
    if (!previous || previous.status !== event.status || previous.message !== event.message) {
      events.push(event);
    } else {
      events[events.length - 1] = event;
    }

    if (events.length > HISTORY_LIMIT) events.shift();
  }

  const latest = events[events.length - 1];
  if (!latest) return null;

  const ageMs = Math.max(0, Date.now() - latest.timestamp);
  const active = !latest.terminal
    && (latest.status === 'running' || latest.status === 'waiting')
    && ageMs <= ACTIVE_MS;

  return {
    status: active ? latest.status : latest.terminal ? 'stopped' : 'stale',
    message: latest.message,
    updatedAt: latest.updatedAt,
    active,
    terminal: latest.terminal,
    stale: !active && !latest.terminal,
    ageMs,
    project: projectName(cwd),
    sessionId: sessionId || path.basename(item.file, '.jsonl'),
    source: item.file,
    events: events
      .slice()
      .reverse()
      .map(({ timestamp, ...event }) => event),
  };
}

function compareCandidates(left, right) {
  if (left.active !== right.active) return left.active ? -1 : 1;
  if (left.status === 'waiting' && right.status !== 'waiting') return -1;
  if (right.status === 'waiting' && left.status !== 'waiting') return 1;
  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
}

const DASHBOARD_CACHE_MS = 2500;
const MOBILE_SESSION_LIMIT = 20;
let dashboardCache = null;
let dashboardCachedAt = 0;

function profileFromSource(source) {
  const normalized = String(source || '').replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.codex-jey/')) return 'JEY';
  if (normalized.includes('/.codex-americano/')) return 'AMERICANO';
  if (normalized.includes('/.codex-hb/')) return 'HB';
  return 'ATUAL';
}

function safeMessage(value) {
  return String(value || '')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[oculto]')
    .replace(/\b(?:sk-(?:proj-)?|gh[pousr]_)[a-z0-9_-]{10,}\b/gi, '[credencial oculta]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,"']+/gi, '$1[oculto]');
}

function mobileSession(candidate) {
  return {
    status: candidate.status,
    message: safeMessage(candidate.message),
    updatedAt: candidate.updatedAt,
    active: candidate.active,
    terminal: candidate.terminal,
    stale: candidate.stale,
    project: candidate.project,
    sessionId: candidate.sessionId,
    profile: profileFromSource(candidate.source),
    events: (candidate.events || []).slice(0, 8).map((event) => ({
      status: event.status,
      message: safeMessage(event.message),
      updatedAt: event.updatedAt,
      terminal: event.terminal,
    })),
  };
}

export function readCodexDashboard({ force = false } = {}) {
  const now = Date.now();
  if (!force && dashboardCache && now - dashboardCachedAt < DASHBOARD_CACHE_MS) {
    return dashboardCache;
  }

  const files = codexRoots()
    .flatMap(recentJsonlFiles)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES);

  const candidates = files
    .map(parseFile)
    .filter(Boolean)
    .sort(compareCandidates);

  const activeSessionCount = candidates.filter((candidate) => candidate.active).length;
  const waitingSessionCount = candidates.filter((candidate) => candidate.active && candidate.status === 'waiting').length;
  const sessions = candidates.slice(0, MOBILE_SESSION_LIMIT).map(mobileSession);
  const selected = sessions[0];
  const activity = selected
    ? {
        ...selected,
        sessionCount: candidates.length,
        activeSessionCount,
        waitingSessionCount,
      }
    : {
        status: 'stopped',
        message: 'Nenhuma atividade do Codex encontrada',
        active: false,
        terminal: false,
        stale: false,
        project: '',
        sessionId: '',
        profile: '',
        updatedAt: null,
        events: [],
        sessionCount: 0,
        activeSessionCount: 0,
        waitingSessionCount: 0,
      };

  dashboardCache = {
    activity,
    sessions,
    sessionCount: candidates.length,
    activeSessionCount,
    waitingSessionCount,
  };
  dashboardCachedAt = now;
  return dashboardCache;
}

export function readCodexActivity() {
  return readCodexDashboard().activity;
}
