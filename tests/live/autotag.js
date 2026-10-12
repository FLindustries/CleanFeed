'use strict';
// Live test for category auto-tag (audit findings #1, #8, #19).
//   node tests/live/autotag.js   (about 1 min)
// Every scenario first loads a search page with nothing blocked, starts
// recording the batchIncrementCategoryHits messages the content script sends,
// then blocks a keyword (which refilters the page) and forces three more full
// refilters (each storage change makes the content script re-check every card).
// Scenario "plain keyword": "trailer" hides cards but sends no auto-tag hit and
// stores no hit, counted video or tag.
// Scenario "topic": "gaming" sends each (channel, video) pair at most once over
// all refilters; the counted videos stored per channel are videos hidden on the
// page (real video ids where the card links one); a channel is tagged exactly
// when 3 or more distinct videos were counted.
// Scenario "untag sticks": a channel tagged in "topic" is untagged with the
// Untag button in Options > Topics & Keywords > Gaming; the page is loaded
// again in a new tab session (nothing counted in memory), "gaming" is blocked
// again: the content script sends hits for that channel, and the background
// neither counts them nor tags the channel again.
// "precondition" in the report says YouTube's results gave nothing to test
// (e.g. no channel reached 3 videos); it is reported, not a failure.
// Prints a JSON report; exit 0 only if every scenario that could run passed.
// Never signs in; on consent pages only "Reject all" is clicked.

const h = require('./harness');

const search = q => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
const PLAIN_URL = search('official movie trailer');
const TOPIC_URL = search('minecraft lets play episode');
const AUTOTAG_KEYS = ['categoryHits', 'categoryTags', 'categoryHitVideos', 'categoryTagExclusions'];
const CLEAN_AUTOTAG = { categoryHits: {}, categoryTags: {}, categoryHitVideos: {}, categoryTagExclusions: {} };
// The content script flushes queued hits 2 s after the first one.
const FLUSH_WAIT_MS = 3500;
const NUDGES = 3;
const NUDGE_GAP_MS = 1500;

// Content-script world: records every batchIncrementCategoryHits payload.
const RECORD_BATCHES = `(() => {
  window.__cfLiveBatches = [];
  if (!window.__cfLiveRecording) {
    window.__cfLiveRecording = true;
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (payload, ...rest) => {
      if (payload && payload.action === 'batchIncrementCategoryHits') {
        window.__cfLiveBatches.push(JSON.parse(JSON.stringify(payload.hits)));
      }
      return send(payload, ...rest);
    };
  }
  return true;
})()`;

const READ_BATCHES = 'window.__cfLiveBatches || []';

// Content-script world: every hidden card that is not a wrapper of another
// card, with the key the content script counts it under.
const READ_HIDDEN = `Array.from(document.querySelectorAll(YT.VIDEO_CARDS))
  .filter(card => card.classList.contains('cleanfeed-hidden') && !card.querySelector(YT.VIDEO_CARDS))
  .map(card => {
    const channel = YT.getChannelName(card);
    const id = YT.getVideoId(card);
    return {
      channel: channel ? channel.trim().toLowerCase() : null,
      id,
      key: cfCategoryVideoKey(id, YT.getVideoTitle(card) || ''),
      reason: card.getAttribute('data-cf-reason') || ''
    };
  })`;

async function nudgeRefilters() {
  for (let i = 0; i < NUDGES; i++) {
    await h.setStorage({ cfLiveNudge: Date.now() + i });
    await h.sleep(NUDGE_GAP_MS);
  }
}

// Loads `url` with nothing blocked, starts recording, blocks `keyword`, lets
// the content script refilter several times. Returns what was sent, stored and hidden.
async function blockAndRefilter(page, cs, url, keyword, extraStorage) {
  await h.setStorage(Object.assign({ blockedKeywords: [] }, extraStorage));
  await h.gotoYouTube(page, url);
  await h.waitForFilter(page);
  await cs.evaluate(RECORD_BATCHES);
  await h.setStorage({ blockedKeywords: [{ keyword, addedAt: Date.now() }] });
  await h.sleep(FLUSH_WAIT_MS);
  await nudgeRefilters();
  await h.sleep(FLUSH_WAIT_MS);
  return {
    batches: await cs.evaluate(READ_BATCHES),
    stored: await h.getStorage(AUTOTAG_KEYS),
    hidden: await cs.evaluate(READ_HIDDEN)
  };
}

function isEmptyObject(value) {
  return !value || Object.keys(value).length === 0;
}

// Every (key, videoKey) pair sent, with how many times it was sent.
function sentPairs(batches) {
  const counts = new Map();
  for (const batch of batches) {
    for (const [key, videoKeys] of batch) {
      for (const videoKey of videoKeys) {
        const pair = key + '\n' + videoKey;
        counts.set(pair, (counts.get(pair) || 0) + 1);
      }
    }
  }
  return counts;
}

async function runPlainScenario(page, cs) {
  const { batches, stored, hidden } = await blockAndRefilter(page, cs, PLAIN_URL, 'trailer', CLEAN_AUTOTAG);
  const result = {
    scenario: 'plain keyword',
    hiddenCards: hidden.length,
    batchesSent: batches.length,
    stored
  };
  if (hidden.length === 0) {
    result.precondition = 'no card was hidden for "trailer"';
    result.ok = true;
    return result;
  }
  result.ok = batches.length === 0 && AUTOTAG_KEYS.every(k => isEmptyObject(stored[k]));
  return result;
}

async function runTopicScenario(page, cs) {
  const { batches, stored, hidden } = await blockAndRefilter(page, cs, TOPIC_URL, 'gaming', CLEAN_AUTOTAG);
  const pairs = sentPairs(batches);
  const duplicatePairs = [...pairs].filter(([, n]) => n > 1).map(([pair]) => pair.replace('\n', ' | '));
  const foreignKeys = [...pairs.keys()].filter(pair => !pair.startsWith('gaming::'));

  const pageKeys = new Map(); // channel -> keys of its hidden cards
  for (const card of hidden) {
    if (!card.channel || !card.key) continue;
    if (!pageKeys.has(card.channel)) pageKeys.set(card.channel, new Set());
    pageKeys.get(card.channel).add(card.key);
  }
  const counted = (stored.categoryHitVideos || {}).gaming || {};
  const hits = (stored.categoryHits || {}).gaming || {};
  const tagged = ((stored.categoryTags || {}).gaming || []).slice().sort();
  const channels = Object.keys(counted).sort();
  const notOnPage = [];
  const badCounts = [];
  for (const ch of channels) {
    for (const key of counted[ch]) {
      if (!(pageKeys.get(ch) || new Set()).has(key)) notOnPage.push(ch + ' | ' + key);
    }
    if (hits[ch] !== counted[ch].length || new Set(counted[ch]).size !== counted[ch].length) badCounts.push(ch);
  }
  const expectedTagged = channels.filter(ch => counted[ch].length >= 3).sort();
  const allKeys = channels.flatMap(ch => counted[ch]);
  const idKeys = allKeys.filter(k => /^[\w-]{11}$/.test(k)).length;

  const result = {
    scenario: 'topic',
    hiddenCards: hidden.length,
    batchesSent: batches.length,
    pairsSent: pairs.size,
    duplicatePairs,
    foreignKeys,
    countedPerChannel: Object.fromEntries(channels.map(ch => [ch, counted[ch].length])),
    countedKeysNotHiddenOnPage: notOnPage,
    channelsWithBadCounts: badCounts,
    countedKeys: allKeys.length,
    countedVideoIdKeys: idKeys,
    tagged,
    expectedTagged
  };
  if (pairs.size === 0) {
    result.precondition = 'no auto-tag hit was sent for "gaming"';
    result.ok = true;
    return result;
  }
  result.ok = duplicatePairs.length === 0 && foreignKeys.length === 0 && notOnPage.length === 0 &&
    badCounts.length === 0 && idKeys > 0 && JSON.stringify(tagged) === JSON.stringify(expectedTagged);
  return result;
}

async function runUntagScenario(page, cs, channel) {
  const result = { scenario: 'untag sticks', channel };
  if (!channel) {
    result.precondition = 'no channel was tagged in the topic scenario';
    result.ok = true;
    return result;
  }

  // Options > Topics & Keywords > Gaming accordion > Untag
  const options = await h.newPage();
  try {
    await h.withTimeout(
      options.goto(`chrome-extension://${h.getExtensionId()}/options.html`, { waitUntil: 'domcontentloaded', timeout: 15000 }),
      17000, 'open options'
    );
    await h.withTimeout(options.click('.nav-item[data-section="topics"]', { timeout: 8000 }), 10000, 'open topics');
    const gaming = options.locator('.category-item', { has: options.locator('.category-name', { hasText: /^Gaming$/ }) });
    await h.withTimeout(gaming.locator('.category-name').click({ timeout: 8000 }), 10000, 'open Gaming accordion');
    const listed = () => h.withTimeout(gaming.locator('.autotag-list .list-item-name').allTextContents(), 8000, 'read tagged list');
    result.listedBefore = await listed();
    const row = gaming.locator('.autotag-list .list-item').filter({ has: options.locator('.list-item-name', { hasText: channel }) });
    await h.withTimeout(row.locator('.list-item-undo').click({ timeout: 8000 }), 10000, 'click Untag');
    const deadline = Date.now() + 8000;
    let stored;
    do {
      await h.sleep(300);
      stored = await h.getStorage(AUTOTAG_KEYS);
    } while (Date.now() < deadline && !(((stored.categoryTagExclusions || {}).gaming || []).includes(channel)));
    await h.sleep(500);
    result.listedAfter = await listed();
    result.afterUntag = {
      tagged: (stored.categoryTags || {}).gaming || [],
      excluded: (stored.categoryTagExclusions || {}).gaming || []
    };
  } finally {
    try { await h.withTimeout(options.close(), 10000, 'close options'); } catch (e) { /* ignore */ }
  }

  // The same search again in a new tab session, "gaming" blocked again.
  const { batches, stored, hidden } = await blockAndRefilter(page, cs, TOPIC_URL, 'gaming', {});
  const sentForChannel = [...sentPairs(batches).keys()].filter(pair => pair.startsWith('gaming::' + channel + '\n')).length;
  const channelCards = hidden.filter(c => c.channel === channel);
  result.afterReload = {
    hitsSentForChannel: sentForChannel,
    channelCardsHidden: channelCards.length,
    channelCardsHiddenByTag: channelCards.filter(c => c.reason.startsWith('channel-tag:')).length,
    tagged: (stored.categoryTags || {}).gaming || [],
    countedForChannel: ((stored.categoryHitVideos || {}).gaming || {})[channel] || null,
    excluded: (stored.categoryTagExclusions || {}).gaming || []
  };
  const untagWorked = result.listedBefore.includes(channel) && !result.listedAfter.includes(channel) &&
    !result.afterUntag.tagged.includes(channel) && result.afterUntag.excluded.includes(channel);
  const stuck = !result.afterReload.tagged.includes(channel) && result.afterReload.countedForChannel === null &&
    result.afterReload.excluded.includes(channel) && result.afterReload.channelCardsHiddenByTag === 0;
  if (untagWorked && stuck && sentForChannel === 0) {
    result.precondition = 'the reloaded results showed no matching video from ' + channel;
    result.ok = true;
    return result;
  }
  result.ok = untagWorked && stuck;
  return result;
}

async function main() {
  const startedAt = Date.now();
  const cancelWatchdog = h.watchdog(300000);
  let report;
  try {
    await h.launch();
    const page = await h.newPage();
    // Attached before the first navigation: it follows every CleanFeed world the page creates.
    const cs = await h.attachContentWorld(page);

    const scenarios = [];
    scenarios.push(await runPlainScenario(page, cs));
    const topic = await runTopicScenario(page, cs);
    scenarios.push(topic);
    scenarios.push(await runUntagScenario(page, cs, (topic.tagged || [])[0] || null));

    report = { ok: scenarios.every(s => s.ok), scenarios, elapsedMs: Date.now() - startedAt };
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
