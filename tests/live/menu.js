'use strict';
// Live test for the CleanFeed items injected into YouTube's 3-dot menu
// (audit findings #0, #35 and #128).
//   node tests/live/menu.js
// Card scenarios (channel Videos tab, channel Shorts tab, search results): open
// the 3-dot menu of card 1, close it, open the menu of card 2, then click
// CleanFeed's "Not interested in this topic" item. Shorts-tab cards (and some
// Videos-tab cards) have no detectable channel name: that used to freeze the tab.
// Shorts shelf scenario (#35): on the search page open a video card's menu,
// close it, then open a Shorts shelf item's menu; it must not offer CleanFeed
// items for the earlier card. Shorts shelf items were outside any card when
// this was written; since finding #12 they are cards themselves, so their menu
// gets items for the Short. (The logged-out watch-page "More actions" menu has
// a single item, which CleanFeed never extends, so it cannot show this bug.)
// Every opened card menu must: keep the tab responsive (page.evaluate(() => 1)
// answers within 3 s, repeatedly over ~5 s); hold exactly one set of CleanFeed
// items (2 separators, 1 topic item, at most 1 block item); not remove/re-add
// them while the menu stays open. The topic panel must name card 2's video.
// The block item's channel (data-cf-channel) must be a real channel name, never
// a view count or a date: on a channel's Videos tab the cards show only "6.8M"
// and "3d ago", and the item used to block a channel named "6.8M". On the
// channel tabs (cards without a channel name) it must name the page's channel
// (YT.getPageChannelName(), "Marques Brownlee" on @mkbhd).
// Each scenario runs in a fresh browser on real logged-out YouTube. Prints a
// JSON report; exit 0 only if every scenario passes.
// Never signs in; on consent pages only "Reject all" is clicked.

const h = require('./harness');

const SEARCH_URL = 'https://www.youtube.com/results?search_query=mkbhd';
// pageChannel: the block item must name the page's channel (cards show none)
const CARD_SCENARIOS = [
  { name: 'channel page: Videos tab', url: 'https://www.youtube.com/@mkbhd/videos', pageChannel: true },
  { name: 'channel page: Shorts tab (no channel name on cards)', url: 'https://www.youtube.com/@mkbhd/shorts', pageChannel: true },
  { name: 'search results', url: SEARCH_URL }
];
// Independent of CleanFeed's own isValidChannelName: what a count or a
// relative date looks like in the English UI the tests get.
const COUNT_OR_DATE_RE = /^\s*[\d.,\s]+[KMB]?\s*$|\b(views?|subscribers?|watching|ago)\b/i;
const PROBE_TIMEOUT_MS = 3000;
const PROBE_WINDOW_MS = 5000;
const MENU_BUTTON_RE_SOURCE = '^(more actions|action menu)$';
const MARK_ATTR = 'data-cf-test-menu-btn';
const SHORTS_SHELF_ITEM = 'ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model';

// ── In-page helpers (serialized into the page by page.evaluate) ──────────

// Marks the 3-dot button of the index-th rendered, outermost video card inside
// `scope` and returns the card's title.
function markCardMenuButton({ cardSelector, scope, index, reSource, markAttr }) {
  document.querySelectorAll('[' + markAttr + ']').forEach(el => el.removeAttribute(markAttr));
  const re = new RegExp(reSource, 'i');
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return null;
  let seen = 0;
  for (const card of root.querySelectorAll(cardSelector)) {
    if (card.parentElement && card.parentElement.closest(cardSelector)) continue; // nested card
    const rect = card.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || card.classList.contains('cleanfeed-hidden')) continue;
    const btn = Array.from(card.querySelectorAll('button'))
      .find(b => re.test((b.getAttribute('aria-label') || '').trim()));
    if (!btn) continue;
    if (seen++ < (index || 0)) continue;
    btn.setAttribute(markAttr, '1');
    let title = '';
    for (const sel of ['#video-title', 'h3 a', 'h3']) {
      const el = card.querySelector(sel);
      if (el && el.textContent.trim()) { title = el.textContent.replace(/\s+/g, ' ').trim(); break; }
    }
    return { card: card.tagName.toLowerCase(), title };
  }
  return null;
}

// Scrolls the target to the middle of the viewport (away from sticky headers)
// and returns a point inside it that is not covered by another element (e.g.
// CleanFeed's own CF+ button), or { covered } naming what covers it.
function findClickPoint(selector) {
  const target = document.querySelector(selector);
  if (!target) return null;
  target.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = target.getBoundingClientRect();
  const fractions = [0.5, 0.3, 0.7, 0.15, 0.85];
  for (const fy of fractions) {
    for (const fx of fractions) {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === target || target.contains(hit))) return { x, y };
    }
  }
  const cover = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { covered: cover ? cover.tagName.toLowerCase() + (cover.id ? '#' + cover.id : '') + '.' + String(cover.className).slice(0, 60) : 'nothing (off-screen?)' };
}

// Describes every open menu popup and the CleanFeed items the user sees in it.
// Counts only shown items: items of an orphaned CleanFeed older than 1.4.0
// (no data-cf-menu-token) are hidden by content.css and only reported in
// `hiddenCf` / `legacyItems`.
function readOpenPopups() {
  const shown = el => el.getAttribute('aria-hidden') !== 'true' &&
    getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const visible = el => el.getClientRects().length > 0;
  return Array.from(document.querySelectorAll('tp-yt-iron-dropdown'))
    .filter(dd => shown(dd) && dd.querySelector('yt-sheet-view-model, ytd-menu-popup-renderer'))
    .map(dd => {
      const all = Array.from(dd.querySelectorAll('.cleanfeed-menu-item, .cleanfeed-menu-separator'));
      const cf = all.filter(visible);
      const count = sel => cf.filter(el => el.matches(sel)).length;
      return {
        separators: count('.cleanfeed-menu-separator'),
        topicItems: count('.cleanfeed-menu-item-topic'),
        blockItems: count('.cleanfeed-menu-item:not(.cleanfeed-menu-item-topic)'),
        cfTotal: cf.length,
        hiddenCf: all.length - cf.length,
        legacyItems: all.filter(el => !el.hasAttribute('data-cf-menu-token')).length,
        blockChannel: cf.filter(el => el.hasAttribute('data-cf-channel')).map(el => el.getAttribute('data-cf-channel')),
        cfText: cf.map(el => el.textContent.trim()).filter(Boolean),
        ytItems: dd.querySelectorAll('yt-list-item-view-model, ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer').length
      };
    });
}

// Marks CleanFeed's topic item inside the open popup.
function markOpenTopicItem(markAttr) {
  document.querySelectorAll('[' + markAttr + ']').forEach(el => el.removeAttribute(markAttr));
  const dd = Array.from(document.querySelectorAll('tp-yt-iron-dropdown'))
    .find(d => d.getAttribute('aria-hidden') !== 'true' && d.getClientRects().length > 0 &&
      d.querySelector('.cleanfeed-menu-item-topic'));
  if (!dd) return false;
  dd.querySelector('.cleanfeed-menu-item-topic').setAttribute(markAttr, '1');
  return true;
}

// Counts CleanFeed menu nodes added or removed anywhere in the popup container.
function startChurnCounter() {
  window.__cfMenuChurn = 0;
  if (window.__cfMenuChurnObserver) window.__cfMenuChurnObserver.disconnect();
  const isCf = n => n.nodeType === 1 && /\bcleanfeed-menu-/.test(n.className || '');
  window.__cfMenuChurnObserver = new MutationObserver(records => {
    for (const r of records) {
      for (const n of r.addedNodes) if (isCf(n)) window.__cfMenuChurn++;
      for (const n of r.removedNodes) if (isCf(n)) window.__cfMenuChurn++;
    }
  });
  window.__cfMenuChurnObserver.observe(document.querySelector('ytd-popup-container') || document.body, { childList: true, subtree: true });
  return true;
}

function readChurnCounter() {
  if (window.__cfMenuChurnObserver) window.__cfMenuChurnObserver.disconnect();
  return window.__cfMenuChurn;
}

// ── Steps ────────────────────────────────────────────────────────────────

// Calls page.evaluate(() => 1) until PROBE_WINDOW_MS has passed (at least 3
// probes, each with a PROBE_TIMEOUT_MS cap). Stops after 2 timeouts.
async function probeResponsive(page) {
  const probes = [];
  const start = Date.now();
  let timeouts = 0;
  while (probes.length < 3 || Date.now() - start < PROBE_WINDOW_MS) {
    const t0 = Date.now();
    try {
      await h.evalInPage(page, () => 1, null, PROBE_TIMEOUT_MS);
      probes.push(Date.now() - t0);
    } catch (e) {
      probes.push('timeout');
      if (++timeouts >= 2) break;
    }
    await h.sleep(1000);
  }
  return { probes, responsive: timeouts === 0 };
}

// Real mouse click on the element marked with MARK_ATTR. A late in-page
// consent dialog is rejected first (it would swallow the click).
async function clickMarked(page) {
  const selector = '[' + MARK_ATTR + '="1"]';
  await h.rejectConsentIfShown(page);
  await h.evalInPage(page, findClickPoint, selector);
  await h.sleep(400); // let lazy-loaded content settle after the scroll
  const point = await h.evalInPage(page, findClickPoint, selector);
  if (!point) throw new Error('the marked element disappeared');
  if (point.covered) throw new Error('the marked element is covered by ' + point.covered);
  await h.withTimeout(page.mouse.move(point.x, point.y, { steps: 2 }), 3000, 'hover marked element');
  await h.sleep(200);
  await h.withTimeout(page.mouse.click(point.x, point.y), 5000, 'click marked element');
}

// Opens a menu via the marked button and inspects it. `expect` is 'one-set'
// (exactly one set of CleanFeed items) or 'optional' (none, or one set).
async function openAndCheck(page, expect) {
  const out = { click: 'ok', probes: [], responsive: false, popups: [], churn: null, reasons: [] };
  try {
    await clickMarked(page);
  } catch (e) {
    out.click = String(e.message).split('\n')[0];
  }
  await h.sleep(500);
  const probe = await probeResponsive(page);
  out.probes = probe.probes;
  out.responsive = probe.responsive;
  if (!out.responsive) {
    out.reasons.push('tab stopped responding after opening the menu');
    return out;
  }
  if (out.click !== 'ok') {
    out.reasons.push('could not click the menu button: ' + out.click);
    return out;
  }
  try {
    // Idempotency: while the menu stays open, hover around inside it (YouTube
    // flips attributes, which re-runs the injector) and count CleanFeed nodes
    // that get removed or re-added. Must be 0.
    await h.evalInPage(page, startChurnCounter);
    const box = await h.evalInPage(page, () => {
      const dd = Array.from(document.querySelectorAll('tp-yt-iron-dropdown'))
        .find(d => d.getAttribute('aria-hidden') !== 'true' && d.getClientRects().length > 0);
      if (!dd) return null;
      const r = dd.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (box) {
      for (let i = 1; i <= 4; i++) {
        await h.withTimeout(page.mouse.move(box.x + box.w / 2, box.y + (box.h * i) / 5, { steps: 3 }), 3000, 'hover popup');
        await h.sleep(250);
      }
    }
    await h.sleep(800);
    out.churn = await h.evalInPage(page, readChurnCounter);
    out.popups = await h.evalInPage(page, readOpenPopups);
  } catch (e) {
    out.reasons.push('inspection failed: ' + e.message);
    return out;
  }

  if (out.popups.length !== 1) {
    out.reasons.push(`expected 1 open menu popup, found ${out.popups.length}`);
  } else {
    const p = out.popups[0];
    if (expect === 'one-set' || p.cfTotal > 0) {
      if (p.topicItems !== 1) out.reasons.push(`expected 1 topic item, found ${p.topicItems}`);
      if (p.blockItems > 1) out.reasons.push(`expected at most 1 block item, found ${p.blockItems}`);
      if (p.separators !== 2) out.reasons.push(`expected 2 separators, found ${p.separators}`);
    }
  }
  if (out.churn !== 0) out.reasons.push(`CleanFeed menu nodes were removed/re-added ${out.churn} times while the menu stayed open`);
  return out;
}

// Checks the channel named by the open menu's block item(s). `cs` is the
// CleanFeed content-script world. Returns { blockChannel, pageChannel, reasons }.
async function checkBlockChannel(cs, popup, expectPageChannel) {
  const names = (popup && popup.blockChannel) || [];
  const out = { blockChannel: names, pageChannel: null, reasons: [] };
  for (const name of names) {
    if (COUNT_OR_DATE_RE.test(name)) out.reasons.push(`the block item names a count or a date: "${name}"`);
    else if (!(await cs.evaluate(`isValidChannelName(${JSON.stringify(name)})`))) {
      out.reasons.push(`the block item names an invalid channel: "${name}"`);
    }
  }
  if (expectPageChannel) {
    out.pageChannel = await cs.evaluate('YT.isChannelPage() ? YT.getPageChannelName() : null');
    if (!out.pageChannel) out.reasons.push('no page channel on a channel page');
    else if (names.length !== 1) out.reasons.push(`expected a block item for the page channel "${out.pageChannel}", found ${names.length}`);
    else if (names[0] !== out.pageChannel) out.reasons.push(`the block item names "${names[0]}", the page channel is "${out.pageChannel}"`);
  }
  return out;
}

async function closeMenu(page) {
  await h.withTimeout(page.keyboard.press('Escape'), 3000, 'press Escape');
  await h.sleep(800);
}

// Clicks CleanFeed's "Not interested in this topic" item in the open menu and
// checks that the topic panel it opens names `expectedTitle` (i.e. the items
// act on the video whose menu was opened). Returns { panel, reason }.
async function checkTopicPanel(page, expectedTitle) {
  if (!(await h.evalInPage(page, markOpenTopicItem, MARK_ATTR))) return { panel: null, reason: 'no topic item in the open menu' };
  await clickMarked(page);
  await h.sleep(800);
  const panel = await h.evalInPage(page, () => {
    const el = document.getElementById('cleanfeed-topic-menu');
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  });
  if (!panel) return { panel, reason: 'topic panel did not open' };
  if (!expectedTitle || !panel.includes(expectedTitle.slice(0, 25))) {
    return { panel, reason: `topic panel names the wrong video (expected "${expectedTitle}")` };
  }
  return { panel, reason: null };
}

// ── Scenarios ────────────────────────────────────────────────────────────

async function cardMenuScenario({ name, url, pageChannel }) {
  const result = { name, url, pass: false, reasons: [] };
  try {
    await h.launch();
    const page = await h.newPage();
    const nav = await h.gotoYouTube(page, url);
    result.url = nav.url;
    await h.waitForFilter(page, { settleMs: 3000 });
    const cs = await h.attachContentWorld(page);

    for (const index of [0, 1]) {
      const label = `card ${index + 1}`;
      const target = await h.evalInPage(page, markCardMenuButton, {
        cardSelector: h.CARD_SELECTOR, scope: '#primary', index, reSource: MENU_BUTTON_RE_SOURCE, markAttr: MARK_ATTR
      });
      if (!target) throw new Error(`${label}: no video card with a 3-dot menu button found`);
      const check = Object.assign({ target }, await openAndCheck(page, 'one-set'));
      result[label] = check;
      result.reasons.push(...check.reasons.map(r => `${label}: ${r}`));
      if (!check.responsive) throw new Error(`${label}: tab frozen`);
      if (check.popups.length === 1) {
        const channel = await checkBlockChannel(cs, check.popups[0], pageChannel);
        check.pageChannel = channel.pageChannel;
        result.reasons.push(...channel.reasons.map(r => `${label}: ${r}`));
      }
      if (index === 0) await closeMenu(page);
    }

    // The items in card 2's menu must act on card 2 (not on card 1).
    const topic = await checkTopicPanel(page, result['card 2'].target.title);
    result.topicPanel = topic.panel;
    if (topic.reason) result.reasons.push(topic.reason);
    result.pass = result.reasons.length === 0;
  } catch (err) {
    result.reasons.push(String(err && err.message || err).split('\n')[0]);
  } finally {
    await h.close();
  }
  return result;
}

// Opens a video card's menu, closes it, then opens the menu of a search-result
// Shorts shelf item (a CleanFeed card since finding #12). That menu must not
// offer CleanFeed items for the previously clicked card: either no items, or
// items whose topic panel names the Short itself.
async function shortsShelfScenario() {
  const result = { name: 'search results: Shorts shelf menu after a video card menu', url: SEARCH_URL, pass: false, reasons: [] };
  try {
    await h.launch();
    const page = await h.newPage();
    const nav = await h.gotoYouTube(page, SEARCH_URL);
    result.url = nav.url;
    await h.waitForFilter(page, { settleMs: 3000 });

    const cardTarget = await h.evalInPage(page, markCardMenuButton, {
      cardSelector: h.CARD_SELECTOR, scope: '#primary', index: 0, reSource: MENU_BUTTON_RE_SOURCE, markAttr: MARK_ATTR
    });
    if (!cardTarget) throw new Error('no video card with a 3-dot menu button found');
    result.card = Object.assign({ target: cardTarget }, await openAndCheck(page, 'one-set'));
    result.reasons.push(...result.card.reasons.map(r => 'video card menu: ' + r));
    if (!result.card.responsive) throw new Error('tab frozen after the video card menu');
    await closeMenu(page);

    const shelfTarget = await h.evalInPage(page, markCardMenuButton, {
      cardSelector: SHORTS_SHELF_ITEM, scope: '#primary', index: 0, reSource: MENU_BUTTON_RE_SOURCE, markAttr: MARK_ATTR
    });
    if (!shelfTarget) throw new Error('no Shorts shelf item with a 3-dot menu button on the search page');
    result.shelf = Object.assign({ target: shelfTarget }, await openAndCheck(page, 'optional'));
    result.reasons.push(...result.shelf.reasons.map(r => 'Shorts shelf menu: ' + r));
    const shelfPopup = result.shelf.popups[0];
    if (shelfPopup && shelfPopup.cfTotal > 0) {
      const topic = await checkTopicPanel(page, shelfTarget.title);
      result.topicPanel = topic.panel;
      if (topic.reason) result.reasons.push('Shorts shelf menu: ' + topic.reason);
    }
    result.pass = result.reasons.length === 0;
  } catch (err) {
    result.reasons.push(String(err && err.message || err).split('\n')[0]);
  } finally {
    await h.close();
  }
  return result;
}

async function main() {
  const startedAt = Date.now();
  const cancelWatchdog = h.watchdog(420000);
  const scenarios = [];
  for (const s of CARD_SCENARIOS) scenarios.push(await cardMenuScenario(s));
  scenarios.push(await shortsShelfScenario());
  cancelWatchdog();

  const report = {
    ok: scenarios.every(s => s.pass),
    summary: scenarios.map(s => `${s.pass ? 'PASS' : 'FAIL'} ${s.name}${s.pass ? '' : ': ' + s.reasons.join('; ')}`),
    scenarios,
    elapsedMs: Date.now() - startedAt
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) main();

// Reused by tests/live/categories.js (the topic panel opens from this 3-dot
// flow) and tests/live/reinject.js (menus next to an orphaned v1.3.2)
module.exports = {
  MARK_ATTR, MENU_BUTTON_RE_SOURCE, SHORTS_SHELF_ITEM, markCardMenuButton, markOpenTopicItem, clickMarked, closeMenu, openAndCheck
};
