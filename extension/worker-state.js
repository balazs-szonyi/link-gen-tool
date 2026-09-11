/* Shared MV3 state. Only unfinished work lives in memory; browser state is authoritative. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LgtWorkerState = api;
})(globalThis, function () {
  const PREFIX = 'lgt:v2:';
  const RANGES = Object.freeze({
    embed: [900001, 910001], bleData: [910001, 930001], bundle: [930001, 950001],
    sportradar: [950001, 970001], bleCors: [970001, 990001], oddin: [990001, 1010000]
  });

  // Callback boundary also works on Chrome versions without Promise support for an API.
  function call(chrome, owner, method, ...args) {
    return new Promise((resolve, reject) => {
      owner[method](...args, result => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    });
  }

  function createQueue() {
    const pending = new Map();
    return function serialize(key, work) {
      const previous = pending.get(key);
      const current = (async () => {
        try { await previous; } catch (_) { /* failure must not poison the queue */ }
        try { return await work(); }
        finally { if (pending.get(key) === current) pending.delete(key); }
      })();
      pending.set(key, current);
      return current;
    };
  }

  async function observe(work, label = 'background operation') {
    try { return await work; }
    catch (error) { console.warn('[link-gen-tool] ' + label + ':', error); }
  }

  function createLatestTasks() {
    const pending = new Map();
    function cancel(key) {
      const token = pending.get(key);
      if (token) token.cancelled = true;
      pending.delete(key);
    }
    async function run(key, work) {
      cancel(key);
      const token = { cancelled: false };
      pending.set(key, token);
      try { return await work(() => !token.cancelled); }
      finally { if (pending.get(key) === token) pending.delete(key); }
    }
    return { run, cancel };
  }

  function createStore(chrome) {
    const serialize = createQueue();
    const keyFor = (area, tabId) => PREFIX + area + ':' + tabId;
    async function read(area, tabId) {
      const key = keyFor(area, tabId);
      const result = await call(chrome, chrome.storage.session, 'get', key);
      return result[key] || null;
    }
    function update(area, tabId, change) {
      const key = keyFor(area, tabId);
      return serialize(key, async () => {
        const value = await change(await read(area, tabId));
        if (value === null) await call(chrome, chrome.storage.session, 'remove', key);
        else await call(chrome, chrome.storage.session, 'set', { [key]: { ...value, schema: 2 } });
        return value;
      });
    }
    async function dropTab(tabId) {
      const all = await call(chrome, chrome.storage.session, 'get', null);
      const keys = Object.keys(all).filter(key => key.startsWith(PREFIX) && key.endsWith(':' + tabId));
      await Promise.all(keys.map(key => serialize(key, () => call(chrome, chrome.storage.session, 'remove', key))));
    }
    return { read, update, dropTab, keyFor, serialize };
  }

  function rulesFor(rules, feature, tabId) {
    const [start, end] = RANGES[feature];
    return rules.filter(rule => rule.id >= start && rule.id < end &&
      (tabId === undefined || rule.condition?.tabIds?.includes(tabId)));
  }
  function allocate(rules, feature, count) {
    const used = new Set(rules.map(rule => rule.id));
    const [start, end] = RANGES[feature];
    const ids = [];
    for (let id = start; id < end && ids.length < count; id++) if (!used.has(id)) ids.push(id);
    if (ids.length !== count) throw new Error(feature + ' session-rule range is exhausted');
    return ids;
  }
  function scopeMatches(scope, url) {
    try {
      if (scope?.kind === 'url') return scope.value === url;
      if (scope?.kind === 'origin') return scope.value === new URL(url).origin;
      if (scope?.kind === 'hostname') return scope.value === new URL(url).hostname;
    } catch (_) { /* malformed URL fails closed */ }
    return false;
  }
  // Non-secret integrity digest, not a security/authentication primitive.
  function fingerprint(rules) {
    function canonical(value) {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
      return value;
    }
    let hash = 2166136261;
    for (const ch of JSON.stringify(canonical([...rules].sort((a, b) => a.id - b.id)))) {
      hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
    }
    return rules.length + ':' + hash.toString(16);
  }

  function createDnr(chrome, store) {
    const serialize = createQueue();
    const pending = new Map(); // cancellation tokens for unfinished Apply only
    const areaFor = feature => 'dnr/' + feature;
    const live = () => call(chrome, chrome.declarativeNetRequest, 'getSessionRules');
    const mutate = options => call(chrome, chrome.declarativeNetRequest, 'updateSessionRules', options);
    const taskKey = (feature, tabId) => feature + ':' + tabId;
    function cancel(feature, tabId) {
      const token = pending.get(taskKey(feature, tabId));
      if (token) { token.cancelled = true; pending.delete(taskKey(feature, tabId)); }
    }
    function cancelTab(tabId) { for (const feature of Object.keys(RANGES)) cancel(feature, tabId); }

    async function reconcile() {
      // Runs before any mutation; events are registered without awaiting this Promise.
      const [rules, tabs, records] = await Promise.all([
        live(), call(chrome, chrome.tabs, 'query', {}), call(chrome, chrome.storage.session, 'get', null)
      ]);
      const urls = new Map(tabs.map(tab => [tab.id, tab.pendingUrl || tab.url]));
      for (const feature of Object.keys(RANGES)) {
        const own = rulesFor(rules, feature);
        const tabIds = new Set(own.flatMap(rule => rule.condition?.tabIds || []));
        const prefix = PREFIX + areaFor(feature) + ':';
        for (const key of Object.keys(records)) if (key.startsWith(prefix)) tabIds.add(Number(key.slice(prefix.length)));
        const malformed = own.filter(rule => rule.condition?.tabIds?.length !== 1).map(rule => rule.id);
        if (malformed.length) await mutate({ removeRuleIds: malformed });
        for (const tabId of tabIds) {
          const record = records[store.keyFor(areaFor(feature), tabId)];
          const current = rulesFor(own, feature, tabId).filter(rule => !malformed.includes(rule.id));
          if (record?.schema === 2 && record.status === 'active' &&
              scopeMatches(record.scope, urls.get(tabId)) && record.fingerprint === fingerprint(current)) continue;
          if (current.length) await mutate({ removeRuleIds: current.map(rule => rule.id) });
          await store.update(areaFor(feature), tabId, () => null);
        }
      }
    }
    // A failed startup is surfaced to every caller, never reported as "inactive".
    const ready = reconcile();
    void observe(ready, 'DNR reconciliation');

    async function apply(feature, tabId, metadata, build) {
      cancel(feature, tabId);
      const token = { id: crypto.randomUUID(), cancelled: false };
      const key = taskKey(feature, tabId);
      pending.set(key, token);
      function assertCurrent() {
        if (token.cancelled) throw new Error('Override cancelled by Stop, navigation, or a newer Apply');
      }
      try {
        await ready;
        await serialize('rules', async () => {
          assertCurrent();
          await store.update(areaFor(feature), tabId, () => ({ ...metadata, token: token.id, status: 'applying' }));
        });
        // Indexer fetch / any expensive preparation happens OUTSIDE the allocation lock.
        const makeRules = await build();
        return await serialize('rules', async () => {
          assertCurrent();
          const all = await live();
          assertCurrent();
          const previous = rulesFor(all, feature, tabId);
          const record = await store.read(areaFor(feature), tabId);
          if (record?.token !== token.id) throw new Error('Override operation superseded');
          const rules = makeRules(count => allocate(all.filter(rule => !previous.includes(rule)), feature, count));
          if (!rules.length) throw new Error('No override rules were produced');
          assertCurrent();
          await mutate({ removeRuleIds: previous.map(rule => rule.id), addRules: rules });
          try {
            assertCurrent();
            await store.update(areaFor(feature), tabId, () => ({ ...metadata, status: 'active', fingerprint: fingerprint(rules) }));
          } catch (error) {
            // A failed metadata write must not leave an untracked active override.
            await mutate({ removeRuleIds: rules.map(rule => rule.id) });
            throw error;
          }
          return { ruleCount: rules.length };
        });
      } catch (error) {
        // Keep intent on cleanup failure: the next worker will reconcile it fail-closed.
        await serialize('rules', async () => {
          const record = await store.read(areaFor(feature), tabId);
          if (record?.token !== token.id) return;
          const ids = rulesFor(await live(), feature, tabId).map(rule => rule.id);
          if (ids.length) await mutate({ removeRuleIds: ids });
          await store.update(areaFor(feature), tabId, () => null);
        });
        throw error;
      } finally { if (pending.get(key) === token) pending.delete(key); }
    }
    function stop(feature, tabId) {
      cancel(feature, tabId);
      return serialize('rules', async () => {
        await ready;
        await store.update(areaFor(feature), tabId, record => ({ ...record, status: 'stopping' }));
        const ids = rulesFor(await live(), feature, tabId).map(rule => rule.id);
        if (ids.length) await mutate({ removeRuleIds: ids });
        await store.update(areaFor(feature), tabId, () => null);
      });
    }
    async function status(feature, tabId) {
      await ready;
      return serialize('rules', async () => ({
        rules: rulesFor(await live(), feature, tabId),
        metadata: await store.read(areaFor(feature), tabId)
      }));
    }
    function navigate(tabId, url) {
      cancelTab(tabId);
      return (async () => {
        await ready;
        for (const feature of Object.keys(RANGES)) {
          // Recheck under the mutation queue; never act on a pre-Apply snapshot.
          await serialize('rules', async () => {
            const record = await store.read(areaFor(feature), tabId);
            if (!record || (feature !== 'embed' && scopeMatches(record.scope, url))) return;
            await store.update(areaFor(feature), tabId, value => ({ ...value, status: 'stopping' }));
            const ids = rulesFor(await live(), feature, tabId).map(rule => rule.id);
            if (ids.length) await mutate({ removeRuleIds: ids });
            await store.update(areaFor(feature), tabId, () => null);
          });
        }
      })();
    }
    async function dropTab(tabId) {
      cancelTab(tabId);
      await Promise.all(Object.keys(RANGES).map(feature => stop(feature, tabId)));
    }
    return { ready, apply, stop, status, navigate, dropTab, cancel, cancelTab, reconcile };
  }

  function createDispatcher(chrome) {
    const handlers = new Map();
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const handler = handlers.get(message?.type);
      if (!handler) return false;
      void (async () => {
        let response;
        try { response = await handler(message, sender); }
        catch (error) { response = { ok: false, error: String(error?.message || error) }; }
        // Respond exactly once, including thrown API/storage/network failures.
        try { sendResponse(response === undefined ? { ok: true } : response); }
        catch (_) { /* sender navigated/closed while operation was running */ }
      })();
      return true;
    });
    return (type, handler) => {
      if (handlers.has(type)) throw new Error('Duplicate message handler: ' + type);
      handlers.set(type, handler);
    };
  }

  return { PREFIX, RANGES, call, createQueue, createLatestTasks, observe, createStore, createDnr,
    rulesFor, allocate, scopeMatches, fingerprint, createDispatcher };
});
