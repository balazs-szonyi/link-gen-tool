// Live regression: a generic sbplayground1 sandbox host has no brand in
// its hostname, but the Link Gen Tool must still resolve the loaded SB
// version from its startup config request plus the environment indexer.
'use strict';

const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const TARGET_URL = process.argv[2] || process.env.LGT_GENERIC_SANDBOX_URL;
if (!TARGET_URL) throw new Error('Pass a generic sandbox URL as the first argument or LGT_GENERIC_SANDBOX_URL.');

async function main() {
  const extensionPath = path.resolve(__dirname, 'extension');
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), 'lgt-generic-sandbox-version-' + Date.now()),
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
    const scriptUrls = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scriptUrls.push(request.url());
    });
    const initialUrl = new URL(TARGET_URL);
    initialUrl.searchParams.delete('exposeObgState');
    await page.goto(initialUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true });
      await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'lgt-toggle-panel' }, () => resolve());
      });
    });

    const label = page.locator('#lgt-panel .lgt-build-row > span').first();
    await label.waitFor({ state: 'visible', timeout: 10000 });
    const deadline = Date.now() + 20000;
    let text = '';
    while (Date.now() < deadline) {
      text = ((await label.textContent()) || '').trim();
      if (/^SB build: v\d+\.\d+\.\d+\.\d+[-\w]* \((desktop|mobile)\) \[[^,]+, QA\]$/.test(text)) break;
      await page.waitForTimeout(1000);
    }

    if (!/^SB build: v\d+\.\d+\.\d+\.\d+[-\w]* \((desktop|mobile)\) \[[^,]+, QA\]$/.test(text)) {
      throw new Error('Generic sandbox SB version was not resolved; header: ' + JSON.stringify(text) +
        ', final URL: ' + page.url() + ', scripts: ' + JSON.stringify(scriptUrls));
    }
    console.log('PASS: ' + text);

    await page.getByRole('button', { name: 'Verify with page state' }).click();
    const verifyResult = page.locator('#lgt-panel .lgt-build-verify');
    await verifyResult.getByText('Page-state verification needs exposeObgState=true', { exact: false }).waitFor();
    await verifyResult.getByRole('button', { name: 'Enable & reload' }).click();
    await page.waitForURL(/(?:\?|&)exposeObgState=true(?:&|$)/, { timeout: 30000 });
    await page.locator('#lgt-panel').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#lgt-panel .lgt-build-verify').getByText('Page state is exposed', { exact: false }).waitFor({ timeout: 15000 });
    console.log('PASS: Verify offered to enable page state, reloaded, and reported a visible result.');

    await page.getByRole('button', { name: 'Verify with page state' }).click();
    await page.locator('#lgt-panel .lgt-build-verify').getByText('Page state is exposed', { exact: false }).waitFor({ timeout: 10000 });
    console.log('PASS: Verify also reports a visible result when page state was already exposed manually.');
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
