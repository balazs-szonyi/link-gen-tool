'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const VERSION = '8.2.3.4918-re0ade7b';
const PAGE_URL = 'https://d-cf.qa.sbplayground1.net/state-verification/?exposeObgState=true';

async function main() {
  const extensionPath = path.resolve(__dirname, 'extension');
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), 'lgt-page-state-' + Date.now()),
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
    await context.route('https://d-cf.qa.sbplayground1.net/**', async (route) => {
      if (route.request().url() === PAGE_URL) {
        await route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>State verification fixture</title>' +
            '<script>window.xSbState={appContext:{version:' + JSON.stringify(VERSION) +
            ',environment:"qa"},sportsbook:{}};</script><main>fixture</main>',
        });
        return;
      }
      await route.abort();
    });

    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const page = await context.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(500);

    await serviceWorker.evaluate(async (version) => {
      const tabs = await chrome.tabs.query({ active: true });
      bundleObservedByTab[tabs[0].id] = {
        shape: 'sandbox',
        brand: 'firestorm',
        version,
        device: 'desktop',
        hostEnv: 'qa',
        host: 'd-cf.qa.sbplayground1.net',
        url: 'https://d-cf.qa.sbplayground1.net/assets/main-fixture.js',
        ts: Date.now(),
      };
      await new Promise((resolve) => chrome.tabs.sendMessage(tabs[0].id, { type: 'lgt-toggle-panel' }, resolve));
    }, VERSION);

    const panel = page.locator('#lgt-panel');
    await panel.waitFor({ state: 'visible', timeout: 10000 });
    await panel.locator('.lgt-build-row > span').first().getByText('SB build: v' + VERSION, { exact: false }).waitFor({ timeout: 10000 });
    await panel.getByRole('button', { name: 'Verify with page state' }).click();
    const result = panel.locator('.lgt-build-verify');
    await result.getByText('Page state confirms both', { exact: false }).waitFor({ timeout: 10000 });
    const successText = await result.innerText();
    assert.match(successText, new RegExp('version=v' + VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' environment=QA'));
    assert.match(successText, /confirms both the network-detected SB version and environment/);

    await page.evaluate(() => {
      window.xSbState.appContext.version = '0.0.0-wrong';
      window.xSbState.appContext.environment = 'alpha';
    });
    await panel.getByRole('button', { name: 'Verify with page state' }).click();
    await result.getByText('does not match network version', { exact: false }).waitFor({ timeout: 10000 });
    const mismatchText = await result.innerText();
    assert.match(mismatchText, /does not match network version/);
    assert.match(mismatchText, /does not match network environment QA/);
    assert.doesNotMatch(mismatchText, /confirms both/);

    console.log('PASS: xSbState.appContext version/environment are extracted and both must match the network observation.');
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
