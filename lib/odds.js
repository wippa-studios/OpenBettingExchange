'use strict';
// lib/odds.js — Betfair-style tick ladder + odds format conversions.
// Pure functions, no I/O. Prices are decimal odds (2dp); handled in integer
// cents internally so band arithmetic never sees float drift.
//
// Ladder (Betfair classic):
//   1.01-2.00 step .01 | 2.02-3.00 step .02 | 3.05-4.00 step .05
//   4.10-6.00 step .10 | 6.20-10.0 step .20 | 10.5-20   step .5
//   21-30  step 1 | 32-50 step 2 | 55-100 step 5 | 110-1000 step 10

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

const MIN_PRICE_CENTS = 101; // 1.01
const MAX_PRICE_CENTS = 100000; // 1000.0
// The same bounds in decimal, for callers that must REJECT an out-of-range
// price before snapping rather than accept whatever the clamp returns.
const MIN_PRICE = MIN_PRICE_CENTS / 100;
const MAX_PRICE = MAX_PRICE_CENTS / 100;

function priceToCents(p) {
  return Math.round(Number(p) * 100);
}

// Integer cents ≤ 100000 divided by 100 give the same double as the 2dp literal.
function centsToPrice(c) {
  return c / 100;
}

// Both are EXPORTED, and lib/userrules.js is why (#76): a rule's condition is a
// strict comparison of two prices, and doing it in doubles would leave "is 2.00
// strictly below 2.00" answering differently depending on which side of the
// representation boundary each value fell. In cents the comparison is total.
// They were module-private for years with exactly one caller (snapToTick) and
// no need of anyone else; a rules engine comparing prices is that someone else.

function bandFor(cents) {
  for (const band of LADDER) {
    if (cents >= band.lo && cents <= band.hi) return band;
  }
  return null;
}

// Clamp to [1.01, 1000] and round to the nearest valid ladder tick. Prices in
// the gaps between bands snap to the nearer end (ties snap down).
//
// THROWS on non-number / non-finite input (fail-fast, house style): garbage
// used to clamp silently to 1.01 — the cheapest price on the board — so a
// NaN slipping past a caller looked like a real quote. The API boundaries
// validate before calling: match.js validateOrder checks the type and
// `inLadderRange`, and the /api/format route checks the range, so a throw here
// means an internal caller passed an unvalidated value.
//
// It still CLAMPS an out-of-range number rather than refusing one, and that is
// deliberate for the trading path: a near-miss price should still trade, and
// `POST /api/orders` documents that it is corrected rather than rejected. A
// caller that must not have its question answered with a different price calls
// `inLadderRange` first — see that function's note and #37.
function snapToTick(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) {
    throw new Error(`snapToTick: price must be a finite number (got ${String(p)})`);
  }
  let c = priceToCents(p);
  if (c < MIN_PRICE_CENTS) c = MIN_PRICE_CENTS;
  if (c > MAX_PRICE_CENTS) c = MAX_PRICE_CENTS;
  const band = bandFor(c);
  if (band) {
    const maxIdx = Math.round((band.hi - band.lo) / band.step);
    let idx = Math.round((c - band.lo) / band.step);
    if (idx < 0) idx = 0;
    if (idx > maxIdx) idx = maxIdx;
    return centsToPrice(band.lo + idx * band.step);
  }
  let below = null;
  let above = null;
  for (const b of LADDER) {
    if (b.hi < c) below = b.hi;
    if (above === null && b.lo > c) above = b.lo;
  }
  if (below === null) return centsToPrice(MIN_PRICE_CENTS);
  if (above === null) return centsToPrice(MAX_PRICE_CENTS);
  return centsToPrice((c - below) <= (above - c) ? below : above);
}

function nextTick(p) {
  const c = priceToCents(snapToTick(p));
  const band = bandFor(c);
  if (!band) return centsToPrice(MAX_PRICE_CENTS);
  const maxIdx = Math.round((band.hi - band.lo) / band.step);
  const idx = Math.round((c - band.lo) / band.step);
  if (idx < maxIdx) return centsToPrice(c + band.step);
  const bIdx = LADDER.indexOf(band);
  if (bIdx === LADDER.length - 1) return centsToPrice(MAX_PRICE_CENTS); // clamp at 1000
  return centsToPrice(LADDER[bIdx + 1].lo);
}

function prevTick(p) {
  const c = priceToCents(snapToTick(p));
  const band = bandFor(c);
  if (!band) return centsToPrice(MIN_PRICE_CENTS);
  const idx = Math.round((c - band.lo) / band.step);
  if (idx > 0) return centsToPrice(c - band.step);
  const bIdx = LADDER.indexOf(band);
  if (bIdx === 0) return centsToPrice(MIN_PRICE_CENTS); // clamp at 1.01
  return centsToPrice(LADDER[bIdx - 1].hi);
}

// Is p EXACTLY on the ladder?
//
// "Exactly" is the whole job, and this function used to get it wrong (#86). It
// was `priceToCents(p)` followed by a grid test — and `priceToCents` ROUNDS, so
// every price within half a cent of a tick satisfied the grid test and came back
// true. `1.015`, `2.015` and `1.999` all reported as exact ticks. Measured: 1,400
// off-ladder prices accepted across `[1.01, 1000]`.
//
// It went unnoticed because at two decimal places the rounding is a no-op, so
// every two-decimal price behaved correctly — and the test that covered it only
// used two-decimal prices. The defect was reachable only at three decimals or
// more, which is precisely the precision an incoming feed or a typed price
// carries.
//
// The rule is therefore "round, THEN require the input to HAVE BEEN that whole
// number of cents" — not a divisibility test. A divisibility test would reject
// `2.3`, because `2.3 * 100` is `229.99999999999997`, and would then be right
// about inexactness while wrong about float noise. The epsilon absorbs the
// representation and nothing else.
//
// This mirrors `OpenBettingExchangeDataFeed/betfeed/odds.py:145`, which fixed the
// same bug in the Python port and documented the three values that gave it away.
// Keep the two in step: the JS was the pre-fix original, and drifting apart is
// how this got missed the first time.
//
// Note this is a VALIDATOR, and nothing in the money path calls it —
// `snapToTick` is what `lib/match.js` uses, and snapping is the correct
// behaviour there: an off-ladder price should be rounded to one, not rejected.
// This exists for the caller that must refuse, which is a feed adapter
// returning a price it could not put on the ladder.
const CENT_EXACTNESS_EPSILON = 1e-6;

function validTick(p) {
  const value = Number(p);
  if (!Number.isFinite(value)) return false;
  const scaled = value * 100;
  const c = Math.round(scaled);
  // Within half a cent of a whole cent is NOT a price the ladder quotes. This is
  // the line the old version was missing.
  if (Math.abs(scaled - c) > CENT_EXACTNESS_EPSILON) return false;
  if (c < MIN_PRICE_CENTS || c > MAX_PRICE_CENTS) return false;
  const band = bandFor(c);
  if (!band) return false;
  return (c - band.lo) % band.step === 0;
}

/**
 * Is p INSIDE the ladder's range at all — `[1.01, 1000]` — tick or not?
 *
 * The distinction from `validTick` is the point, and a caller that needs one does
 * not want the other. `validTick` asks "is this exactly a price the engine will
 * accept", so it rejects `2.75` (in range, between ticks). This asks the much
 * weaker question, and the only one a QUERY can usefully ask: "is this number a
 * price at all".
 *
 * It exists because `snapToTick` CLAMPS. A caller that hands `snapToTick(5000)`
 * gets back `1000` with no indication that anything was wrong, and a validation
 * endpoint that answers a confident "yes, 1000 is fine" to a caller who asked
 * whether 5000 is a price is answering a question nobody asked. `POST
 * /api/orders` wants that clamp — a near-miss price there should still trade —
 * so it is kept. `GET /api/format/:price` does not, and calls this first.
 */
function inLadderRange(p) {
  const c = priceToCents(p);
  return c >= MIN_PRICE_CENTS && c <= MAX_PRICE_CENTS;
}

// Decimal → American ("+150" / "-200"); null for odds ≤ 1.
function toAmerican(p) {
  if (!(Number(p) > 1)) return null;
  if (p >= 2) return '+' + Math.round((p - 1) * 100);
  return '-' + Math.round(100 / (p - 1));
}

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

// Decimal → reduced fractional ("3/2"); approximate with denominator ≤ 50
// (documented approximation for extreme prices). Among near-best
// approximations the simplest fraction wins (bookmaker convention: 5/6 over
// 39/47 for 1.83). Null for odds ≤ 1.
function toFractional(p) {
  if (!(Number(p) > 1)) return null;
  const target = p - 1;
  const candidates = [];
  for (let d = 1; d <= 50; d++) {
    const n = Math.round(target * d);
    if (n === 0) continue; // never collapse a real price to "0/1"
    candidates.push({ n, d, err: Math.abs(target - n / d) });
  }
  // Sub-tick prices (1 < p < 1.01) admit no n/d with d ≤ 50 and n ≥ 1, so
  // candidates is empty exactly there. Label them as the ladder's bottom
  // tick 1.01 = '1/50' — the price snapToTick clamps them to — instead of
  // the flatly wrong '1/1' (even money) this used to return.
  if (!candidates.length) return '1/50';
  let bestErr = Infinity;
  for (const c of candidates) {
    if (c.err < bestErr) bestErr = c.err;
  }
  const EPS = 1e-9;
  const exact = candidates.filter((c) => c.err <= EPS);
  let pick;
  if (exact.length) {
    // An exact fraction exists (e.g. 1.05 = 1/20) — smallest denominator wins.
    pick = exact.reduce((m, c) => (c.d < m.d ? c : m), exact[0]);
  } else {
    const tol = 0.005; // near-best tolerance for the simplicity preference
    const eligible = candidates.filter((c) => c.err <= bestErr + tol);
    pick = eligible.reduce((m, c) => (c.d < m.d ? c : m), eligible[0]);
  }
  const g = gcd(pick.n, pick.d) || 1;
  return `${pick.n / g}/${pick.d / g}`;
}

// Implied probability of a decimal price. Fail-fast: a price of 0 or less, or
// anything non-finite/non-number, has no implied probability — this used to
// answer Infinity / a negative / NaN silently. Callers at the API boundary
// validate first; a throw here means an internal caller passed garbage.
function impliedProb(p) {
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) {
    throw new Error(`impliedProb: price must be a finite number > 0 (got ${String(p)})`);
  }
  return 1 / p;
}

// Overround (book margin) of a set of decimal prices: Σ(1/pᵢ) − 1.
// An empty (or non-array) book has no margin to express: it used to answer
// -1, i.e. "a 100% underround" — free money. THROW instead. Each price is
// checked through impliedProb's contract, so a bad element names the
// violated rule.
function overround(prices) {
  if (!Array.isArray(prices) || prices.length === 0) {
    throw new Error('overround: a non-empty array of prices is required');
  }
  let s = 0;
  for (const p of prices) s += impliedProb(p);
  return s - 1;
}

module.exports = {
  LADDER,
  MIN_PRICE,
  MAX_PRICE,
  MIN_PRICE_CENTS,
  MAX_PRICE_CENTS,
  priceToCents,
  centsToPrice,
  snapToTick,
  nextTick,
  prevTick,
  validTick,
  inLadderRange,
  toAmerican,
  toFractional,
  impliedProb,
  overround,
};
