import fs from 'node:fs';
import { acquireLock, goalFile, readJSON, writeJSON, goalLog } from './goal-store.js';
import { runGoalEngine } from './goal-engine.js';
import { createExecutionRecorder, redactExecutionText } from './goal-events.js';

let release, recorder, timer, client;
const refreshPending = () => {
  if (!recorder) return;
  recorder.pending((client?.pendingApprovals || []).map((r) => ({
    id: r.id, method: r.method, kind: r.params.kind,
    command: redactExecutionText(r.params.command), cwd: r.params.cwd,
    reason: redactExecutionText(r.params.reason), permissions: r.params.permissions,
    grantRoot: r.params.grantRoot, questions: r.params.questions,
    availableDecisions: r.params.availableDecisions,
  })));
};
try {
  release = acquireLock('monitor.lock');
  const selection = readJSON(goalFile('selection.json'));
  if (!selection.id) throw new Error('Selecione um Goal antes de iniciar a execução.');
  recorder = createExecutionRecorder(selection.id, { runId: selection.runId, appendLog: (text) => {
    const file = goalFile('execution.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 4 * 1024 * 1024) fs.renameSync(file, file + '.previous');
    fs.appendFileSync(file, text, { mode: 0o600 });
  } });
  recorder.append('session', 'Nova execução: ' + selection.title + '\nConversa: ' + selection.id);
  try { fs.unlinkSync(goalFile('decision.json')); } catch {}
  timer = setInterval(() => {
    const decision = readJSON(goalFile('decision.json'));
    if (!decision.runId) return;
    try { fs.unlinkSync(goalFile('decision.json')); } catch { return; }
    if (decision.runId !== recorder.snapshot().runId) return;
    try {
      client?.respond(decision.id, decision.decision, decision.answers);
      recorder.append('decision', decision.decision === 'answer' ? 'Resposta enviada ao Codex.' : 'Decisão enviada: ' + decision.decision);
    } catch (error) { recorder.append('error', error.message); }
    refreshPending();
  }, 200);
  fs.writeFileSync(goalFile('worker-ready'), String(process.pid));
  await runGoalEngine(selection, (state) => {
    writeJSON(goalFile('state.json'), state);
    goalLog(state.state, state.detail);
  }, {
    onClient: (rpc) => { client = rpc; refreshPending(); },
    onNotification: (method, params) => { recorder.record(method, params); if (['serverRequest/resolved', 'client/disconnected'].includes(method)) refreshPending(); },
    onApproval: (request) => {
      if (typeof request === 'string') recorder.append('error', 'Solicitação não suportada: ' + request);
      else { recorder.append('approval', 'Aguardando sua decisão: ' + request.method); refreshPending(); }
    },
  });
} catch (error) {
  goalLog('worker-error', error.message);
  recorder?.append('error', error.message);
  process.exitCode = 1;
} finally {
  if (timer) clearInterval(timer);
  try { fs.unlinkSync(goalFile('decision.json')); } catch {}
  if (recorder) { recorder.pending([]); recorder.close(); }
  if (release) release();
}
