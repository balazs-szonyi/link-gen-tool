'use strict';
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./worker-state.js') : root.LgtWorkerState);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LgtDebuggerSession = api;
})(globalThis, function (core) {
  function create(chrome, store) {
    const serialize = core.createQueue();
    const running = new Map(); // Cancellation of a currently executing sequence only.
    const call = (method, ...args) => core.call(chrome, chrome.debugger, method, ...args);
    const command = (tabId, method, params = {}) => call('sendCommand', { tabId }, method, params);
    async function connected(tabId) {
      // getTargets().attached cannot identify who owns the connection. A command
      // succeeds only for this extension's own session; never trust a saved flag.
      try { await command(tabId, 'Page.getFrameTree'); return true; }
      catch (_) { return false; }
    }
    async function migrate() {
      const key = 'lgt-debugger-attached-tabs';
      const legacy = await core.call(chrome, chrome.storage.session, 'get', key);
      for (const tabId of Object.keys(legacy[key] || {}).map(Number)) {
        if (await connected(tabId)) await store.update('debugger', tabId, () => ({ held: true }));
      }
      await core.call(chrome, chrome.storage.session, 'remove', key);
      // The old local map's tab ids cannot be validated across browser sessions.
      // Do not restore it or touch credentials/settings/capture entries.
      await core.call(chrome, chrome.storage.local, 'remove', 'lgt-job-origin-map');
    }
    const ready = migrate();
    void core.observe(ready, 'debugger migration');
    async function detach(tabId) {
      try { if (await connected(tabId)) await call('detach', { tabId }); }
      finally { await store.update('debugger', tabId, () => null); }
    }
    async function ensure(tabId) {
      const record = await store.read('debugger', tabId);
      if (await connected(tabId)) return record || { held: false };
      await store.update('debugger', tabId, () => null);
      // Chrome refuses attach if DevTools/another extension owns the tab.
      await call('attach', { tabId }, '1.3');
      try {
        await store.update('debugger', tabId, () => ({ held: false }));
        try { await command(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (_) { /* best effort */ }
        try { await command(tabId, 'Page.setWebLifecycleState', { state: 'active' }); } catch (_) { /* best effort */ }
        return { held: false };
      } catch (error) { await detach(tabId); throw error; }
    }
    function withSession(tabId, work, hold = false) {
      return serialize(tabId, async () => {
        await ready;
        const record = await ensure(tabId);
        const token = { cancelled: false };
        running.set(tabId, token);
        let success = false;
        try {
          const result = await work(async (method, params) => {
            if (token.cancelled) throw new Error('Debugger detached while operation was running');
            return command(tabId, method, params);
          });
          if (token.cancelled) throw new Error('Debugger detached while operation was running');
          if (hold) await store.update('debugger', tabId, () => ({ held: true }));
          success = true;
          return result;
        } finally {
          if (running.get(tabId) === token) running.delete(tabId);
          // Failed mobile setup cannot leave emulation or a lease behind.
          if ((!record.held && !hold) || (hold && !success)) await detach(tabId);
        }
      });
    }
    function hold(tabId) { return withSession(tabId, async () => {}, true); }
    function release(tabId) { return serialize(tabId, async () => { await ready; await detach(tabId); }); }
    function cancel(tabId) { const token = running.get(tabId); if (token) token.cancelled = true; }
    chrome.debugger.onDetach.addListener(source => {
      if (source.tabId == null) return;
      cancel(source.tabId);
      void core.observe(serialize(source.tabId, async () => {
        // A new attach may already have been queued. Do not erase its lease.
        if (!await connected(source.tabId)) await store.update('debugger', source.tabId, () => null);
      }), 'debugger detach cleanup');
    });
    chrome.tabs.onRemoved.addListener(tabId => { cancel(tabId); void core.observe(release(tabId), 'debugger tab cleanup'); });
    return { ready, withSession, hold, release, command, cancel };
  }
  return { create };
});
