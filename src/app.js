import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import UlanziApi from './vendor/ulanzi-api/index.js';
import { queryAllAccounts } from './codex.js';
import { gaugeSvg, initRenderer, svgToDataUri } from './render.js';
import { startMobileServer } from './mobile.js';
import { activeAccount, switchCodexAccount } from './switch.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.jeycodex';
const REFRESH_MS = 30000;
const LOG_FILE = path.join(os.tmpdir(), 'jey-codex-d200h.log');

function log(message) {
  try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + message + '\n'); } catch {}
}

log('plugin boot');

const ACTIONS = {
  'com.ulanzi.ulanzistudio.jeycodex.jey5h': { account: 'jey', window: 'fiveHour', label: '5H' },
  'com.ulanzi.ulanzistudio.jeycodex.jey7d': { account: 'jey', window: 'sevenDay', label: '7D' },
  'com.ulanzi.ulanzistudio.jeycodex.americano5h': { account: 'americano', window: 'fiveHour', label: '5H' },
  'com.ulanzi.ulanzistudio.jeycodex.americano7d': { account: 'americano', window: 'sevenDay', label: '7D' },
};

const api = new UlanziApi();
const instances = new Map();
let accounts = new Map();
let refreshing = null;
let manualSync = false;
let lastUpdatedAt = null;
const lastGood = new Map();

try {
  await initRenderer();
  log('renderer ready');
} catch (error) {
  log('renderer failed: ' + String(error));
  throw error;
}

function specFor(message) {
  return ACTIONS[message.uuid] || null;
}

function accountFor(spec) {
  return accounts.get(spec.account) || lastGood.get(spec.account) || {
    id: spec.account,
    label: spec.account === 'jey' ? 'JEY' : 'AMERICANO',
    status: 'loading',
    fiveHour: null,
    sevenDay: null,
  };
}

function mobileAccount(id) {
  const current = accounts.get(id) || lastGood.get(id) || {
    id,
    label: id === 'jey' ? 'JEY' : 'AMERICANO',
    status: 'loading',
    fiveHour: null,
    sevenDay: null,
  };

  return {
    ...current,
    stale: !accounts.has(id) && lastGood.has(id),
  };
}

function mobileState(port = Number(process.env.JEY_MOBILE_PORT || 3333)) {
  return {
    host: os.hostname(),
    port,
    syncing: manualSync || Boolean(refreshing),
    lastUpdatedAt,
    activeAccount: activeAccount(),
    accounts: [
      mobileAccount('jey'),
      mobileAccount('americano'),
    ],
  };
}

function renderInstance(instance) {
  const spec = ACTIONS[instance.uuid];
  if (!spec) return;

  const current = accountFor(spec);
  const fresh = accounts.get(spec.account);
  const stale = !fresh && lastGood.has(spec.account);
  const reading = current[spec.window] || null;
  const status = stale ? 'ok' : current.status;

  const svg = gaugeSvg({
    account: current.label,
    windowLabel: spec.label,
    reading,
    status,
    stale,
    syncing: manualSync,
  });

  api.setBaseDataIcon(instance.context, svgToDataUri(svg));
}

function renderAll() {
  for (const instance of instances.values()) {
    try { renderInstance(instance); } catch {}
  }
}

async function refresh(showFeedback = false) {
  if (refreshing) {
    if (showFeedback) {
      manualSync = true;
      log('manual sync joined active refresh');
      renderAll();
      try {
        await refreshing;
      } finally {
        manualSync = false;
        renderAll();
        log('manual sync end');
      }
    }
    return refreshing;
  }

  if (showFeedback) {
    manualSync = true;
    log('manual sync start');
    renderAll();
  }

  const task = (async () => {
    log('refresh start');
    const fresh = await queryAllAccounts();
    for (const [id, result] of fresh) log('account ' + id + ' status=' + result.status);

    for (const [id, result] of fresh) {
      if (result.status === 'ok') lastGood.set(id, result);
    }

    accounts = new Map();
    for (const [id, result] of fresh) {
      if (result.status === 'error' && lastGood.has(id)) continue;
      accounts.set(id, result);
    }

    lastUpdatedAt = new Date().toISOString();
    renderAll();
    log('refresh rendered');
  })();

  refreshing = task;

  try {
    await task;
  } finally {
    if (refreshing === task) refreshing = null;
    if (showFeedback) {
      manualSync = false;
      renderAll();
      log('manual sync end');
    }
  }
}

api.onAdd((message) => {
  log('onAdd uuid=' + message.uuid + ' actionid=' + message.actionid + ' key=' + message.key);
  if (!specFor(message)) return;

  instances.set(message.context, {
    context: message.context,
    uuid: message.uuid,
    actionid: message.actionid,
    key: message.key,
  });

  try {
    renderInstance(instances.get(message.context));
    log('initial render ok ' + message.uuid);
  } catch (error) {
    log('initial render failed: ' + String(error));
  }

  void refresh();
});

api.onClear((message) => {
  if (Array.isArray(message.param)) {
    for (const item of message.param) {
      if (item && item.context) instances.delete(item.context);
    }
    return;
  }

  if (message.context) instances.delete(message.context);
});

api.onRun(() => {
  void refresh(true);
});

api.onConnected(() => {
  log('studio connected');
  void refresh();
});

api.onError((error) => { log('studio error: ' + String(error)); });
api.onClose(() => { log('studio closed'); });

log('connecting to studio');
api.connect(PLUGIN_UUID);

const mobile = startMobileServer({
  getState: () => mobileState(),
  refresh,
  switchAccount: async (id) => {
    log('mobile switch requested account=' + id);
    const result = await switchCodexAccount(id);
    await refresh(true);
    log('mobile switch finished account=' + id + ' restarted=' + result.vscodeRestarted);
    return {
      ...result,
      state: mobileState(),
    };
  },
  log,
});

for (const url of mobile.urls()) log('open on phone ' + url);

void refresh();

setInterval(() => {
  void refresh();
}, REFRESH_MS);
