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
// "precondition" entries in the report say a scenario found nothing to test
// (YouTube picks the results); they are reported, not failures.
// Prints a JSON report; exit 0 only if every scenario that could run passed.
// Never signs in; on consent pages only "Reject all" is clicked.

const h = require('./harness');

const GAME_SEARCH_URL = 'https://www.youtube.com/results?search_query=' + encodeURIComponent("Baldur's Gate 3 Spider-Man");
const CYRILLIC_SEARCH_URL = 'https://www.youtube.com/results?search_query=' + encodeURIComponent('обзор игры');
const CHANNEL_VIDEOS_URL = 'https://www.youtube.com/@mkbhd/videos';
const MARK = 'data-cf-live-quickadd';

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

async function main() {
  const startedAt = Date.now();
  const cancelWatchdog = h.watchdog(240000);
  let report;
  try {
    await h.launch();
    const page = await h.newPage();
    // Attached before the first navigation: it follows every CleanFeed world the page creates.
    const cs = await h.attachContentWorld(page);

    const scenarios = [];
    scenarios.push(await runPopoverScenario(
      page, cs, 'apostrophe/hyphen', GAME_SEARCH_URL, "\\p{L}['\u2019-]\\p{L}",
      chips => chips.find(c => !c.disabled && !c.multi && /\p{L}['\u2019-]\p{L}/u.test(c.text))
    ));
    scenarios.push(await runPopoverScenario(
      page, cs, 'Cyrillic', CYRILLIC_SEARCH_URL, '[\\u0400-\\u04FF]{4,}',
      chips => chips.find(c => !c.disabled && !c.multi && /^[\u0400-\u04FF]{4,}$/.test(c.text))
    ));
    scenarios.push(await runScanScenario(page, cs));

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
