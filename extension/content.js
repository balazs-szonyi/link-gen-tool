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

  // Displayed version is read live from manifest.json
  // (chrome.runtime.getManifest().version) rather than a separate
  // hand-maintained string - previously this file carried its own
  // "ext-vN-date" label alongside manifest.json's semver, and the two
  // could drift/disagree in the UI. Now there is a single source of
  // truth: bump manifest.json's "version" on every release and the
  // panel title always matches it.
  var VERSION = 'v' + chrome.runtime.getManifest().version;

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
  // betsson/betsafe/betssongr share NordicBet's exact same OBG platform
  // markup (#email-input/#password-input, account-login-btn-1-button) -
  // confirmed 2026-08-07 via chrome-devtools live login on all three real
  // sites (isLoggedIn=true, authentication-transaction 201, wallet/balance
  // calls succeeded afterward) using the shared QA credential "User1"
  // (obg.e2e.test.sb+01@gmail.com) from the OBG Sportsbook TA user-
  // accounts wiki - that credential/password is valid across these OBG
  // brands (NOT brand-specific as first assumed), but is NOT universal:
  // it failed on Rizk (a different, non-OBG platform/brand family).
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
    },
    betsson: {
      loginPath: '/en/login',
      usernameSelector: 'input[name="email"], input#email-input, input[type="email"]',
      passwordSelector: 'input[name="password"], input[type="password"]',
      submitSelector: '[data-test-id="account-login-btn-1-button"], button[type="submit"]',
      sportsbookNavPattern: /^sportsbook$/i
    },
    betsafe: {
      loginPath: '/en/login',
      usernameSelector: 'input[name="email"], input#email-input, input[type="email"]',
      passwordSelector: 'input[name="password"], input[type="password"]',
      submitSelector: '[data-test-id="account-login-btn-1-button"], button[type="submit"]',
      // Observed 2026-08-07: the first submit click can land while the
      // React form still shows a stale "Fill in this field" validation
      // state even though both fields already hold the typed value - a
      // second click (no re-typing needed) goes through. attemptAutoLogin
      // already retries submit once on failure via trustedAutoLoginSubmit,
      // so no extra code change was needed for this brand specifically.
      sportsbookNavPattern: /^sportsbook$/i
    },
    betssongr: {
      loginPath: '/en/login',
      usernameSelector: 'input[name="email"], input#email-input, input[type="email"]',
      passwordSelector: 'input[name="password"], input[type="password"]',
      submitSelector: '[data-test-id="account-login-btn-1-button"], button[type="submit"]',
      sportsbookNavPattern: /^sportsbook$/i
    },
    // betssones: CREDENTIAL-VERIFIED 2026-08-08 (authentication-transaction
    // 201, logged-in state confirmed - "Hola, Gabrio" welcome + balance
    // widget). Same OBG markup as above, but real login path is /login,
    // NOT /es/login like most other brands' /en/login convention.
    // IMPORTANT: identical markup did NOT imply shared-credential
    // membership for every OBG-styled brand - arcticbet, betsmith,
    // betsolid, and betssonmx were all live-tested with this exact same
    // credential on 2026-08-08 and ALL FAILED ("provided email/username
    // or password is not valid" / "no son válidos"), despite using the
    // byte-identical login form. Do NOT add those four to LOGIN_SELECTORS
    // on the assumption that matching markup means matching credential -
    // each brand must be individually credential-tested. See REFERENCE.md
    // "Brand credential/login status summary" for the full per-brand
    // results table.
    betssones: {
      loginPath: '/login',
      usernameSelector: 'input[name="email"], input#email-input, input[type="email"]',
      passwordSelector: 'input[name="password"], input[type="password"]',
      submitSelector: '[data-test-id="account-login-btn-1-button"], button[type="submit"]',
      sportsbookNavPattern: /^sportsbook$/i
    }
  };

  var ENV_LABELS = ['test', 'qa', 'alpha', 'prod'];

  // Env -> layer, for the Bundle tab: only QA<->TEST (BLE) or ALPHA<->PROD
  // (BDE) overrides are ever offered, since the two layers' bundle formats
  // are incompatible (see the sb-bundle-override-tool skill's
  // REFERENCE.md Anti-patterns) - mixing them loads a broken build with
  // no explicit runtime error, so this is enforced in the UI rather than
  // left to the user to know/remember.
  var BUNDLE_LAYER = { test: 'ble', qa: 'ble', alpha: 'bde', prod: 'bde' };
  function bundleLayerPartner(env) {
    var layer = BUNDLE_LAYER[env];
    if (!layer) return null;
    var partner = null;
    Object.keys(BUNDLE_LAYER).forEach(function (e) {
      if (e !== env && BUNDLE_LAYER[e] === layer) partner = e;
    });
    return partner;
  }

  // Item 14: brands with no plain user/pass login at all (Swedish
  // BankID / Danish MitID-CPR or similar step-up auth) - auto-login is
  // fundamentally impossible for these, so both the Generate tab's
  // live-login fallback and the Live Login tab's Auto-login button
  // short-circuit straight to "open the real login page for the user to
  // complete by hand" instead of silently attempting (and failing) a
  // normal credential-based flow. Source: sbplayground-link-generator
  // skill's REFERENCE.md brand-credential-status table.
  var SPECIAL_AUTH_BRANDS = {
    bethard: 'Swedish BankID',
    nordicbetdk: 'Danish MitID/CPR',
    betssondk: 'Danish MitID/CPR',
    spelklubben: 'Swedish BankID (shares account with the casino product)'
  };

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

  // Builds the brand's REAL (production-like) origin for a given
  // environment - used to spoof Origin/Referer toward Sportradar so its
  // per-brand domain-licensing check (see background.js's
  // startSrSpoofRule) accepts the request the same way it would for a
  // real visitor. Confirmed via direct HTTP testing (2026-08-06) that
  // "https://www.alpha.nordicbet.com" is accepted by Sportradar's
  // licensing endpoint for nordicbet/alpha; other brands/environments
  // follow the same www.{env.}domain convention but aren't individually
  // verified yet.
  function realBrandOrigin(brandKey, environment) {
    var domain = BRAND_DOMAINS[brandKey];
    if (!domain) return null;
    var prefix = (environment && environment !== 'prod') ? (environment + '.') : '';
    return 'https://www.' + prefix + domain;
  }


  // ---------------------------------------------------------------------
  // Settings - small persisted extension-wide toggles, chrome.storage.local
  // (shared across every brand domain, same as the Vault below). Currently
  // just the one flag: whether the "Open (Sportradar-enabled)" button/spoof
  // feature is offered at all. Defaults to enabled (it's a fix, not a risky
  // experiment) but some environments/users may want to turn it off - e.g.
  // if it ever interferes with unrelated Sportradar traffic in the same tab
  // - so it's not hardcoded on.
  // ---------------------------------------------------------------------

  var SR_SPOOF_SETTING_KEY = 'lgt-sr-spoof-enabled';
  var srSpoofSettingCache = true; // optimistic default until storage read resolves
  var srSpoofChkRef = null; // set by buildModeA once the checkbox exists, so the
  // async storage read below (which may resolve AFTER buildPanel() already ran
  // synchronously at content-script load) can still correct the checkbox's
  // displayed state instead of leaving it stuck on the optimistic default.
  chrome.storage.local.get([SR_SPOOF_SETTING_KEY], function (res) {
    if (res && typeof res[SR_SPOOF_SETTING_KEY] === 'boolean') {
      srSpoofSettingCache = res[SR_SPOOF_SETTING_KEY];
      if (srSpoofChkRef) srSpoofChkRef.checked = srSpoofSettingCache;
    }
  });

  // ---------------------------------------------------------------------
  // Vault - chrome.storage.local, extension-scoped so it is automatically
  // shared across every brand domain (unlike the bookmarklet's per-origin
  // localStorage, which needed a manual Export/Import sync code). No
  // separate sync UI is needed here as a result.
  // ---------------------------------------------------------------------

  var VAULT_KEY = 'lgt-credentials-v1';

  var Vault = (function () {
    function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

    // Migration (item 8): older records saved before the brand-matrix
    // feature have no `brands` field at all - treat that as "unassigned"
    // ([]), not "works for every brand", so nothing is silently assumed
    // to apply to a brand the user never actually confirmed it for.
    function migrate(list) {
      var changed = false;
      list.forEach(function (c) {
        if (!Array.isArray(c.brands)) { c.brands = []; changed = true; }
      });
      return changed;
    }

    function readAll(cb) {
      chrome.storage.local.get([VAULT_KEY], function (res) {
        var list = (res && res[VAULT_KEY]) || [];
        if (migrate(list)) { writeAll(list, function () { cb(list); }); return; }
        cb(list);
      });
    }

    function writeAll(list, cb) {
      var obj = {};
      obj[VAULT_KEY] = list;
      chrome.storage.local.set(obj, function () { if (cb) cb(list); });
    }

    return {
      getAll: function (cb) { readAll(cb); },
      // brands: string[] of brand keys this credential is confirmed/
      // claimed to work for - defaults to [] (unassigned) when omitted so
      // existing callers (pre-matrix) keep working unchanged.
      save: function (label, username, password, brands, cb) {
        readAll(function (list) {
          list.push({ id: uid(), label: label, username: username, password: password, isDefault: list.length === 0, brands: brands || [] });
          writeAll(list, cb);
        });
      },
      setDefault: function (id, cb) {
        readAll(function (list) {
          list.forEach(function (c) { c.isDefault = (c.id === id); });
          writeAll(list, cb);
        });
      },
      // Item 11: replaces a credential's whole brand list in one write
      // (called from the "Brands" checkbox-matrix editor).
      setBrands: function (id, brands, cb) {
        readAll(function (list) {
          var c = list.find(function (x) { return x.id === id; });
          if (c) c.brands = brands || [];
          writeAll(list, cb);
        });
      },
      // Item 9's "unlink just this brand" option - removes one brand key
      // from a credential's list without touching anything else about it.
      unlinkBrand: function (id, brandKey, cb) {
        readAll(function (list) {
          var c = list.find(function (x) { return x.id === id; });
          if (c) c.brands = (c.brands || []).filter(function (b) { return b !== brandKey; });
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
      },
      // Item 12/3: credentials explicitly matrix-linked to a given brand.
      // Deliberately does NOT fall back to "every credential" when the
      // list is empty - an empty result here is the trigger for the
      // item-3 "no credential linked to this brand yet" conflict prompt,
      // not a silent guess.
      getForBrand: function (brandKey, cb) {
        readAll(function (list) {
          cb(list.filter(function (c) { return (c.brands || []).indexOf(brandKey) !== -1; }));
        });
      },
      getById: function (id, cb) {
        readAll(function (list) {
          cb(list.find(function (c) { return c.id === id; }) || null);
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

  // Chrome's fetch() rejects with a bare `TypeError: Failed to fetch` for
  // DNS failures / connection-refused / timeouts - there's no finer-grained
  // reason available at this layer, but for an internal-only host that
  // only routes over the VPN, this specific rejection shape is a safe,
  // high-confidence "you're probably not on the VPN" signal. Genuine
  // HTTP-level failures (brand typo -> 404, real backend 500) already
  // throw their own explicitly-worded Error via the `r.ok` checks below
  // and never reach this classifier at all, so they're never
  // misidentified as a VPN problem.
  function isVpnLikeNetworkError(err) {
    return !!err && err.name === 'TypeError' && /Failed to fetch|NetworkError|Load failed/i.test(err.message || '');
  }

  // Thin wrapper around fetch() for every internal.*.sbplayground1.net
  // call - tags a classified connectivity failure with isVpnRequired so
  // callers can show the "First connect VPN!" popup without each having
  // to re-implement isVpnLikeNetworkError's detection themselves.
  function fetchInternal(url) {
    return fetch(url).catch(function (err) {
      if (isVpnLikeNetworkError(err)) {
        var host = (url.match(/^https:\/\/([^/]+)/) || [])[1] || url;
        var vpnErr = new Error('Could not reach ' + host + ' - not connected to the VPN?');
        vpnErr.isVpnRequired = true;
        vpnErr.vpnHost = host;
        throw vpnErr;
      }
      throw err;
    });
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
    return fetchInternal(apiBase(environment) + '/api/customers/' + brandGuid)
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (customers) {
        return Object.keys(customers || {}).some(function (k) { return k.toLowerCase().indexOf('logged-in') === 0; });
      })
      .catch(function (err) {
        // A VPN-connectivity failure is NOT "this brand has no logged-in
        // key" - swallowing it here would silently mislead
        // runGenerateFlow into wastefully attempting a live-login
        // fallback instead of surfacing the real problem immediately.
        // Any other (non-network) error keeps today's conservative
        // silent-false fallback.
        if (err && err.isVpnRequired) throw err;
        return false;
      });
  }

  function generateLink(opts) {
    var brandGuid = BRANDS[opts.brand];
    if (!brandGuid) return Promise.reject(new Error('Unknown brand: ' + opts.brand));

    var apiEnv = opts.bleSource ? 'prod' : opts.environment;
    var base = apiBase(apiEnv);
    var prefix = opts.loggedIn ? 'logged-in' : 'logged-out';
    var filter = (opts.customerKeyFilter || '').toLowerCase();

    return fetchInternal(base + '/api/customers/' + brandGuid)
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
        return fetchInternal(uri).then(function (r) {
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

  // Mints a fresh, ALPHA-valid BLE customer context from PROD - the exact
  // same source and mechanism the bleSource sandbox-link option already
  // uses (see generateLink's `apiEnv = opts.bleSource ? 'prod' : ...`) -
  // but returns the raw {stc, ctx} pair instead of splicing it into a URL,
  // since the "BLE Data" tab (buildModeE) needs it as declarativeNetRequest
  // request-header VALUES, not as URL path segments. `device` matters here:
  // the earlier device-mismatched-context investigation (see plan.md)
  // found desktop and mobile are genuinely different context registrations
  // on the backend - reusing a desktop-minted context for a page that's
  // actually running as mobile (or vice versa) risks the same kind of
  // failure, so the caller must mint for whichever device the override is
  // actually being applied to.
  function fetchFreshBleContext(brand, device, loggedIn, customerKeyFilter) {
    var brandGuid = BRANDS[brand];
    if (!brandGuid) return Promise.reject(new Error('Unknown brand: ' + brand));
    var base = apiBase('prod');
    var prefix = loggedIn ? 'logged-in' : 'logged-out';
    var filter = (customerKeyFilter || '').toLowerCase();
    return fetchInternal(base + '/api/customers/' + brandGuid)
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
        return fetchInternal(uri).then(function (r) {
          if (!r.ok) throw new Error('user-context fetch failed: HTTP ' + r.status);
          return r.json();
        }).then(function (data) {
          var ctxNode = ((data.data || {}).context || {})[device] || {};
          var stc = (ctxNode.customerContext || {}).staticContextId;
          var ctx = (ctxNode.customerContext || {}).userContextId;
          if (!stc || !ctx) throw new Error('No BLE context found for device "' + device + '" in the user-context response.');
          return { stc: stc, ctx: ctx, customerKey: customerKey };
        });
      });
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

  // Per-brand "silent login proven to work" memory (item 0c). A brand's
  // very first live-login always runs with the background tab briefly
  // visible (today's default) as a safety net, since we don't yet know
  // its selectors/credentials are correct - the moment ANY run for that
  // brand reaches 'captured', we trust the (now fixed, see background.js
  // attachDebugger) invisible background-tab mechanism to keep working
  // and switch that brand to silent-by-default from then on. The manual
  // "Show login tab" checkbox always overrides this remembered default in
  // either direction for a single generation.
  var SILENT_VERIFIED_KEY = 'lgt-silent-verified-brands';

  function isBrandSilentVerified(brandKey, cb) {
    chrome.storage.local.get([SILENT_VERIFIED_KEY], function (res) {
      var map = (res && res[SILENT_VERIFIED_KEY]) || {};
      cb(!!map[brandKey]);
    });
  }

  function markBrandSilentVerified(brandKey) {
    chrome.storage.local.get([SILENT_VERIFIED_KEY], function (res) {
      var map = Object.assign({}, res && res[SILENT_VERIFIED_KEY]);
      if (map[brandKey]) return; // already marked, avoid a redundant write
      map[brandKey] = true;
      var obj = {};
      obj[SILENT_VERIFIED_KEY] = map;
      chrome.storage.local.set(obj);
    });
  }

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
    // `visible` (item 0b/0c): when false the tab is opened with
    // active:false and stays that way for its whole life (relies on
    // background.js's Emulation.setFocusEmulationEnabled fix so trusted
    // input still works); when true the tab is opened active:true so the
    // user can watch/diagnose the flow, e.g. for a brand not yet proven
    // to work silently. `credentialId` (item 12): which Vault credential
    // the OTHER tab (resumeLiveLoginJobIfPending, running in a completely
    // separate content-script instance on the background tab's origin)
    // should use - falls back to Vault.getDefault there when omitted, so
    // existing/older callers are unaffected. `device` ('desktop' default,
    // or 'mobile'): which generated link variant this capture is FOR -
    // 'mobile' tells background.js's lgt-open-tab handler to switch the
    // job tab to a real mobile viewport/UA (CDP device emulation) BEFORE
    // navigating to the login page, so the brand's real site issues a
    // genuinely mobile-scoped stc/ctx instead of a desktop one (see
    // background.js's setupMobileEmulation for the full rationale - a
    // single shared context spliced into both link variants was the
    // confirmed 2026-08-07 root cause of "mobile bleSource link click
    // does nothing").
    function start(brandKey, environment, visible, credentialId, device, cb) {
      var url = realLoginUrl(brandKey, environment);
      if (!url) { cb({ ok: false, error: 'Brand "' + brandKey + '" is not live-login-capable (no login selectors known).' }); return; }
      var job = { id: 'j' + Date.now().toString(36), brand: brandKey, environment: environment, visible: !!visible, credentialId: credentialId || null, device: device || 'desktop', status: 'starting', stc: null, ctx: null, error: null, createdAt: Date.now() };
      write(job, function () {
        chrome.runtime.sendMessage({ type: 'lgt-open-tab', url: url, active: !!visible, device: job.device }, function (response) {
          if (chrome.runtime.lastError) { cb({ ok: false, error: chrome.runtime.lastError.message }); return; }
          if (!response || !response.ok) { cb({ ok: false, error: (response && response.error) || 'failed to open tab' }); return; }
          cb({ ok: true, job: job });
        });
      });
    }
    // Live-updates via chrome.storage.onChanged - used by the Generate
    // tab to reflect status without polling. Returns the listener
    // function so callers can (and must, once settled) unregister it via
    // offChange - onChange used to be called once per generation click
    // with no matching removeListener, so every click across a long QA
    // session left one more permanently-attached listener behind (each
    // old one is a harmless no-op thanks to its own closure's `settled`
    // guard, but this was still an unbounded leak worth closing).
    function onChange(cb) {
      var listener = function (changes, area) {
        if (area !== 'local' || !changes[LIVE_LOGIN_JOB_KEY]) return;
        cb(changes[LIVE_LOGIN_JOB_KEY].newValue || null);
      };
      chrome.storage.onChanged.addListener(listener);
      return listener;
    }
    function offChange(listener) {
      if (listener) chrome.storage.onChanged.removeListener(listener);
    }
    return { get: get, update: update, clear: clear, start: start, onChange: onChange, offChange: offChange };
  })();

  var LiveLoginCache = (function () {
    // Keyed per device too (not just brand:environment) - a desktop and
    // mobile capture for the same brand/environment are genuinely
    // different contexts (see the "device" note on LiveLoginJob.start
    // above) and must never be cross-served from cache.
    function keyFor(brand, environment, device) { return brand + ':' + environment + ':' + (device || 'desktop'); }
    function get(brand, environment, device, cb) {
      chrome.storage.local.get([LIVE_LOGIN_CACHE_KEY], function (res) {
        var map = (res && res[LIVE_LOGIN_CACHE_KEY]) || {};
        var entry = map[keyFor(brand, environment, device)];
        if (entry && (Date.now() - entry.capturedAt) < LIVE_LOGIN_CACHE_TTL_MS) {
          cb(entry);
        } else {
          cb(null);
        }
      });
    }
    function set(brand, environment, device, stc, ctx, cb) {
      chrome.storage.local.get([LIVE_LOGIN_CACHE_KEY], function (res) {
        var map = (res && res[LIVE_LOGIN_CACHE_KEY]) || {};
        map[keyFor(brand, environment, device)] = { stc: stc, ctx: ctx, capturedAt: Date.now() };
        var obj = {};
        obj[LIVE_LOGIN_CACHE_KEY] = map;
        chrome.storage.local.set(obj, function () { if (cb) cb(); });
      });
    }
    return { get: get, set: set };
  })();

  // Playground (sbplayground iframe test-host) suffixes - mirrors
  // background.js's PLAYGROUND_HOST_SUFFIX (kept in sync manually; used
  // there for the Sportradar-spoof auto-detect feature, needed here too
  // so detectBrandAndEnv/Auto-login recognize a brand while the user is
  // on the iframe test page, not just its real production domain - item 7).
  var PLAYGROUND_HOST_SUFFIX = {
    arcticbet: 'arcticbetplayground.net',
    betfirst: 'betfirstplayground.net',
    bethard: 'bethardplayground.net',
    betsafe: 'bsfplayground.net',
    betsmith: 'betsmithplayground.net',
    betsolid: 'betsolidplayground.net',
    betsson: 'btsplayground.net',
    betssonarcb: 'btsarcbplayground.net',
    betssonbr: 'btsbrplayground.net',
    betssondk: 'btsdkplayground.net',
    betssones: 'btsesplayground.net',
    betssongr: 'btsgrplayground.net',
    betssonmx: 'btsmxplayground.net',
    btsarba: 'btsarbaplayground.net',
    btsarbacity: 'btsarbacityplayground.net',
    cherry: 'cherryplayground.net',
    guts: 'gutsplayground.net',
    ibet: 'ibetplayground.net',
    inkabet: 'inkabetplayground.net',
    mobilbahis: 'mbaplayground.net',
    nordicbet: 'ndbplayground.net',
    nordicbetdk: 'ndbdkplayground.net',
    playgurus: 'pgplayground.net',
    rizk: 'rizkplayground.net',
    spelklubben: 'spelklubbenplayground.net'
  };

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
    // Fall back to the playground-host suffix map when the real brand
    // domain didn't match - covers the case where the user is on a
    // generated iframe test link (e.g. d-cf.test.ndbplayground.net)
    // rather than the brand's own production/test site.
    var isSandboxHost = false;
    if (!brand) {
      Object.keys(PLAYGROUND_HOST_SUFFIX).forEach(function (key) {
        var suffix = PLAYGROUND_HOST_SUFFIX[key];
        if (host === suffix || host.slice(-(suffix.length + 1)) === '.' + suffix) { brand = key; isSandboxHost = true; }
      });
    }
    return { brand: brand, environment: env, isSandboxHost: isSandboxHost };
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

  // Like waitForElement, but also races against the login page itself
  // redirecting away before the form ever renders - some brands' login
  // page checks for an existing valid session and immediately bounces to
  // the logged-in homepage instead of showing the form at all (confirmed
  // 2026-08-06 on NordicBet prod: a background tab opened at
  // https://nordicbet.com/en/login while the browser already carried a
  // valid prod session from earlier manual browsing landed on
  // https://nordicbet.com/en, fully logged in, with the login form never
  // appearing - waitForElement's plain timeout misreported this as
  // "Username field not found" instead of recognizing it as an
  // already-authenticated session that just needs the Sportsbook capture
  // step, not a login at all). Resolves { alreadyLoggedIn: true } if the
  // pathname stops containing loginPath before the field shows up,
  // otherwise { field: <element-or-null> } exactly like waitForElement.
  function waitForUsernameFieldOrAlreadyLoggedIn(sel, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var lastSeen = null;
      (function poll() {
        var stillOnLogin = true;
        try { stillOnLogin = location.pathname.indexOf(sel.loginPath) !== -1; } catch (e) {}
        if (!stillOnLogin) return resolve({ alreadyLoggedIn: true });
        var el = deepQuerySelector(sel.usernameSelector);
        if (el) lastSeen = el;
        if (el && isVisible(el)) return resolve({ field: el });
        if (Date.now() - start > timeoutMs) return resolve({ field: lastSeen });
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
              // Diagnostic breadcrumb for the next time this happens: lets
              // us tell a write-side issue (c is null/undefined - background.js
              // never saw the headers at all) apart from a read-side one
              // (c exists with a seenCount but stc/ctx are still empty).
              log('awaitCapture timed out after ' + budgetMs + 'ms - Capture.get() returned: ' + (c ? JSON.stringify({ seenCount: c.seenCount, hasStc: !!c.stc, hasCtx: !!c.ctx }) : 'null'));
              resolve(false);
              return;
            }
            setTimeout(poll, 300);
          });
        })();
      });
    }

    return new Promise(function (resolve) {
      // Give the just-landed post-login page a head start: for brands
      // where that landing page already IS the Sportsbook section, no
      // click is needed at all, and waiting for one would only risk
      // missing the capture window. Bumped from 2500ms - real-world
      // testing 2026-08-06 showed a genuinely successful login/navigation
      // (confirmed via screenshot: real balance, full Sportsbook lobby
      // loaded) still reporting "no stc/ctx captured", and a live
      // end-to-end test of this exact extension code against the real
      // site succeeded but took ~12s total for the whole login+capture
      // sequence in a fast test environment - a real user's slower
      // network/machine could plausibly exceed the old, tighter budgets.
      // The post-login landing page (e.g. NordicBet's plain "/en") can show
      // its own cookie-consent banner even when the earlier login-page
      // dismissal already ran - it's a different route/component tree, and
      // some consent SDKs re-check per-page. An undismissed banner can
      // silently intercept the click meant for the Sportsbook nav link
      // exactly like the already-documented login-form case
      // (tryDismissCookieBanner's comment) - looks identical to "capture is
      // just slow" in the logs, so dismiss proactively before searching.
      tryDismissCookieBanner(log);
      awaitCapture(5000).then(function (already) {
        if (already) return resolve(true);
        if (!pattern) {
          log('No known Sportsbook nav link pattern for "' + brandKey + '" - click into the Sportsbook section yourself so stc/ctx capture can complete.');
          resolve(false);
          return;
        }
        var startPath = location.pathname;
        var start = Date.now();
        function clickAndAwait(linkEl, allowRetry) {
          var c = centerOf(linkEl);
          sendTrustedSequence([{ type: 'click', x: c.x, y: c.y }]).then(function () {
            // Verify the click actually navigated somewhere before waiting
            // the full capture budget - a banner/overlay intercepting the
            // click leaves location.pathname unchanged, which otherwise
            // isn't distinguishable from "the capture is just slow" in the
            // logs. One retry (with a fresh banner-dismiss attempt) covers
            // a banner that only appeared after the first search/click.
            setTimeout(function () {
              if (allowRetry && location.pathname === startPath) {
                log('Click on the Sportsbook nav link did not navigate anywhere yet (still on ' + startPath + ') - a cookie banner or overlay may have intercepted it; retrying once...');
                tryDismissCookieBanner(log);
                var retryEl = findSportsbookNavLink(pattern);
                if (retryEl) return clickAndAwait(retryEl, false);
              }
              awaitCapture(20000).then(function (ok) {
                if (!ok) log('Navigated to Sportsbook, but no stc/ctx captured yet - it may still be loading; check the Live Login tab.');
                resolve(ok);
              });
            }, 1500);
          });
        }
        (function pollNav() {
          var linkEl = findSportsbookNavLink(pattern);
          if (linkEl) {
            clickAndAwait(linkEl, true);
            return;
          }
          if (Date.now() - start > 7000) {
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

  function attemptAutoLogin(brandKey, username, password, log, isSilentWindow) {
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
    // finished mounting yet on a slow alpha-environment page load. Bumped
    // again from 15000ms after a qa-environment failure the same day -
    // NordicBet's qa login page loads an additional Group-IB
    // fraud-detection iframe (eu.id.group-ib.com) not observed on alpha,
    // which can meaningfully delay when the (deeply shadow-DOM-nested,
    // depth 6+ observed) login widget actually mounts and becomes
    // queryable.
    // Even 25000ms occasionally isn't enough - reported 2026-08-06 as an
    // INTERMITTENT failure (works most of the time, dies occasionally),
    // consistent with the Group-IB iframe delay above being variable
    // (network/server load dependent) rather than a hard "never mounts"
    // case. Rather than pushing the single timeout even higher (which
    // delays every real "not supported here" case too), give the page one
    // more, shorter, second chance below - re-running the cookie-banner
    // dismissal too, in case a banner appeared only after the first wait
    // elapsed and was itself blocking the modal.
    return waitForUsernameFieldOrAlreadyLoggedIn(sel, 25000).then(function (result) {
      if (result.alreadyLoggedIn || result.field) return result;
      log('Still waiting for the username field (this environment can be slow to mount the login form) - trying a bit longer...');
      tryDismissCookieBanner(log);
      // Nudge: if this job is running in the silent/minimized background
      // window, a minimized page's document.visibilityState is 'hidden',
      // which Chrome uses to pause/heavily throttle
      // requestAnimationFrame - and this modal's own mount/animate-in
      // apparently depends on rAF timing (confirmed by a 2026-08-07
      // screenshot: the field WAS present once the window got
      // un-minimized for the failure view, despite "not found" during the
      // minimized wait). Briefly restoring 'normal' state (still
      // unfocused - doesn't steal input focus or flash to the front) for
      // just this second, slower-mount wait gives rAF a chance to run at
      // full rate without giving up full invisibility for the common/fast
      // case above. Re-minimized again once this second wait resolves,
      // regardless of outcome - see the .then below. Guarded by
      // isSilentWindow (only true for the actual background-window job -
      // see resumeLiveLoginJobIfPending's call site) since the manual
      // "Auto-login" button in the Live Login tab runs in the user's own
      // CURRENT foreground window, where forcing state:'normal'+
      // focused:false would defocus whatever the user is actively doing.
      if (isSilentWindow) {
        try { chrome.runtime.sendMessage({ type: 'lgt-window-set-state', state: 'normal' }); } catch (e) {}
      }
      return waitForUsernameFieldOrAlreadyLoggedIn(sel, 15000).then(function (secondResult) {
        if (isSilentWindow) {
          try { chrome.runtime.sendMessage({ type: 'lgt-window-set-state', state: 'minimized' }); } catch (e) {}
        }
        return secondResult;
      });
    }).then(function (result) {
      if (result.alreadyLoggedIn) {
        log('Already logged in (redirected away from the login page before any form appeared, most likely because a valid session already existed here from earlier browsing) - skipping straight to Sportsbook capture.');
        return navigateToSportsbookAndAwaitCapture(brandKey, log).then(function () { return true; });
      }
      var userEl = result.field;
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

  // Turns a raw JS error into a user-actionable message for the log/status
  // areas. "Extension context invalidated." is a real, expected Chrome
  // occurrence - it's what chrome.runtime/chrome.storage calls throw in a
  // content script whose extension was reloaded/updated (e.g. via
  // chrome://extensions "Reload") while this tab's panel was already
  // injected from the OLD version. It is NOT a bug in the tool's own
  // logic - the fix is simply to reload the page so a fresh content
  // script attaches to the new extension context - but the raw browser
  // message gives no hint of that, so it repeatedly confused a user who
  // updated the extension without also refreshing an already-open tab
  // (2026-08-07). Reused everywhere a chrome.* call's rejection is shown
  // directly to the user.
  function friendlyErrorMessage(err) {
    var raw = String(err && err.message || err || '');
    if (/Extension context invalidated/i.test(raw)) {
      return 'The addon was just updated/reloaded - this tab is still running the OLD version. Reload this page (F5) and try again.';
    }
    return raw;
  }

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

  // Runs fn() immediately, then every intervalMs, until either the tab is
  // closed or the extension itself gets reloaded/updated while this page
  // stays open (a normal event during dev, or a background auto-update in
  // the wild). In that second case `chrome.runtime.id` becomes undefined
  // and any chrome.runtime.* call throws a synchronous, uncatchable-by-
  // -callback "Extension context invalidated" error - without this guard
  // that error re-fires (and gets logged) every tick forever, since
  // nothing else ever clears a plain setInterval. Used by both the
  // Detected-build strip and the Bundle tab's status poller, the only two
  // places in the panel that poll the background page on a timer.
  function pollWhileExtensionValid(fn, intervalMs) {
    // iv is assigned before the first tick() runs (not after) so that even
    // an invalidation caught on the very first call can clear it - a plain
    // "tick(); iv = setInterval(...)" ordering would leave iv still null
    // during that first call, silently leaking one live interval.
    var iv = setInterval(tick, intervalMs);
    function tick() {
      if (!chrome.runtime || !chrome.runtime.id) { clearInterval(iv); return; }
      try { fn(); } catch (e) { clearInterval(iv); }
    }
    tick();
    return iv;
  }

  // A single, reused "First connect VPN!" modal - shown whenever a
  // user-initiated Generate/Live-Login action's internal.*.sbplayground1.net
  // call fails with a classified VPN/connectivity error (see
  // isVpnLikeNetworkError above). Appended directly to document.body (not
  // inside #lgt-panel) so it stays visible regardless of which panel tab
  // is active or whether the panel is minimized/collapsed. Deliberately
  // reactive-only per the user's explicit choice - there is no background
  // polling, this only ever appears as the direct result of a real failed
  // fetch. Retry re-invokes whatever action just failed; a repeat failure
  // just calls this again naturally, no extra state machine needed.
  var vpnPopupEls = null;
  function showVpnRequiredPopup(message, retryFn) {
    if (!vpnPopupEls) {
      var style = document.createElement('style');
      style.id = 'lgt-vpn-popup-style';
      style.textContent = [
        '#lgt-vpn-popup-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483647;',
        'display:flex;align-items:center;justify-content:center;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
        '#lgt-vpn-popup{background:#101320;color:#f6f7fb;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);',
        'padding:20px;width:320px;text-align:center;border:1px solid #ff6600}',
        '#lgt-vpn-popup h4{margin:0 0 8px;font-size:16px}',
        '#lgt-vpn-popup p{margin:0 0 14px;color:#9aa3b8;font-size:12px;word-break:break-word}',
        '#lgt-vpn-popup .lgt-row{display:flex;gap:8px}',
        '#lgt-vpn-popup button{flex:1;padding:8px;border:none;border-radius:6px;font-weight:600;cursor:pointer}',
        '#lgt-vpn-popup .lgt-vpn-retry{background:#ff6600;color:#101320}',
        '#lgt-vpn-popup .lgt-vpn-close{background:#2b3350;color:#f6f7fb}'
      ].join('');
      document.head.appendChild(style);

      var msgEl = el('p', {}, ['']);
      var retryBtn = el('button', { class: 'lgt-vpn-retry' }, ['Retry']);
      var closeBtn = el('button', { class: 'lgt-vpn-close' }, ['Close']);
      var box = el('div', { id: 'lgt-vpn-popup' }, [
        el('h4', {}, ['\uD83D\uDD12 First connect VPN!']),
        msgEl,
        el('div', { class: 'lgt-row' }, [retryBtn, closeBtn])
      ]);
      var backdrop = el('div', {
        id: 'lgt-vpn-popup-backdrop', style: 'display:none',
        onclick: function (e) { if (e.target === backdrop) hide(); }
      }, [box]);
      (document.body || document.documentElement).appendChild(backdrop);

      var currentRetry = null;
      function hide() { backdrop.style.display = 'none'; currentRetry = null; }
      retryBtn.addEventListener('click', function () {
        var fn = currentRetry;
        hide();
        if (fn) fn();
      });
      closeBtn.addEventListener('click', hide);

      vpnPopupEls = { backdrop: backdrop, msgEl: msgEl, show: function (msg, fn) {
        msgEl.textContent = msg || 'Couldn\'t reach the internal sbplayground1.net API.';
        currentRetry = fn || null;
        backdrop.style.display = 'flex';
      } };
    }
    vpnPopupEls.show(message, retryFn);
  }

  // Item 8/11: a compact, scrollable checkbox matrix over every known
  // brand key (BRANDS), used both when creating a credential and when
  // editing an existing one's brand list later. Returns the wrapper
  // element with a __lgtGetSelected() accessor instead of wiring its own
  // save button, so callers can decide when/how to persist the result.
  function buildBrandMatrix(selected) {
    selected = selected || [];
    var wrap = el('div', { class: 'lgt-brand-matrix' });
    var checks = {};
    Object.keys(BRANDS).sort().forEach(function (key) {
      var chk = el('input', { type: 'checkbox' });
      chk.checked = selected.indexOf(key) !== -1;
      checks[key] = chk;
      wrap.appendChild(el('label', { class: 'lgt-checkbox-row lgt-brand-matrix-row' }, [chk, ' ' + key]));
    });
    wrap.__lgtGetSelected = function () {
      return Object.keys(checks).filter(function (k) { return checks[k].checked; });
    };
    return wrap;
  }

  // Lets the user pick the panel up by its header (title bar) and drop it
  // anywhere in the viewport, instead of it staying pinned to the
  // top-right corner forever. Switches the panel from right/top-anchored
  // positioning to explicit left/top on the first drag so it can move
  // freely afterwards, and clamps to the viewport so it can't be dragged
  // fully off-screen (which would make it unreachable again).
  function makeDraggable(panel, handle) {
    var dragging = false, offsetX = 0, offsetY = 0;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', function (e) {
      // Don't start a drag when the click is on the header's own action
      // buttons (minimize/close) - those need their normal click behavior.
      if (e.target.closest && e.target.closest('.lgt-header-actions')) return;
      dragging = true;
      var rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, e.clientX - offsetX));
      var y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - offsetY));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  }

  var PANEL_OPEN_KEY = 'lgt-panel-open';
  var PANEL_COLLAPSED_KEY = 'lgt-panel-collapsed';

  var THEME_KEY = 'lgt-theme';

  function buildPanel() {
    var style = document.createElement('style');
    style.id = 'lgt-panel-style';
    style.textContent = [
      // Colors are CSS custom properties so the dark/light toggle below
      // can just switch a class on #lgt-panel instead of needing two
      // separate copies of every rule.
      '#lgt-panel{--lgt-bg:#101320;--lgt-fg:#f6f7fb;--lgt-tab-bg:#1c2233;--lgt-accent:#ff6600;',
      '--lgt-accent-fg:#101320;--lgt-muted:#9aa3b8;--lgt-input-bg:#1c2233;--lgt-input-border:#2b3350;',
      '--lgt-secondary-bg:#2b3350;}',
      '#lgt-panel.lgt-theme-light{--lgt-bg:#f4f5f9;--lgt-fg:#1b1f2b;--lgt-tab-bg:#e4e7f0;--lgt-accent:#ff6600;',
      '--lgt-accent-fg:#ffffff;--lgt-muted:#5a6178;--lgt-input-bg:#ffffff;--lgt-input-border:#c7cce0;',
      '--lgt-secondary-bg:#dde1ee;}',
      '#lgt-panel{position:fixed;top:20px;right:20px;width:360px;max-height:88vh;overflow:auto;',
      'background:var(--lgt-bg);color:var(--lgt-fg);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      'border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.4);z-index:2147483647;padding:14px;}',
      '#lgt-panel h3{margin:0 0 8px;font-size:15px;display:flex;justify-content:space-between;align-items:center}',
      '#lgt-panel .lgt-header-actions{display:flex;align-items:center;gap:10px;flex:none}',
      '#lgt-panel .lgt-tabs{display:flex;gap:6px;margin-bottom:10px}',
      '#lgt-panel .lgt-tab{flex:1;text-align:center;padding:6px;border-radius:6px;background:var(--lgt-tab-bg);cursor:pointer}',
      '#lgt-panel .lgt-tab.active{background:var(--lgt-accent);color:var(--lgt-accent-fg);font-weight:600}',
      '#lgt-panel label{display:block;margin:8px 0 3px;color:var(--lgt-muted);font-size:11px;text-transform:uppercase}',
      '#lgt-panel select,#lgt-panel input{width:100%;box-sizing:border-box;padding:6px;border-radius:5px;border:1px solid var(--lgt-input-border);background:var(--lgt-input-bg);color:var(--lgt-fg)}',
      // Checkbox rows (BLE source / Force fresh): without this, the
      // generic "select,input{width:100%}" rule above stretches the
      // checkbox itself to fill the whole row (inputs match it too),
      // which is what was pushing the label text out of a clean
      // left-aligned line. Pin the checkbox to its natural size and lay
      // the row out as a simple left-aligned flex row instead.
      '#lgt-panel input[type=checkbox]{width:auto;flex:0 0 auto;margin:0;accent-color:var(--lgt-accent)}',
      '#lgt-panel .lgt-checkbox-row{display:flex;align-items:center;justify-content:flex-start;gap:8px;',
      'text-transform:none;margin-top:8px;text-align:left}',
      '#lgt-panel button{margin-top:10px;width:100%;padding:8px;border:none;border-radius:6px;background:var(--lgt-accent);color:var(--lgt-accent-fg);font-weight:600;cursor:pointer}',
      '#lgt-panel button.secondary{background:var(--lgt-secondary-bg);color:var(--lgt-fg);margin-top:6px}',
      '#lgt-panel .lgt-row{display:flex;gap:8px}',
      '#lgt-panel .lgt-row > *{flex:1}',
      '#lgt-panel .lgt-result{margin-top:10px;background:var(--lgt-tab-bg);border-radius:6px;padding:8px;word-break:break-all;font-size:11px}',
      '#lgt-panel .lgt-log{margin-top:8px;font-size:11px;color:var(--lgt-muted);white-space:pre-wrap}',
      '#lgt-panel .lgt-close,#lgt-panel .lgt-min,#lgt-panel .lgt-theme-toggle{cursor:pointer;color:var(--lgt-muted)}',
      '#lgt-panel .lgt-min{font-weight:700}',
      // Collapsed ("_"-minimized): only the header stays visible, the
      // panel shrinks to fit since its content is removed from layout.
      '#lgt-panel.lgt-collapsed .lgt-content{display:none}',
      '#lgt-panel.lgt-collapsed h3{margin-bottom:0}',
      '#lgt-panel .lgt-cred{display:flex;justify-content:space-between;align-items:center;background:var(--lgt-tab-bg);padding:6px;border-radius:5px;margin-top:6px}',
      '#lgt-panel .lgt-cred.default{border:1px solid var(--lgt-accent)}',
      '#lgt-panel .lgt-cred button{width:auto;margin:0;padding:3px 8px;font-size:11px}',
      // Item 5: Brands/Delete (and Set default, when present) sat flush
      // against each other with no breathing room since .lgt-cred button
      // above zeroes their margin for the compact row layout - restore
      // spacing on the actions container itself instead.
      '#lgt-panel .lgt-cred-actions{display:flex;gap:6px}',
      // Item 8/11: scrollable brand checkbox matrix (credential creation
      // form + per-credential "Brands" editor panel) - kept compact since
      // there are 30+ brands to list.
      '#lgt-panel .lgt-brand-matrix{max-height:140px;overflow-y:auto;background:var(--lgt-tab-bg);border-radius:5px;padding:6px;margin-top:6px}',
      '#lgt-panel .lgt-brand-matrix-row{margin-top:2px;font-size:11px}',
      '#lgt-panel .lgt-cred-brands{margin-top:4px;font-size:10px;color:var(--lgt-muted)}',
      // Items 2/3/12: inline credential-resolution prompt on the
      // Generate tab (only shown when there is a genuine choice to make).
      '#lgt-panel .lgt-cred-resolve{margin-top:8px;background:var(--lgt-tab-bg);border-radius:6px;padding:8px}',
      '#lgt-panel .lgt-cred-resolve select,#lgt-panel .lgt-cred-resolve input,#lgt-panel .lgt-cred-resolve button{width:100%;margin-top:4px}',
      '#lgt-panel .lgt-hint{font-size:11px;color:var(--lgt-muted)}',
      // Item 15: small availability badge next to the logged-in toggle.
      // Sits below the select now (not inside the label - see item 4
      // fix), so it can't change the label's own height/wrap and throw
      // this column out of vertical alignment with the Environment
      // column's plain single-line label.
      '#lgt-panel .lgt-cred-badge{display:block;font-size:10px;margin-top:4px;padding:1px 6px;border-radius:8px;white-space:nowrap;width:fit-content}',
      '#lgt-panel .lgt-cred-badge.has{background:#1e7e34;color:#fff}',
      '#lgt-panel .lgt-cred-badge.none{background:#a02020;color:#fff}',
      // "Detected build" strip - always visible above the tabs, on every
      // tab (unlike the Bundle tab's own controls). See buildDetectedBuildStrip().
      '#lgt-panel .lgt-build-strip{background:var(--lgt-tab-bg);border-radius:6px;padding:6px 8px;margin-bottom:10px;font-size:11px}',
      '#lgt-panel .lgt-build-row{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap}',
      '#lgt-panel .lgt-build-badge{padding:1px 6px;border-radius:8px;font-weight:700;white-space:nowrap;font-size:10px}',
      '#lgt-panel .lgt-build-badge.match{background:#1e7e34;color:#fff}',
      '#lgt-panel .lgt-build-badge.mismatch{background:#c77900;color:#fff}',
      '#lgt-panel .lgt-build-strip button{width:auto;margin:0;padding:3px 8px;font-size:10px;flex:none}',
      '#lgt-panel .lgt-build-strip .lgt-build-actions{display:flex;gap:6px;flex:none}',
      '#lgt-panel .lgt-build-verify{margin-top:4px;font-size:10px;color:var(--lgt-muted);white-space:pre-wrap}'
    ].join('');
    document.head.appendChild(style);

    var panel = el('div', { id: 'lgt-panel', style: 'display:none' });
    var titleText = el('span', {}, ['Link Gen Tool ', el('span', { style: 'opacity:.5;font-weight:400;font-size:10px' }, [VERSION])]);
    var themeBtn = el('span', {
      class: 'lgt-theme-toggle', title: 'Toggle dark/light mode',
      onclick: function () {
        var next = panel.classList.contains('lgt-theme-light') ? 'dark' : 'light';
        applyTheme(next);
        var obj = {};
        obj[THEME_KEY] = next;
        chrome.storage.local.set(obj);
      }
    }, ['\u25D1']);
    function applyTheme(mode) {
      panel.classList.toggle('lgt-theme-light', mode === 'light');
      themeBtn.textContent = mode === 'light' ? '\u25D0' : '\u25D1';
    }
    chrome.storage.local.get([THEME_KEY], function (res) {
      if (res && res[THEME_KEY] === 'light') applyTheme('light');
    });
    var minBtn = el('span', {
      class: 'lgt-min', title: 'Minimize', onclick: function () {
        panel.classList.toggle('lgt-collapsed');
        try { sessionStorage.setItem(PANEL_COLLAPSED_KEY, panel.classList.contains('lgt-collapsed') ? '1' : '0'); } catch (e) {}
      }
    }, ['_']);
    var closeBtn = el('span', {
      class: 'lgt-close', title: 'Close', onclick: function () {
        panel.style.display = 'none';
        try { sessionStorage.setItem(PANEL_OPEN_KEY, '0'); } catch (e) {}
      }
    }, ['x']);
    var headerActions = el('div', { class: 'lgt-header-actions' }, [themeBtn, minBtn, closeBtn]);
    var title = el('h3', {}, [titleText, headerActions]);
    makeDraggable(panel, title);
    var tabs = el('div', { class: 'lgt-tabs' });
    var tabA = el('div', { class: 'lgt-tab active' }, ['Generate']);
    var tabB = el('div', { class: 'lgt-tab' }, ['Live Login']);
    var tabC = el('div', { class: 'lgt-tab' }, ['Credentials']);
    var tabD = el('div', { class: 'lgt-tab' }, ['Bundle']);
    var tabE = el('div', { class: 'lgt-tab' }, ['BLE Data']);
    tabs.appendChild(tabA); tabs.appendChild(tabB); tabs.appendChild(tabC); tabs.appendChild(tabD); tabs.appendChild(tabE);

    var bodyA = buildModeA();
    var bodyB = buildModeB();
    var bodyC = buildModeC();
    var bodyD = buildModeD();
    var bodyE = buildModeE();
    bodyB.style.display = 'none';
    bodyC.style.display = 'none';
    bodyD.style.display = 'none';
    bodyE.style.display = 'none';
    bodyB.__lgtGoToCredentials = function () { tabC.click(); };
    bodyA.__lgtGoToCredentials = function () { tabC.click(); };

    var pairs = [[tabA, bodyA], [tabB, bodyB], [tabC, bodyC], [tabD, bodyD], [tabE, bodyE]];
    pairs.forEach(function (pair) {
      pair[0].addEventListener('click', function () {
        pairs.forEach(function (p) {
          p[0].classList.toggle('active', p === pair);
          p[1].style.display = p === pair ? '' : 'none';
        });
      });
    });

    // Wrapped in one element so minimizing can hide tabs + all three tab
    // bodies with a single CSS rule (see ".lgt-collapsed .lgt-content"
    // above) instead of having to touch each of them individually.
    var content = el('div', { class: 'lgt-content' });
    content.appendChild(buildDetectedBuildStrip());
    content.appendChild(tabs);
    content.appendChild(bodyA);
    content.appendChild(bodyB);
    content.appendChild(bodyC);
    content.appendChild(bodyD);
    content.appendChild(bodyE);

    panel.appendChild(title);
    panel.appendChild(content);
    (document.body || document.documentElement).appendChild(panel);
    panel.__lgtSwitchToLiveLogin = function () { tabB.click(); };
    panel.__lgtSwitchToCredentials = function () { tabC.click(); };
    panel.__lgtAutoLoginBtn = bodyB.__lgtAutoLoginBtn;
    panel.__lgtShow = function () {
      panel.style.display = '';
      try { sessionStorage.setItem(PANEL_OPEN_KEY, '1'); } catch (e) {}
    };
    panel.__lgtToggle = function () {
      var willShow = panel.style.display === 'none';
      panel.style.display = willShow ? '' : 'none';
      try { sessionStorage.setItem(PANEL_OPEN_KEY, willShow ? '1' : '0'); } catch (e) {}
    };
    // Restore panel open/collapsed state after a same-tab reload -
    // sessionStorage survives a normal reload of the same origin/tab (but
    // not a brand-new tab or a different site), so this reopens the panel
    // exactly where the user left it without leaking that state to
    // unrelated tabs/sites (unlike a chrome.storage.local flag, which
    // would be shared globally across every open tab).
    try {
      if (sessionStorage.getItem(PANEL_COLLAPSED_KEY) === '1') panel.classList.add('lgt-collapsed');
      if (sessionStorage.getItem(PANEL_OPEN_KEY) === '1') panel.style.display = '';
    } catch (e) {}
    return panel;
  }

  function brandOptions(selected) {
    return Object.keys(BRANDS).sort().map(function (k) {
      return el('option', Object.assign({ value: k }, k === selected ? { selected: 'selected' } : {}), [k]);
    });
  }

  // Persists the Generate tab's own form controls (brand/environment/
  // login-state/BLE/force-fresh/customer-key) so a page reload - which
  // rebuilds the whole panel from scratch, same as a first open - doesn't
  // silently reset every dropdown back to its default. Deliberately a
  // single flat "last used" snapshot (not per-brand) since these are all
  // meant to reflect "what was I just doing", not brand-specific settings.
  var GEN_STATE_KEY = 'lgt-gen-state-v1';

  function saveGenState(partial) {
    chrome.storage.local.get([GEN_STATE_KEY], function (res) {
      var state = Object.assign({}, res && res[GEN_STATE_KEY], partial);
      var obj = {};
      obj[GEN_STATE_KEY] = state;
      chrome.storage.local.set(obj);
    });
  }

  function buildModeA() {
    var wrap = el('div', {});
    var brandSel = el('select', {}, brandOptions());
    var envSel = el('select', {}, ENV_LABELS.map(function (e) { return el('option', { value: e }, [e]); }));
    var loginSel = el('select', {}, [el('option', { value: 'out' }, ['logged-out']), el('option', { value: 'in' }, ['logged-in'])]);
    var bleChk = el('input', { type: 'checkbox' });
    var forceFreshChk = el('input', { type: 'checkbox' });
    var forceVisibleChk = el('input', { type: 'checkbox' });
    var result = el('div', { class: 'lgt-result', style: 'display:none' });
    var log = el('div', { class: 'lgt-log' });
    // Items 2/3/12: inline area used only while resolving which saved
    // credential to use for a logged-in live-login generation - hidden
    // whenever nothing needs the user's input (single/no-choice cases
    // resolve silently without ever showing this).
    var credResolveArea = el('div', { class: 'lgt-cred-resolve', style: 'display:none' });

    // 2026-08-07: three fixed, persistent row containers inside `result`
    // (instead of wiping+rebuilding `result.innerHTML` on every click) so
    // the split Desktop/Mobile buttons (see refreshGenerateButtonMode
    // below) can update just ONE device's row without touching whatever
    // the OTHER device's button rendered on a previous click - per user
    // decision, clicking Desktop then Mobile (or vice versa) keeps both
    // rows visible side by side, it does not clear the other one.
    var desktopRowContainer = el('div', { style: 'display:none' });
    var mobileRowContainer = el('div', { style: 'display:none' });
    var brandRowContainer = el('div', { style: 'display:none' });
    result.appendChild(desktopRowContainer);
    result.appendChild(mobileRowContainer);
    result.appendChild(brandRowContainer);

    // Guards against stale-row leakage across an unrelated selection
    // change: if the user switches brand/environment/login-state/BLE
    // between clicks, the next click must start from a clean slate (a
    // Desktop-only click for a NEW brand must not leave a Mobile row from
    // a DIFFERENT, previous brand still sitting next to it) - only a
    // repeat click for the SAME selection is allowed to keep the other
    // device's existing row untouched.
    var lastRenderedResultKey = null;
    function resultKeyFor(brand, environment, loggedIn, bleSource) {
      return brand + '|' + environment + '|' + (loggedIn ? '1' : '0') + '|' + (bleSource ? '1' : '0');
    }
    function ensureFreshResultFor(key) {
      if (key === lastRenderedResultKey) return;
      lastRenderedResultKey = key;
      [desktopRowContainer, mobileRowContainer, brandRowContainer].forEach(function (c) {
        c.innerHTML = '';
        c.style.display = 'none';
      });
    }
    function setRowContainer(container, label, link, rowBrand, rowEnvironment) {
      container.innerHTML = '';
      container.appendChild(renderLinkRow(label, link, rowBrand, rowEnvironment));
      container.style.display = '';
      result.style.display = '';
    }

    // Customer dropdown - lists every customer key the brand actually has
    // for the current environment/login-state (same data the internal
    // generate-link UI's own "Customer" dropdown reads from
    // /api/customers/{brandGuid}), instead of a free-text substring
    // filter. Hidden whenever there's nothing meaningful to pick (0 or 1
    // matching key) - most brands only have a single logged-out customer,
    // and forcing a one-option dropdown on everyone would just be noise.
    var customerSelect = el('select', {});
    var customerWrap = el('div', { style: 'display:none' }, [
      el('label', {}, ['Customer']),
      customerSelect
    ]);
    var customerFetchToken = 0;
    // Set once from restored state (see restoreGenState below) and
    // consumed exactly once by the first refreshCustomerOptions() run
    // after restore - a later brand/env/login-state change should NOT
    // keep re-applying a stale restored customer key onto an unrelated
    // brand's option list.
    var pendingRestoreCustomerKey = null;

    function refreshCustomerOptions() {
      var brand = brandSel.value;
      var brandGuid = BRANDS[brand];
      var token = ++customerFetchToken;
      if (!brandGuid) { customerWrap.style.display = 'none'; return; }
      var apiEnv = bleChk.checked ? 'prod' : envSel.value;
      var prefix = loginSel.value === 'in' ? 'logged-in' : 'logged-out';
      fetchInternal(apiBase(apiEnv) + '/api/customers/' + brandGuid)
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (customers) {
          if (token !== customerFetchToken) return; // superseded by a newer selection
          var keys = Object.keys(customers || {}).filter(function (k) {
            return k.toLowerCase().indexOf(prefix) === 0;
          });
          customerSelect.innerHTML = '';
          if (keys.length <= 1) {
            customerWrap.style.display = 'none';
            pendingRestoreCustomerKey = null;
            return;
          }
          keys.forEach(function (k) {
            customerSelect.appendChild(el('option', { value: k }, [(customers[k] || {}).label || k]));
          });
          if (pendingRestoreCustomerKey && keys.indexOf(pendingRestoreCustomerKey) !== -1) {
            customerSelect.value = pendingRestoreCustomerKey;
          }
          pendingRestoreCustomerKey = null;
          customerWrap.style.display = '';
        })
        .catch(function () {
          if (token !== customerFetchToken) return;
          customerWrap.style.display = 'none';
        });
    }

    brandSel.addEventListener('change', function () { saveGenState({ brand: brandSel.value }); refreshCustomerOptions(); });
    envSel.addEventListener('change', function () { saveGenState({ environment: envSel.value }); refreshCustomerOptions(); });
    loginSel.addEventListener('change', function () { saveGenState({ loginState: loginSel.value }); refreshCustomerOptions(); });
    bleChk.addEventListener('change', function () { saveGenState({ bleSource: bleChk.checked }); refreshCustomerOptions(); });
    forceFreshChk.addEventListener('change', function () { saveGenState({ forceFresh: forceFreshChk.checked }); });
    forceVisibleChk.addEventListener('change', function () { saveGenState({ forceVisible: forceVisibleChk.checked }); });
    customerSelect.addEventListener('change', function () { saveGenState({ customerKey: customerSelect.value }); });

    // Restore whatever was last used before doing the very first
    // customer-options fetch, so that fetch already reflects the
    // restored brand/environment/login-state instead of the hardcoded
    // defaults followed immediately by a second, redundant fetch.
    chrome.storage.local.get([GEN_STATE_KEY], function (res) {
      var saved = res && res[GEN_STATE_KEY];
      if (saved) {
        if (saved.brand && BRANDS[saved.brand]) brandSel.value = saved.brand;
        if (saved.environment && ENV_LABELS.indexOf(saved.environment) !== -1) envSel.value = saved.environment;
        if (saved.loginState === 'in' || saved.loginState === 'out') loginSel.value = saved.loginState;
        if (typeof saved.bleSource === 'boolean') bleChk.checked = saved.bleSource;
        if (typeof saved.forceFresh === 'boolean') forceFreshChk.checked = saved.forceFresh;
        if (typeof saved.forceVisible === 'boolean') forceVisibleChk.checked = saved.forceVisible;
        if (saved.customerKey) pendingRestoreCustomerKey = saved.customerKey;
      }
      refreshCustomerOptions();
      if (typeof refreshCredBadge === 'function') refreshCredBadge();
      if (typeof refreshGenerateButtonMode === 'function') refreshGenerateButtonMode();
    });

    // Falls back to '' (let generateLink() auto-pick the first match) when
    // the dropdown is hidden/empty, otherwise passes the exact selected
    // customer key through - generateLink()'s existing substring filter
    // matches an exact key against itself just fine, no change needed there.
    function selectedCustomerKeyFilter() {
      return customerWrap.style.display !== 'none' && customerSelect.value ? customerSelect.value : '';
    }

    // Item 0b: while a (possibly slow, background-tab) live-login job is
    // in flight, show a spinner-like busy state on whichever button(s)
    // exist instead of leaving them clickable with no feedback - most
    // relevant for the silent-login path, where there's no visible tab at
    // all to otherwise show progress. `generationInProgress` lets
    // refreshGenerateButtonMode() (below) avoid swapping the button row
    // out from under an in-flight click.
    var generationInProgress = false;

    // 2026-08-07: single shared implementation for the plain "Generate"
    // button AND the split "Generate Desktop"/"Generate Mobile" buttons -
    // `devices` says which device(s) a live-login fallback (if one is
    // needed at all) should capture: ['desktop','mobile'] for the single
    // button (today's behavior, unchanged), or a single-element array for
    // a split button (only that device's login runs, roughly halving the
    // wait compared to always doing both). The logged-out and
    // static-customer-key paths ignore `devices` entirely - they always
    // render both variants cheaply, exactly as before, since there is no
    // live-login (and therefore no doubled cost) in either of those.
    function runGenerateFlow(devices, clickedBtn, clickedLabel) {
      // Named (not anonymous) so a VPN-popup Retry click can call this
      // exact attempt again by referencing `attempt` from within its own
      // closure, instead of needing a separately-tracked wrapper.
      return function attempt() {
        var brand = brandSel.value;
        var environment = envSel.value;
        var loggedIn = loginSel.value === 'in';
        var bleSource = bleChk.checked;
        var forceFresh = forceFreshChk.checked;

        ensureFreshResultFor(resultKeyFor(brand, environment, loggedIn, bleSource));
        log.textContent = 'Generating...';

        function setBtnBusy(busy) {
          generationInProgress = busy;
          [btn, desktopBtn, mobileBtn].forEach(function (b) { if (b) b.disabled = busy; });
          if (clickedBtn) clickedBtn.textContent = busy ? (clickedLabel + '… ⏳') : clickedLabel;
        }
        setBtnBusy(true);

        function renderLinks(links) {
          log.textContent = 'Customer: ' + links.customerLabel;
          setRowContainer(desktopRowContainer, 'Desktop', links.desktop, brand, environment);
          setRowContainer(mobileRowContainer, 'Mobile', links.mobile, brand, environment);
          setRowContainer(brandRowContainer, 'Brand page', realBrandOrigin(brand, environment), brand, environment);
          setBtnBusy(false);
        }

        // BLE source (?bleSource=1) only makes sense together with a
        // context that is genuinely BLE-native, i.e. minted on prod (see
        // generateLink's own apiEnv rule: bleSource forces the
        // customer/context lookup to prod). A live-login session
        // captured on the TARGET env itself (e.g. qa) is BDE-native, not
        // BLE-native - forcing bleSource=1 onto THAT combination is what
        // caused a confirmed HTTP 503 (2026-08-06, direct HTTP check:
        // appending "?bleSource=1" to a link built from a qa-captured
        // stc/ctx returned a genuine server-side 503; the same URL
        // without bleSource returned a clean 200). The fix is not to drop
        // BLE for live-login, but to capture the live-login session on
        // PROD instead (prod always serves real, current BLE events -
        // there's no separate "prod BLE source" concept, prod IS BLE) and
        // then render that prod-sourced context on the target env's
        // frontend via the same host-rewrite + bleSource=1 mechanism the
        // static/simulated-customer BLE path already uses - see
        // runLiveLoginFallback below for the login-environment switch.
        // 2026-08-07: takes SEPARATE desktop/mobile stc+ctx pairs now (not
        // one shared pair) - confirmed root cause of "mobile bleSource
        // link click does nothing" was reusing a desktop-captured context
        // for the mobile link too; a real login in a mobile viewport
        // yields a genuinely different, device-scoped context on the
        // backend. Either pair may be `null` (device not requested this
        // run, see `devices` above) - that device's row is then simply
        // left as-is (untouched, whatever a previous click rendered for
        // it), never cleared.
        function spliceAndRender(stcDesktop, ctxDesktop, stcMobile, ctxMobile, bleSourceWanted) {
          generateLink({ brand: brand, environment: environment, loggedIn: false, customerKeyFilter: '', bleSource: bleSourceWanted }).then(function (links) {
            var suffix = bleSourceWanted ? ' + BLE' : '';
            if (stcDesktop && ctxDesktop) {
              var d = spliceContext(links.desktop, stcDesktop, ctxDesktop);
              setRowContainer(desktopRowContainer, 'Desktop (live-login' + suffix + ')', d, brand, environment);
            }
            if (stcMobile && ctxMobile) {
              var m = spliceContext(links.mobile, stcMobile, ctxMobile);
              setRowContainer(mobileRowContainer, 'Mobile (live-login' + suffix + ')', m, brand, environment);
            }
            setRowContainer(brandRowContainer, 'Brand page', realBrandOrigin(brand, environment), brand, environment);
            if (bleSourceWanted) {
              log.textContent += ' (BLE source applied: logged in for real on prod - prod always serves live BLE events - rendered on the ' + environment + ' frontend with bleSource=1.)';
            }
            setBtnBusy(false);
          }).catch(function (err) {
            log.textContent = 'Error building final link: ' + friendlyErrorMessage(err);
            setBtnBusy(false);
            // Cheap retry: the live-login capture already succeeded, so
            // retrying just re-runs this same final splice/build step
            // with the exact same already-captured stc/ctx - no repeat
            // login needed.
            if (err && err.isVpnRequired) {
              showVpnRequiredPopup(err.message, function () {
                setBtnBusy(true);
                spliceAndRender(stcDesktop, ctxDesktop, stcMobile, ctxMobile, bleSourceWanted);
              });
            }
          });
        }

        // Runs the live-login capture(s) (cache -> background-tab job)
        // for brands with no real logged-in test customer, splicing the
        // captured stc/ctx into the normal logged-out link once done -
        // same mechanism the sbplayground-link-generator skill documents
        // as a manual workaround (REFERENCE.md), just automated here.
        // When BLE source is wanted, the login itself happens on PROD
        // (not the target env) - see the note on spliceAndRender above -
        // so the cache/job are also keyed on prod in that case; a single
        // prod capture can then be reused (via spliceAndRender's host
        // rewrite) to render BLE-sourced logged-in links for ANY target
        // env (test/qa/alpha), not just the one originally requested.
        // forceFreshWanted skips the 30-min cache and always runs a
        // brand-new capture, for cases where a guaranteed-fresh context
        // is needed regardless of cache age.
        //
        // 2026-08-07: runs the capture only for the requested
        // `devicesToRun` (in order), instead of always both - the split
        // Desktop/Mobile buttons pass a single-element array so only ONE
        // login runs per click, roughly halving the wait when the user
        // only needs one of the two link variants. Each pass is
        // independently cache-checked (LiveLoginCache is keyed
        // per-device) and independently subject to forceFreshWanted, so
        // "Force fresh" on a Mobile-only click never disturbs a cached
        // Desktop capture.
        function runLiveLoginFallback(bleSourceWanted, forceFreshWanted, credentialId, devicesToRun) {
          var loginEnv = bleSourceWanted ? 'prod' : environment;

          // Captures (or reuses a cached) stc/ctx for exactly one device.
          // Calls onDone(stc, ctx) on success; on failure/timeout it
          // updates the log and flips the buttons back to idle itself and
          // simply never calls onDone, which naturally halts the
          // requested-devices chain below without any extra bookkeeping.
          function captureForDevice(device, onDone) {
            function startFreshCapture(reasonPrefix) {
              var settled = false;
              var deadline = Date.now() + 60000;

              // Item 0c: a brand's very first successful capture always ran
              // with the tab briefly visible (safety net for unknown
              // selectors); once proven ('captured' at least once), silent
              // becomes that brand's default from then on. The "Show login
              // tab" checkbox always overrides this in either direction for
              // one generation.
              isBrandSilentVerified(brand, function (verified) {
                var wantVisible = forceVisibleChk.checked || !verified;
                log.textContent = (reasonPrefix || '') + 'Running a one-time live login on the real site (' + device + ' link, ' + (wantVisible ? 'visible tab' : 'background tab, invisible') + ')...';

                var jobChangeListener = null;
                LiveLoginJob.start(brand, loginEnv, wantVisible, credentialId, device, function (startResult) {
                  if (!startResult.ok) {
                    log.textContent = 'Error starting live login: ' + friendlyErrorMessage(new Error(startResult.error));
                    setBtnBusy(false);
                    return;
                  }
                  jobChangeListener = LiveLoginJob.onChange(function (job) {
                    if (settled || !job) return;
                    if (job.status === 'logging-in') {
                      log.textContent = 'Logging in on the real site (' + device + ' link)...';
                    } else if (job.status === 'captured') {
                      log.textContent = 'Captured ' + device + ' live-login context!';
                      markBrandSilentVerified(brand);
                      settled = true;
                      LiveLoginJob.offChange(jobChangeListener);
                      LiveLoginJob.clear();
                      onDone(job.stc, job.ctx);
                    } else if (job.status === 'failed' || job.status === 'unsupported') {
                      log.textContent = 'Live login failed (' + device + ' link): ' + (job.error || job.status) + ' (the background tab was kept open and brought to the front so you can see what happened - close it manually when done)';
                      // Item 9: only second-guess a credential that was
                      // actually matrix-linked to this brand AND where the
                      // failure explicitly looked like a real login
                      // rejection (job.credentialSuspected, set only for that
                      // specific case in resumeLiveLoginJobIfPending) - a
                      // successful login whose LATER network capture merely
                      // timed out is not evidence the credential is wrong,
                      // and an ad-hoc "try anyway" credential failing isn't
                      // evidence against the matrix either.
                      var failedCredId = job.credentialId;
                      var failedStatus = job.status;
                      var failedCredentialSuspected = !!job.credentialSuspected;
                      settled = true;
                      LiveLoginJob.offChange(jobChangeListener);
                      LiveLoginJob.clear();
                      setBtnBusy(false);
                      if (failedStatus === 'failed' && failedCredId && failedCredentialSuspected) {
                        Vault.getById(failedCredId, function (cred) {
                          if (!cred || (cred.brands || []).indexOf(brand) === -1) return;
                          credResolveArea.innerHTML = '';
                          credResolveArea.style.display = '';
                          credResolveArea.appendChild(el('div', { class: 'lgt-hint' }, [
                            'Login with "' + cred.label + '" did not complete for ' + brand + ' - it may be the wrong credential for this brand. What would you like to do?'
                          ]));
                          credResolveArea.appendChild(el('button', {
                            onclick: function () { Vault.remove(cred.id, function () { credResolveArea.style.display = 'none'; }); }
                          }, ['Delete this credential entirely']));
                          credResolveArea.appendChild(el('button', {
                            onclick: function () { Vault.unlinkBrand(cred.id, brand, function () { credResolveArea.style.display = 'none'; refreshCredBadge(); }); }
                          }, ['Unlink just ' + brand + ' (keep other brands)']));
                          credResolveArea.appendChild(el('button', {
                            onclick: function () {
                              credResolveArea.style.display = 'none';
                              if (wrap.__lgtGoToCredentials) wrap.__lgtGoToCredentials();
                            }
                          }, ['Add a new credential for ' + brand]));
                        });
                      }
                    }
                  });
                });

                (function pollTimeout() {
                  if (settled) return;
                  if (Date.now() > deadline) {
                    log.textContent = 'Live login timed out after 60s (' + device + ' link) - check for a leftover background tab.';
                    settled = true;
                    LiveLoginJob.offChange(jobChangeListener);
                    setBtnBusy(false);
                    return;
                  }
                  setTimeout(pollTimeout, 1000);
                })();
              });
            }

            if (forceFreshWanted) {
              startFreshCapture();
              return;
            }
            LiveLoginCache.get(brand, loginEnv, device, function (cached) {
              if (cached) {
                log.textContent = 'Using cached ' + device + ' live-login context (captured ' + Math.round((Date.now() - cached.capturedAt) / 60000) + ' min ago' + (bleSourceWanted ? ', on prod' : '') + ')...';
                onDone(cached.stc, cached.ctx);
                return;
              }
              startFreshCapture('No logged-in test customer for this brand - ');
            });
          }

          var results = { desktop: null, mobile: null };
          (function runNext(index) {
            if (index >= devicesToRun.length) {
              spliceAndRender(
                results.desktop ? results.desktop.stc : null,
                results.desktop ? results.desktop.ctx : null,
                results.mobile ? results.mobile.stc : null,
                results.mobile ? results.mobile.ctx : null,
                bleSourceWanted
              );
              return;
            }
            var device = devicesToRun[index];
            captureForDevice(device, function (stc, ctx) {
              results[device] = { stc: stc, ctx: ctx };
              runNext(index + 1);
            });
          })(0);
        }

        // Items 2/3/12: figure out which saved credential to use for a
        // logged-in live-login generation, prompting the user inline in
        // credResolveArea whenever there's a genuine choice to make
        // (never for the single-match happy path). Calls onResolved(id)
        // exactly once, or never (generation is abandoned) if the vault
        // is empty and the user is sent to the Credentials tab instead.
        function resolveCredentialForLogin(brandKey, onResolved) {
          credResolveArea.innerHTML = '';
          credResolveArea.style.display = 'none';
          Vault.getAll(function (all) {
            if (!all.length) {
              log.textContent = 'No saved credentials yet - switched to the Credentials tab. Add one there, then try Generate again.';
              setBtnBusy(false);
              if (wrap.__lgtGoToCredentials) wrap.__lgtGoToCredentials();
              return;
            }
            Vault.getForBrand(brandKey, function (matches) {
              if (matches.length === 1) { onResolved(matches[0].id); return; }
              if (matches.length > 1) {
                var pickSel = el('select', {}, matches.map(function (c) { return el('option', { value: c.id }, [c.label]); }));
                credResolveArea.appendChild(el('div', { class: 'lgt-hint' }, ['This brand has more than one saved credential linked to it - pick one:']));
                credResolveArea.appendChild(pickSel);
                credResolveArea.appendChild(el('button', {
                  onclick: function () { credResolveArea.style.display = 'none'; onResolved(pickSel.value); }
                }, ['Use this credential']));
                credResolveArea.style.display = '';
                setBtnBusy(false);
                return;
              }
              // Item 3: no credential matrix-linked to this brand yet.
              credResolveArea.appendChild(el('div', { class: 'lgt-hint' }, [
                'No saved credential is linked to "' + brandKey + '" yet. Try an existing one anyway, or add a new one for this brand:'
              ]));
              var trySel = el('select', {}, all.map(function (c) { return el('option', { value: c.id }, [c.label]); }));
              credResolveArea.appendChild(trySel);
              credResolveArea.appendChild(el('button', {
                onclick: function () { credResolveArea.style.display = 'none'; onResolved(trySel.value); }
              }, ['Try selected credential anyway']));
              var newLabel = el('input', { type: 'text', placeholder: 'Label (optional)' });
              var newUser = el('input', { type: 'text', placeholder: 'Username' });
              var newPass = el('input', { type: 'password', placeholder: 'Password' });
              credResolveArea.appendChild(el('div', {}, [newLabel, newUser, newPass]));
              credResolveArea.appendChild(el('button', {
                onclick: function () {
                  if (!newUser.value || !newPass.value) return;
                  Vault.save(newLabel.value || brandKey, newUser.value, newPass.value, [brandKey], function (list) {
                    credResolveArea.style.display = 'none';
                    onResolved(list[list.length - 1].id);
                  });
                }
              }, ['Save & use a new credential for ' + brandKey]));
              credResolveArea.style.display = '';
              setBtnBusy(false);
            });
          });
        }

        if (!loggedIn) {
          // Logged-out (with or without BLE) - unchanged path, BLE is
          // handled entirely inside generateLink() via the static
          // registry, no live-login involved either way.
          generateLink({ brand: brand, environment: environment, loggedIn: false, customerKeyFilter: selectedCustomerKeyFilter(), bleSource: bleSource })
            .then(renderLinks)
            .catch(function (err) {
              log.textContent = 'Error: ' + friendlyErrorMessage(err);
              setBtnBusy(false);
              if (err && err.isVpnRequired) showVpnRequiredPopup(err.message, attempt);
            });
          return;
        }

        // Logged-in, with or without BLE: check upfront whether the
        // brand has a real logged-in test customer key (works for 4/34
        // brands) on whichever API host generateLink() would actually
        // use (prod when BLE is requested, same as its own apiEnv rule)
        // rather than sniffing generateLink()'s error string. If it
        // does, use the normal static-registry path unchanged (BLE
        // query/host rewriting included); if not, only brands with known
        // login/Sportsbook-nav selectors can fall back to live-login -
        // everyone else keeps today's error behavior. BLE no longer
        // bypasses this check on its own - previously "logged-in + BLE"
        // for a brand with no logged-in key would go straight to
        // generateLink() and fail immediately instead of falling back to
        // live-login like the non-BLE case already did.
        hasLoggedInCustomerKey(brand, bleSource ? 'prod' : environment).then(function (hasKey) {
          if (hasKey) {
            generateLink({ brand: brand, environment: environment, loggedIn: true, customerKeyFilter: selectedCustomerKeyFilter(), bleSource: bleSource })
              .then(renderLinks)
              .catch(function (err) {
                log.textContent = 'Error: ' + friendlyErrorMessage(err);
                setBtnBusy(false);
                if (err && err.isVpnRequired) showVpnRequiredPopup(err.message, attempt);
              });
            return;
          }
          // Item 14: brands with no plain user/pass login (BankID, MitID,
          // etc.) can never succeed at automatic live-login - short-circuit
          // with an explicit confirm instead of silently attempting (and
          // failing) it. Checked BEFORE the LOGIN_SELECTORS gate below,
          // since these brands deliberately have NO entry there at all
          // (there is no selector-based flow to fall back to for them).
          if (SPECIAL_AUTH_BRANDS[brand]) {
            setBtnBusy(false);
            var loginEnvForManual = bleSource ? 'prod' : environment;
            var openManually = confirm(
              'This brand requires manual login (' + SPECIAL_AUTH_BRANDS[brand] + ') - no automatic sign-in is available.\n\n' +
              'Open the brand site now so you can sign in by hand?'
            );
            if (openManually) {
              var manualUrl = realBrandOrigin(brand, loginEnvForManual);
              if (manualUrl) window.open(manualUrl, '_blank');
            }
            log.textContent = 'Manual login required for this brand (' + SPECIAL_AUTH_BRANDS[brand] + ') - automatic generation was skipped.';
            return;
          }
          var sel = LOGIN_SELECTORS[brand];
          if (!sel || !sel.sportsbookNavPattern) {
            log.textContent = 'Error: No customer key matched prefix "logged-in" for this brand, and it is not live-login-capable (no login/Sportsbook-nav selectors known).';
            setBtnBusy(false);
            return;
          }
          resolveCredentialForLogin(brand, function (credentialId) {
            runLiveLoginFallback(bleSource, forceFresh, credentialId, devices);
          });
        }).catch(function (err) {
          log.textContent = 'Error: ' + friendlyErrorMessage(err);
          setBtnBusy(false);
          if (err && err.isVpnRequired) showVpnRequiredPopup(err.message, attempt);
        });
      };
    }

    var btn = el('button', {}, ['Generate']);
    var desktopBtn = el('button', {}, ['Generate Desktop']);
    var mobileBtn = el('button', {}, ['Generate Mobile']);
    btn.addEventListener('click', runGenerateFlow(['desktop', 'mobile'], btn, 'Generate'));
    desktopBtn.addEventListener('click', runGenerateFlow(['desktop'], desktopBtn, 'Generate Desktop'));
    mobileBtn.addEventListener('click', runGenerateFlow(['mobile'], mobileBtn, 'Generate Mobile'));

    // Split-button container: swapped between [btn] (single "Generate",
    // today's default) and [desktopBtn, mobileBtn] (side by side) by
    // refreshGenerateButtonMode() below, depending on whether the CURRENT
    // brand/environment/login-state/BLE selection would actually hit the
    // live-login fallback (the only case where doing one device instead
    // of both saves real time).
    var genBtnRow = el('div', { class: 'lgt-row' }, [btn]);

    // Decides single vs split button mode. Mirrors the exact same
    // decision chain runGenerateFlow's click handler evaluates for real
    // (hasLoggedInCustomerKey -> SPECIAL_AUTH_BRANDS -> LOGIN_SELECTORS),
    // so the buttons shown always match what a click would actually do.
    // Guarded with an incrementing token (same pattern as
    // refreshCustomerOptions's customerFetchToken) against a stale async
    // result landing after a further, faster selection change; skipped
    // entirely while a generation is in flight so the row doesn't swap
    // out from under an active click.
    var genModeToken = 0;
    function applyGenButtonMode(wantSplit) {
      genBtnRow.innerHTML = '';
      if (wantSplit) {
        genBtnRow.appendChild(desktopBtn);
        genBtnRow.appendChild(mobileBtn);
      } else {
        genBtnRow.appendChild(btn);
      }
    }
    function refreshGenerateButtonMode() {
      if (generationInProgress) return;
      var brand = brandSel.value;
      var environment = envSel.value;
      var loggedIn = loginSel.value === 'in';
      var bleSource = bleChk.checked;
      var token = ++genModeToken;
      if (!loggedIn) { applyGenButtonMode(false); return; }
      hasLoggedInCustomerKey(brand, bleSource ? 'prod' : environment).then(function (hasKey) {
        if (token !== genModeToken) return; // superseded by a newer selection
        if (hasKey || SPECIAL_AUTH_BRANDS[brand]) { applyGenButtonMode(false); return; }
        var sel = LOGIN_SELECTORS[brand];
        applyGenButtonMode(!!(sel && sel.sportsbookNavPattern));
      }).catch(function () {
        if (token !== genModeToken) return;
        applyGenButtonMode(false);
      });
    }
    brandSel.addEventListener('change', refreshGenerateButtonMode);
    envSel.addEventListener('change', refreshGenerateButtonMode);
    loginSel.addEventListener('change', refreshGenerateButtonMode);
    bleChk.addEventListener('change', refreshGenerateButtonMode);

    // Item 15: small badge next to Login state showing at a glance
    // whether the currently selected brand already has a saved
    // credential linked in the matrix (or needs manual login entirely).
    var credBadge = el('span', { class: 'lgt-cred-badge', style: 'display:none' }, ['']);
    function refreshCredBadge() {
      var b = brandSel.value;
      if (loginSel.value !== 'in') { credBadge.style.display = 'none'; return; }
      credBadge.style.display = '';
      if (SPECIAL_AUTH_BRANDS[b]) {
        credBadge.className = 'lgt-cred-badge none';
        credBadge.textContent = 'Manual login only';
        return;
      }
      Vault.getForBrand(b, function (matches) {
        if (brandSel.value !== b) return; // stale response, brand changed since
        credBadge.className = 'lgt-cred-badge ' + (matches.length ? 'has' : 'none');
        credBadge.textContent = matches.length ? (matches.length + ' credential' + (matches.length > 1 ? 's' : '') + ' linked') : 'No credential linked yet';
      });
    }
    brandSel.addEventListener('change', refreshCredBadge);
    loginSel.addEventListener('change', refreshCredBadge);
    refreshCredBadge();

    wrap.appendChild(el('label', {}, ['Brand']));
    wrap.appendChild(brandSel);
    wrap.appendChild(el('div', { class: 'lgt-row' }, [
      (function () { var d = el('div', {}); d.appendChild(el('label', {}, ['Environment'])); d.appendChild(envSel); return d; })(),
      (function () { var d = el('div', {}); d.appendChild(el('label', {}, ['Login state'])); d.appendChild(loginSel); d.appendChild(credBadge); return d; })()
    ]));
    wrap.appendChild(customerWrap);
    var bleWrap = el('label', { class: 'lgt-checkbox-row' }, [bleChk, ' BLE source (fresh live events on test/qa)']);
    wrap.appendChild(bleWrap);
    var forceFreshWrap = el('label', { class: 'lgt-checkbox-row' }, [forceFreshChk, ' Force fresh live-login (skip 30-min cache; logged-in only, when no test customer exists)']);
    wrap.appendChild(forceFreshWrap);
    var forceVisibleWrap = el('label', { class: 'lgt-checkbox-row' }, [forceVisibleChk, ' Show login tab (force visible; overrides the remembered silent default for this brand)']);
    wrap.appendChild(forceVisibleWrap);
    var srSpoofChk = el('input', { type: 'checkbox' });
    srSpoofChk.checked = srSpoofSettingCache;
    srSpoofChkRef = srSpoofChk;
    srSpoofChk.addEventListener('change', function () {
      srSpoofSettingCache = srSpoofChk.checked;
      var obj = {};
      obj[SR_SPOOF_SETTING_KEY] = srSpoofSettingCache;
      chrome.storage.local.set(obj);
    });
    var srSpoofWrap = el('label', { class: 'lgt-checkbox-row' }, [srSpoofChk, ' Sportradar Statistics fix (auto-applies on any matching page load/reload, no click needed; spoofs Origin/Referer + CORS so licensed widgets render)']);
    wrap.appendChild(srSpoofWrap);
    wrap.appendChild(genBtnRow);
    wrap.appendChild(credResolveArea);
    wrap.appendChild(log);
    wrap.appendChild(result);
    refreshGenerateButtonMode();
    return wrap;
  }

  function renderLinkRow(label, link, brand, environment) {
    var row = el('div', { style: 'margin-bottom:6px' });
    row.appendChild(el('div', { style: 'color:var(--lgt-muted)' }, [label]));
    var linkText = el('div', {}, [link || '(not available)']);
    row.appendChild(linkText);
    if (link) {
      var btnRow = el('div', { class: 'lgt-row' });
      btnRow.appendChild(el('button', {
        class: 'secondary', style: 'margin-top:6px', onclick: function () {
          navigator.clipboard.writeText(link);
        }
      }, ['Copy ' + label]));
      btnRow.appendChild(el('button', {
        class: 'secondary', style: 'margin-top:6px', onclick: function () {
          window.open(link, '_blank');
        }
      }, ['Open']));
      row.appendChild(btnRow);
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
    var copyBtn = el('button', { class: 'secondary', style: 'display:none' }, ['Copy stc/ctx (paste-ready)']);
    var builtForKey = null; // 'stc|ctx' already rendered, so a repeat
    // Capture.onCapture notification (e.g. a second sb/fe-api call landing
    // with the same headers) doesn't keep re-fetching/re-rendering.

    function renderStatus(c) {
      if (c.stc && c.ctx) {
        status.textContent = 'Captured! stc=' + c.stc + ' ctx=' + c.ctx;
        copyBtn.style.display = '';
        copyBtn.onclick = function () {
          navigator.clipboard.writeText(c.stc + '/' + c.ctx);
        };
        var thisKey = c.stc + '|' + c.ctx;
        if (thisKey !== builtForKey) {
          builtForKey = thisKey;
          buildFinalLink(c);
        }
      } else if ((c.seenCount || 0) > 0) {
        status.textContent = 'Passive capture running - ' + c.seenCount + ' sb/fe-api call(s) observed, none with both headers yet.';
        copyBtn.style.display = 'none';
      }
    }

    // Builds and renders the final link automatically the moment both
    // headers are captured - no manual "Build final link" click needed,
    // since passive capture (Capture/chrome.webRequest) already runs
    // continuously and unconditionally in the background.
    function buildFinalLink(c) {
      if (!detected.brand) { status.textContent = status.textContent + ' (brand not recognized - cannot build base link automatically)'; return; }
      generateLink({ brand: detected.brand, environment: detected.environment, loggedIn: false }).then(function (links) {
        result.style.display = '';
        result.innerHTML = '';
        result.appendChild(renderLinkRow('Desktop', spliceContext(links.desktop, c.stc, c.ctx), detected.brand, detected.environment));
        result.appendChild(renderLinkRow('Mobile', spliceContext(links.mobile, c.stc, c.ctx), detected.brand, detected.environment));
        result.appendChild(renderLinkRow('Brand page', realBrandOrigin(detected.brand, detected.environment), detected.brand, detected.environment));
      }).catch(function (err) {
        status.textContent = 'Error building final link: ' + friendlyErrorMessage(err);
        if (err && err.isVpnRequired) showVpnRequiredPopup(err.message, function () { buildFinalLink(c); });
      });
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

    // Items 2/3/7/9/12/14: brand/matrix-aware auto-login. `wrap.__lgtGoToCredentials`
    // is wired up by buildPanel() right after all three tab bodies exist,
    // so this button can jump the whole panel to the Credentials tab
    // without needing to build that dependency itself.
    var pickerArea = el('div', {});

    function doLogin(cred) {
      pickerArea.innerHTML = '';
      status.textContent = 'Logging in with "' + cred.label + '"...';
      attemptAutoLogin(detected.brand, cred.username, cred.password, function (m) { status.textContent = m; }).then(function (ok) {
        // Item 9: only second-guess a credential that was actually
        // matrix-linked to this brand - one used via "try anyway" failing
        // isn't evidence the matrix is wrong, just that the guess was bad.
        if (ok || (cred.brands || []).indexOf(detected.brand) === -1) return;
        renderFailurePrompt(cred);
      });
    }

    function renderFailurePrompt(cred) {
      pickerArea.innerHTML = '';
      pickerArea.appendChild(el('div', { class: 'lgt-log' }, ['Auto-login/capture with "' + cred.label + '" did not complete for ' + detected.brand + ' - it may be the wrong credential for this brand. What would you like to do?']));
      pickerArea.appendChild(el('button', { class: 'secondary', onclick: function () {
        Vault.remove(cred.id, function () { pickerArea.innerHTML = ''; status.textContent = 'Credential deleted.'; });
      } }, ['Delete this credential entirely']));
      pickerArea.appendChild(el('button', { class: 'secondary', onclick: function () {
        Vault.unlinkBrand(cred.id, detected.brand, function () { pickerArea.innerHTML = ''; status.textContent = 'Unlinked ' + detected.brand + ' from "' + cred.label + '" - its other brand links are unchanged.'; });
      } }, ['Unlink just ' + detected.brand + ' (keep other brands)']));
      pickerArea.appendChild(el('button', {
        onclick: function () {
          pickerArea.innerHTML = '';
          if (wrap.__lgtGoToCredentials) wrap.__lgtGoToCredentials();
          status.textContent = 'Add a new credential for ' + detected.brand + ' in the Credentials tab.';
        }
      }, ['Add a new credential for ' + detected.brand]));
    }

    function renderCredentialPicker(matches) {
      pickerArea.innerHTML = '';
      var sel = el('select', {}, matches.map(function (c) { return el('option', { value: c.id }, [c.label]); }));
      pickerArea.appendChild(el('label', {}, ['Multiple saved credentials are linked to ' + detected.brand + ' - pick one:']));
      pickerArea.appendChild(sel);
      pickerArea.appendChild(el('button', {
        onclick: function () {
          var chosen = matches.find(function (c) { return c.id === sel.value; });
          if (chosen) doLogin(chosen);
        }
      }, ['Login with selected']));
    }

    function renderNoMatchPrompt(allCreds) {
      pickerArea.innerHTML = '';
      pickerArea.appendChild(el('div', { class: 'lgt-log' }, ['No saved credential is linked to ' + detected.brand + ' yet.']));
      var sel = el('select', {}, allCreds.map(function (c) { return el('option', { value: c.id }, [c.label]); }));
      pickerArea.appendChild(sel);
      pickerArea.appendChild(el('button', { class: 'secondary', onclick: function () {
        var chosen = allCreds.find(function (c) { return c.id === sel.value; });
        if (chosen) doLogin(chosen);
      } }, ['Try selected credential anyway']));
      // Item 7's "ask for one and save it" path - inline, no tab switch
      // needed, and the new credential is saved already linked to this
      // brand so it shows up directly in the matrix/dropdown next time.
      var newLabel = el('input', { type: 'text', placeholder: 'Label (e.g. "shared QA user")' });
      var newUser = el('input', { type: 'text', placeholder: 'Username' });
      var newPass = el('input', { type: 'password', placeholder: 'Password' });
      pickerArea.appendChild(el('label', {}, ['...or add a new credential for ' + detected.brand + ' now:']));
      pickerArea.appendChild(newLabel);
      pickerArea.appendChild(newUser);
      pickerArea.appendChild(newPass);
      pickerArea.appendChild(el('button', {
        onclick: function () {
          if (!newUser.value || !newPass.value) return;
          Vault.save(newLabel.value || newUser.value, newUser.value, newPass.value, [detected.brand], function (list) {
            doLogin(list[list.length - 1]);
          });
        }
      }, ['Save & login']));
    }

    var autoBtn = el('button', {
      onclick: function () {
        pickerArea.innerHTML = '';
        if (!detected.brand) { status.textContent = 'Brand not recognized from this hostname - log in manually.'; return; }
        if (SPECIAL_AUTH_BRANDS[detected.brand]) {
          status.textContent = 'This brand requires manual login (' + SPECIAL_AUTH_BRANDS[detected.brand] + ') - no automatic sign-in is possible. Please log in by hand; passive capture will still pick up the session once you do.';
          return;
        }
        Vault.getAll(function (all) {
          if (!all.length) {
            // Item 2: fresh install, nothing saved at all yet.
            status.textContent = 'No saved credentials yet - jumping to the Credentials tab so you can add one, then come back and try Auto-login again.';
            if (wrap.__lgtGoToCredentials) wrap.__lgtGoToCredentials();
            return;
          }
          Vault.getForBrand(detected.brand, function (matches) {
            if (matches.length === 1) doLogin(matches[0]);
            else if (matches.length > 1) renderCredentialPicker(matches);
            else renderNoMatchPrompt(all); // item 3
          });
        });
      }
    }, ['Auto-login']);
    wrap.__lgtAutoLoginBtn = autoBtn;

    wrap.appendChild(info);
    wrap.appendChild(autoBtn);
    wrap.appendChild(pickerArea);
    wrap.appendChild(status);
    wrap.appendChild(copyBtn);
    wrap.appendChild(result);
    return wrap;
  }

  function buildModeC() {
    var wrap = el('div', {});
    var list = el('div', {});
    var labelIn = el('input', { type: 'text', placeholder: 'Label (e.g. "shared QA user")' });
    var userIn = el('input', { type: 'text', placeholder: 'Username' });
    var passIn = el('input', { type: 'password', placeholder: 'Password' });
    var newBrandMatrixLabel = el('label', {}, ['Applies to brands (optional - check all that this login works for)']);
    var newBrandMatrix = buildBrandMatrix([]);

    function render(creds) {
      list.innerHTML = '';
      if (!creds.length) { list.appendChild(el('div', { class: 'lgt-log' }, ['No saved credentials yet.'])); return; }
      creds.forEach(function (c) {
        var row = el('div', { class: 'lgt-cred' + (c.isDefault ? ' default' : ''), style: 'flex-direction:column;align-items:stretch' });
        var top = el('div', { style: 'display:flex;justify-content:space-between;align-items:center' });
        top.appendChild(el('div', {}, [c.label + (c.isDefault ? ' (default)' : '')]));
        var actions = el('div', { class: 'lgt-cred-actions' });
        if (!c.isDefault) {
          actions.appendChild(el('button', { onclick: function () { Vault.setDefault(c.id, render); } }, ['Set default']));
        }
        var brandsPanel = el('div', { style: 'display:none' });
        var brandsBtn = el('button', {
          onclick: function () {
            brandsPanel.style.display = brandsPanel.style.display === 'none' ? '' : 'none';
          }
        }, ['Brands']);
        actions.appendChild(brandsBtn);
        actions.appendChild(el('button', { onclick: function () { Vault.remove(c.id, render); } }, ['Delete']));
        top.appendChild(actions);
        row.appendChild(top);
        row.appendChild(el('div', { class: 'lgt-cred-brands' }, [
          (c.brands && c.brands.length) ? ('Brands: ' + c.brands.join(', ')) : 'Not linked to any brand yet - won\'t be offered automatically anywhere.'
        ]));
        var matrix = buildBrandMatrix(c.brands || []);
        var applyBtn = el('button', {
          onclick: function () {
            Vault.setBrands(c.id, matrix.__lgtGetSelected(), render);
          }
        }, ['Save brands']);
        brandsPanel.appendChild(matrix);
        brandsPanel.appendChild(applyBtn);
        row.appendChild(brandsPanel);
        list.appendChild(row);
      });
    }

    Vault.getAll(render);

    var addBtn = el('button', {
      onclick: function () {
        if (!userIn.value || !passIn.value) return;
        Vault.save(labelIn.value || userIn.value, userIn.value, passIn.value, newBrandMatrix.__lgtGetSelected(), render);
        labelIn.value = ''; userIn.value = ''; passIn.value = '';
        // Rebuild a fresh (all-unchecked) matrix for the next credential
        // instead of leaving the just-submitted selections checked.
        var freshMatrix = buildBrandMatrix([]);
        newBrandMatrix.parentNode.replaceChild(freshMatrix, newBrandMatrix);
        newBrandMatrix = freshMatrix;
      }
    }, ['Save credential']);

    wrap.appendChild(labelIn);
    wrap.appendChild(userIn);
    wrap.appendChild(passIn);
    wrap.appendChild(newBrandMatrixLabel);
    wrap.appendChild(newBrandMatrix);
    wrap.appendChild(addBtn);
    wrap.appendChild(el('label', {}, ['Saved credentials']));
    wrap.appendChild(list);
    wrap.__lgtCredList = list;
    return wrap;
  }

  // Persists the Bundle tab's own form controls (brand / current
  // environment), same rationale as GEN_STATE_KEY above - a page reload
  // rebuilds the whole panel from scratch and shouldn't reset these.
  var BUNDLE_STATE_KEY = 'lgt-bundle-state-v1';

  function saveBundleState(partial) {
    chrome.storage.local.get([BUNDLE_STATE_KEY], function (res) {
      var state = Object.assign({}, res && res[BUNDLE_STATE_KEY], partial);
      var obj = {};
      obj[BUNDLE_STATE_KEY] = state;
      chrome.storage.local.set(obj);
    });
  }

  // "Detected build" strip - always visible above the tabs, regardless of
  // which tab is active. Answers "what environment/version is THIS page's
  // sportsbook bundle actually loaded from?" from the one source that
  // cannot be wrong: the real network request the browser already made
  // (see background.js's bundleObservedByTab / lgt-bundle-observed). This
  // is deliberately independent of the Bundle tab above - it works
  // whether or not an override was ever applied, and is meant to replace
  // relying on the separate "Sportsbook Tool" bookmarklet's own "SB
  // Version" field or manually checking the DevTools Network tab.
  function buildDetectedBuildStrip() {
    var wrap = el('div', { class: 'lgt-build-strip' });
    var row = el('div', { class: 'lgt-build-row' });
    var label = el('span', {}, ['Detecting sportsbook bundle\u2026']);
    var badge = el('span', { class: 'lgt-build-badge', style: 'display:none' }, ['']);
    var verifyBtn = el('button', { class: 'secondary', title: 'Double-check against window.xSbState (requires exposeObgState=true)' }, ['Verify with page state']);
    var actions = el('div', { class: 'lgt-build-actions' }, [verifyBtn]);
    row.appendChild(label);
    row.appendChild(badge);
    row.appendChild(actions);
    var verifyResult = el('div', { class: 'lgt-build-verify', style: 'display:none' }, ['']);
    wrap.appendChild(row);
    wrap.appendChild(verifyResult);

    var lastObserved = null;

    function refresh() {
      chrome.runtime.sendMessage({ type: 'lgt-bundle-observed' }, function (res) {
        void chrome.runtime.lastError;
        if (!res || !res.ok) return;
        var o = res.observed;
        lastObserved = o;
        if (!o) {
          label.textContent = 'No sportsbook bundle detected on this tab yet.';
          badge.style.display = 'none';
          return;
        }
        var pageEnv = (detectBrandAndEnv().environment || 'prod');
        // Use hostEnv (which HOST actually served this file), not the
        // internal /dist/<label>/ path segment - confirmed live
        // 2026-08-10 that a brand's own TEST site can serve its bundle
        // from a path literally labeled "qa" with no override applied
        // (TEST/QA share one underlying BLE-layer build artifact
        // folder), so the path label alone is not a trustworthy
        // "which environment" answer. The request's own hostname is:
        // on a native load it's the same host as the page itself
        // (hostEnv === pageEnv), on an active override it's a
        // different env's CDN host entirely.
        var mismatch = o.hostEnv !== pageEnv;
        // Sandbox-shape links (the tool's own standalone "Generate" tab
        // output) carry no version/device in the bundle URL at all - see
        // BUNDLE_OBSERVE_SANDBOX_RE in background.js. Show what we DO
        // know (env) rather than a misleading "vundefined (undefined)".
        if (o.shape === 'sandbox') {
          // 2026-08-10: the URL itself never carries version/device for
          // this shape, but background.js may have asynchronously
          // resolved the version (and, when unambiguous, the device) via
          // an indexer.json reverse-lookup against the observed chunk
          // filenames (the sandbox page's OWN main-*.js is a different
          // build artifact than the widget's federated entry point, so
          // it rarely matches - the shared chunk-*.js files are what
          // actually resolve, confirmed live 2026-08-10). A brand's
          // desktop/mobile versions are the same build in the
          // overwhelming majority of cases even when the specific device
          // can't be pinned down (a shared chunk matches both) - so show
          // the version alone when device is unresolved, rather than
          // discarding a real, useful answer. Only fall back to the
          // honest "not encoded in URL" message when nothing resolved at
          // all.
          // Show the actual detected brand (e.g. "nordicbet") instead of
          // the generic literal word "sandbox" - background.js already
          // resolves this from the sandbox link's own hostname (see
          // detectBrandAndEnvFromPlaygroundHost) and always includes it
          // on the observation object for this shape; "sandbox" remains
          // only as a defensive fallback in the unlikely case it's ever
          // missing.
          var sandboxLabel = o.brand || 'sandbox';
          if (o.version) {
            label.textContent = 'SB build: v' + o.version + (o.device ? ' (' + o.device + ')' : '') + ' [' + sandboxLabel + ', ' + o.hostEnv.toUpperCase() + ']' + (mismatch ? ' \u2013 overridden from ' + pageEnv.toUpperCase() : '');
          } else {
            label.textContent = 'SB build: ' + o.hostEnv.toUpperCase() + ' (' + sandboxLabel + ' sandbox link \u2013 version/device not encoded in URL)' + (mismatch ? ' \u2013 overridden from ' + pageEnv.toUpperCase() : '');
          }
        } else {
          label.textContent = 'SB build: v' + o.version + ' (' + o.device + ')' + (mismatch ? ' \u2013 overridden from ' + pageEnv.toUpperCase() : '');
        }
        badge.textContent = o.hostEnv.toUpperCase();
        badge.className = 'lgt-build-badge ' + (mismatch ? 'mismatch' : 'match');
        badge.style.display = '';
        badge.title = o.url;
      });
    }
    pollWhileExtensionValid(refresh, 3000);

    // Secondary, on-demand confirmation via window.xSbState - only
    // meaningful on a link carrying exposeObgState=true.
    //
    // REWRITTEN 2026-08-10: the previous implementation injected a plain
    // <script> tag to read window.xSbState from the page's own (MAIN
    // world) context, since a content script's isolated world cannot
    // read the page's own JS variables directly - but that technique IS
    // a DOM script element, so it's subject to the page's own script-src
    // CSP. Confirmed live on a real sandbox link (strict CSP, no
    // 'unsafe-inline') that this silently blocked the injected script
    // every time, which is why the button always ended up showing the
    // "No response after 5s" timeout message - NOT a rare edge case, but
    // the normal outcome on any CSP-hardened page. Now delegates to
    // background.js's chrome.scripting.executeScript({world:'MAIN'})
    // (see its lgt-verify-xsbstate handler), which runs in the page's
    // real JS context WITHOUT being subject to page CSP at all - no more
    // <script> tag, postMessage roundtrip, or securitypolicyviolation
    // heuristic needed. A short client-side timeout remains only as a
    // defensive fallback in case the service worker itself is ever slow
    // to respond.
    verifyBtn.addEventListener('click', function () {
      if (location.search.indexOf('exposeObgState=true') === -1) {
        verifyResult.style.display = '';
        verifyResult.textContent = 'Add exposeObgState=true to the URL to enable this check (window.xSbState is not exposed otherwise).';
        return;
      }
      verifyResult.style.display = '';
      verifyResult.textContent = 'Checking window.xSbState\u2026';
      var settled = false;
      var timeoutId = setTimeout(function () {
        if (settled) return;
        settled = true;
        verifyResult.textContent = 'No response from the background script after 5s \u2013 this should not normally happen; try reloading the extension.';
      }, 5000);

      chrome.runtime.sendMessage({ type: 'lgt-verify-xsbstate' }, function (d) {
        void chrome.runtime.lastError;
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (!d || !d.ok) { verifyResult.textContent = 'xSbState check failed: ' + ((d && d.error) || 'no response'); return; }
        if (!d.hasState) { verifyResult.textContent = 'window.xSbState is not present on this page.'; return; }
        if (d.version || d.environment) {
          var lines = ['xSbState: version=' + (d.version || '?') + ' environment=' + (d.environment || '?')];
          if (lastObserved && lastObserved.version && d.version && String(d.version).indexOf(lastObserved.version) === -1 && lastObserved.version.indexOf(String(d.version)) === -1) {
            lines.push('\u26a0 does not match the network-detected version (' + lastObserved.version + ')');
          } else if (lastObserved && lastObserved.version && d.version) {
            lines.push('\u2713 matches the network-detected version');
          }
          verifyResult.textContent = lines.join('\n');
        } else {
          verifyResult.textContent = 'xSbState present but no known version/environment field found. Top-level keys: ' + d.keys.join(', ');
        }
      });
    });

    return wrap;
  }

  // "Bundle" tab - overrides this brand's sportsbook JS bundle (main-*.js)
  // on THIS tab to run a different, same-layer environment's build
  // (QA<->TEST or ALPHA<->PROD), via background.js's
  // lgt-bundle-start/stop/status messages (see background.js's "Bundle
  // override" section for the actual declarativeNetRequest mechanism).
  // Deliberately independent of the Generate tab per user decision - the
  // user applies this manually to whichever tab the panel happens to be
  // open in, it never auto-applies to a newly generated/opened link.
  function buildModeD() {
    var wrap = el('div', {});
    var detected = detectBrandAndEnv();

    var brandSel = el('select', {}, brandOptions(detected.brand || undefined));
    var curEnvSel = el('select', {}, ENV_LABELS.map(function (e) { return el('option', { value: e }, [e]); }));
    if (detected.environment) curEnvSel.value = detected.environment;

    var targetEnvBadge = el('div', { class: 'lgt-hint' }, ['']);
    function refreshTargetEnv() {
      var partner = bundleLayerPartner(curEnvSel.value);
      targetEnvBadge.textContent = partner
        ? ('Target build: ' + partner.toUpperCase() + ' (same layer as ' + curEnvSel.value.toUpperCase() + ')')
        : 'Unknown layer for this environment.';
      return partner;
    }

    var status = el('div', { class: 'lgt-log' }, ['Not active on this tab.']);

    // Bundle Override only works when the sportsbook widget is loaded via
    // the real dist-shape URL (a brand embedding the widget through
    // Module Federation - real brand domains, or an iframe test host that
    // embeds the widget the same way). It CANNOT work on the tool's own
    // standalone "Generate" tab sandbox links (d-cf.<env>.<brand>playground.net/...):
    // those serve a single monolithic app bundle with no separate,
    // overridable widget component - a 2026-08-10 attempt to also support
    // them by redirecting that bundle to indexer.json's widget-only file
    // produced a confirmed, silent blank page (no console error, no
    // failed request - the browser just runs the wrong bundle as the
    // page's own entry script and nothing ever mounts). Rather than leave
    // that half-broken, the tool now detects this case up front and warns
    // instead of letting the user hit a blank page.
    var sandboxWarning = el('div', { class: 'lgt-hint', style: 'color:#e2a03f;margin-top:6px;display:none' }, [
      '\u26a0 This tab looks like one of the tool\u2019s own standalone sandbox ' +
      'links, not a real embedded brand page. Bundle Override cannot work ' +
      'here - the sandbox link is a single monolithic app bundle, not a ' +
      'separately-overridable widget, and overriding it produces a blank ' +
      'page. Open the brand\u2019s real domain instead (see the "Brand page" ' +
      'link on the Generate tab) and apply the override there.'
    ]);
    var applyDisabledBySandboxGuard = !!detected.isSandboxHost;
    if (applyDisabledBySandboxGuard) sandboxWarning.style.display = '';

    function refreshStatus() {
      chrome.runtime.sendMessage({ type: 'lgt-bundle-status' }, function (res) {
        void chrome.runtime.lastError;
        if (!res || !res.ok) return;
        status.textContent = res.active
          ? ('Active (' + res.ruleCount + ' rule(s)) - ' + res.matched.length + ' request(s) redirected so far.')
          : 'Not active on this tab.';
      });
    }
    pollWhileExtensionValid(refreshStatus, 3000);

    var applyBtn = el('button', {
      onclick: function () {
        if (applyDisabledBySandboxGuard) { status.textContent = 'Blocked: this tab is a standalone sandbox link (see warning above).'; return; }
        var brand = brandSel.value;
        var brandGuid = BRANDS[brand];
        var targetEnv = refreshTargetEnv();
        if (!brandGuid) { status.textContent = 'Unknown brand.'; return; }
        if (!targetEnv) { status.textContent = 'Could not determine a same-layer target environment.'; return; }
        status.textContent = 'Applying...';
        chrome.runtime.sendMessage({ type: 'lgt-bundle-start', targetEnv: targetEnv, brandId: brandGuid }, function (res) {
          void chrome.runtime.lastError;
          if (!res || !res.ok) { status.textContent = 'Failed: ' + ((res && res.error) || 'unknown error'); return; }
          status.textContent = 'Active (' + res.ruleCount + ' rule(s) applied) - reload the page if it was already loaded.';
        });
      }
    }, ['Apply']);

    var disableBtn = el('button', {
      onclick: function () {
        chrome.runtime.sendMessage({ type: 'lgt-bundle-stop' }, function () {
          void chrome.runtime.lastError;
          status.textContent = 'Not active on this tab.';
        });
      }
    }, ['Disable']);

    brandSel.addEventListener('change', function () { saveBundleState({ brand: brandSel.value }); });
    // Environment is intentionally never persisted - see the restore
    // comment below for why (it must always reflect the live page, not a
    // remembered value from a different tab/environment).
    curEnvSel.addEventListener('change', function () { refreshTargetEnv(); });

    wrap.appendChild(el('label', {}, ['Brand']));
    wrap.appendChild(brandSel);
    wrap.appendChild(el('label', {}, ['Current environment (what this tab is actually on)']));
    wrap.appendChild(curEnvSel);
    wrap.appendChild(targetEnvBadge);
    wrap.appendChild(sandboxWarning);
    wrap.appendChild(el('div', { style: 'display:flex;gap:6px;margin-top:6px' }, [applyBtn, disableBtn]));
    wrap.appendChild(status);
    wrap.appendChild(el('div', { class: 'lgt-hint', style: 'margin-top:8px' }, [
      'Redirects this brand\u2019s sportsbook bundle (main-*.js) on THIS tab ' +
      'to the other environment in the same layer (QA\u2194TEST or ' +
      'ALPHA\u2194PROD). Only works within the same layer - mixing layers ' +
      'loads a broken build with no error. Only works on a page where the ' +
      'sportsbook widget is embedded in a real brand page (real brand ' +
      'domain, or an iframe test host embedding it the same way) - NOT on ' +
      'the tool\u2019s own standalone "Generate" tab sandbox links (see ' +
      'warning above if detected). Reload the page after Apply if it was ' +
      'already open. Avoid running the standalone "Sportsbook Bundle ' +
      'Override Tool" extension at the same time in the same tab.'
    ]));

    chrome.storage.local.get([BUNDLE_STATE_KEY], function (res) {
      var saved = res && res[BUNDLE_STATE_KEY];
      // Only restore the remembered BRAND (a genuine cross-page preference).
      // The environment must NEVER be restored from a previous page's saved
      // value - it means "what THIS tab is actually on", so it has to keep
      // reflecting detectBrandAndEnv()'s live, host-based result for the
      // current page. Restoring a stale saved environment here was the bug
      // reported 2026-08-10: on a real QA page the dropdown kept showing a
      // leftover "test" from an earlier tab, which made Apply compute QA as
      // the "other" target - i.e. redirect QA to QA, a silent no-op that
      // looked identical whether Apply/Disable was clicked.
      if (saved && saved.brand && BRANDS[saved.brand]) brandSel.value = saved.brand;
      refreshTargetEnv();
    });

    return wrap;
  }

  // Persists the BLE Data tab's own form controls (brand / device /
  // logged-in), same rationale as BUNDLE_STATE_KEY above.
  var BLE_DATA_STATE_KEY = 'lgt-ble-data-state-v1';

  function saveBleDataState(partial) {
    chrome.storage.local.get([BLE_DATA_STATE_KEY], function (res) {
      var state = Object.assign({}, res && res[BLE_DATA_STATE_KEY], partial);
      var obj = {};
      obj[BLE_DATA_STATE_KEY] = state;
      chrome.storage.local.set(obj);
    });
  }

  // ---------------------------------------------------------------------
  // Mode E: BLE Data Override - resolves the "22-es csapda" (catch-22)
  // between Bundle Override (real brand pages only) and bleSource=1 (this
  // tool's own standalone sandbox links only). See plan.md's "KUTATÁS
  // EREDMÉNYE (2026-08-10, follow-up #3)" section for the full
  // investigation - in short: every /api/sb/v1/* call (on a sandbox link
  // AND on a real brand page alike) carries `x-sb-static-context-id` /
  // `x-sb-user-context-id` request headers that alone determine which
  // customer/session context the backend resolves data for. This tab
  // mints a fresh, ALPHA-valid BLE context from PROD (the same source
  // bleSource already uses) and applies it to THIS tab via
  // declarativeNetRequest: redirect /api/sb/v1/* to the brand's ALPHA
  // host, and rewrite those two context-id headers to the freshly minted
  // pair - independent of, and combinable with, Bundle Override on the
  // same tab.
  // ---------------------------------------------------------------------

  function buildModeE() {
    var wrap = el('div', {});
    var detected = detectBrandAndEnv();

    var brandSel = el('select', {}, brandOptions(detected.brand || undefined));
    var deviceSel = el('select', {}, [
      el('option', { value: 'desktop' }, ['Desktop']),
      el('option', { value: 'mobile' }, ['Mobile'])
    ]);
    var loggedInChk = el('input', { type: 'checkbox' });
    var loggedInLabel = el('label', { style: 'display:flex;align-items:center;gap:6px;justify-content:flex-start' }, [loggedInChk, 'Logged in (only if this brand has a logged-in prod customer key)']);

    var status = el('div', { class: 'lgt-log' }, ['Not active on this tab.']);

    function alphaHostForBrand(brand) {
      var suffix = PLAYGROUND_HOST_SUFFIX[brand];
      return suffix ? ('d-cf.alpha.' + suffix) : null;
    }

    function refreshStatus() {
      chrome.runtime.sendMessage({ type: 'lgt-ble-data-status' }, function (res) {
        void chrome.runtime.lastError;
        if (!res || !res.ok) return;
        if (!res.active) status.textContent = 'Not active on this tab.';
        // While active, leave whatever the last Apply already wrote
        // (customer key / stc used) instead of overwriting it with a
        // generic "Active" - more useful for the tester to see at a
        // glance which context is currently applied.
      });
    }
    pollWhileExtensionValid(refreshStatus, 3000);

    var applyBtn = el('button', {
      onclick: function () {
        var brand = brandSel.value;
        var device = deviceSel.value;
        var alphaHost = alphaHostForBrand(brand);
        if (!alphaHost) { status.textContent = 'This brand has no known playground host - cannot resolve an ALPHA target.'; return; }
        status.textContent = 'Fetching a fresh BLE context from PROD...';
        fetchFreshBleContext(brand, device, loggedInChk.checked, '').then(function (result) {
          status.textContent = 'Applying (' + result.customerKey + ')...';
          chrome.runtime.sendMessage({
            type: 'lgt-ble-data-start', alphaHost: alphaHost, stc: result.stc, ctx: result.ctx
          }, function (res) {
            void chrome.runtime.lastError;
            if (!res || !res.ok) { status.textContent = 'Failed: ' + ((res && res.error) || 'unknown error'); return; }
            status.textContent = 'Active - ' + device + ' context ' + result.stc + ' -> ' + alphaHost + '. Reload the page if it was already loaded.';
          });
        }).catch(function (err) {
          if (err && err.isVpnRequired) { showVpnRequiredPopup(err.message, function () { applyBtn.click(); }); status.textContent = err.message; return; }
          status.textContent = 'Failed: ' + (err && err.message || err);
        });
      }
    }, ['Apply']);

    var disableBtn = el('button', {
      onclick: function () {
        chrome.runtime.sendMessage({ type: 'lgt-ble-data-stop' }, function () {
          void chrome.runtime.lastError;
          status.textContent = 'Not active on this tab.';
        });
      }
    }, ['Disable']);

    brandSel.addEventListener('change', function () { saveBleDataState({ brand: brandSel.value }); });
    deviceSel.addEventListener('change', function () { saveBleDataState({ device: deviceSel.value }); });
    loggedInChk.addEventListener('change', function () { saveBleDataState({ loggedIn: loggedInChk.checked }); });

    wrap.appendChild(el('label', {}, ['Brand']));
    wrap.appendChild(brandSel);
    wrap.appendChild(el('label', {}, ['Device (must match how this page actually renders - desktop vs mobile context are different registrations)']));
    wrap.appendChild(deviceSel);
    wrap.appendChild(loggedInLabel);
    wrap.appendChild(el('div', { style: 'display:flex;gap:6px;margin-top:6px' }, [applyBtn, disableBtn]));
    wrap.appendChild(status);
    wrap.appendChild(el('div', { class: 'lgt-hint', style: 'margin-top:8px' }, [
      'Mints a fresh, ALPHA-valid BLE customer context from PROD and applies ' +
      'it to THIS tab: redirects /api/sb/v1/* calls (event data, live-event ' +
      'list, markets, etc.) to the brand\u2019s ALPHA host and rewrites the ' +
      'context-id headers so ALPHA recognizes the request. Works on ANY ' +
      'page - a real brand page (QA/TEST) or one of this tool\u2019s own ' +
      'sandbox links - independently of, and combinable with, Bundle ' +
      'Override on the same tab. Since the live-event list itself gets ' +
      'redirected too, you don\u2019t need to manually navigate with a ' +
      'borrowed eventId - just Apply, reload, and browse the live section ' +
      'normally. Does NOT restore Match/Visual/Statistics tabs (those use a ' +
      'separate realtime channel, a known, unrelated gap - see README).'
    ]));

    chrome.storage.local.get([BLE_DATA_STATE_KEY], function (res) {
      var saved = res && res[BLE_DATA_STATE_KEY];
      if (saved && saved.brand && BRANDS[saved.brand]) brandSel.value = saved.brand;
      if (saved && saved.device) deviceSel.value = saved.device;
      if (saved && saved.loggedIn) loggedInChk.checked = true;
    });

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
      // Defensive hardening: also require the environment to match, not
      // just the brand. In practice this content-script instance only
      // ever runs inside the background tab this job itself opened (at
      // realLoginUrl(job.brand, job.environment)), so brand+environment
      // should always already agree here - but requiring both explicitly
      // removes any structural possibility of a same-brand,
      // different-environment tab (e.g. an already-open alpha tab, while
      // a qa job is starting) ever picking up a job meant for a different
      // environment, which a user reported suspecting 2026-08-06 after
      // starting a qa live-login while an alpha tab for the same brand
      // happened to be in the foreground.
      if (detected.environment !== job.environment) return;
      var sel = LOGIN_SELECTORS[job.brand];
      if (!sel || !sel.sportsbookNavPattern) {
        LiveLoginJob.update({ status: 'unsupported', error: 'Brand is not live-login-capable (missing login/Sportsbook-nav selectors).' }, focusThisTab);
        return;
      }
      LiveLoginJob.update({ status: 'logging-in' }, function () {
        // Item 12: use the specific credential the Generate tab resolved
        // (brand-matrix match/user pick) when one was set on the job;
        // fall back to the old global-default behavior for any job that
        // predates this (or was started without a matrix match at all).
        (job.credentialId ? function (cb) { Vault.getById(job.credentialId, cb); } : Vault.getDefault)(function (cred) {
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
          // Keep-alive ping (see background.js's lgt-keepalive handler):
          // MV3 service workers idle-terminate after roughly 30s without
          // activity, and chrome.storage calls made directly from THIS
          // content script (Capture.get/reset, all the awaitCapture
          // polling) never round-trip through the background script at
          // all - so a login+capture flow that routinely runs 25s+
          // between waitForUsernameFieldOrAlreadyLoggedIn's two waits and
          // the two awaitCapture budgets can leave the service worker
          // asleep at the exact moment the real sb/fe-api request fires,
          // silently dropping the one chrome.webRequest.onSendHeaders
          // event the entire capture mechanism depends on. This is a
          // known, documented MV3 limitation (non-blocking webRequest
          // observers can miss events if the worker isn't already running
          // when they fire) - suspected root cause of a 2026-08-07
          // NordicBet failure where a confirmed-genuine login (real
          // balance visible) still produced seenCount: 0 the entire time,
          // meaning webRequest never even saw the request, not just a
          // header-matching miss. A periodic round-trip message is the
          // standard workaround: real activity that resets the worker's
          // idle timer and keeps it running for the whole flow.
          var keepAliveIv = setInterval(function () {
            chrome.runtime.sendMessage({ type: 'lgt-keepalive' }, function () { void chrome.runtime.lastError; });
          }, 5000);
          function stopKeepAlive() { clearInterval(keepAliveIv); }

          // Item (2026-08-07, second follow-up): hold the CDP focus-
          // emulation/active-lifecycle state (background.js's
          // attachDebugger comment has the full rationale) for the
          // ENTIRE silent job, not just the brief type/click sequence -
          // user-confirmed a fully-minimized job otherwise simply never
          // progresses (not just slowly) until manually clicked/focused,
          // because the earlier fix only covered the trusted-input
          // moment, leaving the much longer field-polling/capture-waiting
          // phases unprotected. Skipped for a VISIBLE, non-mobile job
          // (job.visible === true, i.e. the user ticked "Show login
          // tab") - that tab is already real/focusable, no emulation
          // needed. A mobile job (job.device === 'mobile') always needs
          // this regardless of visibility though: background.js's
          // lgt-open-tab handler already attached the debugger itself
          // (setupMobileEmulation) to set the mobile viewport/UA before
          // the very first request, so this call is what correctly
          // detaches it once the job settles - see the matching
          // keepAttachedTabs guard in background.js's
          // lgt-debugger-keepalive-start handler (a no-op there when
          // already held, so no double-attach happens here either).
          var needsDebuggerHold = !job.visible || job.device === 'mobile';
          if (needsDebuggerHold) {
            chrome.runtime.sendMessage({ type: 'lgt-debugger-keepalive-start' }, function () { void chrome.runtime.lastError; });
          }
          function stopDebuggerKeepalive() {
            if (needsDebuggerHold) {
              chrome.runtime.sendMessage({ type: 'lgt-debugger-keepalive-stop' }, function () { void chrome.runtime.lastError; });
            }
          }

          Capture.reset(function () {
            attemptAutoLogin(job.brand, cred.username, cred.password, log, !job.visible).then(function (loginOk) {
              // Item 0c fix (2026-08-07): mark this brand "silent verified"
              // as soon as the trusted-input login sequence ITSELF
              // succeeded (real submission navigated away, or an
              // already-authenticated fast path was taken) - regardless of
              // whether the LATER network capture also succeeds. Previously
              // this only fired on a full 'captured' status, which meant a
              // brand could never learn to go silent if capture kept
              // failing/timing out for unrelated reasons (confirmed
              // 2026-08-07 on NordicBet/qa: login genuinely succeeded -
              // screenshot showed a real authenticated Sportsbook page -
              // but capture still timed out, so the silent flag never got
              // set and every subsequent generation kept forcing a visible
              // tab even though the background-tab CDP mechanism was
              // proven to work perfectly fine).
              if (loginOk) markBrandSilentVerified(job.brand);
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
                // Item 9 fix (2026-08-07): only flag the credential itself
                // as suspect when a step explicitly reported a real login
                // rejection (stuck on the login page after both the direct
                // submit and the Enter-key fallback) - every other !loginOk
                // reason (selectors not found, slow-mounting form, a
                // mid-flow page redirect) says nothing about whether the
                // credential is right or wrong for this brand, and
                // shouldn't trigger the delete/unlink prompt.
                var credentialSuspected = steps.some(function (s) { return s.indexOf('likely a real login rejection') !== -1; });
                stopKeepAlive();
                stopDebuggerKeepalive();
                // Bring the tab into view (instead of closing it) so the
                // user can actually see the real page state that caused the
                // failure - a step-message string alone can't capture
                // things like a captcha, cookie-consent overlay, or 2FA
                // prompt that our automation doesn't account for.
                LiveLoginJob.update({ status: 'failed', error: 'Auto-login did not complete. Steps: ' + steps.join(' > '), credentialSuspected: credentialSuspected }, focusThisTab);
                return;
              }
              Capture.get(function (c) {
                stopKeepAlive();
                stopDebuggerKeepalive();
                if (c && c.stc && c.ctx) {
                  LiveLoginJob.update({ status: 'captured', stc: c.stc, ctx: c.ctx }, function () {
                    LiveLoginCache.set(job.brand, job.environment, job.device, c.stc, c.ctx, closeThisTab);
                  });
                } else {
                  // loginOk was true here (real submission succeeded, or a
                  // session was already authenticated) - a missing capture
                  // at this point is a network-capture-timing issue, not
                  // evidence the credential is wrong for this brand.
                  LiveLoginJob.update({ status: 'failed', error: 'Login/Sportsbook navigation completed but no stc/ctx was captured. Steps: ' + steps.join(' > '), credentialSuspected: false }, focusThisTab);
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
