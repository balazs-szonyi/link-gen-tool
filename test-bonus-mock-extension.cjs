'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const EXT_PATH = process.env.LGT_EXTENSION_PATH
  ? path.resolve(process.env.LGT_EXTENSION_PATH)
  : path.resolve(__dirname, 'extension');
const FIXTURE_PATH = path.resolve(__dirname, '..', '.agents', 'skills', 'sportsbook-bonus-override', 'assets', 'mapp-11252-mocked-bonuses.json');
const INVALID_FIXTURE_PATH = path.resolve(__dirname, 'cross-layer-lab', 'fixtures', 'invalid-bonus.json');
const FUTURE_EXPIRY = '2050-12-31T23:59:59.000Z';
const nativePayload = {
  data: { bonuses: { native: { id: 'native', name: 'Native response' } }, mappings: {} },
  responseContext: { source: 'native' },
};

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>Bonus Mock E2E</title><button id="usable">Usable</button><output id="clicks">0</output><script>document.querySelector("#usable").onclick=()=>document.querySelector("#clicks").textContent++</script>');
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/bonuses?wrong=1') { res.end(JSON.stringify({ data: { bonuses: [] }, untouched: 'schema' })); return; }
    if (req.url === '/api/bonuses') { res.end(JSON.stringify(nativePayload)); return; }
    if (req.url === '/api/sb/v1/widgets/globalbonuses/v1') {
      res.end(JSON.stringify({ skeleton: { marketDetailsQueries: [] }, data: { pollingInterval: 0 }, referenceId: 'native-widget' }));
      return;
    }
    if (req.url === '/api/profile') { res.end(JSON.stringify({ untouched: 'endpoint' })); return; }
    res.statusCode = 404;
    res.end(JSON.stringify({ missing: true }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function showPanel(sw, page) {
  if (!await page.locator('#lgt-panel').isVisible().catch(() => false)) {
    await page.locator('#lgt-panel').evaluate((panel) => { panel.style.display = ''; });
  }
  await page.waitForSelector('#lgt-panel', { state: 'visible' });
  await page.locator('#lgt-panel .lgt-tab').filter({ hasText: 'Bonus Mock' }).click();
}

(async () => {
  const server = await startServer();
  const port = server.address().port;
  const userDataDir = path.join(os.tmpdir(), 'lgt-bonus-mock-e2e-' + Date.now());
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run'],
  });
  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await showPanel(sw, page);

    const panel = page.locator('#lgt-panel');
    await panel.locator('#lgt-bonus-file').setInputFiles(FIXTURE_PATH);
    await assert.doesNotReject(() => panel.locator('[data-lgt-bonus-info]').waitFor({ state: 'visible' }));
    await page.waitForFunction(() => document.querySelector('[data-lgt-bonus-info]')?.textContent.includes('40 bonuses'));
    const info = await panel.locator('[data-lgt-bonus-info]').textContent();
    assert.match(info, /mapp-11252-mocked-bonuses\.json - 40 bonuses/);
    assert.match(info, /PriceBoost 25/);
    assert.equal(await panel.locator('#lgt-bonus-future').isChecked(), true);
    await panel.locator('#lgt-bonus-apply').click();
    await page.waitForFunction(() => document.querySelector('[data-lgt-bonus-status]')?.getAttribute('data-lgt-bonus-status') === 'active');

    const fetched = await page.evaluate(async () => ({
      bonus: await fetch('/api/bonuses').then((response) => response.json()),
      widget: await fetch('/api/sb/v1/widgets/globalbonuses/v1').then((response) => response.json()),
      wrong: await fetch('/api/bonuses?wrong=1').then((response) => response.json()),
      profile: await fetch('/api/profile').then((response) => response.json()),
    }));
    assert.equal(Object.keys(fetched.bonus.data.bonuses).length, 40);
    assert.ok(Object.values(fetched.bonus.data.bonuses).every((bonus) => bonus.expiryDate === FUTURE_EXPIRY));
    assert.equal(fetched.widget.data.bonuses.length, 40);
    assert.equal(fetched.widget.referenceId, 'native-widget');
    assert.equal(fetched.widget.skeleton.marketDetailsQueries.length, 1);
    assert.equal(fetched.widget.skeleton.marketDetailsQueries[0].split(',').length, 23);
    assert.equal(fetched.widget.data.bonuses.filter((bonus) => bonus.type === 'PriceBoost').length, 25);
    assert.deepEqual(fetched.wrong, { data: { bonuses: [] }, untouched: 'schema' });
    assert.deepEqual(fetched.profile, { untouched: 'endpoint' });

    const xhrPayload = await page.evaluate(() => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/bonuses');
      xhr.responseType = 'json';
      xhr.onload = () => resolve(xhr.response);
      xhr.onerror = reject;
      xhr.send();
    }));
    assert.equal(Object.keys(xhrPayload.data.bonuses).length, 40);
    await page.waitForFunction(() => /Last matched response/.test(document.querySelector('[data-lgt-bonus-status]')?.textContent || ''));
    assert.match(await panel.locator('[data-lgt-bonus-status]').textContent(), /Active.*40 bonuses/);
    await page.click('#usable');
    assert.equal(await page.textContent('#clicks'), '1');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      panel.locator('#lgt-bonus-stop').click(),
    ]);
    const restored = await page.evaluate(() => fetch('/api/bonuses').then((response) => response.json()));
    assert.deepEqual(restored, nativePayload);

    await showPanel(sw, page);
    const panelAfterStop = page.locator('#lgt-panel');
    await panelAfterStop.locator('#lgt-bonus-file').setInputFiles(INVALID_FIXTURE_PATH);
    await page.waitForFunction(() => document.querySelector('[data-lgt-bonus-status]')?.getAttribute('data-lgt-bonus-status') === 'error');
    assert.match(await panelAfterStop.locator('[data-lgt-bonus-status]').textContent(), /Invalid fixture/);
    console.log('[bonus-extension-e2e] PASS');
  } finally {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error('[bonus-extension-e2e] FATAL', error);
  process.exitCode = 1;
});
