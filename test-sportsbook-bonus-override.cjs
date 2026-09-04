'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('playwright');
const {
  FIXTURE_PATH,
  FUTURE_EXPIRY,
  applyMockedBonuses,
} = require('../.agents/skills/sportsbook-bonus-override/scripts/bonus-override.cjs');

const fixture = require(FIXTURE_PATH);
const originalResponse = {
  data: { bonuses: { native: { id: 'native' } }, mappings: {} },
  responseContext: { source: 'native' },
};

function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><button id="usable">Use page</button><output id="clicks">0</output><script>
        document.querySelector('#usable').onclick = () => document.querySelector('#clicks').textContent++;
        window.ready = Promise.all([
          fetch('/api/bonuses').then(r => r.json()).then(v => window.fetchBonus = v),
          fetch('/api/bonuses?schema=wrong').then(r => r.json()).then(v => window.wrongSchema = v),
          fetch('/api/profile').then(r => r.json()).then(v => window.profile = v)
        ]);
      </script>`);
      return;
    }
    if (req.url === '/api/bonuses?schema=wrong') { res.end(JSON.stringify({ data: { bonuses: [] }, untouched: true })); return; }
    if (req.url === '/api/profile') { res.end(JSON.stringify({ untouched: true })); return; }
    if (req.url === '/api/bonuses') { res.end(JSON.stringify(originalResponse)); return; }
    res.statusCode = 404;
    res.end(JSON.stringify({ missing: true }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    const future = await applyMockedBonuses(page, {
      endpointPattern: /\/api\/bonuses(?:\?|$)/,
      expiryPolicy: 'future',
      timeout: 5000,
    });
    await page.evaluate(() => window.ready);
    const values = await page.evaluate(() => ({ bonus: window.fetchBonus, wrong: window.wrongSchema, profile: window.profile }));
    assert.equal(Object.keys(values.bonus.data.bonuses).length, 40);
    assert.deepEqual(values.bonus.responseContext, fixture.responseContext);
    assert.ok(Object.values(values.bonus.data.bonuses).every((bonus) => bonus.expiryDate === FUTURE_EXPIRY));
    assert.deepEqual(values.wrong, { data: { bonuses: [] }, untouched: true });
    assert.deepEqual(values.profile, { untouched: true });

    const xhrValue = await page.evaluate(() => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/bonuses');
      xhr.onload = () => resolve(JSON.parse(xhr.responseText));
      xhr.onerror = reject;
      xhr.send();
    }));
    assert.equal(Object.keys(xhrValue.data.bonuses).length, 40);
    await page.click('#usable');
    assert.equal(await page.textContent('#clicks'), '1');
    assert.ok(future.matchCount >= 2);
    await future.stop();

    const preserve = await applyMockedBonuses(page, {
      endpointPattern: /\/api\/bonuses(?:\?|$)/,
      expiryPolicy: 'preserve',
      timeout: 5000,
    });
    await page.evaluate(() => window.ready);
    const preservedDate = await page.evaluate((id) => window.fetchBonus.data.bonuses[id].expiryDate, Object.keys(fixture.data.bonuses)[0]);
    assert.equal(preservedDate, Object.values(fixture.data.bonuses)[0].expiryDate);
    await preserve.stop();

    await assert.rejects(
      applyMockedBonuses(page, { endpointPattern: '**/never-observed**', timeout: 250 }),
      /No GET fetch\/XHR bonus response/,
    );
    console.log('[bonus-helper-test] PASS');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error('[bonus-helper-test] FATAL', error);
  process.exitCode = 1;
});
