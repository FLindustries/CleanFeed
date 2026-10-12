'use strict';
// Live test for CF+ quick-add and Channel Scan keywords (audit findings #4, #31).
//   node tests/live/quickadd.js   (about 1.5 min)
// Scenario "apostrophe/hyphen": search for a game whose titles contain an
// apostrophe or hyphen, open the CF+ popover of such a card: a chip keeps the
// punctuation of the word, picking it and clicking "Add selected" stores exactly
// that keyword, it matches the card's title (CleanFeed's own matchesKeyword) and
// the card is hidden afterwards.
// Scenario "Cyrillic": the popover of a Cyrillic title offers selectable chips;
// picking one stores a keyword that matches the title and hides the card.
// Scenario "scan": on a channel's Videos tab the Scan modal lists candidates, each
// one matches at least one of the page's titles; ticking one and clicking
// "Add selected" stores a keyword that matches a title.
// Scenarios "CF+ layout" (channel Videos and Shorts tabs, search results with
// Shorts, a watch page's side column; `node tests/live/quickadd.js layout` runs
// only these): on up to 2 cards of each card type, the CF+ button does not
// overlap YouTube's 3-dot button; with the pointer on CF+ it shows and takes
// the click, and the 3-dot button's centre still takes its own click.
// "precondition" entries in the report say a scenario found nothing to test
// (YouTube picks the results); they are reported, not failures.
// Prints a JSON report; exit 0 only if every scenario that could run passed.
// Never signs in; on consent pages only "Reject all" is clicked.

const h = require('./harness');

const GAME_SEARCH_URL = 'https://www.youtube.com/results?search_query=' + encodeURIComponent("Baldur's Gate 3 Spider-Man");
const CYRILLIC_SEARCH_URL = 'https://www.youtube.com/results?search_query=' + encodeURIComponent('обзор игры');
const CHANNEL_VIDEOS_URL = 'https://www.youtube.com/@mkbhd/videos';
const MARK = 'data-cf-live-quickadd';
// Pages of the CF+ layout scenario: grid cards, Shorts grid cards, search
// results with a Shorts shelf, and the watch page's side column.
const LAYOUT_PAGES = [
  ['CF+ layout: channel Videos tab', CHANNEL_VIDEOS_URL],
  ['CF+ layout: channel Shorts tab', 'https://www.youtube.com/@mkbhd/shorts'],
  ['CF+ layout: search results and Shorts', 'https://www.youtube.com/results?search_query=mkbhd'],
  ['CF+ layout: watch page side column', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']
];

// Runs in the page (main world). Marks the first visible card whose title (read
// the way the popover reads it, passed in) matches the regex source.
function markCard({ titles, reSource, mark }) {
  document.querySelectorAll('[' + mark + ']').forEach(el => el.removeAttribute(mark));
  const re = new RegExp(reSource, 'u');
  for (const entry of titles) {
    if (!re.test(entry.title)) continue;
    const card = document.querySelectorAll(entry.selector)[entry.index];
    if (!card) continue;
    card.setAttribute(mark, '1');
    return entry.title;
  }
  return null;
}

// Runs in the page: opens the popover of the marked card and reads its chips.
function openPopover(mark) {
  const card = document.querySelector('[' + mark + ']');
  const btn = card && card.querySelector('.cleanfeed-quickadd-btn');
  if (!btn) return { error: 'no CF+ button on the marked card' };
  btn.click();
  return { opened: true };
}

function readChips() {
  const pop = document.getElementById('cleanfeed-quickadd-popover');
  if (!pop) return null;
  return Array.from(pop.querySelectorAll('.cleanfeed-quickadd-chip')).map(chip => ({
    text: chip.textContent,
    disabled: chip.disabled,
    multi: chip.classList.contains('cleanfeed-quickadd-chip-bigram')
  }));
}

function clickChip(text) {
  const pop = document.getElementById('cleanfeed-quickadd-popover');
  const chip = pop && Array.from(pop.querySelectorAll('.cleanfeed-quickadd-chip'))
    .find(c => !c.disabled && c.textContent === text);
  if (!chip) return false;
  chip.click();
  return true;
}

function submitPopover() {
  const pop = document.getElementById('cleanfeed-quickadd-popover');
  const btn = pop && pop.querySelector('.cleanfeed-btn-primary');
  if (!btn) return false;
  btn.click();
  return true;
}

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
    await h.sleep(400);
  }
}

// Title of every card, read with CleanFeed's own YT.getVideoTitle.
const LIST_TITLES = `(() => {
  const out = [];
  document.querySelectorAll(YT.VIDEO_CARDS).forEach((card, index) => {
    const title = YT.getVideoTitle(card);
    if (title) out.push({ title, index, selector: YT.VIDEO_CARDS });
  });
  return out;
})()`;

async function storedKeywords() {
  const stored = await h.getStorage(['blockedKeywords']);
  return (stored.blockedKeywords || []).map(k => k.keyword);
}

async function runPopoverScenario(page, cs, name, url, reSource, pickChip) {
  const result = { name };
  await h.setStorage({ blockedKeywords: [] });
  await h.gotoYouTube(page, url);
  await h.waitForFilter(page, { settleMs: 3500 });

  const titles = await cs.evaluate(LIST_TITLES);
  result.cardsWithTitle = titles.length;
  const title = await h.evalInPage(page, markCard, { titles, reSource, mark: MARK });
  if (!title) {
    result.precondition = 'no result title matched ' + reSource;
    result.ok = true;
    return result;
  }
  result.title = title;

  const opened = await h.evalInPage(page, openPopover, MARK);
  if (!opened.opened) throw new Error(opened.error);
  const chips = await waitFor(() => h.evalInPage(page, readChips), 8000, 'popover chips');
  result.chips = chips.map(c => (c.disabled ? '(' + c.text + ')' : c.text));

  const picked = pickChip(chips);
  if (!picked) {
    result.ok = false;
    result.error = 'no selectable chip of the expected kind';
    return result;
  }
  result.pickedChip = picked.text;
  if (!(await h.evalInPage(page, clickChip, picked.text))) throw new Error('could not click chip ' + picked.text);
  if (!(await h.evalInPage(page, submitPopover))) throw new Error('could not click Add selected');

  const keywords = await waitFor(async () => {
    const list = await storedKeywords();
    return list.length > 0 ? list : null;
  }, 8000, 'stored keyword');
  result.stored = keywords;
  result.expectedKeyword = await cs.evaluate('cfNormalizeForMatch(' + JSON.stringify(picked.text) + ')');
  result.matchesTitle = await cs.evaluate('matchesKeyword(' + JSON.stringify(title) + ', ' + JSON.stringify(keywords[0]) + ')');
  result.cardHidden = await waitFor(() => h.evalInPage(page, mark => {
    const card = document.querySelector('[' + mark + ']');
    return !!card && card.classList.contains('cleanfeed-hidden');
  }, MARK), 8000, 'card hidden').catch(() => false);
  result.ok = keywords.length === 1 && keywords[0] === result.expectedKeyword &&
    result.matchesTitle === true && result.cardHidden === true;
  return result;
}

async function runScanScenario(page, cs) {
  const result = { name: 'scan' };
  await h.setStorage({ blockedKeywords: [] });
  await h.gotoYouTube(page, CHANNEL_VIDEOS_URL);
  await h.waitForFilter(page, { settleMs: 4000 });
  const clicked = await waitFor(() => h.evalInPage(page, () => {
    const btn = document.querySelector('.cleanfeed-channel-scan-btn');
    if (!btn) return false;
    btn.click();
    return true;
  }), 15000, 'Scan button').catch(() => false);
  if (!clicked) {
    result.precondition = 'no Scan button on ' + CHANNEL_VIDEOS_URL;
    result.ok = true;
    return result;
  }
  const rows = await waitFor(() => h.evalInPage(page, () => {
    const modal = document.getElementById('cleanfeed-scan-modal');
    if (!modal) return null;
    return Array.from(modal.querySelectorAll('.cleanfeed-scan-row')).map(row => ({
      phrase: row.querySelector('.cleanfeed-scan-phrase').textContent,
      disabled: row.querySelector('input').disabled
    }));
  }), 8000, 'Scan modal');
  result.candidates = rows.map(r => r.phrase);
  const titles = (await cs.evaluate(LIST_TITLES)).map(t => t.title);
  result.titlesAnalysed = titles.length;
  result.unmatched = [];
  for (const row of rows) {
    const ok = await cs.evaluate('cfPhraseMatchesAnyTitle(' + JSON.stringify(titles) + ', ' + JSON.stringify(row.phrase) + ')');
    if (!ok) result.unmatched.push(row.phrase);
  }
  const first = rows.find(r => !r.disabled);
  if (!first) {
    result.precondition = 'the Scan modal listed no selectable candidate';
    result.ok = result.unmatched.length === 0;
    return result;
  }
  await h.evalInPage(page, phrase => {
    const modal = document.getElementById('cleanfeed-scan-modal');
    const row = Array.from(modal.querySelectorAll('.cleanfeed-scan-row'))
      .find(r => r.querySelector('.cleanfeed-scan-phrase').textContent === phrase);
    row.querySelector('input').click();
    modal.querySelector('.cleanfeed-btn-primary').click();
  }, first.phrase);
  const keywords = await waitFor(async () => {
    const list = await storedKeywords();
    return list.length > 0 ? list : null;
  }, 8000, 'stored scan keyword');
  result.picked = first.phrase;
  result.stored = keywords;
  result.ok = result.unmatched.length === 0 && keywords.length === 1 && keywords[0] === first.phrase;
  return result;
}

// Runs in the page: marks the n-th visible outermost card of each card type
// that carries a CF+ button and a 3-dot button, and returns where both are.
// `overlap` is the area (px²) the two buttons share.
function layoutTargets({ cardSelector, perType, mark, reSource }) {
  document.querySelectorAll('[' + mark + ']').forEach(el => el.removeAttribute(mark));
  const re = new RegExp(reSource, 'i');
  const seen = {};
  const out = [];
  for (const card of document.querySelectorAll(cardSelector)) {
    if (card.parentElement && card.parentElement.closest(cardSelector)) continue; // nested card
    const tag = card.tagName.toLowerCase();
    if ((seen[tag] || 0) >= perType) continue;
    const r = card.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || card.classList.contains('cleanfeed-hidden')) continue;
    const cf = card.querySelector(':scope > .cleanfeed-quickadd-btn');
    const menuBtn = Array.from(card.querySelectorAll('button')).find(b => re.test((b.getAttribute('aria-label') || '').trim()));
    if (!cf || !menuBtn || menuBtn.getClientRects().length === 0) continue;
    seen[tag] = (seen[tag] || 0) + 1;
    card.setAttribute(mark, String(out.length));
    const a = cf.getBoundingClientRect();
    const b = menuBtn.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    out.push({ tag, overlap: Math.round(overlap) });
  }
  return out;
}

// Runs in the page: scrolls the CF+ button of the index-th marked card to the
// middle and returns its centre.
function cfCentre({ mark, index }) {
  const card = document.querySelector('[' + mark + '="' + index + '"]');
  if (!card) return null;
  const cf = card.querySelector(':scope > .cleanfeed-quickadd-btn');
  cf.scrollIntoView({ block: 'center' });
  const r = cf.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// Runs in the page, with the pointer on the card's CF+ button: CF+ shows and
// takes the click there, and the centre of the 3-dot button still belongs to
// the 3-dot button.
function hitCheck({ mark, index, reSource }) {
  const card = document.querySelector('[' + mark + '="' + index + '"]');
  if (!card) return null;
  const re = new RegExp(reSource, 'i');
  const cf = card.querySelector(':scope > .cleanfeed-quickadd-btn');
  const menuBtn = Array.from(card.querySelectorAll('button')).find(b => re.test((b.getAttribute('aria-label') || '').trim()));
  const centre = el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const describe = el => el ? el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 40) : 'nothing';
  const inView = ([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  const cfHit = document.elementFromPoint(...centre(cf));
  const menuHit = document.elementFromPoint(...centre(menuBtn));
  return {
    inView: inView(centre(cf)) && inView(centre(menuBtn)),
    cfShown: getComputedStyle(cf).opacity === '1',
    cfTakesClick: !!cfHit && (cfHit === cf || cf.contains(cfHit)),
    cfHit: describe(cfHit),
    menuTakesClick: !!menuHit && (menuHit === menuBtn || menuBtn.contains(menuHit)),
    menuHit: describe(menuHit)
  };
}

// CF+ never covers YouTube's 3-dot button (where "Block channel permanently"
// lives) and stays clickable while the pointer is on the card. Checks up to 2
// cards of each card type on the page.
async function runLayoutScenario(page, name, url) {
  const result = { name, url, cards: [] };
  // Tall enough that a card of the first row fits below the channel header
  await h.withTimeout(page.setViewportSize({ width: 1280, height: 1100 }), 5000, 'set viewport');
  await h.gotoYouTube(page, url);
  await h.waitForFilter(page, { settleMs: 3500 });
  const targets = await h.evalInPage(page, layoutTargets, {
    cardSelector: h.CARD_SELECTOR, perType: 2, mark: MARK, reSource: '^(more actions|action menu)$'
  });
  if (targets.length === 0) {
    result.precondition = 'no card with both a CF+ and a 3-dot button';
    result.ok = true;
    return result;
  }
  for (let index = 0; index < targets.length; index++) {
    await h.evalInPage(page, cfCentre, { mark: MARK, index });
    await h.sleep(400);
    const point = await h.evalInPage(page, cfCentre, { mark: MARK, index }); // after lazy content settled
    const hit = point && await (async () => {
      await h.withTimeout(page.mouse.move(point.x, point.y, { steps: 3 }), 3000, 'hover CF+');
      await h.sleep(500);
      return h.evalInPage(page, hitCheck, { mark: MARK, index, reSource: '^(more actions|action menu)$' });
    })();
    result.cards.push(Object.assign({}, targets[index], hit || { error: 'the card is gone' }));
    await h.withTimeout(page.mouse.move(2, 2), 3000, 'move pointer away');
  }
  result.ok = result.cards.every(c => !c.error && c.inView && c.overlap === 0 && c.cfShown && c.cfTakesClick && c.menuTakesClick);
  return result;
}

async function main() {
  const startedAt = Date.now();
  const cancelWatchdog = h.watchdog(360000);
  let report;
  try {
    await h.launch();
    const page = await h.newPage();
    // Attached before the first navigation: it follows every CleanFeed world the page creates.
    const cs = await h.attachContentWorld(page);

    const scenarios = [];
    // `node tests/live/quickadd.js layout` runs only the CF+ layout scenarios
    if (process.argv[2] !== 'layout') {
      scenarios.push(await runPopoverScenario(
        page, cs, 'apostrophe/hyphen', GAME_SEARCH_URL, "\\p{L}['\u2019-]\\p{L}",
        chips => chips.find(c => !c.disabled && !c.multi && /\p{L}['\u2019-]\p{L}/u.test(c.text))
      ));
      scenarios.push(await runPopoverScenario(
        page, cs, 'Cyrillic', CYRILLIC_SEARCH_URL, '[\\u0400-\\u04FF]{4,}',
        chips => chips.find(c => !c.disabled && !c.multi && /^[\u0400-\u04FF]{4,}$/.test(c.text))
      ));
      scenarios.push(await runScanScenario(page, cs));
    }
    await h.setStorage({ blockedKeywords: [] });
    for (const [name, url] of LAYOUT_PAGES) scenarios.push(await runLayoutScenario(page, name, url));

    report = { ok: scenarios.every(s => s.ok), scenarios, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    report = { ok: false, error: String(err && err.message || err), elapsedMs: Date.now() - startedAt };
  } finally {
    await h.close();
    cancelWatchdog();
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();
