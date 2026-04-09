// CleanFeed Background Service Worker

importScripts('lib/ExtPay.js');
importScripts('storage.js');

// Initialize ExtensionPay
// IMPORTANT: Replace 'cleanfeed' with your actual ExtensionPay extension ID
// after registering at https://extensionpay.com
const extpay = ExtPay('cleanfeed');
extpay.startBackground();

// --- Install / Update ---

chrome.runtime.onInstalled.addListener(async (details) => {
  await Storage.init();

  // Set up smart decay alarm (fires every 24 hours) — on install and update
  chrome.alarms.create('smartDecay', { periodInMinutes: 24 * 60 });
});

// --- Alarms ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'smartDecay') {
    // Re-declare extpay in callback scope (MV3 service worker requirement)
    const extpayLocal = ExtPay('cleanfeed');
    const user = await extpayLocal.getUser().catch(() => null);
    const isPro = user?.paid === true;

    if (!isPro) return; // Smart decay is Pro-only

    const settings = await Storage.getSettings();
    if (settings.enableSmartDecay) {
      await Storage.performSmartDecay();
    }
  }
});

// Ensure alarm exists on startup (service worker may restart)
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.get('smartDecay', (alarm) => {
    if (!alarm) {
      chrome.alarms.create('smartDecay', { periodInMinutes: 24 * 60 });
    }
  });
});

// --- Message Handling ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request).then(sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(request) {
  switch (request.action) {
    case 'blockChannel': {
      const extpayLocal = ExtPay('cleanfeed');
      const user = await extpayLocal.getUser().catch(() => null);
      const isPro = user?.paid === true;
      const channels = await Storage.getBlockedChannels();

      if (!isPro && channels.length >= Storage.FREE_CHANNEL_LIMIT) {
        return { success: false, reason: 'free_limit' };
      }

      return await Storage.addBlockedChannel(request.channelName, request.channelId);
    }

    case 'checkInterest': {
      const extpayLocal = ExtPay('cleanfeed');
      const user = await extpayLocal.getUser().catch(() => null);
      const isPro = user?.paid === true;

      const settings = await Storage.getSettings();
      const onboarding = await Storage.getOnboarding();

      // Pro users: always prompt if enabled
      // Free users: prompt only during first 3 searches (teaser)
      const shouldCheck = isPro
        ? settings.enableInterestBoundaries
        : onboarding.searchCount < 3;

      if (!shouldCheck) {
        return { shouldPrompt: false };
      }

      const matches = await Storage.matchesExistingInterest(request.query);
      if (matches) {
        return { shouldPrompt: false };
      }

      const searchCount = await Storage.incrementSearchCount();
      return {
        shouldPrompt: true,
        query: request.query,
        isPro,
        searchCount,
        useInlineBanner: searchCount <= 3
      };
    }

    case 'addInterest': {
      const key = await Storage.addInterest(request.query);
      return { success: true, key };
    }

    case 'getSettings': {
      const settings = await Storage.getSettings();
      const stats = await Storage.getStats();
      const blockedChannels = await Storage.getBlockedChannels();
      const interests = await Storage.getInterests();
      const onboarding = await Storage.getOnboarding();

      const extpayLocal = ExtPay('cleanfeed');
      const user = await extpayLocal.getUser().catch(() => null);
      const isPro = user?.paid === true;

      return { settings, stats, blockedChannels, interests, onboarding, isPro };
    }

    case 'getBlockedSet': {
      const blockedSet = await Storage.getBlockedChannelSet();
      // Sets can't be serialized, convert to array
      return { blockedNames: [...blockedSet] };
    }

    case 'updateSetting': {
      await Storage.updateSetting(request.key, request.value);
      return { success: true };
    }

    case 'removeBlockedChannel': {
      await Storage.removeBlockedChannel(request.index);
      return { success: true };
    }

    case 'clearAllBlocked': {
      await Storage.clearAllBlockedChannels();
      return { success: true };
    }

    case 'removeInterest': {
      await Storage.removeInterest(request.key);
      return { success: true };
    }

    case 'incrementStat': {
      await Storage.incrementStat(request.stat);
      return { success: true };
    }

    case 'openPaymentPage': {
      const extpayLocal = ExtPay('cleanfeed');
      extpayLocal.openPaymentPage();
      return { success: true };
    }

    default:
      return { error: 'Unknown action' };
  }
}
