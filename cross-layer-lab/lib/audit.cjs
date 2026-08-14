'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redactAccount } = require('./model.cjs');

class AuditLog {
  constructor(file) { this.file = file; }
  write(event) {
    const safe = {
      timestamp: new Date().toISOString(), environment: event.environment || null,
      brand: event.brand || null, accountHash: redactAccount(event.accountId),
      marketIds: event.marketIds || [], selectionIds: event.selectionIds || [],
      stake: event.stake == null ? null : event.stake, currency: event.currency || null,
      decision: event.decision || null, httpStatus: event.httpStatus || null,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

module.exports = { AuditLog };
