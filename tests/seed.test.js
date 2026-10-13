// seed.test.js — demo seeding is idempotent, and board hygiene ages fixtures.
// Run: node tests/seed.test.js   (plain assert, no deps)
'use strict';

// scrypt cost: this suite creates many accounts and pays the hash once per
// account, but asserts NOTHING about the stored hash format. auth.test.js
// runs at the real default (SCRYPT_N=65536) and owns that coverage.
process.env.SCRYPT_N = '16384';
// Hermeticity: pin the seeded-credential overrides to EMPTY before any lib
// require (process env wins over a real .env file, and an empty value reads
// as "unset" to config's secretVal) — so seeding always uses the documented
// admin123/demo123 defaults this suite asserts, whatever the machine carries.
process.env.ADMIN_PASSWORD = '';
process.env.DEMO_PASSWORD = '';
const assert = require('assert');
const { openStore } = require('../lib/store');
const { seed, seedIfNeeded, rollForwardEvents } = require('../lib/seed');
const A = require('../lib/auth');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

// S1: first run seeds the catalogue and the demo accounts; second run is a
// no-op (guarded by the 'seeded' settings key).
check('S1 seed is idempotent', async () => {
  const db = openStore(':memory:');
  assert.strictEqual(await seedIfNeeded(db), true);
  const first = ['sports', 'competitions', 'events', 'markets', 'selections', 'users'].map((t) => count(db, t));
  assert.strictEqual(await seedIfNeeded(db), false);
  const second = ['sports', 'competitions', 'events', 'markets', 'selections', 'users'].map((t) => count(db, t));
  assert.deepStrictEqual(second, first);
  assert.ok(count(db, 'events') >= 8, 'at least 8 events');
  assert.ok(count(db, 'selections') >= 20, 'at least 20 runners');
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key='seeded'").get().value, '1');
});

// S2: the demo accounts exist with the documented roles and balances.
check('S2 demo accounts', async () => {
  const db = openStore(':memory:');
  await seed(db);
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  const demo = db.prepare("SELECT * FROM users WHERE username='demo'").get();
  const bot = db.prepare("SELECT * FROM users WHERE username='MarketMakers'").get();
  assert.strictEqual(admin.is_admin, 1);
  assert.strictEqual(demo.is_admin, 0);
  assert.strictEqual(bot.is_bot, 1);
  assert.ok((await A.loginUser(db, { username: 'admin', password: 'admin123' })).token);
  assert.ok((await A.loginUser(db, { username: 'demo', password: 'demo123' })).token);
  await assert.rejects(A.loginUser(db, { username: 'demo', password: 'wrong' }), (e) => e.status === 401);
  // bots hold the deepest book
  assert.ok(bot.balance_cents > admin.balance_cents, 'bot bank is the largest');
});

// S3: every seeded selection carries a fair price inside the ladder, so the
// bot can quote it (a fair-priceless runner gets no ladder by design).
check('S3 seeded fair prices are ladder-valid', async () => {
  const { validTick } = require('../lib/odds');
  const db = openStore(':memory:');
  await seed(db);
  const rows = db.prepare('SELECT name, fair_price FROM selections').all();
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(validTick(r.fair_price), `${r.name}: ${r.fair_price} is a ladder tick`);
  }
});

// S4: the seeded showcase book self-heals; a real operator's fixture never
// moves. This check CHANGED MEANING with the off-time gate.
//
// It used to assert that any past-due event became 'live'. That was the whole
// of "rolling forward" before events.starts_at closed markets, and with the gate
// it does nothing at all: the market stays shut on its off time whatever the
// status says. A demo machine left running for a few days therefore showed ten
// markets and refused every bet, and looked broken rather than stale.
//
// So the demo's off TIME is what moves now, and ONLY for events the seed
// created (is_demo = 1). The second half is the load-bearing half: silently
// re-dating an operator's real fixture to keep a demo happy is a far worse
// failure than a stale demo board, so an is_demo = 0 event must be untouched
// even when it is long past due.
check('S4 roll the DEMO book forward in time; leave operator fixtures alone', async () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('F','f')").run();
  const add = (name, starts, status, isDemo) =>
    db
      .prepare('INSERT INTO events (sport_id, name, starts_at, status, is_demo) VALUES (1, ?, ?, ?, ?)')
      .run(name, starts, status, isDemo);
  add('demo-past', '2020-01-01 12:00:00', 'upcoming', 1);
  add('demo-soon', '2099-01-01 12:00:00', 'upcoming', 1);
  add('demo-completed', '2020-01-01 12:00:00', 'completed', 1);
  add('operator-past', '2020-01-01 12:00:00', 'upcoming', 0);

  const startsAt = (n) => db.prepare('SELECT starts_at t FROM events WHERE name=?').get(n).t;
  const operatorBefore = startsAt('operator-past');

  assert.strictEqual(rollForwardEvents(db), 1, 'only the past-due DEMO event rolls');

  // The demo event moved into the future, which is what actually reopens it.
  const rolled = startsAt('demo-past');
  assert.notStrictEqual(rolled, '2020-01-01 12:00:00', 'the past-due demo event was re-dated');
  assert.ok(
    db.prepare("SELECT 1 FROM events WHERE name='demo-past' AND datetime(starts_at) > datetime('now')").get(),
    'and it is now genuinely in the FUTURE, so the off-time gate lets it trade'
  );
  assert.strictEqual(startsAt('demo-soon'), '2099-01-01 12:00:00', 'a future demo event is left alone');
  assert.strictEqual(startsAt('demo-completed'), '2020-01-01 12:00:00', 'a completed demo event is history and is not re-dated');
  assert.strictEqual(startsAt('operator-past'), operatorBefore, 'AN OPERATOR FIXTURE IS NEVER MOVED');
  assert.ok(
    db.prepare("SELECT 1 FROM events WHERE name='operator-past' AND datetime(starts_at) <= datetime('now')").get(),
    'and it stays off, which is correct: the venue does not relocate real events'
  );

  // idempotent: nothing left to roll
  assert.strictEqual(rollForwardEvents(db), 0, 'rolling again is a no-op');
});

// S5: ADMIN_PASSWORD / DEMO_PASSWORD (lib/config.js) override the seeded
// credentials on first run — the operator's escape from the well-known demo
// passwords (server.js warns at boot while the defaults are live).
check('S5 seeded accounts honour ADMIN_PASSWORD/DEMO_PASSWORD from config', async () => {
  const config = require('../lib/config');
  const savedAdmin = config.ADMIN_PASSWORD;
  const savedDemo = config.DEMO_PASSWORD;
  config.ADMIN_PASSWORD = 'admin-override-pw';
  config.DEMO_PASSWORD = 'demo-override-pw';
  try {
    const db = openStore(':memory:');
    await seed(db);
    assert.ok((await A.loginUser(db, { username: 'admin', password: 'admin-override-pw' })).token, 'admin override accepted');
    assert.ok((await A.loginUser(db, { username: 'demo', password: 'demo-override-pw' })).token, 'demo override accepted');
    await assert.rejects(A.loginUser(db, { username: 'admin', password: 'admin123' }), (e) => e.status === 401,
      'the well-known default no longer works');
  } finally {
    config.ADMIN_PASSWORD = savedAdmin;
    config.DEMO_PASSWORD = savedDemo;
  }
});

// S6: the seeded bot comes from lib/bots.js's shared definition — same
// username, same bank — and its password is the documented CONSTANT
// placeholder, which can never log anything in (auth rejects is_bot accounts
// outright, so the constant not being secret is fine).
check('S6 the seeded bot is the shared bot, on a never-usable password', async () => {
  const bots = require('../lib/bots');
  const db = openStore(':memory:');
  await seed(db);
  const bot = db.prepare("SELECT * FROM users WHERE username = 'MarketMakers'").get();
  assert.strictEqual(bot.username, bots.BOT_USERNAME, 'the shared username');
  assert.strictEqual(bot.balance_cents, bots.BOT_BANK_CENTS, 'the shared bank');
  await assert.rejects(A.loginUser(db, { username: bots.BOT_USERNAME, password: bots.BOT_PASSWORD }),
    (e) => e.status === 401,
    'the placeholder password never logs in'
  );
});

// S7: databases created before the flag moved inside seed()'s transaction can
// hold data WITHOUT the flag (the old crash window between COMMIT and the
// flag write). seedIfNeeded must heal the flag instead of re-seeding over
// the catalogue — re-seeding died on sports.slug UNIQUE on every boot, which
// is what bricked the demo this fix removes.
check('S7 a catalogued-but-unflagged database heals instead of re-seeding', async () => {
  const db = openStore(':memory:');
  await seed(db);
  db.prepare("DELETE FROM settings WHERE key = 'seeded'").run(); // simulate the old crash window
  const sportsBefore = count(db, 'sports');
  assert.strictEqual(await seedIfNeeded(db), false, 'recognised as already seeded');
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key='seeded'").get().value, '1', 'flag healed');
  assert.strictEqual(count(db, 'sports'), sportsBefore, 'the catalogue was untouched');
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
  console.log(`\nseed.test.js: ${passed} checks passed`);
})();
