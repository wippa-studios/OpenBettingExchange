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
  // The bar's WIDTH is an SVG geometry attribute, not an inline style: the venue
  // serves `style-src 'self'` with no 'unsafe-inline', so `style="width:N%"`
  // was blocked by the browser and the bar never drew. What is asserted here is
  // the VALUE — the matched share — and not the mechanism that carries it, so
  // the check reads whichever attribute is present rather than pinning the
  // markup. `tests/ui_test.mjs` is what pins the mechanism, by failing on an
  // uncaught page error if a future change puts an inline style back.
  const width = (traded.bar.match(/width[:=]\s*"?(\d+)/) || [])[1];
  assert.strictEqual(width, '86', `the bar is the matched share (got ${traded.bar})`);
  assert.ok(!/style="/.test(traded.bar), 'and the bar carries no inline style, which the CSP would block');
  assert.ok(traded.labelSuffix.includes('$30.00'), 'the accessible label carries it too');

  const quiet = client.matchedCellParts({ price: 2.5, size_cents: 500 }, money);
  assert.strictEqual(quiet.matchedRow, '', 'no matched figure on a level nothing has traded at');
  assert.strictEqual(quiet.labelSuffix, '', 'and nothing added to the label');
  // NO BAR EITHER, and that is the rule: a level with $5 available and nothing
  // traded on it IS 0% done, and 0% is a true answer that carries no information.
  // It was drawn before, and on the seeded board 198 of the 198 bars rendered
  // were 0% — bots quote every market and almost none had traded — which is
  // ~400 extra elements per board repaint every 15s saying nothing at all. The
  // bar is drawn where it has something to draw, exactly like the figure, so a
  // cell's two fragments agree instead of being able to drift apart.
  assert.strictEqual(quiet.bar, '', 'and no bar either: 0% is an answer with nothing in it');
  // PRE-STATE for the assertion above: the level is NOT empty, so this is a
  // decision about DRAWING, not about a missing size. A check that passed only
  // because `size_cents` was absent would pass against a bar that never renders.
  assert.strictEqual(client.matchedShare({ price: 2.5, size_cents: 500 }), 0,
    'the SHARE of an untraded level is still 0 — L7 owns that, and it is unchanged');
  assert.strictEqual(client.matchedCellParts({ price: 2.5, size_cents: 500 }, money).bar, '',
    'but a 0% bar is not drawn');
  // And a level with NEITHER is still nothing at all.
  const bare = client.matchedCellParts({ price: 2.5, size_cents: 0 }, money);
  assert.strictEqual(bare.bar, '');
  assert.strictEqual(bare.matchedRow, '');

  // The unmatched size is still what the cell acts on, so it is NOT part of the
  // matched fragments — a regression here would double-count liquidity.
  assert.ok(!traded.matchedRow.includes('$5.00'), 'the unmatched size is not restated as matched');
  assert.ok(!traded.bar.includes('$'), 'the bar is a width, not a money figure');
});

// L7b: the bar's width is a fraction of the cell's own volume, never a bad
// number. The DRAWING rule is pinned by L8; this is the arithmetic behind it, and
// it is checked separately so a NaN cannot hide behind an absent bar.
check('L7b every rendered bar width is a finite percentage', async () => {
  for (const lv of [
    { size_cents: 500, matched_cents: 1 },
    { size_cents: 1, matched_cents: 999999 },
    { size_cents: 1000000, matched_cents: 1 },
    { size_cents: 0, matched_cents: 900 },
    { size_cents: 500, matched_cents: 500 },
  ]) {
    const bar = client.matchedCellParts(lv, String).bar;
    // SVG, not a styled span: the strict `style-src 'self'` CSP blocks inline
    // style attributes, so the width is geometry. See L8 and public/ladder.js.
    assert.ok(/^<svg class="mbar"/.test(bar), `a traded level draws a bar (${JSON.stringify(lv)})`);
    const w = bar.match(/width="(\d+)"/);
    assert.ok(w, `the bar carries a width (got ${bar})`);
    const pct = Number(w[1]);
    assert.ok(Number.isInteger(pct) && pct >= 1 && pct <= 100, `width in 1..100 (got ${pct})`);
  }
  // And nothing traded never produces one, whatever the unmatched size is.
  for (const lv of [{}, { size_cents: 0 }, { size_cents: 500 }, { size_cents: 500, matched_cents: 0 },
    { size_cents: 500, matched_cents: NaN }, null]) {
    const bar = client.matchedCellParts(lv, String).bar;
    assert.strictEqual(bar, '', `no bar for ${JSON.stringify(lv)}`);
    assert.ok(!/NaN|Infinity|undefined/.test(bar), 'and never a bad number in the markup');
  }
});

// L11: THE PRICE CHART (#93). The third thing the issue said was missing
// because `price_history` was write-only: a series endpoint with nothing on the
// client that reads it. The geometry lives in ladder.js for the same reason the
// matched markup does — it is the only part of the chart a Node test can reach.
check('L11 the chart draws a real line, and refuses to invent one', async () => {
  // A PRICE formatter, as OB.price2 is. `sparkline` renders whatever `fmt`
  // returns, so passing the board's money formatter (which formats cents) is a
  // one-word mistake that turns a price of 2.00 into "$0.02" in the label.
  const price = (p) => Number(p).toFixed(2);
  const up = [{ at: 'x', price: 2.0, fills: 1 }, { at: 'y', price: 2.2, fills: 1 }, { at: 'z', price: 2.4, fills: 1 }];
  const svg = client.sparkline(up, { fmt: price });
  assert.ok(svg.startsWith('<svg'), `it renders an svg (got ${svg.slice(0, 40)})`);
  assert.ok(svg.includes('<polyline'), 'with a polyline in it');
  assert.ok(svg.includes('viewBox="0 0 120 28"'), 'at the declared size');
  // THE LABEL CARRIES THE PRICES, formatted by the caller's formatter. Without
  // this the label could silently be rendering money for a price and nothing
  // here would see it — the aria-label is the only place the numbers appear.
  assert.ok(/aria-label="Traded price 2\.00 to 2\.40/.test(svg), `the label states the range (got ${svg})`);
  assert.ok(svg.includes('last 2.40'), 'and where it ended up');
  assert.ok(!svg.includes('$'), 'no money symbol in a price chart');
  // SCALE: every coordinate is inside the viewBox. A chart that plots outside
  // its own viewBox is invisible or clipped, and it looks fine in the markup.
  const nums = (svg.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const coords = [...svg.matchAll(/(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.strictEqual(coords.length, 3, 'one point per sample');
  for (const [x, y] of coords) {
    assert.ok(x >= 0 && x <= 120, `x inside the viewBox (got ${x})`);
    assert.ok(y >= 0 && y <= 28, `y inside the viewBox (got ${y})`);
  }
  // Y IS INVERTED. SVG y grows DOWNWARD, so a rising price must produce a
  // SMALLER y. Asserting the first and last point rather than a shape is what
  // makes an inverted chart fail here instead of on screen.
  assert.ok(coords[0][1] > coords[2][1],
    `a rising price must fall up the canvas, not down it (got ${JSON.stringify(coords.map((c) => c[1]))})`);
  assert.ok(nums.every(Number.isFinite), 'no NaN or Infinity anywhere in the svg');

  // NOTHING TO DRAW, and no shape at all rather than a misleading one.
  assert.strictEqual(client.sparkline([], { fmt: price }), '', 'no series');
  assert.strictEqual(client.sparkline(null, { fmt: price }), '', 'null series');
  assert.strictEqual(client.sparkline([{ price: 2.0 }], { fmt: price }), '',
    'one point is not a trend: a flat line would be indistinguishable from an empty chart');
  // A FLAT series DOES draw, and it draws through the middle. A market that
  // traded repeatedly at one price is genuinely flat and that is the answer,
  // not the absence of one — it is also the case with no range to scale into, so
  // it is the one that divides by zero.
  const flat = client.sparkPoints([{ price: 2.0 }, { price: 2.0 }, { price: 2.0 }]);
  assert.ok(flat, 'a flat series is drawable');
  assert.strictEqual(flat.length, 3);
  assert.ok(flat.every((p) => p.y === flat[0].y), 'and it is a straight line');
  assert.ok(flat[0].y > 0 && flat[0].y < 28, `through the middle of the viewBox (got ${flat[0].y})`);
  assert.ok(client.sparkline([{ price: 2 }, { price: 2 }]).includes('<polyline'), 'and it reaches the markup');

  // A FALLING price rises on the canvas — the other half of the inversion.
  const down = client.sparkPoints([{ price: 3.0 }, { price: 2.0 }]);
  assert.ok(down[0].y < down[1].y, 'a falling price goes down the canvas');

  // TEXT IN THE LABEL IS ESCAPED. The series is server data and the label goes
  // into an attribute; an unescaped quote there closes the attribute.
  const nasty = client.sparkline([{ price: 2 }, { price: 3, fills: 1 }], { fmt: () => 'a" onload="x' });
  assert.ok(!/onload="x"/.test(nasty.slice(nasty.indexOf('aria-label'))),
    `the label cannot break out of its attribute (got ${nasty})`);
  assert.ok(nasty.includes('&quot;'), 'quotes are escaped');

  // SPARK_POINTS is the pure half and scales to the series it is given: more
  // samples means more points, not a resampled curve.
  const many = client.sparkPoints(Array.from({ length: 9 }, (_, i) => ({ price: 2 + i / 10 })));
  assert.strictEqual(many.length, 9);
  assert.ok(many.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
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

// L9b: THE PRICE ROW STILL EMITS THREE CHILDREN. This is the check that would
// have caught what the chart nearly did.
//
// `.lrow` is an exact seven-track grid: `.lmid` takes one and each `.lstack`
// takes three. Add a FOURTH child and it auto-places onto a second implicit row —
// the runner cell then stretches across both and every BACK/LAY label in the
// ladder shifts. Nothing in the CSS objects and nothing else in the suite sees
// it; it is invisible until somebody looks at a 570px screen.
//
// Asserted against the RENDERED markup, not against a constant, because the
// thing that breaks the geometry is a string in public/js/board.js.
check('L9b the price row emits exactly three children and the chart is a sibling', async () => {
  const board = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'board.js'), 'utf8');

  // One price row's worth of children, as it is actually concatenated: from the
  // row's opening `<div class="lrow">` up to the `</div></div>` that closes it.
  // Everything after that — the chart's sibling row — is outside the match by
  // construction, which is the property being asserted.
  const row = board.match(/`<div class="lrow">` \+([\s\S]*?)<\/div><\/div>`/);
  assert.ok(row, 'board.js still builds a price row this way');
  const cells = row[1].match(/`<div /g) || [];
  assert.strictEqual(cells.length, 3,
    `a price row must emit exactly 3 child divs (lmid + 2 lstack), found ${cells.length}`);
  // And it is the runner cell and two price stacks, in that order.
  assert.ok(/`<div class="lmid"/.test(row[1]), 'first child is the runner cell');
  assert.ok(/`<div class="\$\{b\.cls\}">/.test(row[1]), 'then the back stack');
  assert.ok(/`<div class="\$\{l\.cls\}">/.test(row[1]), 'then the lay stack');

  // The chart's row is a SIBLING, never a child, and its one child spans all
  // seven tracks so it does not leave the grid under-filled either.
  assert.ok(/<div class="lrow spark-row"/.test(board), 'the chart row exists');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert.ok(/\.lrow\.spark-row\s*\{[^}]*display:\s*block/.test(css),
    'the chart row opts out of the grid rather than occupying a track');
});

// L9c: THE RUNNER'S NAME STILL FITS. The regression, measured.
//
// #93's first draft added a `MATCHED` badge to `.lmid` beside the existing `LTP`
// one. `.lrow`'s runner column is `minmax(150px, 1.6fr)`, which at the
// documented 570px floor is exactly 150px; with 24px of padding that is 126px of
// usable width. Measured in Chromium at 570px on the seeded board: the LTP badge
// measured 51px and the MATCHED badge 102px, and `.nm` measured 0px — the
// runner's NAME did not render on any row that had traded. Every runner that had
// traded lost its label.
//
// So the runner cell must hold no more than the name and the pre-existing LTP
// badge. This asserts the structural half (the badge is gone from the cell and
// the windowed total is in the market header instead) because that is what a
// Node test can see; the pixel measurement above is why.
check('L9c the runner cell holds no second badge, and the windowed total is in the header', async () => {
  const board = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'board.js'), 'utf8');

  // The badge class the draft added must not be rendered anywhere.
  assert.ok(!/class="ltp tn matched-runner"/.test(board),
    'no MATCHED badge in the runner cell: it measured 102px in a 126px column and hid the name');
  assert.ok(!/\.lmid\s+\.matched-runner/.test(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8')),
    'and no rule styling one either');

  // The windowed total moved to the market header, which is full width.
  assert.ok(/const matchedShown = windowed/.test(board), 'the windowed figure is computed for the header');
  assert.ok(/matched-win/.test(board), 'and it is a header chip, not a ladder badge');
  assert.ok(/<div class="mkthead">[\s\S]{0,300}?\$\{matchedShown\}/.test(board),
    'and it is rendered inside .mkthead');
  assert.ok(/const windowed =/.test(board), 'summed from the per-runner figures');
  // And the per-LEVEL column — the acceptance item — is still in the cells.
  assert.ok(/OB\.Ladder\.matchedCellParts\(lv, OB\.fmt\)/.test(board),
    'the per-level matched column still renders inside the price cells');
  // The runner cell still carries the total for anyone who asks, at no width cost.
  assert.ok(/const matchedTitle = sel\.matched_cents/.test(board), 'the runner row states it in its title');
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
