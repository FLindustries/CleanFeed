'use strict';
// Live test for Shorts filtering (audit finding #12).
//   node tests/live/shorts.js   (about 1 min)
// Search-result Shorts are ytm-shorts-lockup-view-model items wrapped in
// ytm-shorts-lockup-view-model-v2, inside grid-shelf-view-model shelves.
// "Contains minecraft" uses CleanFeed's own whole-word rule (matchesKeyword),
// so "#minecraft" counts and "#minecraftanimation" alone does not.
// Scenario "nothing blocked": search "minecraft shorts": no Short and no shelf
// carries CleanFeed's hidden class; a Short opened in the /shorts player is
// not hidden either.
// Scenario "minecraft blocked": the same search: every Short whose title
// contains "minecraft" is hidden, every other Short is not; each Short is
// exactly one CleanFeed card (the wrapper and the inner lockup are never both
// cards, so nothing is counted twice); a shelf is hidden only when all of its
// Shorts are. Then the /shorts player: a minecraft Short is hidden (with the
// still frame YouTube paints behind it) and its video paused. YouTube reuses
// one renderer for every short, so the test moves on (ArrowDown, else mouse
// wheel) until a titled short without "minecraft" appears (at most 6 steps):
// each short is hidden only if its title contains "minecraft", and a short
// that is shown plays (CleanFeed resumes what it paused).
// "unhideExercised" in the report says whether such a short appeared
// (YouTube picks the order, so it is reported, not required).
// Scenario "channel Shorts tab": each Short there sits in a
// ytd-rich-item-renderer, already a card; the grid cell holds exactly one
// CleanFeed card (the lockups inside are not cards too).
// The scenarios share one browser; storage is rewritten before each search.
// Prints a JSON report; exit 0 only if every scenario passes.
// Never signs in; on consent pages only "Reject all" is clicked.

const h = require('./harness');
const { matchesKeyword } = require('../unit/load-content-dom')();

const KEYWORD = 'minecraft';
const SEARCH_URL = 'https://www.youtube.com/results?search_query=' + encodeURIComponent('minecraft shorts');
const CHANNEL_SHORTS_URL = 'https://www.youtube.com/@mkbhd/shorts';
// Test-local on purpose: the test must find Shorts even where CleanFeed's
// card selector does not (that is the bug it guards against).
const SHORTS_ITEM = 'ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model';
const MIN_SHORTS = 3;
const SHORTS_WAIT_MS = 30000;
const STABLE_MS = 3000;
const PLAYER_WAIT_MS = 20000;
const NEXT_STEPS = 6;
const SETTLE_MS = 2000;

// ── In-page helpers (main world, serialized by page.evaluate) ─────────────

// Every Short on the page (the outermost element of each wrapper/inner pair)
// and every Shorts shelf, with what CleanFeed did to them.
function readShorts({ itemSelector, cardSelector }) {
  const outermost = root => Array.from(root.querySelectorAll(itemSelector))
    .filter(el => !(el.parentElement && el.parentElement.closest(itemSelector)));
  const describe = item => {
    const pair = [item, ...item.querySelectorAll(itemSelector)];
    // The grid cell: a channel's Shorts tab wraps each Short in
    // ytd-rich-item-renderer, which is a CleanFeed card itself.
    const cell = item.closest('ytd-rich-item-renderer') || item;
    const h3 = item.querySelector('h3');
    const link = item.querySelector('a[href^="/shorts/"]');
    return {
      title: h3 ? h3.textContent.replace(/\s+/g, ' ').trim() : '',
      href: link ? link.getAttribute('href') : null,
      cardMatches: [cell, ...cell.querySelectorAll('*')].filter(el => el.matches(cardSelector)).length,
      ownHidden: pair.some(el => el.classList.contains('cleanfeed-hidden')),
      hiddenByAncestor: !!(item.parentElement && item.parentElement.closest('.cleanfeed-hidden')),
      rendered: item.getClientRects().length > 0
    };
  };
  return {
    items: outermost(document).map(describe),
    shelves: Array.from(document.querySelectorAll('grid-shelf-view-model')).map(shelf => {
      const items = outermost(shelf).map(describe);
      return {
        hidden: shelf.classList.contains('cleanfeed-hidden'),
        items: items.length,
        hiddenItems: items.filter(i => i.ownHidden).length
      };
    })
  };
}

function countShorts(itemSelector) {
  return document.querySelectorAll(itemSelector).length;
}

// The short on screen in the /shorts player.
function readPlayer() {
  const page = document.querySelector('ytd-shorts');
  const reel = page && (page.querySelector('ytd-reel-video-renderer[is-active]') || page.querySelector('ytd-reel-video-renderer'));
  if (!reel) return { path: location.pathname, reel: false };
  const titleEl = reel.querySelector('yt-shorts-video-title-view-model');
  const video = reel.querySelector('video');
  // The slot holding the renderer also paints a still frame of the short
  // (an element with a background image) next to the renderer's container.
  const slot = reel.parentElement && reel.parentElement.parentElement;
  const stillFrameShown = !!slot && Array.from(slot.querySelectorAll('*')).some(el => {
    if (el === reel.parentElement || reel.parentElement.contains(el)) return false;
    const s = getComputedStyle(el);
    return s.visibility === 'visible' && el.getClientRects().length > 0 &&
      (s.backgroundImage !== 'none' || el.tagName === 'IMG');
  });
  return {
    path: location.pathname,
    reel: true,
    title: titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '',
    hiddenClass: reel.classList.contains('cleanfeed-hidden'),
    rendered: reel.getClientRects().length > 0,
    stillFrameShown,
    videoPaused: video ? video.paused : null
  };
}

// ── Steps ────────────────────────────────────────────────────────────────

async function poll(fn, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > deadline) return value;
    await h.sleep(300);
  }
}

async function loadShorts(page, url) {
  const nav = await h.gotoYouTube(page, url || SEARCH_URL);
  await h.waitForFilter(page);
  // Wait until no more Shorts arrive: when CleanFeed hides whole shelves the
  // page gets short and YouTube keeps loading more results for a few seconds.
  const deadline = Date.now() + SHORTS_WAIT_MS;
  let count = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const n = await h.evalInPage(page, countShorts, SHORTS_ITEM);
    if (n !== count) {
      count = n;
      stableSince = Date.now();
    } else if (n >= MIN_SHORTS && Date.now() - stableSince >= STABLE_MS) {
      break;
    }
    await h.sleep(500);
  }
  await h.sleep(SETTLE_MS); // let the filter's debounced pass run on the last items
  const shorts = await h.evalInPage(page, readShorts, { itemSelector: SHORTS_ITEM, cardSelector: h.CARD_SELECTOR });
  for (const item of shorts.items) item.matches = matchesKeyword(item.title, KEYWORD);
  return Object.assign({ url: nav.url }, shorts);
}

// Opens a /shorts/ URL and waits until the player shows a title.
async function openPlayer(page, href) {
  await h.gotoYouTube(page, 'https://www.youtube.com' + href);
  const shown = await poll(async () => {
    const p = await h.evalInPage(page, readPlayer);
    return p.reel && p.title ? p : null;
  }, PLAYER_WAIT_MS);
  if (shown) await h.sleep(SETTLE_MS); // let the filter's debounced pass run
  return h.evalInPage(page, readPlayer);
}

// Moves the player to the next short: ArrowDown first, then the mouse wheel.
// Returns the player state once the path has changed and the new title has
// loaded. Some shorts (e.g. ads) show no title at all: their title stays ''.
async function nextShort(page, before) {
  const pathChanged = async () => {
    const p = await h.evalInPage(page, readPlayer);
    return p.reel && p.path !== before.path ? p : null;
  };
  await h.withTimeout(page.keyboard.press('ArrowDown'), 3000, 'press ArrowDown');
  let moved = await poll(pathChanged, 8000);
  let how = 'ArrowDown';
  if (!moved) {
    await h.withTimeout(page.mouse.move(640, 450), 3000, 'move mouse');
    await h.withTimeout(page.mouse.wheel(0, 900), 3000, 'mouse wheel');
    moved = await poll(pathChanged, 8000);
    how = 'wheel';
  }
  if (!moved) return { how: null, player: await h.evalInPage(page, readPlayer) };
  await poll(async () => {
    const p = await h.evalInPage(page, readPlayer);
    return p.title && p.title !== before.title ? p : null;
  }, 6000);
  await h.sleep(SETTLE_MS);
  return { how, player: await h.evalInPage(page, readPlayer) };
}

const itemLabel = item => `"${item.title}" (${item.href})`;

// ── Scenarios ────────────────────────────────────────────────────────────

async function nothingBlocked(page) {
  const result = { name: 'nothing blocked: Shorts untouched', pass: false, reasons: [] };
  await h.setStorage({ blockedKeywords: [], blockedChannels: [] });
  const search = await loadShorts(page);
  result.search = { url: search.url, items: search.items, shelves: search.shelves };
  if (search.items.length < MIN_SHORTS) result.reasons.push(`expected at least ${MIN_SHORTS} Shorts, found ${search.items.length}`);
  for (const item of search.items) {
    if (item.ownHidden || item.hiddenByAncestor) result.reasons.push('Short hidden with nothing blocked: ' + itemLabel(item));
  }
  search.shelves.filter(s => s.hidden).forEach(() => result.reasons.push('a Shorts shelf is hidden with nothing blocked'));

  const target = search.items.find(i => i.matches && i.href);
  result.playerTarget = target ? target.href : null;
  if (target) {
    result.player = await openPlayer(page, target.href);
    if (!result.player.reel) result.reasons.push('player: no ytd-reel-video-renderer on ' + target.href);
    else if (result.player.hiddenClass) result.reasons.push('player: short hidden with nothing blocked');
  } else {
    result.reasons.push('no Short title contains "' + KEYWORD + '": cannot pick a short for the player check');
  }
  result.pass = result.reasons.length === 0;
  return result;
}

async function keywordBlocked(page, playerHref) {
  const result = { name: `"${KEYWORD}" blocked: matching Shorts hidden`, pass: false, reasons: [] };
  await h.setStorage({ blockedKeywords: [{ keyword: KEYWORD, addedAt: Date.now() }], blockedChannels: [] });
  const search = await loadShorts(page);
  result.search = { url: search.url, items: search.items, shelves: search.shelves };
  const matching = search.items.filter(i => i.matches);
  result.counts = { shorts: search.items.length, matching: matching.length, hidden: search.items.filter(i => i.ownHidden).length };
  if (search.items.length < MIN_SHORTS) result.reasons.push(`expected at least ${MIN_SHORTS} Shorts, found ${search.items.length}`);
  if (matching.length === 0) result.reasons.push('no Short title contains "' + KEYWORD + '": nothing to check');
  for (const item of search.items) {
    if (item.cardMatches !== 1) result.reasons.push(`Short is ${item.cardMatches} CleanFeed cards (expected 1): ${itemLabel(item)}`);
    if (item.matches && !(item.ownHidden || !item.rendered)) result.reasons.push('matching Short not hidden: ' + itemLabel(item));
    if (!item.matches && item.ownHidden) result.reasons.push('non-matching Short hidden: ' + itemLabel(item));
  }
  for (const [i, shelf] of search.shelves.entries()) {
    if (shelf.items === 0) continue;
    const allHidden = shelf.hiddenItems === shelf.items;
    if (shelf.hidden !== allHidden) {
      result.reasons.push(`shelf ${i + 1}: hidden=${shelf.hidden} but ${shelf.hiddenItems}/${shelf.items} of its Shorts are hidden`);
    }
  }

  if (playerHref) {
    const player = await openPlayer(page, playerHref);
    result.player = player;
    if (!player.reel) {
      result.reasons.push('player: no ytd-reel-video-renderer on ' + playerHref);
    } else {
      if (!matchesKeyword(player.title, KEYWORD)) result.reasons.push(`player: expected a "${KEYWORD}" short, title is "${player.title}"`);
      if (!player.hiddenClass) result.reasons.push('player: blocked short is not hidden');
      if (player.videoPaused === false) result.reasons.push('player: hidden short keeps playing');
      if (player.stillFrameShown) result.reasons.push('player: a still frame of the hidden short is still shown');
      // YouTube reuses the same renderer for the next short: it must be shown
      // again for a short without "minecraft". The order of the shorts is
      // YouTube's, so step until one such short shows up (at most NEXT_STEPS).
      result.nextShorts = [];
      let current = player;
      for (let step = 1; step <= NEXT_STEPS; step++) {
        const next = await nextShort(page, current);
        if (!next.how) {
          result.reasons.push(`player: could not move to short ${step + 1} (ArrowDown and mouse wheel)`);
          break;
        }
        current = next.player;
        const expectHidden = matchesKeyword(current.title, KEYWORD);
        result.nextShorts.push({ how: next.how, title: current.title, path: current.path, hidden: current.hiddenClass, expectHidden, videoPaused: current.videoPaused, stillFrameShown: current.stillFrameShown });
        if (current.hiddenClass !== expectHidden) {
          result.reasons.push(`player: short "${current.title}" hidden=${current.hiddenClass}, expected ${expectHidden}`);
        }
        if (current.hiddenClass && current.videoPaused === false) result.reasons.push(`player: hidden short "${current.title}" keeps playing`);
        if (current.hiddenClass && current.stillFrameShown) result.reasons.push(`player: a still frame of hidden short "${current.title}" is still shown`);
        // CleanFeed paused the hidden short; YouTube would then leave the
        // following shorts paused too unless CleanFeed resumes playback.
        if (!current.hiddenClass && current.videoPaused === true) result.reasons.push(`player: short "${current.title}" shown after a hidden one does not play`);
        if (!expectHidden && current.title) break;
      }
      // Not a failure (YouTube picks the next shorts), but worth seeing.
      result.unhideExercised = result.nextShorts.some(s => !s.expectHidden && s.title);
    }
  }
  result.pass = result.reasons.length === 0;
  return result;
}

// A channel's Shorts tab wraps each Short in ytd-rich-item-renderer (already a
// card): the lockups inside must not become a second, nested card.
async function channelShortsTab(page) {
  const result = { name: 'channel Shorts tab: one card per Short', url: CHANNEL_SHORTS_URL, pass: false, reasons: [] };
  const tab = await loadShorts(page, CHANNEL_SHORTS_URL);
  result.url = tab.url;
  result.items = tab.items.map(i => ({ title: i.title, cardMatches: i.cardMatches }));
  if (tab.items.length < MIN_SHORTS) result.reasons.push(`expected at least ${MIN_SHORTS} Shorts, found ${tab.items.length}`);
  for (const item of tab.items) {
    if (item.cardMatches !== 1) result.reasons.push(`Short is ${item.cardMatches} CleanFeed cards (expected 1): ${itemLabel(item)}`);
  }
  result.pass = result.reasons.length === 0;
  return result;
}

async function main() {
  const startedAt = Date.now();
  const cancelWatchdog = h.watchdog(300000);
  const scenarios = [];
  try {
    await h.launch();
    const page = await h.newPage();
    const open = await nothingBlocked(page);
    scenarios.push(open);
    scenarios.push(await keywordBlocked(page, open.playerTarget));
    scenarios.push(await channelShortsTab(page));
  } catch (err) {
    scenarios.push({ name: 'run', pass: false, reasons: [String(err && err.message || err).split('\n')[0]] });
  } finally {
    await h.close();
    cancelWatchdog();
  }

  const report = {
    ok: scenarios.length === 3 && scenarios.every(s => s.pass),
    summary: scenarios.map(s => `${s.pass ? 'PASS' : 'FAIL'} ${s.name}${s.pass ? '' : ': ' + s.reasons.join('; ')}`),
    scenarios,
    elapsedMs: Date.now() - startedAt
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();
