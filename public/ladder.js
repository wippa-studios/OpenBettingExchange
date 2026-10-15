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

  // ── The matched column (#93) ──────────────────────────────────────────────
  //
  // Betfair's ladder shows, at every level, BOTH the unmatched size available
  // to take and the volume already matched there. This board showed only the
  // first, because there was no query for the second anywhere in the codebase.
  // There is one now (lib/marketdata.js), and the pure half of rendering it
  // lives HERE rather than in board.js for one reason: this file is
  // require()able under Node, so tests/ladder_parity.test.js can assert the
  // column's arithmetic and its grid contract against the real code. A column
  // whose correctness can only be checked in a browser is a column nobody
  // checks.
  //
  // LADDER_COLUMNS is the grid's shape, stated once. style.css's `.lrow`
  // template is `1 runner + 3 back + 3 lay`; the matched figure rides INSIDE
  // each price cell rather than becoming an eighth column, and this constant is
  // what proves the two cannot drift. See style.css for why it has to stay
  // seven at the 570px floor (#136).
  const LADDER_COLUMNS = { runner: 1, back: 3, lay: 3 };
  const LADDER_COLUMN_COUNT = LADDER_COLUMNS.runner + LADDER_COLUMNS.back + LADDER_COLUMNS.lay;

  // The window the matched figure covers, as the client states it in the cell's
  // tooltip. It MUST equal lib/marketdata.js's DEFAULT_WINDOW_MINUTES, and
  // tests/ladder_parity.test.js pins that — the same job this file already does
  // for the tick table. A tooltip that says "last 10 minutes" beside a figure
  // computed over 30 is a lie told by the interface, and nothing else in the
  // repo would catch it.
  const MATCHED_WINDOW_MINUTES = 10;

  // Normalise one level into the three figures a cell renders.
  //
  // `matched_cents` is ABSENT on a payload from before #93, and absent means
  // zero — never `undefined`, and never the unmatched size reused as a
  // fallback. Defaulting to the size would put a matched figure on every level
  // of a market where nothing has traded, which is the one thing worse than a
  // missing column.
  function levelFigures(level) {
    const lv = level || {};
    const matched = Number(lv.matched_cents);
    const fills = Number(lv.matched_fills);
    return {
      price: lv.price == null ? null : lv.price,
      // `size_cents` is the UNMATCHED size: what is still available to take.
      unmatched_cents: Math.max(0, Math.round(Number(lv.size_cents) || 0)),
      matched_cents: Number.isFinite(matched) && matched > 0 ? Math.round(matched) : 0,
      matched_fills: Number.isFinite(fills) && fills > 0 ? Math.round(fills) : 0,
    };
  }

  // The bar's share of the cell, 0–1: matched volume as a proportion of what
  // has traded at this level plus what is still available there. A trader's eye
  // reads "how much of this price is done" before it reads either number.
  //
  // `null` only when the level is EMPTY — no matched and no unmatched volume —
  // because there is then nothing to be a proportion of. A level with liquidity
  // and no trading in it reads 0, which is the answer rather than the absence
  // of one.
  function matchedShare(level) {
    const f = levelFigures(level);
    const total = f.matched_cents + f.unmatched_cents;
    return total > 0 ? f.matched_cents / total : null;
  }

  // The matched column's MARKUP, as the three fragments a price cell renders.
  //
  // Here rather than in board.js for the same reason levelFigures is: this file
  // is require()able under Node, so tests/ladder_parity.test.js asserts the exact
  // strings the ladder ships — that the figure and the bar are PRESENT when
  // something traded and BOTH ABSENT when nothing did. Asserting that through
  // board.js is impossible, and an untestable column is the reason columns go
  // stale.
  //
  // `fmt` is passed in rather than imported so this file keeps no money-formatting
  // policy of its own: the board's formatter is the only one the venue has.
  function matchedCellParts(level, fmt) {
    const f = levelFigures(level);
    const share = matchedShare(level);
    const money = fmt || String;
    return {
      figures: f,
      // No FIGURE when nothing traded at this level: "$0.00 matched" printed on
      // every level of a quiet market is a row of zeros that reads as a broken
      // counter, which is the same objection board.js raises about
      // `$0.00 matched` in a market header.
      //
      // The BAR is still drawn at 0% when the level has unmatched size — a
      // level with $5 available and nothing traded on it IS 0% done, and saying
      // so beats leaving the row a different height. A level with neither has no
      // bar, because there is nothing there to be a proportion OF.
      matchedRow: f.matched_cents
        ? `<span class="mv tn" title="${money(f.matched_cents)} matched across ${f.matched_fills} fill` +
          `${f.matched_fills === 1 ? '' : 's'} in the last ${MATCHED_WINDOW_MINUTES} minutes">` +
          `${money(f.matched_cents)}</span>`
        : '',
      bar: share == null
        ? ''
        : `<span class="mbar" aria-hidden="true"><span class="mfill" style="width:${Math.round(
            share * 100
          )}%"></span></span>`,
      // Appended to the cell's accessible label, which leads with the unmatched
      // size because that is what pressing the button acts on.
      labelSuffix: f.matched_cents ? `, ${money(f.matched_cents)} matched` : '',
    };
  }

  const api = {
    LADDER,
    LADDER_COLUMNS,
    LADDER_COLUMN_COUNT,
    MATCHED_WINDOW_MINUTES,
    MIN_CENTS,
    MAX_CENTS,
    priceToCents,
    centsToPrice,
    snapCents,
    snapPrice,
    stepPrice,
    exposureCents,
    levelFigures,
    matchedCellParts,
    matchedShare,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node: parity test
  else root.OBLadder = api; // Browser: js/core.js reads window.OBLadder
})(typeof window !== 'undefined' ? window : globalThis);
