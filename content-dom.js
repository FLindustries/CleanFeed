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
  VIDEO_CARDS: 'ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-playlist-renderer, ytd-reel-item-renderer, yt-lockup-view-model',

  getChannelName(videoCard) {
    // Try ALL /@handle links — the first may be the avatar (no text)
    const links2025 = videoCard.querySelectorAll('a[href^="/@"]');
    for (const link of links2025) {
      const text = link.textContent.trim();
      if (text) return text;
    }
    const legacySelectors = [
      '#channel-name a', 'ytd-channel-name a', '#text a',
      '.ytd-channel-name a', '#channel-name #text', 'ytd-channel-name #text',
    ];
    for (const sel of legacySelectors) {
      const el = videoCard.querySelector(sel);
      if (el) {
        const text = el.textContent.trim();
        if (text) return text;
      }
    }

    // 2025-2026 sidebar: yt-lockup-metadata-view-model renders channel as
    // plain text spans, not clickable links. Look for metadata text elements
    // that appear AFTER the title (the second line of text in the card).
    const metadataTexts = videoCard.querySelectorAll(
      '.yt-content-metadata-view-model-wiz__metadata-text, ' +
      'yt-content-metadata-view-model span, ' +
      '.yt-lockup-metadata-view-model-wiz__metadata span'
    );
    for (const el of metadataTexts) {
      const text = el.textContent.trim();
      // Channel names are short and don't contain view counts or dates
      if (text && text.length < 60 && !text.match(/\d+[KMB]?\s*(view|visualizz|visu)/i) &&
          !text.match(/\d+\s*(hour|day|week|month|year|or[ea]|giorn|settiman|mes)/i)) {
        return text;
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
      '#video-title-link',
      'h3 a',
      'h3 yt-formatted-string',
      'h3',
      'h3 .yt-core-attributed-string',
      '.ytd-video-renderer #video-title',
      // 2025-2026 lockup view model (watch page sidebar)
      'yt-lockup-metadata-view-model h3',
      'yt-lockup-metadata-view-model .yt-lockup-metadata-view-model-wiz__title',
      'yt-lockup-metadata-view-model yt-formatted-string',
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
    // YouTube uses TWO different popup styles depending on context:
    // 1. Homepage/search: tp-yt-iron-dropdown > yt-sheet-view-model > yt-list-view-model
    // 2. Watch page sidebar: tp-yt-iron-dropdown > ytd-menu-popup-renderer > tp-yt-paper-listbox
    // We detect BOTH and return the visible/active one.

    // Strategy 1: Check all iron-dropdown overlays
    const dropdowns = document.querySelectorAll('tp-yt-iron-dropdown');
    for (const dd of dropdowns) {
      // Skip definitely hidden dropdowns
      if (dd.hasAttribute('aria-hidden') && dd.getAttribute('aria-hidden') === 'true') continue;
      const style = window.getComputedStyle(dd);
      if (style.display === 'none') continue;

      // New sheet-based popup (homepage, search, some watch pages)
      const sheet = dd.querySelector('yt-sheet-view-model');
      if (sheet) return sheet;

      // Legacy popup renderer (watch page sidebar)
      const menuPopup = dd.querySelector('ytd-menu-popup-renderer');
      if (menuPopup) return menuPopup;
    }

    // Strategy 2: Check popup container directly (catches edge cases)
    const popupContainer = document.querySelector('ytd-popup-container');
    if (popupContainer) {
      // Check for any visible popup renderer
      const popups = popupContainer.querySelectorAll('ytd-menu-popup-renderer');
      for (let i = popups.length - 1; i >= 0; i--) {
        const p = popups[i];
        const style = window.getComputedStyle(p);
        if (style.display !== 'none') return p;
      }
      // Also check for iron-dropdown directly under popup container
      const dd = popupContainer.querySelector('tp-yt-iron-dropdown:not([aria-hidden="true"])');
      if (dd) {
        const sheet = dd.querySelector('yt-sheet-view-model');
        if (sheet) return sheet;
        const mp = dd.querySelector('ytd-menu-popup-renderer');
        if (mp) return mp;
      }
    }

    return null;
  },

  getMenuListbox(popup) {
    return popup.querySelector('yt-list-view-model[role="listbox"]') ||
           popup.querySelector('yt-list-view-model') ||
           popup.querySelector('tp-yt-paper-listbox') ||
           popup.querySelector('#items');
  },

  getMenuItems(listbox) {
    return listbox.querySelectorAll(
      'yt-list-item-view-model[role="menuitem"], yt-list-item-view-model, ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer'
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

// --- Keyword Synonym Map ---
// When a user blocks "crypto", we also block "bitcoin", "ethereum", etc.
// This turns literal keyword blocking into topic-level blocking.

const KEYWORD_SYNONYMS = {
  crypto: ['bitcoin', 'ethereum', 'blockchain', 'solana', 'nft', 'defi', 'binance', 'coinbase', 'altcoin', 'web3', 'dogecoin', 'shiba inu', 'trading crypto', 'criptovalute', 'criptovaluta'],
  gambling: ['casino', 'slot', 'poker', 'betting', 'scommesse', 'roulette', 'blackjack', 'stake', 'slot machine'],
  politics: ['politica', 'election', 'elezioni', 'trump', 'biden', 'parliament', 'parlamento', 'democrat', 'republican', 'sinistra', 'destra', 'governo', 'senato'],
  gossip: ['drama', 'tea', 'exposed', 'scandalo', 'pettegolezzo', 'beef', 'cancelled', 'drammatico'],
  asmr: ['whisper', 'tingles', 'soft spoken', 'mouth sounds', 'tapping asmr'],
  mukbang: ['eating show', 'food challenge', 'eating challenge', 'mangiata'],
  pranks: ['prank', 'scherzo', 'scherzi', 'candid camera', 'social experiment'],
  astrology: ['astrologia', 'horoscope', 'oroscopo', 'zodiac', 'zodiaco', 'tarot', 'tarocchi', 'segno zodiacale'],
  conspiracy: ['complotto', 'complottismo', 'flat earth', 'terra piatta', 'illuminati', 'new world order', 'qanon', 'no vax'],
  nsfw: ['onlyfans', 'thirst trap', 'hot tub', 'bikini haul', 'try on haul', 'lingerie', 'sexy'],
  clickbait: ['you wont believe', 'non crederai', 'gone wrong', 'shocking', 'jaw dropping', 'incredibile'],
  gaming: ['gameplay', 'walkthrough', 'playthrough', 'lets play', 'speedrun', 'esports', 'twitch', 'fortnite', 'minecraft', 'gta', 'call of duty', 'valorant', 'league of legends', 'elden ring', 'dark souls', 'ps5', 'xbox', 'nintendo', 'videogiochi', 'videogioco', 'gamer', 'boss fight', 'dead space', 'system shock', 'resident evil', 'death stranding', 'cyberpunk', 'zelda', 'mario', 'pokemon', 'apex legends', 'overwatch', 'destiny', 'halo', 'god of war', 'final fantasy', 'remake', 'remaster', 'dlc', 'steam', 'epic games', 'playstation', 'rpg', 'mmorpg', 'game', 'games', 'giochi', 'gioco', 'sala giochi', 'video game', 'pc gaming', 'mass effect', 'bioware', 'mr beast gaming', 'roblox', 'among us', 'tetris'],
  kpop: ['k-pop', 'bts', 'blackpink', 'stray kids', 'twice', 'aespa', 'enhypen', 'seventeen', 'k pop'],
  anime: ['manga', 'otaku', 'one piece', 'naruto', 'demon slayer', 'jujutsu kaisen', 'attack on titan', 'dragon ball', 'shonen', 'crunchyroll'],
  diet: ['weight loss', 'dimagrire', 'perdere peso', 'calorie deficit', 'keto', 'intermittent fasting', 'digiuno', 'dieta'],
  hustle: ['side hustle', 'passive income', 'reddito passivo', 'dropshipping', 'affiliate marketing', 'make money online', 'guadagnare online', 'soldi facili'],
  horror: ['creepypasta', 'scary', 'paura', 'terrore', 'jump scare', 'horror story'],
  true_crime: ['true crime', 'murder', 'omicidio', 'serial killer', 'cold case', 'crime documentary', 'caso irrisolto', 'cronaca nera'],
  reaction: ['reaction video', 'reacting to', 'first time watching', 'reagisco', 'la mia reazione'],
  unboxing: ['unboxing', 'haul', 'shopping haul', 'what i bought', 'cosa ho comprato']
};

// disabledSynonymsSet and customSynonymsMap are set by the content script
// from applyState(). They filter/extend the synonym expansion.
let _cfDisabledSynonyms = new Set();
let _cfCustomSynonyms = {};

function cfSetSynonymFilters(disabledArray, customObj) {
  _cfDisabledSynonyms = new Set((disabledArray || []).map(s => s.toLowerCase()));
  _cfCustomSynonyms = customObj || {};
}

function getExpandedKeywords(keyword) {
  const lower = keyword.toLowerCase();
  for (const [category, synonyms] of Object.entries(KEYWORD_SYNONYMS)) {
    if (lower === category || synonyms.includes(lower)) {
      // Start with built-in synonyms, filter out disabled ones
      const expanded = [category, ...synonyms].filter(s => !_cfDisabledSynonyms.has(s));
      // Add custom synonyms for this category
      const customs = _cfCustomSynonyms[category] || [];
      for (const cs of customs) {
        if (!expanded.includes(cs) && !_cfDisabledSynonyms.has(cs)) {
          expanded.push(cs);
        }
      }
      return expanded;
    }
  }
  return [lower];
}
