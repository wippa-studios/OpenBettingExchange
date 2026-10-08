// seed.test.js — demo seeding is idempotent, and board hygiene ages fixtures.
// Run: node tests/seed.test.js   (plain assert, no deps)
'use strict';
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
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

// S1: first run seeds the catalogue and the demo accounts; second run is a
// no-op (guarded by the 'seeded' settings key).
check('S1 seed is idempotent', () => {
  const db = openStore(':memory:');
  assert.strictEqual(seedIfNeeded(db), true);
  const first = ['sports', 'competitions', 'events', 'markets', 'selections', 'users'].map((t) => count(db, t));
  assert.strictEqual(seedIfNeeded(db), false);
  const second = ['sports', 'competitions', 'events', 'markets', 'selections', 'users'].map((t) => count(db, t));
  assert.deepStrictEqual(second, first);
  assert.ok(count(db, 'events') >= 8, 'at least 8 events');
  assert.ok(count(db, 'selections') >= 20, 'at least 20 runners');
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key='seeded'").get().value, '1');
});

// S2: the demo accounts exist with the documented roles and balances.
check('S2 demo accounts', () => {
  const db = openStore(':memory:');
  seed(db);
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  const demo = db.prepare("SELECT * FROM users WHERE username='demo'").get();
  const bot = db.prepare("SELECT * FROM users WHERE username='MarketMakers'").get();
  assert.strictEqual(admin.is_admin, 1);
  assert.strictEqual(demo.is_admin, 0);
  assert.strictEqual(bot.is_bot, 1);
  assert.ok(A.loginUser(db, { username: 'admin', password: 'admin123' }).token);
  assert.ok(A.loginUser(db, { username: 'demo', password: 'demo123' }).token);
  assert.throws(() => A.loginUser(db, { username: 'demo', password: 'wrong' }), (e) => e.status === 401);
  // bots hold the deepest book
  assert.ok(bot.balance_cents > admin.balance_cents, 'bot bank is the largest');
});

// S3: every seeded selection carries a fair price inside the ladder, so the
// bot can quote it (a fair-priceless runner gets no ladder by design).
check('S3 seeded fair prices are ladder-valid', () => {
  const { validTick } = require('../lib/odds');
  const db = openStore(':memory:');
  seed(db);
  const rows = db.prepare('SELECT name, fair_price FROM selections').all();
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(validTick(r.fair_price), `${r.name}: ${r.fair_price} is a ladder tick`);
  }
});

// S4: past-due fixtures become 'live' so a long-running demo keeps a board;
// future events and completed events are left alone.
check('S4 roll forward past-due events', () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('F','f')").run();
  const add = (name, starts, status) =>
    db
      .prepare('INSERT INTO events (sport_id, name, starts_at, status) VALUES (1, ?, ?, ?)')
      .run(name, starts, status);
  add('past-upcoming', '2020-01-01 12:00:00', 'upcoming');
  add('soon-upcoming', '2099-01-01 12:00:00', 'upcoming');
  add('past-completed', '2020-01-01 12:00:00', 'completed');
  assert.strictEqual(rollForwardEvents(db), 1);
  const status = (n) => db.prepare('SELECT status s FROM events WHERE name=?').get(n).s;
  assert.strictEqual(status('past-upcoming'), 'live');
  assert.strictEqual(status('soon-upcoming'), 'upcoming');
  assert.strictEqual(status('past-completed'), 'completed');
  // idempotent: nothing left to roll
  assert.strictEqual(rollForwardEvents(db), 0);
});

// S5: ADMIN_PASSWORD / DEMO_PASSWORD (lib/config.js) override the seeded
// credentials on first run — the operator's escape from the well-known demo
// passwords (server.js warns at boot while the defaults are live).
check('S5 seeded accounts honour ADMIN_PASSWORD/DEMO_PASSWORD from config', () => {
  const config = require('../lib/config');
  const savedAdmin = config.ADMIN_PASSWORD;
  const savedDemo = config.DEMO_PASSWORD;
  config.ADMIN_PASSWORD = 'admin-override-pw';
  config.DEMO_PASSWORD = 'demo-override-pw';
  try {
    const db = openStore(':memory:');
    seed(db);
    assert.ok(A.loginUser(db, { username: 'admin', password: 'admin-override-pw' }).token, 'admin override accepted');
    assert.ok(A.loginUser(db, { username: 'demo', password: 'demo-override-pw' }).token, 'demo override accepted');
    assert.throws(() => A.loginUser(db, { username: 'admin', password: 'admin123' }), (e) => e.status === 401,
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
check('S6 the seeded bot is the shared bot, on a never-usable password', () => {
  const bots = require('../lib/bots');
  const db = openStore(':memory:');
  seed(db);
  const bot = db.prepare("SELECT * FROM users WHERE username = 'MarketMakers'").get();
  assert.strictEqual(bot.username, bots.BOT_USERNAME, 'the shared username');
  assert.strictEqual(bot.balance_cents, bots.BOT_BANK_CENTS, 'the shared bank');
  assert.throws(
    () => A.loginUser(db, { username: bots.BOT_USERNAME, password: bots.BOT_PASSWORD }),
    (e) => e.status === 401,
    'the placeholder password never logs in'
  );
});

// S7: databases created before the flag moved inside seed()'s transaction can
// hold data WITHOUT the flag (the old crash window between COMMIT and the
// flag write). seedIfNeeded must heal the flag instead of re-seeding over
// the catalogue — re-seeding died on sports.slug UNIQUE on every boot, which
// is what bricked the demo this fix removes.
check('S7 a catalogued-but-unflagged database heals instead of re-seeding', () => {
  const db = openStore(':memory:');
  seed(db);
  db.prepare("DELETE FROM settings WHERE key = 'seeded'").run(); // simulate the old crash window
  const sportsBefore = count(db, 'sports');
  assert.strictEqual(seedIfNeeded(db), false, 'recognised as already seeded');
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key='seeded'").get().value, '1', 'flag healed');
  assert.strictEqual(count(db, 'sports'), sportsBefore, 'the catalogue was untouched');
});

console.log(`\nseed.test.js: ${passed} checks passed`);
