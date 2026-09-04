'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Oddin = require('../../extension/oddin-fix.js');

const C = Oddin.constants;
const TEST_URL = 'https://d-cf.test.sbplayground1.net/sportsbook?bleSource=1';
const QA_URL = 'https://m-cf.qa.sbplayground1.net/sportsbook';
const ODDIN_URL = 'https://disir.oddin.gg/match?lang=en&brandToken=' + C.FIRESTORM_TOKEN;

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) { listeners.push(fn); },
    emit() { const args = arguments; listeners.forEach((fn) => fn.apply(null, args)); }
  };
}

function makeChrome(shared) {
  const state = shared || { rules: [], tabs: [], setting: {}, scriptCalls: [], warnings: [] };
  const onBeforeNavigate = event();
  const onCompleted = event();
  const onRemoved = event();
  const onUpdated = event();
  const onChanged = event();
  const chrome = {
    runtime: {},
    declarativeNetRequest: {
      getSessionRules(cb) { cb(structuredClone(state.rules)); },
      updateSessionRules(update, cb) {
        const remove = new Set(update.removeRuleIds || []);
        state.rules = state.rules.filter((rule) => !remove.has(rule.id));
        for (const rule of update.addRules || []) {
          assert.equal(state.rules.some((item) => item.id === rule.id), false, 'DNR rule IDs must be unique');
          state.rules.push(structuredClone(rule));
        }
        cb();
      }
    },
    storage: {
      local: { get(keys, cb) { cb({ ...state.setting }); } },
      onChanged
    },
    webNavigation: { onBeforeNavigate },
    webRequest: { onCompleted },
    tabs: {
      onRemoved,
      onUpdated,
      query(query, cb) { cb(structuredClone(state.tabs)); }
    },
    scripting: {
      executeScript(options, cb) {
        state.scriptCalls.push(options);
        cb([{ result: true }]);
      }
    }
  };
  return { chrome, state, events: { onBeforeNavigate, onCompleted, onRemoved, onUpdated, onChanged } };
}

function getReferer(rule) {
  return rule.action.requestHeaders.find((header) => header.header.toLowerCase() === 'referer').value;
}

test('Oddin DNR rule is fail-closed to the exact token, host, sub-frame and tab', async () => {
  const mock = makeChrome();
  const fix = Oddin.install(mock.chrome);
  await fix.reconcileNavigation({ frameId: 0, tabId: 42, url: TEST_URL });

  assert.equal(mock.state.rules.length, 1);
  const rule = mock.state.rules[0];
  assert.ok(rule.id >= 990001 && rule.id <= 1009999);
  assert.deepEqual(rule.condition.requestDomains, ['disir.oddin.gg']);
  assert.deepEqual(rule.condition.initiatorDomains, ['d-cf.test.sbplayground1.net']);
  assert.deepEqual(rule.condition.resourceTypes, ['sub_frame']);
  assert.deepEqual(rule.condition.tabIds, [42]);
  assert.match(rule.condition.regexFilter, /b1248112-ccd9-4908-a9fd-acedb48d2c54/);
  assert.deepEqual(rule.action.requestHeaders, [
    { header: 'referer', operation: 'set', value: C.ALPHA_REFERER }
  ]);
  assert.equal(rule.action.responseHeaders, undefined);
  assert.equal(rule.action.requestHeaders.some((header) => header.header.toLowerCase() === 'origin'), false);

  assert.equal(Oddin.isTargetOddinUrl(ODDIN_URL), true);
  assert.equal(Oddin.isTargetOddinUrl(ODDIN_URL.replace(C.FIRESTORM_TOKEN, 'other-token')), false);
  assert.equal(Oddin.isTargetOddinUrl(ODDIN_URL.replace('disir.oddin.gg', 'widgets.sir.sportradar.com')), false);
});

test('non-Firestorm/generic TEST-QA targets and disabled setting never install a rule', async () => {
  const cases = [
    'https://d-cf.alpha.sbplayground1.net/sportsbook',
    'https://d-cf.sbplayground1.net/sportsbook',
    'https://d-cf.test.ndbplayground.net/sportsbook',
    'https://internal.test.sbplayground1.net/generate-link',
    'https://www.test.betsson.com/sportsbook'
  ];
  for (const url of cases) {
    const mock = makeChrome();
    const fix = Oddin.install(mock.chrome);
    await fix.reconcileNavigation({ frameId: 0, tabId: 7, url });
    assert.equal(mock.state.rules.length, 0, url);
  }

  const disabled = makeChrome({ rules: [], tabs: [], setting: { [C.SETTING_KEY]: false }, scriptCalls: [], warnings: [] });
  const fix = Oddin.install(disabled.chrome);
  await fix.reconcileNavigation({ frameId: 0, tabId: 7, url: TEST_URL });
  assert.equal(disabled.state.rules.length, 0);
});

test('403 swaps ALPHA to PROD atomically and retries the exact iframe only once', async () => {
  const mock = makeChrome();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  try {
    const fix = Oddin.install(mock.chrome);
    await fix.reconcileNavigation({ frameId: 0, tabId: 11, url: TEST_URL });
    const alphaId = mock.state.rules[0].id;

    await fix.handleCompleted({ tabId: 11, statusCode: 403, type: 'sub_frame', url: ODDIN_URL });
    assert.equal(mock.state.rules.length, 1);
    assert.notEqual(mock.state.rules[0].id, alphaId);
    assert.equal(getReferer(mock.state.rules[0]), C.PROD_REFERER);
    assert.equal(mock.state.scriptCalls.length, 1);
    assert.deepEqual(mock.state.scriptCalls[0].target, { tabId: 11, frameIds: [0] });
    assert.equal(mock.state.scriptCalls[0].world, 'MAIN');
    assert.deepEqual(mock.state.scriptCalls[0].args.slice(0, 2), [C.ODDIN_HOST, C.FIRESTORM_TOKEN]);

    await fix.handleCompleted({ tabId: 11, statusCode: 403, type: 'sub_frame', url: ODDIN_URL });
    assert.equal(mock.state.rules.length, 1);
    assert.equal(getReferer(mock.state.rules[0]), C.PROD_REFERER);
    assert.equal(mock.state.scriptCalls.length, 2, 'second call only emits the page-console warning');
    assert.match(warnings[0], /no further retries/i);

    await fix.handleCompleted({ tabId: 11, statusCode: 403, type: 'sub_frame', url: ODDIN_URL.replace(C.FIRESTORM_TOKEN, 'other') });
    await fix.handleCompleted({ tabId: 11, statusCode: 200, type: 'sub_frame', url: ODDIN_URL });
    await fix.handleCompleted({ tabId: 11, statusCode: 403, type: 'xmlhttprequest', url: ODDIN_URL });
    assert.equal(mock.state.scriptCalls.length, 2);
  } finally {
    console.warn = originalWarn;
  }
});

test('reload, environment changes, navigation, close, disable and worker restart reconcile live rules', async () => {
  const shared = { rules: [], tabs: [{ id: 5, url: TEST_URL }], setting: {}, scriptCalls: [], warnings: [] };
  let mock = makeChrome(shared);
  let fix = Oddin.install(mock.chrome);
  await fix.reconcileNavigation({ frameId: 0, tabId: 5, url: TEST_URL });
  const originalId = shared.rules[0].id;
  await fix.handleCompleted({ tabId: 5, statusCode: 403, type: 'sub_frame', url: ODDIN_URL });
  const prodId = shared.rules[0].id;

  await fix.reconcileNavigation({ frameId: 0, tabId: 5, url: TEST_URL + '&reload=1' });
  assert.equal(shared.rules[0].id, prodId, 'same-origin reload keeps the active fallback');

  shared.tabs[0].url = QA_URL;
  await fix.reconcileNavigation({ frameId: 0, tabId: 5, url: QA_URL });
  assert.equal(shared.rules.length, 1);
  assert.equal(getReferer(shared.rules[0]), C.ALPHA_REFERER, 'TEST to QA resets fallback to ALPHA');
  assert.deepEqual(shared.rules[0].condition.initiatorDomains, ['m-cf.qa.sbplayground1.net']);

  // Simulated MV3 worker restart: memory/listeners disappear, DNR rules remain.
  mock = makeChrome(shared);
  fix = Oddin.install(mock.chrome);
  await fix.reconcileExisting();
  assert.equal(shared.rules.length, 1, 'restart keeps one valid live rule without duplication');

  await fix.reconcileNavigation({ frameId: 0, tabId: 5, url: 'https://example.com/' });
  assert.equal(shared.rules.length, 0, 'different origin removes the live rule');

  shared.tabs[0].url = TEST_URL;
  await fix.reconcileNavigation({ frameId: 0, tabId: 5, url: TEST_URL });
  await fix.stopTab(5);
  assert.equal(shared.rules.length, 0, 'tab close cleanup reads live DNR state');

  await fix.reconcileNavigation({ frameId: 0, tabId: 5, url: TEST_URL });
  shared.setting[C.SETTING_KEY] = false;
  await fix.stopAll();
  assert.equal(shared.rules.length, 0, 'disabling removes already-active rules immediately');
});
