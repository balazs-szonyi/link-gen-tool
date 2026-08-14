#!/usr/bin/env node
'use strict';

// Parameterized logged-out smoke. This is intentionally outside `npm test`:
// it opens the dedicated real Chrome profile and reaches live environments.
const { createLab } = require('./server.cjs');
const { LabBrowser } = require('./lib/browser.cjs');
const { BRANDS } = require('./lib/model.cjs');

const config = {
  brand: process.env.LGT_BRAND || 'nordicbet',
  pageEnv: process.env.LGT_PAGE_ENV || 'test',
  bundleEnv: process.env.LGT_BUNDLE_ENV || 'prod',
  mode: process.env.LGT_MODE || 'hybrid',
  device: process.env.LGT_DEVICE || 'desktop',
};

async function main() {
  const browser = new LabBrowser({ profileDir: require('node:path').join(__dirname, '.chrome-profile-e2e') });
  const lab = createLab({ token: 'live-smoke-token', browser });
  await new Promise((resolve) => lab.server.listen(8845, '127.0.0.1', resolve));
  const port = 8845;
  try {
    const setup = await fetch(`http://127.0.0.1:${port}/v1/session`, {
      method: 'PUT', headers: { authorization: 'Bearer live-smoke-token', 'content-type': 'application/json' }, body: JSON.stringify(config),
    });
    if (!setup.ok) throw new Error(`session setup failed: ${await setup.text()}`);
    const page = browser.page;
    const context = browser.context;
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const coreFailures = [];
    const bundleRequests = [];
    page.on('requestfinished', (request) => {
      if (/\/files\/[a-zA-Z0-9]+[.-][^/?]+\.m?js/i.test(request.url())) bundleRequests.push(request.url());
    });
    page.on('response', async (response) => {
      if (response.status() >= 400 && /client.?config|static.?context|user.?context|\/api\/sb\/|\/sb\/fe-api\//i.test(response.url())) {
        const request = response.request();
        let bodyKeys = [];
        try { bodyKeys = Object.keys(JSON.parse(request.postData() || '{}')); } catch {}
        let responseText = '';
        try { responseText = (await response.text()).slice(0, 500); } catch {}
        coreFailures.push({ status: response.status(), url: response.url(), method: request.method(), requestHeaderNames: Object.keys(request.headers()).sort(), bodyKeys, responseText });
      }
    });
    await page.locator('#lgt-panel').waitFor({ state: 'attached', timeout: 15000 });
    if (!(await page.locator('#lgt-panel').isVisible())) {
      await sw.evaluate(async ({ targetUrl, domain }) => {
        const tabs = await chrome.tabs.query({ url: '*://*.' + domain + '/*' });
        const target = tabs.find((tab) => targetUrl.startsWith(tab.url) || tab.url.startsWith(targetUrl));
        if (target) chrome.tabs.sendMessage(target.id, { type: 'lgt-toggle-panel' }, () => void chrome.runtime.lastError);
      }, { targetUrl: page.url().replace(/\/$/, ''), domain: BRANDS[config.brand].domain });
    }
    await page.locator('#lgt-panel').waitFor({ state: 'visible', timeout: 15000 });
    const panel = page.locator('#lgt-panel');
    await panel.locator('.lgt-tab').filter({ hasText: 'Bundle' }).click();
    const selects = panel.locator('select:visible');
    await selects.nth(0).selectOption(config.brand);
    await selects.nth(1).selectOption(config.pageEnv);
    await selects.nth(3).selectOption(config.mode);
    await selects.nth(2).selectOption(config.bundleEnv);
    await panel.locator('select:visible').nth(4).selectOption(config.device);
    await panel.locator('input[placeholder^="One-time token"]').fill('live-smoke-token');
    const navigation = page.waitForEvent('domcontentloaded', { timeout: 30000 });
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    const applyOutcome = await Promise.race([
      navigation.then(() => 'navigated'),
      page.waitForFunction(() => {
        const visible = [...document.querySelectorAll('#lgt-panel .lgt-log')].find((item) => getComputedStyle(item).display !== 'none' && item.offsetParent);
        return visible && /Failed:|refused:|Blocked:/.test(visible.textContent) ? visible.textContent : false;
      }, null, { timeout: 15000 }).then((handle) => handle.jsonValue()),
    ]);
    if (applyOutcome !== 'navigated') throw new Error(`Apply did not start: ${applyOutcome}`);
    await page.waitForTimeout(8000);
    const redirectUrls = await sw.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules())
      .filter((rule) => rule.id >= 930001 && rule.id < 950001)
      .map((rule) => rule.action && rule.action.redirect && rule.action.redirect.url).filter(Boolean));
    if (!redirectUrls.some((url) => url.includes(`/dist/${config.bundleEnv}/`))) {
      throw new Error(`target bundle rules not installed: ${JSON.stringify(redirectUrls)}`);
    }
    if (!bundleRequests.some((url) => url.includes(`/dist/${config.bundleEnv}/`))) {
      throw new Error(`target bundle request not observed: ${JSON.stringify(bundleRequests.slice(0, 5))}`);
    }
    if (coreFailures.length) throw new Error(`core 4xx responses: ${JSON.stringify(coreFailures)}`);
    console.log(`PASS Host=${config.pageEnv.toUpperCase()} Bundle=${config.bundleEnv.toUpperCase()} Backend=${(config.mode === 'hybrid' ? config.pageEnv : config.bundleEnv).toUpperCase()}`);
  } finally {
    await new Promise((resolve) => lab.server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
