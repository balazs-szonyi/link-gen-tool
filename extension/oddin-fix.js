/*
 * Firestorm Oddin Statistics fix.
 *
 * Kept in a small dependency-free module so the DNR lifecycle can be tested
 * without booting the rest of the extension service worker. In Chrome it is
 * loaded by background.js with importScripts(); in Node it is exported for
 * the mocked background tests.
 */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LgtOddinFix = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var SETTING_KEY = 'lgt-oddin-fix-enabled';
  var RULE_ID_START = 990001;
  var RULE_ID_END = 1010000; // exclusive; owns 990001..1009999
  var ODDIN_HOST = 'disir.oddin.gg';
  var FIRESTORM_TOKEN = 'b1248112-ccd9-4908-a9fd-acedb48d2c54';
  var ALPHA_REFERER = 'https://d-cf.alpha.sbplayground1.net/';
  var PROD_REFERER = 'https://d-cf.sbplayground1.net/';
  var RETRY_PARAM = 'lgtOddinRetry';
  var URL_REGEX = '^https://disir\\.oddin\\.gg/[^#]*[?&]brandToken=' + FIRESTORM_TOKEN + '(?:[&#]|$)';

  function playgroundInfo(rawUrl) {
    var url;
    try { url = new URL(rawUrl); } catch (e) { return null; }
    var match = /^(d-cf|m-cf)\.(test|qa)\.sbplayground1\.net$/.exec(url.hostname.toLowerCase());
    return match ? { origin: url.origin, hostname: url.hostname.toLowerCase(), environment: match[2] } : null;
  }

  function isTargetOddinUrl(rawUrl) {
    var url;
    try { url = new URL(rawUrl); } catch (e) { return false; }
    return url.protocol === 'https:' && url.hostname === ODDIN_HOST &&
      url.searchParams.get('brandToken') === FIRESTORM_TOKEN;
  }

  function install(chromeApi, dependencies) {
    const chrome = chromeApi;
    const core = typeof module === 'object' && module.exports ? require('./worker-state.js') : globalThis.LgtWorkerState;
    const store = dependencies?.store || core.createStore(chrome);
    const dnr = dependencies?.dnr || core.createDnr(chrome, store);
    const latest = core.createLatestTasks();
    const sequence = core.createQueue();
    const call = (owner, method, ...args) => core.call(chrome, owner, method, ...args);
    const lastErrorMessage = () => chrome.runtime.lastError?.message;
    const refererForRule = rule => rule?.action?.requestHeaders?.find(header => header.header.toLowerCase() === 'referer')?.value;
    const ruleHost = rule => rule?.condition?.initiatorDomains?.[0];
    function buildRule(id, tabId, hostname, referer) {
      return {
        id: id,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'referer', operation: 'set', value: referer }]
        },
        condition: {
          regexFilter: URL_REGEX,
          requestDomains: [ODDIN_HOST],
          initiatorDomains: [hostname],
          resourceTypes: ['sub_frame'],
          tabIds: [tabId]
        }
      };
    }


    async function enabled() { return (await call(chrome.storage.local, 'get', SETTING_KEY))[SETTING_KEY] !== false; }
    function stopTab(tabId) { latest.cancel(tabId); return dnr.stop('oddin', tabId); }
    async function startOrKeep(tabId, info, isCurrent) {
      const existing = (await dnr.status('oddin', tabId)).rules;
      if (!isCurrent()) return;
      if (existing.length === 1 && ruleHost(existing[0]) === info.hostname) return;
      await dnr.apply('oddin', tabId, { scope: { kind: 'hostname', value: info.hostname } }, async () => allocate =>
        [buildRule(allocate(1)[0], tabId, info.hostname, ALPHA_REFERER)]);
    }
    function reconcileNavigation(details) {
      if (!details || details.frameId !== 0 || details.tabId == null) return Promise.resolve();
      dnr.cancel('oddin', details.tabId);
      return latest.run(details.tabId, async isCurrent => {
        const info = playgroundInfo(details.url);
        const on = await enabled();
        if (!isCurrent()) return;
        return sequence(details.tabId, async () => {
          if (!isCurrent()) return;
          if (on && info) await startOrKeep(details.tabId, info, isCurrent);
          else await dnr.stop('oddin', details.tabId);
        });
      });
    }
    function retryIframe(tabId) {
      return new Promise(function (resolve, reject) {
        chrome.scripting.executeScript({
          target: { tabId: tabId, frameIds: [0] },
          world: 'MAIN',
          func: function (host, token, retryParam) {
            var frames = document.querySelectorAll('iframe[src]');
            for (var i = 0; i < frames.length; i += 1) {
              var url;
              try { url = new URL(frames[i].src, document.baseURI); } catch (e) { continue; }
              if (url.protocol === 'https:' && url.hostname === host && url.searchParams.get('brandToken') === token) {
                if (url.searchParams.get(retryParam) === '1') return false;
                url.searchParams.set(retryParam, '1');
                frames[i].src = url.href;
                return true;
              }
            }
            return false;
          },
          args: [ODDIN_HOST, FIRESTORM_TOKEN, RETRY_PARAM]
        }, function (results) {
          var error = lastErrorMessage();
          if (error) reject(new Error(error));
          else resolve(!!(results && results[0] && results[0].result));
        });
      });
    }

    function warnProdFailure(tabId) {
      var message = '[link-gen-tool] Oddin Statistics fix: PROD Referer fallback also returned 403; no further retries will be attempted.';
      console.warn(message);
      if (!chrome.scripting || !chrome.scripting.executeScript) return;
      chrome.scripting.executeScript({
        target: { tabId: tabId, frameIds: [0] },
        world: 'MAIN',
        func: function (text) { console.warn(text); },
        args: [message]
      }, function () { void lastErrorMessage(); });
    }


    function handleCompleted(details) {
      if (!details || details.tabId == null || details.tabId < 0 || details.statusCode !== 403 ||
          details.type !== 'sub_frame' || !isTargetOddinUrl(details.url)) return Promise.resolve();
      return sequence(details.tabId, async () => {
        const { rules, metadata } = await dnr.status('oddin', details.tabId);
        const active = rules[0];
        if (!active) return;
        if (refererForRule(active) === PROD_REFERER) { warnProdFailure(details.tabId); return; }
        if (refererForRule(active) !== ALPHA_REFERER) return;
        await dnr.apply('oddin', details.tabId, metadata, async () => allocate =>
          [buildRule(allocate(1)[0], details.tabId, ruleHost(active), PROD_REFERER)]);
        await retryIframe(details.tabId);
      });
    }
    async function stopAll() {
      await dnr.ready;
      const rules = core.rulesFor(await call(chrome.declarativeNetRequest, 'getSessionRules'), 'oddin');
      await Promise.all([...new Set(rules.flatMap(rule => rule.condition.tabIds))].map(stopTab));
    }
    async function reconcileExisting() {
      await dnr.ready;
      if (!await enabled()) await stopAll();
    }
    chrome.webNavigation.onBeforeNavigate.addListener(details => {
      void core.observe(reconcileNavigation(details), 'Oddin navigation');
    });
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (info.url) void core.observe(reconcileNavigation({ tabId, frameId: 0, url: info.url }), 'Oddin tab update');
    });
    chrome.webRequest.onCompleted.addListener(details => {
      void core.observe(handleCompleted(details), 'Oddin fallback');
    }, { urls: ['https://disir.oddin.gg/*'], types: ['sub_frame'] });
    chrome.tabs.onRemoved.addListener(tabId => { void core.observe(stopTab(tabId), 'Oddin tab cleanup'); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SETTING_KEY]) return;
      void core.observe(changes[SETTING_KEY].newValue === false ? stopAll() : reconcileExisting(), 'Oddin setting');
    });
    void core.observe(reconcileExisting(), 'Oddin startup');
    return { reconcileNavigation, handleCompleted, stopTab, stopAll, reconcileExisting };
  }

  return {
    install: install,
    playgroundInfo: playgroundInfo,
    isTargetOddinUrl: isTargetOddinUrl,
    constants: {
      SETTING_KEY: SETTING_KEY,
      RULE_ID_START: RULE_ID_START,
      RULE_ID_END: RULE_ID_END,
      ODDIN_HOST: ODDIN_HOST,
      FIRESTORM_TOKEN: FIRESTORM_TOKEN,
      ALPHA_REFERER: ALPHA_REFERER,
      PROD_REFERER: PROD_REFERER,
      URL_REGEX: URL_REGEX
    }
  };
}));
