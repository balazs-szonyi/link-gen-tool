/*
 * Link Gen Tool extension - background service worker.
 *
 * Captures x-sb-static-context-id / x-sb-user-context-id headers via
 * chrome.webRequest.onSendHeaders - a NETWORK-LAYER observation, entirely
 * independent of page JS timing. This closes the root cause behind the
 * bookmarklet's flaky passive capture: a bundled SPA that grabs a reference
 * to the native `fetch` at its own module-init time (milliseconds after
 * page load, before any bookmarklet click is even possible) makes an
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
 * re-injection machinery of any kind, unlike the bookmarklet's v10-v13
 * fixes for the same problem class.
 */
'use strict';

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
    chrome.storage.local.get([key], function (res) {
      var entry = (res && res[key]) || { stc: null, ctx: null, source: null, seenCount: 0 };
      entry.seenCount = (entry.seenCount || 0) + 1;
      if (stc && ctx) {
        entry.stc = stc;
        entry.ctx = ctx;
        entry.source = details.url;
      }
      var obj = {};
      obj[key] = entry;
      chrome.storage.local.set(obj);
    });
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
// simulation (this affected both the bookmarklet and this extension's
// content.js equally, since content scripts run in the same "not a real
// user" trust tier no matter how they're delivered). chrome.debugger is
// different: it's a background-service-worker-only API (content scripts
// cannot call it) that attaches Chrome DevTools Protocol to the tab and
// injects input via the same Input.dispatchMouseEvent/dispatchKeyEvent
// pipeline real DevTools/Playwright use - indistinguishable from a real
// user to the page, so isTrusted-gated handlers fire normally. This is
// the one "not the bookmarklet anymore" capability that actually matters
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

function sendDebuggerCommand(tabId, method, params) {
  return new Promise(function (resolve, reject) {
    chrome.debugger.sendCommand({ tabId: tabId }, method, params || {}, function (result) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(result);
    });
  });
}

function attachDebugger(tabId) {
  return new Promise(function (resolve, reject) {
    chrome.debugger.attach({ tabId: tabId }, '1.3', function () {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve();
    });
  }).then(function () {
    // Fixes the 0a race condition: a tab created with active:false has
    // never been visible, so Chrome doesn't route keyboard/mouse focus to
    // it and (on some pages) delays compositing - trusted CDP input then
    // has nothing to hit-test/focus against until the user manually
    // clicks the tab, at which point it suddenly becomes real. Emulation.
    // setFocusEmulationEnabled is the CDP-documented fix for exactly this
    // ("simulate a focused and active page, even if the browser window is
    // not visible") - it makes document.hasFocus()/:focus-visible and
    // real DOM/input-widget focus behave as if the tab were frontmost,
    // without ever actually stealing the user's real window/tab focus.
    // Page.setWebLifecycleState('active') additionally guards against
    // Chrome's own page-freezing/backgrounding heuristics interfering
    // mid-sequence. Both are best-effort (older Chrome builds or odd page
    // states could reject either) - a rejection here should never break
    // the actual login attempt, just fall back to the pre-fix behavior.
    return sendDebuggerCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(function () {})
      .then(function () { return sendDebuggerCommand(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(function () {}); });
  });
}

function detachDebugger(tabId) {
  return new Promise(function (resolve) {
    chrome.debugger.detach({ tabId: tabId }, function () {
      void chrome.runtime.lastError; // ignore - already detached is fine
      resolve();
    });
  });
}

function trustedClick(tabId, x, y) {
  return sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y })
    .then(function () { return sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1 }); })
    .then(function () { return sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1 }); });
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
function trustedType(tabId, text) {
  var chars = String(text || '').split('');
  return chars.reduce(function (chain, ch) {
    return chain
      .then(function () { return sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', text: ch, unmodifiedText: ch, key: ch }); })
      .then(function () { return sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', { type: 'char', text: ch }); })
      .then(function () { return sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch, key: ch }); })
      .then(function () { return sleep(10 + Math.random() * 25); });
  }, Promise.resolve());
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

function trustedKey(tabId, keyName) {
  var k = NAMED_KEYS[keyName];
  if (!k) return Promise.resolve();
  var downType = k.downType || 'rawKeyDown';
  var payload = { key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.nativeVirtualKeyCode, text: k.text, unmodifiedText: k.unmodifiedText };
  var down = Object.assign({ type: downType }, payload);
  var up = Object.assign({ type: 'keyUp' }, payload);
  return sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', down)
    .then(function () { return sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', up); });
}

// Tabs whose debugger/focus-emulation is being held attached for an
// entire silent-job lifetime (see lgt-debugger-keepalive-start/stop
// below) - runTrustedSequence must neither re-attach (attach() on an
// already-attached-by-us tab is a needless extra round trip and, on some
// Chrome builds, briefly re-flashes the "started debugging" infobar) nor
// detach when it's done (that would tear down the very focus-emulation
// the keepalive call was meant to hold for the WHOLE job, not just one
// click/type sequence).
var keepAttachedTabs = new Set();

function runTrustedSequence(tabId, actions) {
  var keptAttached = keepAttachedTabs.has(tabId);
  var attachStep = keptAttached ? Promise.resolve() : attachDebugger(tabId);
  return attachStep.then(function () {
    var chain = Promise.resolve();
    actions.forEach(function (action) {
      chain = chain.then(function () {
        if (action.type === 'click') return trustedClick(tabId, action.x, action.y);
        if (action.type === 'type') return trustedType(tabId, action.text);
        if (action.type === 'key') return trustedKey(tabId, action.key);
        return Promise.resolve();
      }).then(function () { return sleep(action.delayAfter || 80); });
    });
    function maybeDetach() { return keptAttached ? Promise.resolve() : detachDebugger(tabId); }
    return chain.then(
      function () { return maybeDetach().then(function () { return { ok: true }; }); },
      function (err) { return maybeDetach().then(function () { return { ok: false, error: String(err && err.message || err) }; }); }
    );
  }, function (err) {
    return { ok: false, error: String(err && err.message || err) };
  });
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
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-debugger-keepalive-start') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  var tabId = sender.tab.id;
  // A mobile-emulated job (see setupMobileEmulation above) already
  // attached the debugger and added this tab to keepAttachedTabs before
  // its content script ever started running - re-attaching here would
  // just error ("Another debugger is already attached") for no benefit;
  // this call's real job (holding the attach for the whole job) is
  // already satisfied, so just confirm ok.
  if (keepAttachedTabs.has(tabId)) { sendResponse({ ok: true }); return false; }
  attachDebugger(tabId).then(
    function () { keepAttachedTabs.add(tabId); sendResponse({ ok: true }); },
    function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
  );
  return true;
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-debugger-keepalive-stop') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  var tabId = sender.tab.id;
  keepAttachedTabs.delete(tabId);
  detachDebugger(tabId).then(function () { sendResponse({ ok: true }); });
  return true;
});


chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-trusted-sequence') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  runTrustedSequence(sender.tab.id, msg.actions || []).then(sendResponse);
  return true; // keep the message channel open for the async sendResponse
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
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-keepalive') return false;
  sendResponse({ ok: true });
  return false;
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
// afterward. Leaves the tab in `keepAttachedTabs` (same bookkeeping the
// silent-job keepalive mechanism already uses) so content.js's later
// lgt-debugger-keepalive-start call (sent once its own content script
// loads) is recognized as already-held and skips re-attaching, and so
// the existing lgt-debugger-keepalive-stop call (sent when the job
// settles, success or failure) correctly detaches it at the end.
function setupMobileEmulation(tabId, url) {
  return attachDebugger(tabId).then(function () {
    keepAttachedTabs.add(tabId);
    return sendDebuggerCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: 470, height: 944, deviceScaleFactor: 2, mobile: true
    });
  }).then(function () {
    return sendDebuggerCommand(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(function () {});
  }).then(function () {
    return sendDebuggerCommand(tabId, 'Network.enable', {});
  }).then(function () {
    return sendDebuggerCommand(tabId, 'Network.setUserAgentOverride', {
      userAgent: MOBILE_EMULATION_UA,
      platform: 'Android',
      userAgentMetadata: MOBILE_EMULATION_UA_METADATA
    });
  }).then(function () {
    return sendDebuggerCommand(tabId, 'Page.navigate', { url: url });
  });
}

// active:false keeps the tab out of the user's way for its whole (short)
// lifetime; it closes itself via lgt-close-tab once its job settles
// (success or failure alike - there's no reason to leave an inactive tab
// open either way).
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-open-tab') return false;
  // msg.device (new): 'mobile' triggers setupMobileEmulation above before
  // navigating to the real url; anything else (or omitted) is the
  // existing desktop-shaped behavior, unchanged.
  var wantMobile = msg.device === 'mobile';

  function afterTabCreated(tabId) {
    if (tabId == null) { sendResponse({ ok: false, error: 'tab not created' }); return; }
    if (!wantMobile) { sendResponse({ ok: true, tabId: tabId }); return; }
    setupMobileEmulation(tabId, msg.url).then(
      function () { sendResponse({ ok: true, tabId: tabId }); },
      function (err) { sendResponse({ ok: false, error: 'mobile emulation setup failed: ' + String(err && err.message || err) }); }
    );
  }

  // msg.active (item 0b/0c): defaults to false (background/invisible) as
  // before; content.js sets it true when the brand isn't yet proven to
  // work silently, or when the user manually ticks "Show login tab".
  if (msg.active) {
    chrome.tabs.create({ url: wantMobile ? 'about:blank' : msg.url, active: true }, function (tab) {
      if (chrome.runtime.lastError) { sendResponse({ ok: false, error: chrome.runtime.lastError.message }); return; }
      afterTabCreated(tab && tab.id);
    });
    return true;
  }
  // Silent path: a plain active:false tab still lands in the CURRENT
  // window's tab strip - visible (as a background/inactive tab), just not
  // focused. User-confirmed 2026-08-07 this still doesn't read as
  // "silent" (a new tab appearing at all, even unfocused, is exactly what
  // this mode is supposed to avoid - only the Generate button's own
  // loader should indicate anything is happening). Opening it in its own,
  // separately minimized window instead keeps it out of the current
  // window's tab strip entirely.
  //
  // A v1.9.7 attempt to avoid minimizing (positioning the window off any
  // real monitor instead, top/left: -32000) was reverted the same day -
  // Chrome's own chrome.windows.create validation rejects bounds where
  // less than 50% of the window overlaps a real display ("Invalid value
  // for bounds. Bounds must be at least 50% within visible screen space"),
  // so that approach cannot work at all as a fully-invisible option; it
  // isn't a workaround, it's a hard platform rule (deliberately closing
  // exactly this kind of "genuinely invisible window" loophole for
  // anti-abuse reasons). `state: 'minimized'` set at creation time (not as
  // a later update) is what actually avoids an on-screen flash on most
  // Chrome/OS combinations - a create-then-minimize as two steps reliably
  // flashes the new window on screen first.
  //
  // Trade-off this reintroduces: a minimized window's page has
  // document.visibilityState = 'hidden', which pauses/heavily throttles
  // requestAnimationFrame - some brands' login-modal mount/animate-in
  // apparently depends on rAF timing, which can occasionally make an
  // already-slow modal mount even more slowly while minimized (see the
  // un-minimize "nudge" during the slow-mount retry wait in content.js's
  // attemptAutoLogin, which mitigates this without giving up full
  // invisibility for the common/fast case).
  chrome.windows.create({ url: wantMobile ? 'about:blank' : msg.url, focused: false, state: 'minimized' }, function (win) {
    if (chrome.runtime.lastError || !win) { sendResponse({ ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'window not created' }); return; }
    var tab = win.tabs && win.tabs[0];
    if (tab && tab.id != null) { afterTabCreated(tab.id); return; }
    // Some Chrome versions don't populate `tabs` on the just-created
    // Window object - fall back to a tab query scoped to the new window.
    chrome.tabs.query({ windowId: win.id }, function (tabs) {
      var t = tabs && tabs[0];
      afterTabCreated(t && t.id);
    });
  });
  return true;
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
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-window-set-state') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  var state = msg.state === 'minimized' ? 'minimized' : 'normal';
  chrome.tabs.get(sender.tab.id, function (tab) {
    if (chrome.runtime.lastError || !tab || tab.windowId == null) { sendResponse({ ok: false, error: 'no window' }); return; }
    chrome.windows.update(tab.windowId, { state: state, focused: false }, function () {
      void chrome.runtime.lastError; // ignore - e.g. window already closed
      sendResponse({ ok: true });
    });
  });
  return true;
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-close-tab') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  chrome.tabs.remove(sender.tab.id, function () {
    void chrome.runtime.lastError; // ignore - tab may already be gone
    sendResponse({ ok: true });
  });
  return true;
});

// Brings the background tab to the front instead of closing it - used
// when a live-login job fails, so the user can actually see what state
// the real login page was left in (captcha, cookie-consent banner, 2FA
// prompt, unexpected layout, etc.) instead of the tab silently vanishing
// with only a generic error string to go on (added 2026-08-06 after a
// NordicBet failure that couldn't otherwise be diagnosed remotely).
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-focus-tab') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  chrome.tabs.update(sender.tab.id, { active: true }, function (tab) {
    if (chrome.runtime.lastError) { sendResponse({ ok: false, error: chrome.runtime.lastError.message }); return; }
    if (tab && tab.windowId != null) {
      // state: 'normal' is required here, not just focused: true - the
      // silent path above opens the tab in its own state:'minimized'
      // window, and focused:true alone does not reliably restore a
      // minimized window on every platform (it can end up "focused" but
      // still minimized/invisible). top/left reposition it to a sane
      // on-screen spot in case anything nudged it (see lgt-window-set-
      // state) to an unusual position first.
      chrome.windows.update(tab.windowId, { focused: true, state: 'normal', top: 40, left: 40 }, function () {
        void chrome.runtime.lastError;
        sendResponse({ ok: true });
      });
      return;
    }
    sendResponse({ ok: true });
  });
  return true;
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
var embedRuleIdByTab = {}; // tabId -> ruleId

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
function nextUniqueSessionRuleId(startId, endIdExclusive, cb) {
  chrome.declarativeNetRequest.getSessionRules(function (rules) {
    var max = startId - 1;
    (rules || []).forEach(function (r) { if (r.id >= startId && r.id < endIdExclusive && r.id > max) max = r.id; });
    cb(max + 1);
  });
}

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
function getOwnSessionRuleIdsForTab(tabId, startId, endIdExclusive) {
  return new Promise(function (resolve) {
    chrome.declarativeNetRequest.getSessionRules(function (rules) {
      var ids = (rules || []).filter(function (r) {
        return r.id >= startId && r.id < endIdExclusive &&
          r.condition && Array.isArray(r.condition.tabIds) && r.condition.tabIds.indexOf(tabId) !== -1;
      }).map(function (r) { return r.id; });
      resolve(ids);
    });
  });
}

function startEmbedRule(tabId, origin) {
  var previousRuleId = embedRuleIdByTab[tabId]; // swap atomically instead of
  // leaking the old rule - without this, re-clicking "Embed here" in the
  // same tab would leave a stale rule alongside the new one.
  return new Promise(function (resolve, reject) {
    nextUniqueSessionRuleId(EMBED_RULE_ID_START, BLE_DATA_RULE_ID_START, function (ruleId) {
      chrome.declarativeNetRequest.updateSessionRules({
        addRules: [{
          id: ruleId,
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
        }],
        removeRuleIds: previousRuleId ? [previousRuleId] : []
      }, function () {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        embedRuleIdByTab[tabId] = ruleId;
        resolve();
      });
    });
  });
}

function stopEmbedRule(tabId) {
  var ruleId = embedRuleIdByTab[tabId];
  if (!ruleId) return Promise.resolve();
  delete embedRuleIdByTab[tabId];
  return new Promise(function (resolve) {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }, function () {
      void chrome.runtime.lastError; // ignore - rule may already be gone
      resolve();
    });
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-embed-start') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  var tabId = sender.tab.id;
  var origin = msg.origin;
  if (!origin) { sendResponse({ ok: false, error: 'no origin' }); return false; }
  stopEmbedRule(tabId).then(function () { return startEmbedRule(tabId, origin); }).then(function () {
    sendResponse({ ok: true });
  }).catch(function (err) {
    sendResponse({ ok: false, error: String(err && err.message || err) });
  });
  return true;
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-embed-stop') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  stopEmbedRule(sender.tab.id).then(function () { sendResponse({ ok: true }); });
  return true;
});

// Safety net - never leave a header-stripping rule behind on a closed or
// navigated-away-from tab (session rules already vanish on browser
// restart, but a long-lived tab reused for other browsing later
// shouldn't keep silently stripping these headers for that origin).
chrome.tabs.onRemoved.addListener(function (tabId) {
  stopEmbedRule(tabId);
  stopSrSpoofRule(tabId);
  stopBleCorsRule(tabId);
  stopBundleOverrideRule(tabId);
  stopBleDataOverrideRule(tabId);
  keepAttachedTabs.delete(tabId);
  delete bundleObservedByTab[tabId];
});
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.status === 'loading' && embedRuleIdByTab[tabId]) stopEmbedRule(tabId);
  if (changeInfo.status === 'loading' && srSpoofRuleIdByTab[tabId]) {
    // Every navigation (including our OWN deliberate about:blank -> target-
    // URL hop right after the rule is added, and every later manual
    // reload/F5 of the same page) fires a 'loading' status change here, not
    // just "user navigated to a different, unrelated site". Naively
    // stopping the rule on ANY 'loading' event was removing it the instant
    // the real navigation began (or on every refresh), so the page's first
    // Sportradar requests always ran unspoofed and showed the licensing
    // error before the fix could ever apply - confirmed by the user
    // (2026-08-07). Only tear the rule down when the tab is actually
    // navigating to a DIFFERENT origin than the one it was opened for;
    // same-origin reloads/SPA navigations (changeInfo.url absent, or same
    // origin) must keep the rule alive.
    var expectedOrigin = srSpoofExpectedOriginByTab[tabId];
    var navigatingAway = false;
    if (changeInfo.url && expectedOrigin) {
      try { navigatingAway = new URL(changeInfo.url).origin !== expectedOrigin; }
      catch (e) { navigatingAway = false; }
    }
    if (navigatingAway) stopSrSpoofRule(tabId);
  }
  if (changeInfo.status === 'loading' && bleCorsRuleIdByTab[tabId]) {
    // Same "same-origin reload/SPA-nav vs. actually left the page" logic as
    // the Sportradar-spoof cleanup above - a fresh bleSource=1 navigation to
    // the SAME origin re-adds its own replacement rule via onBeforeNavigate
    // anyway, so only tear down here when the tab has genuinely moved to a
    // different origin.
    var bleExpectedOrigin = bleCorsExpectedOriginByTab[tabId];
    var bleNavigatingAway = false;
    if (changeInfo.url && bleExpectedOrigin) {
      try { bleNavigatingAway = new URL(changeInfo.url).origin !== bleExpectedOrigin; }
      catch (e) { bleNavigatingAway = false; }
    }
    if (bleNavigatingAway) stopBleCorsRule(tabId);
  }
  // Bundle Override's own stale-rule cleanup runs in
  // chrome.webNavigation.onBeforeNavigate instead (see the comment there)
  // - onUpdated's 'loading' event fires too late to reliably beat the new
  // page's own first bundle-file request.
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
var srSpoofRuleIdByTab = {}; // tabId -> ruleId
var srSpoofExpectedOriginByTab = {}; // tabId -> origin of the URL the tab was
// opened for, so the onUpdated cleanup listener can tell "still on the same
// page (reload/SPA nav)" apart from "user actually navigated to a different
// site in this tab" (see that listener for why this distinction matters).

function startSrSpoofRule(tabId, spoofOrigin, requestDomains) {
  var previousRuleId = srSpoofRuleIdByTab[tabId]; // swap atomically below instead of
  // leaking the old rule - without this, re-navigating the same tab through
  // this function twice (e.g. auto-detect firing again on a reload, or a
  // brand switch in the same tab) would leave a stale rule alongside the
  // new one, and declarativeNetRequest's behavior with two same-priority
  // modifyHeaders rules matching the same request is not something to rely
  // on.
  return new Promise(function (resolve, reject) {
    nextUniqueSessionRuleId(SR_SPOOF_RULE_ID_START, BLE_CORS_RULE_ID_START, function (ruleId) {
      chrome.declarativeNetRequest.updateSessionRules({
        addRules: [{
          id: ruleId,
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
        }],
        removeRuleIds: previousRuleId ? [previousRuleId] : []
      }, function () {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        srSpoofRuleIdByTab[tabId] = ruleId;
        resolve();
      });
    });
  });
}

function stopSrSpoofRule(tabId) {
  var ruleId = srSpoofRuleIdByTab[tabId];
  if (!ruleId) return Promise.resolve();
  delete srSpoofRuleIdByTab[tabId];
  delete srSpoofExpectedOriginByTab[tabId];
  return new Promise(function (resolve) {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }, function () {
      void chrome.runtime.lastError; // ignore - rule may already be gone
      resolve();
    });
  });
}

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

if (chrome.webNavigation && chrome.webNavigation.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener(function (details) {
    if (details.frameId !== 0) return; // top-level navigations only

    // Bundle Override stale-rule cleanup (2026-08-10 fix) - MUST run here,
    // in onBeforeNavigate (fires before the navigation's own first request
    // goes out), not in chrome.tabs.onUpdated's 'loading' event (which
    // fires too late in practice: the async declarativeNetRequest rule
    // removal was still in flight by the time the new page's first script
    // request already matched the stale rule, confirmed by a live repro
    // where the old removal-on-'loading' approach still let the override
    // carry over - the whole point is to guarantee removal happens BEFORE
    // any request the new page makes, not merely "eventually"). Placed
    // ahead of the playground-host detection below and NOT gated on it,
    // since Bundle Override must be cleared even if the tab is navigating
    // away to something that isn't itself a recognized playground host.
    // Deliberately compares the FULL URL, not just the origin - unlike BLE
    // Data below, the Bundle redirect condition (urlFilter matching
    // brandId/device/prefix, see buildBundleRedirectRules) is NOT anchored
    // to a specific host, so it would otherwise keep silently redirecting
    // the bundle on ANY other same-origin page the user browses to next in
    // this tab - confirmed as the actual real-world bug this cleanup
    // exists to prevent (see test-bundle-override-stale-cleanup.cjs).
    if (bundleRuleIdsByTab[details.tabId]) {
      var bundleExpectedUrl = bundleExpectedUrlByTab[details.tabId];
      if (bundleExpectedUrl && details.url !== bundleExpectedUrl) {
        stopBundleOverrideRule(details.tabId).catch(function (err) {
          console.warn('[link-gen-tool] stale Bundle Override cleanup failed:', err);
        });
      }
    }

    // Same stale-rule cleanup intent, but for BLE Data Override compares
    // only the ORIGIN, not the full URL (2026-08-10 follow-up fix, real
    // bug: BLE Data's redirect condition IS anchored to a specific host
    // (regexFilter built from escapeRegexLiteral(currentHost) - see
    // startBleDataOverrideRule), so it can only ever match requests from
    // that exact host regardless of path/query - a same-origin
    // reload/redirect/query-param change (common on SPA sportsbook pages)
    // does NOT invalidate it, but comparing the exact full URL string was
    // wrongly treating any such change as "navigated away" and tearing the
    // override down before the reloaded page's own requests went out -
    // confirmed live (2026-08-10): applying BLE Data + Bundle Override
    // together, then reloading, left BLE Data reporting "not active" and
    // no fresh data flowing, while Bundle Override (already origin-
    // tolerant via its own, unrelated urlFilter pattern) kept working.
    // Only a genuinely different ORIGIN un-anchors the redirect regex, so
    // only that should clear it - matches the same reasoning already
    // proven for the Sportradar-spoof rule below (see its onUpdated
    // 'loading' handler comment).
    if (bleDataRuleIdsByTab[details.tabId]) {
      var bleDataExpectedOrigin = bleDataExpectedOriginByTab[details.tabId];
      var navOrigin;
      try { navOrigin = new URL(details.url).origin; } catch (e) { navOrigin = null; }
      if (bleDataExpectedOrigin && navOrigin && navOrigin !== bleDataExpectedOrigin) {
        stopBleDataOverrideRule(details.tabId).catch(function (err) {
          console.warn('[link-gen-tool] stale BLE Data Override cleanup failed:', err);
        });
      }
    }

    var hostname;
    try { hostname = new URL(details.url).hostname; } catch (e) { return; }
    var info = detectBrandAndEnvFromPlaygroundHost(hostname);
    if (!info) return;

    // bleSource=1 mobile CORS fix - see comment block above startBleCorsRule.
    // Deliberately independent of the Sportradar-spoof machinery below (does
    // NOT require a resolvable real brand domain/spoofOrigin - it only needs
    // the playground suffix, which every entry in PLAYGROUND_HOST_SUFFIX
    // already has); only gated on the URL actually carrying bleSource=1.
    var isBleSource = false;
    try { isBleSource = new URL(details.url).searchParams.get('bleSource') === '1'; } catch (e) { /* ignore */ }
    if (isBleSource) {
      var playgroundSuffix = PLAYGROUND_HOST_SUFFIX[info.brand];
      if (playgroundSuffix) {
        var bleTabId = details.tabId;
        try { bleCorsExpectedOriginByTab[bleTabId] = new URL(details.url).origin; } catch (e) { /* ignore */ }
        startBleCorsRule(bleTabId, playgroundSuffix).catch(function (err) {
          console.warn('[link-gen-tool] auto bleSource CORS fix failed:', err);
        });
      }
    }

    var spoofOrigin = realBrandOriginBg(info.brand, info.environment);
    if (!spoofOrigin) return;
    chrome.storage.local.get([SR_SPOOF_SETTING_KEY], function (res) {
      var enabled = !res || typeof res[SR_SPOOF_SETTING_KEY] !== 'boolean' || res[SR_SPOOF_SETTING_KEY];
      if (!enabled) return;
      var tabId = details.tabId;
      try { srSpoofExpectedOriginByTab[tabId] = new URL(details.url).origin; } catch (e) { /* ignore */ }
      startSrSpoofRule(tabId, spoofOrigin).catch(function (err) {
        console.warn('[link-gen-tool] auto Sportradar spoof failed:', err);
      });
    });
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
var bleCorsRuleIdByTab = {}; // tabId -> ruleId
var bleCorsExpectedOriginByTab = {}; // tabId -> origin of the URL the tab was
// opened for, same "reload/SPA-nav vs actually left the page" distinction as
// srSpoofExpectedOriginByTab above.

function startBleCorsRule(tabId, playgroundSuffix) {
  var previousRuleId = bleCorsRuleIdByTab[tabId];
  return new Promise(function (resolve, reject) {
    nextUniqueSessionRuleId(BLE_CORS_RULE_ID_START, BLE_CORS_RULE_ID_END, function (ruleId) {
      chrome.declarativeNetRequest.updateSessionRules({
        addRules: [{
          id: ruleId,
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
        }],
        removeRuleIds: previousRuleId ? [previousRuleId] : []
      }, function () {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        bleCorsRuleIdByTab[tabId] = ruleId;
        resolve();
      });
    });
  });
}

function stopBleCorsRule(tabId) {
  var ruleId = bleCorsRuleIdByTab[tabId];
  if (!ruleId) return Promise.resolve();
  delete bleCorsRuleIdByTab[tabId];
  delete bleCorsExpectedOriginByTab[tabId];
  return new Promise(function (resolve) {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }, function () {
      void chrome.runtime.lastError; // ignore - rule may already be gone
      resolve();
    });
  });
}

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
var bleDataRuleIdsByTab = {}; // tabId -> [redirectRuleId, headerRuleId]
var bleDataExpectedOriginByTab = {}; // tabId -> the ORIGIN the override was
// applied for, same stale-cleanup role as bundleExpectedOriginByTab above.

function escapeRegexLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function startBleDataOverrideRule(tabId, currentHost, alphaHost, stc, ctx) {
  var previousRuleIds = bleDataRuleIdsByTab[tabId];
  return new Promise(function (resolve, reject) {
    nextUniqueSessionRuleIds(BLE_DATA_RULE_ID_START, BUNDLE_RULE_ID_START, 2, function (ruleIds) {
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
      chrome.declarativeNetRequest.updateSessionRules({
        addRules: [redirectRule, headerRule],
        removeRuleIds: previousRuleIds || []
      }, function () {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        bleDataRuleIdsByTab[tabId] = [redirectRule.id, headerRule.id];
        resolve();
      });
    });
  });
}

function stopBleDataOverrideRule(tabId) {
  var ruleIds = bleDataRuleIdsByTab[tabId];
  delete bleDataExpectedOriginByTab[tabId];
  delete bleDataRuleIdsByTab[tabId];
  // Also query the browser's own live session rules for this tab/id-range,
  // not just the in-memory map - a service-worker restart between Apply
  // and Stop/navigation wipes bleDataRuleIdsByTab (plain JS variable) but
  // NOT the actual declarativeNetRequest session rules (those persist
  // across SW restarts within the same browser session), so trusting the
  // memory map alone can silently leave a real rule behind uncleared.
  return getOwnSessionRuleIdsForTab(tabId, BLE_DATA_RULE_ID_START, BUNDLE_RULE_ID_START).then(function (liveIds) {
    var allIds = (ruleIds || []).concat(liveIds).filter(function (id, i, arr) { return arr.indexOf(id) === i; });
    if (!allIds.length) return;
    return new Promise(function (resolve) {
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: allIds }, function () {
        void chrome.runtime.lastError; // ignore - rules may already be gone
        resolve();
      });
    });
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-ble-data-start') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  var tabId = sender.tab.id;
  var alphaHost = msg.alphaHost, stc = msg.stc, ctx = msg.ctx;
  if (!alphaHost || !stc || !ctx) { sendResponse({ ok: false, error: 'missing alphaHost, stc, or ctx' }); return false; }
  var currentHost, currentOrigin;
  try {
    var u = new URL(sender.tab.url);
    currentHost = u.hostname;
    currentOrigin = u.origin;
  } catch (e) { sendResponse({ ok: false, error: 'could not read current tab URL' }); return false; }
  if (currentOrigin) bleDataExpectedOriginByTab[tabId] = currentOrigin;
  startBleDataOverrideRule(tabId, currentHost, alphaHost, stc, ctx).then(function () {
    sendResponse({ ok: true });
  }).catch(function (err) {
    sendResponse({ ok: false, error: String(err && err.message || err) });
  });
  return true;
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-ble-data-stop') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  stopBleDataOverrideRule(sender.tab.id).then(function () { sendResponse({ ok: true }); });
  return true;
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-ble-data-status') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  var tabId = sender.tab.id;
  // Derive truth from the browser's own live session rules, not just the
  // in-memory map (see stopBleDataOverrideRule comment above for why the
  // map alone is unsafe after a service-worker restart) - resync the map
  // from whatever is actually still registered so later stop/reapply
  // calls stay consistent.
  getOwnSessionRuleIdsForTab(tabId, BLE_DATA_RULE_ID_START, BUNDLE_RULE_ID_START).then(function (liveIds) {
    if (liveIds.length) bleDataRuleIdsByTab[tabId] = liveIds;
    else delete bleDataRuleIdsByTab[tabId];
    sendResponse({ ok: true, active: liveIds.length > 0 });
  });
  return true;
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
var bundleRuleIdsByTab = {}; // tabId -> ruleId[] - an override can add up
// to ~4 rules at once (2 devices x N files-per-device), unlike the single-
// rule-per-tab features above, so this tracks an array, not one id.
var bundleExpectedUrlByTab = {}; // tabId -> the FULL URL (not just origin)
// the tab was showing when Bundle Override was applied - see the
// stale-cleanup logic in chrome.webNavigation.onBeforeNavigate above for
// why this must be the whole URL, unlike the origin-only tracking used by
// BLE Data Override/Sportradar-spoof/BLE-CORS.
var bundleMatchedByTab = {}; // tabId -> {ruleId, requestUrl, timestamp}[] -
// populated by the onRuleMatchedDebug listener below, purely for the
// Bundle tab's own "N request(s) redirected" status readout - the same
// verification role the standalone tool's Service Worker console log
// plays (see REFERENCE.md "Debugging").

var bundleIndexerCache = {}; // targetEnv -> {ts, data} - avoids re-fetching
// indexer.json on every single Apply click while the Bundle tab stays
// open; intentionally not persisted anywhere and lost on a service-worker
// restart, which just means the next Apply re-fetches - never stale
// beyond BUNDLE_INDEXER_CACHE_MS.
var BUNDLE_INDEXER_CACHE_MS = 5 * 60 * 1000;

function fetchBundleIndexer(targetEnv) {
  var cached = bundleIndexerCache[targetEnv];
  if (cached && (Date.now() - cached.ts) < BUNDLE_INDEXER_CACHE_MS) {
    return Promise.resolve(cached.data);
  }
  var url = BUNDLE_INDEXER_URLS[targetEnv];
  if (!url) return Promise.reject(new Error('Unknown target env: ' + targetEnv));
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('indexer.json fetch failed: HTTP ' + r.status);
    return r.json();
  }).then(function (data) {
    bundleIndexerCache[targetEnv] = { ts: Date.now(), data: data };
    return data;
  });
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
function nextUniqueSessionRuleIds(startId, endIdExclusive, count, cb) {
  chrome.declarativeNetRequest.getSessionRules(function (rules) {
    var max = startId - 1;
    (rules || []).forEach(function (r) { if (r.id >= startId && r.id < endIdExclusive && r.id > max) max = r.id; });
    var ids = [];
    for (var i = 1; i <= count; i++) ids.push(max + i);
    cb(ids);
  });
}

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
function buildBundleRedirectRules(indexerData, layerIndexerData, brandId, targetEnv, tabId, ruleIds) {
  var entry = indexerData && indexerData[brandId];
  if (!entry) return { rules: [], skippedNoBrand: true };
  var indexerOrigin = '';
  try { indexerOrigin = new URL(BUNDLE_INDEXER_URLS[targetEnv]).origin; } catch (e) { /* leave empty */ }
  var rules = [];
  var idIdx = 0;
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
        priority: 1,
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
        priority: 1,
        action: { type: 'redirect', redirect: { extensionPath: '/bundle-noop.js' } },
        condition: {
          regexFilter: '^https?://[^/]+/.*' + brandId + '.*/' + device + '/files/' + prefix + '[.-][^/?]+\\.m?js([?].*)?$',
          resourceTypes: ['script'],
          tabIds: [tabId]
        }
      });
    });
  });

  // The selected bundle can request its ClientConfig from the environment
  // encoded by the host page. When ALPHA is pinned on a page configured with
  // PROD, that leaves a /dist/prod/config/... request beside ALPHA JavaScript
  // and can return 403. Keep the remainder of the config path intact, but pin
  // its same-layer environment segment to the selected bundle environment.
  var sourceConfigEnv = bundleEnvironmentsInLayer(targetEnv).filter(function (environment) {
    return environment !== targetEnv;
  })[0];
  if (sourceConfigEnv && idIdx < ruleIds.length) {
    var regexCapture = String.fromCharCode(92);
    rules.push({
      id: ruleIds[idIdx++],
      priority: 1,
      action: {
        type: 'redirect',
        redirect: { regexSubstitution: regexCapture + '1/dist/' + targetEnv + '/config/' + regexCapture + '2' }
      },
      condition: {
        regexFilter: '^(https?://[^/]+)/dist/' + sourceConfigEnv + '/config/(' + brandId + '/.*)$',
        resourceTypes: ['xmlhttprequest'],
        tabIds: [tabId]
      }
    });
  }
  return { rules: rules, skippedNoBrand: false };
}

function startBundleOverrideRule(tabId, targetEnv, brandId) {
  var previousRuleIds = bundleRuleIdsByTab[tabId]; // swap atomically, same
  // reasoning as the other three declarativeNetRequest features above -
  // re-applying (e.g. switching target env without disabling first) must
  // not leave the old rules alongside the new ones.
  var layerEnvironments = bundleEnvironmentsInLayer(targetEnv);
  return Promise.all(layerEnvironments.map(function (environment) {
    return fetchBundleIndexer(environment).then(function (data) {
      return { environment: environment, data: data };
    }).catch(function (err) {
      if (environment === targetEnv) throw err;
      return { environment: environment, data: null };
    });
  })).then(function (layerResults) {
    var targetResult = layerResults.filter(function (result) { return result.environment === targetEnv; })[0];
    var indexerData = targetResult && targetResult.data;
    var layerIndexerData = layerResults.map(function (result) { return result.data; }).filter(function (data) { return !!data; });
    return new Promise(function (resolve, reject) {
      // Reserve room for both target redirects and same-layer source-only
      // entrypoint neutralizers.
      nextUniqueSessionRuleIds(BUNDLE_RULE_ID_START, SR_SPOOF_RULE_ID_START, 16, function (ruleIds) {
        var built = buildBundleRedirectRules(indexerData, layerIndexerData, brandId, targetEnv, tabId, ruleIds);
        if (built.skippedNoBrand) { reject(new Error('Brand not found in ' + targetEnv + ' indexer.json')); return; }
        if (!built.rules.length) { reject(new Error('No bundle files found for this brand/env')); return; }
        chrome.declarativeNetRequest.updateSessionRules({
          addRules: built.rules,
          removeRuleIds: previousRuleIds || []
        }, function () {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          bundleRuleIdsByTab[tabId] = built.rules.map(function (r) { return r.id; });
          bundleMatchedByTab[tabId] = []; // reset the log for a fresh override
          resolve({ ruleCount: built.rules.length });
        });
      });
    });
  });
}

function stopBundleOverrideRule(tabId) {
  var ruleIds = bundleRuleIdsByTab[tabId];
  delete bundleExpectedUrlByTab[tabId];
  delete bundleRuleIdsByTab[tabId];
  delete bundleMatchedByTab[tabId];
  // Same SW-restart-safe cleanup as stopBleDataOverrideRule above - query
  // the browser's own live rules for this tab in our id range, not just
  // the in-memory map, since a service-worker restart between Apply and
  // Stop/navigation wipes the map but not the actual registered rules.
  return getOwnSessionRuleIdsForTab(tabId, BUNDLE_RULE_ID_START, SR_SPOOF_RULE_ID_START).then(function (liveIds) {
    var allIds = (ruleIds || []).concat(liveIds).filter(function (id, i, arr) { return arr.indexOf(id) === i; });
    if (!allIds.length) return;
    return new Promise(function (resolve) {
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: allIds }, function () {
        void chrome.runtime.lastError; // ignore - rules may already be gone
        resolve();
      });
    });
  });
}

// Verification hook mirroring the standalone tool's Service Worker console
// log (REFERENCE.md "Debugging") - requires the `declarativeNetRequestFeedback`
// permission (a dev/unpacked-only API, fine here since this extension is
// always sideloaded, never published to the Chrome Web Store).
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(function (info) {
    var ruleId = info && info.rule && info.rule.ruleId;
    if (typeof ruleId !== 'number' || ruleId < BUNDLE_RULE_ID_START || ruleId >= BUNDLE_RULE_ID_START + 100000) return; // not one of ours
    var tabId = info.request && info.request.tabId;
    if (tabId == null || !bundleMatchedByTab[tabId]) return;
    bundleMatchedByTab[tabId].push({ ruleId: ruleId, requestUrl: info.request.url, timestamp: Date.now() });
    if (bundleMatchedByTab[tabId].length > 50) bundleMatchedByTab[tabId].shift();
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-bundle-start') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  var tabId = sender.tab.id;
  var targetEnv = msg.targetEnv, currentEnv = msg.currentEnv, brandId = msg.brandId;
  if (!targetEnv || !brandId) { sendResponse({ ok: false, error: 'missing targetEnv or brandId' }); return false; }
  if (!BUNDLE_ENV_LAYERS[targetEnv]) { sendResponse({ ok: false, error: 'unknown target environment: ' + targetEnv }); return false; }
  if (currentEnv && BUNDLE_ENV_LAYERS[currentEnv] !== BUNDLE_ENV_LAYERS[targetEnv]) {
    sendResponse({ ok: false, error: 'cross-layer bundle override is not allowed (' + currentEnv + ' -> ' + targetEnv + ')' });
    return false;
  }
  // Remember the exact URL the override was applied for (see the
  // stale-cleanup logic in chrome.webNavigation.onBeforeNavigate above,
  // and the comment on bundleExpectedUrlByTab above for why this is the
  // whole URL, not just the origin) - Bundle Override is meant to be tied
  // to one specific tested link, unlike the Sportradar-spoof/BLE-CORS
  // domain-wide fixes.
  if (sender.tab.url) bundleExpectedUrlByTab[tabId] = sender.tab.url;
  startBundleOverrideRule(tabId, targetEnv, brandId).then(function (result) {
    sendResponse({ ok: true, ruleCount: result.ruleCount, targetEnv: targetEnv });
  }).catch(function (err) {
    sendResponse({ ok: false, error: String(err && err.message || err) });
  });
  return true;
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-bundle-stop') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  stopBundleOverrideRule(sender.tab.id).then(function () { sendResponse({ ok: true }); });
  return true;
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-bundle-status') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  var tabId = sender.tab.id;
  // Derive truth from the browser's own live session rules, not just the
  // in-memory map (see stopBundleOverrideRule comment above for why the
  // map alone is unsafe after a service-worker restart) - resync the map
  // from whatever is actually still registered so later stop/reapply
  // calls stay consistent.
  chrome.declarativeNetRequest.getSessionRules(function (allRules) {
    var liveRules = (allRules || []).filter(function (rule) {
      return rule.id >= BUNDLE_RULE_ID_START && rule.id < SR_SPOOF_RULE_ID_START &&
        rule.condition && Array.isArray(rule.condition.tabIds) && rule.condition.tabIds.indexOf(tabId) !== -1;
    });
    var liveIds = liveRules.map(function (rule) { return rule.id; });
    if (liveIds.length) bundleRuleIdsByTab[tabId] = liveIds;
    else delete bundleRuleIdsByTab[tabId];
    var targetEnvs = liveRules.map(function (rule) {
      var redirectUrl = rule.action && rule.action.redirect && rule.action.redirect.url;
      if (!redirectUrl) return null;
      try { return envLabelFromHostname(new URL(redirectUrl).hostname); } catch (e) { return null; }
    }).filter(function (env, index, values) { return env && values.indexOf(env) === index; });
    sendResponse({
      ok: true,
      active: liveIds.length > 0,
      ruleCount: liveIds.length,
      matched: bundleMatchedByTab[tabId] || [],
      targetEnv: targetEnvs.length === 1 ? targetEnvs[0] : null
    });
  });
  return true;
});

// ---------------------------------------------------------------------
// "Detected build" observation - answers "what environment/version is
// THIS tab's sportsbook bundle actually loaded from, right now?" with
// certainty, from the one source that cannot lie: the real HTTP request
// the browser already made for main-<hash>.js. Completely independent of
// the Bundle-override feature above (works whether or not an override is
// active, and whether or not the user ever opens the Bundle tab) - this
// is what should be trusted over any UI dropdown or the separate
// "Sportsbook Tool" bookmarklet's own "SB Version" field, since both of
// those can show a stale/misconfigured value with no visible error (see
// the 2026-08-10 Bundle-tab bug this was built in response to).
// ---------------------------------------------------------------------

var bundleObservedByTab = {}; // tabId -> {buildFolder, version, device,
// brandId, filePrefix, host, hostEnv, url, ts}. Last-write-wins on
// purpose: every fresh page load/reload always re-requests the bundle
// (hashed filenames, not cached across deploys), so the most recent
// observation IS the current truth for that tab - no separate "is this
// stale" check needed beyond clearing it on a real cross-page navigation
// (below).

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

// Resolve the environment of a dist-shape bundle from the artifact version
// recorded in the URL, not from the hostname serving it. A real ALPHA brand
// page can legitimately proxy a `/dist/prod/...` artifact through its own
// `www.alpha.*` host; hostname-only detection therefore labels a PROD build
// as ALPHA. Comparing the brand/device/version against both indexers in the
// same layer identifies the build itself. Multiple matches are retained as
// an honest "shared build" result instead of guessing.
function resolveDistBundleEnvironments(hostEnv, brandId, device, version) {
  var environments = bundleEnvironmentsInLayer(hostEnv);
  return Promise.all(environments.map(function (environment) {
    return fetchBundleIndexer(environment).then(function (indexerData) {
      var deviceEntry = indexerData && indexerData[brandId] && indexerData[brandId][device];
      return deviceEntry && String(deviceEntry.version) === String(version) ? environment : null;
    }).catch(function () { return null; });
  })).then(function (matches) {
    return matches.filter(function (environment) { return !!environment; });
  });
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
function resolveSandboxBundleInfo(env, filename, brandKey) {
  return fetchBundleIndexer(env).then(function (indexerData) {
    var matches = []; // {device, version, brandId, exact}
    var knownGuid = brandKey && BUNDLE_BRAND_GUIDS[brandKey];
    var brandIdsToSearch = knownGuid ? [knownGuid] : Object.keys(indexerData || {});
    brandIdsToSearch.forEach(function (brandId) {
      var entry = indexerData[brandId];
      ['desktop', 'mobile'].forEach(function (device) {
        var deviceEntry = entry && entry[device];
        if (!deviceEntry) return;
        var exact = (deviceEntry.js || []).some(function (fileUrl) {
          return (fileUrl || '').split('/').pop() === filename;
        });
        var chunkHit = false;
        if (!exact && deviceEntry.resourcesByFacade) {
          chunkHit = Object.keys(deviceEntry.resourcesByFacade).some(function (facadeId) {
            var f = deviceEntry.resourcesByFacade[facadeId];
            // scripts/links are ARRAYS of individual <script>/<link> tag
            // strings (confirmed live 2026-08-10 via direct SW
            // inspection) - NOT one big concatenated HTML string, so each
            // element must be searched individually rather than calling
            // .indexOf(filename) on the array itself (which only checks
            // for an exact whole-element match, never a substring).
            var inScripts = Array.isArray(f && f.scripts) && f.scripts.some(function (s) { return s.indexOf(filename) !== -1; });
            var inLinks = Array.isArray(f && f.links) && f.links.some(function (s) { return s.indexOf(filename) !== -1; });
            return inScripts || inLinks;
          });
        }
        if (exact || chunkHit) {
          matches.push({ device: device, version: deviceEntry.version || null, brandId: brandId, exact: exact });
        }
      });
    });
    if (!matches.length) return null;
    // Prefer an exact entry-point match over a chunk match if both somehow
    // occurred; otherwise use all chunk matches found.
    var exactMatches = matches.filter(function (m) { return m.exact; });
    var pool = exactMatches.length ? exactMatches : matches;
    var versions = pool.map(function (m) { return m.version; }).filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });
    var devices = pool.map(function (m) { return m.device; }).filter(function (d, i, arr) { return arr.indexOf(d) === i; });
    if (versions.length !== 1) return null; // ambiguous across brands/
    // devices - don't show a possibly-wrong version rather than guess.
    return {
      version: versions[0],
      device: devices.length === 1 ? devices[0] : null,
      brandId: pool[0].brandId
    };
  });
}

if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(function (details) {
    if (details.tabId == null || details.tabId < 0) return; // not a real tab
    // (e.g. a service-worker/extension-initiated request) - nothing to
    // attribute the observation to.
    var hostname = '';
    try { hostname = new URL(details.url).hostname; } catch (e) { /* leave empty */ }

    var m = BUNDLE_OBSERVE_RE.exec(details.url);
    if (m) {
      var observedTabId = details.tabId;
      var observedUrl = details.url;
      var observedHostEnv = envLabelFromHostname(hostname);
      var observation = {
        shape: 'dist',
        // m[1] ("dist/<label>/") is NOT a reliable environment indicator on
        // its own - confirmed live 2026-08-10 that a brand's TEST site can
        // serve its bundle from a path literally labeled "qa" with NO
        // override applied (TEST/QA apparently share one underlying BLE-
        // layer build artifact folder). Kept only as a diagnostic detail
        // (buildFolder); the actual "which environment served this file"
        // answer is hostEnv below, derived from the REQUEST'S OWN HOST -
        // which correctly differs between a native load (same host as the
        // page) and an active override (redirected to a different env's
        // CDN host).
        buildFolder: m[1].toLowerCase(),
        brandId: m[2],
        version: m[3],
        device: m[4],
        filePrefix: m[5],
        host: hostname,
        hostEnv: observedHostEnv,
        artifactEnv: null,
        artifactEnvs: [],
        artifactResolutionPending: true,
        url: details.url,
        ts: Date.now()
      };
      bundleObservedByTab[observedTabId] = observation;
      resolveDistBundleEnvironments(observedHostEnv, observation.brandId, observation.device, observation.version).then(function (artifactEnvs) {
        var current = bundleObservedByTab[observedTabId];
        if (!current || current.shape !== 'dist' || current.url !== observedUrl) return;
        current.artifactEnvs = artifactEnvs;
        current.artifactEnv = artifactEnvs.length === 1 ? artifactEnvs[0] : null;
        current.artifactResolutionPending = false;
      }).catch(function () {
        var current = bundleObservedByTab[observedTabId];
        if (current && current.shape === 'dist' && current.url === observedUrl) current.artifactResolutionPending = false;
      });
      return;
    }

    // Sandbox shape (see BUNDLE_OBSERVE_SANDBOX_RE comment above): no
    // version/brandId/device in the URL at all, so the ONLY way to avoid
    // false positives on completely unrelated websites (which may very
    // well also serve a `/assets/main-<hash>.js`, this pattern is generic
    // Angular CLI output, not unique to us) is to require the REQUEST'S
    // OWN HOSTNAME to already be a recognized sbplayground CDN host. If it
    // isn't, silently ignore the request - it's not one of ours.
    var sm = BUNDLE_OBSERVE_SANDBOX_RE.exec(details.url);
    if (!sm) return;
    var known = detectBrandAndEnvFromPlaygroundHost(hostname);
    if (!known) return;
    // Carry forward a previously-resolved version/device across this same
    // tab's later requests (e.g. a page load fires a dozen chunk
    // requests in quick succession) - only ONE of them typically matches
    // indexer.json (most sandbox-page chunks are the host app's own,
    // unrelated to the widget - see resolveSandboxBundleInfo comment
    // below), so a later, non-matching chunk's observation must not blow
    // away an earlier chunk's already-successful enrichment. Only reset
    // to null on a genuinely different page (onBeforeNavigate below
    // clears the whole entry on real navigation, or the shape itself
    // changed, e.g. dist->sandbox).
    var priorSandbox = bundleObservedByTab[details.tabId];
    var carriedVersion = (priorSandbox && priorSandbox.shape === 'sandbox') ? priorSandbox.version : null;
    var carriedDevice = (priorSandbox && priorSandbox.shape === 'sandbox') ? priorSandbox.device : null;
    bundleObservedByTab[details.tabId] = {
      shape: 'sandbox',
      buildFolder: null,
      brandId: null,
      brand: known.brand,
      // version/device are simply not encoded in this URL shape at all -
      // carried forward from a prior request's successful enrichment (see
      // above), or null until/unless one resolves.
      version: carriedVersion,
      device: carriedDevice,
      filePrefix: sm[1].toLowerCase(),
      host: hostname,
      hostEnv: envLabelFromHostname(hostname),
      url: details.url,
      ts: Date.now()
    };

    // Reverse-lookup enrichment (2026-08-10, revised): run for every
    // sandbox-shape observation, not just main-*.js - live testing showed
    // the sandbox host page's own main-*.js is a different build artifact
    // than the widget's federated entry point (see resolveSandboxBundleInfo
    // comment above), so it essentially never matches; the chunk-*.js
    // requests are what actually resolve via indexer.json's per-facade
    // chunk listings. Fire-and-forget: the synchronous env-only
    // observation above already gives the UI something to show
    // immediately; this just patches it in place if/when the async lookup
    // resolves.
    var enrichTabId = details.tabId;
    var enrichFilename = details.url.split('/').pop().split('?')[0].split('#')[0];
    resolveSandboxBundleInfo(known.environment, enrichFilename, known.brand).then(function (found) {
      if (!found) return;
      // Guard: only patch if this tab is still showing a sandbox-shape
      // observation at all - a real navigation (onBeforeNavigate below)
      // clears the entry entirely, or a dist-shape request may have since
      // taken over (an embedded, not standalone, page) - either way this
      // stale lookup no longer applies. Deliberately NOT keyed to the
      // exact request URL (unlike an earlier version of this guard) -
      // that was too strict: since only a handful of a sandbox page's many
      // chunk requests actually match indexer.json, a later NON-matching
      // chunk's own (already-applied, still-pending) request must not be
      // allowed to invalidate an earlier chunk's genuinely successful
      // match once it resolves.
      var current = bundleObservedByTab[enrichTabId];
      if (!current || current.shape !== 'sandbox') return;
      current.version = found.version;
      current.device = found.device;
      current.matchedBrandId = found.brandId;
    }).catch(function (err) {
      console.warn('[link-gen-tool] sandbox bundle indexer reverse-lookup failed:', err);
    });
  }, { urls: ['*://*/dist/*/xp/widgets/sportsbook/*', '*://*/assets/*'], types: ['script'] });
}

// Clear a tab's observation on a genuine top-level navigation to a
// different page - without this, navigating away from a sportsbook page
// to something unrelated would leave the last build's info visible,
// silently misleading ("Detected build" would show the OLD page's data).
// Deliberately not tied to same-origin SPA route changes (those don't
// fire onBeforeNavigate at all) or to the embedded-iframe case (the SB
// app frequently runs inside an iframe on a real brand site, not the top
// frame - clearing only on frameId 0 means an iframe-only reload doesn't
// wipe a still-valid observation; a fresh bundle request will simply
// overwrite it moments later anyway).
if (chrome.webNavigation && chrome.webNavigation.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener(function (details) {
    if (details.frameId !== 0) return;
    delete bundleObservedByTab[details.tabId];
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-bundle-observed') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  sendResponse({ ok: true, observed: bundleObservedByTab[sender.tab.id] || null });
  return false;
});

// "Verify with page state" (2026-08-10, rewritten after live testing
// found the ORIGINAL implementation's real root cause): content.js used
// to inject a plain <script> tag to read window.xSbState from the
// page's own MAIN-world context, since a content script's isolated
// world cannot see the page's own JS variables directly. That technique
// is a DOM script element, so it IS subject to the page's own
// script-src CSP - confirmed live on a NordicBet QA sandbox link, whose
// CSP is `script-src 'self' 'wasm-unsafe-eval' ...` with no
// 'unsafe-inline', which silently blocked the injected script (a real
// "Executing inline script violates ... Content-Security-Policy"
// console error was captured). An earlier page.evaluate()-based probe
// had misleadingly suggested the injection technique "worked" - that
// call goes through the DevTools Protocol, which always bypasses page
// CSP entirely, unlike an actual DOM <script> tag. The correct, official
// fix is chrome.scripting.executeScript with world:'MAIN', which is
// explicitly documented to run in the page's real JS context WITHOUT
// being subject to the page's script-src CSP (it's not parsed as a
// same-origin resource at all) - this can only be called from the
// service worker (content scripts have no "scripting" permission
// access), hence this message-based bridge.
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-verify-xsbstate') return false;
  if (!sender.tab || sender.tab.id == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id },
    world: 'MAIN',
    func: function () {
      var s = window.xSbState;
      if (!s) return { ok: true, hasState: false };
      // Exact field names for version/environment are unconfirmed (see
      // REFERENCE.md - only sportsbook.statistics/scoreboard are
      // documented) - best-effort guesses with a safe fallback to just
      // listing top-level keys so this remains useful even if none of
      // the guesses match the real shape.
      var version = (s.app && s.app.version) || s.version || s.buildVersion || null;
      var environment = (s.app && s.app.environment) || s.environment || null;
      return { ok: true, hasState: true, version: version, environment: environment, keys: Object.keys(s) };
    }
  }).then(function (results) {
    sendResponse((results && results[0] && results[0].result) || { ok: false, error: 'no result from executeScript' });
  }, function (err) {
    sendResponse({ ok: false, error: String((err && err.message) || err) });
  });
  return true; // keep sendResponse alive for the async executeScript call
});

// Opens a NEW tab for the given generated link with Sportradar spoofing
// already active before the page starts loading (unlike "Embed here",
// this acts on a brand-new tab it creates itself, not the current one -
// the widget needs to run on the generated link's OWN page).
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-open-with-sr-spoof') return false;
  var url = msg.url;
  var spoofOrigin = msg.spoofOrigin;
  if (!url || !spoofOrigin) { sendResponse({ ok: false, error: 'missing url or spoofOrigin' }); return false; }
  // IMPORTANT: do NOT pass `url` to tabs.create directly. Doing so starts the
  // real navigation (and therefore the page's first Sportradar /licensing
  // request) IMMEDIATELY, in parallel with this extension call - the
  // declarativeNetRequest rule below was only being added inside the
  // tabs.create callback, i.e. AFTER that navigation had already started, so
  // the page's very first load routinely beat the rule and rendered the
  // licensing error before the spoof ever took effect (confirmed by the
  // user: page loads with the error before the addon "does its job" -
  // 2026-08-07). Fix: open a blank tab first, register the session rule for
  // that tabId while nothing has requested anything yet, THEN navigate the
  // (still-blank) tab to the real URL via tabs.update - guaranteeing the
  // rule is already active before the first Sportradar request fires.
  chrome.tabs.create({ url: 'about:blank', active: true }, function (tab) {
    if (chrome.runtime.lastError || !tab) { sendResponse({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'failed to open tab' }); return; }
    try { srSpoofExpectedOriginByTab[tab.id] = new URL(url).origin; } catch (e) { /* leave unset - cleanup listener degrades to "never auto-stop" */ }
    startSrSpoofRule(tab.id, spoofOrigin).then(function () {
      chrome.tabs.update(tab.id, { url: url }, function () {
        if (chrome.runtime.lastError) { sendResponse({ ok: false, error: chrome.runtime.lastError.message }); return; }
        sendResponse({ ok: true, tabId: tab.id });
      });
    }).catch(function (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    });
  });
  return true;
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
