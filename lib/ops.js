'use strict';
// lib/ops.js — operational surface: health, readiness, metrics, backup.
//
// WHAT A VENUE NEEDS AND A DEMO DOES NOT. Anyone running this against real
// money needs four things, none of which are features:
//
//   HEALTH     — is the process alive? For a supervisor/restart policy.
//   READINESS  — should traffic be sent here? Distinct from health: a process
//                that is alive but cannot reach its database is not ready, and
//                reporting "healthy" would send players to a broken venue.
//   METRICS   — what is it doing? Match rate, unmatched ratio, latency, the
//                reconciliation drift count. Numbers an operator watches.
//   BACKUP    — a consistent copy, restorable, WITHOUT stopping the venue.
//
// The last one is the only one that is a genuine liability if missing. A
// single SQLite file holding customer balances, with no snapshot procedure, is
// a venue whose worst day ends in total loss with no recovery path. That is
// not an ops gap; it is the absence of the most basic control.
//
// THE BACKUP IS ONLINE, NOT A FILE COPY. Copying a live SQLite file with `cp`
// can capture a torn page and produce a restore that does not open. SQLite's
// VACUUM INTO takes a transactionally consistent snapshot of a LIVE database
// while writers continue, which is why it is used here instead of fs.copyFile.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const startedAt = Date.now();

// ── Health / readiness ─────────────────────────────────────────────────────

/**
 * Liveness: the process is up and its event loop is turning.
 *
 * Deliberately does NOT touch the database. A liveness probe that queries a
 * dependency will RESTART the process when the dependency is down, which
 * converts a database blip into a crash loop and makes an outage worse.
 */
function health() {
  return {
    status: 'ok',
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    pid: process.pid,
    version: process.env.npm_package_version || null,
  };
}

/**
 * Readiness: can this instance actually serve traffic?
 *
 * Checks the things whose absence makes serving WRONG rather than merely slow:
 * the database must answer, and the ledger must still balance. A venue whose
 * books have drifted is not ready — sending it players would be trading on a
 * book nobody can defend.
 */
function readiness(db) {
  const checks = {};
  let ready = true;

  try {
    db.prepare('SELECT 1').get();
    checks.database = 'ok';
  } catch (e) {
    checks.database = 'unavailable';
    ready = false;
  }

  if (ready) {
    try {
      const accounts = require('./accounts');
      const drift = accounts.assertConserved(db);
      if (drift === 0) {
        checks.ledger = 'balanced';
      } else {
        // Not "down" — but a drifted ledger must not receive traffic.
        checks.ledger = `drift:${drift}`;
        ready = false;
      }
      const divergent = accounts.assertUserAgrees(db).length;
      checks.cache = divergent === 0 ? 'agrees' : `divergent:${divergent}`;
      if (divergent > 0) ready = false;
    } catch (e) {
      checks.ledger = 'error';
      ready = false;
    }
  }

  try {
    const settings = require('./risk');
    checks.risk_desk = settings.killSwitch(db) ? 'killed' : 'live';
  } catch {
    checks.risk_desk = 'unknown';
  }

  // The results feed is reported and deliberately NOT a readiness gate. A dead
  // feed means outcomes arrive late and a human settles — it does not mean the
  // book is wrong, and pulling a healthy, trading venue out of rotation because
  // a results provider is down would be an outage manufactured by a control.
  // It is here so an operator sees it in the same place they look for
  // everything else.
  try {
    const feed = require('./resultsfeed').health();
    checks.results_feed = feed.status;
  } catch {
    checks.results_feed = 'unknown';
  }

  return { status: ready ? 'ready' : 'not_ready', checks };
}

// ── Metrics ────────────────────────────────────────────────────────────────

/**
 * Prometheus-style text exposition. No dependency: the format is a handful of
 * lines and adding a client library to serve it would be absurd.
 *
 * The metrics chosen are the ones an operator actually watches on an exchange:
 * not CPU, but MATCH RATE (are orders matching?), UNMATCHED RATIO (is
 * liquidity there?), MATCHED VOLUME, and the count of markets the results feed
 * is HOLDING — because a rising held count means the feed is falling behind
 * reality and players are sitting in unresolved positions.
 */
function metrics(db) {
  const out = [];
  const push = (name, help, type, value, labels = '') => {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
    out.push(`${name}${labels} ${value}`);
  };

  const count = (sql, ...args) => db.prepare(sql).get(...args).c;

  const orders = count("SELECT COUNT(*) c FROM orders");
  const matches = count('SELECT COUNT(*) c FROM matches');
  const matchedStake = db.prepare('SELECT COALESCE(SUM(stake_cents),0) s FROM matches').get().s;
  const placedStake = db.prepare('SELECT COALESCE(SUM(stake_cents),0) s FROM orders').get().s;

  push('obx_orders_total', 'Orders placed', 'counter', orders);
  push('obx_matches_total', 'Matches executed', 'counter', matches);
  push('obx_matched_stake_cents', 'Total matched stake', 'counter', matchedStake);
  push('obx_placed_stake_cents', 'Total placed stake', 'counter', placedStake);
  // Match rate: fills per order. A venue whose liquidity has dried up shows
  // up here as a collapse long before anyone complains.
  push('obx_match_rate', 'Matches per order placed', 'gauge', orders === 0 ? 0 : +(matches / orders).toFixed(4));
  // Unmatched ratio: how much of what was wanted never found a counterparty.
  push('obx_unmatched_ratio', 'Share of placed stake that never matched', 'gauge',
    placedStake === 0 ? 0 : +(1 - matchedStake / placedStake).toFixed(4));
  push('obx_markets_held', 'Markets held pending manual settlement', 'gauge',
    count('SELECT COUNT(*) c FROM markets WHERE COALESCE(settlement_hold,0)=1'));
  push('obx_reconciliation_open_findings', 'Unresolved reconciliation findings', 'gauge',
    count('SELECT COUNT(*) c FROM reconciliation_findings WHERE resolved_at IS NULL'));
  push('obx_ledger_drift_cents', 'Ledger conservation drift; must be 0', 'gauge',
    require('./accounts').assertConserved(db));
  push('obx_users_total', 'Registered accounts', 'gauge', count('SELECT COUNT(*) c FROM users'));
  push('obx_uptime_seconds', 'Process uptime', 'gauge', Math.floor((Date.now() - startedAt) / 1000));

  return out.join('\n') + '\n';
}

// ── Backup ─────────────────────────────────────────────────────────────────

/**
 * Take a transactionally consistent snapshot of a LIVE database.
 *
 * Uses SQLite's VACUUM INTO, which reads the database inside a read
 * transaction and writes a fresh, compacted, self-consistent file while
 * writers carry on. fs.copyFile over a WAL database can capture a torn page
 * and produce a backup that does not restore — which is worse than no backup,
 * because it is found at the worst possible moment.
 *
 * `retention` prunes old snapshots so this can run on a timer without filling
 * the disk. Pruning is best-effort: a failure to delete an old snapshot must
 * never fail the backup that just succeeded.
 */
function backup(db, { dir, retention = 24, prefix = 'openbettingexchange' } = {}) {
  if (!dir) throw new Error('backup: dir is required');
  fs.mkdirSync(dir, { recursive: true });
    // Milliseconds AND a random suffix. Without both, two backups within the
  // same second collide on the filename and VACUUM INTO refuses to overwrite
  // an existing file — which means a manual backup racing the scheduled one
  // fails, and the operator is left unsure whether they have two or one.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = crypto.randomBytes(3).toString('hex');
  const target = path.join(dir, `${prefix}-${stamp}-${suffix}.db`);

  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

  // Close the snapshot to its owner IMMEDIATELY, before anything else can touch
  // it. SQLite creates the file with the process umask — 0644 on a typical
  // box — so between this line and any later chmod, any local user can read it.
  // It is a consistent snapshot of the whole database, which means every
  // password hash in the `users` table, not just market data.
  //
  // The mode is set rather than loosened, because a file created 0600 can only
  // ever be tightened afterwards by a deliberate act. A snapshot that is briefly
  // world-readable cannot be un-read.
  //
  // `chmod` rather than `mode:` on open: the file is created by SQLite's C layer
  // through this handle, not by fs.openSync, so there is no fd to pass a mode to.
  try {
    fs.chmodSync(target, 0o600);
  } catch (e) {
    // A snapshot we cannot lock down is a snapshot we must not leave behind. The
    // alternative — carrying on and reporting success — leaves a credential dump
    // on disk and logs a successful backup, which is the worst of both.
    try {
      fs.unlinkSync(target);
    } catch { /* the file may never have been created */ }
    throw new Error(
      `backup: could not restrict permissions on ${target} (${e.code || e.message}). ` +
        `Snapshot deleted rather than left readable. Check that the backup ` +
        `filesystem supports chmod — a filesystem mounted noexec/nodev, or a ` +
        `network mount with squashed permissions, will refuse it.`
    );
  }

  // Verify the snapshot actually opens. A backup that cannot be read is not a
  // backup, and the moment to find out is NOW, not during a restore.
  const { DatabaseSync } = require('node:sqlite');
  const probe = new DatabaseSync(target, { readOnly: true });
  try {
    const integrity = probe.prepare('PRAGMA integrity_check').get();
    const ok = Object.values(integrity)[0] === 'ok';
    const users = probe.prepare("SELECT COUNT(*) c FROM users").get().c;
    probe.close();
    if (!ok) throw new Error(`backup: integrity check failed on ${target}`);
    if (retention > 0) prune(dir, retention, prefix);
    return { path: target, bytes: fs.statSync(target).size, users, integrity: 'ok' };
  } catch (e) {
    probe.close();
    fs.rmSync(target, { force: true }); // a failed snapshot must not linger
    throw e;
  }
}

// Keep the N most recent snapshots. Best-effort by design.
function prune(dir, keep, prefix) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
    .sort() // timestamps sort lexicographically, which is chronological here
    .reverse();
  for (const f of files.slice(keep)) {
    try { fs.rmSync(path.join(dir, f)); } catch { /* best effort */ }
  }
}

/**
 * Restore from a snapshot.
 *
 * Refuses to run against a non-empty database unless `force` is set. Silently
 * overwriting a live venue's books is the kind of operation that must be
 * impossible to do by accident — a restore is almost always meant for a
 * RECOVERY, not a casual refresh.
 */
function restore(snapshotPath, dbPath, { force = false } = {}) {
  if (!fs.existsSync(snapshotPath)) throw new Error(`restore: no snapshot at ${snapshotPath}`);
  const { DatabaseSync } = require('node:sqlite');
  const probe = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const integrity = Object.values(probe.prepare('PRAGMA integrity_check').get())[0];
    if (integrity !== 'ok') throw new Error('restore: snapshot failed its integrity check');
  } finally {
    probe.close();
  }
  if (!force && fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    throw new Error('restore: target database is not empty — pass force to overwrite');
  }
  // Copy rather than move: the snapshot must survive a failed restore so the
  // operator can try again without going back to their own backup.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(snapshotPath, dbPath);
  // A stale WAL beside a replaced main database is corruption waiting to
  // happen, so the sidecars go with it.
  for (const suffix of ['-wal', '-shm']) {
    const side = dbPath + suffix;
    if (fs.existsSync(side)) fs.rmSync(side);
  }
  return { path: dbPath, restored_from: snapshotPath };
}

// WAL checkpoint + incremental vacuum, on a timer. Without it a long-running
// venue's -wal file grows without bound and every read pays for it.
function maintenance(db, { walCheckpoint = 'PASSIVE', incrementalVacuum = 200 } = {}) {
  const before = safeWalSize(db);
  try {
    db.exec(`PRAGMA wal_checkpoint(${walCheckpoint})`);
  } catch (e) {
    return { ok: false, error: `wal_checkpoint: ${e.message}` };
  }
  try {
    // Needs auto_vacuum=INCREMENTAL to do anything; harmless otherwise.
    db.exec(`PRAGMA incremental_vacuum(${incrementalVacuum})`);
  } catch { /* not enabled — fine */ }
  return { ok: true, wal_bytes_before: before, wal_bytes_after: safeWalSize(db) };
}

function safeWalSize(db) {
  try {
    const row = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    void row;
    return null;
  } catch {
    return null;
  }
}

module.exports = { health, readiness, metrics, backup, restore, maintenance, prune, startedAt };