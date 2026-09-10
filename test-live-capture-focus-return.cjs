// Regression test for: "if the link-gen-tool panel's tab isn't the most
// recently opened tab, after a live capture/login the browser doesn't
// jump back to the tool's own tab" (reported 2026-09-10). The fix tracks
// the ORIGIN tab (the tab that requested the job) explicitly in
// background.js and re-focuses it when the job's tab closes via
// lgt-close-tab, instead of relying on Chrome's own "which tab becomes
// active when this one closes" heuristic. This test forces the VISIBLE
// job-tab path (the only path that ever steals focus in the first place -
// the silent/minimized-window path never takes focus away from the
// origin tab to begin with) via the "Show login tab" checkbox, opens
// several other tabs AFTER the origin tab so it is provably not the
// most-recently-opened one, and asserts the origin tab is active again
// once the job completes.
//
// Run with: node test-live-capture-focus-return.cjs
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
    path.join(os.tmpdir(), 'lgt-focus-return-' + Date.now()),
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

    // 1) The origin tab - opened FIRST.
    const originPage = await context.newPage();
    await originPage.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await originPage.waitForTimeout(1000);

    // 2) Two more tabs opened AFTER the origin tab, so the origin tab is
    // provably not "the most recently opened one" by the time the job runs.
    const otherPage1 = await context.newPage();
    await otherPage1.goto('about:blank');
    const otherPage2 = await context.newPage();
    await otherPage2.goto('about:blank');
    log('Opened 2 extra tabs after the origin tab.');

    // Bring the origin tab back to the front - this is the tab the user
    // is actually looking at and clicking Generate on.
    await originPage.bringToFront();
    await originPage.waitForTimeout(300);

    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: '*://*.betsson.co/*' });
      await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'lgt-toggle-panel' }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
    });

    const panel = originPage.locator('#lgt-panel');
    await panel.waitFor({ state: 'visible', timeout: 10000 });

    await panel.locator('select:visible').nth(0).selectOption('betssonco');
    await panel.locator('select:visible').nth(1).selectOption('test');
    await panel.locator('select:visible').nth(2).selectOption('out');
    await originPage.waitForTimeout(1500);

    // Force the VISIBLE job-tab path - this is the only path that ever
    // takes focus away from the origin tab (the silent/minimized-window
    // path never does), so it's the only path where a "return to origin"
    // bug could ever manifest.
    const showLoginTabChk = panel.getByText(/Show login tab/i).locator('xpath=preceding-sibling::input[1]');
    if (await showLoginTabChk.count()) { await showLoginTabChk.check(); }

    const selects = panel.locator('select:visible');
    const count = await selects.count();
    let customerSelect = null;
    for (let i = 0; i < count; i++) {
      const optTexts = await selects.nth(i).locator('option').allTextContents();
      if (optTexts.some((t) => /live capture/i.test(t))) { customerSelect = selects.nth(i); break; }
    }
    assert(customerSelect, 'CO live-capture Customer option not found');
    await customerSelect.selectOption('__betssonco_co_live_passive__');

    const desktopBtn = panel.getByRole('button', { name: 'Generate Desktop', exact: true });
    const singleBtn = panel.getByRole('button', { name: 'Generate', exact: true });
    const clickTarget = (await desktopBtn.isVisible().catch(() => false)) ? desktopBtn : singleBtn;

    const newTabPromise = context.waitForEvent('page', { timeout: 30000 });
    await clickTarget.click();
    log('Clicked Generate - waiting for the job tab to open...');
    const jobPage = await newTabPromise;
    log('Job tab opened: ' + jobPage.url());

    // Wait for the job tab to close again (job succeeded, closeThisTab ran).
    await jobPage.waitForEvent('close', { timeout: 60000 });
    log('Job tab closed.');
    await originPage.waitForTimeout(500);

    const activeTabInfo = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tabs && tabs[0] ? { url: tabs[0].url, id: tabs[0].id } : null;
    });
    log('Active tab after job closed: ' + JSON.stringify(activeTabInfo));

    assert(activeTabInfo, 'no active tab found');
    assert.match(activeTabInfo.url, /betsson\.co/i, 'active tab after the job closed was not the origin (betsson.co) tab - focus-return regression!');

    console.log('PASS: focus correctly returned to the origin tab after the live capture job closed.');
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
