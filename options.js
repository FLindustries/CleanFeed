// CleanFeed Options Page Script

let state = {};

// Synonym map — duplicated from content-dom.js for the options page context.
// Options page runs in its own context and cannot access content script globals.
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

const CATEGORIES = [
  { key: 'crypto', label: 'Crypto' },
  { key: 'gambling', label: 'Gambling' },
  { key: 'politics', label: 'Politics' },
  { key: 'gossip', label: 'Gossip' },
  { key: 'asmr', label: 'ASMR' },
  { key: 'mukbang', label: 'Mukbang' },
  { key: 'pranks', label: 'Pranks' },
  { key: 'astrology', label: 'Astrology' },
  { key: 'conspiracy', label: 'Conspiracy' },
  { key: 'nsfw', label: 'NSFW' },
  { key: 'clickbait', label: 'Clickbait' },
  { key: 'gaming', label: 'Gaming' },
  { key: 'kpop', label: 'K-Pop' },
  { key: 'anime', label: 'Anime' },
  { key: 'diet', label: 'Diet' },
  { key: 'hustle', label: 'Hustle' },
  { key: 'horror', label: 'Horror' },
  { key: 'true_crime', label: 'True Crime' },
  { key: 'reaction', label: 'Reaction' },
  { key: 'unboxing', label: 'Unboxing' },
];

// Custom i18n system: supports language override from settings.
// If language is 'auto', uses chrome.i18n (browser locale).
// Otherwise loads the specific locale's messages.json.
let _customMessages = null;

async function loadCustomLanguage() {
  const { settings } = await chrome.storage.local.get('settings');
  const lang = settings?.language || 'auto';
  if (lang === 'auto') { _customMessages = null; return; }
  try {
    const url = chrome.runtime.getURL('_locales/' + lang + '/messages.json');
    const resp = await fetch(url);
    _customMessages = await resp.json();
  } catch (e) {
    _customMessages = null;
  }
}

function msg(key, subs) {
  // Try custom messages first (if language override is set)
  if (_customMessages && _customMessages[key]) {
    let text = _customMessages[key].message;
    if (subs && Array.isArray(subs)) {
      subs.forEach((sub, i) => {
        text = text.replace('$' + (i + 1), sub);
        // Also replace named placeholders
        const placeholders = _customMessages[key].placeholders;
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
  // Fallback to chrome.i18n native API
  try {
    const m = chrome.i18n.getMessage(key, subs);
    return m || key;
  } catch (e) {
    return key;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadCustomLanguage();
  await loadState();
  applyI18n();
  renderAll();
  setupNav();
  setupKeywordInput();
  setupButtons();

  // Show version
  const manifest = chrome.runtime.getManifest();
  const ver = 'v' + manifest.version;
  document.getElementById('versionText').textContent = ver;
  document.getElementById('aboutVersion').textContent = ver;
});

async function loadState() {
  state = await chrome.runtime.sendMessage({ action: 'getFullState' });
}

function notifyContentScript() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'refilterPage' }).catch(() => {});
    }
  });
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const m = msg(el.dataset.i18n);
    if (m) el.textContent = m;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const m = msg(el.dataset.i18nPlaceholder);
    if (m) el.placeholder = m;
  });
}

function renderAll() {
  renderBadge();
  renderSettings();
  renderChannels();
  renderCategories();
  renderKeywords();
  renderHidden();
  renderInterests();
  renderAbout();
}

function renderBadge() {
  const badge = document.getElementById('planBadge');
  badge.textContent = state.isPro ? msg('pro') : msg('free');
  badge.classList.toggle('badge-pro', state.isPro);
}

// ── Settings ──

function renderSettings() {
  const container = document.getElementById('settings-list');
  container.textContent = '';

  container.appendChild(createToggle('hideShorts', 'hideShortsDesc', state.settings?.hideShorts, false, async (val) => {
    await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'hideShorts', value: val });
    state.settings.hideShorts = val;
    notifyContentScript();
  }));

  container.appendChild(createToggle('interestBoundaries', 'interestBoundariesDesc', state.settings?.enableInterestBoundaries, !state.isPro, async (val) => {
    if (!state.isPro) { chrome.runtime.sendMessage({ action: 'openPaymentPage' }); return; }
    await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'enableInterestBoundaries', value: val });
    state.settings.enableInterestBoundaries = val;
  }));

  container.appendChild(createToggle('smartDecay', 'smartDecayDesc', state.settings?.enableSmartDecay, !state.isPro, async (val) => {
    if (!state.isPro) { chrome.runtime.sendMessage({ action: 'openPaymentPage' }); return; }
    await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'enableSmartDecay', value: val });
    state.settings.enableSmartDecay = val;
  }));

  // Language selector
  const langItem = document.createElement('div');
  langItem.className = 'toggle-item';

  const langInfo = document.createElement('div');
  langInfo.className = 'toggle-info';

  const langTitle = document.createElement('div');
  langTitle.className = 'toggle-title';
  const langTitleSpan = document.createElement('span');
  langTitleSpan.textContent = msg('languageLabel') !== 'languageLabel' ? msg('languageLabel') : 'Language';
  langTitle.appendChild(langTitleSpan);
  langInfo.appendChild(langTitle);

  const langDesc = document.createElement('div');
  langDesc.className = 'toggle-desc';
  langDesc.textContent = msg('languageDesc') !== 'languageDesc' ? msg('languageDesc') : 'Choose the language for CleanFeed interface';
  langInfo.appendChild(langDesc);

  langItem.appendChild(langInfo);

  const langSelect = document.createElement('select');
  langSelect.style.cssText = 'padding:6px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;font-family:inherit;cursor:pointer;background:#ffffff;color:#0f0f0f;';
  const langOptions = [
    { value: 'auto', label: msg('languageAuto') !== 'languageAuto' ? msg('languageAuto') : 'Auto (browser)' },
    { value: 'en', label: 'English' },
    { value: 'it', label: 'Italiano' },
  ];
  for (const opt of langOptions) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if ((state.settings?.language || 'auto') === opt.value) option.selected = true;
    langSelect.appendChild(option);
  }
  langSelect.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'language', value: langSelect.value });
    state.settings.language = langSelect.value;
    // Reload page to apply new language
    window.location.reload();
  });

  langItem.appendChild(langSelect);
  container.appendChild(langItem);
}

function createToggle(titleKey, descKey, isActive, isLocked, onChange) {
  const item = document.createElement('div');
  item.className = 'toggle-item';

  const info = document.createElement('div');
  info.className = 'toggle-info';

  const titleRow = document.createElement('div');
  titleRow.className = 'toggle-title';

  const titleSpan = document.createElement('span');
  titleSpan.textContent = msg(titleKey);
  titleRow.appendChild(titleSpan);

  if (isLocked) {
    const proBadge = document.createElement('span');
    proBadge.className = 'pro-badge-inline';
    proBadge.textContent = 'PRO';
    titleRow.appendChild(proBadge);
  }

  info.appendChild(titleRow);

  const desc = document.createElement('div');
  desc.className = 'toggle-desc';
  desc.textContent = msg(descKey);
  info.appendChild(desc);

  item.appendChild(info);

  const toggle = document.createElement('div');
  toggle.className = 'toggle-switch' + (isActive ? ' active' : '') + (isLocked ? ' locked' : '');

  const knob = document.createElement('div');
  knob.className = 'toggle-knob';
  toggle.appendChild(knob);

  toggle.addEventListener('click', () => {
    if (isLocked) {
      chrome.runtime.sendMessage({ action: 'openPaymentPage' });
      return;
    }
    const newVal = !toggle.classList.contains('active');
    toggle.classList.toggle('active', newVal);
    onChange(newVal);
  });

  item.appendChild(toggle);
  return item;
}

// ── Blocked Channels ──

function renderChannels() {
  const container = document.getElementById('channel-list');
  container.textContent = '';

  const channels = state.blockedChannels || [];
  document.getElementById('channelCount').textContent = channels.length + ' channels blocked';

  const clearBtn = document.getElementById('clearChannelsBtn');

  if (channels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = msg('noBlockedChannels');
    container.appendChild(empty);
    clearBtn.style.display = 'none';
    return;
  }

  clearBtn.style.display = 'block';

  channels.forEach((ch, i) => {
    const item = document.createElement('div');
    item.className = 'list-item';

    const name = document.createElement('span');
    name.className = 'list-item-name';
    name.textContent = ch.name;
    if (ch.id) {
      name.title = ch.id;
    }
    item.appendChild(name);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'list-item-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'removeBlockedChannel', index: i });
      notifyContentScript();
      await loadState();
      renderChannels();
      renderBadge();
    });
    item.appendChild(removeBtn);

    container.appendChild(item);
  });
}

// ── Categories (with synonym accordion) ──

// Track which category accordions are open (survives re-render)
const _openCategories = new Set();

function renderCategories() {
  const container = document.getElementById('category-list');
  container.textContent = '';

  const blockedKwSet = new Set((state.blockedKeywords || []).map(k => k.keyword.toLowerCase()));
  const totalKeywords = (state.blockedKeywords || []).length;
  const atFreeLimit = !state.isPro && totalKeywords >= 3;

  for (const cat of CATEGORIES) {
    const isActive = blockedKwSet.has(cat.key);
    const isLocked = !isActive && atFreeLimit;
    const synonyms = KEYWORD_SYNONYMS[cat.key] || [];

    const item = document.createElement('div');
    item.className = 'category-item';

    // Header row
    const header = document.createElement('div');
    header.className = 'category-header';

    const left = document.createElement('div');
    left.className = 'category-left';

    const arrow = document.createElement('span');
    arrow.className = 'category-arrow';
    arrow.textContent = '\u25B6';
    left.appendChild(arrow);

    const nameEl = document.createElement('span');
    nameEl.className = 'category-name';
    nameEl.textContent = cat.label;
    left.appendChild(nameEl);

    const countEl = document.createElement('span');
    countEl.className = 'category-count';
    countEl.textContent = synonyms.length + ' terms';
    left.appendChild(countEl);

    header.appendChild(left);

    // Lock badge for free users at limit
    if (isLocked) {
      const lockBadge = document.createElement('span');
      lockBadge.className = 'pro-badge-inline';
      lockBadge.textContent = 'PRO';
      left.appendChild(lockBadge);
    }

    // Toggle
    const toggle = document.createElement('div');
    toggle.className = 'category-toggle' + (isActive ? ' active' : '') + (isLocked ? ' locked' : '');

    const toggleKnob = document.createElement('div');
    toggleKnob.className = 'category-toggle-knob';
    toggle.appendChild(toggleKnob);

    toggle.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isLocked) {
        chrome.runtime.sendMessage({ action: 'openPaymentPage' });
        return;
      }
      if (isActive) {
        const keywords = state.blockedKeywords || [];
        const idx = keywords.findIndex(k => k.keyword.toLowerCase() === cat.key);
        if (idx >= 0) {
          await chrome.runtime.sendMessage({ action: 'removeKeyword', index: idx });
        }
      } else {
        const result = await chrome.runtime.sendMessage({ action: 'addKeyword', keyword: cat.key });
        if (result.reason === 'free_limit') {
          alert(msg('keywordLimitToast'));
          return;
        }
      }
      notifyContentScript();
      await loadState();
      renderCategories();
    });

    header.appendChild(toggle);
    item.appendChild(header);

    // Synonyms panel — each synonym is toggleable
    const synonymPanel = document.createElement('div');
    synonymPanel.className = 'category-synonyms';

    const disabledSet = new Set((state.disabledSynonyms || []).map(s => s.toLowerCase()));
    const customList = (state.customSynonyms && state.customSynonyms[cat.key]) || [];

    const synonymList = document.createElement('div');
    synonymList.className = 'synonym-list';

    // Built-in synonyms (category key + synonyms) — all toggleable
    const allBuiltIn = [cat.key, ...synonyms];
    for (const syn of allBuiltIn) {
      const isDisabled = disabledSet.has(syn.toLowerCase());
      const chip = document.createElement('button');
      chip.className = 'synonym-chip' + (isDisabled ? ' disabled' : ' active');
      chip.textContent = syn;
      chip.title = isDisabled ? 'Click to re-enable' : 'Click to disable';
      chip.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'toggleSynonym', synonym: syn });
        notifyContentScript();
        await loadState();
        renderCategories();
      });
      synonymList.appendChild(chip);
    }

    // Custom synonyms — user-added, shown with different style + remove button
    for (const cs of customList) {
      const chipWrap = document.createElement('span');
      chipWrap.className = 'synonym-chip custom';
      chipWrap.textContent = cs;

      const removeBtn = document.createElement('span');
      removeBtn.className = 'synonym-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await chrome.runtime.sendMessage({ action: 'removeCustomSynonym', category: cat.key, synonym: cs });
        notifyContentScript();
        await loadState();
        renderCategories();
      });
      chipWrap.appendChild(removeBtn);
      synonymList.appendChild(chipWrap);
    }

    // Add custom synonym input
    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:4px;margin-top:6px;width:100%;';
    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.className = 'input';
    addInput.placeholder = msg('addSynonymPlaceholder') !== 'addSynonymPlaceholder' ? msg('addSynonymPlaceholder') : 'Add custom term...';
    addInput.style.cssText = 'flex:1;padding:5px 8px;font-size:12px;';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-primary';
    addBtn.style.cssText = 'padding:5px 10px;font-size:12px;';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', async () => {
      const val = addInput.value.trim();
      if (!val) return;
      await chrome.runtime.sendMessage({ action: 'addCustomSynonym', category: cat.key, synonym: val });
      addInput.value = '';
      notifyContentScript();
      await loadState();
      renderCategories();
    });
    addInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addBtn.click(); });
    addRow.appendChild(addInput);
    addRow.appendChild(addBtn);

    synonymPanel.appendChild(synonymList);
    synonymPanel.appendChild(addRow);
    item.appendChild(synonymPanel);

    // Restore open state from previous render
    if (_openCategories.has(cat.key)) {
      synonymPanel.classList.add('open');
      arrow.classList.add('open');
    }

    // Toggle accordion on header click (but not on the toggle switch)
    header.addEventListener('click', (e) => {
      if (e.target.closest('.category-toggle')) return;
      const isOpen = synonymPanel.classList.contains('open');
      synonymPanel.classList.toggle('open', !isOpen);
      arrow.classList.toggle('open', !isOpen);
      if (!isOpen) _openCategories.add(cat.key);
      else _openCategories.delete(cat.key);
    });

    container.appendChild(item);
  }
}

// ── Custom Keywords ──

function renderKeywords() {
  const container = document.getElementById('keyword-list');
  container.textContent = '';

  const keywords = state.blockedKeywords || [];
  const categoryKeys = new Set(CATEGORIES.map(c => c.key));
  const customKeywords = keywords.filter(kw => !categoryKeys.has(kw.keyword.toLowerCase()));

  if (customKeywords.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = msg('noBlockedKeywords');
    container.appendChild(empty);
    return;
  }

  customKeywords.forEach((kw) => {
    const i = keywords.indexOf(kw);
    const item = document.createElement('div');
    item.className = 'list-item';

    const name = document.createElement('span');
    name.className = 'list-item-name';
    name.textContent = kw.keyword;
    item.appendChild(name);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'list-item-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'removeKeyword', index: i });
      notifyContentScript();
      await loadState();
      renderKeywords();
    });
    item.appendChild(removeBtn);

    container.appendChild(item);
  });
}

function setupKeywordInput() {
  const input = document.getElementById('keywordInput');
  const addBtn = document.getElementById('addKeywordBtn');

  addBtn.addEventListener('click', async () => {
    const kw = input.value.trim();
    if (!kw) return;
    const result = await chrome.runtime.sendMessage({ action: 'addKeyword', keyword: kw });
    if (result.success) {
      input.value = '';
      await loadState();
      renderKeywords();
      notifyContentScript();
    } else if (result.reason === 'free_limit') {
      alert(msg('keywordLimitToast'));
    } else if (result.reason === 'already_exists') {
      alert('Keyword already exists.');
    }
  });

  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addBtn.click();
  });
}

// ── Hidden Videos ──

function renderHidden() {
  const container = document.getElementById('hidden-list');
  container.textContent = '';

  if (!state.isPro) {
    const notice = document.createElement('div');
    notice.className = 'upgrade-notice';
    const p = document.createElement('p');
    p.textContent = msg('hiddenVideosUpgrade');
    notice.appendChild(p);
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = msg('upgradeToPro');
    btn.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openPaymentPage' }));
    notice.appendChild(btn);
    container.appendChild(notice);
    return;
  }

  const videos = state.hiddenVideos || [];

  if (videos.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = msg('noHiddenVideos');
    container.appendChild(empty);
    return;
  }

  videos.forEach((vid, i) => {
    const item = document.createElement('div');
    item.className = 'list-item';

    const info = document.createElement('div');
    info.className = 'list-item-info';

    const title = document.createElement('span');
    title.className = 'list-item-name';
    title.textContent = vid.title;
    info.appendChild(title);

    const reason = document.createElement('span');
    reason.className = 'list-item-reason';
    if (vid.reason.startsWith('keyword:')) {
      reason.textContent = msg('keywordReason', [vid.reason.split(':')[1]]);
    } else if (vid.reason.startsWith('channel:')) {
      reason.textContent = msg('channelReason', [vid.reason.split(':')[1]]);
    } else {
      reason.textContent = vid.reason;
    }
    info.appendChild(reason);

    item.appendChild(info);

    const undoBtn = document.createElement('button');
    undoBtn.className = 'list-item-undo';
    undoBtn.textContent = msg('undoHide');
    undoBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'removeHiddenVideo', index: i });
      await loadState();
      renderHidden();
    });
    item.appendChild(undoBtn);

    container.appendChild(item);
  });
}

// ── Interests ──

function renderInterests() {
  const container = document.getElementById('interest-list');
  container.textContent = '';

  if (!state.isPro) {
    const notice = document.createElement('div');
    notice.className = 'upgrade-notice';
    const p = document.createElement('p');
    p.textContent = msg('interestsUpgrade');
    notice.appendChild(p);
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = msg('upgradeToPro');
    btn.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openPaymentPage' }));
    notice.appendChild(btn);
    container.appendChild(notice);
    return;
  }

  const interests = state.interests || {};
  const keys = Object.keys(interests);

  if (keys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = msg('noInterests');
    container.appendChild(empty);
    return;
  }

  keys.forEach(key => {
    const interest = interests[key];
    const item = document.createElement('div');
    item.className = 'list-item';

    const info = document.createElement('div');
    info.className = 'list-item-info';

    const name = document.createElement('span');
    name.className = 'list-item-name';
    name.textContent = interest.query;
    info.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'list-item-meta';
    if (interest.expiresAt) {
      const remaining = Math.max(0, Math.ceil((interest.expiresAt - Date.now()) / (60 * 60 * 1000)));
      meta.textContent = msg('curiosityToday') + ' (' + remaining + 'h)';
    } else {
      const daysAgo = Math.floor((Date.now() - interest.lastUsed) / (24 * 60 * 60 * 1000));
      const daysLeft = Math.max(0, 30 - daysAgo);
      meta.textContent = daysLeft + ' days until decay';
    }
    info.appendChild(meta);

    item.appendChild(info);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'list-item-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'removeInterest', key });
      await loadState();
      renderInterests();
    });
    item.appendChild(removeBtn);

    container.appendChild(item);
  });
}

// ── About ──

function renderAbout() {
  const upgradeCard = document.getElementById('upgradeBtn').closest('.about-card');
  if (state.isPro) {
    // Replace "Upgrade" card with "You are Pro" message
    upgradeCard.textContent = '';
    const h3 = document.createElement('h3');
    h3.textContent = 'CleanFeed Pro';
    upgradeCard.appendChild(h3);
    const p = document.createElement('p');
    p.textContent = msg('youArePro') !== 'youArePro'
      ? msg('youArePro')
      : 'You have full access to all CleanFeed features. Thank you for your support!';
    upgradeCard.appendChild(p);
  }
}

// ── Navigation ──

function setupNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('section-' + btn.dataset.section).classList.add('active');
    });
  });
}

// ── Buttons ──

function setupButtons() {
  document.getElementById('clearChannelsBtn').addEventListener('click', async () => {
    if (confirm(msg('clearAllConfirm'))) {
      await chrome.runtime.sendMessage({ action: 'clearAllBlockedChannels' });
      notifyContentScript();
      await loadState();
      renderChannels();
      renderBadge();
    }
  });

  document.getElementById('upgradeBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openPaymentPage' });
  });

  document.getElementById('bugReportBtn').addEventListener('click', () => {
    // Open a pre-filled GitHub issue or mailto link
    const version = chrome.runtime.getManifest().version;
    const ua = navigator.userAgent;
    const subject = encodeURIComponent('CleanFeed Bug Report');
    const body = encodeURIComponent(
      'Describe the bug:\n\n\n' +
      'Steps to reproduce:\n1. \n2. \n3. \n\n' +
      'Expected behavior:\n\n\n' +
      'CleanFeed version: ' + version + '\n' +
      'Browser: ' + ua + '\n'
    );
    // Use mailto as default — can be changed to a GitHub Issues URL later
    window.open('mailto:cleanfeed.support@gmail.com?subject=' + subject + '&body=' + body);
  });
}

// ── Live Updates ──

chrome.storage.onChanged.addListener(async (changes) => {
  const keys = Object.keys(changes);
  const statOnly = keys.length === 1 && keys[0] === 'stats';
  if (statOnly) return;
  await loadState();
  renderAll();
});
