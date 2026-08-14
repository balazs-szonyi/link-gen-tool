'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeSession } = require('./lib/model.cjs');
const { loadAccounts } = require('./lib/accounts.cjs');
const { PendingActions } = require('./lib/pending.cjs');
const { AuditLog } = require('./lib/audit.cjs');
const { LabBrowser } = require('./lib/browser.cjs');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let length = 0;
    req.on('data', (chunk) => { length += chunk.length; if (length > 1024 * 1024) reject(new Error('request too large')); else chunks.push(chunk); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-lgt-browser-nonce', 'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function createLab(options = {}) {
  const root = path.resolve(__dirname);
  const audit = options.audit || new AuditLog(path.join(root, 'logs', 'audit.jsonl'));
  const accounts = options.accounts || loadAccounts(path.join(root, 'accounts.local.json'));
  const pending = options.pending || new PendingActions({ onAudit: (event) => audit.write(event) });
  const browser = options.browser || new LabBrowser({ profileDir: path.join(root, '.chrome-profile') });
  let session = null;

  function publicSession(value) {
    if (!value) return null;
    const { browserNonce, ...safe } = value;
    return safe;
  }

  function browserBound(req) {
    return !!session && !!session.browserNonce && req.headers['x-lgt-browser-nonce'] === session.browserNonce;
  }
  function localCliRequest(req) {
    const remote = req.socket && req.socket.remoteAddress;
    return !req.headers.origin && (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1');
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url, 'http://127.0.0.1:8845');
    if (url.pathname === '/v1/health' && req.method === 'GET') return send(res, 200, { ok: true, version: '1.19.1', sessionActive: !!session });
    try {
      if (url.pathname === '/v1/session' && req.method === 'GET') return send(res, 200, { session: publicSession(session) });
      if (url.pathname === '/v1/browser-binding' && req.method === 'GET') {
        if (!browserBound(req)) {
          return send(res, 403, { error: 'managed-browser-required' });
        }
        return send(res, 200, { bound: true });
      }
      if (url.pathname === '/v1/pending-actions' && req.method === 'GET') {
        return browserBound(req) ? send(res, 200, { actions: pending.list() }) : send(res, 403, { error: 'managed-browser-required' });
      }
      if (url.pathname === '/v1/session' && req.method === 'PUT') {
        if (!localCliRequest(req)) return send(res, 403, { error: 'cli-session-start-required' });
        const next = normalizeSession(await readBody(req));
        next.browserNonce = crypto.randomBytes(32).toString('base64url');
        pending.rejectAll('session-replaced');
        session = next;
        const openedUrl = await browser.start(session, { getSession: () => session, pending, accounts, audit });
        session.status = 'ready'; session.openedUrl = openedUrl;
        return send(res, 200, { session: publicSession(session) });
      }
      if (url.pathname === '/v1/session' && req.method === 'DELETE') {
        if (!browserBound(req)) return send(res, 403, { error: 'managed-browser-required' });
        pending.rejectAll('session-ended'); await browser.stop(); session = null;
        return send(res, 200, { ok: true });
      }
      const match = /^\/v1\/pending-actions\/([^/]+)\/decision$/.exec(url.pathname);
      if (match && req.method === 'POST') {
        if (!browserBound(req)) return send(res, 403, { error: 'managed-browser-required' });
        const body = await readBody(req);
        if (!['approve', 'cancel'].includes(body.decision)) return send(res, 400, { error: 'decision must be approve or cancel' });
        return pending.decide(match[1], body.decision) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'pending action not found' });
      }
      return send(res, 404, { error: 'not-found' });
    } catch (error) {
      if (session && session.status === 'starting') { session = null; await browser.stop().catch(function () {}); }
      return send(res, 400, { error: error.message });
    }
  });

  server.on('close', () => { pending.rejectAll('companion-stopped'); void browser.stop(); });
  return { server, getSession: () => session, pending };
}

module.exports = { createLab };
