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
  }
};
