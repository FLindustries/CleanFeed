// CleanFeed Popup Script

let state = {};
let settingsUpdateInFlight = false;
let _customMessages = null;

async function loadCustomLanguage() {
  const { settings } = await chrome.storage.local.get('settings');
  const lang = settings?.language || 'auto';
  if (lang === 'auto') { _customMessages = null; return; }
  try {
    const url = chrome.runtime.getURL('_locales/' + lang + '/messages.json');
    const resp = await fetch(url);
    _customMessages = await resp.json();
  } catch (e) { _customMessages = null; }
}

function cfMsg(key, subs) {
  if (_customMessages && _customMessages[key]) {
    let text = _customMessages[key].message;
    if (subs && Array.isArray(subs)) {
      subs.forEach((sub, i) => {
        text = text.replace('$' + (i + 1), sub);
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
  try {
    return chrome.i18n.getMessage(key, subs) || key;
  } catch (e) {
    return key;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadCustomLanguage();
  await loadState();
  applyI18n();
  renderAll();
  setupTabs();

  // Open full options page
  document.getElementById('openOptionsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});

async function loadState() {
  state = await chrome.runtime.sendMessage({ action: 'getFullState' });
}

// Send refilter message directly to the active YouTube tab so it
// un-hides / re-hides content immediately (backup for storage.onChanged).
function notifyContentScript() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      // No tabs permission needed: sendMessage will silently fail if the
      // tab doesn't have our content script (non-YouTube pages).
      chrome.tabs.sendMessage(tabs[0].id, { action: 'refilterPage' }).catch(() => {});
    }
  });
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const m = cfMsg(el.dataset.i18n);
    if (m && m !== el.dataset.i18n) el.textContent = m;
  });
}

function renderAll() {
  renderBadge();
  renderStats();
  renderControls();
  renderBlocked();
  renderHidden();
  renderInterests();
}

function renderBadge() {
  const badge = document.getElementById('planBadge');
  badge.textContent = state.isPro ? cfMsg('pro') : cfMsg('free');
  badge.classList.toggle('badge-pro', state.isPro);
}

function renderStats() {
  document.getElementById('statBlocked').textContent = state.stats?.channelsBlocked || 0;
  document.getElementById('statHidden').textContent = state.stats?.videosHidden || 0;
  document.getElementById('statInterests').textContent = state.stats?.interestsSaved || 0;
}

function renderControls() {
  const container = document.getElementById('tab-controls');
  container.textContent = ''; // clear

  // Toggle: Hide Shorts (Free)
  container.appendChild(createToggle('hideShorts', 'hideShortsDesc', state.settings?.hideShorts, false, async (val) => {
    settingsUpdateInFlight = true;
    await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'hideShorts', value: val });
    state.settings.hideShorts = val;
    settingsUpdateInFlight = false;
  }));

  // Toggle: Interest Boundaries (Pro)
  container.appendChild(createToggle('interestBoundaries', 'interestBoundariesDesc', state.settings?.enableInterestBoundaries, !state.isPro, async (val) => {
    if (!state.isPro) { chrome.runtime.sendMessage({ action: 'openPaymentPage' }); return; }
    settingsUpdateInFlight = true;
    await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'enableInterestBoundaries', value: val });
    state.settings.enableInterestBoundaries = val;
    settingsUpdateInFlight = false;
  }));

  // Toggle: Smart Decay (Pro)
  container.appendChild(createToggle('smartDecay', 'smartDecayDesc', state.settings?.enableSmartDecay, !state.isPro, async (val) => {
    if (!state.isPro) { chrome.runtime.sendMessage({ action: 'openPaymentPage' }); return; }
    settingsUpdateInFlight = true;
    await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'enableSmartDecay', value: val });
    state.settings.enableSmartDecay = val;
    settingsUpdateInFlight = false;
  }));

  // Upgrade CTA (free users only)
  if (!state.isPro) {
    const cta = document.createElement('div');
    cta.className = 'upgrade-cta';

    const title = document.createElement('div');
    title.className = 'upgrade-title';
    title.textContent = cfMsg('unlockFeatures');
    cta.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.className = 'upgrade-subtitle';
    subtitle.textContent = 'Keyword Blocking + Interest Boundaries + Smart Decay + Hidden Log';
    cta.appendChild(subtitle);

    const btn = document.createElement('button');
    btn.className = 'upgrade-btn';
    btn.textContent = cfMsg('upgradeToPro');
    btn.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openPaymentPage' }));
    cta.appendChild(btn);

    container.appendChild(cta);
  }
}

function createToggle(titleKey, descKey, isActive, isLocked, onChange) {
  const item = document.createElement('div');
  item.className = 'toggle-item';

  const info = document.createElement('div');
  info.className = 'toggle-info';

  const titleRow = document.createElement('div');
  titleRow.className = 'toggle-title';

  const titleSpan = document.createElement('span');
  titleSpan.textContent = cfMsg(titleKey);
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
  desc.textContent = cfMsg(descKey);
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

function renderBlocked() {
  const container = document.getElementById('tab-blocked');
  container.textContent = '';

  // --- Blocked Channels Section ---
  const chHeader = document.createElement('div');
  chHeader.className = 'section-header';
  chHeader.textContent = cfMsg('blocked') + ' (' + (state.blockedChannels?.length || 0) + ')';
  container.appendChild(chHeader);

  const channels = state.blockedChannels || [];
  if (channels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = cfMsg('noBlockedChannels');
    container.appendChild(empty);
  } else {
    channels.forEach((ch, i) => {
      const item = document.createElement('div');
      item.className = 'list-item';

      const name = document.createElement('span');
      name.className = 'list-item-name';
      name.textContent = ch.name;
      item.appendChild(name);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'list-item-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'removeBlockedChannel', index: i });
        notifyContentScript();
        await loadState();
        renderAll();
      });
      item.appendChild(removeBtn);

      container.appendChild(item);
    });

    // Clear all button
    const clearBtn = document.createElement('button');
    clearBtn.className = 'clear-all-btn';
    clearBtn.textContent = cfMsg('clearAll');
    clearBtn.addEventListener('click', async () => {
      if (confirm(cfMsg('clearAllConfirm'))) {
        await chrome.runtime.sendMessage({ action: 'clearAllBlockedChannels' });
        notifyContentScript();
        await loadState();
        renderAll();
      }
    });
    container.appendChild(clearBtn);
  }

  // --- Category Blocking Section ---
  const catHeader = document.createElement('div');
  catHeader.className = 'section-header';
  catHeader.style.marginTop = '16px';
  catHeader.textContent = cfMsg('categoryBlocking') || 'Block by Topic';
  container.appendChild(catHeader);

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

  const blockedKwSet = new Set((state.blockedKeywords || []).map(k => k.keyword.toLowerCase()));
  const totalKeywords = (state.blockedKeywords || []).length;
  const atFreeLimit = !state.isPro && totalKeywords >= 3;

  const catGrid = document.createElement('div');
  catGrid.className = 'category-grid';

  for (const cat of CATEGORIES) {
    const isActive = blockedKwSet.has(cat.key);
    const isLocked = !isActive && atFreeLimit;
    const chip = document.createElement('button');
    chip.className = 'category-chip' + (isActive ? ' active' : '') + (isLocked ? ' locked' : '');
    chip.textContent = cat.label + (isLocked ? ' \uD83D\uDD12' : '');
    chip.addEventListener('click', async () => {
      if (isActive) {
        // Remove — find the index of this keyword
        const keywords = state.blockedKeywords || [];
        const idx = keywords.findIndex(k => k.keyword.toLowerCase() === cat.key);
        if (idx >= 0) {
          await chrome.runtime.sendMessage({ action: 'removeKeyword', index: idx });
        }
      } else {
        // Add
        const result = await chrome.runtime.sendMessage({ action: 'addKeyword', keyword: cat.key });
        if (result.reason === 'free_limit') {
          alert(cfMsg('keywordLimitToast'));
          return;
        }
      }
      notifyContentScript();
      await loadState();
      renderAll();
    });
    catGrid.appendChild(chip);
  }

  container.appendChild(catGrid);

  // --- Custom Keywords Section ---
  const kwHeader = document.createElement('div');
  kwHeader.className = 'section-header';
  kwHeader.style.marginTop = '16px';

  const keywords = state.blockedKeywords || [];
  const kwCount = keywords.length;

  const customKwLabel = cfMsg('customKeywords') || 'Custom Keywords';
  const catKeys = new Set(CATEGORIES.map(c => c.key));
  const customKwCount = keywords.filter(kw => !catKeys.has(kw.keyword.toLowerCase())).length;
  if (!state.isPro) {
    kwHeader.textContent = customKwLabel + ' (' + cfMsg('keywordsUsed', [customKwCount.toString()]) + ')';
  } else {
    kwHeader.textContent = customKwLabel + ' (' + customKwCount + ')';
  }
  container.appendChild(kwHeader);

  // Add keyword input
  const inputRow = document.createElement('div');
  inputRow.className = 'keyword-input-row';

  const input = document.createElement('input');
  input.className = 'keyword-input';
  input.type = 'text';
  input.placeholder = cfMsg('addKeywordPlaceholder');
  inputRow.appendChild(input);

  const addBtn = document.createElement('button');
  addBtn.className = 'keyword-add-btn';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', async () => {
    const kw = input.value.trim();
    if (!kw) return;
    const result = await chrome.runtime.sendMessage({ action: 'addKeyword', keyword: kw });
    if (result.success) {
      input.value = '';
      await loadState();
      renderAll();
    } else if (result.reason === 'free_limit') {
      alert(cfMsg('keywordLimitToast'));
    } else if (result.reason === 'already_exists') {
      alert('Keyword already exists.');
    }
  });

  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addBtn.click();
  });

  inputRow.appendChild(addBtn);
  container.appendChild(inputRow);

  // Keyword list — filter out category names (shown above as chips)
  const categoryKeys = new Set(CATEGORIES.map(c => c.key));
  const customKeywords = keywords.filter(kw => !categoryKeys.has(kw.keyword.toLowerCase()));

  if (customKeywords.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = cfMsg('noBlockedKeywords');
    container.appendChild(empty);
  } else {
    customKeywords.forEach((kw) => {
      const i = keywords.indexOf(kw); // real index for removal
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
        renderAll();
      });
      item.appendChild(removeBtn);

      container.appendChild(item);
    });
  }
}

function renderHidden() {
  const container = document.getElementById('tab-hidden');
  container.textContent = '';

  if (!state.isPro) {
    const upgrade = document.createElement('div');
    upgrade.className = 'empty-state';
    upgrade.textContent = cfMsg('hiddenVideosUpgrade');
    container.appendChild(upgrade);
    return;
  }

  const videos = state.hiddenVideos || [];

  if (videos.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = cfMsg('noHiddenVideos');
    container.appendChild(empty);
    return;
  }

  videos.forEach((vid, i) => {
    const item = document.createElement('div');
    item.className = 'list-item hidden-item';

    const info = document.createElement('div');
    info.className = 'list-item-info';

    const title = document.createElement('span');
    title.className = 'list-item-name';
    title.textContent = vid.title;
    info.appendChild(title);

    const reason = document.createElement('span');
    reason.className = 'list-item-reason';
    if (vid.reason.startsWith('keyword:')) {
      reason.textContent = cfMsg('keywordReason', [vid.reason.split(':')[1]]);
    } else if (vid.reason.startsWith('channel:')) {
      reason.textContent = cfMsg('channelReason', [vid.reason.split(':')[1]]);
    } else {
      reason.textContent = vid.reason;
    }
    info.appendChild(reason);

    item.appendChild(info);

    const undoBtn = document.createElement('button');
    undoBtn.className = 'list-item-undo';
    undoBtn.textContent = cfMsg('undoHide');
    undoBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'removeHiddenVideo', index: i });
      await loadState();
      renderAll();
    });
    item.appendChild(undoBtn);

    container.appendChild(item);
  });
}

function renderInterests() {
  const container = document.getElementById('tab-interests');
  container.textContent = '';

  if (!state.isPro) {
    const upgrade = document.createElement('div');
    upgrade.className = 'empty-state';
    upgrade.textContent = cfMsg('interestsUpgrade');
    container.appendChild(upgrade);
    return;
  }

  const interests = state.interests || {};
  const keys = Object.keys(interests);

  if (keys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = cfMsg('noInterests');
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
      meta.textContent = cfMsg('curiosityToday') + ' (' + remaining + 'h)';
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
      renderAll();
    });
    item.appendChild(removeBtn);

    container.appendChild(item);
  });
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });
}

// Live updates — skip re-render for stat-only changes and in-flight settings updates
chrome.storage.onChanged.addListener(async (changes) => {
  const keys = Object.keys(changes);
  const statOnly = keys.length === 1 && keys[0] === 'stats';
  if (statOnly) {
    // Just update the stat counters without rebuilding the whole UI
    const newStats = changes.stats.newValue;
    if (newStats) {
      document.getElementById('statBlocked').textContent = newStats.channelsBlocked || 0;
      document.getElementById('statHidden').textContent = newStats.videosHidden || 0;
      document.getElementById('statInterests').textContent = newStats.interestsSaved || 0;
    }
    return;
  }
  // Skip re-render if we're mid-toggle update to avoid reverting visual state
  if (settingsUpdateInFlight && keys.length === 1 && keys[0] === 'settings') return;
  await loadState();
  renderAll();
});
