'use strict';

const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

const manifest = require('./extension/manifest.json');

const TARGET_URL = process.argv[2] ||
  'https://www.test.spino.com/en/sportsbook?exposeObgState=true&exposeObgRt=true&sealStore=false';

async function main() {
  const extensionPath = path.resolve(__dirname, 'extension');
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), `lgt-spino-${Date.now()}`),
    {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
      ],
    },
  );

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    }

    const page = await context.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const panel = page.locator('#lgt-panel');
    await panel.waitFor({ state: 'attached', timeout: 15000 });

    await serviceWorker.evaluate(async (targetUrl) => {
      const tabs = await chrome.tabs.query({ url: `${new URL(targetUrl).origin}/*` });
      const target = tabs.find((tab) => tab.url === targetUrl) || tabs[0];
      if (!target) throw new Error(`No extension-visible tab found for ${targetUrl}`);

      await new Promise((resolve) => {
        chrome.tabs.sendMessage(target.id, { type: 'lgt-toggle-panel' }, () => {
          // The toggle listener is intentionally fire-and-forget and does
          // not call sendResponse. Chrome may therefore set lastError to
          // "message port closed" even though the content script handled
          // the message; panel visibility below is the authoritative check.
          void chrome.runtime.lastError;
          resolve();
        });
      });
    }, page.url());

    await panel.waitFor({ state: 'visible', timeout: 10000 });
    await panel.getByRole('tab', { name: 'Bundle' }).click();

    const detectedBrand = await page.locator('#lgt-body-bundle select').first().inputValue();
    if (detectedBrand !== 'spino') {
      throw new Error(`Expected Spino brand detection, got ${JSON.stringify(detectedBrand)}`);
    }

    const title = ((await panel.locator('h3').first().textContent()) || '').trim();
    if (!title.includes(`v${manifest.version}`)) {
      throw new Error(`Expected panel version v${manifest.version}, got ${JSON.stringify(title)}`);
    }

    console.log(`PASS: Link Gen Tool ${title} opened on ${page.url()} and detected Spino.`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
