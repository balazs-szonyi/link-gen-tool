# Link Gen Tool

Internal Manifest V3 Chrome extension for generating environment-correct Betsson sportsbook QA links and capturing live-login context.

## Features

- Generate desktop/mobile test, QA, alpha and production links for supported brands, including dedicated `betsson.co` contexts.
- Show local developer links in a detachable, minimizable desktop-only panel.
- Capture live `stc`/`ctx` context at the network layer.
- Apply tab-scoped Bundle, BLE Data, BLE CORS, Embed, Sportradar and Oddin overrides.
- Detect runtime layers per frame and document, with stale-navigation protection.
- Keep temporary state in `chrome.storage.session`; existing credentials and settings remain unchanged.

## Install

1. Download the latest ZIP from the [extension release](https://github.com/balazs-szonyi/link-gen-tool/releases/tag/extension-latest).
2. Extract it.
3. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the extracted `extension` directory.
4. Click the toolbar icon on a supported brand or playground page.

## Development

```powershell
npm test
node --test test/worker-state.test.cjs
```

The GitHub Pages site publishes only the extension download page. `sync-onedrive.ps1` mirrors the unpacked extension to both Chrome-loaded OneDrive copies and verifies recursive hashes.

## Architecture

- Service-worker listeners register synchronously and use one response-safe async dispatcher.
- DNR live session rules are authoritative; per-tab intent, target environment, scope and diagnostics are versioned in session storage.
- Apply operations record intent before mutation, allocate IDs under one short serialized DNR section, swap rules atomically, and clean interrupted state without replay.
- Indexer data uses CacheStorage with a five-minute TTL; network/cache errors cannot become false success or false inactive states.
- Debugger ownership is validated by an actual CDP command, and runtime enrichment carries tab/frame/document generations.
