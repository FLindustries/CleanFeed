'use strict';
// Loads ../../features.js, ../../storage.js and ../../background.js into one
// fresh Node `vm` context, with an in-memory chrome.storage.local and a stub
// ExtPay, and returns the background's message handler plus the storage contents.
//
//   const loadBackground = require('./load-background');
//   const bg = loadBackground({ blockedKeywords: [...] });   // initial storage
//   const res = await bg.handleMessage({ action: 'getFullState' });
//   bg.storage();      // host-realm copy of everything in chrome.storage.local
//   bg.writes;         // keys of every chrome.storage.local.set() call, in order
//   bg.Storage;        // the Storage object from storage.js
//   bg.listeners;      // { onInstalled: [fn], onStartup: [fn], onAlarm: [fn], ... }
//   bg.alarmCalls;     // every chrome.alarms call, in order: ['create' | 'clear' | 'get', name]
//
// features.js and storage.js run first, so background.js's importScripts() is a
// no-op: the scripts share the context's global scope (like importScripts in
// the worker).
//
// Pro status. `options`:
//   isPro      (default false) what the stub ExtPay's getUser() reports as paid
//   getUser    replaces the stub's getUser (async () => user, or throw to fail)
//   now        () => ms: the context's Date.now (a test clock)
//   setTimeout / clearTimeout: the context's timers (default: Node's)
//   console    the context's console (default: Node's)
// bg.getUserCalls() counts getUser() calls, bg.paidListeners holds the
// functions given to extpay.onPaid.addListener.
// The background caches Pro status in chrome.storage.local `proStatusCache`
// and refreshes it on service worker start, so that write happens in every
// test. It is kept out of `writes` and `storage()`, which describe the user's
// data; read it with bg.proStatusCache() and bg.proWrites (each value written).

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const PRO_CACHE_KEY = 'proStatusCache';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function fakeStorageArea(initial, writes, proWrites) {
  const data = clone(initial || {});
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return clone(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const key of list) {
        if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = clone(data[key]);
      }
      return out;
    },
    async set(items) {
      const keys = Object.keys(items).filter(key => key !== PRO_CACHE_KEY).sort();
      if (keys.length > 0) writes.push(keys);
      if (Object.prototype.hasOwnProperty.call(items, PRO_CACHE_KEY)) proWrites.push(clone(items[PRO_CACHE_KEY]));
      for (const [key, value] of Object.entries(items)) data[key] = clone(value);
    }
  };
}

function loadBackground(initialStorage, options) {
  const opts = options || {};
  const isPro = !!opts.isPro;
  const writes = [];
  const proWrites = [];
  const local = fakeStorageArea(initialStorage, writes, proWrites);
  const listeners = {};
  const listener = name => ({ addListener(fn) { (listeners[name] = listeners[name] || []).push(fn); } });
  const alarmCalls = [];
  const paidListeners = [];
  let getUserCalls = 0;
  const getUser = opts.getUser || (async () => ({ paid: isPro }));
  const chrome = {
    storage: { local },
    runtime: {
      onInstalled: listener('onInstalled'),
      onStartup: listener('onStartup'),
      onMessage: listener('onMessage'),
      getManifest: () => ({ version: '0.0.0-test' })
    },
    alarms: {
      onAlarm: listener('onAlarm'),
      create(name) { alarmCalls.push(['create', name]); },
      clear(name) { alarmCalls.push(['clear', name]); return Promise.resolve(true); },
      get(name, cb) { alarmCalls.push(['get', name]); if (cb) cb(null); }
    },
    tabs: { create() {} }
  };
  const sandbox = {
    console: opts.console || console,
    chrome,
    crypto: globalThis.crypto,
    TextEncoder,
    setTimeout: opts.setTimeout || setTimeout,
    clearTimeout: opts.clearTimeout || clearTimeout,
    importScripts() {},
    ExtPay: () => ({
      startBackground() {},
      getUser() { getUserCalls++; return getUser(); },
      onPaid: { addListener(fn) { paidListeners.push(fn); } },
      openPaymentPage() {}
    })
  };
  vm.createContext(sandbox);
  if (opts.now) {
    const contextDate = vm.runInContext('Date', sandbox);
    contextDate.now = () => opts.now();
  }
  const featuresPath = path.join(ROOT, 'features.js');
  vm.runInContext(fs.readFileSync(featuresPath, 'utf8'), sandbox, { filename: featuresPath });
  const storagePath = path.join(ROOT, 'storage.js');
  const backgroundPath = path.join(ROOT, 'background.js');
  vm.runInContext(fs.readFileSync(storagePath, 'utf8') + '\n;globalThis.__cfStorage = Storage;\n', sandbox, { filename: storagePath });
  vm.runInContext(fs.readFileSync(backgroundPath, 'utf8'), sandbox, { filename: backgroundPath });

  return {
    Storage: sandbox.__cfStorage,
    // Results come back as host-realm plain values, ready for deepStrictEqual.
    handleMessage: async request => clone(await sandbox.handleMessage(request)),
    storage: () => {
      const copy = clone(local.data);
      delete copy[PRO_CACHE_KEY];
      return copy;
    },
    proStatusCache: () => clone(local.data[PRO_CACHE_KEY]),
    proWrites,
    getUserCalls: () => getUserCalls,
    paidListeners,
    writes,
    listeners,
    alarmCalls,
    sandbox
  };
}

module.exports = loadBackground;
