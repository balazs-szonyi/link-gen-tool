// Tiny document_start bridge: toolbar clicks can arrive before the main UI
// content script finishes constructing the panel. Keep only an idempotent
// toggle count in the isolated extension world; no page data is read here.
(function () {
  'use strict';
  if (globalThis.__lgtToggleQueue == null) globalThis.__lgtToggleQueue = 0;
  chrome.runtime.onMessage.addListener(function (message) {
    if (message?.type === 'lgt-toggle-panel') globalThis.__lgtToggleQueue += 1;
  });
})();
