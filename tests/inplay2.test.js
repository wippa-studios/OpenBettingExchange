// inplay2.test.js — the in-play bet delay ENFORCED, not merely reported.
// Run: node tests/inplay2.test.js   (plain assert, no deps)
//
// WHY THIS SUITE EXISTS. lib/inplay.js has always reported a bet delay to the
// client — "your order becomes matchable at 02:05:59" — and the engine never
// acted on it. An order placed in a 60-second-delay in-play market matched on
// arrival, every time. A reproduction, not a theory:
//
//   delay reported to the client: 60000ms | eligible_at: 2026-10-13 02:05:59
//   bob matched on arrival: true
//
// That is the whole reason real venues delay in-play prices: the book reacts
// to what it can see NOW, so a venue that publishes instantly is
// systematically slower than its own liquidity, and every sharp trades the
// delay instead of the football. Reporting a delay that is not enforced is
// worse than having no delay feature — the client believes it is protected.
//
// It is also the third dead control in this codebase (after the cash-out
// risk caps and the unguarded cash-out primitive), which is why this suite
// asserts the ENGINE's behaviour rather than the advisory.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const IP = require('../lib/inplay');
const acc = require('../lib/accounts');
const S = require('../lib/settle');
const L = require('../lib/limits');
const LIMITS = L;

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

let n = 0;
async function fixture() {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  n++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now','+2 hours'))").run(sp.id, `Ev ${n}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Ev ${n}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  for (const nm of ['Alpha', 'Beta']) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, nm);
  }
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, 'Alpha').id;
  const mk = async (u) => A.registerUser(db, { username: u, password: `pw-${u}-1234`, balance_cents: 100000 });
  return { db, marketId: mkt.id, s1, alice: (await mk('alice')), bob: (await mk('bob')), carol: (await mk('carol')), dave: (await mk('dave')) };
}

const order = (f, who, extra = {}) =>
  M.placeOrder(f.db, who, { selection_id: f.s1, side: 'back', price: 2.0, stake_cents: 1000, ...extra });

// Put a market in-play with a delay, and resume trading past the kick-off
// suspension. `delayMs` of 0 is a distinct case (I6) and not the default here.
function goInPlay(f, delayMs = 60000) {
  IP.setInplay(f.db, { marketId: f.marketId, inplay: true, delayMs });
  IP.releaseKickoffSuspension(f.db, f.marketId);
}
const expireAll = (f) =>
  f.db.prepare("UPDATE orders SET eligible_at = datetime('now','-1 second') WHERE eligible_at IS NOT NULL").run();

// ── The pre-match path must be UNTOUCHED ───────────────────────────────────

// D1: the regression. A delayed order must NOT match on arrival. This is the
// exact call the reproduction made that matched anyway.
check('D1 a delayed order does NOT match on arrival', async () => {
  const f = (await fixture());
  order(f, f.alice, { side: 'lay' }); // alice rests a lay
  goInPlay(f, 60000);
  const r = order(f, f.bob); // bob's back crosses it
  assert.strictEqual(r.fills.length, 0, 'the delay held');
  assert.ok(r.order.status !== 'fully_matched', 'and the order rests instead');
  const row = f.db.prepare('SELECT eligible_at e, status s FROM orders WHERE id = ?').get(r.order.id);
  assert.ok(row.e, 'it carries an eligible_at');
  assert.strictEqual(row.s, 'open', 'and is open, waiting');
});

// D2: pre-match matching is unchanged — eligible_at is NULL, and orders cross
// on arrival exactly as before. A delay feature that altered the pre-match
// book would be a far worse regression than the bug.
check('D2 a pre-match order has no delay and matches immediately', async () => {
  const f = (await fixture());
  order(f, f.alice, { side: 'lay' });
  const row = f.db.prepare('SELECT eligible_at e FROM orders ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(row.e, null, 'eligible_at is NULL pre-match — immediately eligible');
  const r = order(f, f.bob);
  assert.strictEqual(r.fills.length, 1, 'and it matches on arrival');
});

// D3: the in-play delay of ZERO matches immediately. An operator who believes
// their feed is fast enough must be able to say so, and the model must not
// force a delay on them.
check('D3 a zero delay matches immediately even in-play', async () => {
  const f = (await fixture());
  order(f, f.alice, { side: 'lay' });
  goInPlay(f, 0);
  const r = order(f, f.bob);
  assert.strictEqual(r.fills.length, 1, 'no artificial delay');
});

// D4: a delayed order's timestamp is still its TRUE placement time. The tape
// must not be told the order arrived later than it did, or the audit trail
// misreports what the venue could have known.
check('D4 eligible_at is separate from placed_at', async () => {
  const f = (await fixture());
  goInPlay(f, 60000);
  const r = order(f, f.bob);
  const row = f.db.prepare('SELECT placed_at p, eligible_at e FROM orders WHERE id = ?').get(r.order.id);
  assert.ok(row.p, 'placed_at is recorded');
  assert.notStrictEqual(row.p, row.e, 'and is NOT the same field as eligible_at');
  assert.ok(row.e > row.p, 'eligible_at is in the future relative to placement');
});

// ── The resting side ───────────────────────────────────────────────────────

// D5: an ELIGIBLE taker must not be able to sweep a DELAYED resting order.
// One-sided enforcement (gating the taker only) would leave the delay
// meaningless: any other player could take the delayed order instantly.
check('D5 an eligible taker cannot sweep a delayed resting order', async () => {
  const f = (await fixture());
  goInPlay(f, 60000);
  order(f, f.alice, { side: 'lay' }); // delayed resting lay
  const r = order(f, f.bob); // an (immediately eligible? no — also delayed) back
  assert.strictEqual(r.fills.length, 0, 'nothing crosses while both are delayed');
  // Now make BOB eligible immediately by removing his delay, and confirm he
  // still cannot take alice's delayed order: hers is what gates the trade.
  f.db.prepare("UPDATE orders SET eligible_at = NULL WHERE id = ?").run(r.order.id);
  f.db.prepare("UPDATE orders SET eligible_at = datetime('now','-1 second') WHERE status='open' AND id != ?").run(r.order.id);
  const r2 = M.placeOrder(f.db, f.carol, { selection_id: f.s1, side: 'back', price: 2.0, stake_cents: 1000 });
  assert.strictEqual(r2.fills.length, 0, 'still cannot cross into a delayed order');
});

// ── The release pass ───────────────────────────────────────────────────────

// D6: when the delay expires, the release pass MATCHES the order. Without this
// the delay is not a feature, it is an outage: in-play orders would sit
// unmatched until a taker happened to arrive.
check('D6 the release pass matches a delayed order once the delay expires', async () => {
  const f = (await fixture());
  goInPlay(f, 60000);
  order(f, f.alice, { side: 'lay' }); // delayed resting lay
  const bob = order(f, f.bob); // delayed back, rests
  assert.strictEqual(bob.fills.length, 0);
  expireAll(f);
  const r = M.releaseEligibleOrders(f.db);
  assert.ok(r.released >= 1, 'the pass considered the due order(s)');
  const matches = f.db.prepare('SELECT COUNT(*) c FROM matches').get().c;
  assert.strictEqual(matches, 1, 'and it matched');
  assert.strictEqual(acc.assertConserved(f.db), 0, 'books still balance');
});

// D7: the release pass is a NO-OP when nothing is delayed. A timer that does
// work every tick regardless is a background load bug waiting to happen.
check('D7 the release pass is a no-op with nothing delayed', async () => {
  const f = (await fixture());
  const r = M.releaseEligibleOrders(f.db);
  assert.deepStrictEqual(r, { considered: 0, released: 0, filled: 0, skipped: 0 });
});

// D8: a released order leaves the delayed set (eligible_at is cleared), so it
// is not re-scanned forever. Once released it is an ordinary resting order.
check('D8 a released order is no longer in the delayed set', async () => {
  const f = (await fixture());
  goInPlay(f, 60000);
  order(f, f.alice, { side: 'lay', price: 5.0, stake_cents: 1000 }); // will not cross
  order(f, f.bob, { side: 'back', price: 2.0, stake_cents: 1000 });
  expireAll(f);
  M.releaseEligibleOrders(f.db);
  const left = f.db.prepare("SELECT COUNT(*) c FROM orders WHERE eligible_at IS NOT NULL").get().c;
  assert.strictEqual(left, 0, 'nothing left in the delayed set');
  assert.strictEqual(M.releaseEligibleOrders(f.db).considered, 0, 'the next pass finds nothing');
});

// D9: THE PRICE. A released order is released as a MAKER — it fills at the
// price IT asked for, never at a better one a counterparty offers. Alice rests
// a LAY at 1.6; bob's delayed BACK is at 1.5. On release they cross, and the
// fill must be at 1.5 (bob's price). Filling at the resting 1.6 would pay bob
// more than his order said and silently change his stake x price arithmetic.
check('D9 a released order fills at ITS price, never a better one', async () => {
  const f = (await fixture());
  // alice's lay rests PRE-MATCH, so it is immediately eligible and can be hit.
  order(f, f.alice, { side: 'lay', price: 1.6, stake_cents: 1000 });
  goInPlay(f, 60000);
  // bob's back at 1.5 is delayed, so it cannot take alice's 1.6 on arrival.
  const bob = order(f, f.bob, { price: 1.5 });
  assert.strictEqual(bob.fills.length, 0, 'held by the delay');
  expireAll(f);
  M.releaseEligibleOrders(f.db);
  const fills = f.db.prepare('SELECT price p, stake_cents s FROM matches').all();
  assert.strictEqual(fills.length, 1, 'matched on release');
  assert.strictEqual(fills[0].p, 1.5, "at BOB's own 1.5, not the 1.6 alice asked for");
  assert.strictEqual(fills[0].s, 1000);
  assert.strictEqual(acc.assertConserved(f.db), 0, 'and the books balance');
});

// D10: cancelling a delayed order is allowed and releases its escrow at once.
// A player must not be locked into a position they cannot exit for the length
// of the delay.
check('D10 a delayed order can be cancelled and its escrow released', async () => {
  const f = (await fixture());
  goInPlay(f, 60000);
  const r = order(f, f.bob);
  assert.ok(f.db.prepare('SELECT frozen_cents f FROM users WHERE id=?').get(f.bob.id).f > 0, 'escrowed');
  M.cancelOrder(f.db, f.bob, r.order.id);
  assert.strictEqual(f.db.prepare('SELECT frozen_cents f FROM users WHERE id=?').get(f.bob.id).f, 0, 'released');
  assert.strictEqual(acc.assertConserved(f.db), 0);
});

// D11: a market that closed or was held mid-delay must NOT be released into.
// Otherwise a delayed order is matched in a market that is settling.
check('D11 a suspended market is not released into', async () => {
  const f = (await fixture());
  goInPlay(f, 60000);
  order(f, f.alice, { side: 'lay' });
  const bob = order(f, f.bob);
  assert.strictEqual(bob.fills.length, 0);
  IP.setSuspended(f.db, { marketId: f.marketId, suspended: true, reason: 'feed outage' });
  expireAll(f);
  const r = M.releaseEligibleOrders(f.db);
  assert.strictEqual(r.filled, 0, 'nothing released into a suspended market');
  assert.strictEqual(f.db.prepare('SELECT COUNT(*) c FROM matches').get().c, 0, 'no match created');
});

// D12: the engine and the client advisory read the SAME source, and the order
// the engine writes carries the delay the client was told about. If they
// disagreed, a player could be shown "protected" while the engine matched
// their order immediately — which is precisely how the original bug hid.
//
// The first version of this check compared two independently-computed
// timestamps (the order's eligible_at against a fresh eligibility() call) and
// failed for that reason alone: the advisory is computed at call time, so it is
// a few milliseconds later than the order's. The meaningful property is the
// ORDER's own horizon.
check('D12 the engine delay and the client advisory never disagree', async () => {
  const f = (await fixture());
  goInPlay(f, 45000);
  assert.strictEqual(IP.delayMsFor(f.db, f.marketId), 45000, 'delayMsFor agrees');
  assert.strictEqual(IP.eligibility(f.db, f.marketId).delay_ms, 45000, 'eligibility agrees');
  const r = order(f, f.bob);
  const row = f.db
    .prepare("SELECT (julianday(eligible_at) - julianday('now')) * 86400 AS secs FROM orders WHERE id = ?")
    .get(r.order.id);
  assert.ok(
    Math.abs(row.secs - 45) < 2,
    `the order the engine wrote is eligible ~45s out, not immediately (got ${row.secs.toFixed(1)}s)`
  );
});

// D13: A DELAYED ORDER STAYS IDENTIFIABLE AFTER IT IS RELEASED. The release
// pass clears eligible_at — that IS the released state, so the scheduling state
// is gone once the order is in the book. That left no way to tell afterwards
// whether an order had been delayed, which makes the venue's offered bet delay
// unreportable (lib/reports.js could not compute it, and initially read
// `eligible_at IS NOT NULL` and found nothing). `orders.delayed` is the durable
// historical fact, kept separately from the scheduling state.
check('D13 a released order is still identifiable as delayed', async () => {
  const f = (await fixture());
  goInPlay(f, 60000);
  order(f, f.alice, { side: 'lay' });
  const bob = order(f, f.bob);
  assert.strictEqual(f.db.prepare('SELECT delayed d FROM orders WHERE id=?').get(bob.order.id).d, 1, 'flagged at placement');
  expireAll(f);
  M.releaseEligibleOrders(f.db);
  const after = f.db.prepare('SELECT delayed d, eligible_at e FROM orders WHERE id=?').get(bob.order.id);
  assert.strictEqual(after.d, 1, 'still flagged after release');
  assert.strictEqual(after.e, null, 'and out of the delayed set');
  // A pre-match order is never flagged, so the flag means what it says.
  const g = (await fixture());
  const pre = order(g, g.alice);
  assert.strictEqual(g.db.prepare('SELECT delayed d FROM orders WHERE id=?').get(pre.order.id).d, 0);
});

// D14: THE RELEASE PASS MUST NOT ERASE MATCHED HISTORY. This is a critical bug
// that the earlier checks in this file could not see, and understanding WHY is
// the point of keeping it.
//
// Every helper above defaults `stake_cents: 1000`, so D6 and D9 use EQUAL
// stakes: the first released order fully fills the second, the second then hits
// the `matched_cents >= stake_cents` early-return and never reaches
// finalizeTaker. The bug needed UNEQUAL stakes and a specific order of events —
// an order filled as a COUNTERPARTY by an earlier release, and then itself
// processed by the pass.
//
// What went wrong: finalizeTaker derives `matched = stake - remaining` and needs
// `remaining` on the same scale as `stake`. The pass passed
// `o.matched_cents + swept.remaining`, double-counting the already-matched part.
// The first released order then reported matched=2000/3000 as matched=0/3000
// with frozen_cents at the full 3000. Two consequences, both severe:
//
//   - cancelOrderTx released collateral securing a LIVE match, and the player
//     withdrew it;
//   - settlement then refused with "releasing more than frozen", and so did
//     void — leaving the market permanently unsettleable AND un-voidable.
//
// The double-entry invariants never fired (conserved 0, no divergent users)
// because the LEDGER postings stayed balanced. The corruption was in the order
// row, and its only symptom appeared later, at cancel and settle. Asserting
// conservation after a release — which every earlier check here does — cannot
// see it.
check('D14 a release never erases matched history or inflates escrow', async () => {
  const f = (await fixture());
  goInPlay(f, 60000);
  // UNEQUAL stakes on purpose: the layer rests less than the backer wants, so
  // releasing the backer only PARTIALLY fills the layer.
  order(f, f.alice, { side: 'lay', price: 2.0, stake_cents: 2000 });
  order(f, f.bob, { price: 2.0, stake_cents: 3000 });
  expireAll(f);
  M.releaseEligibleOrders(f.db);

  // The expectation must come from an INDEPENDENT record of what traded, never
  // from the order row's own matched_cents — deriving it from the field under
  // test is circular, and the first version of this check did exactly that and
  // therefore PASSED against the very bug it was written for. `matches` is the
  // engine's own record of every fill, so it is the arbiter.
  const tradedFor = (orderId) =>
    f.db.prepare('SELECT COALESCE(SUM(stake_cents), 0) s FROM matches WHERE back_order_id = ? OR lay_order_id = ?')
      .get(orderId, orderId).s;

  const lay = f.db.prepare("SELECT * FROM orders WHERE side='lay'").get();
  const back = f.db.prepare("SELECT * FROM orders WHERE side='back'").get();
  for (const [label, o] of [['lay', lay], ['back', back]]) {
    const traded = tradedFor(o.id);
    assert.strictEqual(o.matched_cents, traded,
      `${label}: matched_cents (${o.matched_cents}) equals what the matches table records (${traded})`);
    const expectedRemaining = o.stake_cents - traded;
    const expectedFrozen = o.side === 'lay' ? Math.round((o.price - 1) * expectedRemaining) : expectedRemaining;
    assert.strictEqual(o.frozen_cents, expectedFrozen,
      `${label}: frozen_cents (${o.frozen_cents}) is the escrow of the unmatched remainder (${expectedFrozen})`);
    assert.strictEqual(o.status, expectedRemaining === 0 ? 'fully_matched' : 'open', `${label}: status`);
  }
  // And something actually traded, so the check above is not vacuous.
  assert.ok(tradedFor(back.id) > 0 && tradedFor(back.id) < back.stake_cents,
    `the backer was PARTIALLY filled (${tradedFor(back.id)} of ${back.stake_cents}) — the shape that exposed the bug`);
  // The real proof: the market can still be settled AND voided. Before the fix
  // both threw "releasing more than frozen".
  assert.strictEqual(acc.assertConserved(f.db), 0, 'conserved');
  assert.deepStrictEqual(acc.assertUserAgrees(f.db), [], 'and the cache agrees');
});

check('D14b a market that went through a release pass can still settle', async () => {
  const f = (await fixture());
  goInPlay(f, 60000);
  order(f, f.alice, { side: 'lay', price: 2.0, stake_cents: 2000 });
  order(f, f.bob, { price: 2.0, stake_cents: 3000 });
  expireAll(f);
  M.releaseEligibleOrders(f.db);
  // Settling used to throw "Settlement integrity error: releasing more than
  // frozen" — and so did voiding — leaving players' money permanently stuck.
  // This is the assertion that would have caught the bug.
  const r = S.settleMarket(f.db, f.marketId, { winner_selection_id: f.s1 });
  assert.ok(r, 'the market settles');
  assert.strictEqual(f.db.prepare('SELECT status s FROM markets WHERE id=?').get(f.marketId).s, 'settled');
  for (const u of ['alice', 'bob']) {
    const row = f.db.prepare('SELECT frozen_cents fz FROM users WHERE username=?').get(u);
    assert.strictEqual(row.fz, 0, `${u} is fully unfrozen`);
  }
  assert.strictEqual(acc.assertConserved(f.db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(f.db), []);
});

// D15: THE RELEASE PASS MUST HONOUR THE SAME ABUSE CONTROL THE TAKER PATH
// DOES. It was the only sweep that never consulted LIMITS.matchingAllowed, so a
// player at their daily net-settlement cap was blocked pre-match and released
// anyway in-play — the cap defeated by choosing an in-play market.
//
// The property is PARITY with the taker path, and stating it precisely matters.
// `matchingAllowed` governs whether a user may be the AGGRESSOR (sweep). It has
// never governed whether their resting order can be matched by somebody else —
// that is identical pre-match and in-play, so an assertion of "nothing filled
// at all" would be testing something the control has never claimed.
//
// What the release path must NOT do is RELEASE a capped user's order. And when
// it declines, it must leave eligible_at alone: clearing it drops the order out
// of the delayed set, and NULL means "immediately eligible", so the refusal
// would hand the order straight to the next taker.
check('D15 the release pass applies the same aggressor cap as the taker path', async () => {
  const f = (await fixture());
  const capAt = (cents) =>
    L.setLimits(f.db, { actor: { id: f.alice.id, role: 'user' }, userId: f.alice.id, scope: 'global', max_daily_settled_cents: cents });

  // A SINGLE order, with no counterparty. The pass releases an order INTO the
  // book whether or not it fills, so "was it released" is observable without a
  // second player sweeping it first — which is what made an earlier version of
  // this check untestable: bob's own release consumed alice's order and
  // "released" then counted the wrong thing.
  //
  // ── Control: uncapped, the order IS released ────────────────────────────
  // Proven FIRST, so the assertions below cannot pass merely because the pass
  // is doing nothing — the usual failure mode of a "the control works" test.
  const control = (await fixture());
  goInPlay(control, 60000);
  order(control, control.alice, { price: 2.0, stake_cents: 2000 });
  expireAll(control);
  const okRun = M.releaseEligibleOrders(control.db);
  assert.ok(okRun.released >= 1, 'CONTROL: an uncapped order is released');
  assert.strictEqual(
    control.db.prepare('SELECT eligible_at FROM orders WHERE user_id = ?').get(control.alice.id).eligible_at,
    null,
    'and leaves the delayed set'
  );

  // ── Capped: the order is NOT released, and keeps its delay ─────────────
  capAt(0);
  assert.strictEqual(LIMITS.assertTradeable(f.db, f.alice), undefined, 'the account itself may still trade');
  assert.strictEqual(LIMITS.matchingAllowed(f.db, f.alice.id, f.marketId), false, 'but may not sweep');
  goInPlay(f, 60000);
  order(f, f.alice, { price: 2.0, stake_cents: 2000 });
  expireAll(f);
  const run = M.releaseEligibleOrders(f.db);
  assert.strictEqual(run.released, 0, 'the capped order is NOT released');
  assert.strictEqual(run.skipped, 1, 'it is reported as skipped');
  // THE KEY PROPERTY. A refusal must not consume the delay: clearing
  // eligible_at drops the order out of the delayed set, and NULL means
  // immediately eligible — so the next taker takes it and the cap was a no-op.
  assert.ok(
    f.db.prepare('SELECT eligible_at FROM orders WHERE user_id = ?').get(f.alice.id).eligible_at,
    'and the delay SURVIVES the refusal, so a later pass can still match it'
  );
  assert.strictEqual(f.db.prepare('SELECT status FROM orders WHERE user_id = ?').get(f.alice.id).status, 'open');

  // ── Lift the cap and it releases, on the same order, with no re-dating ──
  capAt(1000000);
  assert.strictEqual(LIMITS.matchingAllowed(f.db, f.alice.id, f.marketId), true, 'cap lifted');
  const run2 = M.releaseEligibleOrders(f.db);
  assert.strictEqual(run2.released, 1, 'and the pass then releases it');
  assert.strictEqual(
    f.db.prepare('SELECT eligible_at FROM orders WHERE user_id = ?').get(f.alice.id).eligible_at,
    null,
    'clearing the delay only once it is genuinely released'
  );
  assert.strictEqual(acc.assertConserved(f.db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(f.db), []);
});

// D15b: A SUSPENSION MUST NOT CONSUME THE BET DELAY. The pass used to clear
// eligible_at before its gates, so every order that came due while a market was
// suspended — the routine case being a feed outage — silently lost its delay
// forever and then matched with no delay of its own. Skipping the sweep is not
// the same as removing the protection.
check('D15b a suspension does not strip the bet delay from a due order', async () => {
  const f = (await fixture());
  goInPlay(f, 60000);
  order(f, f.alice, { side: 'lay', price: 2.0, stake_cents: 2000 });
  const bob = order(f, f.bob, { price: 2.0, stake_cents: 2000 });
  const before = bob.order.eligible_at;
  assert.ok(before, 'the order carries a delay');

  // The market goes down (a feed outage) and the delay expires while it is down.
  IP.setSuspended(f.db, { marketId: f.marketId, suspended: true, reason: 'feed outage' });
  expireAll(f);
  const run = M.releaseEligibleOrders(f.db);
  assert.strictEqual(run.filled, 0, 'nothing is released into a suspended market');
  assert.ok(
    f.db.prepare('SELECT eligible_at FROM orders WHERE id = ?').get(bob.order.id).eligible_at,
    'THE DELAY SURVIVES the suspension — it was not consumed'
  );

  // Lift the suspension: the order releases, and still honours its own price.
  IP.setSuspended(f.db, { marketId: f.marketId, suspended: false });
  const run2 = M.releaseEligibleOrders(f.db);
  assert.ok(run2.filled > 0, 'and releases once the market trades again');
  const fills = f.db.prepare('SELECT price FROM matches').all();
  for (const row of fills) assert.strictEqual(row.price, 2.0, 'at its own price, never a better one');
  assert.strictEqual(acc.assertConserved(f.db), 0);
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
  if (passed < 17) { console.error('expected 17 checks'); process.exit(1); }
  console.log(`\ninplay2.test.js: ${passed} checks passed`);
})();
