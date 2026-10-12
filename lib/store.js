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
  -- FIRST-RUN LOCK. Set when an account is still on a seeded demo password;
  -- cleared the moment it is replaced. A stored FLAG, not a check performed
  -- per request: verifying a scrypt hash on every call would put ~160ms on
  -- the hot path and hand an attacker a free CPU-burn. Set once at seed/boot,
  -- read as a boolean afterwards.
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
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
  -- Results-feed HOLD. A disputed or unrecognised outcome parks the market
  -- here: still open (the player genuinely holds a position), but excluded
  -- from automatic settlement until a human releases it. Distinct from
  -- 'settled' because a held market has NOT been resolved — voiding it would
  -- give away money the venue may owe, and settling it would pick a side.
  settlement_hold INTEGER NOT NULL DEFAULT 0 CHECK (settlement_hold IN (0,1)),
  hold_reason TEXT,
  -- ── In-play ────────────────────────────────────────────────────────────
  -- A pre-match exchange is safe from the sharpest money in betting; an
  -- in-play one is not, because the book reacts to what it can see NOW. These
  -- three columns are how the venue stays slower than its own liquidity.
  --
  -- The inplay flag selects the regime. inplay_delay_ms is how long an order must
  -- wait before it may MATCH (not before it was placed -- the order keeps its
  -- true timestamp for the tape). suspend_until is a hard stop: no orders
  -- accepted at all, open-ended when NULL, which is what an operator wants
  -- during a feed outage rather than guessing a resume time.
  inplay INTEGER NOT NULL DEFAULT 0 CHECK (inplay IN (0,1)),
  inplay_delay_ms INTEGER NOT NULL DEFAULT 0
    CHECK (inplay_delay_ms >= 0 AND inplay_delay_ms <= 600000),
  suspend_until TEXT,
  suspend_reason TEXT,
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
  updated_at TEXT,
  -- Phase 4 follow-up: client-supplied idempotency key. At operator scale a
  -- double-submit is a FINANCIAL INCIDENT rather than an annoyance — a retried
  -- request on a flaky connection would otherwise place the bet twice.
  -- NULL means "not idempotent", which preserves every existing caller.
  client_order_id TEXT
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
  -- Cash-out marker. A cash-out closes the player's position for them, and a
  -- later settleMarket must then SKIP this match rather than paying it again —
  -- double settlement is the worst bug this system could have.
  --
  -- It lives on matches, not orders, deliberately: orders.frozen_cents is
  -- owned exclusively by the matching engine (tests/guard.test.js), so a
  -- cash-out may not mark an order closed by writing its escrow. A match is
  -- the unit of settled exposure, which is exactly what a buyout extinguishes.
  cashout INTEGER NOT NULL DEFAULT 0 CHECK (cashout IN (0,1)),
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
    CHECK (type IN ('deposit','escrow','release','settle','commission','refund','adjust','opening')),
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

-- Market-maker risk: the venue's OWN P&L exposure, bounded per bot.
--
-- A bot account may hold a negative balance (it must be able to owe, or it
-- could never lose a bet), but the bots quote a no-edge drift price — so any
-- sharp bettor beats them systematically and the venue absorbs the loss. That
-- loss was unbounded until this table.
--
-- max_liability_cents  how far the bot may go into debt
-- max_daily_loss_cents realised daily P&L floor (a loss cap)
-- quote_skew           ticks of spread widening at FULL pressure; this is
--                      what makes the cap graceful instead of a cliff
--
-- The daily baseline is a balance SNAPSHOT (day_start_balance taken at
-- period_start), not a sum of ledger rows: escrow moves balance->frozen
-- without changing total funds, so a balance delta IS realised P&L.
CREATE TABLE IF NOT EXISTS risk_bots (
  bot_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  max_liability_cents INTEGER NOT NULL
    CHECK (max_liability_cents > 0 AND max_liability_cents = CAST(max_liability_cents AS INTEGER)),
  max_daily_loss_cents INTEGER NOT NULL
    CHECK (max_daily_loss_cents > 0 AND max_daily_loss_cents = CAST(max_daily_loss_cents AS INTEGER)),
  quote_skew REAL NOT NULL DEFAULT 0.5
    CHECK (quote_skew >= 0 AND quote_skew <= 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  period_start TEXT,
  day_start_balance INTEGER
);

-- ── Double-entry ledger (Phase 3) ─────────────────────────────────────────
-- An account is a bucket; entries are postings. Every money movement in the
-- system produces entries summing to ZERO, which turns three things from
-- prose into queries: global conservation, fund segregation, and operator
-- revenue.
--
-- player_funds / player_escrow are PER-USER and require a user_id (a player
-- account with no owner is money belonging to nobody). The venue kinds are
-- singletons with user_id NULL. The CHECK below enforces exactly that split,
-- so the invariant is in the schema rather than in service-layer discipline.
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL
    CHECK (kind IN ('player_funds','player_escrow','operator_commission','house_float','gateway_clearing','bonus')),
  currency TEXT NOT NULL DEFAULT 'USD',
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  CHECK (
    (kind IN ('player_funds','player_escrow') AND user_id IS NOT NULL) OR
    (kind NOT IN ('player_funds','player_escrow') AND user_id IS NULL)
  )
);

-- One UNIQUE per (kind, user_id) — including the NULL venue rows, since
-- SQLite treats NULLs as distinct in a plain UNIQUE, which would let several
-- stray house_float singletons accumulate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_kind_user ON accounts (kind, IFNULL(user_id, 0));

-- A posting. The 'direction' column carries the sign so amount_cents is always
-- a positive magnitude and can never be silently negative. Entries are never
-- updated or deleted by service code — corrections are reversing postings,
-- which is why there is no updated_at.
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount_cents INTEGER NOT NULL
    CHECK (amount_cents > 0)
    CHECK (amount_cents = CAST(amount_cents AS INTEGER)),
  memo TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entries_account ON entries (account_id, id);
CREATE INDEX IF NOT EXISTS idx_entries_tx ON entries (transaction_id, id);

-- ── Tenancy (Phase 4) ─────────────────────────────────────────────────────
-- Self-hosting is the degenerate case of multi-tenancy. The default tenant
-- always exists and a NULL tenant_id means "the default", which is what lets
-- a single-operator install keep working with no configuration at all.
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  -- Commission in BASIS POINTS, integer. A float rate converted per settlement
  -- is how a tenant's take ends up a cent off; bps makes it exact.
  commission_bps INTEGER NOT NULL DEFAULT 250
    CHECK (commission_bps >= 0 AND commission_bps <= 2000),
  brand TEXT,
  jurisdictions TEXT,
  feed_config TEXT,
  psp_config TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Payment intents. A DEPOSIT IS NOT MONEY until confirmed: this table's
-- whole purpose is to make "asked for" and "arrived" different states that
-- the schema can prove apart. credit_transaction_id is the ledger transaction
-- that funded the player, NULL until confirmation — so "was this ever paid
-- out?" is a query rather than a reconstruction.
CREATE TABLE IF NOT EXISTS payment_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  external_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('deposit','withdrawal')),
  amount_cents INTEGER NOT NULL
    CHECK (amount_cents > 0 AND amount_cents = CAST(amount_cents AS INTEGER)),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','failed','rejected','refunded')),
  credit_transaction_id INTEGER REFERENCES transactions(id),
  confirmed_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One provider-side reference per (provider, external_id) once known. Partial,
-- because a pending intent legitimately has no external id yet, and a retry
-- must never create a second row for the same provider payment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_external ON payment_intents (provider, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_user ON payment_intents (user_id, id);
CREATE INDEX IF NOT EXISTS idx_payment_status ON payment_intents (status, id);

-- CASH-OUT QUOTES. The venue's exposure to cash-out begins at the QUOTE,
-- not at execution: if a player holds an unexercised quote, the liability
-- exists whether or not it is taken. expires_at is mandatory so a stale
-- quote releases the exposure instead of pinning it forever.
--
-- fair_value_cents and paid_cents are both stored so the realised shortfall is
-- the number recorded at execution. Recomputing it later from a fair price
-- that has since moved would let an operator rewrite history by moving a
-- price.
CREATE TABLE IF NOT EXISTS cashout_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  market_id INTEGER NOT NULL REFERENCES markets(id),
  fair_value_cents INTEGER NOT NULL CHECK (fair_value_cents >= 0),
  paid_cents INTEGER NOT NULL CHECK (paid_cents >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','taken','expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  taken_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cashout_quotes_open ON cashout_quotes (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_cashout_quotes_user ON cashout_quotes (user_id, id);

-- RECONCILIATION FINDINGS. A discrepancy is a FINDING, not an exception to
-- log: it has to survive being ignored. Keyed by scope so repeated drift
-- UPDATES one open finding rather than creating a new row every hour, and
-- resolved ONLY by a human with a written reason. An unresolved finding keeps
-- re-surfacing in every reconciliation report — otherwise an operator who
-- checks the dashboard daily sees "no findings" the moment the run that
-- detected the drift has scrolled out of view.
CREATE TABLE IF NOT EXISTS reconciliation_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  expected_cents INTEGER NOT NULL,
  actual_cents INTEGER NOT NULL,
  drift_cents INTEGER NOT NULL,
  detail TEXT,
  source TEXT NOT NULL DEFAULT 'scheduled',
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_count INTEGER NOT NULL DEFAULT 1,
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_findings_open ON reconciliation_findings (resolved_at, ABS(drift_cents));

-- PROVENANCE for every outcome the feed applied. A settlement with no source
-- row is a settlement nobody can defend when it is disputed, so this is
-- written in the same transaction as the settlement itself — it cannot record
-- a settlement that rolled back.
CREATE TABLE IF NOT EXISTS result_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  source_event_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('poll','webhook','manual','import')),
  decision TEXT NOT NULL CHECK (decision IN ('settle','void','hold')),
  -- Which rule fired, e.g. abandoned_after_red_card. Kept so an operator can
  -- see WHY, not just what.
  rule TEXT NOT NULL,
  reason TEXT,
  payload TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_result_events_market ON result_events (market_id, id);
-- A source event must not be applied twice, so re-delivery is idempotent at
-- the database level and not only in the application logic above.
CREATE UNIQUE INDEX IF NOT EXISTS idx_result_events_source
  ON result_events (source, source_event_id) WHERE source_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log (target, id);

-- Idempotency: one order per (user, client_order_id). The INDEX is created by
-- migrateClientOrderId(), NOT here — a bare CREATE INDEX validates its columns
-- immediately, so a statement in SCHEMA referencing client_order_id throws
-- "no such column" against a pre-existing orders table, before any migration
-- has had a chance to add it. SCHEMA runs before the migrations by design.
--
-- The user is part of the key deliberately: idempotency keys are client-
-- generated and two different players can collide on one without either
-- being wrong. Scoping to the user makes a collision someone else's bug
-- rather than a cross-account interference.

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
// Tenancy migration: adds tenant_id to every operational table, one
// deliberate change rather than incremental patches.
//
// Every table is touched, which is why this is its own phase rather than
// something folded into another feature. The index leads with tenant_id
// because every operational query will scope by tenant first — a composite
// index where tenant_id is the SECOND column would not be used for the
// filtering that matters.
//
// Each column is added independently and guarded, so a database part-way
// through this migration converges instead of failing on a duplicate ALTER —
// the same lesson as the excluded_until / self_excluded columns above.
const TENANT_TABLES = [
  'users', 'sessions', 'orders', 'matches', 'settlements', 'transactions',
  'price_history', 'limits', 'risk_bots', 'payment_intents', 'audit_log',
  'sports', 'competitions', 'events', 'markets', 'selections',
];

// Idempotency migration: adds orders.client_order_id to a database created
// before it, and its PARTIAL unique index.
//
// The index is created here rather than only in SCHEMA because a pre-existing
// table keeps whatever indexes it had — CREATE TABLE IF NOT EXISTS does not
// add an index to an existing table. Skipping this would silently leave an
// upgraded deployment with the column but NO uniqueness, which is worse than
// not having the feature: it would look like it worked right up until two
// duplicate orders landed.
// In-play migration. As with every other phase, the COLUMNS are reconciled
// here and not in SCHEMA: db.exec(SCHEMA) runs first and CREATE TABLE IF NOT
// EXISTS leaves an existing table alone, so a pre-in-play database would never
// gain the columns. Each is added independently and guarded so a part-migrated
// database converges instead of failing on a duplicate ALTER.
function migrateInPlay(db) {
  const cols = [
    ['inplay', 'ALTER TABLE markets ADD COLUMN inplay INTEGER NOT NULL DEFAULT 0 CHECK (inplay IN (0,1))'],
    ['inplay_delay_ms', 'ALTER TABLE markets ADD COLUMN inplay_delay_ms INTEGER NOT NULL DEFAULT 0 CHECK (inplay_delay_ms >= 0 AND inplay_delay_ms <= 600000)'],
    ['suspend_until', 'ALTER TABLE markets ADD COLUMN suspend_until TEXT'],
    ['suspend_reason', 'ALTER TABLE markets ADD COLUMN suspend_reason TEXT'],
  ];
  for (const [column, ddl] of cols) {
    if (hasColumn(db, 'markets', column)) continue;
    try {
      db.exec(ddl);
    } catch (e) {
      if (!hasColumn(db, 'markets', column)) throw e;
    }
  }
}

function migrateClientOrderId(db) {
  if (!hasColumn(db, 'orders', 'client_order_id')) {
    try {
      db.exec('ALTER TABLE orders ADD COLUMN client_order_id TEXT');
    } catch (e) {
      if (!hasColumn(db, 'orders', 'client_order_id')) throw e;
    }
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_id
       ON orders (user_id, client_order_id) WHERE client_order_id IS NOT NULL`
  );
}

function migrateTenants(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    commission_bps INTEGER NOT NULL DEFAULT 250 CHECK (commission_bps >= 0 AND commission_bps <= 2000),
    brand TEXT, jurisdictions TEXT, feed_config TEXT, psp_config TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  for (const table of TENANT_TABLES) {
    if (!hasTable(db, table)) continue;
    if (!hasColumn(db, table, 'tenant_id')) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER REFERENCES tenants(id)`);
      } catch (e) {
        if (!hasColumn(db, table, 'tenant_id')) throw e;
      }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_tenant ON ${table} (tenant_id)`);
  }

  // The default tenant is created by lib/tenants.js, not here, because it
  // reads config for the commission rate and this module stays free of that
  // dependency. It is ensured at first use instead.
}

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
// Does `table` exist? Same pragma approach as hasColumn, so even the probe is
// parameterized and the name never reaches SQL by interpolation.
function hasTable(db, table) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return !!row;
}

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
      ['must_change_password', 'ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1))'],
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
  migrateInPlay(db);
  migrateClientOrderId(db);
  migrateTenants(db);
  return db;
}

module.exports = { openStore };
