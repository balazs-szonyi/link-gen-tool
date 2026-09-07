'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const EXT_PATH = process.env.LGT_EXTENSION_PATH
  ? path.resolve(process.env.LGT_EXTENSION_PATH)
  : path.resolve(__dirname, 'extension');

// Minimal fixture mirroring the real
// /api/sb/v1/widgets/coupon-history/v1 response shape (QA repro coupon
// 187488260436836352, England Premier League (EPL) BetBuilder), trimmed to
// the fields the mock reads/writes.
function makeCouponHistoryResponse() {
  return {
    data: {
      coupons: [
        {
          id: '187488260436836352',
          type: 'BetBuilder',
          status: 'Settled',
          stake: 1.0,
          effectiveStake: 1.0,
          totalPayout: 7.5,
          totalPotentialPayout: 7.5,
          boostedOdds: 7.5,
          totalOdds: 7.5,
          bonusBetType: 'PriceBoost',
          betsStatus: { won: 1 },
          numberOfSelections: 1,
          eventNames: ['FTB_P_A_BB_1788237221 - FTB_P_B_BB_1788237221'],
          systemBet: {
            selections: [
              {
                betMarketType: 'Default',
                eventName: 'FTB_P_A_BB_1788237221 - FTB_P_B_BB_1788237221',
                status: 'Won',
                odds: 7.5,
                boostedOdds: 7.5,
                formattedOdds: '7.50',
                formattedBoostedOdds: '7.50',
                betBuilderSelectionLabels: [
                  'PM Match Winner - FTB_P_A_BB_1788237221',
                  'Both Teams to Score - Yes',
                  'Number of Goals - Over 3.5',
                ],
                combinedMarketSelections: [
                  { selectionId: 's-1', selectionName: 'FTB_P_A_BB_1788237221', marketName: 'PM Match Winner', marketSelectionResultStatus: 'Won' },
                  { selectionId: 's-2', selectionName: 'Yes', marketName: 'Both Teams to Score', marketSelectionResultStatus: 'Won' },
                  { selectionId: 's-3', selectionName: 'Over 3.5', marketName: 'Number of Goals', marketSelectionResultStatus: 'Won' },
                ],
              },
            ],
          },
        },
        {
          id: 'OTHER-COUPON-1',
          type: 'Single',
          status: 'Settled',
          stake: 2.0,
          effectiveStake: 2.0,
          totalPayout: 4.0,
          totalPotentialPayout: 4.0,
          boostedOdds: 0,
          totalOdds: 2.0,
          bonusBetType: 'Unset',
          betsStatus: { won: 1 },
          numberOfSelections: 1,
          eventNames: ['Some Other Match'],
          systemBet: { selections: [{ eventName: 'Some Other Match', status: 'Won', marketName: 'Match Winner', selectionName: 'Home' }] },
        },
      ],
      paging: { page: 1, pageSize: 20, totalPages: 1, totalItemCount: 2 },
    },
    referenceId: 'native-coupon-history',
  };
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>Bet Void Mock E2E</title><button id="usable">Usable</button><output id="clicks">0</output><script>document.querySelector("#usable").onclick=()=>document.querySelector("#clicks").textContent++</script>');
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url.indexOf('/api/sb/v1/widgets/coupon-history/v1') === 0) { res.end(JSON.stringify(makeCouponHistoryResponse())); return; }
    if (req.url === '/api/profile') { res.end(JSON.stringify({ untouched: 'endpoint' })); return; }
    res.statusCode = 404;
    res.end(JSON.stringify({ missing: true }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function showPanel(page) {
  if (!await page.locator('#lgt-panel').isVisible().catch(() => false)) {
    await page.locator('#lgt-panel').evaluate((panel) => { panel.style.display = ''; });
  }
  await page.waitForSelector('#lgt-panel', { state: 'visible' });
  await page.locator('#lgt-panel .lgt-tab').filter({ hasText: 'Bet Void' }).click();
}

(async () => {
  const server = await startServer();
  const port = server.address().port;
  const userDataDir = path.join(os.tmpdir(), 'lgt-bet-void-mock-e2e-' + Date.now());
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

    // 1) Passive recording: a plain fetch (no config applied yet) must
    // leave the response untouched, but must populate LAST_SEEN_KEY so
    // the panel can "detect" real, currently-visible coupons.
    const nativeFirst = await page.evaluate(() => fetch('/api/sb/v1/widgets/coupon-history/v1?couponFilter=Settled&page=1&pageSize=20').then((r) => r.json()));
    assert.equal(nativeFirst.data.coupons[0].status, 'Settled');
    assert.equal(nativeFirst.data.coupons[0].boostedOdds, 7.5);

    await showPanel(page);
    const panel = page.locator('#lgt-panel');
    await panel.locator('#lgt-bet-void-detect').click();
    await page.waitForFunction(() => document.querySelector('[data-lgt-bet-void-seen]')?.textContent.includes('2 coupon(s) captured'));

    const options = await panel.locator('#lgt-bet-void-coupon option').allTextContents();
    assert.ok(options.some((text) => text.includes('187488260436836352') && text.includes('PriceBoost')), 'expected target coupon listed with PriceBoost badge');

    await panel.locator('#lgt-bet-void-coupon').selectOption({ label: options.find((text) => text.includes('187488260436836352')) });
    await page.waitForFunction(() => /Number of Goals - Over 3\.5/.test(document.querySelector('[data-lgt-bet-void-legs]')?.textContent || ''));

    // Select only the "Number of Goals - Over 3.5" leg (index 2) to void,
    // matching the original bug report.
    const legRow = panel.locator('[data-lgt-bet-void-legs] label', { hasText: 'Number of Goals - Over 3.5' });
    await legRow.locator('input[type=checkbox]').check();
    await panel.locator('#lgt-bet-void-odds').fill('4.15');
    await panel.locator('#lgt-bet-void-apply').click();
    await page.waitForFunction(() => document.querySelector('[data-lgt-bet-void-status]')?.getAttribute('data-lgt-bet-void-status') === 'active');

    // 2) Fetch again: the targeted leg must be Void, totalOdds/payout
    // recalculated to the corrected value, but boostedOdds/bonusBetType
    // MUST remain stale - this is the actual bug being reproduced.
    const mocked = await page.evaluate(() => fetch('/api/sb/v1/widgets/coupon-history/v1?couponFilter=Settled&page=1&pageSize=20').then((r) => r.json()));
    const targetCoupon = mocked.data.coupons.find((c) => c.id === '187488260436836352');
    const otherCoupon = mocked.data.coupons.find((c) => c.id === 'OTHER-COUPON-1');
    const legs = targetCoupon.systemBet.selections[0].combinedMarketSelections;
    assert.equal(legs[2].marketSelectionResultStatus, 'Void', 'targeted leg must be Void');
    assert.equal(legs[0].marketSelectionResultStatus, 'Won', 'untouched leg must stay as-is');
    assert.equal(targetCoupon.status, 'Void', 'whole coupon status must be Void (checkbox was checked)');
    assert.equal(targetCoupon.totalOdds, 4.15, 'totalOdds must be recalculated to the corrected value');
    assert.equal(targetCoupon.totalPayout, 4.15, 'totalPayout must be recalculated from corrected odds * stake');
    assert.equal(targetCoupon.boostedOdds, 7.5, 'boostedOdds must remain STALE (the actual bug)');
    assert.equal(targetCoupon.bonusBetType, 'PriceBoost', 'bonusBetType must remain STALE (the actual bug)');
    assert.deepEqual(otherCoupon, makeCouponHistoryResponse().data.coupons[1], 'a non-targeted coupon in the same response must be byte-for-byte unchanged');

    // XHR path must apply the same override.
    const xhrPayload = await page.evaluate(() => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/sb/v1/widgets/coupon-history/v1?couponFilter=Settled&page=1&pageSize=20');
      xhr.responseType = 'json';
      xhr.onload = () => resolve(xhr.response);
      xhr.onerror = reject;
      xhr.send();
    }));
    const xhrTarget = xhrPayload.data.coupons.find((c) => c.id === '187488260436836352');
    assert.equal(xhrTarget.totalOdds, 4.15);
    assert.equal(xhrTarget.boostedOdds, 7.5);

    // A completely unrelated endpoint must never be touched.
    const profile = await page.evaluate(() => fetch('/api/profile').then((r) => r.json()));
    assert.deepEqual(profile, { untouched: 'endpoint' });

    await page.click('#usable');
    assert.equal(await page.textContent('#clicks'), '1');

    // 3) Stop must restore the native response.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      panel.locator('#lgt-bet-void-stop').click(),
    ]);
    const restored = await page.evaluate(() => fetch('/api/sb/v1/widgets/coupon-history/v1?couponFilter=Settled&page=1&pageSize=20').then((r) => r.json()));
    assert.deepEqual(restored, makeCouponHistoryResponse());

    console.log('[bet-void-mock-e2e] PASS');
  } finally {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error('[bet-void-mock-e2e] FATAL', error);
  process.exitCode = 1;
});