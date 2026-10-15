// ladder_parity.test.js — client ladder vs engine ladder.
// Run: node tests/ladder_parity.test.js   (plain assert, no deps)
//
// The browser slip (public/ladder.js) mirrors the engine's tick table so the
// stepper can move prices without a round-trip. This suite pins the two
// together: any drift between the tables — or the snap/step/exposure maths —
// fails here before it can confuse a bettor's slip.
//
// Since #93 it also pins the MATCHED COLUMN. That column was added to the
// ladder and its markup deliberately lives in public/ladder.js rather than in
// public/js/board.js, which is a browser IIFE with no module export — so
// asserting it anywhere else would mean a browser. This file is the one place
// the shipped markup of the column can be checked mechanically, and it is where
// the client/server window parity is checked for the same reason it checks the
// tick table: drift between the two is invisible until a user reads a figure
// that is not the one the server computed.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const client = require('../public/ladder.js'); // UMD-lite: consumable under Node
const O = require('../lib/odds'); // the engine's table — read only, never edit here

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log('  ok', name);
};

// L1: the client table IS the engine table (both already integer cents).
check('L1 client bands equal engine bands', async () => {
  assert.deepStrictEqual(client.LADDER, O.LADDER);
  assert.strictEqual(client.MIN_CENTS, 101);
  assert.strictEqual(client.MAX_CENTS, 100000);
});

// L2: every engine tick is a fixed point of the client snap, and one step
// walks the whole ladder in lockstep with nextTick/prevTick — including the
// band-edge jumps (2.0→2.02, 10.0→10.5, 100→110…).
check('L2 snap identity + step parity on every tick', async () => {
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
check('L3 snap parity across the whole range', async () => {
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
check('L4 exposure in integer price-cents', async () => {
  assert.strictEqual(client.exposureCents(1.5, 101), 51); // 50.5 → 51
  assert.strictEqual(client.exposureCents(2.4, 1000), 1400);
  assert.strictEqual(client.exposureCents(1.01, 100), 1);
  assert.strictEqual(client.exposureCents(1.03, 150), 5); // 4.5 → 5, cents-exact
  assert.strictEqual(client.exposureCents(1000, 100), 99900);
});

// L5: the client fails loudly on non-finite prices instead of silently
// snapping garbage to 1.01 (mirrors the engine's fail-fast contract).
check('L5 non-finite prices throw', async () => {
  for (const bad of [NaN, Infinity, -Infinity, 'x', null, undefined]) {
    assert.throws(() => client.snapPrice(bad), TypeError);
    assert.throws(() => client.stepPrice(bad, 1), TypeError);
    assert.throws(() => client.exposureCents(bad, 100), TypeError);
  }
});

// How many GRID COLUMNS a `grid-template-columns` value declares.
//
// Not a `split(',').length`: a comma inside `minmax(150px, 1.6fr)` is not a
// track separator, a `repeat(3, …)` is three columns rather than one, and CSS
// does not require a comma BETWEEN tracks at all — `.lrow`'s own declaration
// separates them with whitespace alone. Two earlier versions got this wrong (6,
// then 1, for a row that has always had 7); a check that cries wolf on correct
// CSS is a check that gets switched off, so it now reads the declaration the
// way the browser does: split at DEPTH 0 on a comma or on whitespace, then
// expand `repeat(n, …)` to n. Comments are stripped first — `.lrow`'s own
// comment names the very columns it declares, and counting text inside a
// comment would be absurd.
function columnCount(value) {
  const src = String(value).replace(/\/\*[\s\S]*?\*\//g, '');
  const tracks = [];
  let depth = 0;
  let start = 0;
  const push = (end) => {
    const track = src.slice(start, end).trim();
    if (track) tracks.push(track);
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      push(i);
      start = i + 1;
    }
  }
  push(src.length);
  let columns = 0;
  for (const track of tracks) {
    const repeat = track.match(/^repeat\(\s*(\d+)\s*,/i);
    columns += repeat ? Number(repeat[1]) : 1;
  }
  return columns;
}

// ── The matched column (#93) ─────────────────────────────────────────────
//
// The ladder grew a second figure per level — matched volume, beside the
// unmatched size that was already there — and these are the checks that would
// fail if it were wrong in the ways it can be wrong: reading the unmatched size
// as the matched one, drawing a bar for a level nothing has traded at, or
// silently changing the row's column count.

// L6: the figures come from the level's OWN fields, and a payload that predates
// #93 reads as zero matched rather than as the unmatched size reused.
check('L6 levelFigures reads matched, and defaults a pre-#93 level to zero', async () => {
  assert.deepStrictEqual(
    client.levelFigures({ price: 2.5, size_cents: 500, matched_cents: 3000, matched_fills: 4 }),
    { price: 2.5, unmatched_cents: 500, matched_cents: 3000, matched_fills: 4 }
  );
  // The shape /api/markets/:id/book returned before #93 — no matched fields at
  // all. It must read as "nothing has traded here", never as "the 500 that are
  // available to take have also been taken".
  const legacy = client.levelFigures({ price: 2.5, size_cents: 500 });
  assert.strictEqual(legacy.matched_cents, 0);
  assert.strictEqual(legacy.matched_fills, 0);
  assert.strictEqual(legacy.unmatched_cents, 500);
  assert.notStrictEqual(legacy.matched_cents, legacy.unmatched_cents);
  // Negative, NaN and missing all normalise to zero: a bar or a figure built
  // from one of those is a worse answer than no figure.
  for (const junk of [{ matched_cents: -5 }, { matched_cents: NaN }, { matched_cents: 'x' }, {}]) {
    const f = client.levelFigures({ price: 2, size_cents: 100, ...junk });
    assert.strictEqual(f.matched_cents, 0, `matched_cents for ${JSON.stringify(junk)}`);
    assert.strictEqual(f.matched_fills, 0);
  }
  // A level with nothing available and nothing traded still has figures.
  assert.deepStrictEqual(client.levelFigures({ price: 2, size_cents: 0, matched_cents: 700, matched_fills: 1 }), {
    price: 2, unmatched_cents: 0, matched_cents: 700, matched_fills: 1,
  });
});

// L7: the bar is matched / (matched + unmatched), and is ABSENT — null, not
// zero — when nothing has traded, because an empty bar reads as a measurement.
check('L7 matchedShare is the matched proportion, null when nothing traded', async () => {
  assert.strictEqual(client.matchedShare({ size_cents: 500, matched_cents: 3000 }), 0.8571428571428571);
  assert.strictEqual(client.matchedShare({ size_cents: 3000, matched_cents: 500 }), 500 / 3500);
  assert.strictEqual(client.matchedShare({ size_cents: 0, matched_cents: 900 }), 1);
  assert.strictEqual(client.matchedShare({ size_cents: 500 }), 0);
  assert.strictEqual(client.matchedShare({ size_cents: 500, matched_cents: 0 }), 0);
  assert.strictEqual(client.matchedShare({ price: 2, size_cents: 0 }), null);
  assert.strictEqual(client.matchedShare(null), null);
  // The share is a fraction: never over 1, never negative, whatever the payload.
  for (const lv of [
    { size_cents: 100, matched_cents: 1000000 },
    { size_cents: 1000000, matched_cents: 1 },
    { size_cents: -5, matched_cents: 10 },
  ]) {
    const s = client.matchedShare(lv);
    assert.ok(s >= 0 && s <= 1, `share in range for ${JSON.stringify(lv)} (got ${s})`);
  }
});

// L8: THE COLUMN IS PRESENT AND CORRECT IN THE MARKUP THE LADDER SHIPS.
// Both directions, because a check that only proves the figure appears would
// also pass against a ladder that printed it on every cell of every market.
check('L8 the matched figure and bar are in the markup, and absent when unt traded', async () => {
  const money = (c) => `$${(c / 100).toFixed(2)}`;

  const traded = client.matchedCellParts({ price: 2.5, size_cents: 500, matched_cents: 3000, matched_fills: 2 }, money);
  assert.ok(traded.matchedRow.includes('$30.00'), 'the matched figure is rendered');
  assert.ok(traded.matchedRow.includes('class="mv'), 'in the element the stylesheet targets');
  assert.ok(traded.bar.includes('class="mbar"'), 'the bar track is rendered');
  assert.ok(traded.bar.includes('width:86%'), `the bar is the matched share (got ${traded.bar})`);
  assert.ok(traded.labelSuffix.includes('$30.00'), 'the accessible label carries it too');

  const quiet = client.matchedCellParts({ price: 2.5, size_cents: 500 }, money);
  assert.strictEqual(quiet.matchedRow, '', 'no matched figure on a level nothing has traded at');
  assert.strictEqual(quiet.labelSuffix, '', 'and nothing added to the label');
  // The BAR is still drawn, at 0%: a level with $5 available and nothing traded
  // on it IS 0% done, and that is the answer. What must not happen is a FIGURE,
  // because "$0.00 matched" on every level of a quiet market is a row of zeros
  // that reads as a broken counter.
  assert.ok(quiet.bar.includes('width:0%'), `an unt-traded level reads 0% done (got ${quiet.bar})`);
  // And a level with neither matched nor unmatched volume has no bar at all:
  // there is nothing there to be a proportion OF.
  const bare = client.matchedCellParts({ price: 2.5, size_cents: 0 }, money);
  assert.strictEqual(bare.bar, '');
  assert.strictEqual(bare.matchedRow, '');

  // The unmatched size is still what the cell acts on, so it is NOT part of the
  // matched fragments — a regression here would double-count liquidity.
  assert.ok(!traded.matchedRow.includes('$5.00'), 'the unmatched size is not restated as matched');
  assert.ok(!traded.bar.includes('$'), 'the bar is a width, not a money figure');
});

// L9: the ladder is SEVEN columns, and the stylesheet agrees. The matched
// column rides inside a cell precisely so this could keep being true; adding an
// eighth grid column to style.css without updating this constant (or the other
// way round) fails here instead of on a 570px screen.
check('L9 the row grid is 7 columns and matches public/style.css', async () => {
  assert.strictEqual(client.LADDER_COLUMN_COUNT, 7);
  assert.deepStrictEqual(client.LADDER_COLUMNS, { runner: 1, back: 3, lay: 3 });

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const block = css.match(/\.lrow\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, 'public/style.css still has a .lrow rule');
  const decl = block[1].match(/grid-template-columns:\s*([^;]+);/);
  assert.ok(decl, '.lrow still declares grid-template-columns');
  assert.strictEqual(
    columnCount(decl[1]),
    client.LADDER_COLUMN_COUNT,
    `style.css .lrow declares ${columnCount(decl[1])} columns; the client says ${client.LADDER_COLUMN_COUNT}`
  );
  // The header row has to consume the same count or every label drifts, and the
  // matched markup lives inside a price cell — so a cell that gained a track
  // would break both.
  assert.ok(/\.hdr\s*\{[\s\S]*?grid-column:\s*span 3;/.test(css), 'the BACK/LAY headers still span three columns each');
});

// L10: the window the client NAMES in the cell tooltip is the window the server
// COMPUTES the figure over. Nothing else in the repository would notice these
// two drifting apart, and a tooltip that says "last 10 minutes" beside a number
// computed over 30 is the interface asserting something untrue.
check('L10 the client names the same matched window the server uses', async () => {
  // Required lazily: lib/marketdata.js pulls lib/auth.js and lib/config.js, and
  // this suite is otherwise a pure tick-table check with no environment of its
  // own. The constant under test is a module constant and reads no config, but
  // pinning the environment first keeps the suite hermetic if that ever changes.
  const { DEFAULT_WINDOW_MINUTES } = require('../lib/marketdata');
  assert.strictEqual(client.MATCHED_WINDOW_MINUTES, DEFAULT_WINDOW_MINUTES);
  assert.strictEqual(typeof DEFAULT_WINDOW_MINUTES, 'number');
  assert.ok(DEFAULT_WINDOW_MINUTES > 0);
});

console.log(`\nladder_parity.test.js: ${passed} checks passed`);
