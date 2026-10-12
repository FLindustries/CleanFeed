'use strict';
// Live test: CleanFeed works right after an install / update, and an orphaned
// content script handles its dead extension context (audit findings #16, #46).
//   node tests/live/reinject.js        (about 1 min)
// Loads a temporary copy of the extension (scenario 2 changes it), blocks
// "minecraft" and opens a YouTube search for it. Scenario 3 runs in a fresh
// browser.
// 1. Update: chrome.runtime.reload() from the service worker, no page reload.
//    The open tab must get a new CleanFeed instance (new marker on <html>)
//    that filters again, with exactly one set of CleanFeed UI (one pause
//    switch, at most one CF+ button per card, one pre-hide style, no toast),
//    one set of CleanFeed items in a 3-dot menu, no second instance when the
//    same scripts are injected again, and filtering after an SPA navigation
//    to another search (finding #46: it used to stop there).
// 2. Dead context: the copy's background stops injecting (as if injection
//    failed in that tab), then reload again. The orphaned instance must stop
//    by itself: every CleanFeed element, hidden card and marker goes, one
//    toast says "CleanFeed was updated — reload this page", and a 3-dot menu
//    gets no CleanFeed items.
// 3. Upgrade from v1.3.2 (git 851fb22), the path real users take: v1.3.2 runs
//    the tab, this version is copied over it and reloaded. Same checks as 1
//    (v1.3.2 sets no marker and keeps running next to the new instance).
// Prints a JSON report; exit 0 only if every scenario passes.
// Never signs in; on consent pages only "Reject all" is clicked.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const h = require('./harness');
const menu = require('./menu');

// The v1.3.2 snapshot: the version users update from (it sets no page marker
// and has no teardown, so its orphan keeps running next to the new instance).
const V132_COMMIT = '851fb22';

const SEARCH_URL = 'https://www.youtube.com/results?search_query=minecraft';
const SPA_QUERY = 'minecraft house';
const MARKER_ATTR = 'data-cleanfeed-instance';
const RELOAD_NOTICE = 'CleanFeed was updated — reload this page';
const NO_INJECTION_LINE = '    await injectIntoOpenYouTubeTabs();';
// The files package.sh ships: the extension as users get it.
const EXTENSION_FILES = ['manifest.json', 'background.js', 'features.js', 'content.js', 'content-dom.js', 'storage.js',
  'popup.html', 'popup.js', 'options.html', 'options.js', 'strict-client.js', 'styles', 'icons', 'lib', '_locales'];

function emptyDir(name) {
  const dir = path.join(os.tmpdir(), `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The extension as in the working tree, written into `dir` (over what is there).
function copyExtension(dir) {
  for (const name of EXTENSION_FILES) {
    fs.cpSync(path.join(h.REPO_ROOT, name), path.join(dir, name), { recursive: true });
  }
  return dir;
}

// The extension as v1.3.2 shipped it (git), written into `dir`.
function writeV132Extension(dir) {
  const git = (args, encoding) => execFileSync('git', args, { cwd: h.REPO_ROOT, encoding, maxBuffer: 64 * 1024 * 1024 });
  const files = git(['ls-tree', '-r', '--name-only', V132_COMMIT, '--', ...EXTENSION_FILES], 'utf8').split('\n').filter(Boolean);
  for (const file of files) {
    const out = path.join(dir, file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, git(['show', `${V132_COMMIT}:${file}`], 'buffer'));
  }
  return dir;
}

// ── In-page probes (main world: the DOM is shared with CleanFeed) ────────

function snapshot({ cardSelector, markerAttr, knownTitles }) {
  const cards = Array.from(document.querySelectorAll(cardSelector));
  const titleOf = c => { const t = c.querySelector('#video-title, h3'); return t ? t.textContent.replace(/\s+/g, ' ').trim() : ''; };
  const known = new Set(knownTitles || []);
  const newHidden = cards.filter(c => c.classList.contains('cleanfeed-hidden')).map(titleOf).filter(t => t && !known.has(t));
  const isUi = el => (el.id && /^(cleanfeed-|cf-channel-blocked-msg$)/.test(el.id)) ||
    Array.from(el.classList).some(c => c === 'cf-switch' ||
      (c.startsWith('cleanfeed-') && !['cleanfeed-hidden', 'cleanfeed-relevant-hidden', 'cleanfeed-hide-shorts',
        'cleanfeed-hide-comments', 'cleanfeed-paused', 'cleanfeed-time-limit-reached'].includes(c)));
  const ui = Array.from(document.querySelectorAll('[id^="cleanfeed-"], #cf-channel-blocked-msg, .cf-switch, [class*="cleanfeed-"]')).filter(isUi);
  const toasts = Array.from(document.querySelectorAll('.cleanfeed-toast'));
  const hiddenCard = cards.find(c => c.classList.contains('cleanfeed-hidden'));
  return {
    url: location.pathname + location.search,
    marker: document.documentElement.getAttribute(markerAttr),
    cards: cards.length,
    hiddenCards: cards.filter(c => c.classList.contains('cleanfeed-hidden')).length,
    hiddenAnything: document.querySelectorAll('.cleanfeed-hidden').length,
    // hidden cards whose title is not in knownTitles (e.g. new search results)
    newHiddenTitles: newHidden.length,
    newHiddenSample: newHidden.slice(0, 3),
    checkedMarkers: document.querySelectorAll('[data-cf-checked]').length,
    pauseSwitches: document.querySelectorAll('#cleanfeed-pause-toggle').length,
    prehideStyles: document.querySelectorAll('style#cleanfeed-prehide').length,
    quickAddButtons: document.querySelectorAll('.cleanfeed-quickadd-btn').length,
    maxQuickAddPerCard: Math.max(0, ...cards.map(c => c.querySelectorAll(':scope > .cleanfeed-quickadd-btn').length)),
    uiElements: ui.length,
    uiNotToast: ui.filter(el => !el.closest('.cleanfeed-toast')).map(el => el.id || el.className).slice(0, 10),
    toasts: toasts.map(t => ({
      text: t.textContent.replace(/\s+/g, ' ').trim(),
      position: getComputedStyle(t).position
    })),
    // Is content.css still applied (a hidden card has display:none)?
    hiddenCardDisplay: hiddenCard ? getComputedStyle(hiddenCard).display : null
  };
}

// CleanFeed items in the open 3-dot menu, or null when no menu is open.
function openMenuItems() {
  const dd = Array.from(document.querySelectorAll('tp-yt-iron-dropdown'))
    .find(d => d.getAttribute('aria-hidden') !== 'true' && d.getClientRects().length > 0 &&
      d.querySelector('yt-sheet-view-model, ytd-menu-popup-renderer'));
  if (!dd) return null;
  return {
    topicItems: dd.querySelectorAll('.cleanfeed-menu-item-topic').length,
    separators: dd.querySelectorAll('.cleanfeed-menu-separator').length,
    cfTotal: dd.querySelectorAll('.cleanfeed-menu-item, .cleanfeed-menu-separator').length
  };
}

const probe = (page, knownTitles) => h.evalInPage(page, snapshot, { cardSelector: h.CARD_SELECTOR, markerAttr: MARKER_ATTR, knownTitles });

// Titles of every video card in the page.
const cardTitles = page => h.evalInPage(page, sel => Array.from(document.querySelectorAll(sel), c => {
  const t = c.querySelector('#video-title, h3');
  return t ? t.textContent.replace(/\s+/g, ' ').trim() : '';
}).filter(Boolean), h.CARD_SELECTOR);

async function waitFor(page, label, check, ms, knownTitles) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe(page, knownTitles);
    if (check(last)) return { ok: true, snap: last };
    await h.sleep(250);
  }
  return { ok: false, snap: last, label };
}

// Opens the 3-dot menu of the first visible card and returns its CleanFeed items.
async function menuItems(page) {
  const target = await h.evalInPage(page, menu.markCardMenuButton, {
    cardSelector: h.CARD_SELECTOR, scope: '#primary', index: 0, reSource: menu.MENU_BUTTON_RE_SOURCE, markAttr: menu.MARK_ATTR
  });
  if (!target) return { error: 'no visible card with a 3-dot menu button' };
  try {
    await menu.clickMarked(page);
  } catch (e) {
    return { error: 'could not click the menu button: ' + e.message };
  }
  await h.sleep(1200);
  const items = await h.evalInPage(page, openMenuItems);
  await menu.closeMenu(page);
  return items || { error: 'no menu opened' };
}

// ── Scenarios ────────────────────────────────────────────────────────────

// Reloads the extension (files already in place) and checks the open tab.
async function updateScenario(page, before, name) {
  const result = { name, pass: false, reasons: [] };
  result.reloadMs = await h.reloadExtension();
  const started = Date.now();
  const taken = await waitFor(page, 'new marker', s => s.marker && s.marker !== before.marker, 15000);
  result.newInstanceAfterMs = Date.now() - started;
  if (!taken.ok) {
    result.reasons.push('no new CleanFeed instance took the page over (marker unchanged)');
    result.after = taken.snap;
    return result;
  }
  await h.sleep(3000); // longer than the orphan's grace period (1.5 s)
  const after = await probe(page);
  result.after = after;
  if (after.hiddenCards === 0) result.reasons.push('the new instance hides nothing');
  if (after.pauseSwitches !== 1) result.reasons.push(`expected 1 pause switch, found ${after.pauseSwitches}`);
  if (after.prehideStyles !== 1) result.reasons.push(`expected 1 pre-hide style, found ${after.prehideStyles}`);
  if (after.maxQuickAddPerCard > 1) result.reasons.push(`a card holds ${after.maxQuickAddPerCard} CF+ buttons`);
  if (after.toasts.length !== 0) result.reasons.push('unexpected toast: ' + JSON.stringify(after.toasts));

  result.menu = await menuItems(page);
  if (result.menu.error) result.reasons.push('3-dot menu: ' + result.menu.error);
  else if (result.menu.topicItems !== 1 || result.menu.separators !== 2) {
    result.reasons.push('3-dot menu does not hold exactly one set of CleanFeed items: ' + JSON.stringify(result.menu));
  }

  // The same extension instance injected again (as when the manifest and
  // background.js both reach a loading tab): it must not start a second time.
  result.secondInjection = await h.getServiceWorker().then(sw => h.withTimeout(sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['features.js', 'content-dom.js', 'content.js'] });
      return 'injected';
    } catch (e) {
      return 'executeScript failed: ' + e.message;
    }
  }), 8000, 'second injection'));
  await h.sleep(1500);
  const again = await probe(page);
  result.afterSecondInjection = { marker: again.marker, pauseSwitches: again.pauseSwitches, prehideStyles: again.prehideStyles, maxQuickAddPerCard: again.maxQuickAddPerCard };
  if (again.marker !== after.marker) result.reasons.push('a second injection started a new instance');
  if (again.pauseSwitches !== 1 || again.prehideStyles !== 1 || again.maxQuickAddPerCard > 1) {
    result.reasons.push('a second injection duplicated UI: ' + JSON.stringify(result.afterSecondInjection));
  }

  // SPA navigation to another search, through YouTube's own search box.
  // Cards with titles not on the first search must get hidden.
  const firstSearchTitles = await cardTitles(page);
  const box = page.locator('input[name="search_query"]').first();
  await h.withTimeout(box.fill(SPA_QUERY, { timeout: 5000 }), 7000, 'fill search box');
  await h.withTimeout(box.press('Enter', { timeout: 5000 }), 7000, 'submit search');
  const spa = await waitFor(page, 'SPA results', s => s.url.includes('minecraft+house') && s.newHiddenTitles > 0, 15000, firstSearchTitles);
  result.afterSpaNavigation = spa.snap;
  if (!spa.ok) result.reasons.push('no new result hidden after an SPA navigation to "' + SPA_QUERY + '"');
  if (spa.snap && spa.snap.marker !== after.marker) result.reasons.push('the page marker changed during SPA navigation');
  if (spa.snap && spa.snap.pauseSwitches !== 1) result.reasons.push(`after SPA navigation: ${spa.snap.pauseSwitches} pause switches`);
  if (spa.snap && spa.snap.toasts.length !== 0) result.reasons.push('after SPA navigation: unexpected toast ' + JSON.stringify(spa.snap.toasts));
  result.pass = result.reasons.length === 0;
  return result;
}

async function deadContextScenario(page, extensionDir) {
  const result = { name: 'dead context: the orphan clears the page and asks for a reload', pass: false, reasons: [] };
  const bgPath = path.join(extensionDir, 'background.js');
  const source = fs.readFileSync(bgPath, 'utf8');
  if (!source.includes(NO_INJECTION_LINE)) {
    result.reasons.push('cannot disable injection in the copy: line not found');
    return result;
  }
  fs.writeFileSync(bgPath, source.replace(NO_INJECTION_LINE, '    // live test: no injection'));

  const before = await probe(page);
  result.before = { marker: before.marker, hiddenCards: before.hiddenCards, uiElements: before.uiElements };
  result.reloadMs = await h.reloadExtension();
  await h.sleep(300);
  result.justAfterReload = await probe(page); // orphan still within its grace period
  // A user scrolling: YouTube loads more results, the orphan's observer runs
  await h.evalInPage(page, () => { window.scrollBy(0, 1500); return true; });
  const cleared = await waitFor(page, 'reload notice', s => s.toasts.some(t => t.text.includes(RELOAD_NOTICE)), 10000);
  const after = cleared.snap;
  result.after = after;
  if (!cleared.ok) {
    result.reasons.push('no reload notice appeared');
    return result;
  }
  if (after.toasts.length !== 1) result.reasons.push(`expected 1 toast, found ${after.toasts.length}`);
  if (after.toasts[0].position !== 'fixed') result.reasons.push('the reload notice is not styled (position ' + after.toasts[0].position + ')');
  if (after.marker !== before.marker) result.reasons.push('the marker changed: something new ran in the page');
  if (after.hiddenAnything !== 0) result.reasons.push(`${after.hiddenAnything} elements still hidden`);
  if (after.checkedMarkers !== 0) result.reasons.push(`${after.checkedMarkers} data-cf-checked markers left`);
  if (after.uiNotToast.length !== 0) result.reasons.push('CleanFeed UI left: ' + after.uiNotToast.join(', '));

  // More results load while scrolling: the stopped instance must leave them alone
  await h.evalInPage(page, () => { window.scrollBy(0, 2500); return true; });
  await h.sleep(2500);
  const later = await probe(page);
  result.later = later;
  if (later.hiddenAnything !== 0 || later.quickAddButtons !== 0 || later.checkedMarkers !== 0) {
    result.reasons.push('the orphan still filters after stopping: ' + JSON.stringify({
      hidden: later.hiddenAnything, quickAdd: later.quickAddButtons, checked: later.checkedMarkers
    }));
  }
  await h.evalInPage(page, () => { window.scrollTo(0, 0); return true; });
  await h.sleep(800);
  result.menu = await menuItems(page);
  if (result.menu.error) result.reasons.push('3-dot menu: ' + result.menu.error);
  else if (result.menu.cfTotal !== 0) result.reasons.push(`the stopped orphan still adds ${result.menu.cfTotal} menu items`);
  result.pass = result.reasons.length === 0;
  return result;
}

// Launches the extension from `extensionDir`, blocks "minecraft" and opens
// the search for it. Returns { page, before, setup }.
async function openBlockedSearch(extensionDir) {
  await h.launch({ extensionDir });
  await h.setStorage({ blockedKeywords: [{ keyword: 'minecraft', addedAt: Date.now() }] });
  const page = await h.newPage();
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(String(err.message).split('\n')[0]));
  const nav = await h.gotoYouTube(page, SEARCH_URL);
  await h.waitForFilter(page, { settleMs: 3000 });
  const before = await probe(page);
  const setup = { extensionId: h.getExtensionId(), headless: h.isHeadless(), url: nav.url, consentRejected: nav.consentRejected, before, pageErrors };
  return { page, before, setup };
}

// The current version: an update, then a dead context (one browser).
async function currentVersionRun(scenarios, setups) {
  const extensionDir = copyExtension(emptyDir('cleanfeed-live-ext'));
  try {
    const { page, before, setup } = await openBlockedSearch(extensionDir);
    setups.current = setup;
    if (!before.marker || before.hiddenCards === 0) {
      scenarios.push({ name: 'setup (current version)', pass: false, reasons: ['CleanFeed did not run or hid nothing before the reload'] });
      return;
    }
    scenarios.push(await updateScenario(page, before, 'update: the open tab gets a new instance without a reload'));
    scenarios.push(await deadContextScenario(page, extensionDir));
  } catch (err) {
    scenarios.push({ name: 'run (current version)', pass: false, reasons: [String(err && err.message || err).split('\n')[0]] });
  } finally {
    await h.close();
    fs.rmSync(extensionDir, { recursive: true, force: true });
  }
}

// The real upgrade path: v1.3.2 runs the tab, then this version is installed
// over it and reloaded (a fresh browser).
async function upgradeRun(scenarios, setups) {
  const extensionDir = writeV132Extension(emptyDir('cleanfeed-live-ext-v132'));
  try {
    const { page, before, setup } = await openBlockedSearch(extensionDir);
    setups.v132 = setup;
    if (before.marker || before.hiddenCards === 0 || before.prehideStyles !== 1) {
      scenarios.push({ name: 'setup (v1.3.2)', pass: false, reasons: ['v1.3.2 did not run as expected: ' + JSON.stringify(before)] });
      return;
    }
    copyExtension(extensionDir);
    scenarios.push(await updateScenario(page, before, 'upgrade from v1.3.2: the new version takes the open tab over'));
  } catch (err) {
    scenarios.push({ name: 'run (upgrade from v1.3.2)', pass: false, reasons: [String(err && err.message || err).split('\n')[0]] });
  } finally {
    await h.close();
    fs.rmSync(extensionDir, { recursive: true, force: true });
  }
}

async function main() {
  const startedAt = Date.now();
  const cancelWatchdog = h.watchdog(360000);
  const scenarios = [];
  const setups = {};
  await currentVersionRun(scenarios, setups);
  await upgradeRun(scenarios, setups);
  cancelWatchdog();
  const report = {
    ok: scenarios.length > 0 && scenarios.every(s => s.pass),
    summary: scenarios.map(s => `${s.pass ? 'PASS' : 'FAIL'} ${s.name}${s.pass ? '' : ': ' + s.reasons.join('; ')}`),
    setups,
    scenarios,
    elapsedMs: Date.now() - startedAt
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();
