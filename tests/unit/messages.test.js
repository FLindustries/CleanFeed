'use strict';
// Message formatting for the language override (audit findings #52, #26).
//   - cfFormatMessage(entry, subs) (content-dom.js) formats a messages.json
//     entry like chrome.i18n.getMessage: $NAME$ -> placeholder content,
//     $1..$9 -> substitutions (missing = empty), $$ -> a literal $.
//     content.js msg(), popup.js cfMsg() and options.js msg() use it when a
//     language is chosen in Settings; with "Auto" they call chrome.i18n.getMessage.
//   - English shows "$3.99/mo" ("$$3.99" in messages.json), Italian keeps "3,99€/mese".
//   - No message in either locale has a bare $<digit> (it would be eaten as a slot).
//   - cfIsProBookkeepingOnly(changes): storage changes that only refresh Pro
//     status bookkeeping (same Pro answer) do not re-filter or re-render.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');

const ROOT = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const LOCALES = {
  en: JSON.parse(read('_locales/en/messages.json')),
  it: JSON.parse(read('_locales/it/messages.json'))
};

function format() {
  const cf = loadContentDom();
  assert.strictEqual(typeof cf.cfFormatMessage, 'function', 'content-dom.js defines cfFormatMessage');
  return (entry, subs) => cf.cfFormatMessage(entry, subs);
}

// Loads a settings page script (popup.js or options.js) the way its HTML does
// (features.js, content-dom.js, strict-client.js, then the page), with the
// language override set to `lang`. Returns the page's message helper.
function pageHelper(file, helperName, lang, getMessage) {
  const noop = () => {};
  const sandbox = {
    console,
    document: { addEventListener: noop, querySelectorAll: () => [], getElementById: () => null },
    chrome: {
      i18n: { getMessage: getMessage || (() => '') },
      storage: { onChanged: { addListener: noop }, local: { get: async () => ({}) } },
      runtime: { sendMessage: async () => ({}), getManifest: () => ({ version: '0.0.0-test' }) },
      tabs: { query: noop }
    }
  };
  vm.createContext(sandbox);
  for (const name of ['features.js', 'content-dom.js', 'strict-client.js']) {
    vm.runInContext(read(name), sandbox, { filename: name });
  }
  const shim = `\n;globalThis.__cfSetMessages = m => { _customMessages = m; };\nglobalThis.__cfHelper = ${helperName};\n`;
  vm.runInContext(read(file) + shim, sandbox, { filename: file });
  if (lang) sandbox.__cfSetMessages(LOCALES[lang]);
  return sandbox.__cfHelper;
}

// --- cfFormatMessage ---

test('cfFormatMessage: $$ is a literal dollar, so English shows $3.99/mo', () => {
  const f = format();
  assert.strictEqual(f({ message: 'Upgrade to Pro — $$3.99/mo' }), 'Upgrade to Pro — $3.99/mo');
  assert.strictEqual(f({ message: '$$3.99' }), '$3.99');
  assert.strictEqual(f({ message: '$$3.99' }, ['x', 'y', 'z']), '$3.99', 'substitutions do not touch an escaped dollar');
  assert.strictEqual(f(LOCALES.en.upgradeToPro), 'Upgrade to Pro — $3.99/mo');
  assert.strictEqual(f(LOCALES.it.upgradeToPro), 'Passa a Pro — 3,99€/mese');
});

test('cfFormatMessage: same rules as chrome.i18n.getMessage for $<digit> and stray dollars', () => {
  const f = format();
  assert.strictEqual(f({ message: 'Upgrade to Pro — $3.99/mo' }), 'Upgrade to Pro — .99/mo', 'an unescaped $3 is an empty slot, like Chrome');
  assert.strictEqual(f({ message: 'a $1 b $2' }, ['x']), 'a x b ');
  assert.strictEqual(f({ message: '$$$' }), '$$');
  assert.strictEqual(f({ message: 'cost $' }), 'cost ');
  assert.strictEqual(f({ message: 'plain text' }), 'plain text');
});

test('cfFormatMessage: named placeholders take their substitution', () => {
  const f = format();
  assert.strictEqual(f(LOCALES.en.keywordBlockedToast, ['gaming']), 'Blocked keyword: "gaming"');
  assert.strictEqual(f(LOCALES.it.keywordsUsed, ['2']), '2/3 parole usate');
  assert.strictEqual(f(LOCALES.en.keywordsUsed, '1'), '1/3 keywords used', 'a single string works like getMessage');
  assert.strictEqual(f(LOCALES.en.keywordsUsed, [2]), '2/3 keywords used', 'numbers become text');
  assert.strictEqual(f(LOCALES.en.keywordsUsed), '/3 keywords used', 'no substitution: empty, like Chrome');
  assert.strictEqual(f({ message: '$Name$ and $NAME$', placeholders: { name: { content: '$1' } } }, ['x']), 'x and x', 'names ignore case');
});

test('cfFormatMessage: substitutions are inserted as plain text', () => {
  const f = format();
  for (const sub of ['$&', "$'", '$1', '$$', '$KW$', '<b>x</b>']) {
    assert.strictEqual(f(LOCALES.en.keywordBlockedToast, [sub]), 'Blocked keyword: "' + sub + '"', sub);
  }
});

test('cfFormatMessage: the preset warning shows the real numbers in both languages', () => {
  const f = format();
  const en = f(LOCALES.en.presetFreeLimitWarning, ['4', '2', '3']);
  const it = f(LOCALES.it.presetFreeLimitWarning, ['4', '2', '3']);
  for (const text of [en, it]) {
    assert.ok(!text.includes('$'), 'no placeholder left: ' + text);
    assert.ok(/\b4\b/.test(text) && /\b2\b/.test(text) && /\b3\b/.test(text), 'all three numbers: ' + text);
  }
  assert.ok(en.indexOf('4') < en.indexOf('2') && en.indexOf('2') < en.indexOf('3'), 'adds, then left, then limit: ' + en);
});

// --- messages.json ---

test('no message in en or it has a bare $<digit>: a literal dollar is written $$', () => {
  for (const [lang, messages] of Object.entries(LOCALES)) {
    for (const [key, entry] of Object.entries(messages)) {
      const text = entry.message.replace(/\$\$/g, '');
      assert.ok(!/\$[1-9]/.test(text), `${lang}.${key}: "${entry.message}"`);
    }
  }
});

test('every $NAME$ in en and it is a declared placeholder, and both languages declare the same ones', () => {
  for (const [lang, messages] of Object.entries(LOCALES)) {
    for (const [key, entry] of Object.entries(messages)) {
      const declared = Object.keys(entry.placeholders || {}).map(n => n.toLowerCase());
      for (const m of entry.message.replace(/\$\$/g, '').matchAll(/\$([A-Za-z0-9_@]+)\$/g)) {
        assert.ok(declared.includes(m[1].toLowerCase()), `${lang}.${key}: $${m[1]}$ is not declared`);
      }
    }
  }
  for (const key of Object.keys(LOCALES.en)) {
    if (!LOCALES.it[key]) continue;
    const contents = entry => JSON.stringify(Object.entries(entry.placeholders || {}).map(([n, p]) => [n.toLowerCase(), p.content]).sort());
    assert.strictEqual(contents(LOCALES.it[key]), contents(LOCALES.en[key]), key);
  }
});

// --- the page helpers ---

test('popup.js cfMsg and options.js msg: with a language chosen, English shows $3.99 and Italian 3,99€', () => {
  for (const [file, helper] of [['popup.js', 'cfMsg'], ['options.js', 'msg']]) {
    assert.strictEqual(pageHelper(file, helper, 'en')('upgradeToPro'), 'Upgrade to Pro — $3.99/mo', file);
    assert.strictEqual(pageHelper(file, helper, 'it')('upgradeToPro'), 'Passa a Pro — 3,99€/mese', file);
    assert.strictEqual(pageHelper(file, helper, 'en')('keywordsUsed', ['2']), '2/3 keywords used', file);
    assert.strictEqual(pageHelper(file, helper, 'en')('keywordBlockedToast', ['$&']), 'Blocked keyword: "$&"', file);
  }
});

test('popup.js cfMsg and options.js msg: on Auto they pass key and substitutions to chrome.i18n.getMessage', () => {
  for (const [file, helper] of [['popup.js', 'cfMsg'], ['options.js', 'msg']]) {
    const calls = [];
    const fn = pageHelper(file, helper, null, (key, subs) => { calls.push([key, subs]); return 'native'; });
    assert.strictEqual(fn('presetFreeLimitWarning', ['4', '2', '3']), 'native', file);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [['presetFreeLimitWarning', ['4', '2', '3']]], file);
  }
});

test('content.js msg() formats language-override messages with cfFormatMessage', () => {
  const source = read('content.js').replace(/\r\n/g, '\n');
  const start = source.indexOf('function msg(key, subs)');
  assert.ok(start > 0, 'content.js has msg(key, subs)');
  const end = source.indexOf('\n  }\n', start);
  assert.ok(end > start, 'end of msg()');
  const body = source.slice(start, end);
  assert.ok(body.includes('cfFormatMessage(_contentMessages[key], subs)'), body);
});

// --- cfIsProBookkeepingOnly ---

test('cfIsProBookkeepingOnly: a Pro cache refresh with the same answer, or ExtPay bookkeeping, changes nothing', () => {
  const cf = loadContentDom();
  assert.strictEqual(typeof cf.cfIsProBookkeepingOnly, 'function', 'content-dom.js defines cfIsProBookkeepingOnly');
  const only = changes => cf.cfIsProBookkeepingOnly(changes);
  assert.strictEqual(only({ proStatusCache: { oldValue: { isPro: false, checkedAt: 1 }, newValue: { isPro: false, checkedAt: 2 } } }), true);
  assert.strictEqual(only({ proStatusCache: { newValue: { isPro: false, checkedAt: 2 } } }), true, 'first free answer');
  assert.strictEqual(only({ extensionpay_user: { newValue: { paid: true } } }), true);
  assert.strictEqual(only({ extensionpay_api_key: { newValue: 'k' }, extensionpay_installed_at: { newValue: 'x' } }), true);
});

test('cfIsProBookkeepingOnly: a new Pro answer or any other key still re-filters', () => {
  const cf = loadContentDom();
  const only = changes => cf.cfIsProBookkeepingOnly(changes);
  assert.strictEqual(only({ proStatusCache: { oldValue: { isPro: false, checkedAt: 1 }, newValue: { isPro: true, checkedAt: 2 } } }), false, 'became Pro');
  assert.strictEqual(only({ proStatusCache: { oldValue: { isPro: true, checkedAt: 1 }, newValue: { isPro: false, checkedAt: 2 } } }), false, 'Pro ended');
  assert.strictEqual(only({ proStatusCache: { newValue: { isPro: true, checkedAt: 2 } } }), false, 'first answer is Pro');
  assert.strictEqual(only({ proStatusCache: { oldValue: { isPro: false }, newValue: { isPro: false } }, blockedKeywords: {} }), false);
  assert.strictEqual(only({ settings: {} }), false);
  assert.strictEqual(only({}), false);
  assert.strictEqual(only(undefined), false);
});
