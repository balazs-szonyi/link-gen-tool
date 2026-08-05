/*
 * Link Gen Tool - browser addon for generating environment-correct Betsson
 * sportsbook QA links, without the internal.{env}.sbplayground1.net UI.
 *
 * Loaded via bookmarklet (see bookmarklet.txt) from any page. Injects a
 * floating panel with two modes:
 *   A) Generate Link  - client-side port of generate-link.ps1 (brand/env/
 *      login-state selectors -> calls internal.{env}.sbplayground1.net/api/*
 *      directly; those endpoints have open CORS, verified 2026-08).
 *   B) Live-Login Capture - passively sniffs fetch()/XHR calls to sb/fe-api/*
 *      for x-sb-static-context-id / x-sb-user-context-id headers while the
 *      QA person is logged into the CURRENT brand page (organically, in
 *      their own real browser - no automation fingerprint at all). Can also
 *      attempt an automated in-page login (simulated typing, not headless)
 *      for brands with a known selector map entry.
 *
 * Credentials are stored in the CURRENT page's own localStorage (first-
 * party, so it always works regardless of third-party storage/cookie
 * policies). An earlier version tried to share one vault across every
 * brand domain via a cross-origin iframe (vault.html) + postMessage +
 * localStorage - that broke under Chrome's third-party storage
 * partitioning (and stricter still under managed/corporate Chrome
 * profiles that block third-party storage outright), so a credential
 * saved on one brand domain silently failed to appear on another. Fixed
 * by dropping the iframe entirely and adding an explicit Export/Import
 * code in the Credentials tab: copy a code on brand A, paste it on
 * brand B, and its credential list merges in. Manual, but 100% reliable
 * regardless of browser storage policy - matches the same copy/paste
 * workflow already used for stc/ctx context transplanting.
 */
(function () {
  'use strict';

  // Bump on every change so the loaded version is visible in the panel
  // title and the console - makes it obvious whether a fresh reload
  // actually picked up the latest deployed code (see below: re-running the
  // bookmarklet on a page that already has a panel now always tears down
  // the old instance and rebuilds from the freshly-fetched script, instead
  // of just toggling stale, already-executed code back into view).
  var VERSION = 'v13-2026-08-05';
  console.log('[link-gen-tool] loaded ' + VERSION);

  // document.currentScript is only reliable synchronously during this
  // script's own initial execution (it's the <script> tag the bookmarklet
  // created), so capture its src right here at the top - attemptAutoLogin
  // needs this later to inject the same script into a new same-origin tab
  // it opens for the login page, instead of hardcoding a URL.
  var SELF_SCRIPT_SRC = (document.currentScript && document.currentScript.src) || null;

  if (window.__lgtPanelInstance) {
    window.__lgtPanelInstance.destroy();
  }

  // ---------------------------------------------------------------------
  // Config / data (kept in sync with BRANDS.md / BRAND_DOMAINS.md)
  // ---------------------------------------------------------------------

  var BRANDS = {
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

  // brand key -> real customer-facing domain, used for hostname auto-detection
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

  // Brand-specific login form + post-login sportsbook-nav selectors.
  // EXPERIMENTAL / best-effort: unlike the passive capture mechanism (which
  // needs no selectors at all and is fully validated), these CSS selectors
  // can go stale as brand sites change their markup (NordicBet's real
  // username field is a plain light-DOM `input[name="email"]`, not
  // `input[name="username"]`/`input[type="email"]` as an earlier version
  // assumed - fixed 2026-08 via live DOM inspection). Even with correct
  // selectors, the final submit click may not complete a real login -
  // NordicBet's GroupIB fraud-detection (or a flaky same-page real-time
  // connection) appears to reject/reset the synthetic submission in
  // testing, with no login API call ever firing. Auto-login may still save
  // typing time, but log in manually (a real click) to actually complete
  // the login - the passive capture below keeps working regardless of who
  // clicked. Unmapped brands still get passive header capture, just no
  // auto-fill/auto-submit.
  var LOGIN_SELECTORS = {
    nordicbet: {
      loginPath: '/en/login',
      usernameSelector: 'input[name="email"], input#email-input, input[name="username"], input[type="email"]',
      passwordSelector: 'input[name="password"], input[type="password"]',
      submitSelector: '[data-test-id="account-login-btn-1-button"], button[type="submit"]',
      sportsbookNavText: /sportsbook/i
    },
    mobilbahis: {
      loginPath: '/tr/giris',
      usernameSelector: 'input[type="email"], input[name="username"]',
      passwordSelector: 'input[type="password"]',
      submitSelector: 'button[type="submit"]',
      sportsbookNavText: /m-bahis|spor/i
    }
  };

  var ENV_LABELS = ['test', 'qa', 'alpha', 'prod'];

  // ---------------------------------------------------------------------
  // Vault client - first-party localStorage on the CURRENT page's own
  // origin. A cross-brand-shared credential requires manual Export/Import
  // (see Credentials tab) since cross-origin storage sharing does not
  // survive Chrome's third-party storage partitioning (or stricter
  // corporate policies that block third-party storage outright).
  // ---------------------------------------------------------------------

  var VAULT_KEY = 'lgt-credentials-v1';

  var Vault = (function () {
    function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

    function readAll() {
      try {
        var raw = localStorage.getItem(VAULT_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) { return []; }
    }

    function writeAll(list) {
      try { localStorage.setItem(VAULT_KEY, JSON.stringify(list)); } catch (e) {}
    }

    return {
      init: function () {}, // no-op, kept for API stability
      getAll: function (cb) { var list = readAll(); if (cb) cb(list); return list; },
      save: function (label, username, password, cb) {
        var list = readAll();
        list.push({ id: uid(), label: label, username: username, password: password, isDefault: list.length === 0 });
        writeAll(list);
        if (cb) cb(list);
      },
      setDefault: function (id, cb) {
        var list = readAll();
        list.forEach(function (c) { c.isDefault = (c.id === id); });
        writeAll(list);
        if (cb) cb(list);
      },
      remove: function (id, cb) {
        var list = readAll().filter(function (c) { return c.id !== id; });
        if (list.length && !list.some(function (c) { return c.isDefault; })) list[0].isDefault = true;
        writeAll(list);
        if (cb) cb(list);
      },
      getDefault: function () { var list = readAll(); return list.find(function (c) { return c.isDefault; }) || list[0] || null; },
      getCached: function () { return readAll(); },
      // Cross-brand sync: base64-encoded JSON snapshot the user copies from
      // one brand domain's Credentials tab and pastes into another's.
      exportCode: function () {
        try { return btoa(unescape(encodeURIComponent(JSON.stringify(readAll())))); }
        catch (e) { return ''; }
      },
      importCode: function (code, cb) {
        var list = readAll();
        try {
          var incoming = JSON.parse(decodeURIComponent(escape(atob(String(code || '').trim()))));
          if (!Array.isArray(incoming)) throw new Error('bad format');
          var seen = list.map(function (c) { return c.username + '|' + c.password; });
          incoming.forEach(function (c) {
            var key = c.username + '|' + c.password;
            if (seen.indexOf(key) === -1 && c.username && c.password) {
              list.push({ id: uid(), label: c.label || c.username, username: c.username, password: c.password, isDefault: list.length === 0 });
              seen.push(key);
            }
          });
          writeAll(list);
          if (cb) cb(list, true);
        } catch (e) {
          if (cb) cb(list, false);
        }
      }
    };
  })();

  // ---------------------------------------------------------------------
  // Mode A: Generate Link (client-side port of generate-link.ps1)
  // ---------------------------------------------------------------------

  function apiBase(env) {
    return 'https://internal.' + env + '.sbplayground1.net';
  }

  function generateLink(opts) {
    // opts: { brand, environment, loggedIn, customerKeyFilter, bleSource }
    var brandGuid = BRANDS[opts.brand];
    if (!brandGuid) return Promise.reject(new Error('Unknown brand: ' + opts.brand));

    var apiEnv = opts.bleSource ? 'prod' : opts.environment;
    var base = apiBase(apiEnv);
    var prefix = opts.loggedIn ? 'logged-in' : 'logged-out';
    var filter = (opts.customerKeyFilter || '').toLowerCase();

    return fetch(base + '/api/customers/' + brandGuid)
      .then(function (r) {
        if (!r.ok) throw new Error('customers fetch failed: HTTP ' + r.status);
        return r.json();
      })
      .then(function (customers) {
        var keys = Object.keys(customers).filter(function (k) {
          return k.toLowerCase().indexOf(prefix) === 0 && k.toLowerCase().indexOf(filter) !== -1;
        });
        if (keys.length === 0) {
          var available = Object.keys(customers).filter(function (k) { return k.toLowerCase().indexOf(prefix) === 0; });
          throw new Error('No customer key matched prefix "' + prefix + '" + filter "' + filter + '". Available: ' + available.join(', '));
        }
        var customerKey = keys[0];
        var uri = base + '/api/user-context/' + customerKey +
          '?brand=' + brandGuid + '&shouldUseSbIl=false&generateLinksPage=true&overrideIFrameBaseUrlWith=';
        return fetch(uri).then(function (r) {
          if (!r.ok) throw new Error('user-context fetch failed: HTTP ' + r.status);
          return r.json();
        }).then(function (data) {
          return buildLinksFromContext(data, opts);
        }).then(function (links) {
          links.customerKey = customerKey;
          links.customerLabel = (customers[customerKey] || {}).label || customerKey;
          return links;
        });
      });
  }

  function buildLinksFromContext(resp, opts) {
    function buildFor(device) {
      var userNode = ((resp.data || {}).user || {})[device] || {};
      var ctxNode = ((resp.data || {}).context || {})[device] || {};
      var base = (userNode.iFrameSetup || {}).overrideIFrameBaseUrlWith;
      if (!base) base = (ctxNode.iFrameHelper || {}).baseUri;
      var stc = (ctxNode.customerContext || {}).staticContextId;
      var ctx = (ctxNode.customerContext || {}).userContextId;
      if (!base || !stc || !ctx) return null;

      if (opts.bleSource) {
        base = base.replace(/^(https:\/\/[^.]+\.)/, '$1' + opts.environment + '.');
        return base + '/' + stc + '/' + ctx + '/?bleSource=1&exposeObgState=true&exposeObgRt=true&sealStore=false';
      }
      return base + '/' + stc + '/' + ctx + '/?exposeObgState=true&exposeObgRt=true&sealStore=false';
    }

    return { desktop: buildFor('desktop'), mobile: buildFor('mobile') };
  }

  // Splice a captured (stc, ctx) pair into a freshly generated logged-out
  // base link for the same brand/env/device (used by Mode B).
  //
  // The base link path is always /{segment1}/{segment2}/ where segment1 is
  // the static context id (always "stc[-]-<num>") and segment2 is the
  // user/customer context id - but segment2's OWN prefix varies: anonymous
  // links reuse "stc-<num>" for segment2 too (e.g. .../stc--123/stc--123/),
  // while real logged-in captures look like ".../stc--123/ctx-<hex>/". So we
  // replace by POSITION (first two path segments after the host), not by
  // assuming a "ctx-" prefix is present in the base link.
  function spliceContext(baseLink, stc, ctx) {
    if (!baseLink) return null;
    var m = baseLink.match(/^(https:\/\/[^/]+\/)([^/]+)\/([^/?]+)(\/.*)$/);
    if (!m) return null;
    return m[1] + stc + '/' + ctx + m[4];
  }

  // ---------------------------------------------------------------------
  // Mode B: Live-Login Capture (passive header sniffing + optional
  // simulated-typing auto-login)
  // ---------------------------------------------------------------------

  var Capture = (function () {
    // State lives on `window`, not in this closure. The bookmarklet's
    // fetch/XHR monkey-patch below only ever applies once per page (it's
    // guarded by __lgtPatched), so if the panel is re-injected later
    // (bookmarklet clicked again without a full page reload), a *new*
    // Capture closure is created here but the *original* patched
    // fetch/XHR still calls the *original* considerHeaders/notify. Keeping
    // captured/listeners on a shared window-level object means every
    // Capture instance - old or freshly re-injected - reads and writes the
    // same state, so re-injection can never silently stop receiving
    // capture events.
    var CAPTURE_STORAGE_KEY = '__lgtCaptureData';

    // A same-origin full-page navigation (e.g. a login form that redirects
    // to the logged-in homepage instead of an in-place SPA route change)
    // wipes window.__lgtCaptureState entirely, along with whatever the
    // fetch/XHR patch below already captured - even if the capture
    // succeeded moments before the reload. Restore from sessionStorage on
    // a fresh instance so a capture made just before such a navigation
    // isn't silently lost.
    var restored = null;
    if (!window.__lgtCaptureState) {
      try {
        var rawRestore = sessionStorage.getItem(CAPTURE_STORAGE_KEY);
        if (rawRestore) restored = JSON.parse(rawRestore);
      } catch (e) {}
    }
    var state = window.__lgtCaptureState = window.__lgtCaptureState || {
      captured: restored || { stc: null, ctx: null, source: null },
      seenCount: 0,
      listeners: []
    };

    function notify() { state.listeners.forEach(function (l) { l(state.captured); }); }

    function considerHeaders(headers, url) {
      if (!/sb\/fe-api\//.test(url || '')) return;
      // Counts every sb/fe-api call seen, even ones missing the headers we
      // need - exposed via getSeenCount() so the panel can show concrete
      // progress ("N calls observed") instead of a static "still waiting"
      // message that gives no signal about whether anything is happening.
      state.seenCount = (state.seenCount || 0) + 1;
      // Header casing varies by call site - normalize to lowercase before lookup.
      var normalized = {};
      Object.keys(headers || {}).forEach(function (k) { normalized[k.toLowerCase()] = headers[k]; });
      var stc = normalized['x-sb-static-context-id'];
      var ctx = normalized['x-sb-user-context-id'];
      if (stc && ctx) {
        state.captured.stc = stc;
        state.captured.ctx = ctx;
        state.captured.source = url;
        try { sessionStorage.setItem(CAPTURE_STORAGE_KEY, JSON.stringify(state.captured)); } catch (e) {}
        notify();
      }
    }

    function patchFetch() {
      var origFetch = window.fetch;
      if (!origFetch || origFetch.__lgtPatched) return;
      window.fetch = function (input, init) {
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          var headers = {};
          var h = (init && init.headers) || (input && input.headers);
          if (h) {
            if (h instanceof Headers) h.forEach(function (v, k) { headers[k] = v; });
            else Object.keys(h).forEach(function (k) { headers[k] = h[k]; });
          }
          considerHeaders(headers, url);
        } catch (e) {}
        return origFetch.apply(this, arguments);
      };
      window.fetch.__lgtPatched = true;
    }

    function patchXHR() {
      var origOpen = XMLHttpRequest.prototype.open;
      var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
      if (origOpen.__lgtPatched) return;

      XMLHttpRequest.prototype.open = function (method, url) {
        this.__lgtUrl = url;
        this.__lgtHeaders = {};
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.open.__lgtPatched = true;

      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (this.__lgtHeaders) this.__lgtHeaders[name] = value;
        considerHeaders(this.__lgtHeaders || {}, this.__lgtUrl || '');
        return origSetHeader.apply(this, arguments);
      };
    }

    return {
      start: function () { patchFetch(); patchXHR(); },
      onCapture: function (cb) { state.listeners.push(cb); },
      get: function () { return state.captured; },
      getSeenCount: function () { return state.seenCount || 0; },
      reset: function () {
        state.captured = { stc: null, ctx: null, source: null };
        state.seenCount = 0;
        try { sessionStorage.removeItem(CAPTURE_STORAGE_KEY); } catch (e) {}
      }
    };
  })();

  function detectBrandAndEnv() {
    var host = location.hostname.toLowerCase();
    var labels = host.split('.');
    var env = 'prod';
    ENV_LABELS.forEach(function (e) {
      if (e !== 'prod' && labels.indexOf(e) !== -1) env = e;
    });
    var strippedHost = labels.filter(function (l) { return l !== 'www' && ENV_LABELS.indexOf(l) === -1; }).join('.');

    var brand = null;
    // Note: betssonarcb / btsarba / btsarbacity all resolve to the same
    // real domain (betsson.bet.ar) - they differ by Argentina province, not
    // hostname, so auto-detection can't disambiguate them. Whichever key is
    // iterated last below wins; use the Generate tab's brand selector to
    // override manually for Argentina brands.
    Object.keys(BRAND_DOMAINS).forEach(function (key) {
      if (strippedHost === BRAND_DOMAINS[key] || strippedHost.indexOf(BRAND_DOMAINS[key]) !== -1) {
        brand = key;
      }
    });
    return { brand: brand, environment: env };
  }

  // Simulated human-like typing: real keydown/input events with small
  // randomized delays, not a single `.value =` assignment. Reduces (does
  // not eliminate) behavioral-biometrics detection risk on the submit step.
  function simulateTyping(el, text) {
    return new Promise(function (resolve) {
      var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      el.focus();
      // Browser/site autofill can pre-populate this field before we get to
      // it (e.g. a remembered username). Clear it first instead of
      // appending our text onto whatever's already there, which would
      // otherwise silently corrupt the value (and make the post-typing
      // value === text check below always fail).
      if (el.value) {
        nativeSetter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      var i = 0;
      (function step() {
        if (!el.isConnected) { resolve('detached'); return; }
        if (i >= text.length) {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          resolve(el.value === text ? 'ok' : 'value-mismatch');
          return;
        }
        nativeSetter.call(el, el.value + text[i]);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        i++;
        setTimeout(step, 40 + Math.random() * 90);
      })();
    });
  }

  function simulateClick(el) {
    var rect = el.getBoundingClientRect();
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    ['mousemove', 'mousedown', 'mouseup', 'click'].forEach(function (type) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    });
  }

  // Many brand sites (e.g. NordicBet) build their login form out of web
  // components with open shadow roots - a plain document.querySelector
  // can't see inside those. Recurse into any open shadowRoot as a fallback.
  // (Closed shadow roots remain unreachable from page-injected JS by design;
  // if a brand uses those, auto-login genuinely cannot find the fields and
  // passive capture - which doesn't need to find anything - is the fallback.)
  function deepQuerySelectorAll(selector, root, results) {
    root = root || document;
    results = results || [];
    var found = root.querySelectorAll(selector);
    for (var j = 0; j < found.length; j++) results.push(found[j]);
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) deepQuerySelectorAll(selector, all[i].shadowRoot, results);
    }
    return results;
  }

  function isVisible(elem) {
    if (!elem || !elem.isConnected) return false;
    var rect = elem.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return false;
    var style = window.getComputedStyle(elem);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
    return true;
  }

  // Some brand sites place a hidden decoy input matching the same
  // selector right next to the real one (a common anti-autofill / anti-
  // bot technique, since browsers and naive scripts alike tend to grab
  // the first DOM match). Prefer a visible match; only fall back to the
  // first match overall if none of them look visible.
  function deepQuerySelector(selector, root) {
    var matches = deepQuerySelectorAll(selector, root);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    var visible = matches.filter(isVisible);
    return visible[0] || matches[0];
  }

  // Poll for an element rather than querying once - login forms on these
  // brand sites are client-rendered (React/etc.) and can take a moment to
  // appear/re-render after navigation or after an adjacent field changes.
  // Always returns a FRESH, currently-connected element (never a stale
  // reference captured before a re-render swapped the node out). Prefers
  // a visible match over a hidden decoy field, but if only a hidden match
  // ever appears before the timeout, returns that rather than nothing -
  // still better than failing outright.
  function waitForElement(selector, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var lastSeen = null;
      (function poll() {
        var el = deepQuerySelector(selector);
        if (el) lastSeen = el;
        if (el && isVisible(el)) return resolve(el);
        if (Date.now() - start > timeoutMs) return resolve(lastSeen);
        setTimeout(poll, 150);
      })();
    });
  }

  // Type into `selector` fresh each time (not a reference resolved earlier),
  // retrying once against a freshly re-queried element if the field
  // detaches mid-type or the typed value doesn't stick (both observed
  // symptoms of the form re-rendering the password field shortly after the
  // username field is interacted with). Returns a short status string for
  // logging, never throws.
  function fillField(selector, text, findTimeoutMs, fieldLabel, log) {
    function attempt(attemptsLeft) {
      return waitForElement(selector, findTimeoutMs).then(function (el) {
        if (!el) return fieldLabel + ' field not found';
        var allMatches = deepQuerySelectorAll(selector);
        if (allMatches.length > 1) {
          log(fieldLabel + ' selector matched ' + allMatches.length + ' elements' +
            (isVisible(el) ? ' - using the visible one.' : ' - none looked visible, using the first match (may be a hidden decoy field).'));
        } else if (!isVisible(el)) {
          log(fieldLabel + ' field found but not visible - filling it anyway, may not be the real field.');
        }
        return simulateTyping(el, text).then(function (result) {
          if (result === 'ok') return 'ok';
          log(fieldLabel + ' field ' + result + ' while typing' + (attemptsLeft > 0 ? ' - retrying...' : ' - giving up.'));
          if (attemptsLeft > 0) return attempt(attemptsLeft - 1);
          return fieldLabel + ' field ' + result;
        });
      });
    }
    return attempt(1);
  }

  // Polls whether we're still on the login page after a submit click, up
  // to timeoutMs. Resolves 'navigated' as soon as the pathname no longer
  // contains loginPath, or 'stuck' once the timeout elapses while still
  // there - the generic, brand-agnostic signal that the click likely
  // didn't take effect (no page-specific "did the login API get called"
  // check is attempted, since that would need per-brand knowledge this
  // tool otherwise avoids relying on).
  function watchForSubmitOutcome(loginPath, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var iv = setInterval(function () {
        var stillOnLogin = true;
        try { stillOnLogin = location.pathname.indexOf(loginPath) !== -1; } catch (e) {}
        if (!stillOnLogin) { clearInterval(iv); resolve('navigated'); return; }
        if (Date.now() - start > timeoutMs) { clearInterval(iv); resolve('stuck'); }
      }, 300);
    });
  }

  var RESUME_KEY = '__lgtAutoLoginResume';
  // Separate, simpler breadcrumb from RESUME_KEY above: RESUME_KEY only
  // triggers when we're still ON the login path (it re-attempts the
  // fill/submit flow), so it deliberately does NOT fire once the user has
  // navigated past login - otherwise a freshly re-injected panel there
  // would default back to the "Generate" tab, hiding the very capture
  // status the user needs to see right after a successful auto-login.
  var POST_LOGIN_KEY = '__lgtPostLoginReinject';

  // Polls a same-origin window handle (opened via window.open below) until
  // it has finished navigating to a page whose pathname contains
  // expectedPath, or gives up after timeoutMs. Wrapped in try/catch
  // throughout because some sites send a Cross-Origin-Opener-Policy header
  // that isolates the popup's browsing context group even though it's
  // same-origin - every property read below throws in that case, which is
  // indistinguishable from "not ready yet" until the timeout hits (then
  // it's treated as "give up, fall back to manual").
  function waitForWindowReady(win, expectedPath, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var iv = setInterval(function () {
        var closed = true;
        try { closed = !win || win.closed; } catch (e) { closed = true; }
        if (closed) { clearInterval(iv); resolve(false); return; }
        var ready = false;
        try {
          ready = win.document && win.document.readyState === 'complete' &&
            win.location.pathname.indexOf(expectedPath) !== -1;
        } catch (e) { ready = false; }
        if (ready) { clearInterval(iv); resolve(true); return; }
        if (Date.now() - start > timeoutMs) { clearInterval(iv); resolve(false); }
      }, 200);
    });
  }

  // Injects the exact same <script src=...> tag the bookmarklet itself
  // creates (see index.html) into a same-origin window handle, so the tool
  // starts running there exactly as if the user had clicked the bookmarklet
  // a second time themselves. Returns false if that isn't possible (no
  // captured script URL, or the window's document isn't reachable).
  function injectScriptInto(win) {
    if (!SELF_SCRIPT_SRC) return false;
    try {
      var s = win.document.createElement('script');
      s.src = SELF_SCRIPT_SRC.split('?')[0] + '?t=' + Date.now();
      win.document.body.appendChild(s);
      return true;
    } catch (e) { return false; }
  }

  // Getting the tool running on the *login* page (above) is only half of
  // this problem. If the site's login-success handler does a *hard*
  // full-page navigation (a real reload/redirect, not an in-place SPA
  // route change) once the user actually logs in, that instantly destroys
  // the new tab's script/panel/Capture instance - with zero chance for
  // anything running there to log a message, auto-resume, or keep
  // passively capturing stc/ctx on whatever page loads next. This was the
  // actual, unaddressed cause of "auto/manual login succeeds, but Build
  // final link from capture still says nothing was captured": the user has
  // to know to manually re-click the bookmarklet on the fresh post-login
  // page for capture to have any chance at all, and any request that fires
  // before they do so is missed.
  //
  // This ORIGINAL tab's own script is untouched by any of that (it never
  // navigated), so it can watch the popup from the outside and re-inject
  // there the moment it notices the login page has been left behind -
  // exactly the same trick used to get the tool running on the login page
  // in the first place, just applied on the way back out. If it turns out
  // to have been an in-place SPA route change instead (nothing torn down),
  // the new tab's own panel is still alive and already handled it via
  // watchForSubmitOutcome below - __lgtPanelInstance is checked first so
  // this never double-injects on top of a still-running instance.
  function watchForLoginSuccessAndReinject(win, loginPath, log) {
    var start = Date.now();
    var timeoutMs = 3 * 60 * 1000; // generous - covers the "click Log In yourself" fallback window too
    var iv = setInterval(function () {
      var closed = true;
      try { closed = !win || win.closed; } catch (e) { closed = true; }
      if (closed) { clearInterval(iv); return; }
      if (Date.now() - start > timeoutMs) { clearInterval(iv); return; }
      var pastLogin = false, complete = false, alreadyLive = false;
      try {
        pastLogin = win.location.pathname.indexOf(loginPath) === -1;
        complete = win.document && win.document.readyState === 'complete';
        alreadyLive = !!win.__lgtPanelInstance;
      } catch (e) { return; } // COOP-isolated or not ready yet - keep polling
      if (!pastLogin || !complete) return;
      clearInterval(iv);
      if (alreadyLive) return; // SPA route change - its own panel is already alive and handling this
      try { win.sessionStorage.setItem(POST_LOGIN_KEY, '1'); } catch (e) {}
      if (injectScriptInto(win)) {
        log('Login succeeded - the new tab navigated away from the login page, and its tool was re-injected automatically so passive capture keeps running there.');
      }
    }, 500);
  }

  function attemptAutoLogin(brandKey, username, password, log) {
    var sel = LOGIN_SELECTORS[brandKey];
    if (!sel) {
      log('No known login selectors for brand "' + brandKey + '". Log in manually - capture stays passive and automatic.');
      return Promise.resolve(false);
    }
    if (location.pathname.indexOf(sel.loginPath) === -1) {
      // Leave a short-lived breadcrumb before going anywhere - a
      // same-origin popup opened via window.open() below inherits a copy
      // of this tab's sessionStorage at creation time (per spec), so
      // resumeAutoLoginIfPending() picks this up automatically no matter
      // how the script ends up running on the login page (auto-injected
      // below, or manually re-clicked as a fallback).
      try {
        sessionStorage.setItem(RESUME_KEY, JSON.stringify({ brand: brandKey, ts: Date.now() }));
      } catch (e) {}

      var targetUrl = location.origin + sel.loginPath;
      var win;
      try { win = window.open(targetUrl, '_blank'); } catch (e) { win = null; }

      if (!win) {
        // Popup blocked (or window.open unavailable here) - fall back to
        // the old behaviour: navigate this tab. That tears down this
        // script instance, but the breadcrumb above still lets it
        // auto-resume once the user re-clicks the bookmarklet on the
        // login page.
        log('Could not open a new tab (popup blocked?) - navigating this tab instead. Re-click the bookmarklet once on the login page; it will then resume automatically.');
        location.href = targetUrl;
        return Promise.resolve(false);
      }

      log('Opened login page in a new tab - attempting to continue automatically there...');
      return waitForWindowReady(win, sel.loginPath, 15000).then(function (ready) {
        if (ready && injectScriptInto(win)) {
          log('Started auto-login in the new tab - switch to it to watch progress.');
          // Keep watching from here (this tab was never navigated, so it's
          // unaffected either way) so that IF login succeeds via a hard
          // page navigation there - which would otherwise silently destroy
          // the new tab's tool with no chance to auto-resume - it gets
          // re-injected automatically instead of requiring the user to
          // notice and re-click the bookmarklet themselves.
          watchForLoginSuccessAndReinject(win, sel.loginPath, log);
          return false; // this tab's job is done; the new tab's own panel takes over
        }
        log('Could not continue automatically in the new tab (it may be isolated from this page) - switch to it and click the bookmarklet there once; it will then resume automatically.');
        return false;
      });
    }
    log('Looking for username field...');
    return fillField(sel.usernameSelector, username, 6000, 'Username', log).then(function (userResult) {
      if (userResult !== 'ok') {
        log('Stopped: ' + userResult + '. Log in manually - capture stays passive and automatic either way.');
        return false;
      }
      log('Username filled. Looking for password field...');
      // Re-query for the password field from scratch here (not resolved
      // together with username up front) - if the form re-renders/enables
      // the password field only after the username interaction, this is
      // what actually finds the live one instead of a stale/detached node.
      return fillField(sel.passwordSelector, password, 4000, 'Password', log).then(function (passResult) {
        if (passResult !== 'ok') {
          log('Stopped: ' + passResult + '. Log in manually - capture stays passive and automatic either way.');
          return false;
        }
        log('Password filled. Looking for submit button...');
        return waitForElement(sel.submitSelector, 3000).then(function (submitEl) {
          if (!submitEl) {
            log('Stopped: submit button not found. Log in manually - both fields are filled, just click Log In.');
            return false;
          }
          log('Submitting...');
          simulateClick(submitEl);
          // Some brand sites (e.g. NordicBet's GroupIB fraud-detection,
          // per LOGIN_SELECTORS comment above) silently reject/reset a
          // synthetic submit click - no error, no navigation, the login
          // form just sits there. Without this, the panel would say
          // "Submitting..." forever with zero feedback on whether it's
          // still working or has actually stalled. Poll for a few seconds
          // and, if we're still on the login path, say so plainly instead
          // of leaving the user guessing.
          return watchForSubmitOutcome(sel.loginPath, 4000).then(function (outcome) {
            if (outcome === 'stuck') {
              log('Both fields are filled, but still on the login page a few seconds after submitting - this site may be rejecting the synthetic click (known limitation on some brands). Click "Log In" yourself to finish.');
            } else {
              log('Submitted - navigated away from the login page.');
            }
            return true;
          });
        });
      });
    });
  }

  // ---------------------------------------------------------------------
  // Panel UI
  // ---------------------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'style') node.style.cssText = attrs[k];
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else if (c) node.appendChild(c);
    });
    return node;
  }

  function buildPanel() {
    var style = document.createElement('style');
    style.id = 'lgt-panel-style';
    style.textContent = [
      '#lgt-panel{position:fixed;top:20px;right:20px;width:360px;max-height:88vh;overflow:auto;',
      'background:#101320;color:#f6f7fb;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      'border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.4);z-index:2147483647;padding:14px;}',
      '#lgt-panel h3{margin:0 0 8px;font-size:15px;display:flex;justify-content:space-between;align-items:center}',
      '#lgt-panel .lgt-tabs{display:flex;gap:6px;margin-bottom:10px}',
      '#lgt-panel .lgt-tab{flex:1;text-align:center;padding:6px;border-radius:6px;background:#1c2233;cursor:pointer}',
      '#lgt-panel .lgt-tab.active{background:#ff6600;color:#101320;font-weight:600}',
      '#lgt-panel label{display:block;margin:8px 0 3px;color:#9aa3b8;font-size:11px;text-transform:uppercase}',
      '#lgt-panel select,#lgt-panel input{width:100%;box-sizing:border-box;padding:6px;border-radius:5px;border:1px solid #2b3350;background:#1c2233;color:#f6f7fb}',
      '#lgt-panel button{margin-top:10px;width:100%;padding:8px;border:none;border-radius:6px;background:#ff6600;color:#101320;font-weight:600;cursor:pointer}',
      '#lgt-panel button.secondary{background:#2b3350;color:#f6f7fb;margin-top:6px}',
      '#lgt-panel .lgt-row{display:flex;gap:8px}',
      '#lgt-panel .lgt-row > *{flex:1}',
      '#lgt-panel .lgt-result{margin-top:10px;background:#1c2233;border-radius:6px;padding:8px;word-break:break-all;font-size:11px}',
      '#lgt-panel .lgt-log{margin-top:8px;font-size:11px;color:#9aa3b8;white-space:pre-wrap}',
      '#lgt-panel .lgt-close{cursor:pointer;color:#9aa3b8}',
      '#lgt-panel .lgt-cred{display:flex;justify-content:space-between;align-items:center;background:#1c2233;padding:6px;border-radius:5px;margin-top:6px}',
      '#lgt-panel .lgt-cred.default{border:1px solid #ff6600}',
      '#lgt-panel .lgt-cred button{width:auto;margin:0;padding:3px 8px;font-size:11px}'
    ].join('');
    document.head.appendChild(style);

    var panel = el('div', { id: 'lgt-panel' });
    var titleText = el('span', {}, ['Link Gen Tool ', el('span', { style: 'opacity:.5;font-weight:400;font-size:10px' }, [VERSION])]);
    var title = el('h3', {}, [titleText, el('span', { class: 'lgt-close', onclick: function () { panel.style.display = 'none'; } }, ['x'])]);
    var tabs = el('div', { class: 'lgt-tabs' });
    var tabA = el('div', { class: 'lgt-tab active' }, ['Generate']);
    var tabB = el('div', { class: 'lgt-tab' }, ['Live Login']);
    var tabC = el('div', { class: 'lgt-tab' }, ['Credentials']);
    tabs.appendChild(tabA); tabs.appendChild(tabB); tabs.appendChild(tabC);

    var bodyA = buildModeA();
    var bodyB = buildModeB();
    var bodyC = buildModeC();
    bodyB.style.display = 'none';
    bodyC.style.display = 'none';

    // Single shared array so the `p === pair` identity check in the click
    // handler below actually matches - two separately-created array literals
    // with the same elements are never === equal, which previously made the
    // match always false and hid every tab body (including the clicked one).
    var pairs = [[tabA, bodyA], [tabB, bodyB], [tabC, bodyC]];
    pairs.forEach(function (pair) {
      pair[0].addEventListener('click', function () {
        pairs.forEach(function (p) {
          p[0].classList.toggle('active', p === pair);
          p[1].style.display = p === pair ? '' : 'none';
        });
      });
    });

    panel.appendChild(title);
    panel.appendChild(tabs);
    panel.appendChild(bodyA);
    panel.appendChild(bodyB);
    panel.appendChild(bodyC);
    (document.body || document.documentElement).appendChild(panel);
    // Exposed for bootstrap's auto-login-resume-after-navigation handling.
    panel.__lgtSwitchToLiveLogin = function () { tabB.click(); };
    panel.__lgtAutoLoginBtn = bodyB.__lgtAutoLoginBtn;
    return panel;
  }

  function brandOptions(selected) {
    return Object.keys(BRANDS).sort().map(function (k) {
      return el('option', Object.assign({ value: k }, k === selected ? { selected: 'selected' } : {}), [k]);
    });
  }

  function buildModeA() {
    var wrap = el('div', {});
    var brandSel = el('select', {}, brandOptions());
    var envSel = el('select', {}, ENV_LABELS.map(function (e) { return el('option', { value: e }, [e]); }));
    var loginSel = el('select', {}, [el('option', { value: 'out' }, ['logged-out']), el('option', { value: 'in' }, ['logged-in'])]);
    var bleChk = el('input', { type: 'checkbox' });
    var filterInput = el('input', { type: 'text', placeholder: 'e.g. turkey, restofworld' });
    var result = el('div', { class: 'lgt-result', style: 'display:none' });
    var log = el('div', { class: 'lgt-log' });

    var btn = el('button', {
      onclick: function () {
        result.style.display = 'none';
        log.textContent = 'Generating...';
        generateLink({
          brand: brandSel.value,
          environment: envSel.value,
          loggedIn: loginSel.value === 'in',
          customerKeyFilter: filterInput.value,
          bleSource: bleChk.checked
        }).then(function (links) {
          log.textContent = 'Customer: ' + links.customerLabel;
          result.style.display = '';
          result.innerHTML = '';
          result.appendChild(renderLinkRow('Desktop', links.desktop));
          result.appendChild(renderLinkRow('Mobile', links.mobile));
        }).catch(function (err) {
          log.textContent = 'Error: ' + err.message;
        });
      }
    }, ['Generate']);

    wrap.appendChild(el('label', {}, ['Brand']));
    wrap.appendChild(brandSel);
    wrap.appendChild(el('div', { class: 'lgt-row' }, [
      (function () { var d = el('div', {}); d.appendChild(el('label', {}, ['Environment'])); d.appendChild(envSel); return d; })(),
      (function () { var d = el('div', {}); d.appendChild(el('label', {}, ['Login state'])); d.appendChild(loginSel); return d; })()
    ]));
    wrap.appendChild(el('label', {}, ['Customer key filter (optional)']));
    wrap.appendChild(filterInput);
    var bleWrap = el('label', { style: 'display:flex;align-items:center;gap:6px;text-transform:none;margin-top:8px' }, [bleChk, ' BLE source (fresh live events on test/qa)']);
    wrap.appendChild(bleWrap);
    wrap.appendChild(btn);
    wrap.appendChild(log);
    wrap.appendChild(result);
    return wrap;
  }

  function renderLinkRow(label, link) {
    var row = el('div', { style: 'margin-bottom:6px' });
    row.appendChild(el('div', { style: 'color:#9aa3b8' }, [label]));
    var linkText = el('div', {}, [link || '(not available)']);
    row.appendChild(linkText);
    if (link) {
      row.appendChild(el('button', {
        class: 'secondary', onclick: function () {
          navigator.clipboard.writeText(link);
        }
      }, ['Copy ' + label]));
    }
    return row;
  }

  function buildModeB() {
    var wrap = el('div', {});
    var detected = detectBrandAndEnv();
    var info = el('div', { class: 'lgt-log' }, [
      'Detected: ' + (detected.brand || 'unknown brand') + ' / ' + detected.environment
    ]);
    var status = el('div', { class: 'lgt-log' }, ['Passive capture running. Log in normally, or use Auto-login below.']);
    var result = el('div', { class: 'lgt-result', style: 'display:none' });

    function renderCapturedStatus(c) {
      status.textContent = 'Captured! stc=' + c.stc + ' ctx=' + c.ctx;
    }

    // If this is a fresh script instance but a capture already happened
    // (restored from sessionStorage after a same-origin navigation, or
    // already sitting in window.__lgtCaptureState from an earlier
    // re-injection on this same page) - reflect that immediately instead
    // of showing the generic "still waiting" message until the next new
    // capture event fires.
    var already = Capture.get();
    if (already.stc && already.ctx) {
      renderCapturedStatus(already);
    } else {
      // No full capture yet - poll the seen-count of sb/fe-api calls that
      // DID fire but were missing one of the two headers we need, so it's
      // visible whether passive capture is seeing any relevant traffic at
      // all instead of a static message giving zero signal either way.
      var seenPoll = setInterval(function () {
        if (Capture.get().stc) { clearInterval(seenPoll); return; }
        var n = Capture.getSeenCount();
        if (n > 0) {
          status.textContent = 'Passive capture running - ' + n + ' sb/fe-api call(s) observed, none with both headers yet.';
        }
      }, 1000);
      // Stop polling after 10 minutes regardless - avoids leaving a timer
      // running forever against a detached panel if the user closes the
      // panel or the bookmarklet gets re-clicked (a fresh instance takes
      // over) without this one ever seeing a full capture.
      setTimeout(function () { clearInterval(seenPoll); }, 10 * 60 * 1000);
    }

    Capture.onCapture(renderCapturedStatus);

    var autoBtn = el('button', {
      onclick: function () {
        var cred = Vault.getDefault();
        if (!cred) { status.textContent = 'No saved credential yet - add one in the Credentials tab first.'; return; }
        if (!detected.brand) { status.textContent = 'Brand not recognized from this hostname - log in manually.'; return; }
        attemptAutoLogin(detected.brand, cred.username, cred.password, function (m) { status.textContent = m; });
      }
    }, ['Auto-login with default credential']);
    // Exposed so bootstrap can resume the flow automatically after the
    // login-page navigation below, without the user having to switch to
    // this tab and click the button again by hand.
    wrap.__lgtAutoLoginBtn = autoBtn;

    var buildBtn = el('button', {
      class: 'secondary',
      onclick: function () {
        var c = Capture.get();
        if (!c.stc || !c.ctx) { status.textContent = 'Nothing captured yet.'; return; }
        if (!detected.brand) { status.textContent = 'Brand not recognized - cannot build base link.'; return; }
        status.textContent = 'Building link...';
        generateLink({ brand: detected.brand, environment: detected.environment, loggedIn: false }).then(function (links) {
          result.style.display = '';
          result.innerHTML = '';
          result.appendChild(renderLinkRow('Desktop', spliceContext(links.desktop, c.stc, c.ctx)));
          result.appendChild(renderLinkRow('Mobile', spliceContext(links.mobile, c.stc, c.ctx)));
          status.textContent = 'Done.';
        }).catch(function (err) { status.textContent = 'Error: ' + err.message; });
      }
    }, ['Build final link from capture']);

    wrap.appendChild(info);
    wrap.appendChild(autoBtn);
    wrap.appendChild(buildBtn);
    wrap.appendChild(status);
    wrap.appendChild(result);
    return wrap;
  }

  function buildModeC() {
    var wrap = el('div', {});
    var list = el('div', {});
    var labelIn = el('input', { type: 'text', placeholder: 'Label (e.g. "shared QA user")' });
    var userIn = el('input', { type: 'text', placeholder: 'Username' });
    var passIn = el('input', { type: 'password', placeholder: 'Password' });

    function render(creds) {
      list.innerHTML = '';
      if (!creds.length) { list.appendChild(el('div', { class: 'lgt-log' }, ['No saved credentials yet.'])); return; }
      creds.forEach(function (c) {
        var row = el('div', { class: 'lgt-cred' + (c.isDefault ? ' default' : '') });
        row.appendChild(el('div', {}, [c.label + (c.isDefault ? ' (default)' : '')]));
        var actions = el('div', {});
        if (!c.isDefault) {
          actions.appendChild(el('button', { onclick: function () { Vault.setDefault(c.id, render); } }, ['Set default']));
        }
        actions.appendChild(el('button', { onclick: function () { Vault.remove(c.id, render); } }, ['Delete']));
        row.appendChild(actions);
        list.appendChild(row);
      });
    }

    Vault.getAll(render);

    var addBtn = el('button', {
      onclick: function () {
        if (!userIn.value || !passIn.value) return;
        Vault.save(labelIn.value || userIn.value, userIn.value, passIn.value, render);
        labelIn.value = ''; userIn.value = ''; passIn.value = '';
      }
    }, ['Save credential']);

    wrap.appendChild(el('label', {}, ['Add credential (stored on this brand domain)']));
    wrap.appendChild(labelIn);
    wrap.appendChild(userIn);
    wrap.appendChild(passIn);
    wrap.appendChild(addBtn);
    wrap.appendChild(el('label', {}, ['Saved credentials']));
    wrap.appendChild(list);

    // Cross-brand sync: credentials live in THIS page's own localStorage
    // (first-party, always works). To reuse them on another brand domain,
    // copy the code here and paste it into that domain's Credentials tab.
    var syncStatus = el('div', { class: 'lgt-log' }, []);
    var codeOut = el('input', { type: 'text', readonly: 'readonly', placeholder: 'Click "Copy sync code" to fill this' });
    var codeIn = el('input', { type: 'text', placeholder: 'Paste sync code from another brand tab here' });

    var exportBtn = el('button', {
      class: 'secondary',
      onclick: function () {
        var code = Vault.exportCode();
        codeOut.value = code;
        codeOut.focus();
        codeOut.select();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(function () {
            syncStatus.textContent = 'Copied to clipboard - paste it in the Credentials tab on the other brand.';
          }, function () {
            syncStatus.textContent = 'Code selected above - copy it manually (Ctrl+C).';
          });
        } else {
          syncStatus.textContent = 'Code selected above - copy it manually (Ctrl+C).';
        }
      }
    }, ['Copy sync code (to use on another brand)']);

    var importBtn = el('button', {
      class: 'secondary',
      onclick: function () {
        if (!codeIn.value.trim()) return;
        Vault.importCode(codeIn.value, function (creds, ok) {
          syncStatus.textContent = ok ? 'Imported. Credentials merged in below.' : 'Invalid sync code - check it was copied fully.';
          render(creds);
          codeIn.value = '';
        });
      }
    }, ['Import sync code']);

    wrap.appendChild(el('label', {}, ['Sync across brand domains (manual - storage is per-domain)']));
    wrap.appendChild(exportBtn);
    wrap.appendChild(codeOut);
    wrap.appendChild(codeIn);
    wrap.appendChild(importBtn);
    wrap.appendChild(syncStatus);
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------

  Vault.init();
  Capture.start();
  var panelEl = buildPanel();

  // Resume an auto-login that was interrupted by the navigation to the
  // brand's login page (see attemptAutoLogin) - runs once per breadcrumb,
  // and only if we're actually on that brand's known login path now.
  (function resumeAutoLoginIfPending() {
    var raw;
    try { raw = sessionStorage.getItem(RESUME_KEY); } catch (e) { return; }
    if (!raw) return;
    try { sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
    var pending;
    try { pending = JSON.parse(raw); } catch (e) { return; }
    if (!pending || !pending.brand || Date.now() - pending.ts > 30000) return; // stale breadcrumb, ignore
    var sel = LOGIN_SELECTORS[pending.brand];
    if (!sel || location.pathname.indexOf(sel.loginPath) === -1) return; // navigation didn't land where expected
    var cred = Vault.getDefault();
    if (!cred) return; // nothing to resume with (shouldn't normally happen - it was there before navigating)
    panelEl.__lgtSwitchToLiveLogin();
    if (panelEl.__lgtAutoLoginBtn) panelEl.__lgtAutoLoginBtn.click();
  })();

  // Companion to the above: fires when this fresh instance was re-injected
  // by watchForLoginSuccessAndReinject right after a hard post-login
  // navigation destroyed the previous instance. Just surfaces the Live
  // Login tab (capture status / seen-count) - never re-attempts login here,
  // since by construction this only runs once we're already past the
  // login path.
  (function showLiveLoginIfJustPastLogin() {
    var flag;
    try { flag = sessionStorage.getItem(POST_LOGIN_KEY); } catch (e) { return; }
    if (!flag) return;
    try { sessionStorage.removeItem(POST_LOGIN_KEY); } catch (e) {}
    panelEl.__lgtSwitchToLiveLogin();
  })();

  window.__lgtPanelInstance = {
    toggle: function () { panelEl.style.display = panelEl.style.display === 'none' ? '' : 'none'; },
    destroy: function () {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
      var oldStyle = document.getElementById('lgt-panel-style');
      if (oldStyle && oldStyle.parentNode) oldStyle.parentNode.removeChild(oldStyle);
    }
  };
})();
