'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLab } = require('../server.cjs');
const { ENVIRONMENTS, LAYERS } = require('../lib/model.cjs');

const pairs = ENVIRONMENTS.flatMap((pageEnv) => ENVIRONMENTS
  .filter((bundleEnv) => LAYERS[pageEnv] !== LAYERS[bundleEnv])
  .map((bundleEnv) => [pageEnv, bundleEnv]));

class FakeBrowser {
  constructor() { this.starts = []; this.stops = 0; }
  async start(session) { this.starts.push({ ...session }); return `https://${session.pageEnv}.example.test/sportsbook`; }
  async stop() { this.stops += 1; }
}

test('mock integration covers 8 ordered pairs x 2 modes x 2 devices', async () => {
  assert.equal(pairs.length, 8);
  const browser = new FakeBrowser();
  const lab = createLab({ token: 'matrix-token', browser, accounts: [], audit: { write() {} } });
  await new Promise((resolve) => lab.server.listen(0, '127.0.0.1', resolve));
  const port = lab.server.address().port;
  try {
    for (const [pageEnv, bundleEnv] of pairs) {
      for (const mode of ['hybrid', 'full-runtime']) {
        for (const device of ['desktop', 'mobile']) {
          const response = await fetch(`http://127.0.0.1:${port}/v1/session`, {
            method: 'PUT', headers: { authorization: 'Bearer matrix-token', 'content-type': 'application/json' },
            body: JSON.stringify({ brand: 'betsson', pageEnv, bundleEnv, mode, device }),
          });
          assert.equal(response.status, 200);
          const { session } = await response.json();
          assert.equal(session.pageEnv, pageEnv);
          assert.equal(session.bundleEnv, bundleEnv);
          assert.equal(session.backendEnv, mode === 'hybrid' ? pageEnv : bundleEnv);
          assert.equal(session.device, device);
          assert.equal(session.status, 'ready');
        }
      }
    }
    assert.equal(browser.starts.length, 32);
  } finally {
    await new Promise((resolve) => lab.server.close(resolve));
  }
});

test('state-changing API requires token', async () => {
  const lab = createLab({ token: 'secret', browser: new FakeBrowser(), accounts: [], audit: { write() {} } });
  await new Promise((resolve) => lab.server.listen(0, '127.0.0.1', resolve));
  const port = lab.server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/session`, { method: 'DELETE' });
    assert.equal(response.status, 401);
  } finally { await new Promise((resolve) => lab.server.close(resolve)); }
});
