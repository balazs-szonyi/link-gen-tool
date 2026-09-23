/* Toolbar launcher: toggle an existing panel, inject it on demand, or fall
 * back to an extension-owned window for protected/blank browser pages. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LgtActionLauncher = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PANEL_FILES = ['bonus-mock.js', 'bet-void-mock.js', 'content.js'];
  var STANDALONE_PATH = 'standalone.html';

  function sendToggle(chromeApi, tabId) {
    return new Promise(function (resolve) {
      chromeApi.tabs.sendMessage(tabId, { type: 'lgt-toggle-panel' }, function () {
        resolve(!chromeApi.runtime.lastError);
      });
    });
  }

  async function openStandalone(chromeApi) {
    var url = chromeApi.runtime.getURL(STANDALONE_PATH);
    var existing = await chromeApi.tabs.query({ url: url });
    if (existing[0]) {
      await chromeApi.windows.update(existing[0].windowId, { focused: true });
      await chromeApi.tabs.update(existing[0].id, { active: true });
      return { mode: 'standalone-existing', tabId: existing[0].id };
    }
    var created = await chromeApi.windows.create({
      url: url,
      type: 'popup',
      width: 440,
      height: 780,
      focused: true
    });
    return { mode: 'standalone-created', windowId: created && created.id };
  }

  async function launch(chromeApi, tab) {
    if (!tab || tab.id == null) return openStandalone(chromeApi);
    if (await sendToggle(chromeApi, tab.id)) return { mode: 'toggled', tabId: tab.id };

    try {
      await chromeApi.scripting.executeScript({ target: { tabId: tab.id }, files: PANEL_FILES });
      if (await sendToggle(chromeApi, tab.id)) return { mode: 'injected', tabId: tab.id };
    } catch (error) {
      // chrome://, chrome-extension://, the Web Store and blank/new-tab
      // documents deliberately reject content-script injection.
    }
    return openStandalone(chromeApi);
  }

  function install(chromeApi) {
    chromeApi.action.onClicked.addListener(async function (tab) {
      try {
        await launch(chromeApi, tab);
      } catch (error) {
        console.error('[link-gen-tool] Failed to open panel:', error);
      }
    });
  }

  return { PANEL_FILES: PANEL_FILES, STANDALONE_PATH: STANDALONE_PATH, launch: launch, install: install };
});
