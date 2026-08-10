// Headless end-to-end test of the link-gen-tool extension's live-login
// flow (both Desktop and Mobile device captures), run against NordicBet's
// real test-environment login (test.nordicbet.com) using the shared OBG
// e2e credential. Verifies whether the SILENT (invisible, minimized
// background tab) capture path actually progresses to completion, or
// stalls the way the user reported ("silent mód továbbra is elhal").
//
// Run with: NODE_PATH=<skill node_modules> node test-live-login-e2e.cjs
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const EXT_PATH = path.resolve(__dirname, 'extension');
const SECRETS = JSON.parse(fs.readFileSync(
  'C:\\Users\\basz04\\.agents\\skills\\sbplayground-link-generator\\.secrets\\test-login.json', 'utf8'));
// username field is stored as "username=<email>" - strip the prefix.
const USERNAME = SECRETS.username.replace(/^username=/, '');
const PASSWORD = SECRETS.password;

const BRAND = 'nordicbet';
const ENVIRONMENT = 'test';
const TARGET_URL = 'https://test.nordicbet.com/en/sportsbook';

function log(msg) { console.log('[test] ' + new Date().toISOString().slice(11, 19) + ' ' + msg); }

async function main() {
  const userDataDir = path.join(require('os').tmpdir(), 'lgt-e2e-profile-' + Date.now());
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
    p.on('console', (msg) => log('  [tab console] ' + msg.text().slice(0, 300)));
    p.on('pageerror', (err) => log('  [tab PAGEERROR] ' + err.message));
  });

  // Find the background service worker (extension ID + a JS context with
  // chrome.* APIs available, needed to seed storage and toggle the panel).
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  log('Extension loaded, id=' + extId);

  // Seed: a vault credential for nordicbet (Vault is chrome.storage.local,
  // shared extension-wide) + pre-mark nordicbet as "silent verified" so
  // this run exercises the SILENT (invisible background tab) path
  // directly, matching the user's real-world complaint, instead of the
  // safety-net "first run always visible" path.
  await sw.evaluate(async ({ brand, username, password }) => {
    await chrome.storage.local.set({
      'lgt-credentials-v1': [{
        id: 'e2e-test-cred', label: 'E2E test cred', username, password,
        isDefault: true, brands: [brand],
      }],
      'lgt-silent-verified-brands': { [brand]: true },
    });
  }, { brand: BRAND, username: USERNAME, password: PASSWORD });
  log('Seeded vault credential + silent-verified flag for ' + BRAND);

  const page = await context.newPage();
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const finalUrl = page.url();
  log('Loaded ' + TARGET_URL + ' -> final URL ' + finalUrl);
  await page.waitForTimeout(2000); // let content script settle (document_idle)

  // Toggle the panel visible via the same message the toolbar-icon click
  // sends - must be sent from a context with chrome.tabs, i.e. the
  // background service worker. Query by hostname pattern (not the exact
  // pre-redirect URL) since nordicbet.com redirects to a www. subdomain.
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
  await loginSel.selectOption('in');
  log('Set brand=' + BRAND + ' environment=' + ENVIRONMENT + ' login=in');

  // Let refreshGenerateButtonMode's async hasLoggedInCustomerKey fetch
  // resolve and swap the button row.
  await page.waitForTimeout(3000);

  const desktopBtn = panel.getByRole('button', { name: 'Generate Desktop', exact: true });
  const mobileBtn = panel.getByRole('button', { name: 'Generate Mobile', exact: true });
  const singleBtn = panel.getByRole('button', { name: 'Generate', exact: true });

  const splitVisible = await desktopBtn.isVisible().catch(() => false);
  log('Split Desktop/Mobile buttons visible: ' + splitVisible);
  if (!splitVisible) {
    const singleVisible = await singleBtn.isVisible().catch(() => false);
    log('FALLBACK: single Generate button visible: ' + singleVisible + ' - live-login-fallback mode not detected as expected; aborting device-by-device test, will just click single Generate once.');
  }

  async function runOneDevice(deviceLabel, btnLocator, expectedLabelSubstr) {
    log('--- Starting ' + deviceLabel + ' generation (silent mode) ---');
    await btnLocator.click();
    const logArea = panel.locator('.lgt-log').first();
    const deadline = Date.now() + 150000; // 150s budget
    let lastText = '';
    let stalledSince = null;
    while (Date.now() < deadline) {
      const jobState = await sw.evaluate(async () => {
        const res = await chrome.storage.local.get(['lgt-live-login-job-v1', 'lgt-live-login-job']);
        return res;
      }).catch(() => ({}));
      const text = (await logArea.textContent().catch(() => '')) || '';
      if (text !== lastText) {
        log(deviceLabel + ' log: ' + text.trim().replace(/\s+/g, ' '));
        lastText = text;
        stalledSince = Date.now();
      } else if (stalledSince && Date.now() - stalledSince > 30000) {
        log(deviceLabel + ' STALLED - no log change for 30s. Job storage snapshot: ' + JSON.stringify(jobState));
        stalledSince = Date.now(); // reset so we don't spam every tick, still log every 30s
      }
      if (/error|failed|timed out/i.test(text)) {
        log(deviceLabel + ' FAILURE detected in log text.');
        break;
      }
      const resultVisible = await panel.locator('.lgt-result').first().isVisible().catch((e) => { log('isVisible err: ' + e.message.slice(0,120)); return false; });
      if (resultVisible) {
        const resultText = await panel.locator('.lgt-result').first().textContent().catch(() => '');
        if (resultText && resultText.trim().length > 0 && resultText.indexOf(expectedLabelSubstr) !== -1) {
          log(deviceLabel + ' SUCCESS - result row rendered: ' + resultText.trim().slice(0, 300));
          break;
        }
      }
      await page.waitForTimeout(2000);
    }
    if (Date.now() >= deadline) {
        log(deviceLabel + ' TIMED OUT after budget with no success/failure resolution. Last log: ' + lastText);
    }
      const html = await panel.locator('.lgt-result').first().innerHTML().catch((e) => 'ERR:' + e.message);
      log(deviceLabel + ' final .lgt-result innerHTML: ' + html.slice(0, 500));
    }

  if (splitVisible) {
    await runOneDevice('DESKTOP', desktopBtn, 'Desktop (live-login');
    // Reset any stuck job before the next device attempt.
    await sw.evaluate(async () => { await chrome.storage.local.remove(['lgt-live-login-job-v1', 'lgt-live-login-job']); });
    await page.waitForTimeout(1000);
    await runOneDevice('MOBILE', mobileBtn, 'Mobile (live-login');
  } else {
    await runOneDevice('SINGLE(both)', singleBtn, 'live-login');
  }

  log('Test run complete. Leaving browser open 5s for final console flush.');
  await page.waitForTimeout(5000);
  await context.close();
}

main().catch((err) => {
  console.error('[test] FATAL', err);
  process.exit(1);
});
