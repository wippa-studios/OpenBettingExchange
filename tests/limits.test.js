// limits.test.js — abuse controls (Phase 1).
// Run: node tests/limits.test.js   (plain assert, no deps)
//
// These are ABUSE controls, not solvency controls. A matched position cannot
// lose more than its escrow covers no matter what these limits are set to, so
// nothing here is load-bearing for solvency — which is exactly why the
// distinct-error-code behaviour is tested hard: the player will appeal a
// refusal, and "why was my bet refused" must still be answerable later.
'use strict';

// This suite creates many accounts; pin the scrypt cost down. It asserts
// nothing about the stored hash format — auth.test.js owns that.
process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const L = require('../lib/limits');
const M = require('../lib/match');
const ledger = require('../lib/ledger');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

// Fresh graph: one market, one selection, two players, funded.
async function fixture() {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, 'Ev', datetime('now','+2 hours'))").run(sport.id);
  const ev = db.prepare("SELECT id FROM events WHERE name='Ev'").get();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare("SELECT id FROM markets WHERE event_id=?").get(ev.id);
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Runner', 2.0)").run(mkt.id);
  const sel = db.prepare("SELECT id FROM selections WHERE market_id=?").get(mkt.id);
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 1000000 }));
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 1000000 }));
  return { db, alice, bob, marketId: mkt.id, selId: sel.id };
}

const status = (e) => { try { throw e; } catch (x) { return { status: x.status, code: x.details && x.details.code, message: x.message }; } };
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e.details && e.details.code; } };

// L1: no limits row means NO CAP on every axis — never a cap of zero.
check('L1 absent limits row means unlimited, not zero', async () => {
  const { db, alice, marketId: MKT, selId: SEL } = (await fixture());
  const eff = L.effective(db, alice.id, MKT);
  assert.strictEqual(eff.max_open_stake_cents, null);
  assert.strictEqual(eff.max_market_liability_cents, null);
  assert.strictEqual(eff.max_daily_settled_cents, null);
  assert.strictEqual(L.matchingAllowed(db, alice.id, MKT), true);
});

// L2: a stake cap refuses placement, with a DISTINCT code (not a generic 400).
check('L2 stake cap refuses placement with a distinct code', async () => {
  const { db, alice, marketId: MKT, selId: SEL } = (await fixture());
  L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_open_stake_cents: 1000 });
  assert.throws(() => M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 5000 }),
    (e) => e.status === 429 && e.details.code === 'stake_limit_exceeded');
  // Under the cap still places fine — the limit is a ceiling, not a lockout.
  assert.ok(M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 1000 }).order.id);
});

// L3: market liability is checked against RESTING escrow, and the refusal
// carries the cap and the current figure so the UI can explain itself.
check('L3 market liability cap refuses the order that breaches it', async () => {
  const { db, alice, marketId: MKT, selId: SEL } = (await fixture());
  L.setLimits(db, { actor: alice, userId: alice.id, scope: L.marketScope(MKT), max_market_liability_cents: 3000 });
  M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 2000 });
  assert.strictEqual(L.marketLiability(db, alice.id, MKT), 2000);
  let err = null;
  try { M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 2000 }); }
  catch (e) { err = e; }
  assert.ok(err, 'expected refusal');
  assert.strictEqual(err.status, 429);
  assert.strictEqual(err.details.code, 'market_liability_exceeded');
  assert.strictEqual(err.details.cap_cents, 3000);
  assert.strictEqual(err.details.current_cents, 2000);
});

// L4: cancelling releases escrow and frees the liability headroom again.
// Without this a limit would be a one-way ratchet that permanently strands
// an account once it had been reached.
check('L4 cancel releases liability headroom', async () => {
  const { db, alice, marketId: MKT, selId: SEL } = (await fixture());
  L.setLimits(db, { actor: alice, userId: alice.id, scope: L.marketScope(MKT), max_market_liability_cents: 3000 });
  const o = M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 2000 }).order;
  assert.strictEqual(L.marketLiability(db, alice.id, MKT), 2000);
  M.cancelOrder(db, alice, o.id);
  assert.strictEqual(L.marketLiability(db, alice.id, MKT), 0);
  assert.ok(M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 2000 }).order.id);
});

// L5: a market scope overrides global PER AXIS, not wholesale. Setting a
// market liability cap must not silently clear the user's global daily cap.
check('L5 market scope overrides per axis only', async () => {
  const { db, alice, marketId: MKT, selId: SEL } = (await fixture());
  L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_open_stake_cents: 1000, max_daily_settled_cents: 5000 });
  L.setLimits(db, { actor: alice, userId: alice.id, scope: L.marketScope(MKT), max_market_liability_cents: 7000 });
  const eff = L.effective(db, alice.id, MKT);
  assert.strictEqual(eff.max_market_liability_cents, 7000, 'market-specific cap applies');
  assert.strictEqual(eff.max_open_stake_cents, 1000, 'global stake cap survives');
  assert.strictEqual(eff.max_daily_settled_cents, 5000, 'global daily cap survives');
  // A different market sees only the global row.
  const eff2 = L.effective(db, alice.id, 999);
  assert.strictEqual(eff2.max_market_liability_cents, null);
  assert.strictEqual(eff2.max_open_stake_cents, 1000);
});

// L6: the daily cap STOPS MATCHING but still lets the order REST. It must not
// cancel: a vanished order changes the book for everyone else watching it.
check('L6 daily cap stops matching but the order still rests', async () => {
  const { db, alice, bob, marketId: MKT, selId: SEL } = (await fixture());
  // Bob rests a back at 2.0 that Alice would match.
  M.placeOrder(db, bob, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 5000 });
  // Alice already settled to exactly her daily cap today.
  db.prepare("INSERT INTO settlements (market_id,user_id,credit_cents,commission_cents,pnl_cents) VALUES (?,?,0,0,?)")
    .run(MKT, alice.id, 5000);
  L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_daily_settled_cents: 5000 });
  assert.strictEqual(L.netSettledToday(db, alice.id), 5000);
  assert.strictEqual(L.matchingAllowed(db, alice.id, MKT), false);

  const r = M.placeOrder(db, alice, { selection_id: SEL, side: 'lay', price: 2.0, stake_cents: 5000 });
  assert.strictEqual(r.fills.length, 0, 'must not take fills');
  assert.strictEqual(r.order.status, 'open', 'must rest, not cancel');
  assert.strictEqual(r.order.matched_cents, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM matches').get().c, 0, 'no match row written');
  // Escrow is still held against the resting order.
  assert.strictEqual(L.marketLiability(db, alice.id, MKT), 5000);
});

// ── ABSENT is not NULL ─────────────────────────────────────────────────────
//
// The route documents "a key that is ABSENT leaves that axis untouched; a key
// present with a null CLEARS the cap", and tries to honour it by omitting absent
// keys from the object it passes down. That cannot work: destructuring gives an
// absent key the same `undefined` as an explicit one, `capOf(undefined)` returns
// null, and the axis is cleared.
//
// The failure is a silent WIDENING of a risk control. Tightening a stake limit
// while leaving the daily cap out would hand the account an unlimited daily cap
// — the exact harm the comment says it is preventing, in the comment's own words.
check('L18 an ABSENT axis is left untouched; an explicit null CLEARS it', async () => {
  const { db, alice, marketId: MKT } = (await fixture());
  L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global',
    max_open_stake_cents: 5000, max_market_liability_cents: 7000, max_daily_settled_cents: 9000 });

  // Tighten ONE axis and say nothing about the others.
  const after = L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global',
    max_open_stake_cents: 1000 });

  assert.strictEqual(after.max_open_stake_cents, 1000, 'the named axis was not applied');
  assert.strictEqual(after.max_market_liability_cents, 7000,
    'an ABSENT liability cap was silently cleared');
  assert.strictEqual(after.max_daily_settled_cents, 9000,
    'tightening the stake cap silently granted an UNLIMITED daily cap');

  // An EXPLICIT null still clears, which is the other half of the contract.
  const cleared = L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global',
    max_daily_settled_cents: null });
  assert.strictEqual(cleared.max_daily_settled_cents, null, 'an explicit null must clear the cap');
  assert.strictEqual(cleared.max_open_stake_cents, 1000, 'clearing one axis must not disturb another');
});

check('L18 absent axes on a user with NO existing row are null, not an error', async () => {
  const { db, alice } = (await fixture());
  // No prior row. Every axis is absent, so all three resolve to null.
  const after = L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global',
    max_open_stake_cents: 1000 });
  assert.strictEqual(after.max_open_stake_cents, 1000);
  assert.strictEqual(after.max_market_liability_cents, null);
  assert.strictEqual(after.max_daily_settled_cents, null);
});

check('L18 an absent axis is not RE-VALIDATED, so a no-op PUT still succeeds', async () => {
  const { db, alice } = (await fixture());
  L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_open_stake_cents: 5000 });
  // Sending only the same value must not disturb the others, and must not throw.
  const after = L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global',
    max_open_stake_cents: 5000 });
  assert.strictEqual(after.max_open_stake_cents, 5000);
});

// ── #14: the RESTING side ───────────────────────────────────────────────────
//
// L6 above proves the cap stops a capped user TAKING. It says nothing about the
// other half, and the other half was not enforced: a capped user's order sat in
// the book and the next arrival matched it. The cap was defeated by resting
// instead of taking, which is the same player using the same permission.
//
// The delay-release pass already consulted matchingAllowed, so two of the three
// sweeps honoured the cap and the busiest one did not — which is exactly why
// L6 could stay green for as long as it did.
check('L6b a capped user at their cap is not matched as a RESTING order either', async () => {
  const { db, alice, bob, marketId: MKT, selId: SEL } = (await fixture());

  // Alice is AT her cap. Her order goes in first, so she is the resting side the
  // taker reaches.
  db.prepare("INSERT INTO settlements (market_id,user_id,credit_cents,commission_cents,pnl_cents) VALUES (?,?,0,0,?)")
    .run(MKT, alice.id, 5000);
  L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_daily_settled_cents: 5000 });
  assert.strictEqual(L.matchingAllowed(db, alice.id, MKT), false, 'fixture must start at the cap');

  const aliceOrder = M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 2000 }).order;

  // Bob arrives with money and no cap, and sweeps.
  const r = M.placeOrder(db, bob, { selection_id: SEL, side: 'lay', price: 2.0, stake_cents: 5000 });

  assert.strictEqual(r.fills.length, 0, 'a capped user was matched through the resting side');
  assert.strictEqual(
    db.prepare('SELECT matched_cents m, status s FROM orders WHERE id = ?').get(aliceOrder.id).m, 0,
    "the capped user's resting order took a fill"
  );
  assert.strictEqual(
    db.prepare('SELECT status s FROM orders WHERE id = ?').get(aliceOrder.id).s, 'open',
    'the capped user\'s order was cancelled rather than left resting — a daily cap expires on its own'
  );
  // Bob's stake rests rather than erroring: someone else being capped is not
  // Bob's error, and refusing his placement would be the cap punishing a
  // stranger, which is what #13 was.
  assert.strictEqual(r.order.status, 'open');
  assert.strictEqual(r.order.matched_cents, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM matches').get().c, 0, 'a match row was written anyway');
});

check('L6c the cap lifts, and the order that was held back then matches', async () => {
  const { db, alice, bob, marketId: MKT, selId: SEL } = (await fixture());
  db.prepare("INSERT INTO settlements (market_id,user_id,credit_cents,commission_cents,pnl_cents) VALUES (?,?,0,0,?)")
    .run(MKT, alice.id, 5000);
  L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_daily_settled_cents: 5000 });
  const aliceOrder = M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 2000 }).order;
  M.placeOrder(db, bob, { selection_id: SEL, side: 'lay', price: 2.0, stake_cents: 5000 });
  assert.strictEqual(db.prepare('SELECT matched_cents m FROM orders WHERE id = ?').get(aliceOrder.id).m, 0);

  // Raise the cap. The order was left RESTING precisely so this is possible.
  L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_daily_settled_cents: 9000 });
  const r = M.placeOrder(db, bob, { selection_id: SEL, side: 'lay', price: 2.0, stake_cents: 5000 });

  assert.strictEqual(db.prepare('SELECT matched_cents m FROM orders WHERE id = ?').get(aliceOrder.id).m, 2000,
    'the order was destroyed instead of held back — the cap is transient and must not cancel');
  assert.strictEqual(r.fills.length, 1, 'the later taker took no fill');
});

// ── #18: NET has to mean net of the FEE as well as the losses ──────────────
//
// L7 above claims to prove "net, not gross", but every settlement it inserts
// carries commission_cents = 0. SUM(pnl_cents) and SUM(pnl_cents −
// commission_cents) are identical for that data, so the check could not tell
// the two implementations apart — it passed against the gross sum it was
// written to disprove.
//
// The comment on netSettledToday asserted "pnl_cents is already net of
// commission at write time". That was false: lib/settle.js writes the gross
// delta to pnl_cents and the fee to its own column, so the cap counted a
// player's winnings gross of what the venue charged them.
check('L7b the daily cap is net of COMMISSION, not just of losses', async () => {
  const { db, alice, marketId: MKT } = (await fixture());
  // The reviewer's measured case: a win of 10000 with commission 250.
  db.prepare(
    "INSERT INTO settlements (market_id,user_id,credit_cents,commission_cents,pnl_cents) VALUES (?,?,0,?,?)"
  ).run(MKT, alice.id, 250, 10000);

  const raw = db
    .prepare("SELECT pnl_cents p, commission_cents c FROM settlements WHERE user_id = ?")
    .get(alice.id);
  assert.strictEqual(raw.p, 10000, 'the row stores the GROSS delta');
  assert.strictEqual(raw.c, 250, 'and the fee separately — so the sum must subtract it');

  assert.strictEqual(
    L.netSettledToday(db, alice.id),
    9750,
    'the cap counts 9750 net, not the 10000 gross pnl_cents'
  );

  // A LOSING settlement is charged no commission (lib/settle.js: commission is
  // only taken when pnl > 0), so subtracting it must leave a loss unchanged —
  // otherwise the cap would silently under-count losses too.
  db.prepare(
    "INSERT INTO settlements (market_id,user_id,credit_cents,commission_cents,pnl_cents) VALUES (?,?,0,0,?)"
  ).run(MKT, alice.id, -5000);
  assert.strictEqual(L.netSettledToday(db, alice.id), 4750, 'a loss still counts in full');
});

// L8: net, not gross. A cap on gross would be defeated by churn and would
// effectively no-op for anyone net-flat — the opposite of the intent.
//
// NOTE: this one passes against the gross sum as well, because every row it
// inserts has commission_cents = 0. L7b below is the check that can fail.
check('L7 daily cap counts NET settlement, not gross', async () => {
  const { db, alice, marketId: MKT, selId: SEL } = (await fixture());
  db.prepare("INSERT INTO settlements (market_id,user_id,credit_cents,commission_cents,pnl_cents) VALUES (?,?,0,0,?)").run(MKT, alice.id, -40000);
  db.prepare("INSERT INTO settlements (market_id,user_id,credit_cents,commission_cents,pnl_cents) VALUES (?,?,0,0,?)").run(MKT, alice.id, 45000);
  assert.strictEqual(L.netSettledToday(db, alice.id), 5000, 'net of the loss');
  L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_daily_settled_cents: 5000 });
  assert.strictEqual(L.matchingAllowed(db, alice.id, MKT), false, 'churn does not reset the cap');
});

// L8: a suspended account cannot trade.
check('L8 suspended account is refused with its own code', async () => {
  const { db, alice, marketId: MKT, selId: SEL } = (await fixture());
  db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(alice.id);
  assert.strictEqual(codeOf(() => M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 1000 })), 'account_suspended');
});

// L9: self-exclusion is absolute, cancels RESTING orders and releases escrow.
check('L9 exclusion cancels resting orders and releases escrow', async () => {
  const { db, alice, marketId: MKT, selId: SEL } = (await fixture());
  M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 2000 });
  assert.strictEqual(L.marketLiability(db, alice.id, MKT), 2000);
  const before = db.prepare('SELECT frozen_cents f, balance_cents b FROM users WHERE id=?').get(alice.id);
  assert.strictEqual(before.f, 2000);

  const r = L.exclude(db, { actor: alice, userId: alice.id, until: null, reason: 'self-request' });
  assert.strictEqual(r.cancelled_orders, 1);
  assert.strictEqual(r.released_cents, 2000);
  assert.strictEqual(L.marketLiability(db, alice.id, MKT), 0);
  const after = db.prepare('SELECT frozen_cents f, balance_cents b FROM users WHERE id=?').get(alice.id);
  assert.strictEqual(after.f, 0, 'escrow released');
  assert.strictEqual(after.b, before.b, 'balance restored — release moves frozen->balance');
  // And the account can no longer trade.
  assert.strictEqual(codeOf(() => M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 1000 })), 'self_excluded');
});

// L10: exclusion MUST NOT touch matched positions. Those are collateralised on
// both sides and have to settle; releasing them would mean the venue chooses
// which side of a matched bet to honour, at the counterparty's expense.
check('L10 exclusion leaves MATCHED positions alone', async () => {
  const { db, alice, bob, marketId: MKT, selId: SEL } = (await fixture());
  M.placeOrder(db, bob, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 5000 });
  const r = M.placeOrder(db, alice, { selection_id: SEL, side: 'lay', price: 2.0, stake_cents: 5000 });
  assert.strictEqual(r.fills.length, 1);
  const matchedBefore = db.prepare('SELECT COUNT(*) c FROM matches').get().c;
  const frozenBefore = db.prepare('SELECT frozen_cents f FROM users WHERE id=?').get(alice.id).f;

  L.exclude(db, { actor: alice, userId: alice.id, until: null, reason: 'self-request' });

  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM matches').get().c, matchedBefore, 'match rows intact');
  assert.strictEqual(db.prepare('SELECT frozen_cents f FROM users WHERE id=?').get(alice.id).f, frozenBefore,
    'matched liability still held — it must still settle');
  // And it settles normally afterwards.
  const { settleMarket } = require('../lib/settle');
  settleMarket(db, MKT, { winner_selection_id: SEL });
  assert.strictEqual(db.prepare('SELECT status FROM markets WHERE id=?').get(MKT).status, 'settled');
});

// L11: a TIMED exclusion lapses; a permanent one does not.
check('L11 timed exclusion lapses, permanent does not', async () => {
  const { db, alice, marketId: MKT, selId: SEL } = (await fixture());
  L.exclude(db, { actor: alice, userId: alice.id, until: '2000-01-01 00:00:00', reason: 'test' });
  assert.strictEqual(L.exclusionOf(db, alice.id), null, 'a past date is not an exclusion');
  assert.ok(M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 1000 }).order.id,
    'lapsed exclusion does not block trading');

  L.exclude(db, { actor: alice, userId: alice.id, until: null, reason: 'test' });
  assert.strictEqual(codeOf(() => M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 1000 })), 'self_excluded');
});

// L12: the refund is real money back — exclusion must not confiscate. (Ties
// the whole module to the escrow invariant the engine exists to protect.)
check('L12 exclusion never leaves funds trapped in escrow', async () => {
  const { db, alice, marketId: MKT, selId: SEL } = (await fixture());
  const start = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id=?').get(alice.id);
  for (const stake of [1000, 2500, 700]) {
    const o = M.placeOrder(db, alice, { selection_id: SEL, side: 'lay', price: 3.0, stake_cents: stake }).order;
    void o;
  }
  const loaded = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id=?').get(alice.id);
  assert.ok(loaded.f > 0);
  L.exclude(db, { actor: alice, userId: alice.id, until: null, reason: 'test' });
  const end = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id=?').get(alice.id);
  assert.strictEqual(end.f, 0, 'no escrow stranded');
  assert.strictEqual(end.b, start.b, 'every cent returned');
});

// L13: concurrency. The whole safety argument for placement limits is that the
// read and the write share a transaction. Assert the invariant directly: a
// second placement cannot slip past the cap because it re-reads inside its own
// transaction. Sequential-with-shared-state is the honest simulation here
// (DatabaseSync is single-threaded, so a true interleaving is not expressible).
check('L13 placement limit re-reads current liability, so it cannot be raced', async () => {
  const { db, alice, marketId: MKT, selId: SEL } = (await fixture());
  L.setLimits(db, { actor: alice, userId: alice.id, scope: L.marketScope(MKT), max_market_liability_cents: 3000 });
  M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 2000 });
  // A second placement reads the SAME database inside its own transaction and
  // must see the 2000 already committed, not a stale zero.
  const e = (() => { try { M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 2000 }); return null; } catch (x) { return x; } })();
  assert.ok(e, 'second placement must see the committed liability and refuse');
  assert.strictEqual(e.details.current_cents, 2000);
});

// L14: 0 is a real cap, not "unlimited". Reading a missing/zero cap as
// unlimited is how a limit silently stops limiting.
check('L14 a zero cap is a real zero, not unlimited', async () => {
  const { db, alice, marketId: MKT, selId: SEL } = (await fixture());
  L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_open_stake_cents: 0 });
  assert.strictEqual(L.effective(db, alice.id, MKT).max_open_stake_cents, 0);
  assert.strictEqual(codeOf(() => M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 1000 })), 'stake_limit_exceeded');
});

// L15: a limit breach is AUDITED. The player will appeal, so the cause has to
// be retrievable months later rather than living only in a log line.
check('L15 limit changes and exclusions are audited', async () => {
  const { db, alice, bob, marketId: MKT, selId: SEL } = (await fixture());
  const adm = (await A.registerUser(db, { username: 'ops', password: 'pw-ops-123' }));
  db.prepare("UPDATE users SET role='admin', is_admin=1 WHERE id=?").run(adm.id);
  L.setLimits(db, { actor: adm, userId: alice.id, scope: 'global', max_open_stake_cents: 1000 });
  L.exclude(db, { actor: adm, userId: bob.id, until: null, reason: 'operator decision' });
  const A2 = require('../lib/audit');
  const targets = A2.list(db, { limit: 100 }).map((r) => r.action);
  assert.ok(targets.includes('user.limits_changed'), 'limits change recorded');
  assert.ok(targets.includes('user.excluded'), 'exclusion recorded');
  const ex = A2.list(db, { limit: 100 }).find((r) => r.action === 'user.excluded');
  assert.strictEqual(ex.reason, 'operator decision', 'the reason is retrievable');
  assert.strictEqual(ex.actor_id, adm.id, 'actor recorded');
});

// L16: limits reject nonsense rather than coercing it. A negative cap that
// became "no cap" would be a silent bypass.
check('L16 invalid limit values are refused, not coerced', async () => {
  const { db, alice, marketId: MKT, selId: SEL } = (await fixture());
  assert.throws(() => L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_open_stake_cents: -5 }), /non-negative/);
  assert.throws(() => L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_open_stake_cents: 1.5 }), /non-negative/);
  assert.throws(() => L.setLimits(db, { actor: alice, userId: alice.id, scope: 'evil"; DROP TABLE users;--' }), /Invalid limit scope/);
  assert.strictEqual(L.effective(db, alice.id, MKT).max_open_stake_cents, null, 'nothing was written');
});

// L17: a non-string SCOPE is a rejected request, not a thrown TypeError.
//
// The route substitutes the default only for `undefined`
// (`scope === undefined ? GLOBAL_SCOPE : scope`), so `5`, `null` and
// `["global"]` all reach isValidScope straight from JSON. Without a type guard
// `scope.startsWith(...)` is a TypeError carrying no `.status`, which the error
// handler renders as a 500 — bad input answered with "the server is broken",
// which is exactly what teaches an operator to ignore 5xx from this route.
//
// The tell is that capOf() already rejects a non-integer on every AXIS, so a
// caller reading the module has no way to know the scope was the unvalidated
// one.
check('L17 a non-string limit scope is a 400, not a 500', async () => {
  const { db, alice, marketId: MKT } = (await fixture());
  for (const bad of [5, null, ['global'], true, { scope: 'global' }, 1.5]) {
    assert.strictEqual(L.isValidScope(bad), false, `${JSON.stringify(bad)} is not a scope`);
    assert.throws(
      () => L.setLimits(db, { actor: alice, userId: alice.id, scope: bad, max_open_stake_cents: 1000 }),
      (e) => e.status === 400,
      `${JSON.stringify(bad)} is refused with a 400, not a TypeError`
    );
  }
  // The guard did not narrow the vocabulary: both well-formed scopes still work.
  assert.strictEqual(L.isValidScope('global'), true);
  assert.strictEqual(L.isValidScope(L.marketScope(MKT)), true);
  assert.strictEqual(L.effective(db, alice.id, MKT).max_open_stake_cents, null, 'nothing was written');
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
  if (passed < 18) { console.error("expected 18 checks"); process.exit(1); }
  console.log(`\nlimits.test.js: ${passed} checks passed`);
})();
