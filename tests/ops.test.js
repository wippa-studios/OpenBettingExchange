// ops.test.js — health, readiness, metrics, backup/restore, rate limiting.
// Run: node tests/ops.test.js   (plain assert, no deps)
//
// Backup and restore are the tests that matter most here. A venue holding
// customer balances with no recovery path is not "missing a feature" — it is
// missing the most basic control, and the failure is discovered on the worst
// possible day. So the backup is not just created: it is OPENED, integrity
// checked, and RESTORED into a fresh database that is then queried.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const OPS = require('../lib/ops');
const acc = require('../lib/accounts');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

const tmpdir = (tag) => {
  const d = path.join(os.tmpdir(), `obx_ops_${tag}_${process.pid}`);
  fs.rmSync(d, { force: true, recursive: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// O1: liveness must NOT touch the database. A liveness probe that queries a
// dependency restarts the process when that dependency blips, turning a
// database outage into a crash loop — the outage makes it worse.
check('O1 health reports liveness without touching the database', () => {
  const h = OPS.health();
  assert.strictEqual(h.status, 'ok');
  assert.strictEqual(typeof h.uptime_seconds, 'number');
  assert.strictEqual(h.pid, process.pid);
});

// O2: readiness DOES check, and it checks the LEDGER. A venue whose books
// have drifted must not be sent players — it would be trading on a book
// nobody can defend.
check('O2 readiness verifies the database and the ledger', () => {
  const db = openStore(':memory:');
  const r = OPS.readiness(db);
  assert.strictEqual(r.status, 'ready');
  assert.strictEqual(r.checks.database, 'ok');
  assert.strictEqual(r.checks.ledger, 'balanced');
  assert.strictEqual(r.checks.cache, 'agrees');
  db.close();
});

check('O3 readiness reports NOT READY when the ledger drifts', () => {
  const db = openStore(':memory:');
  const u = A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 });
  // Force an unbalanced posting, past the guard, to prove the probe catches it.
  const txId = Number(db.prepare("INSERT INTO transactions (user_id,type,amount_cents,balance_after,frozen_after) VALUES (?,'deposit',1,1,0)").run(u.id).lastInsertRowid);
  db.prepare("INSERT INTO entries (transaction_id, account_id, direction, amount_cents) VALUES (?,?,'credit',500)").run(txId, acc.accountId(db, 'house_float', null));
  const r = OPS.readiness(db);
  assert.strictEqual(r.status, 'not_ready', 'refuses traffic when the books do not balance');
  assert.ok(r.checks.ledger.startsWith('drift:'));
  db.close();
});

// O4: metrics are the ones an operator actually watches on an exchange —
// match rate and unmatched ratio, not CPU.
check('O4 metrics expose match rate, unmatched ratio and drift', () => {
  const db = openStore(':memory:');
  const m = OPS.metrics(db);
  assert.ok(m.includes('obx_match_rate'), 'match rate');
  assert.ok(m.includes('obx_unmatched_ratio'), 'unmatched ratio');
  assert.ok(m.includes('obx_ledger_drift_cents 0'), 'drift is zero on a healthy book');
  assert.ok(m.includes('obx_reconciliation_open_findings'), 'reconciliation drift count');
  assert.ok(m.includes('obx_markets_held'), 'held markets — a rising count means the feed is behind');
  assert.ok(/^# TYPE obx_match_rate gauge$/m.test(m), 'well-formed exposition');
  db.close();
});

// O5: BACKUP. The real test: the snapshot must be restorable, not merely
// present. A backup nobody has ever opened is a hope, not a backup.
check('O5 backup produces a snapshot that opens, passes integrity, and restores', () => {
  const dir = tmpdir('backup');
  const dbPath = path.join(dir, 'live.db');
  const db = openStore(dbPath);
  A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 });
  A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 50000 });
  db.close();

  const live = openStore(dbPath);
  const snap = OPS.backup(live, { dir: path.join(dir, 'snapshots'), retention: 5 });
  live.close();

  assert.ok(fs.existsSync(snap.path), 'snapshot written');
  assert.strictEqual(snap.integrity, 'ok', 'and passed an integrity check at creation time');
  assert.strictEqual(snap.users, 2, 'with the users in it');

  // Restore into a FRESH path and query it. This is the step that matters.
  const restoredPath = path.join(dir, 'restored.db');
  const r = OPS.restore(snap.path, restoredPath);
  assert.strictEqual(r.path, restoredPath);
  const restored = openStore(restoredPath);
  assert.strictEqual(restored.prepare('SELECT COUNT(*) c FROM users').get().c, 2, 'users survived the round trip');
  const alice = restored.prepare("SELECT balance_cents b FROM users WHERE username='alice'").get();
  assert.strictEqual(alice.b, 100000, 'and their balance is intact');
  assert.strictEqual(acc.assertConserved(restored), 0, 'the restored ledger still balances');
  restored.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// O6: backup works on a LIVE database. This is the whole reason for using
// VACUUM INTO rather than copying the file — a plain copy of a WAL database
// can be torn.
check('O6 backup is consistent while the database is open for writes', () => {
  const dir = tmpdir('live');
  const dbPath = path.join(dir, 'live.db');
  const db = openStore(dbPath);
  const u = A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 });
  const snap = OPS.backup(db, { dir: path.join(dir, 'snap'), retention: 3 });
  // Write AFTER the snapshot: the snapshot must not contain it.
  A.registerUser(db, { username: 'later', password: 'pw-later-123', balance_cents: 1000 });
  db.close();

  const snapDb = openStore(snap.path);
  const names = snapDb.prepare('SELECT username FROM users').all().map((r) => r.username);
  assert.ok(names.includes('alice'));
  assert.ok(!names.includes('later'), 'the snapshot is a point-in-time, not a live view');
  snapDb.close();
  void u;
  fs.rmSync(dir, { recursive: true, force: true });
});

// O7: retention. A backup timer with no pruning fills the disk, and a full
// disk stops the venue as surely as a lost one.
check('O7 retention prunes old snapshots and keeps the newest', () => {
  const dir = tmpdir('retain');
  const snapDir = path.join(dir, 'snap');
  const dbPath = path.join(dir, 'live.db');
  for (let i = 0; i < 5; i++) {
    const db = openStore(dbPath);
    OPS.backup(db, { dir: snapDir, retention: 3 });
    db.close();
  }
  const files = fs.readdirSync(snapDir).filter((f) => f.endsWith('.db'));
  assert.strictEqual(files.length, 3, 'pruned to the retention count');
  fs.rmSync(dir, { recursive: true, force: true });
});

// O8: restore refuses to clobber a live venue without an explicit force.
// Silently overwriting a book of balances is the operation that must be
// impossible to do by accident.
check('O8 restore refuses a non-empty target unless forced', () => {
  const dir = tmpdir('restore');
  const dbPath = path.join(dir, 'live.db');
  const db = openStore(dbPath);
  A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 });
  const snap = OPS.backup(db, { dir: path.join(dir, 'snap') });
  db.close();

  assert.throws(() => OPS.restore(snap.path, dbPath), /not empty/);
  // Forced restore works, and the snapshot SURVIVES it so a failed restore can
  // be retried without going back to the operator's own backup.
  OPS.restore(snap.path, dbPath, { force: true });
  assert.ok(fs.existsSync(snap.path), 'the snapshot is copied, not moved');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('O9 restore rejects a corrupt snapshot rather than installing it', () => {
  const dir = tmpdir('corrupt');
  const bad = path.join(dir, 'bad.db');
  fs.writeFileSync(bad, 'this is not a database');
  assert.throws(() => OPS.restore(bad, path.join(dir, 'out.db')), /could not open|not a database|integrity/i);
  assert.ok(!fs.existsSync(path.join(dir, 'out.db')), 'and nothing was installed');
  fs.rmSync(dir, { recursive: true, force: true });
});

// O10: maintenance. A long-running venue's -wal grows without bound unless
// something checkpoints it.
check('O10 maintenance checkpoints the WAL', () => {
  const dir = tmpdir('maint');
  const db = openStore(path.join(dir, 'live.db'));
  A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 });
  const m = OPS.maintenance(db);
  assert.strictEqual(m.ok, true);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// R1: the volume limiter caps requests from a caller making only VALID
// requests — the case the failure-based login limiter cannot see at all.
check('R1 volume limiting caps a burst of valid requests', () => {
  const { limit, volumeExceeded, resetVolumeLimits } = require('../server');
  resetVolumeLimits(); // isolate from any earlier test's counters
  const req = { user: { id: 1 }, socket: { remoteAddress: '127.0.0.1' } };
  // trade allows 120/min, so a 200-request burst is blocked exactly 80 times.
  let blocked = 0;
  for (let i = 0; i < 200; i++) if (volumeExceeded(req, 'trade') > 0) blocked++;
  assert.strictEqual(blocked, 80, 'exactly the requests beyond the budget were blocked');
  void limit;
});

// R2: the budget is PER USER, not per IP. One noisy client must not exhaust
// everyone else's budget behind the same NAT or proxy.
check('R2 the volume budget is per user, not per IP', () => {
  const { volumeExceeded, resetVolumeLimits } = require('../server');
  resetVolumeLimits();
  const noisy = { user: { id: 7 }, socket: { remoteAddress: '10.0.0.1' } };
  for (let i = 0; i < 200; i++) volumeExceeded(noisy, 'admin');
  // Same IP, different user: untouched budget.
  const quiet = { user: { id: 8 }, socket: { remoteAddress: '10.0.0.1' } };
  assert.strictEqual(volumeExceeded(quiet, 'admin'), 0, 'a different user is unaffected');
});

// R3: buckets are independent. Exhausting trading budget must not lock a user
// out of reading their own balance.
check('R3 buckets are independent of one another', () => {
  const { volumeExceeded, resetVolumeLimits } = require('../server');
  resetVolumeLimits();
  const req = { user: { id: 9 }, socket: { remoteAddress: '127.0.0.1' } };
  for (let i = 0; i < 200; i++) volumeExceeded(req, 'trade');
  assert.strictEqual(volumeExceeded(req, 'wallet'), 0, 'trade exhaustion does not block wallet');
  assert.strictEqual(volumeExceeded(req, 'read'), 0, 'nor reads');
  resetVolumeLimits();
});

console.log(`\nops.test.js: ${passed} checks passed`);
if (passed < 13) { console.error('expected 13 checks'); process.exit(1); }