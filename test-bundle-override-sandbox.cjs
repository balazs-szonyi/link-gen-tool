// Headless end-to-end smoke test of the link-gen-tool extension's
// sandbox-shape bundle-detection fixes (2026-08-10) PLUS the sandbox-shape
// Bundle-Override GUARD (2026-08-10, second pass). Unlike
// test-bundle-override.cjs (which targets a real branded website embedding
// the SB widget via iframe, /dist/.../desktop|mobile/files/... bundle
// shape), this test targets the tool's OWN "Generate" tab output opened
// standalone - a "sandbox" link like
// https://d-cf.qa.ndbplayground.net/stc--.../stc--.../?exposeObgState=true...
// whose bundle is served as plain /assets/main-<hash>.js with no version,
// brandId, or device segment in the URL at all. This shape previously made
// the Detected-build strip show "No sportsbook bundle detected" forever
// (fixed 2026-08-10) and made Bundle Override silently do nothing
// (attempted-fixed 2026-08-10 via a "sandboxDevice" mechanism).
//
// IMPORTANT (2026-08-10, second pass): the "sandboxDevice" Bundle Override
// mechanism tested here previously was found to be fundamentally broken -
// a sandbox-shape link's /assets/main-*.js IS the entire self-contained
// app (there is no separate widget bundle at all), so redirecting it to
// indexer.json's widget-only dist-shape file silently produced a
// completely blank page (confirmed live via Playwright, both logged-out
// and logged-in). That mechanism was removed entirely from
// background.js/content.js. The Bundle tab now instead detects this
// scenario (a standalone sandbox link, not a real embedded brand page)
// and shows a warning + blocks Apply, rather than letting the user hit a
// blank page. This test's Bundle-Override section now verifies THAT
// guard, instead of verifying a redirect that would corrupt the page.
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
const BRAND_KEY = 'nordicbet';
const CURRENT_ENV = 'qa';

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
    // so either the pre-enrichment fallback text ("<brand> sandbox link -
    // version/device not encoded in URL") OR the already-enriched
    // "[<brand>, ENV]" format is an acceptable/valid observation here.
    // Assertion 1b below is what strictly requires the enriched form.
    // 2026-08-10 (follow-up): the bracketed label now shows the actual
    // detected brand name (e.g. "nordicbet") instead of the generic
    // literal word "sandbox", per user feedback that the brand is always
    // unambiguous from the link's own hostname.
    if (text.indexOf('sandbox link') === -1 && text.indexOf('[' + BRAND_KEY + ',') === -1) {
      throw new Error('Detected build strip did not show the detected brand name, got: ' + text);
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
  // v<version> (<device>) [<brand>, ...]" line once background.js's
  // async reverse-lookup resolves against the live indexer.json. This is a
  // BEST-EFFORT bonus enrichment layered on top of the honest fallback
  // text confirmed in assertion 1 above (not part of the 2026-08-10
  // follow-up's 3 requested fixes - brand label / Verify CSP bypass /
  // Copy URL removal - all validated separately below). Whether it
  // resolves within any given run depends on which of the page's own lazy
  // chunk requests happen to fire (confirmed live: only ~2 of ~36 files on
  // this page actually match indexer.json) - this is inherent real-world
  // variance in what the page itself chooses to load, not something the
  // extension controls, so a non-resolution here must NOT fail the whole
  // suite. If it DOES resolve, the format must still be correct. ---
  {
    const deadline = Date.now() + 20000;
    let text = '';
    while (Date.now() < deadline) {
      text = (await buildLabel.textContent().catch(() => '')) || '';
      if (/^SB build: v/.test(text.trim())) break;
      await page.waitForTimeout(1000);
    }
    log('Detected build strip (sandbox, after reverse-lookup): ' + text.trim());
    const enrichedRe = new RegExp('^SB build: v\\S+( \\((desktop|mobile)\\))? \\[' + BRAND_KEY + ', ');
    if (/^SB build: v/.test(text.trim())) {
      if (!enrichedRe.test(text.trim())) {
        throw new Error('Detected build strip resolved a version but with a malformed/wrong brand label: ' + text);
      }
      log('PASS: Detected-build strip enriched version+brand via indexer.json reverse-lookup.');
    } else {
      log('SKIP (non-fatal): indexer.json reverse-lookup did not resolve within 20s this run - best-effort bonus feature, depends on which lazy chunks the page happened to request. Fallback text remained honest: ' + text);
    }
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
    // 2026-08-10 (follow-up): root cause was found and fixed for real - a
    // strict page CSP (script-src, no unsafe-inline) was silently
    // blocking the old <script>-tag injection technique, so "No response
    // after 5s" was actually the NORMAL outcome on any CSP-hardened page,
    // not just a rare edge case. Now that background.js uses
    // chrome.scripting.executeScript({world:'MAIN'}) instead (exempt from
    // page CSP), this MUST show real xSbState content on this
    // exposeObgState=true link - a lingering "No response" here would be
    // a regression of that fix, not an acceptable outcome anymore.
    if (text.indexOf('No response') !== -1) {
      throw new Error('Verify with page state still failed to get a real response (regression of the chrome.scripting.executeScript CSP fix): ' + text);
    }
    if (text.indexOf('xSbState:') === -1 && text.indexOf('xSbState present but no known') === -1) {
      throw new Error('Verify with page state did not report real xSbState content, got: ' + text);
    }
    log('PASS: Verify with page state resolved with real xSbState content (CSP-bypass fix confirmed).');
  }

  // --- 3. Bundle Override GUARD on the sandbox shape (2026-08-10, second
  // pass): Apply must be blocked with a clear warning, NOT silently
  // attempt a redirect that would corrupt the page. ---
  await panel.locator('.lgt-tab').filter({ hasText: 'Bundle' }).click();
  log('Switched to Bundle tab');

  const selects = panel.locator('select:visible');
  const brandSel = selects.nth(0);
  const curEnvSel = selects.nth(1);

  const detectedBrand = await brandSel.inputValue();
  const detectedEnv = await curEnvSel.inputValue();
  log('Auto-detected: brand=' + detectedBrand + ' environment=' + detectedEnv);
  if (detectedEnv !== CURRENT_ENV) {
    log('WARNING: auto-detected env did not match expected "' + CURRENT_ENV + '" - forcing selection manually.');
    await curEnvSel.selectOption(CURRENT_ENV);
  }

  const bundleTabBody = panel.locator('.lgt-content');
  const warningText = (await bundleTabBody.textContent().catch(() => '')) || '';
  if (warningText.indexOf('standalone sandbox link') === -1) {
    throw new Error('Bundle tab did not show the expected sandbox-link warning on a sandbox-shape page - guard regression: ' + warningText.slice(0, 400));
  }
  log('PASS: Bundle tab shows the sandbox-link warning as expected.');

  const applyBtn = panel.getByRole('button', { name: 'Apply', exact: true });
  await applyBtn.click();
  log('Clicked Apply on a sandbox-shape link (should be blocked, not actually applied).');

  const statusEl = panel.locator('.lgt-log:visible').first();
  await page.waitForTimeout(1000);
  const statusText = (await statusEl.textContent().catch(() => '')) || '';
  log('Bundle status after clicking Apply on sandbox link: ' + statusText.trim());
  if (!/^Blocked:/.test(statusText.trim())) {
    throw new Error('Clicking Apply on a sandbox-shape link did not report a Blocked status - guard did not actually prevent the override: ' + statusText);
  }
  log('PASS: Apply was correctly blocked on the sandbox-shape link.');

  // Confirm no rule was actually registered for this tab (the guard must
  // prevent the message from ever reaching background.js with an active
  // effect) - reload and confirm the page is NOT corrupted/blank, which is
  // the strongest possible confirmation that nothing was overridden.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  const bodyAfterReload = await page.locator('body').innerText().catch(() => '');
  log('Body text length after reload (guard should have prevented any override): ' + bodyAfterReload.length);
  if (bodyAfterReload.trim().length < 200) {
    throw new Error('REGRESSION: page went (near-)blank after reload even though Apply was supposed to be blocked - guard did not actually prevent the corrupting override: ' + JSON.stringify(bodyAfterReload.slice(0, 300)));
  }
  log('PASS: page still renders real content after reload - the sandbox-link guard correctly prevented the corrupting override.');

  log('Test run complete.');
  await context.close();
}

main().catch((err) => {
  console.error('[sandbox-test] FATAL', err);
  process.exit(1);
});
