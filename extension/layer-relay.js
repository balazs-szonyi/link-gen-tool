/* Link Gen Tool - runtime layer marker relay.
 *
 * ISOLATED world, all_frames:true, document_idle - the thin bridge
 * between layer-detect.js (MAIN world, same frame) and background.js.
 * Deliberately dumb: no brand/version/environment logic here at all,
 * just forwards whatever layer-detect.js posted, plus this frame's own
 * href (background.js reads sender.frameId/sender.tab.id off the
 * chrome.runtime.sendMessage call itself to know which frame it was).
 */
(function () {
  'use strict';

  var MESSAGE_TYPE = 'lgt-layer-marker';

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== MESSAGE_TYPE || !Array.isArray(data.markers)) return;
    try {
      chrome.runtime.sendMessage({ type: MESSAGE_TYPE, href: data.href, markers: data.markers }, function () {
        void chrome.runtime.lastError; // background may not be ready yet - not fatal, layer-detect.js re-posts on any change
      });
    } catch (e) { /* extension context invalidated (reload) - ignore */ }
  });
})();
