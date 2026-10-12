// CleanFeed Storage Layer
// All chrome.storage.local operations. Imported by background.js only.

const Storage = {
  DEFAULTS: {
    blockedChannels: [],
    blockedKeywords: [],
    whitelistedChannels: [],
    disabledSynonyms: [],    // individual synonyms turned off within categories
    customSynonyms: {},      // user-added synonyms per category: {gaming: ["resident evil"]}
    categoryHits: {},        // per-category per-channel block counts: {gaming: {"every eye": 5}}
    categoryTags: {},        // channels auto-tagged for a category once hits >= threshold: {gaming: ["every eye"]}
    interests: {},
    hiddenVideos: [],
    settings: {
      hideShorts: false,
      hideComments: false,
      enableSmartDecay: true,
      enableInterestBoundaries: true,
      hideSubsRelevant: true, // hide the "Più pertinenti"/"For you" algorithmic shelf on /feed/subscriptions
      language: 'auto',       // 'auto', 'en', 'it'
      dailyTimeLimitEnabled: false,
      dailyTimeLimitMins: 30,
      scheduleEnabled: false,
      scheduleStart: '09:00',
      scheduleEnd: '18:00',
      scheduleDays: [1, 2, 3, 4, 5],
      strictModeEnabled: false,
      strictModePasswordHash: ''
    },
    dailyTimeTracking: { day: '', secondsUsed: 0 },
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
  // After N hidden videos from the same channel in a category, auto-tag the
  // whole channel so future videos are blocked even if the title doesn't
  // contain any keyword/synonym. Catches the "Gaussian Splatting on a gaming
  // channel" case where the title gives no signal.
  CATEGORY_TAG_THRESHOLD: 3,

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

  // --- Disabled Synonyms ---

  async getDisabledSynonyms() {
    const { disabledSynonyms } = await chrome.storage.local.get('disabledSynonyms');
    return disabledSynonyms || [];
  },

  async toggleSynonym(synonym) {
    const list = await this.getDisabledSynonyms();
    const lower = synonym.toLowerCase();
    const idx = list.indexOf(lower);
    if (idx >= 0) {
      list.splice(idx, 1); // re-enable
    } else {
      list.push(lower); // disable
    }
    await chrome.storage.local.set({ disabledSynonyms: list });
    return { enabled: idx >= 0 };
  },

  // --- Custom Synonyms ---

  async getCustomSynonyms() {
    const { customSynonyms } = await chrome.storage.local.get('customSynonyms');
    return customSynonyms || {};
  },

  async addCustomSynonym(category, synonym) {
    const customs = await this.getCustomSynonyms();
    if (!customs[category]) customs[category] = [];
    const lower = synonym.toLowerCase().trim();
    if (!lower) return { success: false };
    if (customs[category].includes(lower)) return { success: false, reason: 'already_exists' };
    customs[category].push(lower);
    await chrome.storage.local.set({ customSynonyms: customs });
    return { success: true };
  },

  async removeCustomSynonym(category, synonym) {
    const customs = await this.getCustomSynonyms();
    if (!customs[category]) return;
    const lower = synonym.toLowerCase();
    customs[category] = customs[category].filter(s => s !== lower);
    if (customs[category].length === 0) delete customs[category];
    await chrome.storage.local.set({ customSynonyms: customs });
  },

  // --- Category Auto-Tag (channels that keep producing blocked content) ---

  async getCategoryHits() {
    const { categoryHits } = await chrome.storage.local.get('categoryHits');
    return categoryHits || {};
  },

  async getCategoryTags() {
    const { categoryTags } = await chrome.storage.local.get('categoryTags');
    return categoryTags || {};
  },

  // Records that a video from `channelName` was hidden under `category`.
  // Returns { tagged: true } the moment the channel crosses the threshold so
  // the caller can refilter and surface the change.
  async incrementCategoryHit(category, channelName) {
    if (!category || !channelName) return { tagged: false };
    const lower = channelName.toLowerCase().trim();
    if (!lower) return { tagged: false };

    const hits = await this.getCategoryHits();
    if (!hits[category]) hits[category] = {};
    const prev = hits[category][lower] || 0;
    hits[category][lower] = prev + 1;

    let newlyTagged = false;
    if (hits[category][lower] >= this.CATEGORY_TAG_THRESHOLD) {
      const tags = await this.getCategoryTags();
      if (!tags[category]) tags[category] = [];
      if (!tags[category].includes(lower)) {
        tags[category].push(lower);
        newlyTagged = true;
        await chrome.storage.local.set({ categoryTags: tags });
      }
    }
    await chrome.storage.local.set({ categoryHits: hits });
    return { tagged: newlyTagged, count: hits[category][lower] };
  },

  // Wipe all auto-tag data for a category — called when a keyword is removed
  // so the user doesn't see ghosts of an old block.
  async clearCategoryData(category) {
    if (!category) return;
    const hits = await this.getCategoryHits();
    const tags = await this.getCategoryTags();
    let changed = false;
    if (hits[category]) { delete hits[category]; changed = true; }
    if (tags[category]) { delete tags[category]; changed = true; }
    if (changed) await chrome.storage.local.set({ categoryHits: hits, categoryTags: tags });
  },

  // Remove a single channel from a category's tag list (used by "Unblock channel for category")
  async untagChannelForCategory(category, channelName) {
    if (!category || !channelName) return;
    const lower = channelName.toLowerCase().trim();
    const tags = await this.getCategoryTags();
    const hits = await this.getCategoryHits();
    if (tags[category]) {
      tags[category] = tags[category].filter(c => c !== lower);
      if (tags[category].length === 0) delete tags[category];
    }
    if (hits[category] && hits[category][lower]) {
      delete hits[category][lower];
      if (Object.keys(hits[category]).length === 0) delete hits[category];
    }
    await chrome.storage.local.set({ categoryTags: tags, categoryHits: hits });
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
    let key = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    // Punctuation-only or non-ASCII (CJK, emoji) queries collapsed to "" and
    // overwrote each other. Fall back to a timestamp suffix.
    if (!key) key = 'interest-' + Date.now();

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
      if (interest.expiresAt && interest.expiresAt < now) {
        delete interests[key];
        changed = true;
        continue;
      }
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
  },

  // --- Daily Time Tracking ---

  async getTodayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  },

  async addTimeUsed(seconds) {
    const today = await this.getTodayKey();
    const { dailyTimeTracking } = await chrome.storage.local.get('dailyTimeTracking');
    const cur = dailyTimeTracking || { day: '', secondsUsed: 0 };
    // Reset counter on new day
    if (cur.day !== today) { cur.day = today; cur.secondsUsed = 0; }
    cur.secondsUsed += seconds;
    await chrome.storage.local.set({ dailyTimeTracking: cur });
    return cur;
  },

  async getTimeUsed() {
    const today = await this.getTodayKey();
    const { dailyTimeTracking } = await chrome.storage.local.get('dailyTimeTracking');
    if (!dailyTimeTracking || dailyTimeTracking.day !== today) return 0;
    return dailyTimeTracking.secondsUsed;
  },

  async hashPassword(plain) {
    if (!plain) return '';
    const buf = new TextEncoder().encode(plain);
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
};
