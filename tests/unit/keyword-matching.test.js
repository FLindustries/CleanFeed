'use strict';
// Keyword matching engine (audit findings #10, #9, #47, #48):
//   - matchesKeyword treats letters and digits of every script as word characters
//   - getExpandedKeywords expands ONLY a category key, never a mere synonym
//   - the built-in synonym lists hold no standalone everyday words

const assert = require('node:assert');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');

const { plain } = loadContentDom;

// --- #10: Unicode-aware word boundaries ---

test('matchesKeyword matches accented words (Italian)', () => {
  const { matchesKeyword } = loadContentDom();
  assert.strictEqual(matchesKeyword('Attualità e politica', 'attualità'), true);
  assert.strictEqual(matchesKeyword('Tour della città di Roma', 'città'), true);
  assert.strictEqual(matchesKeyword('La città più bella', 'città'), true);
  assert.strictEqual(matchesKeyword('Tour della città di Roma', 'tour della città'), true);
});

test('matchesKeyword matches non-Latin scripts', () => {
  const { matchesKeyword } = loadContentDom();
  assert.strictEqual(matchesKeyword('Обзор игры', 'игры'), true);
  assert.strictEqual(matchesKeyword('Политика сегодня', 'политика'), true);
  assert.strictEqual(matchesKeyword('먹방 ASMR', '먹방'), true);
  assert.strictEqual(matchesKeyword('今日 ニュース まとめ', 'ニュース'), true);
  assert.strictEqual(matchesKeyword('Ελληνική πολιτική σήμερα', 'πολιτική'), true);
});

test('matchesKeyword does not match inside a longer non-Latin or accented word', () => {
  const { matchesKeyword } = loadContentDom();
  assert.strictEqual(matchesKeyword('Политика', 'полит'), false);
  assert.strictEqual(matchesKeyword('Обзор игрыми', 'игры'), false);
  assert.strictEqual(matchesKeyword('università', 'università'), true);
  assert.strictEqual(matchesKeyword('universitàs', 'università'), false);
  // Combining marks belong to the word (Devanagari vowel sign after the keyword's last letter)
  assert.strictEqual(matchesKeyword('हिंदी समाचार', 'हिंद'), false);
});

test('matchesKeyword matches keywords that start or end with a symbol', () => {
  const { matchesKeyword } = loadContentDom();
  assert.strictEqual(matchesKeyword('Learning C++ fast', 'c++'), true);
  assert.strictEqual(matchesKeyword('C++', 'c++'), true);
  assert.strictEqual(matchesKeyword('Why I quit C#, honestly', 'c#'), true);
  assert.strictEqual(matchesKeyword('Top 10 #shorts of the week', '#shorts'), true);
  assert.strictEqual(matchesKeyword('Learning C fast', 'c++'), false);
  assert.strictEqual(matchesKeyword('F1 2024 highlights', 'f1'), true);
  assert.strictEqual(matchesKeyword('F12 key', 'f1'), false);
});

test('matchesKeyword keeps ASCII behavior: whole words only, case-insensitive', () => {
  const { matchesKeyword } = loadContentDom();
  assert.strictEqual(matchesKeyword('display', 'play'), false);
  assert.strictEqual(matchesKeyword('endgame', 'game'), false);
  assert.strictEqual(matchesKeyword('How to PLAY chess', 'play'), true);
  assert.strictEqual(matchesKeyword('snake_case naming', 'case'), false);
  assert.strictEqual(matchesKeyword('Top 10 games', 'game'), false);
  assert.strictEqual(matchesKeyword('Gen Z', 'z'), true);
});

test('matchesKeyword treats typographic apostrophes like a plain apostrophe', () => {
  const { matchesKeyword } = loadContentDom();
  assert.strictEqual(matchesKeyword('Baldur\u2019s Gate 3', "baldur's gate"), true);
  assert.strictEqual(matchesKeyword("Baldur's Gate 3", 'baldur\u2019s gate'), true);
  assert.strictEqual(matchesKeyword('Baldur\u2018s Gate 3', "baldur's gate"), true);
  assert.strictEqual(matchesKeyword('Baldur\u02BCs Gate 3', "baldur's gate"), true);
  assert.strictEqual(matchesKeyword("Let\u2019s Play Zelda", "let's play"), true);
});

test('matchesKeyword normalizes NFC but never strips diacritics', () => {
  const { matchesKeyword } = loadContentDom();
  // Decomposed "à" (a + combining grave) in the title, composed in the keyword, and vice versa
  assert.strictEqual(matchesKeyword('citta\u0300 vecchia', 'città'), true);
  assert.strictEqual(matchesKeyword('città vecchia', 'citta\u0300'), true);
  // No diacritic stripping: "citta" is not "città", "ano" is not "año"
  assert.strictEqual(matchesKeyword('Tour della città', 'citta'), false);
  assert.strictEqual(matchesKeyword('Tour della citta', 'città'), false);
  assert.strictEqual(matchesKeyword('Mi año nuevo', 'ano'), false);
});

test('matchesKeyword still escapes regex characters and rejects empty input', () => {
  const { matchesKeyword } = loadContentDom();
  assert.strictEqual(matchesKeyword('node.js tips', 'node.js'), true);
  assert.strictEqual(matchesKeyword('nodexjs tips', 'node.js'), false);
  assert.strictEqual(matchesKeyword('(what) is [this]?', '(what)'), true);
  assert.strictEqual(matchesKeyword('1+1=2', '1+1'), true);
  assert.strictEqual(matchesKeyword('anything', ''), false);
  assert.strictEqual(matchesKeyword('', 'anything'), false);
  assert.strictEqual(matchesKeyword(null, 'anything'), false);
});

test('matchesKeyword returns consistent results on repeated calls (caches)', () => {
  const { matchesKeyword } = loadContentDom();
  for (let i = 0; i < 3; i++) {
    // Alternating texts and keywords must never reuse a stale normalized text or regex
    assert.strictEqual(matchesKeyword('Tour della città', 'città'), true);
    assert.strictEqual(matchesKeyword('Tour della citta', 'città'), false);
    assert.strictEqual(matchesKeyword('Tour della città', 'tour'), true);
    assert.strictEqual(matchesKeyword('Tour della citta', 'tour'), true);
    assert.strictEqual(matchesKeyword('Tour della città', 'citta'), false);
  }
});

test('matchesKeyword finds a whole-word occurrence after an embedded one', () => {
  const { matchesKeyword } = loadContentDom();
  assert.strictEqual(matchesKeyword('endgame and game night', 'game'), true);
  assert.strictEqual(matchesKeyword('endgame and gamers', 'game'), false);
  assert.strictEqual(matchesKeyword("Un'altra città, un'altra città", 'città'), true);
});

// --- #9: expand only a category key ---

test('getExpandedKeywords: blocking a mere synonym blocks just that word', () => {
  const { getExpandedKeywords } = loadContentDom();
  const minecraft = plain(getExpandedKeywords('minecraft'));
  assert.deepStrictEqual(minecraft, ['minecraft']);
  assert.ok(!minecraft.includes('fortnite'));
  assert.deepStrictEqual(plain(getExpandedKeywords('NBA')), ['nba']);
  assert.deepStrictEqual(plain(getExpandedKeywords('bitcoin')), ['bitcoin']);
  assert.deepStrictEqual(plain(getExpandedKeywords('trump')), ['trump']);
});

test('getExpandedKeywords: a category key expands to the category and its synonyms', () => {
  const { getExpandedKeywords } = loadContentDom();
  const gaming = plain(getExpandedKeywords('gaming'));
  assert.strictEqual(gaming[0], 'gaming');
  assert.ok(gaming.includes('minecraft'));
  assert.ok(gaming.includes('fortnite'));
  const crypto = plain(getExpandedKeywords('Crypto'));
  assert.strictEqual(crypto[0], 'crypto');
  assert.ok(crypto.includes('bitcoin'));
});

test('getExpandedKeywords: names inherited from Object.prototype are not categories', () => {
  const { getExpandedKeywords } = loadContentDom();
  assert.deepStrictEqual(plain(getExpandedKeywords('constructor')), ['constructor']);
  assert.deepStrictEqual(plain(getExpandedKeywords('__proto__')), ['__proto__']);
  assert.deepStrictEqual(plain(getExpandedKeywords('hasownproperty')), ['hasownproperty']);
});

test('custom synonyms still expand with their category, and only with it', () => {
  const { getExpandedKeywords, cfSetSynonymFilters } = loadContentDom();
  cfSetSynonymFilters([], { gaming: ['palia'], crypto: ['cardano'] });
  const gaming = plain(getExpandedKeywords('gaming'));
  assert.ok(gaming.includes('palia'));
  assert.ok(!gaming.includes('cardano'));
  // Blocking the custom synonym on its own blocks just that word
  assert.deepStrictEqual(plain(getExpandedKeywords('palia')), ['palia']);
  // Blocking a built-in synonym of the same category does not pull in the customs
  assert.deepStrictEqual(plain(getExpandedKeywords('minecraft')), ['minecraft']);
});

test('disabled synonyms are filtered from a category expansion', () => {
  const { getExpandedKeywords, cfSetSynonymFilters } = loadContentDom();
  cfSetSynonymFilters(['Minecraft'], {});
  const gaming = plain(getExpandedKeywords('gaming'));
  assert.ok(!gaming.includes('minecraft'));
  assert.ok(gaming.includes('fortnite'));
});

test('category exemptions apply only to category blocks', () => {
  const { isCategoryExempt, getExpandedKeywords } = loadContentDom();
  const title = 'The history of Nintendo consoles and minecraft';
  // Category block: discussion-style title is exempt
  assert.strictEqual(isCategoryExempt(title, 'gaming'), true);
  // Blocking only the word "minecraft": it is not a category, so no exemption applies
  assert.strictEqual(isCategoryExempt(title, 'minecraft'), false);
  assert.deepStrictEqual(plain(getExpandedKeywords('minecraft')), ['minecraft']);
  // Inherited Object.prototype names are not categories either (no crash, no exemption)
  assert.strictEqual(isCategoryExempt(title, 'constructor'), false);
  assert.strictEqual(isCategoryExempt(title, '__proto__'), false);
});

// --- #47 / #48: no standalone everyday words in the built-in synonyms ---

// Every standalone term the audit named as an everyday word, per category.
const REMOVED_STANDALONE = {
  gaming: ['persona', 'forza', 'sonic', 'sims'],
  sports: ['partita'],
  politics: ['destra', 'sinistra', 'governo'],
  gossip: ['tea', 'beef', 'drama', 'exposed', 'cancelled'],
  horror: ['paura'],
  religion: ['cristiano', 'rosario', 'pastor'],
  gambling: ['slot', 'stake'],
  kpop: ['twice', 'seventeen'],
  asmr: ['whisper'],
  travel: ['what to do in'],
  beauty: ['trucco'],
  pranks: ['scherzo', 'scherzi'],
  nsfw: ['hot tub'],
  crypto: ['shiba inu']
};

test('none of the removed everyday words remain as standalone synonyms', () => {
  const { KEYWORD_SYNONYMS } = loadContentDom();
  for (const [category, words] of Object.entries(REMOVED_STANDALONE)) {
    const synonyms = plain(KEYWORD_SYNONYMS[category]);
    for (const word of words) {
      assert.ok(!synonyms.includes(word), `${category} still lists the everyday word "${word}"`);
    }
  }
  // They must not have moved to another category either
  const all = new Set();
  for (const list of Object.values(plain(KEYWORD_SYNONYMS))) for (const s of list) all.add(s);
  for (const words of Object.values(REMOVED_STANDALONE)) {
    for (const word of words) assert.ok(!all.has(word), `"${word}" is still a standalone synonym somewhere`);
  }
});

test('unambiguous replacement phrases are in place', () => {
  const { KEYWORD_SYNONYMS } = loadContentDom();
  const has = (category, phrase) => plain(KEYWORD_SYNONYMS[category]).includes(phrase);
  assert.ok(has('gaming', 'persona 5'));
  assert.ok(has('gaming', 'forza horizon'));
  assert.ok(has('gossip', 'spill the tea'));
  assert.ok(has('gossip', 'youtuber beef'));
  assert.ok(has('kpop', 'twice kpop'));
  assert.ok(has('gambling', 'slot machine'));
  assert.ok(has('gambling', 'stake casino'));
});

test('blocking a category never hides everyday videos that share a word with it', () => {
  const { getExpandedKeywords, matchesKeyword } = loadContentDom();
  const hides = (category, title) => plain(getExpandedKeywords(category)).some(t => matchesKeyword(title, t));
  assert.strictEqual(hides('gaming', 'Ho conosciuto una persona speciale'), false);
  assert.strictEqual(hides('gaming', 'Forza Italia: il discorso di oggi'), false);
  assert.strictEqual(hides('gaming', 'The sonic boom explained'), false);
  assert.strictEqual(hides('sports', 'Partita IVA: la guida per i freelance'), false);
  assert.strictEqual(hides('politics', 'Spostarsi a destra o a sinistra? Il codice della strada'), false);
  assert.strictEqual(hides('gossip', 'How to make green tea'), false);
  assert.strictEqual(hides('gossip', 'Beef stew recipe'), false);
  assert.strictEqual(hides('gossip', 'Why this flight was cancelled'), false);
  assert.strictEqual(hides('horror', 'Non ho paura del buio'), false);
  assert.strictEqual(hides('religion', 'Cristiano Ronaldo hat-trick'), false);
  assert.strictEqual(hides('religion', 'Rosario Dawson interview'), false);
  assert.strictEqual(hides('kpop', 'Twice as fast: ten tips'), false);
  assert.strictEqual(hides('gambling', 'Slot canyon hike in Utah'), false);
  assert.strictEqual(hides('gambling', 'Stake out: how detectives work'), false);
  assert.strictEqual(hides('beauty', 'Il trucco del mago svelato'), false);
  assert.strictEqual(hides('travel', 'What to do in case of an earthquake'), false);
  assert.strictEqual(hides('crypto', 'Shiba Inu puppy first week'), false);
});

test('the topic itself is still blocked by its specific phrases', () => {
  const { getExpandedKeywords, matchesKeyword } = loadContentDom();
  const hides = (category, title) => plain(getExpandedKeywords(category)).some(t => matchesKeyword(title, t));
  assert.strictEqual(hides('gaming', 'Persona 5 Royal: full walkthrough'), true);
  assert.strictEqual(hides('gaming', 'Forza Horizon 5 is gorgeous'), true);
  assert.strictEqual(hides('gaming', 'Baldur\u2019s Gate 3 ending explained'), true);
  assert.strictEqual(hides('gossip', 'Spill the tea: the whole story'), true);
  assert.strictEqual(hides('gossip', 'The youtuber beef nobody expected'), true);
  assert.strictEqual(hides('kpop', 'TWICE kpop comeback'), true);
  assert.strictEqual(hides('gambling', 'Slot machine strategy'), true);
  assert.strictEqual(hides('gambling', 'Stake casino review'), true);
  assert.strictEqual(hides('news', 'Attualità e politica'), true);
  assert.strictEqual(hides('travel', 'Tour della città di Roma'), true);
});
