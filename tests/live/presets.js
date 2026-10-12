'use strict';
// Live test for cached Pro status, the upgrade copy and Quick presets on
// the free plan (findings #13, #52, #26).
//   node tests/live/presets.js   (about 30 s)
//  1. Service worker start caches Pro status: chrome.storage.local
//     proStatusCache = { isPro: false, checkedAt } for this free user.
//  2. Upgrade copy with no price (prices come from ExtensionPay, see
//     tests/live/plans.js): popup.html's button reads "Upgrade to Pro" on Auto
//     (chrome.i18n.getMessage) and with English chosen in Settings (the
//     custom loader), "Passa a Pro" in Italian; options.html's plan picker is
//     titled "Choose your plan" / "Scegli il tuo piano".
//  3. options.html, free user with 1 custom keyword (minecraft): clicking
//     "Focus mode" (3 topics) adds nothing, shows no alert and opens no page;
//     an inline notice gives the real numbers (adds 3, 2 of 3 slots left)
//     with an Upgrade button. The same in Italian. A preset whose topics are
//     all blocked already applies with no notice.
//  3b. Every preset has 3 topics; a free user with nothing blocked applies
//     each one whole: its 3 topics are saved, no notice, no alert, no new
//     page; popup.html then counts 3/3 keywords used (topics included) and
//     locks the other topics.
//  4. A returning subscriber pays again: ExtPay saves extensionpay_user in
//     chrome.storage.sync with paid true (it fires no onPaid, paidAt was set
//     already). proStatusCache turns Pro and an open options.html shows PRO;
//     saving paid false turns both back to free.
// Prints a JSON report; exit 0 only if every scenario passes. YouTube is not
// opened; the Upgrade button is never clicked.

const h = require('./harness');

// Upgrade buttons carry no price (prices come from ExtensionPay: tests/live/plans.js)
const PRICE_EN = 'Upgrade to Pro';
const PRICE_IT = 'Passa a Pro';
const PICKER_EN = 'Choose your plan';
const PICKER_IT = 'Scegli il tuo piano';
const NOTICE_EN = "This preset doesn't fit the free plan. Topics it adds: 3. Free slots left: 2 of 3. Pro has no limit.";
const NOTICE_IT = "Questo preset non rientra nel piano gratuito. Argomenti che aggiunge: 3. Posti liberi nel piano gratuito: 2 su 3. Con Pro non c'è limite.";

const keywords = list => list.map(keyword => ({ keyword, addedAt: Date.now() }));
const names = list => (list || []).map(k => k.keyword);

async function setLanguage(language) {
  const { settings } = await h.getStorage(['settings']);
  await h.setStorage({ settings: Object.assign({}, settings, { language }) });
}

// Opens an extension page, recording console errors, page errors and dialogs
// (every dialog is dismissed).
async function openExtensionPage(file) {
  const errors = [];
  const dialogs = [];
  const page = await h.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('dialog', d => { dialogs.push({ type: d.type(), message: d.message() }); d.dismiss().catch(() => {}); });
  await h.withTimeout(
    page.goto(`chrome-extension://${h.getExtensionId()}/${file}`, { waitUntil: 'domcontentloaded', timeout: 15000 }),
    17000, 'open ' + file
  );
  await h.sleep(800);
  return { page, errors, dialogs };
}

const text = (page, selector) => h.evalInPage(page, s => {
  const el = document.querySelector(s);
  return el ? el.textContent : null;
}, selector);

async function proCacheScenario() {
  const r = { name: 'service worker start caches Pro status', pass: false, reasons: [] };
  const deadline = Date.now() + 8000;
  let s = await h.getStorage(['proStatusCache']);
  while (!s.proStatusCache && Date.now() < deadline) {
    await h.sleep(250);
    s = await h.getStorage(['proStatusCache']);
  }
  r.proStatusCache = s.proStatusCache;
  const c = s.proStatusCache;
  if (!c || c.isPro !== false || !Number.isFinite(c.checkedAt)) r.reasons.push('expected { isPro: false, checkedAt }, got ' + JSON.stringify(c));
  else if (Math.abs(Date.now() - c.checkedAt) > 5 * 60 * 1000) r.reasons.push('checkedAt is not recent');
  r.pass = r.reasons.length === 0;
  return r;
}

async function priceScenario() {
  const r = { name: 'upgrade copy: no price on the button, English (Auto and chosen) and Italian', pass: false, reasons: [], seen: {} };
  const errors = [];
  for (const language of ['auto', 'en', 'it']) {
    await setLanguage(language);
    const it = language === 'it';
    for (const [file, selector, expected] of [
      ['options.html', '#planPickerTitle', it ? PICKER_IT : PICKER_EN],
      ['popup.html', '.upgrade-btn', it ? PRICE_IT : PRICE_EN]
    ]) {
      const { page, errors: pageErrors } = await openExtensionPage(file);
      try {
        const shown = await text(page, selector);
        r.seen[`${language} ${file}`] = shown;
        if (shown !== expected) r.reasons.push(`${language} ${file}: "${shown}", expected "${expected}"`);
      } finally {
        await page.close().catch(() => {});
      }
      errors.push(...pageErrors);
    }
  }
  if (errors.length) r.reasons.push('console/page errors: ' + errors.join(' | '));
  r.pass = r.reasons.length === 0;
  return r;
}

async function presetScenario(language, expectedNotice, expectedPrice) {
  const r = { name: `options (${language}): Focus mode on the free plan`, pass: false, reasons: [], steps: {} };
  await setLanguage(language);
  await h.setStorage({ blockedKeywords: keywords(['minecraft']) });
  const { page, errors, dialogs } = await openExtensionPage('options.html');
  try {
    const noticeHiddenAtStart = await h.evalInPage(page, () => document.getElementById('presets-notice').hidden);
    const pagesBefore = page.context().pages().length;
    const card = page.locator('.preset-card', { hasText: 'Focus mode' }).first();
    await h.withTimeout(card.click({ timeout: 8000 }), 10000, 'click Focus mode');
    await h.withTimeout(page.waitForSelector('#presets-notice:not([hidden])', { timeout: 5000 }), 7000, 'preset notice');
    await h.sleep(800);
    const notice = await h.evalInPage(page, () => {
      const el = document.getElementById('presets-notice');
      const btn = el.querySelector('button');
      return { text: (el.querySelector('p') || {}).textContent, button: btn ? btn.textContent : null, visible: el.offsetHeight > 0 };
    });
    const s = await h.getStorage(['blockedKeywords']);
    r.steps.overCap = { noticeHiddenAtStart, notice, dialogs: dialogs.slice(), newPages: page.context().pages().length - pagesBefore, keywords: names(s.blockedKeywords) };
    if (!noticeHiddenAtStart) r.reasons.push('notice shown before any click');
    if (notice.text !== expectedNotice) r.reasons.push(`notice: "${notice.text}", expected "${expectedNotice}"`);
    if (notice.button !== expectedPrice) r.reasons.push(`notice button: "${notice.button}"`);
    if (!notice.visible) r.reasons.push('notice not visible');
    if (dialogs.length) r.reasons.push('dialog shown: ' + JSON.stringify(dialogs));
    if (r.steps.overCap.newPages !== 0) r.reasons.push('a new page (payment?) opened');
    if (names(s.blockedKeywords).join() !== 'minecraft') r.reasons.push('keywords changed: ' + names(s.blockedKeywords).join());

    // All of its topics blocked already (more than 3 keywords, e.g. Pro lapsed): applies, no notice
    await h.setStorage({ blockedKeywords: keywords(['gaming', 'gossip', 'brainrot', 'minecraft', 'news']) });
    await h.sleep(800);
    await h.withTimeout(card.click({ timeout: 8000 }), 10000, 'click Focus mode again');
    await h.sleep(1000);
    const after = await h.evalInPage(page, () => ({
      noticeHidden: document.getElementById('presets-notice').hidden,
      active: !!document.querySelector('.preset-card.preset-active')
    }));
    const s2 = await h.getStorage(['blockedKeywords']);
    r.steps.allBlocked = { after, dialogs: dialogs.slice(), keywords: names(s2.blockedKeywords) };
    if (!after.noticeHidden) r.reasons.push('notice still shown once every topic of the preset is blocked');
    if (!after.active) r.reasons.push('Focus mode not marked active');
    if (dialogs.length) r.reasons.push('dialog shown: ' + JSON.stringify(dialogs));
    if (names(s2.blockedKeywords).length !== 5) r.reasons.push('keywords changed: ' + names(s2.blockedKeywords).join());
  } finally {
    await page.close().catch(() => {});
  }
  if (errors.length) r.reasons.push('console/page errors: ' + errors.join(' | '));
  r.pass = r.reasons.length === 0;
  return r;
}

// The page's own preset list (label + topics), read from options.html.
async function readPresets() {
  const { page } = await openExtensionPage('options.html');
  try {
    return await h.evalInPage(page, () => PRESETS.map(p => ({ id: p.id, label: p.label, keys: p.keys.slice() })));
  } finally {
    await page.close().catch(() => {});
  }
}

// Free user, nothing blocked: every preset applies whole (3 topics), with no
// notice, no alert and no new page; the popup counts them 3/3 and locks the rest.
async function freePresetsFitScenario() {
  const r = { name: 'free with nothing blocked: every preset applies whole, popup counts 3/3', pass: false, reasons: [], presets: {} };
  await setLanguage('auto');
  const presets = await readPresets();
  r.presets.count = presets.length;
  if (presets.length < 5) r.reasons.push('expected at least 5 presets, got ' + presets.length);
  for (const preset of presets) {
    if (preset.keys.length !== 3) r.reasons.push(`${preset.id} has ${preset.keys.length} topics`);
  }
  for (const preset of presets) {
    await h.setStorage({ blockedKeywords: [] });
    const { page, errors, dialogs } = await openExtensionPage('options.html');
    try {
      const pagesBefore = page.context().pages().length;
      const card = page.locator('.preset-card', { hasText: preset.label }).first();
      await h.withTimeout(card.click({ timeout: 8000 }), 10000, 'click ' + preset.label);
      await h.sleep(1200);
      const s = await h.getStorage(['blockedKeywords']);
      const view = await h.evalInPage(page, () => ({
        noticeHidden: document.getElementById('presets-notice').hidden,
        status: [...document.querySelectorAll('.preset-card.preset-active')].length
      }));
      r.presets[preset.id] = { saved: names(s.blockedKeywords), view };
      if (names(s.blockedKeywords).join() !== preset.keys.join()) r.reasons.push(`${preset.id}: saved "${names(s.blockedKeywords).join()}", expected "${preset.keys.join()}"`);
      if (!view.noticeHidden) r.reasons.push(preset.id + ': the over-cap notice is shown');
      if (view.status < 1) r.reasons.push(preset.id + ': the preset card is not marked active');
      if (dialogs.length) r.reasons.push(preset.id + ': dialog shown: ' + JSON.stringify(dialogs));
      if (page.context().pages().length !== pagesBefore) r.reasons.push(preset.id + ': a new page opened');
    } finally {
      await page.close().catch(() => {});
    }
    if (errors.length) r.reasons.push(preset.id + ' console/page errors: ' + errors.join(' | '));
  }

  // The last preset is still applied: the popup counts its 3 topics as 3/3 and locks the other topics
  for (const [language, expected] of [['auto', '3/3 keywords used'], ['it', '3/3 parole usate']]) {
    await setLanguage(language);
    const { page, errors } = await openExtensionPage('popup.html');
    try {
      const popup = await h.evalInPage(page, () => ({
        headers: [...document.querySelectorAll('.section-header')].map(e => e.textContent),
        chips: document.querySelectorAll('.category-chip').length,
        active: document.querySelectorAll('.category-chip.active').length,
        locked: document.querySelectorAll('.category-chip.locked').length
      }));
      r.presets['popup ' + language] = popup;
      if (!popup.headers.some(t => t.includes(expected))) r.reasons.push(`popup (${language}): no "${expected}" in ${JSON.stringify(popup.headers)}`);
      if (popup.active !== 3) r.reasons.push(`popup (${language}): ${popup.active} active topic chips, expected 3`);
      if (popup.locked !== popup.chips - 3) r.reasons.push(`popup (${language}): ${popup.locked} locked of ${popup.chips} chips, expected ${popup.chips - 3}`);
    } finally {
      await page.close().catch(() => {});
    }
    if (errors.length) r.reasons.push('popup (' + language + ') console/page errors: ' + errors.join(' | '));
  }
  r.pass = r.reasons.length === 0;
  return r;
}

// Saves extensionpay_user in chrome.storage.sync, as ExtPay's fetch_user does.
function saveExtPayUser(user) {
  return h.getServiceWorker().then(sw => h.withTimeout(
    sw.evaluate(async u => { await chrome.storage.sync.set({ extensionpay_user: u }); return true; }, user),
    10000, 'save extensionpay_user'));
}

// Polls until check() is true (or the time runs out); returns its last value.
async function waitFor(check, ms) {
  const deadline = Date.now() + ms;
  let value = await check();
  while (!value && Date.now() < deadline) {
    await h.sleep(250);
    value = await check();
  }
  return value;
}

async function returningSubscriberScenario() {
  const r = { name: 'returning subscriber: a saved paid ExtPay user turns Pro at once (no onPaid)', pass: false, reasons: [], steps: {} };
  const lapsed = { paid: false, paidAt: '2026-01-05T10:00:00.000Z', installedAt: '2025-12-01T10:00:00.000Z', subscriptionStatus: 'canceled' };
  await setLanguage('auto');
  await saveExtPayUser(lapsed);
  const { page, errors } = await openExtensionPage('options.html');
  const badgeIsPro = () => h.evalInPage(page, () => document.getElementById('planBadge').classList.contains('badge-pro'));
  const cacheIsPro = async () => ((await h.getStorage(['proStatusCache'])).proStatusCache || {}).isPro;
  try {
    r.steps.before = { cache: (await h.getStorage(['proStatusCache'])).proStatusCache, badgePro: await badgeIsPro() };
    if (r.steps.before.cache?.isPro !== false || r.steps.before.badgePro) r.reasons.push('not free at the start: ' + JSON.stringify(r.steps.before));

    await saveExtPayUser({ ...lapsed, paid: true, subscriptionStatus: 'active' });
    const cachePro = await waitFor(async () => (await cacheIsPro()) === true, 5000);
    const badgePro = await waitFor(badgeIsPro, 5000);
    r.steps.paid = { cache: (await h.getStorage(['proStatusCache'])).proStatusCache, badge: await text(page, '#planBadge'), badgePro };
    if (!cachePro) r.reasons.push('proStatusCache not Pro after the paid user was saved');
    if (!badgePro) r.reasons.push('options.html badge not PRO');

    await saveExtPayUser(lapsed);
    const cacheFree = await waitFor(async () => (await cacheIsPro()) === false, 5000);
    const badgeFree = await waitFor(async () => !(await badgeIsPro()), 5000);
    r.steps.lapsedAgain = { cache: (await h.getStorage(['proStatusCache'])).proStatusCache, badge: await text(page, '#planBadge') };
    if (!cacheFree) r.reasons.push('proStatusCache still Pro after paid false was saved');
    if (!badgeFree) r.reasons.push('options.html badge still PRO');
  } finally {
    await page.close().catch(() => {});
  }
  if (errors.length) r.reasons.push('console/page errors: ' + errors.join(' | '));
  r.pass = r.reasons.length === 0;
  return r;
}

async function main() {
  const startedAt = Date.now();
  const cancelWatchdog = h.watchdog(240000);
  let report;
  try {
    await h.launch();
    const scenarios = [];
    const run = [
      proCacheScenario,
      priceScenario,
      () => presetScenario('auto', NOTICE_EN, PRICE_EN),
      () => presetScenario('it', NOTICE_IT, PRICE_IT),
      freePresetsFitScenario,
      returningSubscriberScenario
    ];
    for (const scenario of run) {
      try {
        scenarios.push(await scenario());
      } catch (err) {
        scenarios.push({ name: scenario.name || 'preset scenario', pass: false, reasons: [String(err && err.message || err).split('\n')[0]] });
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
