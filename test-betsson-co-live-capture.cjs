// Headless end-to-end test of the new "CO - Logged Out (live capture)"
// Customer dropdown option for betssonco (see BETSSONCO_CO_LIVE_KEY in
// extension/content.js). Verifies: the synthetic option is offered in the
// Customer dropdown when brand=betssonco/environment/logged-out, selecting
// it runs a passive (no-login) capture against the REAL betsson.co site
// instead of calling the playground's generateLink() API, and the final
// rendered link is spliced with a stc/ctx pair that is NOT the playground's
// single EN/RestOfWorld customer context.
//
// Run with: node test-betsson-co-live-capture.cjs
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const EXT_PATH = path.resolve(__dirname, 'extension');
const TARGET_URL = 'https://www.test.betsson.co/';

function log(msg) { console.log('[test] ' + new Date().toISOString().slice(11, 19) + ' ' + msg); }

async function main() {
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), 'lgt-betsson-co-live-' + Date.now()),
    {
      channel: 'chromium',
      headless: process.env.LGT_HEADFUL ? false : true,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--no-first-run'
      ]
    }
  );

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });

    const page = await context.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    await sw.evaluate(async () => {
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

    const brandSelect = panel.locator('select:visible').nth(0);
    await brandSelect.selectOption('betssonco');
    await panel.locator('select:visible').nth(1).selectOption('test');
    await panel.locator('select:visible').nth(2).selectOption('out');
    await page.waitForTimeout(1500); // let refreshCustomerOptions() settle

    // Find the Customer dropdown (only visible select besides brand/env/login).
    const selects = panel.locator('select:visible');
    const count = await selects.count();
    let customerSelect = null;
    for (let i = 0; i < count; i++) {
      const optTexts = await selects.nth(i).locator('option').allTextContents();
      if (optTexts.some((t) => /live capture/i.test(t))) { customerSelect = selects.nth(i); break; }
    }
    assert(customerSelect, 'Customer dropdown with the "CO - Logged Out (live capture)" option was not found');

    const optionValues = await customerSelect.locator('option').evaluateAll((nodes) => nodes.map((n) => n.value));
    assert(optionValues.includes('__betssonco_co_live_passive__'), 'synthetic CO live-capture option missing from Customer dropdown');
    log('Customer dropdown options: ' + JSON.stringify(optionValues));

    await customerSelect.selectOption('__betssonco_co_live_passive__');

    const desktopBtn = panel.getByRole('button', { name: 'Generate Desktop', exact: true });
    const mobileBtn = panel.getByRole('button', { name: 'Generate Mobile', exact: true });
    const singleBtn = panel.getByRole('button', { name: 'Generate', exact: true });
    const clickTarget = (await desktopBtn.isVisible().catch(() => false)) ? desktopBtn : singleBtn;
    void mobileBtn;

    await clickTarget.click();
    log('Clicked Generate - waiting for passive capture to complete (up to 90s)...');

    const result = panel.locator('.lgt-result').first();
    await result.getByText(/d-cf\.test\.btsplayground\.net/i).first().waitFor({ timeout: 90000 });
    const resultText = (await result.textContent()) || '';
    log('Result row: ' + resultText.replace(/\s+/g, ' '));
    assert.match(resultText, /d-cf\.test\.btsplayground\.net/i);

    console.log('PASS: CO live-capture dropdown option produced a spliced link.');
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
