/* Toolbar launcher: toggle an existing panel, inject it on demand, or fall
 * back to an extension-owned window for protected/blank browser pages. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LgtActionLauncher = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PANEL_FILES = ['bonus-mock.js', 'bet-void-mock.js', 'bundle-navigation.js', 'content.js'];
  var STANDALONE_PATH = 'standalone.html';

  function sendPanelMessage(chromeApi, tabId, type) {
    return new Promise(function (resolve) {
      chromeApi.tabs.sendMessage(tabId, { type: type }, function (response) {
        resolve(!chromeApi.runtime.lastError && response && response.ok === true);
      });
    });
  }

  function sendToggle(chromeApi, tabId) {
    return sendPanelMessage(chromeApi, tabId, 'lgt-toggle-panel');
  }

  async function standaloneTabs(chromeApi) {
    return chromeApi.tabs.query({ url: chromeApi.runtime.getURL(STANDALONE_PATH) });
  }

  async function hideOtherInPagePanels(chromeApi, activeTabId, standaloneTabIds) {
    var tabs = await chromeApi.tabs.query({});
    var standaloneIds = new Set(standaloneTabIds || []);
    await Promise.all(tabs.map(async function (tab) {
      if (tab.id == null || tab.id === activeTabId || standaloneIds.has(tab.id)) return;
      await sendPanelMessage(chromeApi, tab.id, 'lgt-hide-panel');
    }));
  }

  async function closeStandaloneWindows(chromeApi, tabs, activeTabId) {
    var windowIds = [];
    (tabs || []).forEach(function (tab) {
      if (tab.id === activeTabId || tab.windowId == null || windowIds.includes(tab.windowId)) return;
      windowIds.push(tab.windowId);
    });
    for (const windowId of windowIds) await chromeApi.windows.remove(windowId);
  }

  async function activateInPagePanel(chromeApi, tabId) {
    var standalone = await standaloneTabs(chromeApi);
    await hideOtherInPagePanels(chromeApi, tabId, standalone.map(function (tab) { return tab.id; }));
    await closeStandaloneWindows(chromeApi, standalone, tabId);
  }

  async function openStandalone(chromeApi) {
    var url = chromeApi.runtime.getURL(STANDALONE_PATH);
    var existing = await standaloneTabs(chromeApi);
    await hideOtherInPagePanels(chromeApi, null, existing.map(function (tab) { return tab.id; }));
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
    if (await sendToggle(chromeApi, tab.id)) {
      await activateInPagePanel(chromeApi, tab.id);
      return { mode: 'toggled', tabId: tab.id };
    }

    try {
      await chromeApi.scripting.executeScript({ target: { tabId: tab.id }, files: PANEL_FILES });
      if (await sendToggle(chromeApi, tab.id)) {
        await activateInPagePanel(chromeApi, tab.id);
        return { mode: 'injected', tabId: tab.id };
      }
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
