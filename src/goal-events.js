import crypto from 'node:crypto';
import { goalFile, writeJSON } from './goal-store.js';

export const redactExecutionText = (value) => String(value ?? '')
  .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[chave ocultada]')
  .replace(/((?:access_token|refresh_token|OPENAI_API_KEY)["'\s:=]+)[^\s,"'}]+/gi, '$1[ocultado]')
  .replace(/(Bearer\s+)[A-Za-z0-9_.-]+/gi, '$1[ocultado]');

export function createExecutionRecorder(threadId, { now = Date.now, persist = (value) => writeJSON(goalFile('execution.json'), value), appendLog = () => {}, runId = crypto.randomUUID() } = {}) {
  const data = { runId, threadId, startedAt: now(), lastEventAt: null, turnActive: false, activeTurnId: null, detail: 'Conectando ao Codex CLI…', events: [], sequence: 0, pending: [] };
  let timer, output = '', streamKey = null;
  const flush = () => { if (timer) clearTimeout(timer); timer = null; if (output) { appendLog(output); output = ''; } persist(data); };
  const schedule = () => { if (!timer) { timer = setTimeout(flush, 200); timer.unref?.(); } };
  const append = (kind, text, itemId = null, delta = false) => {
    const safe = redactExecutionText(text).slice(0, 24000);
    if (!safe) return;
    let event = data.events.findLast((e) => itemId && e.itemId === itemId && e.kind === kind);
    const previousText = event?.text;
    if (event && delta) event.text = (event.text + safe).slice(-48000);
    else if (event && !delta) event.text = safe;
    else { event = { id: ++data.sequence, at: now(), kind, itemId, text: safe }; data.events.push(event); }
    data.events = data.events.slice(-250);
    while (data.events.length > 1 && data.events.reduce((n, e) => n + e.text.length, 0) > 500000) data.events.shift();
    const key = kind + ':' + itemId;
    if (delta) {
      if (streamKey !== key) output += `\n[${new Date(now()).toISOString()}] ${kind}\n`;
      output += safe; streamKey = key;
    } else if (previousText !== safe) {
      output += previousText && kind === 'message' && safe.startsWith(previousText) ? safe.slice(previousText.length) : `\n[${new Date(now()).toISOString()}] ${kind}\n${safe}\n`;
      streamKey = null;
    }
    data.lastEventAt = now(); schedule();
  };
  const record = (method, p = {}) => {
    if (p.threadId !== threadId) return;
    const item = p.item || {};
    data.lastEventAt = now();
    if (method === 'turn/started') {
      data.turnActive = true; data.activeTurnId = p.turn?.id || null; data.detail = 'Codex em execução'; append('turn', 'Turno iniciado: ' + (p.turn?.id || '')); flush();
    } else if (method === 'turn/completed') {
      data.turnActive = false; data.activeTurnId = null; data.detail = 'Turno ' + (p.turn?.status || 'encerrado');
      append(p.turn?.error ? 'error' : 'turn', data.detail + (p.turn?.error?.message ? ': ' + p.turn.error.message : '')); flush();
    } else if (method === 'item/agentMessage/delta' || method === 'item/plan/delta' || method === 'item/commandExecution/outputDelta') {
      const kind = method.includes('outputDelta') ? 'output' : method.includes('/plan/') ? 'plan' : 'message';
      data.detail = kind === 'output' ? 'Recebendo saída do comando' : 'Codex respondendo'; append(kind, p.delta, p.itemId, true);
    } else if (method === 'item/started' || method === 'item/completed') {
      const complete = method === 'item/completed';
      if (item.type === 'agentMessage' || item.type === 'plan') append(item.type === 'plan' ? 'plan' : 'message', item.text, item.id);
      if (item.type === 'commandExecution') {
        data.detail = (complete ? 'Comando encerrado: ' : 'Executando: ') + (item.command || item.status || '');
        append('command', data.detail + (item.exitCode != null ? '\nCódigo de saída: ' + item.exitCode : ''), item.id);
        if (item.aggregatedOutput) append('output', item.aggregatedOutput, item.id);
      }
      if (item.type === 'fileChange') {
        data.detail = complete ? 'Alterações em arquivos concluídas' : 'Alterando arquivos';
        append('files', data.detail + '\n' + (item.changes || []).map((c) => c.path + (c.diff ? '\n' + c.diff : '')).join('\n'), item.id);
      }
      if (['mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(item.type)) append('tool', (complete ? 'Concluído: ' : 'Ferramenta: ') + (item.tool || item.name || item.type), item.id);
    } else if (method === 'thread/goal/updated') {
      append('goal', 'Goal: ' + (p.goal?.status || 'atualizado'));
    } else if (method === 'error') {
      data.detail = p.error?.message || p.message || 'Erro no Codex'; append('error', data.detail); flush();
    } else if (method === 'client/disconnected') {
      data.turnActive = false; data.activeTurnId = null; data.detail = p.message || 'CLI desconectado'; append('error', data.detail); flush();
    }
  };
  const pending = (requests) => { data.pending = requests; if (requests.length) data.detail = 'Aguardando sua decisão no painel'; flush(); };
  flush();
  return { record, append, pending, flush, snapshot: () => data, close: () => { data.turnActive = false; data.activeTurnId = null; flush(); } };
}
