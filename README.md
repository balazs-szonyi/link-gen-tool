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
  a brand site normally, already logged in via your own real session. Also
  offers an "Auto-login" button (simulated typing, not headless automation)
  for brands with a known selector map entry — currently NordicBet and
  Mobilbahis. Unmapped brands still get passive capture; just log in
  manually and the panel picks up the headers automatically.
- **Credentials** tab: manage one or more shared test user/pass pairs,
  stored in a cross-origin vault (`vault.html`, hosted on this same GitHub
  Pages origin) so the same credential works regardless of which brand's
  domain the tool is loaded on. The first credential you ever save becomes
  the default automatically; automation always uses the current default so
  it never blocks waiting for input.

## Install (bookmarklet)

1. Open [the GitHub Pages site](https://balazs-szonyi.github.io/link-gen-tool/)
   once it's deployed.
2. Drag the shown `javascript:...` snippet to your bookmarks bar.
3. On any Betsson brand page, click the bookmark to open the panel.

## Local development

```
node serve.js
```

Serves `link-gen-tool.js` and `vault.html` on `http://localhost:8844`. Use a
bookmarklet pointing at `http://localhost:8844/link-gen-tool.js` while
iterating, then switch back to the GitHub Pages URL once changes are pushed.

## Why a vault iframe for credentials?

`localStorage` is origin-scoped, so a credential saved while the panel is
open on `nordicbet.com` would not be visible on `mobilbahis.com`. The vault
is a hidden `<iframe>` that always points at this tool's own GitHub Pages
origin (same origin no matter which brand page embeds it), and the panel
talks to it via `postMessage`. This is the same "cross-origin storage relay"
pattern used by ad-tech ID-sync iframes.

## Known limitations

- Auto-login selectors are only defined for brands that have been manually
  reverse-engineered so far (see `LOGIN_SELECTORS` in `link-gen-tool.js`).
  Adding a new brand means inspecting its login form once (e.g. via
  chrome-devtools MCP) and adding an entry.
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
- The credential vault (`vault.html`) accepts `postMessage` from any origin
  — acceptable for a shared, non-production QA test credential, but do not
  repurpose it to store real/production credentials.
