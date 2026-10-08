import { ACCOUNTS, queryAllAccounts } from '../src/codex.js';

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
