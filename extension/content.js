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

  var VERSION = 'ext-v1-2026-08-05';

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
  var LOGIN_SELECTORS = {
    nordicbet: {
      loginPath: '/en/login',
      usernameSelector: 'input[name="email"], input#email-input, input[name="username"], input[type="email"]',
      passwordSelector: 'input[name="password"], input[type="password"]',
      submitSelector: '[data-test-id="account-login-btn-1-button"], button[type="submit"]'
    },
    mobilbahis: {
      loginPath: '/tr/giris',
      usernameSelector: 'input[type="email"], input[name="username"]',
      passwordSelector: 'input[type="password"]',
      submitSelector: 'button[type="submit"]'
    }
  };

  var ENV_LABELS = ['test', 'qa', 'alpha', 'prod'];

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

  // Same-tab breadcrumb only - a normal same-origin navigation (no popup
  // involved) keeps sessionStorage intact by spec, and the content script
  // is guaranteed to run again on the destination page automatically, so
  // no window.open/injectScriptInto/watchForLoginSuccessAndReinject
  // machinery is needed here at all (unlike the bookmarklet's v10/v13).
  var RESUME_KEY = '__lgtExtAutoLoginResume';

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
    log('Looking for username field...');
    return fillField(sel.usernameSelector, username, 6000, 'Username', log).then(function (userResult) {
      if (userResult !== 'ok') {
        log('Stopped: ' + userResult + '. Log in manually - capture stays passive and automatic either way.');
        return false;
      }
      log('Username filled. Looking for password field...');
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
          return watchForSubmitOutcome(sel.loginPath, 4000).then(function (outcome) {
            if (outcome === 'stuck') {
              log('Both fields are filled, but still on the login page a few seconds after submitting - this site may be rejecting the synthetic click (known limitation on some brands). Click "Log In" yourself to finish.');
            } else {
              log('Submitted - navigated away from the login page. Capture keeps running automatically here.');
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

  window.__lgtExtInstance = {
    destroy: function () {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
      var oldStyle = document.getElementById('lgt-panel-style');
      if (oldStyle && oldStyle.parentNode) oldStyle.parentNode.removeChild(oldStyle);
    }
  };
})();
