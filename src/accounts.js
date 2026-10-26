import os from 'node:os';
import path from 'node:path';

// Stable IDs and order are shared by the worker, quotas, deck and mobile UI.
export const ACCOUNTS = [
  { id: 'jey', label: 'JEY', home: path.join(os.homedir(), '.codex-jey') },
  { id: 'americano', label: 'AMERICANO', home: path.join(os.homedir(), '.codex-americano') },
  { id: 'hb', label: 'HB', home: path.join(os.homedir(), '.codex-hb') },
];
export const profileHomes = Object.fromEntries(ACCOUNTS.map((a) => [a.id, a.home]));
