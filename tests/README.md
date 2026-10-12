# CleanFeed tests (dev-only, never added to package.sh)

**Unit** (pure logic, no browser, zero dependencies): `node tests/run-unit.js [name-filter]`
Add `tests/unit/<name>.test.js`: `const test = require('./registry')`, `node:assert`, and
`require('./load-content-dom')()` for content-dom.js bindings (`matchesKeyword`, `YT`, ...). Wrap vm values in `loadContentDom.plain(x)` before `deepStrictEqual`.
For page-level `YT` helpers, build a stub page with `tests/unit/fake-dom.js` (`el()`, `fakeDocument()`; small CSS subset, unsupported selectors throw) and pass it as `loadContentDom({ document, location: { pathname } })`.

**Live** (real Chromium + this extension + real logged-out YouTube): `node tests/live/smoke.js`
Prints a JSON report, exit 0 if the content script ran. Never signs in; on consent pages it clicks only "Reject all".
Needs playwright-core and Chromium, auto-detected (override: `PLAYWRIGHT_CORE_PATH`, `CF_CHROMIUM_PATH`; `CF_HEADED=1` shows the window).
Build new scenarios on `tests/live/harness.js`: every browser call has a hard timeout; wrap whole scripts in `watchdog()`.
`h.attachContentWorld(page)` evaluates expressions inside CleanFeed's content-script world (e.g. `YT.isChannelPage()`), which `page.evaluate` cannot reach.
`node tests/live/menu.js` (about 2 min): opens real 3-dot menus on a channel page, a search page and a Shorts shelf; checks the tab stays responsive and each menu holds one correct set of CleanFeed items.
`node tests/live/navigation.js` (about 75 s): SPA navigation watch -> owner channel -> another channel (blocked) -> Home, a blocked channel -> Home, and the subscriptions toast across navigations; checks that page-level decisions read only the visible page, not YouTube's hidden cached pages.
`node tests/live/shorts.js` (about 1 min): search-result Shorts (`ytm-shorts-lockup-view-model` in `grid-shelf-view-model`) untouched with nothing blocked; with "minecraft" blocked every matching Short is hidden (one card per Short, empty shelves hidden), and the `/shorts` player hides a matching short, pauses it and resumes playback on the next shown short; a channel's Shorts tab keeps one card per grid cell.
`node tests/live/quickadd.js` (about 1 min): CF+ quick-add on a result with an apostrophe or hyphen in its title and on a Cyrillic one (the chip keeps the punctuation, the stored keyword equals the chip, matches the title and hides the card), then the Scan modal on a channel's Videos tab (every candidate matches a title; ticking one stores it).
