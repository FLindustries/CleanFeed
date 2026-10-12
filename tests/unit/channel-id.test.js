'use strict';
// Channel ids and @handles from links (v1.4 pre-launch fix).
//   - YT.getChannelId(card): the handle of a card's /@handle link, as written in
//     the link and without the '@' ('mkbhd', 'MKBHD'); null for /channel/UC...,
//     /c/Name and /user/Name links. The old regex turned every /channel/ link
//     into "hannel" (stored as the blocked channel's id, then @hannel).
//   - YT.getPageChannelId(): '@handle' or null, never a non-@ path.
//   - cfChannelHandle(id): a stored id that is not a handle ("hannel", a UC...
//     channel id, '/c/Name') gives no handle rule; cfBlockedChannelRules keeps
//     the entry's name.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');
const { el, fakeDocument } = require('./fake-dom');

const UC_ID = 'UCBJycsmduvYEL83R_U4JriQ';

// A video card whose channel name links to `href`, with an optional avatar
// link placed AFTER it in document order.
function card(href, avatarHref) {
  return el('ytd-video-renderer', {},
    el('div', { id: 'details' },
      el('ytd-channel-name', { id: 'channel-name' },
        el('a', { href }, 'Some Channel'))),
    ...(avatarHref ? [el('a', { id: 'avatar-link', href: avatarHref })] : []));
}

test('getChannelId: a /@handle link gives the handle as written, without the tab or query', () => {
  const { YT, cfChannelHandle } = loadContentDom();
  const cases = [
    ['/@mkbhd', 'mkbhd'],
    ['/@MKBHD/videos', 'MKBHD'],
    ['/@mkbhd?si=abc123', 'mkbhd'],
    ['/@MKBHD/videos?view=0&sort=p', 'MKBHD'],
    ['/@mkbhd#about', 'mkbhd'],
    ['/@caf%C3%A9', 'caf%C3%A9'],
  ];
  for (const [href, id] of cases) {
    assert.strictEqual(YT.getChannelId(card(href)), id, href);
    assert.strictEqual(cfChannelHandle(YT.getChannelId(card(href))), '@' + id.toLowerCase(), href);
  }
});

test('getChannelId: /channel/, /c/ and /user/ links give null, never "hannel" or a piece of the name', () => {
  const { YT } = loadContentDom();
  for (const href of [
    '/channel/' + UC_ID,
    '/channel/' + UC_ID + '/videos',
    '/channel/' + UC_ID + '?si=abc123',
    '/c/Veritasium',
    '/c/Veritasium/videos?view=0',
    '/user/marquesbrownlee',
    '/user/marquesbrownlee?si=abc123',
    // the old regex matched 'c' + 'hris' and 'channel' + 'foo' here
    '/c/chris',
    '/user/channelfoo',
    '',
  ]) {
    assert.strictEqual(YT.getChannelId(card(href)), null, href);
  }
  assert.strictEqual(YT.getChannelId(el('ytd-video-renderer', {})), null, 'no link');
});

test('getChannelId: a /@handle link in the card wins over a /channel/ channel-name link', () => {
  const { YT } = loadContentDom();
  assert.strictEqual(YT.getChannelId(card('/channel/' + UC_ID, '/@mkbhd')), 'mkbhd');
  assert.strictEqual(YT.getChannelId(card('/c/Veritasium', '/@veritasium?si=x')), 'veritasium');
});

// cfChannelIdFromHref is what the watch page's Block button stores.
test('cfHandleFromHref / cfChannelIdFromHref: only /@ paths (relative or on youtube.com) are handles', () => {
  const { cfHandleFromHref, cfChannelIdFromHref } = loadContentDom();
  assert.strictEqual(cfChannelIdFromHref('/@mkbhd'), '@mkbhd');
  assert.strictEqual(cfChannelIdFromHref('/@MKBHD/featured?si=1'), '@MKBHD');
  for (const none of ['/channel/' + UC_ID, '/c/Veritasium', '/user/marquesbrownlee', '', null]) {
    assert.strictEqual(cfChannelIdFromHref(none), null, String(none));
  }
  assert.strictEqual(cfHandleFromHref('/@mkbhd'), 'mkbhd');
  assert.strictEqual(cfHandleFromHref('/@MKBHD/shorts?si=1'), 'MKBHD');
  assert.strictEqual(cfHandleFromHref('https://www.youtube.com/@mkbhd/videos'), 'mkbhd');
  for (const none of ['/channel/' + UC_ID, '/c/Veritasium', '/user/marquesbrownlee', '/watch?v=abc&x=/@mkbhd',
    '/@', '/@/videos', '@mkbhd', 'https://example.com/@mkbhd', '', null, undefined]) {
    assert.strictEqual(cfHandleFromHref(none), null, String(none));
  }
});

// Loads content-dom.js on a channel page at `pathname` whose header holds `headerLinks`.
function channelPageAt(pathname, ...headerLinks) {
  const doc = fakeDocument(
    el('ytd-app', {},
      el('ytd-page-manager', { id: 'page-manager' },
        el('ytd-browse', { 'page-subtype': 'channels' },
          el('ytd-c4-tabbed-header-renderer', {}, ...headerLinks.map(href => el('a', { href })))))));
  return loadContentDom({ document: doc, location: { pathname } });
}

test('getPageChannelId: a /channel/, /c/ or /user/ page without a handle link gives null', () => {
  for (const pathname of ['/channel/' + UC_ID, '/channel/' + UC_ID + '/videos', '/c/Veritasium', '/user/marquesbrownlee/videos']) {
    assert.strictEqual(channelPageAt(pathname).YT.getPageChannelId(), null, pathname);
  }
});

test('getPageChannelId: the header handle link, without its tab or query', () => {
  assert.strictEqual(channelPageAt('/channel/' + UC_ID, '/@veritasium?si=abc').YT.getPageChannelId(), '@veritasium');
  assert.strictEqual(channelPageAt('/c/Veritasium', '/@Veritasium/featured').YT.getPageChannelId(), '@Veritasium');
  assert.strictEqual(channelPageAt('/@mkbhd/videos').YT.getPageChannelId(), '@mkbhd');
});

test('cfChannelHandle: an id that is not a handle gives no handle', () => {
  const { cfChannelHandle } = loadContentDom();
  // "hannel": stored for every card linking to /channel/UC... by versions before this fix
  assert.strictEqual(cfChannelHandle('hannel'), '');
  // a channel id, blocked from a /channel/ page or a watch page owner link
  assert.strictEqual(cfChannelHandle(UC_ID), '');
  assert.strictEqual(cfChannelHandle(UC_ID + '/videos'), '');
  // the watch page's Block button stored '/c/Name' and '/user/Name' as they were
  assert.strictEqual(cfChannelHandle('/c/Veritasium'), '');
  assert.strictEqual(cfChannelHandle('/user/marquesbrownlee'), '');
  assert.strictEqual(cfChannelHandle('@'), '');
  // real handles still work, including a real @hannel blocked from its own page
  assert.strictEqual(cfChannelHandle('@hannel'), '@hannel');
  assert.strictEqual(cfChannelHandle('Hannel'), '@hannel');
  assert.strictEqual(cfChannelHandle('mkbhd'), '@mkbhd');
  assert.strictEqual(cfChannelHandle('@MKBHD/videos'), '@mkbhd');
});

test('cfBlockedChannelRules: a stored { name, id: "hannel" } blocks by name, with no @hannel rule', () => {
  const { cfBlockedChannelRules } = loadContentDom();
  const only = cfBlockedChannelRules([{ name: 'Veritasium', id: 'hannel', blockedAt: 1 }]);
  assert.deepStrictEqual([...only.names], ['veritasium']);
  assert.deepStrictEqual([...only.handles], []);

  const rules = cfBlockedChannelRules([
    { name: 'Veritasium', id: 'hannel', blockedAt: 1 },
    { name: 'Marques Brownlee', id: 'mkbhd', blockedAt: 2 },        // card block
    { name: 'Linus Tech Tips', id: '@LinusTechTips/videos', blockedAt: 3 }, // page block before 1.4.0
    { name: 'By Id', id: UC_ID, blockedAt: 4 },                     // /channel/ page block
    { name: 'Legacy', id: '/c/Legacy', blockedAt: 5 },              // watch page block
    { name: 'No Id', id: null, blockedAt: 6 },
    { name: '', id: '@nameless' },
    null,
  ]);
  assert.deepStrictEqual([...rules.names], ['veritasium', 'marques brownlee', 'linus tech tips', 'by id', 'legacy', 'no id']);
  assert.deepStrictEqual([...rules.handles], ['@mkbhd', '@linustechtips', '@nameless']);
  assert.deepStrictEqual([...cfBlockedChannelRules(undefined).handles], []);
});

// content.js derives every handle through content-dom.js, so no page, card,
// peek or watch-page path turns a non-@ link into an @handle.
test('content.js builds no @handle of its own', () => {
  const content = fs.readFileSync(path.resolve(__dirname, '..', '..', 'content.js'), 'utf8');
  assert.ok(!/'@'\s*\+/.test(content), "content.js still prefixes '@' itself");
  assert.ok(!/replace\(\s*'\/channel\/'/.test(content), "content.js still strips '/channel/' from an href");
  assert.ok(/cfBlockedChannelRules\(/.test(content), 'content.js builds the blocked channel rules with cfBlockedChannelRules');
});
