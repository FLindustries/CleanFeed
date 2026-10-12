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

// Validates a string as a plausible channel name. YouTube's metadata spans
// can contain separators ("•", "·"), view counts ("1 Mln di visualizzazioni"),
// dates ("3 giorni fa"), or the channel's own dot — none of which are real
// channel names. Without this filter, getChannelName() returned garbage like
// "•" which then got auto-tagged for keyword categories and silently blocked
// the entire YouTube grid.
function isValidChannelName(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 2 || t.length > 60) return false;
  // Need at least one Latin letter (excludes pure separators "•", "·", "-")
  if (!/[a-zA-ZÀ-ſ]/.test(t)) return false;
  // Reject view counts — multilingual
  if (/\b(views?|visualizz|visitas|vues|aufrufe|просмотр)/i.test(t)) return false;
  if (/^\d+[\s ]*[KMB]\b/i.test(t)) return false; // "1.5K", "2M"
  if (/\b(mln|mila|miliard|migl)\b/i.test(t)) return false; // Italian short forms
  // Reject date strings
  if (/\b\d+\s*(hour|day|week|month|year|sec|min|or[ea]|giorn|settiman|mes|anno|anni|fa)\b/i.test(t)) return false;
  if (/\b(ago|fa)$/i.test(t)) return false;
  return true;
}

// --- YouTube 2025 Selectors ---

// Shorts items outside the /shorts player (search-result Shorts shelves, a
// channel's Shorts shelf). YouTube renders each one as
// ytm-shorts-lockup-view-model inside a ytm-shorts-lockup-view-model-v2
// wrapper (observed 2026-10-12): title in h3, links to /shorts/<id>, usually
// no channel. Only one element of the pair matches, so every Short is checked
// and counted once; the inner element matches only when it has no wrapper.
// Neither matches inside ytd-rich-item-renderer (a channel's Shorts tab, the
// Home Shorts shelf): that is already a card, and a second, nested card would
// be counted twice and make "Skip" hide only the inner part of the grid cell.
const CF_SHORTS_CARDS =
  'ytm-shorts-lockup-view-model-v2:not(ytd-rich-item-renderer *), ' +
  ':not(ytm-shorts-lockup-view-model-v2) > ytm-shorts-lockup-view-model:not(ytd-rich-item-renderer *)';

const YT = {
  // yt-lockup-view-model must stay last: checkSubscriptionExceptions() appends
  // '.cleanfeed-hidden' to this string, which applies to the last entry only.
  VIDEO_CARDS: 'ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-playlist-renderer, ytd-reel-item-renderer, ' + CF_SHORTS_CARDS + ', yt-lockup-view-model',
  SHORTS_CARDS: CF_SHORTS_CARDS,

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
      if (isValidChannelName(text)) return text;
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
      // /shorts player (ytd-reel-video-renderer); no other card contains it
      'yt-shorts-video-title-view-model',
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

  // The id of the video a card links to (/watch?v=... or /shorts/...), else null.
  getVideoId(videoCard) {
    for (const link of videoCard.querySelectorAll('a[href^="/watch?"], a[href^="/shorts/"]')) {
      const id = cfVideoIdFromHref(link.getAttribute('href'));
      if (id) return id;
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

  // YouTube keeps pages visited earlier in the tab inside ytd-page-manager,
  // hidden with the `hidden` attribute (e.g. ytd-watch-flexy[hidden] while a
  // channel's ytd-browse is shown). Page-level lookups must search only the
  // page on screen. Returns that page element, or `document` when there is no
  // page manager or no visible page in it.
  getActivePageRoot() {
    const manager = document.querySelector('ytd-page-manager');
    if (manager) {
      for (const page of manager.children) {
        // Pages are ytd-* elements (ytd-browse, ytd-watch-flexy, ytd-search...);
        // skip anything else that ends up in the manager.
        if (page.tagName.startsWith('YTD-') && !page.hasAttribute('hidden')) return page;
      }
    }
    return document;
  },

  // The /shorts player shows the current short in a ytd-reel-video-renderer.
  // YouTube keeps ONE renderer and swaps its title, channel link and video on
  // every scroll (observed 2026-10-12), so callers must re-check it whenever
  // what it shows changes. Older layouts kept one renderer per short and
  // marked the current one [is-active]. Returns null outside /shorts/.
  getShortsPlayerReel() {
    if (!window.location.pathname.startsWith('/shorts/')) return null;
    const root = YT.getActivePageRoot();
    return root.querySelector('ytd-reel-video-renderer[is-active]') ||
           root.querySelector('ytd-reel-video-renderer');
  },

  getPageChannelName() {
    const root = YT.getActivePageRoot();
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
      const el = root.querySelector(sel);
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
    const link = YT.getActivePageRoot().querySelector(
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
    // DOM-based check (YouTube sometimes redirects /@name to /name). Only a
    // visible channel page or header counts: hidden cached pages stay in the
    // DOM, so a document-wide match stayed true on Home after any channel.
    const channelDom = 'ytd-browse[page-subtype="channels"], ytd-c4-tabbed-header-renderer, #channel-header';
    const root = YT.getActivePageRoot();
    if (root !== document && root.matches(channelDom)) return true;
    for (const el of root.querySelectorAll(channelDom)) {
      if (!el.closest('[hidden]')) return true;
    }
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

// --- 3-dot menu injection decision ---

// CleanFeed items are added only to a popup that opens within this many ms of
// a menu-button click inside a video card.
const MENU_CLICK_WINDOW_MS = 1000;

// Decides what content.js injectBlockOption() does with an open menu popup.
//   itemTokens: data-cf-menu-token of every CleanFeed item/separator already in
//               the popup ([] if none; '' for an item without a token)
//   clickToken: token of the last menu-button click inside a video card, ''
//               when the last menu-button click was outside any card
//   clickAgeMs: ms since that click
// Returns 'keep' (the items were built for this click: change nothing),
// 'inject', 'replace' (remove stale items, then inject), 'clear' (remove stale
// items, inject nothing) or 'none'. 'keep' never mutates the DOM, so a repeat
// call (e.g. from the observer reacting to our own insertions) is a no-op.
function getMenuInjectionAction(itemTokens, clickToken, clickAgeMs) {
  const hasItems = itemTokens.length > 0;
  if (hasItems && clickToken && itemTokens.every(t => t === clickToken)) return 'keep';
  const fresh = !!clickToken && clickAgeMs >= 0 && clickAgeMs <= MENU_CLICK_WINDOW_MS;
  if (fresh) return hasItems ? 'replace' : 'inject';
  return hasItems ? 'clear' : 'none';
}

// --- Keyword Matching ---

// Normalizes text and keywords for matching: lowercase, NFC, and typographic
// apostrophes (U+2018 U+2019 U+02BC) folded to a plain '. Diacritics are kept
// on purpose: "citta" must not match "città" (nor Spanish "ano" match "año").
function cfNormalizeForMatch(value) {
  return String(value).toLowerCase().normalize('NFC').replace(/[\u2018\u2019\u02BC]/g, "'");
}

// A "word character" is any letter, combining mark, digit or underscore of any
// script. The regex \b only knows [A-Za-z0-9_], so it can't be used for "città",
// "игры" or "먹방", and it fails at the edges of keywords such as "c++".
const CF_WORD_CHARS = '\\p{L}\\p{M}\\p{N}_';
const CF_KEYWORD_CACHE_MAX = 2000;
// raw keyword -> { normalized, regex }; the regex is built the first time the
// keyword actually occurs in a text.
const _cfKeywordCache = new Map();
// Callers test one title against hundreds of terms in a row, so the normalized
// form of the last text is kept instead of being recomputed for every term.
let _cfLastMatchText = null;
let _cfLastMatchNormalized = '';

function cfKeywordEntry(keyword) {
  let entry = _cfKeywordCache.get(keyword);
  if (!entry) {
    entry = { normalized: cfNormalizeForMatch(keyword), regex: null };
    if (_cfKeywordCache.size >= CF_KEYWORD_CACHE_MAX) _cfKeywordCache.clear();
    _cfKeywordCache.set(keyword, entry);
  }
  return entry;
}

function matchesKeyword(text, keyword) {
  if (!text || !keyword) return false;
  if (text !== _cfLastMatchText) {
    _cfLastMatchText = text;
    _cfLastMatchNormalized = cfNormalizeForMatch(text);
  }
  const entry = cfKeywordEntry(keyword);
  // Cheap reject first: nearly every term is absent from a given title, and a
  // Unicode regex test is several times slower than a substring search.
  if (!_cfLastMatchNormalized.includes(entry.normalized)) return false;
  if (!entry.regex) {
    // Whole-word match for ALL lengths ("game" must not hit "endgame", "play"
    // must not hit "display", "tea" must not hit "team"). A multi-word phrase
    // (e.g. "assassin's creed") is matched literally and anchored at its outer
    // edges only.
    const escaped = entry.normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    entry.regex = new RegExp(
      '(?<![' + CF_WORD_CHARS + '])' + escaped + '(?![' + CF_WORD_CHARS + '])', 'u');
  }
  return entry.regex.test(_cfLastMatchNormalized);
}

// --- Category Exemptions ---
// Even when a synonym matches, skip the block if the title contains any of
// these phrases — the video is ABOUT the topic (analysis, history, AI in X)
// not gameplay/tutorial content. Example: "AI in gaming" matches "gaming"
// synonym but is a discussion video, not actual playing.
const CATEGORY_EXEMPTIONS = {
  gaming: [
    'ai in gaming', 'ai e gaming', 'intelligenza artificiale',
    'industria del', 'industria dei', 'industria gaming',
    'analisi del', 'analisi dei', 'analysis of', 'critical analysis',
    'storia del', 'storia dei', 'storia di nintendo', 'storia di playstation',
    'history of', 'documentario', 'documentary',
    'evoluzione del', 'evoluzione dei',
    'filosofia del', 'filosofia dei',
    'psicologia del', 'psicologia dei',
    'economia del', 'economia dei', 'business of', 'business model',
    'futuro del', 'futuro dei', 'future of gaming',
    'cultura del', 'cultura dei',
    'come funziona', 'how it works', 'how do',
    'sociologia', 'antropologia',
    // Italian idioms where "gioco/giochi/giocare" is NOT about videogames
    'gioco di parole', 'giochi di parole', 'mettere in gioco', 'rimettere in gioco',
    'in gioco la', 'in gioco il', 'giochi pericolosi',
    'giochi olimpici', 'giochi paralimpici', 'giochi del mediterraneo',
    'gioco di squadra', 'gioco di ruolo da tavolo' // boardgame RPG, not video
  ],
  ai_hype: [
    'analysis of ai', 'critica di ai', 'ethics of ai', 'ai safety research',
    'industria ai', 'storia del computing', 'ai ethics', 'history of ai',
    'ai research paper', 'ai policy', 'regolamentazione ai', 'critica all\'ai'
  ],
  tech: [
    'industria tech', 'storia del tech', 'etica del tech',
    'history of technology', 'tech policy', 'tech regulation',
    'antitrust tech', 'tech ethics'
  ],
  news: [
    'analisi news', 'media literacy', 'news analysis',
    'critica del giornalismo', 'storia del giornalismo', 'journalism ethics'
  ],
  sports: [
    'storia del calcio', 'documentario sport', 'sports documentary',
    'storia dello sport', 'history of football', 'history of basketball',
    'documentario calcio', 'documentario nba'
  ]
};

// Exemptions belong to category blocks only: a plain keyword (even one that is
// a synonym of a category, like "minecraft") is never exempted. Own-property
// check so a keyword such as "constructor" can't hit Object.prototype.
function isCategoryExempt(title, category) {
  if (!title || !category) return false;
  if (!Object.prototype.hasOwnProperty.call(CATEGORY_EXEMPTIONS, category)) return false;
  const exemptions = CATEGORY_EXEMPTIONS[category];
  if (!exemptions || exemptions.length === 0) return false;
  const lower = title.toLowerCase();
  for (const phrase of exemptions) {
    if (lower.includes(phrase)) return true;
  }
  return false;
}

// --- Keyword Synonym Map ---
// When a user blocks the topic "crypto", we also block "bitcoin", "ethereum", etc.
// This turns literal keyword blocking into topic-level blocking. Only a keyword
// that is a category key (see getExpandedKeywords) expands; blocking "bitcoin"
// on its own blocks just "bitcoin".
//
// Terms are matched word-for-word, so a standalone everyday word ("tea", "slot",
// "persona", "partita") would hide unrelated videos for everyone who turns the
// topic on. Use an unambiguous phrase instead ("spill the tea", "slot machine")
// or leave the word out.

const KEYWORD_SYNONYMS = {
  crypto: ['bitcoin', 'ethereum', 'blockchain', 'solana', 'nft', 'defi', 'binance', 'coinbase', 'altcoin', 'web3', 'dogecoin', 'shiba inu coin', 'trading crypto', 'criptovalute', 'criptovaluta'],
  gambling: ['casino', 'poker', 'betting', 'scommesse', 'roulette', 'blackjack', 'stake casino', 'slot machine'],
  politics: ['politica', 'election', 'elezioni', 'trump', 'biden', 'parliament', 'parlamento', 'democrat', 'republican', 'senato'],
  gossip: ['youtube drama', 'youtuber drama', 'drama alert', 'creator drama', 'spill the tea', 'youtuber exposed', 'scandalo', 'pettegolezzo', 'youtuber beef', 'cancel culture', 'drammatico'],
  asmr: ['whispering asmr', 'tingles', 'soft spoken', 'mouth sounds', 'tapping asmr'],
  mukbang: ['eating show', 'food challenge', 'eating challenge', 'mangiata'],
  pranks: ['prank', 'scherzo telefonico', 'scherzi telefonici', 'candid camera', 'social experiment'],
  astrology: ['astrologia', 'horoscope', 'oroscopo', 'zodiac', 'zodiaco', 'tarot', 'tarocchi', 'segno zodiacale'],
  conspiracy: ['complotto', 'complottismo', 'flat earth', 'terra piatta', 'illuminati', 'new world order', 'qanon', 'no vax'],
  nsfw: ['onlyfans', 'thirst trap', 'hot tub stream', 'bikini haul', 'try on haul', 'lingerie', 'sexy'],
  clickbait: ['you wont believe', 'non crederai', 'gone wrong', 'shocking', 'jaw dropping', 'incredibile'],
  // Strategy: include common gaming words (incl. Italian gioco/giochi/giocare
  // and "gaming") to maximize coverage, then rely on CATEGORY_EXEMPTIONS to
  // suppress discussion-style titles like "AI in gaming" / "storia del gioco".
  // Removed only the very ambiguous ones with no good exemption coverage:
  //   "game"/"games" → "Squid Game", "Hunger Games", "endgame"
  //   "destiny"/"halo"/"mario" → too many non-gaming homonyms
  //   "remake"/"remaster" → movie remakes too
  // Franchise names that are also everyday words appear only as unambiguous
  // phrases: "persona 5", "forza horizon", "sonic the hedgehog", "the sims".
  gaming: ['gaming', 'gameplay', 'walkthrough', 'playthrough', 'lets play', "let's play", 'speedrun', 'esports', 'twitch streamer', 'fortnite', 'minecraft', 'gta v', 'gta 6', 'call of duty', 'valorant', 'league of legends', 'elden ring', 'dark souls', 'ps5', 'ps4', 'xbox', 'nintendo', 'playstation', 'videogiochi', 'videogioco', 'gamer', 'gioco', 'giochi', 'giocare', 'giocato', 'boss fight', 'dead space', 'system shock', 'resident evil', 'death stranding', 'cyberpunk 2077', 'zelda', 'pokemon', 'apex legends', 'overwatch', 'god of war', 'final fantasy', 'steam deck', 'epic games store', 'mmorpg', 'sala giochi', 'video game', 'pc gaming', 'mass effect', 'bioware', 'roblox', 'among us', 'tetris',
    // Major franchises (added 2026-05 to catch titles that don't contain "gaming")
    'assassin\'s creed', 'assassins creed', 'witcher', 'skyrim', 'bloodborne', 'sekiro',
    'hollow knight', 'cuphead', 'stardew', 'terraria', 'valheim', 'battlefield',
    'mario kart', 'smash bros', 'splatoon', 'animal crossing', 'sonic the hedgehog', 'crash bandicoot',
    'spider-man', 'hogwarts legacy', 'baldur\'s gate', 'baldurs gate', 'diablo',
    'world of warcraft', 'wow classic', 'path of exile', 'hearthstone', 'genshin',
    'honkai', 'wuthering waves', 'the sims', 'cities skylines', 'civilization',
    'total war', 'age of empires', 'stellaris', 'crusader kings', 'football manager',
    'fifa', 'efootball', 'nba 2k', 'madden', 'forza horizon', 'forza motorsport', 'gran turismo',
    'silent hill', 'starfield', 'jedi survivor', 'jedi fallen order', 'star wars outlaws',
    'kingdom hearts', 'persona 5', 'tekken', 'mortal kombat', 'street fighter',
    'metal gear', 'red dead', 'rdr2', 'horizon zero dawn', 'horizon forbidden',
    'last of us', 'uncharted', 'ghost of tsushima', 'returnal', 'helldivers',
    'palworld', 'lethal company', 'expedition 33', 'space marine',
    // Lego games
    'lego star wars', 'lego batman', 'lego harry potter', 'lego marvel', 'lego city',
    // Consoles & platforms
    'ps4', 'ps3', 'ps2', 'ps1', 'switch 2', 'xbox series', 'xbox one', 'meta quest',
    'oculus', 'vr gaming', 'cloud gaming', 'game pass', 'ps plus', 'psn',
    // Genres
    'fps game', 'soulslike', 'metroidvania', 'roguelike', 'roguelite', 'deckbuilder',
    'tower defense', 'moba', 'battle royale', 'indie game', 'early access',
    // Content patterns
    'launch trailer', 'gameplay trailer', 'reveal trailer', 'recensione gioco',
    'patch notes', 'season pass', 'open beta', 'closed beta',
    'finale del gioco', 'fine del gioco', 'finito il gioco', 'completato al 100',
    'tutti i finali', 'all endings', 'platino del', 'trofei', 'achievements unlocked'],
  kpop: ['k-pop', 'bts', 'blackpink', 'stray kids', 'twice kpop', 'aespa', 'enhypen', 'seventeen kpop', 'k pop'],
  anime: ['manga', 'otaku', 'one piece', 'naruto', 'demon slayer', 'jujutsu kaisen', 'attack on titan', 'dragon ball', 'shonen', 'crunchyroll'],
  diet: ['weight loss', 'dimagrire', 'perdere peso', 'calorie deficit', 'keto', 'intermittent fasting', 'digiuno', 'dieta'],
  hustle: ['side hustle', 'passive income', 'reddito passivo', 'dropshipping', 'affiliate marketing', 'make money online', 'guadagnare online', 'soldi facili'],
  horror: ['creepypasta', 'scary', 'terrore', 'jump scare', 'horror story'],
  true_crime: ['true crime', 'murder', 'omicidio', 'serial killer', 'cold case', 'crime documentary', 'caso irrisolto', 'cronaca nera'],
  reaction: ['reaction video', 'reacting to', 'first time watching', 'reagisco', 'la mia reazione'],
  unboxing: ['unboxing', 'haul', 'shopping haul', 'what i bought', 'cosa ho comprato'],
  // --- New categories added 2026-05 ---
  fitness: ['gym', 'workout', 'bodybuilding', 'push ups', 'pull ups', 'deadlift', 'squat workout',
    'bench press', 'palestra', 'allenamento', 'sala pesi', 'integratori', 'whey protein',
    'calisthenics', 'crossfit', 'cardio workout', 'hiit workout', 'leg day', 'chest day',
    'back day', 'arm day', 'shoulder workout', 'home workout', 'full body workout',
    'massa muscolare', 'ipertrofia', 'powerlifting', 'gym motivation'],
  beauty: ['makeup tutorial', 'skincare routine', 'contouring', 'foundation routine',
    'makeup palette', 'lipstick swatches', 'eyeshadow tutorial',
    'fondotinta', 'mascara', 'rossetto', 'get ready with me', 'grwm',
    'morning skincare', 'night skincare', 'sephora haul', 'ulta haul',
    'beauty routine', 'pelle perfetta', 'tutorial trucco', 'beauty guru',
    'eyeliner tutorial', 'blush tutorial', 'highlighter makeup', 'kbeauty', 'k-beauty'],
  fashion: ['ootd', 'capsule wardrobe', 'thrift haul', 'fashion haul', 'outfit ideas',
    'what i wore', 'try on haul fashion', 'abbigliamento', 'vestiti', 'look del giorno',
    'styling tips', 'fall outfits', 'summer outfits', 'winter outfits', 'spring outfits',
    'street style', 'fashion week', 'settimana della moda', 'milano fashion',
    'zara haul', 'shein haul', 'fashion lookbook', 'closet tour', 'armadio capsula',
    'come vestirsi', 'outfit invernali', 'outfit estivi'],
  travel: ['travel vlog', 'expat life', 'rv life', 'road trip', 'walking tour',
    'city tour', 'vlog viaggio', 'road trip italia', 'in viaggio', 'travel guide',
    'travel diary', 'travel itinerary', 'backpacking', 'solo travel', 'digital nomad',
    'van life', 'vita da nomadi', 'guida turistica', 'tour della città',
    'cosa vedere a', 'travel hacks', 'budget travel', 'luxury travel',
    'island hopping', 'cruise vlog'],
  food: ['recipe', 'cooking tutorial', 'cook with me', 'food vlog', 'ricetta',
    'ricette', 'cucinare', 'in cucina', 'easy meal', 'meal prep', 'what i eat in a day',
    'street food', 'food tour', 'tasty recipe', 'home cooking', 'cucina italiana',
    'pasta recipe', 'pizza recipe', 'baking recipe', 'dessert recipe', 'masterchef',
    'cake decorating', 'cibo di strada', 'cosa mangio', 'food challenge', 'cooking show'],
  cars: ['car review', 'supercar', 'lamborghini', 'ferrari', 'porsche', 'mustang',
    'tesla model', 'motore v8', 'motore v12', 'automobile', 'dyno test', 'drift',
    'jdm', 'top gear', 'auto sportiva', 'tuning auto', 'recensione auto', 'test drive',
    'bugatti', 'mclaren', 'koenigsegg', 'rimac', 'pagani', 'aston martin',
    'rolls royce', 'maserati', 'auto elettrica', 'electric car review', 'horsepower',
    'cavalli motore', 'cabrio', 'coupe review'],
  sports: ['nba', 'ufc', 'mma', 'boxe', 'boxing match', 'formula 1', 'f1 race',
    'premier league', 'champions league', 'mondiali', 'sports highlights',
    'nfl highlights', 'nba highlights', 'wwe', 'wrestling match', 'serie a highlights',
    'la liga', 'bundesliga', 'tennis match', 'wimbledon', 'roland garros',
    'us open tennis', 'australian open', 'motogp', 'rally race', 'olimpiadi',
    'pallavolo', 'pallacanestro', 'pugilato'],
  tech: ['iphone review', 'smartphone review', 'apple event', 'samsung leak',
    'gadget review', 'tech news', 'unboxing tech', 'mkbhd', 'recensione tech',
    'macbook review', 'ipad review', 'galaxy s', 'pixel phone', 'tech roundup',
    'best laptop', 'best smartphone', 'best gadgets', 'tech leaks', 'wwdc',
    'ces 2026', 'google io', 'samsung unpacked', 'tech haul', 'edc tech',
    'smartwatch review', 'airpods review', 'tech setup', 'gaming setup tour'],
  ai_hype: ['chatgpt', 'gpt-5', 'gpt-6', 'ai will replace', 'openai', 'sam altman',
    'anthropic', 'claude ai', 'gemini ai', 'ai changed everything', 'ai revolution',
    'agi', 'llm', 'ai agents', 'ai prompt', 'ai art', 'midjourney', 'stable diffusion',
    'dall-e', 'sora ai', 'ai video', 'prompt engineering', 'ai tools', 'best ai tools',
    'ai automation', 'ai chatbot', 'this ai is insane', 'ai is taking over', 'ai news today'],
  news: ['breaking news', 'daily news', 'news today', 'tg1', 'telegiornale',
    'ultime notizie', 'cronaca', 'attualità', 'news roundup', 'evening news',
    'morning news', 'live news', 'notizie di oggi', 'world news today', 'tg5',
    'tg la7', 'news in 5 minutes', 'news update', 'cnn news', 'bbc news',
    'fox news', 'msnbc'],
  religion: ['sermon', 'bible study', 'predica', 'vangelo', 'gospel music',
    'preghiera', 'ramadan', 'islamic lecture',
    'sunday service', 'church service', 'santo rosario', 'catechesi', 'meditazione cristiana',
    'lettura biblica', 'studio biblico', 'fede cristiana', 'parola di dio',
    'predicazione', 'omelia', 'santa messa', 'preghiera mariana', 'imam lecture'],
  parenting: ['mom life', 'family vlog', 'parenting tips', 'dad life', 'mom vlog',
    'mommy makeover', 'neonato', 'neogenitori', 'gravidanza', 'parto naturale',
    'pregnancy vlog', 'birth story', 'newborn routine', 'baby haul', 'nursery tour',
    'mom of three', 'dad of two', 'toddler mom', 'pannolini', 'svezzamento',
    'maternity vlog', 'postpartum', 'allattamento', 'crescita bambino',
    'consigli genitori', 'baby update'],
  kids: ['nursery rhyme', 'kids song', 'baby shark', 'cocomelon', 'peppa pig',
    'paw patrol', 'canzoni bambini', 'cartoni animati', 'masha e orso', 'bluey',
    'pj masks', 'super wings', 'baby einstein', 'little baby bum', 'sing along kids',
    'kids learning video', 'abc song', 'phonics song', 'kids cartoons', 'pocoyo',
    'bing bunny', 'sigle cartoni', 'cartoni per bambini', 'filastrocche'],
  paranormal: ['haunted house', 'ghost hunting', 'ufo sighting', 'alien encounter',
    'paranormal activity', 'sciamano', 'fantasma', 'ufo italia', 'demonologia',
    'esorcismo', 'caccia ai fantasmi', 'haunted location', 'cryptid', 'bigfoot',
    'mothman', 'skinwalker', 'cerchi nel grano', 'crop circles', 'avvistamento ufo',
    'area 51', 'roswell', 'extraterrestre', 'paranormal investigation',
    'spirit box', 'ouija board', 'tavola ouija', 'poltergeist'],
  brainrot: ['cap cut edit', 'capcut edit', 'sigma compilation', 'edit tiktok',
    'brainrot', 'ai slop', 'sigma male edit', 'alpha edit', 'gigachad edit',
    'mewing tutorial', 'looksmaxxing', 'looksmax', 'skibidi toilet', 'rizz compilation',
    'ohio meme', 'fanum tax', 'gyatt', 'sigma rule', 'sigma mindset edit',
    'phonk edit', 'velocity edit', 'anime edit tiktok', 'movie edit tiktok',
    'patrick bateman edit', 'andrew tate edit', 'goggins edit']
};

// disabledSynonymsSet and customSynonymsMap are set by the content script
// from applyState(). They filter/extend the synonym expansion.
let _cfDisabledSynonyms = new Set();
let _cfCustomSynonyms = {};

function cfSetSynonymFilters(disabledArray, customObj) {
  _cfDisabledSynonyms = new Set((disabledArray || []).map(s => s.toLowerCase()));
  _cfCustomSynonyms = customObj || {};
}

// Only a keyword that IS a category key expands to the category's terms.
// Blocking a word that merely appears in a category's synonym list ("minecraft",
// "nba", "tea") blocks just that word, not the whole topic.
function getExpandedKeywords(keyword) {
  const lower = keyword.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(KEYWORD_SYNONYMS, lower)) return [lower];
  // Start with built-in synonyms (deduplicated), filter out disabled ones
  const expanded = [...new Set([lower, ...KEYWORD_SYNONYMS[lower]])]
    .filter(s => !_cfDisabledSynonyms.has(s));
  // Add custom synonyms for this category
  const customs = Array.isArray(_cfCustomSynonyms[lower]) ? _cfCustomSynonyms[lower] : [];
  for (const cs of customs) {
    if (!expanded.includes(cs) && !_cfDisabledSynonyms.has(cs)) {
      expanded.push(cs);
    }
  }
  return expanded;
}

// --- Category auto-tag (channels that keep producing a blocked topic) ---

// True when `keyword` is a topic: a KEYWORD_SYNONYMS category key. Only a
// blocked topic auto-tags channels; a plain keyword ("trailer", or a synonym
// like "minecraft" blocked on its own) hides matching videos and nothing more.
function cfIsTopicKeyword(keyword) {
  const lower = String(keyword || '').trim().toLowerCase();
  return lower !== '' && Object.prototype.hasOwnProperty.call(KEYWORD_SYNONYMS, lower);
}

// Key under which a video hidden for `keyword` counts toward auto-tagging its
// channel ("gaming::ign"), or null when it must not count: the keyword is not
// a topic, or the channel name is not a real one. YouTube's metadata sometimes
// exposes a bullet or a view count where the channel name should be; counted,
// such garbage got auto-tagged and blocked unrelated videos site-wide.
function cfCategoryHitKey(keyword, channelName) {
  if (!cfIsTopicKeyword(keyword)) return null;
  if (!isValidChannelName(channelName)) return null;
  return String(keyword).trim().toLowerCase() + '::' + channelName.trim().toLowerCase();
}

// The 11-character video id in a /watch?v=... or /shorts/... link, else null.
function cfVideoIdFromHref(href) {
  const text = String(href || '');
  const m = /[?&]v=([\w-]{11})(?![\w-])/.exec(text) || /\/shorts\/([\w-]{11})(?![\w-])/.exec(text);
  return m ? m[1] : null;
}

// Identifies one video when counting auto-tag hits: its id, else its title
// (the hit key already holds the channel). Null when there is neither.
function cfCategoryVideoKey(videoId, title) {
  if (videoId) return videoId;
  const t = String(title || '').trim().toLowerCase();
  return t ? 't:' + t.slice(0, 100) : null;
}

// --- Keyword suggestions (CF+ quick-add popover and Channel Scan) ---
//
// Pure helpers that turn video titles into the phrases offered for blocking.
// A suggested phrase is always a piece of the title it came from, so
// matchesKeyword() finds it there:
//   - a word keeps its inner characters ("baldur's", "spider-man"); only the
//     punctuation at its two edges is trimmed
//   - an elision ("dell'anno", "l'ultimo", "qu'il") splits at the apostrophe
//   - phrases of several words are cut from the title itself, so the spacing and
//     punctuation between the words are the title's own
//   - letters and digits of every script count as word characters

// Words that carry no meaning of their own, so they are never offered as a
// keyword (and never sit inside a suggested phrase).
const STOP_WORDS = new Set([
  // English common words
  'the','a','an','is','are','was','were','in','on','at','to','for','of','and','or',
  'but','not','this','that','with','from','by','how','what','why','when','who','my',
  'your','you','he','she','it','we','they','me','him','her','us','them','do','does',
  'did','will','would','can','could','should','may','might','has','have','had','no',
  'yes','all','just','about','been','being','get','got','new','old','first','last',
  'very','most','some','any','one','two','its','than','then','so','if','up','out',
  'into','more','come','like','best','full','video','videos','official','music',
  'ago','here','there','also','make','made','too','such','only','same','still','even',
  'much','many','few','our','their','these','those','part','watch','watching','look',
  'looking','seen','find','found','using','vs',
  // Italian articles, prepositions, common particles
  'il','la','le','lo','un','una','uno','di','da','del','della','dello','dei','degli',
  'delle','dal','dalla','dallo','dai','dagli','dalle','al','alla','allo','ai','agli',
  'alle','sul','sulla','sullo','sui','sugli','sulle','che','per','con','non','nel',
  'nella','nello','nei','negli','nelle','su','tra','fra',
  // Italian common pronouns / determiners
  'questo','questa','questi','queste','quello','quella','quei','quelle','quel',
  'mio','mia','miei','mie','tuo','tua','tuoi','tue','suo','sua','suoi','sue',
  'nostro','nostra','nostri','nostre','vostro','vostra','vostri','vostre',
  'loro','lui','lei','noi','voi','essi','esse',
  // Italian common verbs / adverbs
  'sono','sei','siamo','siete','era','erano','essere','stato','stata','stati','state',
  'avere','avuto','avuta','avuti','avute','ho','hai','abbiamo','avete','hanno',
  'fare','fatto','fatti','fatta','fatte','dire','detto','dare','dato','vedere','visto',
  'come','cosa','tutto','tutti','tutta','tutte','anche','solo','dopo','prima','ancora',
  'ogni','poi','molto','poco','tanto','troppo','abbastanza','bene','male','meglio',
  'forse','magari','davvero','proprio','sempre','mai','già','ormai','adesso','oggi',
  'ieri','domani','quasi','finalmente','altro','altri','altra','altre','meno','vero',
  'vera','veri','vere','quindi','perché','perche',
  // Italian filler words from clickbait titles
  'sembra','sembrano','sembrava','sembrerebbe','arriva','arrivano','arrivato',
  'annuncia','annunciato','annunciata','conferma','confermato','presentato','presenta',
  'minuti','minuto','secondi','secondo','ora','ore','giorni','giorno','anni','anno',
  'nuovo','nuova','nuovi','nuove','grande','grandi','piccolo','piccola','vecchio',
  'vecchia','primo','prima','ultimo','ultima','ufficiale','ufficialmente','pure',
  'subito','ancora','direttamente','semplicemente','assolutamente',
  'wow','top','solo','così','cosi','contro','dentro','sopra','sotto','dietro',
  // Generic noisy words that aren't useful blockers
  'black','white','red','blue','green','grey','gray',
  'first','second','third','final','main','full','best','worst','great','good','bad',
  // Common YouTube title fillers
  'ep','episode','episodio','parte','part','reaction','reactions',
  // Italian additions from real-world scan results (EveryEye etc.)
  'più','piu','italiano','italiana','italiani','italiane',
  'gratis','film','ecco','modalità','modalita','modo','modi',
  'momento','momenti','perfetto','perfetta','perfetti','perfette',
  'prova','provato','provata','provati','provate','prove',
  'cose','cosa','gen','pro','serie','stagione',
  'spettacolare','spettacolari','fantastico','fantastica','fantastici','fantastiche',
  'incredibile','incredibili','assurdo','assurda','assurdi','assurde',
  'vogliamo','voglio','vuoi','vuole','vogliono','vorrei','vorrebbe',
  'alto','alta','alti','alte','basso','bassa','bassi','basse',
  'bello','bella','belli','belle','bellissimo','bellissima','bellissimi','bellissime',
  'brutto','brutta','brutti','brutte','bruttissimo','bruttissimi',
  'grosso','grossa','grossi','grosse','grande','grandi','piccolo','piccola',
  'animo','aniimo','energia','corso','tempo','tempi','momenti',
  'migliore','migliori','peggiore','peggiori','semplice','semplici',
  'complicato','complicata','difficile','difficili','facile','facili',
  'pure','direttamente','semplicemente','assolutamente','sicuramente',
  'arriva','arrivano','arrivato','arrivata','arrivati','arrivate',
  'parla','parlano','parlato','parlata','dice','dicono','detto','dico',
  'volta','volte','spesso','raramente','recente','recenti',
  'totalmente','completamente','letteralmente',
  // More Italian fillers from real scans (round 2)
  'pazzesco','pazzesca','pazzeschi','pazzesche',
  'roba','livello','livelli','stile','stili',
  'animazione','animazioni','animato','animata',
  'battono','battere','battuto','battuta',
  'capolavoro','capolavori','meraviglia','meraviglie',
  'adoriamo','adoro','adora','adorano','adorato',
  'grafica','grafiche','grafico','visivo','visiva',
  'enorme','enormi','immenso','immensa','immensi','immense',
  'rivelato','rivelata','rivelati','rivelate','svela','svelato','svelata',
  'oltre','aggiunge','aggiunto','aggiunta','novità','novita',
  'arriva','arrivata','arrivati','arrivate'
]);

// Articles and prepositions that elide before a vowel: Italian "l'ultimo",
// "dell'anno", "un'altra", "quest'anno", French "l'été", "qu'il", "d'amour".
// A word whose part before the apostrophe is not listed here ("Baldur's",
// "O'Brien", "don't", "rock'n'roll") is never split.
const CF_ELISION_PREFIXES = new Set([
  // Italian
  'l', 'un', 'c', 'd', 'm', 's', 't', 'v', 'n', 'dell', 'all', 'nell', 'sull', 'dall',
  'coll', 'quest', 'quell', 'sant', 'bell', 'buon', 'com', 'dov', 'cos', 'senz', 'tutt',
  'anch', 'quant',
  // French
  'j', 'qu', 'jusqu', 'lorsqu', 'puisqu', 'quoiqu'
]);

// A prefix of letters, an apostrophe (plain, typographic or modifier letter) and at
// least two more letters or digits ("l'a" and "dell's" stay whole).
const CF_ELISION_RE = /^(\p{L}+)['\u2018\u2019\u02BC](?=[\p{L}\p{N}]{2})/u;

// From the first to the last word character of a whitespace-free run: this is
// the run with its edge punctuation trimmed ('"Spider-Man":' -> 'Spider-Man').
// Same word characters as matchesKeyword, so a trimmed token always starts and
// ends where matchesKeyword accepts a word edge.
const CF_TOKEN_CORE_RE = new RegExp('[' + CF_WORD_CHARS + '](?:.*[' + CF_WORD_CHARS + '])?', 'u');

// Separators that end a word when they are glued to it without a space:
// "Zelda/Mario", "Zelda—Mario", "Zelda--Mario", "Wait...Minecraft", "#shorts#fyp",
// "Gate|Review". Apostrophes, single hyphens, single dots, & + and _ are not
// here: they stay inside a word ("baldur's", "spider-man", "node.js", "q&a",
// "c++20"). A single , : or / between two digits belongs to the number ("24/7",
// "10:30", "1,000").
const CF_TOKEN_SPLIT_RE = new RegExp(
  '(?:\\.{2,}|-{2,}|[\\u2026\\u2014\\u2013\\u2015|\\\\;!?#@()\\[\\]{}"\\u201C\\u201D\\u201E\\u00AB\\u00BB]' +
  '|(?<!\\p{N})[/,:]|[/,:](?!\\p{N}))+', 'gu');

// Splits a title into word tokens, in order:
//   text       the word as written in the title (edge punctuation trimmed)
//   key        text in match form: lowercase, NFC, plain apostrophe
//   start/end  where text sits in the title (title.slice(start, end) === text)
//   elision    true for the elided article of "dell'anno" ("dell'"); never a keyword
//   gapBefore  true when a separator sits between the previous token and this one
//              (a word made only of punctuation such as "-", "|", "...", or a
//              separator glued to the words such as "/" or "—"): no phrase may
//              reach across it
function cfTokenizeTitle(title) {
  const tokens = [];
  if (!title) return tokens;
  const text = String(title);
  const runs = /\S+/gu;
  let gap = false;
  let run;
  while ((run = runs.exec(text)) !== null) {
    const core = CF_TOKEN_CORE_RE.exec(run[0]);
    if (!core || !/[\p{L}\p{N}]/u.test(core[0])) { gap = true; continue; }
    // A run holds one word, or several words glued by separators: cut it there
    const pieces = [];
    let from = 0;
    let sep;
    CF_TOKEN_SPLIT_RE.lastIndex = 0;
    while ((sep = CF_TOKEN_SPLIT_RE.exec(core[0])) !== null) {
      pieces.push({ offset: from, text: core[0].slice(from, sep.index) });
      from = sep.index + sep[0].length;
    }
    pieces.push({ offset: from, text: core[0].slice(from) });

    for (let n = 0; n < pieces.length; n++) {
      if (n > 0) gap = true;
      const word = CF_TOKEN_CORE_RE.exec(pieces[n].text);
      if (!word || !/[\p{L}\p{N}]/u.test(word[0])) { gap = true; continue; }
      let start = run.index + core.index + pieces[n].offset + word.index;
      let rest = word[0];
      for (;;) {
        const elided = CF_ELISION_RE.exec(rest);
        if (!elided || !CF_ELISION_PREFIXES.has(elided[1].toLowerCase())) break;
        tokens.push({
          text: elided[0], key: cfNormalizeForMatch(elided[0]), start, end: start + elided[0].length,
          elision: true, gapBefore: gap
        });
        gap = false;
        start += elided[0].length;
        rest = rest.slice(elided[0].length);
      }
      tokens.push({
        text: rest, key: cfNormalizeForMatch(rest), start, end: start + rest.length,
        elision: false, gapBefore: gap
      });
      gap = false;
    }
  }
  return tokens;
}

// A token's letters and digits only ("it's" -> "its", "spider-man" -> "spiderman"):
// the form that is compared with STOP_WORDS and measured for length.
function cfStopKey(key) {
  return key.replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

// Quick-add: every title word becomes a chip, but a stop word or a single
// character is shown disabled. Numbers are allowed ("GTA 5") unless they are
// a single digit.
function cfIsQuickAddStop(token) {
  if (token.elision) return true;
  const word = cfStopKey(token.key);
  return word.length < 2 || STOP_WORDS.has(word);
}

// Channel Scan: stricter, a candidate needs 3+ characters and is not a number.
function cfIsUsefulScanToken(token) {
  if (token.elision) return false;
  const word = cfStopKey(token.key);
  return word.length >= 3 && !STOP_WORDS.has(word) && !/^\d+$/.test(word);
}

// Phrase of the tokens first..last: cut from the title, so it matches the title.
function cfPhraseOfTokens(text, tokens, first, last) {
  return text.slice(tokens[first].start, tokens[last].end);
}

// The chips of the CF+ quick-add popover for one title, in display order: every
// word, then pairs, then triples of neighbouring words.
//   kind    'word' | 'bigram' | 'trigram'
//   text    what the chip shows (the title's own words)
//   phrase  what gets saved if the chip is picked (match form of text)
//   stop    true for a chip that is shown disabled (words only; a pair or triple
//           never contains a stop word)
// The elided article of "dell'anno" has no chip. Words made only of punctuation
// have none either, and no pair or triple reaches across them.
function cfQuickAddChips(title) {
  const text = title ? String(title) : '';
  const tokens = cfTokenizeTitle(text);
  const stop = tokens.map(cfIsQuickAddStop);
  const chips = [];
  tokens.forEach((token, i) => {
    if (token.elision) return;
    chips.push({ kind: 'word', text: token.text, phrase: token.key, stop: stop[i] });
  });
  for (let size = 2; size <= 3; size++) {
    for (let i = 0; i + size <= tokens.length; i++) {
      let joined = true;
      for (let j = 0; j < size && joined; j++) {
        joined = !stop[i + j] && (j === 0 || !tokens[i + j].gapBefore);
      }
      if (!joined) continue;
      const shown = cfPhraseOfTokens(text, tokens, i, i + size - 1);
      chips.push({
        kind: size === 2 ? 'bigram' : 'trigram',
        text: shown, phrase: cfNormalizeForMatch(shown), stop: false
      });
    }
  }
  return chips;
}

// What the quick-add popover saves for the chips the user picked (a Set or array
// of chip phrases): picked words that sit next to each other in the title merge
// into one phrase cut from the title ("star", "wars" -> "star wars"), every other
// pick is kept as it is. Safety net: a phrase that matchesKeyword does not find in
// the title would never block anything, so it is returned in `skipped` instead of
// `phrases`.
function cfResolveQuickAddSelection(title, selected) {
  const text = title ? String(title) : '';
  const chosen = new Set(selected || []);
  const tokens = cfTokenizeTitle(text);
  const wanted = [];
  const mergedWords = new Set();
  let run = [];
  const closeRun = () => {
    if (run.length > 1) {
      wanted.push(cfNormalizeForMatch(text.slice(run[0].start, run[run.length - 1].end)));
      for (const token of run) mergedWords.add(token.key);
    }
    run = [];
  };
  for (const token of tokens) {
    const picked = !token.elision && chosen.has(token.key);
    if (picked && run.length > 0 && !token.gapBefore) {
      run.push(token);
    } else {
      closeRun();
      if (picked) run = [token];
    }
  }
  closeRun();
  for (const phrase of chosen) {
    if (!mergedWords.has(phrase)) wanted.push(phrase);
  }

  const phrases = [];
  const skipped = [];
  const seen = new Set();
  for (const phrase of wanted) {
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    (matchesKeyword(text, phrase) ? phrases : skipped).push(phrase);
  }
  return { phrases, skipped };
}

// Safety net for Channel Scan: a phrase is worth saving only if it matches at
// least one of the titles that were analysed.
function cfPhraseMatchesAnyTitle(titles, phrase) {
  if (!titles || !phrase) return false;
  for (const title of titles) {
    if (matchesKeyword(title, phrase)) return true;
  }
  return false;
}

// Does `words` hold `run` as consecutive words?
function cfHasWordRun(words, run) {
  for (let i = 0; i + run.length <= words.length; i++) {
    if (run.every((word, j) => words[i + j] === word)) return true;
  }
  return false;
}

// Channel Scan: the most frequent words and phrases (2 or 3 neighbouring words)
// of a set of titles, as { phrase, count, type } sorted by count. Only phrases
// that occur in 2+ titles; a title counts a phrase once. Stop words, tokens under
// 3 characters and numbers are never used, and a phrase never reaches across one
// of them or across a dropped separator. A phrase of neighbouring words is cut
// from the title. A longer phrase hides the words it is made of when it has the
// same count.
function cfExtractKeywords(titles) {
  if (!titles || titles.length === 0) return [];

  const MIN_FREQ = 2;
  const counts = [null, new Map(), new Map(), new Map()]; // index = words per phrase

  for (const title of titles) {
    const text = title ? String(title) : '';
    const tokens = cfTokenizeTitle(text);
    const useful = tokens.map(cfIsUsefulScanToken);
    for (let size = 1; size <= 3; size++) {
      const seen = new Set();
      for (let i = 0; i + size <= tokens.length; i++) {
        let joined = true;
        for (let j = 0; j < size && joined; j++) {
          joined = useful[i + j] && (j === 0 || !tokens[i + j].gapBefore);
        }
        if (!joined) continue;
        const phrase = size === 1
          ? tokens[i].key
          : cfNormalizeForMatch(cfPhraseOfTokens(text, tokens, i, i + size - 1));
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        const entry = counts[size].get(phrase);
        if (entry) entry.count++;
        else counts[size].set(phrase, { count: 1, words: tokens.slice(i, i + size).map(t => t.key) });
      }
    }
  }

  const TYPES = [null, 'unigram', 'bigram', 'trigram'];
  const candidates = [];
  // Longest first, so a shorter phrase can be checked against the longer ones
  for (let size = 3; size >= 1; size--) {
    for (const [phrase, entry] of counts[size]) {
      if (entry.count < MIN_FREQ) continue;
      const hidden = candidates.some(c =>
        c.words.length > size && c.count === entry.count && cfHasWordRun(c.words, entry.words));
      if (!hidden) candidates.push({ phrase, count: entry.count, type: TYPES[size], words: entry.words });
    }
  }

  candidates.sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase));
  // Top 40 — wide enough to catch specific franchises (Ratchet & Clank,
  // Saros, Pragmata, etc.) that appear 2-3 times, tight enough that the
  // user doesn't drown in noise.
  return candidates.slice(0, 40).map(c => ({ phrase: c.phrase, count: c.count, type: c.type }));
}
