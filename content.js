// CleanFeed Content Script — v1.1
// Runs on all YouTube pages. Handles channel/keyword blocking, menu injection,
// curiosity window (interest boundaries), subscription exceptions, and Shorts hiding.
// Depends on content-dom.js (cfEl, YT, matchesKeyword) loaded before this file.

(() => {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────

  let blockedChannelNames = new Set();
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

  // ── Helpers ────────────────────────────────────────────────────────────

  function msg(key, subs) {
    return chrome.i18n.getMessage(key, subs) || key;
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
  }

  function applyState(state) {
    if (!state) return;
    currentSettings = state.settings || {};
    isPro = !!state.isPro;
    blockedKeywords = state.blockedKeywords || [];
    whitelistedChannels = state.whitelistedChannels || [];

    blockedChannelNames = new Set();
    const channels = state.blockedChannels || [];
    for (const ch of channels) {
      if (ch.name) blockedChannelNames.add(ch.name.toLowerCase());
    }
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

  async function onStorageChanged() {
    const state = await sendMsg({ action: 'getFullState' });
    applyState(state);

    // Clear processed flags so everything gets re-evaluated
    document.querySelectorAll('[data-cf-checked]').forEach((el) => {
      delete el.dataset.cfChecked;
    });

    filterPage();
  }

  // ── Filtering ─────────────────────────────────────────────────────────

  function filterPage() {
    if (currentSettings.hideShorts) {
      document.body.classList.add('cleanfeed-hide-shorts');
    } else {
      document.body.classList.remove('cleanfeed-hide-shorts');
    }
    hideBlockedContent();
  }

  function hideBlockedContent() {
    const cards = document.querySelectorAll(YT.VIDEO_CARDS);

    for (const card of cards) {
      if (card.dataset.cfChecked) continue;
      card.dataset.cfChecked = 'true';

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
    // Don't inject twice
    if (popup.querySelector('.cleanfeed-menu-item')) return;

    const listbox = YT.getMenuListbox(popup);
    if (!listbox) return;

    const items = YT.getMenuItems(listbox);
    if (!items || items.length === 0) return;

    // Verify it's a video menu by checking for known items
    const menuTexts = Array.from(items).map((item) =>
      (item.textContent || '').toLowerCase()
    );
    const isVideoMenu = menuTexts.some(
      (t) =>
        t.includes('not interested') ||
        t.includes('non mi interessa') ||
        t.includes('report') ||
        t.includes('segnala') ||
        t.includes('add to queue') ||
        t.includes('aggiungi alla coda') ||
        t.includes('save to watch later') ||
        t.includes('salva in guarda')
    );
    if (!isVideoMenu) return;

    // Get channel info from tracked video card
    if (!lastClickedVideoCard) return;

    const channelName = YT.getChannelName(lastClickedVideoCard);
    const channelId = YT.getChannelId(lastClickedVideoCard);
    if (!channelName) return;

    // Create separator + block item
    const separator = cfEl('div', { className: 'cleanfeed-menu-separator' });

    const blockItem = cfEl(
      'div',
      {
        className: 'cleanfeed-menu-item',
        role: 'menuitem',
        tabindex: '0',
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
      // Both live under #owner div
      container = ownerRenderer.closest('#owner')?.querySelector('#subscribe-button') ||
                  ownerRenderer.parentElement?.querySelector('#subscribe-button') ||
                  ownerRenderer.querySelector('#subscribe-button');
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
      ];
      for (const sel of channelContainerSelectors) {
        container = document.querySelector(sel);
        if (container) break;
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
    // Try multiple selectors for the search input
    const searchInput = document.querySelector('input#search') ||
                        document.querySelector('input[name="search_query"]') ||
                        document.querySelector('ytd-searchbox input');
    if (!searchInput) return;

    // Avoid double-attaching to the same DOM element
    if (searchInput.dataset.cfSearchIntercepted) return;
    searchInput.dataset.cfSearchIntercepted = 'true';

    async function handleSearch() {
      const query = searchInput.value.trim();
      if (!query) return;

      const result = await sendMsg({ action: 'checkInterest', query });
      if (result.shouldPrompt) {
        setTimeout(() => {
          showCuriosityPrompt(
            result.query,
            result.isPro,
            result.useInlineBanner
          );
        }, 500);
      }
    }

    // Use keydown instead of keypress (keypress is deprecated and may not fire for Enter)
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      handleSearch();
    });

    // Also intercept the search button click
    const searchBtn = document.querySelector('#search-icon-legacy, button[aria-label="Search"], ytd-searchbox button');
    if (searchBtn) {
      searchBtn.addEventListener('click', () => {
        handleSearch();
      });
    }

    // Also detect search via SPA navigation (URL changes to /results)
    // This is handled via onNavigate -> interceptSearch, but we also need to
    // check if we just navigated TO a search page and should prompt
    if (window.location.pathname === '/results') {
      const params = new URLSearchParams(window.location.search);
      const query = params.get('search_query');
      if (query) {
        // Small delay to let page render
        setTimeout(async () => {
          const result = await sendMsg({ action: 'checkInterest', query });
          if (result.shouldPrompt) {
            showCuriosityPrompt(result.query, result.isPro, result.useInlineBanner);
          }
        }, 800);
      }
    }
  }

  // ── Curiosity Window Prompt ───────────────────────────────────────────

  function showCuriosityPrompt(query, proStatus, useInlineBanner) {
    // Remove any existing prompt
    const existingBanner = document.querySelector('.cleanfeed-inline-banner');
    const existingToast = document.querySelector('.cleanfeed-curiosity-toast');
    if (existingBanner) existingBanner.remove();
    if (existingToast) dismissToast(existingToast);

    const titleEl = cfEl('div', {}, [
      cfEl('strong', { textContent: msg('newSearch', [query]) }),
    ]);
    const subtitleEl = cfEl('span', {
      textContent: msg('rememberInterest'),
    });

    const justNowBtn = cfEl('button', {
      className: 'cleanfeed-btn cleanfeed-btn-secondary',
      textContent: msg('curiosityJustNow'),
      onClick: () => {
        if (proStatus) {
          activeJustNowQueries.add(query);
          removePrompt();
        } else {
          sendMsg({ action: 'openPaymentPage' });
        }
      },
    });

    const todayBtn = cfEl('button', {
      className: 'cleanfeed-btn cleanfeed-btn-secondary',
      textContent: msg('curiosityToday'),
      onClick: () => {
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
      },
    });

    const alwaysBtn = cfEl('button', {
      className: 'cleanfeed-btn cleanfeed-btn-primary',
      textContent: msg('curiosityAlways'),
      onClick: () => {
        if (proStatus) {
          sendMsg({ action: 'addInterest', query });
          removePrompt();
        } else {
          sendMsg({ action: 'openPaymentPage' });
        }
      },
    });

    const buttons = cfEl('div', { className: 'cleanfeed-toast-buttons' }, [
      justNowBtn,
      todayBtn,
      alwaysBtn,
    ]);

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
      const content = cfEl('div', { className: 'cleanfeed-inline-banner-content' }, [
        cfLogo(),
        cfEl('div', { className: 'cleanfeed-inline-banner-text' }, [
          titleEl,
          subtitleEl,
        ]),
      ]);

      promptEl = cfEl('div', { className: 'cleanfeed-inline-banner' }, [
        content,
        buttons,
      ]);

      const anchor = document.querySelector(
        'ytd-section-list-renderer, ytd-search'
      );
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(promptEl, anchor);
      } else {
        // Fallback: add as toast
        promptEl = buildToastEl([titleEl, subtitleEl, buttons]);
        promptEl.classList.add('cleanfeed-curiosity-toast');
        document.body.appendChild(promptEl);
      }

      // Auto-dismiss banner after 10s
      setTimeout(() => {
        if (promptEl && promptEl.parentNode) promptEl.remove();
      }, 10000);
    } else {
      promptEl = buildToastEl([
        cfLogo(),
        cfEl('div', { className: 'cleanfeed-toast-text' }, [
          titleEl,
          subtitleEl,
        ]),
        buttons,
      ]);
      promptEl.classList.add('cleanfeed-curiosity-toast');
      document.body.appendChild(promptEl);

      // Auto-dismiss toast after 8s
      setTimeout(() => {
        if (promptEl && promptEl.parentNode) dismissToast(promptEl);
      }, 8000);
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
