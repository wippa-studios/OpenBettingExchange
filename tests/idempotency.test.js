// idempotency.test.js — client_order_id (order placement idempotency).
// Run: node tests/idempotency.test.js   (plain assert, no deps)
//
// WHY THIS EXISTS. At operator scale a double-submit is a FINANCIAL INCIDENT,
// not an annoyance: a retried POST on a flaky connection would place the bet
// twice and escrow the stake twice. The tests that matter here are the ones
// proving the SECOND request changes nothing at all — not just that it
// returns the same order.
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
const acc = require('../lib/accounts');
const settle = require('../lib/settle');

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
  const sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  n++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now','+2 hours'))").run(sport.id, `Ev ${n}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Ev ${n}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  const sels = [];
  for (const nm of ['Alpha', 'Beta']) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, nm);
    sels.push(db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, nm).id);
  }
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 }));
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 100000 }));
  return { db, alice, bob, marketId: mkt.id, s1: sels[0], s2: sels[1] };
}

const wallet = (db, id) => db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id=?').get(id);
const orderCount = (db, userId) => db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=?').get(userId).c;

// I1: a repeated request returns the SAME order and changes nothing. The
// escrow is the thing that would actually hurt, so it is asserted directly
// rather than inferred from the order count.
check('I1 a repeat request returns the same order and takes no second escrow', async () => {
  const { db, alice, s1 } = (await fixture());
  const req = { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5000, client_order_id: 'retry-me-1' };
  const first = M.placeOrder(db, alice, req);
  const w1 = wallet(db, alice.id);
  const second = M.placeOrder(db, alice, req);
  const w2 = wallet(db, alice.id);

  assert.strictEqual(second.order.id, first.order.id, 'same order id');
  assert.strictEqual(second.idempotent_replay, true, 'flagged as a replay');
  assert.deepStrictEqual(second.fills, [], 'and reports no fills');
  assert.strictEqual(orderCount(db, alice.id), 1, 'no second order');
  assert.strictEqual(w2.f, w1.f, 'escrow taken ONCE');
  assert.strictEqual(w1.f, 5000);
});

// I2: without a key, behaviour is unchanged. Every existing caller omits it
// and must keep placing orders normally — this feature is opt-in.
check('I2 orders without a key are unaffected', async () => {
  const { db, alice, s1 } = (await fixture());
  const a = M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5000 });
  const b = M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5000 });
  assert.notStrictEqual(a.order.id, b.order.id, 'two distinct orders');
  assert.strictEqual(b.idempotent_replay, undefined);
  assert.strictEqual(orderCount(db, alice.id), 2);
  assert.strictEqual(wallet(db, alice.id).f, 10000, 'both escrowed');
});

// I3: keys are scoped PER USER. Two players may legitimately generate the
// same key; neither being blocked is the correct outcome, and a collision
// must never let one player read or interfere with another's order.
check('I3 the same key from two users creates two orders', async () => {
  const { db, alice, bob, s1 } = (await fixture());
  const a = M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5000, client_order_id: 'same-key' });
  const b = M.placeOrder(db, bob, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5000, client_order_id: 'same-key' });
  assert.notStrictEqual(a.order.id, b.order.id);
  assert.strictEqual(b.idempotent_replay, undefined);
  assert.strictEqual(orderCount(db, alice.id), 1);
  assert.strictEqual(orderCount(db, bob.id), 1);
});

// I4: a replay returns the order to its OWNER only. Alice replaying with
// Bob's key must not hand her Bob's order — that would be an IDOR created by
// the idempotency feature itself.
check('I4 a replay never returns another user\'s order', async () => {
  const { db, alice, bob, s1 } = (await fixture());
  const bobs = M.placeOrder(db, bob, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5000, client_order_id: 'bob-key' });
  const asAlice = M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5000, client_order_id: 'bob-key' });
  assert.notStrictEqual(asAlice.order.id, bobs.order.id, 'alice got her OWN order');
  assert.strictEqual(asAlice.order.user_id, alice.id);
  assert.strictEqual(orderCount(db, alice.id), 1, 'and it was placed, not replayed');
});

// I5: a replay must not re-run the match sweep. If the first order matched,
// the replay reports the SAME fills rather than matching again — otherwise
// "idempotent" would mean idempotent only for resting orders.
check('I5 a replay of a MATCHED order does not match again', async () => {
  const { db, alice, bob, s1 } = (await fixture());
  M.placeOrder(db, bob, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5000 });
  const req = { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 5000, client_order_id: 'match-once' };
  const first = M.placeOrder(db, alice, req);
  assert.strictEqual(first.fills.length, 1, 'matched on the first attempt');
  const matchesAfterFirst = db.prepare('SELECT COUNT(*) c FROM matches').get().c;
  const second = M.placeOrder(db, alice, req);
  assert.strictEqual(second.order.id, first.order.id);
  assert.deepStrictEqual(second.fills, []);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM matches').get().c, matchesAfterFirst, 'no second match');
});

// I6: the money path is untouched by a replay. Conservation and the
// cache/postings agreement must still hold after a duplicate submit.
check('I6 a duplicate submit leaves the books exactly as one submit would', async () => {
  const { db, alice, s1 } = (await fixture());
  const req = { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5000, client_order_id: 'money-once' };
  M.placeOrder(db, alice, req);
  for (let i = 0; i < 5; i++) M.placeOrder(db, alice, req);
  assert.strictEqual(wallet(db, alice.id).f, 5000, 'escrow for ONE order');
  assert.strictEqual(acc.assertConserved(db), 0);
  assert.deepStrictEqual(acc.assertUserAgrees(db), []);
});

// I7: the UNIQUE index is the real guard, not the read. Simulate the race by
// inserting a conflicting order directly and confirming the index refuses it.
check('I7 the unique index refuses a duplicate key even without the read check', async () => {
  const { db, alice, s1 } = (await fixture());
  M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5000, client_order_id: 'db-guard' });
  assert.throws(
    () => db.prepare(
      `INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents, matched_cents, frozen_cents, status, placed_at, client_order_id)
       VALUES (?, ?, ?, 'back', 2.0, 5000, 0, 0, 'open', datetime('now'), 'db-guard')`
    ).run(alice.id, 1, s1),
    /UNIQUE/
  );
});

// I8: NULL keys do not collide. Ordinary orders must remain ordinary — if
// NULLs collided, every non-idempotent order would become a singleton.
check('I8 orders with no key do not collide with each other', async () => {
  const { db, alice, s1 } = (await fixture());
  for (let i = 0; i < 3; i++) {
    assert.ok(M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 1000 }).order.id);
  }
  assert.strictEqual(orderCount(db, alice.id), 3);
});

// I9: a malformed key is refused rather than silently coerced. A key that
// came from a client doing something unsupported should be an error the client
// can see, not a mangled value stored in the book.
check('I9 malformed idempotency keys are refused, not coerced', async () => {
  const { db, alice, s1 } = (await fixture());
  const bad = [
    'x'.repeat(65),              // too long
    'has space',                  // whitespace
    'semi;colon',                 // semicolon is not in the allowlist
    "quote'and\"dquote",
    '<script>',                   // injection-shaped
    12345,                        // not a string
  ];
  for (const k of bad) {
    assert.throws(
      () => M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 1000, client_order_id: k }),
      /client_order_id/,
      `should refuse ${JSON.stringify(k)}`
    );
  }
  assert.strictEqual(orderCount(db, alice.id), 0, 'nothing was placed by any bad key');
  // An empty or whitespace-only key means "not supplied", not "id 0".
  assert.ok(M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 1000, client_order_id: '   ' }).order.id);
});

// I10: a replay survives settlement. If the original order settles and the
// client retries, the replay must still return the settled order rather than
// erroring or re-placing.
check('I10 a replay after settlement still returns the original order', async () => {
  const { db, alice, bob, marketId, s1 } = (await fixture());
  const req = { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5000, client_order_id: 'settled-then-retried' };
  const first = M.placeOrder(db, alice, req);
  M.placeOrder(db, bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 5000 });
  settle.settleMarket(db, marketId, { winner_selection_id: s1 });
  const after = M.placeOrder(db, alice, req);
  assert.strictEqual(after.order.id, first.order.id);
  assert.strictEqual(after.idempotent_replay, true);
  assert.strictEqual(after.fills.length, 0, 'and does not re-match a settled market');
  assert.strictEqual(acc.assertConserved(db), 0);
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
  if (passed < 10) { console.error('expected 10 checks'); process.exit(1); }
  console.log(`\nidempotency.test.js: ${passed} checks passed`);
})();
