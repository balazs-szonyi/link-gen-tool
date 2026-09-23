'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const navigation = require('../extension/bundle-navigation.js');

test('bundle scope follows every navigation for the lifetime of its tab', () => {
  const scope = navigation.scopeForUrl('https://www.test.betsson.com/en/sportsbook/live/tennis?exposeObgState=true');
  assert.deepEqual(scope, { kind: 'tab' });
  assert.equal(navigation.matches(scope, 'https://www.test.betsson.com/en/sportsbook'), true);
  assert.equal(navigation.matches(scope, 'https://www.test.betsson.com/en/horse-racing'), true);
  assert.equal(navigation.matches(scope, 'https://www.test.betsson.com/en/casino'), true);
  assert.equal(navigation.matches(scope, 'about:blank'), true);
});

test('generated playground links also retain tab scope', () => {
  const scope = navigation.scopeForUrl('https://d-cf.test.btsplayground.net/stc-1/ctx-2/?exposeObgState=true');
  assert.equal(navigation.matches(scope, 'https://d-cf.test.btsplayground.net/stc-1/ctx-2/?sealStore=false'), true);
  assert.equal(navigation.matches(scope, 'https://d-cf.test.btsplayground.net/stc-1/ctx-3/'), true);
});
