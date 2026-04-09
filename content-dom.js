// CleanFeed DOM Helpers
// YouTube enforces Trusted Types CSP — never use innerHTML.
// All DOM creation goes through these helpers.

function cfEl(tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'className') el.className = value;
      else if (key === 'id') el.id = value;
      else if (key === 'textContent') el.textContent = value;
      else if (key === 'href') el.href = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      }
      else el.setAttribute(key, value);
    }
  }
  if (children) {
    for (const child of children) {
      if (typeof child === 'string') el.appendChild(document.createTextNode(child));
      else if (child) el.appendChild(child);
    }
  }
  return el;
}

// --- YouTube 2025 Selectors ---

const YT = {
  VIDEO_CARDS: 'ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer',

  getChannelName(videoCard) {
    const link2025 = videoCard.querySelector('a[href^="/@"]');
    if (link2025) {
      const text = link2025.textContent.trim();
      if (text) return text;
    }
    const legacySelectors = [
      '#channel-name a', 'ytd-channel-name a', '#text a',
      '.ytd-channel-name a', '#channel-name #text', 'ytd-channel-name #text'
    ];
    for (const sel of legacySelectors) {
      const el = videoCard.querySelector(sel);
      if (el) {
        const text = el.textContent.trim();
        if (text) return text;
      }
    }
    return null;
  },

  getChannelId(videoCard) {
    const link = videoCard.querySelector('a[href^="/@"], #channel-name a, ytd-channel-name a');
    const href = link?.getAttribute('href') || '';
    const match = href.match(/\/(channel|c|user|@)([^\/\?]+)/);
    return match ? match[2] : null;
  },

  getVideoTitle(videoCard) {
    const selectors = [
      '#video-title',
      'h3 .yt-core-attributed-string',
      '.ytd-video-renderer #video-title'
    ];
    for (const sel of selectors) {
      const el = videoCard.querySelector(sel);
      if (el) {
        const text = el.textContent.trim();
        if (text) return text;
      }
    }
    return null;
  },

  getVideoDescription(videoCard) {
    const selectors = [
      '.metadata-snippet-text',
      '#description-text',
      '.ytd-video-renderer .metadata-snippet-container'
    ];
    for (const sel of selectors) {
      const el = videoCard.querySelector(sel);
      if (el) {
        const text = el.textContent.trim();
        if (text) return text;
      }
    }
    return '';
  },

  getPageChannelName() {
    // On channel pages, extract from URL as fallback
    const selectors = [
      'ytd-video-owner-renderer a[href^="/@"]',
      'ytd-channel-name.ytd-video-owner-renderer a',
      '#owner #channel-name a',
      '#channel-header ytd-channel-name a',
      'yt-dynamic-text-view-model.ytChannelNameViewModelHost',
      // 2025 channel page selectors
      'ytd-c4-tabbed-header-renderer #channel-name',
      'ytd-c4-tabbed-header-renderer #text',
      '#page-header yt-dynamic-text-view-model',
      '#inner-header-container yt-formatted-string#text',
      'ytd-c4-tabbed-header-renderer ytd-channel-name yt-formatted-string',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = el.textContent.trim();
        if (text) return text;
      }
    }
    // Fallback: extract from URL path
    const pathMatch = window.location.pathname.match(/^\/@(.+)/);
    if (pathMatch) return decodeURIComponent(pathMatch[1]);
    return null;
  },

  getPageChannelId() {
    const link = document.querySelector(
      'ytd-video-owner-renderer a[href^="/@"], #channel-header a[href^="/@"], ytd-c4-tabbed-header-renderer a[href^="/@"]'
    );
    const href = link?.getAttribute('href') || '';
    const match = href.match(/@([^\/\?]+)/);
    if (match) return '@' + match[1];
    // Fallback: extract from URL
    const pathMatch = window.location.pathname.match(/^\/@(.+)/);
    if (pathMatch) return '@' + pathMatch[1];
    const channelMatch = window.location.pathname.match(/\/channel\/(.+)/);
    if (channelMatch) return channelMatch[1];
    return null;
  },

  isChannelPage() {
    // URL-based check
    if (/^\/@|^\/channel\/|^\/c\/|^\/user\//.test(window.location.pathname)) return true;
    // DOM-based check (YouTube sometimes redirects /@name to /name)
    if (document.querySelector('ytd-c4-tabbed-header-renderer, #channel-header, ytd-browse[page-subtype="channels"]')) return true;
    return false;
  },

  getMenuPopup() {
    // Check for visible/open popups — YouTube may have multiple tp-yt-iron-dropdown
    // but only the one with display!=none or the [aria-expanded] one is active
    const dropdowns = document.querySelectorAll('tp-yt-iron-dropdown');
    for (const dd of dropdowns) {
      // Skip hidden dropdowns
      const style = window.getComputedStyle(dd);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const sheet = dd.querySelector('yt-sheet-view-model');
      if (sheet) return sheet;
    }
    return document.querySelector('ytd-popup-container ytd-menu-popup-renderer[style*="display"]') ||
           document.querySelector('ytd-popup-container ytd-menu-popup-renderer');
  },

  getMenuListbox(popup) {
    return popup.querySelector('yt-list-view-model[role="listbox"]') ||
           popup.querySelector('tp-yt-paper-listbox') ||
           popup.querySelector('#items');
  },

  getMenuItems(listbox) {
    return listbox.querySelectorAll(
      'yt-list-item-view-model[role="menuitem"], ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer'
    );
  }
};

// --- Keyword Matching ---

function matchesKeyword(text, keyword) {
  if (!text || !keyword) return false;
  const lowerText = text.toLowerCase();
  const lowerKw = keyword.toLowerCase();

  if (lowerKw.length < 4) {
    const regex = new RegExp('\\b' + lowerKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    return regex.test(lowerText);
  }
  return lowerText.includes(lowerKw);
}
