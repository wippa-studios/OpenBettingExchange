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
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

// Fresh graph: one market, one selection, two players, funded.
function fixture() {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, 'Ev', datetime('now','+2 hours'))").run(sport.id);
  const ev = db.prepare("SELECT id FROM events WHERE name='Ev'").get();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare("SELECT id FROM markets WHERE event_id=?").get(ev.id);
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (?, 'Runner', 2.0)").run(mkt.id);
  const sel = db.prepare("SELECT id FROM selections WHERE market_id=?").get(mkt.id);
  const alice = A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 1000000 });
  const bob = A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 1000000 });
  return { db, alice, bob, marketId: mkt.id, selId: sel.id };
}

const status = (e) => { try { throw e; } catch (x) { return { status: x.status, code: x.details && x.details.code, message: x.message }; } };
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e.details && e.details.code; } };

// L1: no limits row means NO CAP on every axis — never a cap of zero.
check('L1 absent limits row means unlimited, not zero', () => {
  const { db, alice, marketId: MKT, selId: SEL } = fixture();
  const eff = L.effective(db, alice.id, MKT);
  assert.strictEqual(eff.max_open_stake_cents, null);
  assert.strictEqual(eff.max_market_liability_cents, null);
  assert.strictEqual(eff.max_daily_settled_cents, null);
  assert.strictEqual(L.matchingAllowed(db, alice.id, MKT), true);
});

// L2: a stake cap refuses placement, with a DISTINCT code (not a generic 400).
check('L2 stake cap refuses placement with a distinct code', () => {
  const { db, alice, marketId: MKT, selId: SEL } = fixture();
  L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_open_stake_cents: 1000 });
  assert.throws(() => M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 5000 }),
    (e) => e.status === 429 && e.details.code === 'stake_limit_exceeded');
  // Under the cap still places fine — the limit is a ceiling, not a lockout.
  assert.ok(M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 1000 }).order.id);
});

// L3: market liability is checked against RESTING escrow, and the refusal
// carries the cap and the current figure so the UI can explain itself.
check('L3 market liability cap refuses the order that breaches it', () => {
  const { db, alice, marketId: MKT, selId: SEL } = fixture();
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
check('L4 cancel releases liability headroom', () => {
  const { db, alice, marketId: MKT, selId: SEL } = fixture();
  L.setLimits(db, { actor: alice, userId: alice.id, scope: L.marketScope(MKT), max_market_liability_cents: 3000 });
  const o = M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 2000 }).order;
  assert.strictEqual(L.marketLiability(db, alice.id, MKT), 2000);
  M.cancelOrder(db, alice, o.id);
  assert.strictEqual(L.marketLiability(db, alice.id, MKT), 0);
  assert.ok(M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 2000 }).order.id);
});

// L5: a market scope overrides global PER AXIS, not wholesale. Setting a
// market liability cap must not silently clear the user's global daily cap.
check('L5 market scope overrides per axis only', () => {
  const { db, alice, marketId: MKT, selId: SEL } = fixture();
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
check('L6 daily cap stops matching but the order still rests', () => {
  const { db, alice, bob, marketId: MKT, selId: SEL } = fixture();
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

// L7: net, not gross. A cap on gross would be defeated by churn and would
// effectively no-op for anyone net-flat — the opposite of the intent.
check('L7 daily cap counts NET settlement, not gross', () => {
  const { db, alice, marketId: MKT, selId: SEL } = fixture();
  db.prepare("INSERT INTO settlements (market_id,user_id,credit_cents,commission_cents,pnl_cents) VALUES (?,?,0,0,?)").run(MKT, alice.id, -40000);
  db.prepare("INSERT INTO settlements (market_id,user_id,credit_cents,commission_cents,pnl_cents) VALUES (?,?,0,0,?)").run(MKT, alice.id, 45000);
  assert.strictEqual(L.netSettledToday(db, alice.id), 5000, 'net of the loss');
  L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_daily_settled_cents: 5000 });
  assert.strictEqual(L.matchingAllowed(db, alice.id, MKT), false, 'churn does not reset the cap');
});

// L8: a suspended account cannot trade.
check('L8 suspended account is refused with its own code', () => {
  const { db, alice, marketId: MKT, selId: SEL } = fixture();
  db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(alice.id);
  assert.strictEqual(codeOf(() => M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 1000 })), 'account_suspended');
});

// L9: self-exclusion is absolute, cancels RESTING orders and releases escrow.
check('L9 exclusion cancels resting orders and releases escrow', () => {
  const { db, alice, marketId: MKT, selId: SEL } = fixture();
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
check('L10 exclusion leaves MATCHED positions alone', () => {
  const { db, alice, bob, marketId: MKT, selId: SEL } = fixture();
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
check('L11 timed exclusion lapses, permanent does not', () => {
  const { db, alice, marketId: MKT, selId: SEL } = fixture();
  L.exclude(db, { actor: alice, userId: alice.id, until: '2000-01-01 00:00:00', reason: 'test' });
  assert.strictEqual(L.exclusionOf(db, alice.id), null, 'a past date is not an exclusion');
  assert.ok(M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 1000 }).order.id,
    'lapsed exclusion does not block trading');

  L.exclude(db, { actor: alice, userId: alice.id, until: null, reason: 'test' });
  assert.strictEqual(codeOf(() => M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 1000 })), 'self_excluded');
});

// L12: the refund is real money back — exclusion must not confiscate. (Ties
// the whole module to the escrow invariant the engine exists to protect.)
check('L12 exclusion never leaves funds trapped in escrow', () => {
  const { db, alice, marketId: MKT, selId: SEL } = fixture();
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
check('L13 placement limit re-reads current liability, so it cannot be raced', () => {
  const { db, alice, marketId: MKT, selId: SEL } = fixture();
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
check('L14 a zero cap is a real zero, not unlimited', () => {
  const { db, alice, marketId: MKT, selId: SEL } = fixture();
  L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_open_stake_cents: 0 });
  assert.strictEqual(L.effective(db, alice.id, MKT).max_open_stake_cents, 0);
  assert.strictEqual(codeOf(() => M.placeOrder(db, alice, { selection_id: SEL, side: 'back', price: 2.0, stake_cents: 1000 })), 'stake_limit_exceeded');
});

// L15: a limit breach is AUDITED. The player will appeal, so the cause has to
// be retrievable months later rather than living only in a log line.
check('L15 limit changes and exclusions are audited', () => {
  const { db, alice, bob, marketId: MKT, selId: SEL } = fixture();
  const adm = A.registerUser(db, { username: 'ops', password: 'pw-ops-123' });
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
check('L16 invalid limit values are refused, not coerced', () => {
  const { db, alice, marketId: MKT, selId: SEL } = fixture();
  assert.throws(() => L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_open_stake_cents: -5 }), /non-negative/);
  assert.throws(() => L.setLimits(db, { actor: alice, userId: alice.id, scope: 'global', max_open_stake_cents: 1.5 }), /non-negative/);
  assert.throws(() => L.setLimits(db, { actor: alice, userId: alice.id, scope: 'evil"; DROP TABLE users;--' }), /Invalid limit scope/);
  assert.strictEqual(L.effective(db, alice.id, MKT).max_open_stake_cents, null, 'nothing was written');
});

console.log(`\nlimits.test.js: ${passed} checks passed`);
if (passed < 16) { console.error('expected 16 checks'); process.exit(1); }