'use strict';
// Keyword suggestions (audit findings #4, #31): the CF+ quick-add chips and the
// Channel Scan candidates must be phrases that matchesKeyword really finds in the
// title they came from. Tokens keep their internal punctuation ("baldur's",
// "spider-man"), only edge punctuation is trimmed, Italian/French elisions split
// at the apostrophe, and non-Latin words produce chips.

const assert = require('node:assert');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');

const { plain } = loadContentDom;

const BRIEF_TITLE = "Baldur's Gate 3 – Spider-Man: l'ultimo dell'anno";

function phrases(chips) {
  return plain(chips).map(c => c.phrase);
}

// --- Quick-add chips ---

test('quick-add chips keep apostrophes and hyphens inside words', () => {
  const { cfQuickAddChips } = loadContentDom();
  const all = phrases(cfQuickAddChips(BRIEF_TITLE));
  assert.ok(all.includes("baldur's"), 'baldur\'s chip');
  assert.ok(all.includes('spider-man'), 'spider-man chip');
  assert.ok(all.includes('anno'), 'anno chip (split from dell\'anno)');
  assert.ok(!all.includes('baldurs'), 'no fused baldurs');
  assert.ok(!all.includes('spiderman'), 'no fused spiderman');
  assert.ok(!all.includes('lultimo') && !all.includes('dellanno'), 'no fused elisions');
});

test('quick-add: every chip phrase matches the title it came from', () => {
  const { cfQuickAddChips, matchesKeyword } = loadContentDom();
  const titles = [
    BRIEF_TITLE,
    'Elden Ring: Nightreign (Official Trailer) | IGN',
    'Half-Life 2 – the "best" mod ever, honestly!',
    'Il gioco dell’anno: L’Aquila e l\'Assassin’s Creed',
    'Обзор игры Minecraft: новости',
    'Learning C++ fast #shorts',
    'Tour della città di Roma',
    'Two  spaces\tand a tab between words'
  ];
  for (const title of titles) {
    const chips = plain(cfQuickAddChips(title));
    assert.ok(chips.length > 0, 'chips for ' + title);
    for (const chip of chips) {
      assert.strictEqual(matchesKeyword(title, chip.phrase), true,
        'chip "' + chip.phrase + '" (' + chip.kind + ') must match "' + title + '"');
    }
  }
});

test('quick-add: Italian and French elisions split at the apostrophe', () => {
  const { cfQuickAddChips } = loadContentDom();
  const chips = plain(cfQuickAddChips("l'università dell'Elden Ring, c'era un'altra volta, qu'il d'amore"));
  const byPhrase = new Map(chips.map(c => [c.phrase, c]));
  for (const word of ['università', 'elden', 'ring', 'era', 'altra', 'il', 'amore']) {
    assert.ok(byPhrase.has(word), word + ' is its own chip');
  }
  // The elided article has no chip of its own, and no word is fused with it
  for (const prefix of ["l'", "dell'", "c'", "un'", "qu'", "d'"]) {
    assert.ok(!byPhrase.has(prefix), prefix + ' is not a chip');
  }
  for (const fused of ['luniversità', "l'università", 'delleelden', "dell'elden", 'cera', 'unaltra', 'quil', 'damore']) {
    assert.ok(!byPhrase.has(fused), fused + ' is not a chip');
  }
  assert.strictEqual(byPhrase.get('università').stop, false);
  assert.strictEqual(byPhrase.get('elden').stop, false);
  assert.strictEqual(byPhrase.get('ring').stop, false);
  assert.strictEqual(byPhrase.get('era').stop, true, 'era is a stop word');
  // A pair or triple never reaches over an elision
  const all = chips.map(c => c.phrase);
  assert.ok(!all.some(p => p.includes("'") && /\s/.test(p)), JSON.stringify(all));
  assert.ok(all.includes('elden ring'));
});

test('quick-add: names and contractions with an apostrophe are not split', () => {
  const { cfQuickAddChips } = loadContentDom();
  const all = phrases(cfQuickAddChips("O'Brien – Baldur’s Gate, don't stop, Dell's laptop"));
  assert.ok(all.includes("o'brien"));
  assert.ok(all.includes("baldur's"), 'typographic apostrophe is folded to a plain one');
  assert.ok(all.includes("don't"));
  assert.ok(all.includes("dell's"));
  assert.ok(!all.includes('brien') && !all.includes('s'));
});

test('quick-add: bigram and trigram chips keep the original punctuation and spacing', () => {
  const { cfQuickAddChips, matchesKeyword } = loadContentDom();
  const title = "Elden Ring: Nightreign review – Baldur's Gate";
  const chips = plain(cfQuickAddChips(title));
  const kinds = new Map(chips.map(c => [c.phrase, c.kind]));
  assert.strictEqual(kinds.get('elden ring'), 'bigram');
  assert.strictEqual(kinds.get('ring: nightreign'), 'bigram');
  assert.strictEqual(kinds.get('elden ring: nightreign'), 'trigram');
  assert.strictEqual(kinds.get("baldur's gate"), 'bigram');
  assert.ok(matchesKeyword(title, 'ring: nightreign'));
  // A standalone dash is a hard break: no phrase may span it
  assert.ok(!kinds.has('review baldur\'s'));
  assert.ok(![...kinds.keys()].some(p => p.includes('–')));
});

test('quick-add: chip text is what the title shows, phrase is the lowercase match form', () => {
  const { cfQuickAddChips } = loadContentDom();
  const chips = plain(cfQuickAddChips("Baldur’s Gate 3"));
  const baldur = chips.find(c => c.phrase === "baldur's");
  assert.strictEqual(baldur.text, 'Baldur’s');
  assert.strictEqual(baldur.kind, 'word');
  const bigram = chips.find(c => c.phrase === "baldur's gate");
  assert.strictEqual(bigram.text, 'Baldur’s Gate');
});

test('quick-add: Cyrillic and other non-Latin titles produce selectable chips', () => {
  const { cfQuickAddChips, matchesKeyword } = loadContentDom();
  const title = 'Обзор игры Minecraft: новости недели';
  const chips = plain(cfQuickAddChips(title));
  const selectable = chips.filter(c => !c.stop).map(c => c.phrase);
  for (const word of ['обзор', 'игры', 'minecraft', 'новости', 'недели']) {
    assert.ok(selectable.includes(word), word + ' is selectable');
  }
  assert.ok(selectable.includes('обзор игры'), 'bigram of Cyrillic words');
  for (const phrase of selectable) assert.strictEqual(matchesKeyword(title, phrase), true, phrase);

  const korean = plain(cfQuickAddChips('먹방 ASMR 라면'));
  assert.ok(korean.filter(c => !c.stop).map(c => c.phrase).includes('먹방'));
  const greek = plain(cfQuickAddChips('Ελληνική πολιτική σήμερα'));
  assert.ok(greek.filter(c => !c.stop).map(c => c.phrase).includes('πολιτική'));
});

test('quick-add: combining marks stay part of the word', () => {
  const { cfQuickAddChips, matchesKeyword } = loadContentDom();
  const title = 'हिंदी समाचार आज';
  const chips = plain(cfQuickAddChips(title));
  assert.ok(chips.some(c => c.phrase === 'हिंदी'), 'trailing vowel sign is not trimmed');
  for (const chip of chips) assert.strictEqual(matchesKeyword(title, chip.phrase), true, chip.phrase);
});

test('quick-add: stop-word behavior is unchanged', () => {
  const { cfQuickAddChips } = loadContentDom();
  const chips = plain(cfQuickAddChips("The best Spider-Man game, it's a 3 and an I"));
  const stop = new Map(chips.map(c => [c.phrase, c.stop]));
  assert.strictEqual(stop.get('the'), true, 'stop word');
  assert.strictEqual(stop.get('best'), true, 'stop word');
  assert.strictEqual(stop.get("it's"), true, "it's is still the stop word its");
  assert.strictEqual(stop.get('3'), true, 'single character');
  assert.strictEqual(stop.get('i'), true, 'single character');
  assert.strictEqual(stop.get('an'), true, 'stop word');
  assert.strictEqual(stop.get('spider-man'), false);
  assert.strictEqual(stop.get('game'), false);
  // n-grams never contain a stop word
  assert.ok(!stop.has('the best'));
  assert.ok(stop.has('spider-man game'));
});

test('quick-add: words made only of punctuation produce no chip and break phrases', () => {
  const { cfQuickAddChips } = loadContentDom();
  const all = phrases(cfQuickAddChips('Gate | Review - Zelda 2 – !!! ...'));
  for (const p of all) assert.ok(/[\p{L}\p{N}]/u.test(p), 'chip "' + p + '" has a letter or digit');
  assert.ok(all.includes('gate') && all.includes('review') && all.includes('zelda'));
  assert.ok(!all.includes('gate review'), 'a standalone | is a hard break');
  assert.ok(!all.includes('review zelda'), 'a standalone - is a hard break');
});

test('quick-add: empty or missing title gives no chips', () => {
  const { cfQuickAddChips } = loadContentDom();
  assert.deepStrictEqual(plain(cfQuickAddChips('')), []);
  assert.deepStrictEqual(plain(cfQuickAddChips('   –  ')), []);
  assert.deepStrictEqual(plain(cfQuickAddChips(undefined)), []);
});

// --- Quick-add selection (merge + safety net) ---

test('quick-add selection: adjacent selected words merge into one phrase from the title', () => {
  const { cfResolveQuickAddSelection } = loadContentDom();
  const out = plain(cfResolveQuickAddSelection('Star Wars Outlaws gameplay', new Set(['star', 'wars', 'outlaws'])));
  assert.deepStrictEqual(out.phrases, ['star wars outlaws']);
  assert.deepStrictEqual(out.skipped, []);
});

test('quick-add selection: merged phrases keep punctuation so they match the title', () => {
  const { cfResolveQuickAddSelection, matchesKeyword } = loadContentDom();
  const title = "Elden Ring: Nightreign – Baldur's Gate";
  const out = plain(cfResolveQuickAddSelection(title, new Set(['elden', 'ring', 'nightreign', "baldur's", 'gate'])));
  // The dash is a hard break: two separate runs
  assert.deepStrictEqual(out.phrases, ['elden ring: nightreign', "baldur's gate"]);
  for (const p of out.phrases) assert.strictEqual(matchesKeyword(title, p), true, p);
});

test('quick-add selection: non-adjacent words, n-gram chips and singletons are kept as they are', () => {
  const { cfResolveQuickAddSelection } = loadContentDom();
  const title = 'Minecraft hardcore world with Steve and Alex';
  const out = plain(cfResolveQuickAddSelection(title, new Set(['minecraft', 'steve', 'alex', 'hardcore world'])));
  assert.deepStrictEqual(out.phrases.slice().sort(), ['alex', 'hardcore world', 'minecraft', 'steve']);
});

test('quick-add selection: a phrase that does not match the title is skipped, not saved', () => {
  const { cfResolveQuickAddSelection } = loadContentDom();
  // Legacy fused tokens, a typo and a phrase from another title
  const out = plain(cfResolveQuickAddSelection("Baldur's Gate 3 – Spider-Man", new Set(['baldurs', 'spiderman', "baldur's", 'spider-man', 'zelda'])));
  assert.deepStrictEqual(out.phrases.slice().sort(), ["baldur's", 'spider-man']);
  assert.deepStrictEqual(out.skipped.slice().sort(), ['baldurs', 'spiderman', 'zelda']);
});

test('quick-add selection: duplicates collapse and an empty selection gives nothing', () => {
  const { cfResolveQuickAddSelection } = loadContentDom();
  const out = plain(cfResolveQuickAddSelection('Zelda review, Zelda guide', new Set(['zelda'])));
  assert.deepStrictEqual(out.phrases, ['zelda']);
  const none = plain(cfResolveQuickAddSelection('Zelda review', new Set()));
  assert.deepStrictEqual(none, { phrases: [], skipped: [] });
});

test('quick-add selection: chips picked from the popover always resolve to saved phrases', () => {
  const { cfQuickAddChips, cfResolveQuickAddSelection, matchesKeyword } = loadContentDom();
  for (const title of [BRIEF_TITLE, 'Обзор игры Minecraft', "Il gioco dell’anno: L’Aquila"]) {
    const chips = plain(cfQuickAddChips(title)).filter(c => !c.stop);
    const out = plain(cfResolveQuickAddSelection(title, new Set(chips.map(c => c.phrase))));
    assert.deepStrictEqual(out.skipped, [], 'nothing skipped for ' + title);
    assert.ok(out.phrases.length > 0);
    for (const p of out.phrases) assert.strictEqual(matchesKeyword(title, p), true, p);
  }
});

// --- Scan candidates ---

test('scan: keywords keep apostrophes and hyphens and match the analyzed titles', () => {
  const { cfExtractKeywords, matchesKeyword } = loadContentDom();
  const titles = [
    "Baldur's Gate 3 review",
    "Baldur's Gate 3 – best Spider-Man mods",
    "Why Baldur’s Gate wins, Spider-Man loses",
    'Spider-Man: Beyond the trailer'
  ];
  const cands = plain(cfExtractKeywords(titles));
  const all = cands.map(c => c.phrase);
  assert.ok(all.includes("baldur's gate"), JSON.stringify(all));
  assert.ok(all.includes('spider-man'), JSON.stringify(all));
  assert.ok(!all.some(p => p === 'baldurs' || p === 'spiderman' || p.includes('baldurs')));
  for (const cand of cands) {
    assert.ok(titles.some(t => matchesKeyword(t, cand.phrase)), cand.phrase + ' must match a title');
  }
});

test('scan: elisions split instead of fusing into non-words', () => {
  const { cfExtractKeywords, matchesKeyword } = loadContentDom();
  const titles = [
    "L'università di Bologna e un'altra università",
    "Perché l'università di Bologna cambia, dell'università",
    "Il gioco dell'anno: l'ultimo gioco",
    "Il gioco dell'anno 2024"
  ];
  const cands = plain(cfExtractKeywords(titles));
  const all = cands.map(c => c.phrase);
  assert.ok(all.includes('università'), JSON.stringify(all));
  assert.ok(all.includes('bologna'), JSON.stringify(all));
  assert.ok(all.includes('gioco'), JSON.stringify(all));
  for (const bad of ['luniversità', 'dalluniversità', 'dellanno', 'unaltra', 'lultimo', "dell'anno"]) {
    assert.ok(!all.includes(bad), bad + ' must not be a candidate');
  }
  for (const cand of cands) {
    assert.ok(titles.some(t => matchesKeyword(t, cand.phrase)), cand.phrase);
  }
  assert.strictEqual(matchesKeyword("Il gioco dell'anno", "dell'anno"), true);
  assert.strictEqual(matchesKeyword("Il gioco dell’anno", "dell'anno"), true);
});

test('scan: Cyrillic titles produce candidates', () => {
  const { cfExtractKeywords, matchesKeyword } = loadContentDom();
  const titles = ['Обзор игры Minecraft', 'Новый обзор игры Zelda', 'Minecraft лучшие моды'];
  const cands = plain(cfExtractKeywords(titles));
  const all = cands.map(c => c.phrase);
  assert.ok(all.includes('обзор игры'), JSON.stringify(all));
  assert.ok(all.includes('minecraft'), JSON.stringify(all));
  for (const cand of cands) {
    assert.ok(titles.some(t => matchesKeyword(t, cand.phrase)), cand.phrase);
  }
});

test('scan: keeps the old filters (frequency, stop words, short and numeric tokens) and the count order', () => {
  const { cfExtractKeywords } = loadContentDom();
  const titles = [
    'Zelda guide 2024 the best',
    'Zelda review 2024 the best',
    'Mario once'
  ];
  const cands = plain(cfExtractKeywords(titles));
  const all = cands.map(c => c.phrase);
  assert.deepStrictEqual(all, ['zelda']);
  assert.strictEqual(cands[0].count, 2);
  assert.strictEqual(cands[0].type, 'unigram');
  assert.deepStrictEqual(plain(cfExtractKeywords([])), []);
  assert.deepStrictEqual(plain(cfExtractKeywords(null)), []);
});

test('scan: an n-gram with the same count hides the words it is made of', () => {
  const { cfExtractKeywords } = loadContentDom();
  const cands = plain(cfExtractKeywords([
    'Elden Ring: Nightreign boss',
    'Elden Ring: Nightreign class'
  ]));
  const all = cands.map(c => c.phrase);
  assert.deepStrictEqual(all, ['elden ring: nightreign']);
  assert.strictEqual(cands[0].type, 'trigram');
  assert.strictEqual(cands[0].count, 2);
});

test('scan: a hard break (standalone dash or pipe) is never bridged by an n-gram', () => {
  const { cfExtractKeywords } = loadContentDom();
  const cands = plain(cfExtractKeywords([
    'Zelda guide - Mario tips',
    'Zelda guide | Mario tips'
  ]));
  const all = cands.map(c => c.phrase);
  assert.ok(all.includes('zelda guide'));
  assert.ok(all.includes('mario tips'));
  assert.ok(!all.some(p => p.includes('guide mario')), JSON.stringify(all));
});

test('scan: at most 40 candidates, sorted by count then alphabetically', () => {
  const { cfExtractKeywords } = loadContentDom();
  const words = [];
  for (let i = 0; i < 60; i++) words.push('word' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)));
  const titles = [words.join(' x '), words.join(' x ') + ' extra'];
  const cands = plain(cfExtractKeywords(titles));
  assert.strictEqual(cands.length, 40);
  const sorted = cands.slice().sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase));
  assert.deepStrictEqual(cands, sorted);
});

// --- Safety net helper ---

test('cfPhraseMatchesAnyTitle: true when at least one analyzed title matches', () => {
  const { cfPhraseMatchesAnyTitle } = loadContentDom();
  const titles = ["Baldur's Gate 3", 'Обзор игры', 'Spider-Man: Beyond'];
  assert.strictEqual(cfPhraseMatchesAnyTitle(titles, "baldur's gate"), true);
  assert.strictEqual(cfPhraseMatchesAnyTitle(titles, 'игры'), true);
  assert.strictEqual(cfPhraseMatchesAnyTitle(titles, 'spider-man'), true);
  assert.strictEqual(cfPhraseMatchesAnyTitle(titles, 'baldurs'), false);
  assert.strictEqual(cfPhraseMatchesAnyTitle(titles, 'spider man'), false);
  assert.strictEqual(cfPhraseMatchesAnyTitle([], 'zelda'), false);
  assert.strictEqual(cfPhraseMatchesAnyTitle(null, 'zelda'), false);
});
