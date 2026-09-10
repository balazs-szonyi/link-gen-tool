// Deterministic Chrome-extension UI regression for Local Links and touch drag.
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const EXT_PATH = path.resolve(__dirname, 'extension');
const BOOKMARKLET_PATH = path.resolve(__dirname, 'link-gen-tool.js');
const COLOMBIA_SEGMENT_ID = '1a68008c-4da6-4f77-acbc-0614cb030d7d';

const contextFixture = {
  data: {
    user: {
      desktop: { iFrameSetup: { overrideIFrameBaseUrlWith: 'https://d-cf.test.btsplayground.net' } },
      mobile: { iFrameSetup: { overrideIFrameBaseUrlWith: 'https://m-cf.test.btsplayground.net' } }
    },
    context: {
      desktop: {
        responseCode: 100,
        customerContext: { staticContextId: 'stc-generic-d', userContextId: 'ctx-generic-d' },
        iFrameHelper: { baseUri: 'https://d-cf.test.btsplayground.net' }
      },
      mobile: {
        responseCode: 100,
        customerContext: { staticContextId: 'stc-generic-m', userContextId: 'ctx-generic-m' },
        iFrameHelper: { baseUri: 'https://m-cf.test.btsplayground.net' }
      },
      'Betsson.co Desktop': {
        responseCode: 100,
        customerContext: { staticContextId: 'stc-co-d', userContextId: 'ctx-co-d' },
        iFrameHelper: { baseUri: 'https://d-cf.test.btsplayground.net' }
      },
      'Betsson.co Mobile': {
        responseCode: 100,
        customerContext: { staticContextId: 'stc-co-m', userContextId: 'ctx-co-m' },
        iFrameHelper: { baseUri: 'https://m-cf.test.btsplayground.net' }
      },
      'Betsson.pe Desktop': {
        responseCode: 100,
        customerContext: { staticContextId: 'stc-pe-d', userContextId: 'ctx-pe-d' },
        iFrameHelper: { baseUri: 'https://d-cf.test.btsplayground.net' }
      }
    }
  }
};

async function testExtension() {
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), 'lgt-local-links-' + Date.now()),
    {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 900 },
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

    await page.route('https://internal.test.sbplayground1.net/api/customers/**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        'logged-out-en-eur-mga-restofworld': { label: 'Logged out' }
      })
    }));
    let userContextUrl = null;
    await page.route('https://internal.test.sbplayground1.net/api/user-context/**', (route) => {
      userContextUrl = route.request().url();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(contextFixture) });
    });

    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://example.com/*' });
      await new Promise((resolve) => chrome.tabs.sendMessage(tabs[0].id, { type: 'lgt-toggle-panel' }, () => resolve()));
    });

    const panel = page.locator('#lgt-panel');
    await panel.waitFor({ state: 'visible' });
    await panel.locator('select:visible').nth(0).selectOption('betssonco');
    await panel.locator('select:visible').nth(1).selectOption('test');
    await panel.locator('select:visible').nth(2).selectOption('out');

    const localToggle = panel.locator('label').filter({ hasText: /^\s*Local links\s*$/ }).locator('input');
    await localToggle.check();
    const localPanel = page.locator('#lgt-local-links-panel');
    await localPanel.waitFor({ state: 'visible' });

    const initialMainRect = await panel.boundingBox();
    const initialLocalRect = await localPanel.boundingBox();
    assert(initialMainRect && initialLocalRect);
    assert(initialLocalRect.x + initialLocalRect.width <= initialMainRect.x, 'Local Links did not dock to the left of the main panel');

    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await localPanel.getByText('http://test.betsson.local:4200/stc-co-d/ctx-co-d', { exact: true }).waitFor();
    await localPanel.getByText('http://test.betsson.local:8085/stc-co-m/ctx-co-m', { exact: true }).waitFor();
    await localPanel.getByText('http://test.betsson.local:4200?staticContext=stc-co-d&userContext=ctx-co-d', { exact: true }).waitFor();
    assert(!((await localPanel.textContent()) || '').includes('stc-pe-d'), 'Another market leaked into betsson.co local links');
    assert(userContextUrl, 'No user-context request was made');
    assert.strictEqual(new URL(userContextUrl).searchParams.get('segmentId'), COLOMBIA_SEGMENT_ID);

    const mainResultText = (await panel.locator('.lgt-result').first().textContent()) || '';
    assert(mainResultText.includes('/stc-co-d/ctx-co-d/'), 'Desktop link did not use the named Betsson.co context');
    assert(mainResultText.includes('/stc-co-m/ctx-co-m/'), 'Mobile link did not use the named Betsson.co context');
    assert(!mainResultText.includes('stc-generic'), 'Generic Betsson context leaked into the Betsson.co links');

    await localPanel.locator('.lgt-min').click();
    assert.strictEqual(await localPanel.locator('.lgt-local-content').evaluate((el) => getComputedStyle(el).display), 'none');
    await localPanel.locator('.lgt-min').click();

    const mainBeforeLocalDrag = await panel.boundingBox();
    const localBeforeDrag = await localPanel.boundingBox();
    const localHeader = localPanel.locator('h3');
    await localHeader.dispatchEvent('pointerdown', {
      pointerId: 41, pointerType: 'mouse', button: 0,
      clientX: localBeforeDrag.x + 30, clientY: localBeforeDrag.y + 15
    });
    await localHeader.dispatchEvent('pointermove', {
      pointerId: 41, pointerType: 'mouse', button: 0,
      clientX: localBeforeDrag.x + 80, clientY: localBeforeDrag.y + 55
    });
    await localHeader.dispatchEvent('pointerup', { pointerId: 41, pointerType: 'mouse', button: 0 });
    const localAfterDrag = await localPanel.boundingBox();
    const mainAfterLocalDrag = await panel.boundingBox();
    assert(localAfterDrag.x !== localBeforeDrag.x || localAfterDrag.y !== localBeforeDrag.y, 'Local Links panel did not move independently');
    assert.deepStrictEqual(mainAfterLocalDrag, mainBeforeLocalDrag, 'Dragging Local Links moved the main panel');

    await localPanel.locator('.lgt-close').click();
    await localPanel.waitFor({ state: 'hidden' });
    assert.strictEqual(await localToggle.isChecked(), false, 'Closing Local Links did not turn its toggle off');

    await page.setViewportSize({ width: 390, height: 844 });
    await localToggle.click();
    assert.strictEqual(await localToggle.isChecked(), false, 'Local Links remained enabled in a mobile viewport');
    await panel.getByText('Local Links: only in desktop viewport.', { exact: true }).waitFor();

    const mainBeforeTouchDrag = await panel.boundingBox();
    const mainHeader = panel.locator('h3').first();
    assert.strictEqual(await mainHeader.evaluate((el) => getComputedStyle(el).touchAction), 'none');
    await mainHeader.dispatchEvent('pointerdown', {
      pointerId: 77, pointerType: 'touch', button: 0,
      clientX: mainBeforeTouchDrag.x + 30, clientY: mainBeforeTouchDrag.y + 15
    });
    await mainHeader.dispatchEvent('pointermove', {
      pointerId: 77, pointerType: 'touch', button: 0,
      clientX: mainBeforeTouchDrag.x + 10, clientY: mainBeforeTouchDrag.y + 95
    });
    await mainHeader.dispatchEvent('pointerup', { pointerId: 77, pointerType: 'touch', button: 0 });
    const mainAfterTouchDrag = await panel.boundingBox();
    assert(mainAfterTouchDrag.y > mainBeforeTouchDrag.y + 40, 'Touch pointer did not drag the main panel');

    console.log('PASS: Local Links dock/render/minimize/drag/close/mobile guard and touch drag all work.');
  } finally {
    await context.close();
  }
}

async function testBookmarklet() {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route('https://internal.test.sbplayground1.net/api/customers/**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ 'logged-out-en-eur-mga-restofworld': { label: 'Logged out' } })
    }));
    await page.route('https://internal.test.sbplayground1.net/api/user-context/**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(contextFixture)
    }));
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ path: BOOKMARKLET_PATH });

    const panel = page.locator('#lgt-panel');
    await panel.locator('select').nth(0).selectOption('betssonco');
    await panel.locator('select').nth(1).selectOption('test');
    await panel.locator('select').nth(2).selectOption('out');
    const localToggle = panel.locator('label').filter({ hasText: /^\s*Local links\s*$/ }).locator('input');
    await localToggle.check();
    const localPanel = page.locator('#lgt-local-links-panel');
    await localPanel.waitFor({ state: 'visible' });
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await localPanel.getByText('http://test.betsson.local:4200/stc-co-d/ctx-co-d', { exact: true }).waitFor();
    await localPanel.getByText('http://test.betsson.local:8085?staticContext=stc-co-m&userContext=ctx-co-m', { exact: true }).waitFor();
    const resultText = (await panel.locator('.lgt-result').first().textContent()) || '';
    assert(resultText.includes('/stc-co-d/ctx-co-d/'));
    assert(resultText.includes('/stc-co-m/ctx-co-m/'));

    await localPanel.locator('.lgt-min').click();
    assert.strictEqual(await localPanel.locator('.lgt-local-content').evaluate((el) => getComputedStyle(el).display), 'none');
    await localPanel.locator('.lgt-min').click();
    await localPanel.locator('.lgt-close').click();
    assert.strictEqual(await localToggle.isChecked(), false);

    await page.setViewportSize({ width: 390, height: 844 });
    await localToggle.click();
    assert.strictEqual(await localToggle.isChecked(), false);
    await panel.getByText('Local Links: only in desktop viewport.', { exact: true }).waitFor();

    const before = await panel.boundingBox();
    const header = panel.locator('h3').first();
    assert.strictEqual(await header.evaluate((el) => getComputedStyle(el).touchAction), 'none');
    await header.dispatchEvent('pointerdown', {
      pointerId: 88, pointerType: 'touch', button: 0,
      clientX: before.x + 30, clientY: before.y + 15
    });
    await header.dispatchEvent('pointermove', {
      pointerId: 88, pointerType: 'touch', button: 0,
      clientX: before.x + 10, clientY: before.y + 95
    });
    await header.dispatchEvent('pointerup', { pointerId: 88, pointerType: 'touch', button: 0 });
    const after = await panel.boundingBox();
    assert(after.y > before.y + 40, 'Bookmarklet touch pointer did not drag the main panel');

    console.log('PASS: bookmarklet Local Links and touch drag work.');
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
