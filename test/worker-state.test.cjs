'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/worker-state.js');
const Detection = require('../extension/detection-state.js');
const Debugger = require('../extension/debugger-session.js');
const { makeChrome, deferred, flush } = require('./worker-harness.cjs');
const URL = 'https://www.test.betsson.com/sportsbook';
function manager(mock) { const store = core.createStore(mock.chrome); return { store, dnr: core.createDnr(mock.chrome, store) }; }
const metadata = { scope: { kind: 'url', value: URL } };
const build = tabId => async () => allocate => [{ id: allocate(1)[0], priority: 1, action: { type: 'block' }, condition: { tabIds: [tabId], urlFilter: 'unit-test' } }];

for (const feature of Object.keys(core.RANGES)) test(feature + ': Apply -> worker restart -> status -> reapply -> Stop', async () => {
  const mock = makeChrome(); let { dnr } = manager(mock);
  await dnr.apply(feature, 1, metadata, build(1));
  assert.equal((await dnr.status(feature, 1)).rules.length, 1);
  // Same browser storage and rules; a wholly new module instance has no queues.
  dnr = manager(mock).dnr;
  assert.equal((await dnr.status(feature, 1)).rules.length, 1);
  await dnr.apply(feature, 1, metadata, build(1));
  assert.equal(mock.state.rules.length, 1);
  assert.equal(mock.state.updates.at(-1).removeRuleIds.length, 1);
  assert.equal(mock.state.updates.at(-1).addRules.length, 1);
  await dnr.stop(feature, 1);
  assert.equal(mock.state.rules.length, 0);
});

test('parallel tabs never collide; gaps reused and exhaustion fails explicitly', async () => {
  const mock = makeChrome(); const { dnr } = manager(mock);
  await Promise.all(Array.from({ length: 30 }, (_, i) => dnr.apply('bundle', i + 1, metadata, build(i + 1))));
  assert.equal(new Set(mock.state.rules.map(rule => rule.id)).size, 30);
  await dnr.stop('bundle', 5);
  await dnr.apply('bundle', 99, metadata, build(99));
  assert.equal(mock.state.rules.length, 30);
  const [start, end] = core.RANGES.embed;
  assert.throws(() => core.allocate(Array.from({ length: end - start }, (_, i) => ({ id: start + i })), 'embed', 1), /exhausted/);
});

for (const interrupt of ['stop', 'navigation', 'new apply']) test('slow Apply cancelled by ' + interrupt, async () => {
  const mock = makeChrome(); const { dnr } = manager(mock); const wait = deferred();
  const applying = dnr.apply('bundle', 1, metadata, async () => { await wait.promise; return (await build(1)()); });
  const rejected = assert.rejects(applying, /cancel|supersed/i);
  await flush();
  if (interrupt === 'stop') await dnr.stop('bundle', 1);
  else if (interrupt === 'navigation') await dnr.navigate(1, URL + '/next');
  else await dnr.apply('bundle', 1, metadata, build(1));
  wait.resolve(); await rejected;
  assert.equal(mock.state.rules.length, interrupt === 'new apply' ? 1 : 0);
});

for (const status of ['applying', 'stopping', 'corrupted', 'missing']) test('restart removes incomplete/mismatched intent: ' + status, async () => {
  const mock = makeChrome(); let { dnr, store } = manager(mock);
  await dnr.apply('embed', 1, metadata, build(1));
  const key = store.keyFor('dnr/embed', 1);
  if (status === 'missing') delete mock.state.session[key];
  else if (status === 'corrupted') mock.state.rules[0].action = { type: 'allow' };
  else mock.state.session[key].status = status;
  dnr = manager(mock).dnr;
  await dnr.ready;
  assert.equal(mock.state.rules.length, 0);
  assert.equal(mock.state.session[key], undefined);
});

test('metadata write failure cannot leave an untracked override; DNR errors are not inactive', async () => {
  const mock = makeChrome(); const { dnr } = manager(mock); await dnr.ready;
  let writes = 0;
  mock.state.fail = label => label === 'session.set' && ++writes === 2;
  await assert.rejects(dnr.apply('bundle', 1, metadata, build(1)), /Injected failure/);
  assert.equal(mock.state.rules.length, 0);
  mock.state.fail = 'dnr.get';
  await assert.rejects(dnr.status('bundle', 1), /Injected failure/);
  mock.state.fail = null;
  await dnr.apply('bundle', 1, metadata, build(1));
  mock.state.fail = 'dnr.update';
  await assert.rejects(dnr.stop('bundle', 1), /Injected failure/);
  assert.equal(mock.state.rules.length, 1);
  mock.state.fail = null;
  await manager(mock).dnr.ready;
  assert.equal(mock.state.rules.length, 0);
});

test('URL and origin scopes retain reloads, remove only their own departing rules', async () => {
  const mock = makeChrome(); const { dnr } = manager(mock);
  await dnr.apply('bundle', 1, metadata, build(1));
  await dnr.apply('bleData', 1, { scope: { kind: 'origin', value: new global.URL(URL).origin } }, build(1));
  await dnr.navigate(1, URL); assert.equal(mock.state.rules.length, 2);
  await dnr.navigate(1, URL + '/different'); assert.equal(mock.state.rules.length, 1);
  await dnr.navigate(1, 'https://www.test.betsson.co/'); assert.equal(mock.state.rules.length, 0);
});

test('session updates are serialized per key, never lose cross-tab writes', async () => {
  const mock = makeChrome(); const store = core.createStore(mock.chrome);
  await Promise.all(Array.from({ length: 80 }, (_, i) => store.update('count', i % 2, value => ({ count: (value?.count || 0) + 1 }))));
  assert.equal((await store.read('count', 0)).count, 40);
  assert.equal((await store.read('count', 1)).count, 40);
});

test('detection persists and rejects enrichment from old navigation, documents and overwritten requests', async () => {
  const mock = makeChrome(); const store = core.createStore(mock.chrome); let detect = Detection.create(store);
  const details = { tabId: 1, frameId: 0, documentId: 'old' };
  await detect.committed(details, { url: URL });
  const token = await detect.observe(details, 'mfe', { version: 'old', url: '/same.js' });
  await detect.navigate({ tabId: 1, frameId: 0 });
  const next = { ...details, documentId: 'new' };
  await detect.committed(next, { url: URL });
  await detect.observe(next, 'mfe', { version: 'new', url: '/same.js' });
  await detect.enrich(details, 'mfe', token, current => { current.version = 'WRONG'; });
  await detect.markers({ tab: { id: 1 }, documentId: 'old' }, [{ layer: 'mfe', version: 'WRONG' }]);
  detect = Detection.create(core.createStore(mock.chrome));
  assert.equal((await detect.snapshot(1)).networkByFrame[0].mfe.version, 'new');
  assert.equal((await detect.snapshot(1)).runtimeByFrame[0].mfe, undefined);
  await detect.observe({ ...next, frameId: 2 }, 'iframe', { version: 'sibling' });
  await detect.navigate({ tabId: 1, frameId: 2 });
  assert.equal((await detect.snapshot(1)).networkByFrame[0].mfe.version, 'new');
  await store.dropTab(1);
  await detect.enrich(details, 'mfe', token, () => assert.fail('late enrichment must not recreate tab'));
  assert.equal(await store.read('detection', 1), null);
});

test('dispatcher returns true, responds once on success and error; unhandled messages return false', async () => {
  const { chrome } = makeChrome(); const register = core.createDispatcher(chrome); const results = [];
  register('test', async message => { if (message.fail) throw Error('bad'); return { ok: true }; });
  const listener = chrome.runtime.onMessage.listeners[0];
  assert.equal(listener({ type: 'unknown' }, {}, () => assert.fail()), false);
  assert.equal(listener({ type: 'test' }, {}, value => results.push(value)), true);
  assert.equal(listener({ type: 'test', fail: true }, {}, value => results.push(value)), true);
  await flush(); assert.deepEqual(results, [{ ok: true }, { ok: false, error: 'bad' }]);
});

test('debugger lease is held across sequences/restart; external debugger is not taken over', async () => {
  const mock = makeChrome(); const store = core.createStore(mock.chrome); let debug = Debugger.create(mock.chrome, store);
  await debug.hold(1);
  await debug.withSession(1, send => send('Input.insertText', { text: 'fixture' }));
  assert.equal(mock.state.attached[1], 'ours');
  debug = Debugger.create(mock.chrome, core.createStore(mock.chrome));
  await debug.withSession(1, send => send('Input.insertText', { text: 'next' }));
  assert.equal(mock.state.attached[1], 'ours');
  await debug.release(1); assert.equal(mock.state.attached[1], undefined);
  mock.state.attached[1] = 'external';
  await store.update('debugger', 1, () => ({ held: true }));
  await assert.rejects(debug.hold(1), /Another debugger/);
  assert.equal(mock.state.attached[1], 'external');
});

test('debugger sequences serialize; mobile setup failure and onDetach clear held leases', async () => {
  const mock = makeChrome(); const store = core.createStore(mock.chrome); const debug = Debugger.create(mock.chrome, store);
  const wait = deferred(); const order = [];
  const first = debug.withSession(1, async () => { order.push(1); await wait.promise; order.push(2); });
  const second = debug.withSession(1, async () => { order.push(3); });
  await flush(); assert.deepEqual(order, [1]); wait.resolve(); await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2, 3]);
  mock.state.fail = 'Emulation.setDeviceMetricsOverride';
  await assert.rejects(debug.withSession(1, send => send('Emulation.setDeviceMetricsOverride'), true), /Injected failure/);
  assert.equal(mock.state.attached[1], undefined);
  mock.state.fail = null;
  await debug.hold(1); delete mock.state.attached[1]; mock.chrome.debugger.onDetach.emit({ tabId: 1 });
  await flush(); assert.equal(await store.read('debugger', 1), null);
});
