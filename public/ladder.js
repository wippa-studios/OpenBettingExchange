// ladder.js — the client-side tick ladder, in integer price-cents.
//
// Extracted from app.js so the browser and lib/odds.js share ONE table:
// tests/ladder_parity.test.js requires this file and asserts the bands and
// the snap/step maths are exactly the server's. Drift here would make the
// slip's stepper disagree with the engine on every click.
//
// Zero-build constraint: classic <script src="/ladder.js">, NOT a module. It
// publishes window.OBLadder for app.js and, when required under Node (the
// parity test), exports the same object via module.exports. No bundler.
(function (root) {
  'use strict';

  // Betfair classic tick table, in integer price-cents (1.01 → 101).
  // MUST stay identical to LADDER in lib/odds.js — the parity test enforces it.
  const LADDER = [
    { lo: 101, hi: 200, step: 1 },         // 1.01-2.00 step 0.01
    { lo: 202, hi: 300, step: 2 },         // 2.02-3.00 step 0.02
    { lo: 305, hi: 400, step: 5 },         // 3.05-4.00 step 0.05
    { lo: 410, hi: 600, step: 10 },        // 4.10-6.00 step 0.10
    { lo: 620, hi: 1000, step: 20 },       // 6.20-10.0 step 0.20
    { lo: 1050, hi: 2000, step: 50 },      // 10.5-20   step 0.5
    { lo: 2100, hi: 3000, step: 100 },     // 21-30     step 1
    { lo: 3200, hi: 5000, step: 200 },     // 32-50     step 2
    { lo: 5500, hi: 10000, step: 500 },    // 55-100    step 5
    { lo: 11000, hi: 100000, step: 1000 }, // 110-1000  step 10
  ];

  const MIN_CENTS = 101;    // 1.01
  const MAX_CENTS = 100000; // 1000.0

  // Decimal price → integer cents. Non-finite input is a caller bug (the slip
  // validates before calling): fail loudly, never invent a price.
  function priceToCents(p) {
    if (!Number.isFinite(p)) throw new TypeError('price must be a finite number');
    return Math.round(p * 100);
  }

  // Integer cents ≤ 100000 divided by 100 give the same double as the 2dp literal.
  const centsToPrice = (c) => c / 100;

  function bandFor(cents) {
    for (const band of LADDER) {
      if (cents >= band.lo && cents <= band.hi) return band;
    }
    return null;
  }

  // Clamp to [1.01, 1000] and round to the nearest valid tick. Mirror of the
  // server's snapToTick (lib/odds.js): prices in band gaps snap to the nearer
  // end, ties snap down.
  function snapCents(c) {
    if (c < MIN_CENTS) c = MIN_CENTS;
    if (c > MAX_CENTS) c = MAX_CENTS;
    const band = bandFor(c);
    if (band) {
      const maxIdx = Math.round((band.hi - band.lo) / band.step);
      let idx = Math.round((c - band.lo) / band.step);
      if (idx < 0) idx = 0;
      if (idx > maxIdx) idx = maxIdx;
      return band.lo + idx * band.step;
    }
    let below = null;
    let above = null;
    for (const b of LADDER) {
      if (b.hi < c) below = b.hi;
      if (above === null && b.lo > c) above = b.lo;
    }
    if (below === null) return MIN_CENTS;
    if (above === null) return MAX_CENTS;
    return c - below <= above - c ? below : above;
  }

  function snapPrice(p) {
    return centsToPrice(snapCents(priceToCents(p)));
  }

  // One tick up (+1) or down (−1) from a snapped price, crossing band edges
  // exactly the way the server's nextTick/prevTick do.
  function stepPrice(p, dir) {
    const c = snapCents(priceToCents(p));
    const band = bandFor(c);
    if (!band) return centsToPrice(dir > 0 ? MAX_CENTS : MIN_CENTS);
    const maxIdx = Math.round((band.hi - band.lo) / band.step);
    const idx = Math.round((c - band.lo) / band.step);
    if (dir > 0) {
      if (idx < maxIdx) return centsToPrice(c + band.step);
      const bIdx = LADDER.indexOf(band);
      return centsToPrice(bIdx === LADDER.length - 1 ? MAX_CENTS : LADDER[bIdx + 1].lo);
    }
    if (idx > 0) return centsToPrice(c - band.step);
    const bIdx = LADDER.indexOf(band);
    return centsToPrice(bIdx === 0 ? MIN_CENTS : LADDER[bIdx - 1].hi);
  }

  // Money boundary: (price − 1) × stake with ONE rounding at the end, computed
  // in integer price-cents so the slip preview can never differ from the
  // engine's cents-domain accounting by a float artefact. Back profit and lay
  // liability are the same formula.
  function exposureCents(price, stakeCents) {
    return Math.round(((priceToCents(price) - 100) * stakeCents) / 100);
  }

  const api = {
    LADDER,
    MIN_CENTS,
    MAX_CENTS,
    priceToCents,
    centsToPrice,
    snapCents,
    snapPrice,
    stepPrice,
    exposureCents,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node: parity test
  else root.OBLadder = api; // Browser: app.js reads window.OBLadder
})(typeof window !== 'undefined' ? window : globalThis);
