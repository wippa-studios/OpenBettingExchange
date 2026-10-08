// match.test.js — the matching engine: sweeps, resting price, escrow, guards.
// Run: node tests/match.test.js   (plain assert, no deps)
// Hand-computed examples mirror JIT paper_math E1–E9 semantics.
'use strict';
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
const S = require('../lib/settle'); // E17 closes its scenario end-to-end

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

let evCounter = 0;

function fresh() {
  const db = openStore(':memory:');
  const mk = (name, bal) => A.registerUser(db, { username: name, password: 'secret1', balance_cents: bal });
  return {
    db,
    users: { alice: mk('alice', 100000), bob: mk('bob', 100000), carol: mk('carol', 100000), dave: mk('dave', 100000) },
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
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id = ?').get(ev.id);
  const ids = [];
  for (const [name, fair] of selections) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(mkt.id, name, fair);
    ids.push(db.prepare('SELECT id FROM selections WHERE market_id = ? AND name = ?').get(mkt.id, name).id);
  }
  return { market_id: mkt.id, s1: ids[0], s2: ids[1] };
}

const balances = (db, id) => {
  const r = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(id);
  return { b: r.b, f: r.f };
};
const orderOf = (db, id) => {
  const r = db.prepare('SELECT matched_cents m, status s FROM orders WHERE id = ?').get(id);
  return { matched: r.m, status: r.s };
};
const frozenCol = (db, id) => db.prepare('SELECT frozen_cents f FROM orders WHERE id = ?').get(id).f;
const txsOf = (db, id) =>
  db.prepare('SELECT type, amount_cents a FROM transactions WHERE user_id = ? ORDER BY id').all(id).map((r) => ({ type: r.type, a: r.a }));
const matchesFor = (db, marketId) =>
  db.prepare('SELECT price, stake_cents s FROM matches WHERE market_id = ? ORDER BY id').all(marketId).map((r) => ({ price: r.price, stake: r.s }));

// E1: back taker matches a resting lay AT THE RESTING PRICE.
check('E1 back matches resting lay at resting price', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const a = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }).order;
  assert.deepStrictEqual(orderOf(db, a.id), { matched: 0, status: 'open' }); // no liquidity yet
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 10000 }); // stake escrowed
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  assert.deepStrictEqual(orderOf(db, a.id), { matched: 10000, status: 'fully_matched' });
  assert.deepStrictEqual(orderOf(db, b.order.id), { matched: 10000, status: 'fully_matched' });
  assert.deepStrictEqual(matchesFor(db, market_id), [{ price: 2.0, stake: 10000 }]);
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 10000 }); // matched pot stays frozen
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 10000 }); // liability (2.0-1)*10000
});

// E2: partial fill — remainder rests.
check('E2 partial fill', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const a = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }).order;
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 6000 });
  assert.deepStrictEqual(orderOf(db, a.id), { matched: 6000, status: 'open' });
  assert.deepStrictEqual(orderOf(db, b.order.id), { matched: 6000, status: 'fully_matched' });
  assert.deepStrictEqual(matchesFor(db, market_id), [{ price: 2.0, stake: 6000 }]);
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 10000 }); // matched 6000 + resting 4000
});

// E3: lay taker matched at P < own price Q releases (Q-P)*fill excess.
check('E3 lay excess escrow released', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const a = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }).order; // rests
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.1, stake_cents: 10000 });
  // escrowed (2.1-1)*10000 = 11000; matched at 2.0 -> liability 10000; excess 1000 released
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 10000 });
  const txs = db.prepare("SELECT type, amount_cents a FROM transactions WHERE user_id = ? ORDER BY id").all(users.bob.id).map((r) => ({ type: r.type, a: r.a }));
  assert.deepStrictEqual(txs, [{ type: 'escrow', a: 11000 }, { type: 'release', a: 1000 }]);
  assert.deepStrictEqual(matchesFor(db, market_id), [{ price: 2.0, stake: 10000 }]);
  assert.deepStrictEqual(orderOf(db, a.id), { matched: 10000, status: 'fully_matched' });
});

// E4: back taker sweeps resting lays HIGHEST price first (best-for-taker).
check('E4 back sweep highest-first', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.06, stake_cents: 10000 });
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 2.02, stake_cents: 5000 });
  const a = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.02, stake_cents: 12000 });
  assert.deepStrictEqual(matchesFor(db, market_id), [
    { price: 2.06, stake: 10000 }, // best price first — backer gets better than demanded
    { price: 2.02, stake: 2000 },
  ]);
  assert.deepStrictEqual(orderOf(db, a.order.id), { matched: 12000, status: 'fully_matched' });
  assert.deepStrictEqual(orderOf(db, db.prepare("SELECT id FROM orders WHERE user_id = ? AND side='lay' AND price=2.06").get(users.bob.id).id), { matched: 10000, status: 'fully_matched' });
  assert.deepStrictEqual(orderOf(db, db.prepare("SELECT id FROM orders WHERE user_id = ? AND side='lay' AND price=2.02").get(users.carol.id).id), { matched: 2000, status: 'open' });
  const sel = db.prepare('SELECT ltp FROM selections WHERE id = ?').get(s1);
  assert.strictEqual(sel.ltp, 2.02); // last traded
});

// E5: lay taker sweeps resting backs LOWEST price first (least liability).
check('E5 lay sweep lowest-first', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.98, stake_cents: 10000 }); // rests
  M.placeOrder(db, users.dave, { selection_id: s1, side: 'back', price: 2.04, stake_cents: 5000 }); // rests
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.1, stake_cents: 12000 });
  assert.deepStrictEqual(matchesFor(db, market_id), [
    { price: 1.98, stake: 10000 }, // lowest eligible back first
    { price: 2.04, stake: 2000 },
  ]);
  // escrowed (2.1-1)*12000 = 13200; released (2.1-1.98)*10000=1200 + (2.1-2.04)*2000=120
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 11880 });
  const txs = db.prepare("SELECT type, amount_cents a FROM transactions WHERE user_id = ? ORDER BY id").all(users.bob.id).map((r) => ({ type: r.type, a: r.a }));
  assert.deepStrictEqual(txs, [
    { type: 'escrow', a: 13200 },
    { type: 'release', a: 1200 },
    { type: 'release', a: 120 },
  ]);
});

// E6: self-match guard — a user never matches their own resting order.
check('E6 self-match guard', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  const l = M.placeOrder(db, users.alice, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  assert.deepStrictEqual(orderOf(db, l.order.id), { matched: 0, status: 'open' }); // own back skipped
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM matches').get().n, 0);
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 20000 });
});

// E7: cancel releases the stake escrow; double-cancel and foreign orders reject.
check('E7 cancel back order', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const a = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }).order;
  const cancelled = M.cancelOrder(db, users.alice, a.id);
  assert.strictEqual(cancelled.status, 'cancelled');
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 0 });
  assert.throws(() => M.cancelOrder(db, users.alice, a.id), (e) => e.status === 400);
  const other = M.placeOrder(db, users.bob, { selection_id: s1, side: 'back', price: 2.05, stake_cents: 10000 }).order;
  assert.throws(() => M.cancelOrder(db, users.alice, other.id), (e) => e.status === 404);
});

// E8: cancel a resting lay releases the FULL liability escrow.
check('E8 cancel lay order', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const l = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.1, stake_cents: 10000 }).order;
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 11000 });
  M.cancelOrder(db, users.bob, l.id);
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 0 });
});

// E9: order validation — stake bounds, side, suspended market.
check('E9 validation', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 50 }), (e) => e.status === 400); // below MIN 100
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: '10000' }), (e) => e.status === 400);
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: s1, side: 'x', price: 2.0, stake_cents: 10000 }), (e) => e.status === 400);
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 200000 }), (e) => e.status === 400); // above MAX
  db.prepare("UPDATE markets SET status = 'suspended' WHERE id = ?").run(market_id);
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }), (e) => e.status === 409);
});

// E10: LTP, trade tape and market volume update on fills.
check('E10 LTP + trade tape + volume', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  const sel = db.prepare('SELECT ltp FROM selections WHERE id = ?').get(s1);
  assert.strictEqual(sel.ltp, 2.0);
  const hist = db.prepare('SELECT price FROM price_history WHERE selection_id = ?').all(s1);
  assert.deepStrictEqual(hist.map((r) => r.price), [2.0]);
  const mkt = db.prepare('SELECT total_matched_cents t FROM markets WHERE id = ?').get(market_id);
  assert.strictEqual(mkt.t, 10000);
});

// E11: bookFor aggregates sizes at each price level, back DESC / lay ASC.
check('E11 book aggregation + ordering', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.1, stake_cents: 10000 });
  // A resting lay must price BELOW the resting backs or it would have swept
  // them on arrival (real-exchange book consistency: back side < lay side).
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 1.99, stake_cents: 5000 });
  const book = M.bookFor(db, db.prepare('SELECT market_id FROM selections WHERE id = ?').get(s1).market_id);
  const row = book.find((b) => b.selection_id === s1);
  assert.deepStrictEqual(row.back, [{ price: 1.99, size_cents: 5000 }]); // resting lays, highest first
  assert.deepStrictEqual(row.lay, [
    { price: 2.0, size_cents: 20000 }, // aggregated at level
    { price: 2.1, size_cents: 10000 },
  ]); // resting backs, lowest first
});

// E12: lay escrow rounding is exact at 2dp prices (single rounding point).
check('E12 escrow float exactness', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.02], ['Beta', 3.0]]);
  const l = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.02, stake_cents: 10000 }).order;
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 10200 }); // round(1.02*10000)
  assert.strictEqual(l.price, 2.02); // snapped input stays on the ladder
});

// E13: FIFO within a price level — two resting lays at the SAME price, the
// older order must fill first (price-time priority, not arbitrary).
check('E13 FIFO within a price level', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 4000 });
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 4000 });
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 6000 });
  const rows = db
    .prepare(
      `SELECT m.stake_cents s, bo.placed_at t FROM matches m
       JOIN orders bo ON bo.id = m.back_order_id
       JOIN orders lo ON lo.id = m.lay_order_id
       WHERE m.market_id = ? ORDER BY m.id`
    )
    .all(market_id);
  // The OLDER lay (bob) is filled first, even though carol's sits at the same price.
  assert.deepStrictEqual(rows.map((r) => r.s), [4000, 2000]);
  const bobId = db.prepare("SELECT id FROM orders WHERE user_id = ? AND side = 'lay'").get(users.bob.id).id;
  const carolId = db.prepare("SELECT id FROM orders WHERE user_id = ? AND side = 'lay'").get(users.carol.id).id;
  assert.ok(bobId < carolId, 'bob rested first');
  assert.deepStrictEqual(orderOf(db, bobId), { matched: 4000, status: 'fully_matched' });
  assert.deepStrictEqual(orderOf(db, carolId), { matched: 2000, status: 'open' });
});

// E14 (Critical-1 repro A): lay 150 @ 1.04 fully matched by a resting back
// @ 1.03. Old formula released round((Q-P)*fill) = 2 and left 4 frozen while
// settlement must release 5 — a permanently unsettleable market. New rule:
// release = frozen - (fill liability + remainder escrow) = 6 - (5 + 0) = 1.
check('E14 repro A: lay 150 @ 1.04 matched @ 1.03 releases 1, keeps 5', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const a = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.03, stake_cents: 150 }).order; // rests
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 1.04, stake_cents: 150 });
  assert.deepStrictEqual(matchesFor(db, market_id), [{ price: 1.03, stake: 150 }]);
  assert.deepStrictEqual(txsOf(db, users.bob.id), [{ type: 'escrow', a: 6 }, { type: 'release', a: 1 }]);
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 5 }); // exactly the settlement liability
  assert.strictEqual(frozenCol(db, b.order.id), 0); // fully matched: no remainder escrow
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 150 }); // matched stake stays frozen
  assert.strictEqual(frozenCol(db, a.id), 0);
});

// E15 (Critical-1 repro B): lay 155 @ 1.10 matched @ 1.02. Old formula left
// 4 frozen while settlement releases 3 — one cent stranded forever. New rule:
// release = 16 - (3 + 0) = 13; frozen 3 = exactly what settlement releases.
check('E15 repro B: lay 155 @ 1.10 matched @ 1.02 keeps exactly 3', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.02, stake_cents: 155 }); // rests
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 1.10, stake_cents: 155 });
  assert.deepStrictEqual(txsOf(db, users.bob.id), [{ type: 'escrow', a: 16 }, { type: 'release', a: 13 }]);
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 3 });
  assert.strictEqual(frozenCol(db, b.order.id), 0);
});

// E16 (Critical-1 repro C, taker side, rescaled to the 100-cent minimum):
// lay 200 @ 1.51 fills 100 @ 1.01 + 100 @ 1.51. The two per-fill liabilities
// sum to 1 + 51 = 52, ABOVE the two single-placement roundings the old
// flawed release could strand. The sweep (lowest price first) releases
// round(0.51*200) - 52 = 50 on the first fill; the wallet ends holding
// exactly 52 = what settlement will release.
check('E16 repro C: multi-fill lay 200 @ 1.51 ends with frozen == sum of fill liabilities', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'back', price: 1.01, stake_cents: 100 }); // rests
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.51, stake_cents: 100 }); // rests
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 1.51, stake_cents: 200 });
  assert.deepStrictEqual(matchesFor(db, market_id), [
    { price: 1.01, stake: 100 }, // lowest eligible back first
    { price: 1.51, stake: 100 },
  ]);
  assert.deepStrictEqual(txsOf(db, users.bob.id), [{ type: 'escrow', a: 102 }, { type: 'release', a: 50 }]);
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 52 }); // 1 + 51 exactly
  assert.strictEqual(frozenCol(db, b.order.id), 0);
});

// E17: the explicit 1-cent TOP-UP path. Bob's lay 100 @ 1.51 sweeps the
// 50 remaining on alice's pre-consumed back (carol's earlier lay took the
// other 100 — every placed stake respects the 100-cent minimum): the first
// fill's target (liability 26 + remainder escrow 26 = 52) exceeds the 51
// one placement rounding froze, so the engine escrows one more cent at
// fill time. Cancelling then releases exactly the tracked remainder (26),
// the matched liability survives for settlement, and settling zeroes
// everything.
check('E17 taker 1-cent top-up, cancel releases tracked remainder, settle -> 0', () => {
  const { db, users } = fresh();
  const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.51, stake_cents: 150 }); // rests 150
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 1.51, stake_cents: 100 }); // fills 100, leaves avail 50
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 1.51, stake_cents: 100 }); // fills the 50
  assert.deepStrictEqual(txsOf(db, users.bob.id), [{ type: 'escrow', a: 51 }, { type: 'escrow', a: 1 }]); // the top-up
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 52 });
  assert.strictEqual(frozenCol(db, b.order.id), 26); // remainder escrow tracked
  M.cancelOrder(db, users.bob, b.order.id);
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 26 }); // matched liability kept
  assert.strictEqual(frozenCol(db, b.order.id), 0);
  S.settleMarket(db, market_id, { winner_selection_id: s2 }); // lay wins
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100049, f: 0 }); // +50 - 1 commission
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 99850, f: 0 }); // lost 100 (to carol) + 50 (to bob)
  assert.deepStrictEqual(balances(db, users.carol.id), { b: 100097, f: 0 }); // +100 - 3 commission
  assert.deepStrictEqual(txsOf(db, users.bob.id).slice(-2), [{ type: 'settle', a: 50 }, { type: 'commission', a: 1 }]);
});

// E18: the same top-up on a RESTING lay — a back taker's fill pushes the
// resting layer's target above what the placement froze, and the top-up is
// taken on the resting layer's account (they must have the cent available).
// A 50-fill needs legal stakes: alice's back 150 sweeps dave's higher lay
// (100 @ 2.0) first, leaving exactly 50 for carol's resting lay at 1.51.
check('E18 resting-lay multi-fill top-up keeps the invariant', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.dave, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 100 }); // rests, higher price
  const l = M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 1.51, stake_cents: 100 }).order; // rests
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.51, stake_cents: 150 }); // sweeps dave's 100 @ 2.0, then 50 of carol's
  assert.deepStrictEqual(txsOf(db, users.carol.id), [{ type: 'escrow', a: 51 }, { type: 'escrow', a: 1 }]);
  assert.deepStrictEqual(balances(db, users.carol.id), { b: 100000, f: 52 });
  assert.strictEqual(frozenCol(db, l.id), 26);
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'back', price: 1.51, stake_cents: 150 }); // completes carol's 50
  assert.deepStrictEqual(balances(db, users.carol.id), { b: 100000, f: 52 }); // second fill: delta 0
  assert.strictEqual(txsOf(db, users.carol.id).length, 2);
  assert.strictEqual(frozenCol(db, l.id), 0);
  assert.deepStrictEqual(orderOf(db, l.id), { matched: 100, status: 'fully_matched' });
});

// E19: self-match guard, back-taker side (mirror of E6): a user's own
// resting lay is skipped even when it is the best eligible price.
check('E19 back-taker self-match guard', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 }); // rests
  const b = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM matches').get().n, 0);
  assert.deepStrictEqual(orderOf(db, b.order.id), { matched: 0, status: 'open' }); // own lay skipped
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 20000 }); // both escrows intact
});

// E20: FIFO within a price level, lay-taker side (mirror of E13): two
// resting backs at the same price, the older one fills first.
check('E20 lay-taker FIFO within a price level', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const bobOrder = M.placeOrder(db, users.bob, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 4000 }).order;
  const carolOrder = M.placeOrder(db, users.carol, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 4000 }).order;
  const b = M.placeOrder(db, users.alice, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 6000 });
  const rows = db
    .prepare(
      `SELECT m.stake_cents s, bo.id AS back_id FROM matches m
       JOIN orders bo ON bo.id = m.back_order_id
       WHERE m.market_id = ? ORDER BY m.id`
    )
    .all(market_id);
  assert.deepStrictEqual(rows.map((r) => r.s), [4000, 2000]); // bob (older) first
  assert.strictEqual(rows[0].back_id, bobOrder.id);
  assert.strictEqual(rows[1].back_id, carolOrder.id);
  assert.ok(bobOrder.id < carolOrder.id, 'bob rested first');
  assert.deepStrictEqual(orderOf(db, bobOrder.id), { matched: 4000, status: 'fully_matched' });
  assert.deepStrictEqual(orderOf(db, carolOrder.id), { matched: 2000, status: 'open' });
  assert.strictEqual(frozenCol(db, carolOrder.id), 2000); // unmatched remainder escrow
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 6000 }); // = 4000 + 2000 liabilities
});

// E21 (Critical-2 half-cent battery): lay 101 @ 1.5 -> escrow round(50.5) = 51.
// Math.round rounds .5 UP — a floor-based liability would freeze 50 and the
// exact asserts here would fail.
check('E21 half-cent escrow: lay 101 @ 1.5 freezes exactly 51', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const l = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 1.5, stake_cents: 101 }).order;
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 51 });
  assert.strictEqual(frozenCol(db, l.id), 51);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.5, stake_cents: 101 }); // fills @ own price
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 51 }); // matched: liability 51, no excess
  assert.strictEqual(txsOf(db, users.bob.id).length, 1); // escrow only — no release
});

// E22 (Critical-2): lay 101 @ 2.5 filling a resting back @ 2.0 — escrow
// round(151.5) = 152, the fill keeps round(1.0*101) = 101, so the excess
// release is exactly 51.
check('E22 half-cent excess: lay 101 @ 2.5 matched @ 2.0 releases exactly 51', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 101 }); // rests
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.5, stake_cents: 101 });
  assert.deepStrictEqual(txsOf(db, users.bob.id), [{ type: 'escrow', a: 152 }, { type: 'release', a: 51 }]);
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 101 });
  assert.strictEqual(frozenCol(db, b.order.id), 0);
});

// E23 (Critical-2): lay 5050 @ 1.01 -> escrow round(50.5) = 51 even at the
// bottom tick of the ladder.
check('E23 half-cent escrow at the ladder floor: lay 5050 @ 1.01 freezes 51', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.01, stake_cents: 5050 }); // rests
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 1.01, stake_cents: 5050 });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 51 });
  assert.strictEqual(txsOf(db, users.bob.id).length, 1); // escrow 51 only
});

// E24: an off-ladder price snaps THROUGH the engine: the stored price is on
// the ladder and the escrow follows the STORED price, not the typed one.
// 2.017 rounds to cents 202 -> stored 2.02 -> escrow round(1.02*10000) = 10200.
// (2.013 lands on cents 201, an exact gap tie, which the ladder resolves
// DOWN to the lower band edge 2.00 — asserted too.)
check('E24 off-ladder snap-through: escrow follows the stored ladder price', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const up = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.017, stake_cents: 10000 }).order;
  assert.strictEqual(up.price, 2.02);
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 10200 });
  const down = M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 2.013, stake_cents: 10000 }).order;
  assert.strictEqual(down.price, 2.00); // gap tie snaps to the lower band edge
  assert.deepStrictEqual(balances(db, users.carol.id), { b: 100000, f: 10000 });
});

// E25: stake bounds are INCLUSIVE — exactly MIN and exactly MAX are accepted
// (a resting order suffices; no match needed). One cent outside either bound
// rejects.
check('E25 stake boundaries accepted at exactly 100 and 100000', () => {
  const { db, users } = fresh();
  const { s1, s2 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  // Backs on s1, lays on s2: on a shared selection a lay @ 1000 would sweep
  // the 1.01 backs (P <= Q) and the boundary orders would match each other.
  const min = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.01, stake_cents: 100 }).order;
  const max = M.placeOrder(db, users.bob, { selection_id: s1, side: 'back', price: 1.01, stake_cents: 100000 }).order;
  const maxLay = M.placeOrder(db, users.carol, { selection_id: s2, side: 'lay', price: 1000, stake_cents: 100 }).order;
  const bigLay = M.placeOrder(db, users.dave, { selection_id: s2, side: 'lay', price: 1.5, stake_cents: 100000 }).order;
  for (const o of [min, max, maxLay, bigLay]) assert.strictEqual(o.status, 'open');
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 100000 }); // whole balance escrowed, still accepted
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.01, stake_cents: 99 }), (e) => e.status === 400);
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.01, stake_cents: 100001 }), (e) => e.status === 400);
});

// E26: selection_id type validation (W4) — garbage must be a 400, never a
// TypeError 500; and a suspended SELECTION rejects orders with 409.
check('E26 selection_id validation + suspended selection 409', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: 'abc', side: 'back', price: 2.0, stake_cents: 10000 }), (e) => e.status === 400);
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: undefined, side: 'back', price: 2.0, stake_cents: 10000 }), (e) => e.status === 400);
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: 2.5, side: 'back', price: 2.0, stake_cents: 10000 }), (e) => e.status === 400);
  db.prepare("UPDATE selections SET status = 'suspended' WHERE id = ?").run(s1);
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }), (e) => e.status === 409);
});

console.log(`\nmatch.test.js: ${passed} checks passed`);
