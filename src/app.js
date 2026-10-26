import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import UlanziApi from './vendor/ulanzi-api/index.js';
import { queryAllAccounts, ACCOUNTS } from './codex.js';
import { gaugeSvg, initRenderer, svgToDataUri } from './render.js';
import { startMobileServer } from './mobile.js';
import { readCodexDashboard } from './activity.js';
import { activeAccount, switchCodexAccount, SWITCH_LOG_FILE } from './switch.js';
import { switchIconSvg } from './switch-icons.js';
import { createGoalController } from './goals.js';
import { startGoalsPanel, openGoalsInStudio, openGoalsBrowser } from './goals-panel.js';
import { goalIconSvg } from './goal-icons.js';
import { isGoalMonitorRunning, processAlive } from './goal-store.js';

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
process.on('uncaughtExceptionMonitor', (error) => log('fatal: ' + (error?.stack || String(error))));
process.on('exit', (code) => log('plugin exit code=' + code));

const ACTIONS = {
  'com.ulanzi.ulanzistudio.jeycodex.jey5h': { account: 'jey', window: 'fiveHour', label: '5H' },
  'com.ulanzi.ulanzistudio.jeycodex.jey7d': { account: 'jey', window: 'sevenDay', label: '7D' },
  'com.ulanzi.ulanzistudio.jeycodex.americano5h': { account: 'americano', window: 'fiveHour', label: '5H' },
  'com.ulanzi.ulanzistudio.jeycodex.americano7d': { account: 'americano', window: 'sevenDay', label: '7D' },
  'com.ulanzi.ulanzistudio.jeycodex.hb5h': { account: 'hb', window: 'fiveHour', label: '5H' },
  'com.ulanzi.ulanzistudio.jeycodex.hb7d': { account: 'hb', window: 'sevenDay', label: '7D' },
  'com.ulanzi.ulanzistudio.jeycodex.mobile': { mobile: true, label: 'CELULAR' },
  'com.ulanzi.ulanzistudio.jeycodex.switchjey': { switchAccount: 'jey', label: 'JEY' },
  'com.ulanzi.ulanzistudio.jeycodex.switchamericano': { switchAccount: 'americano', label: 'AMERICANO' },
  'com.ulanzi.ulanzistudio.jeycodex.switchhb': { switchAccount: 'hb', label: 'HB' },
  'com.ulanzi.ulanzistudio.jeycodex.goals': { goalKind: 'goals' },
  'com.ulanzi.ulanzistudio.jeycodex.goalmonitor': { goalKind: 'monitor' },
  'com.ulanzi.ulanzistudio.jeycodex.goalautomatic': { goalKind: 'automatic' },
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
const goals = createGoalController({ isSwitching: () => Boolean(switchingAccount) });
let goalsPanel = null;
let goalsPanelOpening = null;
let goalActionBusy = false;
let studioWasConnected = false;
let studioConnected = false;
let reconnectTimer = null;
let connectionAttempts = 0;

function connectToStudio() {
  connectionAttempts++;
  log('studio connect attempt=' + connectionAttempts);
  try { api.connect(PLUGIN_UUID, api.port || 3906, api.address || '127.0.0.1'); }
  catch (error) { log('studio connect failed: ' + String(error)); retryStudioConnection(); }
}

function retryStudioConnection() {
  if (reconnectTimer || studioConnected) return;
  const delay = Math.min(10000, 500 * 2 ** Math.min(connectionAttempts - 1, 5));
  log('studio retry in=' + delay);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToStudio(); }, delay);
}

function refreshSafely(feedback = false) {
  void refresh(feedback).catch((error) => log('refresh error: ' + String(error)));
}

async function openGoals() {
  if (!goalsPanel && !goalsPanelOpening) {
    goalsPanelOpening = startGoalsPanel(goals, {
      openBrowser: (url) => openGoalsInStudio(api, url),
      fallbackBrowser: openGoalsBrowser,
    }).then((panel) => { goalsPanel = panel; return panel; })
      .finally(() => { goalsPanelOpening = null; });
  }
  const panel = goalsPanel || await goalsPanelOpening;
  log('goals panel opening');
  api.toast('Abrindo painel de Goals no navegador...');
  try {
    await panel.open();
    log('goals panel opened');
  } catch (error) {
    const copied = copyToClipboard(panel.url);
    log('goals panel browser failed copied=' + copied);
    const failure = new Error(copied
      ? 'Não consegui abrir o navegador. Cole a URL copiada na barra de endereços (Ctrl+V).'
      : 'Não consegui abrir o navegador nem copiar a URL. Verifique o navegador padrão do Windows.');
    failure.code = 'GOALS_BROWSER_FAILED';
    throw failure;
  }
}

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
    label: ACCOUNTS.find((a) => a.id === spec.account)?.label || spec.account.toUpperCase(),
    status: 'loading',
    fiveHour: null,
    sevenDay: null,
  };
}

function mobileAccount(id) {
  const current = accounts.get(id) || lastGood.get(id) || {
    id,
    label: ACCOUNTS.find((a) => a.id === id)?.label || id.toUpperCase(),
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
    accounts: ACCOUNTS.map((a) => mobileAccount(a.id)),
  };
}

function renderInstance(instance) {
  const spec = ACTIONS[instance.uuid];
  if (!spec) return;
  if (spec.goalKind) {
    api.setBaseDataIcon(instance.context, svgToDataUri(goalIconSvg(spec.goalKind, goals.status())));
    return;
  }
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
  if (isGoalMonitorRunning()) {
    if (showToast) api.toast('Pare o monitor de Goals antes de trocar a conta manualmente.');
    throw new Error('Pare o monitor de Goals antes de trocar a conta manualmente.');
  }
  if (switchingAccount) throw new Error('Ja existe uma troca de conta em andamento.');

  const label = ACCOUNTS.find((a) => a.id === id)?.label || id.toUpperCase();
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

  refreshSafely();
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

  if (spec?.goalKind) {
    if (goalActionBusy) return;
    goalActionBusy = true;
    void (async () => {
      if (spec.goalKind === 'goals') { await openGoals(); return; }
      const status = goals.status();
      if (spec.goalKind === 'automatic') {
        await goals.setAutomatic(!status.autoSwitch);
        api.toast(status.autoSwitch ? 'Troca automática DESLIGADA' : 'Troca automática LIGADA');
      } else if (status.running) {
        await goals.stop(); api.toast('Pausa da execução solicitada');
      } else {
        if (!status.selected || !status.readyToStart) {
          api.toast(status.selected ? 'Confirme a conversa livre no PAINEL GOALS para habilitar Executar.' : 'Nenhum Goal selecionado. Use PAINEL GOALS para selecionar ou criar um.');
          return;
        }
        await goals.start(); api.toast('Execução do Goal iniciada pelo Codex CLI');
      }
    })().catch(async (error) => {
      log('goal action error: ' + error.message);
      api.toast(error.message);
      try { api.showAlert(message.context); } catch {}
    }).finally(() => { goalActionBusy = false; renderAll(); });
    return;
  }

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
  refreshSafely(true);
});

api.onConnected(() => {
  studioWasConnected = true;
  studioConnected = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  log('studio connected');
  // Let the registration frame flush before starting local CLI discovery.
  setImmediate(() => refreshSafely());
});

api.onError((error) => { log('studio error: ' + String(error)); });
api.onClose(() => {
  log('studio closed');
  studioConnected = false;
  instances.clear();
  if (!studioWasConnected || processAlive(process.ppid)) { retryStudioConnection(); return; }
  // Studio owns this foreground plugin process. Its background Goal worker
  // remains independent. Do not leave orphan UI clients after Studio exits.
  if (mobile) stopMobile();
  if (goalsPanel) void goalsPanel.close();
  process.exit(0);
});

log('connecting to studio');
connectToStudio();

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

setInterval(() => {
  if (studioConnected) refreshSafely();
}, REFRESH_MS);

// The worker owns execution. Poll only local status files to update the keys;
// the deck never drives a second quota/restart loop.
setInterval(() => {
  for (const instance of instances.values()) {
    const spec = ACTIONS[instance.uuid];
    if (spec?.goalKind || spec?.switchAccount) {
      try { renderInstance(instance); } catch (error) { log('goal icon error: ' + error.message); }
    }
  }
}, 2000);
