// CleanFeed Content Script — Runs on YouTube pages

let blockedNamesSet = new Set();
let currentSettings = {};
let currentInterests = {};
let isPro = false;
let debounceTimer = null;
let observer = null;
let searchIntercepted = false;

// --- Initialization ---

init();

async function init() {
  await loadBlockedChannels();
  await loadSettings();
  filterPage();
  startObserver();
  watchForMenuPopup();
  interceptSearch();

  // Re-check on YouTube SPA navigation
  window.addEventListener('yt-navigate-finish', async () => {
    await loadSettings();
    filterPage();
    interceptSearch();
  });
}

// --- Load Data ---

async function loadBlockedChannels() {
  const response = await chrome.runtime.sendMessage({ action: 'getBlockedSet' });
  blockedNamesSet = new Set(response.blockedNames || []);
}

async function loadSettings() {
  const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
  currentSettings = response.settings || {};
  currentInterests = response.interests || {};
  isPro = response.isPro || false;
}

// --- DOM Filtering ---

function filterPage() {
  if (currentSettings.searchOnlyMode) {
    showSearchOnlyMode();
  } else {
    removeSearchOnlyMode();
  }
  hideBlockedChannels();
}

function hideBlockedChannels() {
  if (blockedNamesSet.size === 0) return;

  const videoSelectors = [
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-rich-item-renderer',
    'ytd-compact-video-renderer',
    'ytd-playlist-video-renderer',
    'ytd-reel-item-renderer'
  ];

  let hiddenCount = 0;

  for (const selector of videoSelectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      if (el.classList.contains('cleanfeed-hidden')) continue;
      if (el.dataset.cleanfeedChecked === 'true') continue;

      const channelName = extractChannelName(el);
      el.dataset.cleanfeedChecked = 'true';

      if (channelName && blockedNamesSet.has(channelName.toLowerCase())) {
        el.classList.add('cleanfeed-hidden');
        hiddenCount++;
      }
    }
  }

  // Also hide channel results in search
  document.querySelectorAll('ytd-channel-renderer').forEach(el => {
    if (el.classList.contains('cleanfeed-hidden')) return;
    const name = el.querySelector('#channel-title')?.textContent?.trim();
    if (name && blockedNamesSet.has(name.toLowerCase())) {
      el.classList.add('cleanfeed-hidden');
      hiddenCount++;
    }
  });

  // Increment stat by actual count of hidden videos
  for (let i = 0; i < hiddenCount; i++) {
    chrome.runtime.sendMessage({ action: 'incrementStat', stat: 'videosHidden' });
  }
}

function extractChannelName(element) {
  const selectors = [
    '#channel-name a',
    'ytd-channel-name a',
    '#text a',
    '.ytd-channel-name a',
    '#channel-name #text',
    'ytd-channel-name #text'
  ];

  for (const selector of selectors) {
    const el = element.querySelector(selector);
    if (el) {
      const text = el.textContent.trim();
      if (text) return text;
    }
  }
  return null;
}

// --- MutationObserver (debounced) ---

function startObserver() {
  if (observer) observer.disconnect();

  observer = new MutationObserver(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => filterPage(), 200);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// --- Search-Only Mode ---

function showSearchOnlyMode() {
  const isHomePage = window.location.pathname === '/' ||
                     window.location.pathname === '/feed/trending' ||
                     window.location.pathname === '/feed/explore';

  if (!isHomePage) {
    removeSearchOnlyMode();
    return;
  }

  // Hide the feed
  const feed = document.querySelector('ytd-browse');
  if (feed) feed.classList.add('cleanfeed-hidden');

  // Don't create overlay twice
  if (document.getElementById('cleanfeed-search-only')) return;

  const overlay = document.createElement('div');
  overlay.id = 'cleanfeed-search-only';
  overlay.className = 'cleanfeed-search-only';

  // Build interest chips
  let chipsHtml = '';
  for (const [key, interest] of Object.entries(currentInterests)) {
    const query = escapeHtml(interest.query);
    chipsHtml += `<a class="cleanfeed-chip" href="/results?search_query=${encodeURIComponent(interest.query)}">${query}</a>`;
  }

  const interestsSection = Object.keys(currentInterests).length > 0
    ? `<div class="cleanfeed-search-only-section">
         <div class="cleanfeed-search-only-label">${chrome.i18n.getMessage('yourInterests')}</div>
         <div class="cleanfeed-interest-chips">${chipsHtml}</div>
       </div>`
    : '';

  overlay.innerHTML = `
    <div class="cleanfeed-search-only-title">${chrome.i18n.getMessage('whatToWatch')}</div>
    <div class="cleanfeed-search-only-subtitle">${chrome.i18n.getMessage('searchOnlyActive')}</div>
    ${interestsSection}
    <div class="cleanfeed-search-only-section">
      <div class="cleanfeed-search-only-label">${chrome.i18n.getMessage('quickAccess')}</div>
      <div class="cleanfeed-quick-links">
        <a class="cleanfeed-quick-link" href="/feed/subscriptions">${chrome.i18n.getMessage('subscriptions')}</a>
        <a class="cleanfeed-quick-link" href="/feed/history">${chrome.i18n.getMessage('history')}</a>
      </div>
    </div>
  `;

  // Insert after the header
  const pageManager = document.querySelector('ytd-page-manager');
  if (pageManager) {
    pageManager.prepend(overlay);
  } else {
    document.body.appendChild(overlay);
  }
}

function removeSearchOnlyMode() {
  const overlay = document.getElementById('cleanfeed-search-only');
  if (overlay) overlay.remove();

  const feed = document.querySelector('ytd-browse');
  if (feed) feed.classList.remove('cleanfeed-hidden');
}

// --- YouTube Menu Injection ---

function watchForMenuPopup() {
  const menuObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const popup = node.tagName === 'YTD-MENU-POPUP-RENDERER'
          ? node
          : node.querySelector?.('ytd-menu-popup-renderer');
        if (popup) {
          injectBlockOption(popup);
        }
      }
    }
  });

  menuObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function injectBlockOption(popup) {
  // Don't inject twice
  if (popup.querySelector('.cleanfeed-menu-item')) return;

  const listbox = popup.querySelector('tp-yt-paper-listbox') ||
                  popup.querySelector('#items');
  if (!listbox) return;

  const channelInfo = findChannelForActiveMenu();

  // Create separator
  const separator = document.createElement('div');
  separator.className = 'cleanfeed-menu-separator';

  // Create block option
  const blockItem = document.createElement('div');
  blockItem.className = 'cleanfeed-menu-item';
  blockItem.innerHTML = `
    <div class="cleanfeed-cf-logo">CF</div>
    <span>${chrome.i18n.getMessage('blockChannelPermanently')}</span>
  `;

  blockItem.addEventListener('click', async (e) => {
    e.stopPropagation();

    const name = channelInfo?.name || findChannelNameFromPage();
    const id = channelInfo?.id || null;

    if (!name) {
      showToast('Could not detect channel name. Try from a different page.');
      closeYouTubeMenu();
      return;
    }

    const result = await chrome.runtime.sendMessage({
      action: 'blockChannel',
      channelName: name,
      channelId: id
    });

    closeYouTubeMenu();

    if (result.success) {
      showToast(chrome.i18n.getMessage('blockedToast', [name]));
      blockedNamesSet.add(name.toLowerCase());
      filterPage();
    } else if (result.reason === 'free_limit') {
      showToast(chrome.i18n.getMessage('freeLimitToast'));
      setTimeout(() => {
        chrome.runtime.sendMessage({ action: 'openPaymentPage' });
      }, 2000);
    } else if (result.reason === 'already_blocked') {
      showToast(`"${name}" is already blocked.`);
    }
  });

  // Try to insert after "Don't recommend channel" option
  const menuItems = listbox.querySelectorAll('ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer');
  let insertAfter = null;
  for (const item of menuItems) {
    const text = item.textContent?.trim().toLowerCase() || '';
    if (text.includes("don't recommend") || text.includes('not interested')) {
      insertAfter = item;
    }
  }

  if (insertAfter && insertAfter.nextSibling) {
    listbox.insertBefore(separator, insertAfter.nextSibling);
    listbox.insertBefore(blockItem, separator.nextSibling);
  } else {
    // Fallback: append to end
    listbox.appendChild(separator);
    listbox.appendChild(blockItem);
  }
}

function findChannelForActiveMenu() {
  const triggerBtn = document.activeElement?.closest(
    'ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer'
  );

  if (triggerBtn) {
    const name = extractChannelName(triggerBtn);
    const linkEl = triggerBtn.querySelector('#channel-name a, ytd-channel-name a');
    const href = linkEl?.href || '';
    const idMatch = href.match(/\/(channel|c|user|@)([^\/\?]+)/);
    const id = idMatch ? idMatch[2] : null;
    return name ? { name, id } : null;
  }

  return null;
}

function findChannelNameFromPage() {
  const channelHeader = document.querySelector('ytd-channel-name.ytd-video-owner-renderer a');
  return channelHeader?.textContent?.trim() || null;
}

function closeYouTubeMenu() {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', keyCode: 27, bubbles: true
  }));
}

// --- Interest Boundaries ---

function interceptSearch() {
  if (searchIntercepted) return;

  const searchBox = document.querySelector('input#search');
  if (!searchBox) return;

  searchIntercepted = true;

  searchBox.addEventListener('keypress', async (e) => {
    if (e.key !== 'Enter') return;

    const query = searchBox.value.trim();
    if (!query) return;

    const response = await chrome.runtime.sendMessage({
      action: 'checkInterest',
      query
    });

    if (response.shouldPrompt) {
      setTimeout(() => {
        if (response.useInlineBanner) {
          showInlineBanner(query, response.isPro);
        } else {
          showInterestToast(query, response.isPro);
        }
      }, 500);
    }
  });
}

function showInterestToast(query, userIsPro) {
  document.querySelector('.cleanfeed-toast')?.remove();

  const toast = document.createElement('div');
  toast.className = 'cleanfeed-toast';
  toast.innerHTML = `
    <div class="cleanfeed-toast-text">
      <span class="cleanfeed-toast-brand">CleanFeed</span> —
      ${chrome.i18n.getMessage('newSearch', [escapeHtml(query)])}
    </div>
    <div class="cleanfeed-toast-buttons">
      <button class="cleanfeed-btn cleanfeed-btn-secondary" data-action="once">
        ${chrome.i18n.getMessage('justOnce')}
      </button>
      <button class="cleanfeed-btn cleanfeed-btn-primary" data-action="remember">
        ${chrome.i18n.getMessage('remember')}
      </button>
    </div>
  `;

  document.body.appendChild(toast);

  toast.querySelector('[data-action="once"]').addEventListener('click', () => {
    dismissToast(toast);
  });

  toast.querySelector('[data-action="remember"]').addEventListener('click', async () => {
    if (!userIsPro) {
      dismissToast(toast);
      chrome.runtime.sendMessage({ action: 'openPaymentPage' });
      return;
    }
    await chrome.runtime.sendMessage({ action: 'addInterest', query });
    dismissToast(toast);
    showToast(`Added "${query}" to your interests`);
  });

  setTimeout(() => dismissToast(toast), 8000);
}

function showInlineBanner(query, userIsPro) {
  document.querySelector('.cleanfeed-inline-banner')?.remove();

  const banner = document.createElement('div');
  banner.className = 'cleanfeed-inline-banner';
  banner.innerHTML = `
    <div class="cleanfeed-inline-banner-content">
      <div class="cleanfeed-cf-logo">CF</div>
      <div class="cleanfeed-inline-banner-text">
        <strong>${chrome.i18n.getMessage('newSearch', [escapeHtml(query)])}</strong>
        <br>
        <span>${chrome.i18n.getMessage('rememberInterest')}</span>
      </div>
    </div>
    <div class="cleanfeed-toast-buttons">
      <button class="cleanfeed-btn cleanfeed-btn-secondary" data-action="once">
        ${chrome.i18n.getMessage('justOnce')}
      </button>
      <button class="cleanfeed-btn cleanfeed-btn-primary" data-action="remember">
        ${chrome.i18n.getMessage('remember')}
      </button>
    </div>
  `;

  const results = document.querySelector('ytd-section-list-renderer, ytd-search');
  if (results) {
    results.parentNode.insertBefore(banner, results);
  }

  banner.querySelector('[data-action="once"]').addEventListener('click', () => {
    banner.remove();
  });

  banner.querySelector('[data-action="remember"]').addEventListener('click', async () => {
    if (!userIsPro) {
      banner.remove();
      chrome.runtime.sendMessage({ action: 'openPaymentPage' });
      return;
    }
    await chrome.runtime.sendMessage({ action: 'addInterest', query });
    banner.remove();
    showToast(`Added "${query}" to your interests`);
  });

  setTimeout(() => banner.remove(), 10000);
}

function dismissToast(toast) {
  if (!toast || !toast.parentNode) return;
  toast.classList.add('cleanfeed-toast-exit');
  setTimeout(() => toast.remove(), 300);
}

// --- Toast Notifications ---

function showToast(message, duration = 4000) {
  document.querySelector('.cleanfeed-toast')?.remove();

  const toast = document.createElement('div');
  toast.className = 'cleanfeed-toast';
  toast.innerHTML = `
    <div class="cleanfeed-toast-text">${escapeHtml(message)}</div>
  `;

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('cleanfeed-toast-exit');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// --- Utilities ---

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// --- Storage Change Listener ---

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.blockedChannels) {
    await loadBlockedChannels();
    document.querySelectorAll('[data-cleanfeed-checked]').forEach(el => {
      delete el.dataset.cleanfeedChecked;
    });
  }
  if (changes.settings || changes.interests) {
    await loadSettings();
  }
  filterPage();
});
