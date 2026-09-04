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

  function install(chromeApi) {
    var chrome = chromeApi;
    var operationsByTab = Object.create(null);
    // Startup reconciliation and the first navigation can overlap. Record
    // onBeforeNavigate's destination synchronously so a slower tabs.query()
    // snapshot cannot mistake a freshly-installed rule for a stale one.
    var pendingNavigationHostByTab = Object.create(null);

    function lastErrorMessage() {
      return chrome.runtime && chrome.runtime.lastError && chrome.runtime.lastError.message;
    }

    function getRules() {
      return new Promise(function (resolve) {
        chrome.declarativeNetRequest.getSessionRules(function (rules) { resolve(rules || []); });
      });
    }

    function ownRules(rules) {
      return (rules || []).filter(function (rule) {
        return rule.id >= RULE_ID_START && rule.id < RULE_ID_END;
      });
    }

    function rulesForTab(rules, tabId) {
      return ownRules(rules).filter(function (rule) {
        return rule.condition && Array.isArray(rule.condition.tabIds) && rule.condition.tabIds.indexOf(tabId) !== -1;
      });
    }

    function updateRules(addRules, removeRuleIds) {
      return new Promise(function (resolve, reject) {
        chrome.declarativeNetRequest.updateSessionRules({
          addRules: addRules || [],
          removeRuleIds: removeRuleIds || []
        }, function () {
          var error = lastErrorMessage();
          if (error) reject(new Error(error));
          else resolve();
        });
      });
    }

    function nextId(rules) {
      var used = Object.create(null);
      ownRules(rules).forEach(function (rule) { used[rule.id] = true; });
      for (var id = RULE_ID_START; id < RULE_ID_END; id += 1) {
        if (!used[id]) return id;
      }
      throw new Error('Oddin Statistics fix session-rule range is exhausted');
    }

    function refererForRule(rule) {
      var headers = rule && rule.action && rule.action.requestHeaders;
      var entry = (headers || []).find(function (header) { return String(header.header).toLowerCase() === 'referer'; });
      return entry && entry.value;
    }

    function ruleHost(rule) {
      var domains = rule && rule.condition && rule.condition.initiatorDomains;
      return domains && domains[0];
    }

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

    function enabled() {
      return new Promise(function (resolve) {
        chrome.storage.local.get([SETTING_KEY], function (result) {
          resolve(!result || typeof result[SETTING_KEY] !== 'boolean' || result[SETTING_KEY]);
        });
      });
    }

    function queue(tabId, operation) {
      var previous = operationsByTab[tabId] || Promise.resolve();
      var current = previous.catch(function () {}).then(operation);
      operationsByTab[tabId] = current;
      current.then(function () {
        if (operationsByTab[tabId] === current) delete operationsByTab[tabId];
      }, function () {
        if (operationsByTab[tabId] === current) delete operationsByTab[tabId];
      });
      return current;
    }

    function stopTab(tabId) {
      return getRules().then(function (rules) {
        var ids = rulesForTab(rules, tabId).map(function (rule) { return rule.id; });
        return ids.length ? updateRules([], ids) : undefined;
      });
    }

    function startOrKeep(tabId, info) {
      return getRules().then(function (rules) {
        var existing = rulesForTab(rules, tabId);
        if (existing.length === 1 && ruleHost(existing[0]) === info.hostname) return;
        var removeIds = existing.map(function (rule) { return rule.id; });
        return updateRules([buildRule(nextId(rules), tabId, info.hostname, ALPHA_REFERER)], removeIds);
      });
    }

    function reconcileNavigation(details) {
      if (!details || details.frameId !== 0 || details.tabId == null) return Promise.resolve();
      var info = playgroundInfo(details.url);
      return enabled().then(function (isEnabled) {
        return queue(details.tabId, function () {
          return isEnabled && info ? startOrKeep(details.tabId, info) : stopTab(details.tabId);
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
      return queue(details.tabId, function () {
        return getRules().then(function (rules) {
          var existing = rulesForTab(rules, details.tabId);
          if (!existing.length) return;
          var active = existing[0];
          if (refererForRule(active) === PROD_REFERER) {
            warnProdFailure(details.tabId);
            return;
          }
          if (refererForRule(active) !== ALPHA_REFERER) return;
          var replacement = buildRule(nextId(rules), details.tabId, ruleHost(active), PROD_REFERER);
          return updateRules([replacement], existing.map(function (rule) { return rule.id; })).then(function () {
            return retryIframe(details.tabId);
          });
        });
      });
    }

    function stopAll() {
      return getRules().then(function (rules) {
        var ids = ownRules(rules).map(function (rule) { return rule.id; });
        return ids.length ? updateRules([], ids) : undefined;
      });
    }

    function reconcileExisting() {
      if (!chrome.tabs || !chrome.tabs.query) return Promise.resolve();
      return Promise.all([getRules(), enabled(), new Promise(function (resolve) { chrome.tabs.query({}, resolve); })])
        .then(function (values) {
          var rules = ownRules(values[0]);
          var isEnabled = values[1];
          var tabs = values[2] || [];
          var valid = Object.create(null);
          tabs.forEach(function (tab) {
            var info = isEnabled && playgroundInfo(tab.url);
            if (info) valid[tab.id] = info.hostname;
          });
          Object.keys(pendingNavigationHostByTab).forEach(function (tabId) {
            var hostname = pendingNavigationHostByTab[tabId];
            if (isEnabled && hostname) valid[tabId] = hostname;
            else delete valid[tabId];
          });
          var stale = rules.filter(function (rule) {
            var tabIds = rule.condition && rule.condition.tabIds;
            return !tabIds || tabIds.length !== 1 || valid[tabIds[0]] !== ruleHost(rule);
          }).map(function (rule) { return rule.id; });
          return stale.length ? updateRules([], stale) : undefined;
        });
    }

    chrome.webNavigation.onBeforeNavigate.addListener(function (details) {
      if (details && details.frameId === 0 && details.tabId != null) {
        var destination = playgroundInfo(details.url);
        pendingNavigationHostByTab[details.tabId] = destination && destination.hostname;
      }
      reconcileNavigation(details).catch(function (error) { console.warn('[link-gen-tool] Oddin navigation setup failed:', error); });
    });
    // Chromium normally delivers webNavigation first. onUpdated is a second
    // early signal for profiles/runners where the worker was not awake for
    // that event; startOrKeep is idempotent, so receiving both is harmless.
    if (chrome.tabs.onUpdated) chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
      if (!changeInfo || !changeInfo.url) return;
      var destination = playgroundInfo(changeInfo.url);
      pendingNavigationHostByTab[tabId] = destination && destination.hostname;
      reconcileNavigation({ frameId: 0, tabId: tabId, url: changeInfo.url }).catch(function (error) {
        console.warn('[link-gen-tool] Oddin tab-update setup failed:', error);
      });
    });
    chrome.webRequest.onCompleted.addListener(function (details) {
      handleCompleted(details).catch(function (error) { console.warn('[link-gen-tool] Oddin fallback failed:', error); });
    }, { urls: ['https://disir.oddin.gg/*'], types: ['sub_frame'] });
    chrome.tabs.onRemoved.addListener(function (tabId) {
      queue(tabId, function () { return stopTab(tabId); }).catch(function () {});
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes || !changes[SETTING_KEY]) return;
      if (changes[SETTING_KEY].newValue === false) stopAll().catch(function (error) { console.warn('[link-gen-tool] Oddin disable cleanup failed:', error); });
      else reconcileExisting().catch(function (error) { console.warn('[link-gen-tool] Oddin enable reconciliation failed:', error); });
    });

    reconcileExisting().catch(function (error) { console.warn('[link-gen-tool] Oddin startup reconciliation failed:', error); });

    return {
      reconcileNavigation: reconcileNavigation,
      handleCompleted: handleCompleted,
      stopTab: stopTab,
      stopAll: stopAll,
      reconcileExisting: reconcileExisting
    };
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
