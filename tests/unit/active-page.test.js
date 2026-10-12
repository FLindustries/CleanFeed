'use strict';
// Page-level lookups read only the visible YouTube page. YouTube keeps pages
// visited earlier in the tab inside ytd-page-manager, hidden with the `hidden`
// attribute (audit findings #11, #14, #49). Built on the fake DOM in fake-dom.js.

const assert = require('node:assert');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');
const { el, fakeDocument } = require('./fake-dom');

// Marques Brownlee's watch page, left hidden after SPA navigation.
function hiddenWatchPage() {
  return el('ytd-watch-flexy', { hidden: '' },
    el('ytd-video-owner-renderer', {},
      el('a', { href: '/@mkbhd' }), // avatar link, no text
      el('ytd-channel-name', { class: 'ytd-video-owner-renderer' },
        el('a', { href: '/@mkbhd' }, 'Marques Brownlee'))));
}

function visibleWatchPage() {
  const page = hiddenWatchPage();
  delete page.attrs.hidden;
  return page;
}

// 2025 channel page layout: #page-header with yt-dynamic-text-view-model, no
// channel link in the header.
function channelPage(name, attrs) {
  return el('ytd-browse', Object.assign({ 'page-subtype': 'channels' }, attrs),
    el('div', { id: 'page-header' },
      el('yt-dynamic-text-view-model', {}, name)),
    el('ytd-two-column-browse-results-renderer', {}));
}

// Older channel page layout: ytd-c4-tabbed-header-renderer with an /@handle link.
function c4ChannelPage(name, handle, attrs) {
  return el('ytd-browse', Object.assign({ 'page-subtype': 'channels' }, attrs),
    el('ytd-c4-tabbed-header-renderer', {},
      el('a', { href: '/' + handle }),
      el('ytd-channel-name', { id: 'channel-name' },
        el('yt-formatted-string', { id: 'text' }, name))),
    el('ytd-two-column-browse-results-renderer', {}));
}

function homePage(attrs) {
  return el('ytd-browse', Object.assign({ 'page-subtype': 'home' }, attrs),
    el('ytd-two-column-browse-results-renderer', {}));
}

// Loads content-dom.js against a document whose ytd-page-manager holds `pages`.
function withPages(pathname, pages) {
  const doc = fakeDocument(
    el('ytd-app', {},
      el('ytd-page-manager', { id: 'page-manager' }, ...pages)));
  const cf = loadContentDom({ document: doc, location: { pathname } });
  return { cf, doc, pages };
}

test('getActivePageRoot returns the visible page, not a hidden cached one', () => {
  const { cf, pages } = withPages('/@veritasium', [hiddenWatchPage(), channelPage('Veritasium')]);
  assert.strictEqual(cf.YT.getActivePageRoot(), pages[1]);
});

test('getActivePageRoot skips non-page children of the page manager', () => {
  const { cf, pages } = withPages('/', [
    el('div', { class: 'not-a-page' }, 'some text'),
    channelPage('Veritasium', { hidden: '' }),
    homePage()
  ]);
  assert.strictEqual(cf.YT.getActivePageRoot(), pages[2]);
});

test('getActivePageRoot falls back to document without a page manager or a visible page', () => {
  const noManager = fakeDocument(el('ytd-app', {}, homePage()));
  const cf1 = loadContentDom({ document: noManager });
  assert.strictEqual(cf1.YT.getActivePageRoot(), noManager);

  const { cf, doc } = withPages('/', [hiddenWatchPage(), homePage({ hidden: '' })]);
  assert.strictEqual(cf.YT.getActivePageRoot(), doc);
});

test('isChannelPage is false on Home after visiting a channel (hidden channel page stays in the DOM)', () => {
  const { cf } = withPages('/', [
    hiddenWatchPage(),
    c4ChannelPage('Veritasium', '@veritasium', { hidden: '' }),
    homePage()
  ]);
  assert.strictEqual(cf.YT.isChannelPage(), false);
});

test('isChannelPage is false on search and watch pages after visiting a channel', () => {
  const search = withPages('/results', [
    channelPage('Veritasium', { hidden: '' }),
    el('ytd-search', { 'page-subtype': 'search' })
  ]);
  assert.strictEqual(search.cf.YT.isChannelPage(), false);
  const watch = withPages('/watch', [channelPage('Veritasium', { hidden: '' }), visibleWatchPage()]);
  assert.strictEqual(watch.cf.YT.isChannelPage(), false);
});

test('isChannelPage: the URL check, or a visible channel page when YouTube drops the /@ path', () => {
  const byUrl = withPages('/@veritasium', [homePage({ hidden: '' })]);
  assert.strictEqual(byUrl.cf.YT.isChannelPage(), true);
  const byDom = withPages('/veritasium', [homePage({ hidden: '' }), channelPage('Veritasium')]);
  assert.strictEqual(byDom.cf.YT.isChannelPage(), true);
});

test('isChannelPage without a page manager counts only channel pages that are not hidden', () => {
  const hidden = fakeDocument(el('ytd-app', {}, c4ChannelPage('Veritasium', '@veritasium', { hidden: '' })));
  assert.strictEqual(loadContentDom({ document: hidden }).YT.isChannelPage(), false);
  const shown = fakeDocument(el('ytd-app', {}, c4ChannelPage('Veritasium', '@veritasium')));
  assert.strictEqual(loadContentDom({ document: shown }).YT.isChannelPage(), true);
});

test('getPageChannelName on a channel page ignores the hidden watch page owner', () => {
  const modern = withPages('/@veritasium', [hiddenWatchPage(), channelPage('Veritasium')]);
  assert.strictEqual(modern.cf.YT.getPageChannelName(), 'Veritasium');
  const c4 = withPages('/@veritasium', [hiddenWatchPage(), c4ChannelPage('Veritasium', '@veritasium')]);
  assert.strictEqual(c4.cf.YT.getPageChannelName(), 'Veritasium');
});

test('getPageChannelId on a channel page ignores the hidden watch page owner', () => {
  const modern = withPages('/@veritasium', [hiddenWatchPage(), channelPage('Veritasium')]);
  assert.strictEqual(modern.cf.YT.getPageChannelId(), '@veritasium');
  // /channel/UC... URL: the handle can only come from the visible header link.
  const c4 = withPages('/channel/UCHnyfMqiRRG1u-2MsSQLbXA', [hiddenWatchPage(), c4ChannelPage('Veritasium', '@veritasium')]);
  assert.strictEqual(c4.cf.YT.getPageChannelId(), '@veritasium');
});

test('getPageChannelName/Id on a watch page read the visible owner, not a hidden channel page', () => {
  const { cf } = withPages('/watch', [c4ChannelPage('Veritasium', '@veritasium', { hidden: '' }), visibleWatchPage()]);
  assert.strictEqual(cf.YT.getPageChannelName(), 'Marques Brownlee');
  assert.strictEqual(cf.YT.getPageChannelId(), '@mkbhd');
});

test('fake DOM sanity: document-order matching across descendant selectors', () => {
  const { doc } = withPages('/', [hiddenWatchPage(), channelPage('Veritasium')]);
  assert.strictEqual(doc.querySelector('ytd-channel-name.ytd-video-owner-renderer a').textContent, 'Marques Brownlee');
  assert.strictEqual(doc.querySelectorAll('ytd-browse[page-subtype="channels"] #page-header yt-dynamic-text-view-model').length, 1);
  assert.strictEqual(doc.querySelector('a[href^="/@"]').getAttribute('href'), '/@mkbhd');
  assert.throws(() => doc.querySelector('ytd-browse > div'), /unsupported selector/);
});
