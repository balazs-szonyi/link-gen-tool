'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouteHandler } = require('../lib/router.cjs');
const { PendingActions } = require('../lib/pending.cjs');

function fakeRoute({ url, method = 'GET', body = null, headers = {} }) {
  const state = {};
  return {
    state,
    request() {
      return {
        url: () => url, method: () => method, headers: () => headers,
        postDataBuffer: () => body === null ? null : Buffer.from(JSON.stringify(body)),
      };
    },
    async continue() { state.continued = true; },
    async fulfill(value) { state.fulfilled = value; },
    async fetch() { throw new Error('fetch must not be reached'); },
  };
}

function dependencies(session, accounts = []) {
  return { getSession: () => session, pending: new PendingActions(), accounts, audit: { write() {} } };
}

test('unknown sportsbook POST contract fails closed', async () => {
  const route = fakeRoute({ url: 'https://api.test.betsson.com/api/sb/v1/new-write', method: 'POST', body: {} });
  await createRouteHandler(dependencies({ status: 'ready', brand: 'betsson', bundleEnv: 'prod', backendEnv: 'test', mode: 'hybrid' }))(route);
  assert.equal(route.state.fulfilled.status, 409);
  assert.match(route.state.fulfilled.body, /unsupported-cross-layer-contract/);
});

test('PROD place-bet rejects a non-allowlisted customer before network', async () => {
  const route = fakeRoute({ url: 'https://api.betsson.com/api/sb/v1/place-bet', method: 'POST', body: { accountId: 'nope', stake: 10, currency: 'EUR' } });
  await createRouteHandler(dependencies({ status: 'ready', brand: 'betsson', bundleEnv: 'test', backendEnv: 'prod', mode: 'hybrid' }))(route);
  assert.equal(route.state.fulfilled.status, 403);
  assert.match(route.state.fulfilled.body, /prod-account-not-allowlisted/);
});

test('unknown declared contract version fails closed', async () => {
  const route = fakeRoute({ url: 'https://api.test.betsson.com/api/sb/v1/events', headers: { 'x-sb-contract-version': 'future' } });
  await createRouteHandler(dependencies({ status: 'ready', brand: 'betsson', bundleEnv: 'prod', backendEnv: 'test', mode: 'hybrid' }))(route);
  assert.equal(route.state.fulfilled.status, 409);
  assert.match(route.state.fulfilled.body, /unsupported-contract-version/);
});

test('companion localhost API is never routed as a sportsbook auth contract', async () => {
  const route = fakeRoute({ url: 'http://127.0.0.1:8845/v1/session' });
  await createRouteHandler(dependencies({ status: 'ready', brand: 'betsson', bundleEnv: 'test', backendEnv: 'test', mode: 'full-runtime' }))(route);
  assert.equal(route.state.continued, true);
  assert.equal(route.state.fulfilled, undefined);
});
