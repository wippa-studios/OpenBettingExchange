// drift.test.js — the drift loop's ladder clamping and its transactional
// consistency: a fair-price move and the requote it triggers are ONE unit of
// work, so a failed requote rolls the price move back with it.
// Run: node tests/drift.test.js   (plain assert, no deps, offline)
'use strict';

// scrypt cost: this suite creates many accounts and pays the hash once per
// account, but asserts NOTHING about the stored hash format. auth.test.js
// runs at the real default (SCRYPT_N=65536) and owns that coverage.
process.env.SCRYPT_N = '16384';
// Hermeticity: pin the money knobs the engine reads at require time, so an
// ambient .env can never change what this suite asserts against.
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.FAUCET_MAX_CENTS = '100000';

const assert = require('assert');
const { openStore } = require('../lib/store');
const { tick } = require('../lib/drift');
const bots = require('../lib/bots');
const A = require('../lib/auth');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

// One open market with one fair-priced selection — the only open selection in
// the db, so tick()'s ORDER BY RANDOM() LIMIT 1 picks it deterministically.
// No bot account is pre-created: the default $1M MarketMakers bank is minted
// by the requote, which must SUCCEED in the clamp examples.
function driftFixture(fair) {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('S', 's')").run();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1, 'E', '2099-01-01 00:00:00')").run();
  db.prepare("INSERT INTO markets (event_id, name, status) VALUES (1, 'M', 'open')").run();
  const marketId = db.prepare('SELECT id FROM markets').get().id;
  db.prepare("INSERT INTO selections (market_id, name, fair_price, status) VALUES (?, 'Sel', ?, 'open')").run(
    marketId,
    fair
  );
  const selectionId = db.prepare('SELECT id FROM selections').get().id;
  return { db, marketId, selectionId };
}

const fairOf = (db) => db.prepare('SELECT fair_price FROM selections').get().fair_price;

// R1: at the bottom of the ladder the walk is forced UP (1.01 has no lower
// tick), one step, staying a valid tick inside [1.01, 1000].
check('R1 drift clamps at the bottom: a 1.01 fair price moves up to 1.02', () => {
  const { db } = driftFixture(1.01);
  tick(db);
  const fair = fairOf(db);
  assert.strictEqual(fair, 1.02, 'one tick up off the floor');
  assert.ok(fair >= 1.01 && fair <= 1000, 'inside the ladder range');
});

// R2: at the top of the ladder the walk is forced DOWN (1000 has no higher
// tick), one step: prevTick(1000) = 990. The requote at 990 needs at most
// 3 x round(999 x 20000) = 59,940,000 cents — inside the default $1M bot bank.
check('R2 drift clamps at the top: a 1000 fair price moves down to 990', () => {
  const { db } = driftFixture(1000);
  tick(db);
  const fair = fairOf(db);
  assert.strictEqual(fair, 990, 'one step down from the ceiling');
  assert.ok(fair >= 1.01 && fair <= 1000, 'inside the ladder range');
});

// R3: transactional consistency. A tiny bot bank (200,000 cents) makes the
// requote after a 990 -> 980 move throw on its first lay (escrow at least
// round(989 x 3000) = 2,967,000 cents). The fair_price UPDATE must roll back
// WITH the failed requote — otherwise fair price and ladder silently disagree
// until the next tick. tick() logs and swallows; the DB state is the proof.
check('R3 a failed requote rolls the fair_price move back with it', () => {
  const { db, selectionId } = driftFixture(990);
  A.createAccount(db, {
    username: bots.BOT_USERNAME,
    password: bots.BOT_PASSWORD,
    is_bot: 1,
    balance_cents: 200000, // can never afford a lay at ~990
  });
  tick(db);
  assert.strictEqual(fairOf(db), 990, 'the price move was rolled back');
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
    0,
    'no partial requote survived'
  );
  const bot = db.prepare('SELECT * FROM users WHERE is_bot = 1').get();
  assert.strictEqual(bot.frozen_cents, 0, 'no escrow stranded by a half-done requote');
});

console.log(`\ndrift.test.js: ${passed} checks passed`);
