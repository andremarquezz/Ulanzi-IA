import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin });
let lastDecision;
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.id === 'interactive-test' && !frame.method) { lastDecision = frame.result; continue; }
  if (frame.id == null || !frame.method) continue;
  if (frame.method === 'test/approval') {
    console.log(JSON.stringify({ id: 'approval-test', method: 'item/commandExecution/requestApproval', params: {} }));
  }
  if (frame.method === 'test/interactiveApproval') {
    console.log(JSON.stringify({ id: 'interactive-test', method: 'item/commandExecution/requestApproval', params: { threadId: 'exact-thread', command: 'npm test', availableDecisions: ['accept', 'decline'] } }));
  }
  if (frame.method === 'test/event') console.log(JSON.stringify({ method: 'turn/started', params: { threadId: 'exact-thread', turn: { id: 'owned-turn' } } }));
  if (frame.method === 'test/login') console.log(JSON.stringify({ method: 'account/login/completed', params: { loginId: 'test-login-id', success: true, error: null } }));
  if (frame.method === 'test/exit') { console.error('fake diagnostic from app-server'); process.exit(7); }
  if (frame.method === 'test/timeout') continue;
  if (frame.method === 'test/error') {
    console.log(JSON.stringify({ id: frame.id, error: { message: 'simulated error' } })); continue;
  }
  const result = frame.method === 'test/decision' ? { decision: lastDecision ?? null }
    : frame.method === 'thread/goal/get' ? { goal: { threadId: frame.params.threadId, status: 'usageLimited' } }
    : frame.method === 'account/rateLimits/read' ? { ordinaryUsageAllowed: false } : {};
  console.log(JSON.stringify({ id: frame.id, result }));
}
