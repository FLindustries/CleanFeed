'use strict';
// Live test for Strict Mode (findings #2 and #5).
//   node tests/live/strict.js   (about 1.5 min)
// Storage holds a free user (Pro lapsed) with strict mode on (password
// "open sesame"), a blocked channel, two blocked keywords, Hide Shorts on and
// a channel auto-tagged for Gaming.
//  1. popup.html: removing the blocked channel asks for the password; cancel
//     or a wrong one ("Wrong password.") removes nothing, the right one
//     removes it. The popup then remembers it: removing a keyword and turning
//     Hide Shorts off ask nothing. A new popup asks again (topic chip).
//  2. options.html: importing a backup that removes blocks asks for the
//     password (cancel: nothing imported, no "Import failed" alert); Untag
//     asks once, a synonym chip then asks nothing; the Strict mode switch of
//     the free user asks for the password and turns strict mode off (no
//     payment page).
//  2b. options.html, free user with strict mode OFF: importing a backup that
//     has strict mode on does not turn it on. The alert says the rest was
//     imported and "Strict Mode is a Pro feature and was not imported."
//     (Italian: "La modalità rigorosa è una funzione Pro e non è stata
//     importata."); storage keeps strictModeEnabled false and no password
//     hash, the backup's blocks and other settings arrive.
//  3. YouTube (strict mode on again): the masthead pause switch is locked
//     ("Locked by Strict Mode" tooltip; a click shows the toast and pauses
//     nothing); turning strict mode off unlocks it live, pausing works, and
//     turning strict mode on again resumes filtering and locks it live. On an
//     auto-tagged channel page the peek switch and "Untag channel" are locked;
//     on a blocked channel page "Show just now" is locked.
// Prints a JSON report; exit 0 only if every scenario passes.
// Never signs in; on consent pages only "Reject all" is clicked.

const crypto = require('node:crypto');
const h = require('./harness');

const PASSWORD = 'open sesame';
const HASH = crypto.createHash('sha256').update(PASSWORD).digest('hex');
const LOCKED_TITLE = 'Locked by Strict Mode';
const TAGGED_CHANNEL_URL = 'https://www.youtube.com/@veritasium';
const BLOCKED_CHANNEL_URL = 'https://www.youtube.com/@mkbhd';
const GAMING_ROW = '.category-item:has(.category-name:text-is("Gaming"))';

async function seed() {
  const { settings } = await h.getStorage(['settings']);
  const now = Date.now();
  await h.setStorage({
    settings: Object.assign({}, settings, { hideShorts: true, strictModeEnabled: true, strictModePasswordHash: HASH }),
    blockedChannels: [{ name: 'Drama Daily', id: '@dramadaily', blockedAt: now }, { name: 'Marques Brownlee', id: '@mkbhd', blockedAt: now }],
    blockedKeywords: [{ keyword: 'gaming', addedAt: now }, { keyword: 'minecraft', addedAt: now }],
    disabledSynonyms: [],
    categoryTags: { gaming: ['veritasium'] },
    categoryTagExclusions: {}
  });
}

async function setStrict(on) {
  const { settings } = await h.getStorage(['settings']);
  await h.setStorage({ settings: Object.assign({}, settings, { strictModeEnabled: on, strictModePasswordHash: on ? HASH : '' }) });
}

// Answers the page's dialogs from a plan: 'dismiss', 'accept' or { text }
// (accept a prompt with that text). Records every dialog seen.
function dialogs(page) {
  const seen = [];
  let plan = [];
  page.on('dialog', async d => {
    seen.push({ type: d.type(), message: d.message() });
    const step = plan.shift();
    try {
      if (step && typeof step === 'object') await d.accept(step.text);
      else if (step === 'accept') await d.accept();
      else await d.dismiss();
    } catch (e) { /* page closed */ }
  });
  return {
    seen,
    plan(steps) { plan = steps.slice(); seen.length = 0; }
  };
}

// Polls storage until check(storage) is true (or `ms` passes); returns it.
async function storageWhen(keys, check, ms) {
  const deadline = Date.now() + (ms || 5000);
  let s = await h.getStorage(keys);
  while (!check(s) && Date.now() < deadline) {
    await h.sleep(250);
    s = await h.getStorage(keys);
  }
  return s;
}

async function openExtensionPage(file) {
  const errors = [];
  const page = await h.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await h.withTimeout(
    page.goto(`chrome-extension://${h.getExtensionId()}/${file}`, { waitUntil: 'domcontentloaded', timeout: 15000 }),
    17000, 'open ' + file
  );
  await h.sleep(800);
  return { page, errors };
}

function click(page, selector, label) {
  return h.withTimeout(page.locator(selector).first().click({ timeout: 8000 }), 10000, label || ('click ' + selector));
}

function clickIn(page, rowSelector, text, buttonSelector, label) {
  return h.withTimeout(
    page.locator(rowSelector, { hasText: text }).first().locator(buttonSelector).click({ timeout: 8000 }),
    10000, label
  );
}

const names = list => (list || []).map(x => x.name || x.keyword);

async function popupScenario() {
  const r = { name: 'popup asks once for the password', pass: false, reasons: [], steps: {} };
  const { page, errors } = await openExtensionPage('popup.html');
  const d = dialogs(page);
  try {
    await click(page, '.tab[data-tab="blocked"]', 'open Blocked tab');
    await h.sleep(300);

    d.plan(['dismiss']);
    await clickIn(page, '.list-item', 'Drama Daily', '.list-item-remove', 'remove channel (cancel)');
    await h.sleep(1200);
    let s = await h.getStorage(['blockedChannels']);
    r.steps.cancel = { dialogs: d.seen.slice(), channels: names(s.blockedChannels) };
    if (d.seen.length !== 1 || d.seen[0].type !== 'prompt' || !/enter password/i.test(d.seen[0].message)) r.reasons.push('cancel: expected one password prompt, got ' + JSON.stringify(d.seen));
    if (!names(s.blockedChannels).includes('Drama Daily')) r.reasons.push('cancel removed the channel');

    d.plan([{ text: 'wrong password' }, 'accept']);
    await clickIn(page, '.list-item', 'Drama Daily', '.list-item-remove', 'remove channel (wrong)');
    await h.sleep(1200);
    s = await h.getStorage(['blockedChannels']);
    r.steps.wrong = { dialogs: d.seen.slice(), channels: names(s.blockedChannels) };
    if (d.seen.length !== 2 || d.seen[1].type !== 'alert' || d.seen[1].message !== 'Wrong password.') r.reasons.push('wrong: expected prompt + "Wrong password." alert, got ' + JSON.stringify(d.seen));
    if (!names(s.blockedChannels).includes('Drama Daily')) r.reasons.push('wrong password removed the channel');

    d.plan([{ text: PASSWORD }]);
    await clickIn(page, '.list-item', 'Drama Daily', '.list-item-remove', 'remove channel (right)');
    s = await storageWhen(['blockedChannels'], x => !names(x.blockedChannels).includes('Drama Daily'));
    r.steps.right = { dialogs: d.seen.slice(), channels: names(s.blockedChannels) };
    if (d.seen.length !== 1) r.reasons.push('right: expected exactly one prompt, got ' + JSON.stringify(d.seen));
    if (names(s.blockedChannels).includes('Drama Daily')) r.reasons.push('right password did not remove the channel');

    d.plan([]);
    await h.sleep(500);
    await clickIn(page, '.list-item', 'minecraft', '.list-item-remove', 'remove keyword (remembered)');
    s = await storageWhen(['blockedKeywords'], x => !names(x.blockedKeywords).includes('minecraft'));
    r.steps.keywordRemembered = { dialogs: d.seen.slice(), keywords: names(s.blockedKeywords) };
    if (d.seen.length !== 0) r.reasons.push('keyword removal asked again: ' + JSON.stringify(d.seen));
    if (names(s.blockedKeywords).includes('minecraft')) r.reasons.push('keyword not removed with the remembered password');

    await click(page, '.tab[data-tab="controls"]', 'open Controls tab');
    await h.sleep(300);
    await click(page, '#tab-controls .toggle-switch.active', 'Hide Shorts off');
    s = await storageWhen(['settings'], x => x.settings.hideShorts === false);
    r.steps.hideShortsRemembered = { dialogs: d.seen.slice(), hideShorts: s.settings.hideShorts };
    if (d.seen.length !== 0) r.reasons.push('Hide Shorts off asked again: ' + JSON.stringify(d.seen));
    if (s.settings.hideShorts !== false) r.reasons.push('Hide Shorts not turned off with the remembered password');
  } finally {
    await page.close().catch(() => {});
  }

  // A new popup does not remember the password
  const second = await openExtensionPage('popup.html');
  const d2 = dialogs(second.page);
  try {
    await click(second.page, '.tab[data-tab="blocked"]', 'open Blocked tab (new popup)');
    await h.sleep(300);
    d2.plan(['dismiss']);
    await click(second.page, '.category-chip.active', 'remove Gaming topic');
    await h.sleep(1200);
    const s = await h.getStorage(['blockedKeywords']);
    r.steps.newPopup = { dialogs: d2.seen.slice(), keywords: names(s.blockedKeywords) };
    if (d2.seen.length !== 1 || d2.seen[0].type !== 'prompt') r.reasons.push('new popup: expected a password prompt, got ' + JSON.stringify(d2.seen));
    if (!names(s.blockedKeywords).includes('gaming')) r.reasons.push('new popup removed the topic without the password');
  } finally {
    await second.page.close().catch(() => {});
  }
  const allErrors = errors.concat(second.errors);
  if (allErrors.length) r.reasons.push('console/page errors: ' + allErrors.join(' | '));
  r.pass = r.reasons.length === 0;
  return r;
}

async function optionsScenario() {
  const r = { name: 'options: import, untag, synonym, strict switch', pass: false, reasons: [], steps: {} };
  const { page, errors } = await openExtensionPage('options.html');
  const d = dialogs(page);
  try {
    // 1. A backup that removes blocks: password asked; cancel imports nothing
    d.plan(['accept', 'dismiss']);
    const backup = { blockedChannels: [], blockedKeywords: [] };
    await h.withTimeout(page.setInputFiles('#importInput', {
      name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup))
    }), 10000, 'choose backup file');
    await h.sleep(1500);
    let s = await h.getStorage(['blockedKeywords', 'blockedChannels']);
    r.steps.importCancelled = { dialogs: d.seen.slice(), keywords: names(s.blockedKeywords), channels: names(s.blockedChannels) };
    const types = d.seen.map(x => x.type).join(',');
    if (types !== 'confirm,prompt') r.reasons.push('import: expected confirm then password prompt and no alert, got ' + JSON.stringify(d.seen));
    if (!names(s.blockedKeywords).includes('gaming') || !names(s.blockedChannels).includes('Marques Brownlee')) r.reasons.push('cancelled import changed blocks');

    // 2. Untag (Task 7's Options button): one prompt, right password
    await click(page, '.nav-item[data-section="topics"]', 'open Topics');
    await h.sleep(300);
    await click(page, GAMING_ROW + ' .category-name', 'open Gaming');
    await h.sleep(300);
    d.plan([{ text: PASSWORD }]);
    await click(page, '.autotag-list .list-item-undo', 'Untag veritasium');
    s = await storageWhen(['categoryTags', 'categoryTagExclusions'], x => !((x.categoryTags || {}).gaming || []).includes('veritasium'));
    r.steps.untag = { dialogs: d.seen.slice(), categoryTags: s.categoryTags, exclusions: s.categoryTagExclusions };
    if (d.seen.length !== 1 || d.seen[0].type !== 'prompt') r.reasons.push('untag: expected one password prompt, got ' + JSON.stringify(d.seen));
    if (((s.categoryTags || {}).gaming || []).includes('veritasium')) r.reasons.push('untag did not untag with the right password');

    // 3. Disabling a synonym: password remembered, nothing asked
    d.plan([]);
    await h.sleep(500);
    await click(page, GAMING_ROW + ' .synonym-chip.active >> nth=1', 'disable a Gaming synonym');
    s = await storageWhen(['disabledSynonyms'], x => (x.disabledSynonyms || []).length === 1);
    r.steps.synonymRemembered = { dialogs: d.seen.slice(), disabledSynonyms: s.disabledSynonyms };
    if (d.seen.length !== 0) r.reasons.push('synonym asked again: ' + JSON.stringify(d.seen));
    if ((s.disabledSynonyms || []).length !== 1) r.reasons.push('synonym not disabled with the remembered password');

    // 4. Strict switch, free user: asks for the password, turns it off, no payment page
    await click(page, '.nav-item[data-section="settings"]', 'open Settings');
    await h.sleep(300);
    const pagesBeforeSwitch = page.context().pages().length;
    const strictRow = page.locator('.toggle-item', { hasText: 'Strict mode' }).first();
    const lockedClass = await h.withTimeout(strictRow.locator('.toggle-switch').getAttribute('class'), 5000, 'strict switch class');
    d.plan([{ text: PASSWORD }]);
    await h.withTimeout(strictRow.locator('.toggle-switch').click({ timeout: 8000 }), 10000, 'click Strict switch');
    s = await storageWhen(['settings'], x => x.settings.strictModeEnabled === false);
    await h.sleep(800);
    r.steps.strictSwitch = { switchClass: lockedClass, dialogs: d.seen.slice(), strictModeEnabled: s.settings.strictModeEnabled,
      newPages: page.context().pages().length - pagesBeforeSwitch };
    if (/\blocked\b/.test(lockedClass)) r.reasons.push('strict switch shows the Pro lock while strict mode is on: ' + lockedClass);
    if (d.seen.length !== 1 || !/disable/i.test(d.seen[0].message)) r.reasons.push('strict switch: expected the disable-password prompt, got ' + JSON.stringify(d.seen));
    if (s.settings.strictModeEnabled !== false) r.reasons.push('strict mode not turned off with the password (free user)');
    if (r.steps.strictSwitch.newPages !== 0) r.reasons.push('a new page (payment?) opened');
  } finally {
    await page.close().catch(() => {});
  }
  if (errors.length) r.reasons.push('console/page errors: ' + errors.join(' | '));
  r.pass = r.reasons.length === 0;
  return r;
}

// Free user, strict mode off: a backup with strict mode on is imported without it.
async function importGateScenario() {
  const r = { name: "options: a free user's import cannot turn Strict Mode on", pass: false, reasons: [], steps: {} };
  const cases = [
    ['auto', 'Strict Mode is a Pro feature and was not imported.'],
    ['it', 'La modalità rigorosa è una funzione Pro e non è stata importata.']
  ];
  for (const [language, note] of cases) {
    await setStrict(false);
    const { settings } = await h.getStorage(['settings']);
    await h.setStorage({ settings: Object.assign({}, settings, { language, hideShorts: false }), blockedKeywords: [{ keyword: 'minecraft', addedAt: Date.now() }] });
    const { page, errors } = await openExtensionPage('options.html');
    const d = dialogs(page);
    try {
      d.plan(['accept', 'accept']); // the replace confirm, then the result alert (the page reloads)
      const backup = {
        blockedKeywords: [{ keyword: 'minecraft', addedAt: 1 }, { keyword: 'news', addedAt: 2 }],
        settings: { hideShorts: true, strictModeEnabled: true, strictModePasswordHash: HASH }
      };
      await h.withTimeout(page.setInputFiles('#importInput', {
        name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup))
      }), 10000, 'choose backup file');
      await storageWhen(['blockedKeywords'], x => names(x.blockedKeywords).includes('news'));
      await h.sleep(1200);
      const s = await h.getStorage(['settings', 'blockedKeywords']);
      r.steps[language] = { dialogs: d.seen.slice(), strictModeEnabled: s.settings.strictModeEnabled,
        hash: s.settings.strictModePasswordHash, hideShorts: s.settings.hideShorts, keywords: names(s.blockedKeywords) };
      const alertMsg = (d.seen.find(x => x.type === 'alert') || {}).message || '';
      if (!alertMsg.includes(note)) r.reasons.push(`${language}: alert "${alertMsg}" lacks "${note}"`);
      if (s.settings.strictModeEnabled !== false) r.reasons.push(language + ': strict mode was turned on by the import');
      if (s.settings.strictModePasswordHash) r.reasons.push(language + ': a password hash was imported');
      if (s.settings.hideShorts !== true) r.reasons.push(language + ": the backup's other settings were not imported");
      if (!names(s.blockedKeywords).includes('news')) r.reasons.push(language + ": the backup's blocks were not imported");
    } finally {
      await page.close().catch(() => {});
    }
    if (errors.length) r.reasons.push(language + ' console/page errors: ' + errors.join(' | '));
  }
  // Later scenarios read English copy: put the language back
  const { settings: after } = await h.getStorage(['settings']);
  await h.setStorage({ settings: Object.assign({}, after, { language: 'auto' }) });
  r.pass = r.reasons.length === 0;
  return r;
}

// Content world: state of the masthead pause switch.
const PAUSE_STATE = `(() => {
  const sw = document.getElementById('cleanfeed-pause-toggle');
  return sw ? { exists: true, on: sw.classList.contains('cf-on'), locked: sw.classList.contains('cleanfeed-strict-locked'),
    ariaDisabled: sw.getAttribute('aria-disabled'), title: sw.title,
    paused: document.body.classList.contains('cleanfeed-paused') } : { exists: false };
})()`;
const TOAST_TEXTS = `Array.from(document.querySelectorAll('.cleanfeed-toast-text')).map(e => e.textContent)`;

async function waitForContent(cs, expression, check, ms) {
  const deadline = Date.now() + (ms || 8000);
  let v = await cs.evaluate(expression);
  while (!check(v) && Date.now() < deadline) {
    await h.sleep(300);
    v = await cs.evaluate(expression);
  }
  return v;
}

async function youtubeScenario() {
  const r = { name: 'YouTube: on-page controls locked, live', pass: false, reasons: [], steps: {} };
  await setStrict(true);
  const page = await h.newPage();
  try {
    await h.gotoYouTube(page, 'https://www.youtube.com/');
    const cs = await h.attachContentWorld(page);
    await h.waitForFilter(page); // let the first render settle (it re-injects the switch)
    let p = await waitForContent(cs, PAUSE_STATE, v => v.exists, 15000);
    r.steps.lockedOnLoad = p;
    if (!p.exists || !p.locked || p.ariaDisabled !== 'true' || p.title !== LOCKED_TITLE || !p.on) r.reasons.push('pause switch not locked on load: ' + JSON.stringify(p));

    // force: Playwright never clicks an aria-disabled control, a user can
    await h.withTimeout(page.locator('#cleanfeed-pause-toggle').click({ timeout: 8000, force: true }), 10000, 'click locked pause');
    await h.sleep(800);
    p = await cs.evaluate(PAUSE_STATE);
    const toasts = await cs.evaluate(TOAST_TEXTS);
    r.steps.clickLocked = { pause: p, toasts };
    if (p.paused) r.reasons.push('locked pause switch paused the page');
    if (!toasts.some(t => t.startsWith(LOCKED_TITLE))) r.reasons.push('no "Locked by Strict Mode" toast: ' + JSON.stringify(toasts));

    await setStrict(false);
    p = await waitForContent(cs, PAUSE_STATE, v => v.exists && !v.locked);
    r.steps.unlockedLive = p;
    if (!p.exists || p.locked) r.reasons.push('pause switch still locked after strict mode was turned off: ' + JSON.stringify(p));
    await h.withTimeout(page.locator('#cleanfeed-pause-toggle').click({ timeout: 8000 }), 10000, 'click unlocked pause');
    p = await waitForContent(cs, PAUSE_STATE, v => v.paused);
    r.steps.pausedWhenUnlocked = p;
    if (!p.paused) r.reasons.push('pause did not work with strict mode off');

    await setStrict(true);
    p = await waitForContent(cs, PAUSE_STATE, v => v.exists && v.locked && !v.paused);
    r.steps.relockedLive = p;
    if (!p.exists || !p.locked || p.paused || !p.on) r.reasons.push('turning strict mode on did not resume filtering and lock the switch: ' + JSON.stringify(p));

    // Auto-tagged channel page: peek switch and Untag locked
    await h.gotoYouTube(page, TAGGED_CHANNEL_URL);
    const ch = await waitForContent(cs, `(() => {
      const peek = document.querySelector('.cleanfeed-channel-peek-btn');
      const untag = document.querySelector('.cleanfeed-autotag-banner button');
      const info = el => el ? { locked: el.classList.contains('cleanfeed-strict-locked'), title: el.title, ariaDisabled: el.getAttribute('aria-disabled') } : null;
      return { channel: YT.getPageChannelName(), peek: info(peek), untag: info(untag) };
    })()`, v => v.peek && v.untag, 15000);
    r.steps.taggedChannel = ch;
    for (const key of ['peek', 'untag']) {
      const c = ch[key];
      if (!c || !c.locked || c.title !== LOCKED_TITLE || c.ariaDisabled !== 'true') r.reasons.push(key + ' not locked on the auto-tagged channel page: ' + JSON.stringify(ch));
    }
    if (ch.untag) {
      await h.withTimeout(page.locator('.cleanfeed-autotag-banner button').click({ timeout: 8000, force: true }), 10000, 'click locked Untag');
      await h.sleep(1500);
      const { categoryTags } = await h.getStorage(['categoryTags']);
      r.steps.taggedChannel.tagsAfterClick = categoryTags;
      if (!((categoryTags || {}).gaming || []).includes('veritasium')) r.reasons.push('locked Untag untagged the channel');
    }

    // Blocked channel page: "Show just now" locked
    await h.gotoYouTube(page, BLOCKED_CHANNEL_URL);
    const blocked = await waitForContent(cs, `(() => {
      const b = document.querySelector('#cf-channel-blocked-msg button');
      return { channel: YT.getPageChannelName(), banner: !!document.getElementById('cf-channel-blocked-msg'),
        button: b ? { locked: b.classList.contains('cleanfeed-strict-locked'), title: b.title, text: b.textContent } : null };
    })()`, v => v.button, 15000);
    r.steps.blockedChannel = blocked;
    if (!blocked.button || !blocked.button.locked || blocked.button.title !== LOCKED_TITLE) r.reasons.push('"Show just now" not locked: ' + JSON.stringify(blocked));
    if (blocked.button) {
      await h.withTimeout(page.locator('#cf-channel-blocked-msg button').click({ timeout: 8000, force: true }), 10000, 'click locked Show just now');
      await h.sleep(1000);
      const still = await cs.evaluate(`!!document.getElementById('cf-channel-blocked-msg')`);
      r.steps.blockedChannel.bannerAfterClick = still;
      if (!still) r.reasons.push('locked "Show just now" unblocked the channel page');
    }
    await cs.detach();
  } finally {
    await page.close().catch(() => {});
  }
  r.pass = r.reasons.length === 0;
  return r;
}

async function main() {
  const startedAt = Date.now();
  const cancelWatchdog = h.watchdog(300000);
  let report;
  try {
    await h.launch();
    const scenarios = [];
    for (const scenario of [popupScenario, optionsScenario, importGateScenario, youtubeScenario]) {
      await seed();
      try {
        scenarios.push(await scenario());
      } catch (err) {
        scenarios.push({ name: scenario.name, pass: false, reasons: [String(err && err.message || err).split('\n')[0]] });
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
