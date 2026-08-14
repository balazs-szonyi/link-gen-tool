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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function createLab(options = {}) {
  const token = options.token || crypto.randomBytes(24).toString('base64url');
  const root = path.resolve(__dirname);
  const audit = options.audit || new AuditLog(path.join(root, 'logs', 'audit.jsonl'));
  const accounts = options.accounts || loadAccounts(path.join(root, 'accounts.local.json'));
  const pending = options.pending || new PendingActions({ onAudit: (event) => audit.write(event) });
  const browser = options.browser || new LabBrowser({ profileDir: path.join(root, '.chrome-profile') });
  let session = null;

  function authorized(req) { return req.headers.authorization === `Bearer ${token}`; }
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url, 'http://127.0.0.1:8845');
    if (url.pathname === '/v1/health' && req.method === 'GET') return send(res, 200, { ok: true, version: '1.19.0', sessionActive: !!session });
    if (!authorized(req)) return send(res, 401, { error: 'invalid-or-missing-token' });
    try {
      if (url.pathname === '/v1/session' && req.method === 'GET') return send(res, 200, { session });
      if (url.pathname === '/v1/pending-actions' && req.method === 'GET') return send(res, 200, { actions: pending.list() });
      if (url.pathname === '/v1/session' && req.method === 'PUT') {
        const next = normalizeSession(await readBody(req));
        pending.rejectAll('session-replaced');
        session = next;
        const openedUrl = await browser.start(session, { getSession: () => session, pending, accounts, audit });
        session.status = 'ready'; session.openedUrl = openedUrl;
        return send(res, 200, { session });
      }
      if (url.pathname === '/v1/session' && req.method === 'DELETE') {
        pending.rejectAll('session-ended'); await browser.stop(); session = null;
        return send(res, 200, { ok: true });
      }
      const match = /^\/v1\/pending-actions\/([^/]+)\/decision$/.exec(url.pathname);
      if (match && req.method === 'POST') {
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
  return { server, token, getSession: () => session, pending };
}

module.exports = { createLab };
