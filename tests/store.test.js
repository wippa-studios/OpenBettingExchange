// store.test.js — schema, constraints and connection behaviour.
// Run: node tests/store.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openStore } = require('../lib/store');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

const TABLES = [
  'users', 'sessions', 'sports', 'competitions', 'events', 'markets', 'selections',
  'orders', 'matches', 'price_history', 'settlements', 'transactions', 'settings',
  'audit_log', 'limits',
];

// D1: every table from the domain spec exists, and opening twice is safe.
check('D1 schema is complete and idempotent', async () => {
  const db = openStore(':memory:');
  for (const t of TABLES) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    assert.ok(row, `table ${t} exists`);
  }
  openStore(':memory:').exec('SELECT 1'); // no throw on a fresh open
});

// D2: foreign keys are enforced (a match cannot point at a missing order).
check('D2 foreign keys enforced', async () => {
  const db = openStore(':memory:');
  assert.throws(() => {
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('t', 999, datetime('now'))").run();
  }, /FOREIGN KEY/);
  assert.throws(() => {
    db.prepare("INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents) VALUES (999,999,999,'back',2.0,100)").run();
  }, /FOREIGN KEY/);
});

// D3: the money invariants are enforced by the DATABASE, not only by service
// code: integer cents, non-negative, matched <= stake, price on the ladder.
check('D3 money CHECK constraints', async () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('F','f')").run();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1,'E',datetime('now'))").run();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (1,'M')").run();
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (1,'A',2.0)").run();
  const mkUser = () =>
    db.prepare("INSERT INTO users (username, pass_hash, balance_cents) VALUES (?, 'x', 0)").run('u' + Math.random().toString(36).slice(2)).lastInsertRowid;

  const u = mkUser();
  assert.throws(() => db.prepare('UPDATE users SET balance_cents = -1 WHERE id=?').run(u), /CHECK constraint failed/);
  assert.throws(() => db.prepare('UPDATE users SET frozen_cents = -5 WHERE id=?').run(u), /CHECK constraint failed/);

  const ins = db.prepare(
    "INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents, matched_cents) VALUES (?,1,1,'back',2.0,1000,0)"
  );
  const oid = ins.run(u).lastInsertRowid;
  assert.throws(() => db.prepare('UPDATE orders SET matched_cents = 1001 WHERE id=?').run(oid), /CHECK constraint failed/);
  assert.throws(() => db.prepare('UPDATE orders SET price = 0.5 WHERE id=?').run(oid), /CHECK constraint failed/);
  assert.throws(() => db.prepare('UPDATE orders SET price = 5000 WHERE id=?').run(oid), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE orders SET side = 'sideways' WHERE id=?").run(oid), /CHECK constraint failed/);
  assert.throws(
    () => db.prepare("INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents) VALUES (?,1,1,'lay',2.0,0)").run(u),
    /CHECK constraint failed/
  );
  // a valid update still works
  db.prepare('UPDATE orders SET matched_cents = 1000 WHERE id=?').run(oid);
  assert.strictEqual(db.prepare('SELECT matched_cents m FROM orders WHERE id=?').get(oid).m, 1000);
});

// D4: settlement rows cannot record a negative commission.
check('D4 settlement constraints', async () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('F','f')").run();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1,'E',datetime('now'))").run();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (1,'M')").run();
  const u = db.prepare("INSERT INTO users (username, pass_hash) VALUES ('u','x')").run().lastInsertRowid;
  assert.throws(
    () => db.prepare('INSERT INTO settlements (market_id, user_id, credit_cents, commission_cents, pnl_cents) VALUES (1,?,0,-1,0)').run(u),
    /CHECK constraint failed/
  );
});

// D5: a pre-migration database gains the account columns, and `role` is
// derived from the legacy `is_admin` boolean exactly once. If the derivation
// re-ran on every open it would silently undo a deliberate demotion.
check('D5 accounts migration derives role from is_admin, once', async () => {
  const p = path.join(os.tmpdir(), `ob-migrate-${process.pid}.db`);
  fs.rmSync(p, { force: true });
  try {
    // The users table exactly as it was before the accounts migration.
    const old = new DatabaseSync(p);
    old.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
      is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0,1)),
      balance_cents INTEGER NOT NULL DEFAULT 0,
      frozen_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    old.prepare("INSERT INTO users (username, pass_hash, is_admin) VALUES ('boss','x',1)").run();
    old.prepare("INSERT INTO users (username, pass_hash, is_admin) VALUES ('joel','x',0)").run();
    old.close();

    const db = openStore(p);
    const rows = db.prepare('SELECT username, role, status, email FROM users ORDER BY id').all();
    assert.strictEqual(rows[0].role, 'admin', 'is_admin=1 derives role=admin');
    assert.strictEqual(rows[1].role, 'user');
    assert.strictEqual(rows[0].status, 'active');
    assert.strictEqual(rows[0].email, null);

    // Demote the admin, then reopen. The derivation must NOT run again.
    db.prepare("UPDATE users SET role='user' WHERE username='boss'").run();
    openStore(p).close();
    const after = openStore(p)
      .prepare("SELECT role FROM users WHERE username='boss'").get();
    assert.strictEqual(after.role, 'user', 'demotion survives a reopen');
    openStore(p).close();
  } finally {
    for (const s of ['', '-wal', '-shm']) fs.rmSync(p + s, { force: true });
  }
});

// D6: email identifies at most one account, while accounts without an address
// are unrestricted — NULL must not count as a shared value.
check('D6 email uniqueness is partial', async () => {
  const db = openStore(':memory:');
  const ins = db.prepare('INSERT INTO users (username, pass_hash, email) VALUES (?,?,?)');
  ins.run('a', 'h', null);
  ins.run('b', 'h', null); // many accounts may have no address
  ins.run('c', 'h', 'taken@example.com');
  assert.throws(() => ins.run('d', 'h', 'taken@example.com'), /UNIQUE/);
});

// D7: MIGRATION REGRESSION. A database created before Phase 4's idempotency
// column must upgrade cleanly. This class of bug is easy to reintroduce and
// invisible to every other test, because all of them open a FRESH database
// where SCHEMA and the migrations agree.
//
// The trap it pins: `db.exec(SCHEMA)` runs BEFORE the migrations, and a bare
// CREATE INDEX validates its columns immediately. Putting
// `CREATE INDEX ... ON orders (user_id, client_order_id)` in SCHEMA therefore
// throws "no such column" against an old orders table, and the app cannot boot
// at all — the feature would look fine in CI and break every existing install.
check('D7 a pre-idempotency database upgrades and keeps its orders', async () => {
  const { DatabaseSync } = require('node:sqlite');
  // A FILE, not :memory: — openStore needs to reopen a real database to see
  // it in its pre-migration shape.
  const file = path.join(os.tmpdir(), `ob_mig_${process.pid}.db`);
  fs.rmSync(file, { force: true });
  const seed = new DatabaseSync(file);
  // An orders table in its OLD shape: no client_order_id at all.
  seed.exec(`CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, market_id INTEGER NOT NULL,
    selection_id INTEGER NOT NULL, side TEXT NOT NULL, price REAL NOT NULL,
    stake_cents INTEGER NOT NULL, matched_cents INTEGER NOT NULL DEFAULT 0,
    frozen_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
    placed_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`);
  seed.prepare("INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents) VALUES (1,1,1,'back',2.0,5000)").run();
  seed.close();

  const db = openStore(file); // must not throw
  assert.ok(
    db.prepare("SELECT name FROM pragma_table_info('orders') WHERE name='client_order_id'").get(),
    'column added'
  );
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orders_client_id'").get(),
    'unique index created'
  );
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 1, 'existing order preserved');
  db.close();
  // And a second open is a no-op, not a duplicate-ALTER failure.
  const again = openStore(file);
  assert.strictEqual(again.prepare('SELECT COUNT(*) c FROM orders').get().c, 1);
  again.close();
  fs.rmSync(file, { force: true });
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
  console.log(`\nstore.test.js: ${passed} checks passed`);
})();
