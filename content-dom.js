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

  // Word-boundary match for ALL lengths. Previously ≥4 chars used substring
  // which gave false positives: "game" → "endgame", "play" → "display"ed,
  // "tea" → "team". Word boundaries respect natural word edges in all langs.
  const escaped = lowerKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // For multi-word phrases (e.g. "assassin's creed") allow flexible spacing
  // but still anchor at outer word boundaries.
  const regex = new RegExp('\\b' + escaped + '\\b');
  return regex.test(lowerText);
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

function isCategoryExempt(title, category) {
  if (!title || !category) return false;
  const exemptions = CATEGORY_EXEMPTIONS[category];
  if (!exemptions || exemptions.length === 0) return false;
  const lower = title.toLowerCase();
  for (const phrase of exemptions) {
    if (lower.includes(phrase)) return true;
  }
  return false;
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
  // Strategy: include common gaming words (incl. Italian gioco/giochi/giocare
  // and "gaming") to maximize coverage, then rely on CATEGORY_EXEMPTIONS to
  // suppress discussion-style titles like "AI in gaming" / "storia del gioco".
  // Removed only the very ambiguous ones with no good exemption coverage:
  //   "game"/"games" → "Squid Game", "Hunger Games", "endgame"
  //   "destiny"/"halo"/"mario" → too many non-gaming homonyms
  //   "remake"/"remaster" → movie remakes too
  gaming: ['gaming', 'gameplay', 'walkthrough', 'playthrough', 'lets play', "let's play", 'speedrun', 'esports', 'twitch streamer', 'fortnite', 'minecraft', 'gta v', 'gta 6', 'call of duty', 'valorant', 'league of legends', 'elden ring', 'dark souls', 'ps5', 'ps4', 'xbox', 'nintendo', 'playstation', 'videogiochi', 'videogioco', 'gamer', 'gioco', 'giochi', 'giocare', 'giocato', 'boss fight', 'dead space', 'system shock', 'resident evil', 'death stranding', 'cyberpunk 2077', 'zelda', 'pokemon', 'apex legends', 'overwatch', 'god of war', 'final fantasy', 'steam deck', 'epic games store', 'mmorpg', 'sala giochi', 'video game', 'pc gaming', 'mass effect', 'bioware', 'roblox', 'among us', 'tetris',
    // Major franchises (added 2026-05 to catch titles that don't contain "gaming")
    'assassin\'s creed', 'assassins creed', 'witcher', 'skyrim', 'bloodborne', 'sekiro',
    'hollow knight', 'cuphead', 'stardew', 'terraria', 'valheim', 'battlefield',
    'mario kart', 'smash bros', 'splatoon', 'animal crossing', 'sonic', 'crash bandicoot',
    'spider-man', 'hogwarts legacy', 'baldur\'s gate', 'baldurs gate', 'diablo',
    'world of warcraft', 'wow classic', 'path of exile', 'hearthstone', 'genshin',
    'honkai', 'wuthering waves', 'sims', 'cities skylines', 'civilization',
    'total war', 'age of empires', 'stellaris', 'crusader kings', 'football manager',
    'fifa', 'efootball', 'nba 2k', 'madden', 'forza', 'gran turismo',
    'silent hill', 'starfield', 'jedi survivor', 'jedi fallen order', 'star wars outlaws',
    'kingdom hearts', 'persona', 'tekken', 'mortal kombat', 'street fighter',
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
  kpop: ['k-pop', 'bts', 'blackpink', 'stray kids', 'twice', 'aespa', 'enhypen', 'seventeen', 'k pop'],
  anime: ['manga', 'otaku', 'one piece', 'naruto', 'demon slayer', 'jujutsu kaisen', 'attack on titan', 'dragon ball', 'shonen', 'crunchyroll'],
  diet: ['weight loss', 'dimagrire', 'perdere peso', 'calorie deficit', 'keto', 'intermittent fasting', 'digiuno', 'dieta'],
  hustle: ['side hustle', 'passive income', 'reddito passivo', 'dropshipping', 'affiliate marketing', 'make money online', 'guadagnare online', 'soldi facili'],
  horror: ['creepypasta', 'scary', 'paura', 'terrore', 'jump scare', 'horror story'],
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
    'makeup palette', 'lipstick swatches', 'eyeshadow tutorial', 'trucco',
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
    'cosa vedere a', 'what to do in', 'travel hacks', 'budget travel', 'luxury travel',
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
    'premier league', 'champions league', 'mondiali', 'sports highlights', 'partita',
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
  religion: ['sermon', 'bible study', 'pastor', 'predica', 'vangelo', 'gospel music',
    'preghiera', 'cristiano', 'ramadan', 'islamic lecture',
    'sunday service', 'church service', 'rosario', 'catechesi', 'meditazione cristiana',
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
