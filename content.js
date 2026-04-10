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

  // ── Helpers ────────────────────────────────────────────────────────────

  function msg(key, subs) {
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
    const state = await sendMsg({ action: 'getFullState' });
    applyState(state);

    filterPage();
    startObserver();
    trackMenuClicks();
    watchForMenuPopup();
    interceptSearch();
    injectChannelPageButton();

    document.addEventListener('yt-navigate-finish', onNavigate);
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

    blockedChannelNames = new Set();
    blockedChannelHandles = new Set();
    const channels = state.blockedChannels || [];
    for (const ch of channels) {
      if (ch.name) blockedChannelNames.add(ch.name.toLowerCase());
      // Store @handle for href-based matching (id may be "@handle" or just "handle")
      if (ch.id) {
        const handle = ch.id.startsWith('@') ? ch.id.toLowerCase() : '@' + ch.id.toLowerCase();
        blockedChannelHandles.add(handle);
      }
    }

    // Update CSS pre-hide rules immediately so blocked content never flashes
    updateBlockedChannelPreHideStyles();
  }

  // ── SPA Navigation ────────────────────────────────────────────────────

  async function onNavigate() {
    const state = await sendMsg({ action: 'getFullState' });
    applyState(state);

    // Clear curiosity window queries when leaving search results
    if (!window.location.pathname.startsWith('/results')) {
      activeJustNowQueries.clear();
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
      const href = '/' + handle; // becomes "/@something"
      const rule =
        'ytd-video-renderer:has(a[href="' + href + '"]), ' +
        'ytd-rich-item-renderer:has(a[href="' + href + '"]), ' +
        'ytd-grid-video-renderer:has(a[href="' + href + '"]), ' +
        'ytd-compact-video-renderer:has(a[href="' + href + '"]), ' +
        'ytd-reel-item-renderer:has(a[href="' + href + '"]), ' +
        'ytd-shelf-renderer:has(a[href="' + href + '"]), ' +
        'ytd-reel-shelf-renderer:has(a[href="' + href + '"]), ' +
        'ytd-playlist-renderer:has(a[href="' + href + '"]) ' +
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
      // JS-based Shorts hiding for search results
      // YouTube 2025 uses grid-shelf-view-model inside ytd-item-section-renderer
      // with a yt-section-header-view-model containing "Shorts" title
      document.querySelectorAll(
        'ytd-item-section-renderer, ytd-shelf-renderer, ytd-reel-shelf-renderer, ' +
        'ytd-rich-shelf-renderer[is-shorts], ytd-rich-section-renderer'
      ).forEach((section) => {
        if (section.classList.contains('cleanfeed-hidden')) return;
        // Check for Shorts by multiple indicators
        const titleEl = section.querySelector(
          '#title, #title-text, h2, .ytShelfHeaderLayoutTitle, ' +
          'yt-formatted-string, span.yt-core-attributed-string'
        );
        const titleText = (titleEl?.textContent || '').trim().toLowerCase();
        const hasShorts = section.hasAttribute('is-shorts') ||
                          section.querySelector('ytd-reel-item-renderer, grid-shelf-view-model') ||
                          titleText === 'shorts' ||
                          titleText.startsWith('shorts');
        if (hasShorts) {
          section.classList.add('cleanfeed-hidden');
        }
      });
      // Also hide individual video cards that are Shorts (have SHORTS badge or overlay)
      document.querySelectorAll('ytd-video-renderer').forEach((video) => {
        if (video.classList.contains('cleanfeed-hidden')) return;
        // Check for Shorts badge/overlay
        const shortsBadge = video.querySelector(
          '[overlay-style="SHORTS"], .ytd-thumbnail-overlay-time-status-renderer[overlay-style="SHORTS"], ' +
          'span.ytd-thumbnail-overlay-time-status-renderer'
        );
        if (shortsBadge) {
          const badgeText = shortsBadge.textContent?.trim().toUpperCase();
          if (badgeText === 'SHORTS' || shortsBadge.getAttribute('overlay-style') === 'SHORTS') {
            video.classList.add('cleanfeed-hidden');
          }
        }
      });
    } else {
      document.body.classList.remove('cleanfeed-hide-shorts');
    }
    hideBlockedContent();
    updateBlockedChannelPreHideStyles();
  }

  function hideBlockedContent() {
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

      // Keyword blocking
      const title = YT.getVideoTitle(card) || '';
      const desc = YT.getVideoDescription(card);

      for (const kw of blockedKeywords) {
        const keyword = kw.keyword;
        if (matchesKeyword(title, keyword) || matchesKeyword(desc, keyword)) {
          // Check whitelist
          if (isWhitelisted(channelName, keyword)) continue;
          // Check curiosity window
          if (matchesJustNow(title, desc)) continue;

          card.classList.add('cleanfeed-hidden');
          logHidden(card, 'keyword', keyword);
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

    // Subscription Exception: check if keyword blocks hit subscribed channels
    checkSubscriptionExceptions();
  }

  // Track which keyword-blocked channels we've already prompted about
  const promptedSubscriptionExceptions = new Set();

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
        if (matchesKeyword(title, keyword) || matchesKeyword(desc, keyword)) {
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

  function matchesJustNow(title, desc) {
    for (const q of activeJustNowQueries) {
      if (matchesKeyword(title, q) || matchesKeyword(desc, q)) return true;
    }
    return false;
  }

  function logHidden(card, type, value) {
    const title = YT.getVideoTitle(card) || '';
    const channel = YT.getChannelName(card) || '';
    const dedupKey = (title + '||' + channel).toLowerCase();
    if (loggedVideos.has(dedupKey)) return;
    loggedVideos.add(dedupKey);

    sendMsg({ action: 'incrementStat', stat: 'videosHidden', amount: 1 });
    sendMsg({
      action: 'logHiddenVideo',
      title,
      channel,
      reason: type + ':' + value,
    });
  }

  // ── MutationObserver ──────────────────────────────────────────────────

  function startObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        filterPage();
      }, 200);
    });

    observer.observe(document.body, {
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
    // Get channel info from tracked video card FIRST
    if (!lastClickedVideoCard) return;

    const channelName = YT.getChannelName(lastClickedVideoCard);
    const channelId = YT.getChannelId(lastClickedVideoCard);

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
    if (!channelName) return;

    // Create separator + block item
    const separator = cfEl('div', { className: 'cleanfeed-menu-separator' });

    const blockItem = cfEl(
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
    );

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

    if (insertAfter && insertAfter.nextSibling) {
      listbox.insertBefore(separator, insertAfter.nextSibling);
      listbox.insertBefore(blockItem, separator.nextSibling);
    } else {
      listbox.appendChild(separator);
      listbox.appendChild(blockItem);
    }
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

    // If on watch page, hide sidebar videos from this channel immediately
    if (window.location.pathname === '/watch') {
      document.querySelectorAll('ytd-compact-video-renderer').forEach((card) => {
        const ch = YT.getChannelName(card);
        if (ch && ch.toLowerCase() === name.toLowerCase()) {
          card.classList.add('cleanfeed-hidden');
        }
      });
    }
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
        if (query) triggerInterestCheck(query);
      });

      const searchBtn = document.querySelector('#search-icon-legacy, button[aria-label="Search"], ytd-searchbox button');
      if (searchBtn) {
        searchBtn.addEventListener('click', () => {
          const query = searchInput.value.trim();
          if (query) triggerInterestCheck(query);
        });
      }
    }

    // --- URL-based detection (primary & most reliable trigger) ---
    // Fires regardless of how the search was initiated: keyboard, button,
    // suggestion click, voice, URL paste, etc.
    if (window.location.pathname === '/results') {
      const params = new URLSearchParams(window.location.search);
      const query = params.get('search_query');
      if (query) {
        // Small delay to let the search page render
        setTimeout(() => triggerInterestCheck(query), 2000);
      }
    }
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
    showCuriosityPrompt(query, isPro, sessionPromptCount <= 3);
  }

  // ── Curiosity Window Prompt ───────────────────────────────────────────

  function showCuriosityPrompt(query, proStatus, useInlineBanner) {
    // Remove any existing prompt
    const existingBanner = document.querySelector('.cleanfeed-inline-banner');
    const existingToast = document.querySelector('.cleanfeed-curiosity-toast');
    if (existingBanner) existingBanner.remove();
    if (existingToast) dismissToast(existingToast);

    // Build all elements with raw createElement + textContent to avoid any
    // Trusted Types CSP violations (cfEl chains can fail silently on YouTube).

    // -- Logo --
    const logo = document.createElement('span');
    logo.className = 'cleanfeed-cf-logo';
    logo.textContent = 'CF';

    // -- Title: "New search: [query]" --
    const titleStrong = document.createElement('strong');
    titleStrong.textContent = msg('newSearch', [query]);
    const titleEl = document.createElement('div');
    titleEl.appendChild(titleStrong);

    // -- Subtitle --
    const subtitleEl = document.createElement('span');
    subtitleEl.textContent = msg('rememberInterest');

    // -- Buttons --
    const justNowBtn = document.createElement('button');
    justNowBtn.className = 'cleanfeed-btn cleanfeed-btn-secondary';
    justNowBtn.textContent = msg('curiosityJustNow');
    justNowBtn.addEventListener('click', () => {
      if (proStatus) {
        activeJustNowQueries.add(query);
        removePrompt();
      } else {
        sendMsg({ action: 'openPaymentPage' });
      }
    });

    const todayBtn = document.createElement('button');
    todayBtn.className = 'cleanfeed-btn cleanfeed-btn-secondary';
    todayBtn.textContent = msg('curiosityToday');
    todayBtn.addEventListener('click', () => {
      if (proStatus) {
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        sendMsg({
          action: 'addInterest',
          query,
          expiresAt: endOfDay.getTime(),
        });
        removePrompt();
      } else {
        sendMsg({ action: 'openPaymentPage' });
      }
    });

    const alwaysBtn = document.createElement('button');
    alwaysBtn.className = 'cleanfeed-btn cleanfeed-btn-primary';
    alwaysBtn.textContent = msg('curiosityAlways');
    alwaysBtn.addEventListener('click', () => {
      if (proStatus) {
        sendMsg({ action: 'addInterest', query });
        removePrompt();
      } else {
        sendMsg({ action: 'openPaymentPage' });
      }
    });

    const buttons = document.createElement('div');
    buttons.className = 'cleanfeed-toast-buttons';
    buttons.appendChild(justNowBtn);
    buttons.appendChild(todayBtn);
    buttons.appendChild(alwaysBtn);

    let promptEl;

    function removePrompt() {
      if (promptEl) {
        if (promptEl.classList.contains('cleanfeed-inline-banner')) {
          promptEl.remove();
        } else {
          dismissToast(promptEl);
        }
      }
    }

    if (useInlineBanner) {
      const bannerText = document.createElement('div');
      bannerText.className = 'cleanfeed-inline-banner-text';
      bannerText.appendChild(titleEl);
      bannerText.appendChild(subtitleEl);

      const content = document.createElement('div');
      content.className = 'cleanfeed-inline-banner-content';
      content.appendChild(logo);
      content.appendChild(bannerText);

      promptEl = document.createElement('div');
      promptEl.className = 'cleanfeed-inline-banner';
      promptEl.appendChild(content);
      promptEl.appendChild(buttons);

      // Try multiple anchor points for the inline banner
      const anchorSelectors = [
        'ytd-section-list-renderer',
        'ytd-search',
        'ytd-item-section-renderer',
        '#contents.ytd-search',
        '#container.ytd-search'
      ];
      let anchor = null;
      for (const sel of anchorSelectors) {
        anchor = document.querySelector(sel);
        if (anchor) break;
      }

      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(promptEl, anchor);
        console.log('CleanFeed: inline banner inserted before', anchor.tagName);
      } else {
        // Fallback: insert at top of page content or use fixed position
        console.log('CleanFeed: no anchor found, inserting at top of page-manager');
        const pageManager = document.querySelector('ytd-page-manager, #content, #page-manager');
        if (pageManager) {
          pageManager.prepend(promptEl);
        } else {
          // Last resort: fixed position toast
          promptEl.style.position = 'fixed';
          promptEl.style.top = '70px';
          promptEl.style.left = '50%';
          promptEl.style.transform = 'translateX(-50%)';
          promptEl.style.zIndex = '99999';
          document.body.appendChild(promptEl);
        }
      }

      // No auto-dismiss — stays until user clicks a button
    } else {
      const toastLogo = document.createElement('span');
      toastLogo.className = 'cleanfeed-cf-logo';
      toastLogo.textContent = 'CF';
      const toastText = document.createElement('div');
      toastText.className = 'cleanfeed-toast-text';
      toastText.appendChild(titleEl);
      toastText.appendChild(subtitleEl);
      promptEl = buildToastEl([toastLogo, toastText, buttons]);
      promptEl.classList.add('cleanfeed-curiosity-toast');
      document.body.appendChild(promptEl);

      // No auto-dismiss — stays until user clicks a button
    }
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
