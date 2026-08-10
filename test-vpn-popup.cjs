// Verifies the "First connect VPN!" popup: since there's no way to
// literally disconnect the corporate VPN via automation, this test
// monkey-patches window.fetch (from a real page, on top of the real
// extension) to reject exactly like Chrome does when internal.*
// sbplayground1.net is unreachable (TypeError: Failed to fetch), then
// clicks Generate (logged-out path, no live-login needed) and confirms:
//   1) the VPN popup appears with the expected text
//   2) clicking Retry re-runs the same generation
//   3) once fetch is restored to normal, the retry succeeds and renders
//      a real link, and the popup goes away
//
// Run with: NODE_PATH=<skill node_modules> node test-vpn-popup.cjs
'use strict';
const path = require('path');
const { chromium } = require('playwright');

const EXT_PATH = path.resolve(__dirname, 'extension');
const BRAND = 'nordicbet';
const ENVIRONMENT = 'test';
const TARGET_URL = 'https://test.nordicbet.com/en/sportsbook';

function log(msg) { console.log('[test] ' + new Date().toISOString().slice(11, 19) + ' ' + msg); }

async function main() {
  const userDataDir = path.join(require('os').tmpdir(), 'lgt-vpn-profile-' + Date.now());
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
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
  page.on('pageerror', (err) => log('  [PAGEERROR] ' + err.message));
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
  const brandSel = panel.locator('select:visible').nth(0);
  const envSel = panel.locator('select:visible').nth(1);
  const loginSel = panel.locator('select:visible').nth(2);
  await brandSel.selectOption(BRAND);
  await envSel.selectOption(ENVIRONMENT);
  await loginSel.selectOption('out'); // logged-out path: simplest generateLink() call, no live-login involved
  log('Set brand=' + BRAND + ' environment=' + ENVIRONMENT + ' login=out');
  await page.waitForTimeout(1500);

  // Simulate "VPN not connected": abort any request to
  // internal.*.sbplayground1.net at the network level via Playwright's
  // route interception (page.evaluate() monkey-patching window.fetch
  // would NOT work here - content scripts run in an isolated JS world
  // with their own `fetch` global, unaffected by overwriting window.fetch
  // from the page's main world; network-level route interception is
  // transparent to which JS world issued the request).
  await page.route('**://internal.*.sbplayground1.net/**', (route) => route.abort('connectionfailed'));
  log('Routed internal.*.sbplayground1.net requests to abort (simulating VPN-down)');

  const singleBtn = panel.getByRole('button', { name: 'Generate', exact: true });
  await singleBtn.click();
  log('Clicked Generate (expecting VPN popup)...');

  const popupBackdrop = page.locator('#lgt-vpn-popup-backdrop');
  await popupBackdrop.waitFor({ state: 'visible', timeout: 10000 });
  const popupText = await page.locator('#lgt-vpn-popup').textContent();
  log('VPN POPUP SHOWN. Text: ' + popupText.replace(/\s+/g, ' ').trim());

  const looksRight = /First connect VPN/i.test(popupText) && /internal\.test\.sbplayground1\.net/i.test(popupText);
  log('Popup text looks correct: ' + looksRight);

  // Restore normal network for internal.*.sbplayground1.net (simulate VPN
  // reconnecting), then click Retry.
  await page.unroute('**://internal.*.sbplayground1.net/**');
  log('Unrouted internal.*.sbplayground1.net (simulating VPN reconnected)');

  const retryBtn = page.locator('#lgt-vpn-popup .lgt-vpn-retry');
  await retryBtn.click();
  log('Clicked Retry');

  await popupBackdrop.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => log('WARNING: popup did not hide immediately after Retry click'));

  const resultLocator = panel.locator('.lgt-result').first();
  const deadline = Date.now() + 20000;
  let renderedOk = false;
  while (Date.now() < deadline) {
    const text = (await resultLocator.textContent().catch(() => '')) || '';
    if (/http/i.test(text)) { renderedOk = true; log('RETRY SUCCESS - result rendered: ' + text.slice(0, 200)); break; }
    await page.waitForTimeout(500);
  }
  if (!renderedOk) log('RETRY FAILED / TIMED OUT - no link rendered after retry.');

  const popupStillVisible = await popupBackdrop.isVisible().catch(() => false);
  log('Popup still visible after successful retry: ' + popupStillVisible + ' (expected false)');

  const overallOk = looksRight && renderedOk && !popupStillVisible;
  log('OVERALL: ' + (overallOk ? 'PASS' : 'FAIL'));

  await context.close();
  process.exit(overallOk ? 0 : 1);
}

main().catch((err) => { console.error('[test] FATAL: ', err); process.exit(1); });
