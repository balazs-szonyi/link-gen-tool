'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION_PATH = path.resolve(__dirname, 'extension');
const PAGE_URL = 'https://internal.test.sbplayground1.net/layout-fixture/';

function contextFixture(customerKey) {
  const match = /^logged-out-([a-z]{2})-([a-z0-9]{3})-/i.exec(customerKey);
  const languageCode = match ? match[1].toLowerCase() : 'en';
  const currencyCode = match ? match[2].toUpperCase() : 'EUR';
  return {
    data: {
      user: {
        desktop: {
          loggedOutCustomer: {
            languageCode,
            customerWallets: { activeWalletCurrency: currencyCode }
          },
          iFrameSetup: { overrideIFrameBaseUrlWith: 'https://d-cf.test.exampleplayground.net' }
        },
        mobile: {
          loggedOutCustomer: {
            languageCode,
            customerWallets: { activeWalletCurrency: currencyCode }
          },
          iFrameSetup: { overrideIFrameBaseUrlWith: 'https://m-cf.test.exampleplayground.net' }
        }
      },
      context: {
        desktop: {
          responseCode: 100,
          customerContext: { staticContextId: 'desktop-stc', userContextId: 'desktop-ctx' },
          iFrameHelper: { baseUri: 'https://d-cf.test.exampleplayground.net' }
        },
        mobile: {
          responseCode: 100,
          customerContext: { staticContextId: 'mobile-stc', userContextId: 'mobile-ctx' },
          iFrameHelper: { baseUri: 'https://m-cf.test.exampleplayground.net' }
        }
      }
    }
  };
}

async function main() {
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), `lgt-panel-layout-${Date.now()}`),
    {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run'
      ]
    }
  );

  try {
    await context.route(PAGE_URL, async (route) => {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Layout fixture</title><main style="height:3000px">fixture</main>'
      });
    });
    await context.route(/https:\/\/internal\.(test|qa|alpha|prod)\.sbplayground1\.net\/api\/customers\/([^/?]+)/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ 'logged-out-en-eur-mga': { label: 'EN - EUR - MGA - Logged Out' } })
      });
    });
    await context.route(/https:\/\/internal\.(test|qa|alpha|prod)\.sbplayground1\.net\/api\/brands\/([^/?]+)/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            supportedLanguages: [
              { languageCode: 'en', name: 'English' },
              { languageCode: 'sv', name: 'Swedish' }
            ],
            supportedCurrencies: [
              { currencyCode: 'EUR', name: 'Euro' },
              { currencyCode: 'SEK', name: 'Swedish Krona' }
            ]
          }
        })
      });
    });
    await context.route(/https:\/\/internal\.(test|qa|alpha|prod)\.sbplayground1\.net\/api\/user-context\/([^?]+)/, async (route) => {
      const url = new URL(route.request().url());
      const customerKey = decodeURIComponent(url.pathname.split('/').pop());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(contextFixture(customerKey))
      });
    });

    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const page = await context.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    const panel = page.locator('#lgt-panel');
    await panel.waitFor({ state: 'attached', timeout: 15000 });
    await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://internal.test.sbplayground1.net/*' });
      await new Promise((resolve) => chrome.tabs.sendMessage(tabs[0].id, { type: 'lgt-toggle-panel' }, resolve));
    });
    await panel.waitFor({ state: 'visible' });
    await panel.locator('.lgt-context-options').evaluate((node) => new Promise((resolve) => {
      if (node.getAttribute('aria-busy') === 'false') { resolve(); return; }
      const observer = new MutationObserver(() => {
        if (node.getAttribute('aria-busy') === 'false') { observer.disconnect(); resolve(); }
      });
      observer.observe(node, { attributes: true, attributeFilter: ['aria-busy'] });
    }));

    const visibleTabLabels = async () => panel.locator('.lgt-tab:visible').allTextContents();
    assert.deepEqual(await visibleTabLabels(), ['Generate', 'Bundle', 'BLE Data', 'Credentials']);
    const moreTools = panel.getByRole('button', { name: 'More tools', exact: true });
    assert.equal((await moreTools.locator(':scope > span').nth(1).textContent()).trim(), 'More');
    assert.equal(await moreTools.getAttribute('aria-describedby'), 'lgt-more-tools-help');
    assert.match(await panel.locator('#lgt-more-tools-help').textContent(), /under development.*may not work reliably/i);
    assert.equal(await moreTools.getAttribute('aria-pressed'), 'false');
    assert.equal(await panel.getByText('Force fresh live-login', { exact: true }).isVisible(), false);
    assert.equal(await panel.getByText('Show login tab', { exact: true }).isVisible(), false);

    const environment = panel.locator('#lgt-gen-environment');
    const bleSource = panel.getByText('BLE source', { exact: true }).locator('input');
    assert.equal(await bleSource.isVisible(), true);
    await bleSource.check();
    await environment.selectOption('alpha');
    assert.equal(await bleSource.isVisible(), false, 'BLE source must be hidden on native-BLE environments');
    await environment.selectOption('test');
    assert.equal(await bleSource.isVisible(), true);
    assert.equal(await bleSource.isChecked(), true, 'TEST/QA BLE preference must survive a native-BLE environment');

    const validation = await serviceWorker.evaluate(() => {
      const valid = validateConfiguredBrandPageRequest({
        brand: 'arcticbet',
        brandId: BUNDLE_BRAND_GUIDS.arcticbet,
        environment: 'test',
        url: 'https://www.test.arcticbet.com/en/sportsbook',
        bleData: { alphaHost: 'd-cf.alpha.arcticbetplayground.net', stc: 'desktop-stc', ctx: 'desktop-ctx' }
      });
      let invalidError = '';
      try {
        validateConfiguredBrandPageRequest({
          brand: 'arcticbet',
          brandId: BUNDLE_BRAND_GUIDS.arcticbet,
          environment: 'prod',
          url: 'https://www.arcticbet.com/en/sportsbook',
          bleData: { alphaHost: 'd-cf.alpha.arcticbetplayground.net', stc: 'desktop-stc', ctx: 'desktop-ctx' }
        });
      } catch (error) { invalidError = error.message; }
      const peru = validateConfiguredBrandPageRequest({
        brand: 'betssonpe',
        brandId: BUNDLE_BRAND_GUIDS.betssonpe,
        environment: 'qa',
        url: 'https://www.qa.betsson.pe/en/sportsbook',
        bleData: { alphaHost: 'd-cf.alpha.btsplayground.net', stc: 'desktop-stc', ctx: 'desktop-ctx' }
      });
      return { host: valid.target.hostname, peruHost: peru.target.hostname, invalidError };
    });
    assert.equal(validation.host, 'www.test.arcticbet.com');
    assert.equal(validation.peruHost, 'www.qa.betsson.pe');
    assert.match(validation.invalidError, /only be configured for TEST or QA/);
    await environment.selectOption('alpha');
    await panel.locator('.lgt-context-options[aria-busy="false"]').waitFor();
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await panel.locator('.lgt-brand-launch-summary').filter({ hasText: 'ALPHA bundle · native BLE data' }).waitFor();
    await environment.selectOption('test');
    await panel.locator('.lgt-context-options[aria-busy="false"]').waitFor();
    await panel.locator('#lgt-gen-brand').selectOption('betssonpe');
    await environment.selectOption('qa');
    await panel.locator('.lgt-context-options[aria-busy="false"]').waitFor();
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    const peruBrandPage = panel.locator('.lgt-brand-link-row');
    await peruBrandPage.getByText('https://www.qa.betsson.pe/en/sportsbook', { exact: true }).waitFor();
    assert.equal(await peruBrandPage.getByRole('button', { name: 'Open configured', exact: true }).isEnabled(), true);
    assert.match(await panel.locator('.lgt-brand-launch-summary').textContent(), /QA bundle · ALPHA BLE data/);
    await panel.locator('#lgt-gen-brand').selectOption('arcticbet');
    await environment.selectOption('test');
    await panel.locator('.lgt-context-options[aria-busy="false"]').waitFor();

    const desktopLayout = await panel.evaluate((node) => ({
      overflowY: getComputedStyle(node).overflowY,
      panelBottom: node.getBoundingClientRect().bottom,
      viewportHeight: innerHeight,
      tabOverflowY: getComputedStyle(node.querySelector('#lgt-body-generate')).overflowY
    }));
    assert.equal(desktopLayout.overflowY, 'hidden');
    assert.equal(desktopLayout.tabOverflowY, 'scroll');
    assert(desktopLayout.panelBottom <= desktopLayout.viewportHeight, 'panel must stay inside the viewport');

    const alignedEdges = await panel.evaluate((node) => {
      const tabsRect = node.querySelector('.lgt-tabs').getBoundingClientRect();
      const brandRect = node.querySelector('#lgt-gen-brand').getBoundingClientRect();
      return {
        leftDifference: Math.abs(tabsRect.left - brandRect.left),
        rightDifference: Math.abs(tabsRect.right - brandRect.right)
      };
    });
    assert(alignedEdges.leftDifference <= 1, `left content edge differs: ${JSON.stringify(alignedEdges)}`);
    assert(alignedEdges.rightDifference <= 1, `right content edge differs: ${JSON.stringify(alignedEdges)}`);

    await moreTools.click();
    assert.deepEqual(await visibleTabLabels(), [
      'Generate', 'Bundle', 'BLE Data', 'Credentials', 'Live Login', 'Bonus Mock', 'Bet Void'
    ]);
    assert.equal(await moreTools.getAttribute('aria-pressed'), 'true');
    const storedOn = await serviceWorker.evaluate(async () => (await chrome.storage.local.get('lgt-ui-preferences-v1'))['lgt-ui-preferences-v1']);
    assert.deepEqual(storedOn, { showMoreTools: true });

    await panel.locator('.lgt-tab').filter({ hasText: 'Bonus Mock' }).click();
    await moreTools.click();
    assert.equal((await panel.locator('.lgt-tab.active').textContent()).trim(), 'Generate');
    assert.deepEqual(await visibleTabLabels(), ['Generate', 'Bundle', 'BLE Data', 'Credentials']);

    const loginState = panel.locator('#lgt-gen-login-state');
    await loginState.selectOption('in');
    const forceFresh = panel.getByText('Force fresh live-login', { exact: true }).locator('input');
    const showLogin = panel.getByText('Show login tab', { exact: true }).locator('input');
    await forceFresh.check();
    await showLogin.check();
    await loginState.selectOption('out');
    assert.equal(await panel.getByText('Force fresh live-login', { exact: true }).isVisible(), false);
    await loginState.selectOption('in');
    assert.equal(await forceFresh.isChecked(), true);
    assert.equal(await showLogin.isChecked(), true);
    await loginState.selectOption('out');

    await page.setViewportSize({ width: 1280, height: 480 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const compactEdges = await panel.evaluate((node) => {
      const tabsRect = node.querySelector('.lgt-tabs').getBoundingClientRect();
      const brandRect = node.querySelector('#lgt-gen-brand').getBoundingClientRect();
      return {
        leftDifference: Math.abs(tabsRect.left - brandRect.left),
        rightDifference: Math.abs(tabsRect.right - brandRect.right),
        scrollbarWidth: node.querySelector('#lgt-body-generate').offsetWidth - node.querySelector('#lgt-body-generate').clientWidth
      };
    });
    assert(compactEdges.scrollbarWidth >= 0, `invalid scrollbar width: ${JSON.stringify(compactEdges)}`);
    assert(compactEdges.leftDifference <= 1, `compact left content edge differs: ${JSON.stringify(compactEdges)}`);
    assert(compactEdges.rightDifference <= 1, `compact right content edge differs: ${JSON.stringify(compactEdges)}`);
    await page.evaluate(() => window.scrollTo(0, 400));
    const pageScrollBefore = await page.evaluate(() => window.scrollY);
    const generateBody = panel.locator('#lgt-body-generate');
    await generateBody.evaluate((node) => { node.scrollTop = 0; });
    const generateButton = panel.getByRole('button', { name: 'Generate', exact: true });
    await generateButton.evaluate((button) => button.click());
    await panel.locator('.lgt-result .lgt-link-row').filter({ hasText: 'Brand page' }).waitFor();
    const brandPageRow = panel.locator('.lgt-brand-link-row');
    assert.equal(await brandPageRow.getByRole('button').allTextContents().then((items) => items.join('|')), 'Open configured');
    assert.equal(await brandPageRow.getByRole('button', { name: 'Copy', exact: true }).count(), 0);
    assert.match(await panel.locator('.lgt-brand-launch-summary').textContent(), /TEST bundle · ALPHA BLE data/);
    assert.equal(await brandPageRow.isVisible(), true);
    await page.waitForTimeout(500);
    const scrollState = await generateBody.evaluate((node) => {
      const result = node.querySelector('.lgt-result');
      const bodyRect = node.getBoundingClientRect();
      const resultRect = result.getBoundingClientRect();
      return {
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        resultBottom: resultRect.bottom,
        bodyBottom: bodyRect.bottom
      };
    });
    assert(scrollState.scrollTop > 0, `Generate results should scroll the inner tabpanel: ${JSON.stringify(scrollState)}`);
    assert(scrollState.resultBottom <= scrollState.bodyBottom + 1, 'generated result should be visible after scrolling');
    assert.equal(await page.evaluate(() => window.scrollY), pageScrollBefore, 'host page must not scroll');

    console.log('PASS: compact layout, More tools, contextual options, configured Brand page and result auto-scroll work.');
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
