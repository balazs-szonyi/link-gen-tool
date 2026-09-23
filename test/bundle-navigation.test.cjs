'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const navigation = require('../extension/bundle-navigation.js');

test('sportsbook scope follows SPA routes but does not leak to other site sections', () => {
  const scope = navigation.scopeForUrl('https://www.test.betsson.com/en/sportsbook/live/tennis?exposeObgState=true');
  assert.deepEqual(scope, { kind: 'path-prefix', origin: 'https://www.test.betsson.com', pathPrefix: '/en/sportsbook' });
  assert.equal(navigation.matches(scope, 'https://www.test.betsson.com/en/sportsbook'), true);
  assert.equal(navigation.matches(scope, 'https://www.test.betsson.com/en/sportsbook/live/football?sealStore=false'), true);
  assert.equal(navigation.matches(scope, 'https://www.test.betsson.com/en/casino'), false);
  assert.equal(navigation.matches(scope, 'https://www.qa.betsson.com/en/sportsbook'), false);
});

test('generated playground links retain page scope while ignoring diagnostic query changes', () => {
  const scope = navigation.scopeForUrl('https://d-cf.test.btsplayground.net/stc-1/ctx-2/?exposeObgState=true');
  assert.equal(navigation.matches(scope, 'https://d-cf.test.btsplayground.net/stc-1/ctx-2/?sealStore=false'), true);
  assert.equal(navigation.matches(scope, 'https://d-cf.test.btsplayground.net/stc-1/ctx-3/'), false);
});
