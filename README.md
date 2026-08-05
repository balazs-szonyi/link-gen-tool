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

## Install (Chrome extension — recommended if passive capture keeps failing)

A real Chrome extension (`extension/` in this repo) exists alongside the
bookmarklet as a separate, more robust option. It captures `stc`/`ctx`
headers via `chrome.webRequest` — a network-layer observation, immune to
the fetch-reference timing race described below that can make the
bookmarklet's in-page patch structurally blind to the relevant traffic on
some sites. It also eliminates the navigation-lifecycle complexity the
bookmarklet needs (`window.open`/re-injection/sessionStorage breadcrumbs) —
a `content_scripts` entry auto-injects on every page load and navigation,
and captured state lives in `chrome.storage.local` (survives navigation and
service-worker restarts with zero extra plumbing). The Credentials vault is
also `chrome.storage.local`-backed, so it's automatically shared across
every brand domain — no manual sync-code step needed.

1. Download the latest ZIP from this repo's
   [Releases page](https://github.com/balazs-szonyi/link-gen-tool/releases/tag/extension-latest)
   (`link-gen-tool-extension.zip`, auto-rebuilt on every push to `main`).
2. Extract it anywhere.
3. Open `chrome://extensions` in Chrome, enable **Developer mode** (top
   right), click **Load unpacked**, and select the extracted folder.
4. Click the extension's toolbar icon on any page to toggle the panel —
   same three tabs (Generate / Live Login / Credentials) as the
   bookmarklet, same UI.

Chrome-only; not published to the Chrome Web Store (internal tool, ZIP/
unpacked distribution only). The bookmarklet is unaffected and continues
to work exactly as before — this is an additional option, not a
replacement.

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

## Known limitations (bookmarklet)

> These limitations are specific to the bookmarklet's page-injected-script
> architecture. The [Chrome extension](#install-chrome-extension--recommended-if-passive-capture-keeps-failing)
> avoids most of them structurally — see below for what still applies to
> the extension.

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
  **Since 2026-08 (v11)**: after clicking submit, the panel now waits a
  few seconds and checks whether we've actually navigated away from the
  login path - if we're still there (matching the stuck-submit pattern
  above), it says so explicitly ("Both fields are filled, but still on the
  login page... click Log In yourself to finish") instead of leaving the
  status stuck on "Submitting..." forever with no way to tell whether it's
  still working or has silently stalled.
- **Capture data (`stc`/`ctx`) is persisted to `sessionStorage`** as soon as
  it's captured (`link-gen-tool.js`'s `Capture` module, v12) and restored on
  a fresh script instance if none is already in memory - a same-origin
  full-page navigation (e.g. a login form that redirects to the logged-in
  homepage rather than an in-place SPA route change) otherwise wipes
  `window.__lgtCaptureState` entirely, discarding a capture that succeeded
  moments earlier if the user hadn't yet clicked "Build final link". The
  panel also now reflects an already-captured value immediately when it's
  (re-)built, instead of only updating on the next new capture event.
- **If nothing has been captured yet, the status line now shows a running
  count of `sb/fe-api/*` calls observed (even ones missing one of the two
  needed headers)**, e.g. "3 sb/fe-api call(s) observed, none with both
  headers yet." - previously this said a static "Passive capture running"
  no matter what was actually happening, giving no signal about whether any
  relevant traffic was occurring at all. If this count never leaves zero
  after a real login, no relevant request is being observed on this tab at
  all (worth checking whether the login flow's account/session-loading
  calls happen on a different tab/subdomain, or before this script was
  injected).
- **The real cause behind "auto/manual login succeeds via the new-tab flow,
  but Build final link from capture still says nothing was captured"
  (v13)**: v10 got the tool running automatically on the *login* page, but
  a successful login is very often a *hard* full-page navigation away from
  it (not an in-place SPA route change) - which instantly destroys that new
  tab's script/panel/Capture instance, with zero chance for it to log
  anything, keep listening, or auto-resume on whatever page loads next. The
  user had to notice this and manually re-click the bookmarklet themselves,
  and any request that fired before they did so was missed regardless of
  v12's persistence (there was nothing to persist yet). The *original* tab
  that opened the login popup is untouched by any of this, so it now keeps
  watching the popup from the outside (`watchForLoginSuccessAndReinject`)
  and, the moment the popup's location moves past the login path with a
  freshly-completed page load and no live panel of its own already there,
  re-injects the tool automatically - restarting passive capture there with
  no user action needed. The re-injected panel also auto-switches to the
  Live Login tab so its status (captured, or the seen-count diagnostic
  above) is immediately visible. If it turns out to have been an SPA route
  change instead (script never actually died), the existing panel there is
  left alone - this only acts when nothing is running to react on its own.
- Behavioral bot-detection (keystroke/mouse timing) on the submit action is
  reduced but not eliminated by the simulated-typing approach — this differs
  from the network/browser-fingerprint-level blocks that stop headless
- **v14 - a manual paste fallback that never depends on the automatic
  capture working at all.** After v13 still didn't resolve a persistent
  "Nothing captured yet." report, the more likely explanation is a
  structural timing race rather than anything the navigation-lifecycle
  fixes above (v10-v13) could address: this tool's `Capture` module patches
  `window.fetch`/`XMLHttpRequest.prototype.*` from a bookmarklet, which by
  definition only runs *after* the page has already loaded and the user has
  clicked it. Many bundled SPAs' own HTTP client code captures a local
  reference to the *native* `fetch` at module-init time (e.g.
  `const _fetch = window.fetch.bind(window)`), which happens within
  milliseconds of page load - long before a human can click a bookmarklet.
  Reassigning `window.fetch` afterwards has no effect on a reference the
  site already captured earlier, so the patch can structurally see **zero**
  matching requests on such a site even though the real headers are being
  sent over the wire the whole time. (`XMLHttpRequest.prototype.open` is
  patched too and may still work if the site calls `xhr.open()` normally
  rather than also caching that reference early - results likely differ by
  brand/bundler.) The Live Login tab now has two plain text inputs to paste
  `stc`/`ctx` values manually - captured via the browser's own DevTools
  Network tab (filter `fe-api`, click any matching request while logged in,
  read `x-sb-static-context-id`/`x-sb-user-context-id` from its Request
  Headers) - which inspects real wire traffic and is unaffected by any of
  the above. "Build final link from capture" uses these manual values
  first if both are filled, falling back to whatever the passive capture
  recorded otherwise. The "Nothing captured yet" message on that button
  also now always includes the concrete `sb/fe-api/*` seen-count, since
  previously it showed an identical generic message regardless of what was
  actually happening, making every prior real-world failure report
  indistinguishable from any other.

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

## Known limitations (Chrome extension)

The extension structurally avoids the capture-timing-race and navigation-
lifecycle issues above (`chrome.webRequest` + `chrome.storage.local`), and
its Credentials vault is shared across all brand domains automatically (no
sync-code step). What still applies, since the DOM-automation code itself
is largely unchanged:

- Auto-login selectors (`LOGIN_SELECTORS` in `extension/content.js`) are
  still experimental/best-effort and brand-markup-dependent, same as the
  bookmarklet — see the bookmarklet notes above for the NordicBet/
  GroupIB submit-detection details, which apply identically here.
- Brand/environment auto-detection (`BRAND_DOMAINS`) and the Argentina-
  brand hostname ambiguity (`betssonarcb`/`btsarba`/`btsarbacity`) are the
  same as the bookmarklet's.
- Chrome only; not published to the Chrome Web Store — unpacked/ZIP
  install only (see "Install (Chrome extension)" above).

