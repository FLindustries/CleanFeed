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
//   bg.listeners;      // { onInstalled: [fn], onStartup: [fn], onAlarm: [fn], storageOnChanged: [fn], ... }
//   bg.alarmCalls;     // every chrome.alarms call, in order: ['create' | 'clear' | 'get', name]
//   bg.chrome;         // the stub chrome: bg.chrome.storage.sync.set({...}) writes like ExtPay
//
// chrome.storage.local and chrome.storage.sync (options.syncStorage: its
// initial contents, where ExtPay keeps extensionpay_user) call the
// storage.onChanged listeners after every set() that changes a value, like Chrome.
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
//
// Open tabs and script injection. `options`:
//   tabs           what chrome.tabs.query() returns (default []): [{ id, url }]
//   scriptingError (call) => an Error to throw for that chrome.scripting call
//                  (call: { method: 'insertCSS' | 'executeScript', tabId, files }), or null
// bg.tabsQueries holds every chrome.tabs.query() argument, bg.scriptingCalls
// every chrome.scripting call ({ method, tabId, files }), failed ones included.
// chrome.runtime.getManifest() returns the real manifest.json (version 0.0.0-test).
//
// Plans and checkout. `options`:
//   getPlans   replaces the stub ExtPay's getPlans (async () => plans, or throw
//              to fail; default: no plans)
//   noExtPay   true: ExtPay() throws, like a failed ExtensionPay init
//   contexts   what chrome.runtime.getContexts() returns (default []):
//              [{ contextType, tabId, windowId, documentUrl }]
// bg.getPlansCalls() counts getPlans() calls; bg.openPaymentPageCalls holds
// the argument of each extpay.openPaymentPage() call (null for none);
// bg.tabsCreated, bg.tabsUpdated ([tabId, props]) and bg.windowsUpdated
// ([windowId, props]) record those chrome calls. chrome.runtime.getURL(path)
// is bg.extensionUrl(path): 'chrome-extension://cleanfeed-test/' + path.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const PRO_CACHE_KEY = 'proStatusCache';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// `changed(changes, areaName)` runs after each set() that changed a value,
// like chrome.storage.onChanged (unchanged keys are left out).
function fakeStorageArea(areaName, initial, writes, proWrites, changed) {
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
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        const had = Object.prototype.hasOwnProperty.call(data, key);
        if (had && JSON.stringify(data[key]) === JSON.stringify(value)) continue;
        changes[key] = had ? { oldValue: clone(data[key]), newValue: clone(value) } : { newValue: clone(value) };
        data[key] = clone(value);
      }
      if (Object.keys(changes).length > 0) changed(changes, areaName);
    }
  };
}

function loadBackground(initialStorage, options) {
  const opts = options || {};
  const isPro = !!opts.isPro;
  const writes = [];
  const proWrites = [];
  const listeners = {};
  const listener = name => ({ addListener(fn) { (listeners[name] = listeners[name] || []).push(fn); } });
  const storageChanged = (changes, areaName) => {
    for (const fn of listeners.storageOnChanged || []) fn(clone(changes), areaName);
  };
  const local = fakeStorageArea('local', initialStorage, writes, proWrites, storageChanged);
  // ExtPay's own storage (it saves extensionpay_* in sync); kept out of `writes`
  const sync = fakeStorageArea('sync', opts.syncStorage, [], [], storageChanged);
  const alarmCalls = [];
  const tabsQueries = [];
  const scriptingCalls = [];
  const scriptingCall = (method, injection) => {
    const call = { method, tabId: injection.target.tabId, files: clone(injection.files) };
    scriptingCalls.push(call);
    const err = opts.scriptingError ? opts.scriptingError(call) : null;
    if (err) throw err;
  };
  const paidListeners = [];
  let getUserCalls = 0;
  const getUser = opts.getUser || (async () => ({ paid: isPro }));
  let getPlansCalls = 0;
  const getPlans = opts.getPlans || (async () => []);
  const openPaymentPageCalls = [];
  const tabsCreated = [];
  const tabsUpdated = [];
  const windowsUpdated = [];
  const extensionUrl = p => 'chrome-extension://cleanfeed-test/' + p;
  const chrome = {
    storage: { local, sync, onChanged: listener('storageOnChanged') },
    runtime: {
      onInstalled: listener('onInstalled'),
      onStartup: listener('onStartup'),
      onMessage: listener('onMessage'),
      getManifest: () => Object.assign(clone(MANIFEST), { version: '0.0.0-test' }),
      getURL: extensionUrl,
      async getContexts() { return clone(opts.contexts || []); }
    },
    alarms: {
      onAlarm: listener('onAlarm'),
      create(name) { alarmCalls.push(['create', name]); },
      clear(name) { alarmCalls.push(['clear', name]); return Promise.resolve(true); },
      get(name, cb) { alarmCalls.push(['get', name]); if (cb) cb(null); }
    },
    tabs: {
      async create(props) { tabsCreated.push(clone(props)); return { id: 900 + tabsCreated.length, windowId: 1 }; },
      async update(tabId, props) { tabsUpdated.push([tabId, clone(props)]); return { id: tabId, windowId: 1 }; },
      async query(queryInfo) { tabsQueries.push(clone(queryInfo)); return clone(opts.tabs || []); }
    },
    windows: {
      async update(windowId, props) { windowsUpdated.push([windowId, clone(props)]); return { id: windowId }; }
    },
    scripting: {
      insertCSS: async injection => scriptingCall('insertCSS', injection),
      executeScript: async injection => { scriptingCall('executeScript', injection); return []; }
    }
  };
  const sandbox = {
    console: opts.console || console,
    chrome,
    crypto: globalThis.crypto,
    TextEncoder,
    setTimeout: opts.setTimeout || setTimeout,
    clearTimeout: opts.clearTimeout || clearTimeout,
    importScripts() {},
    ExtPay: () => {
      if (opts.noExtPay) throw new Error('ExtPay init failed (test)');
      return {
        startBackground() {},
        getUser() { getUserCalls++; return getUser(); },
        getPlans() { getPlansCalls++; return getPlans(); },
        onPaid: { addListener(fn) { paidListeners.push(fn); } },
        openPaymentPage(plan) { openPaymentPageCalls.push(plan === undefined ? null : plan); }
      };
    }
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
    getPlansCalls: () => getPlansCalls,
    openPaymentPageCalls,
    tabsCreated,
    tabsUpdated,
    windowsUpdated,
    extensionUrl,
    paidListeners,
    writes,
    listeners,
    alarmCalls,
    tabsQueries,
    scriptingCalls,
    chrome,
    sandbox
  };
}

module.exports = loadBackground;
