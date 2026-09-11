'use strict';
const assert = require('node:assert/strict');
function event() {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } };
}
function makeChrome(state = {}) {
  Object.assign(state, { rules: state.rules || [], session: state.session || {}, local: state.local || {}, tabs: state.tabs || [{ id: 1, url: 'https://www.test.betsson.com/sportsbook', windowId: 1 }], commands: state.commands || [], attached: state.attached || {}, updates: state.updates || [], fail: null });
  const runtime = { onMessage: event(), getURL: path => 'chrome-extension://fixture/' + path };
  const finish = (label, cb, operation) => {
    queueMicrotask(() => {
      if (state.fail === label || (typeof state.fail === 'function' && state.fail(label))) {
        runtime.lastError = { message: 'Injected failure: ' + label };
        try { cb(); } finally { delete runtime.lastError; }
        return;
      }
      const result = operation(); cb(structuredClone(result));
    });
  };
  const storage = area => ({
    get(keys, cb) { finish(area + '.get', cb, () => keys === null ? state[area] : Object.fromEntries([].concat(keys).filter(key => key in state[area]).map(key => [key, state[area][key]]))); },
    set(values, cb) { finish(area + '.set', cb, () => { Object.assign(state[area], structuredClone(values)); }); },
    remove(keys, cb) { finish(area + '.remove', cb, () => { for (const key of [].concat(keys)) delete state[area][key]; }); }
  });
  const chrome = {
    runtime,
    storage: { session: storage('session'), local: storage('local'), onChanged: event() },
    declarativeNetRequest: {
      onRuleMatchedDebug: event(),
      getSessionRules(cb) { finish('dnr.get', cb, () => state.rules); },
      updateSessionRules(update, cb) { finish('dnr.update', cb, () => {
        const next = state.rules.filter(rule => !update.removeRuleIds?.includes(rule.id));
        for (const rule of update.addRules || []) {
          assert(!next.some(other => rule.id === other.id), 'no colliding DNR IDs'); next.push(structuredClone(rule));
        }
        state.rules = next; state.updates.push(structuredClone(update));
      }); }
    },
    tabs: {
      onRemoved: event(), onUpdated: event(),
      query(query, cb) { finish('tabs.query', cb, () => state.tabs); },
      get(id, cb) { finish('tabs.get', cb, () => state.tabs.find(tab => tab.id === id)); },
      update(id, values, cb) { finish('tabs.update', cb, () => Object.assign(state.tabs.find(tab => tab.id === id), values)); },
      sendMessage(id, msg, cb) { finish('tabs.message', cb, () => ({})); }
    },
    debugger: {
      onDetach: event(),
      attach(target, protocol, cb) {
        if (state.attached[target.tabId]) { runtime.lastError = { message: 'Another debugger is attached' }; cb(); delete runtime.lastError; return; }
        finish('debugger.attach', cb, () => { state.attached[target.tabId] = 'ours'; });
      },
      detach(target, cb) { finish('debugger.detach', cb, () => { delete state.attached[target.tabId]; chrome.debugger.onDetach.emit(target, 'canceled_by_user'); }); },
      sendCommand(target, method, params, cb) {
        if (state.attached[target.tabId] !== 'ours') { runtime.lastError = { message: 'Not attached to this target' }; cb(); delete runtime.lastError; return; }
        finish(method, cb, () => { state.commands.push({ tabId: target.tabId, method, params }); return {}; });
      }
    },
    webNavigation: { onBeforeNavigate: event(), onCommitted: event(), getFrame(details, cb) { finish('getFrame', cb, () => state.frame || { documentId: 'doc-1' }); } },
    webRequest: { onSendHeaders: event(), onBeforeRequest: event(), onHeadersReceived: event(), onCompleted: event() },
    scripting: { executeScript(options, cb) { finish('executeScript', cb, () => [{ result: { enabled: false, owned: false } }]); } },
    action: { onClicked: event() }
  };
  return { chrome, state };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function flush() { await new Promise(resolve => setImmediate(resolve)); }
module.exports = { event, makeChrome, deferred, flush };
