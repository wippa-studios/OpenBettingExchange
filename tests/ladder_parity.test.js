// ladder_parity.test.js — client ladder vs engine ladder.
// Run: node tests/ladder_parity.test.js   (plain assert, no deps)
//
// The browser slip (public/ladder.js) mirrors the engine's tick table so the
// stepper can move prices without a round-trip. This suite pins the two
// together: any drift between the tables — or the snap/step/exposure maths —
// fails here before it can confuse a bettor's slip.
'use strict';
const assert = require('assert');
const client = require('../public/ladder.js'); // UMD-lite: consumable under Node
const O = require('../lib/odds'); // the engine's table — read only, never edit here

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log('  ok', name);
};

// L1: the client table IS the engine table (both already integer cents).
check('L1 client bands equal engine bands', () => {
  assert.deepStrictEqual(client.LADDER, O.LADDER);
  assert.strictEqual(client.MIN_CENTS, 101);
  assert.strictEqual(client.MAX_CENTS, 100000);
});

// L2: every engine tick is a fixed point of the client snap, and one step
// walks the whole ladder in lockstep with nextTick/prevTick — including the
// band-edge jumps (2.0→2.02, 10.0→10.5, 100→110…).
check('L2 snap identity + step parity on every tick', () => {
  for (const band of O.LADDER) {
    for (let c = band.lo; c <= band.hi; c += band.step) {
      const p = c / 100;
      assert.strictEqual(client.snapPrice(p), p, `snap(${p})`);
      assert.strictEqual(client.stepPrice(p, 1), O.nextTick(p), `next(${p})`);
      assert.strictEqual(client.stepPrice(p, -1), O.prevTick(p), `prev(${p})`);
    }
  }
});

// L3: snap parity across band gaps, the clamped extremes and every cent in
// between — the client must agree with the engine on ANY price it is fed.
check('L3 snap parity across the whole range', () => {
  for (let c = 1; c <= 100100; c++) {
    const p = c / 100;
    assert.strictEqual(client.snapPrice(p), O.snapToTick(p), `snap(${p})`);
  }
  for (const p of [-5, 0, 0.5, 999.99, 5000]) {
    assert.strictEqual(client.snapPrice(p), O.snapToTick(p), `clamp(${p})`);
  }
});

// L4: exposure preview stays in integer price-cents with ONE rounding at the
// end — half-cent liabilities round half-up, matching the engine's
// cents-domain accounting (a lay @1.5 stake $1.01 previews $0.51).
check('L4 exposure in integer price-cents', () => {
  assert.strictEqual(client.exposureCents(1.5, 101), 51); // 50.5 → 51
  assert.strictEqual(client.exposureCents(2.4, 1000), 1400);
  assert.strictEqual(client.exposureCents(1.01, 100), 1);
  assert.strictEqual(client.exposureCents(1.03, 150), 5); // 4.5 → 5, cents-exact
  assert.strictEqual(client.exposureCents(1000, 100), 99900);
});

// L5: the client fails loudly on non-finite prices instead of silently
// snapping garbage to 1.01 (mirrors the engine's fail-fast contract).
check('L5 non-finite prices throw', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'x', null, undefined]) {
    assert.throws(() => client.snapPrice(bad), TypeError);
    assert.throws(() => client.stepPrice(bad, 1), TypeError);
    assert.throws(() => client.exposureCents(bad, 100), TypeError);
  }
});

console.log(`\nladder_parity.test.js: ${passed} checks passed`);
