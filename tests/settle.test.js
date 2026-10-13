// settle.test.js — market settlement: pot distribution + commission.
// Run: node tests/settle.test.js   (plain assert, no deps)
'use strict';

// scrypt cost: this suite creates many accounts and pays the hash once per
// account, but asserts NOTHING about the stored hash format. auth.test.js
// runs at the real default (SCRYPT_N=65536) and owns that coverage.
process.env.SCRYPT_N = '16384';
// Hermeticity: pin the money knobs before anything loads lib/config, so an
// ambient .env can never change what these examples assert.
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.FAUCET_MAX_CENTS = '100000';
const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const S = require('../lib/settle');
const { prevTick } = require('../lib/odds');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

let evCounter = 0;

async function fresh() {
  const db = openStore(':memory:');
  const mk = async (name, bal) => A.registerUser(db, { username: name, password: 'secret1', balance_cents: bal });
  return {
    db,
    users: { alice: (await mk('alice', 100000)), bob: (await mk('bob', 100000)), carol: (await mk('carol', 100000)), dave: (await mk('dave', 100000)) },
  };
}

function mkMarket(db, selections) {
  let sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  if (!sport) {
    db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
    sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  }
  evCounter++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now', '+2 hours'))").run(sport.id, `Test Event ${evCounter}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Test Event ${evCounter}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id = ? ORDER BY id DESC').get(ev.id);
  return addSelections(db, mkt.id, selections);
}

function addSelections(db, marketId, selections) {
  const ids = [];
  for (const [name, fair] of selections) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(marketId, name, fair);
    ids.push(db.prepare('SELECT id FROM selections WHERE market_id = ? AND name = ?').get(marketId, name).id);
  }
  return { market_id: marketId, s1: ids[0], s2: ids[1] };
}

const balances = (db, id) => {
  const r = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(id);
  return { b: r.b, f: r.f };
};

// S1: back wins — pot s*Q to the backer, commission on net winnings.
// alice back 10000 @ 2.0 vs bob lay 10000 @ 2.0; winner Alpha.
// alice: +10000 profit, -250 commission -> 109750; bob: -10000 -> 90000.
check('S1 back wins', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  const res = S.settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.strictEqual(res.market.status, 'settled');
  assert.strictEqual(res.market.winner_selection_id, s1);
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 109750, f: 0 });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 90000, f: 0 });
  const rows = db.prepare('SELECT user_id, credit_cents c, commission_cents k, pnl_cents p FROM settlements ORDER BY user_id').all()
    .map((r) => ({ user_id: r.user_id, c: r.c, k: r.k, p: r.p }));
  const alice = rows.find((r) => r.user_id === users.alice.id);
  const bob = rows.find((r) => r.user_id === users.bob.id);
  assert.deepStrictEqual(alice, { user_id: users.alice.id, c: 20000, k: 250, p: 10000 }); // pot 20000 received
  assert.deepStrictEqual(bob, { user_id: users.bob.id, c: 0, k: 0, p: -10000 });
  // conservation: total money = 400000 (4 users) - 250 (commission is house revenue)
  const total = db.prepare('SELECT SUM(balance_cents) t FROM users').get().t;
  assert.strictEqual(total, 399750);
  // single-market event completes
  const ev = db.prepare("SELECT status FROM events WHERE id = (SELECT event_id FROM markets WHERE id = ?)").get(market_id);
  assert.strictEqual(ev.status, 'completed');
});

// S2: back loses — the layer wins and pays the commission.
check('S2 back loses (layer wins)', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  S.settleMarket(db, market_id, { winner_selection_id: s2 });
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 90000, f: 0 });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 109750, f: 0 }); // 100000 + 10000 - 250
});

// S3: lay win at high odds — full liability escrow returned (E3b regression
// at settlement): bob lay 10000 @ 3.0 (escrow 20000) + profit 10000 - 250.
check('S3 lay wins at high odds returns escrow', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 3.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 3.0, stake_cents: 10000 });
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 3.0, stake_cents: 10000 }); // sweeps bob's lay
  S.settleMarket(db, market_id, { winner_selection_id: s2 }); // Alpha loses -> lay wins
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 109750, f: 0 });
  const row = db.prepare('SELECT credit_cents c, pnl_cents p FROM settlements WHERE user_id = ?').get(users.bob.id);
  assert.strictEqual(row.c, 30000); // 20000 escrow + 10000 profit
  assert.strictEqual(row.p, 10000);
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 90000, f: 0 });
});

// S4: market void — everyone gets their own contribution back, untouched.
check('S4 void refunds own contributions', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  S.settleMarket(db, market_id, { void: true });
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 0 });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 0 });
  const refund = db.prepare("SELECT amount_cents a FROM transactions WHERE type = 'refund'").get();
  assert.strictEqual(refund.a, 10000);
  const mkt = db.prepare('SELECT winner_selection_id w, status s FROM markets WHERE id = ?').get(market_id);
  assert.strictEqual(mkt.w, null);
  assert.strictEqual(mkt.s, 'settled');
  const total = db.prepare('SELECT SUM(balance_cents) t FROM users').get().t;
  assert.strictEqual(total, 400000); // conserved
});

// S5: unmatched orders auto-cancel at settlement (escrow released, no
// settlement rows for users without matches).
check('S5 unmatched auto-cancelled', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }); // rests
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 1.98, stake_cents: 5000 }); // rests
  S.settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 0 });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 0 }); // 4900 liability released
  const n = db.prepare('SELECT COUNT(*) n FROM settlements').get().n;
  assert.strictEqual(n, 0);
  const statuses = db.prepare("SELECT status FROM orders").all().map((r) => r.status);
  assert.ok(statuses.every((s) => s === 'cancelled'));
});

// S6: re-settling a settled market is a hard error — no double-pay.
check('S6 re-settle guard', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  S.settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.throws(() => S.settleMarket(db, market_id, { winner_selection_id: s1 }), (e) => e.status === 409);
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 109750, f: 0 }); // untouched
});

// S7: commission charges the NET across matches, not per-match:
// alice wins 5050+5050 = 10100 -> commission round(10100*0.025) = 253
// (per-match rounding would give 126+126 = 252).
check('S7 commission on net', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5050 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 5050 });
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5050 });
  M.placeOrder(db, users.dave, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 5050 });
  S.settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 109847, f: 0 }); // 100000 + 10100 - 253
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 94950, f: 0 });
  assert.deepStrictEqual(balances(db, users.dave.id), { b: 94950, f: 0 });
  const total = db.prepare('SELECT SUM(balance_cents) t FROM users').get().t;
  assert.strictEqual(total, 400000 - 253);
});

// S8: an event completes only when ALL of its markets are settled.
check('S8 event completion across markets', async () => {
  const { db, users } = (await fresh());
  const { market_id: mA, s1: a1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const evId = db.prepare('SELECT event_id FROM markets WHERE id = ?').get(mA).event_id;
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Over/Under 2.5')").run(evId);
  const mB = db.prepare('SELECT id FROM markets WHERE event_id = ? ORDER BY id DESC').get(evId).id;
  const { s1: b1 } = addSelections(db, mB, [['Over', 1.9], ['Under', 2.0]]);
  S.settleMarket(db, mA, { winner_selection_id: a1 });
  let ev = db.prepare('SELECT status FROM events WHERE id = ?').get(evId);
  assert.strictEqual(ev.status, 'upcoming'); // one market still open
  S.settleMarket(db, mB, { winner_selection_id: b1 });
  ev = db.prepare('SELECT status FROM events WHERE id = ?').get(evId);
  assert.strictEqual(ev.status, 'completed');
});

// S9: settled markets reject new orders.
check('S9 settled market frozen', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  S.settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.throws(
    () => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }),
    (e) => e.status === 409
  );
});

// S10: void refunds a lay at its MATCH price liability (excess already
// released at match time): bob lay 10000 @ 2.1 matched at 2.0 -> frozen
// 10000 (not 11000); void refunds exactly 10000.
check('S10 void after lay excess release', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }); // rests
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.1, stake_cents: 10000 }); // matches at 2.0, excess 1000 released
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 10000 });
  S.settleMarket(db, market_id, { void: true });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 0 }); // refunded 10000, not 11000
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 0 });
});

// S11: strict input validation. Settlement is irreversible, so a coerced
// value must never pick the outcome: {void:"false"} must NOT void, and
// true must not become selection id 1.
check('S11 strict settlement input', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  // string "false" is not a boolean -> reject, market stays open
  assert.throws(() => S.settleMarket(db, market_id, { void: 'false' }), (e) => e.status === 400);
  assert.throws(() => S.settleMarket(db, market_id, { void: 'false', winner_selection_id: s1 }), (e) => e.status === 400);
  // a boolean winner id must not be coerced to selection 1
  assert.throws(() => S.settleMarket(db, market_id, { winner_selection_id: true }), (e) => e.status === 400);
  assert.throws(() => S.settleMarket(db, market_id, { winner_selection_id: '1' }), (e) => e.status === 400);
  // both a winner and void:true is contradictory
  assert.throws(() => S.settleMarket(db, market_id, { winner_selection_id: s1, void: true }), (e) => e.status === 400);
  // nothing above may have moved a cent
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 10000 });
  assert.strictEqual(db.prepare('SELECT status s FROM markets WHERE id = ?').get(market_id).s, 'open');
  // a valid call still works afterwards
  const r = S.settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.strictEqual(r.market.status, 'settled');
});

// S12 (Critical-1 repro A end-to-end): lay 150 @ 1.04 matched @ 1.03 keeps
// exactly 5 frozen; settlement SUCCEEDS and every participant's frozen
// returns to exactly 0 (the old formula froze 4 here — settlement
// integrity error, market permanently unsettleable).
check('S12 repro A settles cleanly: frozen -> 0 for everyone', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.03, stake_cents: 150 }); // rests
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 1.04, stake_cents: 150 });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 5 });
  const res = S.settleMarket(db, market_id, { winner_selection_id: s1 }); // back wins
  assert.strictEqual(res.market.status, 'settled');
  // Commission is CEIL (house-favourable, by design — see lib/settle.js):
  // a win of 5 pays ceil(5*0.025) = ceil(0.125) = 1, not round's 0. The old
  // round-to-zero here was exactly the splitter exploit the outside audit's
  // F7 quantified: tiny wins paid no fee at all.
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100004, f: 0 }); // +round(0.03*150)=5, commission ceil(0.125)=1
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 99995, f: 0 });
  const total = db.prepare('SELECT SUM(balance_cents) t FROM users').get().t;
  assert.strictEqual(total, 399999); // conserved; the 1 cent of commission is house revenue
});

// S13 (Critical-1 repro B end-to-end): lay 155 @ 1.10 matched @ 1.02 keeps
// exactly 3 frozen (the old formula stranded 1 cent); settlement succeeds.
check('S13 repro B settles cleanly: frozen -> 0 for everyone', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.02, stake_cents: 155 }); // rests
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 1.10, stake_cents: 155 });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 3 });
  S.settleMarket(db, market_id, { winner_selection_id: s1 }); // back wins
  // +3, commission ceil(3*0.025)=ceil(0.075)=1 — the minimum fee the ceil rule
  // charges; round gave 0.
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100002, f: 0 }); // +3 - 1
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 99997, f: 0 });
});

// S14 (Critical-1 repro C end-to-end, rescaled to the 100-cent minimum):
// the multi-fill lay (200 @ 1.51, filling 100 @ 1.01 + 100 @ 1.51) settles
// AND voids with every frozen returning to exactly 0 — including the void
// refund of exactly 52 = the sum of the two per-fill liabilities.
check('S14 repro C multi-fill: settle and void both zero out frozen', async () => {
  const settleLeg = async (mode) => {
    const { db, users } = (await fresh()); // each leg is hermetic: balances restart at 100000
    const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
    M.placeOrder(db, users.carol, { selection_id: s1, side: 'back', price: 1.01, stake_cents: 100 }); // rests
    M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.51, stake_cents: 100 }); // rests
    M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 1.51, stake_cents: 200 });
    assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 52 }); // 1 + 51
    const bobBefore = balances(db, users.bob.id).b;
    if (mode === 'void') S.settleMarket(db, market_id, { void: true });
    else S.settleMarket(db, market_id, { winner_selection_id: s2 }); // lay wins
    assert.deepStrictEqual(balances(db, users.bob.id), { b: mode === 'void' ? bobBefore : bobBefore + 195, f: 0 }, `bob after ${mode}`);
    assert.deepStrictEqual(balances(db, users.alice.id), { b: mode === 'void' ? 100000 : 99900, f: 0 });
    assert.deepStrictEqual(balances(db, users.carol.id), { b: mode === 'void' ? 100000 : 99900, f: 0 });
    return { db, market_id };
  };
  (await settleLeg('settle')); // +200 stakes - round(200*0.025)=5 commission -> +195
  const { db: voidedDb, market_id: voidedMarket } = (await settleLeg('void'));
  const refunds = voidedDb
    .prepare('SELECT user_id, amount_cents a FROM transactions WHERE type = ? AND market_id = ? ORDER BY user_id')
    .all('refund', voidedMarket)
    .map((r) => r.a)
    .sort((x, y) => x - y);
  assert.deepStrictEqual(refunds, [52, 100, 100]); // bob refunded exactly the liability sum 52
});

// S15 (Critical-2 half-cent battery, settle side): lay 101 @ 1.5 matched at
// 1.5 — the liability round(50.5) = 51 is released at settlement exactly.
check('S15 half-cent settle: 101 @ 1.5 releases exactly 51', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.5, stake_cents: 101 }); // rests
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 1.5, stake_cents: 101 });
  S.settleMarket(db, market_id, { winner_selection_id: s2 }); // lay wins
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100098, f: 0 }); // +101 - round(2.525)=3
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 99899, f: 0 });
  const row = db.prepare('SELECT credit_cents c, commission_cents k, pnl_cents p FROM settlements WHERE user_id = ?').get(users.bob.id);
  assert.strictEqual(row.c, 152); // frozen 51 released + 101 won
  assert.strictEqual(row.k, 3);
  assert.strictEqual(row.p, 101);
});

// S16 (Critical-2 half-cent battery, void side): void refunds exactly the
// frozen liability — 51 for 101 @ 1.5, 101 (not 152) for 101 @ 2.5 matched
// @ 2.0, and 51 for 5050 @ 1.01.
check('S16 half-cent voids refund exactly 51 / 101 / 51', async () => {
  const { db, users } = (await fresh());
  const voidIt = (backPrice, layPrice, backStake) => {
    const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
    M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: backPrice, stake_cents: backStake });
    M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: layPrice, stake_cents: backStake });
    S.settleMarket(db, market_id, { void: true });
    const bobRefund = db
      .prepare('SELECT amount_cents a FROM transactions WHERE type = ? AND user_id = ? AND market_id = ?')
      .get('refund', users.bob.id, market_id);
    return { refund: bobRefund ? bobRefund.a : 0, bal: balances(db, users.bob.id) };
  };
  assert.deepStrictEqual(voidIt(1.5, 1.5, 101), { refund: 51, bal: { b: 100000, f: 0 } });
  assert.deepStrictEqual(voidIt(2.0, 2.5, 101), { refund: 101, bal: { b: 100000, f: 0 } }); // match-price liability, not the 152 placement escrow
  assert.deepStrictEqual(voidIt(1.01, 1.01, 5050), { refund: 51, bal: { b: 100000, f: 0 } });
});

// S17: a winner selection from ANOTHER market is a 400 — nothing moves, the
// market stays open, and a valid settlement still works afterwards.
check('S17 foreign winner rejected with 400, nothing moved', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const foreign = mkMarket(db, [['Other Market Runner', 3.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  assert.throws(() => S.settleMarket(db, market_id, { winner_selection_id: foreign.s1 }), (e) => e.status === 400);
  assert.strictEqual(db.prepare('SELECT status s FROM markets WHERE id = ?').get(market_id).s, 'open');
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 10000 }); // unmoved
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 10000 });
  const res = S.settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.strictEqual(res.market.status, 'settled');
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 109750, f: 0 });
});

// S18: commission is charged on the NET across matches in one market —
// alice wins 20000 on s1 and loses her 5000 stake on s2 in the SAME market:
// fee = round(15000 * 0.025) = 375, not round(20000*0.025) = 500.
check('S18 mixed win/loss: commission on NET only (375, not 500)', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 20000 }); // rests
  M.placeOrder(db, users.carol, { selection_id: s2, side: 'lay', price: 2.0, stake_cents: 5000 }); // rests
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 20000 });
  M.placeOrder(db, users.alice, { selection_id: s2, side: 'back', price: 2.0, stake_cents: 5000 });
  S.settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 114625, f: 0 }); // +20000 -5000 -375
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 80000, f: 0 }); // lost the 20000 liability
  assert.deepStrictEqual(balances(db, users.carol.id), { b: 104875, f: 0 }); // +5000 stake won - round(125) commission
  const total = db.prepare('SELECT SUM(balance_cents) t FROM users').get().t;
  assert.strictEqual(total, 400000 - 500); // 375 + 125 commission out
});

// S19: void with UNMATCHED orders in the market — matched contributions are
// refunded, unmatched remainders are auto-cancelled and released, nobody's
// balance moves, everything ends at frozen 0.
check('S19 void with unmatched orders: release + refund, frozen -> 0', async () => {
  const { db, users } = (await fresh());
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5000 }); // rests
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 5000 }); // sweeps carol
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }); // rests, unmatched (lay below can't cross)
  M.placeOrder(db, users.dave, { selection_id: s1, side: 'lay', price: 1.5, stake_cents: 8000 }); // rests, unmatched (back above can't cross)
  S.settleMarket(db, market_id, { void: true });
  for (const u of [users.alice, users.bob, users.carol, users.dave]) {
    assert.deepStrictEqual(balances(db, u.id), { b: 100000, f: 0 }, `${u.username} untouched and unfrozen`);
  }
  // Auto-cancel only touches UNMATCHED orders (their remainder escrow); the
  // fully-matched pair flows through the refund step and keeps its status —
  // the market itself is what reads settled/void.
  const statuses = db.prepare('SELECT status FROM orders').all().map((r) => r.status).sort();
  assert.deepStrictEqual(statuses, ['cancelled', 'cancelled', 'fully_matched', 'fully_matched']);
  const releases = db
    .prepare("SELECT user_id, amount_cents a FROM transactions WHERE type = 'release' ORDER BY id")
    .all()
    .map((r) => r.a);
  assert.deepStrictEqual(releases, [10000, 4000]); // alice's stake, dave's round(0.5*8000)
  const refunds = db
    .prepare("SELECT amount_cents a FROM transactions WHERE type = 'refund' ORDER BY id")
    .all()
    .map((r) => r.a);
  assert.deepStrictEqual(refunds, [5000, 5000]); // carol's stake, bob's match-price liability
});

// S20 (Critical-2 property test): sweep every ladder tick 1.01-3.0 against
// a wide stake set (100..500 step 7). At every step the layer's frozen is
// EXACTLY the sum of future settlement liabilities plus the tracked
// remainder escrow (equality is stronger than >=), and after settle OR void
// every participant's frozen returns to exactly 0.
check('S20 escrow invariant property sweep (ticks x stakes)', async () => {
  const { escrowFor } = M;
  const db = openStore(':memory:');
  const mk = async (name) => A.registerUser(db, { username: name, password: 'secret1', balance_cents: 1000000 });
  const bob = (await mk('layer'));
  const carol = (await mk('backer1'));
  const alice = (await mk('backer2'));
  const stakes = [];
  for (let s = 100; s <= 500; s += 7) stakes.push(s);
  const ticks = [];
  for (let c = 101; c <= 200; c++) ticks.push(c / 100);
  for (let c = 202; c <= 300; c += 2) ticks.push(c / 100);
  const wallet = (id) => db.prepare('SELECT frozen_cents f, balance_cents b FROM users WHERE id = ?').get(id);
  let scenarios = 0;

  // Full fill: carol backs stake @ P (rests), bob lays stake @ Q, matched at P.
  const fullFill = (Q, P, stake, mode) => {
    const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.0]]);
    M.placeOrder(db, carol, { selection_id: s1, side: 'back', price: P, stake_cents: stake });
    M.placeOrder(db, bob, { selection_id: s1, side: 'lay', price: Q, stake_cents: stake });
    const liab = Math.round((P - 1) * stake);
    assert.strictEqual(wallet(bob.id).f, liab, `frozen == settlement liability (Q=${Q} P=${P} stake=${stake})`);
    const before = wallet(bob.id).b;
    if (mode === 'void') S.settleMarket(db, market_id, { void: true });
    else S.settleMarket(db, market_id, { winner_selection_id: s2 });
    assert.strictEqual(wallet(bob.id).f, 0, `lay frozen -> 0 after ${mode} (Q=${Q} P=${P} stake=${stake})`);
    assert.strictEqual(wallet(carol.id).f, 0, `back frozen -> 0 after ${mode}`);
    const delta = wallet(bob.id).b - before;
    // Commission is CEIL — the house-favourable rounding rule (see
    // lib/settle.js); round was the splitter-shave the audit's F7 quantified.
    assert.strictEqual(delta, mode === 'void' ? 0 : stake - Math.ceil(stake * 0.025), `lay ${mode} delta (Q=${Q} P=${P} stake=${stake})`);
    scenarios++;
  };

  // Multi-fill at the own price: the subadditivity stressor. Two fills of
  // f1 and stake-f1 at Q; frozen must equal the SUM of the two per-fill
  // liabilities even when that exceeds the single placement rounding
  // (the 1-cent top-up path).
  const multiFill = (Q, stake, mode) => {
    const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.0]]);
    const f1 = Math.floor(stake / 2);
    M.placeOrder(db, carol, { selection_id: s1, side: 'back', price: Q, stake_cents: f1 });
    M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: Q, stake_cents: stake - f1 });
    M.placeOrder(db, bob, { selection_id: s1, side: 'lay', price: Q, stake_cents: stake });
    const liab = Math.round((Q - 1) * f1) + Math.round((Q - 1) * (stake - f1));
    assert.strictEqual(wallet(bob.id).f, liab, `multi-fill frozen == sum of fill liabilities (Q=${Q} stake=${stake})`);
    const before = wallet(bob.id).b;
    if (mode === 'void') S.settleMarket(db, market_id, { void: true });
    else S.settleMarket(db, market_id, { winner_selection_id: s2 });
    assert.strictEqual(wallet(bob.id).f, 0, `multi-fill frozen -> 0 after ${mode} (Q=${Q} stake=${stake})`);
    assert.strictEqual(wallet(carol.id).f, 0);
    assert.strictEqual(wallet(alice.id).f, 0);
    const delta = wallet(bob.id).b - before;
    assert.strictEqual(delta, mode === 'void' ? 0 : stake - Math.ceil(stake * 0.025), `multi-fill ${mode} delta (Q=${Q} stake=${stake})`);
    scenarios++;
  };

  // Partial fill, cancel, settle: the remainder escrow is released by the
  // cancel, the matched liability by settlement — neither can overrun.
  const partialCancel = (Q, stake) => {
    const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.0]]);
    M.placeOrder(db, carol, { selection_id: s1, side: 'back', price: Q, stake_cents: 100 });
    const lay = M.placeOrder(db, bob, { selection_id: s1, side: 'lay', price: Q, stake_cents: stake }).order;
    const liab100 = Math.round((Q - 1) * 100);
    const remEsc = escrowFor('lay', Q, stake - 100);
    assert.strictEqual(wallet(bob.id).f, liab100 + remEsc, `partial: frozen == liability + remainder escrow (Q=${Q} stake=${stake})`);
    assert.strictEqual(db.prepare('SELECT frozen_cents f FROM orders WHERE id = ?').get(lay.id).f, remEsc);
    M.cancelOrder(db, bob, lay.id);
    assert.strictEqual(wallet(bob.id).f, liab100, `cancel released exactly the tracked remainder (Q=${Q} stake=${stake})`);
    const before = wallet(bob.id).b;
    S.settleMarket(db, market_id, { winner_selection_id: s2 }); // lay keeps the 100
    assert.strictEqual(wallet(bob.id).f, 0, `partial frozen -> 0 after settle (Q=${Q} stake=${stake})`);
    assert.strictEqual(wallet(carol.id).f, 0);
    assert.strictEqual(wallet(bob.id).b - before, 100 - Math.ceil(100 * 0.025));
    scenarios++;
  };

  for (let i = 0; i < ticks.length; i++) {
    const Q = ticks[i];
    const P = i % 2 === 0 ? Q : prevTick(Q); // own price, or one tick below
    fullFill(Q, P, stakes[i % stakes.length], 'settle');
    fullFill(Q, Q, stakes[(i * 3) % stakes.length], 'void');
    let Sm = stakes[(i * 7) % stakes.length]; // multi-fill needs both halves >= MIN_STAKE
    if (Sm < 200) Sm = 200;
    multiFill(Q, Sm, 'settle');
    let Sv = stakes[(i * 11) % stakes.length];
    if (Sv < 200) Sv = 200;
    multiFill(Q, Sv, 'void');
    const Sp = stakes[i % stakes.length];
    if (Sp > 100) partialCancel(Q, Sp);
  }
  assert.ok(scenarios > 700, `covered ${scenarios} scenarios`);
  console.log(`    (sweep: ${scenarios} scenarios across ${ticks.length} ticks x ${stakes.length} stakes)`);
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
  console.log(`\nsettle.test.js: ${passed} checks passed`);
})();
