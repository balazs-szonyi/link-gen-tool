const test = require('node:test');
const assert = require('node:assert/strict');
const launcher = require('../extension/action-launcher.js');

function chromeMock(options = {}) {
  let sendCount = 0;
  const calls = { execute: [], create: [], windowUpdate: [], tabUpdate: [] };
  const api = {
    runtime: {
      lastError: null,
      getURL: path => `chrome-extension://test/${path}`
    },
    tabs: {
      sendMessage(tabId, message, callback) {
        sendCount += 1;
        api.runtime.lastError = sendCount <= (options.failedSends || 0) ? { message: 'no receiver' } : null;
        callback();
        api.runtime.lastError = null;
      },
      async query() { return options.existingTabs || []; },
      async update(...args) { calls.tabUpdate.push(args); }
    },
    scripting: {
      async executeScript(details) {
        calls.execute.push(details);
        if (options.injectionError) throw new Error('blocked');
      }
    },
    windows: {
      async create(details) { calls.create.push(details); return { id: 42 }; },
      async update(...args) { calls.windowUpdate.push(args); }
    }
  };
  return { api, calls };
}

test('toggles an already installed panel without reinjecting', async () => {
  const { api, calls } = chromeMock();
  const result = await launcher.launch(api, { id: 7 });
  assert.equal(result.mode, 'toggled');
  assert.equal(calls.execute.length, 0);
});

test('injects the panel into an arbitrary accessible page', async () => {
  const { api, calls } = chromeMock({ failedSends: 1 });
  const result = await launcher.launch(api, { id: 8 });
  assert.equal(result.mode, 'injected');
  assert.deepEqual(calls.execute[0].files, launcher.PANEL_FILES);
});

test('opens a standalone popup when the active page rejects injection', async () => {
  const { api, calls } = chromeMock({ failedSends: 1, injectionError: true });
  const result = await launcher.launch(api, { id: 9 });
  assert.equal(result.mode, 'standalone-created');
  assert.equal(calls.create[0].url, 'chrome-extension://test/standalone.html');
  assert.equal(calls.create[0].type, 'popup');
});

test('focuses an existing standalone popup instead of duplicating it', async () => {
  const existingTabs = [{ id: 12, windowId: 13 }];
  const { api, calls } = chromeMock({ failedSends: 1, injectionError: true, existingTabs });
  const result = await launcher.launch(api, { id: 10 });
  assert.equal(result.mode, 'standalone-existing');
  assert.deepEqual(calls.windowUpdate[0], [13, { focused: true }]);
  assert.deepEqual(calls.tabUpdate[0], [12, { active: true }]);
});
