'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSession, replaceEnvironment } = require('../lib/model.cjs');
const { createAdapter } = require('../lib/adapters.cjs');
const { classify } = require('../lib/registry.cjs');
const { isAllowed } = require('../lib/accounts.cjs');
const { extractBet } = require('../lib/router.cjs');
const bleFixture = require('../fixtures/ble-client-config.redacted.json');
const bdeFixture = require('../fixtures/bde-client-config.redacted.json');

test('session selects mode backend and rejects same-layer use', () => {
  assert.equal(normalizeSession({ brand: 'betsson', pageEnv: 'test', bundleEnv: 'prod', mode: 'hybrid', device: 'desktop' }).backendEnv, 'test');
  assert.equal(normalizeSession({ brand: 'nordicbet', pageEnv: 'alpha', bundleEnv: 'qa', mode: 'full-runtime', device: 'mobile' }).backendEnv, 'qa');
  assert.throws(() => normalizeSession({ brand: 'betsson', pageEnv: 'test', bundleEnv: 'qa', mode: 'hybrid' }), /only accepts cross-layer/);
});

test('environment rewrite handles hosts and dist paths', () => {
  assert.equal(replaceEnvironment('https://www.test.betsson.com/dist/test/config/x', 'prod'), 'https://www.betsson.com/dist/prod/config/x');
  assert.equal(replaceEnvironment('https://api.nordicbet.com/sb/fe-api/x', 'qa'), 'https://api.qa.nordicbet.com/sb/fe-api/x');
});

test('BLE bundle to BDE backend adapts endpoint config and context', () => {
  const adapter = createAdapter('test', 'prod');
  assert.equal(adapter.direction, 'ble-to-bde');
  const config = adapter.adaptConfig({ apiUrl: 'https://api.test.betsson.com/x', unrelated: 'https://keep.test/value' });
  assert.equal(config.apiUrl, 'https://api.betsson.com/x');
  assert.equal(config.unrelated, 'https://keep.test/value');
  assert.deepEqual(adapter.adaptResponse({ kind: 'context' }, { staticContextId: 's', userContextId: 'u' }), { staticContextId: 's', userContextId: 'u', staticContext: 's', userContext: 'u' });
});

test('BDE bundle to BLE backend adapts context in reverse', () => {
  const adapter = createAdapter('prod', 'qa');
  assert.equal(adapter.direction, 'bde-to-ble');
  assert.deepEqual(adapter.adaptRequest({ kind: 'context' }, { staticContext: 's', userContext: 'u' }), { staticContext: 's', userContext: 'u', staticContextId: 's', userContextId: 'u' });
  assert.throws(() => createAdapter('prod', 'qa', 'unknown'), /Unsupported contract/);
});

test('redacted config fixtures transform both directions', () => {
  const toBde = createAdapter('test', 'prod').adaptConfig(bleFixture);
  assert.equal(toBde.apiUrl, bdeFixture.apiUrl);
  assert.equal(toBde.walletUrl, bdeFixture.walletUrl);
  const toBle = createAdapter('prod', 'test').adaptConfig(bdeFixture);
  assert.equal(toBle.apiUrl, bleFixture.apiUrl);
  assert.equal(toBle.realtimeEndpoint, bleFixture.realtimeEndpoint);
});

test('endpoint registry explicitly marks only place-bet as mutation', () => {
  assert.equal(classify('https://x/api/sb/v1/quote', 'POST').mutation, false);
  assert.equal(classify('https://x/api/sb/v1/place-bet', 'POST').mutation, true);
  assert.equal(classify('https://x/new-write-contract', 'POST'), null);
});

test('PROD account gate is brand and id specific', () => {
  const accounts = [{ brand: 'betsson', accountId: '42' }];
  assert.equal(isAllowed(accounts, 'betsson', '42'), true);
  assert.equal(isAllowed(accounts, 'nordicbet', '42'), false);
  assert.equal(isAllowed(accounts, 'betsson', '43'), false);
});

test('bet audit extraction retains no cookie, token, or password', () => {
  const extracted = extractBet({ accountId: '42', stake: 5, currency: 'EUR', token: 'secret', password: 'secret', selections: [{ id: 's1', marketId: 'm1' }] });
  assert.deepEqual(extracted, { accountId: '42', stake: 5, currency: 'EUR', selectionIds: ['s1'], marketIds: ['m1'] });
});
