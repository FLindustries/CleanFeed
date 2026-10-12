'use strict';
// Cached Pro status (background.js), audit finding #13.
//   - proCacheDecision(cache, now, retryAt): the pure cache decision. A fresh
//     cache (younger than 6 hours) is used with no refresh; a stale one answers
//     now and refreshes in the background; with no cache the first answer is
//     awaited (free meanwhile); after a failed refresh none starts before retryAt.
//   - proCacheAfterRefresh(cache, paid, now): an answer replaces the cache, a
//     failure (paid === null) keeps the last known value, no cache + failure
//     stays empty (free).
//   - handleMessage: ExtPay is asked on service worker start, when the cache is
//     stale and on onPaid, never once per message; messages that don't need
//     Pro status never wait for it.

const assert = require('node:assert');
const test = require('./registry');
const loadBackground = require('./load-background');

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);

// Lets every pending promise chain (stub storage, stub ExtPay) finish.
const settle = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// A test clock for the context's Date.now.
function clock(start) {
  let now = start;
  return { now: () => now, advance(ms) { now += ms; } };
}

// getUser() answers, one per call, in order; the last one repeats.
// An answer is { paid }, an Error (rejects), or a deferred (its promise).
function answers(...list) {
  let i = 0;
  return () => {
    const next = list[Math.min(i++, list.length - 1)];
    if (next instanceof Error) return Promise.reject(next);
    if (next && next.promise) return next.promise;
    return Promise.resolve(next);
  };
}

// Resolves to 'pending' if `promise` has not settled after a few event-loop turns.
async function stateOf(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 5; i++) await settle();
  return done ? 'settled' : 'pending';
}

function pure() {
  const bg = loadBackground({});
  for (const name of ['proCacheDecision', 'proCacheAfterRefresh']) {
    assert.strictEqual(typeof bg.sandbox[name], 'function', 'background.js defines ' + name);
  }
  const plain = value => JSON.parse(JSON.stringify(value));
  return {
    decide: (cache, now, retryAt) => plain(bg.sandbox.proCacheDecision(cache, now, retryAt)),
    after: (cache, paid, now) => bg.sandbox.proCacheAfterRefresh(cache, paid, now)
  };
}

// Collects the background's console.warn calls (a failed refresh logs one).
function quietConsole() {
  const warnings = [];
  return { warnings, console: Object.assign(Object.create(console), { warn: (...args) => warnings.push(args.join(' ')) }) };
}

const keywords = n => Array.from({ length: n }, (_, i) => ({ keyword: 'kw' + i, addedAt: 1 }));

// --- proCacheDecision (pure) ---

test('proCacheDecision: a fresh cache is used as is, with no refresh', () => {
  const { decide } = pure();
  assert.deepStrictEqual(decide({ isPro: true, checkedAt: T0 - HOUR }, T0, 0), { isPro: true, refresh: false, wait: false });
  assert.deepStrictEqual(decide({ isPro: false, checkedAt: T0 - 5 * HOUR }, T0, 0), { isPro: false, refresh: false, wait: false });
  assert.deepStrictEqual(decide({ isPro: true, checkedAt: T0 }, T0, 0), { isPro: true, refresh: false, wait: false });
});

test('proCacheDecision: a stale cache answers now and refreshes in the background', () => {
  const { decide } = pure();
  assert.deepStrictEqual(decide({ isPro: true, checkedAt: T0 - 7 * HOUR }, T0, 0), { isPro: true, refresh: true, wait: false });
  assert.deepStrictEqual(decide({ isPro: true, checkedAt: T0 - 6 * HOUR }, T0, 0), { isPro: true, refresh: true, wait: false }, '6 hours old is stale');
  assert.deepStrictEqual(decide({ isPro: false, checkedAt: T0 - 30 * 24 * HOUR }, T0, 0), { isPro: false, refresh: true, wait: false });
  // A cache from the future (the clock moved back) is not trusted as fresh
  assert.deepStrictEqual(decide({ isPro: true, checkedAt: T0 + HOUR }, T0, 0), { isPro: true, refresh: true, wait: false });
});

test('proCacheDecision: no cache (or a malformed one) waits for the first answer, free meanwhile', () => {
  const { decide } = pure();
  const none = { isPro: false, refresh: true, wait: true };
  for (const cache of [undefined, null, {}, 'pro', { isPro: 'yes', checkedAt: T0 }, { isPro: true }, { isPro: true, checkedAt: 'today' }]) {
    assert.deepStrictEqual(decide(cache, T0, 0), none, JSON.stringify(cache));
  }
});

test('proCacheDecision: after a failed refresh, none starts before retryAt', () => {
  const { decide } = pure();
  const retryAt = T0 + 5 * MINUTE;
  assert.deepStrictEqual(decide({ isPro: true, checkedAt: T0 - 7 * HOUR }, T0, retryAt), { isPro: true, refresh: false, wait: false });
  assert.deepStrictEqual(decide(null, T0, retryAt), { isPro: false, refresh: false, wait: false });
  assert.deepStrictEqual(decide({ isPro: true, checkedAt: T0 - 7 * HOUR }, retryAt, retryAt), { isPro: true, refresh: true, wait: false });
  assert.deepStrictEqual(decide(null, retryAt, retryAt), { isPro: false, refresh: true, wait: true });
});

// --- proCacheAfterRefresh (pure) ---

test('proCacheAfterRefresh: an answer replaces the cache, stamped with the time', () => {
  const { after } = pure();
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepStrictEqual(plain(after({ isPro: true, checkedAt: T0 - 7 * HOUR }, false, T0)), { isPro: false, checkedAt: T0 });
  assert.deepStrictEqual(plain(after(null, true, T0)), { isPro: true, checkedAt: T0 });
});

test('proCacheAfterRefresh: a failure keeps the last known value; no cache + failure means free', () => {
  const { after } = pure();
  const cache = { isPro: true, checkedAt: T0 - 7 * HOUR };
  assert.strictEqual(after(cache, null, T0), cache, 'failure keeps the cache unchanged');
  assert.strictEqual(after(null, null, T0), null, 'no cache + failure: still nothing cached (free)');
  assert.strictEqual(after({ isPro: 'yes' }, null, T0), null, 'a malformed cache is not kept');
});

// --- handleMessage ---

test('fresh cache: Pro checks read the cache, ExtPay is asked only once at service worker start', async () => {
  const time = clock(T0);
  const bg = loadBackground({ proStatusCache: { isPro: true, checkedAt: T0 - HOUR }, blockedKeywords: keywords(3) },
    { now: time.now, getUser: answers({ paid: true }) });
  await settle();
  assert.strictEqual(bg.getUserCalls(), 1, 'one refresh on service worker start');
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await bg.handleMessage({ action: 'getFullState' })).isPro, true);
  }
  assert.deepStrictEqual(await bg.handleMessage({ action: 'addKeyword', keyword: 'fourth' }), { success: true });
  await bg.handleMessage({ action: 'logHiddenVideo', title: 't', channel: 'c', reason: 'keyword:x' });
  assert.strictEqual(bg.getUserCalls(), 1, 'no ExtPay call per message');
  assert.deepStrictEqual(bg.proStatusCache(), { isPro: true, checkedAt: T0 });
});

test('stale cache: the message gets the cached answer at once, the refresh runs in the background', async () => {
  const time = clock(T0);
  const later = deferred();
  const bg = loadBackground({ proStatusCache: { isPro: true, checkedAt: T0 - HOUR } },
    { now: time.now, getUser: answers({ paid: true }, later) });
  await settle();
  assert.strictEqual(bg.getUserCalls(), 1);

  time.advance(7 * HOUR);
  const state = await bg.handleMessage({ action: 'getFullState' });
  assert.strictEqual(state.isPro, true, 'cached answer, not blocked on the network');
  assert.strictEqual(bg.getUserCalls(), 2, 'the stale cache started one refresh');
  await bg.handleMessage({ action: 'getFullState' });
  assert.strictEqual(bg.getUserCalls(), 2, 'one refresh at a time');

  later.resolve({ paid: false }); // the subscription ended
  await settle();
  assert.deepStrictEqual(bg.proStatusCache(), { isPro: false, checkedAt: T0 + 7 * HOUR });
  assert.strictEqual((await bg.handleMessage({ action: 'getFullState' })).isPro, false);
  assert.strictEqual(bg.getUserCalls(), 2, 'fresh again: no more calls');
});

test('a failed refresh keeps the last known value: a paying user stays Pro offline', async () => {
  const time = clock(T0);
  const stale = { isPro: true, checkedAt: T0 - 8 * HOUR };
  const log = quietConsole();
  const bg = loadBackground({ proStatusCache: stale, blockedKeywords: keywords(3) },
    { now: time.now, getUser: answers(new Error('Failed to fetch')), console: log.console });
  assert.strictEqual((await bg.handleMessage({ action: 'getFullState' })).isPro, true);
  assert.deepStrictEqual(await bg.handleMessage({ action: 'addKeyword', keyword: 'fourth' }), { success: true });
  await settle();
  assert.deepStrictEqual(bg.proStatusCache(), stale, 'the cache is left as it was');
  assert.deepStrictEqual(bg.proWrites, [], 'nothing written on failure');
  assert.strictEqual(log.warnings.length, 1, 'the failure is logged once');
});

test('no cache and a failed refresh: free, and nothing is cached', async () => {
  const bg = loadBackground({ blockedKeywords: keywords(3) }, { getUser: answers(new Error('offline')), console: quietConsole().console });
  assert.strictEqual((await bg.handleMessage({ action: 'getFullState' })).isPro, false);
  assert.deepStrictEqual(await bg.handleMessage({ action: 'addKeyword', keyword: 'fourth' }), { success: false, reason: 'free_limit' });
  await settle();
  assert.strictEqual(bg.proStatusCache(), undefined);
});

test('after a failed refresh, ExtPay is not asked again for 5 minutes', async () => {
  const time = clock(T0);
  const bg = loadBackground({}, { now: time.now, getUser: answers(new Error('offline'), { paid: true }), console: quietConsole().console });
  await settle();
  assert.strictEqual(bg.getUserCalls(), 1, 'service worker start');
  for (let i = 0; i < 3; i++) assert.strictEqual((await bg.handleMessage({ action: 'getFullState' })).isPro, false);
  assert.strictEqual(bg.getUserCalls(), 1, 'no retry storm while offline');

  time.advance(5 * MINUTE);
  assert.strictEqual((await bg.handleMessage({ action: 'getFullState' })).isPro, true, 'retried, and the answer was awaited (no cache)');
  assert.strictEqual(bg.getUserCalls(), 2);
});

test('no cache: a Pro check waits for the first answer and caches it', async () => {
  const time = clock(T0);
  const first = deferred();
  const bg = loadBackground({}, { now: time.now, getUser: answers(first) });
  const pending = bg.handleMessage({ action: 'getFullState' });
  assert.strictEqual(await stateOf(pending), 'pending', 'waits for the first answer');
  first.resolve({ paid: true });
  assert.strictEqual((await pending).isPro, true);
  assert.deepStrictEqual(bg.proStatusCache(), { isPro: true, checkedAt: T0 });
  assert.strictEqual(bg.getUserCalls(), 1, 'the message shared the service-worker-start refresh');
});

test('no cache: a Pro check waits a bounded time, answers free, and the late answer is cached', async () => {
  const timers = [];
  const first = deferred();
  const bg = loadBackground({}, {
    getUser: answers(first),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {}
  });
  const pending = bg.handleMessage({ action: 'getFullState' });
  await settle();
  assert.strictEqual(timers.length, 1, 'one wait timer');
  assert.ok(timers[0].ms > 0 && timers[0].ms <= 5000, 'waits at most 5 s, got ' + timers[0].ms);
  timers[0].fn();
  assert.strictEqual((await pending).isPro, false, 'free while ExtPay has not answered');

  first.resolve({ paid: true });
  await settle();
  assert.strictEqual(bg.proStatusCache().isPro, true, 'the late answer is cached');
  assert.strictEqual((await bg.handleMessage({ action: 'getFullState' })).isPro, true);
});

test('messages that do not need Pro status never wait for ExtPay', async () => {
  const never = deferred(); // ExtPay never answers, nothing cached
  const bg = loadBackground({ blockedKeywords: keywords(1) }, { getUser: answers(never), setTimeout: () => 0, clearTimeout: () => {} });
  const requests = [
    { action: 'getBlockedKeywords' },
    { action: 'getBlockedChannelNames' },
    { action: 'blockChannel', channelName: 'Drama Daily', channelId: '@dramadaily' },
    { action: 'logHiddenVideo', title: 't', channel: 'c', reason: 'keyword:kw0' },
    { action: 'incrementStat', stat: 'videosHidden' },
    { action: 'getTimeUsed' },
    { action: 'removeKeyword', index: 0 },
    { action: 'exportAllData' }
  ];
  for (const request of requests) {
    assert.strictEqual(await stateOf(bg.handleMessage(request)), 'settled', request.action + ' waited for ExtPay');
  }
  assert.strictEqual(await stateOf(bg.handleMessage({ action: 'getFullState' })), 'pending', 'getFullState does need it');
});

test('onPaid: a payment is cached as Pro at once', async () => {
  const time = clock(T0);
  const bg = loadBackground({}, { now: time.now, isPro: false });
  await settle();
  assert.strictEqual((await bg.handleMessage({ action: 'getFullState' })).isPro, false);
  assert.strictEqual(bg.paidListeners.length, 1, 'background listens to extpay.onPaid');

  time.advance(MINUTE);
  bg.paidListeners[0]({ paid: true, paidAt: new Date(T0) });
  await settle();
  assert.deepStrictEqual(bg.proStatusCache(), { isPro: true, checkedAt: T0 + MINUTE });
  assert.strictEqual((await bg.handleMessage({ action: 'getFullState' })).isPro, true);
  assert.strictEqual(bg.getUserCalls(), 1, 'no extra network call needed');
});

test('onPaid during a refresh: the refresh answer sent before the payment does not overwrite it', async () => {
  const time = clock(T0);
  const inFlight = deferred();
  const bg = loadBackground({}, { now: time.now, getUser: answers({ paid: false }, inFlight) });
  await settle();
  time.advance(7 * HOUR);
  assert.strictEqual((await bg.handleMessage({ action: 'getFullState' })).isPro, false); // starts a refresh
  assert.strictEqual(bg.getUserCalls(), 2);

  bg.paidListeners[0]({ paid: true });
  inFlight.resolve({ paid: false }); // answered before the payment went through
  await settle();
  assert.strictEqual(bg.proStatusCache().isPro, true);
  assert.strictEqual((await bg.handleMessage({ action: 'getFullState' })).isPro, true);
});

test('Pro-only actions still use Pro status: whitelist and enabling Strict Mode', async () => {
  const free = loadBackground({}, { isPro: false });
  assert.deepStrictEqual(await free.handleMessage({ action: 'whitelistChannel', name: 'A', id: '@a', exemptFrom: 'gaming' }), { success: false, reason: 'pro_only' });
  assert.deepStrictEqual(await free.handleMessage({ action: 'setStrictPassword', password: 'abcd' }), { error: 'pro_only' });

  const pro = loadBackground({}, { isPro: true });
  assert.deepStrictEqual(await pro.handleMessage({ action: 'whitelistChannel', name: 'A', id: '@a', exemptFrom: 'gaming' }), { success: true });
  assert.deepStrictEqual(await pro.handleMessage({ action: 'setStrictPassword', password: 'abcd' }), { success: true });
});
