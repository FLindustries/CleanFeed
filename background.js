// CleanFeed Background Service Worker

importScripts('lib/ExtPay.js');
importScripts('storage.js');

// Initialize ExtensionPay
// IMPORTANT: Replace 'cleanfeed' with your actual ExtensionPay extension ID
// after registering at https://extensionpay.com
let extpay;
try {
  extpay = ExtPay('cleanfeed');
  extpay.startBackground();
} catch (e) {
  console.warn('CleanFeed: ExtensionPay init failed (not registered yet?):', e);
}

// Helper: safely check Pro status (returns false if ExtPay not ready)
async function checkProStatus() {
  try {
    if (!extpay) return false;
    const user = await extpay.getUser();
    return user?.paid === true;
  } catch (e) {
    // ExtPay not registered yet or network error — treat as free user
    return false;
  }
}

// --- Install / Update ---

chrome.runtime.onInstalled.addListener(async (details) => {
  await Storage.init();

  // Set up smart decay alarm (fires every 24 hours) — on install and update
  chrome.alarms.create('smartDecay', { periodInMinutes: 24 * 60 });
});

// --- Alarms ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'smartDecay') {
    const isPro = await checkProStatus();

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
  // Ignore ExtPay internal messages
  if (typeof request === 'string' && request.startsWith('extpay-')) return;

  handleMessage(request).then(sendResponse).catch(err => {
    console.error('CleanFeed message handler error:', err);
    sendResponse({ error: err.message });
  });
  return true; // Keep channel open for async response
});

async function handleMessage(request) {
  switch (request.action) {
    case 'blockChannel': {
      const isPro = await checkProStatus();
      const channels = await Storage.getBlockedChannels();

      if (!isPro && channels.length >= Storage.FREE_CHANNEL_LIMIT) {
        return { success: false, reason: 'free_limit' };
      }

      return await Storage.addBlockedChannel(request.channelName, request.channelId);
    }

    case 'checkInterest': {
      const isPro = await checkProStatus();

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
      const isPro = await checkProStatus();

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
      try {
        if (extpay) {
          extpay.openPaymentPage();
        } else {
          // Fallback: open ExtensionPay directly
          chrome.tabs.create({ url: 'https://extensionpay.com' });
        }
      } catch (e) {
        console.warn('CleanFeed: Could not open payment page:', e);
      }
      return { success: true };
    }

    default:
      return { error: 'Unknown action' };
  }
}
