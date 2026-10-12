'use strict';
// Feature flags (features.js) and the low-demand features v1.4 hides:
// Interest Boundaries, Smart Decay, Schedule and the Daily time limit.
//   - CF_FEATURES loads, is frozen, and ships with all four flags off
//   - background: no Smart Decay alarm (an old one is cleared), the decay
//     handler does nothing, no curiosity prompt, no time-tracking writes
//   - saved interests are kept (ignored, not deleted)

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('./registry');
const loadBackground = require('./load-background');

const FEATURES_PATH = path.resolve(__dirname, '..', '..', 'features.js');
const FLAGS = ['interestBoundaries', 'smartDecay', 'schedule', 'dailyTimeLimit'];
const DAY_MS = 24 * 60 * 60 * 1000;

// Evaluates features.js in a fresh context, like a classic <script> or
// importScripts(), and returns its top-level CF_FEATURES binding.
function loadFeatures() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(FEATURES_PATH, 'utf8') + '\n;globalThis.__cfFeatures = CF_FEATURES;\n', sandbox, { filename: FEATURES_PATH });
  return sandbox.__cfFeatures;
}

// A saved "Always" interest last used 40 days ago: Smart Decay would delete it.
function staleInterests() {
  const old = Date.now() - 40 * DAY_MS;
  return { minecraft: { query: 'minecraft', keywords: ['minecraft'], addedAt: old, lastUsed: old, expiresAt: null } };
}

function settingsWith(extra) {
  return Object.assign({
    enableInterestBoundaries: true,
    enableSmartDecay: true,
    dailyTimeLimitEnabled: true,
    dailyTimeLimitMins: 30,
    scheduleEnabled: true,
    scheduleDays: [],
    strictModeEnabled: false,
    strictModePasswordHash: ''
  }, extra);
}

// --- features.js ---

test('CF_FEATURES loads with exactly the four feature flags, all booleans', () => {
  const f = loadFeatures();
  assert.ok(f && typeof f === 'object', 'CF_FEATURES is an object');
  assert.deepStrictEqual(Object.keys(f).sort(), [...FLAGS].sort());
  for (const flag of FLAGS) assert.strictEqual(typeof f[flag], 'boolean', flag);
});

test('CF_FEATURES is frozen: a flag cannot be turned on or added at runtime', () => {
  const f = loadFeatures();
  assert.strictEqual(Object.isFrozen(f), true);
  assert.throws(() => { f.schedule = true; }, TypeError);
  assert.throws(() => { f.newFeature = true; }, TypeError);
  assert.strictEqual(f.schedule, false);
  assert.strictEqual('newFeature' in f, false);
});

test('v1.4 ships with Interest Boundaries, Smart Decay, Schedule and Daily time limit hidden', () => {
  const f = loadFeatures();
  for (const flag of FLAGS) assert.strictEqual(f[flag], false, flag);
});

// --- background.js with the flags off ---

test('install/update creates no Smart Decay alarm and clears one left by an older version', async () => {
  const bg = loadBackground({});
  assert.strictEqual(bg.listeners.onInstalled.length, 1);
  await bg.listeners.onInstalled[0]({ reason: 'update' });
  assert.deepStrictEqual(bg.alarmCalls.filter(c => c[0] === 'create'), []);
  assert.deepStrictEqual(bg.alarmCalls.filter(c => c[0] === 'clear'), [['clear', 'smartDecay']]);
});

test('browser startup creates no Smart Decay alarm and clears an existing one', async () => {
  const bg = loadBackground({});
  assert.strictEqual(bg.listeners.onStartup.length, 1);
  await bg.listeners.onStartup[0]();
  assert.deepStrictEqual(bg.alarmCalls.filter(c => c[0] === 'create'), []);
  assert.deepStrictEqual(bg.alarmCalls.filter(c => c[0] === 'clear'), [['clear', 'smartDecay']]);
});

test('a Smart Decay alarm that still fires deletes nothing, even for Pro with decay enabled', async () => {
  const interests = staleInterests();
  const bg = loadBackground({ interests, settings: settingsWith() }, { isPro: true });
  assert.strictEqual(bg.listeners.onAlarm.length, 1);
  await bg.listeners.onAlarm[0]({ name: 'smartDecay' });
  assert.deepStrictEqual(bg.storage().interests, interests);
  assert.deepStrictEqual(bg.writes, []);
});

test('checkInterest never asks for a curiosity prompt and does not use up the free teaser', async () => {
  const free = loadBackground({ interests: {}, onboarding: { interestPromptCount: 0 }, settings: settingsWith() });
  assert.deepStrictEqual(await free.handleMessage({ action: 'checkInterest', query: 'minecraft house tutorial' }), { shouldPrompt: false });
  assert.deepStrictEqual(free.storage().onboarding, { interestPromptCount: 0 });
  assert.deepStrictEqual(free.writes, []);

  const pro = loadBackground({ interests: {}, onboarding: { interestPromptCount: 7 }, settings: settingsWith() }, { isPro: true });
  assert.deepStrictEqual(await pro.handleMessage({ action: 'checkInterest', query: 'minecraft house tutorial' }), { shouldPrompt: false });
  assert.deepStrictEqual(pro.writes, []);
});

test('addTimeUsed writes nothing: no time tracking while the Daily time limit is hidden', async () => {
  const tracking = { day: '2026-10-12', secondsUsed: 120 };
  const bg = loadBackground({ dailyTimeTracking: tracking, settings: settingsWith() });
  await bg.handleMessage({ action: 'addTimeUsed', seconds: 30 });
  await bg.handleMessage({ action: 'addTimeUsed', seconds: 30 });
  assert.deepStrictEqual(bg.writes, []);
  assert.deepStrictEqual(bg.storage().dailyTimeTracking, tracking);
});

test('saved interests and hidden-feature settings are kept, not deleted', async () => {
  const interests = staleInterests();
  const settings = settingsWith({ scheduleStart: '22:00', scheduleEnd: '06:00' });
  const bg = loadBackground({ interests, settings });
  await bg.listeners.onInstalled[0]({ reason: 'update' });
  await bg.listeners.onStartup[0]();
  const state = await bg.handleMessage({ action: 'getFullState' });
  assert.deepStrictEqual(state.interests, interests);
  assert.deepStrictEqual(state.settings, settings);
  const backup = await bg.handleMessage({ action: 'exportAllData' });
  assert.deepStrictEqual(backup.interests, interests);
});
