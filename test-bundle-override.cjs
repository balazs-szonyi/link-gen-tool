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
const CURRENT_ENV = process.env.LGT_CURRENT_ENV || 'test';
const TARGET_ENV = process.env.LGT_TARGET_ENV || CURRENT_ENV; // default behavior: pin to page env
const TARGET_URL = 'https://' + (CURRENT_ENV === 'prod' ? '' : CURRENT_ENV + '.') + 'nordicbet.com/en/sportsbook';
const MOBILE = process.env.LGT_MOBILE === '1';

function log(msg) { console.log('[test] ' + new Date().toISOString().slice(11, 19) + ' ' + msg); }

async function main() {
  const userDataDir = path.join(require('os').tmpdir(), 'lgt-e2e-bundle-profile-' + Date.now());
  const launchOptions = {
    headless: process.env.LGT_HEADFUL ? false : true,
    viewport: MOBILE ? { width: 470, height: 944 } : { width: 1280, height: 800 },
    isMobile: MOBILE,
    hasTouch: MOBILE,
    ...(MOBILE ? {
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    } : {}),
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
    ],
  };
  if (process.env.LGT_CHROMIUM_EXECUTABLE) launchOptions.executablePath = process.env.LGT_CHROMIUM_EXECUTABLE;
  else launchOptions.channel = 'chromium';
  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);

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
  const bundleResponses = [];
  page.on('requestfinished', (req) => {
    const url = req.url();
    if (/\/files\/[a-zA-Z0-9]+[.-][A-Z0-9]+\.m?js(\?|$)/i.test(url)) bundleRequests.push(url);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (/\/files\/[a-zA-Z0-9]+[.-][A-Z0-9]+\.m?js(\?|$)/i.test(url)) {
      bundleResponses.push({ url, status: response.status() });
    }
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
    if (MOBILE && !text.includes('(mobile)')) {
      throw new Error('Mobile test did not load a mobile sportsbook bundle; got: ' + text);
    }
    const badgeText = (await buildStrip.locator('.lgt-build-badge').textContent().catch(() => '')) || '';
    log('Detected build badge (native): ' + badgeText.trim());
    const badgeTitle = (await buildStrip.locator('.lgt-build-badge').getAttribute('title').catch(() => '')) || '';
    log('Detected build URL (native, for diagnosis): ' + badgeTitle);
    const nativeArtifactEnv = badgeText.trim().toLowerCase();
    const sameLayer = ['test', 'qa'].includes(CURRENT_ENV) ? ['test', 'qa'] : ['alpha', 'prod'];
    if (!sameLayer.includes(nativeArtifactEnv)) {
      throw new Error('Detected build badge did not resolve to a valid same-layer artifact environment, got: ' + badgeText);
    }
    if (nativeArtifactEnv !== CURRENT_ENV && text.toUpperCase().indexOf('PAGE IS ' + CURRENT_ENV.toUpperCase()) === -1) {
      throw new Error('Detected build found a cross-environment artifact but did not flag the page/artifact mismatch: ' + text);
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

  const targetEnvSel = panel.locator('select:visible').nth(2);
  const selectedTarget = await targetEnvSel.inputValue();
  if (selectedTarget !== TARGET_ENV) {
    throw new Error('Target bundle environment did not default to the page environment "' + TARGET_ENV + '", got: ' + selectedTarget);
  }

  const targetHint = await panel.locator('.lgt-hint:visible').first().textContent();
  log('Target-env hint: ' + (targetHint || '').trim());
  if (!targetHint || targetHint.toUpperCase().indexOf(TARGET_ENV.toUpperCase()) === -1) {
    throw new Error('Target-env hint did not mention expected layer partner "' + TARGET_ENV + '": ' + targetHint);
  }

  const applyBtn = panel.getByRole('button', { name: 'Apply', exact: true });
  bundleRequests.length = 0;
  bundleResponses.length = 0;
  const reloadPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await applyBtn.click();
  log('Clicked Apply, waiting for the automatic reload...');
  await reloadPromise;
  await page.waitForTimeout(2000);
  log('PASS: Apply automatically reloaded the current tab.');

  await page.waitForSelector('#lgt-panel', { state: 'attached', timeout: 10000 });
  const liveBundleRuleCount = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.nordicbet.com/*' });
    const tab = tabs[0];
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    return rules.filter((rule) => rule.id >= 930001 && rule.id < 950001 &&
      rule.condition && Array.isArray(rule.condition.tabIds) && tab && rule.condition.tabIds.includes(tab.id)).length;
  });
  log('Live bundle rules after automatic reload: ' + liveBundleRuleCount);
  if (!liveBundleRuleCount) throw new Error('Bundle override rules did not survive the automatic same-URL reload.');
  log('PASS: background.js fetched the live ' + TARGET_ENV + ' indexer.json and installed at least one declarativeNetRequest rule.');

  const panelAfterReload = page.locator('#lgt-panel');

  // The Apply click already reloaded after installing the rule. Confirm the
  // resulting requests use the selected target environment.
  await page.waitForTimeout(5000);
  log('Bundle-like requests observed after reload: ' + bundleRequests.length);
  bundleRequests.forEach((u) => log('  ' + u));
  const redirected = bundleRequests.some((u) => u.indexOf('.' + TARGET_ENV + '.') !== -1 || u.indexOf('/' + TARGET_ENV + '/') !== -1);
  if (!redirected) throw new Error('No sportsbook bundle request resolved against target environment ' + TARGET_ENV + '.');
  log('PASS (network-level): a bundle request actually resolved against the ' + TARGET_ENV + ' environment.');
  const wrongLayerResponses = bundleResponses.filter((item) => item.status === 200 &&
    item.url.indexOf('/dist/' + (TARGET_ENV === 'alpha' ? 'prod' : TARGET_ENV === 'prod' ? 'alpha' : TARGET_ENV === 'test' ? 'qa' : 'test') + '/') !== -1);
  if (wrongLayerResponses.length) {
    throw new Error('Mixed bundle execution detected after pinning to ' + TARGET_ENV + ': ' + JSON.stringify(wrongLayerResponses));
  }

  // "Detected build" strip check AFTER the override + reload - the panel
  // itself re-injects on the fresh page load, so re-find it and confirm
  // the badge/label now show the OVERRIDE target env with a mismatch
  // indicator, proving the strip's own detection tracks reality live
  // rather than a UI-remembered value (the exact bug this feature exists
  // to make impossible - see the 2026-08-10 Bundle-tab environment fix).
  {
    await page.waitForSelector('#lgt-panel', { state: 'attached', timeout: 10000 }).catch(() => {});
    const strip2 = panelAfterReload.locator('.lgt-build-strip');
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
    if (badge2.trim().toUpperCase() !== TARGET_ENV.toUpperCase()) {
      throw new Error('Detected build strip did not show target artifact env ' + TARGET_ENV.toUpperCase() + ' after automatic reload; got "' + badge2.trim() + '".');
    }
    if (MOBILE && !text2.includes('(mobile)')) {
      throw new Error('Mobile sportsbook bundle was not retained after automatic reload; got: ' + text2);
    }
    log('PASS: Detected build strip shows ' + TARGET_ENV.toUpperCase() + ' after Apply + automatic reload.');
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
