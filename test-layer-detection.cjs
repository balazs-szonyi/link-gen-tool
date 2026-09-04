'use strict';

// Local/mock regression for the brand+layer scoped SB detection engine
// (replaces the removed window.xSbState-based "Verify with page state"
// button and its test-page-state-verification.cjs). Uses the same
// pattern as the tool's other mock tests: a real unpacked-extension
// Chromium profile (chromium.launchPersistentContext), Playwright's
// context.route() to serve a fully local fixture page with NO real
// network access, and serviceWorker.evaluate() to seed background.js's
// own in-memory detection stores directly - this exercises the exact
// same computeDetectionRows() classifier and buildDetectionHeader() UI
// the real extension uses, without depending on any live brand/QA host.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const PAGE_URL = 'https://d-cf.qa.sbplayground1.net/layer-detection-fixture/';

async function main() {
  const extensionPath = path.resolve(__dirname, 'extension');
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), 'lgt-layer-detection-' + Date.now()),
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
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Layer detection fixture</title><main>fixture</main>' });
        return;
      }
      await route.abort();
    });

    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const page = await context.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(500);

    async function seed(runtimeMarkers, network, frameDoc) {
      await serviceWorker.evaluate(async ({ runtimeMarkers, network, frameDoc }) => {
        const tabs = await chrome.tabs.query({ active: true });
        const tabId = tabs[0].id;
        runtimeMarkersByTab[tabId] = runtimeMarkers;
        networkByTab[tabId] = network;
        frameDocByTab[tabId] = frameDoc;
      }, { runtimeMarkers, network, frameDoc });
    }

    // Seeds/clears the synchronous "Bundle Override is active on this tab"
    // cache directly (background.js normally sets this from the Bundle
    // tab's Apply/Stop handlers and the lgt-bundle-status poll) so the
    // classifier's bundleOverrideExplainsEnvDivergence check can be
    // exercised without actually driving the Bundle UI end-to-end.
    async function setBundleOverrideTarget(targetEnv) {
      await serviceWorker.evaluate(async (targetEnv) => {
        const tabs = await chrome.tabs.query({ active: true });
        const tabId = tabs[0].id;
        if (targetEnv) bundleTargetEnvByTab[tabId] = targetEnv;
        else delete bundleTargetEnvByTab[tabId];
      }, targetEnv);
    }

    // The header only refreshes on its own 3s poll (buildDetectionHeader's
    // pollWhileExtensionValid), so seeding new background.js state does
    // NOT update the DOM synchronously - a locator .waitFor() only waits
    // for the ELEMENT to exist, not for its text to catch up with the
    // latest seed. Poll .allInnerTexts() ourselves until it satisfies the
    // predicate (or time out), instead of racing the 3s refresh.
    async function waitForRows(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let lastTexts = [];
      for (;;) {
        lastTexts = await panelRows().allInnerTexts();
        if (predicate(lastTexts)) return lastTexts;
        if (Date.now() > deadline) {
          throw new Error('Timed out waiting for detection rows to match. Last seen: ' + JSON.stringify(lastTexts));
        }
        await page.waitForTimeout(250);
      }
    }

    // The panel starts hidden (display:none); lgt-toggle-panel is a pure
    // flip, so it must be sent exactly ONCE (to open) - never again per
    // scenario, or it would immediately close on the second seed.
    await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true });
      await new Promise((resolve) => chrome.tabs.sendMessage(tabs[0].id, { type: 'lgt-toggle-panel' }, resolve));
    });

    // Scenario 1: MFE layer Confirmed - runtime marker and network
    // observation agree on version+environment for the SAME brand.
    await seed(
      { 0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brandName: 'Firestorm', version: '8.2.3.4918-re0ade7b', environment: 'qa', ts: Date.now() } } },
      { 0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brand: 'firestorm', device: 'desktop', version: '8.2.3.4918-re0ade7b', hostEnv: 'qa', artifactEnv: 'qa', artifactEnvs: ['qa'], url: PAGE_URL, ts: Date.now() } } },
      {}
    );
    // Scenario 1: MFE layer Confirmed - runtime marker and network
    // observation agree on version+environment for the SAME brand.
    let panel = page.locator('#lgt-panel');
    function panelRows() { return panel.locator('.lgt-build-row'); }
    await seed(
      { 0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brandName: 'Firestorm', version: '8.2.3.4918-re0ade7b', environment: 'qa', ts: Date.now() } } },
      { 0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brand: 'firestorm', device: 'desktop', version: '8.2.3.4918-re0ade7b', hostEnv: 'qa', artifactEnv: 'qa', artifactEnvs: ['qa'], url: PAGE_URL, ts: Date.now() } } },
      {}
    );
    await panel.waitFor({ state: 'visible', timeout: 10000 });
    let texts = await waitForRows((t) => t.length === 1 && /Firestorm/.test(t[0]), 10000);
    assert.match(texts[0], /Firestorm.*MFE.*v8\.2\.3\.4918-re0ade7b.*QA/s);
    assert.match(texts[0], /Confirmed/);
    console.log('PASS: matching runtime+network evidence for one brand+layer renders Confirmed.');

    // Scenario 2: same page, second brand/layer (iframe) with a DIFFERENT
    // version stays in its OWN row - no cross-brand/cross-layer mixing.
    await seed(
      {
        0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brandName: 'Firestorm', version: '8.2.3.4918-re0ade7b', environment: 'qa', ts: Date.now() } },
        1: { iframe: { brandId: '0e5d414b-5234-4050-9fc3-ce1127e18704', brandName: 'NordicBet', version: '8.2.1.4910-h96b2913', environment: 'qa', ts: Date.now() } }
      },
      {
        0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brand: 'firestorm', device: 'desktop', version: '8.2.3.4918-re0ade7b', hostEnv: 'qa', artifactEnv: 'qa', artifactEnvs: ['qa'], url: PAGE_URL, ts: Date.now() } },
        1: { iframe: { brandId: '0e5d414b-5234-4050-9fc3-ce1127e18704', brand: 'nordicbet', device: 'mobile', version: '8.2.1.4910-h96b2913', headerVersion: '8.2.1.4910-h96b2913', hostEnv: 'qa', url: PAGE_URL, ts: Date.now() } }
      },
      {}
    );
    texts = await waitForRows((t) => t.length === 2, 10000);
    assert.match(texts[0], /Firestorm.*MFE.*v8\.2\.3\.4918-re0ade7b.*QA.*Confirmed/s);
    assert.match(texts[1], /Nordicbet.*Fabric.*v8\.2\.1\.4910-h96b2913.*QA.*Confirmed/s);
    console.log('PASS: MFE and Fabric/OBGA layers on one page render as two independent rows, each Confirmed on its own evidence.');

    // Scenario 3: Mismatch - runtime and network evidence for the SAME
    // brand+layer disagree on version.
    await seed(
      { 0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brandName: 'Firestorm', version: '8.2.3.4918-re0ade7b', environment: 'qa', ts: Date.now() } } },
      { 0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brand: 'firestorm', device: 'desktop', version: '8.1.15.4896-hc2cb4ed', hostEnv: 'qa', artifactEnv: 'qa', artifactEnvs: ['qa'], url: PAGE_URL, ts: Date.now() } } },
      {}
    );
    texts = await waitForRows((t) => t.length === 1 && /Mismatch/.test(t[0]), 10000);
    const detailText = await panel.locator('.lgt-build-detail').first().innerText();
    assert.match(detailText, /version: runtime=v8\.2\.3\.4918-re0ade7b vs network=v8\.1\.15\.4896-hc2cb4ed/);
    // The row's headline must show the NETWORK-confirmed version, not the
    // raw runtime marker value, even for a genuinely unexplained Mismatch
    // (no active Bundle Override involved here at all) - this is the
    // consistency fix: the headline selection rule (prefer network
    // whenever it exists) must be identical regardless of whether the
    // divergence ends up Confirmed-via-override or a flagged Mismatch, so
    // the same underlying pinned-runtime-marker fact is never displayed
    // differently (e.g. looking like "ALPHA was detected" in one row and
    // "PROD" in another) depending on which bucket a row lands in.
    assert.match(texts[0], /v8\.1\.15\.4896-hc2cb4ed/);
    assert.doesNotMatch(texts[0], /v8\.2\.3\.4918-re0ade7b/);
    console.log('PASS: disagreeing runtime vs network version for the same brand+layer renders Mismatch with conflict detail, and the headline consistently shows the network-confirmed value (not the raw runtime marker) - the same selection rule used for override-explained Confirmed rows.');

    // Scenario 4: Unclassified - a network hit with NO runtime marker in
    // that frame at all must not get an assumed layer label.
    await seed(
      {},
      { 0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brand: 'firestorm', device: 'desktop', version: '8.2.3.4918-re0ade7b', hostEnv: 'qa', artifactEnv: 'qa', artifactEnvs: ['qa'], url: PAGE_URL, ts: Date.now() } } },
      {}
    );
    texts = await waitForRows((t) => t.length === 1 && /Unclassified/.test(t[0]), 10000);
    assert.doesNotMatch(texts[0], /MFE|Fabric|NodeJS/);
    console.log('PASS: network-only evidence with no runtime marker renders Unclassified with no assumed layer label.');

    // Scenario 5: bleSource=1 request to an ALPHA/PROD host must never be
    // usable as environment evidence (isBleExcludedRequest guard).
    const excluded = await serviceWorker.evaluate(() => ({
      alphaWithBle: isBleExcludedRequest('https://alpha.example.com/api/sb/v1/x?bleSource=1', 'alpha'),
      prodWithBle: isBleExcludedRequest('https://example.com/api/sb/v1/x?bleSource=1', 'prod'),
      qaWithBle: isBleExcludedRequest('https://qa.example.com/api/sb/v1/x?bleSource=1', 'qa'),
      alphaWithoutBle: isBleExcludedRequest('https://alpha.example.com/api/sb/v1/x', 'alpha'),
    }));
    assert.equal(excluded.alphaWithBle, true);
    assert.equal(excluded.prodWithBle, true);
    assert.equal(excluded.qaWithBle, false);
    assert.equal(excluded.alphaWithoutBle, false);
    console.log('PASS: bleSource=1 ALPHA/PROD backend requests are excluded from bundle-environment computation; QA and non-bleSource requests are not.');

    // Scenario 6: hybrid runtime - MFE and iframe markers BOTH present in
    // the SAME frame and BOTH independently Confirmed on the same
    // brand+version+environment+device. This is a real, observed Betsson
    // QA shape (mFE layered on top of the legacy Fabric/OBGA runtime).
    // Since both layers report the exact same version/environment,
    // showing two duplicate-looking rows is just noise - they must be
    // merged into ONE row listing every agreeing layer, with a detail
    // explaining why.
    await seed(
      {
        0: {
          mfe: { brandId: '11111111-1111-1111-1111-111111111111', brandName: 'Firestorm', version: '8.3.0.4928-b1d00c18', environment: 'qa', ts: Date.now() },
          iframe: { brandId: '11111111-1111-1111-1111-111111111111', brandName: 'Firestorm', version: '8.3.0.4928-b1d00c18', environment: 'qa', ts: Date.now() }
        }
      },
      {
        0: {
          mfe: { brandId: '11111111-1111-1111-1111-111111111111', brand: 'firestorm', device: 'desktop', version: '8.3.0.4928-b1d00c18', hostEnv: 'qa', artifactEnv: 'qa', artifactEnvs: ['qa'], url: PAGE_URL, ts: Date.now() },
          iframe: { brandId: '11111111-1111-1111-1111-111111111111', brand: 'firestorm', device: 'desktop', version: '8.3.0.4928-b1d00c18', headerVersion: '8.3.0.4928-b1d00c18', hostEnv: 'qa', url: PAGE_URL, ts: Date.now() }
        }
      },
      {}
    );
    texts = await waitForRows((t) => t.length === 1 && /Confirmed/.test(t[0]), 10000);
    assert.match(texts[0], /Firestorm.*MFE \+ Fabric.*v8\.3\.0\.4928-b1d00c18.*QA.*Confirmed/s);
    const hybridDetailCount = await panel.locator('.lgt-build-detail').count();
    assert.strictEqual(hybridDetailCount, 0);
    console.log('PASS: MFE and the legacy Fabric/OBGA shell both Confirmed in the same frame with matching brand+version+environment are merged into a single hybrid row (label reads "Fabric", not "iframe" - they are the same shell, not two separate layers), with no extra detail text since a merged Confirmed row needs no explanation beyond any other Confirmed row.');

    // Scenario 7: Partially verified - a runtime marker exists but there
    // is no network confirmation for this layer at all yet. The row must
    // self-explain why it has not reached Confirmed instead of leaving
    // detail blank.
    await seed(
      { 0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brandName: 'Firestorm', version: '8.2.3.4918-re0ade7b', environment: 'qa', ts: Date.now() } } },
      {},
      {}
    );
    texts = await waitForRows((t) => t.length === 1 && /Partially verified/.test(t[0]), 10000);
    const partialDetail = await panel.locator('.lgt-build-detail').first().innerText();
    assert.match(partialDetail, /no network confirmation seen for this layer yet/);
    console.log('PASS: Partially verified rows include a specific reason (missing network confirmation) instead of a blank detail.');

    // Scenario 8: a real live pattern (confirmed 2026-09-04 against
    // alpha.betsson.com) - the runtime marker keeps reporting the layer's
    // base build (PROD) while the network side correctly reflects an
    // ALPHA Bundle Override the user deliberately applied. WITHOUT an
    // active override recorded for this tab, this must still be a
    // Mismatch (the baseline/safety case - nothing should silently
    // swallow a real disagreement by default).
    await seed(
      { 0: { mfe: { brandId: '6a6d80b9-16ac-4387-a413-244d93a74deb', brandName: 'Betsson', version: '8.1.16.4855-rb8bfa90', environment: 'prod', ts: Date.now() } } },
      { 0: { mfe: { brandId: '6a6d80b9-16ac-4387-a413-244d93a74deb', brand: 'betsson', device: 'desktop', version: '8.2.5.4941-reba6fd9', hostEnv: 'alpha', artifactEnv: 'alpha', artifactEnvs: ['alpha'], url: PAGE_URL, ts: Date.now() } } },
      {}
    );
    texts = await waitForRows((t) => t.length === 1 && /Mismatch/.test(t[0]), 10000);
    let bundleMismatchDetail = await panel.locator('.lgt-build-detail').first().innerText();
    assert.match(bundleMismatchDetail, /environment: runtime=PROD vs network=ALPHA/);
    // Even in this baseline/unexplained Mismatch, the headline must show
    // the network-confirmed ALPHA build, not the raw pinned PROD runtime
    // value - the SAME headline selection rule as the override-explained
    // Confirmed case below. This is the exact anomaly the user reported:
    // without this, an unexplained Mismatch would show "PROD" while an
    // override-explained Confirmed row for the identical runtime/network
    // split shows "ALPHA" - two different displays for the same
    // underlying always-pinned-runtime-marker fact.
    assert.match(texts[0], /v8\.2\.5\.4941-reba6fd9.*ALPHA/s);
    console.log('PASS: without a recorded active Bundle Override, a runtime=PROD/network=ALPHA split for the same brand+layer still renders Mismatch (the safety baseline), and its headline already shows the network-confirmed ALPHA build (not the raw pinned PROD runtime value) - identical headline selection rule as the override-explained Confirmed case below.');

    // Now record that a Bundle Override targeting ALPHA is active on this
    // tab (as background.js itself does after a real Apply) and re-seed
    // the identical runtime/network split - this must now resolve as
    // Confirmed, showing the network (actually-running) values, with a
    // detail note explaining the pinned-runtime-marker behavior instead of
    // an unexplained conflict.
    await setBundleOverrideTarget('alpha');
    await seed(
      { 0: { mfe: { brandId: '6a6d80b9-16ac-4387-a413-244d93a74deb', brandName: 'Betsson', version: '8.1.16.4855-rb8bfa90', environment: 'prod', ts: Date.now() } } },
      { 0: { mfe: { brandId: '6a6d80b9-16ac-4387-a413-244d93a74deb', brand: 'betsson', device: 'desktop', version: '8.2.5.4941-reba6fd9', hostEnv: 'alpha', artifactEnv: 'alpha', artifactEnvs: ['alpha'], url: PAGE_URL, ts: Date.now() } } },
      {}
    );
    texts = await waitForRows((t) => t.length === 1 && /Confirmed/.test(t[0]), 10000);
    assert.match(texts[0], /Betsson.*MFE.*v8\.2\.5\.4941-reba6fd9.*ALPHA.*Confirmed/s);
    const bundleOverrideDetail = await panel.locator('.lgt-build-detail').first().innerText();
    assert.match(bundleOverrideDetail, /Bundle Override active \(target ALPHA\).*runtime marker still reports the base build v8\.1\.16\.4855-rb8bfa90\/PROD.*network evidence v8\.2\.5\.4941-reba6fd9\/ALPHA reflects what is actually running/s);
    await setBundleOverrideTarget(null);
    console.log('PASS: with an active Bundle Override targeting ALPHA recorded for this tab, the SAME runtime=PROD/network=ALPHA split is recognized as the known pinned-startup-context pattern and renders Confirmed (network values shown) with an explanatory detail instead of Mismatch.');

    console.log('ALL PASS: brand+layer detection engine (Confirmed/Mismatch/Unclassified, multi-row, bleSource exclusion, hybrid-layer flagging, partial-reason detail, Bundle Override-aware classification).');
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
