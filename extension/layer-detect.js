/* Link Gen Tool - runtime layer marker detector.
 *
 * MAIN world, all_frames:true, document_idle - runs in EVERY frame of
 * EVERY page (not just recognized Sportsbook pages), so this file must
 * stay extremely cheap on frames that are not Sportsbook at all: a
 * handful of `typeof window.X !== 'undefined'` checks on a slow poll,
 * nothing else, until one of the three known runtime markers actually
 * appears.
 *
 * Brand + runtime layer are NOT one static brand->architecture matrix -
 * a brand's page can run the MFE widget, the iframe/OBGA embed, and/or a
 * NodeJS-rendered layer, each with its own runtime marker:
 *   - MFE:          window.sbMfeStartupContext / window.sbXpSportsbookAppVersion
 *   - iframe/OBGA:  window.obgClientEnvironmentConfig.startupContext
 *   - NodeJS:       window.nodeContext
 *
 * This script only EXTRACTS what each marker exposes and forwards it,
 * via window.postMessage, to this same frame's isolated-world relay
 * (layer-relay.js) - a MAIN-world content script cannot call
 * chrome.runtime.sendMessage directly. The relay adds no brand/version/
 * environment logic of its own; ALL resolution (brand-priority chain,
 * indexer lookups, confidence classification) happens in background.js,
 * which is also the only place that sees the network side of the
 * evidence.
 */
(function () {
  'use strict';

  var MESSAGE_TYPE = 'lgt-layer-marker';
  var POLL_INTERVAL_MS = 1000;
  var MAX_POLL_ATTEMPTS = 20; // give up after ~20s if nothing ever appears

  function safeGet(obj, path) {
    try {
      return path.split('.').reduce(function (acc, key) {
        return acc == null ? undefined : acc[key];
      }, obj);
    } catch (e) { return undefined; }
  }

  function readMfeMarker() {
    var ctx = window.sbMfeStartupContext;
    var xpVersionMarker = window.sbXpSportsbookAppVersion;
    if (!ctx && xpVersionMarker == null) return null;
    var appContext = ctx && ctx.appContext;
    return {
      layer: 'mfe',
      brandId: safeGet(ctx, 'brandId') || null,
      brandName: safeGet(ctx, 'brandName') || null,
      version: (appContext && appContext.version != null ? appContext.version : xpVersionMarker) || null,
      environment: (appContext && appContext.environment != null ? appContext.environment : null),
      versionSource: appContext && appContext.version != null ? 'sbMfeStartupContext.appContext.version' : (xpVersionMarker != null ? 'sbXpSportsbookAppVersion' : null),
      environmentSource: appContext && appContext.environment != null ? 'sbMfeStartupContext.appContext.environment' : null
    };
  }

  function readIframeMarker() {
    var startupContext = safeGet(window, 'obgClientEnvironmentConfig.startupContext');
    if (!startupContext) return null;
    var appContext = startupContext.appContext;
    return {
      layer: 'iframe',
      brandId: startupContext.brandId || null,
      brandName: startupContext.brandName || null,
      version: (appContext && appContext.version != null ? appContext.version : null),
      environment: (appContext && appContext.environment != null ? appContext.environment : null),
      versionSource: appContext && appContext.version != null ? 'obgClientEnvironmentConfig.startupContext.appContext.version' : null,
      environmentSource: appContext && appContext.environment != null ? 'obgClientEnvironmentConfig.startupContext.appContext.environment' : null
    };
  }

  function readNodeJsMarker() {
    var ctx = window.nodeContext;
    if (!ctx) return null;
    // nodeContext.environment is explicitly NOT guaranteed by the spec -
    // background.js falls back to the document/config/bundle hostname+URL
    // for environment on this layer, so it is intentionally left out of
    // this payload's `environment` field (the brand fallback below is a
    // same-frame document/config brand, which background.js also resolves
    // itself from its own network observations - this marker only ever
    // reports what nodeContext itself actually carries).
    return {
      layer: 'nodejs',
      brandId: ctx.brandId || null,
      brandName: ctx.brandName || null,
      version: ctx.version != null ? ctx.version : null,
      appHash: ctx.appHash != null ? ctx.appHash : null,
      versionSource: ctx.version != null ? 'nodeContext.version' : null
    };
  }

  function collect() {
    var found = [readMfeMarker(), readIframeMarker(), readNodeJsMarker()].filter(function (m) { return !!m; });
    return found;
  }

  function post(markers) {
    // '*' target origin is fine here: the payload only restates values
    // already exposed as plain window globals on this same page, and the
    // recipient (this same frame's isolated-world relay) filters strictly
    // on `event.source === window && event.data.source === MESSAGE_TYPE`.
    try { window.postMessage({ source: MESSAGE_TYPE, href: location.href, markers: markers }, '*'); } catch (e) { /* give up silently */ }
  }

  var attempts = 0;
  var lastSignature = '';
  function tick() {
    attempts += 1;
    var markers = collect();
    if (markers.length) {
      var signature = JSON.stringify(markers);
      if (signature !== lastSignature) {
        lastSignature = signature;
        post(markers);
      }
    }
    // Keep polling for the FULL budget even after a first successful read
    // - runtime contexts hydrate progressively within the same page load
    // (e.g. appContext.environment/brandId can populate a tick or two
    // after the object first appears with only a version, or a second
    // layer - e.g. the legacy OBGA/Fabric marker in an MFE+Fabric hybrid
    // page - can become available only after the MFE one already has).
    // Stopping as soon as ANYTHING was found used to freeze the very
    // first (sometimes incomplete) snapshot forever for the rest of the
    // page's life, which is why a row could stay "Partially verified"
    // indefinitely on some brands even though the real runtime object
    // eventually had everything - confirmed by inspecting the live
    // window.sbMfeStartupContext/obgClientEnvironmentConfig on a real
    // brand page, which had complete brandId+version+environment on both
    // markers all along.
    if (attempts < MAX_POLL_ATTEMPTS) setTimeout(tick, POLL_INTERVAL_MS);
  }

  tick();
})();
