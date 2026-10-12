'use strict';
// Channel names vs. YouTube's metadata text (v1.4 pre-launch fix, task 2).
//   - isValidChannelName(text): false for view/subscriber counts ("6.8M",
//     "1,2 Mln", "3 mila", "1.2K views", "views", "iscritti"), pure numbers and
//     relative dates ("2 days ago", "2 giorni fa") in common UI languages; true
//     for real names, digits and non-Latin scripts included ("Il Sole 24 Ore",
//     "4K Media", "1MILLIONTHINGS", "東海オンエア").
//   - cfMenuBlockChannel(card): the channel the 3-dot "Block channel" item
//     blocks. The card's own name (trusted when the card links the channel's
//     /@handle, else only when valid); else, on a channel page, that page's
//     channel; else null (no block item). On a channel's Videos tab the cards
//     show only "6.8M" and "3d ago" (observed live 2026-10-12): the item used
//     to block a channel named "6.8M".

const assert = require('node:assert');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');
const { el, fakeDocument } = require('./fake-dom');

const { plain } = loadContentDom;

const COUNTS = [
  // English (the compact forms are what a channel's Videos tab shows)
  '6.8M', '10M', '5.6M', '1.2K', '999K', '1.2B', '4K', '6.8M views', '1.2K views', '1 view', 'views', 'No views',
  '6.8M subscribers', '1.2K watching', 'subscribers',
  // Italian
  '6,5 Mln', '1,2 Mln', '3 mila', '1,2 Mln di visualizzazioni', '2,5 Mln di iscritti', 'visualizzazioni', 'iscritti',
  // Spanish, Portuguese, French, German, Dutch, Polish, Turkish, Indonesian, Vietnamese
  '1,2 M de visualizaciones', '1,2 mi de visualizações', '1,2 M de vues', '1,2 Mio. Aufrufe', '1,2 mln. weergaven',
  '1,2 mln wyświetleń', '1,2 Mn görüntüleme', '1,2 jt x ditonton', '1,2 Tr lượt xem',
  // Russian, Ukrainian, Arabic, Hebrew, Hindi, Thai
  '12 тыс. просмотров', '1,2 млн просмотров', '1,2 млн переглядів', '1.2 مليون مشاهدة', '1.2 מיליון צפיות',
  '68 लाख व्यू', 'การดู 1.2 ล้าน ครั้ง',
  // Japanese, Chinese, Korean
  '680万回視聴', '680万 回視聴', 'チャンネル登録者数 680万人', '680万次观看', '조회수 680만회', '구독자 1880만명',
  // compact magnitudes of more Latin-script UIs (fi, cs, sv, da, no, hu, ms, lt, et) and live viewers
  '6,8 milj.', '3,7 tis.', '6,8 mn', '3,7 tn', '3,7 t', '6,8 mill.', '3,7 E', '6.8J', '3,7 tūkst.', '3,7 tuh', '12 in attesa',
  // scripts whose words are not listed: Greek, Persian digits, Hebrew with a Latin "M"
  '6,8 εκ. προβολές', '6,8 εκ.', '۶٫۸ میلیون بازدید', '6.8M צפיות', '6,8 M צפיות',
];

const NUMBERS = ['1234', '1.234', '1,234,567', '1 234 567', '12', '6.8'];

const DATES = [
  '2 days ago', '3d ago', '3 days ago', 'Streamed 2 days ago', '1 year ago', '2 giorni fa', '3 g fa',
  'Trasmesso in live 2 giorni fa', 'hace 2 días', 'há 2 dias', 'il y a 2 jours', 'vor 2 Tagen', '2 dagen geleden',
  '2 dni temu', '2 gün önce', '2 hari yang lalu', '2 ngày trước', '2 дня назад', '2 дні тому', 'منذ 3 أيام',
  'לפני 2 ימים', '2 दिन पहले', '2 วันที่ผ่านมา', '3 日前', '3天前', '3일 전',
  'před 3 dny', 'pred 3 dňami', 'prije 3 dana', 'acum 3 zile', 'för 3 dagar sedan', 'for 3 dage siden',
  '3 päivää sitten', '3 päeva tagasi', '3 araw ang nakalipas', 'prieš 3 dienas', 'pirms 3 dienām',
  'πριν από 3 ημέρες', 'преди 3 дни', '۳ روز پیش',
];

const NAMES = [
  'Veritasium', 'Marques Brownlee', 'Il Sole 24 Ore', 'MrBeast', 'TED', 'Vsauce3', '4K Media', '1MILLIONTHINGS',
  '3Blue1Brown', '5-Minute Crafts', '100 Thieves', '60 Minutes', 'T-Series', 'ViewSonic', 'Mila Kunis Fans',
  // non-Latin names (without digits: see the next list)
  '東海オンエア', 'Тинькофф Журнал', 'مستر بيست', 'हिंदी समाचार', '보겸TV', 'Ελληνική Τηλεόραση', 'Vor Ort',
  // a digit and one Latin letter
  'U2', 'M83', 'B1A4', 'K2',
  // ends like a date word, but dates are lowercase ('3 days ago', '2 giorni fa')
  'The FA', 'Big Fa',
];

// Known limit of isValidChannelName only: a text with a digit and no Latin word
// is rejected, so counts and dates of every UI language are, also those whose
// words are not listed, and a few real names with them (every non-Latin name
// was before v1.4). The 3-dot menu still offers these names when they come
// from the card's /@handle link (see the cfMenuBlockChannel tests below).
const NON_LATIN_WITH_DIGITS = ['Россия 24', 'ช่อง 3'];

test('isValidChannelName rejects view and subscriber counts in common UI languages', () => {
  const { isValidChannelName } = loadContentDom();
  const accepted = COUNTS.filter(t => isValidChannelName(t) !== false);
  assert.deepStrictEqual(accepted, [], 'count-like strings accepted as channel names');
});

test('isValidChannelName rejects pure numbers', () => {
  const { isValidChannelName } = loadContentDom();
  assert.deepStrictEqual(NUMBERS.filter(t => isValidChannelName(t) !== false), []);
});

test('isValidChannelName rejects relative dates in common UI languages', () => {
  const { isValidChannelName } = loadContentDom();
  assert.deepStrictEqual(DATES.filter(t => isValidChannelName(t) !== false), [], 'date-like strings accepted');
});

test('isValidChannelName accepts real names: digits, "K"/"M" inside a name, non-Latin scripts', () => {
  const { isValidChannelName } = loadContentDom();
  assert.deepStrictEqual(NAMES.filter(t => isValidChannelName(t) !== true), [], 'real names rejected');
  // surrounding whitespace (textContent) does not matter
  assert.strictEqual(isValidChannelName('  MrBeast\n'), true);
});

test('isValidChannelName rejects a non-Latin text with a digit (known limit: "Россия 24")', () => {
  const { isValidChannelName } = loadContentDom();
  assert.deepStrictEqual(NON_LATIN_WITH_DIGITS.filter(t => isValidChannelName(t) !== false), []);
});

test('isValidChannelName still rejects separators, empty and over-long text', () => {
  const { isValidChannelName } = loadContentDom();
  for (const bad of ['', '   ', '•', '·', '-', ' • ', 'a', null, undefined, 'x'.repeat(61)]) {
    assert.strictEqual(isValidChannelName(bad), false, JSON.stringify(bad));
  }
});

// ── cfMenuBlockChannel ───────────────────────────────────────────────────

// A channel Videos-tab card as YouTube renders it (2026-10-12): no channel
// link or name, a metadata row with the view count, a delimiter and the date.
function videosTabCard(views, date, ...extra) {
  return el('ytd-rich-item-renderer', {},
    el('yt-lockup-view-model', {},
      ...extra,
      el('h3', {}, el('a', { href: '/watch?v=abcdefghijk' }, 'A video title')),
      el('yt-content-metadata-view-model', {},
        el('div', { class: 'ytContentMetadataViewModelMetadataRow' },
          el('span', { class: 'ytIconWrapperHost ytContentMetadataViewModelLeadingIcon' }),
          el('span', { class: 'ytAttributedStringHost ytContentMetadataViewModelMetadataText' }, views),
          el('span', { class: 'ytContentMetadataViewModelDelimiter' }, ' • '),
          el('span', { class: 'ytAttributedStringHost ytContentMetadataViewModelMetadataText' }, date)))));
}

// A search-result card with its channel's name link.
function namedCard(name, href) {
  return el('ytd-video-renderer', {},
    el('h3', {}, el('a', { href: '/watch?v=abcdefghijk' }, 'A video title')),
    el('ytd-channel-name', { id: 'channel-name' }, el('a', { href }, name)),
    el('span', { class: 'inline-metadata-item' }, '6.8M views'));
}

// 2025 channel page: the name in #page-header, no handle link (the handle
// comes from the URL), the cards in the page's grid.
function channelPage(name, ...cards) {
  return el('ytd-browse', { 'page-subtype': 'channels' },
    el('div', { id: 'page-header' }, ...(name ? [el('yt-dynamic-text-view-model', {}, name)] : [])),
    el('ytd-rich-grid-renderer', {}, ...cards));
}

function load(pathname, ...pages) {
  const doc = fakeDocument(el('ytd-app', {}, el('ytd-page-manager', { id: 'page-manager' }, ...pages)));
  return loadContentDom({ document: doc, location: { pathname } });
}

test('cfMenuBlockChannel: a Videos-tab card without a name blocks the page channel, never "6.8M"', () => {
  const card = videosTabCard('6.8M', '3d ago');
  const cf = load('/@mkbhd/videos', channelPage('Marques Brownlee', card));
  assert.strictEqual(cf.YT.getChannelName(card), null, 'the view count is not a channel name');
  assert.deepStrictEqual(plain(cf.cfMenuBlockChannel(card)), { name: 'Marques Brownlee', id: '@mkbhd' });
});

test('cfMenuBlockChannel: Italian Videos tab ("6,5 Mln", "3 giorni fa") blocks the page channel', () => {
  const card = videosTabCard('6,5 Mln', '3 giorni fa');
  const cf = load('/@mkbhd/videos', channelPage('Marques Brownlee', card));
  assert.deepStrictEqual(plain(cf.cfMenuBlockChannel(card)), { name: 'Marques Brownlee', id: '@mkbhd' });
});

test('cfMenuBlockChannel: without a header name the page handle from the URL is used', () => {
  const card = videosTabCard('10M', '9d ago');
  const cf = load('/@mkbhd/shorts', channelPage(null, card));
  assert.deepStrictEqual(plain(cf.cfMenuBlockChannel(card)), { name: 'mkbhd', id: '@mkbhd' });
});

test('cfMenuBlockChannel: a card with its own valid name blocks that channel', () => {
  const search = namedCard('Marques Brownlee', '/@mkbhd');
  const onSearch = load('/results', el('ytd-search', {}, search));
  assert.deepStrictEqual(plain(onSearch.cfMenuBlockChannel(search)), { name: 'Marques Brownlee', id: 'mkbhd' });
  // also on a channel page: the card's channel wins over the page's
  const other = namedCard('Veritasium', '/@veritasium');
  const onChannel = load('/@mkbhd', channelPage('Marques Brownlee', other));
  assert.deepStrictEqual(plain(onChannel.cfMenuBlockChannel(other)), { name: 'Veritasium', id: 'veritasium' });
});

test('cfMenuBlockChannel: a name read from the card\'s channel link is trusted ("Россия 24", "2K")', () => {
  // isValidChannelName rejects these (a digit and no Latin letter; a count
  // shape), but link text is the channel's real name: the menu keeps its
  // "Block channel" item, as before v1.4.
  for (const [name, href, id] of [
    ['Россия 24', '/@Russia24TV', 'Russia24TV'],
    ['2K', '/@2K', '2K'],
    ['חדשות 12', '/@N12News', 'N12News'],
    ['ช่อง 8', '/@Ch8Thailand', 'Ch8Thailand'],
  ]) {
    const card = namedCard(name, href);
    const onSearch = load('/results', el('ytd-search', {}, card));
    assert.deepStrictEqual(plain(onSearch.cfMenuBlockChannel(card)), { name, id }, name);
    // on another channel's page too: the card's own channel, not the page's
    const card2 = namedCard(name, href);
    const onChannel = load('/@mkbhd', channelPage('Marques Brownlee', card2));
    assert.deepStrictEqual(plain(onChannel.cfMenuBlockChannel(card2)), { name, id }, name + ' on a channel page');
  }
});

test('cfMenuBlockChannel: a name without a channel handle link is still checked', () => {
  // legacy channel-name text with no /@ link: a count there is not a name
  const card = el('ytd-video-renderer', {},
    el('h3', {}, el('a', { href: '/watch?v=abcdefghijk' }, 'A video title')),
    el('div', { id: 'channel-name' }, el('yt-formatted-string', { id: 'text' }, '6.8M')));
  const onSearch = load('/results', el('ytd-search', {}, card));
  assert.strictEqual(onSearch.YT.getChannelName(card), '6.8M', 'the legacy selector reads the text unchecked');
  assert.strictEqual(onSearch.cfMenuBlockChannel(card), null);
  // on a channel page it falls back to the page's channel
  const card2 = el('ytd-video-renderer', {},
    el('div', { id: 'channel-name' }, el('yt-formatted-string', { id: 'text' }, '6.8M')));
  const onChannel = load('/@mkbhd/videos', channelPage('Marques Brownlee', card2));
  assert.deepStrictEqual(plain(onChannel.cfMenuBlockChannel(card2)), { name: 'Marques Brownlee', id: '@mkbhd' });
});

test('cfMenuBlockChannel: no valid name anywhere gives null (no block item)', () => {
  // not a channel page: the count is never used
  const card = videosTabCard('6.8M', '3d ago');
  const onSearch = load('/results', el('ytd-search', {}, card));
  assert.strictEqual(onSearch.cfMenuBlockChannel(card), null);
  // a /channel/UC... page without a header name or handle
  const card2 = videosTabCard('6.8M', '3d ago');
  const byId = load('/channel/UCBJycsmduvYEL83R_U4JriQ/videos', channelPage(null, card2));
  assert.strictEqual(byId.cfMenuBlockChannel(card2), null);
  // a header that shows a count instead of a name is not used either
  const card3 = videosTabCard('6.8M', '3d ago');
  const countHeader = load('/channel/UCBJycsmduvYEL83R_U4JriQ/videos', channelPage('19.6M subscribers', card3));
  assert.strictEqual(countHeader.cfMenuBlockChannel(card3), null);
});

test('cfMenuBlockChannel: a nameless card that links another channel does not block the page channel', () => {
  const foreign = videosTabCard('6.8M', '3d ago', el('a', { href: '/@veritasium' })); // avatar link, no text
  const cf = load('/@mkbhd', channelPage('Marques Brownlee', foreign));
  assert.strictEqual(cf.cfMenuBlockChannel(foreign), null);
  // the page's own handle (any case) is fine
  const own = videosTabCard('6.8M', '3d ago', el('a', { href: '/@MKBHD' }));
  const cf2 = load('/@mkbhd/videos', channelPage('Marques Brownlee', own));
  assert.deepStrictEqual(plain(cf2.cfMenuBlockChannel(own)), { name: 'Marques Brownlee', id: '@mkbhd' });
});

test('cfMenuBlockChannel: a hidden cached channel page is not used on Home', () => {
  const card = videosTabCard('6.8M', '3d ago');
  const hiddenChannel = channelPage('Marques Brownlee');
  hiddenChannel.attrs.hidden = '';
  const cf = load('/', hiddenChannel, el('ytd-browse', { 'page-subtype': 'home' }, card));
  assert.strictEqual(cf.cfMenuBlockChannel(card), null);
});

test('fake DOM sanity: the Videos-tab card metadata spans are found by getChannelName selectors', () => {
  const card = videosTabCard('6.8M', '3d ago');
  fakeDocument(card);
  assert.strictEqual(card.querySelectorAll('yt-content-metadata-view-model span').length, 4);
});
