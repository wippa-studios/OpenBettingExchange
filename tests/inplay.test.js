// inplay.test.js — in-play suspension, bet delay, and traded volume.
// Run: node tests/inplay.test.js   (plain assert, no deps)
//
// In-play is not a feature so much as a DEFENCE. A pre-match exchange is
// safe from the sharpest money in betting; in-play the book reacts to what it
// can see right now, so a venue that publishes prices instantly is
// systematically slower than its own liquidity. Suspension and bet delay are
// how the venue stays slower on purpose.
//
// So the tests assert the venue REFUSES, not that it accepts.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const IP = require('../lib/inplay');
const acc = require('../lib/accounts');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

let n = 0;
function fixture() {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  n++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now','+2 hours'))").run(sp.id, `Ev ${n}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Ev ${n}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, 'Alpha');
  db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, 'Beta');
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, 'Alpha').id;
  const alice = A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 });
  const bob = A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 100000 });
  return { db, alice, bob, marketId: mkt.id, s1 };
}
const place = (f, who, extra = {}) => M.placeOrder(f.db, who, { selection_id: f.s1, side: 'back', price: 2.0, stake_cents: 1000, ...extra });

// I1: a pre-match market is unaffected. The whole in-play apparatus must be
// invisible until it is switched on, or it would break the default case.
check('I1 a pre-match market accepts orders and reports no delay', () => {
  const f = fixture();
  assert.ok(place(f, f.alice).order.id);
  const g = IP.eligibility(f.db, f.marketId);
  assert.strictEqual(g.reason, IP.ELIGIBLE);
  assert.ok(g.eligible_at, 'and it is eligible immediately');
});

// I2: SUSPENSION IS THE CONTROL. A suspended market accepts nothing — that is
// what stops a sharp trading the venue's reaction latency during a goal.
check('I2 a suspended market refuses orders with a reason', () => {
  const f = fixture();
  IP.setSuspended(f.db, { marketId: f.marketId, suspended: true, reason: 'Feed outage' });
  let err = null;
  try { place(f, f.alice); } catch (e) { err = e; }
  assert.ok(err, 'refused');
  assert.strictEqual(err.status, 409, 'Conflict: the request is fine, the market is not ready');
  assert.strictEqual(err.details.code, IP.SUSPENDED);
  assert.ok(/suspended/i.test(err.message));
  // And no money moved.
  assert.strictEqual(f.db.prepare('SELECT frozen_cents f FROM users WHERE id=?').get(f.alice.id).f, 0);
});

// I3: going in-play SUSPENDS BY DESIGN. The venue must not be accepting bets
// at the instant an event turns unpredictable.
check('I3 going in-play suspends the market', () => {
  const f = fixture();
  const r = IP.setInplay(f.db, { marketId: f.marketId, inplay: true, delayMs: 8000 });
  assert.strictEqual(r.inplay, true);
  assert.strictEqual(r.delay_ms, 8000, 'delayMs is milliseconds');
  assert.throws(() => place(f, f.alice), (e) => e.details.code === IP.SUSPENDED);
});

// I4: releasing the kick-off suspension is the ONLY way an in-play market
// starts taking bets, and it is a separate action from suspending.
check('I4 the kick-off suspension must be released before trading', () => {
  const f = fixture();
  IP.setInplay(f.db, { marketId: f.marketId, inplay: true, delayMs: 5000 });
  assert.throws(() => place(f, f.alice), /suspended/i);
  const rel = IP.releaseKickoffSuspension(f.db, f.marketId);
  assert.strictEqual(rel.released, true);
  assert.ok(place(f, f.alice).order.id, 'now it takes orders');
});

// I5: BET DELAY. An in-play order is eligible only after the delay, and the
// client is told WHEN — "delayed" without a duration is indistinguishable
// from broken.
check('I5 an in-play order reports when it becomes matchable', () => {
  const f = fixture();
  IP.setInplay(f.db, { marketId: f.marketId, inplay: true, delayMs: 8000 });
  IP.releaseKickoffSuspension(f.db, f.marketId);
  const e = IP.eligibility(f.db, f.marketId);
  assert.strictEqual(e.reason, IP.DELAYED);
  assert.strictEqual(e.delay_ms, 8000, 'delay is reported in ms');
  assert.ok(e.eligible_at > e.__now || typeof e.eligible_at === 'string', 'and a concrete time');
  // The eligible time must be IN THE FUTURE relative to now.
  const nowTs = f.db.prepare("SELECT datetime('now') AS n").get().n;
  assert.ok(e.eligible_at > nowTs, 'eligible_at is later than now');
});

// I6: a zero delay means immediately eligible — an operator who believes their
// feed is fast enough can say so, and the model does not force a delay.
check('I6 a zero delay is immediately eligible', () => {
  const f = fixture();
  IP.setInplay(f.db, { marketId: f.marketId, inplay: true, delayMs: 0 });
  IP.releaseKickoffSuspension(f.db, f.marketId);
  const e = IP.eligibility(f.db, f.marketId);
  assert.strictEqual(e.reason, IP.ELIGIBLE);
  assert.ok(place(f, f.alice).order.id);
});

// I7: a TIMED suspension expires on its own. An operator should not have to
// remember to resume a market they paused for 30 seconds.
check('I7 a timed suspension expires by itself', () => {
  const f = fixture();
  const past = new Date(Date.now() - 60_000).toISOString();
  IP.setSuspended(f.db, { marketId: f.marketId, suspended: true, until: past, reason: 'brief hold' });
  assert.ok(place(f, f.alice).order.id, 'already expired, so trading resumes');
});

// I8: an OPEN-ENDED suspension stays closed. During a feed outage guessing a
// resume time is worse than requiring a human to restore it.
check('I8 an open-ended suspension requires a human to release', () => {
  const f = fixture();
  IP.setSuspended(f.db, { marketId: f.marketId, suspended: true, reason: 'Feed outage' });
  assert.throws(() => place(f, f.alice), /suspended/i);
  // Nothing expires it.
  assert.throws(() => place(f, f.alice), /suspended/i);
  IP.setSuspended(f.db, { marketId: f.marketId, suspended: false });
  assert.ok(place(f, f.alice).order.id, 'until it is explicitly released');
});

// I9: a SETTLED market cannot be suspended or made in-play. It is terminal.
check('I9 a settled market cannot be suspended or made in-play', () => {
  const f = fixture();
  place(f, f.alice);
  place(f, f.bob);
  require('../lib/settle').settleMarket(f.db, f.marketId, { void: true });
  assert.throws(() => IP.setSuspended(f.db, { marketId: f.marketId, suspended: true }), /Only an open market/);
  assert.throws(() => IP.setInplay(f.db, { marketId: f.marketId, inplay: true }), /Only an open market/);
});

// I10: an absurd delay is refused rather than stored. A ten-hour delay would
// silently make a market untradeable and look like a working venue.
check('I10 an out-of-range delay is refused', () => {
  const f = fixture();
  assert.throws(() => IP.setInplay(f.db, { marketId: f.marketId, inplay: true, delayMs: -1 }), /between 0 and 600000/);
  assert.throws(() => IP.setInplay(f.db, { marketId: f.marketId, inplay: true, delayMs: 999999 }), /between 0 and 600000/);
  assert.throws(() => IP.setInplay(f.db, { marketId: f.marketId, inplay: true, delayMs: 1.5 }), /between 0 and 600000/);
});

// V1: TRADED VOLUME is a WINDOW, not a lifetime total. "How much traded in the
// last 10 minutes" is the liquidity signal; a lifetime total answers a
// question nobody asks.
check('V1 traded volume is a windowed view', () => {
  const f = fixture();
  // Alice backs, Bob LAYS: two backs at the same price never match.
  place(f, f.alice);
  M.placeOrder(f.db, f.bob, { selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 1000 });
  const v = IP.tradedVolume(f.db, f.marketId, 10);
  assert.strictEqual(v.fills, 1);
  assert.strictEqual(v.staked_cents, 1000);
  assert.strictEqual(v.turned_over_cents, 2000, 'stake x price');
  assert.strictEqual(v.window_minutes, 10);
  // Age the fill well outside any realistic window, then confirm the window
  // genuinely excludes it. (A sub-second window was the first attempt and
  // SQLite rounds it, so it silently included the trade.)
  f.db.prepare("UPDATE matches SET at = datetime('now', '-2 hours')").run();
  const empty = IP.tradedVolume(f.db, f.marketId, 10);
  assert.strictEqual(empty.fills, 0, 'outside the window it does not appear');
  assert.strictEqual(empty.staked_cents, 0);
});

// V2: per-selection volume powers a market-mover view.
check('V2 volume can be broken down by selection', () => {
  const f = fixture();
  place(f, f.alice);
  // Bob lays 2000 so BOTH of Alice's 1000 backs match; a 1000 lay would be
  // fully consumed by the first and the second would simply rest.
  M.placeOrder(f.db, f.bob, { selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 2000 });
  place(f, f.alice);
  const by = IP.volumeBySelection(f.db, f.marketId, 10);
  assert.strictEqual(by.length, 1);
  assert.strictEqual(by[0].fills, 2);
  assert.strictEqual(by[0].staked, 2000);
});

// V3: the whole flow preserves the money invariant. In-play refusals and
// suspensions are operational, not financial — they must not disturb escrow.
check('I11 suspension never disturbs the money path', () => {
  const f = fixture();
  place(f, f.alice);
  M.placeOrder(f.db, f.bob, { selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 1000 });
  IP.setSuspended(f.db, { marketId: f.marketId, suspended: true, reason: 'test' });
  for (let i = 0; i < 5; i++) { try { place(f, f.alice); } catch { /* expected */ } }
  IP.setSuspended(f.db, { marketId: f.marketId, suspended: false });
  assert.strictEqual(acc.assertConserved(f.db), 0, 'conservation holds');
  assert.deepStrictEqual(acc.assertUserAgrees(f.db), [], 'cache agrees with postings');
});

console.log(`\ninplay.test.js: ${passed} checks passed`);
if (passed < 12) { console.error('expected 12 checks'); process.exit(1); }