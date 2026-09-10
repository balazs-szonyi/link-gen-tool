// Live regression for the Betsson Colombia market alias. Verifies that the
// extension exposes a distinct betsson.co option, auto-detects the .co host,
// and sends the Colombia segmentId while generating a sandbox link.
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const EXT_PATH = path.resolve(__dirname, 'extension');
const BOOKMARKLET_PATH = path.resolve(__dirname, 'link-gen-tool.js');
const TARGET_URL = 'https://www.test.betsson.co/';
const COLOMBIA_SEGMENT_ID = '1a68008c-4da6-4f77-acbc-0614cb030d7d';

async function testExtension() {
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), 'lgt-betsson-co-' + Date.now()),
    {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--no-first-run'
      ]
    }
  );

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });

    const page = await context.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: '*://*.betsson.co/*' });
      await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'lgt-toggle-panel' }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
    });

    const panel = page.locator('#lgt-panel');
    await panel.waitFor({ state: 'visible', timeout: 10000 });

    const detectedText = await panel.getByText(/Detected:/).first().textContent().catch(() => '');
    assert.match(detectedText || '', /Detected:\s*betssonco\s*\/\s*test/i, 'betsson.co hostname was not auto-detected');

    const brandSelect = panel.locator('select:visible').nth(0);
    const options = await brandSelect.locator('option').evaluateAll((nodes) =>
      nodes.map((node) => ({ value: node.value, text: node.textContent }))
    );
    assert.deepStrictEqual(
      options.find((option) => option.value === 'betssonco'),
      { value: 'betssonco', text: 'betsson.co' }
    );

    await brandSelect.selectOption('betssonco');
    await panel.locator('select:visible').nth(1).selectOption('test');
    await panel.locator('select:visible').nth(2).selectOption('out');
    // Each selector change refreshes the customer registry. Let the final
    // refresh settle before Generate so a slow VPN round-trip cannot make
    // this live smoke race its own superseded requests.
    await page.waitForTimeout(1000);

    const contextRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.hostname === 'internal.test.sbplayground1.net' && url.pathname.includes('/api/user-context/');
    }, { timeout: 60000 });

    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    const request = await contextRequest;
    const requestUrl = new URL(request.url());
    assert.strictEqual(requestUrl.searchParams.get('brand'), '6a6d80b9-16ac-4387-a413-244d93a74deb');
    assert.strictEqual(requestUrl.searchParams.get('segmentId'), COLOMBIA_SEGMENT_ID);

    const result = panel.locator('.lgt-result').first();
    await result.getByText(/d-cf\.test\.btsplayground\.net/i).first().waitFor({ timeout: 60000 });
    assert.match((await result.textContent()) || '', /d-cf\.test\.btsplayground\.net/i);

    await page.goto('https://www.test.betsson.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);
    await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: '*://*.betsson.com/*' });
      await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'lgt-toggle-panel' }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
    });
    const comDetectedText = await page.locator('#lgt-panel').getByText(/Detected:/).first().textContent();
    assert.match(comDetectedText || '', /Detected:\s*betsson\s*\/\s*test/i);
    assert.doesNotMatch(comDetectedText || '', /betssonco/i);

    console.log('PASS: extension generated the Colombia link and kept betsson.com detection separate.');
  } finally {
    await context.close();
  }
}

async function testBookmarklet() {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.addScriptTag({ path: BOOKMARKLET_PATH });

    const panel = page.locator('#lgt-panel');
    await panel.waitFor({ state: 'visible', timeout: 10000 });
    const brandSelect = panel.locator('select').nth(0);
    await brandSelect.selectOption('betssonco');
    await panel.locator('select').nth(1).selectOption('test');
    await panel.locator('select').nth(2).selectOption('out');
    await page.waitForTimeout(1000);

    const contextRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.hostname === 'internal.test.sbplayground1.net' && url.pathname.includes('/api/user-context/');
    }, { timeout: 60000 });

    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    const requestUrl = new URL((await contextRequest).url());
    assert.strictEqual(requestUrl.searchParams.get('segmentId'), COLOMBIA_SEGMENT_ID);
    await panel.locator('.lgt-result').getByText(/d-cf\.test\.btsplayground\.net/i).first().waitFor({ timeout: 60000 });

    await page.goto('https://www.test.betsson.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.addScriptTag({ path: BOOKMARKLET_PATH });
    const comDetectedText = await page.locator('#lgt-panel').getByText(/Detected:/).first().textContent();
    assert.match(comDetectedText || '', /Detected:\s*betsson\s*\/\s*test/i);
    assert.doesNotMatch(comDetectedText || '', /betssonco/i);

    console.log('PASS: bookmarklet generated the Colombia link and kept betsson.com detection separate.');
  } finally {
    await browser.close();
  }
}

async function main() {
  await testExtension();
  await testBookmarklet();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
