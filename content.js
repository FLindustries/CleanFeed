// CleanFeed Content Script — Runs on YouTube pages
// NOTE: YouTube enforces Trusted Types CSP — all DOM must use createElement/textContent, never innerHTML

let blockedNamesSet = new Set();
let currentSettings = {};
let currentInterests = {};
let isPro = false;
let debounceTimer = null;
let observer = null;
let searchIntercepted = false;
let lastClickedVideoCard = null; // Track which video's menu was opened

// --- Initialization ---

init();

async function init() {
  await loadBlockedChannels();
  await loadSettings();
  filterPage();
  startObserver();
  watchForMenuPopup();
  trackMenuButtonClicks();
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
  // Strategy 1 (2025+ YouTube): channel link with href starting with /@
  const channelLink = element.querySelector('a[href^="/@"]');
  if (channelLink) {
    const text = channelLink.textContent.trim();
    if (text) return text;
  }

  // Strategy 2 (legacy YouTube): various channel name selectors
  const legacySelectors = [
    '#channel-name a',
    'ytd-channel-name a',
    '#text a',
    '.ytd-channel-name a',
    '#channel-name #text',
    'ytd-channel-name #text'
  ];

  for (const selector of legacySelectors) {
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

// --- DOM Helper (Trusted Types safe) ---

function buildElement(tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'className') el.className = value;
      else if (key === 'id') el.id = value;
      else if (key === 'textContent') el.textContent = value;
      else if (key === 'href') el.href = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
      else el.setAttribute(key, value);
    }
  }
  if (children) {
    for (const child of children) {
      if (typeof child === 'string') {
        el.appendChild(document.createTextNode(child));
      } else if (child) {
        el.appendChild(child);
      }
    }
  }
  return el;
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

  // Build interest chips
  const chips = [];
  for (const [key, interest] of Object.entries(currentInterests)) {
    chips.push(
      buildElement('a', {
        className: 'cleanfeed-chip',
        href: '/results?search_query=' + encodeURIComponent(interest.query),
        textContent: interest.query
      })
    );
  }

  const sections = [];

  // Title + subtitle
  sections.push(buildElement('div', { className: 'cleanfeed-search-only-title', textContent: chrome.i18n.getMessage('whatToWatch') }));
  sections.push(buildElement('div', { className: 'cleanfeed-search-only-subtitle', textContent: chrome.i18n.getMessage('searchOnlyActive') }));

  // Interests section (if any)
  if (chips.length > 0) {
    const chipsContainer = buildElement('div', { className: 'cleanfeed-interest-chips' }, chips);
    sections.push(
      buildElement('div', { className: 'cleanfeed-search-only-section' }, [
        buildElement('div', { className: 'cleanfeed-search-only-label', textContent: chrome.i18n.getMessage('yourInterests') }),
        chipsContainer
      ])
    );
  }

  // Quick access section
  sections.push(
    buildElement('div', { className: 'cleanfeed-search-only-section' }, [
      buildElement('div', { className: 'cleanfeed-search-only-label', textContent: chrome.i18n.getMessage('quickAccess') }),
      buildElement('div', { className: 'cleanfeed-quick-links' }, [
        buildElement('a', { className: 'cleanfeed-quick-link', href: '/feed/subscriptions', textContent: chrome.i18n.getMessage('subscriptions') }),
        buildElement('a', { className: 'cleanfeed-quick-link', href: '/feed/history', textContent: chrome.i18n.getMessage('history') })
      ])
    ])
  );

  const overlay = buildElement('div', { id: 'cleanfeed-search-only', className: 'cleanfeed-search-only' }, sections);

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
  const menuObserver = new MutationObserver(() => {
    // New YouTube (2025+): yt-sheet-view-model inside tp-yt-iron-dropdown
    const sheetMenu = document.querySelector('tp-yt-iron-dropdown yt-sheet-view-model');
    if (sheetMenu) {
      injectBlockOptionNew(sheetMenu);
      return;
    }

    // Legacy YouTube: ytd-menu-popup-renderer
    const legacyPopup = document.querySelector('ytd-popup-container ytd-menu-popup-renderer');
    if (legacyPopup) {
      injectBlockOptionLegacy(legacyPopup);
    }
  });

  menuObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'focused_', 'aria-hidden']
  });
}

function createBlockMenuItem(channelInfo) {
  const logo = buildElement('div', { className: 'cleanfeed-cf-logo', textContent: 'CF' });
  const label = buildElement('span', { textContent: chrome.i18n.getMessage('blockChannelPermanently') });

  const blockItem = buildElement('div', {
    className: 'cleanfeed-menu-item',
    role: 'menuitem',
    onClick: async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await handleBlockClick(channelInfo);
    }
  }, [logo, label]);

  return blockItem;
}

// New YouTube menu structure (2025+)
function injectBlockOptionNew(sheetMenu) {
  if (sheetMenu.querySelector('.cleanfeed-menu-item')) return;

  const listbox = sheetMenu.querySelector('yt-list-view-model[role="listbox"]');
  if (!listbox) return;

  const menuItems = listbox.querySelectorAll('yt-list-item-view-model[role="menuitem"]');
  if (menuItems.length === 0) return;

  // Verify it's a video context menu
  const hasRelevantItem = Array.from(menuItems).some(item => {
    const text = item.textContent?.trim().toLowerCase() || '';
    return text.includes('non mi interessa') || text.includes('not interested') ||
           text.includes('non consigliare') || text.includes("don't recommend") ||
           text.includes('segnala') || text.includes('report');
  });
  if (!hasRelevantItem) return;

  const channelInfo = findChannelForActiveMenu();
  const separator = buildElement('div', { className: 'cleanfeed-menu-separator' });
  const blockItem = createBlockMenuItem(channelInfo);

  // Insert after "Non consigliare il canale" / "Don't recommend channel"
  let insertAfter = null;
  for (const item of menuItems) {
    const text = item.textContent?.trim().toLowerCase() || '';
    if (text.includes('non consigliare') || text.includes("don't recommend")) {
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

// Legacy YouTube menu structure
function injectBlockOptionLegacy(popup) {
  if (popup.querySelector('.cleanfeed-menu-item')) return;

  const listbox = popup.querySelector('tp-yt-paper-listbox') || popup.querySelector('#items');
  if (!listbox) return;

  const channelInfo = findChannelForActiveMenu();
  const separator = buildElement('div', { className: 'cleanfeed-menu-separator' });
  const blockItem = createBlockMenuItem(channelInfo);

  const menuItems = listbox.querySelectorAll('ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer');
  let insertAfter = null;
  for (const item of menuItems) {
    const text = item.textContent?.trim().toLowerCase() || '';
    if (text.includes("don't recommend") || text.includes('non consigliare')) {
      insertAfter = item;
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

// Shared click handler for both menu versions
async function handleBlockClick(channelInfo) {
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
    showToast('"' + name + '" is already blocked.');
  }
}

// Track clicks on YouTube's three-dot menu buttons to know which video triggered the menu
function trackMenuButtonClicks() {
  document.addEventListener('click', (e) => {
    const videoSelectors = 'ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer';
    // Check if the click was on a menu button (three-dot icon) inside a video card
    const button = e.target.closest('button, yt-icon-button, ytd-menu-renderer');
    if (button) {
      const card = button.closest(videoSelectors);
      if (card) {
        lastClickedVideoCard = card;
      }
    }
  }, true); // capture phase to run before YouTube's handlers
}

function findChannelForActiveMenu() {
  const videoSelectors = 'ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer';

  // Strategy 1: use the tracked video card from the click event
  let videoCard = lastClickedVideoCard;

  // Strategy 2: activeElement might be inside the video card
  if (!videoCard) {
    videoCard = document.activeElement?.closest(videoSelectors);
  }

  if (videoCard) {
    const name = extractChannelName(videoCard);
    const linkEl = videoCard.querySelector('a[href^="/@"], #channel-name a, ytd-channel-name a');
    const href = linkEl?.getAttribute('href') || '';
    const idMatch = href.match(/\/(channel|c|user|@)([^\/\?]+)/);
    const id = idMatch ? idMatch[2] : null;
    return name ? { name, id } : null;
  }

  return null;
}

function findChannelNameFromPage() {
  // Try new YouTube DOM first, then legacy
  const selectors = [
    'ytd-video-owner-renderer a[href^="/@"]',
    'ytd-channel-name.ytd-video-owner-renderer a',
    '#owner #channel-name a'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = el.textContent.trim();
      if (text) return text;
    }
  }
  return null;
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

function createPromptButtons(query, userIsPro, onDismiss) {
  const onceBtn = buildElement('button', {
    className: 'cleanfeed-btn cleanfeed-btn-secondary',
    textContent: chrome.i18n.getMessage('justOnce'),
    onClick: onDismiss
  });

  const rememberBtn = buildElement('button', {
    className: 'cleanfeed-btn cleanfeed-btn-primary',
    textContent: chrome.i18n.getMessage('remember'),
    onClick: async () => {
      if (!userIsPro) {
        onDismiss();
        chrome.runtime.sendMessage({ action: 'openPaymentPage' });
        return;
      }
      await chrome.runtime.sendMessage({ action: 'addInterest', query });
      onDismiss();
      showToast('Added "' + query + '" to your interests');
    }
  });

  return buildElement('div', { className: 'cleanfeed-toast-buttons' }, [onceBtn, rememberBtn]);
}

function showInterestToast(query, userIsPro) {
  document.querySelector('.cleanfeed-toast')?.remove();

  const brandSpan = buildElement('span', { className: 'cleanfeed-toast-brand', textContent: 'CleanFeed' });
  const msgText = ' — ' + chrome.i18n.getMessage('newSearch', [query]);
  const textDiv = buildElement('div', { className: 'cleanfeed-toast-text' }, [brandSpan, msgText]);

  const toast = buildElement('div', { className: 'cleanfeed-toast' });
  const buttons = createPromptButtons(query, userIsPro, () => dismissToast(toast));

  toast.appendChild(textDiv);
  toast.appendChild(buttons);
  document.body.appendChild(toast);

  setTimeout(() => dismissToast(toast), 8000);
}

function showInlineBanner(query, userIsPro) {
  document.querySelector('.cleanfeed-inline-banner')?.remove();

  const logo = buildElement('div', { className: 'cleanfeed-cf-logo', textContent: 'CF' });
  const strong = buildElement('strong', { textContent: chrome.i18n.getMessage('newSearch', [query]) });
  const br = document.createElement('br');
  const subtitle = buildElement('span', { textContent: chrome.i18n.getMessage('rememberInterest') });
  const textDiv = buildElement('div', { className: 'cleanfeed-inline-banner-text' }, [strong, br, subtitle]);
  const content = buildElement('div', { className: 'cleanfeed-inline-banner-content' }, [logo, textDiv]);

  const banner = buildElement('div', { className: 'cleanfeed-inline-banner' });
  const buttons = createPromptButtons(query, userIsPro, () => banner.remove());

  banner.appendChild(content);
  banner.appendChild(buttons);

  const results = document.querySelector('ytd-section-list-renderer, ytd-search');
  if (results) {
    results.parentNode.insertBefore(banner, results);
  }

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

  const textDiv = buildElement('div', { className: 'cleanfeed-toast-text', textContent: message });
  const toast = buildElement('div', { className: 'cleanfeed-toast' }, [textDiv]);

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
