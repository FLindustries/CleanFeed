'use strict';
// Live smoke test: block "minecraft", open a YouTube search for it, report how
// many video cards the extension hid. Exit 0 if the content script ran.
//   node tests/live/smoke.js
// Never signs in; on cookie-consent pages only "Reject all" is clicked.

const h = require('./harness');

const KEYWORD = 'minecraft';
const TARGET_URL = `https://www.youtube.com/results?search_query=${encodeURIComponent(KEYWORD)}`;

async function main() {
  const startedAt = Date.now();
  const cancelWatchdog = h.watchdog(150000);
  let report;
  try {
    await h.launch();
    await h.setStorage({ blockedKeywords: [{ keyword: KEYWORD, addedAt: Date.now() }] });
    const stored = await h.getStorage(['blockedKeywords']);

    const page = await h.newPage();
    const nav = await h.gotoYouTube(page, TARGET_URL);
    await h.waitForFilter(page);

    const dom = await h.evalInPage(page, selector => {
      const cards = Array.from(document.querySelectorAll(selector));
      const markers = new Set();
      document.querySelectorAll('[id^="cleanfeed-"], [id^="cf-"], [class*="cleanfeed-"]').forEach(el => {
        if (el.id && /^(cleanfeed-|cf-)/.test(el.id)) markers.add('#' + el.id);
        el.classList.forEach(c => { if (c.startsWith('cleanfeed-')) markers.add('.' + c); });
      });
      const checked = document.querySelectorAll('[data-cf-checked]').length;
      if (checked > 0) markers.add('[data-cf-checked] x' + checked);
      return {
        title: document.title,
        totalVideoCards: cards.length,
        hiddenCards: cards.filter(c => c.classList.contains('cleanfeed-hidden')).length,
        markers: Array.from(markers).slice(0, 25),
        contentScriptRan: markers.size > 0
      };
    }, h.CARD_SELECTOR);

    report = {
      ok: true,
      extensionId: h.getExtensionId(),
      headless: h.isHeadless(),
      url: nav.url,
      title: dom.title,
      consentRejected: nav.consentRejected,
      storedKeywords: stored.blockedKeywords,
      keyword: KEYWORD,
      totalVideoCards: dom.totalVideoCards,
      hiddenCards: dom.hiddenCards,
      contentScriptRan: dom.contentScriptRan,
      markers: dom.markers,
      elapsedMs: Date.now() - startedAt
    };
  } catch (err) {
    report = { ok: false, contentScriptRan: false, error: String(err && err.message || err), elapsedMs: Date.now() - startedAt };
  } finally {
    await h.close();
    cancelWatchdog();
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.contentScriptRan ? 0 : 1);
}

main();
