// Headless end-to-end regression test for the 2026-08-10 stale-Bundle-
// Override-carries-over-to-a-new-page bug (real user report: "no events
// load at all" on a freshly generated bleSource=1 link, screenshot showed
// the Detected-build strip reading "overridden from QA" [TEST] even
// though the user hadn't asked for a Bundle Override on THIS page).
//
// Root cause (confirmed live via this exact scenario, pre-fix): the
// Bundle Override declarativeNetRequest rule (bundleRuleIdsByTab) was
// never cleared on navigation, unlike the Sportradar-spoof/BLE-CORS
// features - so applying it once, then navigating the SAME tab to a
// genuinely different, unrelated link (even same-origin), silently kept
// redirecting that new page's bundle to the wrong environment.
//
// IMPORTANT (updated 2026-08-10, second pass): this test used to apply
// the override with an explicit `sandboxDevice` on one of the tool's own
// generated sandbox-shape links, on the theory that those links serve
// ONLY the sportsbook widget as /assets/main-*.js. That assumption turned
// out to be WRONG - a sandbox-shape link's /assets/main-*.js is actually
// the entire self-contained app (no separate widget bundle exists at
// all), so redirecting it to indexer.json's widget-only dist-shape file
// silently produced a completely blank page. That whole `sandboxDevice`
// mechanism was removed from background.js/content.js (see the long
// comment on buildBundleRedirectRules). This test now instead uses a
// REAL brand page (test.nordicbet.com, same target test-bundle-
// override.cjs already uses successfully) where the widget genuinely is
// loaded via the dist-shape URL and Bundle Override is known to work
// correctly and safely.
//
// This test reproduces the 3-step sequence and asserts the fix
// (bundleExpectedUrlByTab + chrome.webNavigation.onBeforeNavigate
// cleanup) actually clears the stale override, both in internal state
// AND at the real network-request level, before the new page's bundle
// request fires - and that the new page still renders real content (not
// just "no redirect", but "app actually works").
//
// Run with: node test-bundle-override-stale-cleanup.cjs
'use strict';
const path = require('path');
const { chromium } = require('playwright');

const EXT_PATH = path.resolve(__dirname, 'extension');
const BRAND_GUID = '0e5d414b-5234-4050-9fc3-ce1127e18704'; // nordicbet
const TARGET_ENV = 'qa'; // same layer (BLE) partner of 'test'

function log(msg) { console.log('[stale-cleanup-test] ' + new Date().toISOString().slice(11, 19) + ' ' + msg); }

// Step 1 link: a real, embedded brand page - the widget is loaded via the
// dist-shape URL here, which is the one scenario Bundle Override actually
// supports.
const FIRST_URL = 'https://test.nordicbet.com/en/sportsbook';
// Step 3 link: a genuinely different, unrelated page on the SAME brand
// site (different path) - still native TEST, so any failure can only be
// attributed to the stale-override bug, not to some unrelated backend
// quirk.
const SECOND_URL = 'https://test.nordicbet.com/en/sportsbook/live/football';

async function callViaContentScript(sw, tabId, message) {
  return sw.evaluate(async (args) => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: args.tabId },
      world: 'ISOLATED',
      func: (msg) => new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (res) => { resolve(res); });
      }),
      args: [args.message],
    });
    return result;
  }, { tabId, message });
}

async function main() {
  log('Step 1 link: ' + FIRST_URL);
  log('Step 3 link: ' + SECOND_URL);

  const userDataDir = path.join(require('os').tmpdir(), 'lgt-e2e-stale-cleanup-profile-' + Date.now());
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
  const bundleRequests = [];
  page.on('requestfinished', (req) => {
    const url = req.url();
    if (/\/files\/[a-zA-Z0-9]+-[A-Z0-9]+\.js(\?|$)/.test(url)) bundleRequests.push(url);
  });

  // Step 1: load a normal TEST-env real brand page in this tab.
  await page.goto(FIRST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  log('Step 1: loaded a normal TEST-env brand page in this tab. bundle requests so far: ' + bundleRequests.length);
  if (!bundleRequests.length) throw new Error('Test setup problem: no dist-shape bundle request observed on step 1 - cannot validate override redirect.');

  const tabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.nordicbet.com/*' });
    return tabs[0].id;
  });

  // Step 2: apply Bundle Override TEST -> QA on this SAME tab, via the
  // real lgt-bundle-start message path.
  const applyResult = await callViaContentScript(sw, tabId, { type: 'lgt-bundle-start', targetEnv: TARGET_ENV, brandId: BRAND_GUID });
  log('Step 2: applied Bundle Override TEST->QA, result: ' + JSON.stringify(applyResult));
  if (!applyResult || !applyResult.ok) {
    throw new Error('Failed to apply Bundle Override for test setup: ' + JSON.stringify(applyResult));
  }

  const debugState1 = await sw.evaluate(async (tid) => {
    return { expectedUrl: bundleExpectedUrlByTab[tid], ruleIds: bundleRuleIdsByTab[tid] };
  }, tabId);
  log('DEBUG after step 2 (override should be active): ' + JSON.stringify(debugState1));
  if (!debugState1.ruleIds || !debugState1.ruleIds.length) throw new Error('Test setup problem: override rule was not actually registered.');

  // Confirm the override is REAL at the network level: reload the SAME
  // page now that the override is active, and check a bundle request
  // actually got redirected to the QA env's file - AND that the page
  // still renders real content (not just "redirect happened").
  bundleRequests.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  log('DEBUG bundle requests seen right after applying override: ' + JSON.stringify(bundleRequests));
  if (!bundleRequests.length) throw new Error('Test setup problem: no bundle request observed after applying the override.');
  // NOTE: TEST and QA currently happen to run the SAME underlying build in
  // this environment, and test.nordicbet.com's own reverse proxy natively
  // serves some same-origin requests under a path that already contains
  // "/qa/" (confirmed live, unrelated to any override) - so a bare path
  // substring check for "/qa/" is unreliable here and produces false
  // positives. The one UNAMBIGUOUS signal that our override's redirect
  // actually fired is the CROSS-ORIGIN target CDN host from indexer.json
  // (d-cf.<env>.sbplayground1.net) - the native page never requests that
  // host on its own.
  const isOverrideCdnHost = (u) => u.indexOf('sbplayground1.net') !== -1 && u.indexOf('.' + TARGET_ENV + '.') !== -1;
  const redirectedToQa = bundleRequests.some(isOverrideCdnHost);
  if (!redirectedToQa) {
    throw new Error('Test setup problem: Bundle Override did not actually redirect a bundle request to QA - cannot validate cleanup without a real active override: ' + JSON.stringify(bundleRequests));
  }
  log('Confirmed override is REAL at the network level (bundle request redirected to QA).');

  const bodyAfterOverride = await page.locator('body').innerText().catch(() => '');
  log('Body text length right after override + reload: ' + bodyAfterOverride.length);
  if (bodyAfterOverride.trim().length < 200) {
    throw new Error('REGRESSION: page went (near-)blank after applying Bundle Override + reload (' + bodyAfterOverride.length + ' chars) - the exact class of bug this test now also guards against. Snippet: ' + JSON.stringify(bodyAfterOverride.slice(0, 300)));
  }
  log('Confirmed the page still renders real content with the override active (not blank).');

  // Step 3: WITHOUT stopping the override, navigate this SAME tab to a
  // fresh, unrelated TEST-env page on the same brand - the exact
  // real-world scenario that triggered the user's bug report.
  bundleRequests.length = 0;
  await page.goto(SECOND_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('Step 3: navigated same tab to a fresh, unrelated TEST-env page.');
  await page.waitForTimeout(5000);

  const debugState2 = await sw.evaluate(async (tid) => {
    return { expectedUrl: bundleExpectedUrlByTab[tid], ruleIds: bundleRuleIdsByTab[tid] };
  }, tabId);
  log('DEBUG after step 3 (should show ruleIds cleared): ' + JSON.stringify(debugState2));
  log('DEBUG bundle requests seen in step 3: ' + JSON.stringify(bundleRequests));

  if (debugState2.ruleIds && debugState2.ruleIds.length) {
    throw new Error('REGRESSION: bundleRuleIdsByTab still has active rules after navigating to an unrelated page - stale-cleanup fix did not work: ' + JSON.stringify(debugState2));
  }

  // Assertion: the new page must render real content, not a
  // maintenance/broken fallback.
  const bodyText = await page.locator('body').innerText();
  if (/currently unavailable/i.test(bodyText)) {
    throw new Error('REGRESSION: stale Bundle Override still broke the new page - maintenance fallback shown instead of live events: ' + bodyText.slice(0, 300));
  }
  if (bodyText.trim().length < 200) {
    throw new Error('REGRESSION: new page rendered almost no content (' + bodyText.length + ' chars) - stale override likely still active: ' + JSON.stringify(bodyText.slice(0, 300)));
  }
  log('PASS: new page rendered real content, not a maintenance/blank page.');

  // Assertion: the new page's own bundle requests must NOT have been
  // redirected to the QA env's cross-origin CDN host (i.e. must be
  // genuine, un-overridden TEST requests) - the strongest possible
  // confirmation, at the actual network level, that the stale rule no
  // longer applies. (See the isOverrideCdnHost note above for why a bare
  // "/qa/" path substring check would be unreliable in this environment.)
  if (!bundleRequests.length) throw new Error('No bundle request observed in step 3 - cannot confirm redirect state.');
  const stillRedirected = bundleRequests.some(isOverrideCdnHost);
  if (stillRedirected) {
    throw new Error('REGRESSION: step 3 bundle request was still redirected to QA env: ' + JSON.stringify(bundleRequests));
  }
  log('PASS: step 3 bundle requests were NOT redirected - override correctly cleared at the network level.');

  // Assertion: the Detected-build strip's status query on the NEW page
  // must NOT still claim an active override from the old TEST->QA rule.
  const bundleStatus = await callViaContentScript(sw, tabId, { type: 'lgt-bundle-status' });
  log('Bundle status on the new page: ' + JSON.stringify(bundleStatus));
  if (bundleStatus && bundleStatus.active) {
    throw new Error('REGRESSION: Bundle Override rule is still reported active on the new, unrelated page - stale-cleanup fix did not work.');
  }
  log('PASS: stale Bundle Override was correctly cleared on navigation to a new, unrelated link.');

  await context.close();
  log('ALL PASS');
}

main().catch((err) => {
  console.error('[stale-cleanup-test] FATAL', err);
  process.exitCode = 1;
});
