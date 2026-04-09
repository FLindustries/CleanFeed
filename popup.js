// CleanFeed Popup Script

let state = {};

document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  applyI18n();
  renderUI();
  setupTabSwitching();
  setupToggles();
  setupActions();
});

// --- Load State ---

async function loadState() {
  state = await chrome.runtime.sendMessage({ action: 'getSettings' });
}

// --- i18n ---

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
}

// --- Render ---

function renderUI() {
  // Plan badge
  const badge = document.getElementById('planBadge');
  badge.textContent = state.isPro
    ? chrome.i18n.getMessage('pro')
    : chrome.i18n.getMessage('free');
  badge.classList.toggle('badge-pro', state.isPro);

  // Stats
  document.getElementById('statBlocked').textContent = state.stats?.channelsBlocked || 0;
  document.getElementById('statHidden').textContent = state.stats?.videosHidden || 0;
  document.getElementById('statInterests').textContent = state.stats?.interestsSaved || 0;

  // Toggles
  setToggle('toggleSearchOnly', state.settings?.searchOnlyMode);
  setToggle('toggleInterestBoundaries', state.settings?.enableInterestBoundaries);
  setToggle('toggleSmartDecay', state.settings?.enableSmartDecay);

  // Pro gating
  if (!state.isPro) {
    document.getElementById('toggleInterestBoundaries').classList.add('locked');
    document.getElementById('toggleSmartDecay').classList.add('locked');
    document.getElementById('upgradeCta').style.display = 'block';
    document.getElementById('ibProBadge').style.display = 'inline';
    document.getElementById('sdProBadge').style.display = 'inline';
    document.getElementById('interestsProBadge').style.display = 'inline';
  } else {
    document.getElementById('toggleInterestBoundaries').classList.remove('locked');
    document.getElementById('toggleSmartDecay').classList.remove('locked');
    document.getElementById('upgradeCta').style.display = 'none';
    document.getElementById('ibProBadge').style.display = 'none';
    document.getElementById('sdProBadge').style.display = 'none';
    document.getElementById('interestsProBadge').style.display = 'none';
  }

  renderBlockedList();
  renderInterestsList();
}

function setToggle(id, active) {
  const el = document.getElementById(id);
  if (active) {
    el.classList.add('active');
  } else {
    el.classList.remove('active');
  }
}

function renderBlockedList() {
  const list = document.getElementById('blockedList');
  const channels = state.blockedChannels || [];

  if (channels.length === 0) {
    list.innerHTML = `<div class="empty-state">${chrome.i18n.getMessage('emptyBlockedList')}</div>`;
    return;
  }

  list.innerHTML = channels.map((ch, i) => `
    <div class="list-item">
      <span class="list-item-name">${escapeHtml(ch.name)}</span>
      <button class="list-item-remove" data-index="${i}">&times;</button>
    </div>
  `).join('');

  list.querySelectorAll('.list-item-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const index = parseInt(btn.dataset.index);
      await chrome.runtime.sendMessage({ action: 'removeBlockedChannel', index });
      await loadState();
      renderUI();
    });
  });
}

function renderInterestsList() {
  const list = document.getElementById('interestsList');
  const interests = state.interests || {};
  const keys = Object.keys(interests);

  if (keys.length === 0) {
    list.innerHTML = '<div class="empty-state">No interests saved yet.</div>';
    return;
  }

  list.innerHTML = keys.map(key => {
    const interest = interests[key];
    const daysAgo = Math.floor((Date.now() - interest.lastUsed) / (24 * 60 * 60 * 1000));
    const daysLeft = Math.max(0, 30 - daysAgo);

    return `
      <div class="list-item">
        <div class="list-item-info">
          <span class="list-item-name">${escapeHtml(interest.query)}</span>
          <span class="list-item-meta">${daysLeft} days until decay</span>
        </div>
        <button class="list-item-remove" data-key="${escapeHtml(key)}">&times;</button>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.list-item-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.key;
      await chrome.runtime.sendMessage({ action: 'removeInterest', key });
      await loadState();
      renderUI();
    });
  });
}

// --- Tab Switching ---

function setupTabSwitching() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;

      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      document.getElementById(`tab-${target}`).classList.add('active');
    });
  });
}

// --- Toggles ---

function setupToggles() {
  document.getElementById('toggleSearchOnly').addEventListener('click', async () => {
    const newVal = !state.settings.searchOnlyMode;
    await chrome.runtime.sendMessage({
      action: 'updateSetting', key: 'searchOnlyMode', value: newVal
    });
    state.settings.searchOnlyMode = newVal;
    renderUI();
  });

  document.getElementById('toggleInterestBoundaries').addEventListener('click', async function() {
    if (this.classList.contains('locked')) {
      chrome.runtime.sendMessage({ action: 'openPaymentPage' });
      return;
    }
    const newVal = !state.settings.enableInterestBoundaries;
    await chrome.runtime.sendMessage({
      action: 'updateSetting', key: 'enableInterestBoundaries', value: newVal
    });
    state.settings.enableInterestBoundaries = newVal;
    renderUI();
  });

  document.getElementById('toggleSmartDecay').addEventListener('click', async function() {
    if (this.classList.contains('locked')) {
      chrome.runtime.sendMessage({ action: 'openPaymentPage' });
      return;
    }
    const newVal = !state.settings.enableSmartDecay;
    await chrome.runtime.sendMessage({
      action: 'updateSetting', key: 'enableSmartDecay', value: newVal
    });
    state.settings.enableSmartDecay = newVal;
    renderUI();
  });
}

// --- Actions ---

function setupActions() {
  document.getElementById('clearAllBtn').addEventListener('click', async () => {
    if (confirm(chrome.i18n.getMessage('clearAllConfirm'))) {
      await chrome.runtime.sendMessage({ action: 'clearAllBlocked' });
      await loadState();
      renderUI();
    }
  });

  document.getElementById('upgradeBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openPaymentPage' });
  });
}

// --- Utilities ---

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Listen for storage changes
chrome.storage.onChanged.addListener(async () => {
  await loadState();
  renderUI();
});
