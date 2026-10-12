'use strict';
// Strict Mode lock (background.js), findings #2 and #5.
//   - isWeakeningAction(request, currentState): the pure guard. Every action
//     that weakens filtering is true, adding blocks is false.
//   - handleMessage: while strict mode is on, a weakening request without the
//     right strictPassword is refused with { error: 'strict_locked' } and
//     changes nothing; with it, the request goes through.
//   - Enabling strict mode is Pro-only ({ error: 'pro_only' }); disabling it,
//     or using it after Pro lapsed, needs only the password.

const assert = require('node:assert');
const crypto = require('node:crypto');
const test = require('./registry');
const loadBackground = require('./load-background');

const PASSWORD = 'open sesame';
const HASH = crypto.createHash('sha256').update(PASSWORD).digest('hex');

function settings(extra) {
  return Object.assign({
    hideShorts: true,
    hideComments: true,
    hideSubsRelevant: true,
    language: 'auto',
    scheduleEnabled: false,
    dailyTimeLimitEnabled: false,
    strictModeEnabled: true,
    strictModePasswordHash: HASH
  }, extra);
}

// What a strict-mode user has saved.
function savedState(extra) {
  return Object.assign({
    settings: settings(),
    blockedChannels: [{ name: 'Drama Daily', id: '@dramadaily', blockedAt: 1 }],
    blockedKeywords: [{ keyword: 'gaming', addedAt: 1 }, { keyword: 'minecraft', addedAt: 1 }],
    disabledSynonyms: ['fortnite'],
    customSynonyms: { gaming: ['speedrun'] },
    whitelistedChannels: [],
    categoryTags: { gaming: ['every eye'] },
    categoryHits: { gaming: { 'every eye': 3 } },
    categoryHitVideos: { gaming: { 'every eye': ['a', 'b', 'c'] } },
    categoryTagExclusions: {}
  }, extra);
}

// The background's own isWeakeningAction, vm-loaded with background.js.
function guard() {
  const bg = loadBackground({});
  assert.strictEqual(typeof bg.sandbox.isWeakeningAction, 'function', 'background.js defines isWeakeningAction');
  return (request, current) => bg.sandbox.isWeakeningAction(request, current);
}

// --- isWeakeningAction (pure) ---

test('isWeakeningAction: every weakening action is true', () => {
  const isWeakening = guard();
  const current = savedState();
  const weakening = [
    { action: 'removeBlockedChannel', index: 0 },
    { action: 'clearAllBlockedChannels' },
    { action: 'removeKeyword', index: 1 },
    { action: 'untagChannelForCategory', category: 'gaming', channelName: 'every eye' },
    { action: 'clearCategoryData', category: 'gaming' },
    { action: 'replaceCategoryTags', tags: {} },
    { action: 'toggleSynonym', synonym: 'minecraft' },
    { action: 'removeCustomSynonym', category: 'gaming', synonym: 'speedrun' },
    { action: 'whitelistChannel', name: 'Drama Daily', id: '@dramadaily', exemptFrom: 'gaming' },
    { action: 'updateSetting', key: 'hideShorts', value: false },
    { action: 'updateSetting', key: 'hideComments', value: false },
    { action: 'updateSetting', key: 'hideSubsRelevant', value: false },
    { action: 'importAllData', data: { blockedChannels: [] } },
    { action: 'disableStrictMode', password: 'x' },
    { action: 'setStrictPassword', password: 'new one' }
  ];
  for (const request of weakening) {
    assert.strictEqual(isWeakening(request, current), true, JSON.stringify(request));
  }
});

test('isWeakeningAction: adding blocks and read-only actions are false', () => {
  const isWeakening = guard();
  const current = savedState();
  const notWeakening = [
    { action: 'blockChannel', channelName: 'Another', channelId: '@another' },
    { action: 'addKeyword', keyword: 'fortnite' },
    { action: 'addCustomSynonym', category: 'gaming', synonym: 'roblox' },
    { action: 'applyPreset', categoryKeys: ['gossip'] },
    { action: 'bulkAddBlockingTerms', items: [{ type: 'keyword', phrase: 'drama' }] },
    { action: 'batchIncrementCategoryHits', hits: [['gaming::other', ['v1']]] },
    { action: 'getFullState' },
    { action: 'exportAllData' },
    { action: 'logHiddenVideo', title: 't', channel: 'c', reason: 'keyword:gaming' },
    { action: 'verifyStrictPassword', password: 'x' }
  ];
  for (const request of notWeakening) {
    assert.strictEqual(isWeakening(request, current), false, JSON.stringify(request));
  }
});

test('isWeakeningAction: toggleSynonym weakens only when it disables a synonym', () => {
  const isWeakening = guard();
  const current = savedState({ disabledSynonyms: ['fortnite'] });
  assert.strictEqual(isWeakening({ action: 'toggleSynonym', synonym: 'roblox' }, current), true, 'disables roblox');
  assert.strictEqual(isWeakening({ action: 'toggleSynonym', synonym: 'fortnite' }, current), false, 're-enables fortnite');
  assert.strictEqual(isWeakening({ action: 'toggleSynonym', synonym: 'Fortnite' }, current), false, 'case-insensitive, like Storage.toggleSynonym');
});

test('isWeakeningAction: replaceCategoryTags weakens only when it removes a tag', () => {
  const isWeakening = guard();
  const current = savedState({ categoryTags: { gaming: ['every eye', 'pewdiepie'] } });
  assert.strictEqual(isWeakening({ action: 'replaceCategoryTags', tags: { gaming: ['every eye'] } }, current), true);
  assert.strictEqual(isWeakening({ action: 'replaceCategoryTags', tags: {} }, current), true);
  assert.strictEqual(isWeakening({ action: 'replaceCategoryTags' }, current), true, 'no tags = remove all');
  assert.strictEqual(isWeakening({ action: 'replaceCategoryTags', tags: { gaming: ['every eye', 'pewdiepie'] } }, current), false);
  assert.strictEqual(isWeakening({ action: 'replaceCategoryTags', tags: { gaming: ['every eye', 'pewdiepie', 'new'] } }, current), false);
});

test('isWeakeningAction: updateSetting weakens only when it turns a hide setting off', () => {
  const isWeakening = guard();
  const current = savedState();
  for (const key of ['hideShorts', 'hideComments', 'hideSubsRelevant']) {
    assert.strictEqual(isWeakening({ action: 'updateSetting', key, value: false }, current), true, key + ' off');
    assert.strictEqual(isWeakening({ action: 'updateSetting', key, value: true }, current), false, key + ' on');
  }
  // Hidden features and the language are not gated (Task 9)
  for (const key of ['language', 'scheduleEnabled', 'dailyTimeLimitEnabled', 'enableInterestBoundaries']) {
    assert.strictEqual(isWeakening({ action: 'updateSetting', key, value: false }, current), false, key);
  }
});

test('isWeakeningAction: an import that disables strict mode, changes its password or removes blocks weakens', () => {
  const isWeakening = guard();
  const current = savedState();
  const imports = {
    'disables strict mode': { settings: { strictModeEnabled: false } },
    'changes the password': { settings: { strictModePasswordHash: 'f'.repeat(64) } },
    'turns Hide Shorts off': { settings: { hideShorts: false } },
    'turns Hide "More relevant" off': { settings: { hideSubsRelevant: false } },
    'removes a blocked channel': { blockedChannels: [] },
    'drops a blocked channel id': { blockedChannels: [{ name: 'Drama Daily', blockedAt: 1 }] },
    'removes a blocked keyword': { blockedKeywords: [{ keyword: 'gaming', addedAt: 1 }] },
    'removes a custom synonym': { customSynonyms: {} },
    'disables a synonym': { disabledSynonyms: ['fortnite', 'roblox'] },
    'whitelists a channel': { whitelistedChannels: [{ name: 'Drama Daily', id: '@dramadaily', exemptFrom: 'gaming' }] },
    'removes an auto-tag': { categoryTags: {} },
    'untags a channel': { categoryTagExclusions: { gaming: ['every eye'] } }
  };
  for (const [label, data] of Object.entries(imports)) {
    assert.strictEqual(isWeakening({ action: 'importAllData', data }, current), true, label);
  }
});

test('isWeakeningAction: an import that only keeps or adds blocks does not weaken', () => {
  const isWeakening = guard();
  const current = savedState();
  const addOnly = {
    settings: settings({ language: 'it' }),
    blockedChannels: [...current.blockedChannels, { name: 'Another', id: '@another', blockedAt: 2 }],
    blockedKeywords: [...current.blockedKeywords, { keyword: 'Fortnite', addedAt: 2 }],
    customSynonyms: { gaming: ['speedrun', 'roblox'], kpop: ['bts'] },
    disabledSynonyms: [],
    whitelistedChannels: [],
    categoryTags: { gaming: ['every eye', 'pewdiepie'] },
    categoryTagExclusions: {}
  };
  assert.strictEqual(isWeakening({ action: 'importAllData', data: addOnly }, current), false);
  assert.strictEqual(isWeakening({ action: 'importAllData', data: {} }, current), false, 'empty backup changes nothing');
});

// --- handleMessage with strict mode on ---

// Each case: a weakening request and a check that it took effect.
const WEAKENING_CASES = [
  ['removeBlockedChannel', { action: 'removeBlockedChannel', index: 0 }, s => s.blockedChannels.length === 0],
  ['clearAllBlockedChannels', { action: 'clearAllBlockedChannels' }, s => s.blockedChannels.length === 0],
  ['removeKeyword', { action: 'removeKeyword', index: 1 }, s => s.blockedKeywords.length === 1],
  ['untagChannelForCategory', { action: 'untagChannelForCategory', category: 'gaming', channelName: 'every eye' }, s => !s.categoryTags.gaming],
  ['clearCategoryData', { action: 'clearCategoryData', category: 'gaming' }, s => !s.categoryTags.gaming],
  ['replaceCategoryTags', { action: 'replaceCategoryTags', tags: {} }, s => !s.categoryTags.gaming],
  ['toggleSynonym (disable)', { action: 'toggleSynonym', synonym: 'roblox' }, s => s.disabledSynonyms.includes('roblox')],
  ['removeCustomSynonym', { action: 'removeCustomSynonym', category: 'gaming', synonym: 'speedrun' }, s => !s.customSynonyms.gaming],
  ['whitelistChannel', { action: 'whitelistChannel', name: 'Drama Daily', id: '@dramadaily', exemptFrom: 'gaming' }, s => s.whitelistedChannels.length === 1],
  ['updateSetting hideShorts off', { action: 'updateSetting', key: 'hideShorts', value: false }, s => s.settings.hideShorts === false],
  ['updateSetting hideComments off', { action: 'updateSetting', key: 'hideComments', value: false }, s => s.settings.hideComments === false],
  ['updateSetting hideSubsRelevant off', { action: 'updateSetting', key: 'hideSubsRelevant', value: false }, s => s.settings.hideSubsRelevant === false],
  ['importAllData (removes blocks)', { action: 'importAllData', data: { blockedChannels: [], blockedKeywords: [] } }, s => s.blockedChannels.length === 0],
  ['importAllData (disables strict mode)', { action: 'importAllData', data: { settings: { strictModeEnabled: false } } }, s => s.settings.strictModeEnabled === false]
];

test('strict mode on: every weakening request without the password is refused with strict_locked and changes nothing', async () => {
  for (const [label, request] of WEAKENING_CASES) {
    const bg = loadBackground(savedState(), { isPro: true });
    const before = bg.storage();
    assert.deepStrictEqual(await bg.handleMessage(request), { error: 'strict_locked' }, label);
    assert.deepStrictEqual(bg.writes, [], label + ': no storage write');
    assert.deepStrictEqual(bg.storage(), before, label);
  }
});

test('strict mode on: a wrong strictPassword is refused too', async () => {
  for (const [label, request] of WEAKENING_CASES) {
    const bg = loadBackground(savedState(), { isPro: true });
    const res = await bg.handleMessage(Object.assign({}, request, { strictPassword: 'wrong password' }));
    assert.deepStrictEqual(res, { error: 'strict_locked' }, label);
    assert.deepStrictEqual(bg.writes, [], label);
  }
});

test('strict mode on: the right strictPassword lets every weakening request through', async () => {
  for (const [label, request, applied] of WEAKENING_CASES) {
    const bg = loadBackground(savedState(), { isPro: true });
    const res = await bg.handleMessage(Object.assign({}, request, { strictPassword: PASSWORD }));
    assert.ok(!res || res.error === undefined, label + ': ' + JSON.stringify(res));
    assert.ok(applied(bg.storage()), label + ' took effect');
  }
});

test('strict mode on: the lock still holds after Pro lapsed (password, not Pro, unlocks)', async () => {
  const bg = loadBackground(savedState(), { isPro: false });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'removeBlockedChannel', index: 0 }), { error: 'strict_locked' });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'removeBlockedChannel', index: 0, strictPassword: PASSWORD }), { success: true });
  assert.strictEqual(bg.storage().blockedChannels.length, 0);
});

test('strict mode on: adding blocks never needs the password', async () => {
  const bg = loadBackground(savedState(), { isPro: true });
  assert.strictEqual((await bg.handleMessage({ action: 'blockChannel', channelName: 'Another', channelId: '@another' })).success, true);
  assert.strictEqual((await bg.handleMessage({ action: 'addKeyword', keyword: 'fortnite' })).success, true);
  assert.strictEqual((await bg.handleMessage({ action: 'addCustomSynonym', category: 'gaming', synonym: 'roblox' })).success, true);
  assert.deepStrictEqual(await bg.handleMessage({ action: 'toggleSynonym', synonym: 'fortnite' }), { enabled: true });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'updateSetting', key: 'hideShorts', value: true }), { success: true });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'replaceCategoryTags', tags: { gaming: ['every eye', 'new'] } }), { success: true });
  const backup = await bg.handleMessage({ action: 'exportAllData' });
  backup.blockedKeywords.push({ keyword: 'drama', addedAt: 3 });
  assert.strictEqual((await bg.handleMessage({ action: 'importAllData', data: backup })).success, true);
  const s = bg.storage();
  assert.strictEqual(s.blockedChannels.length, 2);
  assert.deepStrictEqual(s.blockedKeywords.map(k => k.keyword), ['gaming', 'minecraft', 'fortnite', 'drama']);
  assert.strictEqual(s.settings.strictModeEnabled, true);
});

test('strict mode off: weakening requests need no password', async () => {
  for (const [label, request, applied] of WEAKENING_CASES) {
    const bg = loadBackground(savedState({ settings: settings({ strictModeEnabled: false, strictModePasswordHash: '' }) }), { isPro: true });
    const res = await bg.handleMessage(request);
    assert.ok(!res || res.error === undefined, label + ': ' + JSON.stringify(res));
    assert.ok(applied(bg.storage()), label + ' took effect');
  }
});

test('disableStrictMode keeps its own password check', async () => {
  const bg = loadBackground(savedState());
  assert.deepStrictEqual(await bg.handleMessage({ action: 'disableStrictMode', password: 'wrong' }), { success: false, reason: 'wrong_password' });
  assert.strictEqual(bg.storage().settings.strictModeEnabled, true);
  assert.deepStrictEqual(await bg.handleMessage({ action: 'disableStrictMode', password: PASSWORD }), { success: true });
  assert.strictEqual(bg.storage().settings.strictModeEnabled, false);
  assert.strictEqual(bg.storage().settings.strictModePasswordHash, '');
});

test('updateSetting cannot turn strict mode off or change its password', async () => {
  const bg = loadBackground(savedState(), { isPro: true });
  for (const request of [
    { action: 'updateSetting', key: 'strictModeEnabled', value: false },
    { action: 'updateSetting', key: 'strictModePasswordHash', value: '' },
    { action: 'updateSetting', key: 'strictModeEnabled', value: false, strictPassword: PASSWORD }
  ]) {
    const res = await bg.handleMessage(request);
    assert.ok(res && res.success !== true, JSON.stringify(res));
  }
  assert.deepStrictEqual(bg.writes, []);
  assert.strictEqual(bg.storage().settings.strictModeEnabled, true);
});

// --- Enabling strict mode is Pro-only (Ruling 9) ---

test('setStrictPassword: a free user cannot enable strict mode (pro_only)', async () => {
  const bg = loadBackground(savedState({ settings: settings({ strictModeEnabled: false, strictModePasswordHash: '' }) }), { isPro: false });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'setStrictPassword', password: PASSWORD }), { error: 'pro_only' });
  assert.deepStrictEqual(bg.writes, []);
  assert.strictEqual(bg.storage().settings.strictModeEnabled, false);
});

test('setStrictPassword: a Pro user enables strict mode', async () => {
  const bg = loadBackground(savedState({ settings: settings({ strictModeEnabled: false, strictModePasswordHash: '' }) }), { isPro: true });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'setStrictPassword', password: PASSWORD }), { success: true });
  assert.strictEqual(bg.storage().settings.strictModeEnabled, true);
  assert.strictEqual(bg.storage().settings.strictModePasswordHash, HASH);
  assert.deepStrictEqual(await bg.handleMessage({ action: 'removeKeyword', index: 0 }), { error: 'strict_locked' });
});

test('setStrictPassword while strict mode is on needs the current password', async () => {
  const bg = loadBackground(savedState(), { isPro: true });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'setStrictPassword', password: 'new pass' }), { error: 'strict_locked' });
  assert.strictEqual(bg.storage().settings.strictModePasswordHash, HASH);
  assert.deepStrictEqual(await bg.handleMessage({ action: 'setStrictPassword', password: 'new pass', strictPassword: PASSWORD }), { success: true });
  assert.notStrictEqual(bg.storage().settings.strictModePasswordHash, HASH);
  assert.deepStrictEqual(await bg.handleMessage({ action: 'removeKeyword', index: 0, strictPassword: 'new pass' }), { success: true });
});

test('a free user whose Pro lapsed can still disable strict mode with the password', async () => {
  const bg = loadBackground(savedState(), { isPro: false });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'disableStrictMode', password: PASSWORD }), { success: true });
  assert.strictEqual(bg.storage().settings.strictModeEnabled, false);
});

test('verifyStrictPassword still answers for the stored hash', async () => {
  const bg = loadBackground(savedState());
  assert.deepStrictEqual(await bg.handleMessage({ action: 'verifyStrictPassword', password: PASSWORD }), { valid: true });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'verifyStrictPassword', password: 'nope' }), { valid: false });
});
