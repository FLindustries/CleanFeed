'use strict';
// Loads ../../content-dom.js into a fresh Node `vm` context and returns its
// top-level bindings (functions, consts and lets).
//
//   const loadContentDom = require('./load-content-dom');
//   const { matchesKeyword, YT } = loadContentDom();
//   const cf = loadContentDom({ location: { pathname: '/results' } });
//
// Why a shim: top-level `const`/`let`/`class` declarations of a vm script are
// NOT properties of the context object, so `context.KEYWORD_SYNONYMS` would be
// undefined. We scan the source for column-0 declarations and append an export
// shim to the evaluated text. Exports are live getters, so `let` bindings such
// as `_cfDisabledSynonyms` always read their current value. New helpers added to
// content-dom.js later are picked up automatically (no list to maintain).
// Limitation: destructuring declarations (`const { a } = ...`) are not detected.
//
// Every call returns a brand-new context, so state set by cfSetSynonymFilters()
// never leaks between tests.
//
// Cross-realm note: arrays/objects created inside the context have different
// prototypes than host ones, so assert.deepStrictEqual(vmArray, [..]) fails.
// Wrap values with loadContentDom.plain(value) before deep comparisons.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONTENT_DOM_PATH = path.resolve(__dirname, '..', '..', 'content-dom.js');

// Minimal DOM node: enough for cfEl() and for YT.* helpers to be called with
// hand-built fixtures. querySelector* always find nothing unless a test replaces them.
class FakeNode {
  constructor(tag, text) {
    this.tagName = tag ? String(tag).toUpperCase() : '#text';
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.id = '';
    this.className = '';
    this._text = text || '';
  }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function topLevelNames(source) {
  const names = new Set();
  const fnRe = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm;
  const varRe = /^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const re of [fnRe, varRe]) {
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[1]);
  }
  return [...names];
}

function loadContentDom(overrides) {
  const source = fs.readFileSync(CONTENT_DOM_PATH, 'utf8');
  const names = topLevelNames(source);

  const location = Object.assign(
    { pathname: '/', search: '', hash: '', hostname: 'www.youtube.com', href: 'https://www.youtube.com/' },
    (overrides && overrides.location) || {}
  );
  const document = {
    body: new FakeNode('body'),
    createElement: tag => new FakeNode(tag),
    createTextNode: text => new FakeNode(null, text),
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const getComputedStyle = () => ({ display: 'block' });
  const sandbox = {
    console,
    document,
    location,
    getComputedStyle,
    window: { location, document, getComputedStyle }
  };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (key !== 'location') sandbox[key] = value;
    }
  }

  const shim = '\n;globalThis.__cfExports = (function () {\n  const e = {};\n' +
    names.map(n => `  Object.defineProperty(e, ${JSON.stringify(n)}, { enumerable: true, get: function () { return ${n}; } });`).join('\n') +
    '\n  return e;\n})();\n';

  vm.createContext(sandbox);
  vm.runInContext(source + shim, sandbox, { filename: CONTENT_DOM_PATH });

  const exported = sandbox.__cfExports;
  Object.defineProperty(exported, 'sandbox', { value: sandbox, enumerable: false });
  return exported;
}

// Copies a value out of the vm realm into a host-realm plain object/array.
loadContentDom.plain = value => JSON.parse(JSON.stringify(value));

module.exports = loadContentDom;
