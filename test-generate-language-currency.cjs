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
  const host = `https://d-cf.${environment}.exampleplayground.net`;
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
          iFrameSetup: { overrideIFrameBaseUrlWith: host.replace('d-cf', 'm-cf') }
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
          iFrameHelper: { baseUri: host.replace('d-cf', 'm-cf') }
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
    if (process.env.LGT_SCREENSHOT) {
      await panel.screenshot({ path: process.env.LGT_SCREENSHOT });
      console.log(`Screenshot: ${process.env.LGT_SCREENSHOT}`);
    }
    await panel.locator('#lgt-gen-language').selectOption('tr');
    await panel.locator('#lgt-gen-currency').selectOption('TRY');
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await panel.getByText(/Turkish \(TR\).*New Turkish Lira \(TRY\).*Logged Out/).waitFor();
    assert(requestedContextKeys.includes('logged-out-tr-try-tgc'), 'Generate did not request the exact TR/TRY context key');

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
    await ble.check();
    await panel.getByText(/QA metadata fallback/).waitFor();
    await panel.locator('#lgt-gen-language').waitFor({ state: 'visible' });
    await panel.locator('#lgt-gen-currency').waitFor({ state: 'visible' });
    await panel.locator('#lgt-gen-customer').selectOption('logged-out-en-eur-ksa-beta');
    await panel.locator('#lgt-gen-language').selectOption('sv');
    await panel.locator('#lgt-gen-currency').selectOption('SEK');
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await panel.getByText(/Swedish \(SV\).*Swedish Krona \(SEK\).*Logged Out/).waitFor();
    assert(requestedContextKeys.includes('logged-out-sv-sek-ksa-beta'), 'Customer profile suffix was not preserved');

    console.log('PASS: logged-out Language/Currency controls, context generation, persistence and Sandbox fallback work.');
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
