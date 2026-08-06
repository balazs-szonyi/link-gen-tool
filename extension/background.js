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

function runTrustedSequence(tabId, actions) {
  return attachDebugger(tabId).then(function () {
    var chain = Promise.resolve();
    actions.forEach(function (action) {
      chain = chain.then(function () {
        if (action.type === 'click') return trustedClick(tabId, action.x, action.y);
        if (action.type === 'type') return trustedType(tabId, action.text);
        if (action.type === 'key') return trustedKey(tabId, action.key);
        return Promise.resolve();
      }).then(function () { return sleep(action.delayAfter || 80); });
    });
    return chain.then(
      function () { return detachDebugger(tabId).then(function () { return { ok: true }; }); },
      function (err) { return detachDebugger(tabId).then(function () { return { ok: false, error: String(err && err.message || err) }; }); }
    );
  }, function (err) {
    return { ok: false, error: String(err && err.message || err) };
  });
}

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
// active:false keeps the tab out of the user's way for its whole (short)
// lifetime; it closes itself via lgt-close-tab once its job settles
// (success or failure alike - there's no reason to leave an inactive tab
// open either way).
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'lgt-open-tab') return false;
  chrome.tabs.create({ url: msg.url, active: false }, function (tab) {
    if (chrome.runtime.lastError) { sendResponse({ ok: false, error: chrome.runtime.lastError.message }); return; }
    sendResponse({ ok: true, tabId: tab && tab.id });
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
      chrome.windows.update(tab.windowId, { focused: true }, function () {
        void chrome.runtime.lastError;
        sendResponse({ ok: true });
      });
      return;
    }
    sendResponse({ ok: true });
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
