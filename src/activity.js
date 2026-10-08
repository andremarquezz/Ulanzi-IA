import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_DEPTH = 6;
const MAX_TAIL_BYTES = 128 * 1024;
const ACTIVE_MS = 2 * 60 * 1000;

function codexRoots() {
  const home = os.homedir();
  return [
    path.join(home, '.codex-jey'),
    path.join(home, '.codex-americano'),
    path.join(home, '.codex'),
  ].filter((root, index, values) => values.indexOf(root) === index);
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
  try {
    const handle = fs.openSync(file, 'r');
    const length = Math.min(size, MAX_TAIL_BYTES);
    const start = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, start);
    fs.closeSync(handle);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

function textOf(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ');
  if (value && typeof value === 'object') {
    return textOf(value.text) || textOf(value.content) || textOf(value.message) || '';
  }
  return '';
}

function short(value, max = 220) {
  const text = textOf(value);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
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

function describe(record) {
  const payload = record?.payload || record?.data || record;
  const type = String(record?.type || payload?.type || '').toLowerCase();
  const payloadType = String(payload?.type || '').toLowerCase();

  if (/permission|approval|approve/.test(type + ' ' + payloadType)) {
    return { status: 'waiting', message: 'Aguardando permissão' };
  }
  if (/task_complete|turn_complete|session_end|completed/.test(type + ' ' + payloadType)) {
    return { status: 'stopped', message: 'Tarefa concluída' };
  }
  if (/task_start|turn_start|session_start/.test(type + ' ' + payloadType)) {
    return { status: 'running', message: 'Codex iniciou uma tarefa' };
  }
  if (/exec_command_begin|command_begin|shell_command/.test(type + ' ' + payloadType)) {
    return { status: 'running', message: commandText(payload) ? 'Executando: ' + commandText(payload) : 'Executando comando' };
  }
  if (/exec_command_end|command_end|function_call_output/.test(type + ' ' + payloadType)) {
    return { status: 'running', message: 'Comando concluído' };
  }
  if (payloadType === 'function_call' || /function_call/.test(type)) {
    return { status: 'running', message: commandText(payload) || 'Executando uma ação' };
  }
  if (/reasoning|thinking/.test(type + ' ' + payloadType)) {
    return { status: 'running', message: short(payload.text || payload.summary || payload.content) || 'Codex pensando' };
  }
  if (payloadType === 'message' || type === 'message' || type === 'response_item') {
    const message = short(payload.text || payload.content || payload.message);
    if (message) return { status: 'running', message };
  }

  return null;
}

function parseFile(item) {
  const lines = readTail(item.file, item.size).split(/\r?\n/).filter(Boolean);
  let latest = null;
  let cwd = '';
  let sessionId = '';
  let timestamp = item.mtimeMs;

  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }

    const payload = record?.payload || record?.data || {};
    cwd ||= payload.cwd || payload.workdir || record.cwd || '';
    sessionId ||= payload.id || payload.session_id || record.session_id || '';
    const rawTime = record.timestamp || record.created_at || payload.timestamp;
    const parsedTime = rawTime ? Date.parse(rawTime) : NaN;
    if (Number.isFinite(parsedTime)) timestamp = parsedTime;

    const description = describe(record);
    if (description) latest = { ...description, timestamp };
  }

  if (!latest) return null;
  const active = Date.now() - Math.max(timestamp, item.mtimeMs) <= ACTIVE_MS;
  return {
    ...latest,
    status: active ? latest.status : 'stopped',
    message: active ? latest.message : 'Parado • ' + latest.message,
    updatedAt: new Date(Math.max(timestamp, item.mtimeMs)).toISOString(),
    active,
    project: cwd ? path.basename(cwd) : '',
    sessionId: sessionId || path.basename(item.file, '.jsonl'),
    source: item.file,
  };
}

export function readCodexActivity() {
  const files = codexRoots()
    .flatMap(recentJsonlFiles)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of files.slice(0, 12)) {
    const activity = parseFile(file);
    if (activity) return activity;
  }

  return {
    status: 'stopped',
    message: 'Nenhuma atividade do Codex encontrada',
    active: false,
    project: '',
    sessionId: '',
    updatedAt: null,
    source: '',
  };
}
