'use strict';

const crypto = require('node:crypto');

const ENVIRONMENTS = ['test', 'qa', 'alpha', 'prod'];
const BRANDS = {
  betsson: { id: '6a6d80b9-16ac-4387-a413-244d93a74deb', domain: 'betsson.com' },
  nordicbet: { id: '0e5d414b-5234-4050-9fc3-ce1127e18704', domain: 'nordicbet.com' },
};
const LAYERS = { test: 'ble', qa: 'ble', alpha: 'bde', prod: 'bde' };

function assertChoice(name, value, choices) {
  if (!choices.includes(value)) throw new Error(`${name} must be one of: ${choices.join(', ')}`);
  return value;
}

function normalizeSession(input) {
  const brand = assertChoice('brand', String(input.brand || '').toLowerCase(), Object.keys(BRANDS));
  const pageEnv = assertChoice('pageEnv', String(input.pageEnv || '').toLowerCase(), ENVIRONMENTS);
  const bundleEnv = assertChoice('bundleEnv', String(input.bundleEnv || '').toLowerCase(), ENVIRONMENTS);
  const mode = assertChoice('mode', String(input.mode || '').toLowerCase(), ['hybrid', 'full-runtime']);
  const device = assertChoice('device', String(input.device || 'desktop').toLowerCase(), ['desktop', 'mobile']);
  if (LAYERS[pageEnv] === LAYERS[bundleEnv]) throw new Error('Cross-Layer Lab only accepts cross-layer environment pairs');
  return {
    id: crypto.randomUUID(), brand, pageEnv, bundleEnv, mode, device,
    backendEnv: mode === 'hybrid' ? pageEnv : bundleEnv,
    createdAt: new Date().toISOString(), status: 'starting',
  };
}

function envOrigin(brand, env) {
  const prefix = env === 'prod' ? 'www.' : `www.${env}.`;
  return `https://${prefix}${BRANDS[brand].domain}`;
}

function environmentFromHostname(hostname) {
  const labels = String(hostname || '').toLowerCase().split('.');
  return ENVIRONMENTS.find((env) => env !== 'prod' && labels.includes(env)) || 'prod';
}

function replaceEnvironment(urlValue, env) {
  const url = new URL(urlValue);
  const labels = url.hostname.split('.').filter((part) => !['test', 'qa', 'alpha'].includes(part));
  if (env !== 'prod') {
    // Environment labels sit immediately before the registrable domain:
    // www.test.betsson.com, api.qa.betsson.com, wallet.alpha.betsson.com.
    labels.splice(Math.max(0, labels.length - 2), 0, env);
  }
  url.hostname = labels.join('.');
  url.pathname = url.pathname.replace(/\/dist\/(test|qa|alpha|prod)\//, `/dist/${env}/`);
  return url.toString();
}

function redactAccount(account) {
  if (!account) return null;
  return crypto.createHash('sha256').update(String(account)).digest('hex').slice(0, 16);
}

module.exports = { ENVIRONMENTS, BRANDS, LAYERS, normalizeSession, envOrigin, environmentFromHostname, replaceEnvironment, redactAccount };
