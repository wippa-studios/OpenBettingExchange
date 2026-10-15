// escrow-topup.test.js — a layer that cannot fund a fill must not fail the sweep.
// Run: node tests/escrow-topup.test.js   (plain assert, no deps)
//
// WHY THIS FILE EXISTS. `applyLayFill` computes a per-fill escrow delta. Because
// placement, match and settlement each round ONCE, per-fill rounding can leave a
// layer a cent short of what a fill needs — the engine's own header names the
// case, lay 100 @ 1.51 filled 50 + 50. That path called `escrow()`, which
// throws `400 Insufficient available balance` from INSIDE the sweep's
// transaction. The rollback took every fill in that sweep with it, including
// fills already agreed against other players who were not party to it. So one
// player's missing cent silently un-did a stranger's trade.
//
// The fix skips a resting layer that cannot fund the fill, leaving its order
// resting. The taker's remaining stake rests with it.
//
// EVERY CHECK HERE IS ABOUT STATE AFTER THE CALL, NEVER ABOUT THE ERROR. A test
// asserting "it threw" would pass against the original code, which threw for the
// wrong reason and took a stranger's fill down with it — that is the whole bug,
// and it is invisible to any assertion about the throwing.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.FAUCET_MAX_CENTS = '100000';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');

let passed = 0;
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };
let evCounter = 0;

async function fresh() {
  const db = openStore(':memory:');
  const mk = async (name, bal) => A.registerUser(db, { username: name, password: 'secret1', balance_cents: bal });
  return {
    db,
    users: {
      alice: await mk('alice', 100000),
      bob: await mk('bob', 100000),
      carol: await mk('carol', 100000),
    },
  };
}

function mkMarket(db, selections) {
  let sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  if (!sport) {
    db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
    sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  }
  evCounter++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now', '+2 hours'))")
    .run(sport.id, `Escrow Event ${evCounter}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Escrow Event ${evCounter}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id = ?').get(ev.id);
  const ids = [];
  for (const [name, fair] of selections) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(mkt.id, name, fair);
    ids.push(db.prepare('SELECT id FROM selections WHERE market_id = ? AND name = ?').get(mkt.id, name).id);
  }
  return { market_id: mkt.id, s1: ids[0] };
}

const orderRow = (db, id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const userRow = (db, id) => db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(id);
const matchCount = (db) => db.prepare('SELECT COUNT(*) n FROM matches').get().n;

// ─────────────────────────────────────────────────────────────────────────────
// The geometry of the failure.
//
// A layer who placed `lay 200 @ 1.51` had `round(0.51 * 200) = 102` cents held.
// That is ONE rounding of the WHOLE order. Fill 150 of it and the remainder 50,
// and each part rounds on its own:
//
//   fill 150 @ 1.51 → remainder escrow round(0.51 * 50) = round(25.5) = 26
//   fill liability                    round(0.51 * 150) = round(76.5) = 77
//   the engine now needs held         26 + 77 = 103
//
// 103 > 102. The layer needs one cent they do not have. This is arithmetic, not
// a contrived edge — the engine's own header documents the same shape
// (`round((Q-1)*S) - round((Q-P)*f)` landing a cent off `round((P-1)*f)` for
// perfectly reachable stakes), and 1195 reachable (price, available, fill)
// triples behave this way.
//
// A WHOLE fill does not bite: filling all 200 in one go gives 102 - 102 - 0 = 0.
// So the trigger is specifically a PARTIAL fill, which is why every fixture here
// uses a taker whose stake is not a multiple of the layer's.
const LAY_PRICE = 1.51;
const LAY_STAKE = 200;   // the layer's full stake
const FILL = 150;        // the taker's stake — a partial fill of that layer
const REMAINDER = LAY_STAKE - FILL; // 50

check('E1 the documented case really does need a top-up (the fixture is honest)', async () => {
  const oneShot = M.escrowFor('lay', LAY_PRICE, LAY_STAKE);                              // 102, one rounding
  const inParts = M.escrowFor('lay', LAY_PRICE, REMAINDER) + M.escrowFor('lay', LAY_PRICE, FILL); // 26 + 77
  assert.strictEqual(oneShot, 102, 'placement escrow changed; this fixture no longer tests what it claims');
  assert.strictEqual(inParts, 103, 'per-fill rounding no longer exceeds one-shot; #13 is unreachable');
  assert.strictEqual(inParts - oneShot, 1, 'the shortfall is no longer 1 cent');
});

check('E2 an unfunded layer is skipped, and the taker still gets the rest of the book', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, [['Home', 2.0]]);

  // Two layers at the same price. Carol is spent; Bob is fine. Carol has the
  // lower id so she is swept FIRST — the point is that the sweep keeps going
  // past her to Bob rather than unwinding.
  const carolLay = M.placeOrder(db, users.carol, { selection_id: mkt.s1, side: 'lay', price: LAY_PRICE, stake_cents: LAY_STAKE });
  const bobLay = M.placeOrder(db, users.bob, { selection_id: mkt.s1, side: 'lay', price: LAY_PRICE, stake_cents: LAY_STAKE });

  // Drain Carol's available balance WITHOUT touching her frozen escrow, which is
  // what a player who spent their money on something else looks like.
  const c = userRow(db, users.carol.id);
  db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(c.f, users.carol.id);
  assert.strictEqual(userRow(db, users.carol.id).b - userRow(db, users.carol.id).f, 0, 'Carol must have 0 available');

  // Alice backs 50 — deliberately NOT a whole multiple of the layer's stake, so
  // the fill is partial and per-fill rounding bites.
  const res = M.placeOrder(db, users.alice, { selection_id: mkt.s1, side: 'back', price: LAY_PRICE, stake_cents: FILL });

  assert.strictEqual(orderRow(db, carolLay.order.id).status, 'open', 'an unfunded layer must stay open, not matched');
  assert.strictEqual(orderRow(db, carolLay.order.id).matched_cents, 0, 'the unfunded layer was matched anyway');
  // Bob — who had the money — is filled.
  assert.strictEqual(orderRow(db, bobLay.order.id).matched_cents, FILL, 'the funded layer next in the book was not filled');
  assert.strictEqual(res.order.matched_cents, FILL);
});

check('E3 a stranger\'s fill survives another player\'s shortfall (the actual bug)', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, [['Home', 2.0]]);

  // Alice lays FIRST (lower id, swept first) and is funded. Carol lays second and
  // is spent. One taker's sweep agrees a fill against Alice, then reaches Carol
  // — the shortfall happens AFTER a stranger's fill is already on the tape.
  const aliceLay = M.placeOrder(db, users.alice, { selection_id: mkt.s1, side: 'lay', price: LAY_PRICE, stake_cents: LAY_STAKE });
  M.placeOrder(db, users.carol, { selection_id: mkt.s1, side: 'lay', price: LAY_PRICE, stake_cents: LAY_STAKE });

  const c = userRow(db, users.carol.id);
  db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(c.f, users.carol.id);

  const before = matchCount(db);
  // 150 sweeps Alice whole (100) and then reaches Carol for 50 — the partial
  // fill that needs the cent.
  M.placeOrder(db, users.bob, { selection_id: mkt.s1, side: 'back', price: LAY_PRICE, stake_cents: LAY_STAKE + FILL });

  // The point of the whole file: Alice's fill, agreed before Carol's shortfall
  // was reached, must still be on the tape.
  assert.strictEqual(orderRow(db, aliceLay.order.id).matched_cents, LAY_STAKE,
    "a stranger's fill was rolled back by another player's missing cent");
  assert.strictEqual(orderRow(db, aliceLay.order.id).status, 'fully_matched');
  assert.ok(matchCount(db) > before, 'no match rows were written at all — the sweep did nothing');
});

check('E4 no money is created or destroyed by the skip', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, [['Home', 2.0]]);
  const carolLay = M.placeOrder(db, users.carol, { selection_id: mkt.s1, side: 'lay', price: LAY_PRICE, stake_cents: LAY_STAKE });
  const c = userRow(db, users.carol.id);
  db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(c.f, users.carol.id);

  const carolBefore = userRow(db, users.carol.id);
  const totalBefore = [...db.prepare('SELECT balance_cents b FROM users').all()].reduce((s, r) => s + r.b, 0);
  const frozenBefore = db.prepare('SELECT SUM(frozen_cents) f FROM users').get().f;

  M.placeOrder(db, users.alice, { selection_id: mkt.s1, side: 'back', price: LAY_PRICE, stake_cents: FILL });

  const carolAfter = userRow(db, users.carol.id);
  const totalAfter = [...db.prepare('SELECT balance_cents b FROM users').all()].reduce((s, r) => s + r.b, 0);
  const frozenAfter = db.prepare('SELECT SUM(frozen_cents) f FROM users').get().f;

  assert.strictEqual(carolAfter.b, carolBefore.b, "the skipped layer's balance moved");
  assert.strictEqual(carolAfter.f, carolBefore.f, "the skipped layer's escrow moved");
  assert.strictEqual(orderRow(db, carolLay.order.id).frozen_cents, 102,
    'the skipped layer\'s per-order escrow column moved');
  // Alice's stake moved from balance into escrow, so the venue's TOTAL is what
  // must be conserved — a single user's frozen rising is not money appearing.
  assert.strictEqual(totalAfter, totalBefore, 'venue balances are not conserved');
  assert.strictEqual(frozenAfter, frozenBefore + FILL, "the taker's stake did not reach escrow");
});

check('E5 a layer WITH the cent is filled normally — the skip is not a blanket refusal', async () => {
  const { db, users } = await fresh();
  const mkt = mkMarket(db, [['Home', 2.0]]);
  // Same geometry, but Carol keeps 10 cents of slack, so the top-up is payable.
  const carolLay = M.placeOrder(db, users.carol, { selection_id: mkt.s1, side: 'lay', price: LAY_PRICE, stake_cents: LAY_STAKE });
  const c = userRow(db, users.carol.id);
  db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(c.f + 10, users.carol.id);

  M.placeOrder(db, users.alice, { selection_id: mkt.s1, side: 'back', price: LAY_PRICE, stake_cents: FILL });

  const after = orderRow(db, carolLay.order.id);
  assert.strictEqual(after.matched_cents, FILL,
    'a layer with 10 cents of slack was skipped anyway — the affordability check is too strict');
  assert.strictEqual(after.status, 'open', 'a partially filled order must stay open');
  assert.strictEqual(after.frozen_cents, M.escrowFor('lay', LAY_PRICE, REMAINDER), 'the remainder escrow after a partial fill is wrong');
});

(async () => {
  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (e) {
      console.error(`  FAIL ${name}\n       ${e && e.message}`);
      process.exit(1);
    }
    passed++;
    console.log('  ok  ', name);
  }
  console.log(`\nescrow-topup.test.js: ${passed} checks passed`);
})();