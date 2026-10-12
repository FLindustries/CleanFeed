'use strict';
// Watch/Skip prompt (audit finding #7): clicking a video that matches a blocked
// keyword used to stop playback even where CleanFeed is "off". The decision is
// the pure cfSuggestedPromptKeyword (content-dom.js); content.js feeds it the
// page state. It must say "no prompt" (null) when
//   - the page is paused, outside schedule hours, or the Subscriptions feed
//   - the card is peeked ("Show just now")
//   - the title is a discussion-style exemption of the blocked topic
//   - the channel is whitelisted for the blocked keyword AS STORED (not the
//     synonym that matched the title)
//   - the page is /results (existing behavior)
// and otherwise name the blocked keyword as stored, so the whitelist lookup and
// the prompt text use the same word filterPage uses.

const assert = require('node:assert');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');

const KW = keywords => keywords.map(keyword => ({ keyword, addedAt: 0 }));

// Same matching rule as isWhitelisted() in content.js.
function whitelistFrom(list, calls) {
  return (channelName, keyword) => {
    if (calls) calls.push([channelName, keyword]);
    if (!channelName) return false;
    const lower = channelName.toLowerCase();
    return list.some(wc => wc.name && wc.name.toLowerCase() === lower &&
      (wc.exemptFrom === '*' || wc.exemptFrom === keyword));
  };
}

// A click on a normal video card on Home, nothing paused, nothing whitelisted.
function state(overrides) {
  return Object.assign({
    pathname: '/',
    paused: false,
    outsideSchedule: false,
    peeked: false,
    title: 'Fortnite Chapter 5 victory royale',
    channelName: 'Some Streamer',
    blockedKeywords: KW(['fortnite']),
    isWhitelisted: () => false
  }, overrides);
}

// --- the normal case ---

test('a plain blocked keyword in the title intercepts and names the keyword', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  assert.strictEqual(cfSuggestedPromptKeyword(state()), 'fortnite');
});

test('a topic match names the blocked topic as stored, not the synonym that matched', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  const result = cfSuggestedPromptKeyword(state({
    title: 'Minecraft survival, episode 5',
    blockedKeywords: KW(['gaming'])
  }));
  assert.strictEqual(result, 'gaming');
});

test('the prompt shows on Home, Watch, channel pages and every page except /results', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  for (const pathname of ['/', '/watch', '/@somechannel/videos', '/feed/trending', '/playlist']) {
    assert.strictEqual(cfSuggestedPromptKeyword(state({ pathname })), 'fortnite', pathname);
  }
});

test('no match, no title or no blocked keywords: nothing to intercept', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  assert.strictEqual(cfSuggestedPromptKeyword(state({ title: 'Cooking pasta at home' })), null);
  assert.strictEqual(cfSuggestedPromptKeyword(state({ title: '' })), null);
  assert.strictEqual(cfSuggestedPromptKeyword(state({ title: null })), null);
  assert.strictEqual(cfSuggestedPromptKeyword(state({ blockedKeywords: [] })), null);
  assert.strictEqual(cfSuggestedPromptKeyword(state({ blockedKeywords: undefined })), null);
});

test('the keyword matching is the blocking one: whole words and the user\'s disabled synonyms', () => {
  const { cfSuggestedPromptKeyword, cfSetSynonymFilters } = loadContentDom();
  // "endgame" does not contain the word "game"
  assert.strictEqual(cfSuggestedPromptKeyword(state({ title: 'Endgame review', blockedKeywords: KW(['game']) })), null);
  // A synonym the user switched off in Options no longer matches the topic
  cfSetSynonymFilters(['minecraft'], {});
  assert.strictEqual(cfSuggestedPromptKeyword(state({ title: 'Minecraft survival', blockedKeywords: KW(['gaming']) })), null);
});

// --- "off" states ---

test('a paused page never prompts', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  assert.strictEqual(cfSuggestedPromptKeyword(state({ paused: true })), null);
});

test('outside the schedule window never prompts', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  assert.strictEqual(cfSuggestedPromptKeyword(state({ outsideSchedule: true })), null);
});

test('the Subscriptions feed never prompts', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  assert.strictEqual(cfSuggestedPromptKeyword(state({ pathname: '/feed/subscriptions' })), null);
  assert.strictEqual(cfSuggestedPromptKeyword(state({ pathname: '/feed/subscriptions/' })), null);
});

test('a peeked card never prompts', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  assert.strictEqual(cfSuggestedPromptKeyword(state({ peeked: true })), null);
});

test('/results never prompts (existing behavior)', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  assert.strictEqual(cfSuggestedPromptKeyword(state({ pathname: '/results' })), null);
});

test('cfFilteringDisabledForPage is true for pause, schedule-off and Subscriptions only', () => {
  const { cfFilteringDisabledForPage } = loadContentDom();
  const base = { paused: false, outsideSchedule: false, pathname: '/' };
  assert.strictEqual(cfFilteringDisabledForPage(base), false);
  assert.strictEqual(cfFilteringDisabledForPage({ ...base, paused: true }), true);
  assert.strictEqual(cfFilteringDisabledForPage({ ...base, outsideSchedule: true }), true);
  assert.strictEqual(cfFilteringDisabledForPage({ ...base, pathname: '/feed/subscriptions' }), true);
  assert.strictEqual(cfFilteringDisabledForPage({ ...base, pathname: '/feed/subscriptions/' }), true);
  assert.strictEqual(cfFilteringDisabledForPage({ ...base, pathname: '/results' }), false);
  assert.strictEqual(cfFilteringDisabledForPage({ ...base, pathname: '/feed/trending' }), false);
});

// --- exemptions ---

test('a discussion-style title of a blocked topic is exempt', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  const result = cfSuggestedPromptKeyword(state({
    title: 'The history of gaming: a documentary',
    blockedKeywords: KW(['gaming'])
  }));
  assert.strictEqual(result, null);
});

test('a plain keyword is never exempt, even one the exemption list knows', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  const result = cfSuggestedPromptKeyword(state({
    title: 'History of gaming with Minecraft',
    blockedKeywords: KW(['minecraft'])
  }));
  assert.strictEqual(result, 'minecraft');
});

test('an exempt or whitelisted keyword does not hide a second blocked keyword that matches', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  const title = 'History of gaming: Minecraft documentary';
  // "gaming" is exempt for this title, "minecraft" is a plain keyword and still matches
  assert.strictEqual(cfSuggestedPromptKeyword(state({ title, blockedKeywords: KW(['gaming', 'minecraft']) })), 'minecraft');
  // ... unless the channel is whitelisted for that one too
  assert.strictEqual(cfSuggestedPromptKeyword(state({
    title,
    blockedKeywords: KW(['gaming', 'minecraft']),
    isWhitelisted: whitelistFrom([{ name: 'Some Streamer', exemptFrom: 'minecraft' }])
  })), null);
});

// --- whitelist ---

test('a channel whitelisted for the blocked topic is not prompted when a synonym matched', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  const calls = [];
  const result = cfSuggestedPromptKeyword(state({
    title: 'Minecraft survival, episode 5',
    channelName: 'IGN',
    blockedKeywords: KW(['gaming']),
    isWhitelisted: whitelistFrom([{ name: 'IGN', id: 'UC1', exemptFrom: 'gaming' }], calls)
  }));
  assert.strictEqual(result, null);
  // The lookup used the stored keyword, never the synonym found in the title
  assert.deepStrictEqual(calls, [['IGN', 'gaming']]);
});

test('a channel whitelisted for a different keyword is still prompted', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  const result = cfSuggestedPromptKeyword(state({
    title: 'Minecraft survival, episode 5',
    channelName: 'IGN',
    blockedKeywords: KW(['gaming']),
    isWhitelisted: whitelistFrom([{ name: 'IGN', id: 'UC1', exemptFrom: 'crypto' }])
  }));
  assert.strictEqual(result, 'gaming');
});

test('a channel whitelisted for everything (*) is not prompted', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  const result = cfSuggestedPromptKeyword(state({
    channelName: 'Some Streamer',
    isWhitelisted: whitelistFrom([{ name: 'some streamer', id: 'UC2', exemptFrom: '*' }])
  }));
  assert.strictEqual(result, null);
});

test('the whitelist is asked with the keyword exactly as stored', () => {
  const { cfSuggestedPromptKeyword } = loadContentDom();
  const calls = [];
  const result = cfSuggestedPromptKeyword(state({
    title: 'Fortnite Chapter 5',
    blockedKeywords: KW(['Fortnite']),
    isWhitelisted: whitelistFrom([{ name: 'Some Streamer', exemptFrom: 'Fortnite' }], calls)
  }));
  assert.strictEqual(result, null);
  assert.deepStrictEqual(calls, [['Some Streamer', 'Fortnite']]);
});
