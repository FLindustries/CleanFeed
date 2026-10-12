'use strict';
// Live test for the plan picker, the popup's price line and the upgrade
// routing, with the REAL ExtensionPay plans (whatever they are today).
//   node tests/live/plans.js   (about 40 s)
//  1. options.html#upgrade (free user, English on Auto, then Italian): the
//     About tab opens on the picker, which has the focus and is in view; the
//     cards are the real plans (from the background's getPlans, cached in
//     chrome.storage.local plansCache), priced as cfBuildPlanCards formats
//     them; yearly is highlighted, "Best value" only when cfBuildPlanCards
//     allows it; the currency note and the "stay free" line show; no console
//     or page error. With no plans (ExtensionPay unreachable) it expects the
//     "See plans" button instead, and says so in the report.
//  2. popup.html: the line under "Upgrade to Pro" is cfPlansLine() of the
//     same plans (English and Italian).
//  2b. A dashboard change reaches the pages: with a retired plan cached 2
//     minutes ago, options.html#upgrade refreshes plansCache and shows the
//     real plans; popup.html leaves a cache of no plans 1 minute old alone and
//     refreshes one 6 minutes old (its line then shows the real plans).
//  3. A plan-less openPaymentPage (sent from popup.html) opens
//     options.html#upgrade; sent again while that options tab is open on
//     another tab of its own, it opens no new page and shows the picker there.
//  4. A plan's "Choose" button opens extensionpay.com/extension/cleanfeed/
//     choose-plan/<nickname>. No checkout is ever loaded: the test gives ExtPay
//     a placeholder API key (so no key is created on extensionpay.com),
//     aborts that navigation and closes the tab.
// Prints a JSON report; exit 0 only if every scenario passes. YouTube is not
// opened; nothing is signed in to or paid.

const h = require('./harness');
const loadContentDom = require('../unit/load-content-dom');
const fs = require('node:fs');
const path = require('node:path');

const LOCALES = {
  en: JSON.parse(fs.readFileSync(path.join(h.REPO_ROOT, '_locales/en/messages.json'), 'utf8')),
  it: JSON.parse(fs.readFileSync(path.join(h.REPO_ROOT, '_locales/it/messages.json'), 'utf8'))
};
const cf = loadContentDom();
const fmt = lang => (key, subs) => cf.cfFormatMessage(LOCALES[lang][key], subs);
// Node's and Chromium's Intl may differ in spaces (no-break or not)
const norm = s => String(s == null ? '' : s).replace(/[\s  ]+/g, ' ').trim();

async function setLanguage(language) {
  const { settings } = await h.getStorage(['settings']);
  await h.setStorage({ settings: Object.assign({}, settings, { language }) });
}

// Opens an extension page (optionally with a #hash), recording console errors
// and page errors.
async function openExtensionPage(file) {
  const errors = [];
  const page = await h.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await h.withTimeout(
    page.goto(`chrome-extension://${h.getExtensionId()}/${file}`, { waitUntil: 'domcontentloaded', timeout: 15000 }),
    17000, 'open ' + file
  );
  return { page, errors };
}

// The plans the background answers (and caches), read like the pages do.
async function backgroundPlans(page) {
  return h.evalInPage(page, async () => (await chrome.runtime.sendMessage({ action: 'getPlans' })).plans, null, 15000);
}

async function pickerScenario(language) {
  const lang = language === 'it' ? 'it' : 'en';
  const r = { name: `options.html#upgrade (${language}): the picker shows the real plans`, pass: false, reasons: [] };
  await setLanguage(language);
  const { page, errors } = await openExtensionPage('options.html#upgrade');
  try {
    await h.withTimeout(page.waitForSelector('#planCards .plan-card, #planSeePlansBtn', { timeout: 12000 }), 14000, 'plan cards');
    await h.sleep(900); // the smooth scroll
    const plans = await backgroundPlans(page);
    const cache = (await h.getStorage(['plansCache'])).plansCache;
    const cards = loadContentDom.plain(cf.cfBuildPlanCards(plans, lang, new Date()));
    const dom = await h.evalInPage(page, () => {
      const box = document.getElementById('upgrade');
      const rect = box.getBoundingClientRect();
      return {
        aboutActive: document.getElementById('section-about').classList.contains('active'),
        navActive: (document.querySelector('.nav-item.active') || {}).dataset?.section,
        focused: document.activeElement === box,
        highlighted: box.classList.contains('plan-picker-focus'),
        inView: rect.top >= -1 && rect.top < window.innerHeight,
        title: document.getElementById('planPickerTitle').textContent,
        cards: Array.from(document.querySelectorAll('#planCards .plan-card'), c => ({
          kind: c.dataset.plan,
          featured: c.classList.contains('plan-card-featured'),
          name: c.querySelector('.plan-card-name').textContent,
          badge: (c.querySelector('.plan-badge') || {}).textContent || null,
          price: c.querySelector('.plan-card-price').textContent,
          detail: c.querySelector('.plan-card-detail').textContent,
          note: (c.querySelector('.plan-card-note') || {}).textContent || null,
          button: c.querySelector('button').textContent
        })),
        seePlans: !!document.getElementById('planSeePlansBtn'),
        currencyNote: document.getElementById('planCurrencyNote').hidden ? null : document.getElementById('planCurrencyNote').textContent,
        footer: Array.from(document.querySelectorAll('#planFooter p:not([hidden])'), p => p.textContent),
        text: document.getElementById('upgrade').textContent
      };
    });
    Object.assign(r, { plans, plansCacheFetchedAt: cache && cache.fetchedAt, dom });
    if (!dom.aboutActive || dom.navActive !== 'about') r.reasons.push('About tab not active');
    if (!dom.focused) r.reasons.push('picker does not have the focus');
    if (!dom.highlighted) r.reasons.push('picker not highlighted');
    if (!dom.inView) r.reasons.push('picker not scrolled into view');
    if (dom.title !== fmt(lang)('planPickerTitle')) r.reasons.push('title: ' + dom.title);
    if (/most popular|più popolare/i.test(dom.text)) r.reasons.push('"Most popular" shown');
    if (!cache || !Array.isArray(cache.plans)) r.reasons.push('no plansCache in storage');
    if (cards.length === 0) {
      r.note = 'ExtensionPay returned no plans: expecting the See plans fallback';
      if (!dom.seePlans) r.reasons.push('no plans and no See plans button');
      if (dom.currencyNote) r.reasons.push('currency note shown without prices');
    } else {
      if (dom.seePlans) r.reasons.push('See plans shown although plans loaded');
      if (JSON.stringify(dom.cards.map(c => c.kind)) !== JSON.stringify(cards.map(c => c.kind))) {
        r.reasons.push('cards ' + dom.cards.map(c => c.kind).join() + ', expected ' + cards.map(c => c.kind).join());
      }
      const f = fmt(lang);
      for (const card of cards) {
        const shown = dom.cards.find(c => c.kind === card.kind);
        if (!shown) continue;
        const expectedPrice = card.kind === 'lifetime' ? f('planOnce', [card.price]) : f('planPerMonth', [card.kind === 'yearly' ? card.perMonth : card.price]);
        if (norm(shown.price) !== norm(expectedPrice)) r.reasons.push(`${card.kind} price "${shown.price}", expected "${expectedPrice}"`);
        if (card.kind === 'yearly') {
          const detail = card.savePercent ? f('planBilledYearlySave', [card.price, String(card.savePercent)]) : f('planBilledYearly', [card.price]);
          if (norm(shown.detail) !== norm(detail)) r.reasons.push(`yearly detail "${shown.detail}", expected "${detail}"`);
          if (!!shown.badge !== !!card.bestValue) r.reasons.push('Best value badge ' + (shown.badge ? 'shown' : 'missing'));
          if (!shown.featured) r.reasons.push('yearly not highlighted');
        } else if (shown.badge) {
          r.reasons.push(card.kind + ' has a badge');
        }
        if (card.kind === 'lifetime' && !!shown.note !== !!card.launchNote) r.reasons.push('launch note ' + (shown.note ? 'shown' : 'missing'));
      }
      const currency = cf.cfPlansCurrencyToNote(cf.cfBuildPlanCards(plans, lang, new Date()), lang);
      const expectedNote = currency ? f('planCurrencyNote', [currency]) : null;
      if (dom.currencyNote !== expectedNote) r.reasons.push(`currency note "${dom.currencyNote}", expected "${expectedNote}"`);
    }
    if (!dom.footer.includes(fmt(lang)('planStayFree'))) r.reasons.push('"stay free" line missing');
    if (!dom.footer.includes(fmt(lang)('upgradeProDesc'))) r.reasons.push('Pro feature line missing');
  } finally {
    await page.close().catch(() => {});
  }
  if (errors.length) r.reasons.push('console/page errors: ' + errors.join(' | '));
  r.pass = r.reasons.length === 0;
  return r;
}

async function popupScenario(language) {
  const lang = language === 'it' ? 'it' : 'en';
  const r = { name: `popup.html (${language}): the plans line under Upgrade to Pro`, pass: false, reasons: [] };
  await setLanguage(language);
  const { page, errors } = await openExtensionPage('popup.html');
  try {
    await h.withTimeout(page.waitForSelector('.upgrade-btn', { timeout: 8000 }), 10000, 'upgrade button');
    const plans = await backgroundPlans(page);
    const expected = cf.cfPlansLine(cf.cfBuildPlanCards(plans, lang, new Date()), fmt(lang));
    if (expected) await h.withTimeout(page.waitForSelector('#upgradePlans:not([hidden])', { timeout: 8000 }), 10000, 'plans line');
    else await h.sleep(1500);
    const dom = await h.evalInPage(page, () => {
      const line = document.getElementById('upgradePlans');
      return { button: document.querySelector('.upgrade-btn').textContent, line: line && !line.hidden ? line.textContent : null };
    });
    Object.assign(r, { expected, dom });
    if (dom.button !== fmt(lang)('upgradeToPro')) r.reasons.push('button: ' + dom.button);
    if (/\d/.test(dom.button)) r.reasons.push('the button shows a number');
    if (expected ? norm(dom.line) !== norm(expected) : dom.line !== null) r.reasons.push(`line "${dom.line}", expected "${expected}"`);
  } finally {
    await page.close().catch(() => {});
  }
  if (errors.length) r.reasons.push('console/page errors: ' + errors.join(' | '));
  r.pass = r.reasons.length === 0;
  return r;
}

// Polls `fn` (async) every 250 ms until it returns a truthy value or `ms` pass;
// returns the last value.
async function pollFor(fn, ms) {
  const deadline = Date.now() + ms;
  let value = await fn();
  while (!value && Date.now() < deadline) {
    await h.sleep(250);
    value = await fn();
  }
  return value;
}

// A dashboard change reaches the pages: the picker refreshes a cache over a
// minute old (here: a retired plan cached 2 minutes ago), the popup a cache of
// no plans over 5 minutes old, and a cache of no plans under 5 minutes old is
// left alone by the popup (it is not asked again on every open).
async function freshnessScenario() {
  const r = { name: 'dashboard changes reach the picker at once and replace a cache of no plans after 5 min', pass: false, reasons: [], steps: {} };
  await setLanguage('auto');
  const real = ((await h.getStorage(['plansCache'])).plansCache || {}).plans;
  if (!Array.isArray(real)) {
    r.reasons.push('no plansCache from the earlier scenarios');
    return r;
  }
  const realCards = loadContentDom.plain(cf.cfBuildPlanCards(real, 'en', new Date()));
  const RETIRED = { nickname: 'retired-test', interval: 'month', unitAmountCents: 111, currency: 'usd' };
  const MIN = 60 * 1000;
  const cacheAt = async () => ((await h.getStorage(['plansCache'])).plansCache || {}).fetchedAt;
  const allErrors = [];
  try {
    // a. Picker, retired plan cached 2 min ago -> the real plans
    const staleAt = Date.now() - 2 * MIN;
    await h.setStorage({ plansCache: { plans: [RETIRED], fetchedAt: staleAt } });
    const { page: options, errors } = await openExtensionPage('options.html#upgrade');
    allErrors.push(errors);
    try {
      const shown = await pollFor(async () => {
        const dom = await h.evalInPage(options, () => ({
          kinds: Array.from(document.querySelectorAll('#planCards .plan-card'), c => c.dataset.plan),
          prices: Array.from(document.querySelectorAll('#planCards .plan-card-price'), p => p.textContent),
          seePlans: !!document.getElementById('planSeePlansBtn')
        }));
        const want = realCards.map(c => c.kind);
        const ok = want.length
          ? JSON.stringify(dom.kinds) === JSON.stringify(want) && !dom.prices.some(p => p.includes('1.11'))
          : dom.seePlans;
        return ok ? dom : null;
      }, 12000);
      const fetchedAt = await cacheAt();
      r.steps.picker = { shown, staleAt, fetchedAt };
      if (!shown) r.reasons.push('the picker still shows the retired plan (no refresh)');
      if (!(fetchedAt > staleAt)) r.reasons.push('the picker did not refresh plansCache');
    } finally {
      await options.close().catch(() => {});
    }

    // b. Popup, a cache of no plans 1 min old: kept (no request on every open)
    const recentEmptyAt = Date.now() - MIN;
    await h.setStorage({ plansCache: { plans: [], fetchedAt: recentEmptyAt } });
    const p1 = await openExtensionPage('popup.html');
    allErrors.push(p1.errors);
    try {
      await h.withTimeout(p1.page.waitForSelector('.upgrade-btn', { timeout: 8000 }), 10000, 'upgrade button');
      await h.sleep(2000);
      const fetchedAt = await cacheAt();
      r.steps.popupRecentEmpty = { recentEmptyAt, fetchedAt };
      if (fetchedAt !== recentEmptyAt) r.reasons.push('the popup refreshed a cache of no plans under 5 minutes old');
    } finally {
      await p1.page.close().catch(() => {});
    }

    // c. Popup, a cache of no plans 6 min old: refreshed, the line shows the real plans
    const oldEmptyAt = Date.now() - 6 * MIN;
    await h.setStorage({ plansCache: { plans: [], fetchedAt: oldEmptyAt } });
    const p2 = await openExtensionPage('popup.html');
    allErrors.push(p2.errors);
    try {
      await h.withTimeout(p2.page.waitForSelector('.upgrade-btn', { timeout: 8000 }), 10000, 'upgrade button');
      const expected = cf.cfPlansLine(cf.cfBuildPlanCards(real, 'en', new Date()), fmt('en'));
      const fetchedAt = await pollFor(async () => {
        const at = await cacheAt();
        return at > oldEmptyAt ? at : null;
      }, 12000);
      const line = await pollFor(async () => {
        const text = await h.evalInPage(p2.page, () => {
          const el = document.getElementById('upgradePlans');
          return el && !el.hidden ? el.textContent : null;
        });
        return expected ? (norm(text) === norm(expected) ? text : null) : (text === null ? 'none' : null);
      }, 8000);
      r.steps.popupOldEmpty = { oldEmptyAt, fetchedAt, expected, line };
      if (!fetchedAt) r.reasons.push('the popup did not refresh a cache of no plans 6 minutes old');
      if (!line) r.reasons.push(`the popup line is not "${expected}"`);
    } finally {
      await p2.page.close().catch(() => {});
    }
  } finally {
    // The real plans again, fresh, for the next scenarios
    await h.setStorage({ plansCache: { plans: real, fetchedAt: Date.now() } });
  }
  const errors = allErrors.flat();
  if (errors.length) r.reasons.push('console/page errors: ' + errors.join(' | '));
  r.pass = r.reasons.length === 0;
  return r;
}

// Waits for a new page in the context whose URL passes `test`.
function waitForNewPage(context, test, ms) {
  return h.withTimeout(context.waitForEvent('page', { predicate: p => test(p.url()), timeout: ms }), ms + 2000, 'new page');
}

async function routingScenario() {
  const r = { name: 'plan-less openPaymentPage opens options.html#upgrade (and reuses an open options tab)', pass: false, reasons: [], steps: {} };
  await setLanguage('auto');
  const pickerUrl = `chrome-extension://${h.getExtensionId()}/options.html#upgrade`;
  const { page: popup, errors } = await openExtensionPage('popup.html');
  const context = popup.context();
  let opened = null;
  let options = null;
  try {
    // a. No options tab open: a new one on #upgrade
    const waiting = waitForNewPage(context, u => u === pickerUrl, 8000);
    await h.evalInPage(popup, () => chrome.runtime.sendMessage({ action: 'openPaymentPage' }));
    opened = await waiting;
    await h.withTimeout(opened.waitForSelector('#planCards .plan-card, #planSeePlansBtn', { timeout: 12000 }), 14000, 'picker in the new tab');
    r.steps.newTab = await h.evalInPage(opened, () => ({ url: location.href, about: document.getElementById('section-about').classList.contains('active') }));
    if (!r.steps.newTab.about) r.reasons.push('new tab: About not active');
    await opened.close().catch(() => {});
    opened = null;

    // b. An options tab open on Settings: no new page, that tab shows the picker
    ({ page: options } = await openExtensionPage('options.html'));
    await h.withTimeout(options.waitForSelector('#settings-list .toggle-item', { timeout: 8000 }), 10000, 'options settings');
    const before = context.pages().length;
    const settingsFirst = await h.evalInPage(options, () => document.getElementById('section-settings').classList.contains('active'));
    await h.evalInPage(popup, () => chrome.runtime.sendMessage({ action: 'openPaymentPage' }));
    await h.sleep(1500);
    r.steps.reused = await h.evalInPage(options, () => ({
      hash: location.hash,
      about: document.getElementById('section-about').classList.contains('active'),
      focused: document.activeElement === document.getElementById('upgrade')
    }));
    r.steps.reused.settingsFirst = settingsFirst;
    r.steps.reused.newPages = context.pages().length - before;
    if (!settingsFirst) r.reasons.push('options did not start on Settings');
    if (r.steps.reused.newPages !== 0) r.reasons.push('a new page opened instead of reusing the options tab');
    if (r.steps.reused.hash !== '#upgrade' || !r.steps.reused.about) r.reasons.push('the open options tab did not show the picker: ' + JSON.stringify(r.steps.reused));
  } finally {
    if (opened) await opened.close().catch(() => {});
    if (options) await options.close().catch(() => {});
    await popup.close().catch(() => {});
  }
  if (errors.length) r.reasons.push('console/page errors: ' + errors.join(' | '));
  r.pass = r.reasons.length === 0;
  return r;
}

async function checkoutScenario() {
  const r = { name: 'a plan button opens that plan\'s extensionpay.com checkout URL (aborted, closed)', pass: false, reasons: [] };
  await setLanguage('auto');
  // A placeholder key: ExtPay then creates no key on extensionpay.com
  const sw = await h.getServiceWorker();
  await h.withTimeout(sw.evaluate(async () => {
    const { extensionpay_api_key } = await chrome.storage.sync.get('extensionpay_api_key');
    if (!extensionpay_api_key) await chrome.storage.sync.set({ extensionpay_api_key: 'cleanfeed-live-test-placeholder' });
  }), 10000, 'placeholder api key');
  const { page, errors } = await openExtensionPage('options.html#upgrade');
  const context = page.context();
  const aborted = [];
  const handler = route => { aborted.push(route.request().url()); route.abort().catch(() => {}); };
  await context.route('https://extensionpay.com/**', handler);
  let checkout = null;
  try {
    await h.withTimeout(page.waitForSelector('#planCards .plan-card, #planSeePlansBtn', { timeout: 12000 }), 14000, 'plan cards');
    const target = await h.evalInPage(page, () => {
      const btn = document.querySelector('#planCards .plan-card-featured button') || document.querySelector('#planCards .plan-card button') || document.getElementById('planSeePlansBtn');
      return btn ? { kind: btn.dataset.plan || 'see-plans' } : null;
    });
    const plans = await backgroundPlans(page);
    const card = loadContentDom.plain(cf.cfBuildPlanCards(plans, 'en', new Date())).find(c => c.kind === (target && target.kind));
    r.clicked = target && target.kind;
    const expectedPath = card && card.nickname
      ? `https://extensionpay.com/extension/cleanfeed/choose-plan/${card.nickname}?`
      : 'https://extensionpay.com/extension/cleanfeed/choose-plan?';
    const waiting = waitForNewPage(context, () => true, 10000).catch(() => null);
    const selector = target && target.kind !== 'see-plans' ? `#planCards .plan-card[data-plan="${target.kind}"] button` : '#planSeePlansBtn';
    await h.withTimeout(page.click(selector, { timeout: 5000 }), 7000, 'click ' + selector);
    checkout = await waiting;
    // The tab's own navigation is not routable (the extension created it), so
    // read its URL; every extensionpay.com resource it asks for is aborted.
    const deadline = Date.now() + 8000;
    while (checkout && !checkout.url().startsWith('https://extensionpay.com/') && Date.now() < deadline) await h.sleep(200);
    r.checkoutUrl = checkout ? checkout.url().replace(/api_key=[^&]+/, 'api_key=<placeholder>') : null;
    r.abortedRequests = aborted.length;
    r.expectedPrefix = expectedPath;
    if (!checkout) r.reasons.push('no new tab opened');
    else if (!checkout.url().startsWith(expectedPath)) r.reasons.push('the new tab is ' + r.checkoutUrl + ', expected ' + expectedPath + '...');
  } finally {
    if (checkout) await checkout.close().catch(() => {});
    for (const p of context.pages()) {
      if (/^https:\/\/extensionpay\.com\//.test(p.url()) || /^chrome-error:/.test(p.url())) await p.close().catch(() => {});
    }
    await context.unroute('https://extensionpay.com/**', handler).catch(() => {});
    await page.close().catch(() => {});
  }
  if (errors.length) r.reasons.push('console/page errors: ' + errors.join(' | '));
  r.pass = r.reasons.length === 0;
  return r;
}

async function main() {
  const startedAt = Date.now();
  const cancelWatchdog = h.watchdog(180000);
  let report;
  try {
    await h.launch();
    const scenarios = [];
    const run = [
      () => pickerScenario('auto'),
      () => pickerScenario('it'),
      () => popupScenario('auto'),
      () => popupScenario('it'),
      freshnessScenario,
      routingScenario,
      checkoutScenario
    ];
    for (const scenario of run) {
      try {
        scenarios.push(await scenario());
      } catch (err) {
        scenarios.push({ name: scenario.name || 'plans scenario', pass: false, reasons: [String(err && err.message || err).split('\n')[0]] });
      }
    }
    report = {
      ok: scenarios.every(s => s.pass),
      summary: scenarios.map(s => `${s.pass ? 'PASS' : 'FAIL'} ${s.name}${s.pass ? '' : ': ' + s.reasons.join('; ')}`),
      scenarios,
      elapsedMs: Date.now() - startedAt
    };
  } catch (err) {
    report = { ok: false, error: String(err && err.stack || err), elapsedMs: Date.now() - startedAt };
  } finally {
    await h.close();
    cancelWatchdog();
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();
