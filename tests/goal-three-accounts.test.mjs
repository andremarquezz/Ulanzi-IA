import assert from 'node:assert/strict';
import test from 'node:test';
import { runGoalEngine } from '../src/goal-engine.js';
import { chooseAccount, accountRotation, RESUME_COOLDOWN, MIN_RETRY, MAX_RETRY } from '../src/goal-policy.js';

test('three-account order wraps and never selects stale, unknown or cooling-down capacity', () => {
  const now = 1800000000000;
  const good = { known: true, allowed: true, checkedAt: now };
  const empty = { known: true, allowed: false, checkedAt: now };
  assert.deepEqual(accountRotation('americano'), ['hb', 'jey']);
  assert.deepEqual(accountRotation('hb'), ['jey', 'americano']);
  assert.equal(chooseAccount('americano', { americano: empty, jey: good, hb: good }, {}, true, now), 'hb');
  assert.equal(chooseAccount('hb', { hb: empty, jey: good, americano: good }, {}, true, now), 'jey');
  assert.equal(chooseAccount('jey', { jey: empty, americano: empty, hb: good }, {}, true, now), 'hb');
  assert.equal(chooseAccount('jey', { jey: empty, americano: empty, hb: good }, { hb: now + RESUME_COOLDOWN }, true, now), null);
  assert.equal(chooseAccount('jey', { jey: empty, americano: empty, hb: { ...good, checkedAt: now - 61000 } }, {}, true, now), null);
  assert.equal(chooseAccount('jey', { jey: empty, americano: empty, hb: { ...good, known: false } }, {}, true, now), null);
  assert.equal(chooseAccount('jey', { jey: empty, americano: good, hb: good }, {}, false, now), null);
});

function fixture({ cycles = false, capacity = {}, missing = [], duplicate = false, manual = false, stopOnHB = false } = {}) {
  let current = 'jey', goal = 'usageLimited', clock = 1800000000000, stopped = false, round = 0;
  let holds = {};
  const states = [], probes = [], switched = [], activations = [];
  const d = {
    homes: { jey: 'jey', americano: 'americano', hb: 'hb' }, liveHome: 'live',
    current: () => current, fingerprint: () => current + '-fingerprint',
    authID: (home) => missing.includes(home) ? null : (home === 'live' ? current : duplicate && home === 'hb' ? 'americano' : home) + '-id',
    stopped: () => stopped, autoSwitch: () => !manual, holds: () => holds,
    saveHolds: (value) => { holds = structuredClone(value); }, saveSelection: () => {}, log: () => {}, now: () => clock,
    replaceAuth: (source, destination) => { if (destination === 'live') { current = source; switched.push(source); } },
    sleep: async (until) => {
      const waiting = states.at(-1).state === 'waiting_quota';
      if (waiting) assert.ok(until - clock >= MIN_RETRY && until - clock <= MAX_RETRY);
      if (cycles && round < 3 && !waiting) { round++; clock += 11 * 60000; goal = 'usageLimited'; }
      else { stopped = true; clock = until; }
    },
    connect: async (home) => {
      if (home !== 'live') probes.push(home);
      const account = home === 'live' ? current : home;
      return { stop: async () => {}, call: async (method, params) => {
        if (method === 'thread/goal/get') return { goal: { status: goal } };
        if (method === 'thread/goal/set') { goal = params.status; if (goal === 'active') activations.push(current); }
        if (method === 'account/rateLimits/read') {
          if (stopOnHB && account === 'hb') stopped = true;
          const allowed = cycles ? account === ['americano', 'hb', 'jey'][round] : capacity[account];
          return { ordinaryUsageAllowed: allowed ?? false, accountId: d.authID(home) };
        }
        return {};
      } };
    },
  };
  const run = () => runGoalEngine({ id: 'same-goal', title: 'Three accounts', fingerprint: 'jey-fingerprint' }, (s) => states.push(s), d);
  return { run, states, probes, switched, activations };
}

test('same Goal continues JEY → AMERICANO → HB → JEY, then waits when all three run out', async () => {
  const f = fixture({ cycles: true });
  await f.run();
  assert.deepEqual(f.switched, ['americano', 'hb', 'jey']);
  assert.deepEqual(f.activations, ['americano', 'hb', 'jey']);
  assert.equal(f.states.filter((s) => s.state === 'waiting_quota').length, 1);
  assert.ok(f.states.every((s) => s.threadId === 'same-goal'));
  assert.equal(f.states.at(-1).state, 'stopped');
});

test('all three exhausted: one bounded probe pass, no auth swaps or activation', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.probes, ['americano', 'hb']);
  assert.deepEqual(f.switched, []); assert.deepEqual(f.activations, []);
  assert.ok(f.states.some((s) => s.state === 'waiting_quota'));
});

for (const [label, options, probes] of [
  ['HB available after exhausted Americano', { capacity: { hb: true } }, ['americano', 'hb']],
  ['HB not configured', { missing: ['hb'] }, ['americano']],
  ['duplicate HB login is excluded', { duplicate: true }, ['americano']],
  ['automatic disabled', { manual: true, capacity: { hb: true } }, []],
  ['stop during HB probe', { stopOnHB: true, capacity: { hb: true } }, ['americano', 'hb']],
]) test(label, async () => {
  const f = fixture(options); await f.run(); assert.deepEqual(f.probes, probes);
  assert.deepEqual(f.switched, label.startsWith('HB available') ? ['hb'] : []);
});
