// amend.test.js — the order lifecycle beyond place/fill/cancel (#97).
// Run: node tests/amend.test.js   (plain assert, no deps)
//
// WHAT THIS FILE IS FOR. Before #97 the lifecycle was place -> fill -> cancel,
// which left three things a professional workflow cannot do: change a resting
// order, cancel more than one at a time, and say how long the venue should keep
// it. Each is built here and each is proved the hard way, because each of the
// three is a place where the obvious implementation is wrong in a way no green
// bar would catch:
//
//   * an amend that re-inserts the order keeps working and silently demotes it
//     behind everyone at that price, because `id` IS the queue position;
//   * a second escrow formula drifts from the first by a cent at exactly the
//     stakes E14/E15/E17/E18 were written for;
//   * a bulk cancel that interpolates its list, or that refuses the batch when
//     one id is unusable, is the #29 shape with a different payload.
//
// The house rules this file follows, because they are the ones this repository
// has already been bitten by: assert the PRE-STATE before every action so no
// check can pass against code that does nothing; put the CONTROL beside every
// result so "nothing happened" and "the right thing happened" cannot look the
// same; and never weaken an assertion elsewhere to make one here pass.
'use strict';

// scrypt cost: this suite creates many accounts and pays the hash once per
// account, but asserts NOTHING about the stored hash format. auth.test.js
// runs at the real default (SCRYPT_N=65536) and owns that coverage.
process.env.SCRYPT_N = '16384';
// Hermeticity: pin the money knobs before anything loads lib/config, so an
// ambient .env can never change what these examples assert. These are the SAME
// values tests/match.test.js pins, deliberately — an amend's escrow has to be
// arithmetically the same arithmetic that suite already trusts.
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.FAUCET_MAX_CENTS = '100000';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const L = require('../lib/limits');
const IP = require('../lib/inplay');
const BV = require('../lib/bookversion');
const S = require('../lib/settle');
const acc = require('../lib/accounts');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

let evCounter = 0;

/** A fresh venue: one market, two runners, five funded players. */
async function fresh() {
  const db = openStore(':memory:');
  const mk = async (name) => A.registerUser(db, { username: name, password: 'secret1', balance_cents: 1000000 });
  let sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  if (!sport) {
    db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
    sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  }
  evCounter++;
  const evName = `Amend Event ${evCounter}`;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now', '+2 hours'))").run(sport.id, evName);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(evName);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const market_id = db.prepare('SELECT id FROM markets WHERE event_id = ?').get(ev.id).id;
  const ids = {};
  for (const [name, fair] of [['Alpha', 2.0], ['Beta', 2.2]]) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(market_id, name, fair);
    ids[name] = db.prepare('SELECT id FROM selections WHERE market_id = ? AND name = ?').get(market_id, name).id;
  }
  return {
    db,
    market_id,
    s1: ids.Alpha,
    s2: ids.Beta,
    users: {
      alice: await mk('alice'), bob: await mk('bob'), carol: await mk('carol'),
      dave: await mk('dave'), erin: await mk('erin'),
    },
  };
}

// ── Read helpers, all of which assert something about state a check then
// changes. Each one is here so no check has to reach into a column by hand and
// none of them can be quietly wrong in a way that makes its assertion vacuous.
const balances = (db, id) => {
  const r = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(id);
  return { b: r.b, f: r.f };
};
const row = (db, id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const frozenCol = (db, id) => row(db, id).frozen_cents;
const orderOf = (db, id) => {
  const r = row(db, id);
  return { matched: r.matched_cents, status: r.status, stake: r.stake_cents, price: r.price };
};
// The player's own transaction trail, minus the opening balance. This is the
// MONEY audit trail — audit_log is the operator-authority trail, and a player's
// own order lifecycle is recorded here by lib/ledger.js, in the same
// transaction as the movement, exactly as cancelOrderTx's release is.
const txsOf = (db, id) =>
  db.prepare("SELECT type, amount_cents a FROM transactions WHERE user_id = ? AND type != 'opening' ORDER BY id")
    .all(id)
    .map((r) => ({ type: r.type, a: r.a }));
const matchesFor = (db, marketId) =>
  db.prepare('SELECT price, stake_cents s, back_order_id b, lay_order_id l FROM matches WHERE market_id = ? ORDER BY id')
    .all(marketId)
    .map((r) => ({ price: r.price, stake: r.s, back: r.b, lay: r.l }));

/**
 * THE ESCROW IDENTITY, asserted rather than assumed.
 *
 * For one user: the wallet holds exactly (a) what this user's OPEN orders hold
 * as remainder escrow, plus (b) the settlement liability of everything they have
 * matched. That is the contract at the top of lib/match.js, and every check
 * that moves escrow here asserts it, because a cent that breaks it is a cent
 * settlement can neither release (it throws "releasing more than frozen") nor
 * hand back (it is stranded forever).
 */
function escrowIdentity(db, userId) {
  const held = balances(db, userId).f;
  const remainder = db
    .prepare("SELECT COALESCE(SUM(frozen_cents), 0) s FROM orders WHERE user_id = ? AND status = 'open'")
    .get(userId).s;
  // A match is counted once, on the leg belonging to this user: a backer's
  // liability is the matched stake, a layer's is round((price - 1) * stake).
  const matched = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN bo.user_id = ? THEN mt.stake_cents
                                ELSE CAST(ROUND((mt.price - 1) * mt.stake_cents) AS INTEGER) END), 0) s
         FROM matches mt
         JOIN orders bo ON bo.id = mt.back_order_id
         JOIN orders lo ON lo.id = mt.lay_order_id
        WHERE (bo.user_id = ? OR lo.user_id = ?)`
    )
    .get(userId, userId, userId).s;
  assert.strictEqual(
    held,
    remainder + matched,
    `escrow identity broken for user ${userId}: wallet holds ${held}, open remainder ${remainder}, matched liability ${matched}`
  );
  return { held, remainder, matched };
}

/** Books still balance, and every wallet still agrees with its postings. */
function assertVenueIntact(db) {
  assert.strictEqual(acc.assertConserved(db), 0, 'the ledger is not conserved');
  assert.deepStrictEqual(acc.assertUserAgrees(db), [], 'a wallet disagrees with its postings');
}

/** Turn a market in-play and open it for trading again (kick-off suspension). */
function goInPlay(db, marketId, delayMs = 0) {
  IP.setInplay(db, { marketId, inplay: true, delayMs });
  IP.releaseKickoffSuspension(db, marketId);
}

// ── A. Amend ────────────────────────────────────────────────────────────────

// A1: the baseline. A BACK sized down, same price. Pre-state first, then the
// delta, then the ledger row that proves the movement was REAL and not an
// arithmetic identity (an implementation that simply recomputed the column
// would leave the player's money frozen with nothing to show for it).
check('A1 amend size down on a resting BACK releases exactly the delta and keeps the order id', async () => {
  const { db, s1, users } = await fresh();
  const placed = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }).order;

  // ── PRE-STATE. Without these, "released 6000" is consistent with a run that
  // released nothing at all and happened to start from a different number.
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 10000 }, 'the stake is escrowed at placement');
  assert.strictEqual(frozenCol(db, placed.id), 10000, 'the order tracks it as remainder escrow');
  assert.deepStrictEqual(txsOf(db, users.alice.id), [{ type: 'escrow', a: 10000 }], 'and nothing else has moved yet');

  const res = M.amendOrder(db, users.alice, placed.id, { stake_cents: 4000 });

  assert.strictEqual(res.order.id, placed.id, 'THE ORDER ID IS UNCHANGED — id IS the queue position');
  assert.strictEqual(res.order.price, 2.0, 'and the price is untouched');
  assert.strictEqual(res.order.stake_cents, 4000);
  assert.strictEqual(res.size_changed, true);
  assert.strictEqual(res.price_changed, false);
  assert.strictEqual(res.escrow_delta_cents, -6000, 'signed: the venue gave collateral back');
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 4000 }, 'exactly 6000 came back');
  assert.strictEqual(frozenCol(db, placed.id), 4000, 'and the order tracks the new remainder');
  assert.deepStrictEqual(
    txsOf(db, users.alice.id),
    [{ type: 'escrow', a: 10000 }, { type: 'release', a: 6000 }],
    'ONE release of exactly the delta — not a release plus a fresh escrow'
  );
  escrowIdentity(db, users.alice.id);
  assertVenueIntact(db);
});

// A2: the other direction, on the same side, so the sign convention is pinned
// from both ends. An implementation with the sign inverted passes A1 and
// destroys the player's balance here.
check('A2 amend size up on a resting BACK escrows exactly the delta', async () => {
  const { db, s1, users } = await fresh();
  const placed = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 4000 }).order;
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 4000 }, 'pre-state: 4000 frozen');

  const res = M.amendOrder(db, users.alice, placed.id, { stake_cents: 10000 });

  assert.strictEqual(res.escrow_delta_cents, 6000, 'signed: the venue took MORE collateral');
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 10000 });
  assert.strictEqual(frozenCol(db, placed.id), 10000);
  assert.deepStrictEqual(
    txsOf(db, users.alice.id),
    [{ type: 'escrow', a: 4000 }, { type: 'escrow', a: 6000 }],
    'ONE escrow of exactly the delta'
  );
  escrowIdentity(db, users.alice.id);
  assertVenueIntact(db);
});

// A3: the LAY side, where escrow is a liability rather than a stake, in both
// directions, at one amendment each. The expected figures are computed here by
// hand rather than by calling escrowFor, because a test that calls the
// implementation's own formula proves only that it is self-consistent.
check('A3 amend price on a resting LAY: the target is (price - 1) * remainder, both directions', async () => {
  const { db, s1, users } = await fresh();
  // Up: 10000 @ 2.00 froze round(1.00 * 10000) = 10000.
  const up = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 }).order;
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 1000000, f: 10000 }, 'pre-state for the increase');
  const r1 = M.amendOrder(db, users.bob, up.id, { price: 2.5 });
  assert.strictEqual(r1.price_changed, true);
  assert.strictEqual(r1.size_changed, false);
  // round(1.50 * 10000) = 15000, so the venue takes exactly 5000 more.
  assert.strictEqual(r1.escrow_delta_cents, 5000, 'lay liability follows the NEW price');
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 1000000, f: 15000 });
  assert.strictEqual(frozenCol(db, up.id), 15000);
  assert.strictEqual(r1.order.id, up.id, 'the id survives a price change too');
  escrowIdentity(db, users.bob.id);

  // Down: 15000 back to round(1.00 * 10000) = 10000, so exactly 5000 released.
  const r2 = M.amendOrder(db, users.bob, up.id, { price: 2.0 });
  assert.strictEqual(r2.escrow_delta_cents, -5000, 'and back down by the same amount');
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 1000000, f: 10000 });
  assert.strictEqual(frozenCol(db, up.id), 10000);
  assert.deepStrictEqual(
    txsOf(db, users.bob.id),
    [{ type: 'escrow', a: 10000 }, { type: 'escrow', a: 5000 }, { type: 'release', a: 5000 }],
    'no movement at all on the parts that did not change'
  );
  escrowIdentity(db, users.bob.id);
  assertVenueIntact(db);
});

// A4: THE HARD CASE. An order that is already partly matched.
//
// An amend may only touch the UNMATCHED remainder. Two things can go wrong and
// neither shows up on a fully resting order: charging the amend for a fill
// liability it did not incur (so the matched part's collateral is released), and
// forgetting that the remainder shrank when the total stake shrank. This asserts
// matched_cents is untouched, the matched liability is still held, and the
// release is exactly the difference in REMAINDER.
check('A4 a PARTIALLY matched order can be amended and the matched part\'s collateral is untouched', async () => {
  const { db, market_id, s1, s2, users } = await fresh();
  const back = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }).order;
  const layer = M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 4000 }).order; // fills 4000

  // ── PRE-STATE: 4000 matched, 6000 remainder, 10000 held (4000 pot + 6000).
  assert.deepStrictEqual(orderOf(db, back.id), { matched: 4000, status: 'open', stake: 10000, price: 2.0 });
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 10000 });
  assert.strictEqual(frozenCol(db, back.id), 6000, 'the COLUMN tracks the remainder only');
  assert.deepStrictEqual(escrowIdentity(db, users.alice.id), { held: 10000, remainder: 6000, matched: 4000 });

  // Shrink the total stake to 8000: the remainder becomes 4000, so 2000 comes
  // back — and the 4000 matched stake stays exactly where it is.
  const res = M.amendOrder(db, users.alice, back.id, { stake_cents: 8000 });
  assert.strictEqual(res.escrow_delta_cents, -2000, 'the delta is the REMAINDER difference, not the total');
  assert.strictEqual(res.order.matched_cents, 4000, 'the matched amount is untouched');
  assert.strictEqual(frozenCol(db, back.id), 4000);
  assert.deepStrictEqual(
    escrowIdentity(db, users.alice.id),
    { held: 8000, remainder: 4000, matched: 4000 },
    'the matched stake is still held, and the remainder is exactly what is left'
  );
  assert.deepStrictEqual(matchesFor(db, market_id), [{ price: 2.0, stake: 4000, back: back.id, lay: layer.id }], 'the amend did not touch the existing trade');
  // …and a settle must still be possible, which it could not be if the amend had
  // eaten the matched collateral.
  S.settleMarket(db, market_id, { winner_selection_id: s2 });
  assert.strictEqual(balances(db, users.alice.id).f, 0, 'settlement released the matched collateral');
  assert.strictEqual(frozenCol(db, back.id), 0, 'and the cancelled remainder released its own');
  assertVenueIntact(db);
});

// A5: THE ROUNDING BATTERY, and the reason the issue insists the amend reuse
// the partial-fill path rather than introduce a second implementation.
//
// Three figures that a naive "recompute from the new total" gets wrong:
//
//   1. lay 150 @ 1.04 froze round(0.04 * 150) = 6. Amended to 1.05 the target is
//      round(0.05 * 150) = round(7.5) = 8 — Math.round rounds .5 UP, so 8 and
//      not 7. A floor-based target would freeze 7 and strand a cent at
//      settlement forever.
//   2. A lay whose remainder already went through the documented 1-cent
//      TOP-UP (E17/E18) carries a remainder escrow that is exactly
//      escrowFor(side, price, remainder). Amending its SIZE up must target that
//      formula on the NEW remainder — and must NOT re-add the matched part's
//      liability, which is already held.
//   3. The same order amended DOWN in price: the target lands on a value where
//      round() and floor() disagree again, and the release is the difference.
check('A5 the E14/E17/E18 1-cent rounding cases survive an amend, in both directions', async () => {
  const { db, s1, users } = await fresh();

  // ── Case 1: lay 150 @ 1.04 -> 1.05. round(7.5) = 8, floor would say 7.
  const one = M.placeOrder(db, users.alice, { selection_id: s1, side: 'lay', price: 1.04, stake_cents: 150 }).order;
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 6 }, 'pre-state: round(0.04 * 150) = 6');
  const r1 = M.amendOrder(db, users.alice, one.id, { price: 1.05 });
  assert.strictEqual(r1.escrow_delta_cents, 2, '6 -> 8 is exactly two cents, and 8 is the .5-UP rounding');
  assert.strictEqual(frozenCol(db, one.id), 8);
  assert.strictEqual(balances(db, users.alice.id).f, 8);
  escrowIdentity(db, users.alice.id);

  // ── Case 2: the E18 shape. dave's lay 100 @ 2.00 rests higher, so carol's
  // lay 100 @ 1.51 is left with exactly a 50-fill from alice's back 150 — which
  // is the case where the engine has to TOP UP one cent at fill time.
  M.placeOrder(db, users.dave, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 100 });
  const two = M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 1.51, stake_cents: 100 }).order;
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.51, stake_cents: 150 });

  // PRE-STATE, straight out of E18: 50 matched, remainder 50, and the wallet
  // holds 52 = 26 of matched liability + 26 of remainder escrow.
  assert.deepStrictEqual(txsOf(db, users.carol.id), [{ type: 'escrow', a: 51 }, { type: 'escrow', a: 1 }], 'the 1-cent top-up happened');
  assert.strictEqual(frozenCol(db, two.id), 26, 'remainder escrow is round(0.51 * 50) = 26');
  assert.deepStrictEqual(balances(db, users.carol.id), { b: 1000000, f: 52 });
  assert.deepStrictEqual(escrowIdentity(db, users.carol.id), { held: 52, remainder: 26, matched: 26 });

  // Grow the total stake to 200: the remainder becomes 150, target
  // round(0.51 * 150) = round(76.5) = 77 — again .5 UP. The delta is measured
  // from the ORDER COLUMN (26), not from the wallet (52), so the 26 already
  // held for the match is not counted twice.
  const r2 = M.amendOrder(db, users.carol, two.id, { stake_cents: 200 });
  assert.strictEqual(r2.escrow_delta_cents, 51, '77 - 26; the matched liability is not part of the delta');
  assert.strictEqual(frozenCol(db, two.id), 77);
  assert.strictEqual(r2.order.matched_cents, 50, 'still 50 matched');
  assert.deepStrictEqual(escrowIdentity(db, users.carol.id), { held: 103, remainder: 77, matched: 26 });

  // ── Case 3: back DOWN in price at the original size. Remainder 50, target
  // round(0.02 * 50) = 1, so the release is 77 - 1 = 76.
  const r3 = M.amendOrder(db, users.carol, two.id, { price: 1.02, stake_cents: 100 });
  assert.strictEqual(r3.escrow_delta_cents, -76, '1 - 77');
  assert.strictEqual(frozenCol(db, two.id), 1, 'round(0.02 * 50) = 1');
  assert.deepStrictEqual(escrowIdentity(db, users.carol.id), { held: 27, remainder: 1, matched: 26 });

  // Cancel, then settle: every cent comes back and the books balance. This is
  // the end-to-end proof that an amend did not strand anything — the failure
  // mode E27 documents, where a cent is either unreleasable or unreturnable.
  M.cancelOrder(db, users.carol, two.id);
  assert.strictEqual(frozenCol(db, two.id), 0);
  assert.deepStrictEqual(escrowIdentity(db, users.carol.id), { held: 26, remainder: 0, matched: 26 }, 'only the matched liability is left');
  assertVenueIntact(db);
});

// A6: THE HEADLINE. Amending SIZE at an UNCHANGED price keeps the queue
// position, and the way that is proven is the only way it can be: a LATER
// arriving order at the SAME price, and a taker who takes them both.
//
// `id` IS the queue position in this engine (`ORDER BY price, id`, E13/E20), so
// an implementation that cancels and re-places behind the amend's back — or that
// re-inserts the row — keeps every other assertion in this suite green while
// demoting the trader behind the order that arrived after them. The assertion
// that catches it is the ORDER OF THE MATCH ROWS.
check('A6 an unchanged-price amend PRESERVES queue position, against a later-arriving order', async () => {
  const { db, market_id, s1, users } = await fresh();
  // bob rests first, carol second. Both LAY at 2.00 on the same selection.
  const bobOrder = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 4000 }).order;
  const carolOrder = M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 4000 }).order;

  // ── PRE-STATE. Both resting, neither matched, bob genuinely the older one.
  assert.ok(bobOrder.id < carolOrder.id, 'precondition: bob rested first');
  assert.deepStrictEqual(orderOf(db, bobOrder.id), { matched: 0, status: 'open', stake: 4000, price: 2.0 });
  assert.deepStrictEqual(orderOf(db, carolOrder.id), { matched: 0, status: 'open', stake: 4000, price: 2.0 });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 1000000, f: 4000 });

  // bob resizes 4000 -> 1000 at the SAME price. This is the operation the whole
  // feature exists for: a market maker adjusting size, not improving price.
  const res = M.amendOrder(db, users.bob, bobOrder.id, { stake_cents: 1000 });
  assert.strictEqual(res.order.id, bobOrder.id, 'the id is preserved');
  assert.strictEqual(res.order.price, 2.0, 'and the price is unchanged');
  assert.strictEqual(res.escrow_delta_cents, -3000);

  // dave takes 2000. FIFO within the level, best price equal, tiebreak on id.
  M.placeOrder(db, users.dave, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 2000 });

  const fills = matchesFor(db, market_id);
  assert.strictEqual(fills.length, 2, 'the taker was filled twice — one from each level member');
  assert.deepStrictEqual(
    fills.map((f) => f.lay),
    [bobOrder.id, carolOrder.id],
    'THE ORDER THAT RESTED FIRST IS FILLED FIRST, despite being halved afterwards'
  );
  assert.deepStrictEqual(fills.map((f) => f.stake), [1000, 1000], 'bob\'s amended size is what dave took');
  // Bob is DONE. If the amend had been ignored his order would still be 4000 and
  // the first fill would be 4000 — so this also proves the amend took effect.
  assert.deepStrictEqual(orderOf(db, bobOrder.id), { matched: 1000, status: 'fully_matched', stake: 1000, price: 2.0 });
  assert.deepStrictEqual(orderOf(db, carolOrder.id), { matched: 1000, status: 'open', stake: 4000, price: 2.0 });
  // Escrow: bob's 1000 is now a matched liability and stays held; carol keeps
  // 3000 of remainder on top of her 1000 matched liability.
  assert.deepStrictEqual(escrowIdentity(db, users.bob.id), { held: 1000, remainder: 0, matched: 1000 });
  assert.deepStrictEqual(escrowIdentity(db, users.carol.id), { held: 4000, remainder: 3000, matched: 1000 });
  escrowIdentity(db, users.dave.id);
  assertVenueIntact(db);
});

// A7: THE CONTROL for A6, and the reason A6 is not vacuous.
//
// The same book, the same taker, the same size change — expressed the only way
// this venue could express it before #97, cancel-and-replace. bob's new order
// gets a HIGHER id than carol's, so carol wins the level. If this control ever
// produced the same answer as A6, then A6 would not be measuring queue position
// at all, and the whole test would be decoration.
check('A7 the control: cancel-and-replace at the same price LOSES the queue position', async () => {
  const { db, market_id, s1, users } = await fresh();
  const bobOrder = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 4000 }).order;
  const carolOrder = M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 4000 }).order;

  // The old way: cancel, then place again at the same price.
  M.cancelOrder(db, users.bob, bobOrder.id);
  const replaced = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 1000 }).order;
  assert.ok(replaced.id > carolOrder.id, 'precondition: the replacement is the YOUNGEST order in the level');

  M.placeOrder(db, users.dave, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 2000 });

  const fills = matchesFor(db, market_id);
  assert.deepStrictEqual(
    fills.map((f) => f.lay),
    [carolOrder.id],
    'carol — who arrived SECOND — wins the level, and bob is demoted behind her'
  );
  assert.deepStrictEqual(fills.map((f) => f.stake), [2000], 'and takes the WHOLE taker');
  assert.deepStrictEqual(orderOf(db, carolOrder.id), { matched: 2000, status: 'open', stake: 4000, price: 2.0 });
  assert.deepStrictEqual(
    orderOf(db, replaced.id),
    { matched: 0, status: 'open', stake: 1000, price: 2.0 },
    'so bob\'s replacement is never reached — exactly what the amend exists to prevent'
  );
  assertVenueIntact(db);
});

// A8: a price amend that would CROSS the resting book is refused, and refuses
// LEAVES NOTHING. The crossing is not cosmetic: the delay-release pass runs a
// delayed resting order as a TAKER, so a crossed book is a match waiting to
// happen at a price the client never placed.
//
// The assertion that makes this non-vacuous is that a price amend which does NOT
// cross is accepted — otherwise a refuse-everything implementation passes.
check('A8 an amend that would price-cross the resting book is refused and changes nothing', async () => {
  const { db, s1, users } = await fresh();
  // carol's BACK rests at 2.00. bob's LAY has to sit BELOW it or placing it
  // would match on arrival — which is the very invariant this check defends.
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 4000 });
  const lay = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 1.5, stake_cents: 4000 }).order;
  assert.strictEqual(row(db, lay.id).status, 'open', 'precondition: it rests rather than matching');

  // PRE-STATE, so "changed nothing" can be asserted rather than assumed.
  const before = balances(db, users.bob.id);
  const beforeFrozen = frozenCol(db, lay.id);
  const beforeVersion = BV.selectionVersion(db, s1);
  assert.strictEqual(before.f, 2000, 'pre-state: round(0.5 * 4000) = 2000 held');
  assert.strictEqual(beforeFrozen, 2000);

  const e = (() => {
    try { M.amendOrder(db, users.bob, lay.id, { price: 2.0 }); return null; } catch (x) { return x; }
  })();
  assert.ok(e, 'the crossing amend must be refused');
  assert.strictEqual(e.status, 409, '409 Conflict: the request is well formed and would be fine on a different book');
  assert.strictEqual(e.details.code, 'amend_would_cross', 'with a machine-readable code a client can branch on');
  assert.deepStrictEqual(balances(db, users.bob.id), before, 'no collateral moved');
  assert.strictEqual(frozenCol(db, lay.id), beforeFrozen, 'the order is untouched');
  assert.strictEqual(row(db, lay.id).price, 1.5, 'the price is untouched');
  assert.strictEqual(BV.selectionVersion(db, s1), beforeVersion, 'and a refusal bumps no version — that is how a version control starts being routed around');

  // THE CONTROL: a price amend that does NOT cross is accepted, so the refusal
  // above is a crossing rule and not a blanket "no amends".
  const ok = M.amendOrder(db, users.bob, lay.id, { price: 1.9 });
  assert.strictEqual(ok.order.price, 1.9);
  assert.strictEqual(ok.escrow_delta_cents, 1600, 'round(0.9 * 4000) - round(0.5 * 4000) = 3600 - 2000');
  escrowIdentity(db, users.bob.id);
  assertVenueIntact(db);
});

// A9: an amend cannot rewrite history. The matched amount is already somebody
// else's exposure; an order may not be shrunk into a state that reports trades
// that never happened, and it may not be shrunk to a remainder of zero — that
// state belongs to a COUNTERPARTY.
check('A9 an amend cannot take an order below what has already matched, nor to fully matched', async () => {
  const { db, market_id, s1, users } = await fresh();
  const back = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }).order;
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 4000 });
  assert.strictEqual(row(db, back.id).matched_cents, 4000, 'precondition: 4000 matched, 6000 left');

  for (const [stake, why] of [[4000, 'exactly the matched amount — a remainder of zero'], [2000, 'below it']]) {
    const e = (() => {
      try { M.amendOrder(db, users.alice, back.id, { stake_cents: stake }); return null; } catch (x) { return x; }
    })();
    assert.ok(e, `amending to ${stake} must be refused: ${why}`);
    assert.strictEqual(e.status, 400);
  }
  assert.strictEqual(row(db, back.id).stake_cents, 10000, 'the order still says what it always said');
  assert.strictEqual(row(db, back.id).matched_cents, 4000);
  escrowIdentity(db, users.alice.id);

  // The smallest legal amend — one cent above the matched amount — is accepted.
  const ok = M.amendOrder(db, users.alice, back.id, { stake_cents: 4001 });
  assert.strictEqual(ok.order.stake_cents, 4001);
  assert.strictEqual(ok.escrow_delta_cents, -(5999), 'remainder 1 releases 5999');
  escrowIdentity(db, users.alice.id);
  assertVenueIntact(db);
});

// A10: the abuse gates apply to the amend, and — the half that is easy to get
// wrong — they apply to the DELTA. `assertPlacement` sums orders.frozen_cents
// over the user's OPEN orders, which already contains this order's old escrow,
// so the post-amend liability is current + delta. Refusing an amend that REDUCES
// risk would be a control that punishes the trader for de-risking.
check('A10 the abuse gates apply to the amend DELTA: they refuse an increase and must not refuse a decrease', async () => {
  const { db, s1, users } = await fresh();
  const o = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 4000 }).order;
  L.setLimits(db, { actor: users.alice, userId: users.alice.id, scope: L.marketScope(db.prepare('SELECT market_id FROM orders WHERE id=?').get(o.id).market_id), max_market_liability_cents: 4000 });
  assert.strictEqual(L.marketLiability(db, users.alice.id, db.prepare('SELECT market_id FROM orders WHERE id=?').get(o.id).market_id), 4000, 'precondition: the user is AT the cap');

  // Up: would take the liability to 8000 against a 4000 cap.
  const e = (() => { try { M.amendOrder(db, users.alice, o.id, { stake_cents: 8000 }); return null; } catch (x) { return x; } })();
  assert.ok(e, 'an amend past the cap must be refused');
  assert.strictEqual(e.status, 429);
  assert.strictEqual(e.details.code, 'market_liability_exceeded');
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 4000 }, 'the refusal moved no collateral');
  assert.strictEqual(row(db, o.id).stake_cents, 4000);

  // Down: the same cap, the same order, and it MUST be allowed.
  const ok = M.amendOrder(db, users.alice, o.id, { stake_cents: 2000 });
  assert.strictEqual(ok.escrow_delta_cents, -2000);
  assert.strictEqual(L.marketLiability(db, users.alice.id, db.prepare('SELECT market_id FROM orders WHERE id=?').get(o.id).market_id), 2000, 'now under the cap');
  escrowIdentity(db, users.alice.id);
  assertVenueIntact(db);
});

// A11: the book version (#92). An amend is NOT the "an order that merely rests"
// carve-out placement lives under — it changes the size another client is
// reading at a level, and possibly the price itself — so it bumps. And a change
// that moved nothing must NOT bump, because a version that moves for invisible
// reasons is a version clients learn to ignore.
check('A11 the book version moves for a price or size amend and NOT for a persistence-only amend', async () => {
  const { db, s1, users } = await fresh();
  const v0 = BV.selectionVersion(db, s1);
  const o = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 4000 }).order;
  assert.strictEqual(BV.selectionVersion(db, s1), v0, 'placing an order that merely RESTS does not bump, and did not change here');

  // A size amend: another client is reading that level's size, so it must move.
  M.amendOrder(db, users.alice, o.id, { stake_cents: 5000 });
  assert.strictEqual(BV.selectionVersion(db, s1), v0 + 1, 'a size amend bumps exactly once');

  // A persistence amend: `bookFor` does not read the column, so no reader of
  // the book can see anything change.
  M.amendOrder(db, users.alice, o.id, { persistence: 'LAPSE' });
  assert.strictEqual(BV.selectionVersion(db, s1), v0 + 1, 'a persistence-only amend bumps nothing, and says so');
  assert.strictEqual(row(db, o.id).persistence, 'LAPSE', 'but it DID change the order');

  // An amend to the values the order already has: still nothing to see.
  M.amendOrder(db, users.alice, o.id, { stake_cents: 5000 });
  assert.strictEqual(BV.selectionVersion(db, s1), v0 + 1, 'an amend that changes nothing bumps nothing');
  assert.strictEqual(BV.marketVersion(db, row(db, o.id).market_id), v0 + 1, 'and the market counter moved with the selection, exactly once');
});

// A12: the transaction guard. `placeOrderTx` has one for the same reason and the
// amend needs it MORE, because the escrow movement is the whole point: a caller
// that reached amendOrderTx bare would release collateral with no rollback point
// for anything that failed afterwards.
check('A12 amendOrderTx refuses to run outside a transaction', async () => {
  const { db, s1, users } = await fresh();
  const o = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 4000 }).order;
  const e = (() => { try { M.amendOrderTx(db, users.alice, o.id, { stake_cents: 2000 }); return null; } catch (x) { return x; } })();
  assert.ok(e, 'it must refuse rather than perform an unrecoverable mutation');
  assert.strictEqual(e.status, 500, 'a 5xx: this is an internal contract violation, not bad input');
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 4000 }, 'and it moved nothing on the way to refusing');
  assert.strictEqual(row(db, o.id).stake_cents, 4000);
});

// A13: THE STATED LIMITATION, pinned by a test rather than left to a comment.
//
// An amend to a NEW price keeps the order's id, and `id` is the tiebreak within
// the new level — so an order amended INTO a price can sit ahead of orders that
// rested there longer. That is what "keep the id" means, it is not a claim of
// Betfair parity, and it is the opposite of what a cancel-and-replace would do
// (which would put the order behind everyone, see A7). It is pinned here so
// that a future change to the tiebreak cannot happen by accident: this venue's
// documented behaviour is "an amended order is not re-queued".
check('A13 an amend to a NEW price keeps the order id, so it joins that level ahead of orders that rested there longer', async () => {
  const { db, market_id, s1, users } = await fresh();
  // bob lays 4.00 and rests FIRST, so his id is the LOWER one.
  const bobOrder = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 4.0, stake_cents: 2000 }).order;
  // carol lays 3.00 and rests SECOND, in the level bob is about to move into.
  const carolOrder = M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 3.0, stake_cents: 2000 }).order;
  assert.ok(bobOrder.id < carolOrder.id, 'precondition: bob has the lower id, so keeping it is what decides the level');
  const res = M.amendOrder(db, users.bob, bobOrder.id, { price: 3.0 });
  assert.strictEqual(res.order.id, bobOrder.id);
  assert.strictEqual(res.order.price, 3.0);
  assert.strictEqual(res.escrow_delta_cents, -2000, 'round(2*2000) - round(3*2000) = 4000 - 6000');

  M.placeOrder(db, users.dave, { selection_id: s1, side: 'back', price: 3.0, stake_cents: 3000 });
  const fills = matchesFor(db, market_id);
  assert.deepStrictEqual(
    fills.map((f) => f.lay),
    [bobOrder.id, carolOrder.id],
    'the amended order keeps its id, so it takes priority at the price it moved to'
  );
  assert.deepStrictEqual(fills.map((f) => f.price), [3.0, 3.0], 'and the trade happens at the resting price, never at the price it came from');
  assert.deepStrictEqual(fills.map((f) => f.stake), [2000, 1000]);
  escrowIdentity(db, users.bob.id);
  escrowIdentity(db, users.carol.id);
  escrowIdentity(db, users.dave.id);
  assertVenueIntact(db);
});

// A14: a request that asks for nothing is refused rather than answered 200. A
// 200 that changed nothing teaches a client the venue heard it without telling
// it whether anything happened, which is how a stale client comes to believe it
// is hedged when it is not.
check('A14 a no-op amend is refused, and terminal orders are refused with their own reasons', async () => {
  const { db, s1, users } = await fresh();
  const live = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 4000 }).order;

  const nothing = (() => { try { M.amendOrder(db, users.alice, live.id, {}); return null; } catch (x) { return x; } })();
  assert.ok(nothing, 'an empty body is not an amend');
  assert.strictEqual(nothing.status, 400);
  assert.match(nothing.message, /Nothing to amend/);

  // Re-sending the values the order already has IS an amend — it is idempotent,
  // moves no money and bumps nothing (A11). That is different from sending
  // nothing at all, and the difference is deliberate.
  const same = M.amendOrder(db, users.alice, live.id, { stake_cents: 4000 });
  assert.strictEqual(same.escrow_delta_cents, 0);
  assert.strictEqual(same.size_changed, false);

  const done = M.placeOrder(db, users.carol, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 4000 }).order;
  M.cancelOrder(db, users.carol, done.id);
  const cancelled = (() => { try { M.amendOrder(db, users.carol, done.id, { stake_cents: 2000 }); return null; } catch (x) { return x; } })();
  assert.ok(cancelled, 'a cancelled order has nothing to amend');
  assert.strictEqual(cancelled.status, 400);
  assert.match(cancelled.message, /already cancelled/);
  escrowIdentity(db, users.alice.id);
});

// A15: authorisation. An order that exists but is not yours must be
// INDISTINGUISHABLE from one that does not exist — the same 404, the same
// message — or this endpoint becomes an oracle for which ids are real on a venue
// where ids are sequential.
check('A15 an amend refuses another user\'s order exactly as it refuses one that does not exist', async () => {
  const { db, s1, users } = await fresh();
  const strangers = M.placeOrder(db, users.bob, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 4000 }).order;
  const before = balances(db, users.bob.id);

  const notYours = (() => { try { M.amendOrder(db, users.alice, strangers.id, { stake_cents: 2000 }); return null; } catch (x) { return x; } })();
  const notThere = (() => { try { M.amendOrder(db, users.alice, 999999, { stake_cents: 2000 }); return null; } catch (x) { return x; } })();
  assert.ok(notYours && notThere);
  assert.strictEqual(notYours.status, notThere.status, 'same status');
  assert.strictEqual(notYours.message, notThere.message, 'same message — no existence oracle');
  assert.deepStrictEqual(balances(db, users.bob.id), before, 'a stranger\'s collateral never moves');
  assert.strictEqual(row(db, strangers.id).stake_cents, 4000, 'nor their order');
});

// A16: the amend runs the SAME market gates a placement does. A control that
// exists on one money path and not the other is a control with a hole in it, and
// the hole is the one a client told "amend instead of re-placing" drives into.
check('A16 an amend is refused while the market is suspended, exactly as a placement is', async () => {
  const { db, s1, users } = await fresh();
  const o = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 4000 }).order;
  const marketId = row(db, o.id).market_id;

  IP.setSuspended(db, { marketId, suspended: true, reason: 'feed outage' });
  const amendErr = (() => { try { M.amendOrder(db, users.alice, o.id, { stake_cents: 2000 }); return null; } catch (x) { return x; } })();
  const placeErr = (() => { try { M.placeOrder(db, users.bob, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 4000 }); return null; } catch (x) { return x; } })();
  assert.ok(amendErr, 'the amend is refused');
  assert.ok(placeErr, 'and the placement is refused — the same gate, not a second weaker one');
  assert.strictEqual(amendErr.status, 409);
  assert.strictEqual(amendErr.details.code, 'suspended');
  assert.strictEqual(amendErr.message, placeErr.message, 'and it says the same thing a placement would');
  assert.strictEqual(row(db, o.id).stake_cents, 4000, 'nothing moved');
});

// A17: an amend must not disturb the order's BET DELAY. `eligible_at` is the
// sharp-protection control in lib/inplay.js: an order resting through a delay
// must not become instantly matchable because its owner resized it. Nothing in
// the amend writes the column, and this is what says so at the boundary rather
// than in a comment.
check('A17 an amend preserves the order\'s in-play bet delay (eligible_at)', async () => {
  const { db, market_id, s1, users } = await fresh();
  goInPlay(db, market_id, 60000);
  const delayed = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 4000 }).order;
  const before = row(db, delayed.id).eligible_at;
  assert.ok(before, 'precondition: the order is inside a bet delay');
  assert.strictEqual(delayed.delayed, true);

  const res = M.amendOrder(db, users.alice, delayed.id, { stake_cents: 8000 });
  assert.strictEqual(res.escrow_delta_cents, 4000, 'a delayed order can still be resized');
  assert.strictEqual(row(db, delayed.id).eligible_at, before, 'and its delay is UNCHANGED — resizing is not a way to skip the protection');
  assert.strictEqual(row(db, delayed.id).delayed, 1);
  // And it still has not matched: the delay is the only thing stopping it.
  assert.strictEqual(row(db, delayed.id).matched_cents, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM matches').get().n, 0);
  escrowIdentity(db, users.alice.id);
  assertVenueIntact(db);
});

// ── B. Bulk cancel ──────────────────────────────────────────────────────────

// B1: the ordinary case. A list, every id authorised, every id cancelled and
// every cent released exactly once.
check('B1 bulk cancel takes a list and cancels every id it is given', async () => {
  const { db, users } = await fresh();
  const marketId = () => 0;
  const place = (stake, price) => M.placeOrder(db, users.alice, { selection_id: 1, side: 'back', price, stake_cents: stake });
  // s1 is selection 1 in a fresh venue, but do not rely on that: read it back.
  const s1 = db.prepare("SELECT id FROM selections WHERE name = 'Alpha'").get().id;
  const orders = [1000, 2000, 3000].map((stake) => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.9, stake_cents: stake }).order);
  void place; void marketId;
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 6000 }, 'pre-state: 6000 escrowed across three orders');

  const res = M.cancelOrders(db, users.alice, orders.map((o) => o.id));

  assert.strictEqual(res.cancelled, 3);
  assert.strictEqual(res.failed, 0);
  assert.strictEqual(res.released_cents, 6000, 'exactly the tracked remainder, summed');
  assert.deepStrictEqual(res.results.map((r) => r.status), ['cancelled', 'cancelled', 'cancelled']);
  for (const o of orders) assert.strictEqual(row(db, o.id).status, 'cancelled');
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 0 }, 'nothing left in escrow');
  assert.deepStrictEqual(
    txsOf(db, users.alice.id),
    [
      { type: 'escrow', a: 1000 }, { type: 'escrow', a: 2000 }, { type: 'escrow', a: 3000 },
      { type: 'release', a: 1000 }, { type: 'release', a: 2000 }, { type: 'release', a: 3000 },
    ],
    'ONE release per order — no double release, no skipped one'
  );
  escrowIdentity(db, users.alice.id);
  assertVenueIntact(db);
});

// B2: THE ACCEPTANCE CASE. Cancelling your own thirty-nine and hitting one
// stranger's id must cancel thirty-nine and report the one.
//
// Every assertion here is against a PRE-STATE, because the failure this guards
// against is silent: an all-or-nothing refusal (nothing cancelled), a stray
// `IN (…)` that matched too much (a stranger's order gone), or a rollback that
// unwound the authorised subset. All three leave a green-looking response unless
// the escrow is checked cent by cent.
check('B2 a partial failure cancels the authorised subset and leaves the rest untouched, with escrow exactly as before the failed one', async () => {
  const { db, s1, s2, users } = await fresh();
  const mine = [
    M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 2000 }).order,
    M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.8, stake_cents: 3000 }).order,
  ];
  // bob: his own, on the OTHER runner so that alice's backs do not cross it on
  // arrival — the point of this check is authorisation, not matching, and a
  // fixture that matched on placement would be testing two things at once.
  const stranger = M.placeOrder(db, users.bob, { selection_id: s2, side: 'lay', price: 3.0, stake_cents: 7000 }).order;
  assert.strictEqual(row(db, stranger.id).status, 'open', 'precondition: it rests rather than matching');

  // PRE-STATE, cent by cent, for both players.
  const aliceBefore = balances(db, users.alice.id);
  const bobBefore = balances(db, users.bob.id);
  assert.deepStrictEqual(aliceBefore, { b: 1000000, f: 5000 }, 'alice holds 2000 + 3000');
  assert.deepStrictEqual(bobBefore, { b: 1000000, f: 14000 }, 'bob holds (3-1) * 7000');
  const aliceTxsBefore = txsOf(db, users.alice.id).length;

  // The list the issue describes: mine, a stranger's, a non-existent id, mine.
  const res = M.cancelOrders(db, users.alice, [mine[0].id, stranger.id, 999999, mine[1].id]);

  assert.strictEqual(res.cancelled, 2, 'the two authorised ids are cancelled');
  assert.strictEqual(res.failed, 2, 'and the two unusable ones are reported, not swallowed');
  assert.strictEqual(res.released_cents, 5000, 'exactly alice\'s escrow and not one cent of anybody else\'s');
  assert.deepStrictEqual(
    res.results.map((r) => [r.order_id, r.status, r.code]),
    [
      [mine[0].id, 'cancelled', 'cancelled'],
      [stranger.id, 'not_found', 'not_found'],
      [999999, 'not_found', 'not_found'],
      [mine[1].id, 'cancelled', 'cancelled'],
    ],
    'one outcome per id, in the order the client sent them'
  );

  // THE AUTHORISED SUBSET IS CANCELLED.
  for (const o of mine) {
    assert.strictEqual(row(db, o.id).status, 'cancelled');
    assert.strictEqual(row(db, o.id).frozen_cents, 0);
  }
  // THE REST IS UNTOUCHED: the stranger's order is exactly as it was.
  assert.strictEqual(row(db, stranger.id).status, 'open', 'a stranger\'s order is NEVER cancelled');
  assert.strictEqual(row(db, stranger.id).frozen_cents, 14000, 'and its escrow is intact');
  // ESCROW EXACTLY AS BEFORE THE FAILED ONE: bob's wallet did not move a cent,
  // and alice's released precisely her own two orders.
  assert.deepStrictEqual(balances(db, users.bob.id), bobBefore, 'the stranger\'s escrow is exactly as before');
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 0 }, 'alice is flat, having released exactly 5000');
  assert.strictEqual(txsOf(db, users.bob.id).length, 1, 'bob has no ledger rows beyond his own placement');
  assert.strictEqual(txsOf(db, users.alice.id).length, aliceTxsBefore + 2, 'exactly two releases, one per cancelled order');
  escrowIdentity(db, users.alice.id);
  escrowIdentity(db, users.bob.id);
  assertVenueIntact(db);
});

// B3: a stranger's order and a nonexistent id answer IDENTICALLY. A bulk
// endpoint that distinguished them would let a client map the venue's order ids
// from outside — ids are sequential — and it would be the only way this route
// leaks anything at all.
check('B3 a stranger\'s order and a nonexistent id are indistinguishable, and neither is cancelled', async () => {
  const { db, users } = await fresh();
  const s1 = db.prepare("SELECT id FROM selections WHERE name = 'Alpha'").get().id;
  const strangers = [1000, 2000].map((stake) => M.placeOrder(db, users.bob, { selection_id: s1, side: 'back', price: 1.9, stake_cents: stake }).order);
  const bobBefore = balances(db, users.bob.id);
  const before = { ids: strangers.map((o) => o.id), statuses: strangers.map((o) => row(db, o.id).status) };

  const res = M.cancelOrders(db, users.alice, [strangers[0].id, 987654, strangers[1].id]);

  assert.strictEqual(res.cancelled, 0, 'NOTHING belonging to another user is cancelled');
  assert.strictEqual(res.released_cents, 0);
  assert.deepStrictEqual(res.results.map((r) => r.status), ['not_found', 'not_found', 'not_found']);
  // Identical PAYLOADS, not merely identical statuses.
  assert.deepStrictEqual(
    res.results.map((r) => ({ order_id: r.order_id, status: r.status, code: r.code })),
    [
      { order_id: strangers[0].id, status: 'not_found', code: 'not_found' },
      { order_id: 987654, status: 'not_found', code: 'not_found' },
      { order_id: strangers[1].id, status: 'not_found', code: 'not_found' },
    ]
  );
  assert.deepStrictEqual(strangers.map((o) => row(db, o.id).status), before.statuses, 'and their orders are all still open');
  assert.deepStrictEqual(balances(db, users.bob.id), bobBefore, 'with their escrow untouched');
  void before.ids;
  escrowIdentity(db, users.bob.id);
  assertVenueIntact(db);
});

// B4: THE #29 LESSON. A list is untrusted input. The whole request is refused
// BEFORE anything is read or written, so a malformed list cannot cancel half a
// book — and no element is ever interpolated into SQL.
//
// Each case is asserted against a pre-state, because "it threw a 400" and "it
// cancelled nothing" are different claims and only the second one is the
// requirement.
check('B4 a malformed list is refused BEFORE anything is read or written', async () => {
  const { db, users } = await fresh();
  const s1 = db.prepare("SELECT id FROM selections WHERE name = 'Alpha'").get().id;
  const o = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 2000 }).order;
  // A SQL-shaped string, the #29 payload class, plus the coercion traps.
  const cases = [
    [String(o.id), /must be a JSON array/],
    [undefined, /must be a JSON array/],
    [{ ids: [o.id] }, /must be a JSON array/],
    [[], /at least one order id/],
    [[o.id, '1'], /order_ids\[1\] must be a positive integer/],
    [[o.id, 1.5], /order_ids\[1\] must be a positive integer/],
    [[o.id, true], /order_ids\[1\] must be a positive integer/],
    [[o.id, null], /order_ids\[1\] must be a positive integer/],
    [[o.id, -1], /order_ids\[1\] must be a positive integer/],
    [[o.id, "1 OR 1=1"], /order_ids\[1\] must be a positive integer/],
    // Over the cap: 201 ids. The cap is checked on the REQUEST, so nothing has
    // been touched by the time it fires.
    [new Array(201).fill(o.id), /at most 200 ids/],
  ];
  for (const [input, expected] of cases) {
    const e = (() => { try { M.cancelOrders(db, users.alice, input); return null; } catch (x) { return x; } })();
    assert.ok(e, `must refuse ${JSON.stringify(input)}`);
    assert.strictEqual(e.status, 400, `for ${JSON.stringify(input)}`);
    assert.match(e.message, expected, `for ${JSON.stringify(input)}`);
    // THE PRE-STATE, after every refusal in the loop: not one of them cancelled
    // anything or moved a cent.
    assert.strictEqual(row(db, o.id).status, 'open', `a refused list cancelled something: ${JSON.stringify(input)}`);
    assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 2000 }, `a refused list moved money: ${JSON.stringify(input)}`);
  }
  // The list still works afterwards, so the refusals did not poison anything.
  const ok = M.cancelOrders(db, users.alice, [o.id]);
  assert.strictEqual(ok.cancelled, 1);
  escrowIdentity(db, users.alice.id);
  assertVenueIntact(db);
});

// B5: the ids that ARE yours but cannot be cancelled each report their own
// reason. Reporting them as one generic failure would tell a client nothing, and
// releasing twice must be impossible — `already_cancelled` in particular is the
// case a retrying client hits, and it must not take a second bite.
check('B5 a duplicate id, an already-cancelled id and a fully matched id each report their own outcome and release nothing twice', async () => {
  const { db, s1, s2, users } = await fresh();

  const first = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 2000 }).order;
  const gone = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.8, stake_cents: 3000 }).order;
  M.cancelOrder(db, users.alice, gone.id);
  // A fully matched order — on the OTHER runner, because a lay taker sweeps the
  // LOWEST eligible backs first and would otherwise take `first` on the way past.
  const matched = M.placeOrder(db, users.alice, { selection_id: s2, side: 'back', price: 2.0, stake_cents: 4000 }).order;
  M.placeOrder(db, users.bob, { selection_id: s2, side: 'lay', price: 2.0, stake_cents: 4000 });
  assert.strictEqual(row(db, matched.id).status, 'fully_matched', 'precondition: it is fully matched');

  const before = balances(db, users.alice.id);
  const beforeTxs = txsOf(db, users.alice.id).length;
  // first TWICE in one list, plus the two unusable ones.
  const res = M.cancelOrders(db, users.alice, [first.id, first.id, gone.id, matched.id]);

  assert.deepStrictEqual(
    res.results.map((r) => [r.order_id, r.status]),
    [
      [first.id, 'cancelled'],
      [first.id, 'already_cancelled'],
      [gone.id, 'already_cancelled'],
      [matched.id, 'fully_matched'],
    ],
    'a duplicate is REPORTED, not silently dropped — a client that sent one learns it sent one'
  );
  assert.strictEqual(res.cancelled, 1);
  assert.strictEqual(res.failed, 3);
  assert.strictEqual(res.released_cents, 2000, 'and the order is released ONCE');
  assert.deepStrictEqual(balances(db, users.alice.id), { b: before.b, f: before.f - 2000 }, 'no second release');
  assert.strictEqual(txsOf(db, users.alice.id).length, beforeTxs + 1, 'exactly one new ledger row');
  escrowIdentity(db, users.alice.id);
  assertVenueIntact(db);
});

// B6: the per-order transaction, asserted rather than assumed. One order that
// cannot be cancelled MUST NOT unwind the ones that can — which is the reason
// for a transaction per id rather than one for the batch.
check('B6 one failing id does not unwind the ids around it', async () => {
  const { db, users } = await fresh();
  const s1 = db.prepare("SELECT id FROM selections WHERE name = 'Alpha'").get().id;
  const a = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 1000 }).order;
  const b = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.8, stake_cents: 2000 }).order;
  const c = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.7, stake_cents: 3000 }).order;
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 6000 }, 'pre-state: three orders, 6000 escrowed');

  // Force a mid-cancel failure on the MIDDLE id — and on no other.
  //
  // COUNTED rather than matched on SQL text or on an amount, so the injection
  // does not depend on the exact statement lib/ledger.js happens to write, and
  // so a refactor of it cannot turn this into a no-op that quietly passes. The
  // only statements that move users.frozen_cents at this point are the three
  // cancels, in list order, because nothing else in the batch touches a wallet.
  // The assertion that the injection FIRED is what keeps that promise honest.
  const originalPrepare = db.prepare.bind(db);
  let walletWrites = 0;
  let sabotaged = false;
  db.prepare = (sql, ...rest) => {
    const stmt = originalPrepare(sql, ...rest);
    if (typeof sql === 'string' && /UPDATE\s+users\s+SET[^\n]*frozen_cents/i.test(sql)) {
      return {
        run(...args) {
          walletWrites++;
          if (walletWrites === 2) { sabotaged = true; throw new Error('injected ledger failure'); }
          return stmt.run(...args);
        },
      };
    }
    return stmt;
  };

  let res;
  try {
    res = M.cancelOrders(db, users.alice, [a.id, b.id, c.id]);
  } finally {
    db.prepare = originalPrepare;
  }

  assert.ok(sabotaged, 'the injected failure actually fired — otherwise this check proves nothing');
  assert.ok(res, 'the call returns a result rather than throwing for the batch');
  assert.deepStrictEqual(
    res.results.map((r) => r.status),
    ['cancelled', 'error', 'cancelled'],
    'the middle id failed and the two around it did not'
  );
  assert.strictEqual(res.cancelled, 2);
  assert.strictEqual(res.results[1].order_id, b.id, 'the failure is reported against that id alone');
  assert.strictEqual(res.results[1].code, 'cancel_failed');
  assert.match(res.results[1].detail, /injected ledger failure/);
  assert.strictEqual(res.released_cents, 4000, 'a and c were both released; b was not');
  assert.strictEqual(row(db, a.id).status, 'cancelled');
  assert.strictEqual(row(db, c.id).status, 'cancelled');
  assert.strictEqual(row(db, b.id).status, 'open', 'the failed one is untouched — its own transaction rolled back');
  assert.strictEqual(frozenCol(db, b.id), 2000, 'and still holds its own escrow');
  escrowIdentity(db, users.alice.id);
  assertVenueIntact(db);
});

// ── C. Persistence / time in force ──────────────────────────────────────────

// C1: the default is PERSIST, and that is this venue's ENTIRE previous
// behaviour. An order that says nothing about its persistence must behave
// exactly as it did before #97 — including surviving the turn in-play, which is
// the assertion that would fail if the feature had shipped with LAPSE as the
// default and silently cancelled every resting book in the venue.
check('C1 persistence defaults to PERSIST, which is this venue\'s entire previous behaviour', async () => {
  const { db, market_id, s1, users } = await fresh();
  const o = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 4000 }).order;
  assert.strictEqual(o.persistence, 'PERSIST', 'an order that says nothing persists');
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) c FROM orders WHERE persistence != 'PERSIST'").get().c,
    0,
    'and the column\'s own DEFAULT agrees, so a pre-existing database upgraded into this feature is already correct'
  );
  // The same order, written by the OLD code path (no column supplied at all).
  const legacy = M.placeOrder(db, users.bob, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 4000 }).order;
  assert.strictEqual(legacy.persistence, 'PERSIST');

  goInPlay(db, market_id);
  const sweep = M.lapseOrders(db);
  assert.strictEqual(sweep.considered, 0, 'the sweep finds nothing to do: every order persists');
  assert.strictEqual(sweep.lapsed, 0);
  assert.strictEqual(row(db, o.id).status, 'open', 'and a default order is NOT cancelled at the turn in-play');
  escrowIdentity(db, users.alice.id);
  assertVenueIntact(db);
});

// C2: LAPSE, WITH ITS CONTROL BESIDE IT.
//
// The control is not decoration. "LAPSE cancels the order" is satisfiable by an
// implementation that cancels EVERY order in an in-play market, which would pass
// a test that only had one order in it. So the PERSIST order sits in the SAME
// market, on the SAME selection, and must survive.
check('C2 a LAPSE order is cancelled when its market turns in-play; a PERSIST order beside it is not', async () => {
  const { db, market_id, s1, users } = await fresh();
  const lapsing = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 4000, persistence: 'LAPSE' }).order;
  const persisting = M.placeOrder(db, users.bob, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 4000, persistence: 'PERSIST' }).order;
  const aliceBefore = balances(db, users.alice.id);
  assert.deepStrictEqual(aliceBefore, { b: 1000000, f: 4000 }, 'pre-state: alice has 4000 escrowed');

  // Pre-match, the sweep does nothing at all.
  assert.strictEqual(M.lapseOrders(db).lapsed, 0, 'a market that has not turned in-play is not a lapse');
  assert.strictEqual(row(db, lapsing.id).status, 'open');

  goInPlay(db, market_id);

  const sweep = M.lapseOrders(db);
  assert.strictEqual(sweep.considered, 1, 'exactly the one LAPSE order was a candidate');
  assert.strictEqual(sweep.lapsed, 1);
  assert.strictEqual(sweep.released_cents, 4000, 'and its tracked remainder came back');
  assert.deepStrictEqual(sweep.market_ids, [market_id], 'so the route knows which books changed');

  // THE LAPSE ORDER.
  assert.strictEqual(row(db, lapsing.id).status, 'cancelled');
  assert.strictEqual(row(db, lapsing.id).frozen_cents, 0);
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 1000000, f: 0 }, 'every cent back, none more');
  assert.deepStrictEqual(
    txsOf(db, users.alice.id),
    [{ type: 'escrow', a: 4000 }, { type: 'release', a: 4000 }],
    'released through the ordinary cancel funnel, so it is a real release'
  );
  // THE CONTROL, in the same market.
  assert.strictEqual(row(db, persisting.id).status, 'open', 'a PERSIST order carries in');
  assert.strictEqual(frozenCol(db, persisting.id), 4000);
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 1000000, f: 4000 }, 'and keeps its escrow');
  escrowIdentity(db, users.alice.id);
  escrowIdentity(db, users.bob.id);
  assertVenueIntact(db);
});

// C3: the sweep runs on a timer, so it will be called far more often than
// anything changes. It must be idempotent, and it must not report work it did
// not do — a pass that "lapses" 40 orders every five seconds forever would be a
// log line nobody reads and a support ticket nobody can answer.
check('C3 the lapse sweep is idempotent: a second pass considers nothing and moves nothing', async () => {
  const { db, market_id, s1, users } = await fresh();
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 4000, persistence: 'LAPSE' });
  goInPlay(db, market_id);

  const first = M.lapseOrders(db);
  assert.strictEqual(first.lapsed, 1);
  const wallet = balances(db, users.alice.id);
  const txs = txsOf(db, users.alice.id).length;

  for (let i = 0; i < 3; i++) {
    const again = M.lapseOrders(db);
    assert.strictEqual(again.considered, 0, `pass ${i + 2} has nothing to consider`);
    assert.strictEqual(again.lapsed, 0);
    assert.strictEqual(again.skipped, 0);
    assert.deepStrictEqual(again.market_ids, [], 'and reports no book change');
  }
  assert.deepStrictEqual(balances(db, users.alice.id), wallet, 'no further movement');
  assert.strictEqual(txsOf(db, users.alice.id).length, txs, 'and no further ledger rows');
  escrowIdentity(db, users.alice.id);
  assertVenueIntact(db);
});

// C4: the vocabulary is closed. A value the engine cannot carry out is refused
// at the boundary, and the DATABASE refuses it too — so an internal caller
// cannot write one either. Storing a promise and dropping it on the floor is the
// defect this repository's documentation has been written against since it
// started.
check('C4 an unknown persistence is refused and writes nothing; the database refuses MARKET_ON_CLOSE too', async () => {
  const { db, s1, users } = await fresh();
  const before = balances(db, users.alice.id);
  const countBefore = db.prepare('SELECT COUNT(*) c FROM orders').get().c;

  for (const bad of ['MARKET_ON_CLOSE', 'lapse', 'persist', 'GFD', '', 1, true, {}]) {
    const e = (() => {
      try { M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 4000, persistence: bad }); return null; } catch (x) { return x; }
    })();
    assert.ok(e, `must refuse ${JSON.stringify(bad)}`);
    assert.strictEqual(e.status, 400, `for ${JSON.stringify(bad)}`);
    assert.match(e.message, /persistence must be "LAPSE" or "PERSIST"/);
  }
  assert.deepStrictEqual(balances(db, users.alice.id), before, 'no escrow was taken by any refused placement');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders').get().c, countBefore, 'and no order row was written');
  assert.deepStrictEqual(txsOf(db, users.alice.id), [], 'the ledger is untouched');

  // And the amendment path uses the SAME closed vocabulary.
  const good = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 4000 }).order;
  const e = (() => { try { M.amendOrder(db, users.alice, good.id, { persistence: 'MARKET_ON_CLOSE' }); return null; } catch (x) { return x; } })();
  assert.ok(e, 'an amend cannot smuggle an unsupported persistence either');
  assert.strictEqual(e.status, 400);
  assert.strictEqual(row(db, good.id).persistence, 'PERSIST', 'and it changed nothing');

  // THE DATABASE, so no future internal caller can write one behind the API's back.
  const raw = (() => {
    try {
      db.prepare(
        `INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents, persistence)
         VALUES (?, ?, ?, 'back', 1.9, 1000, 'MARKET_ON_CLOSE')`
      ).run(users.alice.id, db.prepare('SELECT market_id FROM orders WHERE id=?').get(good.id).market_id, s1);
      return null;
    } catch (x) { return x; }
  })();
  assert.ok(raw, 'the CHECK constraint refuses it even from raw SQL');
  assert.match(String(raw.message), /CHECK constraint failed/);
  assertVenueIntact(db);
});

// C5 and C6: the race. See the two-child harness immediately below them.

// ── C. The sweep cannot race an arrival at the same instant ─────────────────
//
// WHY TWO OS PROCESSES AND NOT TWO CALLS. node:sqlite is SYNCHRONOUS and this
// process is single-threaded, so a second `placeOrder` cannot begin until the
// first has returned: that is a queue, not a race. The property under test is
// about a TAKER and the LAPSE SWEEP both acting on the same order at the same
// instant, and the only way to express that with the engine this repository
// actually has is two processes against one file — which is the move
// tests/marketversion.test.js MV6 makes, for the same reason, and the L13
// lesson the issue cites by name.
//
// WHAT IT PROVES. Not that the sweep is fast, and not that it is polite. It
// proves that an order is EITHER matched OR cancelled and never both, and that
// the wallet still holds the matched liability in whichever of the two outcomes
// happened. The failure it rules out is the worst one this engine has ever had
// a shape for: a MATCH row written against an order whose collateral cancelOrderTx
// has already released, which leaves a market permanently unsettleable AND
// un-voidable — and which every double-entry invariant stays silent about,
// because the ledger postings stay balanced while the ORDER row is corrupt.
const LAPSE_CHILD = `
process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
const fs = require('fs');
const { openStore } = require(${JSON.stringify(path.join(ROOT, 'lib/store.js'))});
const M = require(${JSON.stringify(path.join(ROOT, 'lib/match.js'))});

const dbPath = process.argv[1];
const readyPath = process.argv[2];
const goPath = process.argv[3];

const db = openStore(dbPath);
fs.writeFileSync(readyPath, 'ready');
const deadline = Date.now() + 30000;
while (!fs.existsSync(goPath)) {
  if (Date.now() > deadline) { console.error('child: barrier never released'); process.exit(3); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
const r = M.lapseOrders(db);
console.log('LAPSEREPORT ' + JSON.stringify({ considered: r.considered, lapsed: r.lapsed, skipped: r.skipped, released_cents: r.released_cents }));
// exitCode, NOT process.exit(): stdout to a pipe is asynchronous in node and
// process.exit() can truncate a pending write, which would show up as "the
// child produced no report" and send a reader hunting an engine bug.
process.exitCode = 0;
`;

const TAKER_CHILD = `
process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
const fs = require('fs');
const { openStore } = require(${JSON.stringify(path.join(ROOT, 'lib/store.js'))});
const M = require(${JSON.stringify(path.join(ROOT, 'lib/match.js'))});

const dbPath = process.argv[1];
const userId = Number(process.argv[2]);
const selectionId = Number(process.argv[3]);
const stake = Number(process.argv[4]);
const readyPath = process.argv[5];
const goPath = process.argv[6];

const db = openStore(dbPath);
fs.writeFileSync(readyPath, 'ready');
const deadline = Date.now() + 30000;
while (!fs.existsSync(goPath)) {
  if (Date.now() > deadline) { console.error('child: barrier never released'); process.exit(3); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
let out;
try {
  const r = M.placeOrder(db, { id: userId }, { selection_id: selectionId, side: 'lay', price: 2.0, stake_cents: stake });
  out = { ok: true, order_id: r.order.id, fills: r.fills.length, matched: r.order.matched_cents };
} catch (e) {
  out = { ok: false, status: e.status || null, message: e.message };
}
console.log('TAKEREPORT ' + JSON.stringify(out));
process.exitCode = 0;
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForFile(file, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${what} never appeared at ${file}`);
    await sleep(10);
  }
}
function spawnChild(script, args) {
  const child = spawn(process.execPath, ['-e', script, ...args], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let errOut = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { errOut += d; });
  return { child, done: new Promise((resolve) => child.on('close', (status) => resolve({ status, out, errOut }))) };
}
function reportOf(result, marker, who) {
  const line = String(result.out || '').split('\n').filter((l) => l.startsWith(marker)).pop();
  assert.ok(line, `${who} produced no report (exit ${result.status}): ${String(result.errOut || '').slice(0, 500)}`);
  return JSON.parse(line.slice(marker.length + 1));
}

/**
 * The race fixture: a file-backed venue with one resting LAPSE back on an
 * in-play market, and a taker who can take it.
 */
async function raceFixture(withTaker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obe-lapse-race-'));
  const dbPath = path.join(dir, 'race.db');
  const db = openStore(dbPath);
  const mk = async (name) => A.registerUser(db, { username: name, password: 'secret1', balance_cents: 1000000 });
  const holder = await mk('holder');
  const taker = await mk('taker');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football','football')").run();
  const sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, 'Race', datetime('now','+2 hours'))").run(sport.id);
  const ev = db.prepare("SELECT id FROM events WHERE name='Race'").get();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const marketId = db.prepare('SELECT id FROM markets WHERE event_id = ?').get(ev.id).id;
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Alpha', 2.0)").run(marketId);
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Beta', 2.2)").run(marketId);
  const selectionId = db.prepare('SELECT id FROM selections WHERE market_id = ?').get(marketId).id;

  // The resting order is placed PRE-match — that is the ordinary way a trader
  // comes to own one — and then the market turns in-play, which is what makes
  // it a lapse candidate.
  const resting = M.placeOrder(db, holder, { selection_id: selectionId, side: 'back', price: 2.0, stake_cents: 4000, persistence: 'LAPSE' }).order;
  goInPlay(db, marketId);
  assert.strictEqual(resting.status, 'open', 'precondition: the order is a live lapse candidate');
  assert.strictEqual(db.prepare('SELECT inplay FROM markets WHERE id = ?').get(marketId).inplay, 1);
  return { dir, dbPath, db, marketId, selectionId, holder, taker, resting };
}

function cleanup(dir, dbPath, db) {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* not created */ } }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
}

// C6 runs FIRST, as the control C5 depends on. It is written and drained in
// order, so a single-threaded "run the taker alone" cannot pass because the
// market cannot match at all — which is the whole risk of a race test whose
// control is missing.
check('C6 the control: with no sweep running, the same arrival really does fill the lapsing order', async () => {
  const f = await raceFixture(false);
  try {
    const before = balances(f.db, f.holder.id);
    assert.deepStrictEqual(before, { b: 1000000, f: 4000 }, 'the resting order holds its stake');
    const taker = spawnChild(TAKER_CHILD, [f.dbPath, String(f.taker.id), String(f.selectionId), '4000', path.join(f.dir, 'ready1'), path.join(f.dir, 'go')]);
    await waitForFile(path.join(f.dir, 'ready1'), 'taker ready');
    fs.writeFileSync(path.join(f.dir, 'go'), 'go');
    const out = reportOf(await taker.done, 'TAKEREPORT', 'control taker');
    assert.strictEqual(out.ok, true, 'CONTROL: the taker was accepted');
    assert.strictEqual(out.fills, 1, 'CONTROL: and it really matched — a rest would not have filled anything');
    assert.strictEqual(row(f.db, f.resting.id).status, 'fully_matched');
    assert.strictEqual(row(f.db, f.resting.id).matched_cents, 4000);
    assert.strictEqual(
      f.db.prepare('SELECT COUNT(*) c FROM matches WHERE back_order_id = ?').get(f.resting.id).c,
      1,
      'CONTROL: exactly one match row references the lapsing order'
    );
    escrowIdentity(f.db, f.holder.id);
    escrowIdentity(f.db, f.taker.id);
    assertVenueIntact(f.db);
  } finally {
    cleanup(f.dir, f.dbPath, f.db);
  }
});

// C5: the race itself, over SEVERAL ROUNDS.
//
// Why several. A single barrier release guarantees both children were parked
// before either ran; it does NOT guarantee they then overlapped — the OS is
// free to run one to completion before starting the other, and often will. Each
// round is therefore a fresh independent chance to hit the contended case, and
// the property under test is an INVARIANT that must hold in every round, so more
// rounds is strictly stronger and can never be flaky. Which branch each round
// lands in is deliberately NOT asserted: the point is that neither branch is
// ever wrong, not that a particular one is reachable every time on every
// machine. (This is the same limit MV6 accepts, and for the same reason.)
const RACE_ROUNDS = 3;
check('C5 the lapse sweep cannot race an arrival at the same instant: two processes, one barrier', async () => {
  for (let round = 1; round <= RACE_ROUNDS; round++) {
    const f = await raceFixture(true);
    try {
      // PRE-STATE, asserted before either child is released.
      assert.deepStrictEqual(balances(f.db, f.holder.id), { b: 1000000, f: 4000 }, `round ${round}: the order holds 4000 before anything happens`);
      assert.strictEqual(row(f.db, f.resting.id).status, 'open');
      assert.strictEqual(row(f.db, f.resting.id).matched_cents, 0);
      escrowIdentity(f.db, f.holder.id);
      escrowIdentity(f.db, f.taker.id);

      const goPath = path.join(f.dir, 'go');
      const ready1 = path.join(f.dir, 'ready1');
      const ready2 = path.join(f.dir, 'ready2');
      const sweeper = spawnChild(LAPSE_CHILD, [f.dbPath, ready1, goPath]);
      const taker = spawnChild(TAKER_CHILD, [f.dbPath, String(f.taker.id), String(f.selectionId), '4000', ready2, goPath]);

      // BOTH children park on the barrier BEFORE either is released. If either
      // never got there the run below would be sequential, which is exactly the
      // shape that passes against a broken implementation.
      await waitForFile(ready1, 'sweeper ready');
      await waitForFile(ready2, 'taker ready');
      fs.writeFileSync(goPath, 'go');
      const [sw, tk] = await Promise.all([sweeper.done, taker.done]);

      const sweep = reportOf(sw, 'LAPSEREPORT', `sweeper (round ${round})`);
      const take = reportOf(tk, 'TAKEREPORT', `taker (round ${round})`);
      assert.ok(sw.status === 0 && tk.status === 0, 'both children exited cleanly');

      const after = row(f.db, f.resting.id);
      const matches = f.db.prepare('SELECT * FROM matches WHERE back_order_id = ? OR lay_order_id = ?').all(f.resting.id, f.resting.id);
      const cancelled = after.status === 'cancelled';
      const matched = after.matched_cents > 0;

      // THE INVARIANT. Either the taker got there first and the order is matched
      // (so the sweep must not have released its collateral), or the sweep got
      // there first and the order is cancelled (so the taker must not have a
      // match row against it). BOTH is the corruption this test exists for.
      assert.ok(
        !(cancelled && matched),
        `round ${round}: the order is BOTH cancelled and matched — status ${after.status}, matched ${after.matched_cents}, ${matches.length} match row(s)`
      );
      if (cancelled) {
        // The sweep won: escrow released, no trade, and the sweep says so.
        assert.strictEqual(after.frozen_cents, 0, `round ${round}: a lapsed order holds nothing`);
        assert.strictEqual(matches.length, 0, `round ${round}: and has no match row against it`);
        assert.strictEqual(sweep.lapsed, 1, `round ${round}: the sweep reports the work it did`);
        assert.strictEqual(sweep.released_cents, 4000);
        assert.strictEqual(take.fills || 0, 0, `round ${round}: the taker rested instead of filling a cancelled order`);
        assert.deepStrictEqual(balances(f.db, f.holder.id), { b: 1000000, f: 0 }, `round ${round}: every cent came back`);
      } else {
        // The taker won: the order traded, and its collateral is STILL HELD as a
        // matched liability. This is the half that catches a sweep which released
        // escrow securing a fill it did not cause.
        assert.strictEqual(after.status, 'fully_matched', `round ${round}: the taker took the whole order`);
        assert.strictEqual(after.matched_cents, 4000);
        assert.strictEqual(matches.length, 1, `round ${round}: exactly one match`);
        assert.strictEqual(sweep.lapsed, 0, `round ${round}: the sweep released nothing it should not have`);
        assert.strictEqual(sweep.released_cents, 0, `round ${round}: and no collateral`);
        assert.strictEqual(take.fills, 1);
        assert.deepStrictEqual(balances(f.db, f.holder.id), { b: 1000000, f: 4000 }, `round ${round}: the matched stake is still collateralised`);
      }

      // WHICHER WAY IT WENT the books are sound. The escrow identity is the whole
      // point: settlement must be able to release exactly what is held, and a
      // cent stranded here is a market that can neither settle nor void.
      escrowIdentity(f.db, f.holder.id);
      escrowIdentity(f.db, f.taker.id);
      assertVenueIntact(f.db);
      // And the market must still be SETTLEABLE — the check the
      // releaseEligibleOrders comment says a corrupt remainder once made
      // impossible.
      const beta = f.db.prepare("SELECT id FROM selections WHERE market_id = ? AND name = 'Beta'").get(f.marketId).id;
      S.settleMarket(f.db, f.marketId, { winner_selection_id: beta });
      assert.strictEqual(balances(f.db, f.holder.id).f, 0, `round ${round}: settlement released everything it was holding`);
      assert.strictEqual(
        f.db.prepare('SELECT COALESCE(SUM(frozen_cents), 0) s FROM orders WHERE user_id = ?').get(f.holder.id).s,
        0,
        `round ${round}: and no order row still holds escrow`
      );
      assertVenueIntact(f.db);
    } finally {
      cleanup(f.dir, f.dbPath, f.db);
    }
  }
});

(async () => {
  // Drain the collected checks IN ORDER, awaiting each. A check that rejects is a
  // failure of this suite, not of the next file: exiting here stops the rest of
  // this suite running rather than letting a broken assertion print a green line
  // for a body that never completed.
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
  console.log(`\namend.test.js: ${passed} checks passed`);
})();