'use strict';
// Loads ../../storage.js and ../../background.js into one fresh Node `vm`
// context, with an in-memory chrome.storage.local and a stub ExtPay, and
// returns the background's message handler plus the storage contents.
//
//   const loadBackground = require('./load-background');
//   const bg = loadBackground({ blockedKeywords: [...] });   // initial storage
//   const res = await bg.handleMessage({ action: 'getFullState' });
//   bg.storage();      // host-realm copy of everything in chrome.storage.local
//   bg.writes;         // keys of every chrome.storage.local.set() call, in order
//   bg.Storage;        // the Storage object from storage.js
//
// storage.js runs first, so background.js's importScripts() is a no-op: both
// scripts share the context's global scope (like importScripts in the worker).
// `isPro` (default false) sets what ExtPay's getUser() reports as paid.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function fakeStorageArea(initial, writes) {
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
      writes.push(Object.keys(items).sort());
      for (const [key, value] of Object.entries(items)) data[key] = clone(value);
    }
  };
}

function loadBackground(initialStorage, options) {
  const isPro = !!(options && options.isPro);
  const writes = [];
  const local = fakeStorageArea(initialStorage, writes);
  const listener = () => ({ addListener() {} });
  const chrome = {
    storage: { local },
    runtime: {
      onInstalled: listener(),
      onStartup: listener(),
      onMessage: listener(),
      getManifest: () => ({ version: '0.0.0-test' })
    },
    alarms: { onAlarm: listener(), create() {}, get(name, cb) { if (cb) cb(null); } },
    tabs: { create() {} }
  };
  const sandbox = {
    console,
    chrome,
    crypto: globalThis.crypto,
    TextEncoder,
    importScripts() {},
    ExtPay: () => ({ startBackground() {}, getUser: async () => ({ paid: isPro }), openPaymentPage() {} })
  };
  vm.createContext(sandbox);
  const storagePath = path.join(ROOT, 'storage.js');
  const backgroundPath = path.join(ROOT, 'background.js');
  vm.runInContext(fs.readFileSync(storagePath, 'utf8') + '\n;globalThis.__cfStorage = Storage;\n', sandbox, { filename: storagePath });
  vm.runInContext(fs.readFileSync(backgroundPath, 'utf8'), sandbox, { filename: backgroundPath });

  return {
    Storage: sandbox.__cfStorage,
    // Results come back as host-realm plain values, ready for deepStrictEqual.
    handleMessage: async request => clone(await sandbox.handleMessage(request)),
    storage: () => clone(local.data),
    writes,
    sandbox
  };
}

module.exports = loadBackground;
