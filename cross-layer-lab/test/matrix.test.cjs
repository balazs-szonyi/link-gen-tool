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
  const lab = createLab({ browser, accounts: [], audit: { write() {} } });
  await new Promise((resolve) => lab.server.listen(0, '127.0.0.1', resolve));
  const port = lab.server.address().port;
  try {
    for (const [pageEnv, bundleEnv] of pairs) {
      for (const mode of ['hybrid', 'full-runtime']) {
        for (const device of ['desktop', 'mobile']) {
          const response = await fetch(`http://127.0.0.1:${port}/v1/session`, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
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

test('a browser origin cannot start a companion session', async () => {
  const lab = createLab({ browser: new FakeBrowser(), accounts: [], audit: { write() {} } });
  await new Promise((resolve) => lab.server.listen(0, '127.0.0.1', resolve));
  const port = lab.server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/session`, {
      method: 'PUT', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 403);
  } finally { await new Promise((resolve) => lab.server.close(resolve)); }
});

test('browser binding rejects a non-managed Chrome profile without manual tokens', async () => {
  const lab = createLab({ browser: new FakeBrowser(), accounts: [], audit: { write() {} } });
  await new Promise((resolve) => lab.server.listen(0, '127.0.0.1', resolve));
  const port = lab.server.address().port;
  try {
    await fetch(`http://127.0.0.1:${port}/v1/session`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brand: 'betsson', pageEnv: 'prod', bundleEnv: 'test', mode: 'hybrid', device: 'mobile' }),
    });
    const rejected = await fetch(`http://127.0.0.1:${port}/v1/browser-binding`);
    assert.equal(rejected.status, 403);
    const nonce = lab.getSession().browserNonce;
    const accepted = await fetch(`http://127.0.0.1:${port}/v1/browser-binding`, {
      headers: { 'x-lgt-browser-nonce': nonce },
    });
    assert.equal(accepted.status, 200);
    const publicSession = await fetch(`http://127.0.0.1:${port}/v1/session`).then((response) => response.json());
    assert.equal('browserNonce' in publicSession.session, false);
  } finally { await new Promise((resolve) => lab.server.close(resolve)); }
});
