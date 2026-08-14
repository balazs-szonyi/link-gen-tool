/* Link Gen Tool Cross-Layer runtime - MAIN world, document_start. */
(function () {
  'use strict';
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
