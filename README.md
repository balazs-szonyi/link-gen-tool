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
- **Oddin Statistics fix** (Chrome extension only, enabled by default):
  allows the known Firestorm Oddin statistics iframe to render on the generic
  `d-cf`/`m-cf` TEST and QA `sbplayground1.net` hosts. It changes only the
  `Referer` of the exact `disir.oddin.gg` sub-frame carrying Firestorm's known
  Oddin `brandToken`, first to the allowed ALPHA playground and, on a 403,
  once to PROD before reloading only that iframe. PROD and ALPHA playgrounds,
  other Oddin tokens/providers, API/CDN traffic, `Origin`, and CORS responses
  are untouched. This is a separate, Firestorm-only fix from the broader
  Sportradar Statistics Origin/Referer + CORS option next to it.
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
- **Bundle** tab (Chrome extension only): pins the current tab's sportsbook
  JS bundle (`main-*.js` and any other entry files listed by the target
  indexer) to an explicitly selected environment. The target defaults to
  the page's own environment, so opening `alpha.<brand>/sportsbook` and
  clicking **Apply** guarantees that the ALPHA indexer's bundle is used even
  when the brand host is misconfigured to serve a PROD artifact. The other
  same-layer environment remains selectable for deliberate QA↔TEST or
  ALPHA↔PROD override testing. Apply installs tab-scoped rules and then
  automatically reloads the page. Ports the mechanism of the separate,
  standalone "Sportsbook Bundle Override Tool"
  (`BetssonGroup/sb-bundle-override-tool`) directly into this extension so
  you don't need to load a second extension side by side.
  If the two environments in a layer expose different bundle entrypoints,
  source-only files are redirected to an inert extension script so code from
  both builds cannot execute in a mixed state. The matching ClientConfig
  request is pinned to the same target environment as the JavaScript bundle,
  preventing a valid ALPHA bundle from falling back to a failing PROD config.
  For ALPHA/TEST targets it also publishes the MAIN-world
  `xSbIsMfeOverrideApplied` compatibility flag used by the QA Sportsbook Tool,
  so that tool reports the effective overridden environment instead of the
  unchanged PROD/QA startup-context metadata; Disable removes the flag again.
  Auto-detects brand/environment from the page you're currently on and only
  offers targets from the same layer (mixing QA/TEST with ALPHA/PROD loads a
  broken build with no explicit error, so this isn't selectable). Scoped to
  the one tab you click Apply in via a
  session-only `declarativeNetRequest` rule — never affects any other
  tab or site, and is cleared automatically when that tab closes or you
  click Disable. **Does not work on standalone sandbox links** (the
  tool's own "Generate" tab output opened directly, not embedded in a
  real brand page) — on that link shape, `/assets/main-<hash>.js` IS the
  entire self-contained app, not a separately-loadable widget, so there
  is no equivalent bundle in another environment to redirect it to; an
  earlier attempt to support this (a "Device" select redirecting to
  indexer.json's widget-only build) silently produced a completely blank
  page instead, since the browser executed the wrong (incompatible)
  bundle as the page's own top-level entry script. The Bundle tab now
  detects this case from the page's hostname and shows a clear warning,
  blocking Apply instead of corrupting the page — to actually override a
  bundle, apply it on the brand's real domain page instead. See "Bundle
  override" in `extension/background.js` for the implementation, or the
  `sb-bundle-override-tool` skill's `REFERENCE.md` for the original
  tool's own documentation.
- **BLE Data** tab (Chrome extension only): gets you **fresh, live BLE
  event data on ANY tab** — a real brand page (`test.nordicbet.com`,
  `qa.nordicbet.com`, ...) or a standalone sandbox link — independent of
  and freely combinable with the Bundle tab above. Solves the
  "22-es csapda" catch-22: Bundle Override only works on real brand
  pages, while the classic `bleSource=1` query flag only works on the
  tool's own sandbox links (a real brand page ignores it entirely,
  since it always talks to its own native BDE/TEST-QA backend
  regardless of the URL). This tab reimplements the *effect* of
  `bleSource` at the network layer instead of relying on the page's own
  native handling of that flag, so it works on any page:
  it redirects the current tab's `/api/sb/v1/*` REST calls
  (`event-market`, `event-page-schema`, `widgets/view`,
  `competitions/liveEvents`, ...) to the brand's **ALPHA** host, and
  rewrites the `x-sb-static-context-id` / `x-sb-user-context-id` request
  headers on those redirected calls to a fresh, ALPHA-valid context
  minted from PROD (the same mechanism the Generate/Live Login tabs'
  existing BLE-source option already uses) — both via a tab-scoped,
  session-only `declarativeNetRequest` rule pair, cleared automatically
  on navigation or tab close, exactly like the Bundle tab. Because
  `competitions/liveEvents` is included, the page's own live-event list
  becomes populated with real ALPHA events automatically — just Apply,
  reload, and browse; no need to hand-craft a URL with an
  alpha/prod-borrowed `eventId`. **Pick the Desktop/Mobile option
  matching how the current page actually renders** — desktop and mobile
  contexts are genuinely different backend registrations, and mixing
  them can subtly break things (same reasoning as the Live Login tab's
  desktop/mobile split, see "Known limitations" below). **Known gap**:
  the Match/Visual/Statistics tabs and the interactive pitch tracker use
  a *separate* realtime channel that this override doesn't touch — see
  the `sbplayground-link-generator` skill's `REFERENCE.md` for that
  limitation's own detail. **Practical combined workflow** (the actual
  scenario this tab was built for): TEST env is down → open a QA brand
  page → Bundle tab: Apply QA→TEST (to run TEST's own build against QA
  infrastructure) → BLE Data tab: Apply (for fresh, live events instead
  of QA's own stale/synthetic BDE catalogue) → reload once, both
  overrides are active together.
- **Bonus Mock** tab (Chrome extension only): selects and validates a full
  sportsbook bonus-response JSON fixture, shows its filename, bonus count,
  and feature distribution, then locally replaces matching GET fetch/XHR
  BSS responses or converts the fixture to the `BonusWidget` response used by
  `/widgets/globalbonuses/v1` and `/widgets/bonuses/v1`. **Apply** is
  scoped by `sessionStorage` to the current tab and origin; unrelated
  endpoints and non-matching schemas pass through untouched. By default it
  moves only bonus `expiryDate` values to
  `2050-12-31T23:59:59.000Z`; clear the checkbox to preserve fixture dates.
  **Stop** deletes the mock and reloads the page so native responses resume.
  The implementation uses the existing `document_start` MAIN-world
  fetch/XHR layer and does not hold a `chrome.debugger` connection, so it
  adds no persistent Chrome debugging infobar. The companion Codex
  `sportsbook-bonus-override` skill carries the canonical MAPP-11252
  40-bonus fixture plus a Playwright adapter for automated tests. This is
  response substitution only: it never creates, activates, assigns, or
  wagers with a real bonus.
- **Automatic brand/layer detection header** (Chrome extension only, always
  visible above the tabs): shows one row per **brand + runtime layer +
  device** combination actually detected on the current tab, across every
  frame, not a single tab-wide guess. A brand's page may run an MFE
  widget, an iframe/OBGA embed, and a NodeJS integration at once, or the
  same layer in two different frames (e.g. desktop MFE plus a mobile
  iframe test harness) — each gets its own row, e.g.:
  - `Firestorm · MFE: v8.2.3.4918-re0ade7b / QA (desktop) — Confirmed`
  - `Betsson · iframe: v8.1.15.4896-hc2cb4ed / QA (mobile) — Confirmed`
  - `NordicBet · NodeJS: v8.2.1.4910-h96b2913 / QA — Partially verified`

  There is no manual verification step any more — the previous **"Verify
  with page state"** button (which read `window.xSbState`) has been
  removed entirely; `xSbState` is never used as a version or environment
  source. Detection is fully automatic and layered:
  - **Runtime layer markers**, read via a `document_idle` MAIN-world
    content script running in every frame: `window.sbMfeStartupContext` /
    `sbXpSportsbookAppVersion` for the MFE layer,
    `window.obgClientEnvironmentConfig.startupContext` for the
    iframe/OBGA layer, `window.nodeContext` for the NodeJS layer. Each
    marker supplies that layer's brandId/brandName, version, and (where
    available) environment.
  - **Independent network confirmation** per layer/frame: the MFE
    layer's own dist-bundle request, the iframe/OBGA layer's config
    request (URL brand/facade/version-family plus the `x-sb-app-version`
    response header — used only as a version source, never as an
    environment source, since the API host serving it can differ from
    the artifact's own environment), and the NodeJS layer's frame
    navigation hostname. Brand resolution always follows the same
    priority chain — runtime marker brand → config-URL brand → MFE
    bundle-URL brand → hostname mapping as a last resort only — and every
    network match is scoped to the one brandId+device it actually named,
    so a chunk hash or version shared across brands can never produce a
    cross-brand match.
  - `bleSource=1` requests to an ALPHA/PROD backend are excluded
    entirely from the bundle-environment computation (they exist only to
    let a QA/TEST-bundle page reach a shared ALPHA/PROD backend, and do
    not reflect the bundle's own environment).

  Each row is classified independently:
  - **Confirmed** — the runtime marker and the network evidence agree on
    brand, version, and environment.
  - **Partially verified** — the layer is recognized (a runtime marker
    exists) but at least one value (version or environment) only has a
    single reliable source. The row's detail line spells out exactly
    which piece of evidence is still missing (e.g. "no network
    confirmation seen for this layer yet", "runtime marker has no
    environment") instead of leaving a user to guess — most commonly
    this self-resolves a few seconds after page load, once the network
    side catches up with the runtime marker.
  - **Mismatch** — the runtime marker and network evidence for the same
    brand+layer disagree; the conflicting values are shown inline (e.g.
    `version: runtime=v8.2.3.4918-re0ade7b vs network=v8.1.15.4896-hc2cb4ed`).
  - **Unclassified SB build** — a network hit with no runtime marker at
    all in that frame; the brand is still shown if resolvable, but no
    layer is guessed.

  Two Confirmed rows in the *same frame* are not always two independent
  integrations: some brands genuinely run a hybrid runtime (e.g. an MFE
  widget layered on top of the legacy Fabric/OBGA runtime, which still
  populates its own `obgClientEnvironmentConfig` for backward
  compatibility). When two layers in one frame are both Confirmed on the
  exact same brand+version+environment+device, each row's detail line
  calls out its sibling explicitly (e.g. `Same brand+version+environment
  as the "iframe" row in this frame — likely one hybrid runtime exposing
  both markers, not two independent layers.`) so this isn't mistaken for
  a detection bug — both rows still stay separate, since each has its
  own genuine, independent evidence.

  A generic host with no brand in its own hostname (e.g.
  `d-cf.qa.sbplayground1.net`) is resolved purely from whichever
  brandId the frame's own config/network request actually carried —
  never guessed from the hostname.


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
   the same Generate / Live Login / Credentials tabs as the bookmarklet,
   plus an extension-only fourth **Bundle** tab (see "What it does"
   above).

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

## Manual live smoke test / regression (brand/layer detection)

The automated suite (`npm test`, `npm run test:bonus`, `npm run
test:bet-void`, `npm run test:layer-detection`) only exercises the
detection engine's classification logic against mocked/offline fixtures
— it deliberately never talks to a real brand or QA-sandbox host. Before
shipping a change to the detection engine
(`background.js`'s `computeDetectionRows`/`runtimeMarkersByTab`/
`networkByTab`, or `layer-detect.js`/`layer-relay.js`), also run this
manual pass:

1. Load the built extension (`extension/`, or the OneDrive-synced copy)
   in Chrome and open the panel on a real or QA brand page.
2. Confirm the automatic header populates within a few seconds with **no**
   manual button click — one row per brand+layer+device combination
   actually present on that page.
3. Cross-check against `BRAND_LAYER_MATRIX.md` for that brand — if the
   matrix already has a row for it, the newly observed layer/version/
   environment/status should match; if it doesn't yet, add a new row (see
   that file for the procedure).
4. Specifically verify, using whichever brands/pages are available to
   you:
   - Two brands with different indexer versions each resolve to their
     OWN brandId (never a value from the other brand or environment).
   - A page with both MFE and iframe layers active shows two independent
     rows, each with its own status.
   - Desktop and mobile are reported as separate rows/devices, never
     merged into one.
   - A QA-bundle page whose request happens to carry `bleSource=1` to an
     ALPHA/PROD backend still reports as QA (the ALPHA/PROD backend
     request itself is excluded from the environment computation).
   - Forcing a brand/version/environment mismatch (e.g. via the Bundle
     Override tab) produces a **Mismatch** row with the conflicting
     values shown inline, not a false Confirmed.
   - A generic host with no brand in its own hostname (e.g.
     `d-cf.qa.sbplayground1.net`) still resolves the correct brand, taken
     from that frame's own config request.

This list intentionally has no fixed URL — see `BRAND_LAYER_MATRIX.md`
for how to pick a brand/page and record the result.

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

### Experimental Cross-Layer runtime (v1.20.6)

Cross-layer hybrid mode now runs directly in the current normal Chrome tab.
There is no CLI, token, Playwright browser, separate profile, or manual binding.
The extension installs its MAIN-world request/config adapter at document start,
before the sportsbook runtime captures `fetch` or `XMLHttpRequest`.
Target ClientConfig requests are also pinned in the tab-scoped network layer,
with a path- and brand-scoped CORS response-header rule. This covers runtimes
that capture a native HTTP function before an in-page adapter can replace it.

Betsson and NordicBet can opt into cross-layer testing from the Bundle tab.
Select `hybrid`, the target bundle and device, then Apply. The tab displays
`Host`, `Bundle`, and `Backend` separately;
this is the primary environment diagnostic for cross-layer runs. `hybrid` keeps
the page backend while loading the target bundle. `full-runtime` is disabled
until target static/user-context bootstrap is available extension-native.
Bundle Apply preserves the current link and adds
`exposeObgState=true&exposeObgRt=true&sealStore=false` before reloading, so
the runtime diagnostics remain available on the resulting page. When a BLE
host's SSR markup is combined with a BDE target bundle, the runtime also sets
`expose-obg-state="true"` before the target custom element's first lifecycle
callback; this prevents the target component from sealing its state before it
can observe the diagnostic query flag.
For Sportsbook Tool v1.6.166 compatibility, cross-layer mode supplies the
selected bundle environment only during the tool script's synchronous startup
calculation, then immediately restores the page's real startup context. This
prevents PROD-host/TEST-bundle runs from being mislabeled as ALPHA.

For the reverse BDE-bundle to BLE-backend direction, the tab-scoped adapter
maps BDE's additional read-only `static-context` GET to BLE's supported
`user-context` GET. The original context headers and identifiers are retained;
mutating requests are not part of this translation.

When a target ClientConfig contains an absolute environment-specific SSTP
health URL, hybrid mode grants the page's exact origin CORS access only to the
target's `GET /sstp/healthy` response. The rule is tab-scoped and deliberately
excludes every other SSTP route and every mutating method.

PROD place-bet is fail-closed in extension-only cross-layer mode. It is never
submitted automatically.

Run the offline contract/safety suite with `npm test`; the parameterized live
normal-Chrome smoke remains in `cross-layer-lab/test-live-cross-layer.cjs`.
Run the Oddin extension smoke with a current Firestorm TEST/QA direct-event
link whose Statistics tab is available:

```powershell
node test-oddin-extension-smoke.cjs "https://d-cf.test.sbplayground1.net/<stc>/<ctx>/<event-route>?bleSource=1"
```

If that live event ended before the run, `LGT_ODDIN_PROBE_URL` may point to a
previously verified full `disir.oddin.gg` match URL. The smoke then attaches
that real provider URL as a sub-frame from the Firestorm page; no provider
response is mocked. It asserts the exact DNR scope, first-request ALPHA
`Referer`, HTTP 200, rendered iframe content, and absence of a fallback loop.

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
- **Bundle tab**: standard mode works within the same environment layer
  (QA↔TEST or ALPHA↔PROD); hybrid mode additionally offers cross-layer target
  bundles while keeping the page backend. It defaults to the current page
  environment for safe pinning. Only works on a real
  brand-embedded page (the widget's `/dist/.../desktop|mobile/files/...`
  bundle shape) — it structurally cannot work on the tool's own
  standalone sandbox links (see the Bundle tab description above for
  why); Apply is blocked with a clear warning on those links instead of
  silently corrupting the page (fixed after a real "Apply → Reload →
  blank white page" bug report on a sandbox link — a previous "Device
  select" attempt to support this case is now removed entirely, since
  indexer.json has no equivalent standalone-app build to redirect a
  sandbox link's bundle to). If the standalone "Sportsbook
  Bundle Override Tool" extension is also loaded, avoid enabling both at
  the same time on the same tab/site — both extensions register their
  own `declarativeNetRequest` rules for the same bundle URLs, and running
  both simultaneously is untested and could produce confusing, order-
  dependent redirect behavior. Apply automatically reloads the same page
  after the rules are installed, because a `declarativeNetRequest` rule only
  affects requests made *after* registration, not ones already in flight or
  already rendered. Since 1.15.0, the override is also automatically cleared the
  moment you navigate that same tab away to a genuinely different link
  (`chrome.webNavigation.onBeforeNavigate`, fires before the new page's
  own first request) — before this fix, an override applied once silently
  kept redirecting the bundle on ANY later, unrelated navigation in that
  tab, which could make an otherwise-fine link fail to load at all (a
  mismatched env/version combination can break the app outright, not just
  show a stale version label). A same-URL reload (F5) is unaffected and
  still correctly preserves the override, including the automatic reload
  triggered by Apply.
- **BLE Data tab**: requires a page reload after Apply, same reason as
  the Bundle tab (`declarativeNetRequest` only affects requests made
  after registration). Cleared automatically on navigation to a
  genuinely different link or on tab close, same mechanism as the
  Bundle tab. Freely combinable with the Bundle tab on the same tab —
  they touch entirely disjoint URL patterns (`/api/sb/v1/*` vs the
  sportsbook JS bundle files) and don't interfere with each other.
  Does **not** fix the separate, unrelated Match/Visual/Statistics-tab
  gap (documented in the `sbplayground-link-generator` skill's
  `REFERENCE.md`) — that data comes from a different realtime channel
  this override doesn't touch. Mismatching the Desktop/Mobile selection
  against how the page actually renders can subtly break things, since
  desktop/mobile BLE contexts are genuinely different backend
  registrations (same reasoning as the Live Login tab's device split).
- **Automatic brand/layer detection header**: each row only appears once
  that frame has actually produced runtime-marker and/or network
  evidence — a lobby-only or non-sportsbook tab simply shows no rows
  ("Detecting sportsbook runtime layers…"), which is expected, not a bug.
  Runtime markers are read by a `document_idle`, `all_frames:true`
  MAIN-world content script (`layer-detect.js`) that polls for up to ~20s
  after each frame loads, then stops — this keeps it cheap on the
  `<all_urls>` pages it necessarily also runs on (an isolated-world relay,
  `layer-relay.js`, forwards whatever it finds to the background service
  worker via `chrome.runtime.sendMessage`; content scripts cannot call
  extension APIs directly from the MAIN world). Network evidence is
  collected per tab+frame+layer in `background.js` from the existing
  `onBeforeRequest`/`onHeadersReceived`/`webNavigation` listeners, and is
  cleared per-frame on that frame's own next navigation (a top-level
  navigation clears the whole tab, since all of its subframes are about
  to be torn down anyway). Since 1.22.6 there is no manual verification
  step: the previous **"Verify with page state"** button and its
  `window.xSbState` read via `chrome.scripting.executeScript({world:
  'MAIN'})` have been removed entirely — `xSbState` is explicitly never
  used as a version/environment source by the new engine, matching the
  behavior above.
- **Automatic brand/layer detection header background polling**: polls
  `background.js` on a 3s timer for as long as the panel is open, using
  the same `pollWhileExtensionValid` (`content.js`, since 1.11.1) belt-
  and-braces handling for a stale `chrome.runtime` reference after an
  extension reload/update (e.g. a dev `chrome://extensions` reload, or a
  background auto-update) as the Bundle tab's own poller — both silently
  stop polling instead of throwing an uncatchable "Extension context
  invalidated" error every 3 seconds forever. If you ever see this error
  logged repeatedly in `chrome://extensions` → "Errors", just reload the
  affected tab(s) — it only means the extension was reloaded while they
  were open, it is not a sign of a data/functionality problem.

