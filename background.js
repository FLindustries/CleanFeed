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
