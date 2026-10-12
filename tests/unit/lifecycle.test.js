'use strict';
// Install / update and a dead extension context (audit findings #16, #46).
//   - background.js: on install and update, every open YouTube tab gets
//     styles/content.css and the content scripts in manifest order
//     (features.js, content-dom.js, content.js); a tab that fails is skipped.
//   - cfSendMessage (content-dom.js), behind content.js sendMsg(): resolves to
//     the background's answer, or to null when sending fails (never a
//     success-looking {}); a dead extension context is reported once.
//   - cfClearCleanFeedPage (content-dom.js): removes every piece of CleanFeed UI
//     and the classes / attributes CleanFeed put on YouTube's own elements, so a
//     new content script never inherits an orphaned one's leftovers.
//   - manifest: the scripting permission, version 1.4.0; both locales carry
//     the two new toasts.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');
const loadBackground = require('./load-background');
const { el, fakeDocument } = require('./fake-dom');

const ROOT = path.resolve(__dirname, '..', '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const MANIFEST = readJson('manifest.json');
const YOUTUBE_MATCH = '*://*.youtube.com/*';
const YT_TABS = [
  { id: 11, url: 'https://www.youtube.com/watch?v=abc' },
  { id: 12, url: 'https://m.youtube.com/results?search_query=x' }
];

// ── background.js: open tabs on install / update ─────────────────────────

function youTubeEntry() {
  return MANIFEST.content_scripts.find(cs => cs.matches.includes(YOUTUBE_MATCH));
}

function expectedInjection(tabId) {
  return [
    { method: 'insertCSS', tabId, files: ['styles/content.css'] },
    { method: 'executeScript', tabId, files: ['features.js', 'content-dom.js', 'content.js'] }
  ];
}

test('manifest: scripting permission, version 1.4.0, YouTube scripts load features.js first', () => {
  assert.ok(MANIFEST.permissions.includes('scripting'), 'permissions include scripting');
  assert.strictEqual(MANIFEST.version, '1.4.0');
  assert.deepStrictEqual(youTubeEntry().js, ['features.js', 'content-dom.js', 'content.js']);
  assert.deepStrictEqual(youTubeEntry().css, ['styles/content.css']);
});

for (const reason of ['install', 'update']) {
  test(`${reason}: every open YouTube tab gets content.css, then the content scripts in manifest order`, async () => {
    const bg = loadBackground({}, { tabs: YT_TABS });
    await bg.listeners.onInstalled[0]({ reason });
    assert.deepStrictEqual(bg.tabsQueries, [{ url: [YOUTUBE_MATCH] }]);
    for (const tab of YT_TABS) {
      assert.deepStrictEqual(bg.scriptingCalls.filter(c => c.tabId === tab.id), expectedInjection(tab.id), `tab ${tab.id}`);
    }
    assert.strictEqual(bg.scriptingCalls.length, 4);
  });
}

test('a Chrome update injects nothing: the running content scripts are still connected', async () => {
  const bg = loadBackground({}, { tabs: YT_TABS });
  await bg.listeners.onInstalled[0]({ reason: 'chrome_update' });
  assert.deepStrictEqual(bg.tabsQueries, []);
  assert.deepStrictEqual(bg.scriptingCalls, []);
});

test('a tab that cannot be injected is skipped; the other tabs and storage setup still happen', async () => {
  const bg = loadBackground({}, {
    tabs: YT_TABS,
    scriptingError: call => (call.tabId === 11 ? new Error('Frame with ID 0 is showing error page') : null)
  });
  await bg.listeners.onInstalled[0]({ reason: 'update' }); // must not reject
  assert.deepStrictEqual(bg.scriptingCalls.filter(c => c.tabId === 12), expectedInjection(12));
  assert.deepStrictEqual(bg.scriptingCalls.filter(c => c.tabId === 11), [expectedInjection(11)[0]],
    'a tab whose CSS injection failed gets no scripts');
  assert.ok(bg.storage().settings, 'Storage.init() ran');
});

test('no open YouTube tab: nothing is injected', async () => {
  const bg = loadBackground({}, { tabs: [] });
  await bg.listeners.onInstalled[0]({ reason: 'install' });
  assert.strictEqual(bg.tabsQueries.length, 1);
  assert.deepStrictEqual(bg.scriptingCalls, []);
});

// ── cfSendMessage: the sendMsg wrapper ───────────────────────────────────

// A chrome.runtime stand-in. Answers asynchronously like Chrome: sets
// lastError (when `lastError` is given) only while the callback runs.
function fakeRuntime({ respond, lastError, throws, id = 'cleanfeedtestid' } = {}) {
  const runtime = { id, lastError: undefined, sent: [] };
  runtime.sendMessage = (payload, callback) => {
    runtime.sent.push(payload);
    if (throws) throw new Error(throws);
    setTimeout(() => {
      runtime.lastError = lastError ? { message: lastError } : undefined;
      try { callback(respond); } finally { runtime.lastError = undefined; }
    }, 0);
  };
  return runtime;
}

function deadCounter() {
  const counter = () => { counter.calls++; };
  counter.calls = 0;
  return counter;
}

test('sendMsg: an answer resolves to that answer', async () => {
  const { cfSendMessage } = loadContentDom();
  const answer = { success: true };
  const runtime = fakeRuntime({ respond: answer });
  const onDead = deadCounter();
  const result = await cfSendMessage(runtime, { action: 'blockChannel', channelName: 'X' }, onDead);
  assert.strictEqual(result, answer);
  assert.deepStrictEqual(loadContentDom.plain(runtime.sent), [{ action: 'blockChannel', channelName: 'X' }]);
  assert.strictEqual(onDead.calls, 0);
});

test('sendMsg: chrome.runtime.lastError resolves to null, not a success-looking {}', async () => {
  const { cfSendMessage } = loadContentDom();
  const runtime = fakeRuntime({ respond: undefined, lastError: 'Could not establish connection. Receiving end does not exist.' });
  const onDead = deadCounter();
  assert.strictEqual(await cfSendMessage(runtime, { action: 'getFullState' }, onDead), null);
  assert.strictEqual(onDead.calls, 0, 'a live context with a failed send is not dead');
});

test('sendMsg: a thrown "Extension context invalidated" resolves to null and reports the dead context', async () => {
  const { cfSendMessage } = loadContentDom();
  const runtime = fakeRuntime({ throws: 'Extension context invalidated.' });
  const onDead = deadCounter();
  assert.strictEqual(await cfSendMessage(runtime, { action: 'addKeyword', keyword: 'x' }, onDead), null);
  assert.strictEqual(onDead.calls, 1);
});

test('sendMsg: lastError "Extension context invalidated." resolves to null and reports the dead context', async () => {
  const { cfSendMessage } = loadContentDom();
  const runtime = fakeRuntime({ lastError: 'Extension context invalidated.' });
  const onDead = deadCounter();
  assert.strictEqual(await cfSendMessage(runtime, { action: 'getFullState' }, onDead), null);
  assert.strictEqual(onDead.calls, 1);
});

test('sendMsg: a runtime without an id (invalidated) is dead whatever the error says', async () => {
  const { cfSendMessage } = loadContentDom();
  const runtime = fakeRuntime({ throws: "Cannot read properties of undefined (reading 'sendMessage')" });
  delete runtime.id;
  const onDead = deadCounter();
  assert.strictEqual(await cfSendMessage(runtime, { action: 'getFullState' }, onDead), null);
  assert.strictEqual(onDead.calls, 1);
  assert.strictEqual(await cfSendMessage(undefined, { action: 'getFullState' }, onDead), null, 'no runtime at all');
  assert.strictEqual(onDead.calls, 2);
});

test('sendMsg: an empty answer resolves to null', async () => {
  const { cfSendMessage } = loadContentDom();
  assert.strictEqual(await cfSendMessage(fakeRuntime({ respond: undefined }), { action: 'x' }), null);
});

test('sendMsg: never rejects, also without an onDead callback', async () => {
  const { cfSendMessage } = loadContentDom();
  assert.strictEqual(await cfSendMessage(fakeRuntime({ throws: 'Extension context invalidated.' }), { action: 'x' }), null);
  assert.strictEqual(await cfSendMessage(fakeRuntime({ lastError: 'boom' }), { action: 'x' }), null);
});

test('cfIsContextInvalidated recognises the dead-context error only', () => {
  const { cfIsContextInvalidated } = loadContentDom();
  assert.strictEqual(cfIsContextInvalidated(new Error('Extension context invalidated.')), true);
  assert.strictEqual(cfIsContextInvalidated({ message: 'Extension context invalidated.' }), true);
  assert.strictEqual(cfIsContextInvalidated(new Error('Could not establish connection. Receiving end does not exist.')), false);
  assert.strictEqual(cfIsContextInvalidated(undefined), false);
});

// ── cfClearCleanFeedPage: no inherited leftovers ─────────────────────────

test('cfIsCleanFeedUi: CleanFeed elements yes, YouTube elements carrying a CleanFeed state class no', () => {
  const { cfIsCleanFeedUi } = loadContentDom();
  const ui = [
    el('button', { id: 'cleanfeed-pause-toggle', class: 'cf-switch cf-on' }),
    el('button', { class: 'cf-switch cleanfeed-channel-peek-btn' }),
    el('style', { id: 'cleanfeed-prehide' }),
    el('div', { id: 'cf-channel-blocked-msg', class: 'cleanfeed-toast' }),
    el('button', { class: 'cleanfeed-quickadd-btn' }),
    el('div', { class: 'cleanfeed-menu-item cleanfeed-menu-item-topic' }),
    el('div', { class: 'cleanfeed-toast cf-exit' })
  ];
  for (const node of ui) assert.strictEqual(cfIsCleanFeedUi(node), true, node.tagName + ' ' + node.className);
  const youtube = [
    el('ytd-video-renderer', { class: 'style-scope cleanfeed-hidden' }),
    el('body', { class: 'cleanfeed-hide-shorts cleanfeed-hide-comments cleanfeed-paused cleanfeed-time-limit-reached' }),
    el('ytd-rich-section-renderer', { class: 'cleanfeed-relevant-hidden' }),
    el('div', { id: 'contents' })
  ];
  for (const node of youtube) assert.strictEqual(cfIsCleanFeedUi(node), false, node.tagName + ' ' + node.className);
});

// A page as an older CleanFeed instance leaves it.
function pageLeftBehind() {
  const shortsChip = el('yt-chip-cloud-chip-renderer', {}, ' Shorts ');
  shortsChip.style.display = 'none';
  const otherChip = el('yt-chip-cloud-chip-renderer', {}, 'Music');
  otherChip.style.display = 'none';
  const doc = fakeDocument(
    el('head', {}, el('style', { id: 'cleanfeed-prehide' })),
    el('body', { class: 'yt-app cleanfeed-hide-shorts cleanfeed-hide-comments cleanfeed-paused cleanfeed-time-limit-reached' },
      el('ytd-masthead', {}, el('div', { id: 'center' },
        el('button', { id: 'cleanfeed-pause-toggle', class: 'cf-switch cf-on' }, el('span', { class: 'cf-switch-label' }, 'CleanFeed')))),
      el('ytd-video-renderer', {
        class: 'style-scope cleanfeed-hidden', 'data-cf-checked': 'true', 'data-cf-reason': 'channel-tag:gaming',
        'data-cf-quickadd-injected': 'true'
      }, el('a', { id: 'video-title' }, 'Minecraft house'), el('button', { class: 'cleanfeed-quickadd-btn' }, el('span', {}, 'CF+'))),
      el('div', { id: 'contents', class: 'cleanfeed-hidden', 'data-cf-blocked': 'some channel' }),
      el('div', { id: 'cf-channel-blocked-msg', class: 'cleanfeed-toast' }, el('button', { class: 'cleanfeed-btn' }, 'Show just now')),
      el('ytd-rich-section-renderer', { class: 'cleanfeed-relevant-hidden' }),
      el('input', { id: 'search', 'data-cf-search-intercepted': 'true' }),
      el('ytd-reel-video-renderer', { 'data-cf-reel-key': 'title\n/@x', 'data-cf-paused-video': 'true' }),
      el('ytd-popup-container', {}, el('tp-yt-paper-listbox', {},
        el('ytd-menu-service-item-renderer', {}, "Don't recommend channel"),
        el('div', { class: 'cleanfeed-menu-separator', 'data-cf-menu-token': '1' }),
        el('div', { class: 'cleanfeed-menu-item', 'data-cf-channel': 'X', 'data-cf-menu-token': '1' }),
        el('div', { class: 'cleanfeed-menu-item cleanfeed-menu-item-topic', 'data-cf-menu-token': '1' }))),
      el('div', { class: 'cleanfeed-toast' }, el('span', { class: 'cleanfeed-toast-text' }, 'Blocked "X"')),
      el('div', { id: 'cleanfeed-topic-menu', class: 'cleanfeed-inline-banner' }),
      el('div', { class: 'cleanfeed-autotag-banner' }),
      el('div', { class: 'cleanfeed-channel-tabs-buttons' }, el('button', { class: 'cleanfeed-channel-block-btn' })),
      el('div', { id: 'cleanfeed-quickadd-popover', class: 'cleanfeed-quickadd-overlay' }),
      shortsChip,
      otherChip));
  doc.documentElement.attrs['data-cleanfeed-instance'] = 'old-instance';
  return { doc, shortsChip, otherChip };
}

const STATE_ATTRS = ['data-cf-checked', 'data-cf-blocked', 'data-cf-reason', 'data-cf-quickadd-injected',
  'data-cf-search-intercepted', 'data-cf-reel-key'];

test('cfClearCleanFeedPage removes all CleanFeed UI and keeps every YouTube element', () => {
  const { cfClearCleanFeedPage } = loadContentDom();
  const { doc } = pageLeftBehind();
  cfClearCleanFeedPage(doc);
  const left = doc.querySelectorAll('[id^="cleanfeed-"], #cf-channel-blocked-msg, .cf-switch, [class*="cleanfeed-"]');
  assert.deepStrictEqual(left.map(n => n.tagName + '.' + n.className), [], 'no CleanFeed element or class is left');
  for (const sel of ['ytd-masthead #center', 'ytd-video-renderer #video-title', '#contents', 'ytd-rich-section-renderer',
    'input#search', 'ytd-reel-video-renderer', 'tp-yt-paper-listbox ytd-menu-service-item-renderer', 'head', 'body']) {
    assert.ok(doc.querySelector(sel), sel + ' is kept');
  }
  assert.strictEqual(doc.querySelector('tp-yt-paper-listbox').children.length, 1, 'only YouTube\'s own menu item stays');
  assert.strictEqual(doc.querySelector('body').className, 'yt-app', 'YouTube\'s own body class stays');
  assert.strictEqual(doc.querySelector('ytd-video-renderer').className, 'style-scope');
});

test('cfClearCleanFeedPage clears the attributes CleanFeed put on YouTube elements and shows the Shorts chip again', () => {
  const { cfClearCleanFeedPage } = loadContentDom();
  const { doc, shortsChip, otherChip } = pageLeftBehind();
  cfClearCleanFeedPage(doc);
  for (const attr of STATE_ATTRS) assert.deepStrictEqual(doc.querySelectorAll('[' + attr + ']'), [], attr);
  assert.strictEqual(shortsChip.style.display, '', 'the Shorts chip CleanFeed hid is shown again');
  assert.strictEqual(otherChip.style.display, 'none', 'another chip is left alone');
  // "CleanFeed paused this video": whoever runs the page next may resume it
  assert.strictEqual(doc.querySelector('ytd-reel-video-renderer').getAttribute('data-cf-paused-video'), 'true');
  assert.strictEqual(doc.documentElement.getAttribute('data-cleanfeed-instance'), 'old-instance', 'the page marker is not touched');
});

test('the instance marker attribute is the one content.js and the tests use', () => {
  const { CF_INSTANCE_ATTR } = loadContentDom();
  assert.strictEqual(CF_INSTANCE_ATTR, 'data-cleanfeed-instance');
});

test('cfPageRanCleanFeed: a marker, or the traces of a version without one, means a takeover', () => {
  const { cfPageRanCleanFeed } = loadContentDom();
  const page = (...children) => fakeDocument(el('body', {}, el('ytd-app', {}, ...children)));
  assert.strictEqual(cfPageRanCleanFeed(page(el('ytd-video-renderer', { class: 'style-scope' }))), false, 'fresh page');
  const marked = page();
  marked.documentElement.attrs['data-cleanfeed-instance'] = 'old';
  assert.strictEqual(cfPageRanCleanFeed(marked), true, 'marker');
  // v1.3.2 sets no marker but always adds its pre-hide style sheet
  assert.strictEqual(cfPageRanCleanFeed(fakeDocument(el('head', {}, el('style', { id: 'cleanfeed-prehide' })))), true, 'pre-hide style');
  assert.strictEqual(cfPageRanCleanFeed(page(el('ytd-video-renderer', { 'data-cf-checked': 'true' }))), true, 'checked card');
  assert.strictEqual(cfPageRanCleanFeed(page(el('ytd-video-renderer', { 'data-cf-quickadd-injected': 'true' }))), true, 'CF+ card');
});

// ── Locales ──────────────────────────────────────────────────────────────

test('both locales carry the dead-context toast and the failure toast', () => {
  const en = readJson('_locales/en/messages.json');
  const it = readJson('_locales/it/messages.json');
  assert.strictEqual(en.extensionUpdatedToast.message, 'CleanFeed was updated — reload this page');
  assert.ok(it.extensionUpdatedToast && it.extensionUpdatedToast.message, 'Italian extensionUpdatedToast');
  assert.ok(en.actionFailedToast && en.actionFailedToast.message, 'English actionFailedToast');
  assert.ok(it.actionFailedToast && it.actionFailedToast.message, 'Italian actionFailedToast');
});
