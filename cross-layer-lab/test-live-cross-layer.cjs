#!/usr/bin/env node
'use strict';

// Parameterized live smoke for the extension-only normal-Chrome runtime.
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { BRANDS } = require('./lib/model.cjs');

const config = {
  brand: process.env.LGT_BRAND || 'nordicbet',
  pageEnv: process.env.LGT_PAGE_ENV || 'test',
  bundleEnv: process.env.LGT_BUNDLE_ENV || 'prod',
  mode: process.env.LGT_MODE || 'hybrid',
  device: process.env.LGT_DEVICE || 'desktop',
};

async function main() {
  const extensionPath = path.resolve(__dirname, '..', 'extension');
  const profile = path.join(os.tmpdir(), `lgt-native-cross-${Date.now()}`);
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    viewport: config.device === 'mobile' ? { width: 470, height: 944 } : { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run'],
  });
  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const page = await context.newPage();
    const prefix = config.pageEnv === 'prod' ? 'www.' : `www.${config.pageEnv}.`;
    const targetUrl = `https://${prefix}${BRANDS[config.brand].domain}/en/sportsbook`;
    const coreFailures = [];
    const configResponses = [];
    const bundleRequests = [];
    const bundleFailures = [];
    page.on('request', (request) => {
      if (/\/files\/[a-zA-Z0-9]+[.-][^/?]+\.m?js/i.test(request.url())) bundleRequests.push(request.url());
    });
    page.on('requestfailed', (request) => {
      if (/\/files\/[a-zA-Z0-9]+[.-][^/?]+\.m?js/i.test(request.url())) bundleFailures.push({ url: request.url(), error: request.failure() });
      if (request.failure()?.errorText !== 'net::ERR_ABORTED' && /client.?config|\/dist\/(?:test|qa|alpha|prod)\/config\/|static.?context|user.?context|\/api\/sb\/|\/sb\/fe-api\//i.test(request.url())) {
        coreFailures.push({ status: 'requestfailed', url: request.url(), error: request.failure() });
      }
    });
    page.on('response', (response) => {
      if (/\/dist\/(?:test|qa|alpha|prod)\/config\//i.test(response.url())) {
        configResponses.push({ status: response.status(), url: response.url() });
      }
      if (response.status() >= 400 && /client.?config|\/dist\/(?:test|qa|alpha|prod)\/config\/|static.?context|user.?context|\/api\/sb\/|\/sb\/fe-api\//i.test(response.url())) {
        coreFailures.push({ status: response.status(), url: response.url() });
      }
    });
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('#lgt-panel').waitFor({ state: 'attached', timeout: 15000 });
    // Some brand shells perform one final top-level canonicalization shortly
    // after DOMContentLoaded. Applying during that hop correctly triggers the
    // extension's stale-navigation cleanup, which makes the test race the
    // page rather than exercise the settled URL a human would use.
    await page.waitForTimeout(3000);
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'lgt-toggle-panel' }, () => void chrome.runtime.lastError);
    });
    await page.locator('#lgt-panel').waitFor({ state: 'visible', timeout: 15000 });
    const panel = page.locator('#lgt-panel');
    await panel.locator('.lgt-tab').filter({ hasText: 'Bundle' }).click();
    const selects = panel.locator('select:visible');
    await selects.nth(0).selectOption(config.brand);
    await selects.nth(1).selectOption(config.pageEnv);
    await selects.nth(3).selectOption(config.mode);
    await selects.nth(2).selectOption(config.bundleEnv);
    if (config.mode !== 'standard') await selects.nth(4).selectOption(config.device);
    bundleRequests.length = 0; coreFailures.length = 0;
    const clearAtReload = (frame) => {
      if (frame !== page.mainFrame()) return;
      page.off('framenavigated', clearAtReload);
      bundleRequests.length = 0;
      bundleFailures.length = 0;
      coreFailures.length = 0;
      configResponses.length = 0;
    };
    page.on('framenavigated', clearAtReload);
    const navigation = page.waitForEvent('domcontentloaded', { timeout: 30000 });
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await navigation;
    await page.waitForTimeout(8000);
    const finalUrl = new URL(page.url());
    if (finalUrl.searchParams.get('exposeObgState') !== 'true' || finalUrl.searchParams.get('exposeObgRt') !== 'true' || finalUrl.searchParams.get('sealStore') !== 'false') {
      throw new Error(`diagnostic query parameters missing after Apply: ${finalUrl}`);
    }
    const runtime = await page.evaluate(() => window.__lgtCrossLayerRuntimeActive);
    const expectedBackendEnv = config.mode === 'hybrid' || config.mode === 'standard' ? config.pageEnv : config.bundleEnv;
    if (config.mode !== 'standard' && (!runtime || runtime.bundleEnv !== config.bundleEnv || runtime.backendEnv !== expectedBackendEnv)) {
      throw new Error(`MAIN-world runtime mismatch: ${JSON.stringify(runtime)}`);
    }
    const bundleRules = await sw.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules())
      .filter((rule) => rule.id >= 930001 && rule.id < 950001)
      .map((rule) => ({ regex: rule.condition.regexFilter, action: rule.action })));
    if (!bundleRequests.some((url) => url.includes(`/dist/${config.bundleEnv}/`))) {
      throw new Error(`target bundle request not observed: page=${page.url()} rules=${JSON.stringify(bundleRules)} requests=${JSON.stringify(bundleRequests.slice(0, 5))} failures=${JSON.stringify(bundleFailures.slice(0, 5))}`);
    }
    if (config.mode !== 'standard' && !bundleRules.some((rule) => rule.regex.includes(`/dist/${config.bundleEnv}/config/${BRANDS[config.brand].id}/`) &&
      rule.action.type === 'modifyHeaders' && rule.action.responseHeaders.some((header) => header.header === 'access-control-allow-origin' && header.value === '*'))) {
      throw new Error(`target ClientConfig CORS rule not installed: ${JSON.stringify(bundleRules)}`);
    }
    if (configResponses.length && !configResponses.some((response) => response.status < 400 && response.url.includes(`/dist/${config.bundleEnv}/config/`))) {
      throw new Error(`successful target ClientConfig response not observed: responses=${JSON.stringify(configResponses)} rules=${JSON.stringify(bundleRules)}`);
    }
    if (coreFailures.length) throw new Error(`core request failures: ${JSON.stringify(coreFailures)}`);
    if ((await page.locator('body').innerText()).includes('Failed to initialize Sportsbook')) {
      throw new Error('Sportsbook rendered its failed-initialization state');
    }
    console.log(`PASS Host=${config.pageEnv.toUpperCase()} Bundle=${config.bundleEnv.toUpperCase()} Backend=${expectedBackendEnv.toUpperCase()} (normal Chrome runtime)`);
  } finally { await context.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
