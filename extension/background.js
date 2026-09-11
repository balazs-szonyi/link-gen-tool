/*
 * Link Gen Tool extension - background service worker.
 *
 * Captures x-sb-static-context-id / x-sb-user-context-id headers via
 * chrome.webRequest.onSendHeaders - a NETWORK-LAYER observation, entirely
 * independent of page JS timing. This closes the root cause behind the
 * legacy page-injected script's flaky passive capture: a bundled SPA that grabs a reference
 * to the native `fetch` at its own module-init time (milliseconds after
 * page load, before any legacy page-injected script click is even possible) makes an
 * in-page fetch/XHR monkey-patch structurally blind to that traffic -
 * reassigning window.fetch afterwards has zero effect on an already-
 * captured reference. chrome.webRequest sees the real request on the wire
 * regardless of any of that, the same class of technique the project's
 * original Playwright-based reference implementation (live-login-poc.mjs)
 * used to first verify this capture mechanism works at all.
 *
 * Captured state is written directly to chrome.storage.local (not held in
 * this service worker's own memory, which Chrome can terminate/restart at
 * any time under MV3) keyed per page origin - so it also survives a hard
 * full-page navigation with zero sessionStorage-breadcrumb / window.open /
 * re-injection machinery of any kind, unlike the legacy page-injected script's v10-v13
 * fixes for the same problem class.
 */
'use strict';

importScripts('worker-state.js', 'detection-state.js', 'debugger-session.js', 'oddin-fix.js');
var workerStore = LgtWorkerState.createStore(chrome);
var dnr = LgtWorkerState.createDnr(chrome, workerStore);
var detection = LgtDetectionState.create(workerStore);
var debuggerSession = LgtDebuggerSession.create(chrome, workerStore);
var handleMessage = LgtWorkerState.createDispatcher(chrome);
var observeTask = LgtWorkerState.observe;
var navigationTasks = LgtWorkerState.createLatestTasks();
function chromeCall(owner, method, ...args) { return LgtWorkerState.call(chrome, owner, method, ...args); }
function senderTabId(sender) {
  if (sender.tab?.id == null) throw new Error('no tab');
  return sender.tab.id;
}
var oddinFix = LgtOddinFix.install(chrome, { dnr: dnr, store: workerStore });

var CAPTURE_PREFIX = 'lgtCapture:';

function captureKeyFor(origin) {
  return CAPTURE_PREFIX + origin;
}

function originFromDetails(details) {
  if (details.initiator) return details.initiator;
  try { return new URL(details.url).origin; } catch (e) { return null; }
}

chrome.webRequest.onSendHeaders.addListener(
  function (details) {
    if (!/sb\/fe-api\//.test(details.url || '')) return;
    var origin = originFromDetails(details);
    if (!origin) return;

    var headers = {};
    (details.requestHeaders || []).forEach(function (h) {
      headers[String(h.name || '').toLowerCase()] = h.value;
    });
    var stc = headers['x-sb-static-context-id'];
    var ctx = headers['x-sb-user-context-id'];

    var key = captureKeyFor(origin);
    void observeTask(workerStore.serialize('capture:' + origin, async () => {
      const res = await chromeCall(chrome.storage.local, 'get', key);
      const entry = res[key] || { stc: null, ctx: null, source: null, seenCount: 0 };
      entry.seenCount = (entry.seenCount || 0) + 1;
      if (stc && ctx) { entry.stc = stc; entry.ctx = ctx; entry.source = details.url; }
      await chromeCall(chrome.storage.local, 'set', { [key]: entry });
    }), 'capture headers');
  },
  { urls: ['*://*/*sb/fe-api/*'] },
  ['requestHeaders', 'extraHeaders']
);

// ---------------------------------------------------------------------
// Trusted input for auto-login, via chrome.debugger (CDP Input domain).
//
// Why this exists: some brands' login submit buttons check
// `event.isTrusted` (or equivalent framework-level "was this a real user
// gesture" heuristics) and silently ignore a content script's synthetic
// dispatchEvent()/click() - a genuine, unavoidable limitation of DOM-level
// simulation (this affected both the legacy page-injected script and this extension's
// content.js equally, since content scripts run in the same "not a real
// user" trust tier no matter how they're delivered). chrome.debugger is
// different: it's a background-service-worker-only API (content scripts
// cannot call it) that attaches Chrome DevTools Protocol to the tab and
// injects input via the same Input.dispatchMouseEvent/dispatchKeyEvent
// pipeline real DevTools/Playwright use - indistinguishable from a real
// user to the page, so isTrusted-gated handlers fire normally. This is
// the one "not the legacy page-injected script anymore" capability that actually matters
// here.
//
// Trade-off: attaching shows Chrome's built-in "<name> started debugging
// this browser" infobar for the few hundred ms the sequence takes, then
// auto-dismisses on detach. There's no way to suppress that banner - it's
// a Chrome-level anti-abuse indicator, not something this extension
// controls.
// ---------------------------------------------------------------------

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function sendDebuggerCommand(tabId, method, params) { return debuggerSession.command(tabId, method, params); }





async function trustedClick(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

// 'rawKeyDown' (not 'keyDown') for the down-event is deliberate: CDP's
// 'keyDown' type ALSO performs character insertion when a `text` payload
// is set, so pairing it with a following 'char' event (which inserts the
// same character again) silently double-types every character - this was
// a real, previously-undetected bug here: credentials were typed as e.g.
// "tteesstteerr@@..." instead of "tester@...", so the real site correctly
// rejected the (garbled) login while every local fixture test - which
// only checked the fields were non-empty, not their exact value - kept
// passing. 'rawKeyDown' dispatches the physical key-down without
// inserting anything, leaving the 'char' event as the single source of
// the actual character insertion (the CDP-documented pattern for typing).
async function trustedType(send, text) {
  for (const ch of String(text || '')) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', text: ch, unmodifiedText: ch, key: ch });
    await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch, key: ch });
    await sleep(10 + Math.random() * 25);
  }
}

// Named (non-character) keys - Tab to blur a field and let any on-blur
// validation/debounce run, Enter as a submit fallback that doesn't
// depend on locating the right button at all (most login forms submit
// their enclosing <form> on Enter inside a text/password field).
//
// Enter needs `type: 'keyDown'` plus a `text`/`unmodifiedText` of '\r'
// (not the char-less 'rawKeyDown' used for e.g. Tab) - that's what
// actually drives Blink's native "Enter submits the form" default
// action; a bare rawKeyDown with no text is a real keypress but doesn't
// reliably trigger implicit form submission the way a genuine keyboard
// Enter (or Playwright's own page.keyboard.press('Enter')) does.
var NAMED_KEYS = {
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, downType: 'rawKeyDown' },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r', downType: 'keyDown' }
};

async function trustedKey(send, keyName) {
  const key = NAMED_KEYS[keyName];
  if (!key) return;
  const { downType, ...payload } = key;
  await send('Input.dispatchKeyEvent', { type: downType || 'rawKeyDown', ...payload });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...payload });
}

// Tabs whose debugger/focus-emulation is being held attached for an
// entire silent-job lifetime (see lgt-debugger-keepalive-start/stop
// below) - runTrustedSequence must neither re-attach (attach() on an
// already-attached-by-us tab is a needless extra round trip and, on some
// Chrome builds, briefly re-flashes the "started debugging" infobar) nor
// detach when it's done (that would tear down the very focus-emulation
// the keepalive call was meant to hold for the WHOLE job, not just one
// click/type sequence).





async function runTrustedSequence(tabId, actions) {
  try {
    await debuggerSession.withSession(tabId, async send => {
      for (const action of actions) {
        if (action.type === 'click') await trustedClick(send, action.x, action.y);
        if (action.type === 'type') await trustedType(send, action.text);
        if (action.type === 'key') await trustedKey(send, action.key);
        await sleep(action.delayAfter || 80);
      }
    });
    return { ok: true };
  } catch (error) { return { ok: false, error: String(error.message || error) }; }
}

// Item (2026-08-07, second follow-up): the 0a race-condition fix above
// (Emulation.setFocusEmulationEnabled + Page.setWebLifecycleState) was
// only ever applied for the brief attachDebugger/detachDebugger window
// around the ACTUAL trusted click/type sequence - not during the much
// longer waitForUsernameFieldOrAlreadyLoggedIn / awaitCapture polling
// that happens before and after it. User-confirmed 2026-08-07: an
// entirely silent (minimized-window) live-login job simply never
// progresses at all - not just slowly - until the window is manually
// clicked/focused, exactly the un-fixed 0a symptom, just relocated to a
// different phase of the flow than the one the original fix covered.
// content.js's resumeLiveLoginJobIfPending now calls
// lgt-debugger-keepalive-start right when a SILENT job begins (before
// any polling starts) and lgt-debugger-keepalive-stop once the job
// settles (success or failure alike, every exit path) - holding the
// focus-emulated/active state for the polling phases too, not just the
// type/click moment.
handleMessage('lgt-debugger-keepalive-start', async function (msg, sender) {
  await debuggerSession.hold(senderTabId(sender));
  return { ok: true };
});

handleMessage('lgt-debugger-keepalive-stop', async function (msg, sender) {
  await debuggerSession.release(senderTabId(sender));
  return { ok: true };
});


handleMessage('lgt-trusted-sequence', async function (msg, sender) {
  return runTrustedSequence(senderTabId(sender), msg.actions || []);
});

// Opens/closes the background (inactive) tab used for the Generate tab's
// auto live-login flow (see content.js's startLiveLoginJob /
// resumeLiveLoginJobIfPending) - chrome.tabs is only callable from the
// service worker, not a content script, hence these two small relays.
// Keep-alive ping for the live-login flow (see content.js's KeepAlive
// helper for the full rationale) - a trivial round-trip whose only
// purpose is to be a genuine wake/activity event for this MV3 service
// worker, so it doesn't idle-terminate mid-login and miss the
// chrome.webRequest.onSendHeaders event(s) that the whole capture
// mechanism depends on.
handleMessage('lgt-keepalive', async function (msg, sender) {
  return { ok: true };
});

// ---------------------------------------------------------------------
// Mobile device emulation for the Live-Login+BLE capture flow.
//
// Root cause (confirmed 2026-08-07, user-diagnosed): the addon's Live
// Login flow ran exactly ONE real login (always in a normal/desktop-
// shaped tab) and spliced that ONE captured stc/ctx into BOTH the
// desktop and mobile generated links. But a real login on the brand's
// live site captures a DEVICE-SCOPED context - logging in from a mobile
// viewport yields a genuinely different stc/ctx than a desktop viewport
// (confirmed directly: manually capturing stc/ctx from nordicbet.com in
// a real mobile viewport gave a different pair than the addon's
// desktop-captured one, and splicing that manually-mobile-captured pair
// into the same link template worked, while the desktop-captured pair
// reused for the mobile link broke it - CORS net::ERR_FAILED on the
// alpha-routed competitions call, or no request firing at all). Fix:
// run the whole login flow TWICE, once per device, with CDP-level
// device emulation active for the mobile pass BEFORE the target URL
// even starts loading (so the brand's real site serves its actual
// mobile frontend/build from the very first request, not just a
// resized desktop one) - see setupMobileEmulation below, and
// content.js's runLiveLoginFallback/captureForDevice for the
// orchestration of two sequential capture jobs.
// ---------------------------------------------------------------------

var MOBILE_EMULATION_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
var MOBILE_EMULATION_UA_METADATA = {
  platform: 'Android',
  platformVersion: '14.0.0',
  architecture: '',
  model: 'Pixel 8',
  mobile: true
};

// Attaches the debugger, switches the tab to a mobile viewport/UA/touch
// profile via CDP, then navigates it to the real target URL - all BEFORE
// any page load happens, so the brand's site sees "mobile" from its very
// first request rather than a desktop page that merely gets resized
// afterward. Records the tab in chrome.storage.session (same bookkeeping the
// silent-job keepalive mechanism already uses) so content.js's later
// lgt-debugger-keepalive-start call (sent once its own content script
// loads) is recognized as already-held and skips re-attaching, and so
// the existing lgt-debugger-keepalive-stop call (sent when the job
// settles, success or failure) correctly detaches it at the end.
async function setupMobileEmulation(tabId, url) {
  await debuggerSession.withSession(tabId, async send => {
    await send('Emulation.setDeviceMetricsOverride', { width: 470, height: 944, deviceScaleFactor: 2, mobile: true });
    try { await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); } catch (_) { /* best effort */ }
    await send('Network.enable', {});
    await send('Network.setUserAgentOverride', { userAgent: MOBILE_EMULATION_UA, platform: 'Android', userAgentMetadata: MOBILE_EMULATION_UA_METADATA });
    // Persist the held lease before navigation can start content-script polling.
    await workerStore.update('debugger', tabId, () => ({ held: true }));
    await chromeCall(chrome.tabs, 'update', tabId, { url: url });
  }, true);
}

// Tracks, per job (background/login/passive-capture) tab id, which tab &
// window originally started it - i.e. the tab hosting the Generate panel
// itself. Needed so lgt-close-tab can reliably jump focus back to THAT
// tab once the job finishes, instead of relying on Chrome's own "which
// tab becomes active when this one closes" heuristic - confirmed
// 2026-09-10 that heuristic is not the origin tab whenever the origin
// tab isn't also the most-recently-opened one (e.g. the user had several
// tabs open and the Generate tab wasn't the last one focused before the
// job's tab was created) - Chrome then reactivates whatever tab it thinks
// is next in its own MRU/index order, not the actual opener. Persisted in
// chrome.storage.local (not a plain in-memory map) for the same reason
// captured header state is - an MV3 service worker can be
// terminated/restarted mid-flight, which would otherwise silently drop
// the mapping.

async function rememberJobOrigin(jobTabId, originTabId, originWindowId) {
  if (jobTabId == null || originTabId == null) return;
  await workerStore.update('jobOrigin', jobTabId, () => ({ tabId: originTabId, windowId: originWindowId }));
}

// Reads back and removes (one-shot) the origin entry for a job tab.
async function takeJobOrigin(jobTabId) {
  let origin = null;
  await workerStore.update('jobOrigin', jobTabId, value => { origin = value; return null; });
  return origin;
}

// active:false keeps the tab out of the user's way for its whole (short)
// lifetime; it closes itself via lgt-close-tab once its job settles
// (success or failure alike - there's no reason to leave an inactive tab
// open either way).
handleMessage('lgt-open-tab', async function (msg, sender) {
  const mobile = msg.device === 'mobile';
  let tab;
  if (msg.active) tab = await chromeCall(chrome.tabs, 'create', { url: 'about:blank', active: true });
  else {
    const win = await chromeCall(chrome.windows, 'create', { url: 'about:blank', focused: false, state: 'minimized' });
    tab = win.tabs?.[0] || (await chromeCall(chrome.tabs, 'query', { windowId: win.id }))[0];
  }
  if (tab?.id == null) throw new Error('tab not created');
  // Save opener before starting navigation; an exceptionally fast capture may
  // finish before the tabs.update callback otherwise.
  await rememberJobOrigin(tab.id, sender.tab?.id, sender.tab?.windowId);
  try {
    if (mobile) await setupMobileEmulation(tab.id, msg.url);
    else await chromeCall(chrome.tabs, 'update', tab.id, { url: msg.url });
    return { ok: true, tabId: tab.id };
  } catch (error) {
    await workerStore.update('jobOrigin', tab.id, () => null);
    throw new Error((mobile ? 'mobile emulation setup failed: ' : '') + error.message);
  }
});

// Item (2026-08-07 follow-up): lets the job tab's OWN content script pull
// itself briefly out of 'minimized' state (without stealing focus) when a
// login modal is taking unusually long to mount - see the "nudge" call
// in content.js's attemptAutoLogin. Restoring 'normal' state clears
// document.visibilityState's 'hidden' flag (restoring full-rate
// requestAnimationFrame) for the duration of the slow-mount retry wait;
// re-minimizing afterward (msg.state === 'minimized') puts it back out of
// sight once that wait resolves either way. Harmless no-op if the tab is
// actually in a visible/active tab already (forceVisible / already-proven
// brand path) - updating an already-normal, unfocused-by-request window's
// state to 'normal' again does nothing.
handleMessage('lgt-window-set-state', async function (msg, sender) {
  const tab = await chromeCall(chrome.tabs, 'get', senderTabId(sender));
  if (tab?.windowId == null) throw new Error('no window');
  await chromeCall(chrome.windows, 'update', tab.windowId, { state: msg.state === 'minimized' ? 'minimized' : 'normal', focused: false });
  return { ok: true };
});

handleMessage('lgt-close-tab', async function (msg, sender) {
  const tabId = senderTabId(sender);
  const origin = await takeJobOrigin(tabId);
  await debuggerSession.release(tabId);
  await chromeCall(chrome.tabs, 'remove', tabId);
  if (origin?.tabId != null) {
    // Closing the origin meanwhile is expected; do not reinterpret a completed
    // capture as a failed login merely because focus cannot be restored.
    try {
      await chromeCall(chrome.tabs, 'update', origin.tabId, { active: true });
      if (origin.windowId != null) {
        const win = await chromeCall(chrome.windows, 'get', origin.windowId);
        await chromeCall(chrome.windows, 'update', origin.windowId, { focused: true, ...(win.state === 'minimized' ? { state: 'normal' } : {}) });
      }
    } catch (error) { console.warn('[link-gen-tool] origin focus unavailable:', error); }
  }
  return { ok: true };
});

// Brings the background tab to the front instead of closing it - used
// when a live-login job fails, so the user can actually see what state
// the real login page was left in (captcha, cookie-consent banner, 2FA
// prompt, unexpected layout, etc.) instead of the tab silently vanishing
// with only a generic error string to go on (added 2026-08-06 after a
// NordicBet failure that couldn't otherwise be diagnosed remotely).
handleMessage('lgt-focus-tab', async function (msg, sender) {
  const tab = await chromeCall(chrome.tabs, 'update', senderTabId(sender), { active: true });
  if (tab?.windowId != null) await chromeCall(chrome.windows, 'update', tab.windowId, { focused: true, state: 'normal', top: 40, left: 40 });
  return { ok: true };
});

// ---------------------------------------------------------------------
// "Embed here" - strips the response headers that block cross-origin
// framing so a generated (often BLE-sourced) playground link can be
// shown inside the CURRENT real brand tab as an iframe, instead of only
// opening in a separate tab.
//
// Why this exists: the standalone playground host (d-cf.{env}.{brand}
// playground.net - the only place bleSource=1 + arbitrary stc/ctx
// actually renders) sends X-Frame-Options: SAMEORIGIN on its responses -
// a hard, browser-enforced anti-framing block confirmed via direct
// response-header inspection. No DOM/CSS/JS trick from a content script
// can work around that.
//
// An earlier version of this feature tried to strip the header via
// chrome.debugger + CDP's Fetch domain (the same mechanism already used
// above for the trusted-click bypass) - that turned out NOT to work:
// Fetch.continueResponse happily reports success and the modified
// headers ARE what a page's own JS would see via fetch()/XHR, but
// Chrome's actual X-Frame-Options/CSP frame-ancestors *enforcement* for
// a navigation happens at a lower layer that CDP's Fetch domain cannot
// override - confirmed by a real-extension test where the header was
// verifiably stripped in the intercepted event yet the iframe still
// landed on chrome-error://chromewebdata/.
//
// declarativeNetRequest's modifyHeaders action, however, operates
// earlier in the network stack (before that enforcement check) and is
// the officially supported MV3 mechanism for this - confirmed working
// via the same real-extension test harness. As a bonus it needs no
// chrome.debugger attach at all, so there's no persistent "started
// debugging this browser" banner for this feature (unlike the
// login-automation trusted-click feature above, which still needs CDP
// for isTrusted input and keeps that trade-off).
//
// The rule is scoped as tightly as possible: session-only (never
// persisted), restricted to sub_frame requests, restricted to the exact
// target origin, and restricted via the `tabIds` condition to the one
// tab the user actually clicked "Embed here" in - it does not affect any
// other tab or any other site.
// ---------------------------------------------------------------------

var EMBED_RULE_ID_START = 900001;

// MV3 service workers are ephemeral - they can be unloaded and restarted
// at any time (e.g. after ~30s idle), which resets any in-memory counter
// back to its starting value. The declarativeNetRequest session rules
// themselves, however, survive that restart (they're only cleared on
// browser restart or extension reload) - so a naive ++counter approach
// WILL eventually collide with an already-registered rule id from a
// previous service-worker lifetime and fail with "Rule with id ... does
// not have a unique ID" (confirmed live 2026-08-07, on the Sportradar-spoof
// rule below). Querying the actually-registered session rules for the
// current max id, instead of trusting any in-memory counter, is immune to
// this regardless of how many times the service worker has restarted.
//
// IMPORTANT (root-caused 2026-08-10, real bug hit combining Bundle
// Override + BLE Data Override on the same tab): `endIdExclusive` is
// REQUIRED and the max-id scan below is restricted to ids already inside
// [startId, endIdExclusive) - it must NOT look at the global max across
// ALL registered rules. Each feature owns a fixed numeric id range (e.g.
// BLE Data 910001-929999, Bundle 930001-949999); if the scan considered
// every rule regardless of range, a feature applied while an EARLIER-
// range feature had only used a couple of ids (e.g. Bundle using just
// 930001-930002) would get its own next id computed from that lower
// max - landing INSIDE the other feature's declared range. That
// mis-allocation broke both features' range-restricted status/stop
// lookups (getOwnSessionRuleIdsForTab) silently: the wrongly-numbered
// rule became invisible to its own feature's status check while a
// DIFFERENT feature's status check (whose range now unintentionally
// covers it) would wrongly claim the rule as its own on next resync.
// Restricting the scan to each feature's own range makes id allocation
// depend only on that feature's own rule count/history, never on
// apply order relative to any other feature.


// Same ephemeral-service-worker problem as above, but for STATUS/STOP
// correctness rather than id allocation: the *-RuleIdsByTab in-memory maps
// (used by the Bundle/BLE Data status+stop handlers) are plain JS
// variables and are wiped on every SW restart, while the actual
// declarativeNetRequest session rules they were tracking are NOT wiped
// (session rules persist across SW restarts within the same browser
// session). Trusting only the memory map after a restart means: (a) the
// status handler wrongly reports "not active" for a rule that is still
// live and still redirecting, and (b) stop/re-apply can leave that live
// rule behind uncleared. Querying the browser's own live rules for the
// tab, filtered to the id range owned by the calling feature, is immune
// to this regardless of how many times the service worker restarted
// between Apply and this call.
async function getOwnSessionRuleIdsForTab(tabId, startId, endIdExclusive) {
  await dnr.ready;
  const rules = await chromeCall(chrome.declarativeNetRequest, 'getSessionRules');
  return rules.filter(rule => rule.id >= startId && rule.id < endIdExclusive && rule.condition?.tabIds?.includes(tabId)).map(rule => rule.id);
}

async function startEmbedRule(tabId, origin) {
  return dnr.apply('embed', tabId, { scope: { kind: 'origin', value: origin } }, async () => allocate => [{
          id: allocate(1)[0],
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [
              { header: 'x-frame-options', operation: 'remove' },
              { header: 'content-security-policy', operation: 'remove' }
            ]
          },
          condition: {
            urlFilter: origin + '/*',
            resourceTypes: ['sub_frame'],
            tabIds: [tabId]
          }
        }]);
}

function stopEmbedRule(tabId) { return dnr.stop('embed', tabId); }

handleMessage('lgt-embed-start', async function (msg, sender) {
  const tabId = senderTabId(sender);
  if (!msg.origin) throw new Error('no origin');
  await startEmbedRule(tabId, msg.origin);
  return { ok: true };
});

handleMessage('lgt-embed-stop', async function (msg, sender) {
  const tabId = senderTabId(sender);
  await stopEmbedRule(tabId);
  return { ok: true };
});

// Safety net - never leave a header-stripping rule behind on a closed or
// navigated-away-from tab (session rules already vanish on browser
// restart, but a long-lived tab reused for other browsing later
// shouldn't keep silently stripping these headers for that origin).
chrome.tabs.onRemoved.addListener(function (tabId) {
  navigationTasks.cancel(tabId);
  dnr.cancelTab(tabId);
  void observeTask((async () => {
    await dnr.dropTab(tabId);
    await debuggerSession.release(tabId);
    await workerStore.dropTab(tabId);
  })(), 'tab cleanup');
});

// ---------------------------------------------------------------------
// Sportradar Origin/Referer spoofing - the Live Match Tracker (and other
// SIR) widgets check the calling page's Origin/Referer against a
// per-brand domain-license list on Sportradar's own server (their
// /{clientId}/licensing endpoint responds {"valid":false,"emsg":"No
// packages licensed for \"<playground host>\""} for any non-whitelisted
// domain, confirmed via direct HTTP testing 2026-08-06). This is a real
// commercial licensing check, not a technical bug or a browser security
// header - the widget's script/CSS load fine either way, but its own JS
// gives up right after licensing fails, so the widget stays stuck on a
// loading spinner. There is no way to make Sportradar's server itself
// accept the playground domain; the only way to see the widget render on
// a generated link is to make outgoing requests to Sportradar/Betradar
// claim to come from the real brand's own (licensed) domain instead -
// i.e. deliberately spoof Origin/Referer for that traffic, scoped to one
// explicitly-opened tab only, same declarativeNetRequest mechanism (a
// different action - request header rewrite instead of response header
// removal) as the "Embed here" feature above.
// ---------------------------------------------------------------------

var SR_SPOOF_RULE_ID_START = 950001;

async function startSrSpoofRule(tabId, spoofOrigin, requestDomains, expectedOrigin) {
  return dnr.apply('sportradar', tabId, { scope: { kind: 'origin', value: expectedOrigin || new URL((await chromeCall(chrome.tabs, 'get', tabId)).url).origin } }, async () => allocate => [{
          id: allocate(1)[0],
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'origin', operation: 'set', value: spoofOrigin },
              { header: 'referer', operation: 'set', value: spoofOrigin + '/' }
            ],
            // The request-header spoof above is only half the fix. Sportradar's
            // /licensing endpoint issues a signed access token that BAKES IN
            // whatever Origin it saw (confirmed by base64-decoding the token's
            // `data` field: {"o":"<spoofOrigin>",...}) and every later data
            // call (e.g. lmt.fn.sportradar.com/.../gismo/match_info/{id}) - which
            // is initiated by script running INSIDE the Sportradar iframe, not
            // by this tab's top-level page - echoes that same spoofed origin
            // back as its own Access-Control-Allow-Origin response header.
            // Chrome's actual CORS enforcement compares that ACAO value
            // against the TAB's real, true origin (not the spoofed request
            // header we just set), so without this second half every such XHR
            // is blocked client-side with "Access-Control-Allow-Origin header
            // has a value ... that is not equal to the supplied origin" -
            // confirmed via live testing 2026-08-07. Rewriting the response
            // ACAO to '*' happens at the network layer before Chrome's CORS
            // check runs, so it satisfies that check unconditionally.
            responseHeaders: [
              { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
              { header: 'Access-Control-Allow-Credentials', operation: 'remove' }
            ]
          },
          condition: {
            // requestDomains matches the domain itself AND its subdomains,
            // so this one entry reaches both widgets.sir.sportradar.com and
            // lmt.fn.sportradar.com without listing each subdomain.
            // (Overridable only for tests - production callers never pass
            // this third argument, so real usage always targets Sportradar/
            // Betradar exactly as documented.)
            requestDomains: requestDomains || ['sportradar.com', 'betradar.com'],
            // Deliberately no initiatorDomains restriction here - the
            // licensing check's own follow-up data calls are initiated by
            // script running inside the Sportradar iframe itself (not by
            // this tab's top-level sportsbook page), so scoping initiators
            // to the sportsbook's own domain would silently fail to rewrite
            // those later requests even though it correctly rewrote the
            // first /licensing call (confirmed by live testing 2026-08-07).
            resourceTypes: ['xmlhttprequest', 'sub_frame', 'script', 'image', 'websocket', 'ping', 'other'],
            tabIds: [tabId]
          }
        }]);
}

function stopSrSpoofRule(tabId) { return dnr.stop('sportradar', tabId); }

// ---------------------------------------------------------------------
// Auto-apply Sportradar spoofing on every matching navigation - no button
// click needed, so a plain page open/reload/paste-URL is covered exactly
// like the standalone POC extension's always-on static rule was (the user
// reported the button-triggered, per-click flow above still lost the race
// on a normal open/refresh because it only ever ran AFTER the user
// explicitly clicked "Open (Sportradar-enabled)" - confirmed 2026-08-07).
// This listens at the earliest available navigation hook
// (webNavigation.onBeforeNavigate fires before the navigation's own
// request is sent) and sets up the SAME tab-scoped session rule used
// above, purely from the destination URL - no content script, no message
// round-trip from page JS, so there's nothing left in the page's own load
// sequence that could possibly outrace it.
// ---------------------------------------------------------------------

var SR_SPOOF_SETTING_KEY = 'lgt-sr-spoof-enabled'; // MUST match content.js's key

// Mirror of content.js's BRAND_DOMAINS (real production domain per brand).
// Duplicated here (rather than imported) because this needs to run from a
// pure navigation event in the service worker, independent of whether/when
// any content script for that tab has run - see comment block above.
var BRAND_DOMAINS = {
  arcticbet: 'arcticbet.com',
  betfirst: 'betfirst.be',
  bethard: 'bethard.com',
  bets10: 'bets10.com',
  betsafe: 'betsafe.com',
  betsmith: 'betsmith.com',
  betsolid: 'betsolid.com',
  betsson: 'betsson.com',
  betssonco: 'betsson.co',
  betssonarcb: 'betsson.bet.ar',
  betssonbr: 'betsson.bet.br',
  betssondk: 'betsson.dk',
  betssones: 'betsson.es',
  betssongr: 'betsson.gr',
  betssonmx: 'betsson.mx',
  btsarba: 'betsson.bet.ar',
  btsarbacity: 'betsson.bet.ar',
  cherry: 'cherry.se',
  guts: 'guts.com',
  hovarda: 'hovarda.com',
  ibet: 'ibet.com',
  inkabet: 'inkabet.pe',
  jetbahis: 'jetbahis.com',
  mobilbahis: 'mobilbahis.com',
  nordicbet: 'nordicbet.com',
  nordicbetdk: 'nordicbet.dk',
  playgurus: 'playgurus.com',
  rexbet: 'rexbet.com',
  rizk: 'rizk.com',
  spelklubben: 'spelklubben.se',
  triobet: 'triobet.com'
};

// Playground hostname suffix per brand (from the sbplayground-link-
// generator skill's BRAND_DOMAINS.md "prod playground base host" column,
// e.g. "d-cf.test.ndbplayground.net" for nordicbet -> suffix
// "ndbplayground.net"). Brands with obfuscated/rotating hex playground
// hosts (bets10, hovarda, jetbahis, rexbet, spino) and brands with no
// stable/known playground host (firestorm, firestormsg, sandbox, triobet)
// are deliberately omitted - there is no reliable hostname pattern to
// match for them, so auto-detection simply does not fire for those brands
// (same silent no-op as realBrandOrigin returning null for an unresolvable
// brand elsewhere in this feature).
var PLAYGROUND_HOST_SUFFIX = {
  arcticbet: 'arcticbetplayground.net',
  betfirst: 'betfirstplayground.net',
  bethard: 'bethardplayground.net',
  betsafe: 'bsfplayground.net',
  betsmith: 'betsmithplayground.net',
  betsolid: 'betsolidplayground.net',
  betsson: 'btsplayground.net',
  betssonarcb: 'btsarcbplayground.net',
  betssonbr: 'btsbrplayground.net',
  betssondk: 'btsdkplayground.net',
  betssones: 'btsesplayground.net',
  betssongr: 'btsgrplayground.net',
  betssonmx: 'btsmxplayground.net',
  btsarba: 'btsarbaplayground.net',
  btsarbacity: 'btsarbacityplayground.net',
  cherry: 'cherryplayground.net',
  guts: 'gutsplayground.net',
  ibet: 'ibetplayground.net',
  inkabet: 'inkabetplayground.net',
  mobilbahis: 'mbaplayground.net',
  nordicbet: 'ndbplayground.net',
  nordicbetdk: 'ndbdkplayground.net',
  playgurus: 'pgplayground.net',
  rizk: 'rizkplayground.net',
  spelklubben: 'spelklubbenplayground.net'
};

function detectBrandAndEnvFromPlaygroundHost(hostname) {
  hostname = (hostname || '').toLowerCase();
  var brand = null;
  Object.keys(PLAYGROUND_HOST_SUFFIX).forEach(function (key) {
    var suffix = PLAYGROUND_HOST_SUFFIX[key];
    if (hostname === suffix || hostname.slice(-(suffix.length + 1)) === '.' + suffix) brand = key;
  });
  if (!brand) return null;
  var env = 'prod';
  ['test', 'qa', 'alpha'].forEach(function (e) {
    if (hostname.indexOf('.' + e + '.') !== -1 || hostname.indexOf(e + '.') === 0) env = e;
  });
  return { brand: brand, environment: env };
}

function realBrandOriginBg(brandKey, environment) {
  var domain = BRAND_DOMAINS[brandKey];
  if (!domain) return null;
  var prefix = (environment && environment !== 'prod') ? (environment + '.') : '';
  return 'https://www.' + prefix + domain;
}

if (chrome.webNavigation?.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener(function (details) {
    // This is an early signal, not a blocking navigation hook. Chrome does not
    // await DNR removal. Explicitly opened tabs install rules before navigation.
    void observeTask(detection.navigate(details), 'clear document observations');
    if (details.frameId !== 0) return;
    const cleanup = dnr.navigate(details.tabId, details.url); // cancels unfinished Apply synchronously
    void observeTask(navigationTasks.run(details.tabId, async isCurrent => {
      await cleanup;
      if (!isCurrent()) return;
      const url = new URL(details.url);
      const info = detectBrandAndEnvFromPlaygroundHost(url.hostname);
      if (!info) return;
      if (url.searchParams.get('bleSource') === '1' && PLAYGROUND_HOST_SUFFIX[info.brand]) {
        await startBleCorsRule(details.tabId, PLAYGROUND_HOST_SUFFIX[info.brand], url.origin);
      }
      if (!isCurrent()) return;
      const spoofOrigin = realBrandOriginBg(info.brand, info.environment);
      if (!spoofOrigin) return;
      const setting = await chromeCall(chrome.storage.local, 'get', SR_SPOOF_SETTING_KEY);
      if (!isCurrent()) return;
      if (setting[SR_SPOOF_SETTING_KEY] !== false) await startSrSpoofRule(details.tabId, spoofOrigin, undefined, url.origin);
    }), 'navigation overrides');
  });
}

// ---------------------------------------------------------------------
// bleSource=1 mobile CORS fix - when a bleSource=1 link's frontend routes
// certain REST calls (e.g. /api/sb/v1/competitions) to the brand's alpha
// desktop CDN host (d-cf.alpha.<brand>playground.net) regardless of
// whether the page itself is being browsed on the DESKTOP (d-cf.) or
// MOBILE (m-cf.) CDN host, a mobile bleSource link ends up making a
// cross-origin fetch from m-cf.<env>.<brand>playground.net to
// d-cf.alpha.<brand>playground.net. That response's own
// Access-Control-Allow-Origin does not include the mobile host, so Chrome
// blocks it client-side with a real CORS error (confirmed live 2026-08-07,
// NordicBet QA mobile bleSource link: clicking into an event silently did
// nothing because this blocked competitions/subcategories call apparently
// gates the event route's own rendering). This is a genuine bug in the
// sportsbook FE bundle's own bleSource routing (it doesn't respect which
// CDN host the page itself is on) - not something a differently-built link
// could avoid, and not fixable by changing any query param.
//
// Same declarativeNetRequest technique as the Sportradar spoof above,
// but simpler: no Origin/Referer spoof is needed (the real origin is
// legitimate), just rewriting the response's Access-Control-Allow-Origin
// to '*' so Chrome's CORS check passes unconditionally. Scoped to the
// one tab and the one brand's playground domain family (all subdomains,
// via requestDomains matching), and only ever activated for a navigation
// whose URL actually carries bleSource=1 - a plain (non-bleSource) link
// never needs this and should not have its CORS behavior touched at all.
// ---------------------------------------------------------------------

var BLE_CORS_RULE_ID_START = 970001;
var BLE_CORS_RULE_ID_END = 990001; // exclusive upper bound of this
// feature's own id range, used to scope nextUniqueSessionRuleId's max-id
// scan (see that function's comment for why this is required).

async function startBleCorsRule(tabId, playgroundSuffix, expectedOrigin) {
  return dnr.apply('bleCors', tabId, { scope: { kind: 'origin', value: expectedOrigin || new URL((await chromeCall(chrome.tabs, 'get', tabId)).url).origin } }, async () => allocate => [{
          id: allocate(1)[0],
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [
              { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
              { header: 'Access-Control-Allow-Credentials', operation: 'remove' }
            ]
          },
          condition: {
            requestDomains: [playgroundSuffix],
            resourceTypes: ['xmlhttprequest', 'sub_frame', 'script', 'image', 'websocket', 'ping', 'other'],
            tabIds: [tabId]
          }
        }]);
}

function stopBleCorsRule(tabId) { return dnr.stop('bleCors', tabId); }

// ---------------------------------------------------------------------
// BLE Data Override - resolves the "22-es csapda" (catch-22) between
// Bundle Override (only works on a real, brand-embedded page) and
// bleSource=1 (only works on the tool's own standalone sandbox links):
// this reimplements bleSource's effect at the NETWORK layer instead of
// relying on the frontend's own bleSource query-flag handling, which only
// exists in the standalone sandbox build - a real brand page has no
// concept of bleSource at all and always talks to its own native (BDE)
// backend regardless of the URL.
//
// Root-caused via live Playwright header inspection (2026-08-10): EVERY
// `/api/sb/v1/*` call (event-page-schema, competitions/liveEvents,
// widgets/view, event-market, most-popular-competitions, ...) - on a
// sandbox link AND on a real brand page alike - carries two request
// headers that alone determine which customer/session context the
// backend resolves data for: `x-sb-static-context-id` and
// `x-sb-user-context-id`. On a real brand page these are populated from
// the page's own native (BDE) session, not from anything in the URL.
// `brandid`/`x-sb-country-code`/etc. are brand-level, not
// context-specific, and `sessiontoken` was confirmed (byte-for-byte
// identical across three completely independent sessions, decoding to an
// all-1s placeholder GUID) to be a static, non-secret placeholder - none
// of those need touching.
//
// The fix is therefore two declarativeNetRequest rules per tab, mirroring
// exactly the redirect+modifyHeaders combination the Sportradar spoof
// above already uses (a redirect action and a modifyHeaders action cannot
// live in the same rule, but two rules of different action types CAN both
// apply to the same logical request, evaluated in different network
// phases):
//   1. redirect `/api/sb/v1/*` from the tab's OWN current host to the
//      brand's ALPHA playground host (regex-substitution, preserving the
//      full path+query unchanged) - restricted to a regex that requires
//      the CURRENT host literally, so once a request has been redirected
//      to the alpha host the rule no longer matches it (no redirect loop,
//      and no accidental effect on unrelated hosts).
//   2. on requests actually reaching that alpha host, overwrite the two
//      context-id request headers to a caller-supplied ALPHA-valid
//      stc/ctx pair (freshly minted from PROD via the exact same
//      mechanism the Generate/Live-Login tabs' own bleSource option
//      already uses - see content.js's `apiEnv = opts.bleSource ? 'prod'
//      : ...`), plus a defensive Access-Control-Allow-Origin: '*'
//      response-header rewrite (alpha's own CORS response was confirmed
//      permissive by a direct curl probe, so this is redundant safety net
//      more than a required fix, same reasoning as the existing BLE CORS
//      fix above).
//
// Bonus effect (not originally planned, discovered during research): since
// competitions/liveEvents is also redirected, the widget's own live-event
// list becomes populated with ALPHA's real events automatically - the
// user does not need to manually navigate with an alpha/prod-borrowed
// eventId in the URL at all, just apply the override and browse normally.
//
// Fully independent of Bundle Override - both can be active on the same
// tab at once (separate rule-id ranges, separate tracking maps), and
// works identically whether the tab is a real brand page or one of this
// tool's own sandbox links.
// ---------------------------------------------------------------------

var BLE_DATA_RULE_ID_START = 910001;

function escapeRegexLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function startBleDataOverrideRule(tabId, currentHost, alphaHost, stc, ctx, expectedOrigin) {
  return dnr.apply('bleData', tabId, { scope: { kind: 'origin', value: expectedOrigin || 'https://' + currentHost } }, async () => allocate => {
    const ruleIds = allocate(2);
      var redirectRule = {
        id: ruleIds[0],
        priority: 1,
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: 'https://' + alphaHost + '/api/sb/v1/\\1' }
        },
        condition: {
          regexFilter: '^https?://' + escapeRegexLiteral(currentHost) + '/api/sb/v1/(.*)$',
          resourceTypes: ['xmlhttprequest'],
          tabIds: [tabId]
        }
      };
      var headerRule = {
        id: ruleIds[1],
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'x-sb-static-context-id', operation: 'set', value: stc },
            { header: 'x-sb-user-context-id', operation: 'set', value: ctx }
          ],
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'Access-Control-Allow-Credentials', operation: 'remove' }
          ]
        },
        condition: {
          urlFilter: '||' + alphaHost + '/api/sb/v1/*',
          resourceTypes: ['xmlhttprequest'],
          tabIds: [tabId]
        }
      };

    return [redirectRule, headerRule];
  });
}

function stopBleDataOverrideRule(tabId) { return dnr.stop('bleData', tabId); }

handleMessage('lgt-ble-data-start', async function (msg, sender) {
  if (!sender.tab || sender.tab.id == null) { return { ok: false, error: 'no tab' }; }
  var tabId = sender.tab.id;
  var alphaHost = msg.alphaHost, stc = msg.stc, ctx = msg.ctx;
  if (!alphaHost || !stc || !ctx) { return { ok: false, error: 'missing alphaHost, stc, or ctx' }; }
  var currentHost, currentOrigin;
  try {
    var u = new URL(sender.tab.url);
    currentHost = u.hostname;
    currentOrigin = u.origin;
  } catch (e) { return { ok: false, error: 'could not read current tab URL' }; }

  // A real brand's TEST shell can enter maintenance before its
  // GameLauncher has created the sportsbook at all. In that state there
  // are no /api/sb/v1/* calls for the BLE override to redirect. The BLE
  // panel therefore supplies the equivalent working PROD sportsbook URL
  // as bootstrapUrl. Install the rules for that destination host BEFORE
  // the navigation starts, and make stale-cleanup expect that destination
  // origin, so onBeforeNavigate does not tear the fresh rules down.
  var sourceHost = currentHost;
  var expectedOrigin = currentOrigin;
  if (msg.bootstrapUrl) {
    try {
      var bootstrap = new URL(msg.bootstrapUrl);
      var brandDomain = BRAND_DOMAINS[msg.brand];
      var isProdBrandHost = brandDomain &&
        (bootstrap.hostname === brandDomain || bootstrap.hostname === 'www.' + brandDomain);
      if (bootstrap.protocol !== 'https:' || !isProdBrandHost) {
        return { ok: false, error: 'invalid BLE maintenance bootstrap URL' };
      }
      sourceHost = bootstrap.hostname;
      expectedOrigin = bootstrap.origin;
    } catch (e) {
      return { ok: false, error: 'invalid BLE maintenance bootstrap URL' };
    }
  }
  await startBleDataOverrideRule(tabId, sourceHost, alphaHost, stc, ctx, expectedOrigin);
  return { ok: true };
});

handleMessage('lgt-ble-data-stop', async function (msg, sender) {
  const tabId = senderTabId(sender);
  await stopBleDataOverrideRule(tabId);
  return { ok: true };
});

handleMessage('lgt-ble-data-status', async function (msg, sender) {
  const tabId = senderTabId(sender);
  const { rules } = await dnr.status('bleData', tabId);
  return { ok: true, active: rules.length > 0 };
});

// ---------------------------------------------------------------------
// Bundle override - redirects a brand's sportsbook bundle (main-*.js, and
// any other per-device file the target env's indexer.json lists) to a
// selected same-layer environment's build (including pinning ALPHA to
// ALPHA when a brand host is serving a PROD artifact), without a deploy. This ports
// the mechanism of the separate, standalone "Sportsbook Bundle Override
// Tool" (BetssonGroup/sb-bundle-override-tool) directly into this
// extension, so testers don't need to load a second extension side by
// side. See the `sb-bundle-override-tool` Copilot CLI skill's
// REFERENCE.md for the original tool's own documented mechanism - this
// reimplementation follows the same indexer.json-driven redirect
// approach, but scopes every rule to ONE explicitly-targeted tab (session
// rules + `tabIds` condition, exactly like the three declarativeNetRequest
// features above) rather than the standalone tool's browser-wide dynamic
// rules - so it can never affect a tab/site other than the one the user
// applied it to, and two people running this feature in different tabs
// never collide with each other.
//
// Only ever override within the SAME environment layer - QA/TEST (BLE) or
// ALPHA/PROD (BDE). The two layers' bundle formats are incompatible; mixing
// them loads a broken build with no explicit runtime error. Both the Bundle
// tab and this message handler validate that boundary.
// ---------------------------------------------------------------------


var BUNDLE_INDEXER_URLS = {
  test: 'https://d-cf.test.sbplayground1.net/dist/test/xp/widgets/sportsbook/indexer.json',
  qa: 'https://d-cf.qa.sbplayground1.net/dist/qa/xp/widgets/sportsbook/indexer.json',
  alpha: 'https://d-cf.alpha.sbplayground1.net/dist/alpha/xp/widgets/sportsbook/indexer.json',
  prod: 'https://d-cf.sbplayground1.net/dist/prod/xp/widgets/sportsbook/indexer.json'
};

var BUNDLE_ENV_LAYERS = {
  test: 'ble',
  qa: 'ble',
  alpha: 'bde',
  prod: 'bde'
};

function bundleEnvironmentsInLayer(environment) {
  var layer = BUNDLE_ENV_LAYERS[environment];
  if (!layer) return [];
  return Object.keys(BUNDLE_ENV_LAYERS).filter(function (candidate) {
    return BUNDLE_ENV_LAYERS[candidate] === layer;
  });
}

var BUNDLE_RULE_ID_START = 930001;

var BUNDLE_INDEXER_CACHE_MS = 5 * 60 * 1000;

// The QA Sportsbook Tool derives the effective mFE environment from the
// page's startup context, which stays at the layer's base environment even
// after a network-level bundle override (PROD for ALPHA, QA for TEST). Its
// own override implementation publishes xSbIsMfeOverrideApplied in MAIN
// world to tell the tool to translate those two values. Mirror that public
// compatibility signal while our equivalent override is active. Do not set
// it for PROD/QA targets: there the unmodified startup context is already
// the right answer, and forcing the flag would invert a correct result.
function bundleTargetNeedsMfeOverrideFlag(targetEnv) {
  return targetEnv === 'alpha' || targetEnv === 'test';
}

// Same fact as the comment above, reused by computeDetectionRows: when a
// Bundle Override is active and targets 'alpha'/'test', the runtime marker
// (sbMfeStartupContext/obgClientEnvironmentConfig.startupContext) is
// EXPECTED to keep reporting the layer's base environment/version (prod
// for the alpha/prod "bde" layer, qa for the qa/test "ble" layer) even
// though the network side now correctly reflects the override target -
// this is not a detection bug, it's the same startup-context-stays-pinned
// behavior the third-party Sportsbook Tool's own xSbIsMfeOverrideApplied
// compatibility flag exists to paper over. Recognizing this exact,
// deterministic pattern lets the classifier avoid crying Mismatch over a
// divergence the user (or the Bundle tab) deliberately caused on purpose.
function bundleOverrideBaseEnvFor(targetEnv) {
  return BUNDLE_ENV_LAYERS[targetEnv] === 'ble' ? 'qa' : 'prod';
}

function bundleOverrideExplainsEnvDivergence(targetEnv, runtimeEnv, networkEnv) {
  if (!targetEnv || !bundleTargetNeedsMfeOverrideFlag(targetEnv)) return false;
  return runtimeEnv === bundleOverrideBaseEnvFor(targetEnv) && networkEnv === normalizeEnv(targetEnv);
}

function setBundleMfeOverrideFlag(tabId, targetEnv) {
  var enabled = bundleTargetNeedsMfeOverrideFlag(targetEnv);
  return new Promise(function (resolve) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      args: [enabled],
      func: function (shouldEnable) {
        var ownerKey = '__linkGenToolOwnsXSbIsMfeOverrideApplied';
        if (shouldEnable) {
          // Respect a flag owned by another tool. The Link Gen Tool UI warns
          // against running both overrides together, but avoiding ownership
          // theft makes Disable safe even if somebody does.
          if (typeof window.xSbIsMfeOverrideApplied === 'undefined' || window[ownerKey]) {
            window.xSbIsMfeOverrideApplied = true;
            window[ownerKey] = true;
          }
        } else if (window[ownerKey]) {
          delete window.xSbIsMfeOverrideApplied;
          delete window[ownerKey];
        }
        return {
          enabled: window.xSbIsMfeOverrideApplied === true,
          owned: window[ownerKey] === true
        };
      }
    }, function (results) {
      var error = chrome.runtime.lastError;
      resolve({
        ok: !error,
        error: error ? error.message : null,
        state: results && results[0] ? results[0].result : null
      });
    });
  });
}

async function getLiveBundleRulesForTab(tabId) { return (await dnr.status('bundle', tabId)).rules; }

function bundleTargetEnvFromRules(liveRules) {
  var targetEnvs = (liveRules || []).map(function (rule) {
    var redirectUrl = rule.action && rule.action.redirect && rule.action.redirect.url;
    if (!redirectUrl) return null;
    try { return envLabelFromHostname(new URL(redirectUrl).hostname); } catch (e) { return null; }
  }).filter(function (env, index, values) { return env && values.indexOf(env) === index; });
  return targetEnvs.length === 1 ? targetEnvs[0] : null;
}

async function syncBundleMfeOverrideFlag(tabId) {
  const liveRules=await getLiveBundleRulesForTab(tabId);
	return await setBundleMfeOverrideFlag(tabId,bundleTargetEnvFromRules(liveRules));
}

async function fetchBundleIndexer(targetEnv) {
  const url = BUNDLE_INDEXER_URLS[targetEnv];
  if (!url) throw new Error('Unknown target env: ' + targetEnv);
  let cache;
  try {
    cache = await caches.open('lgt-indexer-v2');
    const cached = await cache.match(url);
    if (cached) {
      const age = Date.now() - Number(cached.headers.get('x-lgt-cached-at'));
      if (age >= 0 && age < BUNDLE_INDEXER_CACHE_MS) return await cached.json();
      await cache.delete(url);
    }
  } catch (error) { console.warn('[link-gen-tool] indexer cache read unavailable:', error); }
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error('indexer.json fetch failed: HTTP ' + response.status);
  const data = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid indexer.json');
  try {
    if (cache) await cache.put(url, new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'x-lgt-cached-at': String(Date.now()) } }));
  } catch (error) { console.warn('[link-gen-tool] indexer cache write unavailable:', error); }
  return data;
}

// Same service-worker-restart-safe id allocation as nextUniqueSessionRuleId
// above, but returns `count` sequential ids from a single getSessionRules
// query - a bundle override can need several rules at once (one per
// device x file), so calling the single-id helper repeatedly would mean
// repeated round-trips and a theoretical race between them.
//
// Same range-scoping requirement as nextUniqueSessionRuleId above (see
// its comment for the full root-cause writeup) - `endIdExclusive` is
// REQUIRED and the max-id scan is restricted to this feature's own
// range, never the global max across all registered rules.


// Builds one declarativeNetRequest redirect rule per bundle file listed in
// the target env's indexer.json for this brand (device-agnostic - iterates
// whatever `js` array entries actually exist, so it keeps working whether
// a build ships one file (just main-*.js, as observed live 2026-08) or
// splits out extra files like polyfills-*.js in some other build - no
// hardcoded file-name assumption). Some brands' indexer entries list
// relative paths (e.g. "/dist/alpha/.../main-HASH.js") rather than a full
// URL (confirmed live 2026-08 - most brands use an absolute, brand-owned
// CDN host, but at least one observed entry was host-relative) - those
// are resolved against the TARGET env's own indexer host, never a
// hardcoded one, since a relative path always means "same host as the
// indexer.json that listed it."
//
// IMPORTANT (found 2026-08-10, root-caused a real blank-page bug): this
// ONLY builds rules matching the dist-shape widget URL
// (`*<brandId>*/<device>/files/<prefix>-*.js`) - the tool used to ALSO
// build an extra rule matching the bare sandbox-shape pattern
// (`*/assets/<prefix>-*.js`) whenever a `sandboxDevice` was picked, meant
// to let Bundle Override work on the tool's own standalone "Generate" tab
// links. That was based on a wrong assumption: those sandbox links are
// NOT "just the widget with a different URL shape" - `/assets/main-*.js`
// there IS the entire self-contained Angular app (there is no separate
// dist-shape widget request at all on a fresh load). Redirecting that
// shell bundle to indexer.json's widget-only dist-shape file (a component
// meant to be loaded via Module Federation from an already-bootstrapped
// host, not run standalone as the top-level entry script) silently
// produces a completely blank page - confirmed live via Playwright on
// both a logged-out and a logged-in NordicBet QA sandbox link (no console
// error, no failed request; the browser happily executes the wrong
// bundle as the page's own entry script, and nothing ever mounts).
// indexer.json has no equivalent "standalone monolithic sandbox app"
// bundle to redirect to for the other env, so this genuinely cannot be
// fixed with the current data source - removed rather than left half
// broken. Bundle Override now only supports pages where the sportsbook
// widget is embedded via the real dist-shape URL (real brand domains, or
// anything else that loads the widget the same way) - see the Bundle tab
// hint text and README for the corresponding user-facing guidance.
function buildBundleRedirectRules(indexerData, layerIndexerData, brandId, targetEnv, tabId, ruleIds, allowCrossOriginConfig, pageEnv, pageOrigin) {
  var entry = indexerData && indexerData[brandId];
  if (!entry) return { rules: [], skippedNoBrand: true };
  var indexerOrigin = '';
  try { indexerOrigin = new URL(BUNDLE_INDEXER_URLS[targetEnv]).origin; } catch (e) { /* leave empty */ }
  var rules = [];
  var idIdx = 0;
  // Computed up front (not just for the config rules further below) because
  // the generic per-device catch-all noop rule needs it too - see the
  // "unlisted async chunk" comment inside the device loop for why.
  var sourceEnvsForRedirect = allowCrossOriginConfig
    ? Object.keys(BUNDLE_ENV_LAYERS).filter(function (environment) { return environment !== targetEnv; })
    : bundleEnvironmentsInLayer(targetEnv).filter(function (environment) { return environment !== targetEnv; });
  ['desktop', 'mobile'].forEach(function (device) {
    var deviceEntry = entry[device];
    var files = (deviceEntry && deviceEntry.js) || [];
    var targetPrefixes = [];
    files.forEach(function (fileUrl) {
      var filename = fileUrl.split('/').pop();
      // Current indexers contain both `main-HASH.js` and dot-separated
      // entries such as `shell.HASH.js`. Treat both separators as the same
      // semantic bundle prefix so a valid target entry is never silently
      // omitted from the redirect plan.
      var prefixMatch = /^([a-zA-Z0-9]+)[.-]/.exec(filename);
      var prefix = prefixMatch ? prefixMatch[1] : null;
      if (!prefix) return; // unexpected filename shape - skip rather than
      // build a rule that could match too broadly.
      if (targetPrefixes.indexOf(prefix) === -1) targetPrefixes.push(prefix);
      var targetUrl = /^https?:\/\//i.test(fileUrl) ? fileUrl : (indexerOrigin + fileUrl);
      if (idIdx >= ruleIds.length) return; // safety - should never happen,
      // ruleIds is pre-sized to the exact needed count by the caller.
      rules.push({
        id: ruleIds[idIdx++],
        // Higher than the generic unlisted-chunk catch-all noop rule added
        // below (which must never win a tie against an explicit, known-good
        // target redirect for the same request).
        priority: 2,
        action: { type: 'redirect', redirect: { url: targetUrl } },
        condition: {
          // Match both current naming conventions (`main-HASH.js` and
          // `shell.HASH.js`). A regex is required here: parsing the dot form
          // above but retaining the old hyphen-only urlFilter would still
          // install a rule that can never match the shell request.
          regexFilter: '^https?://[^/]+/.*' + brandId + '.*/' + device + '/files/' + prefix + '[.-][^/?]+\\.m?js([?].*)?$',
          resourceTypes: ['script'],
          tabIds: [tabId]
        }
      });
    });

    // Same-layer environments can expose a different entrypoint topology.
    // NordicBet mobile is a concrete example: PROD ships main + shell while
    // ALPHA currently ships main only. Redirecting main without handling the
    // PROD-only shell executes code from both builds in the same page. Any
    // entrypoint prefix found elsewhere in the layer but absent from the
    // selected target is therefore redirected to a no-op extension resource.
    var layerPrefixes = [];
    (layerIndexerData || []).forEach(function (layerData) {
      var layerDevice = layerData && layerData[brandId] && layerData[brandId][device];
      ((layerDevice && layerDevice.js) || []).forEach(function (fileUrl) {
        var filename = fileUrl.split('/').pop();
        var match = /^([a-zA-Z0-9]+)[.-]/.exec(filename);
        if (match && layerPrefixes.indexOf(match[1]) === -1) layerPrefixes.push(match[1]);
      });
    });
    layerPrefixes.forEach(function (prefix) {
      if (targetPrefixes.indexOf(prefix) !== -1 || idIdx >= ruleIds.length) return;
      rules.push({
        id: ruleIds[idIdx++],
        priority: 2, // see the comment on the main-file redirect rule above
        action: { type: 'redirect', redirect: { extensionPath: '/bundle-noop.js' } },
        condition: {
          regexFilter: '^https?://[^/]+/.*' + brandId + '.*/' + device + '/files/' + prefix + '[.-][^/?]+\\.m?js([?].*)?$',
          resourceTypes: ['script'],
          tabIds: [tabId]
        }
      });
    });

    // Both mechanisms above only neutralize entrypoint prefixes that show up
    // SOMEWHERE in indexer.json (target or layer siblings). Confirmed live
    // 2026-09 (Betsson desktop): indexer.json's "js" array for this brand
    // lists only the single "main-HASH.js" entry in EVERY environment, yet
    // the real page also modulepreloads a dozen additional
    // "chunk-HASH.js"/"shell.HASH.js" files that appear in NO environment's
    // indexer.json at all - those requests fire in the same instant as the
    // initial HTML parse (before any override-driven script runs), are
    // completely invisible to the two prefix lists above, and previously
    // kept silently loading from whatever native environment the page
    // actually served (observed: 13 of 46 script requests staying on
    // /dist/prod/ while main + the rest of the redirected build correctly
    // moved to /dist/test/ - a mixed-version build with no error, exactly
    // the "broken build" scenario the two mechanisms above exist to avoid).
    // Since indexer.json never lists these files, there is no known-good
    // target URL to redirect them to; noop them instead of leaking the
    // stale native copy. Scoped to `/dist/<non-target-env>/` so this can
    // never match (or block) a request that's already correctly pointed at
    // the target environment's own path.
    if (idIdx < ruleIds.length && sourceEnvsForRedirect.length) {
      rules.push({
        id: ruleIds[idIdx++],
        priority: 1, // lowest - any explicit rule above must win a tie
        action: { type: 'redirect', redirect: { extensionPath: '/bundle-noop.js' } },
        condition: {
          regexFilter: '^https?://[^/]+/.*dist/(' + sourceEnvsForRedirect.join('|') + ')/.*' + brandId + '.*/' + device + '/files/[^/?]+\\.m?js([?].*)?$',
          resourceTypes: ['script'],
          tabIds: [tabId]
        }
      });
    }
  });

  // The selected bundle can request its ClientConfig from the environment
  // encoded by the host page. When ALPHA is pinned on a page configured with
  // PROD, that leaves a /dist/prod/config/... request beside ALPHA JavaScript
  // and can return 403. Keep the remainder of the config path intact, but pin
  // it to the selected bundle environment. Cross-layer mode covers every
  // possible source environment and also pins the brand host, which removes
  // any dependency on whether the page runtime captured fetch before the
  // MAIN-world adapter was installed.
  var regexCapture = String.fromCharCode(92);
  var sourceConfigEnvs = sourceEnvsForRedirect; // same set computed above,
  // reused here for the config redirect rules below.
  var brandKey = null;
  Object.keys(BUNDLE_BRAND_GUIDS || {}).some(function (key) {
    if (BUNDLE_BRAND_GUIDS[key] !== brandId) return false;
    brandKey = key;
    return true;
  });
  var targetConfigOrigin = null;
  if (allowCrossOriginConfig && pageOrigin) {
    try {
      var targetOriginUrl = new URL(pageOrigin);
      var targetOriginLabels = targetOriginUrl.hostname.split('.').filter(function (label) {
        return ['test', 'qa', 'alpha'].indexOf(label) === -1;
      });
      if (targetEnv !== 'prod') targetOriginLabels.splice(Math.max(0, targetOriginLabels.length - 2), 0, targetEnv);
      targetOriginUrl.hostname = targetOriginLabels.join('.');
      targetConfigOrigin = targetOriginUrl.origin;
    } catch (targetOriginError) {}
  }
  var pageConfigOrigin = allowCrossOriginConfig ? pageOrigin : null;
  sourceConfigEnvs.forEach(function (sourceConfigEnv) {
    if (idIdx >= ruleIds.length) return;
    rules.push({
      id: ruleIds[idIdx++],
      priority: 1,
      action: {
        type: 'redirect',
        redirect: {
          regexSubstitution: (targetConfigOrigin || regexCapture + '1') + '/dist/' + targetEnv + '/config/' + regexCapture + '2'
        }
      },
      condition: {
        regexFilter: '^(https?://[^/]+)/dist/' + sourceConfigEnv + '/config/(' + brandId + '/.*)$',
        resourceTypes: ['xmlhttprequest'],
        tabIds: [tabId]
      }
    });
  });

  // In hybrid cross-layer mode the MAIN-world adapter deliberately asks the
  // target environment for its ClientConfig. That request is cross-origin
  // when, for example, a PROD page runs the TEST bundle. The config endpoint
  // returns the JSON successfully but does not publish an ACAO header, so the
  // page fetch is rejected by Chrome after the HTTP 200 response. Add the
  // smallest possible response-header exception: this tab, this target env,
  // this brand's /dist/<env>/config path, and XHR/fetch only. The config is a
  // public bootstrap resource and the request uses the browser's default
  // cross-origin credential mode (credentials are not sent).
  if (allowCrossOriginConfig && idIdx < ruleIds.length) {
    rules.push({
      id: ruleIds[idIdx++],
      priority: 2,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'access-control-allow-origin', operation: 'set', value: pageConfigOrigin || '*' },
          { header: 'access-control-allow-credentials', operation: 'set', value: 'true' }
        ]
      },
      condition: {
        // Match the original source config URL as well as the post-redirect
        // target URL. DNR response-header evaluation can retain the original
        // request match after our separate redirect action.
        regexFilter: '^https?://[^/]+/dist/(test|qa|alpha|prod)/config/' + brandId + '/.*',
        resourceTypes: ['xmlhttprequest'],
        tabIds: [tabId]
      }
    });
  }

  // BDE bundles (ALPHA/PROD) issue a separate static-context GET. BLE
  // backends (TEST/QA) reject that route with HTTP 400 even though the same
  // context identifiers succeed against BLE's user-context route. Translate
  // only this read-only contract in the BDE-bundle -> BLE-backend direction;
  // request headers and context IDs remain untouched.
  if (allowCrossOriginConfig && BUNDLE_ENV_LAYERS[targetEnv] === 'bde' && BUNDLE_ENV_LAYERS[pageEnv] === 'ble' && idIdx < ruleIds.length) {
    rules.push({
      id: ruleIds[idIdx++],
      priority: 2,
      action: {
        type: 'redirect',
        redirect: { regexSubstitution: regexCapture + '1user-context' + regexCapture + '2' }
      },
      condition: {
        regexFilter: '^(https?://[^/]+/sb/fe-api/v1/)static-context([?].*)?$',
        resourceTypes: ['xmlhttprequest'],
        tabIds: [tabId]
      }
    });
  }

  // Target ClientConfig can contain an absolute SSTP health endpoint for the
  // bundle environment. In hybrid mode that makes a harmless GET cross origin
  // (for example TEST host -> www.betsson.com/sstp/healthy), which the target
  // server answers without CORS headers and Chrome consequently rejects. The
  // page host does not necessarily expose the same endpoint, so retain the
  // target health probe and grant only this tab's exact page origin access to
  // its response. No other SSTP route or method is eligible.
  if (allowCrossOriginConfig && targetConfigOrigin && pageOrigin && targetConfigOrigin !== pageOrigin && idIdx < ruleIds.length) {
    rules.push({
      id: ruleIds[idIdx++],
      priority: 2,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'access-control-allow-origin', operation: 'set', value: pageOrigin },
          { header: 'access-control-allow-credentials', operation: 'set', value: 'true' }
        ]
      },
      condition: {
        regexFilter: '^' + escapeRegexLiteral(targetConfigOrigin) + '/sstp/healthy([?].*)?$',
        requestMethods: ['get'],
        resourceTypes: ['xmlhttprequest'],
        tabIds: [tabId]
      }
    });
  }
  return { rules: rules, skippedNoBrand: false };
}

async function startBundleOverrideRule(tabId, targetEnv, brandId, currentEnv, pageOrigin, expectedUrl) {
  const crossLayer = !!currentEnv && BUNDLE_ENV_LAYERS[currentEnv] !== BUNDLE_ENV_LAYERS[targetEnv];
  const environments = crossLayer ? Object.keys(BUNDLE_INDEXER_URLS) : bundleEnvironmentsInLayer(targetEnv);
  return dnr.apply('bundle', tabId, { targetEnv: targetEnv, scope: { kind: 'url', value: expectedUrl } }, async () => {
    const results = await Promise.all(environments.map(async environment => {
      try { return { environment, data: await fetchBundleIndexer(environment) }; }
      catch (error) { if (environment === targetEnv) throw error; return { environment, data: null }; }
    }));
    const indexer = results.find(result => result.environment === targetEnv)?.data;
    const layerData = results.map(result => result.data).filter(Boolean);
    return allocate => {
      const built = buildBundleRedirectRules(indexer, layerData, brandId, targetEnv, tabId, allocate(23), crossLayer, currentEnv, pageOrigin);
      if (built.skippedNoBrand) throw new Error('Brand not found in ' + targetEnv + ' indexer.json');
      if (!built.rules.length) throw new Error('No bundle files found for this brand/env');
      return built.rules;
    };
  });
}

async function stopBundleOverrideRule(tabId) {
  await dnr.stop('bundle', tabId);
  await workerStore.update('bundleMatches', tabId, () => null);
  return setBundleMfeOverrideFlag(tabId, null);
}

// Verification hook mirroring the standalone tool's Service Worker console
// log (REFERENCE.md "Debugging") - requires the `declarativeNetRequestFeedback`
// permission (a dev/unpacked-only API, fine here since this extension is
// always sideloaded, never published to the Chrome Web Store).
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(function (info) {
    const ruleId = info?.rule?.ruleId;
    const tabId = info?.request?.tabId;
    if (typeof ruleId !== 'number' || ruleId < BUNDLE_RULE_ID_START || ruleId >= SR_SPOOF_RULE_ID_START || tabId == null || tabId < 0) return;
    void observeTask(workerStore.update('bundleMatches', tabId, value => ({
      matched: [...(value?.matched || []), { ruleId, requestUrl: String(info.request.url).slice(0, 4096), timestamp: Date.now() }].slice(-50)
    })), 'bundle match log');
  });
}

handleMessage('lgt-bundle-start', async function (msg, sender) {
  if (!sender.tab || sender.tab.id == null) { return { ok: false, error: 'no tab' }; }
  var tabId = sender.tab.id;
  var targetEnv = msg.targetEnv, currentEnv = msg.currentEnv, brandId = msg.brandId;
  if (!targetEnv || !brandId) { return { ok: false, error: 'missing targetEnv or brandId' }; }
  if (!BUNDLE_ENV_LAYERS[targetEnv]) { return { ok: false, error: 'unknown target environment: ' + targetEnv }; }
  if (currentEnv && BUNDLE_ENV_LAYERS[currentEnv] !== BUNDLE_ENV_LAYERS[targetEnv]) {
    if (!msg.labAuthorized) {
      return { ok: false, error: 'cross-layer bundle override requires an authorized Cross-Layer Lab session (' + currentEnv + ' -> ' + targetEnv + ')' };
    }
  }
  // Remember the exact URL the override was applied for (see the
  // stale-cleanup logic in chrome.webNavigation.onBeforeNavigate above,
  // and the comment on bundleExpectedUrlByTab above for why this is the
  // whole URL, not just the origin) - Bundle Override is meant to be tied
  // to one specific tested link, unlike the Sportradar-spoof/BLE-CORS
  // domain-wide fixes.
  var expectedUrl = sender.tab.url || null;
  if (sender.tab.url) {
    if (msg.expectedUrl) {
      try {
        var currentPageUrl = new URL(sender.tab.url);
        var requestedExpectedUrl = new URL(msg.expectedUrl);
        // The content script only needs to add diagnostics query params to
        // the current page. Do not let this message weaken stale-navigation
        // cleanup by authorizing a different origin or pathname.
        if (requestedExpectedUrl.origin !== currentPageUrl.origin || requestedExpectedUrl.pathname !== currentPageUrl.pathname) {
          return { ok: false, error: 'expected reload URL must keep the current origin and pathname' };
        }
        expectedUrl = requestedExpectedUrl.toString();
      } catch (expectedUrlError) {
        return { ok: false, error: 'invalid expected reload URL' };
      }
    }
  }
  const pageOrigin = new URL(sender.tab.url).origin;
  const result = await startBundleOverrideRule(tabId, targetEnv, brandId, currentEnv, pageOrigin, expectedUrl);
  await workerStore.update('bundleMatches', tabId, () => ({ matched: [] }));
  const flagResult = await setBundleMfeOverrideFlag(tabId, targetEnv);
  return { ok: true, ruleCount: result.ruleCount, targetEnv: targetEnv, mfeFlag: flagResult };
});

handleMessage('lgt-bundle-stop', async function (msg, sender) {
  const tabId = senderTabId(sender);
  await stopBundleOverrideRule(tabId);
  return { ok: true };
});

handleMessage('lgt-bundle-status', async function (msg, sender) {
  const tabId = senderTabId(sender);
  const { rules } = await dnr.status('bundle', tabId);
  const log = await workerStore.read('bundleMatches', tabId);
  return { ok: true, active: rules.length > 0, ruleCount: rules.length, matched: log?.matched || [], targetEnv: bundleTargetEnvFromRules(rules) };
});

// content.js calls this on every new document, independently of whether the
// Link Gen Tool panel is open. Session DNR rules survive an MV3 service-worker
// restart, while MAIN-world globals do not survive a page reload; deriving the
// target from Chrome's live rules restores the compatibility flag reliably.
handleMessage('lgt-bundle-sync-page-flag', async function (msg, sender) {
  const tabId = senderTabId(sender);
  return syncBundleMfeOverrideFlag(tabId);
});

// ---------------------------------------------------------------------
// "Detected build" observation - answers "what environment/version is
// THIS tab's sportsbook bundle actually loaded from, right now?" with
// certainty, from the one source that cannot lie: the real HTTP request
// the browser already made for main-<hash>.js. Completely independent of
// the Bundle-override feature above (works whether or not an override is
// active, and whether or not the user ever opens the Bundle tab) - this
// is what should be trusted over any UI dropdown or the separate
// "Sportsbook Tool" legacy page-injected script's own "SB Version" field, since both of
// those can show a stale/misconfigured value with no visible error (see
// the 2026-08-10 Bundle-tab bug this was built in response to).
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Brand- and layer-scoped SB version/environment detection.
//
// A brand is not one architecture: the SAME brand page can run an MFE
// widget, an iframe/OBGA embed, and/or a NodeJS-rendered layer at once,
// each potentially on a different version/environment, each potentially
// in its OWN frame. Everything below is keyed by tabId -> frameId ->
// layer ('mfe'|'iframe'|'nodejs') so two layers on one page, or the same
// layer in two frames, never overwrite each other's evidence.
//
// runtimeMarkersByTab[tabId][frameId][layer] = {brandId, brandName,
//   version, environment, appHash, versionSource, environmentSource, ts}
//   - populated by the 'lgt-layer-marker' message from layer-relay.js
//     (itself just forwarding layer-detect.js's MAIN-world reads of
//     window.sbMfeStartupContext/sbXpSportsbookAppVersion,
//     window.obgClientEnvironmentConfig.startupContext, window.nodeContext).
//
// networkByTab[tabId][frameId][layer] = {brandId, brand, matchedBrandId,
//   device, version, headerVersion, hostEnv, artifactEnv, artifactEnvs,
//   url, ts} - the independent, network-observed side of the same
// evidence. Last-write-wins per layer on purpose: every fresh page
// load/reload always re-requests the bundle/config (hashed filenames,
// not cached across deploys), so the most recent observation IS the
// current truth for that frame+layer.
//
// frameDocByTab[tabId][frameId] = {url, hostname, env} - the frame's own
// committed navigation URL, used as the NodeJS layer's environment
// source (nodeContext.environment is not guaranteed) and as a last-
// resort hostname brand fallback.

// Resolves a brand key from either a known GUID or a free-text brand
// name (as reported by a runtime marker's brandId/brandName - the two
// markers are not guaranteed to agree on which of the two they populate).
function brandKeyFromMarker(brandId, brandName) {
  if (brandId) {
    var byGuid = bundleBrandKeyFromGuid(brandId);
    if (byGuid) return byGuid;
    // Not a known GUID - it may already BE the brand key/slug itself.
    if (BUNDLE_BRAND_GUIDS[String(brandId).toLowerCase()]) return String(brandId).toLowerCase();
  }
  if (brandName) {
    var normalized = String(brandName).toLowerCase().replace(/[^a-z0-9]/g, '');
    var match = Object.keys(BUNDLE_BRAND_GUIDS).filter(function (key) { return key.replace(/[^a-z0-9]/g, '') === normalized; });
    if (match.length === 1) return match[0];
  }
  return null;
}

// bleSource=1 exists ONLY to force a QA/TEST-bundle page to talk to the
// ALWAYS-live PROD/ALPHA backend (see content.js's `apiEnv = opts.bleSource
// ? 'prod' : ...`). Those ALPHA/PROD backend requests are a deliberate,
// expected mismatch versus the QA/TEST bundle actually running the page -
// they must never be allowed to leak into (or poison) the bundle
// environment computation.
function isBleExcludedRequest(url, hostEnv) {
  if (hostEnv !== 'alpha' && hostEnv !== 'prod') return false;
  try { return new URL(url).searchParams.get('bleSource') === '1'; } catch (e) { return false; }
}

var BUNDLE_OBSERVE_RE = /\/dist\/([a-z]+)\/xp\/widgets\/sportsbook\/([0-9a-fA-F-]{36})\/([^/]+)\/(desktop|mobile)\/files\/([a-zA-Z0-9]+)-[^/.]+\.js/i;

// Second, structurally different bundle URL shape, discovered 2026-08-10:
// the tool's OWN "Generate" tab links (opened standalone, not embedded in a
// real brand page) serve their Angular bundle as plain, same-origin
// `/assets/<prefix>-<hash>.js` - standard Angular CLI output with NO
// version, brandId, or device segment anywhere in the URL (unlike the
// dist-shape above). BUNDLE_OBSERVE_RE never matches this shape, which is
// why the Detected-build strip previously showed "No sportsbook bundle
// detected" forever on these links even though a bundle clearly was
// loading. Restricted to the canonical Angular CLI bundle name prefixes so
// it doesn't fire on arbitrary small helper scripts also served from
// `/assets/`.
var BUNDLE_OBSERVE_SANDBOX_RE = /\/assets\/(main|chunk|polyfills|runtime|vendor)-[A-Za-z0-9]+\.m?js(\?|$)/i;

// A standalone sandbox's startup config request supplies the metadata its
// `/assets/*.js` URLs omit: brand id, facade id, and version family. The
// facade id maps to one device entry in the same environment's indexer,
// which lets us resolve the exact deployed SB version without guessing
// from shared chunk hashes. This also works on the generic
// d-cf.<env>.sbplayground1.net host, where the hostname carries no brand.
var BUNDLE_OBSERVE_SANDBOX_CONFIG_RE = /\/dist\/([a-z]+)\/config\/([0-9a-fA-F-]{36})\/([0-9a-fA-F-]{36})\/([^/]+)\/config\.json(?:\?|$)/i;

// Same label-scan approach as detectBrandAndEnvFromPlaygroundHost() above,
// but not restricted to known playground suffixes - the bundle CDN host
// can be a brand-owned domain (e.g. d-cf.btsplayground.net) that isn't in
// PLAYGROUND_HOST_SUFFIX, so this only looks at the env label itself.
function envLabelFromHostname(hostname) {
  hostname = (hostname || '').toLowerCase();
  var env = 'prod';
  ['test', 'qa', 'alpha'].forEach(function (e) {
    if (hostname.indexOf('.' + e + '.') !== -1 || hostname.indexOf(e + '.') === 0) env = e;
  });
  return env;
}

function genericSandboxInfoFromHostname(hostname) {
  hostname = (hostname || '').toLowerCase();
  if (!/^(?:d|m)-cf(?:\.(?:test|qa|alpha))?\.sbplayground1\.net$/.test(hostname)) return null;
  return { brand: null, environment: envLabelFromHostname(hostname) };
}

// Resolve the environment of a dist-shape bundle from the artifact version
// recorded in the URL, not from the hostname serving it. A real ALPHA brand
// page can legitimately proxy a `/dist/prod/...` artifact through its own
// `www.alpha.*` host; hostname-only detection therefore labels a PROD build
// as ALPHA. Comparing the brand/device/version against both indexers in the
// same layer identifies the build itself. Multiple matches are retained as
// an honest "shared build" result instead of guessing.
async function resolveDistBundleEnvironments(hostEnv, brandId, device, version) {
  var environments = bundleEnvironmentsInLayer(hostEnv);
  const matches=await Promise.all(environments.map(async function(environment_1) {
		try {
			const indexerData=await fetchBundleIndexer(environment_1);
			var deviceEntry=indexerData&&indexerData[brandId]&&indexerData[brandId][device];
			return deviceEntry&&String(deviceEntry.version)===String(version)? environment_1:null;
		} catch {
			return null;
		}
	}));
	return matches.filter(function(environment_2) { return !!environment_2; });
}

// Brand key -> GUID map, needed ONLY to restrict the reverse-lookup below
// to the one relevant brand (see resolveSandboxBundleInfo comment) - a
// duplicate of content.js's own `BRANDS` map (kept in sync manually; small
// and rarely changes), since background.js is a separate service-worker
// script with no access to content.js's IIFE-scoped constants.
var BUNDLE_BRAND_GUIDS = {
  arcticbet: 'fb047cd8-72db-49b8-912a-d413e7ff5111',
  betfirst: '4a876283-f28e-4396-bb32-d72b02b2e535',
  bethard: 'b174746c-51f9-4e28-8ba8-da9610fca05e',
  bets10: 'a3bd0e8c-37e4-434e-bb71-79c482ecf364',
  betsafe: 'cfe0dfc1-9a3c-41cb-8817-7b3e71fddc9f',
  betsmith: 'abbae10d-550b-4bb1-8f61-183b76f4e06f',
  betsolid: '092219ad-a482-428a-b1a0-47fa005d339d',
  betsson: '6a6d80b9-16ac-4387-a413-244d93a74deb',
  betssonarcb: '46df28af-e0f4-48d6-a3b3-3183b2586c44',
  betssonbr: '599869ba-7757-41ab-9b74-887dbf5c3705',
  betssondk: 'ce5be96a-8e97-4d71-8b04-b4a0dd30cfaa',
  betssones: 'ff28e5bd-a193-4f34-9abe-af70ffbd1dbf',
  betssongr: '4bf6590d-0a29-47f5-a705-42b7a04b7878',
  betssonmx: '563d47e3-6ebf-40e7-9205-ddb28eca6c54',
  btsarba: '238cb63a-3dcc-4fdf-b241-23a12cb71aa7',
  btsarbacity: 'dce5427e-f7f7-41f5-8fb8-8cdcf463541b',
  cherry: '58ad233f-9893-4d38-a079-8b35e976efeb',
  firestorm: '11111111-1111-1111-1111-111111111111',
  firestormsg: '44444444-4444-4444-4444-444444444444',
  guts: 'e017f714-cbcc-4121-a9b4-fa731c2ad87e',
  hovarda: '65213300-f984-4bb6-9f04-e69b775c9945',
  ibet: '1dce6498-f1b2-43c1-8899-5985bcafaefe',
  inkabet: '02a22011-da9c-4b27-9ce6-10eb6b172707',
  jetbahis: '9bfc1a74-9ce9-4d98-9518-1b64659c6b2a',
  mobilbahis: 'ce524a11-e5e4-451b-91be-3af96cae1623',
  nordicbet: '0e5d414b-5234-4050-9fc3-ce1127e18704',
  nordicbetdk: '1cfefbe6-d841-49ee-92b3-87b1fd5444b7',
  playgurus: '63788a1e-5258-45e5-8e73-2047df4e6b6e',
  rexbet: '10cabc10-cbe9-45dd-963a-684227456d54',
  rizk: 'd5362abd-45d7-42e9-9d6d-986ceb1fdf45',
  sandbox: '33333333-3333-3333-3333-333333333333',
  spelklubben: '0fa15607-01c7-4a04-88cc-a633dc755fbd',
  spino: 'da121f62-42fa-461f-b57f-bc1cba78af19',
  triobet: '36e4a5ae-37b5-435a-85fc-e7e1f537e131'
};

function bundleBrandKeyFromGuid(brandId) {
  var keys = Object.keys(BUNDLE_BRAND_GUIDS);
  for (var i = 0; i < keys.length; i += 1) {
    if (BUNDLE_BRAND_GUIDS[keys[i]] === brandId) return keys[i];
  }
  return null;
}

async function resolveSandboxConfigInfo(env, brandId, facadeId, versionHint) {
  const indexerData=await fetchBundleIndexer(env);
	var entry=indexerData&&indexerData[brandId];
	if(!entry) return null;
	var matches=['desktop','mobile'].map(function(device) {
		var deviceEntry=entry[device];
		if(!deviceEntry||!deviceEntry.resourcesByFacade||!deviceEntry.resourcesByFacade[facadeId]) return null;
		var version=String(deviceEntry.version||'');
		if(versionHint&&version.indexOf(String(versionHint))!==0) return null;
		return { device: device,version: version };
	}).filter(function(match) { return !!match; });
	if(!matches.length) return null;
	var versions=matches.map(function(match_1) { return match_1.version; }).filter(function(version_1,index,all) {
		return version_1&&all.indexOf(version_1)===index;
	});
	if(versions.length!==1) return null;
	return { version: versions[0],device: matches.length===1? matches[0].device:null,brandId: brandId };
}

// Reverse-lookup (2026-08-10, revised after live testing): sandbox-shape
// URLs carry no version/device, but the SAME environment's indexer.json
// (already fetched/cached for the Bundle Override feature above, via
// fetchBundleIndexer) can still reveal them. IMPORTANT - live testing
// showed the sandbox host page's OWN `main-<hash>.js` is a genuinely
// different build artifact than the widget's federated entry point listed
// in indexer.json's `js` array (the sandbox page is its own standalone
// Angular app that embeds the `<sb-xp-sportsbook>` widget, not the
// embedded/federated build itself) - so `main-*.js` will almost never
// match indexer.json directly. However, the sandbox page's LAZY-LOADED
// `chunk-<hash>.js` files DO come from the shared widget code and were
// confirmed live to match entries inside indexer.json's per-device
// `resourcesByFacade[*].scripts`/`.links` arrays (these list every chunk
// actually shipped to that facade, unlike the flat `js` array which only
// lists the entry point). CRITICAL correction after further live testing
// (2026-08-10): a plain unrestricted cross-brand search on a chunk match
// is NOT reliable - a shared/common vendor chunk (webpack code-splitting
// of identical third-party dependency code) can have the EXACT SAME
// content-hash filename across dozens of unrelated brands, so searching
// every brand's indexer entry for a chunk match produced 70 matches
// spanning brands on genuinely different versions - the "match is
// effectively unique" assumption held for the flat `js` array (unique
// entry-point hash) but does NOT hold for shared chunks. The fix: use the
// sandbox host's OWN hostname-detected brand (already resolved by
// detectBrandAndEnvFromPlaygroundHost at the call site) via
// BUNDLE_BRAND_GUIDS to restrict the search to that ONE brand's indexer
// entry whenever the brand is known - eliminating the cross-brand
// collision entirely. Only falls back to a full cross-brand scan if the
// brand key has no known GUID (should not normally happen, since the
// caller only proceeds after a successful playground-host brand
// detection, but kept as a defensive fallback).
async function resolveSandboxBundleInfo(env, filename, brandKey) {
  const indexerData=await fetchBundleIndexer(env);
	var matches=[]; // {device, version, brandId, exact}
	var knownGuid=brandKey&&BUNDLE_BRAND_GUIDS[brandKey];
	var brandIdsToSearch=knownGuid? [knownGuid]:Object.keys(indexerData||{});
	brandIdsToSearch.forEach(function(brandId) {
		var entry=indexerData[brandId];
		['desktop','mobile'].forEach(function(device) {
			var deviceEntry=entry&&entry[device];
			if(!deviceEntry) return;
			var exact=(deviceEntry.js||[]).some(function(fileUrl) {
				return (fileUrl||'').split('/').pop()===filename;
			});
			var chunkHit=false;
			if(!exact&&deviceEntry.resourcesByFacade) {
				chunkHit=Object.keys(deviceEntry.resourcesByFacade).some(function(facadeId) {
					var f=deviceEntry.resourcesByFacade[facadeId];
					// scripts/links are ARRAYS of individual <script>/<link> tag
					// strings (confirmed live 2026-08-10 via direct SW
					// inspection) - NOT one big concatenated HTML string, so each
					// element must be searched individually rather than calling
					// .indexOf(filename) on the array itself (which only checks
					// for an exact whole-element match, never a substring).
					var inScripts=Array.isArray(f&&f.scripts)&&f.scripts.some(function(s) { return s.indexOf(filename)!==-1; });
					var inLinks=Array.isArray(f&&f.links)&&f.links.some(function(s_1) { return s_1.indexOf(filename)!==-1; });
					return inScripts||inLinks;
				});
			}
			if(exact||chunkHit) {
				matches.push({ device: device,version: deviceEntry.version||null,brandId: brandId,exact: exact });
			}
		});
	});
	if(!matches.length) return null;
	// Prefer an exact entry-point match over a chunk match if both somehow
	// occurred; otherwise use all chunk matches found.
	var exactMatches=matches.filter(function(m) { return m.exact; });
	var pool=exactMatches.length? exactMatches:matches;
	var versions=pool.map(function(m_1) { return m_1.version; }).filter(function(v,i,arr) { return v&&arr.indexOf(v)===i; });
	var devices=pool.map(function(m_2) { return m_2.device; }).filter(function(d,i_1,arr_1) { return arr_1.indexOf(d)===i_1; });
	if(versions.length!==1) return null; // ambiguous across brands/
	return {
		version: versions[0],
		device: devices.length===1? devices[0]:null,
		brandId: pool[0].brandId
	};
}

async function observeBuildRequest(details) {
  if (details.tabId == null || details.tabId < 0) return;
  const hostname = new URL(details.url).hostname;
  const hostEnv = envLabelFromHostname(hostname);
  if (isBleExcludedRequest(details.url, hostEnv)) return;
  const match = BUNDLE_OBSERVE_RE.exec(details.url);
  if (match) {
    const observation = {
      layer: 'mfe', brandId: match[2], brand: bundleBrandKeyFromGuid(match[2]), version: match[3], device: match[4],
      host: hostname, hostEnv, artifactEnv: null, artifactEnvs: [], artifactResolutionPending: true, url: details.url, ts: Date.now()
    };
    const token = await detection.observe(details, 'mfe', observation);
    let artifactEnvs = [];
    try { artifactEnvs = await resolveDistBundleEnvironments(hostEnv, observation.brandId, observation.device, observation.version); }
    catch (error) { console.warn('[link-gen-tool] artifact lookup failed:', error); }
    await detection.enrich(details, 'mfe', token, current => {
      current.artifactEnvs = artifactEnvs;
      current.artifactEnv = artifactEnvs.length === 1 ? artifactEnvs[0] : null;
      current.artifactResolutionPending = false;
    });
    return;
  }
  const config = BUNDLE_OBSERVE_SANDBOX_CONFIG_RE.exec(details.url);
  if (config) {
    const brandId = config[2].toLowerCase();
    const token = await detection.observe(details, 'iframe', {
      layer: 'iframe', brandId, brand: bundleBrandKeyFromGuid(brandId), version: config[4], device: null,
      headerVersion: null, host: hostname, hostEnv, url: details.url, ts: Date.now()
    });
    const found = await resolveSandboxConfigInfo(hostEnv, brandId, config[3].toLowerCase(), config[4]);
    if (found) await detection.enrich(details, 'iframe', token, current => {
      current.version = found.version; current.device = found.device; current.matchedBrandId = found.brandId;
      current.brand = current.brand || bundleBrandKeyFromGuid(found.brandId);
    });
    return;
  }
  if (!BUNDLE_OBSERVE_SANDBOX_RE.exec(details.url)) return;
  const prior = await detection.current(details, 'iframe');
  if (!prior) return;
  const known = detectBrandAndEnvFromPlaygroundHost(hostname) || genericSandboxInfoFromHostname(hostname);
  const lookupBrand = known?.brand || prior.observation.brand;
  const lookupEnv = known?.environment || prior.observation.hostEnv;
  if (!lookupBrand || !lookupEnv) return;
  const filename = details.url.split('/').pop().split('?')[0].split('#')[0];
  const found = await resolveSandboxBundleInfo(lookupEnv, filename, lookupBrand);
  if (found) await detection.enrich(details, 'iframe', prior.token, current => {
    current.version = current.version || found.version;
    current.device = current.device || found.device;
    current.matchedBrandId = current.matchedBrandId || found.brandId;
  });
}

chrome.webRequest.onBeforeRequest.addListener(details => {
  void observeTask(observeBuildRequest(details), 'build observation');
}, { urls: ['*://*/dist/*/xp/widgets/sportsbook/*', '*://*/dist/*/config/*', '*://*/assets/*'], types: ['script', 'xmlhttprequest'] });

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId == null || details.tabId < 0) return;
  const hostEnv = envLabelFromHostname(new URL(details.url).hostname);
  if (isBleExcludedRequest(details.url, hostEnv)) return;
  const header = (details.responseHeaders || []).find(value => String(value.name).toLowerCase() === 'x-sb-app-version');
  if (header?.value != null) void observeTask(detection.header(details, header.value), 'version header');
}, { urls: ['*://*/*sb/fe-api/*', '*://*/*api/sb/v1/*'] }, ['responseHeaders', 'extraHeaders']);

chrome.webNavigation.onCommitted.addListener(details => {
  let hostname;
  try { hostname = new URL(details.url).hostname; } catch (_) { return; }
  if (!hostname) return;
  const info = detectBrandAndEnvFromPlaygroundHost(hostname);
  void observeTask(detection.committed(details, {
    url: details.url, hostname, env: info?.environment || envLabelFromHostname(hostname), brand: info?.brand
  }), 'committed document');
});

handleMessage('lgt-layer-marker', async function (msg, sender) {
  senderTabId(sender);
  // Reject reports from a document that has navigated away, even if its relay
  // was queued before Chrome delivered our onCommitted event.
  if (sender.documentId) {
    const current = await chromeCall(chrome.webNavigation, 'getFrame', { tabId: sender.tab.id, frameId: sender.frameId || 0 });
    if (!current || current.documentId !== sender.documentId) return { ok: true, ignored: true };
  }
  await detection.markers(sender, msg.markers);
  return { ok: true };
});

function normalizeVersion(value) { return String(value == null ? '' : value).trim().replace(/^v/i, ''); }
function normalizeEnv(value) { return String(value == null ? '' : value).trim().toLowerCase(); }

// The confidence classifier - brand+layer+device is ALWAYS the unit of
// comparison; a common chunk hash or version shared by unrelated brands
// never causes cross-brand mixing because every network observation is
// already scoped to the ONE brandId the indexer/config request itself
// named (see resolveSandboxBundleInfo's own single-brand restriction).
function computeDetectionRows(snapshot) {
  var runtimeByFrame = snapshot.runtimeByFrame || {};
  var networkByFrame = snapshot.networkByFrame || {};
  var docByFrame = snapshot.docByFrame || {};
  var frameIds = Object.keys(Object.assign({}, runtimeByFrame, networkByFrame));
  var rows = [];

  frameIds.forEach(function (frameIdStr) {
    var frameId = Number(frameIdStr);
    var runtimeLayers = runtimeByFrame[frameId] || {};
    var networkLayers = networkByFrame[frameId] || {};
    var doc = docByFrame[frameId];
    var hasAnyRuntimeMarker = Object.keys(runtimeLayers).length > 0;
    var frameRows = [];

    if (!hasAnyRuntimeMarker) {
      // Network evidence with no runtime marker at all in this frame -
      // Unclassified: brand shown (if resolvable), but deliberately no
      // assumed layer label.
      Object.keys(networkLayers).forEach(function (layer) {
        var net = networkLayers[layer];
        var brandKey = net.matchedBrandId ? bundleBrandKeyFromGuid(net.matchedBrandId) : (net.brand || (doc && doc.brand));
        rows.push({
          tabId: tabId, frameId: frameId, layer: null, status: 'unclassified',
          brand: brandKey, brandId: net.matchedBrandId || net.brandId,
          device: net.device || null,
          version: net.version || net.headerVersion || null,
          environment: net.artifactEnv || (net.artifactEnvs && net.artifactEnvs.length === 1 ? net.artifactEnvs[0] : null) || net.hostEnv || (doc && doc.env) || null,
          detail: 'Network hit with no runtime layer marker in this frame.'
        });
      });
      return;
    }

    ['mfe', 'iframe', 'nodejs'].forEach(function (layer) {
      var runtime = runtimeLayers[layer];
      var net = networkLayers[layer];
      if (!runtime && !net) return;

      var runtimeBrandKey = runtime ? brandKeyFromMarker(runtime.brandId, runtime.brandName) : null;
      var networkBrandKey = net ? (net.matchedBrandId ? bundleBrandKeyFromGuid(net.matchedBrandId) : net.brand) : null;
      var brandKey = runtimeBrandKey || networkBrandKey || (doc && doc.brand) || null;

      var runtimeVersion = runtime ? normalizeVersion(runtime.version) : '';
      var networkVersion = net ? normalizeVersion(net.version || net.headerVersion) : '';
      var runtimeEnv = runtime ? normalizeEnv(runtime.environment) : '';
      var networkEnv = net ? normalizeEnv(net.artifactEnv || (net.artifactEnvs && net.artifactEnvs.length === 1 ? net.artifactEnvs[0] : '') || net.hostEnv || (layer === 'nodejs' && doc ? doc.env : '')) : '';

      // A Bundle Override the user (or the Bundle tab) deliberately applied
      // on THIS tab causes one specific, fully-deterministic divergence:
      // the runtime marker keeps reporting the layer's base
      // environment/version (the page's own pinned startup context never
      // gets un-pinned by a network-level redirect) while the network side
      // correctly reflects the override target. Recognizing that exact
      // pattern here means it is explained instead of raised as an
      // unexplained Mismatch - see bundleOverrideExplainsEnvDivergence.
      var overrideExplainsEnvDivergence = !!(runtime && net &&
        bundleOverrideExplainsEnvDivergence(snapshot.bundleTargetEnv, runtimeEnv, networkEnv));

      var conflicts = [];
      if (runtimeBrandKey && networkBrandKey && runtimeBrandKey !== networkBrandKey) conflicts.push('brand: runtime=' + runtimeBrandKey + ' vs network=' + networkBrandKey);
      if (!overrideExplainsEnvDivergence) {
        if (runtimeVersion && networkVersion && runtimeVersion !== networkVersion) conflicts.push('version: runtime=v' + runtimeVersion + ' vs network=v' + networkVersion);
        if (runtimeEnv && networkEnv && runtimeEnv !== networkEnv) conflicts.push('environment: runtime=' + runtimeEnv.toUpperCase() + ' vs network=' + networkEnv.toUpperCase());
      }

      // Confirmed: both runtime and network evidence exist for this
      // brand+layer+device, and version+environment are each present on
      // BOTH sides with no conflict. Partially verified: the layer is
      // recognized (a runtime marker exists) but some value only has one
      // reliable source (missing on either side, or network evidence
      // absent entirely). Mismatch takes priority over both whenever any
      // conflict was recorded above.
      var status;
      if (conflicts.length) {
        status = 'mismatch';
      } else if (runtime && net && runtimeVersion && networkVersion && runtimeEnv && networkEnv) {
        status = 'confirmed';
      } else {
        status = 'partial';
      }

      // Partial's own detail: which specific piece of evidence is still
      // missing, so a user doesn't have to guess (or ask) why a row
      // hasn't reached Confirmed - most commonly this self-resolves a
      // few seconds after page load (the network side needs a moment to
      // catch up with the runtime marker), but if it never resolves this
      // pinpoints exactly which side/value is missing.
      var partialReasons = [];
      if (status === 'partial') {
        if (!runtime) partialReasons.push('no runtime layer marker seen in this frame yet');
        if (!net) partialReasons.push('no network confirmation seen for this layer yet');
        if (runtime && net) {
          if (!runtimeVersion) partialReasons.push('runtime marker has no version');
          if (!networkVersion) partialReasons.push('network evidence has no version');
          if (!runtimeEnv) partialReasons.push('runtime marker has no environment');
          if (!networkEnv) partialReasons.push('network evidence has no environment');
        }
      }

      // The row's headline version/environment ALWAYS prefers network
      // evidence over the runtime marker whenever network evidence
      // exists - consistently, in EVERY status (Confirmed, Partially
      // verified, AND Mismatch alike). This used to only apply when an
      // active Bundle Override explained the split, and fell back to
      // showing the raw runtime value for an unexplained Mismatch - which
      // produced a real, reported anomaly: the same underlying fact (the
      // runtime marker on a given brand page is invariably pinned to its
      // layer's base build, e.g. PROD, no matter what is actually
      // running - independently verified live: a real, successful ALPHA
      // Bundle Override left 34/34 redirected requests returning 200 with
      // real ALPHA content, yet the runtime marker read back
      // byte-for-byte identical to its un-overridden value) was DISPLAYED
      // inconsistently - as "ALPHA" in the explained/Confirmed case (since
      // network was substituted in) and as "PROD" in an unexplained
      // Mismatch case (since runtime was shown raw), even though in both
      // cases runtime itself never said anything but the pinned base
      // value. Network evidence is a direct observation of which files
      // were actually requested and loaded, so it is the more meaningful
      // "what's really running" signal in every case - the Confirmed vs
      // Mismatch STATUS is what tells the user whether that value is
      // trusted/explained or flagged as a real, unexplained conflict; the
      // headline value itself no longer flips between two different
      // selection rules depending on which bucket a row lands in.
      var bundleOverrideNote = overrideExplainsEnvDivergence
        ? ('Bundle Override active (target ' + snapshot.bundleTargetEnv.toUpperCase() + '): runtime marker still reports the base build v' +
          runtimeVersion + '/' + runtimeEnv.toUpperCase() + ' - this brand\'s startup context stays pinned to its base environment even once overridden; network evidence v' +
          networkVersion + '/' + networkEnv.toUpperCase() + ' reflects what is actually running and is shown here.')
        : null;

      frameRows.push({
        tabId: tabId, frameId: frameId, layer: layer, status: status,
        brand: brandKey, brandId: (runtime && runtime.brandId) || (net && (net.matchedBrandId || net.brandId)) || null,
        device: net && net.device || null,
        version: (networkVersion || runtimeVersion) || null,
        environment: (networkEnv || runtimeEnv) || null,
        // Raw, unmerged sides - kept alongside the headline fields above
        // (not shown in the header itself) so other UI (the Bundle tab's
        // "Host: <env>" label, which is a URL/hostname heuristic, not a
        // measurement) can cross-check itself against what the page's
        // OWN runtime marker actually reports, e.g. to warn the user
        // when a domain nominally named e.g. "alpha.betsson.com" is, on
        // this specific browser/network, actually silently served its
        // PROD fallback build (a real, verified platform characteristic
        // for sessions without true ALPHA edge access - independent of
        // any Bundle Override).
        runtimeEnvironment: runtimeEnv || null,
        networkEnvironment: networkEnv || null,
        detail: conflicts.join('; ') || partialReasons.join('; ') || bundleOverrideNote || null
      });
    });

    // Two layers in the SAME frame that both reach Confirmed on the exact
    // same brand+version+environment+device are not two independently
    // swappable architectures - some brands run a genuinely hybrid
    // runtime (e.g. an mFE app layered on top of the legacy OBGA/"Fabric"
    // context, which the mFE app deliberately also populates for
    // backward compatibility with older tooling). Since the numbers are
    // identical, showing two rows is just noise - merge them into ONE
    // row that lists every agreeing layer, instead of repeating the same
    // version/environment/status twice.
    var mergedFrameRows = [];
    var consumed = {};
    frameRows.forEach(function (row, i) {
      if (consumed[i]) return;
      consumed[i] = true;
      if (row.status !== 'confirmed') { mergedFrameRows.push(row); return; }
      var group = [row];
      frameRows.forEach(function (other, j) {
        if (consumed[j] || other.status !== 'confirmed' || other.layer === row.layer) return;
        if (other.brand === row.brand && other.version === row.version &&
            other.environment === row.environment && other.device === row.device) {
          group.push(other);
          consumed[j] = true;
        }
      });
      if (group.length === 1) { mergedFrameRows.push(row); return; }
      mergedFrameRows.push({
        tabId: row.tabId, frameId: row.frameId, layer: null,
        layers: group.map(function (r) { return r.layer; }),
        status: 'confirmed', brand: row.brand, brandId: row.brandId,
        device: row.device, version: row.version, environment: row.environment,
        // A plain hybrid merge has nothing left to explain (both layers
        // simply agree), but if any layer in the group carried a Bundle
        // Override note (the only detail a 'confirmed' row can ever have),
        // that is real, actionable state - not merge-implementation
        // trivia - so it must survive the merge, not get discarded.
        detail: group.map(function (r) { return r.detail; }).filter(Boolean)[0] || null
      });
    });

    Array.prototype.push.apply(rows, mergedFrameRows);
  });

  return rows;
}

handleMessage('lgt-detection-rows', async function (msg, sender) {
  const tabId = senderTabId(sender);
  const snapshot = await detection.snapshot(tabId);
  snapshot.bundleTargetEnv = bundleTargetEnvFromRules((await dnr.status('bundle', tabId)).rules);
  return { ok: true, rows: computeDetectionRows(snapshot) };
});

// Opens a NEW tab for the given generated link with Sportradar spoofing
// already active before the page starts loading (unlike "Embed here",
// this acts on a brand-new tab it creates itself, not the current one -
// the widget needs to run on the generated link's OWN page).
handleMessage('lgt-open-with-sr-spoof', async function (msg, sender) {
  if (!msg.url || !msg.spoofOrigin) throw new Error('missing url or spoofOrigin');
  const origin = new URL(msg.url).origin;
  const tab = await chromeCall(chrome.tabs, 'create', { url: 'about:blank', active: true });
  try {
    await startSrSpoofRule(tab.id, msg.spoofOrigin, undefined, origin);
    await chromeCall(chrome.tabs, 'update', tab.id, { url: msg.url });
    return { ok: true, tabId: tab.id };
  } catch (error) { await stopSrSpoofRule(tab.id); throw error; }
});

// Toolbar icon click toggles the panel in the active tab's content script.
// The content script itself is always injected (document_idle, every page/
// navigation) and always listening - it just keeps the panel hidden by
// default until told to show, or until an in-progress auto-login resume
// shows it automatically.
chrome.action.onClicked.addListener(function (tab) {
  if (!tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: 'lgt-toggle-panel' }, function () {
    // Swallow "Receiving end does not exist" - happens on pages the
    // content script can't run on (chrome://, the Web Store, etc).
    void chrome.runtime.lastError;
  });
});
