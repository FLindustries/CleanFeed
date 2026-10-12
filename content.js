// CleanFeed Content Script — v1.1
// Runs on all YouTube pages. Handles channel/keyword blocking, menu injection,
// curiosity window (interest boundaries), subscription exceptions, and Shorts hiding.
// Depends on features.js (CF_FEATURES) and content-dom.js (cfEl, YT,
// matchesKeyword) loaded before this file.

(() => {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────

  let blockedChannelNames = new Set();
  let blockedChannelHandles = new Set(); // @handles for href-based matching
  let blockedKeywords = [];
  let whitelistedChannels = [];
  let savedInterestQueries = []; // active interests from storage (Today/Always)
  let currentSettings = {};
  let isPro = false;
  // Channels that have been auto-tagged for a blocked topic because too
  // many of their videos already matched. Shape: Map<categoryLower, Set<channelLower>>
  let categoryTagsLocal = new Map();
  // Pending category hits — flushed in a batch via background to reduce IPC.
  // Shape: Map<`${category}::${channelLower}`, Set<videoKey>>
  const pendingCategoryHits = new Map();
  let categoryHitFlushTimer = null;
  // Videos already counted toward auto-tagging in this tab
  // (`${category}::${channelLower}\n${videoKey}`). Every full refilter
  // evaluates the same cards again; each video must count only once.
  const countedCategoryVideos = new Set();
  // Page-scoped overrides (all reset on yt-navigate-finish):
  //   isPagePaused  — floating toggle: disable ALL filtering on this page
  //   peekedChannels — handles (lowercase, with @) the user wants to see
  //                    on this page only, regardless of block/keyword rules
  let isPagePaused = false;
  const peekedChannels = new Set();
  let debounceTimer = null;
  let observer = null;
  let lastClickedVideoCard = null;
  // Last menu-button click: when, and a token unique to that click inside a
  // card ('' when the click was outside any card). See injectBlockOption.
  let lastMenuClickAt = 0;
  let lastMenuClickToken = '';
  let menuClickSeq = 0;
  // searchIntercepted — now tracked via data-cf-search-intercepted on the input element
  let activeJustNowQueries = new Set();
  const loggedVideos = new Set(); // dedup: track title+channel combos already logged
  let sessionPromptCount = 0; // per-session curiosity prompt count (resets each page load)
  let lastPromptedQuery = ''; // avoid re-prompting for the same query on SPA re-renders
  let lastKnownSearchQuery = ''; // track URL search query for SPA change detection
  let pendingCuriosityCheck = null; // pending waitForSearchResults timeout
  let _timeTrackerInterval = null;
  let _timeAccumulated = 0;

  // ── Helpers ────────────────────────────────────────────────────────────

  // Custom i18n: load language override from settings
  let _contentMessages = null;

  async function loadContentLanguage() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      const lang = settings?.language || 'auto';
      if (lang === 'auto') { _contentMessages = null; return; }
      const url = chrome.runtime.getURL('_locales/' + lang + '/messages.json');
      const resp = await fetch(url);
      _contentMessages = await resp.json();
    } catch (e) {
      _contentMessages = null;
    }
  }

  function msg(key, subs) {
    // Try custom language first
    if (_contentMessages && _contentMessages[key]) {
      let text = _contentMessages[key].message;
      if (subs && Array.isArray(subs)) {
        subs.forEach((sub, i) => {
          text = text.replace('$' + (i + 1), sub);
          const placeholders = _contentMessages[key].placeholders;
          if (placeholders) {
            for (const [name, ph] of Object.entries(placeholders)) {
              if (ph.content === '$' + (i + 1)) {
                text = text.replace('$' + name.toUpperCase() + '$', sub);
              }
            }
          }
        });
      }
      return text;
    }
    try {
      return chrome.i18n?.getMessage(key, subs) || key;
    } catch (e) {
      return key;
    }
  }

  function sendMsg(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (chrome.runtime.lastError) {
            // Extension was reloaded — silently ignore
            resolve({});
            return;
          }
          resolve(resp || {});
        });
      } catch (e) {
        // Extension context invalidated — silently ignore
        resolve({});
      }
    });
  }

  // Returns an <img> using the extension's actual green icon, falling back to
  // a textual "CF" badge if the runtime URL is unavailable (e.g. extension
  // context invalidated during a hot reload).
  function cfLogo() {
    try {
      const img = document.createElement('img');
      img.className = 'cleanfeed-cf-logo';
      img.src = chrome.runtime.getURL('icons/icon48.png');
      img.alt = 'CF';
      return img;
    } catch (e) {
      return cfEl('span', { className: 'cleanfeed-cf-logo cleanfeed-cf-logo-fallback', textContent: 'CF' });
    }
  }

  // Build a slider toggle switch (dark-mode style). The "on" state means the
  // labelled feature is ACTIVE (e.g. CleanFeed ON, Channel hidden ON).
  // opts.locked: locked by Strict Mode (dimmed; a click only explains why).
  function cfSwitch(opts) {
    const wrap = document.createElement('button');
    wrap.type = 'button';
    wrap.className = 'cf-switch' + (opts.on ? ' cf-on' : '');
    if (opts.id) wrap.id = opts.id;
    if (opts.title) wrap.title = opts.title;
    if (opts.extraClass) wrap.className += ' ' + opts.extraClass;
    if (opts.locked) {
      wrap.className += ' cleanfeed-strict-locked';
      for (const [name, value] of Object.entries(strictLockAttrs())) wrap.setAttribute(name, value);
    }

    const label = cfEl('span', { className: 'cf-switch-label', textContent: opts.label });
    const thumb = cfEl('span', { className: 'cf-switch-thumb' });
    const track = cfEl('span', { className: 'cf-switch-track' }, [thumb]);

    wrap.appendChild(label);
    wrap.appendChild(track);
    const onToggle = opts.locked ? showStrictLockedToast : opts.onToggle;
    if (typeof onToggle === 'function') {
      wrap.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      });
    }
    return wrap;
  }

  // ── Strict Mode ───────────────────────────────────────────────────────
  // While strict mode is on, the on-page controls that weaken filtering
  // (pause, peek, untag, the "More relevant" toggle, the subscription
  // exception) are locked. No password is ever asked inside a YouTube page:
  // the user turns strict mode off in CleanFeed's settings instead.

  function isStrictLocked() {
    return !!currentSettings.strictModeEnabled;
  }

  // Attributes of a control locked by Strict Mode: the reason as its tooltip.
  function strictLockAttrs() {
    return { title: msg('strictLockedTitle'), 'aria-disabled': 'true' };
  }

  function showStrictLockedToast() {
    showToast(msg('strictLockedToast'));
  }

  // ── Page-scope skip rules ─────────────────────────────────────────────
  // Subscriptions feed is the user's own choice — they curated those channels,
  // so filtering there only gets in the way. If they don't like a video they
  // can unsubscribe directly.
  // Returns true if the current local time falls OUTSIDE the user's scheduled
  // filtering window. During schedule-off hours CleanFeed behaves as if paused.
  // Schedule mode hidden (features.js): never outside, even if a user enabled it.
  function isOutsideSchedule() {
    if (!CF_FEATURES.schedule || !currentSettings.scheduleEnabled) return false;
    const start = currentSettings.scheduleStart || '09:00';
    const end = currentSettings.scheduleEnd || '18:00';
    const days = currentSettings.scheduleDays || [1, 2, 3, 4, 5];
    const now = new Date();
    if (!days.includes(now.getDay())) return true; // wrong day → schedule off

    const [startH, startM] = start.split(':').map(n => parseInt(n, 10));
    const [endH, endM] = end.split(':').map(n => parseInt(n, 10));
    const cur = now.getHours() * 60 + now.getMinutes();
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;
    if (startMin <= endMin) {
      return !(cur >= startMin && cur < endMin);
    } else {
      // Wraps midnight (e.g. 22:00 to 06:00)
      return !(cur >= startMin || cur < endMin);
    }
  }

  function isFilteringDisabledForPage() {
    return cfFilteringDisabledForPage({
      paused: isPagePaused,
      outsideSchedule: isOutsideSchedule(), // schedule outside hours
      pathname: window.location.pathname
    });
  }

  // Extract channel handle (lowercase, "@xyz") from a card or page. Returns null
  // if unavailable. Used for peek-channel matching against href attributes.
  function getCardChannelHandle(card) {
    const link = card.querySelector('a[href^="/@"]');
    if (!link) return null;
    const href = (link.getAttribute('href') || '').toLowerCase();
    const m = href.match(/^\/(@[^\/\?]+)/);
    return m ? m[1] : null;
  }

  function isCardPeeked(card) {
    if (peekedChannels.size === 0) return false;
    const handle = getCardChannelHandle(card);
    if (handle && peekedChannels.has(handle)) return true;
    // Fallback: match by channel name (sidebar cards may lack handle links)
    const name = YT.getChannelName(card);
    if (name && peekedChannels.has(name.toLowerCase())) return true;
    // Channel-page fallback: video cards on a channel's own page don't repeat
    // the channel link or name inside each card (it's already in the header),
    // so the previous lookups return null. Use the PAGE channel as the implicit
    // owner of every card on this page. Without this, "Show just now" did
    // nothing on a channel's own page.
    if (YT.isChannelPage()) {
      const pageName = YT.getPageChannelName();
      if (pageName && peekedChannels.has(pageName.toLowerCase())) return true;
      const pageId = YT.getPageChannelId();
      if (pageId) {
        const h = pageId.startsWith('@') ? pageId.toLowerCase() : '@' + pageId.toLowerCase();
        if (peekedChannels.has(h)) return true;
      }
    }
    return false;
  }

  // ── Init ───────────────────────────────────────────────────────────────

  // --- Daily Time Limit ---

  function startTimeTracker() {
    // Daily time limit hidden (features.js): no tracker, no storage writes
    // (each one refilters every YouTube tab), no overlay.
    if (!CF_FEATURES.dailyTimeLimit) return;
    // Send every 30s of foreground time to background
    if (_timeTrackerInterval) clearInterval(_timeTrackerInterval);
    _timeTrackerInterval = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      _timeAccumulated += 30;
      if (_timeAccumulated >= 30) {
        sendMsg({ action: 'addTimeUsed', seconds: _timeAccumulated });
        _timeAccumulated = 0;
      }
      await checkTimeLimit();
    }, 30000);
    // Initial check immediately
    checkTimeLimit();
  }

  async function checkTimeLimit() {
    if (!currentSettings.dailyTimeLimitEnabled) {
      document.body.classList.remove('cleanfeed-time-limit-reached');
      const overlay = document.getElementById('cleanfeed-time-limit-overlay');
      if (overlay) overlay.remove();
      return;
    }
    const limitMins = currentSettings.dailyTimeLimitMins || 30;
    const resp = await sendMsg({ action: 'getTimeUsed' });
    const secsUsed = (resp && resp.secondsUsed) || 0;
    if (secsUsed >= limitMins * 60) {
      document.body.classList.add('cleanfeed-time-limit-reached');
      showTimeLimitOverlay(limitMins);
    } else {
      document.body.classList.remove('cleanfeed-time-limit-reached');
      const overlay = document.getElementById('cleanfeed-time-limit-overlay');
      if (overlay) overlay.remove();
    }
  }

  function showTimeLimitOverlay(limitMins) {
    if (document.getElementById('cleanfeed-time-limit-overlay')) return;
    const h = cfEl('h2', { textContent: '⏰ Daily limit reached' });
    const p = cfEl('p', { textContent: "You've spent " + limitMins + ' minutes on YouTube today. Come back tomorrow.' });
    const tip = cfEl('p', { className: 'cleanfeed-time-limit-tip', textContent: 'Tip: change the limit in CleanFeed options if you need more time.' });
    const card = cfEl('div', { className: 'cleanfeed-time-limit-card' }, [h, p, tip]);
    const wrap = cfEl('div', { id: 'cleanfeed-time-limit-overlay', className: 'cleanfeed-time-limit-overlay' }, [card]);
    document.body.appendChild(wrap);
  }

  async function init() {
    // Load custom language for content script messages
    await loadContentLanguage();

    // Pre-apply Shorts hiding immediately (before waiting for full state)
    // to eliminate any flash of Shorts content during load.
    try {
      const { settings } = await chrome.storage.local.get('settings');
      if (settings && settings.hideShorts) {
        document.body.classList.add('cleanfeed-hide-shorts');
      }
    } catch (e) { /* storage not ready yet — init will handle it */ }

    const state = await sendMsg({ action: 'getFullState' });
    applyState(state);

    filterPage();
    injectQuickAddButtonsAll();
    startObserver();
    trackMenuClicks();
    interceptSuggestedClicks();
    watchForMenuPopup();
    interceptSearch();
    injectChannelPageButton();
    injectPauseToggle();
    injectSubscriptionsToggle();
    applyRelevantSectionVisibility();
    startTimeTracker();

    document.addEventListener('yt-navigate-finish', onNavigate);
    document.addEventListener('yt-page-data-updated', () => {
      filterPage();
      checkSearchQueryChanged();
    });
    startSearchQueryWatcher();
    chrome.storage.onChanged.addListener(onStorageChanged);

    // Listen for direct refilter messages from popup/background
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request && request.action === 'refilterPage') {
        onStorageChanged({ blockedChannels: true }, 'local');
        sendResponse({ success: true });
      }
    });

    // Re-check schedule status every 5 minutes so filtering kicks in/out on time
    // (only while Schedule mode exists, see features.js)
    if (CF_FEATURES.schedule) {
      setInterval(() => {
        if (currentSettings.scheduleEnabled) {
          // Reset cf-checked state so cards get re-evaluated under new schedule status
          document.querySelectorAll('[data-cf-checked]').forEach((el) => {
            delete el.dataset.cfChecked;
          });
          document.querySelectorAll('.cleanfeed-hidden').forEach((el) => {
            el.classList.remove('cleanfeed-hidden');
          });
          filterPage();
        }
      }, 5 * 60 * 1000);
    }
  }

  // Diagnostic: dump full filtering state to console once per change. Helps
  // the user (and us) trace "why is this video being blocked" without needing
  // a separate dev tool. Deduped so repeated applyState calls don't spam.
  let _lastDebugKey = '';
  function logDebugState(state) {
    const info = {
      blockedKeywords: (state.blockedKeywords || []).map(k => k.keyword),
      blockedChannels: (state.blockedChannels || []).map(c => c.name),
      customSynonyms: state.customSynonyms || {},
      disabledSynonyms: state.disabledSynonyms || [],
      categoryTags: state.categoryTags || {},
      currentChannelOnPage: YT.isChannelPage() ? YT.getPageChannelName() : null
    };
    const key = JSON.stringify(info);
    if (key === _lastDebugKey) return;
    _lastDebugKey = key;
    console.log('%cCleanFeed state:', 'color:#00c853;font-weight:bold;', info);
  }

  function applyState(state) {
    if (!state) return;
    logDebugState(state);
    currentSettings = state.settings || {};
    isPro = !!state.isPro;
    // Strict mode ends a page pause or channel peek the user started before it was on
    if (isStrictLocked()) {
      if (isPagePaused) {
        isPagePaused = false;
        document.body.classList.remove('cleanfeed-paused');
      }
      peekedChannels.clear();
    }
    blockedKeywords = state.blockedKeywords || [];
    whitelistedChannels = state.whitelistedChannels || [];

    // Load saved interests (Today/Always) so hideBlockedContent can exempt them.
    // Filter out expired "Today" interests.
    savedInterestQueries = [];
    const interests = state.interests || {};
    const now = Date.now();
    for (const [key, interest] of Object.entries(interests)) {
      if (interest.expiresAt && interest.expiresAt < now) continue; // expired
      if (interest.query) savedInterestQueries.push(interest.query.toLowerCase());
    }

    blockedChannelNames = new Set();
    blockedChannelHandles = new Set();
    const channels = state.blockedChannels || [];
    for (const ch of channels) {
      if (ch.name) blockedChannelNames.add(ch.name.toLowerCase());
      if (ch.id) {
        const handle = ch.id.startsWith('@') ? ch.id.toLowerCase() : '@' + ch.id.toLowerCase();
        blockedChannelHandles.add(handle);
      }
    }

    // Update synonym filters (disabled synonyms + custom synonyms)
    cfSetSynonymFilters(state.disabledSynonyms, state.customSynonyms);

    // Load auto-tagged channels per category (case-insensitive)
    // ALSO: filter out garbage channel names that may have leaked into storage
    // BEFORE the channel-name validation was added. Without this, an existing
    // "•" or view-count entry keeps blocking videos sitewide.
    // Only topics auto-tag: tags stored for a plain keyword by older versions
    // stay in storage but are ignored. Channels the user untagged are ignored
    // too, even if a tag for them comes back (e.g. from an imported backup).
    categoryTagsLocal = new Map();
    const tagMap = state.categoryTags || {};
    const exclusions = state.categoryTagExclusions || {};
    let needsCleanup = false;
    const cleanedTags = {};
    for (const [cat, channels] of Object.entries(tagMap)) {
      if (!Array.isArray(channels)) continue;
      const validChannels = channels.filter(c => isValidChannelName(c));
      if (validChannels.length !== channels.length) needsCleanup = true;
      if (validChannels.length === 0) continue;
      cleanedTags[cat] = validChannels;
      const catLower = cat.toLowerCase();
      if (!cfIsTopicKeyword(catLower)) continue;
      const excluded = Array.isArray(exclusions[catLower]) ? exclusions[catLower] : [];
      const active = validChannels.map(c => c.toLowerCase()).filter(c => !excluded.includes(c));
      if (active.length > 0) categoryTagsLocal.set(catLower, new Set(active));
    }
    if (needsCleanup) {
      console.log('%cCleanFeed: removed garbage entries from categoryTags', 'color:#ffa500;font-weight:bold;');
      sendMsg({ action: 'replaceCategoryTags', tags: cleanedTags });
    }

    updateBlockedChannelPreHideStyles();
  }

  // ── Category auto-tag helpers ─────────────────────────────────────────

  function isChannelTaggedForBlocked(channelLower) {
    if (!channelLower) return null;
    // Returns the matching blocked keyword (category) if channel is tagged, else null.
    // categoryTagsLocal holds topics only, so a plain keyword never matches here.
    for (const kw of blockedKeywords) {
      const cat = kw.keyword.toLowerCase();
      const tagged = categoryTagsLocal.get(cat);
      if (tagged && tagged.has(channelLower)) return cat;
    }
    return null;
  }

  // Counts `card`, hidden for matching `keyword`, toward auto-tagging its
  // channel. Only a topic counts (cfCategoryHitKey refuses plain keywords and
  // garbage channel names), and each video counts once per topic and channel:
  // here for this tab, and in the background across page loads.
  function queueCategoryHit(keyword, channelName, card, title) {
    const key = cfCategoryHitKey(keyword, channelName);
    if (!key) return;
    // An outer wrapper (Home's ytd-rich-item-renderer) holds the video's own
    // card, which is evaluated and counted by itself.
    if (card.querySelector(YT.VIDEO_CARDS)) return;
    const videoKey = cfCategoryVideoKey(YT.getVideoId(card), title);
    if (!videoKey) return;
    const countedKey = key + '\n' + videoKey;
    if (countedCategoryVideos.has(countedKey)) return;
    if (countedCategoryVideos.size >= 5000) countedCategoryVideos.clear();
    countedCategoryVideos.add(countedKey);
    let videoKeys = pendingCategoryHits.get(key);
    if (!videoKeys) {
      videoKeys = new Set();
      pendingCategoryHits.set(key, videoKeys);
    }
    videoKeys.add(videoKey);
    if (!categoryHitFlushTimer) {
      // Flush slowly to coalesce; the data is for the NEXT page load mostly.
      categoryHitFlushTimer = setTimeout(flushCategoryHits, 2000);
    }
  }

  function flushCategoryHits() {
    categoryHitFlushTimer = null;
    if (pendingCategoryHits.size === 0) return;
    const batch = Array.from(pendingCategoryHits, ([key, videoKeys]) => [key, [...videoKeys]]);
    pendingCategoryHits.clear();
    sendMsg({ action: 'batchIncrementCategoryHits', hits: batch });
  }

  // ── SPA Navigation ────────────────────────────────────────────────────

  async function onNavigate() {
    const state = await sendMsg({ action: 'getFullState' });

    // Reset page-scoped overrides on every navigation. The user said "solo
    // su questa pagina" — pause and peeks must NOT leak to the next page.
    if (isPagePaused) {
      isPagePaused = false;
      document.body.classList.remove('cleanfeed-paused');
    }
    if (peekedChannels.size > 0) {
      peekedChannels.clear();
    }
    // Stale per-page caches that should NOT survive SPA navigation
    lastClickedVideoCard = null;
    // The blocked-channel banner and hidden content belong to the page we
    // just left; filterPage() below re-applies them if this page is blocked.
    clearBlockedChannelPage();
    // Bound loggedVideos to prevent unbounded growth across long sessions
    if (loggedVideos.size > 500) loggedVideos.clear();

    applyState(state);

    // Clear curiosity window when leaving search results
    if (!window.location.pathname.startsWith('/results')) {
      activeJustNowQueries.clear();
      lastKnownSearchQuery = '';
      lastPromptedQuery = '';
      removeCuriosityPrompt();
    }

    filterPage();
    injectChannelPageButton();
    injectPauseToggle();
    injectSubscriptionsToggle();
    applyRelevantSectionVisibility();
    interceptSearch();
  }

  // Undoes the blocked-channel page state set by hideBlockedContent(): shows
  // the hidden page content again and removes the banner.
  function clearBlockedChannelPage() {
    document.querySelectorAll('[data-cf-blocked]').forEach((el) => {
      delete el.dataset.cfBlocked;
      el.classList.remove('cleanfeed-hidden');
    });
    const blockedMsg = document.getElementById('cf-channel-blocked-msg');
    if (blockedMsg) blockedMsg.remove();
  }

  // Clears a blocked-channel page state that does not match the page on screen.
  // YouTube fires yt-navigate-finish BEFORE it swaps the visible page, so the
  // pass right after onNavigate() can block the page being left; the next pass
  // (mutation observer) undoes it here. `content` / `channelKey`: the content
  // element of the blocked channel page on screen and its lowercase name (null
  // and '' when the page on screen is not a blocked channel page). The state is
  // consistent when the only marked element is `content` (marked for
  // `channelKey`) and the banner exists exactly when something is marked.
  // Makes no DOM change when the state is already consistent.
  function clearStaleBlockedChannelPage(content, channelKey) {
    const marked = Array.from(document.querySelectorAll('[data-cf-blocked]'));
    const hasBanner = !!document.getElementById('cf-channel-blocked-msg');
    const stale = marked.some(el => el !== content || el.dataset.cfBlocked !== channelKey) ||
                  (marked.length > 0) !== hasBanner;
    if (stale) clearBlockedChannelPage();
  }

  // ── Storage Change Listener ───────────────────────────────────────────

  async function onStorageChanged(changes, areaName) {
    // PERF: skip when ONLY stats changed. logHidden flushes batched stats every
    // second; without this skip, every batch triggered a full unhide/refilter
    // cycle (state fetch + DOM walk + prehide rebuild) — measured ~150ms thrash
    // per flush on a populated homepage. Stat counters are display-only on the
    // popup; they don't affect filtering decisions.
    const keys = Object.keys(changes || {});
    const statsOnly = keys.length === 1 && keys[0] === 'stats';
    if (statsOnly) return;
    // Also skip pure auto-tag bookkeeping (hit counts, counted videos): no
    // functional state change unless a NEW tag was added, which we'll catch on
    // the categoryTags key
    const hitsOnly = keys.length > 0 && keys.every(k => k === 'categoryHits' || k === 'categoryHitVideos');
    if (hitsOnly) return;

    const wasStrictLocked = isStrictLocked();
    const state = await sendMsg({ action: 'getFullState' });
    applyState(state);

    // Remove ALL CleanFeed hiding — then re-evaluate everything fresh
    document.querySelectorAll('.cleanfeed-hidden').forEach((el) => {
      el.classList.remove('cleanfeed-hidden');
    });
    document.querySelectorAll('[data-cf-checked]').forEach((el) => {
      delete el.dataset.cfChecked;
    });
    document.querySelectorAll('[data-cf-blocked]').forEach((el) => {
      delete el.dataset.cfBlocked;
    });
    // Remove channel blocked message if present
    const blockedMsg = document.getElementById('cf-channel-blocked-msg');
    if (blockedMsg) blockedMsg.remove();

    filterPage();

    // Strict mode turned on or off: lock or unlock the on-page controls now
    if (isStrictLocked() !== wasStrictLocked) {
      injectPauseToggle();
      injectChannelPageButton();
      injectSubscriptionsToggle();
    }
  }

  // ── CSS Pre-Hiding for Blocked Channels ────────────────────────────

  let preHideStyleEl = null;

  function updateBlockedChannelPreHideStyles() {
    // Build CSS rules that hide video cards by @handle href BEFORE JS runs.
    // Uses style.sheet.insertRule() to bypass YouTube's Trusted Types CSP.
    if (!preHideStyleEl) {
      preHideStyleEl = document.createElement('style');
      preHideStyleEl.id = 'cleanfeed-prehide';
      document.head.appendChild(preHideStyleEl);
    }

    const sheet = preHideStyleEl.sheet;
    if (!sheet) return;

    // Clear existing rules
    while (sheet.cssRules.length > 0) {
      sheet.deleteRule(0);
    }

    // If filtering is disabled for this page (paused / Subscriptions), emit
    // no rules at all — the user wants to see everything here.
    if (isFilteringDisabledForPage()) return;

    // Insert a rule for each blocked handle (skipping peeked channels)
    for (const handle of blockedChannelHandles) {
      if (peekedChannels.has(handle)) continue;
      // handle is stored as "@something" (lowercase)
      // Use case-insensitive attribute selector (i flag) because YouTube
      // may use different casing (/@Trolden vs /@trolden)
      const href = '/' + handle; // becomes "/@something"
      const rule =
        'ytd-video-renderer:has(a[href="' + href + '" i]), ' +
        'ytd-rich-item-renderer:has(a[href="' + href + '" i]), ' +
        'ytd-grid-video-renderer:has(a[href="' + href + '" i]), ' +
        'ytd-compact-video-renderer:has(a[href="' + href + '" i]), ' +
        'ytd-reel-item-renderer:has(a[href="' + href + '" i]), ' +
        'ytd-shelf-renderer:has(a[href="' + href + '" i]), ' +
        'ytd-reel-shelf-renderer:has(a[href="' + href + '" i]), ' +
        'ytd-playlist-renderer:has(a[href="' + href + '" i]), ' +
        'yt-lockup-view-model:has(a[href="' + href + '" i]) ' +
        '{ display: none !important; }';
      try {
        sheet.insertRule(rule, sheet.cssRules.length);
      } catch (e) {
        // Some selectors might fail in older browsers — skip silently
      }
    }
  }

  // ── Filtering ─────────────────────────────────────────────────────────

  function filterPage() {
    // Update body class for skip pages (CSS handles the rest via :not())
    if (isFilteringDisabledForPage()) {
      // CSS shows everything; we still need to clean up any leftover .cleanfeed-hidden
      // from before navigation so it never reapplies stale state.
      document.querySelectorAll('.cleanfeed-hidden').forEach((el) => {
        el.classList.remove('cleanfeed-hidden');
      });
      document.querySelectorAll('[data-cf-checked]').forEach((el) => {
        delete el.dataset.cfChecked;
      });
      const blockedMsg = document.getElementById('cf-channel-blocked-msg');
      if (blockedMsg) blockedMsg.remove();
      syncShortsPlayback();
      return;
    }

    if (currentSettings.hideShorts) {
      document.body.classList.add('cleanfeed-hide-shorts');
      // Hide "Shorts" filter chip — YouTube removed the [title] attribute so
      // CSS :has([title="Shorts"]) no longer works; must match by text content.
      document.querySelectorAll('yt-chip-cloud-chip-renderer').forEach(chip => {
        if (chip.textContent.trim() === 'Shorts') {
          chip.style.display = 'none';
        }
      });
    } else {
      document.body.classList.remove('cleanfeed-hide-shorts');
      // Restore chip if setting turned off
      document.querySelectorAll('yt-chip-cloud-chip-renderer').forEach(chip => {
        if (chip.textContent.trim() === 'Shorts' && chip.style.display === 'none') {
          chip.style.display = '';
        }
      });
    }

    if (currentSettings.hideComments) {
      document.body.classList.add('cleanfeed-hide-comments');
    } else {
      document.body.classList.remove('cleanfeed-hide-comments');
    }
    hideBlockedContent();
    syncShortsPlayback();
    // Note: updateBlockedChannelPreHideStyles() runs in applyState() when
    // blocked lists change — no need to rebuild CSS rules on every filter pass.
  }

  // /shorts player: a hidden short would keep playing (with sound) behind the
  // empty space, so it is paused. YouTube then treats the player as paused by
  // the user and does not start the following shorts, so playback resumes once
  // the player shows a short that is not hidden, but only when CleanFeed was
  // the one that paused it.
  function syncShortsPlayback() {
    const reel = YT.getShortsPlayerReel();
    const video = reel && reel.querySelector('video');
    if (!video) return;
    if (reel.classList.contains('cleanfeed-hidden')) {
      if (!video.paused) {
        video.pause();
        reel.dataset.cfPausedVideo = 'true';
      }
    } else if (reel.dataset.cfPausedVideo) {
      delete reel.dataset.cfPausedVideo;
      video.play().catch(() => {});
    }
  }

  function hideBlockedContent() {
    // Nothing to filter — skip all DOM queries
    if (blockedChannelNames.size === 0 && blockedChannelHandles.size === 0 && blockedKeywords.length === 0) return;

    const cards = Array.from(document.querySelectorAll(YT.VIDEO_CARDS));
    // /shorts player: the short on screen is checked like a card. YouTube
    // reuses one renderer for every short, so it is checked again whenever the
    // title or channel it shows changes (the channel link loads later).
    const shortsReel = YT.getShortsPlayerReel();
    if (shortsReel) {
      const reelChannelLink = shortsReel.querySelector('a[href^="/@"]');
      const reelKey = (YT.getVideoTitle(shortsReel) || '') + '\n' +
        (reelChannelLink ? reelChannelLink.getAttribute('href') : '');
      if (shortsReel.dataset.cfReelKey !== reelKey) {
        shortsReel.dataset.cfReelKey = reelKey;
        shortsReel.classList.remove('cleanfeed-hidden');
        delete shortsReel.dataset.cfChecked;
      }
      cards.push(shortsReel);
    }
    let newCards = 0;

    for (const card of cards) {
      if (card.dataset.cfChecked) continue;
      card.dataset.cfChecked = 'true';
      newCards++;

      // Peek mode: this channel is exempted for this page view
      if (isCardPeeked(card)) continue;

      const channelName = YT.getChannelName(card);
      const channelLower = channelName ? channelName.toLowerCase() : '';

      // Channel blocking
      if (channelLower && blockedChannelNames.has(channelLower)) {
        card.classList.add('cleanfeed-hidden');
        logHidden(card, 'channel', channelName);
        continue;
      }

      // Keyword blocking (with synonym expansion — "crypto" also blocks "bitcoin" etc.)
      const title = YT.getVideoTitle(card) || '';
      const desc = YT.getVideoDescription(card);

      // Auto-tag: channel was already tagged for one of the blocked categories,
      // so block ALL their videos unless the title is a discussion-style exemption.
      const taggedCat = isChannelTaggedForBlocked(channelLower);
      if (taggedCat) {
        if (!isCategoryExempt(title, taggedCat) && !isWhitelisted(channelName, taggedCat)) {
          card.classList.add('cleanfeed-hidden');
          card.setAttribute('data-cf-reason', 'channel-tag:' + taggedCat);
          logHidden(card, 'channel-tag', taggedCat);
          continue;
        }
      }

      for (const kw of blockedKeywords) {
        const expandedTerms = getExpandedKeywords(kw.keyword);
        let matched = false;
        for (const term of expandedTerms) {
          if (matchesKeyword(title, term) || matchesKeyword(desc, term)) {
            matched = true;
            break;
          }
        }
        if (matched) {
          if (isWhitelisted(channelName, kw.keyword)) continue;
          // Interests (Just now / Today / Always) only exempt on search results page.
          // On homepage, watch page sidebar, etc., keyword blocking always takes priority.
          if (window.location.pathname === '/results' && matchesSavedInterest(title, desc)) continue;
          // Discussion-style exemption: "AI in gaming", "Storia di Nintendo", etc.
          if (isCategoryExempt(title, kw.keyword.toLowerCase())) continue;

          card.classList.add('cleanfeed-hidden');
          logHidden(card, 'keyword', kw.keyword);
          // Channel hit for future auto-tagging (topics only)
          if (channelName) queueCategoryHit(kw.keyword, channelName, card, title);
          break;
        }
      }
    }


    // Re-check previously processed cards — YouTube may recycle DOM elements
    // by swapping their data/content without removing them from the tree.
    // In that case data-cf-checked is still set but the card now shows a
    // different (possibly blocked) channel.
    for (const card of cards) {
      if (!card.dataset.cfChecked) continue; // just processed above
      // Skip cards already hidden
      if (card.classList.contains('cleanfeed-hidden')) continue;
      const channelName = YT.getChannelName(card);
      const channelLower = channelName ? channelName.toLowerCase() : '';
      if (channelLower && blockedChannelNames.has(channelLower)) {
        if (peekedChannels.has(channelLower)) continue;
        card.classList.add('cleanfeed-hidden');
        logHidden(card, 'channel', channelName);
      }
    }

    // Skip heavy channel/shelf/handle passes when no channels are blocked
    if (blockedChannelNames.size === 0 && blockedChannelHandles.size === 0) {
      // Still need to check channel page and subscription exceptions below
    } else {

    // Hide blocked channels EVERYWHERE — search results, Shorts, shelves, etc.
    // Channel result cards in search — aggressive matching across all text/link content
    document.querySelectorAll('ytd-channel-renderer').forEach((el) => {
      if (el.dataset.cfChecked) return;
      el.dataset.cfChecked = 'true';
      // Try multiple strategies to extract the channel name
      let name = null;
      // 1. Any link pointing to a channel handle
      const handleLink = el.querySelector('a[href^="/@"]');
      if (handleLink) {
        name = handleLink.textContent.trim().toLowerCase();
        // If the link text is empty, extract from href
        if (!name) {
          const href = handleLink.getAttribute('href') || '';
          const match = href.match(/\/@(.+)/);
          if (match) name = decodeURIComponent(match[1]).toLowerCase();
        }
      }
      // 2. Broader selectors for the channel title area
      if (!name) {
        const titleSelectors = [
          '#channel-title', '#text a', '#text', 'yt-formatted-string#text',
          'yt-formatted-string', '#channel-title-text', '.channel-name',
          '#info #text-container yt-formatted-string'
        ];
        for (const sel of titleSelectors) {
          const titleEl = el.querySelector(sel);
          if (titleEl) {
            const t = titleEl.textContent.trim().toLowerCase();
            if (t && blockedChannelNames.has(t)) { name = t; break; }
          }
        }
      }
      if (name && blockedChannelNames.has(name) && !peekedChannels.has(name)) {
        el.classList.add('cleanfeed-hidden');
      }
    });

    // Hide shelf renderers whose title contains a blocked channel name
    // (e.g., "Le novità di marta daddato", "Ultimi Short di marta daddato",
    //  "Latest from marta daddato", etc.)
    const shelfSelectors = 'ytd-shelf-renderer, ytd-reel-shelf-renderer, ytd-horizontal-card-list-renderer';
    document.querySelectorAll(shelfSelectors).forEach((shelf) => {
      if (shelf.dataset.cfChecked) return;
      shelf.dataset.cfChecked = 'true';
      // Get the shelf title text
      const titleEl = shelf.querySelector(
        '#title, #title-text, .title, h2 yt-formatted-string, ' +
        'yt-formatted-string.style-scope.ytd-shelf-renderer, ' +
        'span#title-text, #title-container yt-formatted-string'
      );
      const titleText = titleEl?.textContent?.trim()?.toLowerCase() || '';
      if (!titleText) return;
      for (const blocked of blockedChannelNames) {
        if (titleText.includes(blocked)) {
          if (peekedChannels.has(blocked)) break;
          shelf.classList.add('cleanfeed-hidden');
          break;
        }
      }
    });

    // Also hide any remaining video cards in search whose channel link matches
    // but wasn't caught by the main VIDEO_CARDS loop (e.g., different renderer types)
    if (window.location.pathname === '/results') {
      document.querySelectorAll('ytd-video-renderer, ytd-reel-item-renderer').forEach((el) => {
        if (el.classList.contains('cleanfeed-hidden')) return;
        if (el.dataset.cfChecked) return;
        // Check all channel-handle links inside
        const links = el.querySelectorAll('a[href^="/@"]');
        for (const link of links) {
          const text = link.textContent.trim().toLowerCase();
          if (text && blockedChannelNames.has(text) && !peekedChannels.has(text)) {
            el.classList.add('cleanfeed-hidden');
            el.dataset.cfChecked = 'true';
            break;
          }
        }
      });
    }

    // Aggressive final sweep: match blocked channels by @handle in href values.
    // This catches channels regardless of how the display name is rendered
    // (different casing, unicode, localized names, etc.)
    if (blockedChannelHandles.size > 0) {
      const handleLinks = document.querySelectorAll('a[href^="/@"]');
      for (const link of handleLinks) {
        const href = (link.getAttribute('href') || '').toLowerCase();
        // Extract the handle portion: /@ followed by the handle (ignore trailing path)
        const handleMatch = href.match(/^\/(@[^\/\?]+)/);
        if (!handleMatch) continue;
        const handle = handleMatch[1];
        if (!blockedChannelHandles.has(handle)) continue;
        if (peekedChannels.has(handle)) continue;

        // Walk up to the nearest renderer-level container and hide it
        const container = link.closest(
          'ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ' +
          'ytd-compact-video-renderer, ytd-reel-item-renderer, ytd-channel-renderer, ' +
          YT.SHORTS_CARDS + ', ytd-reel-video-renderer, ' +
          'ytd-shelf-renderer, ytd-reel-shelf-renderer, ytd-horizontal-card-list-renderer, ' +
          'ytd-playlist-renderer'
        );
        if (container && !container.classList.contains('cleanfeed-hidden')) {
          container.classList.add('cleanfeed-hidden');
        }
      }
    }

    } // end: blockedChannelNames/Handles gate

    // A search-result Shorts shelf whose items are all hidden would show only
    // its header: hide it too, and show it again once one of its items is visible.
    for (const shelf of document.querySelectorAll('grid-shelf-view-model')) {
      const items = shelf.querySelectorAll(YT.SHORTS_CARDS);
      if (items.length === 0) continue;
      const allHidden = Array.from(items).every(item => item.classList.contains('cleanfeed-hidden'));
      shelf.classList.toggle('cleanfeed-hidden', allHidden);
    }

    // If we're on a blocked channel's page, hide ALL their content
    let onBlockedChannelPage = false;
    if (YT.isChannelPage()) {
      const pageChannel = YT.getPageChannelName();
      const pageChannelLower = pageChannel ? pageChannel.toLowerCase() : '';
      const pageHandle = YT.getPageChannelId();
      const pageHandleLower = pageHandle ? (pageHandle.startsWith('@') ? pageHandle.toLowerCase() : '@' + pageHandle.toLowerCase()) : '';

      // Skip the block if user has peeked this channel
      const peeked = (pageChannelLower && peekedChannels.has(pageChannelLower)) ||
                     (pageHandleLower && peekedChannels.has(pageHandleLower));

      if (pageChannel && blockedChannelNames.has(pageChannelLower) && !peeked) {
        onBlockedChannelPage = true;
        // Hide the entire page content section. Only the visible page: Home's
        // and other cached pages' grids stay in the DOM, hidden.
        const content = YT.getActivePageRoot().querySelector('ytd-two-column-browse-results-renderer, #contents.ytd-section-list-renderer, ytd-browse #content');
        clearStaleBlockedChannelPage(content, pageChannelLower);
        if (content && !content.dataset.cfBlocked) {
          content.dataset.cfBlocked = pageChannelLower;
          content.classList.add('cleanfeed-hidden');
          // Show a message that this channel is blocked, with a peek button
          if (!document.getElementById('cf-channel-blocked-msg')) {
            const peekLocked = isStrictLocked();
            const peekBtn = cfEl('button', {
              className: 'cleanfeed-btn cleanfeed-btn-primary' + (peekLocked ? ' cleanfeed-strict-locked' : ''),
              style: 'margin-left:12px;',
              textContent: msg('showChannelJustNow') !== 'showChannelJustNow'
                ? msg('showChannelJustNow') : 'Show just now',
              ...(peekLocked ? strictLockAttrs() : {}),
              onClick: peekLocked ? showStrictLockedToast : () => {
                setChannelPeek(pageChannel, pageHandle, true);
              }
            });
            const msg_el = cfEl('div', {
              id: 'cf-channel-blocked-msg',
              className: 'cleanfeed-toast',
              style: 'position:relative;margin:40px auto;max-width:560px;bottom:auto;left:auto;transform:none;animation:none;justify-content:center;'
            }, [
              cfLogo(),
              cfEl('span', { textContent: msg('channelBlockedByCleanFeed') !== 'channelBlockedByCleanFeed'
                ? msg('channelBlockedByCleanFeed') : 'This channel is blocked by CleanFeed' }),
              peekBtn
            ]);
            // Inside the blocked page, where its content was: YouTube hides
            // the banner together with the page when the user navigates away.
            content.before(msg_el);
          }
        }
      }
    }
    // Not on a blocked channel's page (any more): undo a leftover block
    if (!onBlockedChannelPage) clearStaleBlockedChannelPage(null, '');

    // Extra sweep for sidebar: YouTube 2025-2026 sidebar uses yt-lockup-metadata-view-model
    // which is NOT in VIDEO_CARDS. Find ALL #video-title in the sidebar and process them.
    if (window.location.pathname === '/watch') {
      const sidebarTitles = document.querySelectorAll(
        '#secondary #video-title, ytd-watch-next-secondary-results-renderer #video-title'
      );
      for (const titleEl of sidebarTitles) {
        // Walk up to find the outermost individual video container.
        // Stop at list boundaries (#items, #contents, #secondary).
        let container = titleEl;
        let bestContainer = titleEl.parentElement;
        for (let i = 0; i < 8 && container; i++) {
          container = container.parentElement;
          if (!container) break;
          if (container.id === 'items' || container.id === 'contents' ||
              container.id === 'secondary' ||
              container.tagName === 'YTD-WATCH-NEXT-SECONDARY-RESULTS-RENDERER') break;
          bestContainer = container;
        }
        container = bestContainer;

        if (!container || container.dataset.cfChecked) continue;
        if (container.classList.contains('cleanfeed-hidden')) continue;

        // Peek mode: this channel is exempted for this page view
        if (isCardPeeked(container)) { container.dataset.cfChecked = 'sidebar'; continue; }

        container.dataset.cfChecked = 'sidebar';

        const title = titleEl.textContent?.trim() || '';

        // Channel blocking: try multiple strategies
        // Strategy 1: standard getChannelName (works if links exist)
        const channelName = YT.getChannelName(container);
        const channelLower = channelName ? channelName.toLowerCase() : '';
        if (channelLower && blockedChannelNames.has(channelLower)) {
          if (peekedChannels.has(channelLower)) continue;
          container.classList.add('cleanfeed-hidden');
          continue;
        }

        // Strategy 2: check handle links
        const channelLink = container.querySelector('a[href^="/@"]');
        const channelHref = (channelLink?.getAttribute('href') || '').toLowerCase();
        const handleMatch = channelHref.match(/^\/(@[^\/\?]+)/);
        const handle = handleMatch ? handleMatch[1] : '';
        if (handle && blockedChannelHandles.has(handle)) {
          if (peekedChannels.has(handle)) continue;
          container.classList.add('cleanfeed-hidden');
          continue;
        }

        // Strategy 3: brute force — check if ALL text in the container contains
        // any blocked channel name. The sidebar renders channel names as plain text
        // without links, so we search the full text content.
        const allText = container.textContent.toLowerCase();
        let channelBlocked = false;
        for (const blocked of blockedChannelNames) {
          if (allText.includes(blocked)) {
            if (peekedChannels.has(blocked)) { channelBlocked = false; break; }
            container.classList.add('cleanfeed-hidden');
            channelBlocked = true;
            break;
          }
        }
        if (channelBlocked) continue;

        // Auto-tag check for sidebar cards
        const taggedCat2 = isChannelTaggedForBlocked(channelLower);
        if (taggedCat2 && !isCategoryExempt(title, taggedCat2)) {
          container.classList.add('cleanfeed-hidden');
          continue;
        }

        // Keyword blocking
        for (const kw of blockedKeywords) {
          if (isCategoryExempt(title, kw.keyword.toLowerCase())) continue;
          const expandedTerms = getExpandedKeywords(kw.keyword);
          for (const term of expandedTerms) {
            if (matchesKeyword(title, term)) {
              container.classList.add('cleanfeed-hidden');
              if (channelName) queueCategoryHit(kw.keyword, channelName, container, title);
              break;
            }
          }
          if (container.classList.contains('cleanfeed-hidden')) break;
        }
      }
    }

    // Inject quick-add hover buttons on all visible video cards
    injectQuickAddButtonsAll();

    // Subscription Exception: throttled — runs at most once every 3 seconds
    // to avoid scanning the entire sidebar + all hidden cards on every filter pass.
    scheduleSubscriptionCheck();
  }

  // keyword + channel pairs already shown in the subscriptions toast. Kept for
  // the whole tab session (never cleared on SPA navigation), so the toast
  // never repeats for the same pair.
  const promptedSubscriptionExceptions = new Set();
  let subCheckTimer = null;

  function subscriptionPromptKey(keyword, channelName) {
    return String(keyword).toLowerCase() + '\n' + String(channelName).toLowerCase();
  }

  function scheduleSubscriptionCheck() {
    if (subCheckTimer) return; // already scheduled
    subCheckTimer = setTimeout(() => {
      subCheckTimer = null;
      checkSubscriptionExceptions();
    }, 3000);
  }

  function checkSubscriptionExceptions() {
    if (!isPro && blockedKeywords.length === 0) return;

    // Get subscribed channel names from the sidebar
    const subscribedNames = new Set();
    const sidebarEntries = document.querySelectorAll(
      // 2025 YouTube sidebar selectors
      'ytd-guide-section-renderer ytd-guide-entry-renderer a[href^="/@"], ' +
      '#sections ytd-guide-entry-renderer a[href^="/@"], ' +
      'ytd-guide-subscriptions-section-renderer ytd-guide-entry-renderer a[href^="/@"], ' +
      // Mini guide (collapsed sidebar)
      'ytd-mini-guide-entry-renderer a[href^="/@"], ' +
      // Generic fallback
      '#guide-content a[href^="/@"]'
    );
    for (const entry of sidebarEntries) {
      const name = entry.querySelector('.title')?.textContent?.trim() ||
                   entry.querySelector('yt-formatted-string')?.textContent?.trim() ||
                   entry.getAttribute('title') ||
                   entry.textContent?.trim();
      if (name) subscribedNames.add(name.toLowerCase());
    }

    if (subscribedNames.size === 0) return;

    // Only the visible page: cached pages keep their hidden cards in the DOM
    const pageRoot = YT.getActivePageRoot();
    // For each keyword, find subscribed channels that were hidden
    for (const kw of blockedKeywords) {
      const keyword = kw.keyword;

      const affectedChannels = [];
      const cards = pageRoot.querySelectorAll(YT.VIDEO_CARDS + '.cleanfeed-hidden');
      for (const card of cards) {
        const channelName = YT.getChannelName(card);
        if (!channelName) continue;
        if (!subscribedNames.has(channelName.toLowerCase())) continue;
        if (isWhitelisted(channelName, keyword)) continue;
        if (promptedSubscriptionExceptions.has(subscriptionPromptKey(keyword, channelName))) continue;

        // This card was hidden by this keyword and the channel is subscribed
        const title = YT.getVideoTitle(card) || '';
        const desc = YT.getVideoDescription(card);
        const expandedTerms = getExpandedKeywords(keyword);
        if (expandedTerms.some(term => matchesKeyword(title, term) || matchesKeyword(desc, term))) {
          if (!affectedChannels.some(c => c.name.toLowerCase() === channelName.toLowerCase())) {
            affectedChannels.push({
              name: channelName,
              id: YT.getChannelId(card)
            });
          }
        }
      }

      if (affectedChannels.length > 0) {
        for (const ch of affectedChannels) {
          promptedSubscriptionExceptions.add(subscriptionPromptKey(keyword, ch.name));
        }
        showSubscriptionExceptionToast(affectedChannels, keyword);
        break; // Only show one toast at a time
      }
    }
  }

  function isWhitelisted(channelName, keyword) {
    if (!channelName) return false;
    const lower = channelName.toLowerCase();
    return whitelistedChannels.some(
      (wc) =>
        wc.name &&
        wc.name.toLowerCase() === lower &&
        (wc.exemptFrom === '*' || wc.exemptFrom === keyword)
    );
  }

  // ── Topic Detection Helpers ────────────────────────────────────────

  function detectTopicFromTitle(title) {
    if (!title) return null;
    // Match against ALL synonym categories (not just blocked ones).
    // If no category matches, return null — don't guess random words.
    // Previously the fallback picked the first word >= 4 chars, which
    // caused nonsense topics like "code" (from "Code Geass") or "survival".
    for (const [category, synonyms] of Object.entries(KEYWORD_SYNONYMS)) {
      if (matchesKeyword(title, category)) return category;
      for (const synonym of synonyms) {
        if (matchesKeyword(title, synonym)) return category;
      }
    }
    return null;
  }

  function matchesSavedInterest(title, desc) {
    // Interest Boundaries hidden (features.js): saved interests are kept in
    // storage but exempt nothing.
    if (!CF_FEATURES.interestBoundaries) return false;
    // Check in-memory "Just now" queries
    for (const q of activeJustNowQueries) {
      if (matchesKeyword(title, q) || matchesKeyword(desc, q)) return true;
    }
    // Check stored interests (Today / Always) — these persist across reloads
    for (const q of savedInterestQueries) {
      if (matchesKeyword(title, q) || matchesKeyword(desc, q)) return true;
    }
    return false;
  }

  // Batched logging — queue entries and flush once per second instead of
  // sending 2 IPC messages per hidden video (40+ calls during a busy filter pass).
  let logQueue = [];
  let logFlushTimer = null;

  function logHidden(card, type, value) {
    const title = YT.getVideoTitle(card) || '';
    const channel = YT.getChannelName(card) || '';
    const dedupKey = (title + '||' + channel).toLowerCase();
    if (loggedVideos.has(dedupKey)) return;
    loggedVideos.add(dedupKey);

    // DEBUG: helps the user understand why a specific video was hidden.
    // Visible in DevTools console (F12). Single line per video. The dedup
    // ensures we don't spam the console on re-filter passes.
    console.log('CleanFeed: hid "' + title + '" — reason: ' + type + ':' + value + ' (channel: ' + channel + ')');

    logQueue.push({ title, channel, reason: type + ':' + value });

    if (!logFlushTimer) {
      logFlushTimer = setTimeout(flushLogQueue, 1000);
    }
  }

  function flushLogQueue() {
    logFlushTimer = null;
    if (logQueue.length === 0) return;
    const batch = logQueue.splice(0);
    // Single stat increment for the whole batch
    sendMsg({ action: 'incrementStat', stat: 'videosHidden', amount: batch.length });
    // Send individual logs (fire-and-forget, but now spaced from filtering)
    for (const entry of batch) {
      sendMsg({ action: 'logHiddenVideo', title: entry.title, channel: entry.channel, reason: entry.reason });
    }
  }

  // ── Find Card from Active Menu ─────────────────────────────────────

  // When a three-dot menu is open, find which video it belongs to by
  // checking all ytd-menu-renderer elements for one with active/open state,
  // then walking up to find video info (title + channel).
  // ── MutationObserver ──────────────────────────────────────────────────

  function startObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      // Immediately re-apply CSS-only toggles (zero cost, prevents flicker).
      // This runs on every mutation but classList.add is a no-op if already set.
      if (currentSettings.hideShorts) {
        document.body.classList.add('cleanfeed-hide-shorts');
      }

      // Re-apply the "Più pertinenti" hide on subs feed — the section often
      // loads after the chronological grid as the user scrolls. Also ensure
      // our toggle button is present (YouTube can re-render the header).
      if (window.location.pathname.startsWith('/feed/subscriptions')) {
        applyRelevantSectionVisibility();
        if (!document.getElementById('cleanfeed-subs-toggle')) {
          injectSubscriptionsToggle();
        }
      } else {
        // Re-inject pause switch into masthead if YouTube re-rendered the header,
        // or if init ran before the masthead existed in the DOM.
        if (!document.getElementById('cleanfeed-pause-toggle')) {
          injectPauseToggle();
        }
        // Re-inject channel buttons if the user is on a channel/watch page
        // and our wrapper is missing (tabs row may have loaded after init).
        if ((YT.isChannelPage() || window.location.pathname === '/watch') &&
            !document.querySelector('.cleanfeed-channel-tabs-buttons') &&
            !document.querySelector('.cleanfeed-channel-block-btn')) {
          injectChannelPageButton();
        }
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        filterPage();
        injectQuickAddButtonsAll();
      }, 300);
    });

    // Scope to the content area — avoids firing on navbar, sidebar, popups, etc.
    const target = document.querySelector('ytd-page-manager') ||
                   document.querySelector('#content') ||
                   document.body;

    observer.observe(target, {
      childList: true,
      subtree: true,
    });
  }

  // ── Menu Click Tracking (Capture Phase) ───────────────────────────────

  function trackMenuClicks() {
    document.addEventListener(
      'click',
      (e) => {
        const target = e.target;
        const menuTrigger = target.closest(
          'button, yt-icon-button, ytd-menu-renderer, yt-button-shape'
        );
        if (!menuTrigger) return;

        // Set on EVERY menu-button click: a menu opened outside any card (e.g.
        // under the main video) must not inherit an earlier card's channel.
        lastClickedVideoCard = menuTrigger.closest(YT.VIDEO_CARDS);
        lastMenuClickAt = Date.now();
        lastMenuClickToken = lastClickedVideoCard ? String(++menuClickSeq) : '';
      },
      true
    );
  }

  // ── Suggested Video Click Interception ─────────────────────────────

  let suggestedClickBlocked = false; // flag to block the click after mousedown intercepts

  function interceptSuggestedClicks() {
    // We need to intercept at BOTH mousedown and click:
    // - mousedown: show the prompt and set a flag
    // - click: preventDefault to stop the <a> tag from navigating
    // preventDefault on mousedown alone does NOT prevent link navigation.

    function shouldIntercept(e) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return null;
      if (e.target.closest('button, yt-icon-button, ytd-menu-renderer, yt-button-shape')) return null;

      const card = e.target.closest(YT.VIDEO_CARDS);
      if (!card) return null;
      if (document.getElementById('cleanfeed-suggested-prompt')) return null;

      // Same rules as hiding: no prompt on /results, where filtering is off
      // (pause, Subscriptions feed, schedule), for a peeked card, an exempt
      // title or a whitelisted channel. `category` is the blocked keyword.
      const category = cfSuggestedPromptKeyword({
        pathname: window.location.pathname,
        paused: isPagePaused,
        outsideSchedule: isOutsideSchedule(),
        peeked: isCardPeeked(card),
        title: YT.getVideoTitle(card),
        channelName: YT.getChannelName(card),
        blockedKeywords,
        isWhitelisted
      });
      if (!category) return null;

      const link = card.querySelector('a[href*="/watch"], a[href*="/shorts"]');
      const href = link ? link.href : null;
      if (!href) return null;

      return { card, category, href };
    }

    document.addEventListener('mousedown', (e) => {
      const result = shouldIntercept(e);
      if (!result) return;

      // Set flag so the subsequent click event gets blocked
      suggestedClickBlocked = true;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      showSuggestedVideoPrompt(result.category, result.href, result.card);
    }, true);

    document.addEventListener('click', (e) => {
      // Block the click that follows our intercepted mousedown
      if (suggestedClickBlocked) {
        suggestedClickBlocked = false;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }

      // Also intercept clicks directly (some YouTube navigations use click only)
      const result = shouldIntercept(e);
      if (!result) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      showSuggestedVideoPrompt(result.category, result.href, result.card);
    }, true);
  }

  function showSuggestedVideoPrompt(category, href, card) {
    // Remove any existing prompt
    const existing = document.getElementById('cleanfeed-suggested-prompt');
    if (existing) existing.remove();

    // Build with raw createElement for Trusted Types CSP safety

    const logo = document.createElement('span');
    logo.className = 'cleanfeed-cf-logo';
    logo.textContent = 'CF';

    const titleStrong = document.createElement('strong');
    // `category` is a topic key (true_crime) or a plain blocked keyword; show the display name
    const categoryLabel = cfCategoryLabel(category);
    const aboutText = msg('suggestedVideoAbout', [categoryLabel]);
    titleStrong.textContent = (aboutText === 'suggestedVideoAbout') ? 'This video is about "' + categoryLabel + '"' : aboutText;
    const titleEl = document.createElement('div');
    titleEl.appendChild(titleStrong);

    const subtitleEl = document.createElement('span');
    const askText = msg('suggestedVideoAsk');
    subtitleEl.textContent = (askText === 'suggestedVideoAsk') ? 'Do you still want to watch it?' : askText;

    function removePrompt() {
      const el = document.getElementById('cleanfeed-suggested-prompt');
      if (el) el.remove();
    }

    const watchBtn = document.createElement('button');
    watchBtn.className = 'cleanfeed-btn cleanfeed-btn-primary';
    const watchText = msg('suggestedWatchNow');
    watchBtn.textContent = (watchText === 'suggestedWatchNow') ? 'Watch just now' : watchText;
    watchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      removePrompt();
      window.location.href = href;
    });

    const skipBtn = document.createElement('button');
    skipBtn.className = 'cleanfeed-btn cleanfeed-btn-secondary';
    const skipText = msg('suggestedSkip');
    skipBtn.textContent = (skipText === 'suggestedSkip') ? 'Skip' : skipText;
    skipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      removePrompt();
      card.classList.add('cleanfeed-hidden');
      logHidden(card, 'keyword', category);
    });

    const buttons = document.createElement('div');
    buttons.className = 'cleanfeed-toast-buttons';
    buttons.appendChild(watchBtn);
    buttons.appendChild(skipBtn);

    const bannerText = document.createElement('div');
    bannerText.className = 'cleanfeed-inline-banner-text';
    bannerText.appendChild(titleEl);
    bannerText.appendChild(subtitleEl);

    const content = document.createElement('div');
    content.className = 'cleanfeed-inline-banner-content';
    content.appendChild(logo);
    content.appendChild(bannerText);

    const promptEl = document.createElement('div');
    promptEl.className = 'cleanfeed-inline-banner';
    promptEl.id = 'cleanfeed-suggested-prompt';
    promptEl.appendChild(content);
    promptEl.appendChild(buttons);

    document.body.appendChild(promptEl);

    // Auto-dismiss after 8 seconds (same as Skip)
    setTimeout(() => {
      if (document.getElementById('cleanfeed-suggested-prompt')) {
        removePrompt();
      }
    }, 8000);
  }

  // ── Menu Popup Detection ──────────────────────────────────────────────

  function watchForMenuPopup() {
    // PERF: scope to the popup container instead of document.body. Previously
    // this fired on virtually every YouTube interaction (focus, hover, every
    // class change anywhere in the DOM tree), running getMenuPopup() each time.
    // ytd-popup-container is the only place menu popups actually appear.
    const target = document.querySelector('ytd-popup-container') || document.body;
    const observeOptions = {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'focused_', 'aria-hidden', 'class', 'opened', 'aria-expanded'],
    };

    const menuObserver = new MutationObserver(() => {
      const popup = YT.getMenuPopup();
      if (!popup) return;
      // Stop observing while we edit the popup: our own insertions/removals
      // must never re-trigger this callback (that loop froze the tab).
      menuObserver.disconnect();
      try {
        injectBlockOption(popup);
      } finally {
        menuObserver.observe(target, observeOptions);
      }
    });

    menuObserver.observe(target, observeOptions);
  }

  // ── Inject "Block Channel" into Video Menu ────────────────────────────

  function injectBlockOption(popup) {
    // Every item we add carries the token of the click it was built for, so a
    // repeat call for the same click changes nothing, also for cards without a
    // channel name (topic item only). Items are added only to a popup opened
    // shortly after a click inside a card; stale ones are removed.
    const existing = popup.querySelectorAll('.cleanfeed-menu-item, .cleanfeed-menu-separator');
    const clickToken = lastClickedVideoCard ? lastMenuClickToken : '';
    const action = getMenuInjectionAction(
      Array.from(existing, el => el.dataset.cfMenuToken || ''),
      clickToken,
      Date.now() - lastMenuClickAt
    );
    if (action === 'keep' || action === 'none') return;
    existing.forEach(el => el.remove()); // 'replace' / 'clear': drop stale items
    if (action === 'clear') return;

    const listbox = YT.getMenuListbox(popup);
    if (!listbox) return;

    const items = YT.getMenuItems(listbox);
    if (!items || items.length === 0) return;

    if (items.length < 2) return;

    const videoCard = lastClickedVideoCard;
    const channelName = YT.getChannelName(videoCard);
    const channelId = YT.getChannelId(videoCard);
    const videoTitle = YT.getVideoTitle(videoCard);
    const detectedCategory = detectTopicFromTitle(videoTitle);

    // Find "don't recommend" item for insertion point
    let insertAfter = null;
    for (const item of items) {
      const text = (item.textContent || '').toLowerCase();
      if (
        text.includes("don't recommend") ||
        text.includes('non consigliare')
      ) {
        insertAfter = item;
        break;
      }
    }

    // Insert point reference
    let lastInserted = insertAfter;

    function insertItem(element) {
      element.dataset.cfMenuToken = clickToken;
      if (lastInserted && lastInserted.nextSibling) {
        listbox.insertBefore(element, lastInserted.nextSibling);
      } else {
        listbox.appendChild(element);
      }
      lastInserted = element;
    }

    // Separator
    insertItem(cfEl('div', { className: 'cleanfeed-menu-separator' }));

    // Block channel item (only if channel name is available)
    if (channelName) {
      insertItem(cfEl(
        'div',
        {
          className: 'cleanfeed-menu-item',
          role: 'menuitem',
          tabindex: '0',
          'data-cf-channel': channelName,
          onClick: () => handleBlockClick(channelName, channelId),
        },
        [
          cfLogo(),
          cfEl('span', { textContent: msg('blockChannelPermanently') }),
        ]
      ));
    }

    // "Not interested in this topic" item — always shown
    insertItem(cfEl('div', { className: 'cleanfeed-menu-separator' }));
    insertItem(cfEl(
      'div',
      {
        className: 'cleanfeed-menu-item cleanfeed-menu-item-topic',
        role: 'menuitem',
        tabindex: '0',
        onClick: () => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
          showTopicBlockMenu(videoCard, videoTitle, detectedCategory);
        },
      },
      [
        cfLogo(),
        cfEl('span', { textContent: msg('notInterestedInTopic') }),
      ]
    ));
  }

  // ── Handle Block Click ────────────────────────────────────────────────

  async function handleBlockClick(name, id) {
    const result = await sendMsg({ action: 'blockChannel', channelName: name, channelId: id });

    // Close YouTube menu (if open)
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        keyCode: 27,
        bubbles: true,
      })
    );

    if (result && result.reason === 'already_blocked') {
      showToast('"' + name + '" is already blocked.');
      return;
    }

    showToast(msg('blockedToast', [name]));

    blockedChannelNames.add(name.toLowerCase());
    // Keep handles set in sync so the pre-hide CSS rule rebuild catches this
    // channel by /@ href immediately (otherwise cards by handle remained
    // visible until the next applyState cycle).
    if (id) {
      const handleLower = id.startsWith('@') ? id.toLowerCase() : '@' + id.toLowerCase();
      blockedChannelHandles.add(handleLower);
      updateBlockedChannelPreHideStyles();
    }

    // Remove the block button if we're on the watch/channel page
    const blockBtn = document.querySelector('.cleanfeed-channel-block-btn');
    if (blockBtn) blockBtn.remove();

    // Clear processed flags and re-filter
    document.querySelectorAll('[data-cf-checked]').forEach((el) => {
      delete el.dataset.cfChecked;
    });
    filterPage();

    // If on a channel page of the blocked channel, go back to homepage
    if (YT.isChannelPage()) {
      const pageChannel = YT.getPageChannelName();
      if (pageChannel && pageChannel.toLowerCase() === name.toLowerCase()) {
        setTimeout(() => { window.location.href = 'https://www.youtube.com'; }, 1500);
        return;
      }
    }

    // If on watch page of blocked channel, go back to homepage
    if (window.location.pathname === '/watch') {
      const watchChannel = document.querySelector('ytd-video-owner-renderer ytd-channel-name yt-formatted-string a');
      const watchName = watchChannel?.textContent?.trim();
      if (watchName && watchName.toLowerCase() === name.toLowerCase()) {
        setTimeout(() => { window.location.href = 'https://www.youtube.com'; }, 1500);
        return;
      }
    }

    // If on watch page, hide sidebar videos from this channel immediately.
    // Covers BOTH old layout (ytd-compact-video-renderer) AND new 2025 layout.
    if (window.location.pathname === '/watch') {
      // Old layout
      document.querySelectorAll('ytd-compact-video-renderer').forEach((card) => {
        const ch = YT.getChannelName(card);
        if (ch && ch.toLowerCase() === name.toLowerCase()) {
          card.classList.add('cleanfeed-hidden');
        }
      });

      // New layout: find by channel name in sidebar text
      document.querySelectorAll('#secondary #video-title, ytd-watch-next-secondary-results-renderer #video-title').forEach((titleEl) => {
        let container = titleEl;
        let bestContainer = titleEl.parentElement;
        for (let i = 0; i < 8 && container; i++) {
          container = container.parentElement;
          if (!container) break;
          if (container.id === 'items' || container.id === 'contents' ||
              container.id === 'secondary') break;
          bestContainer = container;
        }
        const ch = YT.getChannelName(bestContainer);
        if (ch && ch.toLowerCase() === name.toLowerCase()) {
          bestContainer.classList.add('cleanfeed-hidden');
        }
      });

      // Also hide the specific clicked card's full container
      if (lastClickedVideoCard) {
        let hideTarget = lastClickedVideoCard;
        let el = hideTarget;
        for (let i = 0; i < 6 && el; i++) {
          if (el.parentElement && (el.parentElement.id === 'items' || el.parentElement.id === 'contents' ||
              el.parentElement.id === 'secondary' || el.parentElement.tagName === 'YTD-WATCH-NEXT-SECONDARY-RESULTS-RENDERER')) {
            hideTarget = el;
            break;
          }
          el = el.parentElement;
        }
        hideTarget.classList.add('cleanfeed-hidden');
      }
    }
  }

  // ── Handle Topic Block Click ──────────────────────────────────────────

  function showTopicBlockMenu(card, title, detectedCategory) {
    // Remove any existing topic menu
    const existing = document.getElementById('cleanfeed-topic-menu');
    if (existing) existing.remove();

    function removeMenu() {
      const el = document.getElementById('cleanfeed-topic-menu');
      if (el) el.remove();
    }

    async function blockKeyword(keyword) {
      removeMenu();
      // A topic key (true_crime) is shown by its display name; other keywords as typed
      const shown = cfCategoryLabel(keyword);
      const result = await sendMsg({ action: 'addKeyword', keyword });
      if (result && result.reason === 'free_limit') {
        showToast(msg('keywordLimitToast'));
        sendMsg({ action: 'openPaymentPage' });
        return;
      }
      if (result && result.reason === 'already_exists') {
        showToast(msg('keywordAlreadyBlocked', [shown]) !== 'keywordAlreadyBlocked'
          ? msg('keywordAlreadyBlocked', [shown])
          : '"' + shown + '" is already blocked.');
        return;
      }
      showToast(msg('keywordBlockedToast', [shown]) !== 'keywordBlockedToast'
        ? msg('keywordBlockedToast', [shown])
        : 'Blocked keyword: "' + shown + '"');
      // Hide the full video container (walk up to find it for sidebar cards)
      let hideTarget = card;
      if (!hideTarget.matches || !hideTarget.matches(YT.VIDEO_CARDS)) {
        let el = card;
        for (let i = 0; i < 6 && el; i++) {
          if (el.parentElement && (el.parentElement.id === 'items' || el.parentElement.id === 'contents' ||
              el.parentElement.id === 'secondary' || el.parentElement.tagName === 'YTD-WATCH-NEXT-SECONDARY-RESULTS-RENDERER')) {
            hideTarget = el;
            break;
          }
          el = el.parentElement;
        }
      }
      hideTarget.classList.add('cleanfeed-hidden');
      logHidden(card, 'keyword', keyword);
      blockedKeywords.push({ keyword, addedAt: Date.now() });
      document.querySelectorAll('[data-cf-checked]').forEach((el) => { delete el.dataset.cfChecked; });
      filterPage();
    }

    // --- Header ---
    const logo = document.createElement('span');
    logo.className = 'cleanfeed-cf-logo';
    logo.textContent = 'CF';

    const titleEl = document.createElement('strong');
    titleEl.textContent = msg('notInterestedInTopic');

    const videoTitle = document.createElement('span');
    videoTitle.style.cssText = 'font-size:12px;color:var(--cf-text-secondary);display:block;margin-top:2px;';
    videoTitle.textContent = title ? '"' + title.substring(0, 60) + (title.length > 60 ? '...' : '') + '"' : '';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'cleanfeed-inline-banner-text';
    titleWrap.appendChild(titleEl);
    titleWrap.appendChild(videoTitle);

    // Close button (X)
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;font-size:18px;color:var(--cf-text-muted);cursor:pointer;padding:0 4px;flex-shrink:0;line-height:1;';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeMenu(); });

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;width:100%;';
    const contentWrap = document.createElement('div');
    contentWrap.className = 'cleanfeed-inline-banner-content';
    contentWrap.appendChild(logo);
    contentWrap.appendChild(titleWrap);
    headerRow.appendChild(contentWrap);
    headerRow.appendChild(closeBtn);

    // --- Options ---
    const options = document.createElement('div');
    options.style.cssText = 'display:flex;flex-direction:column;gap:8px;width:100%;margin-top:12px;';

    // Option 1: Block detected category (if found)
    if (detectedCategory) {
      const catLabel = cfCategoryLabel(detectedCategory);

      const catOption = document.createElement('div');
      catOption.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

      const catBtn = document.createElement('button');
      catBtn.className = 'cleanfeed-btn cleanfeed-btn-danger';
      catBtn.style.cssText = 'width:100%;text-align:left;padding:10px 14px;font-size:14px;';
      catBtn.textContent = msg('blockEntireCategory', [catLabel]) !== 'blockEntireCategory'
        ? msg('blockEntireCategory', [catLabel])
        : 'Block entire category: ' + catLabel;
      catBtn.addEventListener('click', (e) => { e.stopPropagation(); blockKeyword(detectedCategory); });

      const catDesc = document.createElement('span');
      catDesc.style.cssText = 'font-size:11px;color:var(--cf-text-muted);padding:0 4px;';
      catDesc.textContent = msg('blockCategoryDesc') !== 'blockCategoryDesc'
        ? msg('blockCategoryDesc')
        : 'Hides all videos related to ' + catLabel + ' across YouTube';

      catOption.appendChild(catBtn);
      catOption.appendChild(catDesc);
      options.appendChild(catOption);
    }

    // Option 2: Custom keyword input
    const kwOption = document.createElement('div');
    kwOption.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

    const kwLabel = document.createElement('span');
    kwLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--cf-text-secondary);';
    kwLabel.textContent = msg('blockSpecificKeyword') !== 'blockSpecificKeyword'
      ? msg('blockSpecificKeyword')
      : 'Or block a specific keyword:';

    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;gap:6px;align-items:center;';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = msg('typeKeywordPlaceholder') !== 'typeKeywordPlaceholder'
      ? msg('typeKeywordPlaceholder')
      : 'e.g. starcraft, uncharted...';
    input.style.cssText = 'flex:1;padding:8px 10px;border:1px solid var(--cf-border);border-radius:6px;font-size:13px;background:var(--cf-bg);color:var(--cf-text);outline:none;font-family:inherit;';

    // Category dropdown — assign keyword to a category instead of standalone
    const catSelect = document.createElement('select');
    catSelect.style.cssText = 'padding:7px 6px;border:1px solid var(--cf-border);border-radius:6px;font-size:12px;background:var(--cf-bg);color:var(--cf-text);font-family:inherit;cursor:pointer;';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = msg('addToCategory') !== 'addToCategory' ? msg('addToCategory') : 'Add to category:';
    catSelect.appendChild(noneOpt);
    // Only show blocked categories as options (all topics, display names, from content-dom.js)
    const blockedKwSet = new Set(blockedKeywords.map(k => k.keyword.toLowerCase()));
    for (const c of cfCategoryList()) {
      if (blockedKwSet.has(c.key)) {
        const opt = document.createElement('option');
        opt.value = c.key;
        opt.textContent = c.label;
        catSelect.appendChild(opt);
      }
    }

    const inputBtn = document.createElement('button');
    inputBtn.className = 'cleanfeed-btn cleanfeed-btn-primary';
    inputBtn.style.cssText = 'padding:8px 14px;';
    inputBtn.textContent = 'Block';

    async function doBlock() {
      const kw = input.value.trim();
      if (!kw) return;
      const selectedCat = catSelect.value;
      if (selectedCat) {
        // Add as custom synonym to the selected category
        removeMenu();
        const result = await sendMsg({ action: 'addCustomSynonym', category: selectedCat, synonym: kw });
        if (result && result.reason === 'already_exists') {
          showToast('"' + kw + '" is already in ' + cfCategoryLabel(selectedCat));
        } else {
          showToast(msg('keywordBlockedToast', [kw]) !== 'keywordBlockedToast'
            ? msg('keywordBlockedToast', [kw]) : 'Added "' + kw + '" to ' + cfCategoryLabel(selectedCat));
        }
        // Hide the card and re-filter
        let hideTarget = card;
        if (!hideTarget.matches || !hideTarget.matches(YT.VIDEO_CARDS)) {
          let el = card;
          for (let i = 0; i < 6 && el; i++) {
            if (el.parentElement && (el.parentElement.id === 'items' || el.parentElement.id === 'contents' ||
                el.parentElement.id === 'secondary' || el.parentElement.tagName === 'YTD-WATCH-NEXT-SECONDARY-RESULTS-RENDERER')) {
              hideTarget = el; break;
            }
            el = el.parentElement;
          }
        }
        hideTarget.classList.add('cleanfeed-hidden');
        document.querySelectorAll('[data-cf-checked]').forEach((el) => { delete el.dataset.cfChecked; });
        // Reload state so getExpandedKeywords picks up the custom synonym
        const newState = await sendMsg({ action: 'getFullState' });
        if (newState) cfSetSynonymFilters(newState.disabledSynonyms, newState.customSynonyms);
        filterPage();
      } else {
        blockKeyword(kw);
      }
    }

    inputBtn.addEventListener('click', (e) => { e.stopPropagation(); doBlock(); });
    input.addEventListener('keypress', (e) => { if (e.key === 'Enter') { e.stopPropagation(); doBlock(); } });

    const kwDesc = document.createElement('span');
    kwDesc.style.cssText = 'font-size:11px;color:var(--cf-text-muted);padding:0 4px;';
    kwDesc.textContent = msg('blockKeywordDesc') !== 'blockKeywordDesc'
      ? msg('blockKeywordDesc')
      : 'Hides all videos whose title contains this word';

    inputRow.appendChild(input);
    inputRow.appendChild(catSelect);
    inputRow.appendChild(inputBtn);
    kwOption.appendChild(kwLabel);
    kwOption.appendChild(inputRow);
    kwOption.appendChild(kwDesc);
    options.appendChild(kwOption);

    // Separator
    const separator = document.createElement('div');
    separator.style.cssText = 'height:1px;background:var(--cf-border);margin:4px 0;';
    options.appendChild(separator);

    // Option 3: Skip (just hide this one video)
    const skipOption = document.createElement('div');
    skipOption.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

    const skipBtn = document.createElement('button');
    skipBtn.className = 'cleanfeed-btn cleanfeed-btn-secondary';
    skipBtn.style.cssText = 'width:100%;text-align:center;padding:8px 14px;';
    skipBtn.textContent = msg('skipThisVideo') !== 'skipThisVideo'
      ? msg('skipThisVideo')
      : 'Skip this video';
    skipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeMenu();
      // Find the outermost video container to hide (including thumbnail).
      // Walk up from card until hitting a list boundary.
      let hideTarget = card;
      if (!hideTarget.matches || !hideTarget.matches(YT.VIDEO_CARDS)) {
        let el = card;
        for (let i = 0; i < 6 && el; i++) {
          if (el.parentElement && (el.parentElement.id === 'items' || el.parentElement.id === 'contents' ||
              el.parentElement.id === 'secondary' || el.parentElement.tagName === 'YTD-WATCH-NEXT-SECONDARY-RESULTS-RENDERER')) {
            hideTarget = el; // this is the direct child of the list — hide this
            break;
          }
          el = el.parentElement;
        }
      }
      hideTarget.classList.add('cleanfeed-hidden');
    });

    const skipDesc = document.createElement('span');
    skipDesc.style.cssText = 'font-size:11px;color:var(--cf-text-muted);padding:0 4px;text-align:center;';
    skipDesc.textContent = msg('skipDesc') !== 'skipDesc'
      ? msg('skipDesc')
      : 'Only hides this one video, nothing else';

    skipOption.appendChild(skipBtn);
    skipOption.appendChild(skipDesc);
    options.appendChild(skipOption);

    // --- Build prompt (NO auto-dismiss — stays until user clicks) ---
    const promptEl = document.createElement('div');
    promptEl.className = 'cleanfeed-inline-banner';
    promptEl.id = 'cleanfeed-topic-menu';
    promptEl.style.cssText = 'flex-direction:column;align-items:stretch;position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:99999;width:90%;max-width:520px;animation:cf-banner-in 0.3s ease forwards;';
    promptEl.appendChild(headerRow);
    promptEl.appendChild(options);

    document.body.appendChild(promptEl);

    // Focus the input for quick typing
    setTimeout(() => input.focus(), 100);
  }

  // ── Channel Page Button ───────────────────────────────────────────────

  function injectChannelPageButton() {
    // Remove existing buttons + wrapper on every call (channel may have changed via SPA navigation)
    document.querySelectorAll(
      '.cleanfeed-channel-block-btn, .cleanfeed-channel-peek-btn, .cleanfeed-channel-tabs-buttons, ' +
      '.cleanfeed-autotag-banner'
    ).forEach(el => el.remove());

    const isChannel = YT.isChannelPage();
    const isWatch = window.location.pathname === '/watch';

    if (!isChannel && !isWatch) return;

    // Get channel name and container — scoped to the correct area
    let channelName, channelId, container;

    if (isWatch) {
      // Watch page: use the MAIN video's owner area (not sidebar)
      const ownerRenderer = document.querySelector('ytd-watch-metadata ytd-video-owner-renderer, #above-the-fold ytd-video-owner-renderer, ytd-watch-flexy ytd-video-owner-renderer');
      if (!ownerRenderer) return;

      // Get channel name from within this specific owner renderer
      const nameEl = ownerRenderer.querySelector('ytd-channel-name yt-formatted-string a') ||
                     ownerRenderer.querySelector('ytd-channel-name a') ||
                     ownerRenderer.querySelector('#channel-name a');
      if (nameEl) {
        channelName = nameEl.textContent.trim();
        const href = nameEl.getAttribute('href') || '';
        channelId = href.startsWith('/@') ? href.substring(1) : href.replace('/channel/', '');
      }

      // Container: subscribe button is a SIBLING of owner renderer, not inside it
      // Both live under #owner div. Try multiple locations.
      container = ownerRenderer.closest('#owner')?.querySelector('#subscribe-button') ||
                  ownerRenderer.parentElement?.querySelector('#subscribe-button') ||
                  ownerRenderer.querySelector('#subscribe-button') ||
                  // Fallback: use the owner renderer itself as container
                  ownerRenderer;
    } else {
      // Channel page
      channelName = YT.getPageChannelName();
      channelId = YT.getPageChannelId();

      const channelContainerSelectors = [
        'ytd-c4-tabbed-header-renderer #subscribe-button',
        'ytd-c4-tabbed-header-renderer #buttons',
        '#channel-header #subscribe-button',
        '#page-header yt-flexible-actions-view-model',
        '#inner-header-container yt-flexible-actions-view-model',
        // Additional layouts (Bonsai Empire-style pages, redesigned channel headers)
        '#page-header #flexible-item-buttons',
        '#page-header .page-header-view-model-wiz__page-header-flexible-actions',
        'ytd-c4-tabbed-header-renderer #inner-header-container #buttons',
        '#channel-header-container #subscribe-button',
        '#page-header-container yt-subscribe-button-view-model',
      ];
      for (const sel of channelContainerSelectors) {
        container = document.querySelector(sel);
        if (container) break;
      }

      // Fallback: if no subscribe/buttons container found, insert after channel name
      if (!container) {
        const channelNameSelectors = [
          'ytd-c4-tabbed-header-renderer #channel-name',
          '#page-header yt-dynamic-text-view-model',
          '#inner-header-container yt-formatted-string#text',
          '#channel-header ytd-channel-name',
          '#page-header .page-header-view-model-wiz__page-header-title',
        ];
        for (const sel of channelNameSelectors) {
          const nameEl = document.querySelector(sel);
          if (nameEl) {
            container = nameEl;
            break;
          }
        }
      }
    }

    if (!channelName) return;

    // Create Block button — resolves channel at click time for safety
    const btn = cfEl(
      'button',
      {
        className: 'cleanfeed-channel-block-btn',
        'data-cf-channel': channelName,
        'data-cf-channel-id': channelId || '',
        onClick: (e) => {
          let name = e.currentTarget.getAttribute('data-cf-channel');
          let id = e.currentTarget.getAttribute('data-cf-channel-id');
          if (isWatch) {
            const ownerNow = document.querySelector('ytd-watch-metadata ytd-video-owner-renderer, #above-the-fold ytd-video-owner-renderer');
            const nameNow = ownerNow?.querySelector('ytd-channel-name yt-formatted-string a, ytd-channel-name a');
            if (nameNow?.textContent?.trim()) {
              name = nameNow.textContent.trim();
              const href = nameNow.getAttribute('href') || '';
              id = href.startsWith('/@') ? href.substring(1) : href.replace('/channel/', '');
            }
          }
          if (name) handleBlockClick(name, id);
          else showToast(msg('couldNotDetect'));
        },
      },
      [cfLogo(), cfEl('span', { textContent: msg('blockThisChannel') })]
    );

    // Create Peek switch
    const handleLower = channelId
      ? (channelId.startsWith('@') ? channelId.toLowerCase() : '@' + channelId.toLowerCase())
      : '';
    const isPeeked = (channelName && peekedChannels.has(channelName.toLowerCase())) ||
                     (handleLower && peekedChannels.has(handleLower));
    const filteringOn = !isPeeked;
    const peekLabel = msg('cleanFeedLabel') !== 'cleanFeedLabel' ? msg('cleanFeedLabel') : 'CleanFeed';
    const peekTitle = filteringOn
      ? (msg('showChannelJustNowTitle') !== 'showChannelJustNowTitle' ? msg('showChannelJustNowTitle') : 'Show this channel just now (page-only)')
      : (msg('hideChannelAgainTitle') !== 'hideChannelAgainTitle' ? msg('hideChannelAgainTitle') : 'Re-enable filtering for this channel');
    const peekBtn = cfSwitch({
      label: peekLabel,
      on: filteringOn,
      title: peekTitle,
      extraClass: 'cleanfeed-channel-peek-btn',
      locked: filteringOn && isStrictLocked(), // peeking weakens; ending a peek never does
      onToggle: () => setChannelPeek(channelName, channelId, filteringOn)
    });
    peekBtn.setAttribute('data-cf-channel', channelName);
    peekBtn.setAttribute('data-cf-channel-id', channelId || '');

    // --- Placement ---
    // On WATCH pages: inline next to the video's Iscriviti button (compact row).
    // On CHANNEL pages: in the tabs row (Home / Video / Short / Live / ...) at
    // the far right, wrapped in a flex container that pushes itself with
    // margin-left:auto. Previously we tucked them under Iscriviti where they
    // stacked full-width and looked broken.
    if (isWatch) {
      if (container && container.parentNode) {
        container.parentNode.insertBefore(btn, container.nextSibling);
        btn.parentNode.insertBefore(peekBtn, btn.nextSibling);
      }
      return;
    }

    // Scan button — only on channel pages (not watch pages). Lets the user
    // analyse all currently-loaded video titles and bulk-add new keywords or
    // synonyms based on what they find.
    const scanBtn = cfEl('button', {
      className: 'cleanfeed-channel-scan-btn',
      title: msg('scanChannelTitle') !== 'scanChannelTitle'
        ? msg('scanChannelTitle')
        : 'Analyse this channel and suggest new keywords to block',
      onClick: () => openScanModal()
    }, [
      cfLogo(),
      cfEl('span', {
        textContent: msg('scanChannelBtn') !== 'scanChannelBtn'
          ? msg('scanChannelBtn')
          : 'Scan'
      })
    ]);

    // Auto-tag banner: if this channel was auto-tagged for any blocked
    // category, surface it CLEARLY with a one-click untag. Without this,
    // users see "all my videos are blocked but I didn't block this channel"
    // and have no idea why (the tag is invisible state in storage).
    const autoTaggedCats = [];
    const channelNameLower = channelName.toLowerCase();
    for (const [cat, channelSet] of categoryTagsLocal.entries()) {
      if (channelSet.has(channelNameLower)) autoTaggedCats.push(cat);
    }

    let banner = null;
    if (autoTaggedCats.length > 0 && !isWatch) {
      const untagLocked = isStrictLocked();
      banner = cfEl('div', { className: 'cleanfeed-autotag-banner' }, [
        cfLogo(),
        cfEl('span', { className: 'cleanfeed-autotag-text' }, [
          cfEl('strong', { textContent: 'Auto-tagged: ' + autoTaggedCats.map(cfCategoryLabel).join(', ') + '.' }),
          cfEl('span', { textContent: ' All videos from this channel are blocked because they kept matching these categories. ' })
        ]),
        cfEl('button', {
          className: 'cleanfeed-btn cleanfeed-btn-primary' + (untagLocked ? ' cleanfeed-strict-locked' : ''),
          textContent: 'Untag channel',
          ...(untagLocked ? strictLockAttrs() : {}),
          onClick: untagLocked ? showStrictLockedToast : async () => {
            for (const cat of autoTaggedCats) {
              const res = await sendMsg({ action: 'untagChannelForCategory', category: cat, channelName });
              if (res.error === 'strict_locked') { showStrictLockedToast(); return; }
            }
            showToast('Untagged ' + channelName + ' from ' + autoTaggedCats.map(cfCategoryLabel).join(', '));
            // Refresh local state + refilter
            const newState = await sendMsg({ action: 'getFullState' });
            if (newState) applyState(newState);
            document.querySelectorAll('[data-cf-checked]').forEach((el) => {
              delete el.dataset.cfChecked;
            });
            document.querySelectorAll('.cleanfeed-hidden').forEach((el) => {
              el.classList.remove('cleanfeed-hidden');
            });
            filterPage();
            injectChannelPageButton(); // refresh the banner state
          }
        })
      ]);
    }

    // Channel page → look for the tabs row first
    const tabsRow = findChannelTabsRow();
    if (tabsRow) {
      const wrapper = cfEl('div', { className: 'cleanfeed-channel-tabs-buttons' });
      wrapper.appendChild(btn);
      wrapper.appendChild(peekBtn);
      wrapper.appendChild(scanBtn);
      tabsRow.appendChild(wrapper);
      // Banner goes ABOVE the tabs row, full width, so it can't be missed
      if (banner && tabsRow.parentElement) {
        tabsRow.parentElement.insertBefore(banner, tabsRow);
      }
      return;
    }

    // Last-resort fallback: still next to Iscriviti, but wrap in the same flex
    // container we use for the tabs row so the buttons stay inline horizontally
    // and don't stack full-width.
    if (container && container.parentNode) {
      const wrapper = cfEl('div', { className: 'cleanfeed-channel-tabs-buttons' });
      wrapper.appendChild(btn);
      wrapper.appendChild(peekBtn);
      wrapper.appendChild(scanBtn);
      container.parentNode.insertBefore(wrapper, container.nextSibling);
    }
  }

  // ── Scan Modal ────────────────────────────────────────────────────────

  function openScanModal() {
    // Collect titles from all visible video cards on this channel page
    const cards = document.querySelectorAll(YT.VIDEO_CARDS);
    const titles = [];
    for (const card of cards) {
      const t = YT.getVideoTitle(card);
      if (t) titles.push(t);
    }

    if (titles.length === 0) {
      showToast(msg('scanNoVideos') !== 'scanNoVideos'
        ? msg('scanNoVideos')
        : 'No videos found on this page to analyse');
      return;
    }

    const candidates = cfExtractKeywords(titles);
    showScanModal(titles.length, candidates, titles);
  }

  function showScanModal(videoCount, candidates, titles) {
    // Remove any existing modal
    const existing = document.getElementById('cleanfeed-scan-modal');
    if (existing) existing.remove();

    const blockedCats = getBlockedCategoryOptions();

    // --- Build modal structure ---
    const overlay = cfEl('div', { id: 'cleanfeed-scan-modal', className: 'cleanfeed-modal-overlay' });
    const panel = cfEl('div', { className: 'cleanfeed-modal-panel' });

    // Header
    const headerTitle = cfEl('div', { className: 'cleanfeed-modal-title' }, [
      cfLogo(),
      cfEl('span', {
        textContent: (msg('scanTitle') !== 'scanTitle' ? msg('scanTitle') : 'Scan keywords')
          + ' — ' + videoCount + ' '
          + (msg('scanVideosAnalysed') !== 'scanVideosAnalysed' ? msg('scanVideosAnalysed') : 'videos analysed')
      })
    ]);
    const closeBtn = cfEl('button', {
      className: 'cleanfeed-modal-close',
      textContent: '×',
      onClick: () => overlay.remove()
    });
    const header = cfEl('div', { className: 'cleanfeed-modal-header' }, [headerTitle, closeBtn]);
    panel.appendChild(header);

    // Helper text
    panel.appendChild(cfEl('p', {
      className: 'cleanfeed-modal-help',
      textContent: msg('scanHelp') !== 'scanHelp'
        ? msg('scanHelp')
        : 'Tick the keywords you want to block, then choose where each goes. Tip: scroll the channel page first to load more videos before scanning.'
    }));

    // Candidate list
    const list = cfEl('div', { className: 'cleanfeed-scan-list' });
    if (candidates.length === 0) {
      list.appendChild(cfEl('div', {
        className: 'cleanfeed-modal-empty',
        textContent: msg('scanNoCandidates') !== 'scanNoCandidates'
          ? msg('scanNoCandidates')
          : 'No repeated keywords found. Try scrolling to load more videos and re-scan.'
      }));
    }

    const rowState = []; // collect for confirm: { phrase, checked, target }

    for (const cand of candidates) {
      const cls = classifyCandidate(cand.phrase);
      const alreadyBlocked = cls !== null;

      const row = cfEl('label', { className: 'cleanfeed-scan-row' + (alreadyBlocked ? ' cf-already-blocked' : '') });
      const checkbox = cfEl('input', {
        type: 'checkbox',
        className: 'cleanfeed-scan-checkbox'
      });
      if (alreadyBlocked) checkbox.disabled = true;

      const phraseEl = cfEl('span', {
        className: 'cleanfeed-scan-phrase',
        textContent: cand.phrase
      });
      const countEl = cfEl('span', {
        className: 'cleanfeed-scan-count',
        textContent: '(' + cand.count + ')'
      });

      // Status badge for already-blocked items
      let badge = null;
      if (cls) {
        const label = cls.kind === 'keyword' ? 'already blocked'
                    : cls.kind === 'category' ? 'category blocked'
                    : 'in synonyms (' + cfCategoryLabel(cls.category) + ')';
        badge = cfEl('span', { className: 'cleanfeed-scan-badge', textContent: label });
      }

      // Dropdown: standalone / synonym of category X
      const select = cfEl('select', { className: 'cleanfeed-scan-target' });
      const standaloneOpt = cfEl('option', { value: '__standalone', textContent: 'Standalone keyword' });
      select.appendChild(standaloneOpt);
      for (const cat of blockedCats) {
        select.appendChild(cfEl('option', {
          value: 'syn:' + cat,
          textContent: 'Synonym of ' + cfCategoryLabel(cat)
        }));
      }
      if (alreadyBlocked) select.disabled = true;

      // Default is always "Standalone keyword" — we don't auto-assign a
      // category because the candidate words don't carry semantic info
      // (e.g. "ufficiale", "questi" are not gaming-related). User picks
      // a category from the dropdown if they want synonym treatment.
      select.value = '__standalone';

      const state = { phrase: cand.phrase, checkbox, select, alreadyBlocked };
      rowState.push(state);

      row.appendChild(checkbox);
      row.appendChild(phraseEl);
      row.appendChild(countEl);
      if (badge) row.appendChild(badge);
      row.appendChild(select);
      list.appendChild(row);
    }
    panel.appendChild(list);

    // Footer
    const cancelBtn = cfEl('button', {
      className: 'cleanfeed-btn cleanfeed-btn-secondary',
      textContent: msg('cancel') !== 'cancel' ? msg('cancel') : 'Cancel',
      onClick: () => overlay.remove()
    });
    const confirmBtn = cfEl('button', {
      className: 'cleanfeed-btn cleanfeed-btn-primary',
      textContent: msg('scanAddSelected') !== 'scanAddSelected'
        ? msg('scanAddSelected')
        : 'Add selected',
      onClick: () => confirmScanAdd(rowState, overlay, titles)
    });
    const footer = cfEl('div', { className: 'cleanfeed-modal-footer' }, [cancelBtn, confirmBtn]);
    panel.appendChild(footer);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Click-outside to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
  }

  // Toast for "every selected keyword was skipped or already there".
  function nothingAddedText() {
    return msg('scanNothingAdded') !== 'scanNothingAdded' ? msg('scanNothingAdded') : 'Nothing added';
  }

  async function confirmScanAdd(rowState, overlay, titles) {
    const selected = rowState.filter(s => !s.alreadyBlocked && s.checkbox.checked);
    if (selected.length === 0) {
      showToast(msg('scanNothingSelected') !== 'scanNothingSelected'
        ? msg('scanNothingSelected') : 'Select at least one keyword');
      return;
    }

    // Build the batch payload. Safety net: a phrase that matches none of the
    // analysed titles would never block anything, so it is skipped quietly.
    const items = [];
    for (const s of selected) {
      if (!cfPhraseMatchesAnyTitle(titles, s.phrase)) {
        console.debug('CleanFeed: skipped scan keyword that matches no analysed title: ' + s.phrase);
        continue;
      }
      const target = s.select.value;
      if (target === '__standalone') {
        items.push({ type: 'keyword', phrase: s.phrase });
      } else if (target && target.startsWith('syn:')) {
        items.push({ type: 'synonym', phrase: s.phrase, category: target.slice(4) });
      }
    }

    // Close modal IMMEDIATELY so the user doesn't see it frozen during the
    // background write. Previously the modal stayed open for the duration of
    // the sequential awaits — ~30s for 15-20 items.
    overlay.remove();
    if (items.length === 0) {
      showToast(nothingAddedText());
      return;
    }
    showToast('Adding ' + items.length + '…');

    const res = await sendMsg({ action: 'bulkAddBlockingTerms', items });
    if (!res) {
      showToast('Failed to add keywords');
      return;
    }

    const parts = [];
    if (res.addedKw > 0) parts.push(res.addedKw + ' keyword');
    if (res.addedSyn > 0) parts.push(res.addedSyn + ' synonym');
    if (res.skippedFree > 0) parts.push(res.skippedFree + ' skipped (free limit)');
    if (res.duplicates > 0) parts.push(res.duplicates + ' duplicates');
    showToast(parts.length > 0 ? 'Added: ' + parts.join(', ') : nothingAddedText());

    // Refresh local state + refilter once (storage.onChanged also fires but
    // we do an explicit refresh to avoid race with the toast timing).
    const newState = await sendMsg({ action: 'getFullState' });
    if (newState) applyState(newState);
    document.querySelectorAll('[data-cf-checked]').forEach((el) => {
      delete el.dataset.cfChecked;
    });
    filterPage();

    if (res.skippedFree > 0) {
      sendMsg({ action: 'openPaymentPage' });
    }
  }

  // ── Channel Scan helpers ──────────────────────────────────────────────
  // The candidate extractor (cfExtractKeywords) lives in content-dom.js.

  // Map a user-blocked keyword to its canonical category (gaming, anime, ...).
  // Only a keyword that IS a category key names a category. Blocking
  // "uncharted" (a synonym of "gaming") blocks just that word, so it is a
  // standalone keyword, not "gaming"; callers check KEYWORD_SYNONYMS[result]
  // to tell a category from a standalone keyword.
  function canonicalCategoryOf(userKeyword) {
    return userKeyword.toLowerCase();
  }

  // Strip diacritics so "pokémon" matches "pokemon" etc.
  function deburr(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Returns "blocked" classification for a candidate phrase:
  //   - 'keyword'  → exact match of an existing blocked keyword
  //   - 'category' → matches a blocked category name (e.g. "gaming")
  //   - 'synonym'  → already in built-in or custom synonyms of a blocked category
  //   - null       → fresh candidate
  function classifyCandidate(phrase) {
    const lower = phrase.toLowerCase();
    const lowerNoAcc = deburr(lower);
    // Exact blocked keyword?
    for (const kw of blockedKeywords) {
      const k = kw.keyword.toLowerCase();
      if (k === lower || deburr(k) === lowerNoAcc) {
        if (KEYWORD_SYNONYMS && KEYWORD_SYNONYMS[k]) {
          return { kind: 'category', category: k };
        }
        return { kind: 'keyword' };
      }
    }
    // Built-in / custom synonym of a blocked category?
    for (const kw of blockedKeywords) {
      const userKw = kw.keyword.toLowerCase();
      const expanded = getExpandedKeywords(userKw);
      const found = expanded.some(s => {
        const sl = s.toLowerCase();
        return sl === lower || deburr(sl) === lowerNoAcc;
      });
      if (found) {
        return { kind: 'synonym', category: canonicalCategoryOf(userKw) };
      }
    }
    return null;
  }

  // Return canonical categories the user can target with "Add as synonym of …".
  // Deduplicated so blocking both "gaming" and "uncharted" lists "gaming" once.
  function getBlockedCategoryOptions() {
    if (!KEYWORD_SYNONYMS) return [];
    const out = new Set();
    for (const kw of blockedKeywords) {
      const userKw = kw.keyword.toLowerCase();
      const canonical = canonicalCategoryOf(userKw);
      if (KEYWORD_SYNONYMS[canonical]) out.add(canonical);
    }
    return [...out];
  }

  // Find the row that holds the channel tabs (Home / Video / Short / Live /
  // Playlist / Post). Returns the row CONTAINER so callers can append child
  // elements that visually align with the right edge of the tab strip.
  function findChannelTabsRow() {
    // Strategy 1: ARIA tablist — strongest standard signal
    const tablist = document.querySelector('[role="tablist"]');
    if (tablist && tablist.offsetWidth > 0) return tablist;

    // Strategy 2: known YouTube tab containers (every layout we've seen)
    const candidates = [
      'yt-page-header-renderer yt-tab-group-shape',
      'yt-tab-group-shape',
      '.yt-tab-group-shape-wiz',
      '.page-header-view-model-wiz__page-header-tabs',
      'ytd-c4-tabbed-header-renderer tp-yt-paper-tabs',
      'ytd-c4-tabbed-header-renderer #tabsContent',
      'ytd-c4-tabbed-header-renderer #tabs'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.offsetWidth > 0) return el.parentElement || el;
    }

    // Strategy 3: walk up from any single tab element
    const tab = document.querySelector(
      'yt-tab-shape, ytd-tab-renderer, tp-yt-paper-tab, .yt-tab-shape-wiz, [role="tab"]'
    );
    if (tab && tab.offsetWidth > 0 && tab.parentElement) return tab.parentElement;

    // Strategy 4: anchor on the channel-internal search icon
    const searchIcon =
      document.querySelector('ytd-c4-tabbed-header-renderer ytd-icon-button[id*="search"]') ||
      document.querySelector('#expand-channel-search-button') ||
      document.querySelector('yt-page-header-renderer button[aria-label*="erca" i]') ||
      document.querySelector('yt-page-header-renderer button[aria-label*="earch" i]');
    if (searchIcon && searchIcon.parentElement) return searchIcon.parentElement;

    // Strategy 5: text-based last resort. Tab labels are short and unique.
    // Match a visible clickable with one of the known tab labels and walk to
    // its parent. Width guard (< 240px) avoids grabbing large containers.
    const TAB_TEXTS = new Set([
      'Home', 'Video', 'Videos', 'Shorts', 'Short', 'Live', 'Playlist',
      'Playlists', 'Post', 'Posts', 'Community', 'Channels', 'About', 'Info',
      'Featured', 'Releases', 'Podcasts', 'Store'
    ]);
    const clickables = document.querySelectorAll('a, button, [role="tab"], yt-tab-shape');
    for (const el of clickables) {
      const t = (el.textContent || '').trim();
      if (!TAB_TEXTS.has(t)) continue;
      if (el.offsetWidth === 0 || el.offsetWidth > 240) continue;
      // Walk up to the row container that holds multiple tab siblings
      let p = el.parentElement;
      for (let depth = 0; p && depth < 4; depth++) {
        // The row should contain ≥2 tab-like children
        const tabsInside = p.querySelectorAll('a, button, [role="tab"], yt-tab-shape');
        if (tabsInside.length >= 2) return p;
        p = p.parentElement;
      }
    }

    return null;
  }

  // ── Channel Peek (page-scoped exemption) ──────────────────────────────

  function setChannelPeek(channelName, channelId, on) {
    const nameLower = channelName ? channelName.toLowerCase() : '';
    const handleLower = channelId
      ? (channelId.startsWith('@') ? channelId.toLowerCase() : '@' + channelId.toLowerCase())
      : '';

    if (on) {
      if (nameLower) peekedChannels.add(nameLower);
      if (handleLower) peekedChannels.add(handleLower);
    } else {
      if (nameLower) peekedChannels.delete(nameLower);
      if (handleLower) peekedChannels.delete(handleLower);
    }

    // Rebuild pre-hide CSS (excludes peeked handles when on, re-includes when off)
    updateBlockedChannelPreHideStyles();

    // Reset all "checked" markers and the channel-blocked overlay so a fresh
    // pass re-evaluates every card against the new peek state.
    document.querySelectorAll('.cleanfeed-hidden').forEach((el) => {
      el.classList.remove('cleanfeed-hidden');
    });
    document.querySelectorAll('[data-cf-checked]').forEach((el) => {
      delete el.dataset.cfChecked;
    });
    document.querySelectorAll('[data-cf-blocked]').forEach((el) => {
      delete el.dataset.cfBlocked;
    });
    const blockedMsg = document.getElementById('cf-channel-blocked-msg');
    if (blockedMsg) blockedMsg.remove();

    filterPage();
    // Re-inject the peek button so its label/state updates
    injectChannelPageButton();
  }

  // ── Floating Pause Toggle ─────────────────────────────────────────────

  function injectPauseToggle() {
    // Remove any existing toggle (handles SPA navigation)
    const existing = document.getElementById('cleanfeed-pause-toggle');
    if (existing) existing.remove();

    // Don't show on the Subscriptions feed — filtering is already off there.
    if (window.location.pathname.startsWith('/feed/subscriptions')) return;

    // Anchor: prefer the center section of YouTube's masthead (which contains
    // the search bar + mic). #center is ALWAYS rendered on every YouTube page
    // and layout — including watch pages where the right-side #end (Crea /
    // notifications / avatar) sometimes collapses or fails to render.
    // Falling back to #end only if #center is unavailable.
    const center =
      document.querySelector('ytd-masthead #center') ||
      document.querySelector('#masthead-container #center') ||
      document.querySelector('#masthead #center');
    const end =
      document.querySelector('ytd-masthead #end') ||
      document.querySelector('ytd-masthead #buttons');

    const target = center || end;
    if (!target) return; // masthead not ready yet; observer will retry

    // Switch semantic: ON = CleanFeed active (filtering); OFF = paused.
    const isOn = !isPagePaused;
    const label = msg('cleanFeedLabel') !== 'cleanFeedLabel' ? msg('cleanFeedLabel') : 'CleanFeed';
    const title = isOn
      ? (msg('pauseCleanFeedTitle') !== 'pauseCleanFeedTitle' ? msg('pauseCleanFeedTitle') : 'Disable CleanFeed on this page only')
      : (msg('resumeCleanFeedTitle') !== 'resumeCleanFeedTitle' ? msg('resumeCleanFeedTitle') : 'Re-enable CleanFeed on this page');

    const sw = cfSwitch({
      id: 'cleanfeed-pause-toggle',
      label,
      on: isOn,
      title,
      locked: isOn && isStrictLocked(), // pausing weakens; resuming never does
      onToggle: () => setPagePaused(isOn) // if currently ON, pause it; if OFF, resume
    });
    // Append as LAST child of #center → appears right after the mic icon,
    // before the right-side action group. Visually sits centered-right of the
    // header, always inside the visible masthead viewport.
    target.appendChild(sw);
  }

  // ── Subscriptions: hide "Più pertinenti" algorithmic shelf ───────────
  // YouTube splits the Subscriptions feed into a chronological list AND a
  // "Più pertinenti / Most relevant / For you" algorithmic shelf below.
  // The shelf undoes the whole point of subscribing — it surfaces things YT
  // wants you to watch, not what your subscribed channels actually posted.

  // Localized titles for the "more relevant / recommended" section header.
  // Matched as lowercase substring against the section title text.
  const RELEVANT_SECTION_TITLES = [
    'più pertinenti', 'piu pertinenti',
    'most relevant',
    'for you', 'per te',
    'recommended', 'consigliati',
    'recomendados', 'mais relevantes',
    'plus pertinent', 'pour vous',
    'empfohlen', 'für dich',
    'おすすめ', '추천'
  ];

  function findRelevantSections() {
    if (!window.location.pathname.startsWith('/feed/subscriptions')) return [];
    const sections = document.querySelectorAll('ytd-rich-section-renderer, ytd-shelf-renderer');
    const matches = [];
    for (const s of sections) {
      const titleEl = s.querySelector(
        '#title-text, #title, h2 span, span#title, .grid-subheader, ' +
        'yt-formatted-string#title, .ytd-rich-shelf-renderer #title'
      );
      const t = (titleEl?.textContent || '').trim().toLowerCase();
      if (!t) continue;
      for (const candidate of RELEVANT_SECTION_TITLES) {
        if (t.includes(candidate)) { matches.push(s); break; }
      }
    }
    return matches;
  }

  function applyRelevantSectionVisibility() {
    const hide = currentSettings.hideSubsRelevant !== false; // default true
    const sections = findRelevantSections();
    for (const s of sections) {
      if (hide) s.classList.add('cleanfeed-relevant-hidden');
      else s.classList.remove('cleanfeed-relevant-hidden');
    }
  }

  function injectSubscriptionsToggle() {
    const existing = document.getElementById('cleanfeed-subs-toggle');
    if (existing) existing.remove();

    if (!window.location.pathname.startsWith('/feed/subscriptions')) return;

    // Anchor: the "Tutte le iscrizioni / All subscriptions" link lives in the
    // page header. We insert our toggle as a sibling immediately before it so
    // they sit on the same horizontal row, on the right side of the feed.
    const anchor =
      document.querySelector('a[href="/feed/channels"]') ||
      document.querySelector('a[href*="/feed/channels"]') ||
      document.querySelector('ytd-rich-grid-renderer #header a');
    if (!anchor || !anchor.parentNode) return;

    // Switch semantic: ON = "More relevant" shelf hidden (filtering active)
    //                  OFF = shelf visible (let it through)
    const hidden = currentSettings.hideSubsRelevant !== false;
    const label = msg('subsCleanerLabel') !== 'subsCleanerLabel'
      ? msg('subsCleanerLabel') : 'Hide "More relevant"';
    const title = hidden
      ? (msg('showRelevantShelfTitle') !== 'showRelevantShelfTitle'
          ? msg('showRelevantShelfTitle') : 'Click to show YouTube’s algorithmic shelf')
      : (msg('hideRelevantShelfTitle') !== 'hideRelevantShelfTitle'
          ? msg('hideRelevantShelfTitle') : 'Click to hide YouTube’s algorithmic shelf');

    const sw = cfSwitch({
      id: 'cleanfeed-subs-toggle',
      label,
      on: hidden,
      title,
      locked: hidden && isStrictLocked(), // showing the shelf weakens; hiding it never does
      onToggle: async () => {
        const newVal = !hidden;
        const res = await sendMsg({ action: 'updateSetting', key: 'hideSubsRelevant', value: newVal });
        if (res.error === 'strict_locked') { showStrictLockedToast(); return; }
        currentSettings.hideSubsRelevant = newVal;
        applyRelevantSectionVisibility();
        injectSubscriptionsToggle();
      }
    });

    anchor.parentNode.insertBefore(sw, anchor);
  }

  function setPagePaused(paused) {
    isPagePaused = paused;
    if (paused) {
      document.body.classList.add('cleanfeed-paused');
    } else {
      document.body.classList.remove('cleanfeed-paused');
    }
    // Rebuild prehide CSS (cleared when paused, restored when resumed)
    updateBlockedChannelPreHideStyles();
    // Reset filter markers so every card re-evaluates
    document.querySelectorAll('.cleanfeed-hidden').forEach((el) => {
      el.classList.remove('cleanfeed-hidden');
    });
    document.querySelectorAll('[data-cf-checked]').forEach((el) => {
      delete el.dataset.cfChecked;
    });
    document.querySelectorAll('[data-cf-blocked]').forEach((el) => {
      delete el.dataset.cfBlocked;
    });
    const blockedMsg = document.getElementById('cf-channel-blocked-msg');
    if (blockedMsg) blockedMsg.remove();
    filterPage();
    injectPauseToggle();
  }

  // ── Search Intercept (Interest Boundaries) ────────────────────────────

  function interceptSearch() {
    // --- Input-based interception (keydown + button click) ---
    const searchInput = document.querySelector('input#search') ||
                        document.querySelector('input[name="search_query"]') ||
                        document.querySelector('ytd-searchbox input');

    if (searchInput && !searchInput.dataset.cfSearchIntercepted) {
      searchInput.dataset.cfSearchIntercepted = 'true';

      searchInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const query = searchInput.value.trim();
        if (query) scheduleInterestCheck(query);
      });

      const searchBtn = document.querySelector('#search-icon-legacy, button[aria-label="Search"], ytd-searchbox button');
      if (searchBtn) {
        searchBtn.addEventListener('click', () => {
          const query = searchInput.value.trim();
          if (query) scheduleInterestCheck(query);
        });
      }
    }

    // --- URL-based detection ---
    checkSearchQueryChanged();
  }

  // Poll URL every second to catch search changes that bypass yt-navigate-finish
  let searchWatcherInterval = null;
  function startSearchQueryWatcher() {
    if (searchWatcherInterval) clearInterval(searchWatcherInterval);
    // The URL poll only feeds the curiosity prompt (Interest Boundaries).
    if (CF_FEATURES.interestBoundaries) {
      searchWatcherInterval = setInterval(() => {
        if (window.location.pathname === '/results') {
          checkSearchQueryChanged();
        }
      }, 1000);
    }
    // Clean up the interval and any pending batched logs/hits when the tab
    // is going away. pagehide fires for both real unloads and bfcache.
    window.addEventListener('pagehide', () => {
      if (searchWatcherInterval) {
        clearInterval(searchWatcherInterval);
        searchWatcherInterval = null;
      }
      flushLogQueue();
      flushCategoryHits();
    }, { once: true });
  }

  // Detect when the search query in the URL changes
  function checkSearchQueryChanged() {
    if (window.location.pathname !== '/results') return;
    const params = new URLSearchParams(window.location.search);
    const query = params.get('search_query');
    if (query && query !== lastKnownSearchQuery) {
      lastKnownSearchQuery = query;
      scheduleInterestCheck(query);
    }
  }

  // Wait for search results DOM to be ready, then trigger interest check
  function scheduleInterestCheck(query) {
    // Interest Boundaries hidden (features.js): no curiosity prompt.
    if (!CF_FEATURES.interestBoundaries) return;
    lastKnownSearchQuery = query; // prevent duplicate triggers from other paths
    if (pendingCuriosityCheck) {
      clearTimeout(pendingCuriosityCheck);
      pendingCuriosityCheck = null;
    }
    // Remove stale prompt from previous search
    removeCuriosityPrompt();

    let attempts = 0;
    const maxAttempts = 30; // 3s max wait
    function waitForResults() {
      attempts++;
      const results = document.querySelector(
        'ytd-section-list-renderer #contents ytd-item-section-renderer, ' +
        'ytd-search ytd-item-section-renderer, ' +
        'ytd-search ytd-video-renderer'
      );
      if (results) {
        triggerInterestCheck(query);
      } else if (attempts < maxAttempts) {
        pendingCuriosityCheck = setTimeout(waitForResults, 100);
      }
    }
    waitForResults();
  }

  // Remove any visible curiosity prompt by ID (DOM-based, not closure-based)
  function removeCuriosityPrompt() {
    const el = document.getElementById('cleanfeed-curiosity-prompt');
    if (el) el.remove();
  }

  async function triggerInterestCheck(query) {
    if (!query) return;
    if (query === lastPromptedQuery) return;
    // Per-session safety gate: prevent runaway prompting on weird SPA loops
    if (sessionPromptCount >= 3 && !isPro) return;

    // Check if this EXACT query was already saved as an interest — if so, skip
    const matchCheck = await sendMsg({ action: 'checkInterestMatch', query });
    if (matchCheck && matchCheck.exactMatch) return;

    // Central gate via background — applies to BOTH free and Pro users.
    // Previously free users bypassed this and their lifetime cap (3 prompts)
    // was never incremented, so free users effectively saw the teaser forever.
    const gateResult = await sendMsg({ action: 'checkInterest', query });
    if (!gateResult || !gateResult.shouldPrompt) return;

    lastPromptedQuery = query;
    sessionPromptCount++;
    showCuriosityPrompt(query, isPro);
  }

  // ── Curiosity Window Prompt ───────────────────────────────────────────

  function showCuriosityPrompt(query, proStatus) {
    // Remove any existing prompt (DOM-based lookup, not closure)
    removeCuriosityPrompt();

    // Build all elements with raw createElement + textContent to avoid any
    // Trusted Types CSP violations (cfEl chains can fail silently on YouTube).

    // -- Logo --
    const logo = document.createElement('span');
    logo.className = 'cleanfeed-cf-logo';
    logo.textContent = 'CF';

    // -- Title: "New search: [query]" --
    const titleStrong = document.createElement('strong');
    const newSearchText = msg('newSearch', [query]);
    titleStrong.textContent = (newSearchText === 'newSearch') ? 'New search: "' + query + '"' : newSearchText;
    const titleEl = document.createElement('div');
    titleEl.appendChild(titleStrong);

    // -- Subtitle --
    const subtitleEl = document.createElement('span');
    const rememberText = msg('rememberInterest');
    subtitleEl.textContent = (rememberText === 'rememberInterest') ? 'How long do you want to see this content?' : rememberText;

    // -- Button helper (stopPropagation prevents YouTube from intercepting clicks) --
    function makeBtn(className, labelKey, fallback, handler) {
      const btn = document.createElement('button');
      btn.className = 'cleanfeed-btn ' + className;
      const text = msg(labelKey);
      btn.textContent = (text === labelKey) ? fallback : text;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        handler();
        removeCuriosityPrompt();
      });
      return btn;
    }

    // Helper: un-hide all cards and re-filter so interest exemption takes effect
    function refilterAfterInterest() {
      document.querySelectorAll('.cleanfeed-hidden').forEach((el) => {
        el.classList.remove('cleanfeed-hidden');
      });
      document.querySelectorAll('[data-cf-checked]').forEach((el) => {
        delete el.dataset.cfChecked;
      });
      filterPage();
    }

    const justNowBtn = makeBtn('cleanfeed-btn-secondary', 'curiosityJustNow', 'Just now', () => {
      activeJustNowQueries.add(query);
      refilterAfterInterest();
      if (!proStatus) sendMsg({ action: 'openPaymentPage' });
    });

    const todayBtn = makeBtn('cleanfeed-btn-secondary', 'curiosityToday', 'Today', () => {
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
      sendMsg({ action: 'addInterest', query, expiresAt: endOfDay.getTime() }).then(() => {
        // Reload interests into local state before re-filtering
        savedInterestQueries.push(query.toLowerCase());
        refilterAfterInterest();
      });
      if (!proStatus) sendMsg({ action: 'openPaymentPage' });
    });

    const alwaysBtn = makeBtn('cleanfeed-btn-primary', 'curiosityAlways', 'Always', () => {
      sendMsg({ action: 'addInterest', query }).then(() => {
        savedInterestQueries.push(query.toLowerCase());
        refilterAfterInterest();
      });
      if (!proStatus) sendMsg({ action: 'openPaymentPage' });
    });

    const buttons = document.createElement('div');
    buttons.className = 'cleanfeed-toast-buttons';
    buttons.appendChild(justNowBtn);
    buttons.appendChild(todayBtn);
    buttons.appendChild(alwaysBtn);

    // -- Always build as inline banner at top --
    const bannerText = document.createElement('div');
    bannerText.className = 'cleanfeed-inline-banner-text';
    bannerText.appendChild(titleEl);
    bannerText.appendChild(subtitleEl);

    const content = document.createElement('div');
    content.className = 'cleanfeed-inline-banner-content';
    content.appendChild(logo);
    content.appendChild(bannerText);

    const promptEl = document.createElement('div');
    promptEl.className = 'cleanfeed-inline-banner';
    promptEl.id = 'cleanfeed-curiosity-prompt';
    promptEl.appendChild(content);
    promptEl.appendChild(buttons);

    // Append to document.body — YouTube never replaces body children,
    // so the prompt is immune to SPA DOM swaps. CSS handles fixed positioning.
    document.body.appendChild(promptEl);
  }

  // ── Subscription Exception Toast ──────────────────────────────────────

  function showSubscriptionExceptionToast(affectedChannels, keyword) {
    const text = cfEl('div', { className: 'cleanfeed-toast-text' }, [
      cfEl('span', {
        textContent: msg('subscriptionExceptionToast', [
          String(affectedChannels.length),
        ]),
      }),
    ]);

    const chips = cfEl('div', { className: 'cleanfeed-toast-chips' });
    const chipsLocked = isStrictLocked();
    for (const ch of affectedChannels) {
      const chip = cfEl('button', {
        className: 'cleanfeed-chip' + (chipsLocked ? ' cleanfeed-strict-locked' : ''),
        textContent: ch.name,
        ...(chipsLocked ? strictLockAttrs() : {}),
        onClick: () => {
          if (isStrictLocked()) {
            showStrictLockedToast();
          } else if (isPro) {
            sendMsg({
              action: 'whitelistChannel',
              name: ch.name,
              id: ch.id,
              exemptFrom: keyword,
            }).then((res) => {
              if (res.error === 'strict_locked') { showStrictLockedToast(); return; }
              chip.remove();
              // Re-filter to un-hide
              document.querySelectorAll('[data-cf-checked]').forEach((el) => {
                delete el.dataset.cfChecked;
              });
              // Add to local whitelist
              whitelistedChannels.push({
                name: ch.name,
                id: ch.id,
                exemptFrom: keyword,
              });
              filterPage();
            });
          } else {
            sendMsg({ action: 'openPaymentPage' });
          }
        },
      });
      chips.appendChild(chip);
    }

    const toast = buildToastEl([cfLogo(), text, chips]);
    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) dismissToast(toast);
    }, 10000);
  }

  // ── Toast Helpers ─────────────────────────────────────────────────────

  function buildToastEl(children) {
    return cfEl('div', { className: 'cleanfeed-toast' }, children);
  }

  function showToast(message, duration) {
    duration = duration || 4000;
    const toast = buildToastEl([
      cfLogo(),
      cfEl('span', { className: 'cleanfeed-toast-text', textContent: message }),
    ]);
    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) dismissToast(toast);
    }, duration);
  }

  function dismissToast(toast) {
    toast.classList.add('cf-exit');
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 300);
  }

  // --- Quick-add keyword button (per video card, hover-triggered) ---

  // Inject the "CF+" hover button into a single card. Idempotent: skips if already present.
  function injectQuickAddButton(card) {
    if (card.querySelector('.cleanfeed-quickadd-btn')) return;
    // Don't inject on cards already hidden
    if (card.classList.contains('cleanfeed-hidden')) return;

    // Skip nested-inside-another-video-card cases (e.g. yt-lockup-view-model
    // wrapped in ytd-rich-item-renderer — both match VIDEO_CARDS). Only the
    // OUTERMOST card gets the button. Without this guard we ended up with two
    // CF+ buttons stacked on the same thumbnail on certain channel layouts.
    let p = card.parentElement;
    while (p && p !== document.body) {
      if (p.matches && p.matches(YT.VIDEO_CARDS)) return;
      p = p.parentElement;
    }

    const btn = cfEl('button', {
      className: 'cleanfeed-quickadd-btn',
      title: msg('quickAddTitle') !== 'quickAddTitle' ? msg('quickAddTitle') : 'Add words from this title to your block list',
      onClick: (e) => {
        e.stopPropagation();
        e.preventDefault();
        const title = YT.getVideoTitle(card) || '';
        openQuickAddPopover(card, title);
      }
    }, [cfEl('span', { textContent: 'CF+' })]);

    // Mark card as relatively-positioned via inline style? We use CSS instead — card has position:relative naturally for most.
    card.appendChild(btn);
  }

  // Walks the page and injects the button on all visible video cards
  function injectQuickAddButtonsAll() {
    const cards = document.querySelectorAll(YT.VIDEO_CARDS);
    for (const card of cards) {
      if (card.dataset.cfQuickaddInjected) continue;
      card.dataset.cfQuickaddInjected = 'true';
      injectQuickAddButton(card);
    }
  }

  function openQuickAddPopover(card, title) {
    // Remove existing
    const existing = document.getElementById('cleanfeed-quickadd-popover');
    if (existing) existing.remove();

    // Chips: one per title word (stop words disabled), then pairs and triples of
    // neighbouring words. Text keeps the title's own case and punctuation, phrase
    // is what gets saved. In QUICK-ADD context, numbers ARE often meaningful (game
    // version, year, codename: "007 First Light", "GTA 5", "Half-Life 2", "Doom 3"),
    // so they are selectable; the general scan modal uses a stricter filter.
    const chipList = cfQuickAddChips(title);

    // Available "Add as" targets: every blocked category (canonical), plus Standalone
    const blockedCats = getBlockedCategoryOptions();

    const overlay = cfEl('div', { id: 'cleanfeed-quickadd-popover', className: 'cleanfeed-quickadd-overlay' });
    const panel = cfEl('div', { className: 'cleanfeed-quickadd-panel' });

    const header = cfEl('div', { className: 'cleanfeed-quickadd-header' });
    header.appendChild(cfLogo());
    header.appendChild(cfEl('span', {
      className: 'cleanfeed-quickadd-title',
      textContent: msg('quickAddPopoverTitle') !== 'quickAddPopoverTitle'
        ? msg('quickAddPopoverTitle') : 'Pick words to block'
    }));
    const closeBtn = cfEl('button', {
      className: 'cleanfeed-modal-close',
      textContent: '×',
      onClick: () => overlay.remove()
    });
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Display the original title above chips for context
    const titleEl = cfEl('div', { className: 'cleanfeed-quickadd-fulltitle', textContent: title });
    panel.appendChild(titleEl);

    const chipsWrap = cfEl('div', { className: 'cleanfeed-quickadd-chips' });
    const selected = new Set();

    for (const info of chipList) {
      const chip = cfEl('button', {
        className: 'cleanfeed-quickadd-chip'
          + (info.kind === 'word' ? '' : ' cleanfeed-quickadd-chip-bigram')
          + (info.stop ? ' is-stop' : ''),
        textContent: info.text
      });
      if (info.stop) {
        chip.disabled = true;
        chip.title = 'Common word — skipped';
      } else {
        chip.addEventListener('click', () => {
          if (selected.has(info.phrase)) {
            selected.delete(info.phrase);
            chip.classList.remove('selected');
          } else {
            selected.add(info.phrase);
            chip.classList.add('selected');
          }
        });
      }
      chipsWrap.appendChild(chip);
    }
    panel.appendChild(chipsWrap);

    // Dropdown for target category
    const targetRow = cfEl('div', { className: 'cleanfeed-quickadd-target' });
    targetRow.appendChild(cfEl('label', {
      textContent: msg('quickAddAs') !== 'quickAddAs' ? msg('quickAddAs') : 'Add as:'
    }));
    const select = cfEl('select', { className: 'cleanfeed-quickadd-select' });
    const standaloneOpt = cfEl('option', { value: '__standalone', textContent: 'Standalone keyword' });
    select.appendChild(standaloneOpt);
    for (const cat of blockedCats) {
      select.appendChild(cfEl('option', { value: 'syn:' + cat, textContent: 'Synonym of ' + cfCategoryLabel(cat) }));
    }
    // Smart default: prefer "gaming" if blocked, else first blocked category, else standalone
    if (blockedCats.includes('gaming')) select.value = 'syn:gaming';
    else if (blockedCats.length > 0) select.value = 'syn:' + blockedCats[0];
    else select.value = '__standalone';
    targetRow.appendChild(select);
    panel.appendChild(targetRow);

    // Footer
    const footer = cfEl('div', { className: 'cleanfeed-quickadd-footer' });
    const cancel = cfEl('button', {
      className: 'cleanfeed-btn cleanfeed-btn-secondary',
      textContent: msg('cancel') !== 'cancel' ? msg('cancel') : 'Cancel',
      onClick: () => overlay.remove()
    });
    const submit = cfEl('button', {
      className: 'cleanfeed-btn cleanfeed-btn-primary',
      textContent: msg('quickAddSubmit') !== 'quickAddSubmit' ? msg('quickAddSubmit') : 'Add selected',
      onClick: async () => {
        if (selected.size === 0) {
          showToast(msg('scanNothingSelected') !== 'scanNothingSelected' ? msg('scanNothingSelected') : 'Select at least one keyword');
          return;
        }
        const target = select.value;

        // Adjacent picked words merge into one phrase cut from the title ("007",
        // "first", "light" -> "007 first light"), and any phrase the title does not
        // contain is dropped: it would be saved but never block anything.
        const { phrases, skipped } = cfResolveQuickAddSelection(title, selected);
        for (const phrase of skipped) {
          console.debug('CleanFeed: skipped quick-add keyword that does not match the title: ' + phrase);
        }
        const items = [];
        for (const phrase of phrases) {
          if (target === '__standalone') items.push({ type: 'keyword', phrase });
          else if (target.startsWith('syn:')) items.push({ type: 'synonym', phrase, category: target.slice(4) });
        }
        overlay.remove();
        if (items.length === 0) {
          showToast(nothingAddedText());
          return;
        }
        const res = await sendMsg({ action: 'bulkAddBlockingTerms', items });
        if (res) {
          const parts = [];
          if (res.addedKw > 0) parts.push(res.addedKw + ' keyword');
          if (res.addedSyn > 0) parts.push(res.addedSyn + ' synonym');
          if (res.skippedFree > 0) parts.push(res.skippedFree + ' skipped (free limit)');
          showToast(parts.length > 0 ? 'Added: ' + parts.join(', ') : nothingAddedText());
          if (res.skippedFree > 0) sendMsg({ action: 'openPaymentPage' });
          // Refresh state + refilter so the card disappears immediately
          const newState = await sendMsg({ action: 'getFullState' });
          if (newState) applyState(newState);
          document.querySelectorAll('[data-cf-checked]').forEach(el => { delete el.dataset.cfChecked; });
          filterPage();
        }
      }
    });
    footer.appendChild(cancel);
    footer.appendChild(submit);
    panel.appendChild(footer);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Click outside to close
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────

  init();
})();
