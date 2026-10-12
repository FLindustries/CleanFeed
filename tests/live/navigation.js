'use strict';
// Live test: page-level decisions read only the VISIBLE YouTube page after SPA
// navigation (audit findings #11, #14, #49, #37). YouTube keeps pages visited
// earlier in the tab inside ytd-page-manager, hidden.
//   node tests/live/navigation.js
// Scenario "channel pages": open a watch page (full load), click the owner link
// (SPA) to the owner's channel, then search "veritasium" and click through to
// that channel (SPA) while the hidden watch page still shows the first owner.
// On each channel page, YT.getPageChannelName()/getPageChannelId() (evaluated
// in the content-script world) must name the channel on screen. Then block the
// channel on screen: its banner must appear and only the visible page may be
// hidden. Then click the YouTube logo (SPA): on Home isChannelPage() must be
// false, no banner or blocked-page state may remain, and the banner must never
// be rendered on Home (sampled every animation frame during the navigation).
// Scenario "blocked channel -> Home": the same Home checks after a full load of
// an already blocked channel page.
// Scenario "subscriptions toast": on a search page, a fake subscription to the
// first result's channel plus a blocked keyword from its title shows the
// "subscribed channels were affected" toast once; it must not show again after
// SPA navigation to Home and back.
// Scenario "channel tab": on /@mkbhd/videos (no handle link in the 2025
// header) getPageChannelId() is "@mkbhd" and CleanFeed's Block button stores
// "@mkbhd", not "@mkbhd/videos"; the search for "mkbhd" then has a pre-hide
// rule for /@mkbhd and hides the channel's results. A channel stored as
// "@mkbhd/videos" (older versions) blocks the same way.
// Each scenario runs in a fresh browser on real logged-out YouTube. Prints a
// JSON report; exit 0 only if every scenario passes.
// Never signs in; on consent pages only "Reject all" is clicked.

const h = require('./harness');

const SEARCH_URL = 'https://www.youtube.com/results?search_query=mkbhd';
const CHANNEL_TAB_URL = 'https://www.youtube.com/@mkbhd/videos';
const OTHER_CHANNEL_QUERY = 'veritasium';
const OTHER_CHANNEL_HANDLE = '@veritasium';
const NAV_WAIT_MS = 20000;
const MARK_ATTR = 'data-cf-test-nav-target';

// ── In-page helpers (main world, serialized by page.evaluate) ─────────────

// What the user sees: the visible page, the channel name in its header, the
// blocked-channel banner and every element CleanFeed marked as a blocked page.
function readVisiblePage() {
  const manager = document.querySelector('ytd-page-manager');
  const visible = manager ? Array.from(manager.children).find(c => /^YTD-/.test(c.tagName) && !c.hasAttribute('hidden')) : null;
  const headerName = visible ? visible.querySelector('#page-header yt-dynamic-text-view-model') : null;
  const banner = document.getElementById('cf-channel-blocked-msg');
  return {
    path: location.pathname,
    visiblePage: visible ? visible.tagName.toLowerCase() + (visible.getAttribute('page-subtype') ? '[' + visible.getAttribute('page-subtype') + ']' : '') : null,
    pages: manager ? Array.from(manager.children).map(c => c.tagName.toLowerCase() + (c.hasAttribute('hidden') ? '(hidden)' : '')) : [],
    headerName: headerName ? headerName.textContent.replace(/\s+/g, ' ').trim() : null,
    hiddenOwners: Array.from(document.querySelectorAll('ytd-watch-flexy[hidden] ytd-video-owner-renderer ytd-channel-name a'))
      .map(a => a.textContent.trim()).filter(Boolean),
    banner: !!banner,
    bannerRendered: !!banner && banner.getClientRects().length > 0,
    blocked: Array.from(document.querySelectorAll('[data-cf-blocked]')).map(el => ({
      tag: el.tagName.toLowerCase(),
      inVisiblePage: !!visible && visible.contains(el),
      cfHidden: el.classList.contains('cleanfeed-hidden')
    }))
  };
}

// Marks the first element matching `selector` that is rendered and not inside
// a hidden page, scrolls it to the middle of the viewport and returns a click
// point not covered by another element ({ covered } otherwise, null if none).
function markAndLocate({ selector, markAttr }) {
  document.querySelectorAll('[' + markAttr + ']').forEach(el => el.removeAttribute(markAttr));
  const target = Array.from(document.querySelectorAll(selector))
    .find(el => !el.closest('[hidden]') && el.getClientRects().length > 0);
  if (!target) return null;
  target.setAttribute(markAttr, '1');
  target.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = target.getBoundingClientRect();
  for (const fy of [0.5, 0.3, 0.7]) {
    for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === target || target.contains(hit))) return { x, y };
    }
  }
  return { covered: true };
}

function clickMarkedInPage(markAttr) {
  const el = document.querySelector('[' + markAttr + '="1"]');
  if (!el) return false;
  el.click();
  return true;
}

// First search result from `handle`'s channel: its channel name (as CleanFeed
// reads it: first /@ link with text) and a title word to block.
function pickToastTarget({ cardSelector, handle }) {
  const manager = document.querySelector('ytd-page-manager');
  const visible = manager && Array.from(manager.children).find(c => /^YTD-/.test(c.tagName) && !c.hasAttribute('hidden'));
  if (!visible) return null;
  for (const card of visible.querySelectorAll(cardSelector)) {
    const named = Array.from(card.querySelectorAll('a[href^="/@"]')).find(a => a.textContent.trim());
    if (!named || named.getAttribute('href').toLowerCase() !== '/' + handle) continue;
    const titleEl = card.querySelector('#video-title') || card.querySelector('h3');
    const title = titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '';
    const words = (title.toLowerCase().match(/[a-z]+/g) || [])
      .filter(w => w.length >= 5 && w !== handle.slice(1))
      .sort((a, b) => b.length - a.length);
    if (words.length === 0) continue;
    return { channel: named.textContent.trim(), title, keyword: words[0] };
  }
  return null;
}

// A fake subscription in the guide (logged out has none). CleanFeed reads
// '#guide-content a[href^="/@"]' and takes the name from the title attribute.
function addFakeSubscription({ handle, channel }) {
  const box = document.createElement('div');
  box.id = 'guide-content';
  box.hidden = true;
  box.setAttribute('data-cf-test', 'fake-subscription');
  const a = document.createElement('a');
  a.setAttribute('href', '/' + handle);
  a.setAttribute('title', channel);
  box.appendChild(a);
  document.body.appendChild(box);
  return true;
}

// Counts animation frames in which the blocked-channel banner is rendered
// while the page on screen is not a channel page (e.g. Home).
function startBannerWatch() {
  window.__cfBannerElsewhere = 0;
  const tick = () => {
    const manager = document.querySelector('ytd-page-manager');
    const visible = manager && Array.from(manager.children).find(c => /^YTD-/.test(c.tagName) && !c.hasAttribute('hidden'));
    const onChannel = !!visible && visible.getAttribute('page-subtype') === 'channels';
    const banner = document.getElementById('cf-channel-blocked-msg');
    if (!onChannel && banner && banner.getClientRects().length > 0) window.__cfBannerElsewhere++;
    window.__cfBannerRaf = requestAnimationFrame(tick);
  };
  tick();
  return true;
}

function stopBannerWatch() {
  cancelAnimationFrame(window.__cfBannerRaf);
  return window.__cfBannerElsewhere;
}

// Logs every CleanFeed toast that names `channel` in a chip.
function startToastLog(channel) {
  window.__cfToastLog = [];
  const observer = new MutationObserver(records => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || !n.classList.contains('cleanfeed-toast')) continue;
        const chips = Array.from(n.querySelectorAll('.cleanfeed-chip'), c => c.textContent.trim());
        if (chips.includes(channel)) window.__cfToastLog.push({ path: location.pathname, chips });
      }
    }
  });
  observer.observe(document.body, { childList: true });
  return true;
}

// ── Steps ────────────────────────────────────────────────────────────────

async function waitForPath(page, test, label) {
  const deadline = Date.now() + NAV_WAIT_MS;
  while (Date.now() < deadline) {
    const info = await h.evalInPage(page, readVisiblePage);
    if (test(info.path) && info.visiblePage) return info;
    await h.sleep(300);
  }
  throw new Error(`${label}: navigation did not finish (path ${await h.evalInPage(page, () => location.pathname)})`);
}

// Real mouse click on the first visible `selector` (element.click() if it is
// covered, e.g. by a late consent bump). YouTube handles both as SPA navigation.
async function clickVisible(page, selector, label) {
  await h.rejectConsentIfShown(page);
  let point = await h.evalInPage(page, markAndLocate, { selector, markAttr: MARK_ATTR });
  if (!point) throw new Error(`${label}: nothing visible matches ${selector}`);
  await h.sleep(400); // let lazy content settle after the scroll
  point = await h.evalInPage(page, markAndLocate, { selector, markAttr: MARK_ATTR });
  if (!point) throw new Error(`${label}: ${selector} disappeared`);
  if (point.covered) {
    if (!(await h.evalInPage(page, clickMarkedInPage, MARK_ATTR))) throw new Error(`${label}: ${selector} disappeared`);
    return 'element.click()';
  }
  await h.withTimeout(page.mouse.click(point.x, point.y), 5000, `${label}: click`);
  return 'mouse';
}

async function cleanFeedView(cs) {
  return cs.evaluate('({ name: YT.getPageChannelName(), id: YT.getPageChannelId(), isChannelPage: YT.isChannelPage() })');
}

function handleFromPath(path) {
  const m = path.match(/^\/(@[^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Checks that CleanFeed names the channel shown on screen.
function checkChannelPage(step, info, cf) {
  const reasons = [];
  if (!info.headerName) reasons.push(`${step}: could not read the channel name in the visible page header`);
  else if (cf.name !== info.headerName) reasons.push(`${step}: getPageChannelName() = "${cf.name}", the page shows "${info.headerName}"`);
  const handle = handleFromPath(info.path);
  if (!handle) reasons.push(`${step}: URL ${info.path} has no /@handle`);
  else if (String(cf.id).toLowerCase() !== handle.toLowerCase()) reasons.push(`${step}: getPageChannelId() = "${cf.id}", the URL says "${handle}"`);
  if (cf.isChannelPage !== true) reasons.push(`${step}: isChannelPage() = ${cf.isChannelPage}`);
  return reasons;
}

// From a blocked channel's page, clicks the YouTube logo (SPA) and checks Home:
// the banner is never rendered there (not even briefly while YouTube swaps
// the pages), isChannelPage() is false and no blocked-page state is left.
async function goHomeAndCheck(page, cs, result) {
  await h.evalInPage(page, startBannerWatch);
  result.steps.logoClick = await clickVisible(page, 'ytd-topbar-logo-renderer a#logo', 'YouTube logo');
  await waitForPath(page, p => p === '/', 'Home');
  await h.sleep(3000);
  const info = await h.evalInPage(page, readVisiblePage);
  const cf = await cleanFeedView(cs);
  const framesWithBanner = await h.evalInPage(page, stopBannerWatch);
  result.steps.home = { info, cleanFeed: cf, framesWithBannerOffChannel: framesWithBanner };
  if (framesWithBanner > 0) result.reasons.push(`Home: the blocked-channel banner was rendered in ${framesWithBanner} frame(s) off the channel page`);
  if (info.visiblePage !== 'ytd-browse[home]') result.reasons.push(`Home: unexpected visible page ${info.visiblePage}`);
  if (cf.isChannelPage !== false) result.reasons.push(`Home: isChannelPage() = ${cf.isChannelPage}`);
  if (info.banner) result.reasons.push('Home: the blocked-channel banner still exists');
  if (info.blocked.length > 0) result.reasons.push(`Home: ${info.blocked.length} element(s) still marked as a blocked channel page`);
}

// ── Scenarios ────────────────────────────────────────────────────────────

async function channelPagesScenario() {
  const result = { name: 'watch -> owner channel -> other channel (blocked) -> Home', pass: false, steps: {}, reasons: [] };
  try {
    await h.launch();
    const page = await h.newPage();

    // A watch page by Marques Brownlee, loaded in full.
    await h.gotoYouTube(page, SEARCH_URL);
    await h.waitForFilter(page);
    const watchHref = await h.evalInPage(page, () => {
      const card = Array.from(document.querySelectorAll('ytd-video-renderer'))
        .find(c => c.querySelector('a[href="/@mkbhd"]') && c.querySelector('a#video-title'));
      return card ? card.querySelector('a#video-title').getAttribute('href') : null;
    });
    if (!watchHref) throw new Error('no Marques Brownlee video found in the search results');
    await h.gotoYouTube(page, 'https://www.youtube.com' + watchHref);
    await waitForPath(page, p => p === '/watch', 'watch page');
    const cs = await h.attachContentWorld(page);
    await h.sleep(3000);

    // 1. Owner link -> the owner's channel (SPA).
    result.steps.ownerClick = await clickVisible(page, 'ytd-watch-metadata ytd-video-owner-renderer ytd-channel-name a', 'owner link');
    await waitForPath(page, p => p.startsWith('/@'), 'owner channel');
    await h.sleep(3000);
    let info = await h.evalInPage(page, readVisiblePage);
    let cf = await cleanFeedView(cs);
    result.steps.ownerChannel = { info, cleanFeed: cf };
    result.reasons.push(...checkChannelPage('owner channel', info, cf));

    // 2. Search box -> results -> a different channel (SPA). The hidden watch
    //    page still shows the first owner.
    await h.rejectConsentIfShown(page);
    const box = page.locator('input[name="search_query"]').first();
    await h.withTimeout(box.fill(OTHER_CHANNEL_QUERY, { timeout: 8000 }), 10000, 'type search');
    await h.withTimeout(box.press('Enter', { timeout: 5000 }), 8000, 'submit search');
    await waitForPath(page, p => p === '/results', 'search results');
    await h.waitForFilter(page);
    result.steps.channelLinkClick = await clickVisible(page, `a[href^="/${OTHER_CHANNEL_HANDLE}"]`, 'channel link in search results');
    await waitForPath(page, p => p.toLowerCase().startsWith('/' + OTHER_CHANNEL_HANDLE), 'other channel');
    await h.sleep(3000);
    info = await h.evalInPage(page, readVisiblePage);
    cf = await cleanFeedView(cs);
    result.steps.otherChannel = { info, cleanFeed: cf };
    if (info.hiddenOwners.length === 0) result.reasons.push('other channel: the hidden watch page was not kept in the DOM (scenario no longer exercises the bug)');
    result.reasons.push(...checkChannelPage('other channel', info, cf));

    // 3. Block the channel on screen (by the name its header shows).
    if (!info.headerName) throw new Error('cannot block the other channel: its name is unreadable');
    await h.setStorage({ blockedChannels: [{ name: info.headerName, id: handleFromPath(info.path), blockedAt: Date.now() }] });
    await h.sleep(3000);
    info = await h.evalInPage(page, readVisiblePage);
    result.steps.otherChannelBlocked = { info };
    if (!info.bannerRendered) result.reasons.push('blocked channel page: the "channel is blocked" banner is not shown');
    if (!info.blocked.some(b => b.inVisiblePage && b.cfHidden)) result.reasons.push('blocked channel page: the visible page content was not hidden');
    if (info.blocked.some(b => !b.inVisiblePage)) result.reasons.push('blocked channel page: an element outside the visible page was marked blocked');

    // 4. YouTube logo -> Home (SPA).
    await goHomeAndCheck(page, cs, result);
    await cs.detach();
    result.pass = result.reasons.length === 0;
  } catch (err) {
    result.reasons.push(String(err && err.message || err).split('\n')[0]);
  } finally {
    await h.close();
  }
  return result;
}

async function blockedChannelToHomeScenario() {
  const result = { name: 'blocked channel page (full load) -> Home', pass: false, steps: {}, reasons: [] };
  try {
    await h.launch();
    await h.setStorage({ blockedChannels: [{ name: 'Veritasium', id: OTHER_CHANNEL_HANDLE, blockedAt: Date.now() }] });
    const page = await h.newPage();
    await h.gotoYouTube(page, `https://www.youtube.com/${OTHER_CHANNEL_HANDLE}`);
    await waitForPath(page, p => p.toLowerCase().startsWith('/' + OTHER_CHANNEL_HANDLE), 'blocked channel');
    const cs = await h.attachContentWorld(page);
    await h.sleep(4000);
    const info = await h.evalInPage(page, readVisiblePage);
    result.steps.blockedChannel = { info, cleanFeed: await cleanFeedView(cs) };
    if (info.headerName !== 'Veritasium') throw new Error(`the channel header shows "${info.headerName}", expected "Veritasium" (blocked by that name)`);
    if (!info.bannerRendered) result.reasons.push('blocked channel page: the "channel is blocked" banner is not shown');
    if (!info.blocked.some(b => b.inVisiblePage && b.cfHidden)) result.reasons.push('blocked channel page: the visible page content was not hidden');

    await goHomeAndCheck(page, cs, result);
    await cs.detach();
    result.pass = result.reasons.length === 0;
  } catch (err) {
    result.reasons.push(String(err && err.message || err).split('\n')[0]);
  } finally {
    await h.close();
  }
  return result;
}

// Reads CleanFeed's pre-hide rules and the search results of `handle`.
function readHandleBlocking(handle) {
  const style = document.getElementById('cleanfeed-prehide');
  const rules = style && style.sheet ? Array.from(style.sheet.cssRules, r => r.cssText) : [];
  const cards = Array.from(document.querySelectorAll('ytd-video-renderer'))
    .filter(c => c.querySelector('a[href="/' + handle + '" i]'));
  return {
    ruleForHandle: rules.some(r => r.toLowerCase().includes('"/' + handle.toLowerCase() + '"')),
    ruleForTab: rules.some(r => r.toLowerCase().includes('/' + handle.toLowerCase() + '/')),
    cards: cards.length,
    shownCards: cards.filter(c => getComputedStyle(c).display !== 'none').length
  };
}

// Search results for "mkbhd": checks that the channel's results are blocked by handle.
async function checkSearchBlocksHandle(page, step, result) {
  await h.gotoYouTube(page, SEARCH_URL);
  await h.waitForFilter(page, { settleMs: 3000 });
  const seen = await h.evalInPage(page, readHandleBlocking, '@mkbhd');
  result.steps[step] = seen;
  if (!seen.ruleForHandle) result.reasons.push(`${step}: no pre-hide rule for /@mkbhd`);
  if (seen.ruleForTab) result.reasons.push(`${step}: a pre-hide rule still carries the channel tab`);
  if (seen.cards === 0) result.reasons.push(`${step}: no @mkbhd result to check`);
  else if (seen.shownCards > 0) result.reasons.push(`${step}: ${seen.shownCards} of ${seen.cards} @mkbhd results still shown`);
}

async function channelTabBlockScenario() {
  const result = { name: 'block from a channel tab: the handle without the tab', pass: false, steps: {}, reasons: [] };
  try {
    await h.launch();
    const page = await h.newPage();
    await h.gotoYouTube(page, CHANNEL_TAB_URL);
    await waitForPath(page, p => p.startsWith('/@mkbhd/videos'), 'channel Videos tab');
    const cs = await h.attachContentWorld(page);
    await h.sleep(3000);
    const cf = await cleanFeedView(cs);
    result.steps.channelTab = cf;
    if (cf.id !== '@mkbhd') result.reasons.push(`getPageChannelId() = "${cf.id}" on /@mkbhd/videos`);

    // CleanFeed's own Block button (not a YouTube control)
    result.steps.blockClick = await clickVisible(page, '.cleanfeed-channel-block-btn', 'Block button');
    let stored = [];
    for (let i = 0; i < 20 && stored.length === 0; i++) {
      await h.sleep(400);
      stored = (await h.getStorage(['blockedChannels'])).blockedChannels || [];
    }
    result.steps.stored = stored;
    await h.sleep(2500); // CleanFeed leaves the blocked channel's page for Home after 1.5 s
    if (stored.length !== 1) result.reasons.push(`expected 1 blocked channel, found ${stored.length}`);
    else if (stored[0].id !== '@mkbhd') result.reasons.push(`the Block button stored the id "${stored[0].id}", expected "@mkbhd"`);
    await cs.detach();
    if (stored.length === 1) await checkSearchBlocksHandle(page, 'search after the block', result);

    // An id stored with the tab by an older version still blocks by handle
    // (under a name no result shows, so only the handle can block).
    await h.setStorage({ blockedChannels: [{ name: 'Old name', id: '@mkbhd/videos', blockedAt: Date.now() }] });
    await checkSearchBlocksHandle(page, 'search with "@mkbhd/videos" stored', result);
    result.pass = result.reasons.length === 0;
  } catch (err) {
    result.reasons.push(String(err && err.message || err).split('\n')[0]);
  } finally {
    await h.close();
  }
  return result;
}

async function subscriptionToastScenario() {
  const result = { name: 'subscriptions toast: once per keyword + channel', pass: false, steps: {}, reasons: [] };
  try {
    await h.launch();
    const page = await h.newPage();
    await h.gotoYouTube(page, SEARCH_URL);
    await h.waitForFilter(page);

    const target = await h.evalInPage(page, pickToastTarget, { cardSelector: h.CARD_SELECTOR, handle: '@mkbhd' });
    if (!target) throw new Error('no Marques Brownlee result with a usable title word');
    result.steps.target = target;
    await h.evalInPage(page, addFakeSubscription, { handle: '@mkbhd', channel: target.channel });
    await h.evalInPage(page, startToastLog, target.channel);
    await h.setStorage({ blockedKeywords: [{ keyword: target.keyword, addedAt: Date.now() }] });
    await h.sleep(6000); // refilter + the 3 s subscription-check throttle
    const first = await h.evalInPage(page, () => window.__cfToastLog.slice());
    result.steps.afterBlocking = first;
    if (first.length !== 1) throw new Error(`expected 1 toast after blocking "${target.keyword}", saw ${first.length}: cannot test repeats`);

    result.steps.logoClick = await clickVisible(page, 'ytd-topbar-logo-renderer a#logo', 'YouTube logo');
    await waitForPath(page, p => p === '/', 'Home');
    await h.sleep(6000);
    result.steps.afterHome = await h.evalInPage(page, () => window.__cfToastLog.slice());

    await h.evalInPage(page, () => { history.back(); return true; }); // SPA back (popstate)
    await waitForPath(page, p => p === '/results', 'back to search');
    await h.sleep(6000);
    const log = await h.evalInPage(page, () => window.__cfToastLog.slice());
    result.steps.afterBack = log;
    if (log.length !== 1) {
      result.reasons.push(`the toast for "${target.keyword}" + ${target.channel} showed ${log.length} times (on ${log.map(t => t.path).join(', ')}); expected once`);
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
  const cancelWatchdog = h.watchdog(600000);
  const scenarios = [];
  scenarios.push(await channelPagesScenario());
  scenarios.push(await blockedChannelToHomeScenario());
  scenarios.push(await subscriptionToastScenario());
  scenarios.push(await channelTabBlockScenario());
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

main();
