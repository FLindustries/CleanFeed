'use strict';
// Shorts helpers in content-dom.js (audit finding #12). Fixtures follow the
// DOM observed on logged-out YouTube on 2026-10-12. Which element of the
// ytm-shorts-lockup-view-model(-v2) pair is a card uses `>` and `:not()`,
// which the fake DOM does not support: tests/live/shorts.js checks it on the
// real page.

const assert = require('node:assert');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');
const { el, fakeDocument } = require('./fake-dom');

// One search-result Short: the -v2 wrapper around the inner lockup.
function shortsLockup(title, id) {
  return el('ytm-shorts-lockup-view-model-v2', {},
    el('ytm-shorts-lockup-view-model', { class: 'shortsLockupViewModelHost' },
      el('a', { class: 'reel-item-endpoint', href: '/shorts/' + id }),
      el('div', { class: 'shortsLockupViewModelHostOutsideMetadata' },
        el('h3', { class: 'shortsLockupViewModelHostMetadataTitle' },
          el('a', { href: '/shorts/' + id, title },
            el('span', { role: 'text' }, title))),
        el('div', { class: 'shortsLockupViewModelHostMetadataSubhead' },
          el('span', { role: 'text' }, '17M views')))));
}

// The /shorts player's renderer: title in yt-shorts-video-title-view-model,
// channel as an /@handle/shorts link with the handle as text.
function shortsReel(title, handle, attrs) {
  return el('ytd-reel-video-renderer', Object.assign({ id: 'reel-video-renderer' }, attrs),
    el('div', { id: 'short-video-container' },
      el('video', {})),
    // Other text before the title: a heading-like panel label
    el('div', { id: 'experiment-overlay' },
      el('h3', {}, 'Shopping')),
    el('yt-reel-metapanel-view-model', {},
      el('yt-reel-channel-bar-view-model', {},
        el('a', { href: '/' + handle + '/shorts' }, handle)),
      el('yt-shorts-video-title-view-model', {},
        el('h1', { class: 'ytShortsVideoTitleViewModelShortsVideoTitle' },
          el('span', {}, title)))));
}

function shortsPage(reels, attrs) {
  return el('ytd-shorts', attrs || {},
    el('div', { id: 'shorts-container' },
      el('div', { id: 'shorts-inner-container' },
        ...reels.map((reel, i) => el('div', { id: String(i) },
          el('div', { id: 'reel-overlay-container' }, reel))))));
}

function withPages(pathname, pages) {
  const doc = fakeDocument(
    el('ytd-app', {},
      el('ytd-page-manager', { id: 'page-manager' }, ...pages)));
  return loadContentDom({ document: doc, location: { pathname } });
}

test('getVideoTitle reads a search-result Short title from its h3', () => {
  const { YT } = loadContentDom();
  const item = shortsLockup('Sena Never Forgot Maizen JJ #minecraft', 'WD5ROkEJLJk');
  assert.strictEqual(YT.getVideoTitle(item), 'Sena Never Forgot Maizen JJ #minecraft');
});

test('getChannelName finds no channel in a search-result Short (it shows none)', () => {
  const { YT } = loadContentDom();
  // The only other text is the view count, which must not pass for a channel.
  assert.strictEqual(YT.getChannelName(shortsLockup('Minecraft', '3d3Z_lb90No')), null);
});

test('getVideoTitle reads the /shorts player title, not other text in the renderer', () => {
  const { YT } = loadContentDom();
  const reel = shortsReel('Courtois X Neymar.jr skills', '@SomeChannel');
  assert.strictEqual(YT.getVideoTitle(reel), 'Courtois X Neymar.jr skills');
});

test('getChannelName reads the /shorts player channel link', () => {
  const { YT } = loadContentDom();
  assert.strictEqual(YT.getChannelName(shortsReel('Title', '@SenaVD')), '@SenaVD');
});

test('VIDEO_CARDS keeps yt-lockup-view-model last and lists the Shorts cards once', () => {
  const { YT } = loadContentDom();
  const parts = YT.VIDEO_CARDS.split(',').map(s => s.trim());
  // checkSubscriptionExceptions() appends '.cleanfeed-hidden' to the string.
  assert.strictEqual(parts[parts.length - 1], 'yt-lockup-view-model');
  assert.ok(YT.VIDEO_CARDS.includes(YT.SHORTS_CARDS));
  assert.strictEqual(YT.VIDEO_CARDS.split(YT.SHORTS_CARDS).length, 2);
});

test('getShortsPlayerReel returns the renderer of the visible /shorts page', () => {
  const reel = shortsReel('A short', '@a');
  const cf = withPages('/shorts/WD5ROkEJLJk', [el('ytd-browse', { hidden: '' }), shortsPage([reel])]);
  assert.strictEqual(cf.YT.getShortsPlayerReel(), reel);
});

test('getShortsPlayerReel prefers the [is-active] renderer when there are several', () => {
  const first = shortsReel('First', '@a');
  const active = shortsReel('Second', '@b', { 'is-active': '' });
  const cf = withPages('/shorts/abc', [shortsPage([first, active])]);
  assert.strictEqual(cf.YT.getShortsPlayerReel(), active);
});

test('getShortsPlayerReel ignores a hidden cached /shorts page', () => {
  const cachedReel = shortsReel('Cached', '@a');
  const cf = withPages('/shorts/abc', [shortsPage([cachedReel], { hidden: '' }), el('ytd-search', {})]);
  assert.strictEqual(cf.YT.getShortsPlayerReel(), null);
});

test('getShortsPlayerReel returns null outside /shorts/', () => {
  const reel = shortsReel('A short', '@a');
  for (const pathname of ['/results', '/', '/watch', '/@mkbhd/shorts', '/shorts']) {
    const cf = withPages(pathname, [shortsPage([reel])]);
    assert.strictEqual(cf.YT.getShortsPlayerReel(), null, pathname);
  }
});
