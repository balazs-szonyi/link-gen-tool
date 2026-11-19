const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const { parse, merge, FORMAT } = require('../extension/credential-import.js');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));

const brandOf = (url) => (url.includes('betsson') ? 'betsson' : url.includes('betsafe') ? 'betsafe' : null);
let n = 0;
const uid = () => 'id' + (++n);

test('parse rejects foreign formats and skips incomplete rows', () => {
  assert.ok(parse('nope').error);
  assert.ok(parse(JSON.stringify({ format: 'x', credentials: [] })).error);
  const res = parse(JSON.stringify({
    format: FORMAT,
    credentials: [{ label: 'a', username: 'u', password: 'p', urls: ['https://qa.betsson.com'] }, { username: 'u2' }]
  }));
  assert.equal(res.records.length, 1);
  assert.equal(res.skipped, 1);
});

test('merge adds, updates by label+username, unions brands and keeps the default', () => {
  const existing = [{ id: 'old', label: 'QA user', username: 'u', password: 'old', isDefault: true, brands: ['betsafe'] }];
  const res = merge(existing, [
    { label: 'QA user', username: 'u', password: 'new', urls: ['https://www.qa.betsson.com'] },
    { label: 'Other', username: 'o', password: 'p', urls: [] }
  ], brandOf, uid);
  assert.equal(res.added, 1);
  assert.equal(res.updated, 1);
  assert.equal(res.unassigned, 1);
  assert.deepEqual(res.list[0].brands, ['betsafe', 'betsson']);
  assert.equal(res.list[0].password, 'new');
  assert.equal(res.list[0].id, 'old');
  assert.equal(res.list[1].isDefault, false);
  assert.equal(existing[0].password, 'old');
});

test('first imported credential becomes default in an empty vault', () => {
  const res = merge([], [{ label: 'a', username: 'u', password: 'p', urls: [] }], brandOf, uid);
  assert.equal(res.list[0].isDefault, true);
});

test('manifest injects credential-import.js before content.js', () => {
  const scripts = manifest.content_scripts.find((s) => s.js.includes('content.js')).js;
  assert.ok(scripts.indexOf('credential-import.js') !== -1);
  assert.ok(scripts.indexOf('credential-import.js') < scripts.indexOf('content.js'));
});
