// CleanFeed Content Script — v1.1
// Runs on all YouTube pages. Handles channel/keyword blocking, menu injection,
// curiosity window (interest boundaries), subscription exceptions, and Shorts hiding.
// Depends on content-dom.js (cfEl, YT, matchesKeyword) loaded before this file.

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
  let debounceTimer = null;
  let observer = null;
  let lastClickedVideoCard = null;
  // searchIntercepted — now tracked via data-cf-search-intercepted on the input element
  let activeJustNowQueries = new Set();
  const loggedVideos = new Set(); // dedup: track title+channel combos already logged
  let sessionPromptCount = 0; // per-session curiosity prompt count (resets each page load)
  let lastPromptedQuery = ''; // avoid re-prompting for the same query on SPA re-renders
  let lastKnownSearchQuery = ''; // track URL search query for SPA change detection
  let pendingCuriosityCheck = null; // pending waitForSearchResults timeout

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

  function cfLogo() {
    return cfEl('span', { className: 'cleanfeed-cf-logo', textContent: 'CF' });
  }

  // ── Init ───────────────────────────────────────────────────────────────

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
    startObserver();
    trackMenuClicks();
    interceptSuggestedClicks();
    watchForMenuPopup();
    interceptSearch();
    injectChannelPageButton();

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
        console.log('CleanFeed: received refilterPage message');
        onStorageChanged({}, 'local');
        sendResponse({ success: true });
      }
    });
  }

  function applyState(state) {
    if (!state) return;
    currentSettings = state.settings || {};
    isPro = !!state.isPro;
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

    updateBlockedChannelPreHideStyles();
  }

  // ── SPA Navigation ────────────────────────────────────────────────────

  async function onNavigate() {
    const state = await sendMsg({ action: 'getFullState' });
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
    interceptSearch();
  }

  // ── Storage Change Listener ───────────────────────────────────────────

  async function onStorageChanged(changes, areaName) {
    console.log('CleanFeed: onStorageChanged fired', areaName, Object.keys(changes || {}));
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

    // Insert a rule for each blocked handle
    for (const handle of blockedChannelHandles) {
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
    hideBlockedContent();
    // Note: updateBlockedChannelPreHideStyles() runs in applyState() when
    // blocked lists change — no need to rebuild CSS rules on every filter pass.
  }

  function hideBlockedContent() {
    // Nothing to filter — skip all DOM queries
    if (blockedChannelNames.size === 0 && blockedChannelHandles.size === 0 && blockedKeywords.length === 0) return;

    const cards = document.querySelectorAll(YT.VIDEO_CARDS);
    let newCards = 0;

    for (const card of cards) {
      if (card.dataset.cfChecked) continue;
      card.dataset.cfChecked = 'true';
      newCards++;

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

          card.classList.add('cleanfeed-hidden');
          logHidden(card, 'keyword', kw.keyword);
          break;
        }
      }
    }

    if (newCards > 0) {
      console.log('CleanFeed: hideBlockedContent processed', newCards, 'new cards');
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
      if (name && blockedChannelNames.has(name)) {
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
          if (text && blockedChannelNames.has(text)) {
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

        // Walk up to the nearest renderer-level container and hide it
        const container = link.closest(
          'ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ' +
          'ytd-compact-video-renderer, ytd-reel-item-renderer, ytd-channel-renderer, ' +
          'ytd-shelf-renderer, ytd-reel-shelf-renderer, ytd-horizontal-card-list-renderer, ' +
          'ytd-playlist-renderer'
        );
        if (container && !container.classList.contains('cleanfeed-hidden')) {
          container.classList.add('cleanfeed-hidden');
        }
      }
    }

    } // end: blockedChannelNames/Handles gate

    // If we're on a blocked channel's page, hide ALL their content
    if (YT.isChannelPage()) {
      const pageChannel = YT.getPageChannelName();
      if (pageChannel && blockedChannelNames.has(pageChannel.toLowerCase())) {
        // Hide the entire page content section
        const content = document.querySelector('ytd-two-column-browse-results-renderer, #contents.ytd-section-list-renderer, ytd-browse #content');
        if (content && !content.dataset.cfBlocked) {
          content.dataset.cfBlocked = 'true';
          content.classList.add('cleanfeed-hidden');
          // Show a message that this channel is blocked
          if (!document.getElementById('cf-channel-blocked-msg')) {
            const msg_el = cfEl('div', {
              id: 'cf-channel-blocked-msg',
              className: 'cleanfeed-toast',
              style: 'position:relative;margin:40px auto;max-width:500px;bottom:auto;left:auto;transform:none;animation:none;justify-content:center;'
            }, [
              cfLogo(),
              cfEl('span', { textContent: 'This channel is blocked by CleanFeed' })
            ]);
            const pageManager = document.querySelector('ytd-page-manager, #page-manager');
            if (pageManager) pageManager.prepend(msg_el);
          }
        }
      }
    }

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
        container.dataset.cfChecked = 'sidebar';

        const title = titleEl.textContent?.trim() || '';

        // Channel blocking: try multiple strategies
        // Strategy 1: standard getChannelName (works if links exist)
        const channelName = YT.getChannelName(container);
        const channelLower = channelName ? channelName.toLowerCase() : '';
        if (channelLower && blockedChannelNames.has(channelLower)) {
          container.classList.add('cleanfeed-hidden');
          continue;
        }

        // Strategy 2: check handle links
        const channelLink = container.querySelector('a[href^="/@"]');
        const channelHref = (channelLink?.getAttribute('href') || '').toLowerCase();
        const handleMatch = channelHref.match(/^\/(@[^\/\?]+)/);
        const handle = handleMatch ? handleMatch[1] : '';
        if (handle && blockedChannelHandles.has(handle)) {
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
            container.classList.add('cleanfeed-hidden');
            channelBlocked = true;
            break;
          }
        }
        if (channelBlocked) continue;

        // Keyword blocking
        for (const kw of blockedKeywords) {
          const expandedTerms = getExpandedKeywords(kw.keyword);
          for (const term of expandedTerms) {
            if (matchesKeyword(title, term)) {
              container.classList.add('cleanfeed-hidden');
              break;
            }
          }
          if (container.classList.contains('cleanfeed-hidden')) break;
        }
      }
    }

    // Subscription Exception: throttled — runs at most once every 3 seconds
    // to avoid scanning the entire sidebar + all hidden cards on every filter pass.
    scheduleSubscriptionCheck();
  }

  // Track which keyword-blocked channels we've already prompted about
  const promptedSubscriptionExceptions = new Set();
  let subCheckTimer = null;

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

    // For each keyword, find subscribed channels that were hidden
    for (const kw of blockedKeywords) {
      const keyword = kw.keyword;
      const promptKey = keyword;
      if (promptedSubscriptionExceptions.has(promptKey)) continue;

      const affectedChannels = [];
      const cards = document.querySelectorAll(YT.VIDEO_CARDS + '.cleanfeed-hidden');
      for (const card of cards) {
        const channelName = YT.getChannelName(card);
        if (!channelName) continue;
        if (!subscribedNames.has(channelName.toLowerCase())) continue;
        if (isWhitelisted(channelName, keyword)) continue;

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
        promptedSubscriptionExceptions.add(promptKey);
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

  function getBlockedCategoryForTitle(title) {
    if (!title) return null;
    for (const kw of blockedKeywords) {
      const expandedTerms = getExpandedKeywords(kw.keyword);
      for (const term of expandedTerms) {
        if (matchesKeyword(title, term)) return expandedTerms[0];
      }
    }
    return null;
  }

  const STOP_WORDS = new Set([
    'the','a','an','is','are','was','were','in','on','at','to','for','of','and','or',
    'but','not','this','that','with','from','by','how','what','why','when','who','my',
    'your','you','he','she','it','we','they','me','him','her','us','them','do','does',
    'did','will','would','can','could','should','may','might','has','have','had','no',
    'yes','all','just','about','been','being','get','got','new','old','first','last',
    'very','most','some','any','one','two','its','than','then','so','if','up','out',
    'into','more','come','like','best','full','video','official','music',
    'il','la','le','lo','un','una','di','da','del','della','che','per','con','non',
    'sono','una','questo','questa','come','cosa','tutto','tutti','anche','solo','dopo',
    'prima','ogni','suo','sua','suoi','fare','fatto','essere','stato','stati'
  ]);

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

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => filterPage(), 300);
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

        const videoCard = menuTrigger.closest(YT.VIDEO_CARDS);
        if (videoCard) {
          lastClickedVideoCard = videoCard;
        }
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
      if (window.location.pathname === '/results') return null;

      const card = e.target.closest(YT.VIDEO_CARDS);
      if (!card) return null;
      if (document.getElementById('cleanfeed-suggested-prompt')) return null;

      const title = YT.getVideoTitle(card);
      const category = getBlockedCategoryForTitle(title);
      if (!category) return null;

      const channelName = YT.getChannelName(card);
      if (isWhitelisted(channelName, category)) return null;

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
    const aboutText = msg('suggestedVideoAbout', [category]);
    titleStrong.textContent = (aboutText === 'suggestedVideoAbout') ? 'This video is about "' + category + '"' : aboutText;
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
    const menuObserver = new MutationObserver(() => {
      const popup = YT.getMenuPopup();
      if (popup) {
        injectBlockOption(popup);
      }
    });

    menuObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'focused_', 'aria-hidden', 'class', 'opened', 'aria-expanded'],
    });
  }

  // ── Inject "Block Channel" into Video Menu ────────────────────────────

  function injectBlockOption(popup) {
    // Get channel info from tracked video card FIRST (eager resolution)
    if (!lastClickedVideoCard) return;

    const channelName = YT.getChannelName(lastClickedVideoCard);
    const channelId = YT.getChannelId(lastClickedVideoCard);
    const videoTitle = YT.getVideoTitle(lastClickedVideoCard);
    const videoCard = lastClickedVideoCard;

    // Check if the existing menu item already has the correct channel
    const existingItem = popup.querySelector('.cleanfeed-menu-item');
    if (existingItem && existingItem.dataset.cfChannel === channelName) return;

    // Remove old items if channel changed
    if (existingItem) {
      popup.querySelectorAll('.cleanfeed-menu-item, .cleanfeed-menu-separator').forEach(el => el.remove());
    }

    const listbox = YT.getMenuListbox(popup);
    if (!listbox) return;

    const items = YT.getMenuItems(listbox);
    if (!items || items.length === 0) return;

    if (items.length < 2) return;

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
      const result = await sendMsg({ action: 'addKeyword', keyword });
      if (result && result.reason === 'free_limit') {
        showToast(msg('keywordLimitToast'));
        sendMsg({ action: 'openPaymentPage' });
        return;
      }
      if (result && result.reason === 'already_exists') {
        showToast(msg('keywordAlreadyBlocked', [keyword]) !== 'keywordAlreadyBlocked'
          ? msg('keywordAlreadyBlocked', [keyword])
          : '"' + keyword + '" is already blocked.');
        return;
      }
      showToast(msg('keywordBlockedToast', [keyword]) !== 'keywordBlockedToast'
        ? msg('keywordBlockedToast', [keyword])
        : 'Blocked keyword: "' + keyword + '"');
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
      const catLabel = detectedCategory.charAt(0).toUpperCase() + detectedCategory.slice(1);

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
    // Only show blocked categories as options
    const blockedKwSet = new Set(blockedKeywords.map(k => k.keyword.toLowerCase()));
    const CATS = [
      'crypto','gambling','politics','gossip','asmr','mukbang','pranks','astrology',
      'conspiracy','nsfw','clickbait','gaming','kpop','anime','diet','hustle',
      'horror','true_crime','reaction','unboxing'
    ];
    for (const c of CATS) {
      if (blockedKwSet.has(c)) {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c.charAt(0).toUpperCase() + c.slice(1).replace('_', ' ');
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
          showToast('"' + kw + '" is already in ' + selectedCat);
        } else {
          showToast(msg('keywordBlockedToast', [kw]) !== 'keywordBlockedToast'
            ? msg('keywordBlockedToast', [kw]) : 'Added "' + kw + '" to ' + selectedCat);
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
    // Remove existing button on every call (channel may have changed via SPA navigation)
    const existing = document.querySelector('.cleanfeed-channel-block-btn');
    if (existing) existing.remove();

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

    if (!channelName || !container) return;

    // Create button — resolves channel at click time for safety
    const btn = cfEl(
      'button',
      {
        className: 'cleanfeed-channel-block-btn',
        'data-cf-channel': channelName,
        'data-cf-channel-id': channelId || '',
        onClick: (e) => {
          // Re-resolve channel name at click time in case SPA navigated
          let name = e.currentTarget.getAttribute('data-cf-channel');
          let id = e.currentTarget.getAttribute('data-cf-channel-id');

          // Double-check by reading from DOM at click time
          if (isWatch) {
            const ownerNow = document.querySelector('ytd-watch-metadata ytd-video-owner-renderer, #above-the-fold ytd-video-owner-renderer');
            const nameNow = ownerNow?.querySelector('ytd-channel-name yt-formatted-string a, ytd-channel-name a');
            if (nameNow?.textContent?.trim()) {
              name = nameNow.textContent.trim();
              const href = nameNow.getAttribute('href') || '';
              id = href.startsWith('/@') ? href.substring(1) : href.replace('/channel/', '');
            }
          }

          if (name) {
            handleBlockClick(name, id);
          } else {
            showToast(msg('couldNotDetect'));
          }
        },
      },
      [cfLogo(), cfEl('span', { textContent: msg('blockThisChannel') })]
    );

    // Insert after the subscribe button
    const insertTarget = container.tagName === 'BUTTON' ? container.parentNode : container;
    if (insertTarget && insertTarget.parentNode) {
      insertTarget.parentNode.insertBefore(btn, insertTarget.nextSibling);
    }
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
  function startSearchQueryWatcher() {
    setInterval(() => {
      if (window.location.pathname === '/results') {
        checkSearchQueryChanged();
      }
    }, 1000);
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
    console.log('CleanFeed: triggerInterestCheck', query, sessionPromptCount);
    // Don't re-prompt for the same query on SPA re-renders
    if (query === lastPromptedQuery) return;
    // Per-session limit: free users get 3 prompts per page-load session
    if (sessionPromptCount >= 3 && !isPro) return;

    // Check if this EXACT query was already saved as an interest — if so, skip
    // (We use exact match, not fuzzy, to avoid false positives)
    const matchCheck = await sendMsg({ action: 'checkInterestMatch', query });
    if (matchCheck && matchCheck.exactMatch) {
      console.log('CleanFeed: query exactly matches existing interest, skipping prompt');
      return;
    }

    // Pro users: also respect the enableInterestBoundaries setting
    if (isPro) {
      const result = await sendMsg({ action: 'checkInterest', query });
      if (!result.shouldPrompt) return;
    }

    // Show the prompt
    lastPromptedQuery = query;
    sessionPromptCount++;
    console.log('CleanFeed: showing curiosity prompt #' + sessionPromptCount);
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
      console.log('CleanFeed: Just now clicked, isPro:', proStatus);
      activeJustNowQueries.add(query);
      refilterAfterInterest();
      if (!proStatus) sendMsg({ action: 'openPaymentPage' });
    });

    const todayBtn = makeBtn('cleanfeed-btn-secondary', 'curiosityToday', 'Today', () => {
      console.log('CleanFeed: Today clicked, isPro:', proStatus);
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
      console.log('CleanFeed: Always clicked, isPro:', proStatus);
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
    console.log('CleanFeed: curiosity prompt shown for "' + query + '"');
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
    for (const ch of affectedChannels) {
      const chip = cfEl('button', {
        className: 'cleanfeed-chip',
        textContent: ch.name,
        onClick: () => {
          if (isPro) {
            sendMsg({
              action: 'whitelistChannel',
              name: ch.name,
              id: ch.id,
              exemptFrom: keyword,
            }).then(() => {
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

  // ── Bootstrap ─────────────────────────────────────────────────────────

  init();
})();
