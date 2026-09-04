// Real-Chromium smoke for the Firestorm Oddin Statistics fix.
// Usage:
//   node test-oddin-extension-smoke.cjs "https://d-cf.test.sbplayground1.net/.../?bleSource=1..."
// Pass a direct event URL with the Statistics panel selected/openable. The
// script deliberately does not apply a Bundle Override: this smoke verifies
// the page's native TEST bundle together with the extension's independent
// Oddin, Sportradar and BLE routing features.
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { chromium } = require('playwright');

const EXT_PATH = path.resolve(__dirname, 'extension');
const TOKEN = 'b1248112-ccd9-4908-a9fd-acedb48d2c54';
const targetUrl = process.argv[2] || process.env.LGT_ODDIN_TEST_URL;

if (!targetUrl || !/^https:\/\/(?:d-cf|m-cf)\.(?:test|qa)\.sbplayground1\.net\//.test(targetUrl)) {
  console.error('Pass a Firestorm TEST/QA direct-event URL as argv[2] or LGT_ODDIN_TEST_URL.');
  process.exit(2);
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lgt-oddin-smoke-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: process.env.LGT_HEADFUL ? false : true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run']
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    sw.on('console', (message) => console.log('[service-worker]', message.type(), message.text()));
    const page = await context.newPage();
    const oddin = [];
    const forbidden403 = [];

    page.on('response', async (response) => {
      const url = response.url();
      if (!url.startsWith('https://disir.oddin.gg/') || !url.includes(TOKEN)) return;
      const headers = await response.request().allHeaders().catch(() => ({}));
      const item = { url, status: response.status(), referer: headers.referer || null };
      oddin.push(item);
      if (item.status === 403) forbidden403.push(item);
      console.log('[oddin-smoke]', JSON.stringify(item));
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const tab = await sw.evaluate(async (url) => {
      const hostname = new URL(url).hostname;
      const tabs = await chrome.tabs.query({ url: `*://${hostname}/*` });
      return tabs.find((item) => item.active) || tabs[0];
    }, targetUrl);
    if (!tab) throw new Error('Could not resolve the Firestorm tab id.');

    const rules = await sw.evaluate(async (tabId) => (await chrome.declarativeNetRequest.getSessionRules())
      .filter((rule) => rule.id >= 990001 && rule.id <= 1009999 && rule.condition.tabIds.includes(tabId)), tab.id);
    if (rules.length !== 1) {
      const diagnostic = await sw.evaluate(async ({ tabId, url }) => {
        try {
          await oddinFix.reconcileNavigation({ frameId: 0, tabId, url });
          return { globals: [typeof LgtOddinFix, typeof oddinFix], rules: await chrome.declarativeNetRequest.getSessionRules() };
        } catch (error) {
          return { globals: [typeof LgtOddinFix, typeof oddinFix], error: String(error && error.stack || error) };
        }
      }, { tabId: tab.id, url: targetUrl });
      throw new Error('Expected exactly one auto-installed tab-scoped Oddin DNR rule; diagnostic=' + JSON.stringify(diagnostic));
    }
    const rule = rules[0];
    if (JSON.stringify(rule.condition.requestDomains) !== JSON.stringify(['disir.oddin.gg']) ||
        JSON.stringify(rule.condition.resourceTypes) !== JSON.stringify(['sub_frame'])) {
      throw new Error('Oddin DNR rule is not narrowly scoped: ' + JSON.stringify(rule));
    }

    // Direct event links usually open Match first. Select Statistics when it
    // is available, without guessing an event or changing sportsbook state.
    const statistics = page.getByText('Statistics', { exact: true }).first();
    if (await statistics.isVisible({ timeout: 15000 }).catch(() => false)) await statistics.click();

    // Optional deterministic provider probe for times when the supplied live
    // event has already ended between link creation and the smoke run. This
    // still performs a real sub-frame navigation from the Firestorm page and
    // validates the real Oddin response/render path; it does not mock or
    // intercept the provider.
    if (process.env.LGT_ODDIN_PROBE_URL) {
      await page.evaluate((url) => {
        const frame = document.createElement('iframe');
        frame.id = 'lgt-oddin-smoke-probe';
        frame.src = url;
        document.body.appendChild(frame);
      }, process.env.LGT_ODDIN_PROBE_URL);
    }

    await page.waitForResponse((response) => response.url().startsWith('https://disir.oddin.gg/') &&
      response.url().includes(TOKEN) && response.status() === 200, { timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(2000);

    if (!oddin.length) {
      const links = await page.locator('a').evaluateAll((items) => items.slice(0, 80).map((item) => ({
        text: (item.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        href: item.href
      })).filter((item) => item.text || /eventId|live/i.test(item.href)));
      throw new Error('No Firestorm-token Oddin iframe request was observed; use a direct event URL that exposes Statistics. Visible links=' + JSON.stringify(links));
    }
    if (oddin[0].referer !== 'https://d-cf.alpha.sbplayground1.net/') {
      throw new Error('First Oddin iframe request did not use the ALPHA Referer: ' + JSON.stringify(oddin[0]));
    }
    const success = oddin.find((item) => item.status === 200);
    if (!success) throw new Error('Oddin iframe never returned 200: ' + JSON.stringify(oddin));
    if (forbidden403.length > 1) throw new Error('Oddin fallback loop detected: ' + JSON.stringify(oddin));

    const oddinFrame = page.frames().find((frame) => frame.url().startsWith('https://disir.oddin.gg/') && frame.url().includes(TOKEN));
    if (!oddinFrame) throw new Error('Oddin response succeeded but no matching iframe is attached.');
    const bodyText = await oddinFrame.locator('body').innerText({ timeout: 15000 }).catch(() => '');
    if (bodyText.trim().length < 20) throw new Error('Oddin iframe returned 200 but did not render meaningful statistics content.');

    console.log('PASS: Oddin Statistics rendered with a narrow tab-scoped rule; requests=' + JSON.stringify(oddin));
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
