'use strict';

const { classify, CONTRACT_VERSION } = require('./registry.cjs');
const { replaceEnvironment, LAYERS } = require('./model.cjs');
const { createAdapter } = require('./adapters.cjs');
const { isAllowed } = require('./accounts.cjs');

function parseJson(buffer) {
  if (!buffer || !buffer.length) return null;
  try { return JSON.parse(buffer.toString('utf8')); } catch { return null; }
}

function extractBet(body) {
  const value = body || {};
  const selections = value.selections || value.bets || value.legs || [];
  return {
    accountId: value.accountId || value.customerId || value.userId || null,
    stake: value.stake ?? value.amount ?? value.totalStake ?? null,
    currency: value.currency || value.currencyCode || null,
    selectionIds: selections.map((item) => item.selectionId || item.id).filter(Boolean),
    marketIds: selections.map((item) => item.marketId).filter(Boolean),
  };
}

function shouldHandle(url, session, method) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol.startsWith('http') && !!classify(url, method);
}

function createRouteHandler({ getSession, getCookies, pending, accounts, audit }) {
  return async function routeHandler(route) {
    const request = route.request();
    const session = getSession();
    if (!session || session.status !== 'ready') return route.continue();
    try {
      const hostname = new URL(request.url()).hostname;
      if (hostname === '127.0.0.1' || hostname === 'localhost') return route.continue();
    } catch { return route.continue(); }
    const contract = classify(request.url(), request.method());
    var isSportsbookApi = /\/api\/sb\/|\/sb\/fe-api\//i.test(request.url());
    if (!contract && !isSportsbookApi) return route.continue();
    if (!contract) {
      // Unknown reads remain on the page unchanged. Unknown cross-layer writes
      // are never forwarded: a new contract must enter the registry first.
      if (request.method() !== 'GET' && request.method() !== 'HEAD' && request.method() !== 'OPTIONS') {
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'unsupported-cross-layer-contract' }) });
      }
      return route.continue();
    }
    let adapter;
    try {
      adapter = LAYERS[session.bundleEnv] === LAYERS[session.backendEnv]
        ? { adaptConfig: (value) => value, adaptRequest: (contractValue, value) => value, adaptResponse: (contractValue, value) => value }
        : createAdapter(session.bundleEnv, session.backendEnv, request.headers()['x-sb-contract-version'] || CONTRACT_VERSION);
    } catch (error) {
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'unsupported-contract-version', detail: error.message }) });
    }
    const targetEnv = contract.kind === 'config' ? session.bundleEnv : session.backendEnv;
    const targetUrl = replaceEnvironment(request.url(), targetEnv);
    let requestBody = parseJson(request.postDataBuffer());
    requestBody = adapter.adaptRequest(contract, requestBody);

    let bet = null;
    if (contract.mutation) {
      bet = extractBet(requestBody);
      if (session.backendEnv === 'prod') {
        if (!isAllowed(accounts, session.brand, bet.accountId)) {
          return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'prod-account-not-allowlisted' }) });
        }
        try {
          await pending.create({ brand: session.brand, accountId: bet.accountId, stake: bet.stake, currency: bet.currency, selectionIds: bet.selectionIds, marketIds: bet.marketIds, environment: 'prod' });
        } catch (error) {
          return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: error.message }) });
        }
      }
    }

    try {
      const overrides = { url: targetUrl, timeout: 30000 };
      if (session.mode === 'full-runtime' && typeof getCookies === 'function') {
        // Filled below when the browser dependency exposes target-origin
        // cookies; do not copy source-origin cookies onto another layer.
        const targetCookies = await getCookies(targetUrl);
        if (targetCookies && targetCookies.length) overrides.headers = { ...request.headers(), cookie: targetCookies.map((cookie) => cookie.name + '=' + cookie.value).join('; ') };
      }
      if (requestBody !== null) {
        overrides.postData = JSON.stringify(requestBody);
        overrides.headers = { ...(overrides.headers || request.headers()), 'content-type': 'application/json' };
      }
      const response = await route.fetch(overrides);
      const raw = await response.body();
      const parsed = parseJson(raw);
      const adapted = parsed === null ? raw : Buffer.from(JSON.stringify(
        contract.kind === 'config' ? adapter.adaptConfig(parsed) : adapter.adaptResponse(contract, parsed)
      ));
      if (contract.mutation) audit.write({ ...bet, brand: session.brand, environment: session.backendEnv, decision: 'forwarded', httpStatus: response.status() });
      return route.fulfill({ response, body: adapted });
    } catch (error) {
      if (contract.mutation) audit.write({ ...bet, brand: session.brand, environment: session.backendEnv, decision: 'network-failed' });
      return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'cross-layer-upstream-failed', detail: error.message }) });
    }
  };
}

module.exports = { createRouteHandler, extractBet, shouldHandle };
