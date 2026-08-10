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
// IMPORTANT (found while validating this test): the tool's own generated
// links are "sandbox-shape" (bundle served as plain /assets/main-*.js,
// no brandId/device/env segment in the URL) - a Bundle Override only
// actually affects such a link if it was applied with an explicit
// `sandboxDevice` (matching the Bundle tab's Device selector), NOT
// `sandboxDevice: null`. Also: `bleSource=1` links independently hit a
// real, unrelated backend quirk (observed returning a static server-
// rendered "Maintenance Page" even with ZERO extension involvement on a
// totally clean profile) - so this regression test intentionally avoids
// bleSource=1 for its step-3 URL to not conflate that unrelated
// backend flakiness with the actual bug being verified here.
//
// This test reproduces the 3-step sequence and asserts the fix
// (bundleExpectedUrlByTab + chrome.webNavigation.onBeforeNavigate
// cleanup) actually clears the stale override, both in internal state
// AND at the real network-request level, before the new page's bundle
// request fires.
//
// Run with: node test-bundle-override-stale-cleanup.cjs
'use strict';
const path = require('path');
const { chromium } = require('playwright');

const EXT_PATH = path.resolve(__dirname, 'extension');
const BRAND_GUID = '0e5d414b-5234-4050-9fc3-ce1127e18704'; // nordicbet
const CURRENT_ENV = 'qa';

function log(msg) { console.log('[stale-cleanup-test] ' + new Date().toISOString().slice(11, 19) + ' ' + msg); }

async function generateLinks() {
  const url = 'https://internal.' + CURRENT_ENV + '.sbplayground1.net/api/user-context/logged-out-en-eur-mga-restofworld' +
    '?brand=' + BRAND_GUID + '&shouldUseSbIl=false&generateLinksPage=true&overrideIFrameBaseUrlWith=';
  const res = await fetch(url);
  if (!res.ok) throw new Error('user-context fetch failed: HTTP ' + res.status);
  const r = await res.json();
  const base = r.data.user.desktop.iFrameSetup.overrideIFrameBaseUrlWith;
  const stc = r.data.context.desktop.customerContext.staticContextId;
  const ctx = r.data.context.desktop.customerContext.userContextId;
  return {
    // Step 1 link (native QA, no override, no bleSource).
    first: base + '/' + stc + '/' + ctx + '/live/football?exposeObgState=true&exposeObgRt=true&sealStore=false',
    // Step 3 link: a genuinely different, unrelated page (different
    // path) - still native QA, still no bleSource, so any failure can
    // only be attributed to the stale-override bug, not to any
    // independent bleSource backend quirk.
    second: base + '/' + stc + '/' + ctx + '/live/basketball?exposeObgState=true&exposeObgRt=true&sealStore=false',
  };
}

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
  const links = await generateLinks();
  log('Step 1 link: ' + links.first);
  log('Step 3 link: ' + links.second);

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
  const scriptRequests = [];
  const allScriptLikeRequests = [];
  page.on('request', (req) => {
    if (req.resourceType() === 'script' && /\/assets\/main-[A-Za-z0-9]+\.js/.test(req.url())) scriptRequests.push(req.url());
    if (req.resourceType() === 'script') allScriptLikeRequests.push(req.url());
  });

  // Step 1: load a normal QA link in this tab.
  await page.goto(links.first, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  log('Step 1: loaded a normal QA link in this tab. main.js requests so far: ' + JSON.stringify(scriptRequests));
  if (!scriptRequests.length) throw new Error('Test setup problem: no /assets/main-*.js request observed on step 1 - cannot validate override redirect.');

  const tabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.ndbplayground.net/*' });
    return tabs[0].id;
  });

  // Step 2: apply Bundle Override QA -> TEST on this SAME tab, via the
  // real lgt-bundle-start message path, WITH sandboxDevice set (matching
  // how a real user would use the Bundle tab's Device selector on one of
  // the tool's own standalone/sandbox-shape links - sandboxDevice: null
  // would never even match this link's /assets/main-*.js request).
  const applyResult = await callViaContentScript(sw, tabId, { type: 'lgt-bundle-start', targetEnv: 'test', brandId: BRAND_GUID, sandboxDevice: 'desktop' });
  log('Step 2: applied Bundle Override QA->TEST (sandboxDevice desktop), result: ' + JSON.stringify(applyResult));
  if (!applyResult || !applyResult.ok) {
    throw new Error('Failed to apply Bundle Override for test setup: ' + JSON.stringify(applyResult));
  }

  const debugState1 = await sw.evaluate(async (tid) => {
    return { expectedUrl: bundleExpectedUrlByTab[tid], ruleIds: bundleRuleIdsByTab[tid] };
  }, tabId);
  log('DEBUG after step 2 (override should be active): ' + JSON.stringify(debugState1));
  if (!debugState1.ruleIds || !debugState1.ruleIds.length) throw new Error('Test setup problem: override rule was not actually registered.');

  // Confirm the override is REAL at the network level: reload the SAME
  // page now that the override is active, and check the main.js request
  // actually got redirected to the TEST env's file.
  scriptRequests.length = 0;
  allScriptLikeRequests.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  log('DEBUG main.js requests seen right after applying override: ' + JSON.stringify(scriptRequests));
  log('DEBUG all script-type requests: ' + JSON.stringify(allScriptLikeRequests));
  if (!scriptRequests.length) throw new Error('Test setup problem: no /assets/main-*.js request observed after applying the override.');
  const redirectedToTest = scriptRequests.some((u) => u.includes('.test.')) || allScriptLikeRequests.some((u) => !/\/assets\/main-[A-Za-z0-9]+\.js/.test(u) && /main-/.test(u));
  if (!redirectedToTest) {
    throw new Error('Test setup problem: Bundle Override did not actually redirect the main.js request to TEST - cannot validate cleanup without a real active override: ' + JSON.stringify(scriptRequests));
  }
  log('Confirmed override is REAL at the network level (main.js redirected to TEST).');

  // Step 3: WITHOUT stopping the override, navigate this SAME tab to a
  // fresh, unrelated QA link - the exact real-world scenario that
  // triggered the user's bug report.
  scriptRequests.length = 0;
  await page.goto(links.second, { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('Step 3: navigated same tab to a fresh, unrelated QA link.');
  await page.waitForTimeout(5000);

  const debugState2 = await sw.evaluate(async (tid) => {
    return { expectedUrl: bundleExpectedUrlByTab[tid], ruleIds: bundleRuleIdsByTab[tid] };
  }, tabId);
  log('DEBUG after step 3 (should show ruleIds cleared): ' + JSON.stringify(debugState2));
  log('DEBUG main.js requests seen in step 3: ' + JSON.stringify(scriptRequests));

  if (debugState2.ruleIds && debugState2.ruleIds.length) {
    throw new Error('REGRESSION: bundleRuleIdsByTab still has active rules after navigating to an unrelated page - stale-cleanup fix did not work: ' + JSON.stringify(debugState2));
  }

  // Assertion: the page must NOT show the "Sportsbook is currently
  // unavailable" maintenance fallback (the exact pre-fix symptom), and
  // must show real live event content instead.
  const bodyText = await page.locator('body').innerText();
  if (/currently unavailable/i.test(bodyText)) {
    throw new Error('REGRESSION: stale Bundle Override still broke the new page - maintenance fallback shown instead of live events: ' + bodyText.slice(0, 300));
  }
  if (!/Live Now/i.test(bodyText)) {
    throw new Error('Page did not render the expected "Live Now" section at all - unexpected failure mode: ' + bodyText.slice(0, 300));
  }
  log('PASS: new page rendered live content, not a maintenance page.');

  // Assertion: the new page's own main.js request must NOT have been
  // redirected to the TEST env (i.e. must be a genuine, un-overridden QA
  // request) - the strongest possible confirmation, at the actual
  // network level, that the stale rule no longer applies.
  if (!scriptRequests.length) throw new Error('No /assets/main-*.js request observed in step 3 - cannot confirm redirect state.');
  const stillRedirected = scriptRequests.some((u) => u.includes('.test.'));
  if (stillRedirected) {
    throw new Error('REGRESSION: step 3 main.js request was still redirected to TEST env: ' + JSON.stringify(scriptRequests));
  }
  log('PASS: step 3 main.js request was NOT redirected - override correctly cleared at the network level. ' + JSON.stringify(scriptRequests));

  // Assertion: the Detected-build strip's status query on the NEW page
  // must NOT still claim an active override from the old QA->TEST rule.
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
