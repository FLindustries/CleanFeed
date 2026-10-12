// CleanFeed feature flags.
// Loaded first everywhere: content scripts (manifest.json), background.js
// (importScripts), popup.html and options.html.
// A feature set to false is hidden: no UI, no background work, no effect on
// filtering. Its code and the user's saved data are kept so it can return.

const CF_FEATURES = Object.freeze({ interestBoundaries: false, smartDecay: false, schedule: false, dailyTimeLimit: false });
