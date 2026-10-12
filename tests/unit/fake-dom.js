'use strict';
// Tiny fake DOM tree for unit tests of content-dom.js page-level helpers.
//
//   const { el, fakeDocument } = require('./fake-dom');
//   const doc = fakeDocument(
//     el('ytd-page-manager', {},
//       el('ytd-watch-flexy', { hidden: '' }),
//       el('ytd-browse', { 'page-subtype': 'channels' }, el('span', {}, 'text'))));
//   const cf = loadContentDom({ document: doc, location: { pathname: '/@x' } });
//
// Elements answer matches / querySelector / querySelectorAll / closest for a
// small CSS subset: comma lists, the descendant combinator (whitespace), and
// compounds made of a tag (or *), #id, .class, [attr], [attr="v"], [attr^="v"].
// Anything else (>, +, ~, :pseudo, unquoted values) throws, so a test can never
// pass because a selector was silently ignored. Results are in document order,
// like the real DOM, and selectors are not scoped (as in the real DOM, the
// ancestors in `A B` may lie outside the element querySelector is called on).

const COMPOUND_RE = /^([a-zA-Z][\w-]*|\*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)$/;
const PART_RE = /#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:(\^?=)\s*"([^"]*)"\s*)?\]/g;

function parseCompound(text) {
  const m = COMPOUND_RE.exec(text);
  if (!m) throw new Error(`fake-dom: unsupported selector "${text}"`);
  const checks = [];
  if (m[1] && m[1] !== '*') {
    const tag = m[1].toUpperCase();
    checks.push(n => n.tagName === tag);
  }
  let consumed = '';
  let p;
  PART_RE.lastIndex = 0;
  while ((p = PART_RE.exec(m[2])) !== null) {
    consumed += p[0];
    if (p[1] !== undefined) {
      const id = p[1];
      checks.push(n => n.getAttribute('id') === id);
    } else if (p[2] !== undefined) {
      const cls = p[2];
      checks.push(n => n.classList.contains(cls));
    } else {
      const name = p[3];
      const op = p[4];
      const value = p[5];
      if (!op) checks.push(n => n.hasAttribute(name));
      else if (op === '=') checks.push(n => n.getAttribute(name) === value);
      else checks.push(n => n.hasAttribute(name) && n.getAttribute(name).startsWith(value));
    }
  }
  if (consumed !== m[2]) throw new Error(`fake-dom: unsupported selector "${text}"`);
  return node => checks.every(check => check(node));
}

// Returns a list of complex selectors, each a list of compound matchers
// (left to right).
function parseSelector(selector) {
  return String(selector).split(',').map(part => {
    const compounds = part.trim().split(/\s+/).filter(Boolean);
    if (compounds.length === 0) throw new Error(`fake-dom: empty selector in "${selector}"`);
    return compounds.map(parseCompound);
  });
}

// Descendant combinators only, so matching the nearest qualifying ancestor
// for each compound (right to left) is exact.
function matchesComplex(node, compounds) {
  let i = compounds.length - 1;
  if (!compounds[i](node)) return false;
  let current = node.parentElement;
  for (i--; i >= 0; i--) {
    while (current && !compounds[i](current)) current = current.parentElement;
    if (!current) return false;
    current = current.parentElement;
  }
  return true;
}

class FakeElement {
  constructor(tag, attrs, children) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = Object.assign({}, attrs);
    this.parentElement = null;
    this.childNodes = [];
    this.children = [];
    for (const child of children) {
      if (typeof child === 'string') {
        this.childNodes.push(child);
      } else {
        child.parentElement = this;
        this.childNodes.push(child);
        this.children.push(child);
      }
    }
  }

  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  get classList() {
    const classes = this.className.split(/\s+/).filter(Boolean);
    return { contains: name => classes.includes(name) };
  }
  get textContent() {
    return this.childNodes.map(c => (typeof c === 'string' ? c : c.textContent)).join('');
  }

  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  getAttribute(name) { return this.hasAttribute(name) ? String(this.attrs[name]) : null; }

  matches(selector) {
    return parseSelector(selector).some(compounds => matchesComplex(this, compounds));
  }

  closest(selector) {
    const complexes = parseSelector(selector);
    for (let node = this; node; node = node.parentElement) {
      if (complexes.some(compounds => matchesComplex(node, compounds))) return node;
    }
    return null;
  }

  // Descendants in document (pre-)order, not including this element.
  descendants() {
    const out = [];
    const walk = node => {
      for (const child of node.children) {
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelectorAll(selector) {
    const complexes = parseSelector(selector);
    return this.descendants().filter(node => complexes.some(compounds => matchesComplex(node, compounds)));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

// el(tag, attrs, ...children): children are elements or text strings.
function el(tag, attrs, ...children) {
  return new FakeElement(tag, attrs || {}, children);
}

// A document whose <html> element holds `children`. querySelector(All) search
// the whole tree, <html> included.
function fakeDocument(...children) {
  const html = el('html', {}, ...children);
  return {
    documentElement: html,
    querySelectorAll: selector => (html.matches(selector) ? [html] : []).concat(html.querySelectorAll(selector)),
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  };
}

module.exports = { el, fakeDocument, FakeElement };
