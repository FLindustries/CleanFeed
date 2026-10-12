'use strict';
// Live test harness: drives the REAL CleanFeed extension in a real Chromium
// against the real (logged-out) YouTube. Dev-only, never packaged.
//
//   const h = require('./harness');
//   const stop = h.watchdog(120000);          // hard cap for the whole script
//   const ctx = await h.launch();
//   await h.setStorage({ blockedKeywords: [{ keyword: 'minecraft', addedAt: Date.now() }] });
//   const page = await h.newPage();
//   await h.gotoYouTube(page, 'https://www.youtube.com/results?search_query=minecraft');
//   await h.waitForFilter(page);
//   const n = await h.evalInPage(page, sel => document.querySelectorAll(sel).length, h.CARD_SELECTOR);
//   await h.close();
//
// Rules: never sign in to anything; on cookie-consent pages only "Reject all"
// is ever clicked. EVERY call that can block on the browser has a hard timeout
// (a later task runs this against a page that freezes): use withTimeout() /
// evalInPage() for anything you add, and watchdog() around whole scripts.
//
// Environment overrides:
//   PLAYWRIGHT_CORE_PATH  path to a playwright-core package directory
//   CF_CHROMIUM_PATH      path to chrome.exe (Chrome for Testing / Chromium)
//   CF_HEADED=1           force a visible browser window
//   CF_KEEP_PROFILE=1     reuse (do not wipe) the temp profile dir

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROFILE_NAME = 'cleanfeed-live-profile';

const LAUNCH_TIMEOUT_MS = 60000;
const SW_TIMEOUT_MS = 12000;
const STORAGE_INIT_TIMEOUT_MS = 10000;
const CALL_TIMEOUT_MS = 10000;
const SW_CALL_TIMEOUT_MS = 5000;
const NAV_TIMEOUT_MS = 30000;
const CLOSE_TIMEOUT_MS = 10000;

// Same selector the content script uses, read from content-dom.js so the two never drift.
const CARD_SELECTOR = require('../unit/load-content-dom')().YT.VIDEO_CARDS;

// Buttons that REJECT cookies. Deliberately an allowlist of "reject all" labels,
// anchored, so no "Accept all" / "Sign in" style button can ever match.
const REJECT_ALL_RE = /^\s*(reject all|rifiuta tutto|alle ablehnen|tout refuser|rechazar todo|rejeitar tudo|alles afwijzen)\s*$/i;

const state = {
  context: null,
  sw: null,
  extensionId: null,
  profileDir: null,
  headless: null,
  consentSettled: false,
  developerMode: false
};

// ── Timeouts ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Rejects after `ms` even if `promise` never settles (e.g. frozen page).
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`timed out after ${ms}ms: ${label}`);
      err.code = 'CF_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// page.evaluate with a hard timeout: a frozen renderer never answers, and
// Playwright's own page.evaluate has no timeout option.
function evalInPage(page, fn, arg, ms) {
  return withTimeout(page.evaluate(fn, arg), ms || CALL_TIMEOUT_MS, 'page.evaluate');
}

// Whole-script safety net. If the script is still running after `ms`, kill the
// browser and exit 124. Returns a function that cancels it.
function watchdog(ms) {
  const limit = ms || 180000;
  const timer = setTimeout(() => {
    console.error(`[harness] watchdog fired after ${limit}ms: killing browser and exiting`);
    try { killBrowserProcesses(state.profileDir); } catch (e) { /* best effort */ }
    process.exit(124);
  }, limit);
  timer.unref();
  return () => clearTimeout(timer);
}

// ── Resolving Playwright and Chromium ────────────────────────────────────

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dir, d.name));
  } catch (e) {
    return [];
  }
}

function resolvePlaywrightCore() {
  if (process.env.PLAYWRIGHT_CORE_PATH) {
    return require(process.env.PLAYWRIGHT_CORE_PATH);
  }
  const npx = path.join(localAppData(), 'npm-cache', '_npx');
  const candidates = listDirs(npx)
    .map(d => path.join(d, 'node_modules', 'playwright-core'))
    .filter(d => fs.existsSync(path.join(d, 'package.json')))
    .map(d => ({ dir: d, mtime: fs.statSync(d).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const errors = [];
  for (const c of candidates) {
    try {
      return require(c.dir);
    } catch (e) {
      errors.push(`${c.dir}: ${e.message}`);
    }
  }
  throw new Error(
    'playwright-core not found. Set PLAYWRIGHT_CORE_PATH to a playwright-core package directory, ' +
    `or run "npx playwright --version" once so it lands in ${npx}.` +
    (errors.length ? '\n' + errors.join('\n') : '')
  );
}

// Directories that may hold Playwright's chromium-<rev> folders. When this runs
// inside an MSIX-packaged app (e.g. the Claude desktop app) %LOCALAPPDATA% is
// virtualized: files are readable there but CreateProcess cannot launch them
// ("spawn UNKNOWN" / ENOENT). The same files spawn fine through their physical
// Packages\<pkg>\LocalCache\Local path, so those are searched too, first.
function chromiumBases() {
  const local = localAppData();
  const bases = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) bases.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  for (const pkg of listDirs(path.join(local, 'Packages'))) {
    bases.push(path.join(pkg, 'LocalCache', 'Local', 'ms-playwright'));
  }
  bases.push(path.join(local, 'ms-playwright'));
  return bases;
}

// All usable chrome.exe paths, best first: newest revision, and on equal
// revisions the physical (spawnable) location before the virtualized one.
// CF_CHROMIUM_PATH wins and is the only candidate.
function chromiumCandidates() {
  if (process.env.CF_CHROMIUM_PATH) {
    if (!fs.existsSync(process.env.CF_CHROMIUM_PATH)) {
      throw new Error(`CF_CHROMIUM_PATH does not exist: ${process.env.CF_CHROMIUM_PATH}`);
    }
    return [process.env.CF_CHROMIUM_PATH];
  }
  const found = [];
  chromiumBases().forEach((base, order) => {
    for (const dir of listDirs(base)) {
      const rev = Number((path.basename(dir).match(/^chromium-(\d+)$/) || [])[1]);
      const exe = path.join(dir, 'chrome-win64', 'chrome.exe');
      if (Number.isFinite(rev) && fs.existsSync(exe)) found.push({ exe, rev, order });
    }
  });
  found.sort((a, b) => b.rev - a.rev || a.order - b.order);
  if (found.length === 0) {
    throw new Error(
      `No Chromium found under ${chromiumBases().join(' or ')}. ` +
      'Set CF_CHROMIUM_PATH to a chrome.exe, or run "npx playwright install chromium".'
    );
  }
  return found.map(c => c.exe);
}

function resolveChromium() {
  return chromiumCandidates()[0];
}

// ── Profile + process cleanup ────────────────────────────────────────────

function prepareProfileDir() {
  const base = path.join(os.tmpdir(), PROFILE_NAME);
  if (process.env.CF_KEEP_PROFILE === '1') {
    fs.mkdirSync(base, { recursive: true });
    return base;
  }
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return base;
  } catch (e) {
    // A leftover browser still holds the old profile: use a fresh sibling dir.
    return `${base}-${process.pid}-${Date.now()}`;
  }
}

// Last resort when context.close() hangs: kill every chrome.exe whose command
// line mentions this profile dir (never other processes).
function killBrowserProcesses(profileDir) {
  if (!profileDir) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -and $_.CommandLine.Contains($env:CF_KILL_PATTERN) } | " +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
      ], { timeout: 20000, stdio: 'ignore', env: Object.assign({}, process.env, { CF_KILL_PATTERN: profileDir }) });
    } else {
      execFileSync('pkill', ['-f', `chrom.*${profileDir}`], { timeout: 10000, stdio: 'ignore' });
    }
  } catch (e) { /* nothing matched, or already gone */ }
}

function removeProfileDir(profileDir) {
  if (!profileDir || process.env.CF_KEEP_PROFILE === '1') return;
  try {
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) { /* best effort: it is a temp dir and is wiped on the next launch */ }
}

// ── Launch ───────────────────────────────────────────────────────────────

function isOurServiceWorker(worker) {
  return /^chrome-extension:\/\/[a-z]+\/background\.js$/.test(worker.url());
}

async function findServiceWorker(context, ms) {
  const existing = context.serviceWorkers().find(isOurServiceWorker);
  if (existing) return existing;
  return withTimeout(
    context.waitForEvent('serviceworker', { predicate: isOurServiceWorker, timeout: ms }),
    ms + 2000,
    'extension service worker'
  );
}

// background.js seeds default storage in onInstalled. Writing before that
// finishes could be overwritten by the defaults, so wait for it.
async function waitForStorageInit(sw) {
  const deadline = Date.now() + STORAGE_INIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const seeded = await withTimeout(
      sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings !== undefined),
      CALL_TIMEOUT_MS,
      'storage init check'
    );
    if (seeded) return;
    await sleep(200);
  }
  throw new Error('extension storage was never initialised (onInstalled did not finish)');
}

async function launchOnce(pw, exe, headless, extensionDir) {
  const profileDir = prepareProfileDir();
  state.profileDir = profileDir;
  let context;
  try {
    context = await withTimeout(
      pw.chromium.launchPersistentContext(profileDir, {
        executablePath: exe,
        headless,
        locale: 'en-US',
        viewport: { width: 1280, height: 900 },
        // Playwright adds --disable-extensions by default; we need extensions.
        ignoreDefaultArgs: ['--disable-extensions'],
        args: [
          `--disable-extensions-except=${extensionDir}`,
          `--load-extension=${extensionDir}`,
          '--lang=en-US'
        ],
        timeout: LAUNCH_TIMEOUT_MS - 5000
      }),
      LAUNCH_TIMEOUT_MS,
      'launchPersistentContext'
    );
    const sw = await findServiceWorker(context, SW_TIMEOUT_MS);
    await waitForStorageInit(sw);
    state.context = context;
    state.sw = sw;
    state.extensionId = new URL(sw.url()).hostname;
    state.headless = headless;
    return context;
  } catch (err) {
    // Tear down the failed attempt so a headed retry starts clean.
    if (context) {
      try { await withTimeout(context.close(), CLOSE_TIMEOUT_MS, 'context.close'); } catch (e) { /* kill below */ }
    }
    killBrowserProcesses(profileDir);
    removeProfileDir(profileDir);
    throw err;
  }
}

// Launches Chromium with the extension loaded from the repo root (or from
// `options.extensionDir`, e.g. a temp copy a test changes and then reloads
// with reloadExtension()). Tries headless first (new headless supports
// extensions), falls back to headed if the extension's service worker never
// appears. If a Chromium build cannot be started or will not load the
// extension, the next installed build is tried (at most 3). Returns the BrowserContext.
async function launch(options) {
  if (state.context) throw new Error('harness already launched: call close() first');
  const extensionDir = (options && options.extensionDir) || REPO_ROOT;
  const pw = resolvePlaywrightCore();
  const exes = chromiumCandidates().slice(0, 3);
  const modes = process.env.CF_HEADED === '1' ? [false] : [true, false];
  const failures = [];
  for (const exe of exes) {
    for (const headless of modes) {
      try {
        return await launchOnce(pw, exe, headless, extensionDir);
      } catch (err) {
        const firstLine = String(err.message).split('\n')[0];
        failures.push(`${exe} (${headless ? 'headless' : 'headed'}): ${firstLine}`);
        // The OS refused to start this executable: another mode will not help.
        if (/spawn (UNKNOWN|ENOENT|EACCES)/.test(firstLine)) break;
      }
    }
  }
  throw new Error('could not launch Chromium with the extension.\n' + failures.join('\n'));
}

function requireContext() {
  if (!state.context) throw new Error('harness not launched: call launch() first');
  return state.context;
}

function getExtensionId() {
  requireContext();
  return state.extensionId;
}

function newPage() {
  return withTimeout(requireContext().newPage(), CALL_TIMEOUT_MS, 'context.newPage');
}

// MV3 service workers are terminated when idle. If ours is gone, wake it by
// opening an extension page (it messages the background on load) and wait.
async function getServiceWorker() {
  const context = requireContext();
  if (state.sw && context.serviceWorkers().includes(state.sw)) return state.sw;
  const found = context.serviceWorkers().find(isOurServiceWorker);
  if (found) {
    state.sw = found;
    return found;
  }
  const waker = await newPage();
  try {
    const waiting = findServiceWorker(context, SW_TIMEOUT_MS);
    waiting.catch(() => {}); // avoid an unhandled rejection if goto throws first
    await withTimeout(
      waker.goto(`chrome-extension://${state.extensionId}/options.html`, { waitUntil: 'domcontentloaded', timeout: CALL_TIMEOUT_MS }),
      CALL_TIMEOUT_MS + 2000,
      'wake service worker'
    );
    state.sw = await waiting;
    return state.sw;
  } finally {
    try { await withTimeout(waker.close(), CALL_TIMEOUT_MS, 'close waker page'); } catch (e) { /* ignore */ }
  }
}

// Chromium re-enables a reloaded unpacked extension only in developer mode
// (otherwise it is disabled as "unsupportedDeveloperExtension"). Turns it on
// in this throwaway test profile, from chrome://extensions.
async function enableDeveloperMode() {
  if (state.developerMode) return;
  const page = await newPage();
  try {
    await withTimeout(
      page.goto('chrome://extensions/', { waitUntil: 'domcontentloaded', timeout: CALL_TIMEOUT_MS }),
      CALL_TIMEOUT_MS + 2000,
      'open chrome://extensions'
    );
    await evalInPage(page, () => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
    state.developerMode = true;
  } finally {
    try { await withTimeout(page.close(), CALL_TIMEOUT_MS, 'close chrome://extensions'); } catch (e) { /* ignore */ }
  }
}

// Reloads the extension like an update does: chrome.runtime.reload() in the
// service worker (from disk, so changes to an unpacked copy apply), then waits
// for the new service worker and for onInstalled's storage setup. Content
// scripts in open tabs are orphaned. Returns the ms until the new worker ran.
async function reloadExtension() {
  const context = requireContext();
  await enableDeveloperMode();
  const old = await getServiceWorker();
  const started = Date.now();
  const next = withTimeout(
    context.waitForEvent('serviceworker', { predicate: w => isOurServiceWorker(w) && w !== old, timeout: SW_TIMEOUT_MS }),
    SW_TIMEOUT_MS + 2000,
    'service worker after reload'
  );
  next.catch(() => {}); // awaited below
  state.sw = null;
  // The worker goes away while answering: the evaluate itself may fail
  try { await withTimeout(old.evaluate(() => { chrome.runtime.reload(); }), SW_CALL_TIMEOUT_MS, 'chrome.runtime.reload'); } catch (e) { /* expected */ }
  state.sw = await next;
  await waitForStorageInit(state.sw);
  return Date.now() - started;
}

// Runs fn(arg) inside the extension's service worker. If the worker cannot be
// reached in time (recycled, hung), falls back to a script-less page on the
// extension origin (manifest.json), which exposes the same chrome.* storage API.
async function swEval(fn, arg, label) {
  try {
    const sw = await getServiceWorker();
    return await withTimeout(sw.evaluate(fn, arg), SW_CALL_TIMEOUT_MS, label);
  } catch (swErr) {
    state.sw = null;
    const page = await newPage();
    try {
      await withTimeout(
        page.goto(`chrome-extension://${state.extensionId}/manifest.json`, { waitUntil: 'domcontentloaded', timeout: CALL_TIMEOUT_MS }),
        CALL_TIMEOUT_MS + 2000,
        `${label} (extension page)`
      );
      return await evalInPage(page, fn, arg);
    } catch (pageErr) {
      throw new Error(`${label} failed in the service worker (${swErr.message}) and in an extension page (${pageErr.message})`);
    } finally {
      try { await withTimeout(page.close(), CALL_TIMEOUT_MS, 'close extension page'); } catch (e) { /* ignore */ }
    }
  }
}

// chrome.storage.local.set(obj) from inside the extension.
function setStorage(obj) {
  return swEval(async o => { await chrome.storage.local.set(o); return true; }, obj, 'setStorage');
}

// chrome.storage.local.get(keys) from inside the extension (null = everything).
function getStorage(keys) {
  return swEval(k => chrome.storage.local.get(k), keys === undefined ? null : keys, 'getStorage');
}

// ── YouTube navigation ───────────────────────────────────────────────────

// Clicks "Reject all" if a cookie-consent page or dialog is showing. Never
// clicks anything else. Returns true if it rejected.
async function rejectConsentIfShown(page) {
  const onConsentHost = /(^|\.)consent\.(youtube|google)\.com$/.test(new URL(page.url()).hostname);
  // After the first pass the choice is remembered in a cookie, so only peek.
  const waitMs = onConsentHost ? 10000 : (state.consentSettled ? 800 : 4000);
  // Accessible name OR visible text: YouTube's in-page consent bump gives its
  // "Reject all" button a long aria-label ("Reject the use of cookies ..."),
  // so only the button's text says "Reject all".
  const button = page.getByRole('button', { name: REJECT_ALL_RE })
    .or(page.locator('button').filter({ hasText: REJECT_ALL_RE }))
    .first();
  let shown = false;
  try {
    await withTimeout(button.waitFor({ state: 'visible', timeout: waitMs }), waitMs + 2000, 'consent button');
    shown = true;
  } catch (e) { /* no consent UI */ }
  state.consentSettled = true;
  if (!shown) return false;
  await withTimeout(button.click({ timeout: 5000 }), 8000, 'click Reject all');
  if (onConsentHost) {
    try {
      await withTimeout(
        page.waitForURL(u => !/(^|\.)consent\./.test(u.hostname) && /youtube\.com$/.test(u.hostname), { timeout: 20000 }),
        22000,
        'redirect after consent'
      );
    } catch (e) {
      // The redirect can be aborted (net::ERR_ABORTED) by a follow-up
      // navigation; gotoYouTube() navigates again if we are not on YouTube.
      await sleep(1000);
    }
  } else {
    await sleep(500);
  }
  return true;
}

// Navigates to a YouTube URL (DOMContentLoaded) and rejects cookie consent if
// it appears. Returns { url, consentRejected }.
async function gotoYouTube(page, url) {
  await withTimeout(
    page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }),
    NAV_TIMEOUT_MS + 5000,
    `goto ${url}`
  );
  const consentRejected = await rejectConsentIfShown(page);
  if (consentRejected && !/youtube\.com$/.test(new URL(page.url()).hostname)) {
    await withTimeout(
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }),
      NAV_TIMEOUT_MS + 5000,
      `goto ${url} (after consent)`
    );
  }
  return { url: page.url(), consentRejected };
}

// Short settle wait: gives the page time to render video cards, then lets the
// content script's filter pass and mutation observer finish. Never throws.
async function waitForFilter(page, opts) {
  const settleMs = (opts && opts.settleMs) || 2500;
  const timeout = (opts && opts.timeout) || 10000;
  try {
    await withTimeout(page.waitForSelector(CARD_SELECTOR, { state: 'attached', timeout }), timeout + 2000, 'wait for video cards');
  } catch (e) { /* no cards (empty page / frozen): still settle, the caller inspects the result */ }
  await sleep(settleMs);
}

// ── Content-script world ─────────────────────────────────────────────────

// page.evaluate runs in the page's main world, which cannot see the content
// script's globals (YT, cfEl, ...). This evaluates expressions inside
// CleanFeed's own isolated world in the page's main frame, through CDP.
//   const cs = await h.attachContentWorld(page);   // once per page
//   const name = await cs.evaluate('YT.getPageChannelName()');
// The result must be JSON-serializable. Survives SPA and full navigations
// (it always uses the newest CleanFeed world of the main frame).
async function attachContentWorld(page) {
  const origin = `chrome-extension://${getExtensionId()}`;
  const cdp = await withTimeout(requireContext().newCDPSession(page), CALL_TIMEOUT_MS, 'newCDPSession');
  const tree = await withTimeout(cdp.send('Page.getFrameTree'), CALL_TIMEOUT_MS, 'Page.getFrameTree');
  const mainFrameId = tree.frameTree.frame.id;
  const worlds = new Map(); // execution context id -> created order
  let created = 0;
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    const aux = context.auxData || {};
    if (context.origin === origin && aux.type === 'isolated' && aux.frameId === mainFrameId) {
      worlds.set(context.id, ++created);
    }
  });
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => worlds.delete(executionContextId));
  cdp.on('Runtime.executionContextsCleared', () => worlds.clear());
  await withTimeout(cdp.send('Runtime.enable'), CALL_TIMEOUT_MS, 'Runtime.enable');

  async function evaluate(expression, ms) {
    const limit = ms || CALL_TIMEOUT_MS;
    const deadline = Date.now() + limit;
    while (worlds.size === 0) {
      if (Date.now() > deadline) throw new Error('CleanFeed content-script world not found in the main frame');
      await sleep(200);
    }
    const contextId = [...worlds.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const res = await withTimeout(
      cdp.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }),
      limit,
      `content-world evaluate: ${expression.slice(0, 60)}`
    );
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception;
      throw new Error(`content-world evaluate threw: ${(ex && ex.description) || res.exceptionDetails.text}`);
    }
    return res.result.value;
  }

  return {
    evaluate,
    detach: () => withTimeout(cdp.detach(), CALL_TIMEOUT_MS, 'CDP detach').catch(() => {})
  };
}

// ── Shutdown ─────────────────────────────────────────────────────────────

async function close() {
  const context = state.context;
  const profileDir = state.profileDir;
  state.context = null;
  state.sw = null;
  state.extensionId = null;
  // The next launch uses a fresh profile, so YouTube asks for consent again.
  state.consentSettled = false;
  state.developerMode = false;
  if (!context) return;
  try {
    await withTimeout(context.close(), CLOSE_TIMEOUT_MS, 'context.close');
  } catch (e) {
    killBrowserProcesses(profileDir);
  }
  removeProfileDir(profileDir);
}

module.exports = {
  REPO_ROOT,
  CARD_SELECTOR,
  resolvePlaywrightCore,
  resolveChromium,
  chromiumCandidates,
  withTimeout,
  evalInPage,
  watchdog,
  sleep,
  launch,
  newPage,
  getExtensionId,
  getServiceWorker,
  reloadExtension,
  setStorage,
  getStorage,
  gotoYouTube,
  rejectConsentIfShown,
  waitForFilter,
  attachContentWorld,
  close,
  isHeadless: () => state.headless
};
