/*
 * Link Gen Tool extension - content script.
 *
 * Ported from the link-gen-tool bookmarklet (link-gen-tool.js), adapted to
 * an extension's naturally different lifecycle:
 *
 *  - This script runs automatically on every page load AND every
 *    navigation (content_scripts auto-inject, no window.open/injection/
 *    sessionStorage-breadcrumb tricks needed at all to "survive" a hard
 *    page navigation the way the bookmarklet had to work around).
 *  - Passive capture itself does not happen here at all - it happens in
 *    background.js via chrome.webRequest, at the network layer, so it
 *    works even on the very first request a page makes, before this
 *    script (or any page script) has had a chance to run. This script
 *    only *reads* the already-captured state from chrome.storage.local.
 *  - The Credentials vault lives in chrome.storage.local (extension-scoped)
 *    instead of per-origin localStorage, so it is automatically shared
 *    across every brand domain - no manual Export/Import sync-code step
 *    needed (that UI is intentionally dropped here; it remains in the
 *    bookmarklet, which still needs it).
 *  - The panel is hidden by default and shown via the toolbar icon (or
 *    automatically, mid-flow, if an auto-login resume is pending) rather
 *    than being built only on an explicit bookmarklet click.
 */
(function () {
  'use strict';

  // Bump this on every content.js change (mirrors the bookmarklet's
  // VERSION convention) - it's shown in the panel title so a user can
  // confirm which build is actually running after reloading the
  // extension, instead of guessing whether a fix "took".
  var VERSION = 'ext-v8-2026-08-06';

  if (window.__lgtExtInstance) {
    window.__lgtExtInstance.destroy();
  }

  // ---------------------------------------------------------------------
  // Config / data (kept in sync with the bookmarklet's own copy)
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

  // See link-gen-tool.js for the same table and its caveats (best-effort,
  // brand markup can go stale, submit may not complete a real login on
  // brands with fraud-detection that rejects synthetic clicks).
  // sportsbookNavPattern: matched against the trimmed visible text of an
  // in-page nav link/tab to reach the Sportsbook section post-login. This
  // MUST be an in-page click (SPA-style client routing), never a hard
  // location.href navigation - a hard reload straight to the sportsbook
  // URL right after login races with session restoration and yields an
  // anonymous "LoggedOut" context instead of the real logged-in one
  // (confirmed 2026-08-05 on NordicBet/test; see the sbplayground-link-
  // generator skill's REFERENCE.md "hard navigation breaks the session"
  // pitfall - live-login-poc.mjs works around it the same way).
  var LOGIN_SELECTORS = {
    nordicbet: {
      loginPath: '/en/login',
      usernameSelector: 'input[name="email"], input#email-input, input[name="username"], input[type="email"]',
      passwordSelector: 'input[name="password"], input[type="password"]',
      submitSelector: '[data-test-id="account-login-btn-1-button"], button[type="submit"]',
      sportsbookNavPattern: /^sportsbook$/i
    },
    mobilbahis: {
      loginPath: '/tr/giris',
      usernameSelector: 'input[type="email"], input[name="username"]',
      passwordSelector: 'input[type="password"]',
      submitSelector: 'button[type="submit"]',
      // Best-effort/unverified via the extension (real-site selectors,
      // same caveat as the rest of this brand's entry) - matches the
      // "M-BAHIS" top-nav tab from the skill's worked example.
      sportsbookNavPattern: /m-bahis/i
    }
  };

  var ENV_LABELS = ['test', 'qa', 'alpha', 'prod'];

  // Builds the URL to the brand's REAL login page (not the sbplayground
  // internal test harness) for a given environment - used to open the
  // background tab for the Generate tab's auto live-login flow. Same
  // env-prefix convention as the rest of this tool (test./qa./alpha.
  // prefix, none for prod). Returns null if the brand isn't known or has
  // no LOGIN_SELECTORS entry (i.e. isn't live-login-capable).
  function realLoginUrl(brandKey, environment) {
    var domain = BRAND_DOMAINS[brandKey];
    var sel = LOGIN_SELECTORS[brandKey];
    if (!domain || !sel) return null;
    var prefix = (environment && environment !== 'prod') ? (environment + '.') : '';
    return 'https://' + prefix + domain + sel.loginPath;
  }


  // ---------------------------------------------------------------------
  // Vault - chrome.storage.local, extension-scoped so it is automatically
  // shared across every brand domain (unlike the bookmarklet's per-origin
  // localStorage, which needed a manual Export/Import sync code). No
  // separate sync UI is needed here as a result.
  // ---------------------------------------------------------------------

  var VAULT_KEY = 'lgt-credentials-v1';

  var Vault = (function () {
    function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

    function readAll(cb) {
      chrome.storage.local.get([VAULT_KEY], function (res) {
        cb((res && res[VAULT_KEY]) || []);
      });
    }

    function writeAll(list, cb) {
      var obj = {};
      obj[VAULT_KEY] = list;
      chrome.storage.local.set(obj, function () { if (cb) cb(list); });
    }

    return {
      getAll: function (cb) { readAll(cb); },
      save: function (label, username, password, cb) {
        readAll(function (list) {
          list.push({ id: uid(), label: label, username: username, password: password, isDefault: list.length === 0 });
          writeAll(list, cb);
        });
      },
      setDefault: function (id, cb) {
        readAll(function (list) {
          list.forEach(function (c) { c.isDefault = (c.id === id); });
          writeAll(list, cb);
        });
      },
      remove: function (id, cb) {
        readAll(function (list) {
          var filtered = list.filter(function (c) { return c.id !== id; });
          if (filtered.length && !filtered.some(function (c) { return c.isDefault; })) filtered[0].isDefault = true;
          writeAll(filtered, cb);
        });
      },
      // Async (unlike the bookmarklet's synchronous version) since
      // chrome.storage.local has no synchronous read API.
      getDefault: function (cb) {
        readAll(function (list) {
          cb(list.find(function (c) { return c.isDefault; }) || list[0] || null);
        });
      }
    };
  })();

  // ---------------------------------------------------------------------
  // Mode A: Generate Link (identical to the bookmarklet - no vault/capture
  // dependency, calls the open-CORS internal.{env}.sbplayground1.net APIs
  // directly from the page).
  // ---------------------------------------------------------------------

  function apiBase(env) {
    return 'https://internal.' + env + '.sbplayground1.net';
  }

  // Upfront check so the Generate tab's live-login fallback (see
  // buildModeA) doesn't have to sniff generateLink()'s error string to
  // decide whether a brand has a real logged-in test customer at all.
  // Per the sbplayground-link-generator skill's REFERENCE.md, only 4/34
  // brands (firestorm, firestormsg, playgurus, sandbox) currently have
  // one - every other brand always resolves false here.
  function hasLoggedInCustomerKey(brand, environment) {
    var brandGuid = BRANDS[brand];
    if (!brandGuid) return Promise.resolve(false);
    return fetch(apiBase(environment) + '/api/customers/' + brandGuid)
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (customers) {
        return Object.keys(customers || {}).some(function (k) { return k.toLowerCase().indexOf('logged-in') === 0; });
      })
      .catch(function () { return false; });
  }

  function generateLink(opts) {
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

  function spliceContext(baseLink, stc, ctx) {
    if (!baseLink) return null;
    var m = baseLink.match(/^(https:\/\/[^/]+\/)([^/]+)\/([^/?]+)(\/.*)$/);
    if (!m) return null;
    return m[1] + stc + '/' + ctx + m[4];
  }

  // ---------------------------------------------------------------------
  // Mode B: Live-Login Capture. Unlike the bookmarklet, capture itself
  // happens in background.js via chrome.webRequest (network layer) - this
  // module just reads chrome.storage.local (per-origin key) and reacts to
  // chrome.storage.onChanged for live updates, no in-page fetch/XHR patch
  // at all, and no polling loop needed for "did anything new arrive".
  // ---------------------------------------------------------------------

  var Capture = (function () {
    var listeners = [];

    function keyForThisOrigin() { return 'lgtCapture:' + location.origin; }

    function notify(entry) { listeners.forEach(function (l) { l(entry); }); }

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      var k = keyForThisOrigin();
      if (changes[k]) notify(changes[k].newValue || { stc: null, ctx: null, source: null, seenCount: 0 });
    });

    return {
      // No-op: background.js captures unconditionally via webRequest,
      // independent of whether/when this content script has run. Kept for
      // API-shape parity with the bookmarklet's Capture module.
      start: function () {},
      onCapture: function (cb) { listeners.push(cb); },
      get: function (cb) {
        chrome.storage.local.get([keyForThisOrigin()], function (res) {
          cb((res && res[keyForThisOrigin()]) || { stc: null, ctx: null, source: null, seenCount: 0 });
        });
      },
      reset: function (cb) {
        chrome.storage.local.remove([keyForThisOrigin()], function () { if (cb) cb(); });
      }
    };
  })();

  // ---------------------------------------------------------------------
  // Auto live-login job coordination (Generate tab -> background tab ->
  // back to the Generate tab), for brands with no real logged-in test
  // customer. chrome.storage.local (not sessionStorage) is required here
  // since the job spans two different tabs/origins - the Generate tab
  // (wherever it happens to be open) and a throwaway background tab on
  // the brand's real domain.
  //
  // Single in-flight job at a time (one key, not a list/queue) - the
  // Generate tab UI only ever starts one live-login at a time itself.
  // ---------------------------------------------------------------------

  var LIVE_LOGIN_JOB_KEY = 'lgt-live-login-job';
  var LIVE_LOGIN_CACHE_KEY = 'lgt-live-login-cache';
  var LIVE_LOGIN_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min - conservative slice of the ~8-24h real validity (see REFERENCE.md)

  var LiveLoginJob = (function () {
    function get(cb) {
      chrome.storage.local.get([LIVE_LOGIN_JOB_KEY], function (res) {
        cb((res && res[LIVE_LOGIN_JOB_KEY]) || null);
      });
    }
    function write(job, cb) {
      var obj = {};
      obj[LIVE_LOGIN_JOB_KEY] = job;
      chrome.storage.local.set(obj, function () { if (cb) cb(); });
    }
    function update(patch, cb) {
      get(function (job) {
        if (!job) { if (cb) cb(); return; }
        write(Object.assign({}, job, patch), cb);
      });
    }
    function clear(cb) {
      chrome.storage.local.remove([LIVE_LOGIN_JOB_KEY], function () { if (cb) cb(); });
    }
    // Opens the background tab via background.js (content scripts cannot
    // call chrome.tabs.* directly) at the brand's real login page.
    function start(brandKey, environment, cb) {
      var url = realLoginUrl(brandKey, environment);
      if (!url) { cb({ ok: false, error: 'Brand "' + brandKey + '" is not live-login-capable (no login selectors known).' }); return; }
      var job = { id: 'j' + Date.now().toString(36), brand: brandKey, environment: environment, status: 'starting', stc: null, ctx: null, error: null, createdAt: Date.now() };
      write(job, function () {
        chrome.runtime.sendMessage({ type: 'lgt-open-tab', url: url }, function (response) {
          if (chrome.runtime.lastError) { cb({ ok: false, error: chrome.runtime.lastError.message }); return; }
          if (!response || !response.ok) { cb({ ok: false, error: (response && response.error) || 'failed to open tab' }); return; }
          cb({ ok: true, job: job });
        });
      });
    }
    // Live-updates via chrome.storage.onChanged - used by the Generate
    // tab to reflect status without polling.
    function onChange(cb) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes[LIVE_LOGIN_JOB_KEY]) return;
        cb(changes[LIVE_LOGIN_JOB_KEY].newValue || null);
      });
    }
    return { get: get, update: update, clear: clear, start: start, onChange: onChange };
  })();

  var LiveLoginCache = (function () {
    function keyFor(brand, environment) { return brand + ':' + environment; }
    function get(brand, environment, cb) {
      chrome.storage.local.get([LIVE_LOGIN_CACHE_KEY], function (res) {
        var map = (res && res[LIVE_LOGIN_CACHE_KEY]) || {};
        var entry = map[keyFor(brand, environment)];
        if (entry && (Date.now() - entry.capturedAt) < LIVE_LOGIN_CACHE_TTL_MS) {
          cb(entry);
        } else {
          cb(null);
        }
      });
    }
    function set(brand, environment, stc, ctx, cb) {
      chrome.storage.local.get([LIVE_LOGIN_CACHE_KEY], function (res) {
        var map = (res && res[LIVE_LOGIN_CACHE_KEY]) || {};
        map[keyFor(brand, environment)] = { stc: stc, ctx: ctx, capturedAt: Date.now() };
        var obj = {};
        obj[LIVE_LOGIN_CACHE_KEY] = map;
        chrome.storage.local.set(obj, function () { if (cb) cb(); });
      });
    }
    return { get: get, set: set };
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
    Object.keys(BRAND_DOMAINS).forEach(function (key) {
      if (strippedHost === BRAND_DOMAINS[key] || strippedHost.indexOf(BRAND_DOMAINS[key]) !== -1) {
        brand = key;
      }
    });
    return { brand: brand, environment: env };
  }

  // ---------------------------------------------------------------------
  // Auto-login helpers (DOM-only, unchanged from the bookmarklet).
  // ---------------------------------------------------------------------

  function simulateTyping(el, text) {
    return new Promise(function (resolve) {
      var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      el.focus();
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

  function deepQuerySelectorAll(selector, root, results) {
    root = root || document;
    results = results || [];
    // If root itself is a shadow host (as opposed to document or a
    // ShadowRoot), root.querySelectorAll only sees its LIGHT DOM
    // children - its own shadow content has to be dived into explicitly.
    // Needed for findSubmitNear's shadow-boundary-crossing walk, which
    // can pass a shadow host directly as root.
    if (root.shadowRoot) deepQuerySelectorAll(selector, root.shadowRoot, results);
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

  function deepQuerySelector(selector, root) {
    var matches = deepQuerySelectorAll(selector, root);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    var visible = matches.filter(isVisible);
    return visible[0] || matches[0];
  }

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

  function warnIfMultipleMatches(selector, matchedEl, fieldLabel, log) {
    var allMatches = deepQuerySelectorAll(selector);
    if (allMatches.length > 1) {
      log(fieldLabel + ' selector matched ' + allMatches.length + ' elements' +
        (isVisible(matchedEl) ? ' - using the visible one.' : ' - none looked visible, using the first match (may be a hidden decoy field).'));
    } else if (!isVisible(matchedEl)) {
      log(fieldLabel + ' field found but not visible - using it anyway, may not be the real field.');
    }
  }

  // The generic submitSelector (e.g. `button[type="submit"]`) can match
  // MORE than just the login button when the login form is a modal/dialog
  // overlaid on top of a page that has its own unrelated submit buttons
  // (e.g. a "Deposit" button on the page behind the login modal) - those
  // stay technically visible (not display:none, just visually dimmed by
  // an overlay) so a page-wide search can pick the wrong one, which looks
  // exactly like "fields filled, clicked, but nothing happens". Walking up
  // from the password field to find the smallest containing ancestor with
  // a visible match keeps the search inside the actual login form/modal.
  //
  // `.parentElement` alone stops dead at a shadow root's edge (returns
  // null, since a ShadowRoot is not an Element) - some brands' entire
  // login form lives inside one (confirmed 2026-08-06 on NordicBet, an
  // open shadow root), so without crossing back out via
  // `getRootNode().host` the walk would give up after just 1-2 levels
  // even though the real submit button is a perfectly normal, nearby
  // sibling within that same shadow root.
  function stepUp(node) {
    if (node.parentElement) return node.parentElement;
    var root = node.getRootNode();
    return (root && root.host) || null;
  }

  function findSubmitNear(passEl, submitSelector, maxLevels) {
    var node = passEl;
    for (var i = 0; i < (maxLevels || 12) && node && node !== document.body; i++) {
      node = stepUp(node);
      if (!node) break;
      var matches = deepQuerySelectorAll(submitSelector, node).filter(isVisible);
      if (matches.length) return matches[0];
    }
    return null;
  }

  // Finds a visible in-page nav link/tab whose trimmed text matches
  // `pattern` - used to reach the Sportsbook section post-login via a real
  // SPA-routed click rather than a hard navigation (see the
  // sportsbookNavPattern comment on LOGIN_SELECTORS for why that matters).
  // Covers plain <a>, <button>, and ARIA link/tab roles (some brand navs
  // use non-anchor elements with a router's onClick handler).
  function findSportsbookNavLink(pattern) {
    var candidates = deepQuerySelectorAll('a, button, [role="link"], [role="tab"]')
      .filter(function (elm) {
        var text = (elm.textContent || '').trim();
        return text && pattern.test(text) && isVisible(elm);
      });
    return candidates[0] || null;
  }

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

  function centerOf(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  function clearFieldValue(el) {
    if (!el || !el.value) return;
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // document.activeElement stops at the first shadow host - the actually
  // focused element can be several shadow roots deeper (confirmed on
  // NordicBet's FDS-INPUT web components). Needed to verify a trusted
  // click really landed on our target field rather than something else
  // entirely (observed once in real testing 2026-08-06: a click aimed at
  // the username field's coordinates instead focused an unrelated
  // cookie-consent-banner button, so the subsequently-typed username went
  // nowhere while the login form stayed empty - no CDP error was raised
  // anywhere in that chain, since strictly speaking every dispatched
  // event succeeded, it just didn't hit the element we intended).
  function activeElementDeep() {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  // A login modal that's still animating in (slide/fade transition) can
  // report a getBoundingClientRect() that doesn't match where it'll
  // actually be a moment later, so a click computed against it can land
  // on whatever's underneath instead (another real, observed cause of
  // "typed text goes nowhere" alongside the cookie-banner case above).
  // Poll until two consecutive reads agree before trusting the rect.
  function waitForStableRect(elGetter, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var last = null;
      (function poll() {
        var el = elGetter();
        if (!el) { resolve(null); return; }
        var r = el.getBoundingClientRect();
        var cur = r.left + ',' + r.top + ',' + r.width + ',' + r.height;
        if (last === cur) { resolve(el); return; }
        last = cur;
        if (Date.now() - start > timeoutMs) { resolve(el); return; }
        setTimeout(poll, 120);
      })();
    });
  }

  // Clicks a field via trusted CDP input, then verifies (from the content
  // script, which - unlike background.js - can read document.activeElement
  // across shadow roots) that focus actually landed on that field before
  // typing into it. Retries the click once (after a short wait, in case
  // something was still settling/animating) if focus missed - this is
  // what actually catches and self-heals the "click landed on an
  // unrelated element" failure mode instead of silently typing into the
  // void.
  function clickFieldAndVerifyFocus(el, fieldLabel, log) {
    function attempt(retriesLeft) {
      var c = centerOf(el);
      return sendTrustedSequence([{ type: 'click', x: c.x, y: c.y }]).then(function (response) {
        if (!response || !response.ok) return { ok: false, error: response && response.error };
        return new Promise(function (resolve) { setTimeout(resolve, 120); }).then(function () {
          if (activeElementDeep() === el) return { ok: true };
          if (retriesLeft > 0) {
            log(fieldLabel + ' click landed on an unrelated element instead of the field (possibly a cookie banner or an animating overlay) - retrying...');
            return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(function () { return attempt(retriesLeft - 1); });
          }
          return { ok: false, error: 'focus did not land on ' + fieldLabel + ' field after retrying' };
        });
      });
    }
    return attempt(1);
  }

  // Ask the background service worker to run a chrome.debugger (CDP)
  // input sequence - see background.js for why this exists (trusted
  // input, unlike a content script's forgeable dispatchEvent/click(),
  // isn't rejected by brands that gate their submit handler on
  // event.isTrusted). Content scripts can't call chrome.debugger
  // directly, hence the message round-trip.
  function sendTrustedSequence(actions) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'lgt-trusted-sequence', actions: actions }, function (response) {
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve(response || { ok: false, error: 'no response' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  // DOM-simulation fallback (the original bookmarklet-era approach) -
  // only used if chrome.debugger couldn't attach (e.g. real DevTools is
  // already attached to this tab, which blocks a second debugger client).
  function domFallbackSubmit(userEl, username, passEl, password, submitEl, log) {
    log('Trusted input unavailable - falling back to synthetic DOM events (may be rejected by this brand\'s fraud checks, same limitation the bookmarklet had).');
    return simulateTyping(userEl, username).then(function (userResult) {
      if (userResult !== 'ok') { log('Username field ' + userResult + ' while typing (fallback path). Log in manually.'); return false; }
      return simulateTyping(passEl, password).then(function (passResult) {
        if (passResult !== 'ok') { log('Password field ' + passResult + ' while typing (fallback path). Log in manually.'); return false; }
        simulateClick(submitEl);
        return true;
      });
    });
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (el.hasAttribute('disabled')) return true;
    return false;
  }

  // Some forms only enable the submit button after an on-blur validation
  // pass (debounced), which a straight type-then-click sequence can
  // outrun - the click lands on a still-disabled button and silently
  // does nothing (no isTrusted issue at all, just a timing race with the
  // form's own validation). Poll briefly rather than clicking immediately.
  function waitForEnabled(el, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function poll() {
        if (!isDisabled(el)) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(poll, 100);
      })();
    });
  }

  // Clicks a field (verifying focus actually lands there - see
  // clickFieldAndVerifyFocus), types into it via trusted CDP input, then
  // verifies the field's actual value matches what we intended before
  // moving on. Retries the whole click+type once if the value doesn't
  // match (re-clearing first) - catches cases where focus landed
  // correctly but e.g. the field's own JS reset/reformatted the value
  // mid-type, in addition to the focus-miss case already handled by
  // clickFieldAndVerifyFocus.
  function fillFieldVerified(el, text, fieldLabel, log, retriesLeft) {
    if (retriesLeft == null) retriesLeft = 1;
    return clickFieldAndVerifyFocus(el, fieldLabel, log).then(function (clickResult) {
      if (!clickResult.ok) return clickResult;
      return sendTrustedSequence([{ type: 'type', text: text }]).then(function (typeResponse) {
        if (!typeResponse || !typeResponse.ok) return { ok: false, error: typeResponse && typeResponse.error };
        if (el.value === text) return { ok: true };
        if (retriesLeft > 0) {
          log(fieldLabel + ' field value didn\'t match what was typed (got ' + JSON.stringify(el.value) + ') - clearing and retrying...');
          clearFieldValue(el);
          return fillFieldVerified(el, text, fieldLabel, log, retriesLeft - 1);
        }
        return { ok: false, error: fieldLabel + ' field value still doesn\'t match after retrying (got ' + JSON.stringify(el.value) + ')' };
      });
    });
  }

  // Two round trips to the background's chrome.debugger session, split
  // so this content script can poll the (plain, non-trusted-input-
  // requiring) `disabled` state of the submit button in between: (1) type
  // both fields and Tab out of the password field to trigger any on-blur
  // validation, (2) once the button looks enabled, click it. If the click
  // doesn't lead anywhere, attemptAutoLogin retries with a trusted Enter
  // keypress in the password field as a button-independent fallback.
  function trustedAutoLoginSubmit(userEl, username, passEl, password, submitEl, log, retried) {
    clearFieldValue(userEl);
    clearFieldValue(passEl);
    return waitForStableRect(function () { return userEl; }, 800).then(function () {
      return fillFieldVerified(userEl, username, 'Username', log);
    }).then(function (userResult) {
      if (!userResult.ok) return { ok: false, error: userResult.error };
      return waitForStableRect(function () { return passEl; }, 800).then(function () {
        return fillFieldVerified(passEl, password, 'Password', log);
      }).then(function (passResult) {
        if (!passResult.ok) return { ok: false, error: passResult.error };
        return sendTrustedSequence([{ type: 'key', key: 'Tab' }]);
      });
    }).then(function (response) {
      if (!response || !response.ok) {
        // chrome.debugger can occasionally detach mid-sequence for
        // reasons outside this extension's control (observed 2026-08-06
        // on NordicBet: "Detached while handling command" partway
        // through typing), and a click can also simply land on the wrong
        // element (observed the same day: an intervening cookie-consent
        // banner button stole focus meant for the username field, which
        // fillFieldVerified above now catches and retries on its own -
        // this outer retry is for everything else, e.g. the CDP detach
        // case). One retry (re-clearing both fields first, so characters
        // aren't doubled up on top of a partial value) is far more likely
        // to actually succeed than immediately giving up on trusted
        // input, since the untrusted DOM fallback is known to be
        // silently ignored by brands that gate their submit handler on
        // event.isTrusted (the whole reason trusted input exists here).
        if (!retried) {
          log('Trusted input failed (' + (response && response.error || 'unknown reason') + ') - retrying once...');
          return trustedAutoLoginSubmit(userEl, username, passEl, password, submitEl, log, true);
        }
        log('Trusted input failed (' + (response && response.error || 'unknown reason') + ').');
        return domFallbackSubmit(userEl, username, passEl, password, submitEl, log);
      }
      return waitForEnabled(submitEl, 3000).then(function (enabled) {
        if (!enabled) log('Submit button still looks disabled after filling both fields - clicking anyway (may be a false read on a custom component).');
        var sc = centerOf(submitEl);
        return sendTrustedSequence([{ type: 'click', x: sc.x, y: sc.y }]).then(function (clickResponse) {
          if (clickResponse && clickResponse.ok) return true;
          log('Trusted submit click failed (' + (clickResponse && clickResponse.error || 'unknown reason') + ').');
          return domFallbackSubmit(userEl, username, passEl, password, submitEl, log);
        });
      });
    });
  }

  // Button-independent fallback: press Enter while focused in the
  // password field, which most login forms treat as "submit the
  // enclosing form" regardless of whether our submitSelector guess
  // found (or clicked) the actual right element.
  function trustedEnterKeySubmit(passEl, log) {
    var pc = centerOf(passEl);
    return sendTrustedSequence([{ type: 'click', x: pc.x, y: pc.y }, { type: 'key', key: 'Enter' }]).then(function (response) {
      if (!response || !response.ok) {
        log('Enter-key submit fallback failed (' + (response && response.error || 'unknown reason') + ').');
        return false;
      }
      return true;
    });
  }

  // Same-tab breadcrumb only - a normal same-origin navigation (no popup
  // involved) keeps sessionStorage intact by spec, and the content script
  // is guaranteed to run again on the destination page automatically, so
  // no window.open/injectScriptInto/watchForLoginSuccessAndReinject
  // machinery is needed here at all (unlike the bookmarklet's v10/v13).
  var RESUME_KEY = '__lgtExtAutoLoginResume';

  // Closes the loop after a successful auto-login: passive capture only
  // fires once a page actually makes an sb/fe-api/* request, which a
  // post-login account/home landing page usually doesn't - the Sportsbook
  // section has to actually be reached. Uses a real in-page nav-link
  // click (trusted, via CDP) rather than a hard navigation, per the
  // documented "hard navigation breaks the session" pitfall (see the
  // sportsbookNavPattern comment on LOGIN_SELECTORS).
  function navigateToSportsbookAndAwaitCapture(brandKey, log) {
    var sel = LOGIN_SELECTORS[brandKey];
    var pattern = sel && sel.sportsbookNavPattern;

    // NOTE: Capture.reset() is NOT called in here (anymore) - it now
    // happens once, earlier, right before the login submit is even
    // attempted (see attemptAutoLogin/resumeLiveLoginJobIfPending). That
    // fixed a real 2026-08-06 NordicBet bug: some brands' post-login
    // landing page (e.g. NordicBet's plain "/en") IS ALREADY the
    // authenticated Sportsbook lobby, so the real sb/fe-api/* request can
    // fire and complete within moments of landing there - resetting here,
    // right before an (in that case redundant/no-op) nav-link click,
    // would silently wipe out that already-good capture, leaving nothing
    // for awaitCapture() to find afterward even though login had
    // genuinely succeeded.
    function awaitCapture(budgetMs) {
      return new Promise(function (resolve) {
        var start = Date.now();
        (function poll() {
          Capture.get(function (c) {
            if (c && c.stc && c.ctx) {
              log('Captured! stc=' + c.stc + ' ctx=' + c.ctx);
              resolve(true);
              return;
            }
            if (Date.now() - start > budgetMs) {
              resolve(false);
              return;
            }
            setTimeout(poll, 300);
          });
        })();
      });
    }

    return new Promise(function (resolve) {
      // Give the just-landed post-login page a short head start: for
      // brands where that landing page already IS the Sportsbook section,
      // no click is needed at all, and waiting for one would only risk
      // missing the capture window.
      awaitCapture(2500).then(function (already) {
        if (already) return resolve(true);
        if (!pattern) {
          log('No known Sportsbook nav link pattern for "' + brandKey + '" - click into the Sportsbook section yourself so stc/ctx capture can complete.');
          resolve(false);
          return;
        }
        var start = Date.now();
        (function pollNav() {
          var linkEl = findSportsbookNavLink(pattern);
          if (linkEl) {
            var c = centerOf(linkEl);
            sendTrustedSequence([{ type: 'click', x: c.x, y: c.y }]).then(function () {
              awaitCapture(8000).then(function (ok) {
                if (!ok) log('Navigated to Sportsbook, but no stc/ctx captured yet - it may still be loading; check the Live Login tab.');
                resolve(ok);
              });
            });
            return;
          }
          if (Date.now() - start > 4000) {
            log('Could not find a Sportsbook nav link to click - click into the Sportsbook section yourself so stc/ctx capture can complete.');
            resolve(false);
            return;
          }
          setTimeout(pollNav, 200);
        })();
      });
    });
  }

  // Some brands show a cookie-consent banner (OneTrust, confirmed on
  // NordicBet's alpha env: #onetrust-accept-btn-handler) that can overlap
  // or briefly intercept clicks meant for the login form underneath -
  // observed once in real testing 2026-08-06 as a click intended for the
  // username field instead focusing the banner's own button, leaving the
  // username field empty while the password field (clicked afterward,
  // once the banner had closed) filled correctly. fillFieldVerified's
  // focus-check/retry now catches that case regardless of cause, but
  // dismissing the banner proactively first is cheap and removes the
  // failure mode outright when this specific, common consent SDK is
  // present. Uses a plain (untrusted) click since consent-management
  // platforms aren't part of a brand's fraud/isTrusted-gated login logic.
  function tryDismissCookieBanner(log) {
    try {
      var btn = document.getElementById('onetrust-accept-btn-handler');
      if (btn && isVisible(btn)) {
        log('Dismissing cookie consent banner...');
        btn.click();
      }
    } catch (e) {}
  }

  function attemptAutoLogin(brandKey, username, password, log) {
    var sel = LOGIN_SELECTORS[brandKey];
    if (!sel) {
      log('No known login selectors for brand "' + brandKey + '". Log in manually - capture stays passive and automatic.');
      return Promise.resolve(false);
    }
    if (location.pathname.indexOf(sel.loginPath) === -1) {
      try {
        sessionStorage.setItem(RESUME_KEY, JSON.stringify({ brand: brandKey, ts: Date.now() }));
      } catch (e) {}
      log('Navigating to the login page - this continues automatically once it loads (no extra click needed).');
      location.href = location.origin + sel.loginPath;
      return Promise.resolve(false);
    }
    tryDismissCookieBanner(log);
    log('Looking for username field...');
    // 6000ms was too tight for this environment - observed 2026-08-06 a
    // "Username field not found" failure where a follow-up screenshot
    // showed the field WAS present (and even auto-filled by Chrome's own
    // password manager) shortly after, implying the modal simply hadn't
    // finished mounting yet on a slow alpha-environment page load.
    return waitForElement(sel.usernameSelector, 15000).then(function (userEl) {
      if (!userEl) {
        log('Stopped: Username field not found. Log in manually - capture stays passive and automatic either way.');
        return false;
      }
      warnIfMultipleMatches(sel.usernameSelector, userEl, 'Username', log);
      log('Username field found. Looking for password field...');
      return waitForElement(sel.passwordSelector, 4000).then(function (passEl) {
        if (!passEl) {
          log('Stopped: Password field not found. Log in manually - capture stays passive and automatic either way.');
          return false;
        }
        warnIfMultipleMatches(sel.passwordSelector, passEl, 'Password', log);
        log('Password field found. Looking for submit button...');
        var scopedSubmit = findSubmitNear(passEl, sel.submitSelector);
        var submitPromise = scopedSubmit ? Promise.resolve(scopedSubmit) : waitForElement(sel.submitSelector, 3000);
        if (!scopedSubmit) {
          log('No submit button found near the password field (unusual) - falling back to a page-wide search, which risks matching an unrelated button.');
        }
        return submitPromise.then(function (submitEl) {
          if (!submitEl) {
            log('Stopped: submit button not found. Fields located - click Log In yourself to finish.');
            return false;
          }
          log('Filling fields and submitting with trusted input (you may briefly see a "started debugging this browser" banner - expected, it\'s what lets the click bypass isTrusted/fraud checks; it disappears on its own).');
          return trustedAutoLoginSubmit(userEl, username, passEl, password, submitEl, log).then(function (submitted) {
            if (!submitted) return false;
            return watchForSubmitOutcome(sel.loginPath, 4000).then(function (outcome) {
              if (outcome !== 'stuck') {
                log('Submitted - navigated away from the login page. Heading to Sportsbook to complete capture...');
                return navigateToSportsbookAndAwaitCapture(brandKey, log).then(function () { return true; });
              }
              log('Still on the login page after clicking submit - trying a trusted Enter keypress in the password field as a button-independent fallback...');
              return trustedEnterKeySubmit(passEl, log).then(function () {
                return watchForSubmitOutcome(sel.loginPath, 3000).then(function (outcome2) {
                  if (outcome2 === 'stuck') {
                    log('Still on the login page - likely a real login rejection (wrong credential, captcha, etc) rather than a click-trust issue at this point. Check manually.');
                    return false;
                  }
                  log('Submitted via Enter key - navigated away from the login page. Heading to Sportsbook to complete capture...');
                  return navigateToSportsbookAndAwaitCapture(brandKey, log).then(function () { return true; });
                });
              });
            });
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

    var panel = el('div', { id: 'lgt-panel', style: 'display:none' });
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
    panel.__lgtSwitchToLiveLogin = function () { tabB.click(); };
    panel.__lgtAutoLoginBtn = bodyB.__lgtAutoLoginBtn;
    panel.__lgtShow = function () { panel.style.display = ''; };
    panel.__lgtToggle = function () { panel.style.display = panel.style.display === 'none' ? '' : 'none'; };
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
        var brand = brandSel.value;
        var environment = envSel.value;
        var loggedIn = loginSel.value === 'in';
        var bleSource = bleChk.checked;

        function renderLinks(links) {
          log.textContent = 'Customer: ' + links.customerLabel;
          result.style.display = '';
          result.innerHTML = '';
          result.appendChild(renderLinkRow('Desktop', links.desktop));
          result.appendChild(renderLinkRow('Mobile', links.mobile));
        }

        function spliceAndRender(stc, ctx) {
          generateLink({ brand: brand, environment: environment, loggedIn: false, customerKeyFilter: '', bleSource: false }).then(function (links) {
            result.style.display = '';
            result.innerHTML = '';
            result.appendChild(renderLinkRow('Desktop (live-login)', spliceContext(links.desktop, stc, ctx)));
            result.appendChild(renderLinkRow('Mobile (live-login)', spliceContext(links.mobile, stc, ctx)));
          }).catch(function (err) {
            log.textContent = 'Error building final link: ' + err.message;
          });
        }

        // Runs a one-time live login (cache -> background-tab job) for
        // brands with no real logged-in test customer, splicing the
        // captured stc/ctx into the normal logged-out link once done -
        // same mechanism the sbplayground-link-generator skill documents
        // as a manual workaround (REFERENCE.md), just automated here.
        function runLiveLoginFallback() {
          LiveLoginCache.get(brand, environment, function (cached) {
            if (cached) {
              log.textContent = 'Using cached live-login context (captured ' + Math.round((Date.now() - cached.capturedAt) / 60000) + ' min ago)...';
              spliceAndRender(cached.stc, cached.ctx);
              return;
            }
            log.textContent = 'No logged-in test customer for this brand - running a one-time live login on the real site (background tab, invisible)...';
            var settled = false;
            var deadline = Date.now() + 60000;

            LiveLoginJob.start(brand, environment, function (startResult) {
              if (!startResult.ok) {
                log.textContent = 'Error starting live login: ' + startResult.error;
                settled = true;
                return;
              }
              LiveLoginJob.onChange(function (job) {
                if (settled || !job) return;
                if (job.status === 'logging-in') {
                  log.textContent = 'Logging in on the real site...';
                } else if (job.status === 'captured') {
                  log.textContent = 'Captured live-login context!';
                  spliceAndRender(job.stc, job.ctx);
                  LiveLoginJob.clear();
                  settled = true;
                } else if (job.status === 'failed' || job.status === 'unsupported') {
                  log.textContent = 'Live login failed: ' + (job.error || job.status) + ' (the background tab was kept open and brought to the front so you can see what happened - close it manually when done)';
                  LiveLoginJob.clear();
                  settled = true;
                }
              });
            });

            (function pollTimeout() {
              if (settled) return;
              if (Date.now() > deadline) {
                log.textContent = 'Live login timed out after 60s - check for a leftover background tab.';
                settled = true;
                return;
              }
              setTimeout(pollTimeout, 1000);
            })();
          });
        }

        if (!loggedIn || bleSource) {
          // Logged-out, or BLE override (always sourced from the static
          // registry regardless of login state) - unchanged path.
          generateLink({ brand: brand, environment: environment, loggedIn: loggedIn, customerKeyFilter: filterInput.value, bleSource: bleSource })
            .then(renderLinks)
            .catch(function (err) { log.textContent = 'Error: ' + err.message; });
          return;
        }

        // Logged-in, no BLE: check upfront whether the brand has a real
        // logged-in test customer key (works for 4/34 brands) rather
        // than sniffing generateLink()'s error string - if it does, use
        // the normal static-registry path unchanged; if not, only brands
        // with known login/Sportsbook-nav selectors can fall back to
        // live-login, everyone else keeps today's error behavior.
        hasLoggedInCustomerKey(brand, environment).then(function (hasKey) {
          if (hasKey) {
            generateLink({ brand: brand, environment: environment, loggedIn: true, customerKeyFilter: filterInput.value, bleSource: false })
              .then(renderLinks)
              .catch(function (err) { log.textContent = 'Error: ' + err.message; });
            return;
          }
          var sel = LOGIN_SELECTORS[brand];
          if (!sel || !sel.sportsbookNavPattern) {
            log.textContent = 'Error: No customer key matched prefix "logged-in" for this brand, and it is not live-login-capable (no login/Sportsbook-nav selectors known).';
            return;
          }
          runLiveLoginFallback();
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
    var status = el('div', { class: 'lgt-log' }, ['Passive capture running (network-level - always on, independent of this panel). Log in normally, or use Auto-login below.']);
    var result = el('div', { class: 'lgt-result', style: 'display:none' });

    function renderStatus(c) {
      if (c.stc && c.ctx) {
        status.textContent = 'Captured! stc=' + c.stc + ' ctx=' + c.ctx;
      } else if ((c.seenCount || 0) > 0) {
        status.textContent = 'Passive capture running - ' + c.seenCount + ' sb/fe-api call(s) observed, none with both headers yet.';
      }
    }

    // Reflect whatever's already captured immediately (covers both a
    // capture that completed before this panel was ever opened, and one
    // that completed on an earlier page before a hard navigation - since
    // storage is keyed by origin and persists regardless of navigation or
    // service-worker restarts, there's nothing extra to "restore" here).
    Capture.get(renderStatus);
    // Live-updates as more requests come in / a full capture lands - via
    // chrome.storage.onChanged, no polling loop needed.
    Capture.onCapture(renderStatus);

    var autoBtn = el('button', {
      onclick: function () {
        Vault.getDefault(function (cred) {
          if (!cred) { status.textContent = 'No saved credential yet - add one in the Credentials tab first.'; return; }
          if (!detected.brand) { status.textContent = 'Brand not recognized from this hostname - log in manually.'; return; }
          attemptAutoLogin(detected.brand, cred.username, cred.password, function (m) { status.textContent = m; });
        });
      }
    }, ['Auto-login with default credential']);
    wrap.__lgtAutoLoginBtn = autoBtn;

    var manualLabel = el('label', {}, ['Or paste manually (DevTools > Network, filter "fe-api", any request > Headers)']);
    var manualStc = el('input', { placeholder: 'x-sb-static-context-id value' });
    var manualCtx = el('input', { placeholder: 'x-sb-user-context-id value' });

    function proceedWithContext(c) {
      if (!c.stc || !c.ctx) {
        var n = c.seenCount || 0;
        status.textContent = n > 0
          ? 'Nothing captured yet - ' + n + ' sb/fe-api call(s) observed so far, but none had both required headers.'
          : 'Nothing captured yet - zero sb/fe-api calls observed for this origin so far. Try pasting the values manually above instead (DevTools Network tab).';
        return;
      }
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

    var buildBtn = el('button', {
      class: 'secondary',
      onclick: function () {
        var manualStcVal = manualStc.value.trim();
        var manualCtxVal = manualCtx.value.trim();
        if (manualStcVal && manualCtxVal) {
          proceedWithContext({ stc: manualStcVal, ctx: manualCtxVal, seenCount: 0 });
        } else {
          Capture.get(proceedWithContext);
        }
      }
    }, ['Build final link from capture']);

    wrap.appendChild(info);
    wrap.appendChild(autoBtn);
    wrap.appendChild(manualLabel);
    wrap.appendChild(manualStc);
    wrap.appendChild(manualCtx);
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

    wrap.appendChild(el('label', {}, ['Add credential (shared across all brand domains automatically)']));
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

  Capture.start();
  var panelEl = buildPanel();

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'lgt-toggle-panel') {
      panelEl.__lgtToggle();
    }
  });

  // Resume an auto-login that was interrupted by navigating to the brand's
  // login page (see attemptAutoLogin). Unlike the bookmarklet, this needs
  // no window-handle/popup logic at all: the content script simply runs
  // again automatically on the destination page, and sessionStorage
  // survives a normal same-tab, same-origin navigation by spec.
  (function resumeAutoLoginIfPending() {
    var raw;
    try { raw = sessionStorage.getItem(RESUME_KEY); } catch (e) { return; }
    if (!raw) return;
    try { sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
    var pending;
    try { pending = JSON.parse(raw); } catch (e) { return; }
    if (!pending || !pending.brand || Date.now() - pending.ts > 30000) return;
    var sel = LOGIN_SELECTORS[pending.brand];
    if (!sel || location.pathname.indexOf(sel.loginPath) === -1) return;
    panelEl.__lgtShow();
    panelEl.__lgtSwitchToLiveLogin();
    if (panelEl.__lgtAutoLoginBtn) panelEl.__lgtAutoLoginBtn.click();
  })();

  // Runs the Generate tab's auto live-login job (see LiveLoginJob /
  // startLiveLoginJob) end to end in this tab - the background tab
  // opened at the brand's real login URL, invisible to the user for its
  // whole short lifetime. Only ever acts on a job in its initial
  // 'starting' state (not 'logging-in') as a light-weight guard against
  // a rare double-pickup: if the Generate tab itself happens to already
  // be sitting on the brand's real login page when the job is created,
  // its own bootstrap check could otherwise race the freshly-opened
  // background tab for the same job - in practice the background tab's
  // real network navigation is far slower than an already-loaded tab's
  // synchronous storage read, so the already-loaded tab (if any) wins
  // and flips the status before the background tab's check ever sees
  // 'starting'.
  (function resumeLiveLoginJobIfPending() {
    LiveLoginJob.get(function (job) {
      if (!job || job.status !== 'starting') return;
      var detected = detectBrandAndEnv();
      if (!detected.brand || detected.brand !== job.brand) return;
      var sel = LOGIN_SELECTORS[job.brand];
      if (!sel || !sel.sportsbookNavPattern) {
        LiveLoginJob.update({ status: 'unsupported', error: 'Brand is not live-login-capable (missing login/Sportsbook-nav selectors).' }, focusThisTab);
        return;
      }
      LiveLoginJob.update({ status: 'logging-in' }, function () {
        Vault.getDefault(function (cred) {
          if (!cred) {
            LiveLoginJob.update({ status: 'failed', error: 'No saved credential in the vault.' }, focusThisTab);
            return;
          }
          // Collect every step message attemptAutoLogin/navigateToSportsbookAndAwaitCapture
          // report along the way, so a failure surfaces exactly which
          // step it got stuck on in the Generate tab (this job runs in an
          // invisible background tab that auto-closes, so console.log
          // alone is never actually seen by the user - it has to be
          // attached to the job itself).
          var steps = [];
          function log(m) { steps.push(m); console.log('[lgt-live-login]', m); }
          // Reset any capture already stored for this origin ONCE, right
          // before the login attempt even starts - Capture is keyed
          // per-origin and persists indefinitely, so without this a STALE
          // entry from earlier anonymous browsing on this same brand
          // (very likely, since the extension passively captures on
          // every page load) would be silently reported as "captured"
          // even if this specific login attempt actually failed
          // (confirmed 2026-08-06 on NordicBet: reported success with a
          // leftover anonymous stc/ctx pair). This must happen BEFORE
          // login, not right before the later Sportsbook-nav-link click -
          // some brands' post-login landing page (e.g. NordicBet's plain
          // "/en") is ALREADY the authenticated Sportsbook lobby, so the
          // real capture can complete within moments of landing there;
          // resetting any later than this would risk wiping out that
          // already-good capture before ever reading it (also confirmed
          // 2026-08-06: a genuinely successful NordicBet login still
          // reported "no stc/ctx captured" because of exactly this
          // ordering bug).
          Capture.reset(function () {
            attemptAutoLogin(job.brand, cred.username, cred.password, log).then(function (loginOk) {
              // loginOk === false means attemptAutoLogin never reached a
              // confirmed logged-in state (missing fields/selectors, or -
              // most notably - still stuck on the login page after both the
              // direct submit and the Enter-key fallback, i.e. a real login
              // rejection) and so never got as far as
              // navigateToSportsbookAndAwaitCapture. Do NOT fall through to
              // Capture.get() in that case: Capture is keyed per-origin and
              // persists indefinitely, so it may still hold a stale entry
              // from unrelated earlier browsing on this brand's domain that
              // would otherwise be misreported as a successful capture
              // (confirmed 2026-08-06 on NordicBet: a rejected login - most
              // likely a credential saved for a different brand, since the
              // vault has no per-brand association - still reported
              // "captured" with a leftover anonymous stc/ctx pair).
              if (!loginOk) {
                // Bring the tab into view (instead of closing it) so the
                // user can actually see the real page state that caused the
                // failure - a step-message string alone can't capture
                // things like a captcha, cookie-consent overlay, or 2FA
                // prompt that our automation doesn't account for.
                LiveLoginJob.update({ status: 'failed', error: 'Auto-login did not complete. Steps: ' + steps.join(' > ') }, focusThisTab);
                return;
              }
              Capture.get(function (c) {
                if (c && c.stc && c.ctx) {
                  LiveLoginJob.update({ status: 'captured', stc: c.stc, ctx: c.ctx }, function () {
                    LiveLoginCache.set(job.brand, job.environment, c.stc, c.ctx, closeThisTab);
                  });
                } else {
                  LiveLoginJob.update({ status: 'failed', error: 'Login/Sportsbook navigation completed but no stc/ctx was captured. Steps: ' + steps.join(' > ') }, focusThisTab);
                }
              });
            });
          });
        });
      });
    });
  })();

  function closeThisTab() {
    chrome.runtime.sendMessage({ type: 'lgt-close-tab' }, function () {
      void chrome.runtime.lastError; // ignore - nothing to do if this fails
    });
  }

  function focusThisTab() {
    chrome.runtime.sendMessage({ type: 'lgt-focus-tab' }, function () {
      void chrome.runtime.lastError; // ignore - nothing to do if this fails
    });
  }

  window.__lgtExtInstance = {
    destroy: function () {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
      var oldStyle = document.getElementById('lgt-panel-style');
      if (oldStyle && oldStyle.parentNode) oldStyle.parentNode.removeChild(oldStyle);
    }
  };
})();
