// CleanFeed Background Service Worker

importScripts('lib/ExtPay.js');
importScripts('features.js');
importScripts('storage.js');

// --- ExtensionPay (resilient init) ---
let extpay;
try {
  extpay = ExtPay('cleanfeed');
  extpay.startBackground();
} catch (e) {
  console.warn('CleanFeed: ExtensionPay init failed:', e);
}

// --- Pro status (cached) ---
// extpay.getUser() is a request to extensionpay.com (once the user has ever
// opened the payment page), so the answer is cached in memory and in
// chrome.storage.local `proStatusCache`: { isPro, checkedAt }. It is
// refreshed on service worker start, when ExtPay reports a payment or saves a
// new answer, after a checkout, and in the background when older than
// PRO_CACHE_TTL_MS. A failed refresh keeps the last known answer (a paying
// user stays Pro offline); with no answer yet, a failure means free.
const PRO_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// After a failed refresh, the next one waits this long.
const PRO_RETRY_MS = 5 * 60 * 1000;
// With nothing cached, a Pro check waits this long for ExtPay, then answers
// free; the late answer is still cached.
const PRO_FIRST_WAIT_MS = 3000;

// `cache` when it is a well-formed { isPro, checkedAt }, else null.
function validProCache(cache) {
  if (!cache || typeof cache !== 'object') return null;
  if (typeof cache.isPro !== 'boolean' || !Number.isFinite(cache.checkedAt)) return null;
  return cache;
}

// Pure. What a Pro check does with `cache` at `now`; no refresh starts
// before `retryAt` (set after a failed one):
//   fresh cache -> { isPro: cached, refresh: false, wait: false }
//   stale cache -> { isPro: cached, refresh: true,  wait: false }  answer now, refresh in the background
//   no cache    -> { isPro: false,  refresh: true,  wait: true }   wait for the first answer
function proCacheDecision(cache, now, retryAt) {
  const valid = validProCache(cache);
  const canRefresh = now >= (retryAt || 0);
  if (!valid) return { isPro: false, refresh: canRefresh, wait: canRefresh };
  const age = now - valid.checkedAt;
  const fresh = age >= 0 && age < PRO_CACHE_TTL_MS;
  return { isPro: valid.isPro, refresh: !fresh && canRefresh, wait: false };
}

// Pure. The cache after a refresh: `paid` is ExtPay's answer (true/false),
// or null when the refresh failed, which keeps the last known cache (null
// when there is none, which reads as free).
function proCacheAfterRefresh(cache, paid, now) {
  if (paid === true || paid === false) return { isPro: paid, checkedAt: now };
  return validProCache(cache);
}

let proCache;             // { isPro, checkedAt } or null; undefined until read from storage
let proCacheRead = null;  // reads proCache from storage, once per service worker
let proRefresh = null;    // the refresh in flight (resolves to isPro)
let proRetryAt = 0;       // no refresh before this time
let proCacheVersion = 0;  // bumped on every cache write

function readProCache() {
  if (!proCacheRead) {
    proCacheRead = chrome.storage.local.get('proStatusCache')
      .then(data => data.proStatusCache, () => null)
      .then(stored => { if (proCache === undefined) proCache = validProCache(stored); });
  }
  return proCacheRead;
}

async function writeProCache(cache) {
  proCache = cache;
  proCacheVersion++;
  try {
    await chrome.storage.local.set({ proStatusCache: cache });
  } catch (e) {
    console.warn('CleanFeed: could not save Pro status:', e);
  }
}

// Asks ExtPay now (one request at a time) and caches the answer.
function refreshProStatus() {
  if (!proRefresh) {
    proRefresh = (async () => {
      await readProCache();
      const version = proCacheVersion;
      let paid = null;
      try {
        if (extpay) paid = (await extpay.getUser())?.paid === true;
      } catch (e) {
        console.warn('CleanFeed: Pro status check failed, keeping the last known one:', e);
      }
      if (paid === null) proRetryAt = Date.now() + PRO_RETRY_MS;
      // A cache written meanwhile (onPaid) is newer than this answer
      else if (version === proCacheVersion) await writeProCache(proCacheAfterRefresh(proCache, paid, Date.now()));
      return proCache ? proCache.isPro : false;
    })().finally(() => { proRefresh = null; });
  }
  return proRefresh;
}

// Resolves to `promise`'s value, or to `fallback` after `ms`.
function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Pro status for a request: the cached answer, refreshed in the background
// when stale. Only with nothing cached does it wait (briefly) for ExtPay.
async function checkProStatus() {
  await readProCache();
  const decision = proCacheDecision(proCache, Date.now(), proRetryAt);
  if (!decision.refresh) return decision.isPro;
  const refresh = refreshProStatus();
  return decision.wait ? withTimeout(refresh, PRO_FIRST_WAIT_MS, false) : decision.isPro;
}

try {
  if (extpay && extpay.onPaid) {
    extpay.onPaid.addListener(user => {
      writeProCache({ isPro: typeof user?.paid === 'boolean' ? user.paid : true, checkedAt: Date.now() });
    });
  }
} catch (e) {
  console.warn('CleanFeed: ExtensionPay onPaid listener failed:', e);
}

// ExtPay saves every user it fetches in storage `extensionpay_user` (sync, or
// local where sync is unavailable): its payment polling, a resubscription,
// another device. onPaid only fires when the saved user had no paidAt yet, so
// a returning subscriber who pays again is only seen here.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' && areaName !== 'local') return;
  const user = changes.extensionpay_user && changes.extensionpay_user.newValue;
  const paid = user && user.paid;
  if (typeof paid !== 'boolean') return;
  readProCache().then(() => {
    // A newer answer than any refresh in flight (writeProCache bumps the version)
    if (!proCache || proCache.isPro !== paid) writeProCache({ isPro: paid, checkedAt: Date.now() });
  });
});

// After a checkout, ExtPay's payment page sends 'extpay-fetch-user' and ExtPay
// polls the user until it has a paidAt. A returning subscriber already has
// one, so that poll stops at its first answer even when the payment is not
// recorded yet. Until the cache says Pro, ask again after these delays.
const PRO_CHECKOUT_RECHECK_MS = [15 * 1000, 60 * 1000, 3 * 60 * 1000];
let proCheckoutRecheck = false; // rechecks are scheduled

function recheckProAfterCheckout() {
  if (proCheckoutRecheck) return;
  proCheckoutRecheck = true;
  PRO_CHECKOUT_RECHECK_MS.forEach((ms, i) => setTimeout(() => {
    if (i === PRO_CHECKOUT_RECHECK_MS.length - 1) proCheckoutRecheck = false;
    if (!(proCache && proCache.isPro)) refreshProStatus();
  }, ms));
}

// Service worker start
refreshProStatus();

// --- Pro plans (cached) ---
// extpay.getPlans() asks extensionpay.com for the plans and their prices, so
// the normalized answer is cached in chrome.storage.local `plansCache`:
// { plans, fetchedAt }. A cache younger than PLANS_CACHE_TTL_MS answers with no
// request; an older one answers at once and is refreshed in the background. A
// failed refresh keeps the last cache; with none, the answer is no plans.
const PLANS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// After a failed request, the next one waits this long.
const PLANS_RETRY_MS = 5 * 60 * 1000;
// A cache of no plans (ExtPay answered none, e.g. while the plans are being
// edited in the ExtensionPay dashboard) is refreshed after this long instead.
const PLANS_EMPTY_TTL_MS = 5 * 60 * 1000;
// The plan picker asks with { fresh: true }: there a cache older than this is
// refreshed, so a price or plan changed in the ExtensionPay dashboard shows the
// first time the picker opens (the refreshed cache re-renders it). Not 0: that
// re-render asks again and must find the cache fresh.
const PLANS_PICKER_MAX_AGE_MS = 60 * 1000;
// With nothing cached, getPlans waits this long for ExtPay, then answers no
// plans; the late answer is still cached.
const PLANS_FIRST_WAIT_MS = 5000;
const PLAN_INTERVALS = ['month', 'year', 'once'];
// A plan nickname goes into ExtensionPay's checkout URL: plain names only.
const PLAN_NICKNAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Pure. ExtPay's getPlans() answer as [{ nickname, interval, unitAmountCents,
// currency }]. Dropped: a plan with no positive price, an interval other than
// month / year / once, a recurring plan billed every 2+ intervals (the picker
// shows prices per month and per year), or no 3-letter currency. A nickname
// that is not a plain name becomes null (its card opens ExtPay's own page).
function normalizePlans(raw) {
  if (!Array.isArray(raw)) return [];
  const plans = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    if (!Number.isFinite(p.unitAmountCents) || p.unitAmountCents <= 0) continue;
    if (!PLAN_INTERVALS.includes(p.interval)) continue;
    if (p.interval !== 'once' && p.intervalCount != null && p.intervalCount !== 1) continue;
    if (typeof p.currency !== 'string' || !/^[A-Za-z]{3}$/.test(p.currency)) continue;
    plans.push({
      nickname: typeof p.nickname === 'string' && PLAN_NICKNAME_RE.test(p.nickname) ? p.nickname : null,
      interval: p.interval,
      unitAmountCents: Math.round(p.unitAmountCents),
      currency: p.currency.toLowerCase()
    });
  }
  return plans;
}

// `cache` when it is a well-formed { plans, fetchedAt }, else null.
function validPlansCache(cache) {
  if (!cache || typeof cache !== 'object') return null;
  if (!Array.isArray(cache.plans) || !Number.isFinite(cache.fetchedAt)) return null;
  return cache;
}

// Pure. What getPlans does with `cache` at `now`; no request starts before
// `retryAt` (set after a failed one):
//   fresh cache -> { plans: cached, refresh: false, wait: false }
//   stale cache -> { plans: cached, refresh: true,  wait: false }  answer now, refresh in the background
//   no cache    -> { plans: [],     refresh: true,  wait: true }   wait for the first answer
// A cache is fresh for PLANS_CACHE_TTL_MS, PLANS_EMPTY_TTL_MS when it holds no
// plans, and never longer than `maxAgeMs` when that is given (the picker).
function plansCacheDecision(cache, now, retryAt, maxAgeMs) {
  const valid = validPlansCache(cache);
  const canRefresh = now >= (retryAt || 0);
  if (!valid) return { plans: [], refresh: canRefresh, wait: canRefresh };
  const age = now - valid.fetchedAt;
  let ttl = valid.plans.length ? PLANS_CACHE_TTL_MS : PLANS_EMPTY_TTL_MS;
  if (Number.isFinite(maxAgeMs)) ttl = Math.min(ttl, maxAgeMs);
  const fresh = age >= 0 && age < ttl;
  return { plans: valid.plans, refresh: !fresh && canRefresh, wait: false };
}

let plansRefresh = null;  // the request in flight (resolves to the new cache, or null)
let plansRetryAt = 0;     // no request before this time

// Asks ExtPay now (one request at a time) and caches the answer.
function refreshPlans() {
  if (!plansRefresh) {
    plansRefresh = (async () => {
      try {
        if (!extpay || typeof extpay.getPlans !== 'function') throw new Error('ExtensionPay is not available');
        const cache = { plans: normalizePlans(await extpay.getPlans()), fetchedAt: Date.now() };
        await chrome.storage.local.set({ plansCache: cache });
        return cache;
      } catch (e) {
        console.warn('CleanFeed: could not load the Pro plans, keeping the last known ones:', e);
        plansRetryAt = Date.now() + PLANS_RETRY_MS;
        return null;
      }
    })().finally(() => { plansRefresh = null; });
  }
  return plansRefresh;
}

// The plans for a page: the cached ones, refreshed in the background when
// stale (`forPicker`: the picker's stricter PLANS_PICKER_MAX_AGE_MS). Only
// with nothing cached does it wait (briefly) for ExtPay.
async function getPlans(forPicker) {
  let cache = null;
  try {
    cache = (await chrome.storage.local.get('plansCache')).plansCache;
  } catch (e) { /* treated as no cache */ }
  const decision = plansCacheDecision(cache, Date.now(), plansRetryAt, forPicker ? PLANS_PICKER_MAX_AGE_MS : undefined);
  if (!decision.refresh) return { plans: decision.plans };
  const refresh = refreshPlans();
  if (!decision.wait) return { plans: decision.plans };
  const fresh = await withTimeout(refresh, PLANS_FIRST_WAIT_MS, null);
  return { plans: fresh ? fresh.plans : [] };
}

// Opens the in-app plan picker (options.html#upgrade): an options tab that is
// open already is focused and shown the picker, else a new tab opens.
async function openPlanPicker() {
  const url = chrome.runtime.getURL('options.html#upgrade');
  const page = chrome.runtime.getURL('options.html');
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      const open = (contexts || []).find(c => Number.isInteger(c.tabId) && c.tabId >= 0 &&
        typeof c.documentUrl === 'string' && c.documentUrl.split(/[?#]/)[0] === page);
      if (open) {
        const tab = await chrome.tabs.update(open.tabId, { active: true, url });
        if (tab && chrome.windows && chrome.windows.update) await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
    }
  } catch (e) {
    // That tab closed meanwhile, or no access: open a new one
  }
  await chrome.tabs.create({ url });
}

// --- Install / Update ---

// Chrome runs content scripts only in pages loaded after CleanFeed is
// installed or updated, so YouTube tabs that are already open would get no
// filtering until reloaded. They get the manifest's YouTube CSS and scripts
// here, in manifest order (features.js first). After an update the old
// content script in such a tab is orphaned; the new one takes the page over
// (content.js). A tab that cannot be injected (discarded, an error page,
// closed meanwhile) is skipped: CleanFeed starts there on its next load.
async function injectIntoOpenYouTubeTabs() {
  const entry = (chrome.runtime.getManifest().content_scripts || [])
    .find(cs => (cs.matches || []).includes('*://*.youtube.com/*'));
  if (!entry) return;
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: entry.matches });
  } catch (e) {
    console.warn('CleanFeed: could not list the open YouTube tabs:', e);
    return;
  }
  await Promise.all(tabs.map(async (tab) => {
    const target = { tabId: tab.id };
    try {
      if (entry.css && entry.css.length > 0) await chrome.scripting.insertCSS({ target, files: entry.css });
      await chrome.scripting.executeScript({ target, files: entry.js });
    } catch (e) {
      // This tab only
    }
  }));
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await Storage.init();
  // Smart Decay hidden (features.js): no alarm; remove one an older version made.
  if (CF_FEATURES.smartDecay) chrome.alarms.create('smartDecay', { periodInMinutes: 24 * 60 });
  else chrome.alarms.clear('smartDecay');

  // Reset the curiosity prompt counter ONLY on first install. Previously this
  // also fired on every update, resurrecting the 3-prompt free teaser every
  // patch release — so paying-eligible users saw the upgrade nag forever.
  if (details && details.reason === 'install') {
    try {
      const onboarding = await Storage.getOnboarding();
      onboarding.interestPromptCount = 0;
      await chrome.storage.local.set({ onboarding });
    } catch (e) {
      console.warn('CleanFeed: failed to reset interest prompt count:', e);
    }
  }

  // Not on a Chrome update: the content scripts running then are still connected
  if (details && (details.reason === 'install' || details.reason === 'update')) {
    await injectIntoOpenYouTubeTabs();
  }
});

// --- Alarms ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'smartDecay') {
    if (!CF_FEATURES.smartDecay) return;
    const isPro = await checkProStatus();
    if (!isPro) return;

    const settings = await Storage.getSettings();
    if (settings.enableSmartDecay) {
      await Storage.performSmartDecay();
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  if (!CF_FEATURES.smartDecay) {
    chrome.alarms.clear('smartDecay');
    return;
  }
  chrome.alarms.get('smartDecay', (alarm) => {
    if (!alarm) {
      chrome.alarms.create('smartDecay', { periodInMinutes: 24 * 60 });
    }
  });
});

// --- Strict Mode lock ---
// While strict mode is on, a request that weakens filtering needs the right
// `strictPassword`, otherwise it is refused with { error: 'strict_locked' }.
// Adding blocks is never gated.

// Settings that hide content; turning one off weakens filtering.
const STRICT_HIDE_SETTINGS = ['hideShorts', 'hideComments', 'hideSubsRelevant'];

// Actions isWeakeningAction can call weakening, which strictModeRefusal
// checks (the others skip it). disableStrictMode is weakening too, but its
// handler checks its own `password`.
const STRICT_GUARDED_ACTIONS = new Set([
  'removeBlockedChannel', 'clearAllBlockedChannels', 'removeKeyword',
  'untagChannelForCategory', 'clearCategoryData', 'replaceCategoryTags',
  'toggleSynonym', 'removeCustomSynonym', 'whitelistChannel', 'updateSetting',
  'importAllData', 'setStrictPassword'
]);

// Storage the weakening checks compare a request against.
const STRICT_STATE_KEYS = [
  'settings', 'blockedChannels', 'blockedKeywords', 'customSynonyms', 'disabledSynonyms',
  'whitelistedChannels', 'categoryTags', 'categoryTagExclusions'
];

// Same meaning as the content script: hideSubsRelevant is on unless false.
function isHideSettingOn(key, value) {
  return key === 'hideSubsRelevant' ? value !== false : !!value;
}

function strictLower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

// Keys of { group: [item, ...] } as "group\nitem" (lowercase).
function strictPairs(map) {
  const out = new Set();
  if (!map || typeof map !== 'object') return out;
  for (const [group, items] of Object.entries(map)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) out.add(group.toLowerCase() + '\n' + strictLower(item));
  }
  return out;
}

// True when some value of `before` is not in `after` (both Sets).
function strictLosesAny(before, after) {
  for (const value of before) if (!after.has(value)) return true;
  return false;
}

function strictSetOf(list, keyOf) {
  return new Set((Array.isArray(list) ? list : []).map(item => keyOf(item || {})).filter(Boolean));
}

// True when importing `data` (an exported backup, applied like importAllData
// does) would weaken filtering compared with `current`: disable strict mode
// or change its password, turn a hide setting off, remove a blocked channel,
// keyword, custom synonym or auto-tag, or add a disabled synonym, whitelisted
// channel or untag exclusion.
function importWeakens(data, current) {
  if (!data || typeof data !== 'object') return false;
  if (data.settings && typeof data.settings === 'object') {
    const cur = current.settings || {};
    const next = { ...cur, ...data.settings };
    if (cur.strictModeEnabled &&
        (!next.strictModeEnabled || next.strictModePasswordHash !== cur.strictModePasswordHash)) return true;
    for (const key of STRICT_HIDE_SETTINGS) {
      if (isHideSettingOn(key, cur[key]) && !isHideSettingOn(key, next[key])) return true;
    }
  }
  if (Array.isArray(data.blockedChannels)) {
    if (strictLosesAny(strictSetOf(current.blockedChannels, ch => strictLower(ch.name)),
                       strictSetOf(data.blockedChannels, ch => strictLower(ch.name)))) return true;
    if (strictLosesAny(strictSetOf(current.blockedChannels, ch => strictLower(ch.id)),
                       strictSetOf(data.blockedChannels, ch => strictLower(ch.id)))) return true;
  }
  if (Array.isArray(data.blockedKeywords) &&
      strictLosesAny(strictSetOf(current.blockedKeywords, k => strictLower(k.keyword)),
                     strictSetOf(data.blockedKeywords, k => strictLower(k.keyword)))) return true;
  if (data.customSynonyms && typeof data.customSynonyms === 'object' &&
      strictLosesAny(strictPairs(current.customSynonyms), strictPairs(data.customSynonyms))) return true;
  if (Array.isArray(data.disabledSynonyms) &&
      strictLosesAny(new Set(data.disabledSynonyms.map(strictLower)),
                     new Set((current.disabledSynonyms || []).map(strictLower)))) return true;
  if (Array.isArray(data.whitelistedChannels)) {
    const keyOf = ch => strictLower(ch.name) + '\n' + strictLower(ch.exemptFrom);
    if (strictLosesAny(strictSetOf(data.whitelistedChannels, keyOf),
                       strictSetOf(current.whitelistedChannels, keyOf))) return true;
  }
  if (data.categoryTags && typeof data.categoryTags === 'object' &&
      strictLosesAny(strictPairs(current.categoryTags), strictPairs(data.categoryTags))) return true;
  if (data.categoryTagExclusions && typeof data.categoryTagExclusions === 'object' && !Array.isArray(data.categoryTagExclusions) &&
      strictLosesAny(strictPairs(data.categoryTagExclusions), strictPairs(current.categoryTagExclusions))) return true;
  return false;
}

// Strict Mode is Pro-only to turn on, and an import is another way to turn it
// on. For a user who is not Pro and has strict mode off, drops strictModeEnabled
// and strictModePasswordHash from the backup's `incoming` settings. `current`:
// the stored settings. With strict mode on already, or for Pro, the backup's
// settings pass as they are (importWeakens and strictModeRefusal guard those).
// Returns { settings: a copy to merge, dropped: true when the backup would have
// switched strict mode on }. Pure.
function importStrictGate(incoming, current, isPro) {
  if (isPro || (current && current.strictModeEnabled)) return { settings: incoming, dropped: false };
  const { strictModeEnabled, strictModePasswordHash, ...rest } = incoming;
  return { settings: rest, dropped: !!strictModeEnabled };
}

// True when `request` would weaken filtering. `current`: the stored state it
// changes ({ settings, blockedChannels, blockedKeywords, customSynonyms,
// disabledSynonyms, whitelistedChannels, categoryTags, categoryTagExclusions }).
// Pure: whether strict mode is on is checked by strictModeRefusal.
function isWeakeningAction(request, current) {
  const state = current || {};
  switch (request && request.action) {
    case 'removeBlockedChannel':
    case 'clearAllBlockedChannels':
    case 'removeKeyword':
    case 'untagChannelForCategory':
    case 'clearCategoryData':
    case 'removeCustomSynonym':
    case 'whitelistChannel':
    case 'disableStrictMode':
    case 'setStrictPassword': // while strict mode is on: replaces its password
      return true;
    case 'toggleSynonym': {
      // Storage.toggleSynonym re-enables a disabled synonym, else disables it
      const disabled = Array.isArray(state.disabledSynonyms) ? state.disabledSynonyms : [];
      return typeof request.synonym !== 'string' || !disabled.includes(request.synonym.toLowerCase());
    }
    case 'replaceCategoryTags':
      return strictLosesAny(strictPairs(state.categoryTags), strictPairs(request.tags || {}));
    case 'updateSetting':
      return STRICT_HIDE_SETTINGS.includes(request.key) && !isHideSettingOn(request.key, request.value);
    case 'importAllData':
      return importWeakens(request.data, state);
    default:
      return false;
  }
}

// Same check as verifyStrictPassword: with strict mode off or no password
// set, any password matches.
async function strictPasswordMatches(settings, password) {
  if (!settings.strictModeEnabled) return true;
  if (!settings.strictModePasswordHash) return true;
  const hash = await Storage.hashPassword(password || '');
  return hash === settings.strictModePasswordHash;
}

// Returns { error: 'strict_locked' } when strict mode is on and `request`
// weakens filtering without the right `strictPassword`, else null.
async function strictModeRefusal(request) {
  if (!request || !STRICT_GUARDED_ACTIONS.has(request.action)) return null;
  const current = await chrome.storage.local.get(STRICT_STATE_KEYS);
  const settings = current.settings || Storage.DEFAULTS.settings;
  if (!settings.strictModeEnabled) return null;
  if (!isWeakeningAction(request, current)) return null;
  if (await strictPasswordMatches(settings, request.strictPassword)) return null;
  return { error: 'strict_locked' };
}

// --- Message Handling ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // ExtPay's own messages: its listener (startBackground) answers them
  if (typeof request === 'string' && request.startsWith('extpay-')) {
    if (request === 'extpay-fetch-user') recheckProAfterCheckout();
    return;
  }

  handleMessage(request).then(sendResponse).catch(err => {
    console.error('CleanFeed:', err);
    sendResponse({ error: err.message });
  });
  return true;
});

// Only the cases that need Pro status ask for it (checkProStatus).
async function handleMessage(request) {
  const refusal = await strictModeRefusal(request);
  if (refusal) return refusal;

  switch (request.action) {
    // --- Channel Blocking ---
    case 'blockChannel': {
      return await Storage.addBlockedChannel(request.channelName, request.channelId);
    }

    case 'getBlockedChannelNames': {
      const names = await Storage.getBlockedChannelNames();
      return { blockedNames: [...names] };
    }

    case 'removeBlockedChannel': {
      await Storage.removeBlockedChannel(request.index);
      return { success: true };
    }

    case 'clearAllBlockedChannels': {
      await Storage.clearAllBlockedChannels();
      return { success: true };
    }

    // --- Keyword Blocking ---
    case 'addKeyword': {
      if (!(await checkProStatus())) {
        const keywords = await Storage.getBlockedKeywords();
        if (keywords.length >= Storage.FREE_KEYWORD_LIMIT) {
          return { success: false, reason: 'free_limit' };
        }
      }
      return await Storage.addBlockedKeyword(request.keyword);
    }

    case 'getBlockedKeywords': {
      const keywords = await Storage.getBlockedKeywords();
      return { keywords };
    }

    case 'removeKeyword': {
      // Capture the keyword name BEFORE removing so we can wipe its auto-tag data
      const keywords = await Storage.getBlockedKeywords();
      const target = keywords[request.index];
      await Storage.removeBlockedKeyword(request.index);
      if (target?.keyword) await Storage.clearCategoryData(target.keyword.toLowerCase());
      return { success: true };
    }

    // --- Category Auto-Tag ---
    // Body: hits = [["category::channelLower", [videoKey, ...]], ...]
    // One storage read and one write for the whole batch: a read + write per
    // hit timed out the service worker. Storage.recordCategoryHits counts each
    // video once and never re-tags a channel the user untagged.
    case 'batchIncrementCategoryHits': {
      const newlyTagged = await Storage.recordCategoryHits(request.hits);
      return { success: true, newlyTagged };
    }

    case 'untagChannelForCategory': {
      await Storage.untagChannelForCategory(request.category, request.channelName);
      return { success: true };
    }

    case 'clearCategoryData': {
      await Storage.clearCategoryData(request.category);
      return { success: true };
    }

    // Wholesale replace of categoryTags — used by the content script's
    // garbage-collection pass (removes entries created before the channel-name
    // validation was added). Also wipes matching categoryHits so the bad
    // channels can't re-create themselves the next time we filter.
    case 'replaceCategoryTags': {
      const newTags = request.tags || {};
      const oldHits = await Storage.getCategoryHits();

      // For each category, keep only hits whose channel survived in the new tags
      // OR whose channel name is still valid (i.e. legitimate sub-threshold hits)
      const newHits = {};
      for (const [cat, channelMap] of Object.entries(oldHits)) {
        if (!channelMap || typeof channelMap !== 'object') continue;
        const keepChannels = {};
        for (const [ch, count] of Object.entries(channelMap)) {
          // Tag-valid channel survives even at any count; otherwise it must
          // pass a basic sanity check.
          const tagHas = Array.isArray(newTags[cat]) && newTags[cat].includes(ch);
          const valid = ch && ch.length >= 2 && /[a-zA-ZÀ-ſ]/.test(ch);
          if (tagHas || valid) keepChannels[ch] = count;
        }
        if (Object.keys(keepChannels).length > 0) newHits[cat] = keepChannels;
      }
      await chrome.storage.local.set({ categoryTags: newTags, categoryHits: newHits });
      return { success: true };
    }

    // --- Bulk add (used by channel scan modal) ---
    // Takes [{ type: 'keyword'|'synonym', phrase, category? }] and applies
    // them in a SINGLE storage write per bucket. Sequential per-item calls
    // were taking ~30s with 15-20 selections because each one triggered a
    // storage.onChanged cascade (state refetch + filterPage + …).
    case 'bulkAddBlockingTerms': {
      const items = Array.isArray(request.items) ? request.items : [];
      let addedKw = 0, addedSyn = 0, skippedFree = 0, duplicates = 0;
      const isPro = await checkProStatus();

      const keywords = await Storage.getBlockedKeywords();
      const customs = await Storage.getCustomSynonyms();
      const existingKw = new Set(keywords.map(k => k.keyword.toLowerCase()));

      for (const item of items) {
        if (!item || !item.phrase) continue;
        const phrase = item.phrase.toLowerCase().trim();
        if (!phrase) continue;

        if (item.type === 'keyword') {
          if (existingKw.has(phrase)) { duplicates++; continue; }
          if (!isPro && keywords.length >= Storage.FREE_KEYWORD_LIMIT) {
            skippedFree++; continue;
          }
          keywords.push({ keyword: phrase, addedAt: Date.now() });
          existingKw.add(phrase);
          addedKw++;
        } else if (item.type === 'synonym' && item.category) {
          const cat = item.category;
          if (!customs[cat]) customs[cat] = [];
          if (customs[cat].includes(phrase)) { duplicates++; continue; }
          customs[cat].push(phrase);
          addedSyn++;
        }
      }

      // Single storage write covering BOTH buckets — one storage.onChanged
      // cascade total, not one per item.
      const writes = {};
      if (addedKw > 0) writes.blockedKeywords = keywords;
      if (addedSyn > 0) writes.customSynonyms = customs;
      if (Object.keys(writes).length > 0) {
        await chrome.storage.local.set(writes);
      }

      return { addedKw, addedSyn, skippedFree, duplicates };
    }

    // --- Preset Profiles ---
    // Bulk-add a curated set of category keys as blocked keywords in one
    // storage write. Categories already blocked are silently skipped.
    // On Free, a preset that would go past the cap adds nothing and reports
    // how many topics it adds against the free slots.
    case 'applyPreset': {
      const keys = Array.isArray(request.categoryKeys) ? request.categoryKeys : [];
      if (keys.length === 0) return { success: false, error: 'empty_preset' };

      const existing = await Storage.getBlockedKeywords();
      const existingSet = new Set(existing.map(k => k.keyword.toLowerCase()));
      const toAdd = keys.filter(k => !existingSet.has(k.toLowerCase()));

      // Check free limit
      const limit = Storage.FREE_KEYWORD_LIMIT;
      if (toAdd.length > 0 && existing.length + toAdd.length > limit && !(await checkProStatus())) {
        return { success: false, reason: 'free_limit', wouldAdd: toAdd.length, currentCount: existing.length, limit };
      }

      let added = 0;
      for (const k of toAdd) {
        existing.push({ keyword: k.toLowerCase(), addedAt: Date.now() });
        added++;
      }
      if (added > 0) await chrome.storage.local.set({ blockedKeywords: existing });
      return { success: true, added, alreadyBlocked: keys.length - added };
    }

    // --- Synonym Management ---
    case 'toggleSynonym': {
      return await Storage.toggleSynonym(request.synonym);
    }

    case 'getDisabledSynonyms': {
      const disabled = await Storage.getDisabledSynonyms();
      return { disabledSynonyms: disabled };
    }

    case 'addCustomSynonym': {
      return await Storage.addCustomSynonym(request.category, request.synonym);
    }

    case 'removeCustomSynonym': {
      await Storage.removeCustomSynonym(request.category, request.synonym);
      return { success: true };
    }

    // --- Subscription Exception ---
    case 'whitelistChannel': {
      if (!(await checkProStatus())) return { success: false, reason: 'pro_only' };
      await Storage.addWhitelistedChannel(request.name, request.id, request.exemptFrom);
      return { success: true };
    }

    case 'isChannelWhitelisted': {
      const result = await Storage.isChannelWhitelisted(request.channelName, request.keyword);
      return { whitelisted: result };
    }

    // --- Interest Boundaries ---
    case 'checkInterest': {
      // Interest Boundaries hidden (features.js): never prompt, never count.
      if (!CF_FEATURES.interestBoundaries) return { shouldPrompt: false };
      const isPro = await checkProStatus();
      const onboarding = await Storage.getOnboarding();

      const shouldCheck = isPro
        ? (await Storage.getSettings()).enableInterestBoundaries
        : onboarding.interestPromptCount < 3;

      if (!shouldCheck) return { shouldPrompt: false };

      const matches = await Storage.matchesExistingInterest(request.query);
      if (matches) return { shouldPrompt: false };

      const count = await Storage.incrementInterestPromptCount();
      return {
        shouldPrompt: true,
        query: request.query,
        isPro,
        promptCount: count,
        useInlineBanner: count <= 3
      };
    }

    case 'checkInterestMatch': {
      // Check if this EXACT query is already saved as an interest (not fuzzy match)
      const interests = await Storage.getInterests();
      const queryLower = request.query.toLowerCase().trim();
      let exactMatch = false;
      for (const [key, interest] of Object.entries(interests)) {
        if (interest.query && interest.query.toLowerCase().trim() === queryLower) {
          exactMatch = true;
          break;
        }
      }
      return { exactMatch };
    }

    case 'addInterest': {
      const key = await Storage.addInterest(request.query, request.expiresAt || null);
      return { success: true, key };
    }

    case 'removeInterest': {
      await Storage.removeInterest(request.key);
      return { success: true };
    }

    // --- Hidden Videos ---
    case 'logHiddenVideo': {
      await Storage.logHiddenVideo(request.title, request.channel, request.reason);
      return { success: true };
    }

    case 'removeHiddenVideo': {
      await Storage.removeHiddenVideo(request.index);
      return { success: true };
    }

    // --- Settings ---
    case 'getFullState': {
      const settings = await Storage.getSettings();
      const stats = await Storage.getStats();
      const blockedChannels = await Storage.getBlockedChannels();
      const blockedKeywords = await Storage.getBlockedKeywords();
      const whitelistedChannels = await Storage.getWhitelistedChannels();
      const disabledSynonyms = await Storage.getDisabledSynonyms();
      const customSynonyms = await Storage.getCustomSynonyms();
      const categoryTags = await Storage.getCategoryTags();
      const categoryTagExclusions = await Storage.getCategoryTagExclusions();
      const interests = await Storage.getInterests();
      const hiddenVideos = await Storage.getHiddenVideos();
      const onboarding = await Storage.getOnboarding();
      const isPro = await checkProStatus();

      return {
        settings, stats, blockedChannels, blockedKeywords,
        whitelistedChannels, disabledSynonyms, customSynonyms,
        categoryTags, categoryTagExclusions, interests, hiddenVideos, onboarding, isPro
      };
    }

    case 'updateSetting': {
      // Strict mode changes only through setStrictPassword / disableStrictMode
      if (request.key === 'strictModeEnabled' || request.key === 'strictModePasswordHash') {
        return { success: false, reason: 'not_allowed' };
      }
      await Storage.updateSetting(request.key, request.value);
      return { success: true };
    }

    case 'incrementStat': {
      await Storage.incrementStat(request.stat, request.amount || 1);
      return { success: true };
    }

    // --- Interest Prompt Reset ---
    case 'resetInterestPromptCount': {
      const onboarding = await Storage.getOnboarding();
      onboarding.interestPromptCount = 0;
      await chrome.storage.local.set({ onboarding });
      return { success: true };
    }

    // --- Daily Time Tracking ---
    case 'addTimeUsed': {
      // Daily time limit hidden (features.js): no tracking writes.
      if (!CF_FEATURES.dailyTimeLimit) return { success: false, reason: 'feature_hidden' };
      return await Storage.addTimeUsed(request.seconds);
    }

    case 'getTimeUsed': {
      const secs = await Storage.getTimeUsed();
      return { secondsUsed: secs };
    }

    // --- Payment ---
    // { fresh: true }: the plan picker's request (see PLANS_PICKER_MAX_AGE_MS)
    case 'getPlans': {
      return await getPlans(request.fresh === true);
    }

    // { plan: nickname } opens that plan's ExtensionPay checkout; { direct: true }
    // opens ExtensionPay's own page (the picker's "See plans" when no plans
    // loaded); anything else opens the in-app plan picker.
    case 'openPaymentPage': {
      const plan = typeof request.plan === 'string' && PLAN_NICKNAME_RE.test(request.plan) ? request.plan : null;
      try {
        if (plan || request.direct === true) {
          if (extpay) {
            Promise.resolve(plan ? extpay.openPaymentPage(plan) : extpay.openPaymentPage())
              .catch(e => console.warn('CleanFeed: payment page error:', e));
          } else {
            await chrome.tabs.create({ url: 'https://extensionpay.com' });
          }
        } else {
          await openPlanPicker();
        }
      } catch (e) {
        console.warn('CleanFeed: payment page error:', e);
      }
      return { success: true };
    }

    // --- Export / Import ---
    case 'exportAllData': {
      const blockedChannels = await Storage.getBlockedChannels();
      const blockedKeywords = await Storage.getBlockedKeywords();
      const customSynonyms = await Storage.getCustomSynonyms();
      const disabledSynonyms = await Storage.getDisabledSynonyms();
      const whitelistedChannels = await Storage.getWhitelistedChannels();
      const interests = await Storage.getInterests();
      const settings = await Storage.getSettings();
      const categoryTags = await Storage.getCategoryTags();
      const categoryTagExclusions = await Storage.getCategoryTagExclusions();
      return {
        cleanfeedVersion: chrome.runtime.getManifest().version,
        exportedAt: Date.now(),
        blockedChannels, blockedKeywords, customSynonyms, disabledSynonyms,
        whitelistedChannels, interests, settings, categoryTags, categoryTagExclusions
      };
    }

    case 'importAllData': {
      const data = request.data || {};
      // Validate top-level keys are objects/arrays as expected
      if (!data || typeof data !== 'object') return { success: false, error: 'invalid_format' };
      const updates = {};
      if (Array.isArray(data.blockedChannels)) updates.blockedChannels = data.blockedChannels;
      if (Array.isArray(data.blockedKeywords)) updates.blockedKeywords = data.blockedKeywords;
      if (data.customSynonyms && typeof data.customSynonyms === 'object') updates.customSynonyms = data.customSynonyms;
      if (Array.isArray(data.disabledSynonyms)) updates.disabledSynonyms = data.disabledSynonyms;
      if (Array.isArray(data.whitelistedChannels)) updates.whitelistedChannels = data.whitelistedChannels;
      if (data.interests && typeof data.interests === 'object') updates.interests = data.interests;
      let strictModeSkipped = false;
      if (data.settings && typeof data.settings === 'object') {
        // Merge incoming settings with existing defaults so missing fields don't break
        const cur = await Storage.getSettings();
        let incoming = data.settings;
        // A backup must not switch Strict Mode on for a user who is not Pro. Pro
        // status is only asked for when the backup carries strict-mode fields.
        if (!cur.strictModeEnabled && ('strictModeEnabled' in incoming || 'strictModePasswordHash' in incoming)) {
          const gate = importStrictGate(incoming, cur, await checkProStatus());
          incoming = gate.settings;
          strictModeSkipped = gate.dropped;
        }
        updates.settings = { ...cur, ...incoming };
      }
      if (data.categoryTags && typeof data.categoryTags === 'object') updates.categoryTags = data.categoryTags;
      if (data.categoryTagExclusions && typeof data.categoryTagExclusions === 'object' && !Array.isArray(data.categoryTagExclusions)) {
        updates.categoryTagExclusions = data.categoryTagExclusions;
      }
      await chrome.storage.local.set(updates);
      return strictModeSkipped
        ? { success: true, imported: Object.keys(updates), strictModeSkipped: true }
        : { success: true, imported: Object.keys(updates) };
    }

    // --- Strict Mode ---
    case 'verifyStrictPassword': {
      const settings = await Storage.getSettings();
      return { valid: await strictPasswordMatches(settings, request.password) };
    }

    // Turns strict mode on with this password. Enabling it is Pro-only; while
    // it is on, this replaces the password (strictModeRefusal asks for the
    // current one) and needs no Pro, nor does disabling it.
    case 'setStrictPassword': {
      const settings = await Storage.getSettings();
      if (!settings.strictModeEnabled && !(await checkProStatus())) return { error: 'pro_only' };
      const hash = await Storage.hashPassword(request.password || '');
      settings.strictModePasswordHash = hash;
      settings.strictModeEnabled = true;
      await chrome.storage.local.set({ settings });
      return { success: true };
    }

    case 'disableStrictMode': {
      const settings = await Storage.getSettings();
      if (settings.strictModeEnabled && settings.strictModePasswordHash) {
        const submittedHash = await Storage.hashPassword(request.password || '');
        if (submittedHash !== settings.strictModePasswordHash) return { success: false, reason: 'wrong_password' };
      }
      settings.strictModeEnabled = false;
      settings.strictModePasswordHash = '';
      await chrome.storage.local.set({ settings });
      return { success: true };
    }

    default:
      return { error: 'Unknown action: ' + request.action };
  }
}
