import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import UlanziApi from './vendor/ulanzi-api/index.js';
import { queryAllAccounts } from './codex.js';
import { gaugeSvg, initRenderer, svgToDataUri } from './render.js';
import { startMobileServer } from './mobile.js';
import { readCodexDashboard } from './activity.js';
import { activeAccount, switchCodexAccount, SWITCH_LOG_FILE } from './switch.js';
import { switchIconSvg } from './switch-icons.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.jeycodex';
const REFRESH_MS = 30000;
const LOG_FILE = path.join(os.tmpdir(), 'jey-codex-d200h.log');

function log(message) {
  try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + message + '\n'); } catch {}
}

function copyToClipboard(value) {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('clip.exe', [], { input: value + '\r\n', encoding: 'utf8', windowsHide: true });
      return result.status === 0;
    }
    const result = spawnSync('pbcopy', [], { input: value, encoding: 'utf8' });
    return result.status === 0;
  } catch {
    return false;
  }
}

log('plugin boot');

const ACTIONS = {
  'com.ulanzi.ulanzistudio.jeycodex.jey5h': { account: 'jey', window: 'fiveHour', label: '5H' },
  'com.ulanzi.ulanzistudio.jeycodex.jey7d': { account: 'jey', window: 'sevenDay', label: '7D' },
  'com.ulanzi.ulanzistudio.jeycodex.americano5h': { account: 'americano', window: 'fiveHour', label: '5H' },
  'com.ulanzi.ulanzistudio.jeycodex.americano7d': { account: 'americano', window: 'sevenDay', label: '7D' },
  'com.ulanzi.ulanzistudio.jeycodex.mobile': { mobile: true, label: 'CELULAR' },
  'com.ulanzi.ulanzistudio.jeycodex.switchjey': { switchAccount: 'jey', label: 'JEY' },
  'com.ulanzi.ulanzistudio.jeycodex.switchamericano': { switchAccount: 'americano', label: 'AMERICANO' },
};

const api = new UlanziApi();
const instances = new Map();
let accounts = new Map();
let refreshing = null;
let manualSync = false;
let lastUpdatedAt = null;
let mobile = null;
let mobileRunning = false;
let switchingAccount = null;
let switchingStage = '';
let switchError = null;
let switchErrorTimeout = null;
const lastGood = new Map();

function showTemporarySwitchError(errorInfo) {
  switchError = errorInfo;
  if (switchErrorTimeout) clearTimeout(switchErrorTimeout);
  renderAll();
  // Error is an acknowledgement, not the persistent account state.
  switchErrorTimeout = setTimeout(() => {
    if (switchError === errorInfo) {
      switchError = null;
      renderAll();
    }
    switchErrorTimeout = null;
  }, 6500);
}

function clearSwitchError() {
  switchError = null;
  if (switchErrorTimeout) clearTimeout(switchErrorTimeout);
  switchErrorTimeout = null;
}

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
  const dashboard = readCodexDashboard();
  return {
    host: os.hostname(),
    port,
    serverTime: new Date().toISOString(),
    syncing: manualSync || Boolean(refreshing),
    lastUpdatedAt,
    activeAccount: activeAccount(),
    switchingAccount,
    switchingStage,
    switchError,
    mobileRunning,
    activity: dashboard.activity,
    sessions: dashboard.sessions,
    sessionCount: dashboard.sessionCount,
    activeSessionCount: dashboard.activeSessionCount,
    waitingSessionCount: dashboard.waitingSessionCount,
    accounts: [
      mobileAccount('jey'),
      mobileAccount('americano'),
    ],
  };
}

function renderInstance(instance) {
  const spec = ACTIONS[instance.uuid];
  if (!spec) return;
  if (spec.mobile) {
    // The icon shows the action that pressing the key will perform.
    api.setStateIcon(instance.context, mobileRunning ? 1 : 0, 'CELULAR');
    return;
  }

  if (spec.switchAccount) {
    const active = activeAccount();
    const state = switchingAccount === spec.switchAccount
      ? 'switching'
      : switchError?.account === spec.switchAccount
        ? 'error'
        : active === spec.switchAccount
          ? 'active'
          : 'idle';
    const svg = switchIconSvg(spec.switchAccount, state, switchingStage);
    api.setBaseDataIcon(instance.context, svgToDataUri(svg));
    return;
  }

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


async function performAccountSwitch(id, { showToast = true } = {}) {
  if (switchingAccount) throw new Error('Ja existe uma troca de conta em andamento.');

  const label = id === 'jey' ? 'JEY' : 'AMERICANO';
  if (activeAccount() === id) {
    clearSwitchError();
    renderAll();
    if (showToast) api.toast(label + ' ja esta ativo');
    return {
      ok: true,
      activeAccount: id,
      alreadyActive: true,
      vscodeWasRunning: false,
      vscodeRestarted: false,
      reopenedTargets: [],
    };
  }

  switchingAccount = id;
  switchingStage = 'INICIANDO';
  clearSwitchError();
  renderAll();
  if (showToast) api.toast('Trocando para ' + label + '...');
  log('account switch start account=' + id + ' details=' + SWITCH_LOG_FILE);

  try {
    const result = await switchCodexAccount(id, {
      onProgress(message) {
        switchingStage = /fechando/i.test(message) ? 'FECHANDO'
          : /reabrindo/i.test(message) ? 'ABRINDO'
            : /identificando/i.test(message) ? 'LENDO'
              : /aplicando/i.test(message) ? 'TROCANDO'
                : 'AGUARDE';
        log('account switch progress account=' + id + ' step=' + message);
        renderAll();
      },
    });

    log('account switch finished account=' + id
      + ' restarted=' + result.vscodeRestarted
      + ' projects=' + result.reopenedTargets.length
      + ' restoreMode=' + (result.restoreMode || 'none'));

    if (showToast) {
      if (result.restorePartial) {
        api.toast(label + ' ATIVO • '
          + result.windowsRestored + '/' + result.windowsExpected
          + ' janelas reabertas. Abra o projeto restante manualmente.');
      } else if (result.restoreFailed) {
        api.toast(label + ' ATIVO • Nao foi possivel reabrir o VS Code. Abra um projeto manualmente.');
      } else {
        const suffix = result.vscodeRestarted ? ' • projetos restaurados' : '';
        api.toast(label + ' ativo' + suffix);
      }
    }

    // Quota refresh is not a prerequisite for successful account switching.
    void refresh(true).catch((error) => log('post-switch refresh error: ' + String(error)));
    return result;
  } catch (error) {
    const code = error?.code || 'UNKNOWN';
    const detail = error instanceof Error ? error.message : String(error);
    const selected = activeAccount();
    const accountChanged = error?.accountChanged === true || selected === id;

    const errorInfo = {
      account: id,
      code,
      detail,
      accountChanged,
      activeAccount: selected,
      time: new Date().toISOString(),
    };
    showTemporarySwitchError(errorInfo);

    log('account switch failed account=' + id + ' code=' + code
      + ' accountChanged=' + accountChanged + ' activeAccount=' + selected
      + ' error=' + detail);

    if (showToast) {
      if (accountChanged) {
        api.toast(label + ' ATIVO • VS Code incompleto: ' + detail
          + ' | Log: ' + SWITCH_LOG_FILE);
      } else {
        api.toast('Troca NAO aplicada • ' + code + ': ' + detail
          + ' | Log: ' + SWITCH_LOG_FILE);
      }
    }

    throw error;
  } finally {
    switchingAccount = null;
    switchingStage = '';
    renderAll();
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

api.onRun((message) => {
  const spec = ACTIONS[message?.uuid];

  if (spec?.switchAccount) {
    void performAccountSwitch(spec.switchAccount).catch(() => {
      try { api.showAlert(message.context); } catch {}
    });
    return;
  }

  if (spec?.mobile) {
    if (mobileRunning) {
      stopMobile();
      api.toast('Painel mobile parado');
      return;
    }
    startMobile();
    const url = mobile?.urls?.()[0] || 'painel mobile';
    const copied = copyToClipboard(url);
    api.toast(copied ? 'Painel iniciado • URL copiada' : 'Painel iniciado • URL: ' + url);
    log('mobile action pressed copied=' + copied + ' url=' + url);
    return;
  }
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

function updateMobileIcons() {
  for (const instance of instances.values()) {
    if (ACTIONS[instance.uuid]?.mobile) {
      try { api.setStateIcon(instance.context, mobileRunning ? 1 : 0, 'CELULAR'); } catch {}
    }
  }
}

function startMobile() {
  if (mobile) return;
  mobile = startMobileServer({
    getState: () => mobileState(),
    refresh,
    switchAccount: async (id) => {
      log('mobile switch requested account=' + id);
      const result = await performAccountSwitch(id, { showToast: false });
      log('mobile switch finished account=' + id + ' restarted=' + result.vscodeRestarted);
      return {
        ...result,
        state: mobileState(),
      };
    },
    log,
  });
  mobileRunning = true;
  updateMobileIcons();
  for (const url of mobile.urls()) log('open on phone ' + url);
}

function stopMobile() {
  if (!mobile) return;
  try { mobile.close(); } catch (error) { log('mobile close error: ' + String(error)); }
  mobile = null;
  mobileRunning = false;
  updateMobileIcons();
  log('mobile server stopped');
}

void refresh();

setInterval(() => {
  void refresh();
}, REFRESH_MS);
