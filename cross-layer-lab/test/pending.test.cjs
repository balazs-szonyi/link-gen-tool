'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PendingActions } = require('../lib/pending.cjs');

test('confirmation is single-use with no automatic retry', async () => {
  const pending = new PendingActions({ timeoutMs: 1000 });
  const action = pending.create({ brand: 'betsson', stake: 1 });
  const id = pending.list()[0].id;
  assert.equal(pending.decide(id, 'approve'), true);
  assert.equal(await action, 'approve');
  assert.equal(pending.decide(id, 'approve'), false);
});

test('cancel rejects the held mutation', async () => {
  const pending = new PendingActions({ timeoutMs: 1000 });
  const action = pending.create({ brand: 'nordicbet' });
  const id = pending.list()[0].id;
  pending.decide(id, 'cancel');
  await assert.rejects(action, /cancelled/);
});

test('companion crash rejects all held mutations', async () => {
  const pending = new PendingActions({ timeoutMs: 1000 });
  const first = pending.create({ brand: 'betsson' });
  const second = pending.create({ brand: 'nordicbet' });
  pending.rejectAll('companion-stopped');
  await assert.rejects(first, /companion-stopped/);
  await assert.rejects(second, /companion-stopped/);
  assert.equal(pending.list().length, 0);
});

test('timeout rejects fail-closed', async () => {
  const pending = new PendingActions({ timeoutMs: 5 });
  await assert.rejects(pending.create({ brand: 'betsson' }), /timeout/);
});
