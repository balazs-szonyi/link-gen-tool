'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const EXT_PATH = path.resolve(__dirname, 'extension');
const BRAND_IDS = {
  bets10: 'a3bd0e8c-37e4-434e-bb71-79c482ecf364',
  betssongr: '4bf6590d-0a29-47f5-a705-42b7a04b7878',
  sandbox: '33333333-3333-3333-3333-333333333333'
};

function customerFixtureFor(brandId) {
  if (brandId === BRAND_IDS.betssongr) {
    return { 'logged-out-en-eur-hgc': { label: 'EN - EUR - HGC - Logged Out' } };
  }
  if (brandId === BRAND_IDS.sandbox) {
    return {
      'logged-out-en-eur-mga-alpha': { label: 'EN - EUR - MGA - Alpha - Logged Out' },
      'logged-out-en-eur-ksa-beta': { label: 'EN - EUR - KSA - Beta - Logged Out' }
    };
  }
  return { 'logged-out-en-eur-tgc': { label: 'EN - EUR - TGC - Logged Out' } };
}

function metadataFixtureFor(brandId) {
  if (brandId === BRAND_IDS.betssongr) {
    return {
      supportedLanguages: [
        { languageCode: 'en', name: 'English' },
        { languageCode: 'el', name: 'Greek' }
      ],
      supportedCurrencies: [{ currencyCode: 'EUR', name: 'Euro' }]
    };
  }
  if (brandId === BRAND_IDS.sandbox) {
    return {
      supportedLanguages: [
        { languageCode: 'en', name: 'English' },
        { languageCode: 'sv', name: 'Swedish' }
      ],
      supportedCurrencies: [
        { currencyCode: 'EUR', name: 'Euro' },
        { currencyCode: 'SEK', name: 'Swedish Krona' }
      ]
    };
  }
  return {
    supportedLanguages: [
      { languageCode: 'en', name: 'English' },
      { languageCode: 'es', name: 'Spain' },
      { languageCode: 'tr', name: 'Turkish' }
    ],
    supportedCurrencies: [
      { currencyCode: 'EUR', name: 'Euro' },
      { currencyCode: 'TRY', name: 'New Turkish Lira' }
    ]
  };
}

function contextFixture(customerKey, environment) {
  const match = /^logged-out-([a-z]{2})-([a-z0-9]{3})-/i.exec(customerKey);
  const languageCode = match ? match[1].toLowerCase() : 'en';
  const currencyCode = match ? match[2].toUpperCase() : 'EUR';
  const host = environment === 'prod'
    ? 'https://7f2b8e.784b554.net'
    : `https://d-cf.${environment}.exampleplayground.net`;
  const mobileHost = environment === 'prod'
    ? 'https://d4a9c1.784b554.net'
    : host.replace('d-cf', 'm-cf');
  return {
    data: {
      user: {
        desktop: {
          loggedOutCustomer: {
            languageCode,
            customerWallets: { activeWalletCurrency: currencyCode }
          },
          iFrameSetup: { overrideIFrameBaseUrlWith: host }
        },
        mobile: {
          loggedOutCustomer: {
            languageCode,
            customerWallets: { activeWalletCurrency: currencyCode }
          },
          iFrameSetup: { overrideIFrameBaseUrlWith: environment === 'prod' ? '' : mobileHost }
        }
      },
      context: {
        desktop: {
          responseCode: 100,
          customerContext: { staticContextId: `stc-${languageCode}-${currencyCode}`, userContextId: `ctx-${languageCode}-${currencyCode}` },
          iFrameHelper: { baseUri: host }
        },
        mobile: {
          responseCode: 100,
          customerContext: { staticContextId: `mstc-${languageCode}-${currencyCode}`, userContextId: `mctx-${languageCode}-${currencyCode}` },
          iFrameHelper: { baseUri: mobileHost }
        }
      }
    }
  };
}

async function togglePanel(context, page) {
  await page.locator('#lgt-panel').waitFor({ state: 'attached', timeout: 15000 });
  await page.waitForTimeout(500);
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://internal.test.sbplayground1.net/*' });
    await new Promise((resolve) => chrome.tabs.sendMessage(tabs[0].id, { type: 'lgt-toggle-panel' }, () => resolve()));
  });
  await page.locator('#lgt-panel').waitFor({ state: 'visible' });
}

async function main() {
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), `lgt-locale-${Date.now()}`),
    {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run']
    }
  );

  try {
    const page = await context.newPage();
    const requestedContextKeys = [];

    await page.route(/https:\/\/internal\.(test|qa|alpha|prod)\.sbplayground1\.net\/api\/customers\/([^/?]+)/, async (route) => {
      const brandId = new URL(route.request().url()).pathname.split('/').pop();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(customerFixtureFor(brandId)) });
    });
    await page.route(/https:\/\/internal\.(test|qa|alpha|prod)\.sbplayground1\.net\/api\/brands\/([^/?]+)/, async (route) => {
      const url = new URL(route.request().url());
      const environment = url.hostname.split('.')[1];
      const brandId = url.pathname.split('/').pop();
      if (brandId === BRAND_IDS.sandbox && (environment === 'alpha' || environment === 'prod')) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: metadataFixtureFor(brandId) })
      });
    });
    await page.route(/https:\/\/internal\.(test|qa|alpha|prod)\.sbplayground1\.net\/api\/user-context\/([^?]+)/, async (route) => {
      const url = new URL(route.request().url());
      const customerKey = decodeURIComponent(url.pathname.split('/').pop());
      const environment = url.hostname.split('.')[1];
      requestedContextKeys.push(customerKey);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(contextFixture(customerKey, environment))
      });
    });

    await page.goto('https://internal.test.sbplayground1.net/', { waitUntil: 'domcontentloaded' });
    await togglePanel(context, page);
    let panel = page.locator('#lgt-panel');

    await panel.locator('#lgt-gen-brand').selectOption('bets10');
    await panel.locator('#lgt-gen-language').waitFor({ state: 'visible' });
    await panel.locator('#lgt-gen-currency').waitFor({ state: 'visible' });
    assert.strictEqual(await panel.locator('#lgt-gen-language option').count(), 3);
    assert.strictEqual(await panel.locator('#lgt-gen-currency option').count(), 2);
    await panel.locator('#lgt-gen-language').selectOption('tr');
    await panel.locator('#lgt-gen-currency').selectOption('TRY');
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await panel.getByText(/Turkish \(TR\).*New Turkish Lira \(TRY\).*Logged Out/).waitFor();
    assert(requestedContextKeys.includes('logged-out-tr-try-tgc'), 'Generate did not request the exact TR/TRY context key');
    const bets10BrandPage = panel.locator('.lgt-link-row').filter({ hasText: 'Brand page' });
    assert.strictEqual(
      await bets10BrandPage.locator('.lgt-link-url').textContent(),
      'https://www.test.bets10.com/tr/sportsbook',
      'Brand page must open the selected locale\'s Sportsbook section instead of the brand homepage'
    );
    if (process.env.LGT_SCREENSHOT) {
      await panel.screenshot({ path: process.env.LGT_SCREENSHOT });
      console.log(`Screenshot: ${process.env.LGT_SCREENSHOT}`);
    }

    const bleForBets10 = panel.getByText('BLE source', { exact: true }).locator('input');
    await bleForBets10.check();
    await panel.locator('.lgt-context-options').waitFor({ state: 'visible' });
    await panel.locator('.lgt-context-options').evaluate((node) => new Promise((resolve) => {
      if (node.getAttribute('aria-busy') === 'false') { resolve(); return; }
      const observer = new MutationObserver(() => {
        if (node.getAttribute('aria-busy') === 'false') { observer.disconnect(); resolve(); }
      });
      observer.observe(node, { attributes: true, attributeFilter: ['aria-busy'] });
    }));
    await panel.locator('#lgt-gen-language').selectOption('tr');
    await panel.locator('#lgt-gen-currency').selectOption('TRY');
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await panel.getByText('https://d-cf.test.exampleplayground.net/stc-tr-TRY/ctx-tr-TRY/?bleSource=1', { exact: false }).waitFor();
    await panel.getByText('https://m-cf.test.exampleplayground.net/mstc-tr-TRY/mctx-tr-TRY/?bleSource=1', { exact: false }).waitFor();
    assert.strictEqual(await panel.getByText(/784b554\.net/).count(), 0, 'Opaque PROD host leaked into a TEST BLE link');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#lgt-panel').waitFor({ state: 'attached', timeout: 15000 });
    await page.locator('#lgt-panel').evaluate((element) => { element.style.display = 'block'; });
    panel = page.locator('#lgt-panel');
    await panel.locator('#lgt-gen-language').waitFor({ state: 'visible' });
    assert.strictEqual(await panel.locator('#lgt-gen-brand').inputValue(), 'bets10');
    assert.strictEqual(await panel.locator('#lgt-gen-language').inputValue(), 'tr');
    assert.strictEqual(await panel.locator('#lgt-gen-currency').inputValue(), 'TRY');

    await panel.locator('#lgt-gen-brand').selectOption('betssongr');
    await panel.locator('#lgt-gen-language').waitFor({ state: 'visible' });
    await panel.locator('#lgt-gen-currency').waitFor({ state: 'hidden' });
    assert.strictEqual(await panel.locator('#lgt-gen-currency').inputValue(), 'EUR');

    await panel.locator('#lgt-gen-login-state').selectOption('in');
    await panel.locator('#lgt-gen-language').waitFor({ state: 'hidden' });
    await panel.locator('#lgt-gen-currency').waitFor({ state: 'hidden' });
    await panel.locator('#lgt-gen-login-state').selectOption('out');

    await panel.locator('#lgt-gen-brand').selectOption('sandbox');
    const ble = panel.getByText('BLE source', { exact: true }).locator('input');
    if (!(await ble.isChecked())) await ble.check();
    await panel.getByText(/QA metadata fallback/).waitFor();
    await panel.locator('#lgt-gen-language').waitFor({ state: 'visible' });
    await panel.locator('#lgt-gen-currency').waitFor({ state: 'visible' });
    await panel.locator('#lgt-gen-customer').selectOption('logged-out-en-eur-ksa-beta');
    await panel.locator('#lgt-gen-language').selectOption('sv');
    await panel.locator('#lgt-gen-currency').selectOption('SEK');
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await panel.getByText(/Swedish \(SV\).*Swedish Krona \(SEK\).*Logged Out/).waitFor();
    assert(requestedContextKeys.includes('logged-out-sv-sek-ksa-beta'), 'Customer profile suffix was not preserved');

    // Exercise the actual Open action, not only the displayed URL. Keep it
    // last because opening an active tab deliberately changes Chrome's
    // active-tab state, which is outside the locale-generation assertions.
    await panel.locator('#lgt-gen-brand').selectOption('arcticbet');
    await panel.locator('.lgt-context-options[aria-busy="false"]').waitFor();
    const finalBle = panel.getByText('BLE source', { exact: true }).locator('input');
    if (await finalBle.isChecked()) {
      await finalBle.uncheck();
      await panel.locator('.lgt-context-options[aria-busy="false"]').waitFor();
    }
    await panel.locator('#lgt-gen-language').waitFor({ state: 'visible' });
    await panel.locator('#lgt-gen-language').selectOption('en');
    await panel.locator('#lgt-gen-currency').selectOption('EUR');
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    const finalBrandPage = panel.locator('.lgt-link-row').filter({ hasText: 'Brand page' });
    await context.route('https://www.test.arcticbet.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>ArcticBet Sportsbook target</title>' });
    });
    const openedBrandPagePromise = context.waitForEvent('page');
    await finalBrandPage.getByRole('button', { name: 'Open', exact: true }).click();
    const openedBrandPage = await openedBrandPagePromise;
    await openedBrandPage.waitForLoadState('domcontentloaded');
    assert.strictEqual(
      openedBrandPage.url(),
      'https://www.test.arcticbet.com/en/sportsbook',
      'Open must navigate to the exact Sportsbook URL displayed in the Brand page row'
    );
    await openedBrandPage.close();

    console.log('PASS: locale context generation, persistence, Sandbox fallback, and exact Brand page Open navigation work.');
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
