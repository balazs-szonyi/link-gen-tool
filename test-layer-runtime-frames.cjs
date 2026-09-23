'use strict';

// End-to-end coverage for the real MAIN -> postMessage -> ISOLATED relay ->
// service-worker -> panel path in both a brand top frame and a cross-origin
// sportsbook iframe. No detection state is seeded by the test.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const BRAND_URL = 'https://www.test.betsson.com/en/sportsbook/runtime-layer-fixture';
const IFRAME_URL = 'https://d-cf.test.btsplayground.net/runtime-layer-frame/';

const BRAND_HTML = `<!doctype html>
<title>Brand runtime layer fixture</title>
<script>
  window.sbMfeStartupContext = {
    brandId: '6a6d80b9-16ac-4387-a413-244d93a74deb',
    brandName: 'betsson',
    appContext: { version: '9.1.0-mfe', environment: 'test' }
  };
</script>
<main>brand fixture</main>
<iframe title="sportsbook runtime" src="${IFRAME_URL}"></iframe>`;

const IFRAME_HTML = `<!doctype html>
<title>Iframe runtime layer fixture</title>
<script>
  window.obgClientEnvironmentConfig = {
    startupContext: {
      brandId: 'cfe0dfc1-9a3c-41cb-8817-7b3e71fddc9f',
      brandName: 'betsafe',
      appContext: { version: '9.1.0-fabric', environment: 'test' }
    }
  };
</script>
<main>iframe fixture</main>`;

async function main() {
  const extensionPath = path.resolve(__dirname, 'extension');
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), 'lgt-layer-runtime-frames-' + Date.now()),
    {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
      ],
    }
  );

  try {
    await context.route('https://www.test.betsson.com/**', route =>
      route.fulfill({ contentType: 'text/html', body: BRAND_HTML }));
    await context.route('https://d-cf.test.btsplayground.net/**', route =>
      route.fulfill({ contentType: 'text/html', body: IFRAME_HTML }));

    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const page = await context.newPage();
    await page.goto(BRAND_URL, { waitUntil: 'load', timeout: 30000 });
    await page.locator('iframe[title="sportsbook runtime"]').waitFor({ state: 'attached' });

    const deadline = Date.now() + 15000;
    let snapshot;
    for (;;) {
      snapshot = await serviceWorker.evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true });
        return detection.snapshot(tabs[0].id);
      });
      const runtimeFrames = Object.values(snapshot.runtimeByFrame || {});
      if (runtimeFrames.some(frame => frame.mfe) && runtimeFrames.some(frame => frame.iframe)) break;
      if (Date.now() > deadline) throw new Error('Timed out waiting for top-frame MFE and cross-origin iframe runtime markers: ' + JSON.stringify(snapshot));
      await page.waitForTimeout(200);
    }

    const runtimeEntries = Object.entries(snapshot.runtimeByFrame);
    const mfeEntry = runtimeEntries.find(([, frame]) => frame.mfe);
    const iframeEntry = runtimeEntries.find(([, frame]) => frame.iframe);
    assert.equal(mfeEntry[0], '0');
    assert.notEqual(iframeEntry[0], '0');
    assert.equal(mfeEntry[1].mfe.version, '9.1.0-mfe');
    assert.equal(iframeEntry[1].iframe.version, '9.1.0-fabric');

    await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true });
      await new Promise(resolve => chrome.tabs.sendMessage(tabs[0].id, { type: 'lgt-toggle-panel' }, resolve));
    });
    const panel = page.locator('#lgt-panel');
    await panel.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('#lgt-panel .lgt-build-row').length === 2);
    const rows = await panel.locator('.lgt-build-row').allInnerTexts();
    assert.ok(rows.some(row => /Betsson.*MFE.*v9\.1\.0-mfe.*TEST.*Partially verified/s.test(row)), rows.join('\n'));
    assert.ok(rows.some(row => /Betsafe.*Fabric.*v9\.1\.0-fabric.*TEST.*Partially verified/s.test(row)), rows.join('\n'));

    console.log('PASS: brand top-frame MFE and cross-origin iframe Fabric markers both traverse the real relay and render in the panel.');
  } finally {
    await context.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
