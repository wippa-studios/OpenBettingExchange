// odds.test.js — unit checks for the tick ladder + conversions (PLAN "Odds engine").
// Run: node tests/odds.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const O = require('../lib/odds');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// T1: snapToTick is identity on EVERY valid ladder tick (round-trip property).
check('T1 identity on all ladder ticks', async () => {
  for (const band of O.LADDER) {
    for (let c = band.lo; c <= band.hi; c += band.step) {
      const p = c / 100;
      assert.strictEqual(O.snapToTick(p), p, `tick ${p}`);
    }
  }
});

// T2: nearest-tick snapping across band boundaries and gaps.
check('T2 nearest-tick snapping', async () => {
  assert.strictEqual(O.snapToTick(1.995), 2.0);   // mid-tick, half-up
  assert.strictEqual(O.snapToTick(1.984), 1.98);
  assert.strictEqual(O.snapToTick(3.02), 3.0);    // gap 3.00-3.05: nearer end
  assert.strictEqual(O.snapToTick(3.03), 3.05);
  assert.strictEqual(O.snapToTick(3.04), 3.05);
  assert.strictEqual(O.snapToTick(2.01), 2.0);    // gap tie snaps down
  assert.strictEqual(O.snapToTick(10.2), 10.0);   // gap 10.0-10.5: nearer end
  assert.strictEqual(O.snapToTick(10.3), 10.5);   // gap 10.0-10.5: nearer end
  assert.strictEqual(O.snapToTick(100.01), 100.0);
  assert.strictEqual(O.snapToTick(105.5), 110.0); // gap 100-110: nearer end
});

// T3: clamps to the ladder extremes.
check('T3 clamping', async () => {
  assert.strictEqual(O.snapToTick(0.5), 1.01);
  assert.strictEqual(O.snapToTick(5000), 1000);
  assert.strictEqual(O.snapToTick(-3), 1.01);
  assert.strictEqual(O.nextTick(1000), 1000);
  assert.strictEqual(O.prevTick(1.01), 1.01);
});

// T4: next/prev walk band boundaries exactly (2.0→2.02, 10.0→10.5, 100→110...).
check('T4 nextTick/prevTick across bands', async () => {
  assert.strictEqual(O.nextTick(1.01), 1.02);
  assert.strictEqual(O.nextTick(2.0), 2.02);
  assert.strictEqual(O.prevTick(2.02), 2.0);
  assert.strictEqual(O.nextTick(3.0), 3.05);
  assert.strictEqual(O.prevTick(3.05), 3.0);
  assert.strictEqual(O.nextTick(6.0), 6.2);
  assert.strictEqual(O.prevTick(6.2), 6.0);
  assert.strictEqual(O.nextTick(10.0), 10.5);
  assert.strictEqual(O.prevTick(10.5), 10.0);
  assert.strictEqual(O.nextTick(20.0), 21.0);
  assert.strictEqual(O.prevTick(21.0), 20.0);
  assert.strictEqual(O.nextTick(30.0), 32.0);
  assert.strictEqual(O.prevTick(32.0), 30.0);
  assert.strictEqual(O.nextTick(50.0), 55.0);
  assert.strictEqual(O.prevTick(55.0), 50.0);
  assert.strictEqual(O.nextTick(100.0), 110.0);
  assert.strictEqual(O.prevTick(110.0), 100.0);
  assert.strictEqual(O.nextTick(2.5), 2.52);
  assert.strictEqual(O.prevTick(2.52), 2.5);
  assert.strictEqual(O.nextTick(1.5), 1.51);
  assert.strictEqual(O.prevTick(1.5), 1.49);
});

// T5: American conversion.
check('T5 toAmerican', async () => {
  assert.strictEqual(O.toAmerican(2.5), '+150');
  assert.strictEqual(O.toAmerican(1.5), '-200');
  assert.strictEqual(O.toAmerican(3.0), '+200');
  assert.strictEqual(O.toAmerican(1.25), '-400');
  assert.strictEqual(O.toAmerican(10.0), '+900');
  assert.strictEqual(O.toAmerican(1.01), '-10000');
  assert.strictEqual(O.toAmerican(1.0), null);
  assert.strictEqual(O.toAmerican(0.5), null);
});

// T6: fractional conversion (reduced, denominator ≤ 50).
check('T6 toFractional', async () => {
  assert.strictEqual(O.toFractional(2.5), '3/2');
  assert.strictEqual(O.toFractional(3.0), '2/1');
  assert.strictEqual(O.toFractional(1.5), '1/2');
  assert.strictEqual(O.toFractional(2.0), '1/1');
  assert.strictEqual(O.toFractional(1.83), '5/6');
  assert.strictEqual(O.toFractional(1.2), '1/5');
  assert.strictEqual(O.toFractional(1.05), '1/20');
  assert.strictEqual(O.toFractional(1.01), '1/50');
  // Sub-tick prices (1 < p < 1.01) label as the bottom tick's fraction —
  // never the flatly wrong '1/1' this used to return.
  assert.strictEqual(O.toFractional(1.005), '1/50');
  assert.strictEqual(O.toFractional(1.0099), '1/50');
  assert.strictEqual(O.toFractional(6.0), '5/1');
  assert.strictEqual(O.toFractional(4.0), '3/1');
  assert.strictEqual(O.toFractional(1.0), null);
});

// T7: implied probability.
check('T7 impliedProb', async () => {
  assert.strictEqual(O.impliedProb(2.0), 0.5);
  assert.strictEqual(O.impliedProb(4.0), 0.25);
  assert.ok(near(O.impliedProb(1.25), 0.8));
  // Guards: zero/negative/non-finite input has no implied probability —
  // fail fast rather than answering Infinity/-x/NaN.
  assert.throws(() => O.impliedProb(0), /finite number > 0/);
  assert.throws(() => O.impliedProb(-2), /finite number > 0/);
  assert.throws(() => O.impliedProb(NaN), /finite number > 0/);
  assert.throws(() => O.impliedProb(Infinity), /finite number > 0/);
  assert.throws(() => O.impliedProb('2'), /finite number > 0/); // no coercion
});

// T8: overround (book margin).
check('T8 overround', async () => {
  assert.ok(near(O.overround([2.0, 3.0, 4.0]), 1 / 12));
  assert.ok(near(O.overround([2.5, 3.4, 2.9]), 0.0389, 1e-3)); // ~3.9% book
  assert.ok(near(O.overround([2.0, 2.0]), 0)); // fair two-way
  assert.ok(O.overround([1.01, 1.01]) > 0.9);
  // Guards: an empty book is an error, not a "-1" that reads as free money;
  // each price is validated through impliedProb's contract.
  assert.throws(() => O.overround([]), /non-empty array/);
  assert.throws(() => O.overround('nope'), /non-empty array/);
  assert.throws(() => O.overround([2.0, 0]), /impliedProb/);
  assert.throws(() => O.overround([2.0, -1]), /impliedProb/);
});

// T9: validTick discriminator.
//
// T9b below is the part this check was MISSING, and it is why the whole test
// passed against a function that accepts 1,400 off-ladder prices. Every case
// here is a two-decimal price, and at two decimals `priceToCents`' rounding is
// a no-op — so the test exercised the function only where it cannot fail.
// (#86)
check('T9 validTick', async () => {
  assert.strictEqual(O.validTick(2.02), true);
  assert.strictEqual(O.validTick(1.01), true);
  assert.strictEqual(O.validTick(2.01), false);
  assert.strictEqual(O.validTick(3.03), false);
  assert.strictEqual(O.validTick(0.5), false);
  assert.strictEqual(O.validTick(1000.01), false);
  assert.strictEqual(O.validTick(1000), true);
});

// T9b: validTick must mean EXACTLY on the ladder, at any precision.
//
// The bug: validTick did `priceToCents(p)` and then a grid test. priceToCents
// ROUNDS, so any price within half a cent of a tick satisfied the grid test and
// was reported as an exact tick. The Python port in the datafeed repo fixed
// precisely this and documented why — see
// OpenBettingExchangeDataFeed/betfeed/odds.py:145 — naming 1.015, 2.015 and
// 1.999 as the values that wrongly passed. These are those values.
//
// These are the three the Python docstring measured True for. If this check ever
// passes without the epsilon fix, the JS and the Python have diverged again.
check('T9b validTick is EXACT, not within-half-a-cent', async () => {
  const notTicks = [1.015, 2.015, 1.999, 2.401, 2.4025, 1.011, 3.334];
  for (const p of notTicks) {
    assert.strictEqual(
      O.validTick(p),
      false,
      `validTick(${p}) is true, but ${p} is not a price the ladder quotes — ` +
        'it is within half a cent of one, and "exactly on the ladder" means exactly',
    );
  }
  // The mirror: every REAL tick at three-decimal precision is still accepted, so
  // the fix does not become "reject anything with a decimal in it".
  for (const p of [1.01, 1.02, 2.02, 2.4, 3.0, 1000, 1.5]) {
    assert.strictEqual(
      O.validTick(p),
      true,
      `validTick(${p}) is false, but ${p} IS a ladder tick — the exactness fix over-rejected`,
    );
  }
});

// T9c: float noise must NOT be treated as inexactness.
//
// The fix rejects a price whose scaled value is not a whole number of cents.
// But 2.3 * 100 is 229.99999999999997, so a naive `scaled % 1 === 0` would
// reject a genuine tick. This is the reason the rule is "round, then require the
// input to HAVE BEEN that whole number within an epsilon" rather than a
// divisibility test. Without this case a correct fix reads as a broken one.
check('T9c float noise on a real tick is still a tick', async () => {
  for (const p of [2.3, 1.7, 0.1 + 1.01, 4.2, 2.1 + 0.2, 1.01 * 3]) {
    // Only assert where the value IS a ladder tick, checked independently of
    // validTick via snapToTick — otherwise this asserts validTick against itself.
    const snapped = O.snapToTick(p);
    if (Math.abs(snapped - p) > 1e-9) continue; // not a tick; T9b's business
    assert.strictEqual(
      O.validTick(p),
      true,
      `validTick(${p}) is false but it is a ladder tick — float noise was treated as inexactness`,
    );
  }
});

// T10: next/prev never leave the ladder range for arbitrary inputs.
check('T10 range safety', async () => {
  for (let c = 50; c <= 100200; c += 137) {
    const p = O.snapToTick(c / 100);
    assert.ok(p >= 1.01 && p <= 1000, `range at ${c}`);
    assert.strictEqual(O.validTick(p), true, `valid at ${c}`);
  }
});

// T11: snapToTick fails fast on non-finite / non-number input instead of
// silently mapping garbage to 1.01 (the cheapest price on the board). Finite
// out-of-range values still CLAMP — that documented ladder behaviour is
// distinct from garbage and stays pinned by T3 (-3 → 1.01, 5000 → 1000).
check('T11 snapToTick throws on non-finite input', async () => {
  for (const bad of [NaN, Infinity, -Infinity, '2.5', null, undefined]) {
    assert.throws(() => O.snapToTick(bad), /finite number/, `snapToTick(${String(bad)})`);
  }
});

// T12: inLadderRange asks "is this number a price at all", which is strictly
// weaker than validTick's "is this exactly a tick".
//
// The distinction is the whole point of #37 and it is easy to collapse by
// accident, so both directions are asserted: an off-tick price INSIDE the range
// is accepted (the desk's fair-price helper must still be able to snap a
// hand-typed 2.75), and a price outside it is refused (it is not a near-miss, it
// is not a price). The two ends of the ladder are inside by definition.
check('T12 inLadderRange separates "off-tick" from "not a price"', async () => {
  // Every valid tick is in range — validTick implies inLadderRange.
  for (const band of O.LADDER) {
    for (let c = band.lo; c <= band.hi; c += band.step) {
      assert.strictEqual(O.inLadderRange(c / 100), true, `tick ${c / 100} is in range`);
    }
  }
  // Off-tick but inside: accepted by inLadderRange, rejected by validTick.
  // This is the assertion that keeps the two from being the same function.
  // Every value here is unambiguous under priceToCents' rounding; 1.005 is NOT
  // used because 1.005 * 100 is 100.49999… and rounds DOWN to 1.00, which is
  // below the floor — a float artefact, not a ladder fact.
  for (const offTick of [1.99, 2.01, 2.74, 2.75, 3.02, 3.04, 10.2, 100.5]) {
    assert.strictEqual(O.inLadderRange(offTick), true, `${offTick} is inside the ladder`);
  }
  for (const offTick of [2.01, 2.75, 3.02, 3.04, 10.2, 100.5]) {
    assert.strictEqual(O.validTick(offTick), false, `${offTick} is genuinely off-tick`);
  }
  // Outside: refused by BOTH, which is what lets the route rely on it.
  for (const out of [0, 0.5, 1, 1.005, -5, 1000.01, 5000, 99999]) {
    assert.strictEqual(O.inLadderRange(out), false, `${out} is outside the ladder`);
  }
  // The exported decimal bounds agree with the cents constants they came from.
  assert.strictEqual(O.MIN_PRICE, 1.01);
  assert.strictEqual(O.MAX_PRICE, 1000);
  assert.strictEqual(O.inLadderRange(O.MIN_PRICE), true, 'the floor is in range');
  assert.strictEqual(O.inLadderRange(O.MAX_PRICE), true, 'the ceiling is in range');
});

(async () => {
  // Drain the collected checks IN ORDER, awaiting each. A check that rejects
  // is a failure of this suite, not of the next file: exiting here stops
  // the rest of this suite running rather than letting a broken assertion
  // print a green line for a body that never completed.
  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (e) {
      console.error(`  FAIL ${name}`);
      console.error(e);
      process.exit(1);
    }
    passed++;
    console.log('  ok', name);
  }
  console.log(`\nodds.test.js: ${passed} checks passed`);
})();
