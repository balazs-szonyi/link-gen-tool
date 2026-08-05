# Link Gen Tool

Bookmarklet-injectable browser addon companion to the
[`sbplayground-link-generator`](https://github.com/balazs-szonyi/sbplayground-link-generator)
Copilot CLI skill. Generates environment-correct Betsson sportsbook QA links
directly in the browser, and can capture live-login `stc`/`ctx` pairs from a
brand page you're already logged into — no CLI, no headless automation.

## What it does

- **Generate** tab: pick brand / environment (test, qa, alpha, prod) / login
  state / BLE-source, get a desktop + mobile link. Client-side port of
  `generate-link.ps1` — calls `internal.{env}.sbplayground1.net/api/*`
  directly (those endpoints have open CORS).
- **Live Login** tab: passively sniffs `sb/fe-api/*` requests for
  `x-sb-static-context-id` / `x-sb-user-context-id` headers while you browse
  a brand site normally, already logged in via your own real session. This
  passive capture needs no per-brand code and is fully verified end-to-end
  (2026-08, NordicBet/test). Also offers an **experimental** "Auto-login"
  button (simulated typing, not headless automation) for brands with a
  `LOGIN_SELECTORS` entry — this part is unverified/best-effort, since some
  brands (confirmed: NordicBet) build their login form with shadow-DOM web
  components that a plain (or even shadow-piercing) `querySelector` may not
  reach. When auto-login can't find the fields, just log in manually — the
  passive capture keeps working regardless. Unmapped brands get passive
  capture only, no auto-fill attempt.
- **Credentials** tab: manage one or more test user/pass pairs, stored in
  the current page's own `localStorage` (first-party, so it always saves
  reliably). To reuse a credential on a different brand's domain, use the
  **"Copy sync code"** button on the source domain and **"Import sync
  code"** on the target domain's Credentials tab — a manual step, but 100%
  reliable regardless of the browser's third-party storage policy (see
  "Why not a shared cross-origin vault?" below). The first credential you
  ever save on a domain becomes its default automatically; automation
  always uses the current default so it never blocks waiting for input.

## Install (bookmarklet)

1. Open [the GitHub Pages site](https://balazs-szonyi.github.io/link-gen-tool/)
   once it's deployed.
2. Drag the shown `javascript:...` snippet to your bookmarks bar.
3. On any Betsson brand page, click the bookmark to open the panel.
4. The panel title bar and the browser console (`[link-gen-tool] loaded
   vX...`) show the version of the code that's actually running. Clicking
   the bookmark again on the same page (no reload) now always tears down
   the old panel and rebuilds it from a freshly-fetched copy of
   `link-gen-tool.js` - so re-clicking is a reliable way to pick up a new
   deploy without needing a full page reload. If you ever suspect you're
   testing a stale build, check the version shown against the latest
   commit before assuming a fix didn't work.

## Local development

```
node serve.js
```

Serves `link-gen-tool.js` on `http://localhost:8844`. Use a bookmarklet
pointing at `http://localhost:8844/link-gen-tool.js` while iterating, then
switch back to the GitHub Pages URL once changes are pushed.

## Why not a shared cross-origin vault?

An earlier version stored credentials in a hidden cross-origin `<iframe>`
(`vault.html`, hosted on this tool's own GitHub Pages origin) so one
credential would automatically be visible on every brand domain. That
broke in real-world testing (2026-08): Chrome's third-party storage
partitioning (stricter still on managed/corporate Chrome profiles that
block third-party storage outright) silently scopes an iframe's
`localStorage` per top-level site, so a credential saved while embedded on
`nordicbet.com` was invisible when the same iframe loaded on
`betsafe.com` — a save that looked like it "didn't stick." Fixed by
dropping the iframe and storing credentials directly in each page's own
first-party `localStorage`, plus an explicit Export/Import sync code in
the Credentials tab for moving a credential between brand domains. Manual,
but it can't be silently broken by a storage policy.

## Versioning

`link-gen-tool.js` has a `VERSION` constant near the top, shown in the
panel title and logged to the console on every load. Bump it with every
change. This exists because of a real bug (2026-08): re-clicking the
bookmarklet on a page that already had a panel used to just toggle the
*existing, already-executed* panel back into view instead of running the
newly-fetched script - so a user who fixed/deployed code and then
re-clicked the bookmarklet without a full page reload would keep seeing
the old, pre-fix behavior indefinitely, even though the deploy itself had
succeeded. The bookmarklet click now always destroys any existing panel
and rebuilds fresh from whatever code was just fetched; the visible
version number is the easiest way to confirm which build is actually
running.

## Known limitations

- Clicking "Auto-login" when the current page isn't the brand's login path
  no longer navigates the current tab away. Instead it opens the login page
  in a **new same-origin tab** (`window.open(...)`) and - since it's
  same-origin - reaches directly into that tab's `document` to inject the
  exact same `<script src=...>` tag the bookmarklet itself creates, so the
  whole tool starts running there automatically, with no extra click. The
  original tab's script/panel is left completely alone (it never navigates,
  so nothing is torn down there). A short-lived breadcrumb is still left in
  `sessionStorage` (`__lgtAutoLoginResume`) before opening the new tab -
  same-origin popups inherit a copy of the opener's `sessionStorage` at
  creation time, so `resumeAutoLoginIfPending()` in the new tab picks it up
  and auto-switches to the Live Login tab + resumes the fill/submit flow
  there, exactly as before.
  - **Fallback (rare)**: if the new tab can't be opened (popup blocked) or
    the site isolates it from this page (e.g. via a
    `Cross-Origin-Opener-Policy` header, which can prevent reaching into
    even a same-origin popup's `document`), this falls back to the old
    behaviour - navigating the current tab - and you'll need to re-click
    the bookmarklet once on the login page yourself; the breadcrumb above
    still lets it resume automatically from there, same as always.
- Username/password fields are cleared before typing into them
  (`simulateTyping` in `link-gen-tool.js`), not just appended to - browser
  or site autofill can pre-populate a field (e.g. a remembered username)
  before the script gets to it, and typing on top of that without clearing
  first silently corrupts the value instead of replacing it.
- **Confirmed on NordicBet (2026-08): the password selector matches two
  elements on the real login page** - a genuine visible field plus a
  hidden one (a decoy input some sites add specifically to confuse
  browser/script autofill, since a naive script or autofill heuristic
  tends to grab the first DOM match). The earlier plain `querySelector`
  had no way to tell them apart and could silently fill the hidden decoy
  instead of the real field - which would explain a filled email but an
  always-empty-looking password even though the script's own log reached
  "Submitting...". `deepQuerySelector` now collects every match (including
  through shadow roots) and prefers a visible one; if more than one match
  is found, the panel logs it (e.g. "Password selector matched 2 elements
  - using the visible one.") so this is directly diagnosable instead of a
  silent guess.
- Auto-login selectors (`LOGIN_SELECTORS` in `link-gen-tool.js`) are
  experimental/best-effort. NordicBet's real login fields (`input[name=
  "email"]` / `input[name="password"]`) are plain light-DOM inputs (an
  earlier "shadow-DOM" diagnosis was wrong - the actual bug was just a
  stale username selector, fixed 2026-08). Filling in the fields re-queries
  each field fresh (`waitForElement`/`fillField` in `link-gen-tool.js`)
  right before typing into it, with a retry if the field detaches or the
  typed value doesn't stick, instead of resolving username/password/submit
  once up front and reusing those references across the whole (multi-
  second) typing sequence - the earlier upfront-resolve approach could fail
  silently if the site re-renders the password field after the username
  field is interacted with. Each step (looking for a field / filled /
  submitting / stopped-and-why) is logged in the panel so a failure is
  diagnosable from the log text instead of just "it stopped." However, the
  submit step was observed to not reliably complete a real login in
  testing - no login API call ever fired, and the form appeared to reset
  shortly after the click - most likely NordicBet's GroupIB fraud-detection
  (confirmed present via console logs) rejecting the non-human interaction,
  though a flaky same-page real-time connection in the test environment
  ("SST Connection Failed" in analytics) may also be a factor. The
  **passive capture** mechanism (no selectors, no submit needed) is what's
  actually validated and reliable — auto-login/auto-fill is a bonus that
  may save typing but log in manually (real click) to actually complete
  the login; passive capture keeps working regardless of who clicked.
- Behavioral bot-detection (keystroke/mouse timing) on the submit action is
  reduced but not eliminated by the simulated-typing approach — this differs
  from the network/browser-fingerprint-level blocks that stop headless
  automation outright (e.g. Kasada on Mobilbahis QA).
- The panel only auto-detects brand/environment from `location.hostname`
  (`BRAND_DOMAINS`) — brands without a known public domain (firestorm,
  firestormsg, sandbox) aren't auto-detectable this way; use the Generate tab
  directly for those.
- `betssonarcb` / `btsarba` / `btsarbacity` share the same real domain
  (`betsson.bet.ar`, differing only by Argentina province), so hostname
  auto-detection can't tell them apart. Override the brand manually in that
  case.
- Credentials are stored per-domain (`localStorage`), not shared
  automatically across brands — use the "Copy sync code" / "Import sync
  code" buttons in the Credentials tab to move a credential to another
  brand's domain manually.
