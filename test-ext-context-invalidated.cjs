// Minimal repro: verify pollWhileExtensionValid() stops silently instead of
// re-throwing "Extension context invalidated" once chrome.runtime.id is
// gone (the observed real-world bug: extension reloaded while a QA
// nordicbet tab stayed open, error logged 4x every 3s in
// chrome://extensions errors page).
const assert = require('assert');

const timers = [];
global.setInterval = (fn, ms) => { const id = timers.length; timers.push({ fn, ms, cleared: false }); return id; };
global.clearInterval = (id) => { if (timers[id]) timers[id].cleared = true; };

// Inline copy of the helper under test (kept in sync manually; source of
// truth is content.js's pollWhileExtensionValid).
function pollWhileExtensionValid(fn, intervalMs) {
  var iv = setInterval(tick, intervalMs);
  function tick() {
    if (!chrome.runtime || !chrome.runtime.id) { clearInterval(iv); return; }
    try { fn(); } catch (e) { clearInterval(iv); }
  }
  tick();
  return iv;
}

// --- Scenario A: extension valid, then invalidated mid-flight (context
// invalidated between two ticks, e.g. the extension was reloaded/updated
// while this tab stayed open) - the interval must detect this on its very
// next tick and clear itself, never calling fn() again. ---
global.chrome = { runtime: { id: 'abc', sendMessage: () => {} } };
let calls = 0;
function refresh() { calls++; chrome.runtime.sendMessage({ type: 'x' }, function () {}); }

const iv = pollWhileExtensionValid(refresh, 3000);
assert.strictEqual(calls, 1, 'first tick (context valid) should call fn once');
assert.strictEqual(timers[iv].cleared, false, 'interval must stay alive while context is valid');

// Extension gets reloaded: chrome.runtime.id becomes undefined (this is
// exactly what real Chrome does, per docs/observed behavior).
chrome.runtime.id = undefined;
timers[iv].fn(); // simulate the interval's next natural 3s tick
assert.strictEqual(calls, 1, 'fn must NOT be called once context is invalidated');
assert.strictEqual(timers[iv].cleared, true, 'interval must self-clear the first time it observes an invalidated context');

// Further natural ticks (simulated) must be no-ops - proves the fix
// actually stops the repeated-error loop seen in the bug report, not just
// clears the interval once while still executing this tick's body.
timers[iv].fn();
assert.strictEqual(calls, 1, 'no further fn calls after self-clearing');

// --- Scenario B: context already invalid on the very first synchronous
// call (edge case) - must not throw and must still register as cleared,
// not leak a live interval. ---
global.chrome = { runtime: { id: undefined } };
let calls2 = 0;
const iv2 = pollWhileExtensionValid(() => { calls2++; }, 3000);
assert.strictEqual(calls2, 0, 'fn must never be called if context is already invalid on the first tick');
assert.strictEqual(timers[iv2].cleared, true, 'interval must not be left running if context was invalid from the start');

// --- Scenario C: fn() itself throws synchronously (the exact failure mode
// from the bug report - chrome.runtime.sendMessage throws "Extension
// context invalidated" even though chrome.runtime.id check raced past,
// e.g. a Chrome version where the id isn't cleared before the throw
// starts happening) - must be caught, not propagate as an uncaught error,
// and must still self-clear. ---
global.chrome = { runtime: { id: 'abc' } };
let threwCount = 0;
const iv3 = pollWhileExtensionValid(() => { threwCount++; throw new Error('Extension context invalidated.'); }, 3000);
assert.strictEqual(threwCount, 1, 'fn should have been attempted once');
assert.strictEqual(timers[iv3].cleared, true, 'a synchronous throw from fn must be caught and stop the interval, not propagate');

console.log('PASS: pollWhileExtensionValid stops after Extension context invalidated in all 3 scenarios, no repeated/uncaught errors.');
