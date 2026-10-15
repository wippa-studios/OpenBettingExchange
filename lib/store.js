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
  -- Identity is CASE-INSENSITIVE, and the database says so rather than the
  -- service layer. The NOT NULL UNIQUE above compares with BINARY collation,
  -- so on its own it admits 'admin' and 'ADMIN' as two people while the login
  -- limiter - which lowercases - treats them as one. That pairing is an
  -- unauthenticated denial of service against a documented name.
  --
  -- The guarantee is a UNIQUE INDEX ON THIS COLUMN WITH COLLATE NOCASE, created
  -- in migrateUsernameCase() rather than here: an index cannot be added by a
  -- bare CREATE TABLE, and SCHEMA runs before the migrations by design. The
  -- stored SPELLING is untouched - it is displayed in the UI, in the admin desk
  -- and in audit targets - so only the comparison changes. See that function
  -- for why a folded key column is not used instead.
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

-- RESPONSIBLE GAMBLING STATE, one row per user: session clock and the last
-- reality check. A table rather than more users columns because these are the
-- first of several per-user, per-period controls (deposit limits by rolling
-- window, session limits by inactivity) and a table grows without another
-- users-table migration. lib/rg.js owns it.
CREATE TABLE IF NOT EXISTS user_rg_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  session_started_at TEXT,
  -- Stamped on every authenticated request. The session clock is reset only
  -- after a real IDLE GAP measured from this, never by signing out — a session
  -- limit defeated by logging out is not a limit.
  last_active_at TEXT,
  last_reality_check_at TEXT,
  last_check_net_cents INTEGER
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
  -- Demo events are the seeded showcase book. They are the ONLY events whose
  -- off time is ever moved, so a demo can stay tradeable on a machine that has
  -- been left running for days. A real admin-created event must never be rolled
  -- forward: silently moving a customer's fixture to "fix" stale seed data
  -- would be a far worse bug than a stale demo.
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
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
  -- A DEAD HEAT / JOINT FAVOURITE. The engine settles exactly one selection
  -- for a normal win; a joint favourite needs the winning SET, because the
  -- payout is the stake DIVIDED among the tied winners and settled at the
  -- price. Settling a dead heat as a void (the only alternative when a market
  -- settles exactly one selection) pays nobody, which underpays the winners
  -- and overcharges everyone else — so a market type the venue must offer
  -- needs its own shape rather than a wrong one.
  --
  -- winner_selection_id is retained, and stays authoritative, for the ordinary
  -- single-winner case: one representation for the common case, a separate
  -- column only for the one that genuinely needs a set.
  dead_heat INTEGER NOT NULL DEFAULT 0 CHECK (dead_heat IN (0,1)),
  joint_winners TEXT,
  settled_at TEXT,
  -- WHAT THE PAYOUT DEPENDS ON. 'win' — the default, and the only shape the
  -- settlement engine implements: one winning selection takes the pot.
  -- 'place' — the payout depends on a finishing POSITION (top 2, top 4, ...),
  -- which this engine cannot compute at all.
  --
  -- WHY IT IS A COLUMN AND NOT A COMMENT (#88). Racing rules adjust PLACE
  -- markets when a runner is withdrawn: the field shrinks, so the place
  -- distribution changes and every place bettor's payout must be recomputed.
  -- That is not a settlement-time concern and it is not a per-selection void. If
  -- the venue offers a place market and a runner is withdrawn, voiding the
  -- runner and paying a 'winner' would be arithmetically wrong — the payout of a
  -- place market is not a winner's liability — and nothing in the engine would
  -- notice, because the engine has one payout shape and computes that one.
  --
  -- So the refusal has to be declared somewhere the engine can read. An operator
  -- who marks a market 'place' gets an EXPLICIT, AUDITED HOLD on any outcome the
  -- engine cannot price correctly, rather than a plausible wrong number. #95
  -- tracks modelling the shapes properly; until then this is what "handle place
  -- markets correctly" looks like, which is to admit the engine cannot.
  --
  -- A CLOSED vocabulary on purpose: 'place' is not a claim that place payouts are
  -- implemented, it is a claim that they are NOT, and the engine's refusal to
  -- touch one is the point.
  payout_shape TEXT NOT NULL DEFAULT 'win'
    CHECK (payout_shape IN ('win','place')),
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
  -- IN-PLAY BET DELAY. When the order may first MATCH — NULL means
  -- immediately, which is every pre-match order, so the pre-match path is
  -- byte-for-byte unchanged. It is deliberately NOT the placement time: the
  -- order keeps its true placed_at for the tape, because conflating the two
  -- makes the tape lie about what the venue could have known.
  --
  -- The delay was REPORTED to the client from day one but never enforced by
  -- the engine, so an in-play order matched the instant it arrived. A
  -- control that only exists in the response is worse than no control: the
  -- client believes it is protected and it is not.
  eligible_at TEXT,
  -- The RULE that placed this order, when it was placed by a user's automation
  -- rather than by hand. NULL is the DEFAULT and means "manual".
  --
  -- This column exists because the self-match guard in lib/match.js cannot
  -- decide anything without it (#75). The guard's question is no longer "is this
  -- the same user" but "is exactly one side of this crossing an automated
  -- order of that same user", and that distinction has to be on the order row.
  -- An order is the only durable record that survives settlement, so it is where
  -- the fact has to live.
  --
  -- No foreign key yet: the user_rules table is #76, and a foreign key to a
  -- table that does not exist cannot be declared. The constraint that arrives
  -- with it is that attribution must SURVIVE rule deletion (#81) — which means
  -- the eventual key cannot be ON DELETE CASCADE, and is more likely to be a
  -- plain INTEGER with the rule id retained after the rule is gone.
  rule_id INTEGER,
  -- Whether this order was placed UNDER an in-play bet delay. A durable
  -- historical fact, deliberately separate from eligible_at above: the release
  -- pass CLEARS eligible_at when it matches the order into the book, so after
  -- release the scheduling state is gone. Without this column there is no way
  -- afterwards to tell a delayed order from an undelayed one, which makes the
  -- venue's offered bet delay unreportable — the one operational figure a
  -- venue publishes about itself.
  delayed INTEGER NOT NULL DEFAULT 0 CHECK (delayed IN (0,1)),
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
  -- SELF-CROSSED BY THE PLAYER'S OWN LIQUIDITY (#75).
  --
  -- 1 means BOTH sides of this match belong to the same user, and exactly one of
  -- them is an automated order. It is the durable record of a deliberate
  -- weakening of the self-match guard, and the consequence is financial: this
  -- fill was produced by the player's OWN resting order rather than by anyone
  -- else in the venue, so any P&L derived from it is partly self-generated. A
  -- player who cannot tell which fills those are cannot trust their own number.
  --
  -- It lives on matches for the same reason cashout does: orders.frozen_cents is
  -- owned exclusively by the engine (tests/guard.test.js), and a match is the
  -- unit of settled exposure.
  self_crossed INTEGER NOT NULL DEFAULT 0 CHECK (self_crossed IN (0,1)),
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
    CHECK (type IN ('deposit','escrow','release','settle','commission','refund','adjust','opening',
                  'withdraw','withdraw_refund')),
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

-- A USER'S AUTOMATED BETTING RULE (#76) — the declarative record behind every
-- order a person did not click themselves.
--
-- It is a RECORD, not a program. There is no expression column, no script
-- column and nothing here that is ever parsed and executed: the four fields
-- that make the rule what it is are op, threshold_cents, side and
-- stake_cents, and lib/userrules.js knows exactly one way to evaluate them.
-- That narrowness IS the safety property — an engine that could place a
-- player's money has no business accepting text a player wrote, and a schema
-- column is the only place that can be prevented rather than reviewed.
--
-- selection_id, not market_id: the price being watched is a PRICE OF A
-- RUNNER, and the runner is the thing the board quotes.
--
-- Prices are integer ladder cents, never REAL. lib/odds.js keeps every band
-- calculation in cents for exactly this reason, and a rule compared in floats
-- would make "strictly below 2.00" ambiguous at the boundary that decides
-- whether it fires.
--
-- The arm/fire state machine is one boolean. armed = 1 means "the condition
-- is not currently holding, so the next transition INTO it fires". It is set
-- to 0 on the tick the condition holds, and back to 1 on the tick it lifts.
-- That is what makes the rule ONE-SHOT PER CROSSING rather than one order per
-- evaluation: a price resting exactly on the threshold, or a stream oscillating
-- across it, cannot turn a single rule into a stream of orders.
--
-- ARMING IS ESTABLISHED AT CREATION, not at the first evaluation. A rule
-- created while its own condition already holds starts DISARMED, because the
-- player said "when this crosses", not "while this is true" — they have not
-- watched a crossing, and firing on the next tick of a price that never moved
-- would place an order nobody asked for.
CREATE TABLE IF NOT EXISTS user_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  selection_id INTEGER NOT NULL REFERENCES selections(id),
  -- Which way the price has to move. Exactly two values, closed set: the whole
  -- point of v1 is that the condition cannot be expressed any other way.
  op TEXT NOT NULL CHECK (op IN ('below','above')),
  -- The threshold, snapped to the tick ladder on the way in (so a stored rule
  -- is a rule that can actually fire at a placeable price), in integer cents.
  threshold_cents INTEGER NOT NULL
    CHECK (threshold_cents >= 101 AND threshold_cents <= 100000),
  side TEXT NOT NULL CHECK (side IN ('back','lay')),
  stake_cents INTEGER NOT NULL
    CHECK (stake_cents > 0)
    CHECK (stake_cents = CAST(stake_cents AS INTEGER)),
  -- 'live' is the only status that evaluates. Killed rules are kept, not
  -- deleted: orders.rule_id and the audit trail reference them, and a rule
  -- that vanishes takes the ability to explain its own fills with it (#81).
  status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','killed')),
  armed INTEGER NOT NULL DEFAULT 1 CHECK (armed IN (0,1)),
  -- The rule's own last observation of the price, for the UI and for #81.
  -- NOT the crossing baseline — armed is that, and re-deriving it from a
  -- price history would be a second, weaker source of truth.
  last_price_cents INTEGER,
  -- How many ORDERS this rule has placed. Not how many times it crossed: a
  -- crossing the engine refused places nothing, and counting it here would let
  -- the tally say "fired 40 times" when the player has 12 bets.
  fire_count INTEGER NOT NULL DEFAULT 0 CHECK (fire_count >= 0),
  -- How many crossings produced NO order, because the same validateOrder path
  -- refused it. Kept beside fire_count because "continuous without a live
  -- tally" is how someone finds out at the end of the day that their rule was
  -- being refused 8 times a minute (#67).
  refusal_count INTEGER NOT NULL DEFAULT 0 CHECK (refusal_count >= 0),
  last_fired_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  killed_at TEXT,
  killed_reason TEXT
);

-- Every evaluation reads "this user's LIVE rules on this selection". Both
-- indexes exist for that one query; without them a venue-wide tick is a full
-- scan of every rule anyone has ever created, and the scan grows without bound
-- while the result set never does.
CREATE INDEX IF NOT EXISTS idx_user_rules_live_selection ON user_rules (selection_id) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS idx_user_rules_live_user ON user_rules (user_id) WHERE status = 'live';

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
-- Betfair credentials for the external feed collector, per tenant, sealed
-- with AES-256-GCM (see lib/feedcreds.js). Each field is an independent
-- envelope so one can be rotated without re-supplying the others, and so the
-- row carries no shape information about which fields are set.
--
-- There is no "display this" path: lib/feedcreds.status() reports booleans
-- only, and forCollector() is the single function that returns plaintext, for
-- the child process and nothing else.
CREATE TABLE IF NOT EXISTS feed_credentials (
  tenant_id  INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  app_key    TEXT,
  username   TEXT,
  password   TEXT,
  login_mode TEXT NOT NULL DEFAULT 'password'
             CHECK (login_mode IN ('password','certs','session_token')),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

-- CASH-OUT BUYOUTS: one row per executed venue buyout.
--
-- The original design recorded QUOTES and never recorded executions, so the
-- risk caps read zero forever and never fired (the outside audit's F2: a
-- control that exists only in its comments). Since a quote and its execution
-- are atomic in the same request here, there is no live "open quote" to track
-- — what the venue actually carries is executed buyouts. So a row is written
-- AT EXECUTION, and resolved AT SETTLEMENT.
--
-- fair_value_cents and paid_cents are both fixed at execution: recomputing
-- them later from a fair price that has since moved would let an operator
-- rewrite history by moving a price.
--
-- house_match_ids is the JSON array of replacement match ids the venue wrote
-- when it took over the player's side. At settlement those matches resolve,
-- and the venue's realised loss is paid_cents - pnl(house legs) — the only
-- honest measure, because the venue both PAID the player and TOOK the
-- position, so its loss is the payout minus whatever the position returned.
-- Resolution is tracked by settled_at rather than a new status value, because
-- SQLite CHECK constraints cannot be altered in place and a deployment that
-- predates this table must not end up with different semantics than a fresh
-- one.
CREATE TABLE IF NOT EXISTS cashout_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  market_id INTEGER NOT NULL REFERENCES markets(id),
  fair_value_cents INTEGER NOT NULL CHECK (fair_value_cents >= 0),
  paid_cents INTEGER NOT NULL CHECK (paid_cents >= 0),
  status TEXT NOT NULL DEFAULT 'taken' CHECK (status IN ('open','taken','expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  taken_at TEXT,
  house_match_ids TEXT,
  proceeds_cents INTEGER,
  loss_cents INTEGER,
  settled_at TEXT
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
// Cash-out buyout bookkeeping columns, for databases created before the
// outside audit's F2 fix. Column adds only — the status CHECK stays as it is,
// because resolution is tracked by settled_at (see the schema comment) and a
// CHECK cannot be altered in place on an existing table.
function migrateCashoutBuyouts(db) {
  const cols = [
    // matches.cashout marks the legs a buyout SUPERSEDED, and it is what keeps
    // them out of settlement AND out of every turnover report. It was only ever
    // in SCHEMA, with no migration, so a database created before that column
    // landed has no `cashout` at all — and then both settlement and reporting
    // would fail on it. That gap only became visible when a report index tried
    // to use the column and aborted the boot of an existing database (the fifth
    // time this repo has hit that trap). The column is genuinely required, so it
    // gains a migration rather than the index losing its filter.
    ['cashout', 'ALTER TABLE matches ADD COLUMN cashout INTEGER NOT NULL DEFAULT 0 CHECK (cashout IN (0,1))'],
    ['house_match_ids', 'ALTER TABLE cashout_quotes ADD COLUMN house_match_ids TEXT'],
    ['proceeds_cents', 'ALTER TABLE cashout_quotes ADD COLUMN proceeds_cents INTEGER'],
    ['loss_cents', 'ALTER TABLE cashout_quotes ADD COLUMN loss_cents INTEGER'],
    ['settled_at', 'ALTER TABLE cashout_quotes ADD COLUMN settled_at TEXT'],
  ];
  for (const [column, ddl] of cols) {
    // matches and cashout_quotes are different tables; a column name means one
    // thing in each, so the probe has to name the table it is asking about.
    const table = ddl.includes('ALTER TABLE matches') ? 'matches' : 'cashout_quotes';
    if (hasColumn(db, table, column)) continue;
    try { db.exec(ddl); } catch (e) { if (!hasColumn(db, table, column)) throw e; }
  }
}

// In-play delay: orders.eligible_at. Nullable, and NULL is the DEFAULT
// meaning for every existing order — they are all immediately eligible, so an
// upgrade cannot retroactively freeze a book.
// Dead-heat settlement columns. Column adds only; no CHECK on the existing
// status/winner columns is touched, so an upgraded database and a fresh one
// behave identically.
// Report-window indexes. Every report filters on a bare `at` range and groups
// over the whole table; without these a 400-day window is a full scan — and
// node:sqlite is SYNCHRONOUS, so a scan blocks the whole single-threaded server
// for its duration. lib/reports.js comments about an "indexable comparison" that
// had no index behind it.
//
// Partial on cashout = 0 because every report excludes superseded buyout legs:
// they are not trades, and they are the overwhelming majority of match rows.
//
// Created in the MIGRATION, not in SCHEMA. SCHEMA runs before migrations and
// CREATE INDEX validates its columns immediately, so an index here aborts the
// boot of every database predating the column. (Fifth time this repo has hit
// that trap.)
function migrateReportIndexes(db) {
  db.exec('CREATE INDEX IF NOT EXISTS idx_matches_at ON matches (at, market_id) WHERE cashout = 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_settlements_at ON settlements (at, market_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_at ON orders (placed_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_at ON transactions (at, type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cashout_settled_at ON cashout_quotes (settled_at)');
}

// events.is_demo — the demo-events flag. Added to SCHEMA for fresh databases
// and here for existing ones, because CREATE TABLE IF NOT EXISTS leaves an
// existing table untouched. Guarded per-column so a part-migrated database
// converges instead of failing on a duplicate ALTER.
// feed_credentials — the encrypted Betfair credential store.
//
// A brand-new table needs no migration (CREATE TABLE IF NOT EXISTS creates it),
// but the FOREIGN KEY to tenants(id) means the tenants table must exist first,
// and this must run after it. It is registered after migrateTenants so a
// database created before this table existed gains it on first open rather than
// the credential store failing its first write with "no such table".
function migrateFeedCredentials(db) {
  if (!hasTable(db, 'feed_credentials')) return;
  db.exec('CREATE TABLE IF NOT EXISTS feed_credentials ('
    + '  tenant_id  INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,'
    + "  app_key    TEXT,"
    + "  username   TEXT,"
    + "  password   TEXT,"
    + "  login_mode TEXT NOT NULL DEFAULT 'password'"
    + "    CHECK (login_mode IN ('password','certs','session_token')),"
    + "  created_by INTEGER REFERENCES users(id),"
    + "  updated_by INTEGER REFERENCES users(id),"
    + "  created_at TEXT NOT NULL DEFAULT (datetime('now')),"
    + "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))"
    + ')');
}

/**
 * CREDENTIAL-ABUSE COUNTERS, moved out of process memory.
 *
 * These were a module-level `Map` in server.js, so a restart handed every
 * attacker a fresh allowance of ten guesses on every account, forever: the
 * effective rate became ten guesses per restart rather than ten per
 * escalating window. The table is the same state in the venue's source of
 * truth, which is also what makes the read-modify-write atomic enough for a
 * second process to share it.
 *
 * The keys are the ones the in-memory map used, verbatim and un-namespaced by
 * this table's own column: `login:<username>`, `login-ip:<address>` and
 * `register:<address>`. Two thresholds live in server.js, not here, because
 * they are policy rather than shape.
 *
 * `locked_until` is epoch MILLISECONDS as an INTEGER, not a SQLite datetime
 * string: it is compared against `Date.now()` on every authenticated request,
 * and a string comparison per request is a conversion this does not need. It
 * is the one place a timestamp is not UTC text, and it is the only way to read
 * it is through server.js.
 *
 * `fails` IS NOT RESET WHEN A LOCK EXPIRES — it keeps counting, which is what
 * makes the window double on each further failure. Clearing it would hand an
 * attacker ten more guesses every half-minute forever.
 */
function migrateLoginAttempts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY,
    fails INTEGER NOT NULL DEFAULT 0 CHECK (fails >= 0),
    locked_until INTEGER NOT NULL DEFAULT 0 CHECK (locked_until >= 0),
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  // The sweep below deletes by age, so the age is what has to be indexed. A
  // table with one row per attacked key and no index would be a full scan on a
  // timer.
  db.exec('CREATE INDEX IF NOT EXISTS idx_login_attempts_updated ON login_attempts (updated_at)');
}

function migrateEventIsDemo(db) {
  if (hasColumn(db, 'events', 'is_demo')) return;
  try {
    db.exec('ALTER TABLE events ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1))');
  } catch (e) {
    if (!hasColumn(db, 'events', 'is_demo')) throw e;
  }
  // Rows the seed already created are demo rows. Anything an operator created
  // through the admin API has a created_at later than the seed run, but rather
  // than guess from timestamps, treat every pre-existing event as demo: this
  // migration only runs once, on a database that predates the flag, so "all
  // events so far" is exactly the seeded showcase book plus anything the
  // operator added by hand before the flag existed. Rolling one of those
  // forward is harmless (it only moves an off time, and only for demo rows),
  // whereas failing to mark the seeded rows would leave the demo unfixable.
  db.exec('UPDATE events SET is_demo = 1 WHERE is_demo = 0');
}

function migrateDeadHeat(db) {
  for (const [column, ddl] of [
    ['dead_heat', 'ALTER TABLE markets ADD COLUMN dead_heat INTEGER NOT NULL DEFAULT 0 CHECK (dead_heat IN (0,1))'],
    ['joint_winners', 'ALTER TABLE markets ADD COLUMN joint_winners TEXT'],
  ]) {
    if (hasColumn(db, 'markets', column)) continue;
    try { db.exec(ddl); } catch (e) { if (!hasColumn(db, 'markets', column)) throw e; }
  }
}

// markets.payout_shape — what the payout depends on. See the schema comment:
// it exists so the engine can REFUSE a market whose payouts it cannot compute,
// rather than computing the wrong one. A database created before this column
// existed gains it with the 'win' default, which is what every pre-existing
// market was in fact — the engine has only ever had one payout shape — so an
// upgraded deployment and a fresh one behave identically.
//
// The CHECK rides on the ALTER rather than being left to SCHEMA, because a
// column added here that SCHEMA does not also carry is a column an upgraded
// database accepts a bad value into. migrateDeadHeat does the same for markets.
function migratePayoutShape(db) {
  if (hasColumn(db, 'markets', 'payout_shape')) return;
  try {
    db.exec("ALTER TABLE markets ADD COLUMN payout_shape TEXT NOT NULL DEFAULT 'win' CHECK (payout_shape IN ('win','place'))");
  } catch (e) {
    if (!hasColumn(db, 'markets', 'payout_shape')) throw e;
  }
}

function migrateEligibleAt(db) {
  if (!hasColumn(db, 'orders', 'eligible_at')) {
    try {
      db.exec('ALTER TABLE orders ADD COLUMN eligible_at TEXT');
    } catch (e) {
      if (!hasColumn(db, 'orders', 'eligible_at')) throw e;
    }
  }
  // #75: the rule that placed an automated order. NULL means manual, so every
  // pre-existing row is already correct and needs no backfill — which is the
  // right default rather than a convenient one: an order nobody attributes to a
  // rule WAS placed by a human.
  if (!hasColumn(db, 'orders', 'rule_id')) {
    try {
      db.exec('ALTER TABLE orders ADD COLUMN rule_id INTEGER');
    } catch (e) {
      if (!hasColumn(db, 'orders', 'rule_id')) throw e;
    }
  }
  // #75: the same marker on the match itself. See the schema comment — this is
  // the durable record that a fill came from the player's own liquidity.
  if (!hasColumn(db, 'matches', 'self_crossed')) {
    try {
      db.exec('ALTER TABLE matches ADD COLUMN self_crossed INTEGER NOT NULL DEFAULT 0 CHECK (self_crossed IN (0,1))');
    } catch (e) {
      if (!hasColumn(db, 'matches', 'self_crossed')) throw e;
    }
  }
  if (!hasColumn(db, 'user_rg_state', 'last_active_at')) {
    try {
      db.exec('ALTER TABLE user_rg_state ADD COLUMN last_active_at TEXT');
    } catch (e) {
      if (!hasColumn(db, 'user_rg_state', 'last_active_at')) throw e;
    }
  }
  if (!hasColumn(db, 'orders', 'delayed')) {
    try {
      db.exec('ALTER TABLE orders ADD COLUMN delayed INTEGER NOT NULL DEFAULT 0 CHECK (delayed IN (0,1))');
    } catch (e) {
      if (!hasColumn(db, 'orders', 'delayed')) throw e;
    }
  }
  // The index belongs HERE, not in SCHEMA. db.exec(SCHEMA) runs BEFORE
  // migrations and CREATE INDEX validates its columns immediately, so an
  // index on a migration-added column aborts the boot of every database that
  // predates the migration. (The fourth time this repo has hit that trap.)
  db.exec("CREATE INDEX IF NOT EXISTS idx_orders_eligible ON orders (eligible_at, id) WHERE eligible_at IS NOT NULL");
}

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

  // Each column is added INDEPENDENTLY, and each is guarded on its OWN column
  // rather than on the whole block.
  //
  // This used to be `if (!hadRole) { ...five columns... }`. That looks harmless
  // and is not: a database that migrated when this list was shorter — before
  // `must_change_password` was added to it — has `role` but NOT
  // `must_change_password`, so the gate is false on every subsequent boot and
  // the column is never added. The database is then permanently unable to boot,
  // because `enforceFirstRunLock` selects the column that was never created.
  //
  // Found on a real local database: role=yes, password_changed_at=yes,
  // must_change_password=no. The gate was load-bearing for the ROLE BACKFILL
  // below (which must only run once), and the column adds were collateral
  // damage. So: adds are per-column and unconditional; the backfill stays gated.
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

  if (!hadRole) {
    // Derive role from the legacy boolean. role was just added, so every row
    // is the 'user' default and this is unambiguous. Runs ONCE, and only when
    // role was genuinely absent — re-running it would be harmless today but
    // this is a backfill of a legacy schema and belongs behind its own guard.
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
  migrateUsernameCase(db);
}

/**
 * CASE-INSENSITIVE USERNAME IDENTITY, enforced by the database.
 *
 * THE COLUMN CONSTRAINT IS NOT ENOUGH. `username TEXT NOT NULL UNIQUE`
 * compares with BINARY collation, so `admin` and `ADMIN` were two accounts —
 * while the login limiter keyed on the LOWERCASED name, so an attacker could
 * register `ADMIN`, take ten wrong-password attempts against it, and lock the
 * documented `admin` account out of its own venue. One rule, applied in two
 * directions: the registry said they were different people and the limiter said
 * they were the same one.
 *
 * WHY A COLLATION AND NOT A SECOND `username_key` COLUMN. The two are
 * equivalent here and the collation is the smaller change: USERNAME_RE in
 * lib/auth.js admits only [A-Za-z0-9_-], so the identity alphabet is ASCII and
 * SQLite's NOCASE folding is COMPLETE over it. It would not be over a Unicode
 * name — 'İ' and 'i' are two identities to NOCASE — which is why the charset
 * restriction, not the collation, is the load-bearing half of that decision.
 * A folded key column would also be a second column that every writer has to
 * keep in step, and this repository's standing position is that a convention is
 * not a type. An index the database refuses to violate is a type.
 *
 * The stored SPELLING is untouched: `username` keeps whatever case the first
 * registrant chose, because it is displayed in the UI, in the admin desk and in
 * audit targets. What changes is that no second account may differ from it by
 * case alone, and that every lookup compares the same way.
 */
function migrateUsernameCase(db) {
  // A database that already violates the rule cannot be indexed, and silently
  // carrying on without the index would restore the exact bug this migration
  // exists to close — so it refuses to boot and names the accounts. Merging
  // them automatically is not an option: whose balance and whose orders are
  // they? That is an operator's decision, and it is a rare one on a venue that
  // seeds `admin` and `demo` and takes registrations from strangers.
  const collisions = db
    .prepare(
      `SELECT LOWER(username) AS folded, COUNT(*) AS n,
              GROUP_CONCAT(username, ' / ') AS spellings
         FROM users
        GROUP BY LOWER(username)
       HAVING n > 1`
    )
    .all();
  if (collisions.length) {
    const list = collisions.map((c) => `"${c.spellings}"`).join(', ');
    throw new Error(
      'Refusing to boot: these usernames differ only by case and cannot be merged ' +
        'automatically — each has its own balance and orders. Rename one of each ' +
        `(UPDATE users SET username = '...' WHERE username = ...), then start again. ${list}`
    );
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users (username COLLATE NOCASE)');
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
  migrateDeadHeat(db);
  migratePayoutShape(db);
  migrateEligibleAt(db);
  // Order matters: the report indexes reference matches.cashout, which
  // migrateCashoutBuyouts adds. An index created before its column exists
  // aborts the boot of every database predating it.
  migrateCashoutBuyouts(db);
  migrateReportIndexes(db);
  migrateEventIsDemo(db);
  migrateLoginAttempts(db);
  migrateFeedCredentials(db);
  migrateClientOrderId(db);
  migrateTenants(db);
  return db;
}

module.exports = { openStore };
