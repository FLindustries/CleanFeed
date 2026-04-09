// CleanFeed Storage Layer
// Shared helpers for chrome.storage.local read/write operations

const Storage = {
  // Default values for fresh install
  DEFAULTS: {
    blockedChannels: [],
    interests: {},
    settings: {
      searchOnlyMode: false,
      enableSmartDecay: true,
      enableInterestBoundaries: true
    },
    stats: {
      channelsBlocked: 0,
      videosHidden: 0,
      interestsSaved: 0
    },
    onboarding: {
      searchCount: 0
    }
  },

  FREE_CHANNEL_LIMIT: 5,

  // Initialize storage with defaults (called on install)
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

  async getBlockedChannelSet() {
    const channels = await this.getBlockedChannels();
    return new Set(channels.map(ch => ch.name.toLowerCase()));
  },

  async addBlockedChannel(name, id) {
    const channels = await this.getBlockedChannels();
    const exists = channels.some(
      ch => ch.id === id || ch.name.toLowerCase() === name.toLowerCase()
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
    await this.updateStats({ channelsBlocked: 0 });
  },

  // --- Interests ---

  async getInterests() {
    const { interests } = await chrome.storage.local.get('interests');
    return interests || {};
  },

  async addInterest(query) {
    const interests = await this.getInterests();
    const key = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    interests[key] = {
      query,
      keywords: [query.toLowerCase()],
      addedAt: Date.now(),
      lastUsed: Date.now()
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

    for (const [key, interest] of Object.entries(interests)) {
      for (const keyword of interest.keywords) {
        const kwWords = keyword.split(/\s+/);
        // Check if any keyword word matches any query word (whole word)
        const match = kwWords.some(kw =>
          queryWords.some(qw => qw === kw || qw.includes(kw) && kw.length >= 4)
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
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let changed = false;

    for (const [key, interest] of Object.entries(interests)) {
      if (interest.lastUsed && interest.lastUsed < thirtyDaysAgo) {
        delete interests[key];
        changed = true;
      }
    }

    if (changed) {
      await chrome.storage.local.set({ interests });
    }
    return changed;
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

  async incrementStat(statName) {
    const stats = await this.getStats();
    stats[statName] = (stats[statName] || 0) + 1;
    await chrome.storage.local.set({ stats });
  },

  async updateStats(updates) {
    const stats = await this.getStats();
    Object.assign(stats, updates);
    await chrome.storage.local.set({ stats });
  },

  // --- Onboarding ---

  async getOnboarding() {
    const { onboarding } = await chrome.storage.local.get('onboarding');
    return onboarding || this.DEFAULTS.onboarding;
  },

  async incrementSearchCount() {
    const onboarding = await this.getOnboarding();
    onboarding.searchCount = (onboarding.searchCount || 0) + 1;
    await chrome.storage.local.set({ onboarding });
    return onboarding.searchCount;
  }
};
