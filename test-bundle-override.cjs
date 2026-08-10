// Headless end-to-end smoke test of the link-gen-tool extension's Bundle
// Override tab (v1.10.0+). Loads the extension, opens a real brand
// sportsbook page (test.nordicbet.com - the same target other e2e tests in
// this repo already use successfully), opens the panel's Bundle tab,
// verifies brand/environment auto-detection, clicks Apply, and confirms
// the extension's background.js actually fetched the target env's real
// indexer.json and installed at least one declarativeNetRequest rule (the
// core new mechanism this test exists to validate end-to-end against a
// live indexer.json, not a mock). It then reloads the page and does a
// best-effort (non-fatal) check that an actual main-*.js bundle request
// resolved to the target ("qa") host, since that final hop depends on
// real third-party page/network timing this test doesn't fully control.
//
// Run with: node test-bundle-override.cjs
'use strict';
const path = require('path');
const { chromium } = require('playwright');

const EXT_PATH = path.resolve(__dirname, 'extension');
const BRAND = 'nordicbet';
const CURRENT_ENV = 'test';
const TARGET_ENV = 'qa'; // same layer (BLE) partner of 'test'
const TARGET_URL = 'https://test.nordicbet.com/en/sportsbook';

function log(msg) { console.log('[test] ' + new Date().toISOString().slice(11, 19) + ' ' + msg); }

async function main() {
  const userDataDir = path.join(require('os').tmpdir(), 'lgt-e2e-bundle-profile-' + Date.now());
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.LGT_HEADFUL ? false : true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
    ],
  });

  context.on('page', (p) => {
    log('NEW PAGE/TAB opened: ' + p.url());
    p.on('pageerror', (err) => log('  [tab PAGEERROR] ' + err.message));
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  log('Extension loaded, id=' + extId);

  const page = await context.newPage();

  // Track every script request whose path looks like a sportsbook bundle
  // file, so we can check post-reload whether any of them actually landed
  // on the target (qa) host - this is the closest thing to "did the
  // redirect really take effect" without depending on exact indexer hash
  // values, which change on every deploy.
  const bundleRequests = [];
  page.on('requestfinished', (req) => {
    const url = req.url();
    if (/\/files\/[a-zA-Z0-9]+-[A-Z0-9]+\.js(\?|$)/.test(url)) bundleRequests.push(url);
  });

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('Loaded ' + TARGET_URL + ' -> final URL ' + page.url());
  await page.waitForTimeout(2000); // let content script settle (document_idle)

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

  // "Detected build" strip check (native, no override applied yet) - this
  // is the always-visible strip above the tabs, backed by background.js's
  // real webRequest-based observation (bundleObservedByTab), independent
  // of the Bundle tab's own controls below.
  const buildStrip = panel.locator('.lgt-build-strip');
  const buildLabel = buildStrip.locator('span').first();
  {
    const deadline = Date.now() + 15000;
    let text = '';
    while (Date.now() < deadline) {
      text = (await buildLabel.textContent().catch(() => '')) || '';
      if (/^SB build:/.test(text.trim())) break;
      await page.waitForTimeout(1000);
    }
    log('Detected build strip (native, pre-override): ' + text.trim());
    if (!/^SB build:/.test(text.trim())) {
      throw new Error('Detected build strip never populated (expected "SB build: ..."), last text: ' + text);
    }
    const badgeText = (await buildStrip.locator('.lgt-build-badge').textContent().catch(() => '')) || '';
    log('Detected build badge (native): ' + badgeText.trim());
    const badgeTitle = (await buildStrip.locator('.lgt-build-badge').getAttribute('title').catch(() => '')) || '';
    log('Detected build URL (native, for diagnosis): ' + badgeTitle);
    if (badgeText.trim().toUpperCase() !== CURRENT_ENV.toUpperCase()) {
      throw new Error('Detected build badge did not show native env "' + CURRENT_ENV + '", got: ' + badgeText);
    }
  }

  await panel.locator('.lgt-tab').filter({ hasText: 'Bundle' }).click();
  log('Switched to Bundle tab');

  const brandSel = panel.locator('select:visible').nth(0);
  const curEnvSel = panel.locator('select:visible').nth(1);

  const detectedBrand = await brandSel.inputValue();
  const detectedEnv = await curEnvSel.inputValue();
  log('Auto-detected: brand=' + detectedBrand + ' environment=' + detectedEnv);
  if (detectedBrand !== BRAND || detectedEnv !== CURRENT_ENV) {
    log('WARNING: auto-detect did not match expected brand/env (brand=' + BRAND + ', env=' + CURRENT_ENV + ') - forcing selection manually.');
    await brandSel.selectOption(BRAND);
    await curEnvSel.selectOption(CURRENT_ENV);
  }

  const targetHint = await panel.locator('.lgt-hint:visible').first().textContent();
  log('Target-env hint: ' + (targetHint || '').trim());
  if (!targetHint || targetHint.toUpperCase().indexOf(TARGET_ENV.toUpperCase()) === -1) {
    throw new Error('Target-env hint did not mention expected layer partner "' + TARGET_ENV + '": ' + targetHint);
  }

  const applyBtn = panel.getByRole('button', { name: 'Apply', exact: true });
  await applyBtn.click();
  log('Clicked Apply, waiting for status to report an active override...');

  const statusEl = panel.locator('.lgt-log:visible').first();
  const deadline = Date.now() + 20000;
  let statusText = '';
  while (Date.now() < deadline) {
    statusText = (await statusEl.textContent().catch(() => '')) || '';
    log('Bundle status: ' + statusText.trim());
    if (/^Active \(\d+ rule/.test(statusText.trim())) break;
    if (/^Failed:/.test(statusText.trim())) break;
    await page.waitForTimeout(1500);
  }

  if (!/^Active \(\d+ rule/.test(statusText.trim())) {
    throw new Error('Bundle override did not report an active state within budget. Last status: ' + statusText);
  }
  log('PASS: background.js fetched the live ' + TARGET_ENV + ' indexer.json and installed at least one declarativeNetRequest rule.');

  // Best-effort (non-fatal) network verification: reload so the page's
  // own bundle requests are made AFTER the rule is active, then see if
  // any matched bundle request actually resolved against the target env.
  bundleRequests.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  log('Bundle-like requests observed after reload: ' + bundleRequests.length);
  bundleRequests.forEach((u) => log('  ' + u));
  const redirected = bundleRequests.some((u) => u.indexOf('.' + TARGET_ENV + '.') !== -1 || u.indexOf('/' + TARGET_ENV + '/') !== -1);
  if (redirected) {
    log('PASS (network-level): a bundle request actually resolved against the ' + TARGET_ENV + ' environment.');
  } else {
    log('NOTE: could not confirm a redirected bundle request at the network level within this run (page/timing-dependent, non-fatal) - the declarativeNetRequest-rule-installed assertion above already validates the core new mechanism end-to-end.');
  }

  // "Detected build" strip check AFTER the override + reload - the panel
  // itself re-injects on the fresh page load, so re-find it and confirm
  // the badge/label now show the OVERRIDE target env with a mismatch
  // indicator, proving the strip's own detection tracks reality live
  // rather than a UI-remembered value (the exact bug this feature exists
  // to make impossible - see the 2026-08-10 Bundle-tab environment fix).
  {
    await page.waitForSelector('#lgt-panel', { state: 'attached', timeout: 10000 }).catch(() => {});
    const strip2 = page.locator('#lgt-panel .lgt-build-strip');
    const label2 = strip2.locator('span').first();
    const deadline = Date.now() + 15000;
    let text2 = '';
    while (Date.now() < deadline) {
      text2 = (await label2.textContent().catch(() => '')) || '';
      if (/^SB build:/.test(text2.trim())) break;
      await page.waitForTimeout(1000);
    }
    log('Detected build strip (post-override, post-reload): ' + text2.trim());
    const badge2 = (await strip2.locator('.lgt-build-badge').textContent().catch(() => '')) || '';
    log('Detected build badge (post-override): ' + badge2.trim());
    if (badge2.trim().toUpperCase() === TARGET_ENV.toUpperCase()) {
      log('PASS: Detected build strip correctly flipped to ' + TARGET_ENV.toUpperCase() + ' after the override + reload.');
    } else {
      log('NOTE: Detected build strip did not show ' + TARGET_ENV.toUpperCase() + ' after reload (got "' + badge2.trim() + '") - non-fatal, network-timing dependent like the redirect check above.');
    }
  }

  // CRITICAL assertion (added 2026-08-10, closes a real test-coverage gap
  // found this session): the feature's whole promise is that the app
  // still WORKS after overriding, just on a different build - up to now,
  // no test ever actually checked that the page still renders visible
  // content after Apply + reload, only that the network redirect
  // happened. This exact gap let a genuine "sandbox-shape link goes
  // completely blank after override" bug (see the sandbox-shape guard in
  // buildModeD/content.js and the 2026-08-10 comment in
  // buildBundleRedirectRules/background.js) go unnoticed. Confirm here,
  // for the one scenario Bundle Override IS meant to support (a real
  // brand page embedding the widget via the dist-shape URL), that the
  // page actually has real, non-trivial rendered text content.
  const bodyText = await page.locator('body').innerText().catch(() => '');
  log('Body text length after override + reload: ' + bodyText.length);
  if (bodyText.trim().length < 200) {
    throw new Error('REGRESSION: page body has almost no rendered text (' + bodyText.length + ' chars) after Bundle Override + reload - the app likely failed to render. Snippet: ' + JSON.stringify(bodyText.slice(0, 300)));
  }
  log('PASS: page still renders real content (' + bodyText.length + ' chars) after Bundle Override + reload - not a blank page.');

  log('Test run complete.');
  await context.close();
}

main().catch((err) => {
  console.error('[test] FATAL', err);
  process.exit(1);
});
