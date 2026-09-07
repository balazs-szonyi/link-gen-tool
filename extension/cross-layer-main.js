/* Link Gen Tool Cross-Layer runtime - MAIN world, document_start. */
(function () {
  'use strict';

  // Bonus Mock is installed on every document before the app can capture
  // fetch/XMLHttpRequest. It remains a no-op until this tab+origin has an
  // enabled sessionStorage config written by the content-script UI.
  (function installBonusMockRuntime() {
    var bonusMock = window.LgtBonusMock;
    if (!bonusMock || window.__lgtBonusMockRuntimeInstalled) return;
    window.__lgtBonusMockRuntimeInstalled = true;

    function readConfig() {
      var raw;
      try { raw = sessionStorage.getItem(bonusMock.CONFIG_KEY); } catch (e) { return null; }
      if (!raw) return null;
      try {
        var config = JSON.parse(raw);
        return config && config.enabled && bonusMock.hasResponseShape(config.payload) ? config : null;
      } catch (e) { return null; }
    }

    function recordMatch(url, config, replacement, responseFormat) {
      try {
        var previousRaw = sessionStorage.getItem(bonusMock.LAST_MATCH_KEY);
        var previous = previousRaw ? JSON.parse(previousRaw) : null;
        var widgetBonuses = replacement && replacement.data && Array.isArray(replacement.data.bonuses) ? replacement.data.bonuses : [];
        var featureCounts = {};
        widgetBonuses.forEach(function (bonus) { featureCounts[bonus.type] = (featureCounts[bonus.type] || 0) + 1; });
        var marketQueries = replacement && replacement.skeleton && replacement.skeleton.marketDetailsQueries;
        sessionStorage.setItem(bonusMock.LAST_MATCH_KEY, JSON.stringify({
          url: String(url),
          count: (previous && previous.count || 0) + 1,
          bonusCount: config.bonusCount,
          responseFormat: responseFormat,
          replacedBonusCount: widgetBonuses.length || config.bonusCount,
          featureCounts: featureCounts,
          marketCount: Array.isArray(marketQueries) && marketQueries[0] ? marketQueries[0].split(',').length : 0,
          matchedAt: Date.now()
        }));
      } catch (e) { /* status telemetry must never affect the response */ }
    }

    function responseWithMock(response, config, url) {
      var contentType = response.headers.get('content-type') || '';
      if (!/json/i.test(contentType)) return Promise.resolve(response);
      return response.clone().json().then(function (original) {
        var replacement;
        var responseFormat;
        if (bonusMock.hasResponseShape(original)) { replacement = config.payload; responseFormat = 'bss'; }
        else if (bonusMock.hasWidgetResponseShape(original)) { replacement = bonusMock.toWidgetPayload(config.payload, original); responseFormat = 'widget'; }
        else return response;
        var headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        headers.set('content-type', 'application/json');
        recordMatch(url, config, replacement, responseFormat);
        return new Response(JSON.stringify(replacement), {
          status: response.status,
          statusText: response.statusText,
          headers: headers
        });
      }).catch(function () { return response; });
    }

    var nativeBonusFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var config = readConfig();
      return nativeBonusFetch.apply(this, arguments).then(function (response) {
        if (!config || method !== 'GET' || !bonusMock.matchesEndpoint(url)) return response;
        return responseWithMock(response, config, url);
      });
    };

    var NativeBonusXHR = window.XMLHttpRequest;
    function BonusMockXHR() {
      var xhr = new NativeBonusXHR();
      var requestUrl = '';
      var requestMethod = 'GET';
      var nativeOpen = xhr.open;
      xhr.open = function (method, url) {
        requestMethod = String(method || 'GET').toUpperCase();
        requestUrl = String(url);
        return nativeOpen.apply(xhr, arguments);
      };
      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState !== 4 || requestMethod !== 'GET' || !bonusMock.matchesEndpoint(requestUrl)) return;
        var config = readConfig();
        if (!config) return;
        try {
          var contentType = xhr.getResponseHeader('content-type') || '';
          if (!/json/i.test(contentType) || (xhr.responseType && xhr.responseType !== 'json' && xhr.responseType !== 'text')) return;
          var original = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
          var replacement;
          var responseFormat;
          if (bonusMock.hasResponseShape(original)) { replacement = config.payload; responseFormat = 'bss'; }
          else if (bonusMock.hasWidgetResponseShape(original)) { replacement = bonusMock.toWidgetPayload(config.payload, original); responseFormat = 'widget'; }
          else return;
          var serialized = JSON.stringify(replacement);
          Object.defineProperty(xhr, 'responseText', { configurable: true, get: function () { return serialized; } });
          Object.defineProperty(xhr, 'response', { configurable: true, get: function () { return xhr.responseType === 'json' ? replacement : serialized; } });
          recordMatch(requestUrl, config, replacement, responseFormat);
        } catch (e) { /* retain the native response */ }
      });
      return xhr;
    }
    BonusMockXHR.prototype = NativeBonusXHR.prototype;
    Object.keys(NativeBonusXHR).forEach(function (key) { try { BonusMockXHR[key] = NativeBonusXHR[key]; } catch (e) {} });
    window.XMLHttpRequest = BonusMockXHR;
  })();

  // Bet Void Mock is installed the same way as Bonus Mock above: always
  // passively records a lightweight summary of every real coupon-history
  // response it sees (so the content-script UI can list real, current
  // coupons+legs without the user pasting anything), and only rewrites a
  // response when a tab+origin-scoped sessionStorage config is both
  // enabled and targets a coupon actually present in that response.
  (function installBetVoidMockRuntime() {
    var betVoidMock = window.LgtBetVoidMock;
    if (!betVoidMock || window.__lgtBetVoidMockRuntimeInstalled) return;
    window.__lgtBetVoidMockRuntimeInstalled = true;

    function readConfig() {
      var raw;
      try { raw = sessionStorage.getItem(betVoidMock.CONFIG_KEY); } catch (e) { return null; }
      if (!raw) return null;
      try {
        var config = JSON.parse(raw);
        return config && config.enabled && config.couponId ? config : null;
      } catch (e) { return null; }
    }

    function recordSeen(url, payload) {
      try {
        sessionStorage.setItem(betVoidMock.LAST_SEEN_KEY, JSON.stringify({
          url: String(url),
          capturedAt: Date.now(),
          coupons: betVoidMock.summarizeCoupons(payload)
        }));
      } catch (e) { /* passive telemetry must never affect the response */ }
    }

    function recordMatch(url, couponId, appliedLegCount) {
      try {
        var previousRaw = sessionStorage.getItem(betVoidMock.LAST_MATCH_KEY);
        var previous = previousRaw ? JSON.parse(previousRaw) : null;
        sessionStorage.setItem(betVoidMock.LAST_MATCH_KEY, JSON.stringify({
          url: String(url),
          couponId: couponId,
          appliedLegCount: appliedLegCount,
          count: (previous && previous.count || 0) + 1,
          matchedAt: Date.now()
        }));
      } catch (e) { /* status telemetry must never affect the response */ }
    }

    function responseWithBetVoidMock(response, url) {
      var contentType = response.headers.get('content-type') || '';
      if (!/json/i.test(contentType)) return Promise.resolve(response);
      return response.clone().json().then(function (original) {
        if (!betVoidMock.hasResponseShape(original)) return response;
        recordSeen(url, original);
        var config = readConfig();
        if (!config) return response;
        var result = betVoidMock.applyVoidToCoupon(original, config);
        if (!result.matched) return response;
        recordMatch(url, config.couponId, result.appliedLegCount);
        var headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        headers.set('content-type', 'application/json');
        return new Response(JSON.stringify(result.payload), {
          status: response.status,
          statusText: response.statusText,
          headers: headers
        });
      }).catch(function () { return response; });
    }

    var nativeBetVoidFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      return nativeBetVoidFetch.apply(this, arguments).then(function (response) {
        if (method !== 'GET' || !betVoidMock.matchesEndpoint(url)) return response;
        return responseWithBetVoidMock(response, url);
      });
    };

    var NativeBetVoidXHR = window.XMLHttpRequest;
    function BetVoidMockXHR() {
      var xhr = new NativeBetVoidXHR();
      var requestUrl = '';
      var requestMethod = 'GET';
      var nativeOpen = xhr.open;
      xhr.open = function (method, url) {
        requestMethod = String(method || 'GET').toUpperCase();
        requestUrl = String(url);
        return nativeOpen.apply(xhr, arguments);
      };
      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState !== 4 || requestMethod !== 'GET' || !betVoidMock.matchesEndpoint(requestUrl)) return;
        try {
          var contentType = xhr.getResponseHeader('content-type') || '';
          if (!/json/i.test(contentType) || (xhr.responseType && xhr.responseType !== 'json' && xhr.responseType !== 'text')) return;
          var original = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
          if (!betVoidMock.hasResponseShape(original)) return;
          recordSeen(requestUrl, original);
          var config = readConfig();
          if (!config) return;
          var result = betVoidMock.applyVoidToCoupon(original, config);
          if (!result.matched) return;
          recordMatch(requestUrl, config.couponId, result.appliedLegCount);
          var serialized = JSON.stringify(result.payload);
          Object.defineProperty(xhr, 'responseText', { configurable: true, get: function () { return serialized; } });
          Object.defineProperty(xhr, 'response', { configurable: true, get: function () { return xhr.responseType === 'json' ? result.payload : serialized; } });
        } catch (e) { /* retain the native response */ }
      });
      return xhr;
    }
    BetVoidMockXHR.prototype = NativeBetVoidXHR.prototype;
    Object.keys(NativeBetVoidXHR).forEach(function (key) { try { BetVoidMockXHR[key] = NativeBetVoidXHR[key]; } catch (e) {} });
    window.XMLHttpRequest = BetVoidMockXHR;
  })();
  var KEY = '__lgtCrossLayerRuntimeV1';
  var raw;
  try { raw = sessionStorage.getItem(KEY); } catch (e) { return; }
  if (!raw) return;
  var config;
  try { config = JSON.parse(raw); } catch (e) { return; }
  if (!config || !config.enabled || !config.expectedUrl) return;
  function sameConfiguredPage(actualValue, expectedValue) {
    try {
      var actual = new URL(actualValue);
      var expected = new URL(expectedValue);
      var normalizePath = function (path) { return path.length > 1 ? path.replace(/\/$/, '') : path; };
      if (actual.origin !== expected.origin || normalizePath(actual.pathname) !== normalizePath(expected.pathname) || actual.hash !== expected.hash) return false;
      ['exposeObgState', 'exposeObgRt', 'sealStore'].forEach(function (key) {
        actual.searchParams.delete(key);
        expected.searchParams.delete(key);
      });
      actual.searchParams.sort();
      expected.searchParams.sort();
      return actual.search === expected.search;
    } catch (e) { return false; }
  }
  if (!sameConfiguredPage(location.href, config.expectedUrl)) return;

  // The BLE host's SSR markup creates the sportsbook element without the
  // BDE component's diagnostic attribute. Reading the query string later is
  // too late: the target custom element snapshots its attributes in its first
  // connectedCallback, leaving obgState sealed even though the URL contains
  // exposeObgState=true. Decorate that lifecycle before the target bundle
  // registers the element, while retaining the component's own callback.
  var nativeCustomElementDefine = window.customElements && window.customElements.define;
  if (nativeCustomElementDefine) {
    window.customElements.define = function (name, constructor, options) {
      var isSportsbookElement = /^sb-xp-sportsbook$/i.test(String(name));
      if (isSportsbookElement && constructor && constructor.prototype) {
        var originalConnectedCallback = constructor.prototype.connectedCallback;
        constructor.prototype.connectedCallback = function () {
          if (location.search && new URLSearchParams(location.search).get('exposeObgState') === 'true') {
            this.setAttribute('expose-obg-state', 'true');
          }
          if (typeof originalConnectedCallback === 'function') return originalConnectedCallback.apply(this, arguments);
        };
      }
      try { return nativeCustomElementDefine.call(this, name, constructor, options); }
      finally {
        // The lifecycle decoration is single-purpose. Restore the browser API
        // immediately after the target component is registered.
        if (isSportsbookElement) window.customElements.define = nativeCustomElementDefine;
      }
    };
  }

  var ENV_LABELS = ['test', 'qa', 'alpha'];
  var ENDPOINT_KEY = /(url|uri|endpoint|host|origin|api|auth|wallet|realtime|signalr)/i;
  function replaceEnvironment(value, environment) {
    var url = new URL(value, location.href);
    var labels = url.hostname.split('.').filter(function (part) { return ENV_LABELS.indexOf(part) === -1; });
    if (environment !== 'prod') labels.splice(Math.max(0, labels.length - 2), 0, environment);
    url.hostname = labels.join('.');
    url.pathname = url.pathname.replace(/\/dist\/(test|qa|alpha|prod)\//, '/dist/' + environment + '/');
    return url.toString();
  }
  function classify(url, method) {
    var upper = String(method || 'GET').toUpperCase();
    if (/client.?config|\/config\//i.test(url)) return 'config';
    if (/startup.?context|static.?context|user.?context/i.test(url)) return 'context';
    if (/place.?bet|bets?\/submit/i.test(url) && upper === 'POST') return 'place-bet';
    if (/quote|validat/i.test(url) && upper === 'POST') return 'bet-read';
    if (/\/api\/sb\/|\/sb\/fe-api\/|wallet|balance|signalr|realtime|route.?data|configuration|auth|login|session/i.test(url)) return 'backend';
    return null;
  }
  function rewriteTree(value, backendEnv, key) {
    if (Array.isArray(value)) return value.map(function (item) { return rewriteTree(item, backendEnv, key); });
    if (value && typeof value === 'object') {
      var output = {};
      Object.keys(value).forEach(function (childKey) { output[childKey] = rewriteTree(value[childKey], backendEnv, childKey); });
      return output;
    }
    if (typeof value === 'string' && ENDPOINT_KEY.test(key || '') && /^https?:\/\//i.test(value)) {
      try { return replaceEnvironment(value, backendEnv); } catch (e) { return value; }
    }
    return value;
  }
  function route(url, method) {
    var kind = classify(url, method);
    if (!kind) return { kind: null, url: url };
    if (kind === 'place-bet' && config.backendEnv === 'prod') return { kind: kind, blocked: true, url: url };
    var targetEnvironment = kind === 'config' ? config.bundleEnv : config.backendEnv;
    try { return { kind: kind, url: replaceEnvironment(url, targetEnvironment) }; }
    catch (e) { return { kind: kind, url: url }; }
  }
  function adaptJson(kind, value) {
    if (kind === 'config' && config.mode === 'hybrid') return rewriteTree(value, config.backendEnv);
    return value;
  }

  // Sportsbook Tool <= v1.6.166 only understands same-layer overrides. Its
  // startup calculation maps PROD+override to ALPHA and QA+override to TEST,
  // so a real PROD-host/TEST-bundle cross-layer run is mislabeled ALPHA.
  // Present a target-compatible startup value only while that external tool
  // script initializes (it snapshots the environment synchronously), then
  // restore the real runtime objects immediately after load. The sportsbook
  // itself therefore never remains on the compatibility value.
  var nativeAppendChild = Node.prototype.appendChild;
  Node.prototype.appendChild = function (child) {
    var isSportsbookTool = child && child.nodeType === 1 && child.tagName === 'SCRIPT' &&
      (child.id === 'sportsbookToolScript' || /sportsbookTool(?:\.min)?\.js/i.test(child.src || ''));
    if (!isSportsbookTool) return nativeAppendChild.call(this, child);

    var context = window.sbMfeStartupContext && window.sbMfeStartupContext.appContext;
    var originalEnvironment = context && context.environment;
    var hadOverrideFlag = Object.prototype.hasOwnProperty.call(window, 'xSbIsMfeOverrideApplied');
    var originalOverrideFlag = window.xSbIsMfeOverrideApplied;
    var compatibilityBase = { test: 'qa', alpha: 'prod', qa: 'qa', prod: 'prod' }[config.bundleEnv];
    var compatibilityFlag = config.bundleEnv === 'test' || config.bundleEnv === 'alpha';
    var restored = false;
    function restoreSportsbookToolCompatibility() {
      if (restored) return;
      restored = true;
      try { if (context) context.environment = originalEnvironment; } catch (e) {}
      try {
        if (hadOverrideFlag) window.xSbIsMfeOverrideApplied = originalOverrideFlag;
        else delete window.xSbIsMfeOverrideApplied;
      } catch (e) {}
    }
    try {
      if (context && compatibilityBase) context.environment = compatibilityBase;
      window.xSbIsMfeOverrideApplied = compatibilityFlag;
      child.addEventListener('load', function () { setTimeout(restoreSportsbookToolCompatibility, 0); }, { once: true });
      child.addEventListener('error', restoreSportsbookToolCompatibility, { once: true });
      var result = nativeAppendChild.call(this, child);
      setTimeout(restoreSportsbookToolCompatibility, 10000);
      return result;
    } catch (e) {
      restoreSportsbookToolCompatibility();
      throw e;
    }
  };
  window.__lgtSportsbookToolEnvironment = config.bundleEnv;

  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    var originalUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    var method = (init && init.method) || (input && input.method) || 'GET';
    var plan = route(originalUrl, method);
    if (plan.blocked) return Promise.reject(new Error('PROD place-bet is blocked in normal-Chrome Cross-Layer mode'));
    var routedInput = input;
    if (plan.url !== originalUrl) {
      routedInput = typeof input === 'string' || input instanceof URL ? plan.url : new Request(plan.url, input);
    }
    return nativeFetch.call(this, routedInput, init).then(function (response) {
      if (plan.kind !== 'config' && plan.kind !== 'context') return response;
      var contentType = response.headers.get('content-type') || '';
      if (!/json/i.test(contentType)) return response;
      return response.clone().json().then(function (body) {
        var headers = new Headers(response.headers);
        headers.delete('content-length'); headers.delete('content-encoding');
        return new Response(JSON.stringify(adaptJson(plan.kind, body)), { status: response.status, statusText: response.statusText, headers: headers });
      }).catch(function () { return response; });
    });
  };

  var NativeXHR = window.XMLHttpRequest;
  function CrossLayerXHR() {
    var xhr = new NativeXHR();
    var plan = null;
    var nativeOpen = xhr.open;
    xhr.open = function (method, url) {
      plan = route(String(url), method);
      if (plan.blocked) throw new Error('PROD place-bet is blocked in normal-Chrome Cross-Layer mode');
      var args = Array.prototype.slice.call(arguments); args[1] = plan.url;
      return nativeOpen.apply(xhr, args);
    };
    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState !== 4 || !plan || (plan.kind !== 'config' && plan.kind !== 'context')) return;
      try {
        var body = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
        var adapted = adaptJson(plan.kind, body);
        Object.defineProperty(xhr, 'responseText', { configurable: true, get: function () { return JSON.stringify(adapted); } });
        Object.defineProperty(xhr, 'response', { configurable: true, get: function () { return xhr.responseType === 'json' ? adapted : JSON.stringify(adapted); } });
      } catch (e) { /* retain the native response */ }
    });
    return xhr;
  }
  CrossLayerXHR.prototype = NativeXHR.prototype;
  Object.keys(NativeXHR).forEach(function (key) { try { CrossLayerXHR[key] = NativeXHR[key]; } catch (e) {} });
  window.XMLHttpRequest = CrossLayerXHR;
  window.__lgtCrossLayerRuntimeActive = { mode: config.mode, pageEnv: config.pageEnv, bundleEnv: config.bundleEnv, backendEnv: config.backendEnv };
})();
