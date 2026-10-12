// CleanFeed Options Page Script
// Topics and their synonyms (KEYWORD_SYNONYMS, CATEGORY_META, cfCategoryList,
// cfBuiltInTerms) come from content-dom.js, loaded before this script.

let state = {};

// Preset profiles — curated bundles of category keys for one-click setup.
// Each preset's `keys` must exist in CATEGORY_META / KEYWORD_SYNONYMS (content-dom.js).
// Exactly 3 topics each: the free plan holds 3 keywords and topics, so a free
// user with nothing blocked can apply any one preset whole.
const PRESETS = [
  { id: 'focus_mode', emoji: '\u{1F3AF}', label: 'Focus mode', desc: 'No gaming, drama, brainrot', keys: ['gaming', 'gossip', 'brainrot'] },
  { id: 'detox_hustle', emoji: '\u{1F4B0}', label: 'Hustle detox', desc: 'No "get rich quick" content', keys: ['hustle', 'crypto', 'gambling'] },
  { id: 'parent_safe', emoji: '\u{1F468}‍\u{1F469}‍\u{1F467}', label: 'Parent / family safe', desc: 'Filter brainrot, horror, NSFW', keys: ['brainrot', 'nsfw', 'horror'] },
  { id: 'no_politics', emoji: '\u{1F5F3}️', label: 'Politics-free zone', desc: 'No politics, news, conspiracy', keys: ['politics', 'news', 'conspiracy'] },
  { id: 'no_drama', emoji: '\u{1F3AD}', label: 'Drama-free', desc: 'No gossip, reactions, pranks', keys: ['gossip', 'reaction', 'pranks'] }
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
  // Try custom messages first (if language override is set), formatted
  // like chrome.i18n (content-dom.js)
  if (_customMessages && _customMessages[key]) return cfFormatMessage(_customMessages[key], subs);
  // Fallback to chrome.i18n native API
  try {
    const m = chrome.i18n.getMessage(key, subs);
    return m || key;
  } catch (e) {
    return key;
  }
}

// Removes the UI of features hidden in features.js: every element marked
// data-cf-feature="<flag>" whose CF_FEATURES flag is off.
function removeHiddenFeatureUI() {
  document.querySelectorAll('[data-cf-feature]').forEach(el => {
    if (!CF_FEATURES[el.dataset.cfFeature]) el.remove();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  removeHiddenFeatureUI();
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
  try {
    const result = await chrome.runtime.sendMessage({ action: 'getFullState' });
    state = result || {};
  } catch (e) {
    // Service worker can be dormant on cold open. Fall back to an empty state
    // so the page still renders instead of throwing and leaving a blank UI.
    console.warn('CleanFeed: getFullState failed, retrying once', e);
    try {
      await new Promise(r => setTimeout(r, 100));
      const retry = await chrome.runtime.sendMessage({ action: 'getFullState' });
      state = retry || {};
    } catch (e2) {
      state = {};
    }
  }
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
  renderPresets();
  renderSettings();
  renderChannels();
  renderCategories();
  renderKeywords();
  renderHidden();
  renderInterests();
  renderStats();
  renderUpgrade();
}

// ── Preset Profiles ──

function renderPresets() {
  const container = document.getElementById('presets-grid');
  if (!container) return;
  container.textContent = '';
  const blockedKwSet = new Set((state.blockedKeywords || []).map(k => k.keyword.toLowerCase()));

  for (const preset of PRESETS) {
    const card = document.createElement('button');
    card.className = 'preset-card';
    // If ALL preset keys already blocked, mark active
    const allActive = preset.keys.every(k => blockedKwSet.has(k.toLowerCase()));
    if (allActive) card.classList.add('preset-active');

    const emoji = document.createElement('span');
    emoji.className = 'preset-emoji';
    emoji.textContent = preset.emoji;

    const text = document.createElement('div');
    text.className = 'preset-text';
    const label = document.createElement('div');
    label.className = 'preset-label';
    label.textContent = preset.label;
    const desc = document.createElement('div');
    desc.className = 'preset-desc';
    desc.textContent = preset.desc;
    text.appendChild(label);
    text.appendChild(desc);

    const status = document.createElement('div');
    status.className = 'preset-status';
    const activeCount = preset.keys.filter(k => blockedKwSet.has(k.toLowerCase())).length;
    status.textContent = activeCount + '/' + preset.keys.length;

    card.appendChild(emoji);
    card.appendChild(text);
    card.appendChild(status);

    card.addEventListener('click', async () => {
      const res = await chrome.runtime.sendMessage({ action: 'applyPreset', categoryKeys: preset.keys });
      if (res?.reason === 'free_limit') {
        presetLimitNotice = { id: preset.id, limit: res.limit || 3 };
        await loadState();
        renderPresets();
        return;
      }
      presetLimitNotice = null;
      if (res?.success) {
        await loadState();
        renderAll();
        notifyContentScript();
      }
    });
    container.appendChild(card);
  }
  renderPresetLimitNotice(blockedKwSet);
}

// Free plan: the preset last clicked did not fit. { id, limit } or null.
let presetLimitNotice = null;

// Says why that preset was not applied (topics it adds, free slots left,
// from the current state) with an Upgrade button the user can choose to
// click. Hidden once the preset fits or the user is Pro.
function renderPresetLimitNotice(blockedKwSet) {
  const notice = document.getElementById('presets-notice');
  if (!notice) return;
  notice.textContent = '';
  const preset = presetLimitNotice && PRESETS.find(p => p.id === presetLimitNotice.id);
  const limit = presetLimitNotice ? presetLimitNotice.limit : 0;
  const used = (state.blockedKeywords || []).length;
  const add = preset ? preset.keys.filter(k => !blockedKwSet.has(k.toLowerCase())).length : 0;
  if (!preset || state.isPro || add === 0 || used + add <= limit) {
    presetLimitNotice = null;
    notice.hidden = true;
    return;
  }
  const text = document.createElement('p');
  text.textContent = msg('presetFreeLimitWarning', [String(add), String(Math.max(0, limit - used)), String(limit)]);
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.textContent = msg('upgradeToPro');
  btn.addEventListener('click', () => openUpgrade());
  notice.appendChild(text);
  notice.appendChild(btn);
  notice.hidden = false;
}

function renderStats() {
  const cardsContainer = document.getElementById('stats-cards');
  const catsContainer = document.getElementById('stats-categories');
  if (!cardsContainer || !catsContainer) return;

  cardsContainer.textContent = '';
  catsContainer.textContent = '';

  const channelsBlocked = (state.blockedChannels || []).length;
  const videosHidden = (state.hiddenVideos || []).length;
  const interestsSaved = Object.keys(state.interests || {}).length;
  // Rough estimate: avg YouTube video is 8 minutes
  const hoursSaved = Math.round(videosHidden * 8 / 60 * 10) / 10;

  const cards = [
    { value: videosHidden, label: msg('statsVideosHidden') !== 'statsVideosHidden' ? msg('statsVideosHidden') : 'Videos filtered' },
    { value: channelsBlocked, label: msg('statsChannelsBlocked') !== 'statsChannelsBlocked' ? msg('statsChannelsBlocked') : 'Channels blocked' },
    { value: hoursSaved + 'h', label: msg('statsHoursSaved') !== 'statsHoursSaved' ? msg('statsHoursSaved') : 'Hours saved (est.)' }
  ];
  if (CF_FEATURES.interestBoundaries) {
    cards.push({ value: interestsSaved, label: msg('statsInterestsSaved') !== 'statsInterestsSaved' ? msg('statsInterestsSaved') : 'Interests saved' });
  }

  for (const c of cards) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const v = document.createElement('div');
    v.className = 'stat-card-value';
    v.textContent = c.value;
    const l = document.createElement('div');
    l.className = 'stat-card-label';
    l.textContent = c.label;
    card.appendChild(v);
    card.appendChild(l);
    cardsContainer.appendChild(card);
  }

  // Category breakdown from categoryTags — count channels tagged per category.
  // categoryTags has shape { [category]: [channelId, channelId, ...] } so we
  // can simply use array length as the "total" per category.
  const categoryTags = state.categoryTags || {};
  const totalsByCategory = [];
  for (const [cat, channelArray] of Object.entries(categoryTags)) {
    const total = Array.isArray(channelArray) ? channelArray.length : 0;
    if (total > 0) totalsByCategory.push({ cat, total });
  }
  totalsByCategory.sort((a, b) => b.total - a.total);
  const top5 = totalsByCategory.slice(0, 5);

  if (top5.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = msg('statsNoData') !== 'statsNoData' ? msg('statsNoData') : 'Browse YouTube with CleanFeed enabled and stats will appear here.';
    catsContainer.appendChild(empty);
    return;
  }

  const maxCount = top5[0].total;
  for (const item of top5) {
    const row = document.createElement('div');
    row.className = 'stats-bar-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'stats-bar-label';
    labelEl.textContent = cfCategoryLabel(item.cat);
    const barWrap = document.createElement('div');
    barWrap.className = 'stats-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'stats-bar-fill';
    bar.style.width = Math.round((item.total / maxCount) * 100) + '%';
    barWrap.appendChild(bar);
    const countEl = document.createElement('span');
    countEl.className = 'stats-bar-count';
    countEl.textContent = item.total;
    row.appendChild(labelEl);
    row.appendChild(barWrap);
    row.appendChild(countEl);
    catsContainer.appendChild(row);
  }
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
    const res = await sendWithStrict({ action: 'updateSetting', key: 'hideShorts', value: val });
    if (res?.error) { renderSettings(); return; } // refused: show the real state again
    state.settings.hideShorts = val;
    notifyContentScript();
  }));

  container.appendChild(createToggle('hideComments', 'hideCommentsDesc', state.settings?.hideComments, false, async (val) => {
    const res = await sendWithStrict({ action: 'updateSetting', key: 'hideComments', value: val });
    if (res?.error) { renderSettings(); return; }
    state.settings.hideComments = val;
    notifyContentScript();
  }));

  // Daily time limit toggle and minutes — only while the feature exists (features.js)
  if (CF_FEATURES.dailyTimeLimit) {
    container.appendChild(createToggle('dailyTimeLimit', 'dailyTimeLimitDesc', state.settings?.dailyTimeLimitEnabled, false, async (val) => {
      await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'dailyTimeLimitEnabled', value: val });
      state.settings.dailyTimeLimitEnabled = val;
      notifyContentScript();
    }));

    // Minutes input
    const minsItem = document.createElement('div');
    minsItem.className = 'toggle-item';
    const minsInfo = document.createElement('div');
    minsInfo.className = 'toggle-info';
    const minsTitle = document.createElement('div');
    minsTitle.className = 'toggle-title';
    const minsTitleSpan = document.createElement('span');
    minsTitleSpan.textContent = msg('dailyTimeLimitMins') !== 'dailyTimeLimitMins' ? msg('dailyTimeLimitMins') : 'Time limit (minutes)';
    minsTitle.appendChild(minsTitleSpan);
    minsInfo.appendChild(minsTitle);
    const minsDesc = document.createElement('div');
    minsDesc.className = 'toggle-desc';
    minsDesc.textContent = msg('dailyTimeLimitMinsDesc') !== 'dailyTimeLimitMinsDesc' ? msg('dailyTimeLimitMinsDesc') : 'How many minutes per day before YouTube locks';
    minsInfo.appendChild(minsDesc);
    minsItem.appendChild(minsInfo);
    const minsInput = document.createElement('input');
    minsInput.type = 'number';
    minsInput.min = '5';
    minsInput.max = '480';
    minsInput.value = state.settings?.dailyTimeLimitMins || 30;
    minsInput.style.cssText = 'width:80px;padding:6px 10px;border:1px solid var(--cf-border, #e0e0e0);border-radius:6px;font-size:13px;text-align:center;';
    minsInput.addEventListener('change', async () => {
      const val = parseInt(minsInput.value, 10) || 30;
      await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'dailyTimeLimitMins', value: val });
      state.settings.dailyTimeLimitMins = val;
    });
    minsItem.appendChild(minsInput);
    container.appendChild(minsItem);
  }

  // Interest Boundaries (Pro) — only while the feature exists (features.js)
  if (CF_FEATURES.interestBoundaries) {
    container.appendChild(createToggle('interestBoundaries', 'interestBoundariesDesc', state.settings?.enableInterestBoundaries, !state.isPro, async (val) => {
      if (!state.isPro) { openUpgrade(); return; }
      await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'enableInterestBoundaries', value: val });
      state.settings.enableInterestBoundaries = val;
    }));
  }

  // Smart Decay (Pro) — only while the feature exists (features.js)
  if (CF_FEATURES.smartDecay) {
    container.appendChild(createToggle('smartDecay', 'smartDecayDesc', state.settings?.enableSmartDecay, !state.isPro, async (val) => {
      if (!state.isPro) { openUpgrade(); return; }
      await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'enableSmartDecay', value: val });
      state.settings.enableSmartDecay = val;
    }));
  }

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

  // Schedule mode (Pro feature) — only while the feature exists (features.js)
  if (CF_FEATURES.schedule) {
    const schedItem = document.createElement('div');
    schedItem.className = 'toggle-item';
    const schedInfo = document.createElement('div');
    schedInfo.className = 'toggle-info';
    const schedTitleRow = document.createElement('div');
    schedTitleRow.className = 'toggle-title';
    const schedTitle = document.createElement('span');
    schedTitle.textContent = msg('scheduleMode') !== 'scheduleMode' ? msg('scheduleMode') : 'Schedule mode';
    schedTitleRow.appendChild(schedTitle);
    if (!state.isPro) {
      const pro = document.createElement('span');
      pro.className = 'pro-badge-inline';
      pro.textContent = 'PRO';
      schedTitleRow.appendChild(pro);
    }
    schedInfo.appendChild(schedTitleRow);
    const schedDesc = document.createElement('div');
    schedDesc.className = 'toggle-desc';
    schedDesc.textContent = msg('scheduleModeDesc') !== 'scheduleModeDesc'
      ? msg('scheduleModeDesc')
      : 'Apply CleanFeed only during specific hours (e.g. work hours)';
    schedInfo.appendChild(schedDesc);
    schedItem.appendChild(schedInfo);

    const schedToggle = document.createElement('div');
    schedToggle.className = 'toggle-switch' + (state.settings?.scheduleEnabled ? ' active' : '') + (!state.isPro ? ' locked' : '');
    const schedKnob = document.createElement('div');
    schedKnob.className = 'toggle-knob';
    schedToggle.appendChild(schedKnob);
    schedToggle.addEventListener('click', async () => {
      if (!state.isPro) { openUpgrade(); return; }
      const newVal = !schedToggle.classList.contains('active');
      schedToggle.classList.toggle('active', newVal);
      await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'scheduleEnabled', value: newVal });
      state.settings.scheduleEnabled = newVal;
      notifyContentScript();
      renderSettings(); // re-render to show/hide time pickers
    });
    schedItem.appendChild(schedToggle);
    container.appendChild(schedItem);

    // Time picker rows — only show when schedule enabled and Pro
    if (state.isPro && state.settings?.scheduleEnabled) {
      const timesRow = document.createElement('div');
      timesRow.className = 'toggle-item';
      timesRow.style.cssText = 'gap:12px;justify-content:flex-start;padding-left:28px;';

      const fromLabel = document.createElement('span');
      fromLabel.textContent = msg('scheduleFrom') !== 'scheduleFrom' ? msg('scheduleFrom') : 'From';
      fromLabel.style.cssText = 'font-size:13px;color:var(--cf-text-secondary,#606060);';

      const fromInput = document.createElement('input');
      fromInput.type = 'time';
      fromInput.value = state.settings?.scheduleStart || '09:00';
      fromInput.style.cssText = 'padding:6px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;';
      fromInput.addEventListener('change', async () => {
        await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'scheduleStart', value: fromInput.value });
        state.settings.scheduleStart = fromInput.value;
        notifyContentScript();
      });

      const toLabel = document.createElement('span');
      toLabel.textContent = msg('scheduleTo') !== 'scheduleTo' ? msg('scheduleTo') : 'to';
      toLabel.style.cssText = 'font-size:13px;color:var(--cf-text-secondary,#606060);';

      const toInput = document.createElement('input');
      toInput.type = 'time';
      toInput.value = state.settings?.scheduleEnd || '18:00';
      toInput.style.cssText = 'padding:6px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;';
      toInput.addEventListener('change', async () => {
        await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'scheduleEnd', value: toInput.value });
        state.settings.scheduleEnd = toInput.value;
        notifyContentScript();
      });

      timesRow.appendChild(fromLabel);
      timesRow.appendChild(fromInput);
      timesRow.appendChild(toLabel);
      timesRow.appendChild(toInput);
      container.appendChild(timesRow);

      // Day picker
      const daysRow = document.createElement('div');
      daysRow.className = 'toggle-item';
      daysRow.style.cssText = 'gap:6px;justify-content:flex-start;padding-left:28px;flex-wrap:wrap;';
      const dayLabel = document.createElement('span');
      dayLabel.textContent = msg('scheduleDays') !== 'scheduleDays' ? msg('scheduleDays') : 'Days:';
      dayLabel.style.cssText = 'font-size:13px;color:var(--cf-text-secondary,#606060);margin-right:8px;';
      daysRow.appendChild(dayLabel);

      const dayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const dayLabelsIt = ['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
      const useIt = (state.settings?.language === 'it') || (navigator.language?.startsWith('it'));
      const labels = useIt ? dayLabelsIt : dayLabels;
      const activeDays = new Set(state.settings?.scheduleDays || [1,2,3,4,5]);

      for (let d = 0; d < 7; d++) {
        const chip = document.createElement('button');
        chip.className = 'day-chip' + (activeDays.has(d) ? ' active' : '');
        chip.textContent = labels[d];
        chip.style.cssText = 'padding:4px 8px;font-size:11px;border:1px solid ' + (activeDays.has(d) ? '#00c853' : '#e0e0e0') + ';background:' + (activeDays.has(d) ? '#00c853' : 'transparent') + ';color:' + (activeDays.has(d) ? '#fff' : '#0f0f0f') + ';border-radius:999px;cursor:pointer;';
        chip.addEventListener('click', async () => {
          const cur = new Set(state.settings?.scheduleDays || []);
          if (cur.has(d)) cur.delete(d);
          else cur.add(d);
          const arr = [...cur].sort();
          await chrome.runtime.sendMessage({ action: 'updateSetting', key: 'scheduleDays', value: arr });
          state.settings.scheduleDays = arr;
          notifyContentScript();
          renderSettings();
        });
        daysRow.appendChild(chip);
      }
      container.appendChild(daysRow);
    }
  }

  // Strict mode (Pro feature)
  const strictItem = document.createElement('div');
  strictItem.className = 'toggle-item';
  const strictInfo = document.createElement('div');
  strictInfo.className = 'toggle-info';
  const strictTitleRow = document.createElement('div');
  strictTitleRow.className = 'toggle-title';
  const strictTitle = document.createElement('span');
  strictTitle.textContent = msg('strictMode') !== 'strictMode' ? msg('strictMode') : 'Strict mode';
  strictTitleRow.appendChild(strictTitle);
  // Enabling strict mode is Pro; turning it off never is (also after Pro lapsed)
  const strictOn = !!state.settings?.strictModeEnabled;
  const strictProLocked = !state.isPro && !strictOn;
  if (strictProLocked) {
    const pro = document.createElement('span');
    pro.className = 'pro-badge-inline';
    pro.textContent = 'PRO';
    strictTitleRow.appendChild(pro);
  }
  strictInfo.appendChild(strictTitleRow);
  const strictDesc = document.createElement('div');
  strictDesc.className = 'toggle-desc';
  strictDesc.textContent = msg('strictModeDesc') !== 'strictModeDesc'
    ? msg('strictModeDesc')
    : "Lock CleanFeed behind a password — you can't weaken filters without entering it.";
  strictInfo.appendChild(strictDesc);
  strictItem.appendChild(strictInfo);

  const strictToggle = document.createElement('div');
  strictToggle.className = 'toggle-switch' + (strictOn ? ' active' : '') + (strictProLocked ? ' locked' : '');
  const strictKnob = document.createElement('div');
  strictKnob.className = 'toggle-knob';
  strictToggle.appendChild(strictKnob);
  strictToggle.addEventListener('click', async () => {
    const currentlyEnabled = strictToggle.classList.contains('active');
    if (!currentlyEnabled && !state.isPro) { openUpgrade(); return; }
    if (!currentlyEnabled) {
      const pwd = prompt(msg('strictSetPassword') !== 'strictSetPassword'
        ? msg('strictSetPassword')
        : "Set a password (you'll need this to disable strict mode):");
      if (!pwd || pwd.length < 4) {
        alert(msg('strictPasswordTooShort') !== 'strictPasswordTooShort'
          ? msg('strictPasswordTooShort')
          : 'Password must be at least 4 characters.');
        return;
      }
      const confirmPwd = prompt(msg('strictConfirmPassword') !== 'strictConfirmPassword'
        ? msg('strictConfirmPassword')
        : 'Confirm password:');
      if (pwd !== confirmPwd) {
        alert(msg('strictPasswordMismatch') !== 'strictPasswordMismatch'
          ? msg('strictPasswordMismatch')
          : "Passwords don't match.");
        return;
      }
      const res = await chrome.runtime.sendMessage({ action: 'setStrictPassword', password: pwd });
      if (res?.error === 'pro_only') {
        openUpgrade();
        return;
      }
      if (res?.success) {
        strictToggle.classList.add('active');
        state.settings.strictModeEnabled = true;
        alert(msg('strictModeEnabledMsg') !== 'strictModeEnabledMsg'
          ? msg('strictModeEnabledMsg')
          : "Strict mode enabled. You'll need this password to disable it.");
      }
    } else {
      const pwd = prompt(msg('strictEnterPassword') !== 'strictEnterPassword'
        ? msg('strictEnterPassword')
        : 'Enter your strict-mode password to disable:');
      if (!pwd) return;
      const res = await chrome.runtime.sendMessage({ action: 'disableStrictMode', password: pwd });
      if (res?.success) {
        strictToggle.classList.remove('active');
        state.settings.strictModeEnabled = false;
        state.settings.strictModePasswordHash = '';
      } else {
        alert(msg('strictWrongPassword') !== 'strictWrongPassword'
          ? msg('strictWrongPassword')
          : 'Wrong password. Strict mode stays on.');
      }
    }
  });
  strictItem.appendChild(strictToggle);
  container.appendChild(strictItem);
}

// Sends a message to the background, asking once for the strict-mode
// password when a weakening request is locked (strict-client.js).
const sendWithStrict = cfCreateStrictSender(msg);

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
      openUpgrade();
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
      const res = await sendWithStrict({ action: 'removeBlockedChannel', index: i });
      if (res?.error) return;
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
  const atFreeLimit = !state.isPro && cfFreeKeywordsUsed(state.blockedKeywords) >= CF_FREE_KEYWORD_LIMIT;

  for (const cat of cfCategoryList()) {
    const isActive = blockedKwSet.has(cat.key);
    const isLocked = !isActive && atFreeLimit;
    // Exactly the terms blocking uses (content-dom.js): the topic key, then its synonyms
    const builtInTerms = cfBuiltInTerms(cat.key);

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
    countEl.textContent = builtInTerms.length + ' terms';
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
        openUpgrade();
        return;
      }
      if (isActive) {
        const keywords = state.blockedKeywords || [];
        const idx = keywords.findIndex(k => k.keyword.toLowerCase() === cat.key);
        if (idx >= 0) {
          const res = await sendWithStrict({ action: 'removeKeyword', index: idx });
          if (res?.error) return;
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

    // Built-in terms (category key + synonyms) — all toggleable. The category's
    // own term is shown by its display name, never as a raw key like ai_hype.
    for (const syn of builtInTerms) {
      const isDisabled = disabledSet.has(syn.toLowerCase());
      const chip = document.createElement('button');
      chip.className = 'synonym-chip' + (isDisabled ? ' disabled' : ' active');
      chip.textContent = syn === cat.key ? cat.label : syn;
      chip.title = isDisabled ? 'Click to re-enable' : 'Click to disable';
      chip.addEventListener('click', async () => {
        const res = await sendWithStrict({ action: 'toggleSynonym', synonym: syn });
        if (res?.error) return;
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
        const res = await sendWithStrict({ action: 'removeCustomSynonym', category: cat.key, synonym: cs });
        if (res?.error) return;
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
    const autoTagList = renderAutoTaggedChannels(cat.key, isActive);
    if (autoTagList) synonymPanel.appendChild(autoTagList);
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

// Channels auto-tagged for a blocked topic (all their videos are hidden), each
// with an Untag button. Untag records an exclusion in the background, so the
// channel is never auto-tagged for this topic again. Returns null when there
// is nothing to show.
function renderAutoTaggedChannels(categoryKey, isActive) {
  if (!isActive) return null;
  const tagged = (state.categoryTags || {})[categoryKey];
  const excludedList = (state.categoryTagExclusions || {})[categoryKey];
  const excluded = new Set(Array.isArray(excludedList) ? excludedList : []);
  const channels = Array.isArray(tagged)
    ? tagged.filter(ch => typeof ch === 'string' && ch && !excluded.has(ch))
    : [];
  if (channels.length === 0) return null;

  const section = document.createElement('div');
  section.className = 'autotag-list';

  const title = document.createElement('div');
  title.className = 'autotag-list-title';
  title.textContent = msg('autoTaggedChannelsTitle');
  section.appendChild(title);

  const desc = document.createElement('div');
  desc.className = 'autotag-list-desc';
  desc.textContent = msg('autoTaggedChannelsDesc');
  section.appendChild(desc);

  for (const ch of channels) {
    const row = document.createElement('div');
    row.className = 'list-item';

    const name = document.createElement('span');
    name.className = 'list-item-name';
    name.textContent = ch;
    row.appendChild(name);

    const untagBtn = document.createElement('button');
    untagBtn.className = 'list-item-undo';
    untagBtn.textContent = msg('untagChannelBtn');
    untagBtn.addEventListener('click', async () => {
      untagBtn.disabled = true;
      const res = await sendWithStrict({ action: 'untagChannelForCategory', category: categoryKey, channelName: ch });
      if (res?.error) { untagBtn.disabled = false; return; }
      notifyContentScript();
      await loadState();
      renderCategories();
    });
    row.appendChild(untagBtn);

    section.appendChild(row);
  }
  return section;
}

// ── Custom Keywords ──

function renderKeywords() {
  const container = document.getElementById('keyword-list');
  container.textContent = '';

  const keywords = state.blockedKeywords || [];
  const categoryKeys = new Set(cfCategoryList().map(c => c.key));
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
      const res = await sendWithStrict({ action: 'removeKeyword', index: i });
      if (res?.error) return;
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
    btn.addEventListener('click', () => openUpgrade());
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
      reason.textContent = msg('keywordReason', [cfCategoryLabel(vid.reason.split(':')[1])]);
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
  if (!container) return; // Interests section hidden (features.js)
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
    btn.addEventListener('click', () => openUpgrade());
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

// ── Plan picker (#upgrade, in About & Support) ──
// Every upgrade button in CleanFeed leads here: options.js buttons call
// openUpgrade(), the popup and the YouTube page ask the background, which
// opens options.html#upgrade. Prices come from ExtensionPay (getPlans), never
// from this file; each card opens that plan's checkout.

// The Pro plans from the background, as cfBuildPlanCards() cards (content-dom.js).
// fresh: the prices people choose from here are at most a minute old.
const planLoader = cfCreatePlansLoader(msg, renderUpgrade, { fresh: true });

function planCardEl(card) {
  const featured = card.kind === 'yearly';
  const nameKey = { monthly: 'planMonthly', yearly: 'planYearly', lifetime: 'planLifetime' }[card.kind];
  const nameId = 'plan-name-' + card.kind;

  const head = cfEl('div', { className: 'plan-card-head' }, [
    cfEl('span', { className: 'plan-card-name', id: nameId, textContent: msg(nameKey) })
  ]);
  if (card.bestValue) head.appendChild(cfEl('span', { className: 'plan-badge', textContent: msg('planBestValue') }));

  const lines = [];
  if (card.kind === 'monthly') {
    lines.push(cfEl('div', { className: 'plan-card-price', textContent: msg('planPerMonth', [card.price]) }));
    lines.push(cfEl('div', { className: 'plan-card-detail', textContent: msg('planBilledMonthly') }));
  } else if (card.kind === 'yearly') {
    lines.push(cfEl('div', { className: 'plan-card-price', textContent: msg('planPerMonth', [card.perMonth]) }));
    lines.push(cfEl('div', {
      className: 'plan-card-detail',
      textContent: card.savePercent
        ? msg('planBilledYearlySave', [card.price, String(card.savePercent)])
        : msg('planBilledYearly', [card.price])
    }));
  } else {
    lines.push(cfEl('div', { className: 'plan-card-price', textContent: msg('planOnce', [card.price]) }));
    lines.push(cfEl('div', { className: 'plan-card-detail', textContent: msg('planOneTimeNote') }));
    if (card.launchNote) {
      lines.push(cfEl('div', { className: 'plan-card-note', textContent: msg('planLaunchNote', [card.launchEnds]) }));
    }
  }

  // A plan without a nickname has no checkout of its own: ExtensionPay's page
  const request = card.nickname
    ? { action: 'openPaymentPage', plan: card.nickname }
    : { action: 'openPaymentPage', direct: true };
  const button = cfEl('button', {
    className: 'btn plan-choose ' + (featured ? 'btn-primary' : 'btn-secondary'),
    'data-plan': card.kind,
    'aria-describedby': nameId,
    textContent: msg('planChoose'),
    onclick: () => chrome.runtime.sendMessage(request)
  });

  return cfEl('div', {
    className: 'plan-card' + (featured ? ' plan-card-featured' : ''),
    'data-plan': card.kind,
    role: 'group',
    'aria-labelledby': nameId
  }, [head, ...lines, cfEl('div', { className: 'plan-card-spacer' }), button]);
}

function renderUpgrade() {
  const box = document.getElementById('upgrade');
  if (!box) return;
  const title = document.getElementById('planPickerTitle');
  const cardsEl = document.getElementById('planCards');
  const footer = document.getElementById('planFooter');
  const note = document.getElementById('planCurrencyNote');
  cardsEl.textContent = '';
  box.classList.toggle('plan-picker-pro', !!state.isPro);

  if (state.isPro) {
    title.textContent = msg('planYoureProTitle');
    cardsEl.appendChild(cfEl('p', { className: 'plan-pro-text', textContent: msg('youArePro') }));
    footer.hidden = true;
    return;
  }

  title.textContent = msg('planPickerTitle');
  footer.hidden = false;
  note.hidden = true;
  const cards = planLoader.cards();
  if (cards === null) {
    planLoader.load();
    return;
  }
  if (cards.length === 0) {
    // No prices to show: ExtensionPay's own page lists the plans
    cardsEl.appendChild(cfEl('button', {
      className: 'btn btn-primary plan-see-plans',
      id: 'planSeePlansBtn',
      textContent: msg('planSeePlans'),
      onclick: () => chrome.runtime.sendMessage({ action: 'openPaymentPage', direct: true })
    }));
    return;
  }
  for (const card of cards) cardsEl.appendChild(planCardEl(card));
  const currency = cfPlansCurrencyToNote(cards, cfUiLocale(msg));
  if (currency) {
    note.textContent = msg('planCurrencyNote', [currency]);
    note.hidden = false;
  }
}

// Shows the plan picker: the About tab, scrolled to the picker, which takes
// the focus and is briefly highlighted.
function showUpgradeSection() {
  const box = document.getElementById('upgrade');
  if (!box) return;
  activateSection('about');
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  box.classList.remove('plan-picker-focus');
  void box.offsetWidth; // restart the highlight
  box.classList.add('plan-picker-focus');
  box.focus({ preventScroll: true });
}

// For the upgrade buttons on this page: the picker, with #upgrade in the URL.
function openUpgrade() {
  if (location.hash !== '#upgrade') history.replaceState(null, '', '#upgrade');
  showUpgradeSection();
}

// ── Navigation ──

function activateSection(name) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.section === name));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === 'section-' + name));
}

function setupNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      activateSection(btn.dataset.section);
      // Leaving the picker: a later #upgrade from the background is a change again
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    });
  });
  // The background opens options.html#upgrade, or sets that hash on this tab
  window.addEventListener('hashchange', () => {
    if (location.hash === '#upgrade') showUpgradeSection();
  });
  if (location.hash === '#upgrade') showUpgradeSection();
}

// ── Buttons ──

function setupButtons() {
  // Null-checks: a missing button must not stop the rest of setupButtons.
  const clearChannelsBtn = document.getElementById('clearChannelsBtn');
  if (clearChannelsBtn) clearChannelsBtn.addEventListener('click', async () => {
    if (confirm(msg('clearAllConfirm'))) {
      const res = await sendWithStrict({ action: 'clearAllBlockedChannels' });
      if (res?.error) return;
      notifyContentScript();
      await loadState();
      renderChannels();
      renderBadge();
    }
  });

  const resetRecsBtn = document.getElementById('resetRecsBtn');
  if (resetRecsBtn) resetRecsBtn.addEventListener('click', () => {
    // Open YouTube's watch history page and search/activity history page
    window.open('https://www.youtube.com/feed/history', '_blank');
    window.open('https://myactivity.google.com/product/youtube', '_blank');
  });

  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.addEventListener('click', async () => {
    const data = await chrome.runtime.sendMessage({ action: 'exportAllData' });
    if (!data) return;
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cleanfeed-backup-' + date + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const importBtn = document.getElementById('importBtn');
  const importInput = document.getElementById('importInput');
  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      const confirmMsg = msg('importConfirm') !== 'importConfirm'
        ? msg('importConfirm')
        : 'This will REPLACE your current CleanFeed configuration. Continue?';
      if (!confirm(confirmMsg)) {
        importInput.value = '';
        return;
      }
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        // A backup that would weaken filtering needs the strict-mode password
        const res = await sendWithStrict({ action: 'importAllData', data });
        if (res?.success) {
          let done = msg('importSuccess') !== 'importSuccess' ? msg('importSuccess') : 'Import successful. Page will reload.';
          // A free user's backup cannot turn Strict Mode on: say so, with the result
          if (res.strictModeSkipped) {
            done += '\n\n' + (msg('importStrictSkipped') !== 'importStrictSkipped' ? msg('importStrictSkipped') : 'Strict Mode is a Pro feature and was not imported.');
          }
          alert(done);
          window.location.reload();
        } else if (res?.error !== 'strict_locked') { // strict_locked: password cancelled or wrong (already told)
          alert(msg('importError') !== 'importError' ? msg('importError') : 'Import failed: invalid file format.');
        }
      } catch (e) {
        alert((msg('importError') !== 'importError' ? msg('importError') : 'Import failed') + ': ' + e.message);
      }
      importInput.value = '';
    });
  }

  const bugReportBtn = document.getElementById('bugReportBtn');
  if (bugReportBtn) bugReportBtn.addEventListener('click', () => {
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
    window.open('mailto:factuallogic98@gmail.com?subject=' + subject + '&body=' + body);
  });
}

// ── Live Updates ──

chrome.storage.onChanged.addListener(async (changes) => {
  const keys = Object.keys(changes);
  const statOnly = keys.length === 1 && keys[0] === 'stats';
  if (statOnly) return;
  // The background refreshed the Pro plans: new prices for the picker
  if (changes.plansCache && !state.isPro) planLoader.load();
  // Pro status re-checked with the same answer, or the plans (content-dom.js)
  if (cfIsProBookkeepingOnly(changes)) return;
  await loadState();
  renderAll();
});
