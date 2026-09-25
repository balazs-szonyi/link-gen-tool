'use strict';

// Local/mock regression for the brand+layer scoped SB detection engine
// (replaces the removed window.xSbState-based "Verify with page state"
// button and its test-page-state-verification.cjs). Uses the same
// pattern as the tool's other mock tests: a real unpacked-extension
// Chromium profile (chromium.launchPersistentContext), Playwright's
// context.route() to serve a fully local fixture page with NO real
// network access, and serviceWorker.evaluate() to seed background.js's
// persisted per-tab detection state directly - this exercises the exact
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
      frameDoc = Object.assign({
        0: { url: PAGE_URL, hostname: 'd-cf.qa.sbplayground1.net', env: 'qa', brand: null }
      }, frameDoc);
      await serviceWorker.evaluate(async ({ runtimeMarkers, network, frameDoc }) => {
        const tabs = await chrome.tabs.query({ active: true });
        const tabId = tabs[0].id;
        const frameIds = new Set([...Object.keys(runtimeMarkers), ...Object.keys(network), ...Object.keys(frameDoc)]);
        const frames = {};
        for (const frameId of frameIds) {
          frames[frameId] = {
            generation: crypto.randomUUID(),
            runtime: runtimeMarkers[frameId] || {},
            network: network[frameId] || {},
            document: frameDoc[frameId] || null,
            documentId: null
          };
        }
        await workerStore.update('detection', tabId, () => ({ generation: crypto.randomUUID(), frames }));
      }, { runtimeMarkers, network, frameDoc });
    }

    // Seeds/clears one real tab-scoped session DNR redirect rule so the
    // same live-rule lookup used by the production message handler can
    // determine the Bundle Override target environment. This lets the
    // classifier's bundleOverrideExplainsEnvDivergence check to be
    // exercised without actually driving the Bundle UI end-to-end.
    async function setBundleOverrideTarget(targetEnv) {
      await serviceWorker.evaluate(async (targetEnv) => {
        const tabs = await chrome.tabs.query({ active: true });
        const tabId = tabs[0].id;
        const ruleId = 930001;
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [ruleId],
          addRules: targetEnv ? [{
            id: ruleId,
            priority: 1,
            action: { type: 'redirect', redirect: { url: `https://bundle.${targetEnv}.example.invalid/main.js` } },
            condition: { urlFilter: '||bundle-source.example.invalid/', resourceTypes: ['script'], tabIds: [tabId] }
          }] : []
        });
        await workerStore.update('dnr/bundle', tabId, () => targetEnv ? {
          targetEnv,
          status: 'active',
          scope: { kind: 'tab' }
        } : null);
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

    // Scenario 1: the URL requests QA and the observed MFE artifact is QA.
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
    assert.match(texts[0], /Matches URL/);
    console.log('PASS: a loaded bundle environment matching the top-level URL renders Matches URL.');

    // Scenario 2: same page, second brand/layer (iframe) with a DIFFERENT
    // version stays in its OWN row - no cross-brand/cross-layer mixing.
    await seed(
      {
        0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brandName: 'Firestorm', version: '8.2.3.4918-re0ade7b', environment: 'qa', ts: Date.now() } },
        1: { iframe: { brandId: '0e5d414b-5234-4050-9fc3-ce1127e18704', brandName: 'NordicBet', version: '8.2.1.4910-h96b2913', environment: 'qa', ts: Date.now() } }
      },
      {
        0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brand: 'firestorm', device: 'desktop', version: '8.2.3.4918-re0ade7b', hostEnv: 'qa', artifactEnv: 'qa', artifactEnvs: ['qa'], url: PAGE_URL, ts: Date.now() } },
        1: { iframe: { brandId: '0e5d414b-5234-4050-9fc3-ce1127e18704', brand: 'nordicbet', device: 'mobile', version: '8.2.1.4910-h96b2913', headerVersion: '8.2.1.4910-h96b2913', hostEnv: 'qa', artifactEnv: 'qa', artifactEnvs: ['qa'], url: PAGE_URL, ts: Date.now() } }
      },
      {}
    );
    texts = await waitForRows((t) => t.length === 2, 10000);
    assert.match(texts[0], /Firestorm.*MFE.*v8\.2\.3\.4918-re0ade7b.*QA.*Matches URL/s);
    assert.match(texts[1], /Nordicbet.*Fabric.*v8\.2\.1\.4910-h96b2913.*QA.*Matches URL/s);
    console.log('PASS: MFE and Fabric/OBGA rows independently compare their loaded artifacts with the top-level URL.');

    // Scenario 3: version evidence can disagree while the loaded bundle
    // environment still matches the URL. The primary badge remains about
    // environment truth, and the version split is a separate warning.
    await seed(
      { 0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brandName: 'Firestorm', version: '8.2.3.4918-re0ade7b', environment: 'qa', ts: Date.now() } } },
      { 0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brand: 'firestorm', device: 'desktop', version: '8.1.15.4896-hc2cb4ed', hostEnv: 'qa', artifactEnv: 'qa', artifactEnvs: ['qa'], url: PAGE_URL, ts: Date.now() } } },
      {}
    );
    texts = await waitForRows((t) => t.length === 1 && /Firestorm.*v8\.1\.15\.4896-hc2cb4ed.*Matches URL/s.test(t[0]), 10000);
    assert.equal((await panel.locator('.lgt-build-evidence-warning').innerText()).trim(), 'Evidence warning: detection evidence differs.');
    const evidenceDisclosure = panel.locator('.lgt-build-disclosure').first();
    assert.equal(await evidenceDisclosure.evaluate((node) => node.open), false);
    assert.equal((await evidenceDisclosure.locator('summary').innerText()).trim(), 'Show detection details');
    const detailText = await panel.locator('.lgt-build-detail').first().textContent();
    assert.match(detailText, /version: runtime=v8\.2\.3\.4918-re0ade7b vs network=v8\.1\.15\.4896-hc2cb4ed/);
    // The row's headline must show the NETWORK-confirmed version, not the
    // raw runtime marker value, even when runtime and network evidence
    // disagree (no active Bundle Override involved here at all) - this is the
    // consistency fix: the headline selection rule (prefer network
    // whenever it exists) must be identical regardless of whether the
    // URL comparison ends up Matches URL, Overridden, or Mismatch, so
    // the same underlying pinned-runtime-marker fact is never displayed
    // differently (e.g. looking like "ALPHA was detected" in one row and
    // "PROD" in another) depending on which bucket a row lands in.
    assert.match(texts[0], /v8\.1\.15\.4896-hc2cb4ed/);
    assert.doesNotMatch(texts[0], /v8\.2\.3\.4918-re0ade7b/);
    await evidenceDisclosure.locator('summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await evidenceDisclosure.evaluate((node) => node.open), true);
    await page.waitForTimeout(3500);
    assert.equal(await panel.locator('.lgt-build-disclosure').first().evaluate((node) => node.open), true);
    console.log('PASS: version evidence conflicts stay separate from the Matches URL environment result and retain an accessible disclosure.');

    // Scenario 4: Unclassified - a network hit with NO runtime marker in
    // that frame at all must not get an assumed layer label.
    await seed(
      {},
      { 0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brand: 'firestorm', device: 'desktop', version: '8.2.3.4918-re0ade7b', hostEnv: 'qa', artifactEnv: 'qa', artifactEnvs: ['qa'], url: PAGE_URL, ts: Date.now() } } },
      {}
    );
    texts = await waitForRows((t) => t.length === 1 && /Unclassified SB build.*Matches URL/s.test(t[0]), 10000);
    assert.doesNotMatch(texts[0], /MFE|Fabric|NodeJS/);
    const unclassifiedDisclosure = panel.locator('.lgt-build-disclosure').first();
    assert.equal(await unclassifiedDisclosure.evaluate((node) => node.open), false);
    assert.equal((await unclassifiedDisclosure.locator('summary').innerText()).trim(), 'Show detection details');
    console.log('PASS: direct network evidence can establish Matches URL without inventing a runtime layer label.');

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

    // A TEST brand URL can natively serve a QA config. The path correctly
    // identifies QA as the loaded artifact, but that is a real mismatch
    // against the TEST environment requested by the top-level URL.
    const crossEnvironmentConfig = await serviceWorker.evaluate(() => {
      const url = 'https://www.test.betsson.gr/dist/qa/config/4bf6590d-0a29-47f5-a705-42b7a04b7878/11111111-1111-1111-1111-111111111111/8.3/config.json';
      const match = BUNDLE_OBSERVE_SANDBOX_CONFIG_RE.exec(url);
      const hostEnv = envLabelFromHostname(new URL(url).hostname);
      return {
        hostEnv,
        artifactEnv: sandboxConfigArtifactEnvironment(match, hostEnv),
      };
    });
    assert.deepEqual(crossEnvironmentConfig, { hostEnv: 'test', artifactEnv: 'qa' });
    const mfePathEvidence = await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true });
      await observeBuildRequest({
        tabId: tabs[0].id,
        frameId: 0,
        url: 'https://www.test.betsson.gr/dist/qa/xp/widgets/sportsbook/4bf6590d-0a29-47f5-a705-42b7a04b7878/8.3.0.5227-h7cbe311/desktop/files/main-ABC123.js'
      });
      const snapshot = await detection.snapshot(tabs[0].id);
      return snapshot.networkByFrame[0].mfe.artifactEnv;
    });
    assert.equal(mfePathEvidence, 'qa');

    await seed(
      { 0: { iframe: { brandId: '4bf6590d-0a29-47f5-a705-42b7a04b7878', brandName: 'Betssongr', version: '8.3.0.5227-h7cbe311', environment: 'qa', ts: Date.now() } } },
      { 0: { iframe: { brandId: '4bf6590d-0a29-47f5-a705-42b7a04b7878', brand: 'betssongr', device: 'desktop', version: '8.3.0.5227-h7cbe311', hostEnv: 'test', artifactEnv: 'qa', artifactEnvs: ['qa'], url: PAGE_URL, ts: Date.now() } } },
      { 0: { url: 'https://test.betsson.gr/en/sportsbook', hostname: 'test.betsson.gr', env: 'test', brand: 'betssongr' } }
    );
    texts = await waitForRows((t) => t.length === 1 && /Betssongr.*Fabric.*QA.*Mismatch/s.test(t[0]), 10000);
    assert.equal((await panel.locator('.lgt-build-alert').innerText()).trim(), 'URL requests TEST, but QA bundle is loaded.');
    console.log('PASS: test.betsson.gr loading a native QA Fabric artifact is correctly reported as URL/bundle Mismatch.');

    // Scenario 6: hybrid runtime - MFE and iframe markers BOTH present in
    // the SAME frame and BOTH independently match the URL on the same
    // brand+version+environment+device. This is a real, observed Betsson
    // QA shape (mFE layered on top of the Fabric/OBGA runtime).
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
          iframe: { brandId: '11111111-1111-1111-1111-111111111111', brand: 'firestorm', device: 'desktop', version: '8.3.0.4928-b1d00c18', headerVersion: '8.3.0.4928-b1d00c18', hostEnv: 'qa', artifactEnv: 'qa', artifactEnvs: ['qa'], url: PAGE_URL, ts: Date.now() }
        }
      },
      {}
    );
    texts = await waitForRows((t) => t.length === 1 && /Firestorm.*MFE \+ Fabric.*Matches URL/s.test(t[0]), 10000);
    assert.match(texts[0], /Firestorm.*MFE \+ Fabric.*v8\.3\.0\.4928-b1d00c18.*QA.*Matches URL/s);
    const hybridDetailCount = await panel.locator('.lgt-build-detail').count();
    assert.strictEqual(hybridDetailCount, 0);
    console.log('PASS: matching MFE and Fabric rows merge into one compact Matches URL result.');

    // Scenario 7: Partially verified - a runtime marker exists but there
    // is no network confirmation for this layer at all yet. The row must
    // self-explain why its loaded environment cannot be verified yet.
    // detail blank.
    await seed(
      { 0: { mfe: { brandId: '11111111-1111-1111-1111-111111111111', brandName: 'Firestorm', version: '8.2.3.4918-re0ade7b', environment: 'qa', ts: Date.now() } } },
      {},
      {}
    );
    texts = await waitForRows((t) => t.length === 1 && /Partially verified/.test(t[0]), 10000);
    const partialDisclosure = panel.locator('.lgt-build-disclosure').first();
    assert.equal(await partialDisclosure.evaluate((node) => node.open), false);
    assert.equal((await partialDisclosure.locator('summary').innerText()).trim(), 'Why Partially verified?');
    const partialDetail = await panel.locator('.lgt-build-detail').first().textContent();
    assert.match(partialDetail, /no network confirmation seen for this layer yet/);
    console.log('PASS: Partially verified rows include a specific reason (missing network confirmation) instead of a blank detail.');

    // Scenario 8: the primary badge compares URL versus loaded artifact,
    // not runtime marker versus network metadata. An ALPHA artifact on an
    // ALPHA URL therefore matches even if the runtime marker is pinned to
    // PROD; the unexplained marker split remains a separate warning.
    await seed(
      { 0: { mfe: { brandId: '6a6d80b9-16ac-4387-a413-244d93a74deb', brandName: 'Betsson', version: '8.1.16.4855-rb8bfa90', environment: 'prod', ts: Date.now() } } },
      { 0: { mfe: { brandId: '6a6d80b9-16ac-4387-a413-244d93a74deb', brand: 'betsson', device: 'desktop', version: '8.2.5.4941-reba6fd9', hostEnv: 'alpha', artifactEnv: 'alpha', artifactEnvs: ['alpha'], url: PAGE_URL, ts: Date.now() } } },
      { 0: { url: 'https://alpha.betsson.com/en/sportsbook', hostname: 'alpha.betsson.com', env: 'alpha', brand: 'betsson' } }
    );
    texts = await waitForRows((t) => t.length === 1 && /Matches URL/.test(t[0]), 10000);
    let bundleEvidenceDetail = await panel.locator('.lgt-build-detail').first().textContent();
    assert.match(bundleEvidenceDetail, /environment evidence: runtime=PROD vs network=ALPHA/);
    assert.equal(await panel.locator('.lgt-build-evidence-warning').count(), 1);
    assert.match(texts[0], /v8\.2\.5\.4941-reba6fd9.*ALPHA/s);
    console.log('PASS: URL and loaded artifact matching remains Matches URL while unexplained runtime metadata divergence is warned separately.');

    // A same-environment ALPHA override still produces Matches URL. Its
    // active metadata explains the pinned PROD runtime marker, so the
    // evidence warning disappears while the detail remains available.
    await setBundleOverrideTarget('alpha');
    await seed(
      { 0: { mfe: { brandId: '6a6d80b9-16ac-4387-a413-244d93a74deb', brandName: 'Betsson', version: '8.1.16.4855-rb8bfa90', environment: 'prod', ts: Date.now() } } },
      { 0: { mfe: { brandId: '6a6d80b9-16ac-4387-a413-244d93a74deb', brand: 'betsson', device: 'desktop', version: '8.2.5.4941-reba6fd9', hostEnv: 'alpha', artifactEnv: 'alpha', artifactEnvs: ['alpha'], url: PAGE_URL, ts: Date.now() } } },
      { 0: { url: 'https://alpha.betsson.com/en/sportsbook', hostname: 'alpha.betsson.com', env: 'alpha', brand: 'betsson' } }
    );
    texts = await waitForRows((t) => t.length === 1 && /Matches URL/.test(t[0]), 10000);
    assert.match(texts[0], /Betsson.*MFE.*v8\.2\.5\.4941-reba6fd9.*ALPHA.*Matches URL/s);
    await panel.locator('.lgt-build-detail').filter({ hasText: 'Bundle Override active (target ALPHA)' }).waitFor({ state: 'attached', timeout: 10000 });
    assert.equal(await panel.locator('.lgt-build-evidence-warning').count(), 0);
    const bundleOverrideDetail = await panel.locator('.lgt-build-detail').first().textContent();
    assert.match(bundleOverrideDetail, /Bundle Override active \(target ALPHA\).*runtime marker still reports the base build v8\.1\.16\.4855-rb8bfa90\/PROD.*network evidence v8\.2\.5\.4941-reba6fd9\/ALPHA reflects what is actually running/s);
    console.log('PASS: a standard same-environment override stays Matches URL and explains the pinned runtime marker.');

    // A Link Gen-owned cross-environment override is Overridden only when
    // its active target is also observed in the loaded network artifact.
    await setBundleOverrideTarget('qa');
    await seed(
      { 0: { mfe: { brandId: '4bf6590d-0a29-47f5-a705-42b7a04b7878', brandName: 'Betssongr', version: '8.3.0.5227-h7cbe311', environment: 'qa', ts: Date.now() } } },
      { 0: { mfe: { brandId: '4bf6590d-0a29-47f5-a705-42b7a04b7878', brand: 'betssongr', device: 'desktop', version: '8.3.0.5227-h7cbe311', hostEnv: 'test', artifactEnv: 'qa', artifactEnvs: ['qa'], url: PAGE_URL, ts: Date.now() } } },
      { 0: { url: 'https://test.betsson.gr/en/sportsbook', hostname: 'test.betsson.gr', env: 'test', brand: 'betssongr' } }
    );
    texts = await waitForRows((t) => t.length === 1 && /Overridden/.test(t[0]), 10000);
    assert.match(texts[0], /Betssongr.*MFE.*QA.*Overridden/s);
    assert.equal((await panel.locator('.lgt-build-override').innerText()).trim(), 'URL requests TEST; Link Gen override intentionally loaded QA.');
    console.log('PASS: an active Link Gen target confirmed by the loaded artifact renders Overridden instead of Mismatch.');

    // Merely having override metadata is not enough. If the artifact that
    // actually loaded differs from both the URL and the active target, the
    // result stays Mismatch and explicitly calls out the failed target.
    await seed(
      { 0: { mfe: { brandId: '4bf6590d-0a29-47f5-a705-42b7a04b7878', brandName: 'Betssongr', version: '8.4.0.6000-test', environment: 'alpha', ts: Date.now() } } },
      { 0: { mfe: { brandId: '4bf6590d-0a29-47f5-a705-42b7a04b7878', brand: 'betssongr', device: 'desktop', version: '8.4.0.6000-test', hostEnv: 'test', artifactEnv: 'alpha', artifactEnvs: ['alpha'], url: PAGE_URL, ts: Date.now() } } },
      { 0: { url: 'https://test.betsson.gr/en/sportsbook', hostname: 'test.betsson.gr', env: 'test', brand: 'betssongr' } }
    );
    texts = await waitForRows((t) => t.length === 1 && /Mismatch/.test(t[0]), 10000);
    assert.doesNotMatch(texts[0], /Overridden/);
    assert.match(await panel.locator('.lgt-build-detail').first().textContent(), /override target: active=QA vs loaded=ALPHA/);
    assert.equal(await panel.locator('.lgt-build-evidence-warning').count(), 1);
    await setBundleOverrideTarget(null);
    console.log('PASS: active override metadata cannot hide an artifact that failed to load from its configured target.');

    // Bundle has three separate explanation contexts: the general help,
    // the standalone-sandbox limitation, and a live URL/runtime mismatch.
    // Each must stay compact while its short actionable warning remains
    // visible. Seed an ALPHA artifact on this QA fixture URL to trigger
    // the loaded-bundle warning used by the Bundle tab.
    await seed(
      { 0: { mfe: { brandId: '6a6d80b9-16ac-4387-a413-244d93a74deb', brandName: 'Betsson', version: '8.1.16.4855-rb8bfa90', environment: 'prod', ts: Date.now() } } },
      { 0: { mfe: { brandId: '6a6d80b9-16ac-4387-a413-244d93a74deb', brand: 'betsson', device: 'desktop', version: '8.2.5.4941-reba6fd9', hostEnv: 'alpha', artifactEnv: 'alpha', artifactEnvs: ['alpha'], url: PAGE_URL, ts: Date.now() } } },
      {}
    );
    await waitForRows((t) => t.length === 1 && /Mismatch/.test(t[0]), 10000);
    await panel.locator('.lgt-tab').filter({ hasText: 'Bundle' }).click();
    const bundleHelp = panel.locator('.lgt-bundle-help');
    assert.equal(await bundleHelp.evaluate((node) => node.open), false);
    assert.equal((await bundleHelp.locator('summary').innerText()).trim(), 'How Bundle Override works & limitations');
    const sandboxHelp = panel.locator('.lgt-sandbox-help');
    assert.equal(await sandboxHelp.evaluate((node) => node.open), false);
    assert.equal((await sandboxHelp.locator('summary').innerText()).trim(), 'Why is it unavailable?');
    const hostRealityHelp = panel.locator('.lgt-host-reality-details');
    await hostRealityHelp.waitFor({ state: 'visible', timeout: 7000 });
    assert.equal(await hostRealityHelp.evaluate((node) => node.open), false);
    assert.match(await panel.locator('#lgt-body-bundle').innerText(), /Loaded bundle does not match the URL environment/);
    console.log('PASS: Bundle general, sandbox, and live environment explanations are collapsed while concise warnings remain visible.');

    // The long BLE explanation is also a native disclosure. It is compact
    // by default, works from the keyboard, and deliberately does not store
    // its open state: a real page reload resets it to collapsed.
    await panel.locator('.lgt-tab').filter({ hasText: 'BLE Data' }).click();
    let bleHelp = panel.locator('.lgt-ble-help');
    await bleHelp.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await bleHelp.evaluate((node) => node.open), false);
    assert.equal((await bleHelp.locator('summary').innerText()).trim(), 'How BLE Data works & limitations');
    assert.equal(await bleHelp.locator('li').count(), 5);
    await bleHelp.locator('summary').focus();
    await page.keyboard.press('Space');
    assert.equal(await bleHelp.evaluate((node) => node.open), true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    panel = page.locator('#lgt-panel');
    await panel.waitFor({ state: 'visible', timeout: 10000 });
    bleHelp = panel.locator('.lgt-ble-help');
    await bleHelp.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await bleHelp.evaluate((node) => node.open), false);
    console.log('PASS: BLE help is collapsed by default, exposes five concise points, opens with Space, and resets to collapsed after page reload.');

    // Audit the other tabs that contain persistent explanatory copy. All
    // help starts collapsed, while controls retain short scan-friendly
    // labels and Bet Void keeps its safety-critical warning visible.
    await panel.locator('.lgt-tab').filter({ hasText: 'Generate' }).click();
    const generateHelp = panel.locator('.lgt-generate-help');
    assert.equal(await generateHelp.evaluate((node) => node.open), false);
    const generateText = await panel.locator('#lgt-body-generate').innerText();
    assert.match(generateText, /Local links\s+Sportradar Statistics fix\s+BLE source\s+Oddin Statistics fix/s);
    assert.doesNotMatch(generateText, /Force fresh live-login|Show login tab/);
    await panel.locator('#lgt-gen-login-state').selectOption('in');
    const loggedInGenerateText = await panel.locator('#lgt-body-generate').innerText();
    assert.match(loggedInGenerateText, /Force fresh live-login\s+Show login tab/s);
    assert.doesNotMatch(generateText, /skip 30-min cache|spoofs Origin\/Referer/);

    await panel.getByRole('button', { name: 'More tools', exact: true }).click();
    await panel.locator('.lgt-tab').filter({ hasText: 'Live Login' }).click();
    assert.equal(await panel.locator('.lgt-live-login-help').evaluate((node) => node.open), false);

    await panel.locator('.lgt-tab').filter({ hasText: 'Bonus Mock' }).click();
    assert.equal(await panel.locator('.lgt-bonus-help').evaluate((node) => node.open), false);

    await panel.locator('.lgt-tab').filter({ hasText: 'Bet Void' }).click();
    assert.equal(await panel.locator('.lgt-bet-void-help').evaluate((node) => node.open), false);
    assert.match(await panel.locator('#lgt-body-bet-void').innerText(), /do not press F5 on a coupon-detail deep link/i);
    console.log('PASS: Generate, Live Login, Bonus Mock, and Bet Void use compact collapsed help; the critical Bet Void F5 warning stays visible.');

    console.log('ALL PASS: brand+layer detection engine and full-tool compact native disclosure UX.');
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
