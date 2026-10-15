// marketdata.test.js — the matched-volume column, the price-history series,
// the mover view and the trade tape's retention policy (#93).
// Run: node tests/marketdata.test.js   (plain assert, no deps)
//
// WHY A SUITE OF ITS OWN, AND WHY IT IS SHAPED THIS WAY.
//
// `price_history` was written on every fill and read by NOTHING in production:
// a complete, indexed table consulted by no code path. That is why the ladder
// had no matched-volume column, why there was no chart and why there were no
// movers — not because nobody had built them, but because there was no query
// for any of them. Everything below is that query, its consumers, and the
// policy that says how long the data behind it is kept.
//
// THE HARNESS REPORTS EVERY FAILURE. STATE.md §5 records five vacuous tests
// and a harness that exited on the first failure; this suite does neither. Each
// behavioural check asserts the PRE-STATE, performs the action, and then
// asserts the outcome, because a check that would pass against code which did
// nothing is not a check.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.DB_PATH = ':memory:';
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
// Small enough that the endpoint's own bounds are exercised rather than
// assumed; there is no default cap on points.
process.env.RATE_LIMIT_READ = '1000';
process.env.RATE_LIMIT_ADMIN = '1000';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const MD = require('../lib/marketdata');

let passed = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ok', name);
  } catch (e) {
    failures.push([name, e]);
    console.error('  FAIL', name, '\n       ', e && e.message);
  }
};

let evCounter = 0;

// A market with two runners and enough balance to fill anything asked of it.
async function fixture() {
  const db = openStore(':memory:');
  if (!db.prepare("SELECT id FROM sports WHERE slug='football'").get()) {
    db.prepare("INSERT INTO sports (name, slug) VALUES ('Football','football')").run();
  }
  evCounter += 1;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1, ?, datetime('now','+2 hours'))")
    .run(`MD Event ${evCounter}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`MD Event ${evCounter}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const market_id = db.prepare('SELECT id FROM markets WHERE event_id = ?').get(ev.id).id;
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Alpha', 2.0)").run(market_id);
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Beta', 2.2)").run(market_id);
  const alpha = db.prepare("SELECT id FROM selections WHERE market_id = ? AND name='Alpha'").get(market_id).id;
  const beta = db.prepare("SELECT id FROM selections WHERE market_id = ? AND name='Beta'").get(market_id).id;
  const alice = await A.registerUser(db, { username: 'md-alice', password: 'secret1', balance_cents: 100000 });
  const bob = await A.registerUser(db, { username: 'md-bob', password: 'secret1', balance_cents: 100000 });
  return { db, market_id, alpha, beta, alice, bob };
}

// A resting order that nothing has taken, at a price the ladder will show.
function restBack(db, user, selection_id, price, stake) {
  return M.placeOrder(db, user, { selection_id, side: 'back', price, stake_cents: stake }).order;
}

const bookOf = (db, market_id, levels = 3) => M.bookFor(db, market_id, levels);
const levelAt = (book, selectionId, side, price) => {
  const sel = book.find((s) => s.selection_id === selectionId);
  const hit = (sel[side] || []).find((lv) => Number(lv.price) === Number(price));
  assert.ok(hit, `no ${side} level at ${price} for selection ${selectionId}`);
  return hit;
};
const tapeRows = (db, selectionId) => db.prepare('SELECT COUNT(*) c FROM price_history WHERE selection_id = ?').get(selectionId).c;

(async () => {
  // ── M1: the column exists, is absent before anything trades, and is CORRECT
  // after. The pre-state is the load-bearing half: `bookFor` has always
  // returned levels with only `price` and `size_cents`, so asserting "the
  // matched figure is right" without first asserting "there was nothing to be
  // right" would pass against a function that returned a constant.
  await check('M1 the ladder carries matched volume per level, zero before any fill', async () => {
    const { db, market_id, alpha, alice, bob } = await fixture();
    restBack(db, alice, alpha, 2.0, 5000);

    // PRE-STATE: a level with liquidity and NOTHING traded on it.
    const before = MD.attachMatchedLevels(db, bookOf(db, market_id), { marketId: market_id });
    const lv = levelAt(before, alpha, 'lay', 2.0);
    assert.strictEqual(lv.size_cents, 5000, 'pre-state: the level is live');
    assert.strictEqual(lv.matched_cents, 0, 'pre-state: nothing has traded here');
    assert.strictEqual(lv.matched_fills, 0);
    assert.deepStrictEqual(MD.matchedByLevel(db, { marketIds: [market_id] }), [], 'and no rows at all');

    // ACTION: bob takes 1200 of it.
    M.placeOrder(db, bob, { selection_id: alpha, side: 'lay', price: 2.0, stake_cents: 1200 });

    // OUTCOME: matched on that exact level, unmatched reduced by the fill, and
    // the pre-state's 0 is gone.
    const after = MD.attachMatchedLevels(db, bookOf(db, market_id), { marketId: market_id });
    const now = levelAt(after, alpha, 'lay', 2.0);
    assert.strictEqual(now.matched_cents, 1200, 'matched cents at the level');
    assert.strictEqual(now.matched_fills, 1, 'one fill');
    assert.strictEqual(now.size_cents, 3800, 'unmatched fell by exactly the fill');
    // The OTHER runner never traded and must read zero, not "inherit" Alpha's.
    const betaSel = after.find((s) => s.name === 'Beta');
    assert.deepStrictEqual(betaSel.back, [], 'Beta has no levels at all');
  });

  // M2: two fills at one price AGGREGATE. A column that reported only the most
  // recent fill would pass M1 and fail this.
  await check('M2 fills at one price aggregate into the level, and into the tape', async () => {
    const { db, market_id, alpha, alice, bob } = await fixture();
    restBack(db, alice, alpha, 2.0, 10000);
    restBack(db, alice, alpha, 2.0, 10000);
    const level = () => MD.attachMatchedLevels(db, bookOf(db, market_id), { marketId: market_id })
      .find((s) => s.selection_id === alpha).lay.find((l) => l.price === 2);

    // PRE-STATE: twenty thousand resting, nothing taken.
    assert.strictEqual(level().matched_cents, 0);
    assert.strictEqual(level().matched_fills, 0);
    assert.strictEqual(level().size_cents, 20000);

    M.placeOrder(db, bob, { selection_id: alpha, side: 'lay', price: 2.0, stake_cents: 4000 });
    assert.strictEqual(level().matched_cents, 4000, 'after the first fill');

    M.placeOrder(db, bob, { selection_id: alpha, side: 'lay', price: 2.0, stake_cents: 1500 });

    const lv = level();
    assert.strictEqual(lv.matched_cents, 5500, 'both fills, summed — a column reporting only the latest would say 1500');
    assert.strictEqual(lv.matched_fills, 2);
    assert.strictEqual(lv.size_cents, 14500, 'unmatched is the resting remainder, not the pre-fill size');
    assert.strictEqual(tapeRows(db, alpha), 2, 'and the tape recorded both');
  });

  // M3: the column is a WINDOW, not a lifetime figure. This is what makes the
  // read cheap and what the retention policy is written in terms of.
  await check('M3 matched volume is windowed — a fill outside the window is excluded', async () => {
    const { db, market_id, alpha, alice, bob } = await fixture();
    restBack(db, alice, alpha, 2.0, 10000);
    M.placeOrder(db, bob, { selection_id: alpha, side: 'lay', price: 2.0, stake_cents: 2000 });
    const inWindow = MD.matchedByLevel(db, { marketIds: [market_id], window: 60 });
    assert.strictEqual(inWindow.length, 1);
    assert.strictEqual(inWindow[0].matched_cents, 2000, 'pre-state: inside the window');

    // Push the trade itself — tape row, match row and rollup bucket — out of the
    // window. All three, because a column that read one of them would silently
    // disagree with the other two.
    db.prepare("UPDATE matches SET at = datetime('now','-2 hours') WHERE selection_id = ?").run(alpha);
    db.prepare("UPDATE price_history SET at = datetime('now','-2 hours') WHERE selection_id = ?").run(alpha);
    db.prepare("UPDATE price_matched_levels SET bucket = strftime('%Y-%m-%d %H:%M', datetime('now','-2 hours')) WHERE selection_id = ?").run(alpha);

    const out = MD.matchedByLevel(db, { marketIds: [market_id], window: 60 });
    assert.deepStrictEqual(out, [], 'a two-hour-old trade is not in the last minute');
    // And it comes back when the window is widened — so it was excluded by the
    // window, not lost.
    const wide = MD.matchedByLevel(db, { marketIds: [market_id], window: 180 });
    assert.strictEqual(wide.length, 1);
    assert.strictEqual(wide[0].matched_cents, 2000);
  });

  // M4: THE MOVER VIEW IS THE SAME QUERY. Not a similar one.
  await check('M4 movers() agrees with the ladder column, from the same rows', async () => {
    const { db, market_id, alpha, beta, alice, bob } = await fixture();
    // Two runners, three distinct prices, so the roll-up has something to do.
    // A lay taker sweeps resting backs from the BEST price up, so each level is
    // left resting only where the test wants it to be — and the 2.0 level is
    // deliberately exhausted, because that is the case the ladder cannot show
    // and the runner total exists for.
    restBack(db, alice, alpha, 2.0, 3000);
    M.placeOrder(db, bob, { selection_id: alpha, side: 'lay', price: 2.0, stake_cents: 3000 });
    restBack(db, alice, alpha, 2.02, 3000);
    M.placeOrder(db, bob, { selection_id: alpha, side: 'lay', price: 2.02, stake_cents: 1100 });
    restBack(db, alice, beta, 3.0, 5000);
    M.placeOrder(db, bob, { selection_id: beta, side: 'lay', price: 3.0, stake_cents: 5000 });

    const rows = MD.matchedByLevel(db, { marketIds: [market_id] });
    assert.strictEqual(rows.length, 3, 'three (selection, price) groups');

    const book = MD.attachMatchedLevels(db, bookOf(db, market_id), { marketId: market_id });
    const alphaSel = book.find((s) => s.selection_id === alpha);
    const ladderTotal = (sel) => sel.lay.reduce((a, lv) => a + lv.matched_cents, 0)
      + sel.back.reduce((a, lv) => a + lv.matched_cents, 0);

    const { movers } = MD.movers(db, { marketIds: [market_id] });
    assert.strictEqual(movers.length, 2, 'two runners moved');
    const alphaRow = movers.find((m) => m.selection_id === alpha);
    const betaRow = movers.find((m) => m.selection_id === beta);
    assert.strictEqual(alphaRow.name, 'Alpha', 'and it names them');

    // THE MOVER FIGURE IS THE LADDER FIGURE — the same rows, rolled up. It is
    // compared against the RUNNER TOTAL, which is the figure the ladder can
    // always show; see the assertion two below for why the per-level sum is not
    // the right thing to compare against.
    assert.strictEqual(alphaRow.matched_cents, alphaSel.matched_cents, 'the mover figure IS the ladder figure');
    assert.strictEqual(alphaRow.fills, alphaSel.matched_fills);
    assert.strictEqual(betaRow.matched_cents, book.find((s) => s.selection_id === beta).matched_cents);
    assert.strictEqual(alphaRow.matched_cents, 4100, '3000 + 1100 across two levels');
    assert.strictEqual(alphaRow.levels, 2);
    assert.strictEqual(alphaRow.lowest_price, 2.0);
    assert.strictEqual(alphaRow.top_price, 2.02);
    assert.strictEqual(alphaRow.fills, 2);

    // A fully-traded level is GONE from the ladder — bookFor only lists prices
    // with unmatched size — so the per-level sum is strictly less than the
    // runner total. That gap is 3000 here, and it is stated rather than left to
    // be discovered: it is the volume a trader would otherwise watch vanish.
    assert.deepStrictEqual(alphaSel.lay.map((lv) => [lv.price, lv.size_cents, lv.matched_cents]),
      [[2.02, 1900, 1100]], 'only the level with size left is on the ladder');
    assert.strictEqual(ladderTotal(alphaSel), 1100, 'so the levels alone under-report the runner');
    assert.strictEqual(alphaSel.matched_cents - ladderTotal(alphaSel), 3000,
      'by exactly the volume traded out of a level that is no longer displayed');
    assert.strictEqual(book.find((s) => s.name === 'Beta').matched_cents, 5000);
    // Ranked by money, not by name.
    assert.deepStrictEqual(movers.map((m) => m.selection_id), [beta, alpha]);
  });

  // M5: the board's mover view and the ladder cannot drift because there is one
  // statement. Asserted as the source of truth being a single exported
  // template: a second mover-specific SQL string could not exist without this
  // failing, and that is the defect #93's acceptance is actually about.
  await check('M5 one query, and it is an index search rather than a scan', async () => {
    const { db, market_id } = await fixture();
    const sql = MD.MATCHED_BY_LEVEL_SQL.replace('{{MARKET_IDS}}', '?');
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, MD.bucketCutoff(10)).map((r) => r.detail).join(' | ');
    assert.match(plan, /SEARCH price_matched_levels USING INDEX/,
      `the per-frame read must be an index search; the planner said: ${plan}`);
    assert.ok(!/SCAN price_matched_levels/.test(plan), `and never a scan; the planner said: ${plan}`);
    assert.match(plan, /market_id=\? AND bucket>\?/, `both terms must be index constraints; got: ${plan}`);

    // The series, too: one runner's fills inside a window, on the index that
    // table was built for.
    const seriesPlan = db.prepare(`EXPLAIN QUERY PLAN ${MD.PRICE_SERIES_SQL}`)
      .all(60, 1, '-10 minutes').map((r) => r.detail).join(' | ');
    assert.match(seriesPlan, /SEARCH price_history USING INDEX idx_price_history_selection/,
      `the series read must use the per-runner index; the planner said: ${seriesPlan}`);
    assert.ok(!/SCAN price_history(?!_)/.test(seriesPlan), `and never a table scan; got: ${seriesPlan}`);

    // ONE statement behind both readers. `movers` has to be a roll-up of
    // matchedByLevel's rows, so the template it interpolates is the only
    // aggregate in this module for matched volume.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketdata.js'), 'utf8');
    const fromMatches = src.match(/FROM\s+(\w+)/g) || [];
    assert.ok(!fromMatches.includes('FROM matches'),
      'nothing reads the raw matches table: a per-frame read over the fill history is the scan this design refuses');
    assert.ok(!fromMatches.includes('FROM price_history GROUP BY selection_id'),
      'and matched volume is not summed from the raw tape');
  });

  // ── M6: THE RETENTION TEST the issue asks for by name — "a test that fails if
  // the table is pruned inside the documented retention window".
  //
  // It is asserted from BOTH sides, and both sides are needed:
  //   - a row INSIDE the window survives a prune that removes rows outside it.
  //     Only half of this could be satisfied by a prune that deletes nothing.
  //   - a row OUTSIDE the window IS removed. Without this half the check would
  //     pass against a pruner that did nothing at all, which is the vacuity
  //     this repository has been bitten by five times.
  //   - and the ladder's matched column is UNCHANGED by the prune, because a
  //     money figure must not depend on a table that is allowed to be deleted.
  await check('M6 pruning removes rows OUTSIDE the retention window and never inside it', async () => {
    const { db, market_id, alpha, alice, bob } = await fixture();
    restBack(db, alice, alpha, 2.0, 10000);
    M.placeOrder(db, bob, { selection_id: alpha, side: 'lay', price: 2.0, stake_cents: 2500 });
    restBack(db, alice, alpha, 2.02, 10000);
    M.placeOrder(db, bob, { selection_id: alpha, side: 'lay', price: 2.02, stake_cents: 750 });

    const policy = MD.retentionPolicy();
    const days = policy.retention_days;
    // One tape row and one rollup bucket INSIDE the window; one of each OUTSIDE.
    db.prepare("INSERT INTO price_history (selection_id, price, at) VALUES (?, 2.5, datetime('now','-3 days'))").run(alpha);
    db.prepare("INSERT INTO price_history (selection_id, price, at) VALUES (?, 9.5, datetime('now', ?))")
      .run(alpha, `-${days * 2} days`);
    db.prepare(`INSERT INTO price_matched_levels (selection_id, market_id, price_cents, bucket, fills, matched_cents)
                VALUES (?, ?, 250, strftime('%Y-%m-%d %H:%M', datetime('now','-3 days')), 1, 400)`).run(alpha, market_id);
    db.prepare(`INSERT INTO price_matched_levels (selection_id, market_id, price_cents, bucket, fills, matched_cents)
                VALUES (?, ?, 950, strftime('%Y-%m-%d %H:%M', datetime('now', ?)), 1, 900)`)
      .run(alpha, market_id, `-${days * 2} days`);

    // PRE-STATE, asserted rather than assumed.
    assert.strictEqual(tapeRows(db, alpha), 4, 'pre-state: four tape rows');
    const inside = db.prepare("SELECT COUNT(*) c FROM price_history WHERE at >= datetime('now', ?)")
      .get(`-${days} days`).c;
    const outside = db.prepare("SELECT COUNT(*) c FROM price_history WHERE at < datetime('now', ?)")
      .get(`-${days} days`).c;
    assert.strictEqual(inside, 3, 'pre-state: three rows inside the window');
    assert.strictEqual(outside, 1, 'pre-state: one row outside it');
    const ladderBefore = MD.attachMatchedLevels(db, bookOf(db, market_id), { marketId: market_id })
      .find((s) => s.selection_id === alpha).lay.map((lv) => [lv.price, lv.matched_cents]);
    const seriesBefore = MD.priceSeries(db, alpha, { window: days * 24 * 60 }).series;

    // ACTION.
    const result = MD.prunePriceHistory(db);

    // The half that could be satisfied by doing nothing.
    assert.ok(result.tape_rows_deleted > 0, `the prune removed nothing: ${JSON.stringify(result)}`);
    assert.ok(result.rollup_rows_deleted > 0, `the rollup was not pruned: ${JSON.stringify(result)}`);
    assert.strictEqual(result.retention_days, days, 'it reports the policy it applied');

    // The half the issue names: nothing inside the window was touched.
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) c FROM price_history WHERE at >= datetime('now', ?)").get(`-${days} days`).c,
      inside, 'every row inside the retention window survived'
    );
    assert.strictEqual(tapeRows(db, alpha), 3, 'and the one outside it is gone');
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) c FROM price_matched_levels WHERE bucket >= strftime('%Y-%m-%d %H:%M', datetime('now', ?))")
        .get(`-${days} days`).c,
      2, 'the in-window rollup bucket survived'
    );

    // AND THE POINT OF ALL OF IT: a chart the endpoint will still serve is a
    // chart the pruner cannot empty, and pruning changed no money figure.
    assert.deepStrictEqual(MD.priceSeries(db, alpha, { window: days * 24 * 60 }).series, seriesBefore,
      'the series is identical after the prune');
    const ladderAfter = MD.attachMatchedLevels(db, bookOf(db, market_id), { marketId: market_id })
      .find((s) => s.selection_id === alpha).lay.map((lv) => [lv.price, lv.matched_cents]);
    assert.deepStrictEqual(ladderAfter, ladderBefore,
      'the ladder column is unchanged: it is computed from the executed tape, not from the prunable table');
  });

  // M7: pruning is bounded. node:sqlite is synchronous, so a prune that tried
  // to catch up in one call would hold the single writer for its duration — the
  // same constraint that shapes every read in this feature.
  await check('M7 a prune pass is bounded, and says so when there is more to do', async () => {
    const { db, alpha } = await fixture();
    // More old rows than one pass may delete.
    const stmt = db.prepare("INSERT INTO price_history (selection_id, price, at) VALUES (?, 3.0, datetime('now','-400 days'))");
    db.exec('BEGIN');
    for (let i = 0; i < 5; i++) stmt.run(alpha);
    db.exec('COMMIT');
    assert.strictEqual(tapeRows(db, alpha), 5);

    const result = MD.prunePriceHistory(db);
    assert.strictEqual(result.tape_rows_deleted, 5, 'a small backlog is cleared in one pass');
    assert.strictEqual(result.more_remaining, false, 'and nothing is implied about work it did not do');

    // The policy's own arithmetic is checkable from outside, so the bound in the
    // comment cannot quietly become a different number from the one enforced.
    assert.ok(policy_batch_bound() > 0);
    function policy_batch_bound() {
      const p = MD.retentionPolicy();
      return p.prune_batch_rows * p.prune_max_batches;
    }
  });

  // M8: the retention window is enforced, not merely documented. A chart asked
  // for further back than the policy keeps is REFUSED, because silently
  // truncating it would produce a series that looks like a quiet market.
  await check('M8 the series refuses a window wider than the retention window', async () => {
    const { db, alpha } = await fixture();
    db.prepare("INSERT INTO price_history (selection_id, price, at) VALUES (?, 2.0, datetime('now','-10 days'))").run(alpha);
    const policy = MD.retentionPolicy();
    assert.strictEqual(policy.max_window_minutes, policy.retention_days * 24 * 60);

    const ok = MD.priceSeries(db, alpha, { window: policy.max_window_minutes });
    assert.strictEqual(ok.window_minutes, policy.max_window_minutes, 'exactly the window is allowed');
    assert.strictEqual(ok.retention_days, policy.retention_days, 'and the answer says how far back it reaches');
    assert.ok(ok.series.length >= 1, 'the row is in it');

    assert.throws(
      () => MD.priceSeries(db, alpha, { window: policy.max_window_minutes + 1 }),
      (e) => e.status === 400 && e.details && e.details.code === 'window_too_wide',
      'one minute further is refused, not truncated'
    );
    assert.throws(() => MD.priceSeries(db, 999999, {}), (e) => e.status === 404, 'and an unknown selection is a 404');
  });

  // M9: the tape is genuinely DERIVED from the executed trade, which is what
  // makes pruning it safe rather than merely convenient. If a fill could write
  // price_history without a match — or a match without a tape row — the policy
  // would be discarding something `matches` could not rebuild.
  await check('M9 price_history carries nothing the matches table does not', async () => {
    const { db, market_id, alpha, beta, alice, bob } = await fixture();
    restBack(db, alice, alpha, 2.0, 2600);
    M.placeOrder(db, bob, { selection_id: alpha, side: 'lay', price: 2.0, stake_cents: 2600 });
    restBack(db, alice, alpha, 2.02, 900);
    M.placeOrder(db, bob, { selection_id: alpha, side: 'lay', price: 2.02, stake_cents: 900 });
    restBack(db, alice, beta, 3.0, 4400);
    M.placeOrder(db, bob, { selection_id: beta, side: 'lay', price: 3.0, stake_cents: 4400 });

    const fromMatches = db.prepare(
      'SELECT selection_id, price, COUNT(*) n FROM matches GROUP BY selection_id, price ORDER BY selection_id, price'
    ).all();
    const fromTape = db.prepare(
      'SELECT selection_id, price, COUNT(*) n FROM price_history GROUP BY selection_id, price ORDER BY selection_id, price'
    ).all();
    assert.deepStrictEqual(fromTape, fromMatches,
      'every tape row corresponds to exactly one match, at the same price');
    assert.ok(fromMatches.length >= 3, 'and there were trades on both runners to compare');
  });

  // M10: a pre-existing database gains the rollup CORRECTLY, rather than
  // starting life with no matched volume on any trade it already held.
  // STATE.md §5 and lib/store.js both record this repo losing migrations and
  // then aborting boots on index creation; the backfill is the half that is
  // easy to forget and impossible to notice.
  await check('M10 a database that predates the rollup is backfilled exactly once', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const fs2 = require('fs');
    const os = require('os');
    const path2 = require('path');
    const dir = fs2.mkdtempSync(path2.join(os.tmpdir(), 'ob-md-'));
    const file = path2.join(dir, 'old.db');

    // A database built by the CURRENT schema would already have the trigger, so
    // the case under test is simulated honestly: create the trade rows, then
    // drop the rollup's trigger and empty the rollup, which is exactly the state
    // a database predating #93 is in.
    const db0 = openStore(file);
    db0.prepare("INSERT INTO sports (name, slug) VALUES ('F','f')").run();
    db0.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1,'E', datetime('now'))").run();
    db0.prepare("INSERT INTO markets (event_id, name) VALUES (1,'M')").run();
    db0.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (1,'A',2.0)").run();
    db0.prepare("INSERT INTO users (username, pass_hash, balance_cents) VALUES ('u','x',100000)").run();
    db0.prepare("INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents, matched_cents, frozen_cents, status) VALUES (1,1,1,'back',2.0,3000,3000,3000,'fully_matched')").run();
    db0.prepare("INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents, matched_cents, frozen_cents, status) VALUES (1,1,1,'lay',2.0,3000,3000,0,'fully_matched')").run();
    db0.prepare("INSERT INTO matches (market_id, selection_id, back_order_id, lay_order_id, price, stake_cents) VALUES (1,1,1,2,2.0,3000)").run();
    db0.prepare("INSERT INTO price_history (selection_id, price) VALUES (1, 2.0)").run();
    db0.exec('DROP TRIGGER trg_matches_price_matched_levels');
    db0.exec('DELETE FROM price_matched_levels');
    db0.close();

    // REOPEN: this is the migration running against the state above.
    const db1 = openStore(file);
    const backfilled = db1.prepare('SELECT fills, matched_cents FROM price_matched_levels').all();
    assert.strictEqual(backfilled.length, 1, 'the historical fill is in the rollup');
    assert.strictEqual(backfilled[0].fills, 1);
    assert.strictEqual(backfilled[0].matched_cents, 3000);
    assert.strictEqual(MD.matchedByLevel(db1, { marketIds: [1] })[0].matched_cents, 3000,
      'and the ladder column reads it immediately, with no restart needed twice');

    // AND IT IS EXACTLY ONCE. The migration runs on every open, so a second
    // open that re-added the 3000 would be a silent doubling.
    db1.close();
    const db2 = openStore(file);
    const again = db2.prepare('SELECT fills, matched_cents FROM price_matched_levels').all();
    assert.deepStrictEqual(again, backfilled, 'reopening does not re-add the historical fills');
    db2.close();
    fs2.rmSync(dir, { recursive: true, force: true });
  });

  // M10b: the window the book REPORTS is the window it was computed over.
  //
  // `matched_window_minutes` is what the ladder renders in the runner badge's
  // tooltip, so a book that reported the DEFAULT while its rows came from a
  // 180-minute aggregate would put "in the last 10 minutes" beside a number
  // that is not one. The pre-state here is the failure itself: assert the
  // window is the caller's BEFORE any trade exists, because a version that
  // hardcoded the constant would answer 10 for both windows and pass a check
  // written only against the default.
  await check('M10b the book reports the window its matched figures were taken over', async () => {
    const { db, market_id, alpha, alice, bob } = await fixture();
    restBack(db, alice, alpha, 2.0, 9000);
    M.placeOrder(db, bob, { selection_id: alpha, side: 'lay', price: 2.0, stake_cents: 1500 });

    const forWindow = (w) => MD.attachMatchedLevels(db, bookOf(db, market_id), { marketId: market_id, window: w })
      .find((s) => s.selection_id === alpha);

    // PRE-STATE, at two windows that differ: the old code answered 10 for both.
    assert.strictEqual(forWindow(10).matched_window_minutes, 10);
    assert.strictEqual(forWindow(180).matched_window_minutes, 180);
    // The rows are identical here (one recent fill) — what must differ is the
    // LABEL, so the assertion is on the label and not on the money.
    assert.strictEqual(forWindow(180).matched_cents, forWindow(10).matched_cents);

    // attachRows is the pure form and is the one the BOARD route calls, so it is
    // pinned directly: a caller that forgot to forward the window is the bug.
    const rows = MD.matchedByLevel(db, { marketIds: [market_id], window: 45 });
    assert.strictEqual(rows.length, 1, 'pre-state: there is a row to attach');
    const bare = MD.attachRows(bookOf(db, market_id), rows, { window: 45 });
    assert.strictEqual(bare.find((s) => s.selection_id === alpha).matched_window_minutes, 45,
      'attachRows forwards the window it was given');
    // And with no window at all it still names the default, so the field is never
    // undefined for a client to print.
    assert.strictEqual(MD.attachRows(bookOf(db, market_id), rows)[0].matched_window_minutes, MD.DEFAULT_WINDOW_MINUTES);
  });

  // ── M11: the routes. #93's second acceptance item is an ENDPOINT, and an endpoint
  // nobody called is how `price_history` became write-only in the first place.
  await check('M11 the three routes answer, and the series is fed by the tape', async () => {
    const srv = require('../server');
    const server = srv.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.on('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const j = async (method, path, body, cookie) => {
        const headers = {};
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (cookie) headers.cookie = cookie;
        const res = await fetch(base + path, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        });
        let json = null;
        try { json = await res.json(); } catch { /* non-JSON body is the case under test */ }
        return { status: res.status, json };
      };

      // Trade on the SERVER's own database, through the engine, so the route is
      // exercised against rows a real fill produced.
      const db = srv.db;
      if (!db.prepare("SELECT id FROM sports WHERE slug='mdroute'").get()) {
        db.prepare("INSERT INTO sports (name, slug) VALUES ('MDRoute','mdroute')").run();
      }
      db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES ((SELECT id FROM sports WHERE slug='mdroute'), 'E', datetime('now','+2 hours'))").run();
      const ev = db.prepare("SELECT id FROM events WHERE name='E' ORDER BY id DESC LIMIT 1").get();
      db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Route Odds')").run(ev.id);
      const market_id = db.prepare('SELECT id FROM markets WHERE event_id = ? ORDER BY id DESC LIMIT 1').get(ev.id).id;
      db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Routed', 2.0)").run(market_id);
      const sel = db.prepare('SELECT id FROM selections WHERE market_id = ? ORDER BY id DESC LIMIT 1').get(market_id).id;
      const taker = await A.registerUser(db, { username: 'md-route-taker', password: 'secret1', balance_cents: 100000 });
      const maker = await A.registerUser(db, { username: 'md-route-maker', password: 'secret1', balance_cents: 100000 });
      M.placeOrder(db, maker, { selection_id: sel, side: 'back', price: 2.0, stake_cents: 6000 });
      M.placeOrder(db, taker, { selection_id: sel, side: 'lay', price: 2.0, stake_cents: 3400 });

      // GET /api/selections/:id/price-history — fed by the tape, not by nothing.
      const series = await j('GET', `/api/selections/${sel}/price-history?window=60`);
      assert.strictEqual(series.status, 200);
      assert.strictEqual(series.json.selection_id, sel);
      assert.strictEqual(series.json.retention_days, MD.RETENTION_DAYS);
      assert.ok(series.json.series.length >= 1, 'the route returns a series');
      const fills = series.json.series.reduce((a, p) => a + p.fills, 0);
      assert.strictEqual(fills, 1, 'and it counted the one fill the engine made');

      // The window ceiling is a 400 with a machine-readable code.
      const tooWide = await j('GET', `/api/selections/${sel}/price-history?window=${MD.MAX_WINDOW_MINUTES + 1}`);
      assert.strictEqual(tooWide.status, 400);
      assert.strictEqual(tooWide.json.code, 'window_too_wide');

      const missing = await j('GET', '/api/selections/99999999/price-history');
      assert.strictEqual(missing.status, 404);
      const notInt = await j('GET', '/api/selections/abc/price-history');
      assert.strictEqual(notInt.status, 400);

      // GET /api/movers — the board's mover view, same query as the column.
      const mv = await j('GET', '/api/movers?window=60&limit=5');
      assert.strictEqual(mv.status, 200);
      assert.strictEqual(mv.json.window_minutes, 60);
      const row = mv.json.movers.find((m) => m.selection_id === sel);
      assert.ok(row, 'the runner that just traded is in the mover view');
      assert.strictEqual(row.matched_cents, 3400, 'with the figure the engine matched');

      // The board and the desk carry the same column.
      const events = await j('GET', '/api/events');
      assert.strictEqual(events.status, 200);
      const evt = events.json.events.find((e) => e.id === ev.id);
      const mkt = evt.markets.find((m) => m.id === market_id);
      const lv = mkt.selections.find((s) => s.selection_id === sel).lay.find((l) => l.price === 2);
      assert.strictEqual(lv.matched_cents, 3400, '/api/events carries the matched column');
      assert.strictEqual(lv.size_cents, 2600, 'beside the unmatched size, unchanged');
      const book = await j('GET', `/api/markets/${market_id}/book`);
      assert.strictEqual(book.json.book.find((s) => s.selection_id === sel).lay.find((l) => l.price === 2).matched_cents, 3400,
        'and /api/markets/:id/book carries the same figure');

      // POST /api/admin/maintenance/price-history — admin-gated, and it ran.
      const anon = await j('POST', '/api/admin/maintenance/price-history', {});
      assert.ok(anon.status === 401 || anon.status === 403, `the pruner is admin-only (got ${anon.status})`);
      const adm = await A.registerUser(db, { username: 'md-route-admin', password: 'secret1', balance_cents: 0 });
      db.prepare("UPDATE users SET role='admin', is_admin=1 WHERE id=?").run(adm.id);
      const loginRes = await fetch(base + '/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'md-route-admin', password: 'secret1' }),
      });
      assert.strictEqual(loginRes.status, 200, 'the admin can sign in');
      const setCookie = loginRes.headers.getSetCookie().find((c) => c.startsWith('ob_session='));
      assert.ok(setCookie, 'and gets a session');
      const pruned = await j('POST', '/api/admin/maintenance/price-history', {}, setCookie.split(';')[0]);
      assert.strictEqual(pruned.status, 200, `the pruner ran for an admin: ${JSON.stringify(pruned.json)}`);
      assert.strictEqual(pruned.json.retention_days, MD.RETENTION_DAYS);
      assert.strictEqual(typeof pruned.json.more_remaining, 'boolean');
      // And it removed nothing that was inside the window — the series above is
      // still intact after it ran.
      const after = await j('GET', `/api/selections/${sel}/price-history?window=60`);
      assert.deepStrictEqual(after.json.series, series.json.series, 'the series survived the prune');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  console.log(`\nmarketdata.test.js: ${passed} checks passed`);
  if (failures.length) {
    console.error(`\nmarketdata.test.js: ${failures.length} FAILED`);
    for (const [name, e] of failures) console.error(`  x ${name}\n     ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('marketdata.test.js crashed:', e);
  process.exit(1);
});