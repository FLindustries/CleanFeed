# CleanFeed tests (dev-only, never added to package.sh)

**Unit** (pure logic, no browser, zero dependencies): `node tests/run-unit.js [name-filter]`
Add `tests/unit/<name>.test.js`: `const test = require('./registry')`, `node:assert`, and
`require('./load-content-dom')()` for content-dom.js bindings (`matchesKeyword`, `YT`, ...). Wrap vm values in `loadContentDom.plain(x)` before `deepStrictEqual`.

**Live** (real Chromium + this extension + real logged-out YouTube): `node tests/live/smoke.js`
Prints a JSON report, exit 0 if the content script ran. Never signs in; on consent pages it clicks only "Reject all".
Needs playwright-core and Chromium, auto-detected (override: `PLAYWRIGHT_CORE_PATH`, `CF_CHROMIUM_PATH`; `CF_HEADED=1` shows the window).
Build new scenarios on `tests/live/harness.js`: every browser call has a hard timeout; wrap whole scripts in `watchdog()`.
`node tests/live/menu.js` (about 2 min): opens real 3-dot menus on a channel page, a search page and a Shorts shelf; checks the tab stays responsive and each menu holds one correct set of CleanFeed items.
