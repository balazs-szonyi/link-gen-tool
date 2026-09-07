'use strict';

const crypto = require('node:crypto');

class PendingActions {
  constructor({ timeoutMs = 120000, onAudit = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.onAudit = onAudit;
    this.items = new Map();
  }
  create(summary) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reject(id, 'timeout'), this.timeoutMs);
      this.items.set(id, { id, ...summary, createdAt: new Date().toISOString(), timer, resolve, reject });
    });
  }
  list() {
    return [...this.items.values()].map(({ timer, resolve, reject, ...safe }) => safe);
  }
  decide(id, decision) {
    const item = this.items.get(id);
    if (!item) return false;
    clearTimeout(item.timer); this.items.delete(id);
    this.onAudit({ ...item, timer: undefined, resolve: undefined, reject: undefined, decision });
    if (decision === 'approve') item.resolve('approve');
    else item.reject(new Error('cancelled'));
    return true;
  }
  reject(id, reason) {
    const item = this.items.get(id);
    if (!item) return false;
    clearTimeout(item.timer); this.items.delete(id);
    this.onAudit({ ...item, timer: undefined, resolve: undefined, reject: undefined, decision: reason });
    item.reject(new Error(reason)); return true;
  }
  rejectAll(reason = 'companion-stopped') { for (const id of [...this.items.keys()]) this.reject(id, reason); }
}

module.exports = { PendingActions };
