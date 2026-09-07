'use strict';

const { LAYERS, replaceEnvironment } = require('./model.cjs');
const { CONTRACT_VERSION } = require('./registry.cjs');

const ENDPOINT_KEY = /(url|uri|endpoint|host|origin|api|auth|wallet|realtime|signalr)/i;

function rewriteTree(value, backendEnv, key) {
  if (Array.isArray(value)) return value.map((item) => rewriteTree(item, backendEnv, key));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [childKey, child] of Object.entries(value)) output[childKey] = rewriteTree(child, backendEnv, childKey);
    return output;
  }
  if (typeof value === 'string' && ENDPOINT_KEY.test(key || '') && /^https?:\/\//i.test(value)) {
    try { return replaceEnvironment(value, backendEnv); } catch { return value; }
  }
  return value;
}

function normalizeContext(value, direction) {
  if (!value || typeof value !== 'object') return value;
  const output = { ...value };
  // The two runtimes use different casing for these stable context fields.
  if (direction === 'ble-to-bde') {
    if (output.staticContextId && !output.staticContext) output.staticContext = output.staticContextId;
    if (output.userContextId && !output.userContext) output.userContext = output.userContextId;
  } else {
    if (output.staticContext && !output.staticContextId) output.staticContextId = output.staticContext;
    if (output.userContext && !output.userContextId) output.userContextId = output.userContext;
  }
  return output;
}

function createAdapter(bundleEnv, backendEnv, contractVersion = CONTRACT_VERSION) {
  if (contractVersion !== CONTRACT_VERSION) throw new Error(`Unsupported contract version: ${contractVersion}`);
  const bundleLayer = LAYERS[bundleEnv];
  const backendLayer = LAYERS[backendEnv];
  if (!bundleLayer || !backendLayer || bundleLayer === backendLayer) throw new Error('Adapter requires different known layers');
  const direction = `${bundleLayer}-to-${backendLayer}`;
  return {
    direction, contractVersion,
    adaptConfig(config) { return rewriteTree(config, backendEnv); },
    adaptRequest(contract, body) { return contract.kind === 'context' ? normalizeContext(body, direction) : body; },
    adaptResponse(contract, body) { return contract.kind === 'context' ? normalizeContext(body, direction) : body; },
  };
}

module.exports = { createAdapter, rewriteTree };
