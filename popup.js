// CleanFeed Popup Script

let state = {};

document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  applyI18n();
  renderAll();
  setupTabs();
});

async function loadState() {
  state = await chrome.runtime.sendMessage({ action: 'getFullState' });
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const msg = chrome.i18n.getMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
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
  badge.textContent = state.isPro ? chrome.i18n.getMessage('pro') : chrome.i18n.getMessage('free');
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
    await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'hideShorts', value: val });
    state.settings.hideShorts = val;
  }));

  // Toggle: Interest Boundaries (Pro)
  container.appendChild(createToggle('interestBoundaries', 'interestBoundariesDesc', state.settings?.enableInterestBoundaries, !state.isPro, async (val) => {
    if (!state.isPro) { chrome.runtime.sendMessage({ action: 'openPaymentPage' }); return; }
    await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'enableInterestBoundaries', value: val });
    state.settings.enableInterestBoundaries = val;
  }));

  // Toggle: Smart Decay (Pro)
  container.appendChild(createToggle('smartDecay', 'smartDecayDesc', state.settings?.enableSmartDecay, !state.isPro, async (val) => {
    if (!state.isPro) { chrome.runtime.sendMessage({ action: 'openPaymentPage' }); return; }
    await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'enableSmartDecay', value: val });
    state.settings.enableSmartDecay = val;
  }));

  // Upgrade CTA (free users only)
  if (!state.isPro) {
    const cta = document.createElement('div');
    cta.className = 'upgrade-cta';

    const title = document.createElement('div');
    title.className = 'upgrade-title';
    title.textContent = chrome.i18n.getMessage('unlockFeatures');
    cta.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.className = 'upgrade-subtitle';
    subtitle.textContent = 'Keyword Blocking + Interest Boundaries + Smart Decay + Hidden Log';
    cta.appendChild(subtitle);

    const btn = document.createElement('button');
    btn.className = 'upgrade-btn';
    btn.textContent = chrome.i18n.getMessage('upgradeToPro');
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
  titleSpan.textContent = chrome.i18n.getMessage(titleKey);
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
  desc.textContent = chrome.i18n.getMessage(descKey);
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
  chHeader.textContent = chrome.i18n.getMessage('blocked') + ' (' + (state.blockedChannels?.length || 0) + ')';
  container.appendChild(chHeader);

  const channels = state.blockedChannels || [];
  if (channels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = chrome.i18n.getMessage('noBlockedChannels');
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
        await loadState();
        renderAll();
      });
      item.appendChild(removeBtn);

      container.appendChild(item);
    });

    // Clear all button
    const clearBtn = document.createElement('button');
    clearBtn.className = 'clear-all-btn';
    clearBtn.textContent = chrome.i18n.getMessage('clearAll');
    clearBtn.addEventListener('click', async () => {
      if (confirm(chrome.i18n.getMessage('clearAllConfirm'))) {
        await chrome.runtime.sendMessage({ action: 'clearAllBlockedChannels' });
        await loadState();
        renderAll();
      }
    });
    container.appendChild(clearBtn);
  }

  // --- Blocked Keywords Section ---
  const kwHeader = document.createElement('div');
  kwHeader.className = 'section-header';
  kwHeader.style.marginTop = '16px';

  const keywords = state.blockedKeywords || [];
  const kwCount = keywords.length;

  if (!state.isPro) {
    kwHeader.textContent = chrome.i18n.getMessage('keywordBlocking') + ' (' + chrome.i18n.getMessage('keywordsUsed', [kwCount.toString()]) + ')';
  } else {
    kwHeader.textContent = chrome.i18n.getMessage('keywordBlocking') + ' (' + kwCount + ')';
  }
  container.appendChild(kwHeader);

  // Add keyword input
  const inputRow = document.createElement('div');
  inputRow.className = 'keyword-input-row';

  const input = document.createElement('input');
  input.className = 'keyword-input';
  input.type = 'text';
  input.placeholder = chrome.i18n.getMessage('addKeywordPlaceholder');
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
      alert(chrome.i18n.getMessage('keywordLimitToast'));
    } else if (result.reason === 'already_exists') {
      alert('Keyword already exists.');
    }
  });

  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addBtn.click();
  });

  inputRow.appendChild(addBtn);
  container.appendChild(inputRow);

  // Keyword list
  if (keywords.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = chrome.i18n.getMessage('noBlockedKeywords');
    container.appendChild(empty);
  } else {
    keywords.forEach((kw, i) => {
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
    upgrade.textContent = chrome.i18n.getMessage('hiddenVideosUpgrade');
    container.appendChild(upgrade);
    return;
  }

  const videos = state.hiddenVideos || [];

  if (videos.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = chrome.i18n.getMessage('noHiddenVideos');
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
      reason.textContent = chrome.i18n.getMessage('keywordReason', [vid.reason.split(':')[1]]);
    } else if (vid.reason.startsWith('channel:')) {
      reason.textContent = chrome.i18n.getMessage('channelReason', [vid.reason.split(':')[1]]);
    } else {
      reason.textContent = vid.reason;
    }
    info.appendChild(reason);

    item.appendChild(info);

    const undoBtn = document.createElement('button');
    undoBtn.className = 'list-item-undo';
    undoBtn.textContent = chrome.i18n.getMessage('undoHide');
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
    upgrade.textContent = chrome.i18n.getMessage('interestsUpgrade');
    container.appendChild(upgrade);
    return;
  }

  const interests = state.interests || {};
  const keys = Object.keys(interests);

  if (keys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = chrome.i18n.getMessage('noInterests');
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
      meta.textContent = chrome.i18n.getMessage('curiosityToday') + ' (' + remaining + 'h)';
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

// Live updates
chrome.storage.onChanged.addListener(async () => {
  await loadState();
  renderAll();
});
