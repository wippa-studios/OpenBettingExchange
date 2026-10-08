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
  pass_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0,1)),
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
    CHECK (type IN ('deposit','escrow','release','settle','commission','refund')),
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
  migrateOrdersFrozenCents(db);
  return db;
}

module.exports = { openStore };
