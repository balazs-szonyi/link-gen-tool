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
