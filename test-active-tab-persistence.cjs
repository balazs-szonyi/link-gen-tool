// Regression test: reloading a page must keep the Link Gen Tool panel on
// the tab the user selected instead of resetting it to Generate.
'use strict';

const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

async function main() {
  const extensionPath = path.resolve(__dirname, 'extension');
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), 'lgt-active-tab-' + Date.now()),
    {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
      ],
    }
  );

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });

    const page = await context.newPage();
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://example.com/*' });
      await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'lgt-toggle-panel' }, () => resolve());
      });
    });

    const panel = page.locator('#lgt-panel');
    await panel.waitFor({ state: 'visible', timeout: 10000 });
    await panel.locator('.lgt-tab').filter({ hasText: 'Bundle' }).click();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await panel.waitFor({ state: 'visible', timeout: 10000 });

    const activeTab = ((await panel.locator('.lgt-tab.active').textContent()) || '').trim();
    if (activeTab !== 'Bundle') {
      throw new Error('Expected Bundle after reload, got ' + JSON.stringify(activeTab));
    }
    console.log('PASS: Bundle remains active after page reload.');
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
