'use strict';

// Regression test for the layer-detect.js MAIN-world poller itself (not
// the mocked computeDetectionRows() classifier covered by
// test-layer-detection.cjs). Real sportsbook runtime contexts hydrate
// PROGRESSIVELY within a single page load - e.g. window.sbMfeStartupContext
// can appear first with only appContext.version set, then get
// appContext.environment/brandId a tick or two later once the app finishes
// bootstrapping (verified directly against a real live QA brand page).
//
// layer-detect.js used to stop polling for good the moment ANY marker was
// found at all (`return` inside `if (markers.length)`), freezing that
// first - sometimes incomplete - snapshot forever. This test serves a
// fixture page whose inline script mutates window.sbMfeStartupContext in
// two stages (partial, then complete) and asserts background.js's
// runtimeMarkersByTab eventually reflects the COMPLETE second stage, not
// just the first partial one.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const PAGE_URL = 'https://d-cf.qa.sbplayground1.net/layer-marker-polling-fixture/';

// Stage 1 (present immediately): version only, no environment/brandId -
// exactly the kind of incomplete first snapshot the old code would have
// frozen on. Stage 2 (applied ~1.2s later, well within the 1s poll
// interval's next couple of ticks): the same object gains environment
// and brandId, mirroring real progressive hydration.
const FIXTURE_HTML = `<!doctype html>
<title>Layer marker polling fixture</title>
<main>fixture</main>
<script>
  window.sbMfeStartupContext = { appContext: { version: '8.2.5.4941-reba6fd9' } };
  setTimeout(function () {
    window.sbMfeStartupContext = {
      brandId: 'cfe0dfc1-9a3c-41cb-8817-7b3e71fddc9f',
      brandName: 'betsafe',
      appContext: { version: '8.2.5.4941-reba6fd9', environment: 'qa' }
    };
  }, 1200);
</script>`;

async function main() {
  const extensionPath = path.resolve(__dirname, 'extension');
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), 'lgt-layer-marker-polling-' + Date.now()),
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
    await context.route('https://d-cf.qa.sbplayground1.net/**', async (route) => {
      if (route.request().url() === PAGE_URL) {
        await route.fulfill({ contentType: 'text/html', body: FIXTURE_HTML });
        return;
      }
      await route.abort();
    });

    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const page = await context.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    async function readMfeMarker() {
      return serviceWorker.evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true });
        const tabId = tabs[0].id;
        const byFrame = runtimeMarkersByTab[tabId];
        return byFrame && byFrame[0] && byFrame[0].mfe;
      });
    }

    // Right after the fixture loads, layer-detect.js's first tick should
    // already have posted the STAGE 1 (incomplete) snapshot.
    const deadlineStage1 = Date.now() + 10000;
    let stage1;
    for (;;) {
      stage1 = await readMfeMarker();
      if (stage1) break;
      if (Date.now() > deadlineStage1) throw new Error('Timed out waiting for the first (partial) marker snapshot.');
      await page.waitForTimeout(200);
    }
    assert.equal(stage1.version, '8.2.5.4941-reba6fd9');
    assert.ok(!stage1.environment, 'stage 1 snapshot should not have an environment yet (this is the point of the test)');
    console.log('PASS: first tick captures the initial (incomplete) marker snapshot, version-only.');

    // The OLD code would stop polling here forever. The FIX must keep
    // polling and pick up the stage-2 mutation once it lands.
    const deadlineStage2 = Date.now() + 15000;
    let stage2;
    for (;;) {
      stage2 = await readMfeMarker();
      if (stage2 && stage2.environment) break;
      if (Date.now() > deadlineStage2) {
        throw new Error(
          'Timed out waiting for the LATER, complete marker snapshot to be picked up. ' +
          'Last seen: ' + JSON.stringify(stage2) +
          ' - this means layer-detect.js stopped polling after the first (incomplete) read, ' +
          'which is exactly the bug this test guards against.'
        );
      }
      await page.waitForTimeout(200);
    }
    assert.equal(stage2.environment, 'qa');
    assert.equal(stage2.brandId, 'cfe0dfc1-9a3c-41cb-8817-7b3e71fddc9f');
    assert.equal(stage2.brandName, 'betsafe');
    console.log('PASS: a later tick picks up the completed marker snapshot (brandId+environment) instead of staying frozen on the first partial one.');

    console.log('ALL PASS: layer-detect.js keeps polling past the first successful read so progressively-hydrated runtime contexts are eventually captured in full.');
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
