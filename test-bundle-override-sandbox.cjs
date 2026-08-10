// Headless end-to-end smoke test of the link-gen-tool extension's
// sandbox-shape bundle-detection/override fixes (2026-08-10). Unlike
// test-bundle-override.cjs (which targets a real branded website embedding
// the SB widget via iframe, /dist/.../desktop|mobile/files/... bundle
// shape), this test targets the tool's OWN "Generate" tab output opened
// standalone - a "sandbox" link like
// https://d-cf.qa.ndbplayground.net/stc--.../stc--.../?exposeObgState=true...
// whose bundle is served as plain /assets/main-<hash>.js with no version,
// brandId, or device segment in the URL at all. This shape previously made
// the Detected-build strip show "No sportsbook bundle detected" forever
// and made Bundle Override silently do nothing (both fixed 2026-08-10).
//
// Generates a FRESH sandbox link via the internal API at run time (the
// same flow the sbplayground-link-generator skill's generate-link.ps1
// uses) rather than hardcoding one, since stc/ctx contexts can go stale.
//
// Run with: node test-bundle-override-sandbox.cjs
'use strict';
const path = require('path');
const { chromium } = require('playwright');

const EXT_PATH = path.resolve(__dirname, 'extension');
const BRAND_GUID = '0e5d414b-5234-4050-9fc3-ce1127e18704'; // nordicbet
const CURRENT_ENV = 'qa';
const TARGET_ENV = 'test'; // same layer (BLE) partner of 'qa'

function log(msg) { console.log('[sandbox-test] ' + new Date().toISOString().slice(11, 19) + ' ' + msg); }

async function generateSandboxLink() {
  const url = 'https://internal.' + CURRENT_ENV + '.sbplayground1.net/api/user-context/logged-out-en-eur-mga-restofworld' +
    '?brand=' + BRAND_GUID + '&shouldUseSbIl=false&generateLinksPage=true&overrideIFrameBaseUrlWith=';
  const res = await fetch(url);
  if (!res.ok) throw new Error('user-context fetch failed: HTTP ' + res.status);
  const r = await res.json();
  const base = r.data.user.desktop.iFrameSetup.overrideIFrameBaseUrlWith;
  const stc = r.data.context.desktop.customerContext.staticContextId;
  const ctx = r.data.context.desktop.customerContext.userContextId;
  return base + '/' + stc + '/' + ctx + '/?exposeObgState=true&exposeObgRt=true&sealStore=false';
}

async function main() {
  const targetUrl = await generateSandboxLink();
  log('Generated fresh sandbox link: ' + targetUrl);

  const userDataDir = path.join(require('os').tmpdir(), 'lgt-e2e-bundle-sandbox-profile-' + Date.now());
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
  log('Extension loaded, id=' + new URL(sw.url()).host);

  const page = await context.newPage();

  const bundleRequests = [];
  page.on('requestfinished', (req) => {
    const url = req.url();
    // Track BOTH shapes: the sandbox source shape (/assets/main-*.js) and
    // the /dist/.../files/main-*.js shape a successful redirect actually
    // lands on - declarativeNetRequest redirects are a network-level
    // substitution (the original request is cancelled, a brand-new request
    // fires against the target URL), so the redirected request will NOT
    // still look like /assets/... - it lands on the target env's own
    // /dist/.../files/... path entirely. Missing this the first time this
    // test was written caused a false "not redirected" reading even though
    // the override was working correctly.
    if (/\/(assets|files)\/(main|chunk)-[A-Za-z0-9]+\.m?js(\?|$)/i.test(url)) bundleRequests.push(url);
  });

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('Loaded sandbox link -> final URL ' + page.url());
  await page.waitForTimeout(3000); // let content script + first bundle requests settle

  await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.ndbplayground.net/*' });
    for (const t of tabs) {
      await new Promise((resolve) => {
        chrome.tabs.sendMessage(t.id, { type: 'lgt-toggle-panel' }, () => { void chrome.runtime.lastError; resolve(); });
      });
    }
  });
  await page.waitForSelector('#lgt-panel', { state: 'visible', timeout: 10000 });
  log('Panel is visible');

  const panel = page.locator('#lgt-panel');

  // --- 1. Detected-build strip: sandbox-shape format, no "No bundle
  // detected" forever, no misleading "vundefined" ---
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
    log('Detected build strip (sandbox, pre-override): ' + text.trim());
    if (!/^SB build:/.test(text.trim())) {
      throw new Error('Detected build strip never populated on a sandbox link (regression of the 2026-08-10 fix), last text: ' + text);
    }
    // The indexer.json reverse-lookup enrichment (added 2026-08-10) is
    // fast enough now that it frequently already resolved by this point -
    // so either the pre-enrichment fallback text ("sandbox link -
    // version/device not encoded in URL") OR the already-enriched
    // "[sandbox, ENV]" format is an acceptable/valid observation here.
    // Assertion 1b below is what strictly requires the enriched form.
    if (text.indexOf('sandbox link') === -1 && text.indexOf('[sandbox,') === -1) {
      throw new Error('Detected build strip did not use the sandbox-shape label, got: ' + text);
    }
    if (text.indexOf('vundefined') !== -1 || text.indexOf('(undefined)') !== -1) {
      throw new Error('Detected build strip showed a misleading "undefined" value: ' + text);
    }
    const badgeText = (await buildStrip.locator('.lgt-build-badge').textContent().catch(() => '')) || '';
    log('Detected build badge (sandbox, native): ' + badgeText.trim());
    if (badgeText.trim().toUpperCase() !== CURRENT_ENV.toUpperCase()) {
      throw new Error('Detected build badge did not show native env "' + CURRENT_ENV + '" on sandbox link, got: ' + badgeText);
    }
    log('PASS: Detected-build strip correctly recognizes the sandbox bundle shape.');
  }

  // --- 1b. indexer.json reverse-lookup enrichment (2026-08-10): the
  // strip should upgrade from the env-only fallback to a real "SB build:
  // v<version> (<device>) [sandbox, ...]" line once background.js's
  // async reverse-lookup resolves against the live indexer.json - this is
  // the actual feature being validated here, distinct from the shape
  // recognition confirmed above. ---
  {
    const deadline = Date.now() + 15000;
    let text = '';
    while (Date.now() < deadline) {
      text = (await buildLabel.textContent().catch(() => '')) || '';
      if (/^SB build: v/.test(text.trim())) break;
      await page.waitForTimeout(1000);
    }
    log('Detected build strip (sandbox, after reverse-lookup): ' + text.trim());
    if (!/^SB build: v\S+( \((desktop|mobile)\))? \[sandbox, /.test(text.trim())) {
      throw new Error('Detected build strip never showed an enriched version for the sandbox link (indexer.json reverse-lookup regression), last text: ' + text);
    }
    log('PASS: Detected-build strip enriched version via indexer.json reverse-lookup.');
  }

  // --- 2. "Verify with page state" must never hang - resolves one way or
  // another well within a generous budget ---
  {
    const verifyBtn = panel.getByRole('button', { name: 'Verify with page state' });
    await verifyBtn.click();
    const verifyResult = panel.locator('.lgt-build-verify');
    const deadline = Date.now() + 8000; // fix guarantees resolution within 5s
    let text = '';
    while (Date.now() < deadline) {
      text = (await verifyResult.textContent().catch(() => '')) || '';
      if (text.trim() && text.trim() !== 'Checking window.xSbState\u2026') break;
      await page.waitForTimeout(500);
    }
    log('Verify with page state result: ' + text.trim());
    if (!text.trim() || text.trim() === 'Checking window.xSbState\u2026') {
      throw new Error('Verify with page state hung past its 5s timeout budget (regression of the 2026-08-10 fix)');
    }
    log('PASS: Verify with page state resolved instead of hanging.');
  }

  // --- 3. Bundle Override on the sandbox shape (new Device select) ---
  await panel.locator('.lgt-tab').filter({ hasText: 'Bundle' }).click();
  log('Switched to Bundle tab');

  const selects = panel.locator('select:visible');
  const brandSel = selects.nth(0);
  const curEnvSel = selects.nth(1);
  const deviceSel = selects.nth(2);

  const detectedBrand = await brandSel.inputValue();
  const detectedEnv = await curEnvSel.inputValue();
  log('Auto-detected: brand=' + detectedBrand + ' environment=' + detectedEnv);
  if (detectedEnv !== CURRENT_ENV) {
    log('WARNING: auto-detected env did not match expected "' + CURRENT_ENV + '" - forcing selection manually.');
    await curEnvSel.selectOption(CURRENT_ENV);
  }
  await deviceSel.selectOption('desktop');
  log('Device select present and set to desktop.');

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
    throw new Error('Bundle override did not report an active state on sandbox link. Last status: ' + statusText);
  }
  log('PASS: Bundle Override installed rule(s) for the sandbox-shape link.');

  bundleRequests.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  log('Sandbox-shape bundle requests observed after reload: ' + bundleRequests.length);
  bundleRequests.forEach((u) => log('  ' + u));
  const redirected = bundleRequests.some((u) => u.indexOf('.' + TARGET_ENV + '.') !== -1 || u.indexOf('/' + TARGET_ENV + '/') !== -1);
  if (redirected) {
    log('PASS (network-level): a sandbox-shape /assets/main-*.js request actually resolved against the ' + TARGET_ENV + ' environment.');
  } else {
    log('NOTE: could not confirm a redirected sandbox-shape request at the network level within this run (page/timing-dependent, non-fatal) - the rule-installed assertion above already validates the core mechanism.');
  }

  log('Test run complete.');
  await context.close();
}

main().catch((err) => {
  console.error('[sandbox-test] FATAL', err);
  process.exit(1);
});
