'use strict';

const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

async function main() {
  const extensionPath = path.resolve(__dirname, 'extension');
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), 'lgt-bundle-navigation-' + Date.now()),
    {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run']
    }
  );

  try {
    await context.route('https://www.test.betsson.com/**', async route => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Bundle navigation fixture</title>' });
    });
    const page = await context.newPage();
    const initial = 'https://www.test.betsson.com/en/sportsbook/live/tennis?exposeObgState=true&exposeObgRt=true&sealStore=false';
    await page.goto(initial, { waitUntil: 'domcontentloaded' });
    await page.locator('#lgt-panel').waitFor({ state: 'attached', timeout: 10000 });
    await page.evaluate(expectedUrl => {
      sessionStorage.setItem('__lgtBundleDiagnosticsV1', JSON.stringify({ expectedUrl }));
      history.pushState({}, '', '/en/horse-racing');
    }, initial);
    await page.waitForURL(url => url.pathname === '/en/horse-racing' &&
      url.searchParams.get('exposeObgState') === 'true' &&
      url.searchParams.get('exposeObgRt') === 'true' &&
      url.searchParams.get('sealStore') === 'false');

    // A full document navigation without the query must restore it as well.
    await page.goto('https://www.test.betsson.com/en/sportsbook', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(url => url.pathname === '/en/sportsbook' &&
      url.searchParams.get('exposeObgState') === 'true' &&
      url.searchParams.get('exposeObgRt') === 'true' &&
      url.searchParams.get('sealStore') === 'false');
    await page.waitForFunction(() => sessionStorage.getItem('__lgtBundleDiagnosticsV1') !== null);
    console.log('PASS: SPA and full same-tab navigation preserve bundle diagnostics across Horse Racing and Sportsbook.');
  } finally {
    await context.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
