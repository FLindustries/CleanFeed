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

chrome.runtime.onInstalled.addListener(async (details) => {
  await Storage.init();
  chrome.alarms.create('smartDecay', { periodInMinutes: 24 * 60 });

  // Reset the curiosity prompt counter ONLY on first install. Previously this
  // also fired on every update, resurrecting the 3-prompt free teaser every
  // patch release — so paying-eligible users saw the upgrade nag forever.
  if (details && details.reason === 'install') {
    try {
      const onboarding = await Storage.getOnboarding();
      onboarding.interestPromptCount = 0;
      await chrome.storage.local.set({ onboarding });
    } catch (e) {
      console.warn('CleanFeed: failed to reset interest prompt count:', e);
    }
  }
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
      // Capture the keyword name BEFORE removing so we can wipe its auto-tag data
      const keywords = await Storage.getBlockedKeywords();
      const target = keywords[request.index];
      await Storage.removeBlockedKeyword(request.index);
      if (target?.keyword) await Storage.clearCategoryData(target.keyword.toLowerCase());
      return { success: true };
    }

    // --- Category Auto-Tag ---
    // Body: hits = [["category::channelLower", [videoKey, ...]], ...]
    // One storage read and one write for the whole batch: a read + write per
    // hit timed out the service worker. Storage.recordCategoryHits counts each
    // video once and never re-tags a channel the user untagged.
    case 'batchIncrementCategoryHits': {
      const newlyTagged = await Storage.recordCategoryHits(request.hits);
      return { success: true, newlyTagged };
    }

    case 'untagChannelForCategory': {
      await Storage.untagChannelForCategory(request.category, request.channelName);
      return { success: true };
    }

    case 'clearCategoryData': {
      await Storage.clearCategoryData(request.category);
      return { success: true };
    }

    // Wholesale replace of categoryTags — used by the content script's
    // garbage-collection pass (removes entries created before the channel-name
    // validation was added). Also wipes matching categoryHits so the bad
    // channels can't re-create themselves the next time we filter.
    case 'replaceCategoryTags': {
      const newTags = request.tags || {};
      const oldHits = await Storage.getCategoryHits();

      // For each category, keep only hits whose channel survived in the new tags
      // OR whose channel name is still valid (i.e. legitimate sub-threshold hits)
      const newHits = {};
      for (const [cat, channelMap] of Object.entries(oldHits)) {
        if (!channelMap || typeof channelMap !== 'object') continue;
        const keepChannels = {};
        for (const [ch, count] of Object.entries(channelMap)) {
          // Tag-valid channel survives even at any count; otherwise it must
          // pass a basic sanity check.
          const tagHas = Array.isArray(newTags[cat]) && newTags[cat].includes(ch);
          const valid = ch && ch.length >= 2 && /[a-zA-ZÀ-ſ]/.test(ch);
          if (tagHas || valid) keepChannels[ch] = count;
        }
        if (Object.keys(keepChannels).length > 0) newHits[cat] = keepChannels;
      }
      await chrome.storage.local.set({ categoryTags: newTags, categoryHits: newHits });
      return { success: true };
    }

    // --- Bulk add (used by channel scan modal) ---
    // Takes [{ type: 'keyword'|'synonym', phrase, category? }] and applies
    // them in a SINGLE storage write per bucket. Sequential per-item calls
    // were taking ~30s with 15-20 selections because each one triggered a
    // storage.onChanged cascade (state refetch + filterPage + …).
    case 'bulkAddBlockingTerms': {
      const items = Array.isArray(request.items) ? request.items : [];
      let addedKw = 0, addedSyn = 0, skippedFree = 0, duplicates = 0;

      const keywords = await Storage.getBlockedKeywords();
      const customs = await Storage.getCustomSynonyms();
      const existingKw = new Set(keywords.map(k => k.keyword.toLowerCase()));

      for (const item of items) {
        if (!item || !item.phrase) continue;
        const phrase = item.phrase.toLowerCase().trim();
        if (!phrase) continue;

        if (item.type === 'keyword') {
          if (existingKw.has(phrase)) { duplicates++; continue; }
          if (!isPro && keywords.length >= Storage.FREE_KEYWORD_LIMIT) {
            skippedFree++; continue;
          }
          keywords.push({ keyword: phrase, addedAt: Date.now() });
          existingKw.add(phrase);
          addedKw++;
        } else if (item.type === 'synonym' && item.category) {
          const cat = item.category;
          if (!customs[cat]) customs[cat] = [];
          if (customs[cat].includes(phrase)) { duplicates++; continue; }
          customs[cat].push(phrase);
          addedSyn++;
        }
      }

      // Single storage write covering BOTH buckets — one storage.onChanged
      // cascade total, not one per item.
      const writes = {};
      if (addedKw > 0) writes.blockedKeywords = keywords;
      if (addedSyn > 0) writes.customSynonyms = customs;
      if (Object.keys(writes).length > 0) {
        await chrome.storage.local.set(writes);
      }

      return { addedKw, addedSyn, skippedFree, duplicates };
    }

    // --- Preset Profiles ---
    // Bulk-add a curated set of category keys as blocked keywords in one
    // storage write. Categories already blocked are silently skipped.
    case 'applyPreset': {
      const keys = Array.isArray(request.categoryKeys) ? request.categoryKeys : [];
      if (keys.length === 0) return { success: false, error: 'empty_preset' };

      const existing = await Storage.getBlockedKeywords();
      const existingSet = new Set(existing.map(k => k.keyword.toLowerCase()));
      const toAdd = keys.filter(k => !existingSet.has(k.toLowerCase()));

      // Check free limit
      if (!isPro && (existing.length + toAdd.length) > Storage.FREE_KEYWORD_LIMIT) {
        return { success: false, reason: 'free_limit', wouldAdd: toAdd.length, currentCount: existing.length };
      }

      let added = 0;
      for (const k of toAdd) {
        existing.push({ keyword: k.toLowerCase(), addedAt: Date.now() });
        added++;
      }
      if (added > 0) await chrome.storage.local.set({ blockedKeywords: existing });
      return { success: true, added, alreadyBlocked: keys.length - added };
    }

    // --- Synonym Management ---
    case 'toggleSynonym': {
      return await Storage.toggleSynonym(request.synonym);
    }

    case 'getDisabledSynonyms': {
      const disabled = await Storage.getDisabledSynonyms();
      return { disabledSynonyms: disabled };
    }

    case 'addCustomSynonym': {
      return await Storage.addCustomSynonym(request.category, request.synonym);
    }

    case 'removeCustomSynonym': {
      await Storage.removeCustomSynonym(request.category, request.synonym);
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

    case 'checkInterestMatch': {
      // Check if this EXACT query is already saved as an interest (not fuzzy match)
      const interests = await Storage.getInterests();
      const queryLower = request.query.toLowerCase().trim();
      let exactMatch = false;
      for (const [key, interest] of Object.entries(interests)) {
        if (interest.query && interest.query.toLowerCase().trim() === queryLower) {
          exactMatch = true;
          break;
        }
      }
      return { exactMatch };
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
      const disabledSynonyms = await Storage.getDisabledSynonyms();
      const customSynonyms = await Storage.getCustomSynonyms();
      const categoryTags = await Storage.getCategoryTags();
      const categoryTagExclusions = await Storage.getCategoryTagExclusions();
      const interests = await Storage.getInterests();
      const hiddenVideos = await Storage.getHiddenVideos();
      const onboarding = await Storage.getOnboarding();

      return {
        settings, stats, blockedChannels, blockedKeywords,
        whitelistedChannels, disabledSynonyms, customSynonyms,
        categoryTags, categoryTagExclusions, interests, hiddenVideos, onboarding, isPro
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

    // --- Interest Prompt Reset ---
    case 'resetInterestPromptCount': {
      const onboarding = await Storage.getOnboarding();
      onboarding.interestPromptCount = 0;
      await chrome.storage.local.set({ onboarding });
      return { success: true };
    }

    // --- Daily Time Tracking ---
    case 'addTimeUsed': {
      return await Storage.addTimeUsed(request.seconds);
    }

    case 'getTimeUsed': {
      const secs = await Storage.getTimeUsed();
      return { secondsUsed: secs };
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

    // --- Export / Import ---
    case 'exportAllData': {
      const blockedChannels = await Storage.getBlockedChannels();
      const blockedKeywords = await Storage.getBlockedKeywords();
      const customSynonyms = await Storage.getCustomSynonyms();
      const disabledSynonyms = await Storage.getDisabledSynonyms();
      const whitelistedChannels = await Storage.getWhitelistedChannels();
      const interests = await Storage.getInterests();
      const settings = await Storage.getSettings();
      const categoryTags = await Storage.getCategoryTags();
      const categoryTagExclusions = await Storage.getCategoryTagExclusions();
      return {
        cleanfeedVersion: chrome.runtime.getManifest().version,
        exportedAt: Date.now(),
        blockedChannels, blockedKeywords, customSynonyms, disabledSynonyms,
        whitelistedChannels, interests, settings, categoryTags, categoryTagExclusions
      };
    }

    case 'importAllData': {
      const data = request.data || {};
      // Validate top-level keys are objects/arrays as expected
      if (!data || typeof data !== 'object') return { success: false, error: 'invalid_format' };
      const updates = {};
      if (Array.isArray(data.blockedChannels)) updates.blockedChannels = data.blockedChannels;
      if (Array.isArray(data.blockedKeywords)) updates.blockedKeywords = data.blockedKeywords;
      if (data.customSynonyms && typeof data.customSynonyms === 'object') updates.customSynonyms = data.customSynonyms;
      if (Array.isArray(data.disabledSynonyms)) updates.disabledSynonyms = data.disabledSynonyms;
      if (Array.isArray(data.whitelistedChannels)) updates.whitelistedChannels = data.whitelistedChannels;
      if (data.interests && typeof data.interests === 'object') updates.interests = data.interests;
      if (data.settings && typeof data.settings === 'object') {
        // Merge incoming settings with existing defaults so missing fields don't break
        const cur = await Storage.getSettings();
        updates.settings = { ...cur, ...data.settings };
      }
      if (data.categoryTags && typeof data.categoryTags === 'object') updates.categoryTags = data.categoryTags;
      if (data.categoryTagExclusions && typeof data.categoryTagExclusions === 'object' && !Array.isArray(data.categoryTagExclusions)) {
        updates.categoryTagExclusions = data.categoryTagExclusions;
      }
      await chrome.storage.local.set(updates);
      return { success: true, imported: Object.keys(updates) };
    }

    // --- Strict Mode ---
    case 'verifyStrictPassword': {
      const settings = await Storage.getSettings();
      if (!settings.strictModeEnabled) return { valid: true };
      if (!settings.strictModePasswordHash) return { valid: true };
      const hash = await Storage.hashPassword(request.password || '');
      return { valid: hash === settings.strictModePasswordHash };
    }

    case 'setStrictPassword': {
      const hash = await Storage.hashPassword(request.password || '');
      const settings = await Storage.getSettings();
      settings.strictModePasswordHash = hash;
      settings.strictModeEnabled = true;
      await chrome.storage.local.set({ settings });
      return { success: true };
    }

    case 'disableStrictMode': {
      const settings = await Storage.getSettings();
      if (settings.strictModeEnabled && settings.strictModePasswordHash) {
        const submittedHash = await Storage.hashPassword(request.password || '');
        if (submittedHash !== settings.strictModePasswordHash) return { success: false, reason: 'wrong_password' };
      }
      settings.strictModeEnabled = false;
      settings.strictModePasswordHash = '';
      await chrome.storage.local.set({ settings });
      return { success: true };
    }

    default:
      return { error: 'Unknown action: ' + request.action };
  }
}
