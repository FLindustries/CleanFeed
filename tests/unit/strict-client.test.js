'use strict';
// The page side of the Strict Mode lock (audit findings #2, #5; Task 11).
// strict-client.js holds the one copy of the password retry-and-remember logic.
// popup.html and options.html load it; YouTube pages never do (no password
// prompts inside YouTube pages).

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('./registry');

const ROOT = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const MESSAGES = {
  strictRequiresPassword: 'Strict mode is enabled. Enter password to continue:',
  strictWrongPassword: 'Wrong password.',
};

// Loads strict-client.js into a fresh vm context with a fake background that
// accepts `bg.password` (changeable mid-test) and records every request, plus
// scripted prompt() answers.
function load({ password = 'secret', answers = [], getMessage } = {}) {
  const bg = { password };
  const sent = [];
  const prompts = [];
  const alerts = [];
  const context = vm.createContext({
    chrome: {
      runtime: {
        async sendMessage(request) {
          sent.push(JSON.parse(JSON.stringify(request)));
          if (request.action === 'addKeyword') return { success: true };
          if (request.strictPassword === bg.password) return { success: true };
          return { error: 'strict_locked' };
        },
      },
    },
    prompt(text) { prompts.push(text); return answers.length ? answers.shift() : null; },
    alert(text) { alerts.push(text); },
  });
  vm.runInContext(read('strict-client.js'), context, { filename: 'strict-client.js' });
  const lookup = getMessage || (key => MESSAGES[key] || key);
  return { create: () => context.cfCreateStrictSender(lookup), bg, sent, prompts, alerts };
}

const REMOVE = { action: 'removeKeyword', index: 0 };

test('a request the background does not lock is sent once, with no prompt', async () => {
  const page = load();
  const send = page.create();
  const res = await send({ action: 'addKeyword', keyword: 'drama' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(res)), { success: true });
  assert.deepStrictEqual(page.sent, [{ action: 'addKeyword', keyword: 'drama' }]);
  assert.deepStrictEqual(page.prompts, []);
  assert.deepStrictEqual(page.alerts, []);
});

test('strict_locked: asks for the password once, retries with it and remembers it', async () => {
  const page = load({ answers: ['secret'] });
  const send = page.create();
  const first = await send(REMOVE);
  assert.strictEqual(first.success, true);
  assert.deepStrictEqual(page.prompts, [MESSAGES.strictRequiresPassword]);
  assert.deepStrictEqual(page.sent, [REMOVE, { ...REMOVE, strictPassword: 'secret' }]);

  const second = await send({ action: 'clearAllBlockedChannels' });
  assert.strictEqual(second.success, true);
  assert.strictEqual(page.prompts.length, 1, 'the remembered password is reused, no second prompt');
  assert.deepStrictEqual(page.sent[2], { action: 'clearAllBlockedChannels', strictPassword: 'secret' });
  assert.deepStrictEqual(page.alerts, []);
});

test('the caller\'s request object is never given the password', async () => {
  const page = load({ answers: ['secret'] });
  const send = page.create();
  const request = { action: 'removeKeyword', index: 2 };
  await send(request);
  await send(request);
  assert.deepStrictEqual(request, { action: 'removeKeyword', index: 2 });
});

test('a wrong password shows the existing error string and is not remembered', async () => {
  const page = load({ answers: ['nope', 'secret'] });
  const send = page.create();
  const res = await send(REMOVE);
  assert.strictEqual(res.error, 'strict_locked');
  assert.deepStrictEqual(page.alerts, [MESSAGES.strictWrongPassword]);

  await send(REMOVE);
  assert.deepStrictEqual(page.sent[2], REMOVE, 'the wrong password is not sent again');
  assert.strictEqual(page.prompts.length, 2);
  assert.deepStrictEqual(page.sent[3], { ...REMOVE, strictPassword: 'secret' });
});

test('cancelling the prompt sends nothing more and shows no error', async () => {
  for (const answer of [null, '']) {
    const page = load({ answers: [answer] });
    const send = page.create();
    const res = await send(REMOVE);
    assert.strictEqual(res.error, 'strict_locked');
    assert.deepStrictEqual(page.sent, [REMOVE]);
    assert.deepStrictEqual(page.alerts, []);
  }
});

test('a remembered password that stops working is forgotten and asked for again', async () => {
  const page = load({ answers: ['secret', 'new-one'] });
  const send = page.create();
  await send(REMOVE);
  // The password is changed on another page: the remembered one is now refused.
  page.bg.password = 'new-one';
  const res = await send(REMOVE);
  assert.strictEqual(res.success, true);
  assert.strictEqual(page.prompts.length, 2, 'asked again after the remembered password was refused');
  assert.deepStrictEqual(page.sent.slice(2), [
    { ...REMOVE, strictPassword: 'secret' },
    { ...REMOVE, strictPassword: 'new-one' },
  ]);
  assert.deepStrictEqual(page.alerts, []);

  // The new password is the one remembered now.
  await send(REMOVE);
  assert.strictEqual(page.prompts.length, 2);
  assert.deepStrictEqual(page.sent[4], { ...REMOVE, strictPassword: 'new-one' });
});

test('each page keeps its own password: a new sender asks again', async () => {
  const page = load({ answers: ['secret', 'secret'] });
  await page.create()(REMOVE);
  await page.create()(REMOVE);
  assert.strictEqual(page.prompts.length, 2);
});

test('the prompt and the error read the page\'s own message helper', async () => {
  const page = load({ answers: ['nope'], getMessage: key => `[it] ${key}` });
  await page.create()(REMOVE);
  assert.deepStrictEqual(page.prompts, ['[it] strictRequiresPassword']);
  assert.deepStrictEqual(page.alerts, ['[it] strictWrongPassword']);
});

test('a missing message falls back to the English string', async () => {
  const page = load({ answers: ['nope'], getMessage: key => key });
  await page.create()(REMOVE);
  assert.deepStrictEqual(page.prompts, [MESSAGES.strictRequiresPassword]);
  assert.deepStrictEqual(page.alerts, [MESSAGES.strictWrongPassword]);
});

// --- wiring: one copy, extension pages only ---

test('popup.html and options.html load strict-client.js before their own script', () => {
  for (const [html, script] of [['options.html', 'options.js'], ['popup.html', 'popup.js']]) {
    const source = read(html);
    const client = source.indexOf('<script src="strict-client.js"></script>');
    const own = source.indexOf(`<script src="${script}"></script>`);
    assert.ok(client !== -1, `${html} does not load strict-client.js`);
    assert.ok(client < own, `${html} loads strict-client.js after ${script}`);
  }
});

test('strict-client.js is packaged and is never a content script', () => {
  assert.ok(read('package.sh').includes("'strict-client.js'"), 'package.sh does not ship strict-client.js');
  const manifest = JSON.parse(read('manifest.json'));
  for (const entry of manifest.content_scripts) {
    assert.ok(!entry.js.includes('strict-client.js'), 'strict-client.js runs inside web pages');
  }
  assert.ok(!/strict-client/.test(read('background.js')), 'background.js loads strict-client.js');
});

test('popup.js and options.js keep no copy of the retry logic', () => {
  for (const file of ['popup.js', 'options.js']) {
    const source = read(file);
    assert.ok(!/function\s+sendWithStrict\b/.test(source), `${file} still defines sendWithStrict`);
    assert.ok(!/prompt\([^)]*strictRequiresPassword/.test(source), `${file} still prompts for the strict password itself`);
    assert.ok(/cfCreateStrictSender\(/.test(source), `${file} does not use cfCreateStrictSender`);
  }
});

function topLevelNames(source) {
  const names = new Set();
  const fnRe = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm;
  const varRe = /^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const re of [fnRe, varRe]) {
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[1]);
  }
  return names;
}

test('strict-client.js declares no top-level name the other page scripts declare', () => {
  // Classic scripts on one page share the global lexical scope.
  const own = topLevelNames(read('strict-client.js'));
  for (const file of ['features.js', 'content-dom.js', 'popup.js', 'options.js']) {
    const clash = [...topLevelNames(read(file))].filter(n => own.has(n));
    assert.deepStrictEqual(clash, [], `${file} redeclares: ${clash.join(', ')}`);
  }
});
