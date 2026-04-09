# CleanFeed v1.0 Rebuild — Design Spec

**Date:** 2026-04-09
**Status:** Final
**Author:** Gianluca + Claude
**Replaces:** `2026-04-09-cleanfeed-design.md` (first design, had bugs due to YouTube 2025 DOM changes)

---

## Problem

YouTube's "Not interested" button doesn't work — Mozilla confirmed it fails 57% of the time (20,000 user study). One curious search pollutes your feed for weeks. There's no way to block content categories, protect your subscriptions from category blocks, or time-limit your curiosity. CleanFeed fixes all of this.

## Product Summary

CleanFeed is a Chrome extension that gives users real control over YouTube's algorithm. Seven features:

1. **Permanent Channel Blocking** — block any channel forever, works everywhere on YouTube
2. **Keyword Blocking** — block by keywords in title + description
3. **Subscription Exception** — whitelist subscribed channels within keyword blocks
4. **Curiosity Window** — time-limited interest boundaries: "solo adesso" / "oggi" / "sempre"
5. **Shorts Killer** — one toggle, all Shorts sections vanish
6. **Smart Decay** — interests auto-remove after 30 days of inactivity
7. **Hidden Videos Log** — see what was hidden and why, undo false positives

## Business Model: Freemium

| Feature | Free | Pro ($3.99/mo or $29.99/yr) |
|---------|------|------------------------------|
| Channel blocking | Unlimited | Unlimited |
| Shorts killer | Yes | Yes |
| Keyword blocking | 3 keywords | Unlimited |
| Subscription Exception | No | Yes |
| Curiosity Window | No (teaser: prompt shown 3x then stops) | Full (Solo adesso / Oggi / Sempre) |
| Smart Decay | No | Yes |
| Hidden videos log | No | Yes |

**Why unlimited free channel blocking:** BlockTube (100K users) offers unlimited free blocking. Limiting CleanFeed to 5 would make users choose BlockTube instead. Free channel blocking gets users in the door; the unique Pro features (Subscription Exception, Curiosity Window) convert them.

**Payment:** Stripe via ExtensionPay library. Zero server cost. ExtensionPay takes 5% + Stripe's 2.9% + $0.30 per transaction. Payouts to Postepay Evolution IBAN.

**Revenue projections (3% conversion rate):**
- 10,000 users → 300 Pro → $1,200/mo
- 50,000 users → 1,500 Pro → $6,000/mo
- 100,000 users → 3,000 Pro → $12,000/mo

---

## Architecture

### Stack
- Chrome Extension, Manifest V3
- 100% client-side — no server, no database, no API calls
- `chrome.storage.local` (10MB limit)
- ExtensionPay for payments (resilient init — works without registered ID)
- MutationObserver for YouTube DOM changes (debounced 200ms)
- All DOM creation via `document.createElement()` — YouTube enforces Trusted Types CSP, blocking all `innerHTML`

### YouTube 2025 DOM Reality (discovered through live testing)

YouTube's DOM has changed significantly in 2025:
- **Menu popup:** Now uses `yt-sheet-view-model > yt-list-view-model > yt-list-item-view-model` instead of `ytd-menu-popup-renderer > tp-yt-paper-listbox`
- **Channel names:** Now inside `a[href^="/@"]` instead of `#channel-name a` or `ytd-channel-name a`
- **Shorts sections:** Uses `ytd-reel-shelf-renderer` and `ytd-rich-shelf-renderer[is-shorts]`
- **Trusted Types CSP:** All `innerHTML` assignments throw errors. Must use `createElement` + `textContent`
- **Menu button tracking:** `document.activeElement` loses the video card reference after menu opens. Must track clicks on three-dot buttons via capture-phase event listener.

Both old and new DOM structures must be supported (YouTube rolls out changes gradually).

### File Structure
```
C:\Users\Nyare\Desktop\Clean Feed\
├── manifest.json              # Extension config (Manifest V3)
├── background.js              # Service worker: ExtPay, alarms, message handling
├── content.js                 # YouTube content script: all DOM manipulation
├── popup.html                 # Popup UI shell
├── popup.js                   # Popup logic: tabs, toggles, lists, Pro gating
├── storage.js                 # Storage helpers (imported by background.js)
├── styles/
│   ├── popup.css              # Popup styles (light + dark)
│   └── content.css            # YouTube overlay styles (toast, banner, block button)
├── lib/
│   └── ExtPay.js              # ExtensionPay library
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── _locales/
    ├── en/
    │   └── messages.json      # English (primary)
    └── it/
        └── messages.json      # Italian
```

### Data Model (chrome.storage.local)

```json
{
  "blockedChannels": [
    { "name": "ChannelName", "id": "@handle", "blockedAt": 1712000000000 }
  ],
  "blockedKeywords": [
    { "keyword": "gaming", "addedAt": 1712000000000 }
  ],
  "whitelistedChannels": [
    { "name": "FavGamingChannel", "id": "@handle", "exemptFrom": "gaming" }
  ],
  "interests": {
    "programming": {
      "query": "programming tutorials",
      "keywords": ["programming", "coding"],
      "addedAt": 1712000000000,
      "lastUsed": 1712000000000,
      "expiresAt": null
    }
  },
  "hiddenVideos": [
    {
      "title": "Elden Ring Boss Fight",
      "channel": "SomeGamer",
      "reason": "keyword:gaming",
      "hiddenAt": 1712000000000
    }
  ],
  "settings": {
    "hideShorts": false,
    "enableSmartDecay": true,
    "enableInterestBoundaries": true
  },
  "stats": {
    "channelsBlocked": 0,
    "videosHidden": 0,
    "interestsSaved": 0
  },
  "onboarding": {
    "interestPromptCount": 0
  }
}
```

**Notes:**
- `hiddenVideos` array is capped at 100 entries (oldest removed first) to prevent storage bloat
- `interests.expiresAt` is set for "Oggi" curiosity window (timestamp of midnight) and null for "Sempre"
- `whitelistedChannels.exemptFrom` links to the keyword that triggered the exception

---

## Feature Details

### Feature 1: Permanent Channel Blocking

**Where the block option appears:**

1. **Three-dot menu (⋮) on any video** — homepage, search results, sidebar recommendations, watch page sidebar
   - Injected into YouTube's `yt-list-view-model` (2025) or `tp-yt-paper-listbox` (legacy)
   - Positioned after "Non consigliare il canale" / "Don't recommend channel"
   - Fallback: append to end of menu if target item not found
   - Red text + CF logo to distinguish from YouTube's options

2. **Button on channel page** — next to the "Subscribe" button
   - Only appears when visiting a channel page (URL matches `/@handle` or `/channel/`)
   - Styled as a small red button: "[CF] Block this channel"

**Channel name detection:**
- Primary: `a[href^="/@"]` inside the video card (2025 DOM)
- Fallback: `#channel-name a`, `ytd-channel-name a` (legacy DOM)
- Menu click tracking: capture-phase click listener on `document` tracks which video card's three-dot button was last clicked, stored in `lastClickedVideoCard` variable

**After blocking:**
- All videos from that channel get `cleanfeed-hidden` class (CSS `display: none !important`)
- Toast notification: "Blocked [ChannelName] permanently"
- Channel added to `blockedChannels` in storage
- Stats counter incremented
- No page reload needed

**Subscription Exception trigger:**
- After blocking a channel via keyword (not direct channel block), check if any of the user's subscribed channels match the keyword
- If matches found, show toast: "X of your subscribed channels were affected. Exclude them?"
- This only triggers for keyword blocks, not direct channel blocks

### Feature 2: Keyword Blocking

**How it works:**
1. User adds a keyword in popup's "Bloccati" / "Blocked" tab
2. Content script checks every video card's title text and visible description text
3. If keyword is found (case-insensitive, word boundary matching for keywords 4+ chars), video card is hidden
4. Hidden video is logged to `hiddenVideos` array with reason

**Title extraction (2025 DOM):**
- Video title: `#video-title`, `.ytd-video-renderer #video-title`, or the `yt-core-attributed-string` inside `h3`
- Description text: `.metadata-snippet-text`, `#description-text`, or visible snippet text below title

**Word boundary matching:**
- Keywords under 4 characters: exact word match only ("fps" matches "60 fps gameplay" but not "tips")
- Keywords 4+ characters: substring match ("gaming" matches "retro gaming setup" and "gaming chair review")

**Free tier:** 3 keywords max. Adding a 4th shows toast: "Free plan allows 3 keywords. Upgrade to Pro for unlimited."

**Subscription Exception integration:**
- When adding a keyword, scan visible videos for subscribed channels that would be hidden
- If found, show toast: "X subscribed channels affected. Exclude them?" with channel names
- User taps channel names to whitelist them

### Feature 3: Subscription Exception

**Trigger:** Only when a keyword block affects a subscribed channel.

**Detection of subscribed channels:**
- Scan video cards on current page for channels with a "subscribed" indicator
- YouTube shows a subtle indicator on videos from subscribed channels (checkmark or different styling)
- Alternative: check the sidebar subscription list (`#guide-section-renderer` with subscription entries)

**UX flow:**
1. User adds keyword "gaming" in popup
2. Content script hides all matching videos
3. Among hidden videos, some are from subscribed channels
4. Toast appears: "2 of your subscribed channels were affected. Exclude them?"
5. Toast shows channel names as clickable chips
6. User taps a channel name → that channel is added to `whitelistedChannels` with `exemptFrom: "gaming"`
7. Videos from that channel reappear despite the keyword match

**Storage:** `whitelistedChannels` array with `{ name, id, exemptFrom }`. A channel can be exempt from multiple keywords.

**Pro only.** Free users see the toast but tapping a channel opens Pro upgrade.

### Feature 4: Curiosity Window (Interest Boundaries Upgrade)

**Trigger:** User searches for something that doesn't match any existing interest.

**Detection:** Intercept `input#search` keypress Enter. Send `checkInterest` message to background. Background checks if query matches any existing interest keywords.

**Prompt options (Pro users):**
- **"Solo adesso"** — content allowed for this search session only. When user navigates away from search results (detected via `yt-navigate-finish` event where the new URL is NOT a search results page), the permission expires. Implementation: store active "solo adesso" queries in a JavaScript Set in content script memory (not chrome.storage). The Set is checked during filtering — matching videos are NOT hidden. The Set clears when `yt-navigate-finish` fires with a non-search URL.
- **"Oggi"** — set `expiresAt` to midnight tonight in the interest entry. Smart Decay or a check on next page load removes it after midnight.
- **"Sempre"** — permanent interest, no expiration. Subject to Smart Decay (30 days).

**Free users:**
- See the prompt during first 3 searches (teaser)
- All buttons in the teaser open Pro upgrade page
- After 3 searches, prompt stops appearing entirely

**Onboarding behavior:**
- First 3 searches: inline banner (prominent, teaches the feature)
- After 3 searches (Pro users): bottom toast (less intrusive, auto-dismiss 8s)

### Feature 5: Shorts Killer

**Toggle:** Single on/off switch in popup under Controls tab.

**When ON, hide these elements:**
- `ytd-reel-shelf-renderer` — Shorts shelf on homepage
- `ytd-rich-shelf-renderer[is-shorts]` — alternative Shorts shelf
- `ytd-reel-item-renderer` — individual Short items
- Shorts tab/chip in search results and channel pages
- The "Shorts" entry in the left sidebar navigation

**Implementation:** Inject CSS rules that hide these selectors when the setting is ON. Faster than JS-based hiding and avoids FOUC.

**Free feature.** This drives installs — everyone wants it.

### Feature 6: Smart Decay

**How it works:**
- `chrome.alarms` fires every 24 hours
- Checks all entries in `interests`
- If `lastUsed` is older than 30 days AND `expiresAt` is null (permanent interest), remove it
- If `expiresAt` is set and past, remove it (handles "Oggi" expiration)

**Pro only.** Free users' interests never decay (but they can't add interests anyway without Curiosity Window).

### Feature 7: Hidden Videos Log

**What it shows:** The "Nascosti" / "Hidden" tab in the popup displays recently hidden videos:
- Video title (truncated)
- Channel name
- Reason: "Keyword: gaming" or "Channel: PewDiePie"
- Timestamp
- "Undo" button — removes this specific hide and adds the video's channel/keyword to a temporary allow-list for the session

**Storage:** `hiddenVideos` array, max 100 entries, oldest removed first.

**Pro only.** Free users see the tab but with a "Upgrade to see hidden videos" message.

---

## Popup UI

### Structure
```
┌──────────────────────────────────┐
│ [CF] CleanFeed              [FREE]│  ← Always-dark header
├──────────────────────────────────┤
│    12        47          2       │  ← Stats row (always visible)
│  Blocked   Hidden    Interests   │
├──────────────────────────────────┤
│ Controls │ Blocked │ Hidden │ Interests │  ← Tab bar
├──────────────────────────────────┤
│                                  │
│  Tab content here                │
│                                  │
│  ┌────────────────────────────┐  │
│  │   Upgrade to Pro — $3.99   │  │  ← CTA (free users only)
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

### Tab: Controls
- **Hide Shorts** — toggle (Free)
- **Keyword Blocking** — toggle + "PRO" badge if free (Pro)
- **Interest Boundaries** — toggle + "PRO" badge if free (Pro)
- **Smart Decay** — toggle + "PRO" badge if free (Pro)
- Upgrade CTA at bottom (free users only)

### Tab: Blocked
Two sections:
1. **Blocked Channels** — list with channel names + remove (×) button
2. **Blocked Keywords** — list with keywords + remove (×) button + "Add keyword" input field
   - Free users: show "X/3 keywords used" counter
   - Adding input field at top with "Add" button

### Tab: Hidden (Pro only)
- List of recently hidden videos with:
  - Title (truncated to ~40 chars)
  - Reason badge ("Keyword: gaming" or "Channel: X")
  - "Undo" button
- Free users: "Upgrade to Pro to see hidden videos"

### Tab: Interests (Pro only)
- List of saved interests with:
  - Interest name
  - Type badge: "Oggi" (with expiry time) or "Sempre"
  - Days until Smart Decay (for "Sempre" interests)
  - Remove (×) button
- Free users: "Upgrade to Pro for Interest Boundaries"

### Dark mode
- Popup uses `@media (prefers-color-scheme: dark)` (can't access YouTube's `html[dark]` from popup)
- Content overlays (toast, banner, block button) use YouTube's `html[dark]` attribute

### Design tokens (unchanged from v1)
- Accent: YouTube blue `#3ea6ff`
- Header: always dark `#0f0f0f`
- CF logo: 22x22 blue rounded square with "CF"
- PRO badge: 8px, `#3ea6ff` background, white text, pill shape
- Toggle: 44x24px, active `#3ea6ff`, inactive `#ccc` (light) / `#383838` (dark)

---

## Localization

Primary language: **English**. Secondary: Italian.

All user-facing strings use `chrome.i18n.getMessage()`. The `_locales` directory contains:
- `en/messages.json` (primary, ~40 keys)
- `it/messages.json` (translation)

New i18n keys needed for rebuild:
- `hideShorts` / `hideShortsDesc`
- `keywordBlocking` / `keywordBlockingDesc`
- `addKeyword` / `addKeywordPlaceholder`
- `keywordsUsed` (with placeholder for count)
- `hiddenVideos` / `hiddenVideosUpgrade`
- `interestsUpgrade`
- `subscriptionExceptionToast` (with placeholder for count)
- `excludeChannel`
- `curiosityJustNow` / `curiosityToday` / `curiosityAlways`
- `blockThisChannel`
- `undoHide`

---

## What's NOT in v1.0

Explicitly out of scope:
- Search-Only Mode (removed — Unhook does it better)
- Community blocklists (needs user base, v2.0)
- CleanFeed Score (needs data, v2.0)
- Focus Profiles (v1.2)
- Block Like This / similar channel suggestions (v1.1)
- Hide Already-Watched Videos (v1.1)
- Clean Subscriptions Feed (v1.1)
- Quick Clean (v1.1)
- Spoiler Shield (v1.2)
- AI-powered content analysis (v2.0)
- Content-type filter within a channel (v1.1 — block reaction videos from a gaming channel)
- Cross-browser sync (future Pro feature)
- Export/import blocked channels (v1.1)

---

## Launch Checklist

1. Build extension with all 7 features + Pro gating
2. Set up ExtensionPay account (Stripe + Postepay Evolution)
3. Create Chrome Web Store listing ($5 fee)
4. Submit for review (3-5 business days)
5. Reddit launch: r/YouTube, r/productivity, r/ADHD
6. Product Hunt launch
7. X (Twitter) marketing campaign
