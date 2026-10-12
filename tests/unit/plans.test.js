'use strict';
// Pro plans: prices from ExtensionPay, the plan picker and the upgrade routing.
//   - cfBuildPlanCards(plans, uiLang, today) (content-dom.js): Monthly /
//     Yearly / Lifetime view-models from ExtensionPay plans. Prices formatted
//     with Intl for the UI language; the yearly per-month price is rounded UP
//     to the cent and the saving DOWN; "Best value" only when the yearly
//     per-month price is below the monthly one; the lifetime launch note only
//     through 2026-12-31 (local date). Plans without a positive price are ignored.
//   - cfPlansLine(cards, getMessage): the popup's line under "Upgrade to Pro".
//   - cfPlansCurrencyToNote(cards, uiLang): the currency a "Prices in ..." note
//     names, or null when the UI language's readers pay in it already.
//   - cfCreatePlansLoader(getMessage, onCards, options): the one copy of the
//     pages' plans loader (popup.js and options.js): getPlans -> cards ->
//     onCards; a load() while one is in flight asks exactly once more after
//     it; a failed request is logged and renders no plans; { fresh: true }
//     (options.js, the picker) asks getPlans { fresh: true }.
//   - background.js getPlans: ExtPay getPlans() normalized and cached in
//     chrome.storage.local `plansCache` ({ plans, fetchedAt }) for 24 h (5 min
//     when it holds no plans; 1 min for the picker's { fresh: true }); a stale
//     cache answers at once and refreshes in the background; a failure keeps
//     the last cache (or answers no plans).
//   - background.js openPaymentPage: { plan } opens that plan's ExtensionPay
//     checkout, { direct: true } ExtensionPay's own page, and no plan the
//     in-app picker options.html#upgrade (an open options tab is reused).

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');
const loadBackground = require('./load-background');

const ROOT = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const LOCALES = {
  en: JSON.parse(read('_locales/en/messages.json')),
  it: JSON.parse(read('_locales/it/messages.json'))
};
const plain = loadContentDom.plain;

const PLANNED = [
  { nickname: 'monthly', interval: 'month', unitAmountCents: 299, currency: 'usd' },
  { nickname: 'yearly', interval: 'year', unitAmountCents: 1999, currency: 'usd' },
  { nickname: 'lifetime', interval: 'once', unitAmountCents: 2999, currency: 'usd' }
];
// What ExtensionPay answers today (2026-10-12): no lifetime plan yet
const LIVE = [
  { unitAmountCents: 399, currency: 'usd', nickname: 'monthly', interval: 'month', intervalCount: 1 },
  { unitAmountCents: 2999, currency: 'usd', nickname: 'yearly', interval: 'year', intervalCount: 1 }
];

function cardsOf(plans, lang, today) {
  const cf = loadContentDom();
  assert.strictEqual(typeof cf.cfBuildPlanCards, 'function', 'content-dom.js defines cfBuildPlanCards');
  return plain(cf.cfBuildPlanCards(plans, lang, today || '2026-10-12'));
}
const byKind = cards => Object.fromEntries(cards.map(c => [c.kind, c]));

// --- cfBuildPlanCards ---

test('cfBuildPlanCards: monthly $2.99, yearly $1.67/mo saving 44% (Best value), lifetime $29.99, in English', () => {
  const cards = cardsOf(PLANNED, 'en');
  assert.deepStrictEqual(cards.map(c => c.kind), ['monthly', 'yearly', 'lifetime']);
  const { monthly, yearly, lifetime } = byKind(cards);
  assert.strictEqual(monthly.price, '$2.99');
  assert.strictEqual(monthly.nickname, 'monthly');
  assert.strictEqual(yearly.price, '$19.99');
  assert.strictEqual(yearly.perMonth, '$1.67', '19.99 / 12 = 1.6658, rounded up');
  assert.strictEqual(yearly.savePercent, 44, '1 - 19.99 / 35.88 = 44.28%, rounded down');
  assert.strictEqual(yearly.bestValue, true);
  assert.strictEqual(yearly.nickname, 'yearly');
  assert.strictEqual(lifetime.price, '$29.99');
  assert.strictEqual(lifetime.nickname, 'lifetime');
  for (const c of cards) assert.strictEqual(c.currency, 'USD', c.kind);
  assert.ok(!('bestValue' in monthly) || monthly.bestValue === false, 'only yearly can be Best value');
});

test('cfBuildPlanCards: the lifetime launch note shows through 2026-12-31 (local date), not after', () => {
  assert.strictEqual(byKind(cardsOf(PLANNED, 'en', '2026-12-31')).lifetime.launchNote, true);
  assert.strictEqual(byKind(cardsOf(PLANNED, 'en', '2027-01-01')).lifetime.launchNote, false);
  // A Date is read as a local calendar date
  assert.strictEqual(byKind(cardsOf(PLANNED, 'en', new Date(2026, 11, 31, 23, 59))).lifetime.launchNote, true);
  assert.strictEqual(byKind(cardsOf(PLANNED, 'en', new Date(2027, 0, 1, 0, 1))).lifetime.launchNote, false);
  const lifetime = byKind(cardsOf(PLANNED, 'en', '2026-10-12')).lifetime;
  assert.ok(/December 31, 2026/.test(lifetime.launchEnds), lifetime.launchEnds);
  assert.ok(/31 dicembre 2026/.test(byKind(cardsOf(PLANNED, 'it')).lifetime.launchEnds));
});

test('cfBuildPlanCards: Italian formats with a comma and "USD"', () => {
  const { monthly, yearly, lifetime } = byKind(cardsOf(PLANNED, 'it'));
  for (const text of [monthly.price, yearly.perMonth, yearly.price, lifetime.price]) {
    assert.ok(text.includes('USD'), text);
    assert.ok(!text.includes('$') && !text.includes('€'), text);
  }
  assert.ok(monthly.price.includes('2,99'), monthly.price);
  assert.ok(yearly.perMonth.includes('1,67'), yearly.perMonth);
});

test('cfBuildPlanCards: yearly only has no saving and no Best value', () => {
  const cards = cardsOf([PLANNED[1]], 'en');
  assert.deepStrictEqual(cards.map(c => c.kind), ['yearly']);
  assert.strictEqual(cards[0].perMonth, '$1.67');
  assert.strictEqual(cards[0].savePercent, null);
  assert.strictEqual(cards[0].bestValue, false);
});

test('cfBuildPlanCards: the live plans (monthly 3.99, yearly 29.99) give no lifetime card and save 37%', () => {
  const cards = cardsOf(LIVE, 'en');
  assert.deepStrictEqual(cards.map(c => c.kind), ['monthly', 'yearly']);
  const { monthly, yearly } = byKind(cards);
  assert.strictEqual(monthly.price, '$3.99');
  assert.strictEqual(yearly.perMonth, '$2.50', '29.99 / 12 = 2.4992, rounded up');
  assert.strictEqual(yearly.savePercent, 37, '1 - 29.99 / 47.88 = 37.36%, rounded down');
  assert.strictEqual(yearly.bestValue, true);
});

test('cfBuildPlanCards: a plan with no price, or price 0, is dropped', () => {
  const plans = [
    { nickname: 'monthly', interval: 'month', unitAmountCents: 0, currency: 'usd' },
    { nickname: 'yearly', interval: 'year', currency: 'usd' },
    { nickname: 'lifetime', interval: 'once', unitAmountCents: 2999, currency: 'usd' }
  ];
  assert.deepStrictEqual(cardsOf(plans, 'en').map(c => c.kind), ['lifetime']);
  assert.deepStrictEqual(cardsOf([], 'en'), []);
  assert.deepStrictEqual(cardsOf(null, 'en'), []);
});

test('cfBuildPlanCards: plans sharing an interval prefer the nickname monthly / yearly / lifetime', () => {
  const plans = [
    { nickname: 'promo_month', interval: 'month', unitAmountCents: 199, currency: 'usd' },
    { nickname: 'monthly', interval: 'month', unitAmountCents: 299, currency: 'usd' },
    { nickname: 'other_year', interval: 'year', unitAmountCents: 999, currency: 'usd' },
    { nickname: 'founder', interval: 'once', unitAmountCents: 4999, currency: 'usd' }
  ];
  const { monthly, yearly, lifetime } = byKind(cardsOf(plans, 'en'));
  assert.strictEqual(monthly.nickname, 'monthly');
  assert.strictEqual(yearly.nickname, 'other_year', 'the only yearly plan');
  assert.strictEqual(lifetime.nickname, 'founder', 'the only one-time plan');
});

test('cfBuildPlanCards: no Best value and no saving when yearly costs as much as monthly or more', () => {
  const same = byKind(cardsOf([
    { nickname: 'monthly', interval: 'month', unitAmountCents: 299, currency: 'usd' },
    { nickname: 'yearly', interval: 'year', unitAmountCents: 3588, currency: 'usd' }
  ], 'en')).yearly;
  assert.strictEqual(same.bestValue, false);
  assert.strictEqual(same.savePercent, null);
  const dearer = byKind(cardsOf([
    { nickname: 'monthly', interval: 'month', unitAmountCents: 299, currency: 'usd' },
    { nickname: 'yearly', interval: 'year', unitAmountCents: 3999, currency: 'usd' }
  ], 'en')).yearly;
  assert.strictEqual(dearer.bestValue, false);
  assert.strictEqual(dearer.savePercent, null);
});

test('cfBuildPlanCards: the saving is computed in whole cents (no float rounding down a whole percent)', () => {
  // 1 - 2556 / 3600 = 29% exactly; (1 - 0.71) * 100 in floats is 28.999...
  const yearly = byKind(cardsOf([
    { nickname: 'monthly', interval: 'month', unitAmountCents: 300, currency: 'usd' },
    { nickname: 'yearly', interval: 'year', unitAmountCents: 2556, currency: 'usd' }
  ], 'en')).yearly;
  assert.strictEqual(yearly.savePercent, 29);
});

// --- cfPlansLine and the currency note ---

function lineOf(plans, lang) {
  const cf = loadContentDom();
  assert.strictEqual(typeof cf.cfPlansLine, 'function', 'content-dom.js defines cfPlansLine');
  const cards = cf.cfBuildPlanCards(plans, lang, '2026-10-12');
  // Intl puts a no-break space between an Italian amount and "USD"
  return cf.cfPlansLine(cards, (key, subs) => cf.cfFormatMessage(LOCALES[lang][key], subs)).replace(/[  ]/g, ' ');
}

test('cfPlansLine: "$1.67/mo billed yearly · or $2.99 monthly" (en) and the Italian equivalent', () => {
  assert.strictEqual(lineOf(PLANNED.slice(0, 2), 'en'), '$1.67/mo billed yearly · or $2.99 monthly');
  assert.strictEqual(lineOf(PLANNED.slice(0, 2), 'it'), "1,67 USD/mese con l'annuale · o 2,99 USD al mese");
  assert.strictEqual(lineOf(PLANNED, 'en'), '$1.67/mo billed yearly · or $2.99 monthly', 'at most two plans');
  assert.strictEqual(lineOf(LIVE, 'en'), '$2.50/mo billed yearly · or $3.99 monthly');
  assert.strictEqual(lineOf([PLANNED[2]], 'en'), '$29.99 once');
  assert.strictEqual(lineOf([], 'en'), '', 'no plans: no line');
});

test('cfPlansCurrencyToNote: USD is noted in English and Italian, EUR not in Italian', () => {
  const cf = loadContentDom();
  assert.strictEqual(typeof cf.cfPlansCurrencyToNote, 'function', 'content-dom.js defines cfPlansCurrencyToNote');
  const note = (plans, lang) => cf.cfPlansCurrencyToNote(cf.cfBuildPlanCards(plans, lang, '2026-10-12'), lang);
  assert.strictEqual(note(PLANNED, 'en'), 'USD');
  assert.strictEqual(note(PLANNED, 'it'), 'USD');
  const eur = PLANNED.map(p => Object.assign({}, p, { currency: 'eur' }));
  assert.strictEqual(note(eur, 'it'), null);
  assert.strictEqual(note(eur, 'en'), 'EUR');
  assert.strictEqual(note([], 'en'), null);
  const f = (lang, subs) => cf.cfFormatMessage(LOCALES[lang].planCurrencyNote, subs);
  assert.strictEqual(f('en', ['USD']), 'Prices in USD.');
  assert.strictEqual(f('it', ['USD']), 'Prezzi in USD; la tua banca converte in euro.');
});

test('cfUiLocale: the locale of the shown messages, "en" when unknown', () => {
  const cf = loadContentDom();
  assert.strictEqual(cf.cfUiLocale(key => cf.cfFormatMessage(LOCALES.en[key])), 'en');
  assert.strictEqual(cf.cfUiLocale(key => cf.cfFormatMessage(LOCALES.it[key])), 'it');
  assert.strictEqual(cf.cfUiLocale(key => key), 'en', 'a missing message returns its key');
});

// --- cfCreatePlansLoader: the popup's and the options page's plans loader ---

const flush = () => new Promise(resolve => setImmediate(resolve));

// content-dom.js in a vm with a fake background: every getPlans request waits
// until the test answers it (requests[i].resolve / reject). `lang` is what the
// page's message helper says for uiLocale.
function plansLoaderPage(lang, options) {
  const requests = [];
  const warnings = [];
  const rendered = [];
  const cf = loadContentDom({
    chrome: {
      runtime: {
        sendMessage(request) {
          return new Promise((resolve, reject) => requests.push({ request: plain(request), resolve, reject }));
        }
      }
    },
    console: Object.assign(Object.create(console), { warn: (...args) => warnings.push(args.map(String).join(' ')) })
  });
  assert.strictEqual(typeof cf.cfCreatePlansLoader, 'function', 'content-dom.js defines cfCreatePlansLoader');
  const getMessage = key => (key === 'uiLocale' ? (lang || 'en') : key);
  const loader = cf.cfCreatePlansLoader(getMessage, cards => rendered.push(plain(cards)), options);
  return { loader, requests, warnings, rendered };
}

test('cfCreatePlansLoader: load() asks getPlans once, builds the cards and hands them to onCards', async () => {
  const page = plansLoaderPage('en');
  assert.strictEqual(page.loader.cards(), null, 'no cards before the first answer');
  const done = page.loader.load();
  assert.deepStrictEqual(page.requests.map(r => r.request), [{ action: 'getPlans' }]);
  page.requests[0].resolve({ plans: PLANNED });
  await done;
  await flush();
  assert.strictEqual(page.requests.length, 1, 'no follow-up request without a second load()');
  assert.deepStrictEqual(page.rendered.map(cards => cards.map(c => c.price)), [['$2.99', '$19.99', '$29.99']]);
  assert.deepStrictEqual(plain(page.loader.cards()), page.rendered[0]);
  assert.deepStrictEqual(page.warnings, []);
});

test('cfCreatePlansLoader: a load() while one is in flight causes exactly one follow-up request', async () => {
  const page = plansLoaderPage('en');
  const first = page.loader.load();
  const second = page.loader.load();
  page.loader.load(); // a third one while the first is still in flight
  assert.strictEqual(second, first, 'a load() in flight is shared');
  assert.strictEqual(page.requests.length, 1, 'no second request while one is in flight');

  page.requests[0].resolve({ plans: LIVE });
  await first;
  await flush();
  assert.strictEqual(page.requests.length, 2, 'exactly one follow-up request once the first answers');
  assert.deepStrictEqual(page.requests[1].request, { action: 'getPlans' });

  page.requests[1].resolve({ plans: PLANNED });
  await flush();
  assert.strictEqual(page.requests.length, 2, 'the follow-up asks no further');
  assert.deepStrictEqual(page.rendered.map(cards => cards.map(c => c.price)), [
    ['$3.99', '$29.99'],
    ['$2.99', '$19.99', '$29.99']
  ], 'onCards ran for each answer, the newer plans last');
  assert.deepStrictEqual(plain(page.loader.cards()).map(c => c.kind), ['monthly', 'yearly', 'lifetime']);

  page.loader.load();
  assert.strictEqual(page.requests.length, 3, 'a load() after both answered asks again');
});

test('cfCreatePlansLoader: a failed getPlans is logged and renders no plans', async () => {
  const page = plansLoaderPage('en');
  const done = page.loader.load();
  page.requests[0].reject(new Error('Could not establish connection. Receiving end does not exist.'));
  await done;
  assert.deepStrictEqual(page.rendered, [[]]);
  assert.deepStrictEqual(plain(page.loader.cards()), []);
  assert.strictEqual(page.warnings.length, 1, 'one console.warn');
  assert.match(page.warnings[0], /CleanFeed: could not load the Pro plans/);
  assert.match(page.warnings[0], /Could not establish connection/);

  // An answer with no plans list is no plans, and not an error
  const again = page.loader.load();
  page.requests[1].resolve(undefined);
  await again;
  assert.deepStrictEqual(page.rendered, [[], []]);
  assert.strictEqual(page.warnings.length, 1);
});

test('cfCreatePlansLoader: prices are formatted for the page\'s own UI locale', async () => {
  const page = plansLoaderPage('it');
  const done = page.loader.load();
  page.requests[0].resolve({ plans: PLANNED });
  await done;
  const monthly = page.rendered[0].find(c => c.kind === 'monthly');
  assert.ok(monthly.price.includes('2,99') && monthly.price.includes('USD'), monthly.price);
});

test('cfCreatePlansLoader { fresh: true } asks getPlans { fresh: true }, its follow-up too', async () => {
  const page = plansLoaderPage('en', { fresh: true });
  const first = page.loader.load();
  page.loader.load();
  assert.deepStrictEqual(page.requests.map(r => r.request), [{ action: 'getPlans', fresh: true }]);
  page.requests[0].resolve({ plans: LIVE });
  await first;
  await flush();
  assert.deepStrictEqual(page.requests.map(r => r.request), [{ action: 'getPlans', fresh: true }, { action: 'getPlans', fresh: true }]);
  page.requests[1].resolve({ plans: PLANNED });
  await flush();
  assert.deepStrictEqual(plain(page.loader.cards()).map(c => c.price), ['$2.99', '$19.99', '$29.99']);
});

test('the options page\'s picker loads fresh plans; the popup\'s line uses the cache', () => {
  assert.ok(/cfCreatePlansLoader\([^)]*\{\s*fresh:\s*true\s*\}\s*\)/.test(read('options.js')), 'options.js passes { fresh: true }');
  assert.ok(/cfCreatePlansLoader\(cfMsg, renderPlansLine\)/.test(read('popup.js')), 'popup.js keeps the 24 h cache');
});

test('popup.js and options.js keep no copy of the plans loader', () => {
  for (const file of ['popup.js', 'options.js']) {
    const src = read(file).replace(/\/\/.*$/gm, ''); // code only, not comments
    assert.ok(/cfCreatePlansLoader\(/.test(src), `${file} does not use cfCreatePlansLoader`);
    assert.ok(!/action:\s*'getPlans'/.test(src), `${file} still asks getPlans itself`);
    assert.ok(!/cfBuildPlanCards\(/.test(src), `${file} still builds the plan cards itself`);
    assert.ok(!/^(?:let|var)\s+(?:planCards|plansLoading|plansReload)\b/m.test(src), `${file} still keeps loader state of its own`);
  }
});

// --- locales ---

test('upgradeToPro carries no price in either language', () => {
  assert.strictEqual(LOCALES.en.upgradeToPro.message, 'Upgrade to Pro');
  assert.strictEqual(LOCALES.it.upgradeToPro.message, 'Passa a Pro');
});

test('no hard-coded price in _locales (prices come from ExtensionPay)', () => {
  for (const [lang, messages] of Object.entries(LOCALES)) {
    for (const [key, entry] of Object.entries(messages)) {
      assert.ok(!/\d+[.,]\d{2}\b/.test(entry.message), `${lang}.${key}: "${entry.message}"`);
      assert.ok(!/€|\$\$\d/.test(entry.message), `${lang}.${key}: "${entry.message}"`);
    }
  }
});

test('every plan-picker message exists in en and it', () => {
  const keys = ['uiLocale', 'planPickerTitle', 'planMonthly', 'planYearly', 'planLifetime', 'planBestValue',
    'planPerMonth', 'planBilledMonthly', 'planBilledYearly', 'planBilledYearlySave', 'planOnce', 'planOneTimeNote',
    'planLaunchNote', 'planCurrencyNote', 'planStayFree', 'planChoose', 'planSeePlans', 'planYoureProTitle',
    'planLineYearly', 'planLineMonthly', 'planLineOr'];
  for (const lang of ['en', 'it']) {
    for (const key of keys) assert.ok(LOCALES[lang][key] && LOCALES[lang][key].message, `${lang}.${key}`);
  }
  const cf = loadContentDom();
  const f = (lang, key, subs) => cf.cfFormatMessage(LOCALES[lang][key], subs);
  assert.strictEqual(f('en', 'planBilledYearlySave', ['$19.99', '44']), 'Billed $19.99 yearly — save 44%');
  assert.strictEqual(f('it', 'planBilledYearlySave', ['19,99 USD', '44']), "19,99 USD addebitati una volta l'anno — risparmi il 44%");
  assert.strictEqual(f('en', 'planStayFree'), 'Channel blocking and hiding Shorts & comments stay free.');
  assert.strictEqual(f('en', 'planPerMonth', ['$2.99']), '$2.99/mo');
  assert.strictEqual(f('en', 'planLaunchNote', ['December 31, 2026']), 'Launch price until December 31, 2026.');
  for (const lang of ['en', 'it']) {
    assert.ok(!/most popular|più popolare/i.test(JSON.stringify(LOCALES[lang])), lang + ': never "Most popular"');
  }
});

// --- cfIsProBookkeepingOnly: a plans cache refresh re-filters nothing ---

test('cfIsProBookkeepingOnly: a plansCache write alone is bookkeeping', () => {
  const cf = loadContentDom();
  assert.strictEqual(cf.cfIsProBookkeepingOnly({ plansCache: { newValue: { plans: [], fetchedAt: 1 } } }), true);
  assert.strictEqual(cf.cfIsProBookkeepingOnly({ plansCache: { newValue: { plans: [], fetchedAt: 1 } }, settings: {} }), false);
});

// --- background: getPlans and its cache ---

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const settle = () => new Promise(resolve => setImmediate(resolve));
const quiet = () => Object.assign(Object.create(console), { warn() {} });

function clock(start) {
  let now = start;
  return { now: () => now, advance(ms) { now += ms; } };
}

test('normalizePlans: keeps { nickname, interval, unitAmountCents, currency }; drops no/zero price and multi-interval plans', () => {
  const bg = loadBackground({});
  assert.strictEqual(typeof bg.sandbox.normalizePlans, 'function', 'background.js defines normalizePlans');
  const out = JSON.parse(JSON.stringify(bg.sandbox.normalizePlans([
    ...LIVE,
    { unitAmountCents: 0, currency: 'usd', nickname: 'free', interval: 'month', intervalCount: 1 },
    { currency: 'usd', nickname: 'noprice', interval: 'year', intervalCount: 1 },
    { unitAmountCents: 999, currency: 'usd', nickname: 'quarterly', interval: 'month', intervalCount: 3 },
    { unitAmountCents: 2999, currency: 'USD', nickname: 'lifetime', interval: 'once', intervalCount: null },
    { unitAmountCents: 500, currency: 'usd', nickname: null, interval: 'month', intervalCount: 1 },
    null, 'x'
  ])));
  assert.deepStrictEqual(out, [
    { nickname: 'monthly', interval: 'month', unitAmountCents: 399, currency: 'usd' },
    { nickname: 'yearly', interval: 'year', unitAmountCents: 2999, currency: 'usd' },
    { nickname: 'lifetime', interval: 'once', unitAmountCents: 2999, currency: 'usd' },
    { nickname: null, interval: 'month', unitAmountCents: 500, currency: 'usd' }
  ]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bg.sandbox.normalizePlans('nope'))), []);
});

test('getPlans: no cache -> asks ExtPay once, caches { plans, fetchedAt } and answers the normalized plans', async () => {
  const c = clock(T0);
  const bg = loadBackground({}, { now: c.now, getPlans: async () => LIVE });
  const res = await bg.handleMessage({ action: 'getPlans' });
  assert.strictEqual(bg.getPlansCalls(), 1);
  assert.deepStrictEqual(res.plans.map(p => p.nickname), ['monthly', 'yearly']);
  assert.deepStrictEqual(Object.keys(res.plans[0]).sort(), ['currency', 'interval', 'nickname', 'unitAmountCents']);
  assert.deepStrictEqual(bg.storage().plansCache, { plans: res.plans, fetchedAt: T0 });
});

test('getPlans: a fresh cache (under 24 h) answers with no request', async () => {
  const c = clock(T0);
  const cached = { plans: [{ nickname: 'monthly', interval: 'month', unitAmountCents: 299, currency: 'usd' }], fetchedAt: T0 - 23 * HOUR };
  const bg = loadBackground({ plansCache: cached }, { now: c.now, getPlans: async () => LIVE });
  const res = await bg.handleMessage({ action: 'getPlans' });
  await settle();
  assert.strictEqual(bg.getPlansCalls(), 0);
  assert.deepStrictEqual(res.plans, cached.plans);
  assert.deepStrictEqual(bg.storage().plansCache, cached);
});

test('getPlans: a stale cache answers at once and is refreshed in the background', async () => {
  const c = clock(T0);
  const cached = { plans: [{ nickname: 'monthly', interval: 'month', unitAmountCents: 299, currency: 'usd' }], fetchedAt: T0 - 25 * HOUR };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const bg = loadBackground({ plansCache: cached }, { now: c.now, getPlans: () => gate.then(() => LIVE) });
  const res = await bg.handleMessage({ action: 'getPlans' });
  assert.deepStrictEqual(res.plans, cached.plans, 'the cached plans, without waiting for ExtPay');
  assert.strictEqual(bg.getPlansCalls(), 1, 'a refresh started');
  release();
  for (let i = 0; i < 5; i++) await settle();
  assert.deepStrictEqual(bg.storage().plansCache.plans.map(p => p.unitAmountCents), [399, 2999]);
  assert.strictEqual(bg.storage().plansCache.fetchedAt, T0);
  const again = await bg.handleMessage({ action: 'getPlans' });
  assert.deepStrictEqual(again.plans.map(p => p.unitAmountCents), [399, 2999]);
  assert.strictEqual(bg.getPlansCalls(), 1, 'fresh now: no second request');
});

test('getPlans: a failed refresh keeps the last cache; with none it answers no plans', async () => {
  const c = clock(T0);
  const cached = { plans: [{ nickname: 'yearly', interval: 'year', unitAmountCents: 1999, currency: 'usd' }], fetchedAt: T0 - 48 * HOUR };
  const failing = async () => { throw 'ExtPay: HTTP error while getting plans. Received http code: 500'; };
  const bg = loadBackground({ plansCache: cached }, { now: c.now, getPlans: failing, console: quiet() });
  const res = await bg.handleMessage({ action: 'getPlans' });
  for (let i = 0; i < 5; i++) await settle();
  assert.deepStrictEqual(res.plans, cached.plans);
  assert.deepStrictEqual(bg.storage().plansCache, cached, 'the failure did not overwrite the cache');

  const empty = loadBackground({}, { now: c.now, getPlans: failing, console: quiet() });
  assert.deepStrictEqual(await empty.handleMessage({ action: 'getPlans' }), { plans: [] });
  assert.strictEqual(empty.storage().plansCache, undefined);
  // No new request on every popup open right after a failure
  await empty.handleMessage({ action: 'getPlans' });
  assert.strictEqual(empty.getPlansCalls(), 1);
  c.advance(10 * 60 * 1000);
  await empty.handleMessage({ action: 'getPlans' });
  assert.strictEqual(empty.getPlansCalls(), 2, 'asked again after the retry delay');
});

test('getPlans { fresh: true } (the picker): a cache over a minute old answers at once and is refreshed', async () => {
  const c = clock(T0);
  // What the dashboard sold until a minute and a half ago
  const cached = { plans: [{ nickname: 'monthly', interval: 'month', unitAmountCents: 399, currency: 'usd' }], fetchedAt: T0 - 90 * 1000 };
  const bg = loadBackground({ plansCache: cached }, { now: c.now, getPlans: async () => PLANNED });

  const plainReq = await bg.handleMessage({ action: 'getPlans' });
  await settle();
  assert.deepStrictEqual(plainReq.plans, cached.plans);
  assert.strictEqual(bg.getPlansCalls(), 0, 'without fresh the 24 h cache answers alone');

  const res = await bg.handleMessage({ action: 'getPlans', fresh: true });
  assert.deepStrictEqual(res.plans, cached.plans, 'the cached plans, without waiting for ExtPay');
  assert.strictEqual(bg.getPlansCalls(), 1, 'a refresh started');
  for (let i = 0; i < 5; i++) await settle();
  assert.deepStrictEqual(bg.storage().plansCache, { plans: JSON.parse(JSON.stringify(PLANNED)), fetchedAt: T0 });

  // The refreshed cache re-renders the picker, which asks again: no loop
  const again = await bg.handleMessage({ action: 'getPlans', fresh: true });
  await settle();
  assert.deepStrictEqual(again.plans.map(p => p.unitAmountCents), [299, 1999, 2999]);
  assert.strictEqual(bg.getPlansCalls(), 1, 'a cache under a minute old answers alone');
  c.advance(59 * 1000);
  await bg.handleMessage({ action: 'getPlans', fresh: true });
  await settle();
  assert.strictEqual(bg.getPlansCalls(), 1);
  c.advance(2 * 1000);
  await bg.handleMessage({ action: 'getPlans', fresh: true });
  await settle();
  assert.strictEqual(bg.getPlansCalls(), 2, 'over a minute old: refreshed again');
});

test('getPlans: a cache of no plans is refreshed after 5 minutes, not 24 h', async () => {
  const c = clock(T0);
  const empty = { plans: [], fetchedAt: T0 - 4 * 60 * 1000 };
  const bg = loadBackground({ plansCache: empty }, { now: c.now, getPlans: async () => LIVE });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'getPlans' }), { plans: [] });
  await settle();
  assert.strictEqual(bg.getPlansCalls(), 0, 'under 5 minutes: no request');
  c.advance(2 * 60 * 1000);
  assert.deepStrictEqual(await bg.handleMessage({ action: 'getPlans' }), { plans: [] }, 'answers at once');
  assert.strictEqual(bg.getPlansCalls(), 1, 'over 5 minutes: refreshed');
  for (let i = 0; i < 5; i++) await settle();
  assert.deepStrictEqual(bg.storage().plansCache.plans.map(p => p.nickname), ['monthly', 'yearly']);
});

test('getPlans { fresh: true } after a failure waits the retry delay like any request', async () => {
  const c = clock(T0);
  const cached = { plans: [{ nickname: 'yearly', interval: 'year', unitAmountCents: 1999, currency: 'usd' }], fetchedAt: T0 - 2 * 60 * 1000 };
  const failing = async () => { throw new Error('offline'); };
  const bg = loadBackground({ plansCache: cached }, { now: c.now, getPlans: failing, console: quiet() });
  assert.deepStrictEqual((await bg.handleMessage({ action: 'getPlans', fresh: true })).plans, cached.plans);
  for (let i = 0; i < 5; i++) await settle();
  assert.strictEqual(bg.getPlansCalls(), 1);
  assert.deepStrictEqual(bg.storage().plansCache, cached, 'the failure did not overwrite the cache');
  await bg.handleMessage({ action: 'getPlans', fresh: true });
  await settle();
  assert.strictEqual(bg.getPlansCalls(), 1, 'no new request on every picker open right after a failure');
});

test('getPlans: without ExtPay it answers no plans', async () => {
  const bg = loadBackground({}, { noExtPay: true, console: quiet() });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'getPlans' }), { plans: [] });
});

// --- background: openPaymentPage ---

test('openPaymentPage { plan } opens that plan\'s ExtensionPay checkout', async () => {
  const bg = loadBackground({});
  await bg.handleMessage({ action: 'openPaymentPage', plan: 'yearly' });
  assert.deepStrictEqual(bg.openPaymentPageCalls, ['yearly']);
  assert.deepStrictEqual(bg.tabsCreated, []);
});

test('openPaymentPage { direct: true } opens ExtensionPay\'s own page (the See plans fallback)', async () => {
  const bg = loadBackground({});
  await bg.handleMessage({ action: 'openPaymentPage', direct: true });
  assert.deepStrictEqual(bg.openPaymentPageCalls, [null]);
  assert.deepStrictEqual(bg.tabsCreated, []);
});

test('openPaymentPage with no plan opens the in-app picker options.html#upgrade', async () => {
  const bg = loadBackground({});
  await bg.handleMessage({ action: 'openPaymentPage' });
  assert.deepStrictEqual(bg.openPaymentPageCalls, []);
  assert.deepStrictEqual(bg.tabsCreated, [{ url: bg.extensionUrl('options.html#upgrade') }]);
});

test('openPaymentPage with no plan focuses an open options tab instead of opening another', async () => {
  const bg = loadBackground({}, {
    contexts: [
      { contextType: 'TAB', tabId: 7, windowId: 3, documentUrl: 'chrome-extension://cleanfeed-test/popup.html' },
      { contextType: 'TAB', tabId: 12, windowId: 4, documentUrl: 'chrome-extension://cleanfeed-test/options.html' }
    ]
  });
  await bg.handleMessage({ action: 'openPaymentPage' });
  assert.deepStrictEqual(bg.tabsCreated, []);
  assert.deepStrictEqual(bg.tabsUpdated, [[12, { active: true, url: bg.extensionUrl('options.html#upgrade') }]]);
  assert.deepStrictEqual(bg.windowsUpdated, [[1, { focused: true }]]);
});

test('openPaymentPage: a plan nickname that is not a plain name opens the picker, never a crafted URL', async () => {
  const bg = loadBackground({});
  await bg.handleMessage({ action: 'openPaymentPage', plan: '../../evil?x=1' });
  assert.deepStrictEqual(bg.openPaymentPageCalls, []);
  assert.deepStrictEqual(bg.tabsCreated, [{ url: bg.extensionUrl('options.html#upgrade') }]);
});

test('openPaymentPage without ExtPay: a plan opens extensionpay.com, no plan still opens the picker', async () => {
  const bg = loadBackground({}, { noExtPay: true, console: quiet() });
  await bg.handleMessage({ action: 'openPaymentPage', plan: 'monthly' });
  await bg.handleMessage({ action: 'openPaymentPage', direct: true });
  await bg.handleMessage({ action: 'openPaymentPage' });
  assert.deepStrictEqual(bg.tabsCreated, [
    { url: 'https://extensionpay.com' },
    { url: 'https://extensionpay.com' },
    { url: bg.extensionUrl('options.html#upgrade') }
  ]);
});

// --- the pages route every upgrade button to the picker ---

test('options.js routes upgrade buttons to #upgrade; only the picker sends a plan or direct', () => {
  const src = read('options.js');
  const sends = src.match(/action:\s*'openPaymentPage'[^}]*}/g) || [];
  assert.ok(sends.length >= 2, 'the picker sends plan / direct');
  for (const s of sends) assert.ok(/plan|direct/.test(s), 'options.js sends a plan-less openPaymentPage: ' + s);
  const html = read('options.html');
  assert.ok(/id="upgrade"/.test(html), 'options.html has the #upgrade section');
  assert.ok(!/id="upgradeBtn"/.test(html), 'the single upgrade card is gone');
});
