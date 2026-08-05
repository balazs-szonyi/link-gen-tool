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

## Known limitations

- Auto-login selectors (`LOGIN_SELECTORS` in `link-gen-tool.js`) are
  experimental/best-effort, not verified working. Confirmed issue: NordicBet
  builds its login form with shadow-DOM web components that weren't
  reachable even via a shadow-piercing `querySelector` in testing (2026-08).
  The **passive capture** mechanism (no selectors needed) is what's actually
  validated and reliable — auto-login is a bonus that may or may not work
  per brand; log in manually when it doesn't.
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
