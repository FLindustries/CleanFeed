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
  let searchIntercepted = false;
  let activeJustNowQueries = new Set();

  // ── Helpers ────────────────────────────────────────────────────────────

  function msg(key, subs) {
    return chrome.i18n.getMessage(key, subs) || key;
  }

  function sendMsg(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (resp) => {
        resolve(resp || {});
      });
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
    let hiddenCount = 0;

    for (const card of cards) {
      if (card.dataset.cfChecked) continue;
      card.dataset.cfChecked = 'true';

      const channelName = YT.getChannelName(card);
      const channelLower = channelName ? channelName.toLowerCase() : '';

      // Channel blocking
      if (channelLower && blockedChannelNames.has(channelLower)) {
        card.classList.add('cleanfeed-hidden');
        hiddenCount++;
        logHidden(card, 'channel', channelName);
        continue;
      }

      // Keyword blocking
      const title = YT.getVideoTitle(card) || '';
      const desc = YT.getVideoDescription(card);
      let hidden = false;

      for (const kw of blockedKeywords) {
        const keyword = kw.keyword;
        if (matchesKeyword(title, keyword) || matchesKeyword(desc, keyword)) {
          // Check whitelist
          if (isWhitelisted(channelName, keyword)) continue;
          // Check curiosity window
          if (matchesJustNow(title, desc)) continue;

          card.classList.add('cleanfeed-hidden');
          hiddenCount++;
          logHidden(card, 'keyword', keyword);
          hidden = true;
          break;
        }
      }
    }

    if (hiddenCount > 0) {
      sendMsg({ action: 'incrementStat', stat: 'videosHidden', amount: hiddenCount });
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
      '#guide-section-renderer ytd-guide-entry-renderer a[href^="/@"], ' +
      '#sections ytd-guide-entry-renderer a[href^="/@"]'
    );
    for (const entry of sidebarEntries) {
      const name = entry.querySelector('.title')?.textContent?.trim() ||
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
        hideBlockedContent();
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
      attributeFilter: ['style', 'focused_', 'aria-hidden'],
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
        t.includes('segnala')
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
    await sendMsg({ action: 'blockChannel', channelName: name, channelId: id });

    // Close YouTube menu
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        keyCode: 27,
        bubbles: true,
      })
    );

    showToast(msg('blockedToast', [name]));

    blockedChannelNames.add(name.toLowerCase());

    // Clear processed flags and re-filter
    document.querySelectorAll('[data-cf-checked]').forEach((el) => {
      delete el.dataset.cfChecked;
    });
    filterPage();
  }

  // ── Channel Page Button ───────────────────────────────────────────────

  function injectChannelPageButton() {
    const existing = document.querySelector('.cleanfeed-channel-block-btn');

    if (!YT.isChannelPage()) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;

    const channelName = YT.getPageChannelName();
    const channelId = YT.getPageChannelId();
    if (!channelName) return;

    const container = document.querySelector(
      '#subscribe-button, ytd-subscribe-button-renderer, #channel-header-container .buttons-container'
    );
    if (!container) return;

    const btn = cfEl(
      'button',
      {
        className: 'cleanfeed-channel-block-btn',
        onClick: () => handleBlockClick(channelName, channelId),
      },
      [cfLogo(), cfEl('span', { textContent: msg('blockThisChannel') })]
    );

    container.parentNode.insertBefore(btn, container.nextSibling);
  }

  // ── Search Intercept (Interest Boundaries) ────────────────────────────

  function interceptSearch() {
    if (searchIntercepted) return;

    const searchInput = document.querySelector('input#search');
    if (!searchInput) return;

    searchIntercepted = true;

    searchInput.addEventListener('keypress', async (e) => {
      if (e.key !== 'Enter') return;

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
    });
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
