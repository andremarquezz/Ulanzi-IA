import { ACCOUNTS, queryAllAccounts } from '../src/codex.js';
import { readCodexActivity } from '../src/activity.js';

console.log('Codex homes:');
for (const account of ACCOUNTS) console.log('  ' + account.label + ': ' + account.home);

const accounts = await queryAllAccounts();
for (const account of ACCOUNTS) {
  const result = accounts.get(account.id);
  if (!result) {
    console.log(account.label + ': NO RESULT');
    continue;
  }
  const fmt = (window) => window ? Math.round(100 - window.usedPercent) + '% restante' : '-';
  console.log(account.label + ': ' + result.status + ' | 5H ' + fmt(result.fiveHour) + ' | 7D ' + fmt(result.sevenDay));
  if (result.error) console.log('  erro: ' + result.error);
}

const activity = readCodexActivity();
console.log('Codex activity: ' + activity.status + (activity.active ? ' | ativa' : ' | sem sessão ativa'));
console.log('  ' + activity.message);
if (activity.sessionId) console.log('  sessão: ' + activity.sessionId);
for (const event of (activity.events ?? []).slice(0, 3)) console.log('  evento: ' + event.message);
