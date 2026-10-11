'use strict';
// lib/store.js — SQLite (node:sqlite) schema + connection.
// Money is INTEGER cents everywhere; prices REAL (2dp). The opener accepts a
// file path or ':memory:' so tests run offline without touching data/.
//
// Every money column carries a fractional-cents guard
// (col = CAST(col AS INTEGER)): SQLite's INTEGER affinity silently ACCEPTS
// 500.5 (it stores the REAL), so "integer cents" is enforced by the database
// itself, not only by service-layer Number.isInteger checks.
//
// Foreign keys are declared on every reference — including
// markets.winner_selection_id, transactions.order_id and transactions.market_id
// — and enforced per connection (PRAGMA foreign_keys = ON below): a
// settlement can never point at a market or order that does not exist.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  -- Optional contact address. NULL for accounts that never supplied one (and
  -- for bots). Uniqueness is a PARTIAL index (below) rather than a column
  -- constraint, so many accounts may have no address while a supplied one
  -- still identifies exactly one account. /api/auth/login accepts either
  -- identifier.
  email TEXT,
  pass_hash TEXT NOT NULL,
  -- Authoritative privilege flag. 'admin' holds every permission; 'user' holds
  -- none beyond their own account. is_admin is the LEGACY mirror, retained
  -- only so pre-migration databases keep a valid value and older callers
  -- still read something sane; it is backfilled from here once and is not
  -- authoritative. See migrateUserAccounts().
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0,1)),
  -- Account lifecycle, distinct from role: a suspended admin is still an
  -- admin, they just cannot act. Kept separate so a suspension never silently
  -- changes what an account is permitted to do.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  -- Self-exclusion. The FLAG and the DATE are separate because "permanently
  -- excluded" and "not excluded" must both be expressible: a NULL date alone
  -- is ambiguous between the two, and reading permanent exclusion as "never
  -- excluded" is the worst possible failure of a responsible-gambling
  -- control.
  --   self_excluded=0                -> not excluded (regardless of date)
  --   self_excluded=1, until NULL    -> PERMANENT, no re-admission
  --   self_excluded=1, until <ts>    -> excluded until that moment
  -- Kept SEPARATE from 'status' because exclusion outranks open positions and
  -- has no re-admission path on the same surface: 'status' is an operator
  -- toggle, this is a player's own absolute request.
  self_excluded INTEGER NOT NULL DEFAULT 0 CHECK (self_excluded IN (0,1)),
  excluded_until TEXT,
  password_changed_at TEXT,
  -- Money: integer cents. frozen <= balance is enforced by the service layer
  -- (ledger escrow checks); the database guards the cents invariant itself.
  --
  -- The House counterparty (is_bot = 1) is exempt from the non-negative check.
  -- With no user-to-user matching there is no pot to pay winners from: when a
  -- bet is won the house owes (price-1)*stake out of its own balance, so it
  -- MUST be allowed to go negative or the CHECK would block the payout. Every
  -- human account stays non-negative, which is the invariant that matters.
  balance_cents INTEGER NOT NULL DEFAULT 0
    CHECK (is_bot = 1 OR balance_cents >= 0)
    CHECK (balance_cents = CAST(balance_cents AS INTEGER)),
  frozen_cents INTEGER NOT NULL DEFAULT 0
    CHECK (frozen_cents >= 0)
    CHECK (frozen_cents = CAST(frozen_cents AS INTEGER)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sport_id INTEGER NOT NULL REFERENCES sports(id),
  name TEXT NOT NULL,
  country TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sport_id INTEGER NOT NULL REFERENCES sports(id),
  competition_id INTEGER REFERENCES competitions(id),
  name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('upcoming','live','completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','suspended','settled')),
  winner_selection_id INTEGER REFERENCES selections(id),
  settled_at TEXT,
  total_matched_cents INTEGER NOT NULL DEFAULT 0
    CHECK (total_matched_cents >= 0)
    CHECK (total_matched_cents = CAST(total_matched_cents AS INTEGER))
);

CREATE TABLE IF NOT EXISTS selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','suspended','void')),
  fair_price REAL,
  ltp REAL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  market_id INTEGER NOT NULL REFERENCES markets(id),
  selection_id INTEGER NOT NULL REFERENCES selections(id),
  side TEXT NOT NULL CHECK (side IN ('back','lay')),
  price REAL NOT NULL CHECK (price >= 1.01 AND price <= 1000),
  stake_cents INTEGER NOT NULL
    CHECK (stake_cents > 0)
    CHECK (stake_cents = CAST(stake_cents AS INTEGER)),
  matched_cents INTEGER NOT NULL DEFAULT 0
    CHECK (matched_cents >= 0 AND matched_cents <= stake_cents)
    CHECK (matched_cents = CAST(matched_cents AS INTEGER)),
  -- Per-order escrow source of truth: the escrow held against the
  -- UNMATCHED remainder — exactly what a cancel (or settlement's
  -- auto-cancel) releases. The MATCHED part's liability stays frozen in
  -- the wallet on top of this column until settlement releases it.
  -- Maintained by lib/match.js; pre-column databases are backfilled by
  -- the migration in openStore() below.
  frozen_cents INTEGER NOT NULL DEFAULT 0
    CHECK (frozen_cents >= 0)
    CHECK (frozen_cents = CAST(frozen_cents AS INTEGER)),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','fully_matched','cancelled')),
  placed_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  selection_id INTEGER NOT NULL REFERENCES selections(id),
  back_order_id INTEGER NOT NULL REFERENCES orders(id),
  lay_order_id INTEGER NOT NULL REFERENCES orders(id),
  price REAL NOT NULL CHECK (price >= 1.01 AND price <= 1000),
  stake_cents INTEGER NOT NULL
    CHECK (stake_cents > 0)
    CHECK (stake_cents = CAST(stake_cents AS INTEGER)),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Write-only trade tape: one row per fill, kept for LTP charts / audits.
-- Retention: rows are never pruned (a demo's worth is tiny); the index
-- below keeps per-runner history reads linear as the tape grows.
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  selection_id INTEGER NOT NULL REFERENCES selections(id),
  price REAL NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  credit_cents INTEGER NOT NULL DEFAULT 0
    CHECK (credit_cents >= 0)
    CHECK (credit_cents = CAST(credit_cents AS INTEGER)),
  commission_cents INTEGER NOT NULL DEFAULT 0
    CHECK (commission_cents >= 0)
    CHECK (commission_cents = CAST(commission_cents AS INTEGER)),
  pnl_cents INTEGER NOT NULL DEFAULT 0
    CHECK (pnl_cents = CAST(pnl_cents AS INTEGER)),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL
    CHECK (type IN ('deposit','escrow','release','settle','commission','refund','adjust')),
  amount_cents INTEGER NOT NULL
    CHECK (amount_cents = CAST(amount_cents AS INTEGER)),
  balance_after INTEGER NOT NULL
    CHECK (balance_after = CAST(balance_after AS INTEGER)),
  frozen_after INTEGER NOT NULL
    CHECK (frozen_after = CAST(frozen_after AS INTEGER)),
  order_id INTEGER REFERENCES orders(id),
  market_id INTEGER REFERENCES markets(id),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Append-only record of OPERATOR actions (suspend, role change, balance
-- adjustment, settlement, catalogue edits) — deliberately separate from the
-- transactions table, which records only movements of money. An audit row is
-- written even when no money moves, which is exactly the case that the
-- transactions table cannot express.
--
-- actor_id is NULL for actions taken by the system itself (an automatic
-- settlement, a drift tick); actor_id set means a human operator acted.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  -- Free-form subject of the action, e.g. 'user:42' or 'market:7'.
  target TEXT,
  -- JSON snapshots of the affected fields before and after. Small by
  -- construction: only the fields the action actually changed.
  before TEXT,
  after TEXT,
  -- Operator-supplied cause. A limit breach a player can appeal needs one.
  reason TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Email uniqueness is partial so accounts without an address do not collide
-- on NULL. These three index users columns, so they are created by
-- migrateUserAccounts() AFTER it has guaranteed the columns exist — running
-- them here would fail against a pre-migration database whose users table has
-- no email/role/status yet.

-- Per-user ABUSE limits. NOT a solvency control — every match is collateralised
-- on both sides, so a player cannot lose more than their escrow covers. These
-- bound what one ACCOUNT can do (one player wedging a market open), not what
-- the venue can lose. The venue's real unbounded liability is the market
-- maker; see lib/risk.js.
--
-- A missing row means NO CAP on every axis. NULL columns mean "no cap on this
-- axis", and 0 is a real zero — the absence of a restriction must never be
-- read as a cap of nothing, which would silently freeze every account.
--
-- Scope is 'global' or 'market:<id>'; a market row overrides the global row
-- PER AXIS (not wholesale), so setting a market liability cap does not clear
-- the user's global daily cap.
CREATE TABLE IF NOT EXISTS limits (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope = 'global' OR scope LIKE 'market:%'),
  max_open_stake_cents INTEGER
    CHECK (max_open_stake_cents IS NULL OR (max_open_stake_cents >= 0 AND max_open_stake_cents = CAST(max_open_stake_cents AS INTEGER))),
  max_market_liability_cents INTEGER
    CHECK (max_market_liability_cents IS NULL OR (max_market_liability_cents >= 0 AND max_market_liability_cents = CAST(max_market_liability_cents AS INTEGER))),
  max_daily_settled_cents INTEGER
    CHECK (max_daily_settled_cents IS NULL OR (max_daily_settled_cents >= 0 AND max_daily_settled_cents = CAST(max_daily_settled_cents AS INTEGER))),
  PRIMARY KEY (user_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log (target, id);

CREATE INDEX IF NOT EXISTS idx_orders_book ON orders (selection_id, side, price, id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, status);
CREATE INDEX IF NOT EXISTS idx_matches_selection ON matches (selection_id);
CREATE INDEX IF NOT EXISTS idx_matches_market ON matches (market_id);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions (user_id, id);
-- settledFor() scans a user's settlement history; the settlements table
-- grows forever, so without this index every wallet history read is a
-- full table scan.
CREATE INDEX IF NOT EXISTS idx_settlements_user ON settlements (user_id, id);
-- Per-runner trade-tape reads (see the price_history comment above).
CREATE INDEX IF NOT EXISTS idx_price_history_selection ON price_history (selection_id, at);
`;

// Does `table` have a column named `column`? Uses the table-valued pragma
// function so even the schema probe is parameterized (PRAGMA itself cannot
// bind arguments; the table name is interpolated from a fixed literal).
function hasColumn(db, table, column) {
  const row = db
    .prepare('SELECT name FROM pragma_table_info(?) WHERE name = ?')
    .get(table, column);
  return !!row;
}

// Backfill every OPEN order's remainder escrow with the canonical formula.
// Cancelled / fully-matched orders keep 0: they have no cancelable
// remainder, and a fully-matched order's liability is held in the wallet
// until settlement releases it.
function backfillFrozenCents(db) {
  // escrowFor is lib/match.js's canonical formula (the one every fill
  // uses). Required lazily so the schema layer does not drag the whole
  // engine into module-load time, and any future require cycle stays
  // harmless.
  const { escrowFor } = require('./match');
  const rows = db
    .prepare('SELECT id, side, price, stake_cents, matched_cents FROM orders WHERE status = \'open\'')
    .all();
  const upd = db.prepare('UPDATE orders SET frozen_cents = ? WHERE id = ?');
  for (const o of rows) {
    upd.run(escrowFor(o.side, o.price, o.stake_cents - o.matched_cents), o.id);
  }
}

// Idempotent migration: databases created before the escrow-integrity fix
// have no orders.frozen_cents column. Add it (guarded by a schema probe;
// the try/catch covers the theoretical concurrent-open race), then
// backfill open orders once — only when the column was just added, so a
// later reopen can never overwrite fill-maintained values.
function migrateOrdersFrozenCents(db) {
  if (hasColumn(db, 'orders', 'frozen_cents')) return;
  try {
    db.exec('ALTER TABLE orders ADD COLUMN frozen_cents INTEGER NOT NULL DEFAULT 0');
  } catch (e) {
    // Someone else added it between the probe and the ALTER: fine.
    if (!hasColumn(db, 'orders', 'frozen_cents')) throw e;
  }
  backfillFrozenCents(db);
}

// Accounts migration: adds the identity/lifecycle columns to a database
// created before them, and derives `role` from the legacy `is_admin` boolean
// exactly once.
//
// The "once" matters. Like the frozen_cents backfill above, this runs ONLY
// when `users.role` was absent a moment ago. If it re-asserted on every boot
// it would silently undo a deliberate demotion, because `is_admin` would still
// say 1 for an account an operator has since demoted via `role`. The schema
// comment on the column records that is_admin is the non-authoritative side.
function migrateUserAccounts(db) {
  const hadRole = hasColumn(db, 'users', 'role');

  if (!hadRole) {
    // Each column is independent and guarded, so a database mid-migration (or
    // one written by a future version with some columns already present) still
    // converges instead of failing on a duplicate ALTER.
    const adds = [
      ['email', 'ALTER TABLE users ADD COLUMN email TEXT'],
      ['role', "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin'))"],
      ['status', "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended'))"],
      ['password_changed_at', 'ALTER TABLE users ADD COLUMN password_changed_at TEXT'],
    ];
    for (const [column, ddl] of adds) {
      if (hasColumn(db, 'users', column)) continue;
      try {
        db.exec(ddl);
      } catch (e) {
        // Lost a race with another opener: fine, as long as it landed.
        if (!hasColumn(db, 'users', column)) throw e;
      }
    }

    // Derive role from the legacy boolean. role was just added, so every row
    // is the 'user' default and this is unambiguous.
    db.exec("UPDATE users SET role = 'admin' WHERE is_admin = 1 AND role = 'user'");
  }

  // `excluded_until` is added UNCONDITIONALLY, not inside the role-gated block
  // above. That block only runs when `role` was absent, so a database that
  // already migrated role (i.e. every real deployment) would never gain the
  // column — and lib/limits.js would then throw "no such column" on the first
  // exclusion. Each phase's column gets its own independent guard for exactly
  // this reason.
  if (!hasColumn(db, 'users', 'excluded_until')) {
    try {
      db.exec('ALTER TABLE users ADD COLUMN excluded_until TEXT');
    } catch (e) {
      if (!hasColumn(db, 'users', 'excluded_until')) throw e;
    }
  }
  if (!hasColumn(db, 'users', 'self_excluded')) {
    try {
      db.exec('ALTER TABLE users ADD COLUMN self_excluded INTEGER NOT NULL DEFAULT 0 CHECK (self_excluded IN (0,1))');
    } catch (e) {
      if (!hasColumn(db, 'users', 'self_excluded')) throw e;
    }
  }

  // Created unconditionally, and last, so they are safe against both a fresh
  // database (columns came from SCHEMA) and a migrated one (columns came from
  // the ALTERs above). IF NOT EXISTS makes the second open a no-op.
  //
  // The email index is PARTIAL: accounts with no address store NULL, and NULL
  // is not a value two accounts are allowed to share on identity.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE email IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users (role)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_status ON users (status)');
}

// Widens transactions.type to admit 'adjust' — an operator-initiated credit or
// debit. Without it a balance adjustment would have to be mislabelled as a
// 'deposit', which is a lie in the one history the PLAYER can read, and an
// admin debit (a clawback) has no representation at all.
//
// SQLite cannot alter a CHECK constraint, so the table is rebuilt. No other
// table declares a foreign key INTO transactions, so the rename cannot strand
// a reference; the two indexes on (user_id, id) are recreated by SCHEMA on the
// next open, which is why they are not duplicated here.
function migrateTransactionTypes(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'")
    .get();
  if (!row || /'adjust'/.test(row.sql)) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('ALTER TABLE transactions RENAME TO transactions_old');
    db.exec(`CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL
        CHECK (type IN ('deposit','escrow','release','settle','commission','refund','adjust')),
      amount_cents INTEGER NOT NULL
        CHECK (amount_cents = CAST(amount_cents AS INTEGER)),
      balance_after INTEGER NOT NULL
        CHECK (balance_after = CAST(balance_after AS INTEGER)),
      frozen_after INTEGER NOT NULL
        CHECK (frozen_after = CAST(frozen_after AS INTEGER)),
      order_id INTEGER REFERENCES orders(id),
      market_id INTEGER REFERENCES markets(id),
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    db.exec(`INSERT INTO transactions
      (id, user_id, type, amount_cents, balance_after, frozen_after, order_id, market_id, at)
      SELECT id, user_id, type, amount_cents, balance_after, frozen_after, order_id, market_id, at
      FROM transactions_old`);
    db.exec('DROP TABLE transactions_old');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* connection already unwound */ }
    throw e;
  }
}

function openStore(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // The app drives a single synchronous connection, but a stray second
  // opener (two processes against the same file) should wait briefly for
  // the lock instead of failing instantly with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  // SCHEMA first: it creates any table a fresh install needs (users, audit_log)
  // and is a no-op for tables an older database already has. The migrations
  // then reconcile the COLUMNS and INDEXES of those pre-existing tables, which
  // CREATE TABLE IF NOT EXISTS cannot do — it leaves an existing table alone.
  migrateUserAccounts(db);
  migrateTransactionTypes(db);
  migrateOrdersFrozenCents(db);
  return db;
}

module.exports = { openStore };
