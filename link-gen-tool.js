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
 * Shared test credentials live in a cross-origin vault (vault.html, hosted
 * on this same GitHub Pages origin) so one username/password pair works
 * across every brand domain. See vault.html for the storage protocol.
 */
(function () {
  'use strict';

  if (window.__lgtPanelInstance) {
    window.__lgtPanelInstance.toggle();
    return;
  }

  // ---------------------------------------------------------------------
  // Config / data (kept in sync with BRANDS.md / BRAND_DOMAINS.md)
  // ---------------------------------------------------------------------

  var TOOL_ORIGIN = (function () {
    var s = document.currentScript;
    try {
      if (s && s.src) return new URL(s.src).origin;
    } catch (e) {}
    return 'https://balazs-szonyi.github.io'; // fallback if injected without currentScript (e.g. eval)
  })();
  var VAULT_URL = TOOL_ORIGIN.indexOf('github.io') !== -1
    ? 'https://balazs-szonyi.github.io/link-gen-tool/vault.html'
    : TOOL_ORIGIN + '/vault.html';

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
  // are unverified guesses for brands whose login form lives behind a
  // shadow-DOM-based web-component stack (confirmed on NordicBet, whose
  // real login form was NOT reachable even via a shadow-root-piercing
  // querySelector in testing on 2026-08 - it may only render after further
  // client-side hydration, or behind a closed shadow root, which is
  // fundamentally unreachable from page-injected JS). Auto-login may
  // silently fail to find fields on such brands; when it does, log in
  // manually - the passive capture keeps working regardless. Unmapped
  // brands still get passive header capture, just no auto-fill/auto-submit.
  var LOGIN_SELECTORS = {
    nordicbet: {
      loginPath: '/en/login',
      usernameSelector: 'input[name="username"], input[type="email"]',
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
  // Vault client (cross-origin credential store via hidden iframe)
  // ---------------------------------------------------------------------

  var Vault = (function () {
    var iframe = null;
    var ready = false;
    var pendingCallbacks = [];
    var lastData = [];

    function init() {
      iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = VAULT_URL;
      (document.body || document.documentElement).appendChild(iframe);

      window.addEventListener('message', function (ev) {
        if (!ev.data || ev.data.type !== 'lgt-vault-data') return;
        lastData = ev.data.credentials || [];
        var cbs = pendingCallbacks;
        pendingCallbacks = [];
        cbs.forEach(function (cb) { cb(lastData); });
      });

      iframe.addEventListener('load', function () {
        ready = true;
        send({ type: 'lgt-vault-get' });
      });
    }

    function send(msg, cb) {
      if (cb) pendingCallbacks.push(cb);
      if (!ready) {
        // queue: iframe load handler will fire the initial get; retry shortly
        setTimeout(function () { if (ready) postNow(msg); else send(msg, null); }, 150);
        return;
      }
      postNow(msg);
    }

    function postNow(msg) {
      try {
        var targetOrigin = new URL(VAULT_URL).origin;
        iframe.contentWindow.postMessage(msg, targetOrigin);
      } catch (e) {}
    }

    return {
      init: init,
      getAll: function (cb) { send({ type: 'lgt-vault-get' }, cb); },
      save: function (label, username, password, cb) {
        send({ type: 'lgt-vault-save', credential: { label: label, username: username, password: password } }, cb);
      },
      setDefault: function (id, cb) { send({ type: 'lgt-vault-set-default', id: id }, cb); },
      remove: function (id, cb) { send({ type: 'lgt-vault-delete', id: id }, cb); },
      getDefault: function () { return lastData.find(function (c) { return c.isDefault; }) || lastData[0] || null; },
      getCached: function () { return lastData; }
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
    var captured = { stc: null, ctx: null, source: null };
    var listeners = [];

    function notify() { listeners.forEach(function (l) { l(captured); }); }

    function considerHeaders(headers, url) {
      if (!/sb\/fe-api\//.test(url || '')) return;
      // Header casing varies by call site - normalize to lowercase before lookup.
      var normalized = {};
      Object.keys(headers || {}).forEach(function (k) { normalized[k.toLowerCase()] = headers[k]; });
      var stc = normalized['x-sb-static-context-id'];
      var ctx = normalized['x-sb-user-context-id'];
      if (stc && ctx) {
        captured.stc = stc;
        captured.ctx = ctx;
        captured.source = url;
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
      onCapture: function (cb) { listeners.push(cb); },
      get: function () { return captured; },
      reset: function () { captured = { stc: null, ctx: null, source: null }; }
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
      el.focus();
      var i = 0;
      (function step() {
        if (i >= text.length) { el.dispatchEvent(new Event('change', { bubbles: true })); resolve(); return; }
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
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
  function deepQuerySelector(selector, root) {
    root = root || document;
    var found = root.querySelector(selector);
    if (found) return found;
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) {
        found = deepQuerySelector(selector, all[i].shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  function attemptAutoLogin(brandKey, username, password, log) {
    var sel = LOGIN_SELECTORS[brandKey];
    if (!sel) {
      log('No known login selectors for brand "' + brandKey + '". Log in manually - capture stays passive and automatic.');
      return Promise.resolve(false);
    }
    if (location.pathname.indexOf(sel.loginPath) === -1) {
      log('Navigating to login page: ' + sel.loginPath);
      location.href = location.origin + sel.loginPath;
      return Promise.resolve(false); // page will reload; user re-opens panel / re-runs after nav
    }
    var userEl = deepQuerySelector(sel.usernameSelector);
    var passEl = deepQuerySelector(sel.passwordSelector);
    var submitEl = deepQuerySelector(sel.submitSelector);
    if (!userEl || !passEl || !submitEl) {
      log('Login form fields not found (still rendering, or behind a closed shadow root/iframe this script cannot reach). ' +
        'Log in manually instead - capture stays passive and automatic either way.');
      return Promise.resolve(false);
    }
    log('Filling credentials (simulated typing)...');
    return simulateTyping(userEl, username)
      .then(function () { return simulateTyping(passEl, password); })
      .then(function () {
        log('Submitting...');
        simulateClick(submitEl);
        return true;
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
    var title = el('h3', {}, ['Link Gen Tool', el('span', { class: 'lgt-close', onclick: function () { panel.style.display = 'none'; } }, ['x'])]);
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

    [[tabA, bodyA], [tabB, bodyB], [tabC, bodyC]].forEach(function (pair) {
      pair[0].addEventListener('click', function () {
        [[tabA, bodyA], [tabB, bodyB], [tabC, bodyC]].forEach(function (p) {
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

    Capture.onCapture(function (c) {
      status.textContent = 'Captured! stc=' + c.stc + ' ctx=' + c.ctx;
    });

    var autoBtn = el('button', {
      onclick: function () {
        var cred = Vault.getDefault();
        if (!cred) { status.textContent = 'No saved credential yet - add one in the Credentials tab first.'; return; }
        if (!detected.brand) { status.textContent = 'Brand not recognized from this hostname - log in manually.'; return; }
        attemptAutoLogin(detected.brand, cred.username, cred.password, function (m) { status.textContent = m; });
      }
    }, ['Auto-login with default credential']);

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

    wrap.appendChild(el('label', {}, ['Add credential (shared across all brands)']));
    wrap.appendChild(labelIn);
    wrap.appendChild(userIn);
    wrap.appendChild(passIn);
    wrap.appendChild(addBtn);
    wrap.appendChild(el('label', {}, ['Saved credentials']));
    wrap.appendChild(list);
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------

  Vault.init();
  Capture.start();
  var panelEl = buildPanel();

  window.__lgtPanelInstance = {
    toggle: function () { panelEl.style.display = panelEl.style.display === 'none' ? '' : 'none'; }
  };
})();
