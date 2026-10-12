'use strict';
// Live test for the features v1.4 hides (features.js): Interest Boundaries +
// Smart Decay, Schedule, Daily time limit.
//   node tests/live/hidden-features.js   (about 1 min)
// Storage holds what a user of an older version may have saved: an "Always"
// interest for "minecraft", Schedule mode on with no days (older versions then
// treated every moment as outside the schedule and stopped filtering), a daily
// time limit already used up today, and an unused free curiosity teaser.
//  1. Search "minecraft" (blocked): every card whose title matches is hidden
//     (the saved interest and the schedule are ignored); no time-limit overlay.
//  2. Search "fortnite" (blocked, no saved interest): no curiosity prompt, and
//     every card whose title matches is hidden (the schedule is ignored).
//  3. That page stays visible for 35 s: dailyTimeTracking is never written
//     (the old time tracker wrote it every 30 s and refiltered every tab).
//  4. popup.html and options.html, in English and with the Italian language
//     override: no console or page error, no Interests tab or section, no
//     Interest Boundaries / Smart Decay / Schedule / Daily time limit control or
//     stat, and the Pro copy names none of them.
// Prints a JSON report; exit 0 only if every scenario passes.
// Never signs in; on consent pages only "Reject all" is clicked.

const h = require('./harness');

const search = q => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
const PROMPT_WAIT_MS = 6000;
const TRACKER_WINDOW_MS = 35000;
// Copy of the hidden features that must not appear anywhere, per UI language.
const HIDDEN_COPY_RE = {
  en: /interest boundar|smart decay|schedule|time limit|interests saved|until decay|\binterests\b/i,
  it: /confini di interesse|decadimento|programmat|limite giornaliero|limite \(minuti\)|interessi salvati|\binteressi\b/i
};

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function seedOldUserState() {
  const { settings } = await h.getStorage(['settings']);
  const now = Date.now();
  await h.setStorage({
    blockedKeywords: [{ keyword: 'minecraft', addedAt: now }, { keyword: 'fortnite', addedAt: now }],
    interests: { minecraft: { query: 'minecraft', keywords: ['minecraft'], addedAt: now, lastUsed: now, expiresAt: null } },
    settings: Object.assign({}, settings, {
      enableInterestBoundaries: true,
      enableSmartDecay: true,
      scheduleEnabled: true,
      scheduleStart: '09:00',
      scheduleEnd: '18:00',
      scheduleDays: [],
      dailyTimeLimitEnabled: true,
      dailyTimeLimitMins: 5
    }),
    dailyTimeTracking: { day: todayKey(), secondsUsed: 10 * 60 * 60 },
    onboarding: { interestPromptCount: 0 }
  });
}

// Content-script world: cards (not wrappers of another card) whose title
// matches `keyword`, and how many of them are still visible.
const matchingCards = keyword => `(() => {
  const cards = Array.from(document.querySelectorAll(YT.VIDEO_CARDS)).filter(c => !c.querySelector(YT.VIDEO_CARDS));
  const matching = cards.filter(c => matchesKeyword(YT.getVideoTitle(c) || '', ${JSON.stringify(keyword)}));
  const visible = matching.filter(c => !c.closest('.cleanfeed-hidden'));
  return { cards: cards.length, matching: matching.length, visible: visible.length,
    visibleTitles: visible.slice(0, 5).map(c => YT.getVideoTitle(c)) };
})()`;

function readPageUi(page) {
  return h.evalInPage(page, () => ({
    curiosityPrompt: !!document.getElementById('cleanfeed-curiosity-prompt'),
    timeLimitOverlay: !!document.getElementById('cleanfeed-time-limit-overlay'),
    timeLimitClass: document.body.classList.contains('cleanfeed-time-limit-reached'),
    visibility: document.visibilityState
  }));
}

// gotoYouTube, retried once when a navigation still running (e.g. the consent
// redirect of the warm-up visit) aborts this one.
async function goto(page, url) {
  try {
    return await h.gotoYouTube(page, url);
  } catch (err) {
    if (!/ERR_ABORTED/.test(String(err && err.message))) throw err;
    await h.sleep(1500);
    return h.gotoYouTube(page, url);
  }
}

async function exemptionScenario(page, cs) {
  const result = { name: 'search "minecraft": saved interest and schedule ignored, no time-limit overlay', pass: false, reasons: [] };
  try {
    const nav = await goto(page, search('minecraft'));
    result.url = nav.url;
    await h.waitForFilter(page, { settleMs: 3000 });
    result.cards = await cs.evaluate(matchingCards('minecraft'));
    result.ui = await readPageUi(page);
    if (result.cards.matching === 0) result.reasons.push('precondition: no card title matches "minecraft"');
    if (result.cards.visible > 0) result.reasons.push(`${result.cards.visible} matching card(s) still visible`);
    if (result.ui.timeLimitOverlay || result.ui.timeLimitClass) result.reasons.push('time-limit overlay shown');
    if (result.ui.curiosityPrompt) result.reasons.push('curiosity prompt shown');
  } catch (err) {
    result.reasons.push(String(err && err.message || err).split('\n')[0]);
  }
  result.pass = result.reasons.length === 0;
  return result;
}

async function promptAndTrackerScenarios(page, cs) {
  const prompt = { name: 'search "fortnite" (blocked): no curiosity prompt, schedule ignored', pass: false, reasons: [] };
  const tracker = { name: 'page visible 35 s: no dailyTimeTracking write', pass: false, reasons: [] };
  try {
    const before = (await h.getStorage(['dailyTimeTracking'])).dailyTimeTracking;
    const nav = await goto(page, search('fortnite'));
    const loadedAt = Date.now();
    prompt.url = nav.url;
    await h.waitForFilter(page, { settleMs: PROMPT_WAIT_MS });
    prompt.ui = await readPageUi(page);
    prompt.cards = await cs.evaluate(matchingCards('fortnite'));
    if (prompt.ui.curiosityPrompt) prompt.reasons.push('curiosity prompt shown');
    if (prompt.ui.timeLimitOverlay || prompt.ui.timeLimitClass) prompt.reasons.push('time-limit overlay shown');
    if (prompt.cards.matching === 0) prompt.reasons.push('precondition: no card title matches "fortnite"');
    if (prompt.cards.visible > 0) prompt.reasons.push(`${prompt.cards.visible} matching card(s) still visible`);

    const left = TRACKER_WINDOW_MS - (Date.now() - loadedAt);
    if (left > 0) await h.sleep(left);
    tracker.visibility = (await readPageUi(page)).visibility;
    const after = (await h.getStorage(['dailyTimeTracking'])).dailyTimeTracking;
    tracker.before = before;
    tracker.after = after;
    if (tracker.visibility !== 'visible') tracker.reasons.push('precondition: page not visible (' + tracker.visibility + ')');
    if (JSON.stringify(before) !== JSON.stringify(after)) tracker.reasons.push('dailyTimeTracking was written');
  } catch (err) {
    const line = String(err && err.message || err).split('\n')[0];
    prompt.reasons.push(line);
    tracker.reasons.push(line);
  }
  prompt.pass = prompt.reasons.length === 0;
  tracker.pass = tracker.reasons.length === 0;
  return [prompt, tracker];
}

// Sets the UI language override ('auto' follows the en-US browser).
async function setLanguage(language) {
  const { settings } = await h.getStorage(['settings']);
  await h.setStorage({ settings: Object.assign({}, settings, { language }) });
}

// Opens an extension page, records console errors and uncaught page errors.
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

async function popupScenario(lang) {
  const result = { name: `popup.html (${lang}): no hidden-feature UI, no errors`, pass: false, reasons: [] };
  const { page, errors } = await openExtensionPage('popup.html');
  try {
    await h.withTimeout(page.waitForSelector('#tab-controls .toggle-item', { timeout: 8000 }), 10000, 'popup controls');
    // Visit every tab, as a user would, then read the whole popup.
    const tabs = await h.evalInPage(page, () => Array.from(document.querySelectorAll('.tab'), t => t.dataset.tab));
    for (const tab of tabs) {
      await h.withTimeout(page.click(`.tab[data-tab="${tab}"]`, { timeout: 5000 }), 7000, 'open tab ' + tab);
    }
    await h.sleep(500);
    const dom = await h.evalInPage(page, () => ({
      tabs: Array.from(document.querySelectorAll('.tab'), t => t.textContent.trim()),
      interestsTab: !!document.querySelector('.tab[data-tab="interests"], #tab-interests'),
      toggles: Array.from(document.querySelectorAll('#tab-controls .toggle-title'), t => t.textContent.trim()),
      upgradeCopy: (document.querySelector('.upgrade-subtitle') || {}).textContent || null,
      text: document.body.textContent.replace(/\s+/g, ' ')
    }));
    Object.assign(result, { tabs: dom.tabs, toggles: dom.toggles, upgradeCopy: dom.upgradeCopy });
    if (dom.interestsTab) result.reasons.push('Interests tab present');
    const copy = dom.text.match(HIDDEN_COPY_RE[lang]);
    if (copy) result.reasons.push('hidden-feature copy shown: "' + copy[0] + '"');
    if (!dom.upgradeCopy) result.reasons.push('no upgrade copy found (free user expected)');
  } catch (err) {
    result.reasons.push(String(err && err.message || err).split('\n')[0]);
  } finally {
    try { await h.withTimeout(page.close(), 10000, 'close popup'); } catch (e) { /* ignore */ }
  }
  result.errors = errors;
  if (errors.length > 0) result.reasons.push(`${errors.length} console/page error(s)`);
  result.pass = result.reasons.length === 0;
  return result;
}

async function optionsScenario(lang) {
  const result = { name: `options.html (${lang}): no hidden-feature UI, no errors`, pass: false, reasons: [] };
  const { page, errors } = await openExtensionPage('options.html');
  try {
    await h.withTimeout(page.waitForSelector('#settings-list .toggle-item', { timeout: 8000 }), 10000, 'options settings');
    const sections = await h.evalInPage(page, () => Array.from(document.querySelectorAll('.nav-item'), b => b.dataset.section));
    for (const section of sections) {
      await h.withTimeout(page.click(`.nav-item[data-section="${section}"]`, { timeout: 5000 }), 7000, 'open section ' + section);
    }
    await h.sleep(500);
    const dom = await h.evalInPage(page, () => ({
      nav: Array.from(document.querySelectorAll('.nav-item'), b => b.textContent.trim()),
      interestsSection: !!document.querySelector('.nav-item[data-section="interests"], #section-interests, #interest-list'),
      settings: Array.from(document.querySelectorAll('#settings-list .toggle-title'), t => t.textContent.trim()),
      timeInputs: document.querySelectorAll('#settings-list input[type="time"], #settings-list input[type="number"], #settings-list .day-chip').length,
      statCards: Array.from(document.querySelectorAll('#stats-cards .stat-card-label'), l => l.textContent.trim()),
      upgradeCopy: (document.querySelector('#upgradeCard p') || {}).textContent || null,
      aboutCopy: (document.querySelector('#section-about .about-card p') || {}).textContent || null,
      text: document.body.textContent.replace(/\s+/g, ' ')
    }));
    Object.assign(result, { nav: dom.nav, settings: dom.settings, statCards: dom.statCards, upgradeCopy: dom.upgradeCopy, aboutCopy: dom.aboutCopy });
    if (dom.interestsSection) result.reasons.push('Interests section present');
    if (dom.timeInputs > 0) result.reasons.push(`${dom.timeInputs} schedule/time-limit input(s) present`);
    const copy = dom.text.match(HIDDEN_COPY_RE[lang]);
    if (copy) result.reasons.push('hidden-feature copy shown: "' + copy[0] + '"');
    if (!dom.upgradeCopy) result.reasons.push('no upgrade copy found (free user expected)');
  } catch (err) {
    result.reasons.push(String(err && err.message || err).split('\n')[0]);
  } finally {
    try { await h.withTimeout(page.close(), 10000, 'close options'); } catch (e) { /* ignore */ }
  }
  result.errors = errors;
  if (errors.length > 0) result.reasons.push(`${errors.length} console/page error(s)`);
  result.pass = result.reasons.length === 0;
  return result;
}

async function main() {
  const startedAt = Date.now();
  const cancelWatchdog = h.watchdog(240000);
  let report;
  try {
    await h.launch();
    const scenarios = [];
    const page = await h.newPage();
    try {
      // Settle cookie consent first: a full-screen time-limit overlay (the old
      // behavior) would cover YouTube's consent dialog.
      await goto(page, 'https://www.youtube.com/');
      await h.sleep(1500);
      await seedOldUserState();
      const cs = await h.attachContentWorld(page);
      scenarios.push(await exemptionScenario(page, cs));
      scenarios.push(...await promptAndTrackerScenarios(page, cs));
      await cs.detach();
    } finally {
      try { await h.withTimeout(page.close(), 10000, 'close page'); } catch (e) { /* ignore */ }
    }
    for (const lang of ['en', 'it']) {
      await setLanguage(lang === 'en' ? 'auto' : lang);
      scenarios.push(await popupScenario(lang));
      scenarios.push(await optionsScenario(lang));
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
