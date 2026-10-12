'use strict';
// Live test for one source of truth for topics and synonyms (audit findings #3, #34).
//   node tests/live/categories.js
// options.html and popup.html load content-dom.js, which was written for YouTube
// pages: each must open in the real extension without a console or page error.
//  1. Options > Topics: 35 rows with display names, each showing exactly the terms
//     blocking uses (cfBuiltInTerms), no raw key such as ai_hype / true_crime.
//  2. Popup > Blocked: 35 topic chips with display names.
//  3. YouTube search results: with several topics blocked (fitness, ai_hype,
//     true_crime, ... the ones the old 20-topic list left out), the topic panel of
//     a video's 3-dot menu offers "Add to category" for every blocked topic, by
//     display name.
// Prints a JSON report; exit 0 only if every scenario passes.
// Never signs in; on consent pages only "Reject all" is clicked.

const h = require('./harness');
const menu = require('./menu');
const loadContentDom = require('../unit/load-content-dom');

const cf = loadContentDom();
const CATEGORIES = loadContentDom.plain(cf.cfCategoryList());
const ALL_KEYS = CATEGORIES.map(c => c.key);
const RAW_KEYS_WITH_UNDERSCORE = ALL_KEYS.filter(k => k.includes('_'));
const SEARCH_URL = 'https://www.youtube.com/results?search_query=mkbhd';
// Topics the old 20-topic lists left out, plus one old one. None of them matches
// the mkbhd search results, so cards stay visible for the menu.
const MENU_TOPICS = ['fitness', 'ai_hype', 'true_crime', 'brainrot', 'paranormal', 'kids', 'religion'];

function blockedKeywords(keys) {
  return keys.map(keyword => ({ keyword, addedAt: Date.now() }));
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

function sameList(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function optionsScenario() {
  const result = { name: 'options.html topics', pass: false, reasons: [] };
  await h.setStorage({ blockedKeywords: blockedKeywords(['ai_hype', 'true_crime']) });
  const { page, errors } = await openExtensionPage('options.html');
  try {
    await h.withTimeout(page.click('.nav-item[data-section="topics"]', { timeout: 8000 }), 10000, 'open topics');
    await h.withTimeout(page.waitForSelector('#category-list .category-item', { timeout: 8000 }), 10000, 'category rows');
    const dom = await h.evalInPage(page, () => {
      const rows = Array.from(document.querySelectorAll('#category-list .category-item'));
      return {
        names: rows.map(r => r.querySelector('.category-name').textContent),
        counts: rows.map(r => r.querySelector('.category-count').textContent),
        chips: rows.map(r => Array.from(r.querySelectorAll('.synonym-list .synonym-chip:not(.custom)'), c => c.textContent)),
        text: document.getElementById('category-list').textContent
      };
    });
    result.rows = dom.names.length;
    result.gamingChips = (dom.chips[ALL_KEYS.indexOf('gaming')] || []).length;
    result.aiHypeFirstChip = (dom.chips[ALL_KEYS.indexOf('ai_hype')] || [])[0];
    if (dom.names.length !== 35) result.reasons.push(`expected 35 topic rows, found ${dom.names.length}`);
    if (!sameList(dom.names, CATEGORIES.map(c => c.label))) result.reasons.push('row names are not the display names in order: ' + dom.names.join(', '));
    CATEGORIES.forEach((c, i) => {
      const terms = loadContentDom.plain(cf.cfBuiltInTerms(c.key));
      const expectedChips = [c.label, ...terms.slice(1)];
      if (!sameList(dom.chips[i], expectedChips)) result.reasons.push(`${c.key}: chips differ from the terms blocking uses`);
      if (dom.counts[i] !== terms.length + ' terms') result.reasons.push(`${c.key}: count "${dom.counts[i]}", expected ${terms.length} terms`);
    });
    for (const raw of RAW_KEYS_WITH_UNDERSCORE) {
      if (dom.text.includes(raw)) result.reasons.push('raw key shown: ' + raw);
    }
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

async function popupScenario() {
  const result = { name: 'popup.html topic chips', pass: false, reasons: [] };
  await h.setStorage({ blockedKeywords: blockedKeywords(ALL_KEYS) });
  const { page, errors } = await openExtensionPage('popup.html');
  try {
    await h.withTimeout(page.click('.tab[data-tab="blocked"]', { timeout: 8000 }), 10000, 'open Blocked tab');
    await h.withTimeout(page.waitForSelector('#tab-blocked .category-chip', { timeout: 8000 }), 10000, 'topic chips');
    const dom = await h.evalInPage(page, () => ({
      chips: Array.from(document.querySelectorAll('#tab-blocked .category-chip'), c => c.textContent),
      text: document.getElementById('tab-blocked').textContent
    }));
    result.chips = dom.chips.length;
    if (dom.chips.length !== 35) result.reasons.push(`expected 35 topic chips, found ${dom.chips.length}`);
    if (!sameList(dom.chips, CATEGORIES.map(c => c.label))) result.reasons.push('chips are not the display names in order: ' + dom.chips.join(', '));
    for (const raw of RAW_KEYS_WITH_UNDERSCORE) {
      if (dom.text.includes(raw)) result.reasons.push('raw key shown: ' + raw);
    }
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

async function topicMenuScenario() {
  const result = { name: 'topic panel: Add to category lists every blocked topic', url: SEARCH_URL, pass: false, reasons: [] };
  await h.setStorage({ blockedKeywords: blockedKeywords(MENU_TOPICS) });
  const page = await h.newPage();
  try {
    const nav = await h.gotoYouTube(page, SEARCH_URL);
    result.url = nav.url;
    await h.waitForFilter(page, { settleMs: 3000 });
    const target = await h.evalInPage(page, menu.markCardMenuButton, {
      cardSelector: h.CARD_SELECTOR, scope: '#primary', index: 0, reSource: menu.MENU_BUTTON_RE_SOURCE, markAttr: menu.MARK_ATTR
    });
    if (!target) throw new Error('no visible video card with a 3-dot menu button found');
    await menu.clickMarked(page);
    await h.sleep(1200);
    if (!(await h.evalInPage(page, menu.markOpenTopicItem, menu.MARK_ATTR))) throw new Error('no CleanFeed topic item in the open menu');
    await menu.clickMarked(page);
    await h.sleep(800);
    const options = await h.evalInPage(page, () => {
      const select = document.querySelector('#cleanfeed-topic-menu select');
      return select ? Array.from(select.options, o => ({ value: o.value, text: o.textContent })) : null;
    });
    if (!options) throw new Error('the topic panel has no category dropdown');
    result.options = options.map(o => o.text);
    const expected = CATEGORIES.filter(c => MENU_TOPICS.includes(c.key));
    if (!sameList(options.slice(1).map(o => o.value), expected.map(c => c.key))) {
      result.reasons.push('dropdown topics: ' + options.slice(1).map(o => o.value).join(', '));
    }
    if (!sameList(options.slice(1).map(o => o.text), expected.map(c => c.label))) {
      result.reasons.push('dropdown names are not the display names: ' + options.slice(1).map(o => o.text).join(', '));
    }
    if (options.some(o => o.text.includes('_'))) result.reasons.push('a raw key is shown in the dropdown');
    result.pass = result.reasons.length === 0;
  } catch (err) {
    result.reasons.push(String(err && err.message || err).split('\n')[0]);
  } finally {
    try { await h.withTimeout(page.close(), 10000, 'close page'); } catch (e) { /* ignore */ }
  }
  return result;
}

async function main() {
  const startedAt = Date.now();
  const cancelWatchdog = h.watchdog(240000);
  let report;
  try {
    await h.launch();
    const scenarios = [];
    scenarios.push(await optionsScenario());
    scenarios.push(await popupScenario());
    scenarios.push(await topicMenuScenario());
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
