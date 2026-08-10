// Headless end-to-end smoke test of the link-gen-tool extension's "BLE
// Data" tab (v1.17.0+, the "22-es csapda" / catch-22 fix). Loads the
// extension, opens a REAL brand sportsbook page (test.nordicbet.com -
// something Bundle Override can already do but bleSource=1 never could),
// opens the panel's BLE Data tab, applies the override, reloads, and
// confirms at the network layer that:
//   1. an /api/sb/v1/* call actually landed on the brand's ALPHA host
//      (the redirect half of the mechanism), and
//   2. that request carried the freshly-minted x-sb-static-context-id /
//      x-sb-user-context-id header values the tool applied (the
//      modifyHeaders half of the mechanism) - not the page's own native
//      (BDE) context.
// Also confirms the page still renders real content afterward (same
// "not a silent blank page" philosophy as test-bundle-override.cjs).
//
// Run with: node test-ble-data-override.cjs
'use strict';
const path = require('path');
const { chromium } = require('playwright');

const EXT_PATH = path.resolve(__dirname, 'extension');
const BRAND = 'nordicbet';
const TARGET_URL = 'https://test.nordicbet.com/en/sportsbook/live/football';
const ALPHA_HOST = 'd-cf.alpha.ndbplayground.net';

function log(msg) { console.log('[test] ' + new Date().toISOString().slice(11, 19) + ' ' + msg); }

async function main() {
  const userDataDir = path.join(require('os').tmpdir(), 'lgt-e2e-ble-data-profile-' + Date.now());
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

  const apiHits = []; // {url, headers} for every /api/sb/v1/* request seen
  page.on('requestfinished', async (req) => {
    const u = req.url();
    if (/\/api\/sb\/v1\//i.test(u)) {
      let hdrs = {};
      try { hdrs = await req.allHeaders(); } catch (e) { /* ignore */ }
      apiHits.push({ url: u, headers: hdrs });
    }
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
  await panel.locator('.lgt-tab').filter({ hasText: 'BLE Data' }).click();
  log('Switched to BLE Data tab');

  const brandSel = panel.locator('select:visible').nth(0);
  const detectedBrand = await brandSel.inputValue();
  log('Auto-detected brand: ' + detectedBrand);
  if (detectedBrand !== BRAND) {
    log('WARNING: auto-detect did not match expected brand "' + BRAND + '" - forcing selection.');
    await brandSel.selectOption(BRAND);
  }

  const applyBtn = panel.getByRole('button', { name: 'Apply', exact: true });
  await applyBtn.click();
  log('Clicked Apply, waiting for status to report an active override...');

  const statusEl = panel.locator('.lgt-log:visible').first();
  const deadline = Date.now() + 25000;
  let statusText = '';
  while (Date.now() < deadline) {
    statusText = (await statusEl.textContent().catch(() => '')) || '';
    log('BLE Data status: ' + statusText.trim());
    if (/^Active - /.test(statusText.trim())) break;
    if (/^Failed:/.test(statusText.trim())) break;
    await page.waitForTimeout(1500);
  }
  if (!/^Active - /.test(statusText.trim())) {
    throw new Error('BLE Data Override did not report an active state within budget. Last status: ' + statusText);
  }
  log('PASS: BLE Data Override reports active. Status: ' + statusText.trim());

  // Extract the applied stc value from the status text ("Active - desktop
  // context stc--XXXX -> d-cf.alpha...") so we can confirm it below.
  const stcMatch = /context (\S+) ->/.exec(statusText);
  const appliedStc = stcMatch ? stcMatch[1] : null;
  log('Applied stc (parsed from status): ' + appliedStc);

  apiHits.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  log('/api/sb/v1/* requests observed after reload: ' + apiHits.length);

  const alphaHits = apiHits.filter((h) => {
    try { return new URL(h.url).hostname === ALPHA_HOST; } catch (e) { return false; }
  });
  log('...of which redirected to ' + ALPHA_HOST + ': ' + alphaHits.length);
  if (!alphaHits.length) {
    throw new Error('No /api/sb/v1/* request was redirected to ' + ALPHA_HOST + ' - the redirect rule did not take effect.');
  }
  log('PASS: at least one /api/sb/v1/* request was redirected to the ALPHA host.');

  if (appliedStc) {
    const withContext = alphaHits.filter((h) => h.headers && h.headers['x-sb-static-context-id'] === appliedStc);
    log('...of which carried the applied context header (' + appliedStc + '): ' + withContext.length);
    if (!withContext.length) {
      throw new Error('Redirected requests did not carry the applied x-sb-static-context-id header (' + appliedStc + ') - the modifyHeaders rule did not take effect. Sample headers: ' + JSON.stringify((alphaHits[0] && alphaHits[0].headers) || {}));
    }
    log('PASS: redirected requests carried the freshly-minted ALPHA context header.');
  } else {
    log('NOTE: could not parse the applied stc from the status text - skipping the header-value assertion (non-fatal, the host-redirect assertion above already validates the core mechanism).');
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  log('Body text length after override + reload: ' + bodyText.length);
  if (bodyText.trim().length < 200) {
    throw new Error('REGRESSION: page body has almost no rendered text (' + bodyText.length + ' chars) after BLE Data Override + reload - the app likely failed to render. Snippet: ' + JSON.stringify(bodyText.slice(0, 300)));
  }
  log('PASS: page still renders real content (' + bodyText.length + ' chars) after BLE Data Override + reload - not a blank page.');

  // Stale-rule cleanup check: navigating to a genuinely different page in
  // the same tab must clear the override, same reasoning/mechanism as
  // Bundle Override's own stale-cleanup fix (see
  // test-bundle-override-stale-cleanup.cjs) - a redirect rule keyed to the
  // OLD host must not silently keep affecting whatever loads next.
  apiHits.length = 0;
  await page.goto('https://test.nordicbet.com/en/sportsbook/live/tennis', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const alphaHitsAfterNav = apiHits.filter((h) => {
    try { return new URL(h.url).hostname === ALPHA_HOST; } catch (e) { return false; }
  });
  log('/api/sb/v1/* requests redirected to ALPHA after navigating away: ' + alphaHitsAfterNav.length);
  if (alphaHitsAfterNav.length) {
    throw new Error('REGRESSION: BLE Data Override rules were still active after navigating to a different page - stale-cleanup did not fire.');
  }
  log('PASS: BLE Data Override was correctly cleared after navigating away.');

  log('Test run complete.');
  await context.close();
}

main().catch((err) => {
  console.error('[test] FATAL', err);
  process.exit(1);
});
