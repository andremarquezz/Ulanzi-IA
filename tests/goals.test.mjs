import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { quotaFromResponse, chooseAccount, nextCheck, RESUME_COOLDOWN, MIN_RETRY, MAX_RETRY } from '../src/goal-policy.js';
import { runGoalEngine } from '../src/goal-engine.js';
import { startGoalsPanel, openGoalsInStudio, openGoalsBrowser } from '../src/goals-panel.js';
import { EventEmitter } from 'node:events';
import { goalIconSvg } from '../src/goal-icons.js';
import { replaceFile } from '../src/goal-store.js';

test('Studio receives the base URL and token in its documented separate parameter', () => {
  const calls = [];
  openGoalsInStudio({ openUrl: (...args) => calls.push(args) }, 'http://127.0.0.1:4567/?token=example');
  assert.deepEqual(calls, [['http://127.0.0.1:4567/', false, { token: 'example' }]]);
});

test('browser launcher reports process failures instead of silently swallowing them', async () => {
  const commands = [];
  await openGoalsBrowser('http://127.0.0.1:4567/?token=test', { spawnProcess: (...args) => {
    commands.push(args); const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 0)); return child;
  } });
  assert.equal(commands[0][0], 'rundll32.exe');
  assert.deepEqual(commands[0][1], ['url.dll,FileProtocolHandler', 'http://127.0.0.1:4567/?token=test']);
  await assert.rejects(openGoalsBrowser('http://127.0.0.1:4567/', { spawnProcess: () => {
    const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('missing'))); return child;
  } }), /navegador padrão/);
});

test('panel verifies the browser request and falls back when Studio does not open it', async (t) => {
  let primary = 0, fallback = 0;
  const panel = await startGoalsPanel({}, {
    html: () => '<h1>Goals</h1>', openTimeout: 50,
    openBrowser: () => { primary++; },
    fallbackBrowser: async (url) => { fallback++; assert.equal((await fetch(url)).status, 200); },
  });
  t.after(() => panel.close());
  await panel.open();
  assert.equal(primary, 1); assert.equal(fallback, 1);
});

test('panel surfaces a launch failure if neither route reaches the page', async (t) => {
  const panel = await startGoalsPanel({}, { html: () => 'Goals', openTimeout: 10, openBrowser: () => {}, fallbackBrowser: () => {} });
  t.after(() => panel.close());
  await assert.rejects(panel.open(), /navegador não abriu/);
});

test('monitor icons describe the action performed, without an unselected play icon', () => {
  const initial = goalIconSvg('monitor', { running: false });
  assert.match(initial, /SEM GOAL/); assert.match(initial, /USE PAINEL GOALS/);
  assert.doesNotMatch(initial, /m57 47|ESCOLHER/);
  assert.match(goalIconSvg('monitor', { selected: { id: 'goal' }, readyToStart: false }), /CONFIRME NO PAINEL/);
  assert.match(goalIconSvg('monitor', { selected: { id: 'goal' }, readyToStart: true }), /EXECUTAR/);
  for (const state of ['running', 'waiting_quota', 'switching']) {
    assert.match(goalIconSvg('monitor', { selected: { id: 'goal' }, running: true, state }), /PAUSAR/);
  }
  assert.doesNotMatch(goalIconSvg('monitor', { selected: { id: 'goal' }, state: 'error' }), /ABRIR PAINEL/);
});

test('Windows atomic replacement retries temporary locks with a hard bound', () => {
  let attempts = 0;
  replaceFile('source', 'destination', { rename: () => { if (++attempts < 4) throw Object.assign(new Error('locked'), { code: 'EPERM' }); }, pause: () => {} });
  assert.equal(attempts, 4);
  attempts = 0;
  assert.throws(() => replaceFile('source', 'destination', { rename: () => { attempts++; throw Object.assign(new Error('locked'), { code: 'EPERM' }); }, pause: () => {} }), /locked/);
  assert.equal(attempts, 10);
});

test('permission, identity and both quota windows govern eligibility', () => {
  const now = 1000000;
  const parse = (r) => quotaFromResponse(r, now, 'expected');
  assert.equal(parse({ ordinaryUsageAllowed: true }).allowed, true);
  assert.equal(parse({ ordinaryUsageAllowed: null, rateLimits: { primary: { usedPercent: 0 } } }).known, false);
  assert.equal(parse({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 0 } } }).allowed, false);
  assert.equal(parse({ ordinaryUsageAllowed: true, accountId: 'other' }).known, false);
  for (const limit of [
    { primary: { usedPercent: 100 } }, { secondary: { usedPercent: 100 } },
    { spendControlReached: true }, { rateLimitReachedType: 'rate_limit_reached' },
  ]) assert.equal(parse({ ordinaryUsageAllowed: true, rateLimits: limit }).allowed, false);
  const q = parse({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 0 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 100 } } } });
  assert.equal(q.allowed, false);
  assert.equal(chooseAccount('jey', { jey: q, americano: q }, {}, true, now), null);
  const good = parse({ ordinaryUsageAllowed: true });
  assert.equal(chooseAccount('jey', { jey: q, americano: good }, {}, true, now), 'americano');
  assert.equal(chooseAccount('jey', { jey: q, americano: good }, {}, false, now), null);
  assert.equal(chooseAccount('jey', { jey: q, americano: good }, { americano: now + RESUME_COOLDOWN }, true, now), null);
  assert.equal(chooseAccount('jey', { jey: { ...good, checkedAt: now - 61000 } }, {}, true, now), null);
});

test('retry respects reset windows and stays within 3 to 30 minutes', () => {
  const now = 1000000;
  const quotas = { jey: { resetAt: now + 12 * 60000 }, americano: { resetAt: now + 25 * 60000 } };
  assert.equal(nextCheck(quotas, {}, 0, now), now + 12 * 60000);
  for (let failures = 0; failures < 100; failures++) {
    const delay = nextCheck(quotas, {}, failures, now) - now;
    assert.ok(delay >= MIN_RETRY && delay <= MAX_RETRY);
  }
});

function engineFixture(scenario) {
  let current = 'jey', stopped = false, clock = 1800000000000, goal = scenario === 'resume-paused' ? 'paused' : scenario === 'owned-turn' ? 'active' : 'usageLimited', reads = 0;
  let activeTurn = null;
  const calls = [], replacements = [], states = [];
  let savedHolds = {};
  const d = {
    liveHome: 'live', homes: { jey: 'jey', americano: 'americano' },
    current: () => current, fingerprint: () => current + '-fingerprint',
    authID: (home) => (home === 'live' ? current : home) + '-id',
    holds: () => scenario === 'cooldown' ? { jey: clock + RESUME_COOLDOWN, americano: clock + RESUME_COOLDOWN } : {},
    saveHolds: (h) => { savedHolds = structuredClone(h); },
    autoSwitch: () => scenario !== 'manual',
    saveSelection: (s) => { calls.push(['checkpoint', s]); },
    stopped: () => stopped, log: () => {}, now: () => clock,
    sleep: async (next) => { assert.ok(next > clock); clock = next; stopped = true; },
    replaceAuth: (source, destination) => { replacements.push([source, destination]); if (destination === 'live') current = source; },
    connect: async (home) => {
      const account = home === 'live' ? current : home;
      return {
        get activeTurnId() { return activeTurn; },
        approvalRequired: scenario === 'approval', stop: async () => {},
        call: async (method, params) => {
          calls.push([method, params, account]);
          if (method === 'thread/goal/get') {
            reads++;
            if (scenario === 'paused' && reads >= 3) goal = 'paused';
            return { goal: { status: goal, threadId: 'same-goal' } };
          }
          if (method === 'account/rateLimits/read') {
            if (scenario === 'stop-during-probe' && account === 'americano') stopped = true;
            let allowed = account === 'americano' || scenario === 'recovered' || scenario === 'cooldown' || scenario === 'paused';
            if (scenario === 'empty') allowed = false;
            if (scenario === 'unknown') allowed = null;
            if (scenario === 'rollback' && home === 'live' && account === 'americano') allowed = false;
            return { ordinaryUsageAllowed: allowed, accountId: account + '-id' };
          }
          if (method === 'thread/goal/set') { assert.equal(params.threadId, 'same-goal'); goal = params.status; if (scenario === 'owned-turn' && goal === 'active') activeTurn = 'owned-turn-id'; }
          if (method === 'turn/interrupt') activeTurn = null;
          return {};
        },
      };
    },
  };
  return { d, states, calls, replacements, current: () => current, holds: () => savedHolds, goal: () => goal };
}

test('an explicit start resumes a paused Goal once and subscribes before activation', async () => {
  const f = engineFixture('resume-paused');
  await runGoalEngine({ id: 'same-goal', fingerprint: 'jey-fingerprint', resumePaused: true }, (s) => f.states.push(s), f.d);
  const active = f.calls.filter(([method, p]) => method === 'thread/goal/set' && p.status === 'active');
  assert.equal(active.length, 1);
  assert.equal(f.calls.find(([method]) => method === 'checkpoint')[1].resumePaused, false);
  assert.ok(f.calls.findIndex(([m]) => m === 'thread/resume') < f.calls.findIndex(([m]) => m === 'thread/goal/set'));
  assert.equal(f.goal(), 'paused', 'stop must leave a resumable Goal');
});

test('a paused Goal is not resumed without fresh click authorization', async () => {
  const f = engineFixture('resume-paused');
  await runGoalEngine({ id: 'same-goal', fingerprint: 'jey-fingerprint' }, (s) => f.states.push(s), f.d);
  assert.equal(f.calls.some(([method]) => method === 'thread/goal/set'), false);
  assert.equal(f.states.at(-1).state, 'paused');
});

test('pause interrupts the owned live turn and preserves the Goal', async () => {
  const f = engineFixture('owned-turn');
  await runGoalEngine({ id: 'same-goal', fingerprint: 'jey-fingerprint' }, (s) => f.states.push(s), f.d);
  assert.ok(f.states.some((s) => s.state === 'running'));
  assert.equal(f.goal(), 'paused');
  assert.deepEqual(f.calls.find(([m]) => m === 'turn/interrupt')[1], { threadId: 'same-goal', turnId: 'owned-turn-id' });
});

for (const scenario of ['empty', 'cooldown', 'unknown', 'manual']) test('monitor waits without switching: ' + scenario, async () => {
  const f = engineFixture(scenario);
  await runGoalEngine({ id: 'same-goal', title: 'Test Goal', fingerprint: 'jey-fingerprint' }, (s) => f.states.push(s), f.d);
  assert.ok(f.states.some((s) => s.state === 'waiting_quota'));
  assert.equal(f.current(), 'jey'); assert.deepEqual(f.replacements, []);
  assert.equal(f.calls.filter(([method]) => method === 'thread/goal/set').length, 0);
  assert.equal(f.states.at(-1).state, 'stopped');
});

for (const scenario of ['switch', 'recovered']) test('monitor resumes same Goal: ' + scenario, async () => {
  const f = engineFixture(scenario);
  await runGoalEngine({ id: 'same-goal', title: 'Test Goal', fingerprint: 'jey-fingerprint' }, (s) => f.states.push(s), f.d);
  assert.ok(f.states.some((s) => s.state === 'waiting_codex'));
  assert.equal(f.states.some((s) => s.state === 'running'), false, 'activation alone must not claim a running turn');
  assert.equal(f.current(), scenario === 'switch' ? 'americano' : 'jey');
  assert.equal(f.calls.filter(([method, params]) => method === 'thread/goal/set' && params.status === 'active').length, 1);
  assert.equal(f.calls.filter(([method, params]) => method === 'thread/goal/set' && params.status === 'paused').length, 1, 'stop must pause the owned Goal');
  const resume = f.calls.findIndex(([method]) => method === 'thread/resume');
  const activate = f.calls.findIndex(([method, params]) => method === 'thread/goal/set' && params.status === 'active');
  assert.ok(resume >= 0 && resume < activate, 'load and subscribe before activating the Goal');
  assert.ok(f.holds()[f.current()] > 1800000000000);
  if (scenario === 'switch') assert.deepEqual(f.replacements, [['live', 'jey'], ['americano', 'live']]);
  else assert.deepEqual(f.replacements, []);
});

test('switch failure restores source session without attempting resume', async () => {
  const f = engineFixture('rollback');
  await runGoalEngine({ id: 'same-goal', fingerprint: 'jey-fingerprint' }, (s) => f.states.push(s), f.d);
  assert.equal(f.current(), 'jey');
  assert.equal(f.states.at(-1).state, 'error');
  assert.equal(f.calls.filter(([m]) => m === 'thread/goal/set').length, 0);
  assert.deepEqual(f.replacements.at(-1), ['jey', 'live']);
});

for (const scenario of ['paused', 'approval', 'stop-during-probe']) test('respect manual intervention: ' + scenario, async () => {
  const f = engineFixture(scenario);
  await runGoalEngine({ id: 'same-goal', fingerprint: 'jey-fingerprint' }, (s) => f.states.push(s), f.d);
  assert.equal(f.calls.filter(([m]) => m === 'thread/goal/set').length, 0);
  assert.deepEqual(f.replacements, []);
  assert.equal(f.states.at(-1).state, scenario === 'stop-during-probe' ? 'stopped' : scenario === 'paused' ? 'paused' : 'attention');
});

test('Goals HTML parses and never inserts titles through innerHTML', () => {
  const html = fs.readFileSync(new URL('../plugin/resources/goals.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script.replaceAll('__GOALS_TOKEN__', '"test"')));
  assert.doesNotMatch(script, /innerHTML/);
  for (const kind of ['goals', 'monitor', 'automatic']) assert.match(goalIconSvg(kind, { state: 'waiting_quota' }), /<svg/);
});

test('loopback panel authenticates requests and requires explicit execution confirmation', async (t) => {
  let starts = 0, selected = null;
  const html = '<script>const token=__GOALS_TOKEN__;</script>';
  const panel = await startGoalsPanel({
    status: () => ({ state: 'idle' }), listThreads: async () => [{ id: 'thread' }],
    selectGoal: async (id) => { selected = id; return { selected: id }; },
    start: async ({ confirmed }) => { assert.equal(confirmed, true); starts++; return { running: true }; },
    stop: async () => ({ stopped: true }), setAutomatic: async (autoSwitch) => ({ autoSwitch }), logs: () => 'log',
  }, { html: () => html, openBrowser: () => {} });
  t.after(() => panel.close());
  const url = new URL(panel.url); const base = url.origin; const token = url.searchParams.get('token');
  assert.equal((await fetch(base + '/api/status')).status, 401);
  const headers = { 'x-goals-token': token, 'content-type': 'application/json' };
  assert.deepEqual(await (await fetch(base + '/api/status', { headers })).json(), { state: 'idle' });
  assert.equal((await fetch(base + '/api/start', { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal(starts, 0);
  assert.equal((await fetch(base + '/api/start', { method: 'POST', headers, body: '{"exclusiveConfirmed":true}' })).status, 200);
  assert.equal(starts, 1);
  await fetch(base + '/api/select', { method: 'POST', headers, body: '{"id":"thread"}' }); assert.equal(selected, 'thread');
  assert.equal((await fetch(base + '/api/status', { headers: { ...headers, origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/select', { method: 'POST', headers, body: '{broken' })).status, 400);
  assert.match(await (await fetch(panel.url)).text(), new RegExp(token));
});
