# CleanFeed v1.0 Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete rebuild of CleanFeed with 7 features (channel blocking, keyword blocking, subscription exception, curiosity window, shorts killer, smart decay, hidden videos log) on YouTube's actual 2025 DOM.

**Architecture:** 100% client-side Chrome Extension (Manifest V3). All DOM creation via createElement (no innerHTML — YouTube enforces Trusted Types CSP). Data in chrome.storage.local. Payments via ExtensionPay. Supports both 2025 and legacy YouTube DOM structures.

**Tech Stack:** Chrome Extension Manifest V3, vanilla JavaScript, ExtensionPay/Stripe, chrome.storage.local, chrome.alarms, MutationObserver, chrome.i18n

---

## File Structure

```
C:\Users\Nyare\Desktop\Clean Feed\
├── manifest.json              # Extension config
├── background.js              # Service worker: ExtPay, alarms, all message handling
├── storage.js                 # Storage helpers (imported by background.js only)
├── content.js                 # YouTube DOM: filtering, menu injection, prompts
├── content-dom.js             # DOM helper functions (createElement wrappers, selectors)
├── popup.html                 # Popup shell
├── popup.js                   # Popup logic
├── styles/
│   ├── popup.css              # Popup styles
│   └── content.css            # YouTube overlay styles + Shorts killer CSS
├── lib/
│   └── ExtPay.js              # ExtensionPay library (already downloaded)
├── icons/                     # Already exist from v1
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── _locales/
    ├── en/messages.json       # English (primary)
    └── it/messages.json       # Italian
```

**Key change from v1:** Split content script DOM helpers into `content-dom.js` to keep `content.js` focused on logic. Both are loaded via manifest content_scripts array.

---

### Task 1: Clean Slate — Manifest + Locales + Stubs

**Files:**
- Modify: `manifest.json`
- Rewrite: `_locales/en/messages.json`
- Rewrite: `_locales/it/messages.json`
- Create: `content-dom.js` (stub)
- Keep: `lib/ExtPay.js`, `icons/`

- [ ] **Step 1: Rewrite manifest.json**

```json
{
  "manifest_version": 3,
  "name": "__MSG_extensionName__",
  "version": "1.1.0",
  "description": "__MSG_extensionDescription__",
  "default_locale": "en",
  "permissions": [
    "storage",
    "alarms"
  ],
  "host_permissions": [
    "*://*.youtube.com/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["*://*.youtube.com/*"],
      "js": ["content-dom.js", "content.js"],
      "css": ["styles/content.css"],
      "run_at": "document_idle"
    },
    {
      "matches": ["https://extensionpay.com/*"],
      "js": ["lib/ExtPay.js"],
      "run_at": "document_start"
    }
  ],
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

Note: version bumped to 1.1.0 to distinguish from the broken v1.0.

- [ ] **Step 2: Rewrite English locale**

```json
{
  "extensionName": { "message": "CleanFeed - YouTube That Respects You" },
  "extensionDescription": { "message": "Permanent channel blocking, keyword filtering, interest boundaries, and Shorts removal. Take control of YouTube's algorithm." },
  "controls": { "message": "Controls" },
  "blocked": { "message": "Blocked" },
  "hidden": { "message": "Hidden" },
  "interests": { "message": "Interests" },
  "hideShorts": { "message": "Hide Shorts" },
  "hideShortsDesc": { "message": "Remove all Shorts sections from YouTube" },
  "keywordBlocking": { "message": "Keyword Blocking" },
  "keywordBlockingDesc": { "message": "Hide videos matching blocked keywords" },
  "interestBoundaries": { "message": "Interest Boundaries" },
  "interestBoundariesDesc": { "message": "Control how new searches affect your feed" },
  "smartDecay": { "message": "Smart Decay" },
  "smartDecayDesc": { "message": "Auto-remove interests after 30 days" },
  "blockChannelPermanently": { "message": "Block channel permanently" },
  "blockThisChannel": { "message": "Block this channel" },
  "blockedToast": { "message": "Blocked \"$CHANNEL$\" permanently", "placeholders": { "channel": { "content": "$1" } } },
  "couldNotDetect": { "message": "Could not detect channel name." },
  "addKeyword": { "message": "Add keyword" },
  "addKeywordPlaceholder": { "message": "e.g. gaming, drama, react..." },
  "keywordsUsed": { "message": "$COUNT$/3 keywords used", "placeholders": { "count": { "content": "$1" } } },
  "keywordLimitToast": { "message": "Free plan allows 3 keywords. Upgrade to Pro for unlimited." },
  "hiddenVideos": { "message": "Hidden Videos" },
  "hiddenVideosUpgrade": { "message": "Upgrade to Pro to see hidden videos" },
  "interestsUpgrade": { "message": "Upgrade to Pro for Interest Boundaries" },
  "subscriptionExceptionToast": { "message": "$COUNT$ of your subscribed channels were affected. Exclude them?", "placeholders": { "count": { "content": "$1" } } },
  "excludeChannel": { "message": "Exclude" },
  "curiosityJustNow": { "message": "Just now" },
  "curiosityToday": { "message": "Today" },
  "curiosityAlways": { "message": "Always" },
  "newSearch": { "message": "New search: \"$QUERY$\"", "placeholders": { "query": { "content": "$1" } } },
  "rememberInterest": { "message": "How long do you want to see this content?" },
  "undoHide": { "message": "Undo" },
  "clearAll": { "message": "Clear All" },
  "clearAllConfirm": { "message": "Clear all blocked channels? This cannot be undone." },
  "unlockFeatures": { "message": "Unlock all features" },
  "upgradeToPro": { "message": "Upgrade to Pro — $3.99/mo" },
  "pro": { "message": "PRO" },
  "free": { "message": "FREE" },
  "noBlockedChannels": { "message": "No channels blocked yet. Use the three-dot menu on any YouTube video to block a channel." },
  "noBlockedKeywords": { "message": "No keywords blocked yet." },
  "noHiddenVideos": { "message": "No hidden videos yet." },
  "noInterests": { "message": "No interests saved yet." },
  "keywordReason": { "message": "Keyword: $KW$", "placeholders": { "kw": { "content": "$1" } } },
  "channelReason": { "message": "Channel: $CH$", "placeholders": { "ch": { "content": "$1" } } }
}
```

- [ ] **Step 3: Rewrite Italian locale**

```json
{
  "extensionName": { "message": "CleanFeed - YouTube Che Ti Rispetta" },
  "extensionDescription": { "message": "Blocco permanente canali, filtro per parole chiave, confini di interesse e rimozione Shorts. Prendi il controllo dell'algoritmo di YouTube." },
  "controls": { "message": "Controlli" },
  "blocked": { "message": "Bloccati" },
  "hidden": { "message": "Nascosti" },
  "interests": { "message": "Interessi" },
  "hideShorts": { "message": "Nascondi Shorts" },
  "hideShortsDesc": { "message": "Rimuovi tutte le sezioni Shorts da YouTube" },
  "keywordBlocking": { "message": "Blocco Parole Chiave" },
  "keywordBlockingDesc": { "message": "Nascondi video che contengono parole bloccate" },
  "interestBoundaries": { "message": "Confini di Interesse" },
  "interestBoundariesDesc": { "message": "Controlla come le nuove ricerche influenzano il tuo feed" },
  "smartDecay": { "message": "Decadimento Intelligente" },
  "smartDecayDesc": { "message": "Rimuovi interessi dopo 30 giorni" },
  "blockChannelPermanently": { "message": "Blocca canale permanentemente" },
  "blockThisChannel": { "message": "Blocca questo canale" },
  "blockedToast": { "message": "Bloccato \"$CHANNEL$\" permanentemente", "placeholders": { "channel": { "content": "$1" } } },
  "couldNotDetect": { "message": "Impossibile rilevare il nome del canale." },
  "addKeyword": { "message": "Aggiungi parola chiave" },
  "addKeywordPlaceholder": { "message": "es. gaming, drama, react..." },
  "keywordsUsed": { "message": "$COUNT$/3 parole usate", "placeholders": { "count": { "content": "$1" } } },
  "keywordLimitToast": { "message": "Il piano gratuito permette 3 parole chiave. Passa a Pro per illimitate." },
  "hiddenVideos": { "message": "Video Nascosti" },
  "hiddenVideosUpgrade": { "message": "Passa a Pro per vedere i video nascosti" },
  "interestsUpgrade": { "message": "Passa a Pro per i Confini di Interesse" },
  "subscriptionExceptionToast": { "message": "$COUNT$ dei tuoi canali iscritti sono stati colpiti. Vuoi escluderli?", "placeholders": { "count": { "content": "$1" } } },
  "excludeChannel": { "message": "Escludi" },
  "curiosityJustNow": { "message": "Solo adesso" },
  "curiosityToday": { "message": "Oggi" },
  "curiosityAlways": { "message": "Sempre" },
  "newSearch": { "message": "Nuova ricerca: \"$QUERY$\"", "placeholders": { "query": { "content": "$1" } } },
  "rememberInterest": { "message": "Per quanto tempo vuoi vedere questo contenuto?" },
  "undoHide": { "message": "Annulla" },
  "clearAll": { "message": "Cancella Tutto" },
  "clearAllConfirm": { "message": "Cancellare tutti i canali bloccati? Non si può annullare." },
  "unlockFeatures": { "message": "Sblocca tutte le funzionalità" },
  "upgradeToPro": { "message": "Passa a Pro — 3,99€/mese" },
  "pro": { "message": "PRO" },
  "free": { "message": "FREE" },
  "noBlockedChannels": { "message": "Nessun canale bloccato. Usa il menu a tre punti su qualsiasi video YouTube." },
  "noBlockedKeywords": { "message": "Nessuna parola chiave bloccata." },
  "noHiddenVideos": { "message": "Nessun video nascosto." },
  "noInterests": { "message": "Nessun interesse salvato." },
  "keywordReason": { "message": "Parola: $KW$", "placeholders": { "kw": { "content": "$1" } } },
  "channelReason": { "message": "Canale: $CH$", "placeholders": { "ch": { "content": "$1" } } }
}
```

- [ ] **Step 4: Create content-dom.js stub**

```javascript
// CleanFeed DOM Helpers — YouTube Trusted Types safe
// All DOM creation uses createElement, never innerHTML
```

- [ ] **Step 5: Create empty stubs for files that will be built in later tasks**

Create empty `background.js`, `storage.js`, `content.js`, `popup.html`, `popup.js`, `styles/popup.css`, `styles/content.css` as minimal stubs so the extension loads without errors.

- background.js: `// CleanFeed Background — Task 3`
- storage.js: `// CleanFeed Storage — Task 2`
- content.js: `// CleanFeed Content — Tasks 4-7`
- popup.html: minimal `<!DOCTYPE html><html><head><link rel="stylesheet" href="styles/popup.css"></head><body><script src="popup.js"></script></body></html>`
- popup.js: `// CleanFeed Popup — Task 8`
- styles/popup.css: `/* CleanFeed Popup — Task 9 */`
- styles/content.css: `/* CleanFeed Content — Task 4 */`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: clean slate for v1.1 rebuild — manifest, locales, stubs"
```

---

### Task 2: Storage Layer

**Files:**
- Rewrite: `storage.js`

The storage layer handles all chrome.storage.local operations. Only imported by background.js via `importScripts()`.

- [ ] **Step 1: Write storage.js**

```javascript
// CleanFeed Storage Layer
// All chrome.storage.local operations. Imported by background.js only.

const Storage = {
  DEFAULTS: {
    blockedChannels: [],
    blockedKeywords: [],
    whitelistedChannels: [],
    interests: {},
    hiddenVideos: [],
    settings: {
      hideShorts: false,
      enableSmartDecay: true,
      enableInterestBoundaries: true
    },
    stats: {
      channelsBlocked: 0,
      videosHidden: 0,
      interestsSaved: 0
    },
    onboarding: {
      interestPromptCount: 0
    }
  },

  FREE_KEYWORD_LIMIT: 3,
  HIDDEN_VIDEOS_MAX: 100,

  async init() {
    const data = await chrome.storage.local.get(null);
    const updates = {};
    for (const [key, defaultVal] of Object.entries(this.DEFAULTS)) {
      if (data[key] === undefined) {
        updates[key] = defaultVal;
      }
    }
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
  },

  // --- Blocked Channels ---

  async getBlockedChannels() {
    const { blockedChannels } = await chrome.storage.local.get('blockedChannels');
    return blockedChannels || [];
  },

  async getBlockedChannelNames() {
    const channels = await this.getBlockedChannels();
    return new Set(channels.map(ch => ch.name.toLowerCase()));
  },

  async addBlockedChannel(name, id) {
    const channels = await this.getBlockedChannels();
    const exists = channels.some(
      ch => ch.name.toLowerCase() === name.toLowerCase()
    );
    if (exists) return { success: false, reason: 'already_blocked' };

    channels.push({ name, id, blockedAt: Date.now() });
    await chrome.storage.local.set({ blockedChannels: channels });
    await this.incrementStat('channelsBlocked');
    return { success: true };
  },

  async removeBlockedChannel(index) {
    const channels = await this.getBlockedChannels();
    if (index >= 0 && index < channels.length) {
      channels.splice(index, 1);
      await chrome.storage.local.set({ blockedChannels: channels });
    }
  },

  async clearAllBlockedChannels() {
    await chrome.storage.local.set({ blockedChannels: [] });
  },

  // --- Blocked Keywords ---

  async getBlockedKeywords() {
    const { blockedKeywords } = await chrome.storage.local.get('blockedKeywords');
    return blockedKeywords || [];
  },

  async addBlockedKeyword(keyword) {
    const keywords = await this.getBlockedKeywords();
    const normalized = keyword.toLowerCase().trim();
    if (!normalized) return { success: false, reason: 'empty' };

    const exists = keywords.some(k => k.keyword.toLowerCase() === normalized);
    if (exists) return { success: false, reason: 'already_exists' };

    keywords.push({ keyword: normalized, addedAt: Date.now() });
    await chrome.storage.local.set({ blockedKeywords: keywords });
    return { success: true };
  },

  async removeBlockedKeyword(index) {
    const keywords = await this.getBlockedKeywords();
    if (index >= 0 && index < keywords.length) {
      keywords.splice(index, 1);
      await chrome.storage.local.set({ blockedKeywords: keywords });
    }
  },

  // --- Whitelisted Channels (Subscription Exception) ---

  async getWhitelistedChannels() {
    const { whitelistedChannels } = await chrome.storage.local.get('whitelistedChannels');
    return whitelistedChannels || [];
  },

  async addWhitelistedChannel(name, id, exemptFrom) {
    const list = await this.getWhitelistedChannels();
    const exists = list.some(
      ch => ch.name.toLowerCase() === name.toLowerCase() && ch.exemptFrom === exemptFrom
    );
    if (exists) return;

    list.push({ name, id, exemptFrom, addedAt: Date.now() });
    await chrome.storage.local.set({ whitelistedChannels: list });
  },

  async isChannelWhitelisted(channelName, keyword) {
    const list = await this.getWhitelistedChannels();
    return list.some(
      ch => ch.name.toLowerCase() === channelName.toLowerCase() && ch.exemptFrom === keyword
    );
  },

  async removeWhitelistedChannel(index) {
    const list = await this.getWhitelistedChannels();
    if (index >= 0 && index < list.length) {
      list.splice(index, 1);
      await chrome.storage.local.set({ whitelistedChannels: list });
    }
  },

  // --- Interests ---

  async getInterests() {
    const { interests } = await chrome.storage.local.get('interests');
    return interests || {};
  },

  async addInterest(query, expiresAt) {
    const interests = await this.getInterests();
    const key = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    interests[key] = {
      query,
      keywords: [query.toLowerCase()],
      addedAt: Date.now(),
      lastUsed: Date.now(),
      expiresAt: expiresAt || null
    };

    await chrome.storage.local.set({ interests });
    await this.incrementStat('interestsSaved');
    return key;
  },

  async removeInterest(key) {
    const interests = await this.getInterests();
    delete interests[key];
    await chrome.storage.local.set({ interests });
  },

  async touchInterest(key) {
    const interests = await this.getInterests();
    if (interests[key]) {
      interests[key].lastUsed = Date.now();
      await chrome.storage.local.set({ interests });
    }
  },

  async matchesExistingInterest(query) {
    const interests = await this.getInterests();
    const queryWords = query.toLowerCase().split(/\s+/);
    const now = Date.now();

    for (const [key, interest] of Object.entries(interests)) {
      // Skip expired interests
      if (interest.expiresAt && interest.expiresAt < now) continue;

      for (const keyword of interest.keywords) {
        const kwWords = keyword.split(/\s+/);
        const match = kwWords.some(kw =>
          queryWords.some(qw => qw === kw || (kw.length >= 4 && qw.includes(kw)))
        );
        if (match) {
          await this.touchInterest(key);
          return true;
        }
      }
    }
    return false;
  },

  async performSmartDecay() {
    const interests = await this.getInterests();
    const now = Date.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
    let changed = false;

    for (const [key, interest] of Object.entries(interests)) {
      // Remove expired "Oggi" interests
      if (interest.expiresAt && interest.expiresAt < now) {
        delete interests[key];
        changed = true;
        continue;
      }
      // Remove permanent interests not used in 30 days
      if (!interest.expiresAt && interest.lastUsed < thirtyDaysAgo) {
        delete interests[key];
        changed = true;
      }
    }

    if (changed) {
      await chrome.storage.local.set({ interests });
    }
    return changed;
  },

  // --- Hidden Videos Log ---

  async getHiddenVideos() {
    const { hiddenVideos } = await chrome.storage.local.get('hiddenVideos');
    return hiddenVideos || [];
  },

  async logHiddenVideo(title, channel, reason) {
    const videos = await this.getHiddenVideos();
    videos.unshift({
      title: (title || '').substring(0, 80),
      channel: channel || 'Unknown',
      reason,
      hiddenAt: Date.now()
    });

    // Cap at 100 entries
    if (videos.length > this.HIDDEN_VIDEOS_MAX) {
      videos.length = this.HIDDEN_VIDEOS_MAX;
    }

    await chrome.storage.local.set({ hiddenVideos: videos });
  },

  async removeHiddenVideo(index) {
    const videos = await this.getHiddenVideos();
    if (index >= 0 && index < videos.length) {
      videos.splice(index, 1);
      await chrome.storage.local.set({ hiddenVideos: videos });
    }
  },

  // --- Settings ---

  async getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return settings || this.DEFAULTS.settings;
  },

  async updateSetting(key, value) {
    const settings = await this.getSettings();
    settings[key] = value;
    await chrome.storage.local.set({ settings });
  },

  // --- Stats ---

  async getStats() {
    const { stats } = await chrome.storage.local.get('stats');
    return stats || this.DEFAULTS.stats;
  },

  async incrementStat(statName, amount) {
    const stats = await this.getStats();
    stats[statName] = (stats[statName] || 0) + (amount || 1);
    await chrome.storage.local.set({ stats });
  },

  // --- Onboarding ---

  async getOnboarding() {
    const { onboarding } = await chrome.storage.local.get('onboarding');
    return onboarding || this.DEFAULTS.onboarding;
  },

  async incrementInterestPromptCount() {
    const onboarding = await this.getOnboarding();
    onboarding.interestPromptCount = (onboarding.interestPromptCount || 0) + 1;
    await chrome.storage.local.set({ onboarding });
    return onboarding.interestPromptCount;
  }
};
```

- [ ] **Step 2: Commit**

```bash
git add storage.js
git commit -m "feat: storage layer with channels, keywords, whitelist, interests, hidden log"
```

---

### Task 3: Background Service Worker

**Files:**
- Rewrite: `background.js`

Handles: ExtPay init (resilient), storage init, smart decay alarm, all message passing.

- [ ] **Step 1: Write background.js**

```javascript
// CleanFeed Background Service Worker

importScripts('lib/ExtPay.js');
importScripts('storage.js');

// --- ExtensionPay (resilient init) ---
let extpay;
try {
  extpay = ExtPay('cleanfeed');
  extpay.startBackground();
} catch (e) {
  console.warn('CleanFeed: ExtensionPay init failed:', e);
}

async function checkProStatus() {
  try {
    if (!extpay) return false;
    const user = await extpay.getUser();
    return user?.paid === true;
  } catch (e) {
    return false;
  }
}

// --- Install / Update ---

chrome.runtime.onInstalled.addListener(async () => {
  await Storage.init();
  chrome.alarms.create('smartDecay', { periodInMinutes: 24 * 60 });
});

// --- Alarms ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'smartDecay') {
    const isPro = await checkProStatus();
    if (!isPro) return;

    const settings = await Storage.getSettings();
    if (settings.enableSmartDecay) {
      await Storage.performSmartDecay();
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.get('smartDecay', (alarm) => {
    if (!alarm) {
      chrome.alarms.create('smartDecay', { periodInMinutes: 24 * 60 });
    }
  });
});

// --- Message Handling ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (typeof request === 'string' && request.startsWith('extpay-')) return;

  handleMessage(request).then(sendResponse).catch(err => {
    console.error('CleanFeed:', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(request) {
  const isPro = await checkProStatus();

  switch (request.action) {
    // --- Channel Blocking ---
    case 'blockChannel': {
      return await Storage.addBlockedChannel(request.channelName, request.channelId);
    }

    case 'getBlockedChannelNames': {
      const names = await Storage.getBlockedChannelNames();
      return { blockedNames: [...names] };
    }

    case 'removeBlockedChannel': {
      await Storage.removeBlockedChannel(request.index);
      return { success: true };
    }

    case 'clearAllBlockedChannels': {
      await Storage.clearAllBlockedChannels();
      return { success: true };
    }

    // --- Keyword Blocking ---
    case 'addKeyword': {
      if (!isPro) {
        const keywords = await Storage.getBlockedKeywords();
        if (keywords.length >= Storage.FREE_KEYWORD_LIMIT) {
          return { success: false, reason: 'free_limit' };
        }
      }
      return await Storage.addBlockedKeyword(request.keyword);
    }

    case 'getBlockedKeywords': {
      const keywords = await Storage.getBlockedKeywords();
      return { keywords };
    }

    case 'removeKeyword': {
      await Storage.removeBlockedKeyword(request.index);
      return { success: true };
    }

    // --- Subscription Exception ---
    case 'whitelistChannel': {
      if (!isPro) return { success: false, reason: 'pro_only' };
      await Storage.addWhitelistedChannel(request.name, request.id, request.exemptFrom);
      return { success: true };
    }

    case 'isChannelWhitelisted': {
      const result = await Storage.isChannelWhitelisted(request.channelName, request.keyword);
      return { whitelisted: result };
    }

    // --- Interest Boundaries ---
    case 'checkInterest': {
      const onboarding = await Storage.getOnboarding();

      const shouldCheck = isPro
        ? (await Storage.getSettings()).enableInterestBoundaries
        : onboarding.interestPromptCount < 3;

      if (!shouldCheck) return { shouldPrompt: false };

      const matches = await Storage.matchesExistingInterest(request.query);
      if (matches) return { shouldPrompt: false };

      const count = await Storage.incrementInterestPromptCount();
      return {
        shouldPrompt: true,
        query: request.query,
        isPro,
        promptCount: count,
        useInlineBanner: count <= 3
      };
    }

    case 'addInterest': {
      const key = await Storage.addInterest(request.query, request.expiresAt || null);
      return { success: true, key };
    }

    case 'removeInterest': {
      await Storage.removeInterest(request.key);
      return { success: true };
    }

    // --- Hidden Videos ---
    case 'logHiddenVideo': {
      await Storage.logHiddenVideo(request.title, request.channel, request.reason);
      return { success: true };
    }

    case 'removeHiddenVideo': {
      await Storage.removeHiddenVideo(request.index);
      return { success: true };
    }

    // --- Settings ---
    case 'getFullState': {
      const settings = await Storage.getSettings();
      const stats = await Storage.getStats();
      const blockedChannels = await Storage.getBlockedChannels();
      const blockedKeywords = await Storage.getBlockedKeywords();
      const whitelistedChannels = await Storage.getWhitelistedChannels();
      const interests = await Storage.getInterests();
      const hiddenVideos = await Storage.getHiddenVideos();
      const onboarding = await Storage.getOnboarding();

      return {
        settings, stats, blockedChannels, blockedKeywords,
        whitelistedChannels, interests, hiddenVideos, onboarding, isPro
      };
    }

    case 'updateSetting': {
      await Storage.updateSetting(request.key, request.value);
      return { success: true };
    }

    case 'incrementStat': {
      await Storage.incrementStat(request.stat, request.amount || 1);
      return { success: true };
    }

    // --- Payment ---
    case 'openPaymentPage': {
      try {
        if (extpay) extpay.openPaymentPage();
        else chrome.tabs.create({ url: 'https://extensionpay.com' });
      } catch (e) {
        console.warn('CleanFeed: payment page error:', e);
      }
      return { success: true };
    }

    default:
      return { error: 'Unknown action: ' + request.action };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add background.js
git commit -m "feat: background service worker with all message handlers and resilient ExtPay"
```

---

### Task 4: Content DOM Helpers + CSS

**Files:**
- Rewrite: `content-dom.js`
- Rewrite: `styles/content.css`

DOM helpers for Trusted Types compliance, plus all CSS for YouTube overlays and Shorts killer.

- [ ] **Step 1: Write content-dom.js**

```javascript
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
  // Video card selectors (all types)
  VIDEO_CARDS: 'ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer',

  // Channel name: primary (2025) then legacy fallbacks
  getChannelName(videoCard) {
    // 2025: channel link with /@handle href
    const link2025 = videoCard.querySelector('a[href^="/@"]');
    if (link2025) {
      const text = link2025.textContent.trim();
      if (text) return text;
    }
    // Legacy selectors
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

  // Channel ID from link href
  getChannelId(videoCard) {
    const link = videoCard.querySelector('a[href^="/@"], #channel-name a, ytd-channel-name a');
    const href = link?.getAttribute('href') || '';
    const match = href.match(/\/(channel|c|user|@)([^\/\?]+)/);
    return match ? match[2] : null;
  },

  // Video title extraction
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

  // Video description snippet
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

  // Get channel name from current page (video watch page or channel page)
  getPageChannelName() {
    const selectors = [
      'ytd-video-owner-renderer a[href^="/@"]',
      'ytd-channel-name.ytd-video-owner-renderer a',
      '#owner #channel-name a',
      '#channel-header ytd-channel-name a',
      'yt-dynamic-text-view-model.ytChannelNameViewModelHost'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = el.textContent.trim();
        if (text) return text;
      }
    }
    return null;
  },

  getPageChannelId() {
    const link = document.querySelector(
      'ytd-video-owner-renderer a[href^="/@"], #channel-header a[href^="/@"]'
    );
    const href = link?.getAttribute('href') || '';
    const match = href.match(/@([^\/\?]+)/);
    return match ? '@' + match[1] : null;
  },

  // Check if current page is a channel page
  isChannelPage() {
    return /^\/@|^\/channel\/|^\/c\/|^\/user\//.test(window.location.pathname);
  },

  // Menu popup (2025 vs legacy)
  getMenuPopup() {
    return document.querySelector('tp-yt-iron-dropdown yt-sheet-view-model') ||
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
    // Short keywords: exact word boundary match
    const regex = new RegExp('\\b' + lowerKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    return regex.test(lowerText);
  }
  // Longer keywords: substring match
  return lowerText.includes(lowerKw);
}
```

- [ ] **Step 2: Write styles/content.css**

```css
/* CleanFeed Content Styles — Injected into YouTube */

/* --- Theme Variables --- */
:root {
  --cf-bg: #ffffff;
  --cf-bg-secondary: #f8f9fa;
  --cf-text: #0f0f0f;
  --cf-text-secondary: #606060;
  --cf-text-muted: #909090;
  --cf-border: #e5e5e5;
  --cf-accent: #3ea6ff;
  --cf-accent-hover: #1f8fff;
  --cf-danger: #ff4444;
  --cf-shadow: rgba(0, 0, 0, 0.12);
}

html[dark] {
  --cf-bg: #1a1a1a;
  --cf-bg-secondary: #272727;
  --cf-text: #f1f1f1;
  --cf-text-secondary: #aaaaaa;
  --cf-text-muted: #717171;
  --cf-border: #383838;
  --cf-accent: #3ea6ff;
  --cf-accent-hover: #65b8ff;
  --cf-danger: #ff6666;
  --cf-shadow: rgba(0, 0, 0, 0.4);
}

/* --- Hidden by CleanFeed --- */
.cleanfeed-hidden { display: none !important; }

/* --- Shorts Killer (CSS-based, no JS needed) --- */
body.cleanfeed-hide-shorts ytd-reel-shelf-renderer,
body.cleanfeed-hide-shorts ytd-rich-shelf-renderer[is-shorts],
body.cleanfeed-hide-shorts ytd-reel-item-renderer,
body.cleanfeed-hide-shorts [is-shorts],
body.cleanfeed-hide-shorts ytd-guide-entry-renderer:has(a[title="Shorts"]),
body.cleanfeed-hide-shorts ytd-mini-guide-entry-renderer:has(a[title="Shorts"]),
body.cleanfeed-hide-shorts yt-chip-cloud-chip-renderer:has([title="Shorts"]) {
  display: none !important;
}

/* --- Toast Notification --- */
.cleanfeed-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%) translateY(100px);
  background: var(--cf-bg);
  border: 1px solid var(--cf-border);
  border-radius: 12px;
  padding: 12px 18px;
  display: flex;
  align-items: center;
  gap: 12px;
  box-shadow: 0 4px 16px var(--cf-shadow);
  z-index: 99999;
  font-family: 'Roboto', 'Arial', sans-serif;
  font-size: 14px;
  color: var(--cf-text);
  max-width: 560px;
  animation: cf-slide-up 0.3s ease forwards;
}

.cleanfeed-toast.cf-exit { animation: cf-slide-down 0.3s ease forwards; }

@keyframes cf-slide-up { to { transform: translateX(-50%) translateY(0); } }
@keyframes cf-slide-down { to { transform: translateX(-50%) translateY(100px); } }

.cleanfeed-toast-text { flex: 1; line-height: 1.4; }
.cleanfeed-toast-brand { color: var(--cf-accent); font-weight: 600; }

.cleanfeed-toast-buttons { display: flex; gap: 6px; flex-shrink: 0; }
.cleanfeed-toast-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }

.cleanfeed-btn {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}

.cleanfeed-btn-primary { background: var(--cf-accent); color: #ffffff; }
.cleanfeed-btn-primary:hover { background: var(--cf-accent-hover); }
.cleanfeed-btn-secondary { background: var(--cf-bg-secondary); color: var(--cf-text); }
.cleanfeed-btn-secondary:hover { background: var(--cf-border); }
.cleanfeed-btn-danger { background: var(--cf-danger); color: #ffffff; }

.cleanfeed-chip {
  padding: 4px 12px;
  background: var(--cf-bg-secondary);
  border: 1px solid var(--cf-border);
  border-radius: 16px;
  font-size: 12px;
  color: var(--cf-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.cleanfeed-chip:hover {
  background: var(--cf-accent);
  color: #ffffff;
  border-color: var(--cf-accent);
}

/* --- Inline Banner --- */
.cleanfeed-inline-banner {
  margin: 12px auto;
  max-width: 1096px;
  padding: 14px 20px;
  background: var(--cf-bg);
  border: 1px solid var(--cf-accent);
  border-left: 4px solid var(--cf-accent);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  font-family: 'Roboto', 'Arial', sans-serif;
  font-size: 14px;
  color: var(--cf-text);
  box-shadow: 0 2px 8px var(--cf-shadow);
  z-index: 99998;
}

.cleanfeed-inline-banner-content { display: flex; align-items: center; gap: 10px; flex: 1; }
.cleanfeed-inline-banner-text strong { color: var(--cf-text); }
.cleanfeed-inline-banner-text span { color: var(--cf-text-secondary); font-size: 13px; }

/* --- CF Logo (used in menu and banners) --- */
.cleanfeed-cf-logo {
  width: 20px; height: 20px;
  background: var(--cf-accent);
  border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 800; color: #ffffff;
  flex-shrink: 0;
}

/* --- Menu Item --- */
.cleanfeed-menu-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 16px;
  cursor: pointer;
  color: var(--cf-danger);
  font-size: 14px;
  font-family: 'Roboto', 'Arial', sans-serif;
}

.cleanfeed-menu-item:hover { background: var(--cf-bg-secondary); }
.cleanfeed-menu-separator { height: 1px; background: var(--cf-border); margin: 4px 0; }

/* --- Channel Page Block Button --- */
.cleanfeed-channel-block-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 16px;
  background: transparent;
  border: 1px solid var(--cf-danger);
  border-radius: 20px;
  color: var(--cf-danger);
  font-size: 13px; font-weight: 600;
  cursor: pointer;
  font-family: 'Roboto', 'Arial', sans-serif;
  margin-left: 8px;
  transition: all 0.15s;
}

.cleanfeed-channel-block-btn:hover {
  background: var(--cf-danger);
  color: #ffffff;
}
```

- [ ] **Step 3: Commit**

```bash
git add content-dom.js styles/content.css
git commit -m "feat: DOM helpers (Trusted Types safe) + content CSS with Shorts killer"
```

---

### Task 5: Content Script — Channel Blocking + Keyword Blocking + Menu Injection

**Files:**
- Rewrite: `content.js`

This is the main content script. Handles all YouTube page manipulation.

- [ ] **Step 1: Write content.js**

This file is large (~400 lines). Write the complete content.js with:

**State variables:**
- `blockedChannelNames` (Set), `blockedKeywords` (array), `whitelistedChannels` (array)
- `currentSettings`, `isPro`
- `debounceTimer`, `observer`, `lastClickedVideoCard`
- `searchIntercepted`, `activeJustNowQueries` (Set — for Curiosity Window "Solo adesso")

**init():**
- Load all data from background via `getFullState` message
- Call `filterPage()`, `startObserver()`, `trackMenuClicks()`, `watchForMenuPopup()`, `interceptSearch()`, `injectChannelPageButton()`
- Listen for `yt-navigate-finish` to re-run on SPA navigation (clear `activeJustNowQueries` if not on search page)

**loadState():**
- Send `getFullState` to background, populate all state variables
- Build `blockedChannelNames` Set from response

**filterPage():**
- Apply/remove Shorts killer CSS class on `document.body`
- Call `hideBlockedContent()`

**hideBlockedContent():**
- Query all video cards (`YT.VIDEO_CARDS`)
- For each unprocessed card:
  - Get channel name via `YT.getChannelName()`
  - Check if channel is in `blockedChannelNames` → hide, log reason "channel:name"
  - Get title via `YT.getVideoTitle()` + description via `YT.getVideoDescription()`
  - For each blocked keyword: check `matchesKeyword(title, kw)` or `matchesKeyword(desc, kw)`
    - Before hiding: check if channel is whitelisted for this keyword via `whitelistedChannels`
    - If whitelisted: skip
    - If NOT whitelisted: hide, log reason "keyword:kw"
    - Check `activeJustNowQueries` — if title/desc matches any active query, don't hide
  - Mark card as processed with `data-cf-checked`
- Send `incrementStat` with total hidden count
- Send `logHiddenVideo` for each newly hidden video

**trackMenuClicks():**
- Capture-phase click listener on document
- If click target is inside a button within a video card, store that card in `lastClickedVideoCard`

**watchForMenuPopup():**
- MutationObserver on body (childList + subtree + attributes)
- On mutation: check `YT.getMenuPopup()`. If found, call `injectBlockOption(popup)`

**injectBlockOption(popup):**
- Don't inject twice (check for `.cleanfeed-menu-item`)
- Get listbox via `YT.getMenuListbox(popup)`
- Verify it's a video context menu (check menu items for "not interested" / "non mi interessa" / "report" / "segnala")
- Get channel info from `lastClickedVideoCard` using `YT.getChannelName()` and `YT.getChannelId()`
- Create separator + block item via `cfEl()`
- Find "don't recommend" / "non consigliare" item for insertion point
- Insert after it, or append to end as fallback

**handleBlockClick(channelName, channelId):**
- Send `blockChannel` message to background
- Close YouTube menu (Escape keydown)
- Show toast with channel name
- Add to local `blockedChannelNames` Set
- Re-run `filterPage()`

**injectChannelPageButton():**
- If `YT.isChannelPage()`: find the subscribe button area, inject a "[CF] Block this channel" button next to it
- On click: get channel name from `YT.getPageChannelName()`, block it

**interceptSearch():**
- Attach to `input#search` keypress Enter
- Send `checkInterest` to background
- If `shouldPrompt`: show inline banner (first 3) or toast (after)

**showCuriosityPrompt(query, isPro, useInlineBanner):**
- Three buttons: "Solo adesso" / "Oggi" / "Sempre"
- "Solo adesso": add query to `activeJustNowQueries` Set, dismiss prompt
- "Oggi": send `addInterest` with `expiresAt` = midnight tonight
- "Sempre": send `addInterest` with no expiry
- Free users: all buttons open Pro upgrade

**showSubscriptionExceptionToast(affectedChannels, keyword):**
- Toast with channel names as clickable chips
- Clicking a chip: send `whitelistChannel` to background, re-filter page

**showToast(message, duration):**
- Simple text toast with auto-dismiss

**dismissToast(toast):**
- Add `cf-exit` class, remove after 300ms

**Storage change listener:**
- `chrome.storage.onChanged` → reload state, re-filter

- [ ] **Step 2: Commit**

```bash
git add content.js
git commit -m "feat: content script — channel/keyword blocking, menu injection, channel page button"
```

---

### Task 6: Content Script — Curiosity Window + Subscription Exception

**Files:**
- Modify: `content.js` (add curiosity window and subscription exception functions)

NOTE: If Task 5 already includes these functions (as described in the Step 1 spec), this task is about verifying they work. If they were left as stubs, implement them here.

The key functions to ensure are complete:

- [ ] **Step 1: Verify/implement showCuriosityPrompt()**

Must create either an inline banner or toast with three buttons using `cfEl()`:
- "Just now" / "Solo adesso" — `cfEl('button', { className: 'cleanfeed-btn cleanfeed-btn-secondary', textContent: chrome.i18n.getMessage('curiosityJustNow'), onClick: ... })`
- "Today" / "Oggi" — `cfEl('button', { className: 'cleanfeed-btn cleanfeed-btn-secondary', textContent: chrome.i18n.getMessage('curiosityToday'), onClick: ... })`
- "Always" / "Sempre" — `cfEl('button', { className: 'cleanfeed-btn cleanfeed-btn-primary', textContent: chrome.i18n.getMessage('curiosityAlways'), onClick: ... })`

For "Oggi", calculate midnight: `new Date().setHours(23, 59, 59, 999)`

- [ ] **Step 2: Verify/implement showSubscriptionExceptionToast()**

After a keyword block hides videos, scan hidden videos for subscribed channels. For each affected subscribed channel, show a chip in the toast. Clicking a chip sends `whitelistChannel` message and un-hides that channel's videos.

Detection of subscribed channels: look for channels in the left sidebar subscription list (`ytd-guide-entry-renderer` under the subscriptions section) and compare with hidden video channel names.

- [ ] **Step 3: Test curiosity window flow manually**

1. Reload extension
2. Open YouTube, search for something new
3. Verify prompt appears (inline banner for first 3, toast after)
4. Click "Just now" — verify videos stay visible
5. Navigate away — verify the query expires

- [ ] **Step 4: Commit**

```bash
git add content.js
git commit -m "feat: curiosity window with 3 time options + subscription exception toast"
```

---

### Task 7: Popup HTML + JS

**Files:**
- Rewrite: `popup.html`
- Rewrite: `popup.js`

- [ ] **Step 1: Write popup.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="styles/popup.css">
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="cf-logo">CF</div>
      <span class="header-title">CleanFeed</span>
    </div>
    <div class="header-badge" id="planBadge">FREE</div>
  </div>

  <div class="stats-row">
    <div class="stat">
      <div class="stat-value" id="statBlocked">0</div>
      <div class="stat-label" data-i18n="blocked">Blocked</div>
    </div>
    <div class="stat-divider"></div>
    <div class="stat">
      <div class="stat-value" id="statHidden">0</div>
      <div class="stat-label" data-i18n="hidden">Hidden</div>
    </div>
    <div class="stat-divider"></div>
    <div class="stat">
      <div class="stat-value" id="statInterests">0</div>
      <div class="stat-label" data-i18n="interests">Interests</div>
    </div>
  </div>

  <div class="tab-bar">
    <button class="tab active" data-tab="controls" data-i18n="controls">Controls</button>
    <button class="tab" data-tab="blocked" data-i18n="blocked">Blocked</button>
    <button class="tab" data-tab="hidden" data-i18n="hidden">Hidden</button>
    <button class="tab" data-tab="interests" data-i18n="interests">Interests</button>
  </div>

  <div class="tab-content active" id="tab-controls"></div>
  <div class="tab-content" id="tab-blocked"></div>
  <div class="tab-content" id="tab-hidden"></div>
  <div class="tab-content" id="tab-interests"></div>

  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write popup.js**

Full popup logic with:
- `loadState()` via `getFullState` message
- `applyI18n()` for localization
- `renderControls()` — toggles for Hide Shorts, Keyword Blocking, Interest Boundaries, Smart Decay + Pro badges + upgrade CTA
- `renderBlocked()` — two sections: blocked channels list + blocked keywords list with add input
- `renderHidden()` — hidden videos log with undo buttons (Pro only)
- `renderInterests()` — interests list with type badge and decay countdown (Pro only)
- Tab switching logic
- Toggle click handlers (locked toggles open payment page)
- Add keyword handler with free limit check
- Remove handlers for channels, keywords, hidden videos, interests
- `chrome.storage.onChanged` listener for live updates

Key implementation notes:
- All DOM via `document.createElement` (popup doesn't need Trusted Types compliance but keeping consistent)
- Dark mode via `@media (prefers-color-scheme: dark)` in CSS
- Stats update from `state.stats`
- PRO badges: `display: none` by default, shown via JS for free users

- [ ] **Step 3: Commit**

```bash
git add popup.html popup.js
git commit -m "feat: popup UI with 4 tabs — controls, blocked, hidden, interests"
```

---

### Task 8: Popup CSS

**Files:**
- Rewrite: `styles/popup.css`

- [ ] **Step 1: Write complete popup.css**

Must include:
- Body: `width: 380px; min-height: 480px;`
- Header: always dark `#0f0f0f`, flex layout, CF logo, badge
- Stats row: flex with dividers, light `#f8f9fa` / dark `#181818`
- Tab bar: 4 tabs, active = blue border + blue text
- Toggle switches: 44x24px, active blue, locked 40% opacity
- Pro badges: 8px, blue pill, hidden by default
- Upgrade CTA: gradient background, centered
- List items: flex, rounded, with remove button
- Add keyword input: flex row with input + add button
- Empty states: centered, muted text
- Dark mode: `@media (prefers-color-scheme: dark)` block
- Scrollbar styling
- All 4 tab content panels

Specs are identical to v1 popup.css with the addition of:
- Keyword input field styling
- Hidden videos list styling (with reason badge)
- Interests list with type badge

- [ ] **Step 2: Commit**

```bash
git add styles/popup.css
git commit -m "feat: popup CSS with dark/light theme, 4 tabs, keyword input"
```

---

### Task 9: Integration Testing + Final Fixes

**Files:**
- All files (verification)

- [ ] **Step 1: Load extension and run full test checklist**

1. **Channel Blocking:**
   - [ ] Homepage: three-dot menu shows "Block channel permanently"
   - [ ] Click block → video disappears immediately (no reload)
   - [ ] Toast shows channel name
   - [ ] Blocked channel appears in popup Blocked tab
   - [ ] Unblock from popup works
   - [ ] Search results: block works
   - [ ] Watch page sidebar: block works
   - [ ] Channel page: "[CF] Block this channel" button appears next to Subscribe

2. **Keyword Blocking:**
   - [ ] Add keyword in popup → matching videos hidden on YouTube
   - [ ] Hidden videos logged in Hidden tab with reason
   - [ ] Remove keyword → videos reappear
   - [ ] 4th keyword (free) → shows upgrade toast
   - [ ] Title AND description matching works

3. **Subscription Exception:**
   - [ ] Block keyword that affects subscribed channel → exception toast appears
   - [ ] Click channel name in toast → channel whitelisted
   - [ ] Whitelisted channel's videos reappear
   - [ ] Free users: clicking channel opens Pro upgrade

4. **Curiosity Window:**
   - [ ] Search for new topic → prompt appears
   - [ ] First 3 searches: inline banner
   - [ ] After 3: bottom toast
   - [ ] "Just now" → videos visible until navigate away
   - [ ] "Today" → interest expires at midnight
   - [ ] "Always" → permanent interest
   - [ ] Free users: buttons open Pro upgrade

5. **Shorts Killer:**
   - [ ] Toggle ON → all Shorts sections disappear
   - [ ] Toggle OFF → Shorts reappear
   - [ ] Works on homepage, search, channel pages

6. **Popup:**
   - [ ] All 4 tabs render correctly
   - [ ] Stats update
   - [ ] Dark mode works
   - [ ] Pro badges show for free users
   - [ ] Upgrade CTA visible for free users

7. **General:**
   - [ ] YouTube SPA navigation handled
   - [ ] No console errors
   - [ ] Dark mode on YouTube matches

- [ ] **Step 2: Fix any issues found**

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: CleanFeed v1.1 — complete rebuild with 7 features

- Permanent channel blocking (menu + channel page button)
- Keyword blocking (title + description matching)
- Subscription exception (whitelist channels within keyword blocks)
- Curiosity window (just now / today / always)
- Shorts killer (CSS-based toggle)
- Smart decay (30-day auto-remove)
- Hidden videos log (with undo)
- Freemium: unlimited channel blocking + 3 keywords + shorts free
- Pro: unlimited keywords + subscription exception + curiosity window + smart decay + hidden log
- YouTube 2025 DOM support + Trusted Types compliance
- English + Italian localization"
```

---

### Task 10: ExtensionPay Setup + Chrome Web Store (Manual)

**Files:** None (manual steps for Gianluca)

- [ ] **Step 1: Create ExtensionPay account**
1. Go to https://extensionpay.com
2. Sign up with factualogic98@gmail.com
3. Connect Stripe (use Postepay Evolution Mastercard)
4. Register extension as `cleanfeed`
5. Add plans: monthly $3.99, yearly $29.99

- [ ] **Step 2: Update extension ID**
Replace `'cleanfeed'` in background.js if ExtensionPay gives a different ID.

- [ ] **Step 3: Chrome Web Store**
1. Go to https://chrome.google.com/webstore/devconsole
2. Pay $5 developer fee
3. Create listing with screenshots
4. Upload zip of extension (exclude .git, .superpowers, docs)
5. Submit for review
