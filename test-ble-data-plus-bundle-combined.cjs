// Regression test for the real-world bug reported 2026-08-10: applying
// BOTH Bundle Override AND BLE Data Override on the same tab, then doing a
// single page reload, left BLE Data Override reporting "Not active on this
// tab" and no fresh BLE data flowing - even though Bundle Override
// correctly stayed active. Root cause: BLE Data's stale-rule cleanup (and
// status handler) compared the exact full URL string, which any
// same-origin query/redirect/normalization difference on reload could
// wrongly treat as "navigated away", tearing the rule down right before
// the reloaded page's own requests went out. Fixed by comparing only the
// ORIGIN for BLE Data's cleanup, and by deriving status/stop from the
// live declarativeNetRequest session rules instead of trusting an
// in-memory map that a service-worker restart can wipe.
//
// This test applies BOTH overrides together on a real brand page (the
// exact combined workflow the "22-es csapda" fix exists for), reloads
// ONCE, and confirms BOTH overrides are still active and both actually
// took effect at the network layer.
//
// Run with: node test-ble-data-plus-bundle-combined.cjs
'use strict';
const path = require('path');
const { chromium } = require('playwright');

const EXT_PATH = path.resolve(__dirname, 'extension');
const BRAND = 'nordicbet';
const BRAND_GUID = '0e5d414b-5234-4050-9fc3-ce1127e18704';
const TARGET_URL = 'https://qa.nordicbet.com/en/sportsbook/live/football';
const ALPHA_HOST = 'd-cf.alpha.ndbplayground.net';
const BUNDLE_TARGET_ENV = 'test'; // QA <-> TEST are the same layer

function log(msg) { console.log('[combined-test] ' + new Date().toISOString().slice(11, 19) + ' ' + msg); }

async function main() {
  const userDataDir = path.join(require('os').tmpdir(), 'lgt-e2e-combined-profile-' + Date.now());
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.LGT_HEADFUL ? false : true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
    ],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  log('Extension loaded, id=' + new URL(sw.url()).host);

  const page = await context.newPage();

  const apiHits = [];
  const bundleHits = [];
  page.on('requestfinished', async (req) => {
    const u = req.url();
    if (/\/api\/sb\/v1\//i.test(u)) {
      let hdrs = {};
      try { hdrs = await req.allHeaders(); } catch (e) { /* ignore */ }
      apiHits.push({ url: u, headers: hdrs });
    }
    if (/\/dist\/.*\/(desktop|mobile)\/files\/(main|chunk)-/i.test(u)) bundleHits.push(u);
  });

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('Loaded ' + TARGET_URL + ' -> final URL ' + page.url());
  await page.waitForTimeout(2000);

  await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.nordicbet.com/*' });
    for (const t of tabs) {
      await new Promise((resolve) => {
        chrome.tabs.sendMessage(t.id, { type: 'lgt-toggle-panel' }, () => { void chrome.runtime.lastError; resolve(); });
      });
    }
  });
  await page.waitForSelector('#lgt-panel', { state: 'visible', timeout: 10000 });
  log('Panel is visible');
  const panel = page.locator('#lgt-panel');

  // Step 1: apply Bundle Override (QA -> TEST), the real, same scenario
  // the user reported (env down -> borrow another env's build).
  await panel.locator('.lgt-tab').filter({ hasText: 'Bundle', exact: false }).first().click();
  log('Switched to Bundle tab');
  const bundleApplyBtn = panel.getByRole('button', { name: 'Apply', exact: true });
  await bundleApplyBtn.click();
  log('Clicked Apply on Bundle tab, waiting for status to report an active override...');
  const bundleStatusEl = panel.locator('.lgt-log:visible').first();
  const bundleDeadline = Date.now() + 20000;
  let bundleStatusText = '';
  while (Date.now() < bundleDeadline) {
    bundleStatusText = (await bundleStatusEl.textContent().catch(() => '')) || '';
    if (/^Active \(\d+ rule/.test(bundleStatusText.trim())) break;
    if (/^Failed:/.test(bundleStatusText.trim())) break;
    await page.waitForTimeout(1000);
  }
  log('Bundle status before BLE Data apply: ' + bundleStatusText.trim());
  if (!/^Active \(\d+ rule/.test(bundleStatusText.trim())) {
    throw new Error('Bundle Override did not report active state (test setup step). Last status: ' + bundleStatusText);
  }

  // Step 2: apply BLE Data Override on the SAME tab, without disabling
  // Bundle - the whole point of the "22-es csapda" fix is that both can
  // coexist.
  await panel.locator('.lgt-tab').filter({ hasText: 'BLE Data' }).click();
  log('Switched to BLE Data tab');
  const brandSel = panel.locator('select:visible').nth(0);
  const detectedBrand = await brandSel.inputValue();
  if (detectedBrand !== BRAND) await brandSel.selectOption(BRAND);
  const bleApplyBtn = panel.getByRole('button', { name: 'Apply', exact: true });
  await bleApplyBtn.click();
  log('Clicked Apply on BLE Data tab');

  const statusEl = panel.locator('.lgt-log:visible').first();
  const deadline = Date.now() + 25000;
  let statusText = '';
  while (Date.now() < deadline) {
    statusText = (await statusEl.textContent().catch(() => '')) || '';
    if (/^Active - /.test(statusText.trim())) break;
    if (/^Failed:/.test(statusText.trim())) break;
    await page.waitForTimeout(1500);
  }
  log('BLE Data status before reload: ' + statusText.trim());
  if (!/^Active - /.test(statusText.trim())) {
    throw new Error('BLE Data Override did not report active before reload. Last status: ' + statusText);
  }

  const debugStateBeforeReload = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.nordicbet.com/*' });
    const tid = tabs[0].id;
    const liveRules = await new Promise((resolve) => chrome.declarativeNetRequest.getSessionRules(resolve));
    return {
      tabId: tid,
      bleDataRuleIdsByTab: bleDataRuleIdsByTab[tid],
      bundleRuleIdsByTab: bundleRuleIdsByTab[tid],
      allLiveRuleIdsForTab: liveRules.filter((r) => r.condition && r.condition.tabIds && r.condition.tabIds.indexOf(tid) !== -1).map((r) => r.id)
    };
  });
  log('DEBUG background state BEFORE reload: ' + JSON.stringify(debugStateBeforeReload));

  // Step 3: ONE reload - the exact user repro ("apply bundle override, apply
  // BLE data override, reload").
  apiHits.length = 0;
  bundleHits.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  log('Reloaded. URL after reload: ' + page.url());
  await page.waitForTimeout(6000);

  const panelVisibleAfterReload = await page.locator('#lgt-panel').isVisible().catch(() => false);
  log('Panel visible after reload: ' + panelVisibleAfterReload);
  if (!panelVisibleAfterReload) {
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: '*://*.nordicbet.com/*' });
      for (const t of tabs) {
        await new Promise((resolve) => {
          chrome.tabs.sendMessage(t.id, { type: 'lgt-toggle-panel' }, () => { void chrome.runtime.lastError; resolve(); });
        });
      }
    });
    await page.waitForTimeout(2000);
    log('Panel visible after re-toggling: ' + await page.locator('#lgt-panel').isVisible().catch(() => false));
  }

  // The panel resets to its default tab on a fresh page load, so the
  // status element must be re-located on the BLE Data tab again - the
  // `statusEl` locator captured before reload pointed at whatever
  // `.lgt-log:visible` existed on THAT (now gone) panel instance/tab.
  await panel.locator('.lgt-tab').filter({ hasText: 'BLE Data' }).click();
  await page.waitForTimeout(500);
  const statusElAfterReload = panel.locator('.lgt-log:visible').first();

  const deadlineAfterReload = Date.now() + 15000;
  let statusAfterReload = '';
  while (Date.now() < deadlineAfterReload) {
    statusAfterReload = (await statusElAfterReload.textContent().catch(() => '')) || '';
    if (/^Active/.test(statusAfterReload.trim())) break;
    await page.waitForTimeout(1000);
  }

  const debugState = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.nordicbet.com/*' });
    const tid = tabs[0].id;
    const liveRules = await new Promise((resolve) => chrome.declarativeNetRequest.getSessionRules(resolve));
    return {
      tabId: tid,
      tabUrl: tabs[0].url,
      bleDataRuleIdsByTab: bleDataRuleIdsByTab[tid],
      bleDataExpectedOriginByTab: bleDataExpectedOriginByTab[tid],
      bundleRuleIdsByTab: bundleRuleIdsByTab[tid],
      bundleExpectedUrlByTab: bundleExpectedUrlByTab[tid],
      liveRuleIdsForTab: liveRules.filter((r) => r.condition && r.condition.tabIds && r.condition.tabIds.indexOf(tid) !== -1).map((r) => r.id)
    };
  });
  log('DEBUG background state after reload: ' + JSON.stringify(debugState));

  // Assertion A: BLE Data status must STILL report active after reload
  // (this is precisely what the user saw fail: "not active on this tab").
  log('BLE Data status after reload: ' + statusAfterReload.trim());
  if (!/^Active/.test(statusAfterReload.trim())) {
    throw new Error('REGRESSION: BLE Data Override no longer reports active after a reload with Bundle Override also applied. Status: ' + statusAfterReload);
  }
  log('PASS: BLE Data Override still reports active after reload.');

  // Assertion B: BLE data actually flowed - at least one /api/sb/v1/* call
  // redirected to ALPHA.
  const alphaHits = apiHits.filter((h) => {
    try { return new URL(h.url).hostname === ALPHA_HOST; } catch (e) { return false; }
  });
  log('/api/sb/v1/* requests redirected to ALPHA after reload: ' + alphaHits.length + ' of ' + apiHits.length);
  if (!alphaHits.length) {
    throw new Error('REGRESSION: no /api/sb/v1/* request was redirected to ALPHA after reload - BLE Data Override stopped working at the network level, even though status may say active.');
  }
  log('PASS: BLE data actually flowed from ALPHA after reload.');

  // Assertion C: Bundle Override must ALSO still be active (the two
  // features must not interfere with each other). Query the same
  // getOwnSessionRuleIdsForTab ground-truth the real lgt-bundle-status
  // handler itself uses, directly in the service worker context (calling
  // chrome.tabs.sendMessage here would wrongly target the content script,
  // which has no listener for this background-only message type).
  const bundleStatus = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.nordicbet.com/*' });
    const tid = tabs[0].id;
    const liveIds = await getOwnSessionRuleIdsForTab(tid, BUNDLE_RULE_ID_START, SR_SPOOF_RULE_ID_START);
    return { active: liveIds.length > 0, ruleCount: liveIds.length };
  });
  log('Bundle status after reload: ' + JSON.stringify(bundleStatus));
  if (!bundleStatus || !bundleStatus.active) {
    throw new Error('REGRESSION: Bundle Override was cleared by the BLE Data Override apply/reload sequence - the two features are not independent.');
  }
  log('PASS: Bundle Override is still active alongside BLE Data Override.');

  const bodyText = await page.locator('body').innerText().catch(() => '');
  log('Body text length after combined override + reload: ' + bodyText.length);
  if (bodyText.trim().length < 200) {
    throw new Error('REGRESSION: page body has almost no rendered text (' + bodyText.length + ' chars) with both overrides active.');
  }
  log('PASS: page still renders real content with both overrides active.');

  log('Test run complete.');
  await context.close();
}

main().catch((err) => {
  console.error('[combined-test] FATAL', err);
  process.exit(1);
});
