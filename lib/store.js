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

// `venueCurrency` is interpolated into the three currency column defaults
// below. It is config.VENUE_CURRENCY, validated to ^[A-Z]{3}$ by lib/config.js
// before it can reach here, and this is DDL rather than a value, so the
// interpolation is safe by construction — the alternative was a literal in the
// schema, which is what #104 removed.
//
// WHY THE DEFAULTS ARE THE VENUE'S CURRENCY AND NOT A LITERAL. They used to be
// the string 'USD', hard-coded into accounts.currency, payment_intents.currency
// and tenants.currency. On an AUD venue that default FABRICATED a currency
// nobody chose: a raw `INSERT INTO tenants (slug, name)` produced a tenant
// denominated in USD, and every assertion added by #104 then refused it — which
// is the defect the issue describes, one layer down. A default that means "the
// venue's currency" is a fact; a default that means "USD" is a stale constant.
//
// It stays a DEFAULT rather than NOT NULL for one honest reason, on accounts:
// tests/ledger2.test.js inserts an account with no currency and asserts it
// fails on the kind/ownership CHECK. Without a default that insert would fail
// on NOT NULL instead, and the assertion would be asserting a different
// constraint than the one it was written for. Both are refusals; only one is
// the one under test.
const SCHEMA = (venueCurrency) => `
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
  -- CUSTOMER PRE-VERIFICATION (#Australian AML/CTF). Australian law has required
  -- identity verification BEFORE an online gambling account is created since
  -- 29 September 2024, and the interim allowance for deferring it in special
  -- circumstances was repealed rather than extended — so registration on its own
  -- cannot produce a usable account, and the gate that enforces that lives in
  -- the ENGINE (lib/identity/index.js assertVerified, called from
  -- lib/limits.js assertTradeable and from the deposit/withdrawal paths) rather
  -- than in a route.
  --
  -- THE REASON IT IS A COLUMN AND NOT A LOOKUP AGAINST identity_verifications:
  -- it is read on every money path, so it has to be one indexed read on the row
  -- that already exists. lib/rg.js makes the same argument for user_rg_state
  -- being a per-user table rather than three more users columns, and the reason
  -- it is not a table here is the opposite one: this is a single enum with five
  -- values, it is read on the hottest path in the venue, and a JOIN to a row
  -- that might be missing would make "not verified" mean "no record" on exactly
  -- the path that must fail closed.
  --
  -- DEFAULT 'unverified' AND THAT IS THE POINT, not an oversight. An upgraded
  -- database gains every pre-existing account as unverified, which on a
  -- deployment that turns IDENTITY_REQUIRED on means none of them can trade
  -- until the operator brings each into compliance with a reasoned, audited
  -- decision (lib/identity setDecision). That IS the obligation's shape — the
  -- rule has a commencement date and pre-existing accounts are the operator's
  -- remediation problem, not something a migration should quietly wave through by
  -- backfilling everybody as verified.
  --
  -- Deliberately NOT carrying a date of birth. See the long note on
  -- 'age_assurance' below for why age assurance and identity are two records with
  -- two retention policies and why "a DOB on the user" is the shape this
  -- deliberately avoids.
  identity_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (identity_status IN ('unverified','pending','verified','failed','review')),
  identity_status_at TEXT,
  -- WHERE THE ACCOUNT CAME FROM, for the cross-account link analysis. Not an
  -- identity control and not personal information about a person's identity —
  -- it is the network address and client hint the account presented at
  -- registration, and it exists so that "several accounts opened from the same
  -- IP and/or device" (a published suspicious-activity indicator, and an
  -- enumerated finding in AUSTRAC's own statement about a large Australian
  -- operator) is a query rather than a guess.
  --
  -- NOT TRUSTED FROM A CLIENT HEADER unless TRUST_PROXY_JURISDICTION is on, for
  -- the reason lib/config.js gives for that key: a client-declared country is
  -- not a jurisdiction, and trusting one would make the control defeatable by
  -- editing a header while still being recorded as enforced. Same rule, same
  -- reason, different column.
  registration_ip TEXT,
  registration_device TEXT,
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
    CHECK (total_matched_cents = CAST(total_matched_cents AS INTEGER)),
  -- BOOK VERSION (#92): how many times this market's readable book has moved.
  --
  -- The counterpart of selections.book_version, and the aggregate of it: any
  -- change to any runner in this market bumps BOTH, so a client that read the
  -- whole market and one that read a single runner are both able to say
  -- "the book I priced against has not been the book I traded on".
  --
  -- It exists because placement has no version handshake of its own. Until
  -- this column, a client that read a ladder and sent an order had it placed
  -- at whatever the ladder said by the time it arrived, answered 201, and
  -- could not tell "accepted and did not match" from "accepted at a price I did
  -- not intend". This is the number that makes the difference observable; see
  -- lib/bookversion.js and docs/EXCHANGE_RULES.md.
  --
  -- A plain monotone counter, deliberately: it is compared for order and for
  -- distance, never rendered, never parsed. Betfair's is an opaque string and
  -- a client must not be able to read meaning into ours.
  book_version INTEGER NOT NULL DEFAULT 0
    CHECK (book_version >= 0)
    CHECK (book_version = CAST(book_version AS INTEGER))
);

CREATE TABLE IF NOT EXISTS selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','suspended','void')),
  fair_price REAL,
  ltp REAL,
  -- BOOK VERSION (#92): bumped every time THIS RUNNER's readable book moves —
  -- a fill on it, a cancel on it. See markets.book_version for what the number
  -- is for; this is the narrower of the two and the one a ladder client wants,
  -- because activity on the other eleven runners is not a change to the ladder
  -- it was reading.
  book_version INTEGER NOT NULL DEFAULT 0
    CHECK (book_version >= 0)
    CHECK (book_version = CAST(book_version AS INTEGER))
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
  client_order_id TEXT,
  -- HOW LONG THIS ORDER IS GOOD FOR (#97) — the exchange's persistenceType,
  -- and the one part of Betfair's order lifecycle this venue had no vocabulary
  -- for at all. Before this column every order on this venue was GFD-ish:
  -- it rested until it matched or somebody cancelled it, forever, including
  -- across the moment the market turned in-play. That is a decision a trader
  -- cannot make and a professional workflow stalls on, because the only way to
  -- be flat before an event starts is to watch a clock and cancel by hand.
  --
  --   'PERSIST' — the unmatched remainder carries into the in-play market.
  --                This is the DEFAULT and it is this venue's ENTIRE previous
  --                behaviour, deliberately unchanged: adding the feature must
  --                not silently start cancelling resting orders for owners
  --                who never asked for it, which is a money movement with no
  --                request behind it.
  --   'LAPSE'   — cancel the unmatched remainder when the market turns
  --                in-play. Enforced by lapseOrders() in lib/match.js, on the
  --                same scheduled pass that releases in-play bet delays.
  --
  -- There is deliberately no 'MARKET_ON_CLOSE'. It means "into the starting
  -- price auction", and this engine has no auction and no starting-price field
  -- at all — so accepting the value would be accepting an instruction this
  -- venue cannot carry out. A closed CHECK that refuses it loudly beats an
  -- open column that stores a promise and drops it on the floor, which is the
  -- defect this repository's documentation has been written against since it
  -- started.
  --
  -- An order's eligible_at is its BET DELAY (may it MATCH yet) and this is
  -- its TIME IN FORCE (how long the venue keeps it). They were built for
  -- different problems on the same substrate: eligible_at exists because
  -- lib/inplay.js delays in-play prices, and this column exists because a
  -- trader needs a way to say "do not carry me past this point". Conflating
  -- them would mean an order lapsing because it was never matchable.
  persistence TEXT NOT NULL DEFAULT 'PERSIST'
    CHECK (persistence IN ('LAPSE','PERSIST'))
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

-- Trade tape: one row per fill, at the price it filled at.
--
-- READ, since #93. Before that it was written on every fill by
-- lib/match.js's recordTrades and read by NOTHING in production — a complete,
-- indexed table consulted by no code path, which is the "a thing that exists
-- and reports nothing" shape docs/ROADMAP.md calls a dead control. Its one
-- production reader is the price series behind
-- GET /api/selections/:id/price-history (lib/marketdata.js).
--
-- It carries no fact the matches table does not: both are one row per fill,
-- and a match already holds selection_id, price and at. So this is a DERIVED
-- projection of the executed tape, which is what makes pruning it safe — and
-- that is why the ladder's matched-volume column is computed from the matched
-- volume rollup rather than from here. A money figure must never depend on a
-- table that is allowed to be deleted.
--
-- RETENTION is a deliberate policy, not an accident. It used to say "rows are
-- never pruned (a demo's worth is tiny)", which is true of a demo and false of
-- a venue: MAX_SSE_CLIENTS defaults to 2000 and nothing bounded this table.
-- The policy, its window and the reader that constrains it live in
-- lib/marketdata.js (RETENTION_DAYS / retentionPolicy) and in
-- docs/EXCHANGE_RULES.md; the pruner is prunePriceHistory, reached through
-- POST /api/admin/maintenance/price-history.
--
-- The index below keeps per-runner history reads linear as the tape grows,
-- which is what the series endpoint's windowed aggregate runs on.
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
  -- WHAT THIS BUCKET IS DENOMINATED IN (#104).
  --
  -- It used to be written with a literal 'USD' at both write sites in
  -- lib/accounts.js and read by NOTHING — a decorative column. It is now the
  -- assertion every posting is checked against: lib/accounts.js accountId()
  -- refuses a row whose currency disagrees with its tenant's, and post()
  -- refuses a set of legs spanning two currencies. A column nothing reads
  -- cannot tell you anything; this one can now refuse.
  --
  -- The DEFAULT is the venue's currency, interpolated above — see the note on
  -- the SCHEMA signature. It is a fallback for an insert that forgot, never a
  -- source of truth: lib/accounts.js supplies the value on every insert and
  -- then READS IT BACK and refuses a row that disagrees.
  currency TEXT NOT NULL DEFAULT '${venueCurrency}',
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  CHECK (
    (kind IN ('player_funds','player_escrow') AND user_id IS NOT NULL) OR
    (kind NOT IN ('player_funds','player_escrow') AND user_id IS NULL)
  )
);

-- One UNIQUE per (kind, user_id) — including the NULL venue rows, since
-- SQLite treats NULLs as distinct in a plain UNIQUE, which would let several
-- stray house_float singletons accumulate.
--
-- THE INDEX DOES NOT SPAN CURRENCY, and that is the whole constraint on this
-- codebase's money: one player_funds bucket per player, one house_float for the
-- venue, each in ONE denomination. It is also why the INSERT OR IGNORE in
-- lib/accounts.js used to be a silent no-op — a second currency hit the unique
-- index, the insert was ignored, the caller carried on, and the account
-- resolved was the one that already existed. There is no currency in this index
-- and there is no accounts.tenant_id either, so per-tenant multi-currency is
-- not merely unimplemented, it is not expressible. Making it expressible is
-- option B of #104 and it starts with THIS index.
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
  -- THE CURRENCY THIS TENANT TRADES IN (#104). It exists on the tenant rather
  -- than in a constant because a white-label venue is a configuration change,
  -- not a code change — but it is written and READ (#104: it used to be a
  -- literal 'USD' at every write site and read by nothing), it is what
  -- /api/branding publishes, and it is what lib/accounts.js asserts every
  -- ledger account against.
  --
  -- The DEFAULT is the venue's currency, interpolated above — the note on the
  -- SCHEMA signature says why it is not a literal. It is a fallback for a row
  -- inserted without one, never a source of truth: lib/tenants.js supplies the
  -- value on every insert.
  currency TEXT NOT NULL DEFAULT '${venueCurrency}',
  brand TEXT,
  jurisdictions TEXT,
  feed_config TEXT,
  psp_config TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Customer pre-verification (lib/identity/) ────────────────────────────────
-- TWO TABLES, AND THE SEPARATION IS THE DELIVERABLE.
--
-- The reform bill's explanatory memorandum addresses AGE ASSURANCE separately
-- from IDENTITY, and does three things this schema exists to make possible:
--
--   1. personal information collected FOR AGE ASSURANCE must be DESTROYED once
--      used, absent elevated consent;
--   2. no Australian is to be forced to use government identification
--      (including Digital ID) for age assurance;
--   3. age assurance is not, by itself, an identity control.
--
-- Modelling this as "a date of birth on the user" — which is the obvious thing
-- and what a well-meaning contributor would write — makes all three impossible.
-- A DOB on 'users' cannot be erased without erasing the account's identity
-- record, cannot be distinguished from KYC data, and ASSUMES the venue ends up
-- holding a government identifier or a date at all.
--
-- THAT LAST ASSUMPTION IS PROBABLY WRONG, and the schema is built so it costs
-- nothing if it is. A privacy-preserving digital-identity network built for this
-- exact purpose proves a person is over 18 WITHOUT handing over a document or an
-- identifier — that is the point of the design, and it is what the bill's own
-- safeguard describes. So 'age_assurance' holds an ATTESTATION and an opaque
-- vendor handle, and NOTHING that identifies a person on its own: no date of
-- birth, no document type, no document number, no image. 'attributes' may be
-- NULL and every code path here works when it is.
--
-- IT IS CHEAP IF THE PROVISION IS NOT ENACTED AND EXPENSIVE TO RETROFIT IF IT
-- IS, which is the whole argument for two tables. If the provision never lands,
-- erasing an age-assurance record when it has been used costs nothing and the
-- durable evidence — a check OUTCOME inside the verification's own checks list,
-- which IS financial-crime material — is untouched. If it does land, retrofitting
-- "separately erasable" onto a schema that put age and identity in one row means
-- splitting a record class that other code is already reading.
--
-- WHAT SURVIVES AN ERASURE is the tombstone ('erased_at', 'erased_by'): a fact
-- about the PROCESS, not about the person. "There was an age-assurance record for
-- this account and it was destroyed on this date, at this operator's instruction"
-- is what an auditor asks first, and deleting the row makes the question
-- unanswerable.
CREATE TABLE IF NOT EXISTS age_assurance (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  -- The vendor's OPAQUE handle for the assertion. Not an identifier of a person:
  -- a reference provider returns a truncated SHA-256 of a subject handle.
  external_id TEXT,
  -- How the age was assured. A CLOSED vocabulary, because the venue's own record
  -- of which method was used is what answers "was this person ever forced to
  -- present a government document?", and an open column answers nothing.
  --   'privacy_preserving' — a privacy-preserving digital-identity assertion.
  --                          No document was received by this venue at all.
  --   'third_party'        — a contracted age-assurance provider asserted it.
  --   'document'           — a document was reviewed. Recorded as a FACT about
  --                          what happened; nothing about the document is stored.
  --   'self_declaration'   — the customer asserted it. Weakest, and present so
  --                          that the weak case is expressible rather than hidden.
  method TEXT NOT NULL CHECK (method IN ('privacy_preserving','third_party','document','self_declaration')),
  -- How strong the assertion was. Closed for the same reason.
  assurance TEXT NOT NULL CHECK (assurance IN ('attested','verified','self_declared')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass','fail')),
  -- Whatever the vendor chose to return, as JSON. NULL is NORMAL and expected —
  -- see the note above. Nothing in this repository reads it, and nothing requires
  -- it to be present.
  attributes TEXT,
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  -- The erasure tombstone. Non-NULL means the personal information is gone.
  erased_at TEXT,
  erased_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- THE IDENTITY RECORD. Separate from 'age_assurance' because identity is KEPT
-- (it is financial-crime material with a multi-year retention expectation) and
-- age assurance is DESTROYED (see above). One row per verification ATTEMPT, not
-- one per user: a customer who starts, abandons and starts again has two attempts
-- and the history is what an investigator needs.
--
-- 'subject_reference' is an OPAQUE HANDLE, never a name, date of birth or
-- document number. The venue must be able to ask a screening question without
-- holding the identity that answers it.
--
-- 'checks' is the CONSTITUENT checks that produced the decision, stored with the
-- VENDOR'S OWN NAME alongside the venue's normalisation — never instead of. A
-- provider that renames its own check must not be able to silently stop being
-- stored, because the operator's first question about a disputed refusal is
-- "which check cleared or failed this person?". lib/identity/index.js refuses a
-- PASS with no checks at all, for the same reason.
CREATE TABLE IF NOT EXISTS identity_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  external_id TEXT,
  -- The provider decision. Closed vocabulary from lib/identity/provider.js.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','pass','fail','review','expired','closed')),
  decision TEXT
    CHECK (decision IS NULL OR decision IN ('pending','pass','fail','review','expired','closed')),
  checks TEXT,
  detail TEXT,
  subject_reference TEXT,
  -- The name the KYC provider returned for this subject. THE ONLY PLACE IN THIS
  -- SCHEMA WHERE A PERSON'S NAME IS STORED, and it is here rather than on
  -- 'users' for a reason with teeth: third-party funding can only be detected by
  -- comparing the name the PAYMENT RAIL reports against the name the account was
  -- verified under (see lib/funding.js). The comparison needs the verified name;
  -- nothing else in the venue does.
  --
  -- It is NULLABLE and it is NOT set from anything the customer types. It is the
  -- provider's assertion, recorded so a disputed refusal can be explained. It is
  -- never exposed on a player-facing surface, and lib/identity's statusOf — the
  -- only identity surface a customer can read — does not return it.
  subject_name TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_identity_user ON identity_verifications (user_id, id);
-- A provider's callback identifies the attempt by its external id, and a
-- PARTIAL unique index is what makes a re-delivered callback find the same row
-- rather than opening a second attempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_external
  ON identity_verifications (provider, external_id) WHERE external_id IS NOT NULL;

-- WHO MAY READ FINANCIAL-CRIME MATERIAL. Ships EMPTY, and that is the correct
-- default rather than an unfinished feature: 'admin' is the venue's general
-- operator role and is held by whoever runs the trading desk, the support desk
-- and the content desk. Whether any particular person may read a
-- suspicious-matter file is a question about that person, that jurisdiction and
-- that regulator — so the deliverable is the MECHANISM and the table, and the
-- operator's compliance officer populates it. Until they do, nobody is entitled
-- and the surfaces refuse.
--
-- This is the machine half of the tipping-off control. Tipping off is a
-- criminal offence in Australia and the exposure runs to staff who are NOT
-- ENTITLED TO KNOW as well as to the customer, so "entitled" has to be a fact
-- about a person rather than an assumption about a role. See lib/aml/findings.js
-- for the three surfaces and the two that are NOT here.
CREATE TABLE IF NOT EXISTS aml_entitlements (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_by INTEGER REFERENCES users(id),
  reason TEXT,
  granted_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  -- #104: what this intent is denominated in. Was a hard-coded 'USD' written
  -- at two sites in lib/payments/index.js and read by nothing. It is READ now —
  -- lib/payments/index.js refuses to credit an intent whose currency is not
  -- the paying user's tenant's. The default is the venue's currency (see the
  -- SCHEMA signature), so an intent inserted without one is denominated in the
  -- money the venue actually trades in rather than in a stale constant.
  currency TEXT NOT NULL DEFAULT '${venueCurrency}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','failed','rejected','refunded')),
  credit_transaction_id INTEGER REFERENCES transactions(id),
  confirmed_at TEXT,
  failure_reason TEXT,
  -- ── THE FUNDING SIDE, WHICH IS NOT THE SAME QUESTION AS THE SESSION ────────
  -- Everything below exists because "where does this money come from" and "where
  -- does this customer play" are DIFFERENT questions that a regulator treats
  -- separately — AUSTRAC's statement against a large Australian operator made
  -- both findings, about different facts, in the same document.
  --
  -- 'lib/tenants.js' already gates the SESSION side at login: a player in a
  -- blocked jurisdiction cannot get in. That gate is correct and it is not
  -- sufficient, because a customer sitting in Sydney can fund an account from a
  -- foreign bank account, and nothing about their session reveals that.
  --
  -- 'payer_name' is the name THE RAIL reported, not the name the customer typed.
  -- That is the whole detection signal for third-party funding: the difference
  -- between "this instrument is registered to the account holder" and "this
  -- instrument is registered to somebody else" is exactly this field against the
  -- account's verified subject name. A venue that does not capture it cannot
  -- detect the finding at all.
  --
  -- 'funding_country' is the country of the instrument, NOT of the customer.
  -- Nullable because a rail that reports neither must not be made to guess, and a
  -- fabricated country is worse than an absent one — it is compared against a
  -- restricted-jurisdiction list.
  payer_name TEXT,
  funding_country TEXT,
  -- Which registered instrument funded this. NULL means the rail did not say,
  -- which lib/funding.js REFUSES rather than allows: see the note on that table
  -- for why an unstated owner is the third-party case by definition.
  funding_instrument_id INTEGER REFERENCES funding_instruments(id),
  -- Which payment method, and therefore under WHICH TERMS the venue was
  -- permitted to use it. The terms are the point — see payment_methods above.
  payment_method_id INTEGER REFERENCES payment_methods(id),
  -- The country a withdrawal is being paid TO. Distinct from the customer and
  -- from the funding country, and the fact "attempts to withdraw funds to an
  -- international bank account" is a published indicator in its own right.
  beneficiary_country TEXT,
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

-- ── AML / CTF (lib/aml/) ─────────────────────────────────────────────────────
-- WHY A SECOND FINDINGS TABLE rather than reusing reconciliation_findings: read
-- that schema. expected_cents, actual_cents and drift_cents are all NOT NULL and
-- all three are a MONEY DISAGREEMENT. "This account won nine bets in four minutes
-- on one selection" has no expected figure, no actual figure and no drift, so
-- reusing it would mean writing zeros — a fabricated financial claim on every
-- alert, in the one table an operator is trained to read as factual. Two further
-- reasons are structural: financial-crime records have the OPPOSITE retention
-- answer to the trade tape (lib/retention.js), and they have a different AUDIENCE
-- tipping off makes "who may read this row" a question of fact about a person.
-- The PATTERN is reused deliberately. Read lib/aml/findings.js.
--
-- NO expected/actual/drift COLUMNS, and 'observed_cents' is NULLABLE for the same
-- reason the money columns are absent: some indicators have a figure to point at
-- (a deposit that crossed the threshold) and some have none (a shared device
-- across three accounts), and a NOT NULL money column would force the second kind
-- to invent one.
CREATE TABLE IF NOT EXISTS aml_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  -- The stable key for "the same thing happening again". Repeated detection
  -- UPDATES one open row and increments seen_count, so a pattern that recurs is
  -- one case an analyst reads rather than one row per scan. NOT unique-indexed
  -- because a RESOLVED row keeps its scope: reopening the same case is a new
  -- finding, not a resurrection of a closed one, and the unique lookup is scoped
  -- to 'resolved_at IS NULL' in the query itself.
  scope TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('high','medium','low')),
  user_id INTEGER REFERENCES users(id),
  detail TEXT,
  -- The figures that made the rule fire, as JSON. This is the answer to "what
  -- would this have caught?" — an analyst must never have to re-run a query to
  -- find out what the machine saw, and a calibration argument has to be
  -- settleable with evidence rather than opinion.
  evidence TEXT,
  observed_cents INTEGER,
  source TEXT NOT NULL DEFAULT 'scheduled',
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_count INTEGER NOT NULL DEFAULT 1,
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolution TEXT
);

-- The open set, which is the list every surface reads. Severity first because the
-- sort an analyst actually wants is "what is worst", and 'id' last so repeated
-- detection of one case keeps its place.
CREATE INDEX IF NOT EXISTS idx_aml_alerts_open ON aml_alerts (resolved_at, severity, id);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_user ON aml_alerts (user_id, id);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_rule ON aml_alerts (rule_id, id);

-- A THRESHOLD CROSSING IS AN OBLIGATION, NOT A LOG LINE.
--
-- Since 31 March 2026 the customer-due-diligence exemption threshold for
-- gambling providers dropped from under $10,000 to under $5,000. A transaction
-- crossing it, or a set of related transactions crossing it together, creates a
-- duty to report. A log line satisfies nothing: the point of the duty is that it
-- survives the process that noticed it, and it has to be answerable months later
-- by someone who was not here.
--
-- DISCHARGED_BY is a GENERATION REFERENCE, not a boolean. "We produced a report"
-- and "we filed a report with AUSTRAC" are different facts, this codebase
-- GENERATES reports and does not submit anything to any regulator, and a boolean
-- here would let an operator mark a duty discharged on the strength of a file
-- nobody sent. The string names the generation so the two can be compared.
CREATE TABLE IF NOT EXISTS aml_threshold_obligations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  -- 'single'  — one transaction at or over the threshold.
  -- 'related' — several transactions that individually sat under it and together
  --            crossed it. Structuring is the whole point of the second kind, and
  --            a threshold that only looks at individual amounts does not see it.
  basis TEXT NOT NULL CHECK (basis IN ('single','related')),
  threshold_cents INTEGER NOT NULL,
  observed_cents INTEGER NOT NULL,
  -- The window the observation covers. window_from is NOT NULL because an
  -- obligation with no stated start cannot be answered months later, which is the
  -- whole reason the row exists.
  --
  -- window_to IS NULLABLE, and that is the honest state rather than a gap: a
  -- threshold is crossed DURING a window that is still open, so at detection time
  -- there is no end to record. It is stamped when the obligation is discharged.
  -- Making it NOT NULL — the first schema here did — meant every single-transaction
  -- crossing had to invent an end, and inventing one puts a false bound in the one
  -- row an examiner reads.
  window_from TEXT NOT NULL,
  window_to TEXT,
  -- The transactions that made up the window, as a JSON array of
  -- payment_intents ids. Kept so the obligation can be answered from the
  -- obligation itself rather than by re-deriving a window that has since moved.
  transaction_ids TEXT,
  detail TEXT,
  -- Set when the corresponding report was generated. A NULL here on an old
  -- obligation is the single most useful thing an operator can be shown.
  report_reference TEXT,
  report_generated_at TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_count INTEGER NOT NULL DEFAULT 1,
  discharged_at TEXT,
  discharged_by INTEGER REFERENCES users(id),
  discharge_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_aml_threshold_open ON aml_threshold_obligations (discharged_at, id);
CREATE INDEX IF NOT EXISTS idx_aml_threshold_user ON aml_threshold_obligations (user_id, id);

-- PER-RULE CALIBRATION. The operator's tuning, not ours.
--
-- Every rule in lib/aml/rules.js declares a DEFAULT threshold, and the default is
-- a defensible starting point rather than a legal position. The threshold a rule
-- actually uses is: this row if present, otherwise the declared default. That
-- ordering matters — a rule with no override runs on its shipped default rather
-- than on nothing, so a deployment that has not tuned anything is still
-- MONITORED, which is the state that is safe.
--
-- A TABLE rather than config keys because the answer is per-tenant (a white-label
-- venue's customers are a different population from the venue's own), because it
-- has to be changed by an operator without a restart, and because changing a
-- financial-crime threshold is an act that should leave an audit row.
--
-- 'value_cents' and 'value_count' are nullable and a rule uses whichever its own
-- shape calls for; storing a count as cents would be a unit bug waiting to be
-- read.
CREATE TABLE IF NOT EXISTS aml_rule_thresholds (
  rule_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  value_cents INTEGER,
  value_count INTEGER,
  window_days INTEGER,
  updated_by INTEGER REFERENCES users(id),
  reason TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (rule_id, tenant_id)
);

-- ── Deposit funding (lib/funding.js) ─────────────────────────────────────────
-- AUSTRAC's statement against a large Australian operator in December 2024 found
-- deposit channels that enabled credits which "obscured or could obscure the
-- identity of the depositor or the source of money/funds", and separately found
-- transaction monitoring that failed to detect "a person (a third party) other
-- than the person in whose name the betting account was held".
--
-- DETECTING THAT NEEDS A REGISTRY OF WHAT IS EXPECTED, or the check is a name
-- comparison against nothing. This table is that registry.
--
-- AND THE REGISTERED-INSTRUMENT PROBLEM IS THE INTERESTING PART, because a naive
-- name-match rule refuses EVERY legitimate deposit in Australia. On the NPP/Osko
-- rail an operator's receiving PayID is normally registered to a PAYMENT
-- PROCESSOR or INTERMEDIARY COMPANY, not to the venue — so "the funding
-- instrument's registered name must equal the account holder's" is false for
-- every real Osko customer. 'owner_kind' is the whole answer: an instrument
-- registered to the VENUE or to a CONTRACTED PROCESSOR is cleared, one registered
-- to an UNKNOWN owner is refused, and only one registered to a DIFFERENT person
-- is the third-party finding.
--
-- AND Osko/NPP TRANSFERS ARE IRREVOCABLE WITH NO CHARGEBACK, which is why this
-- has to be a REFUSAL AT INTAKE rather than a flag discovered afterwards: a
-- wrongly-accepted deposit cannot be clawed back through the rail.
--
-- SHIPS EMPTY, like aml_entitlements. A venue going live must register its
-- processor pools and its own receiving accounts before it can accept anything,
-- and an instrument nobody has registered is REFUSED rather than allowed — the
-- same "not configured is not configured" stance lib/config.js takes for
-- FEED_CREDENTIALS_KEY.
CREATE TABLE IF NOT EXISTS funding_instruments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  -- What sort of rail endpoint this is. Closed, because "who signed this" means
  -- something different for each and an open column would let an operator record
  -- a bank account as a card.
  instrument_kind TEXT NOT NULL CHECK (instrument_kind IN ('bank_account','payid','card','wallet','prepaid','processor_pool')),
  -- The name the RAIL says the instrument is registered to. THE field the
  -- third-party check compares.
  registered_owner TEXT NOT NULL,
  -- WHO THAT NAME IS, in the only four answers that matter here:
  --   'venue'    — the venue's own account. Cleared.
  --   'processor'— a contracted payment processor or intermediary holding a POOL
  --               on the venue's behalf. Cleared, and this is the Osko case.
  --   'player'   — an account holder's own instrument. Name must match.
  --   'unknown'  — nobody can say. REFUSED. An instrument whose ownership is
  --               unstated is the third-party case by definition, and failing
  --               open here would make the control decorative.
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('venue','processor','player','unknown')),
  -- Which processor, for 'processor' rows. Recorded so an operator can answer
  -- "which contract is this pool under?" and so revoking one processor does not
  -- revoke every pool.
  processor_ref TEXT,
  jurisdiction TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_funding_tenant ON funding_instruments (tenant_id, enabled);
-- The lookup is by registered owner, so the index leads with the compared column.
CREATE INDEX IF NOT EXISTS idx_funding_owner ON funding_instruments (registered_owner);

-- PAYMENT METHODS, AND THE TERMS UNDER WHICH THE VENUE MAY USE THEM.
--
-- "PayPal" and "PayPal, approved seller, Australian customers only" are different
-- facts, and the second is the one that matters: PayPal prohibits gambling by
-- default and names betting against a bookmaker and betting through an exchange
-- explicitly, so a venue may only use it as an approved seller that can block the
-- jurisdictions it is not permitted to serve. Recording just "paypal" records
-- nothing that can be enforced.
--
-- THE OTHER THING THIS TABLE HAS TO EXPRESS IS THAT CREDIT IS A RELATIONSHIP,
-- NOT A NAME. One Australian operator prohibits credit cards AND any payment
-- method linked to a credit card — including digital wallets and BPAY — for
-- online wagering, while leaving debit cards unaffected. So "accepts Apple Pay"
-- and "accepts a credit-linked instrument" are different answers, and a payment
-- method list that could only say "wallet" could not tell them apart. Hence
-- 'credit_linked', which an operator sets per method against their own policy.
--
-- 'seller_status' is nullable because it is meaningful only for the methods whose
-- provider restricts the merchant (PayPal and the wallets), and ENABLING such a
-- method without recording the terms is refused — the constraint is the control.
CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bank_transfer','debit_card','credit_card','wallet','prepaid','paypal','bpay','other')),
  -- 1 when this method draws on CREDIT, directly or through a link. The
  -- distinction a single 'kind' cannot express.
  credit_linked INTEGER NOT NULL DEFAULT 0 CHECK (credit_linked IN (0,1)),
  -- NULL when the provider places no merchant restriction on this method.
  -- 'approved_seller' — the venue holds the provider's approval and has
  --                     demonstrated it can block the jurisdictions it must.
  -- 'restricted_seller'— approval exists with conditions recorded in
  --                     permitted_countries.
  seller_status TEXT CHECK (seller_status IS NULL OR seller_status IN ('approved_seller','restricted_seller')),
  -- JSON array of ISO country codes the venue may use THIS METHOD for, or NULL
  -- for no restriction. The mechanism by which "approved seller, Australian
  -- customers only" becomes enforceable rather than aspirational: the deposit
  -- intake gate refuses a funding country that is not in here.
  permitted_countries TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_slug ON payment_methods (tenant_id, slug);

-- ── The data-source register (lib/datasources.js) ────────────────────────────
-- Racing NSW's rules require an operator using NSW race-field information to hold
-- an approval from Racing NSW REGARDLESS OF WHERE IT IS DOMICILED OR LICENSED,
-- with fees payable. So "we are licensed somewhere else" is not an answer, and an
-- operator needs to know, per source, who owns it, what approval they hold, what
-- it may be used for, and when it expires.
--
-- 'permits' is a JSON array over the CLOSED vocabulary below, because the three
-- uses have genuinely different consequences and a single boolean cannot express
-- "you may display this but you may not settle from it". A display-only approval
-- that settles a race is the failure this column exists to make visible.
CREATE TABLE IF NOT EXISTS data_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  -- Who owns the underlying race-field information.
  owner TEXT NOT NULL,
  -- The approving authority, where that is a separate body from the owner.
  authority TEXT,
  -- The approval or licence reference itself, and the fee terms. A register that
  -- cannot say what the operator actually holds is a list of names.
  licence_ref TEXT,
  fee_terms TEXT,
  -- JSON array over 'display' | 'store' | 'settle'.
  permits TEXT NOT NULL DEFAULT '[]',
  starts_at TEXT,
  expires_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_data_sources_expiry ON data_sources (enabled, expires_at);

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
  -- WHICH LICENSED SOURCE this outcome came from, when the outcome arrived
  -- through one. NULLABLE AND DELIBERATELY NULLABLE.
  --
  -- 'source' above is a coarse TRANSPORT vocabulary — poll, webhook, manual,
  -- import — and it answers "how did this arrive?", not "under what right may
  -- this be used?". Racing NSW's rules require an approval to use NSW race-field
  -- information regardless of where the operator is domiciled or licensed, and
  -- the three things an approval can grant are DISPLAY, STORE and SETTLE, which
  -- a transport cannot distinguish. So this EXTENDS the column rather than
  -- replacing it: nothing that reads 'source' changes, and a settlement that
  -- arrives with no registered source still records exactly what it recorded
  -- before.
  --
  -- AND THE NULL IS MADE VISIBLE rather than merely permitted. A settlement with
  -- no source is a settlement nobody can defend to the data owner, so
  -- /api/admin/data-sources reports the unattributed count and lib/datasources.js
  -- can refuse an outcome that NAMES a source whose licence does not permit
  -- settling. See that module for the enforcement boundary.
  data_source_id INTEGER REFERENCES data_sources(id),
  -- THE DEDUCTION DECLARED ON A WITHDRAWAL, and whether one was declared at all.
  --
  -- NULLABLE AND CLOSED, and both facts earn their keep. A withdrawal settles the
  -- runners that survived, and Australian racing rules require a DEDUCTION to be
  -- taken off those winners' payouts — scaled by the withdrawn runner's odds, from
  -- a table the venue does not carry and the stewards declare in a particular race
  -- (see lib/deductions.js for why the venue computes nothing). So this records
  -- what was declared, in what unit, and what the venue did with it.
  --
  -- NULLABLE because most outcomes carry no withdrawal and therefore raise no
  -- deduction question, and because a row that predates the column must stay
  -- exactly what it was. A deduction_state of 'undeclared' is the FINDING: a race
  -- with a late scratching, settled at full payout, with nobody having said what
  -- to deduct. That is the total the venue OVERPAID, and it is a query rather
  -- than a promise — lib/deductions.js reports it and an operator reads it.
  --
  -- CLOSED for the reason data_sources.permits is closed: an open column is a
  -- value nothing knows how to police, and this one is the difference between a
  -- settlement an auditor can read and a number they have to trust.
  deduction_state TEXT CHECK (deduction_state IN ('undeclared','declared','rejected')),
  -- The canonical record: what was declared, for whom, on which runner, in what
  -- unit, what the odds made of it and whether the ceiling clamped it. Kept as
  -- TEXT because it is a composed document rather than a scalar — a voided-runner
  -- table is two rows and this is one JSON array — and because the countable half
  -- of the same fact is the column above. A counter and a record are different
  -- jobs and one of them being enough is why provenance has been hard to read
  -- before.
  deductions_json TEXT,
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

// ── #101: THE IDENTITY MAP BETWEEN THE FEED'S CATALOGUE AND THIS VENUE'S ──────
//
// WHAT THIS TABLE IS FOR. With FEED_ENABLED the venue used to show a feed's
// fixtures and reference ladders while trading NOTHING, because every one of
// them was a row in somebody else's database: lib/match.js resolves a selection
// through `selections → markets → events` in THIS store, so a feed selection id
// resolved to nothing and `POST /api/orders` answered 404. lib/feedcat.js now
// MATERIALISES the feed's catalogue into local rows — and the moment it does,
// the venue has two id spaces for the same race:
//
//   the feed's     '1.234567890', 58805, '10'      (Betfair's own ids, and a
//                  selection id is REUSED across markets, so a runner's real
//                  identity is the composite `${market_id}:${selection_id}`)
//   this venue's   1, 42, 128                     (autoincrement, local only)
//
// The results protocol speaks in integers in BOTH directions
// (lib/resultsfeed.js `requestBody`, and `normaliseSignal`'s winners /
// non_runners), so without this table every outcome the feed sends after a
// materialisation names selections the market does not have: the withdrawal
// path holds as `non_runner_foreign`, the outcome path takes the empty-winner
// HOLD branch, and real money sits in a held market while withdrawn runners
// stay quoted. That is the money-path defect this table exists to prevent, and
// it is a mapping problem, so the mapping is stored rather than re-derived.
//
// WHY IT IS A TABLE AND NOT A CONVENTION. Re-deriving "which local market is
// feed market 1.234567890" from names would be a guess: feeds rename fixtures,
// reuse runners and republish ids. Identity is a fact about the past, and the
// only honest place for a fact about the past is storage.
//
// MIGRATION-ONLY, NOT IN SCHEMA, and for the reason price_matched_levels and
// login_attempts set out rather than the reason migrateFeedCredentials does:
// this table has no FOREIGN KEY, so there is no ordering constraint on it — it
// cannot fail to exist because a table it depends on did not, and one DDL in
// one place beats the same DDL written twice with two chances to drift. It is
// registered beside migrateFeedCredentials because it is the other half of the
// same operator-facing feed surface.
//
// NO tenant_id COLUMN, which is a real limitation and worth naming rather than
// hiding: the sync stamps `tenant_id` on every row it creates (every table it
// writes has one), but the MAP is keyed without it, because one feed catalogue
// is one venue-wide artefact — two tenants pointing the venue at the same
// licensed feed are describing the same race, and inventing a second local
// market for it would be the "two feeds spelling one sport differently create
// two sports" defect one level down. The unique key below is what makes that
// identity rather than an accident.
//
// NO DELETES, ever. `synced_at` records when this venue last saw the feed's row,
// and a market that leaves the feed is SUSPENDED locally rather than removed
// (see lib/feedcat.js), because players hold positions on it and a delete would
// take their money with it. The UNIQUE constraint is the re-run guard for the
// sync itself: two syncs of an unchanged feed produce identical rows and
// identical local ids.
function migrateFeedMap(db) {
  db.exec('CREATE TABLE IF NOT EXISTS feed_map ('
    + '  id INTEGER PRIMARY KEY AUTOINCREMENT,'
    // The provider `name` — 'postgres' | 'http' — not a URL and not a tenant. Two
    // feeds can describe the same fixture; only the one that was actually ASKED
    // is recorded, so switching provider and syncing again re-derives ids in the
    // new space instead of trusting a mapping made against another one.
    + '  provider TEXT NOT NULL,'
    + "  kind TEXT NOT NULL CHECK (kind IN ('event','market','selection')),"
    // The id in the FEED's id space, verbatim and as TEXT. Betfair market ids are
    // dotted strings ('1.234567890') and this column must not be an INTEGER to
    // hold them: a numeric cast of '1.234' is 1, and every market in the feed
    // would then share one row.
    + '  external_id TEXT NOT NULL,'
    + '  local_id INTEGER NOT NULL,'
    + "  synced_at TEXT NOT NULL DEFAULT (datetime('now')),"
    + '  UNIQUE (provider, kind, external_id)'
    + ')');
  // The REVERSE direction: local row → the feed's id for it. The unique key
  // above indexes the forward lookup ("which local row is this external id?");
  // the results path needs the other one ("what did the feed call this row?") to
  // translate an inbound outcome, and without this index that is a scan of the
  // whole map for every market in the pending set — a synchronous scan, on a
  // server whose storage layer is synchronous and single-threaded.
  db.exec('CREATE INDEX IF NOT EXISTS idx_feed_map_local ON feed_map (provider, kind, local_id)');
}

/**
 * MATCHED VOLUME PER PRICE LEVEL — the ladder's missing column, rolled up (#93).
 *
 * WHY A ROLLUP AND NOT A QUERY OVER `matches`. The ladder wants matched volume
 * at each price for a WINDOW, and `matches` is the record of every fill ever
 * made. Reading it per board frame is a scan: node:sqlite is SYNCHRONOUS, and
 * docs/ARCHITECTURE.md already flags that a scan "blocks the whole
 * single-threaded server for its duration". MAX_SSE_CLIENTS bounds long-lived
 * streams; nothing bounds a synchronous table scan, so the board cannot be the
 * thing that introduces one.
 *
 * This table makes the board's per-frame read cost depend on HOW MANY DISTINCT
 * (selection, price, minute) COMBINATIONS traded in the window rather than on
 * how many fills occurred — which is the property that makes it flat as trading
 * volume grows. lib/marketdata.js's matchedByLevel() is the only reader.
 *
 * `price_cents`, not `price`. The primary key has to be an exact-match key, and
 * a REAL in a composite PRIMARY KEY makes every conflict test a float
 * comparison. Prices are integer price-cents everywhere else in this codebase
 * for the same reason.
 *
 * MINUTE buckets. The window a trader reads is minutes, so minute resolution is
 * what the ladder needs; a coarser bucket would silently merge trades a trader
 * is trying to separate and a finer one would rebuild the table we are avoiding.
 *
 * `fills` and `matched_cents` are CASHED-OUT LEGS INCLUDED, deliberately, and
 * this is the one place the rollup and `idx_matches_at` disagree. `matches` is
 * authoritative for money and a buyout supersedes a leg's exposure — so every
 * report filters `cashout = 0`. But this table is the LADDER, and the ladder
 * shows matched volume beside `markets.total_matched_cents` and
 * INPLAY.tradedVolume, neither of which excludes buyouts. A ladder whose matched
 * column silently disagreed with the market's own matched total would be worse
 * than having no column. `lib/marketdata.js` says so where it is read.
 *
 * MAINTAINED BY A TRIGGER, not by `lib/match.js`. Every fill path is owned by
 * another workstream, and a rollup that application code updates is a rollup
 * that some future INSERT forgets — a ladder that silently shows no matched
 * volume on the one code path nobody tested. The database does it, so it cannot
 * drift from the tape.
 */
function migratePriceMatchedLevels(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS price_matched_levels (
  selection_id  INTEGER NOT NULL REFERENCES selections(id),
  market_id     INTEGER NOT NULL REFERENCES markets(id),
  price_cents   INTEGER NOT NULL CHECK (price_cents >= 101),
  -- strftime('%Y-%m-%d %H:%M', at): the minute this level traded in.
  bucket        TEXT NOT NULL,
  fills         INTEGER NOT NULL DEFAULT 0 CHECK (fills >= 0),
  matched_cents INTEGER NOT NULL DEFAULT 0 CHECK (matched_cents >= 0),
  PRIMARY KEY (selection_id, price_cents, bucket)
) WITHOUT ROWID`);
  // market_id leads because the board polls per market: every ladder render asks
  // "this market's levels over this window", and a bucket-led index would make
  // each of those an index range over the WHOLE venue's recent minutes instead
  // of one market's.
  db.exec('CREATE INDEX IF NOT EXISTS idx_price_matched_levels_market ON price_matched_levels (market_id, bucket)');

  // The trigger's absence is the migration's high-water mark. See below.
  const hadTrigger = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_matches_price_matched_levels'")
    .get();
  db.exec(
    'CREATE TRIGGER IF NOT EXISTS trg_matches_price_matched_levels AFTER INSERT ON matches BEGIN'
    + '  INSERT INTO price_matched_levels'
    + '    (selection_id, market_id, price_cents, bucket, fills, matched_cents)'
    + '  VALUES (NEW.selection_id, NEW.market_id, CAST(ROUND(NEW.price * 100) AS INTEGER),'
    + "          strftime('%Y-%m-%d %H:%M', NEW.at), 1, NEW.stake_cents)"
    + '  ON CONFLICT(selection_id, price_cents, bucket) DO UPDATE SET'
    + '    fills = fills + 1,'
    + '    matched_cents = matched_cents + NEW.stake_cents;'
    + 'END'
  );
  // BACKFILL, ONCE — and the trigger's absence is what proves "once".
  //
  // This migration runs on EVERY openStore(), so an unconditional backfill would
  // double the rollup on every boot, which is precisely the kind of
  // quiet-doubling defect this repo keeps auditing for. The trigger has existed
  // since the moment this table did on a fresh install, so once it is present
  // every fill is already accounted for and there is nothing to reconcile. When
  // it is ABSENT — a database that predates this migration — no row has ever
  // been maintained, so the whole rollup is rebuilt from `matches`.
  //
  // DELETE-then-INSERT rather than an additive upsert: the rebuild has to be
  // correct even if an earlier partial run left rows behind, and the table is
  // derived data so a correct rebuild is indistinguishable from the original.
  if (hadTrigger) return;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM price_matched_levels');
    db.exec(`INSERT INTO price_matched_levels (selection_id, market_id, price_cents, bucket, fills, matched_cents)
      SELECT selection_id,
             market_id,
             CAST(ROUND(price * 100) AS INTEGER),
             strftime('%Y-%m-%d %H:%M', at),
             COUNT(*),
             SUM(stake_cents)
        FROM matches
       GROUP BY selection_id, market_id, CAST(ROUND(price * 100) AS INTEGER), strftime('%Y-%m-%d %H:%M', at)`);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* connection already unwound */ }
    throw e;
  }
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

// ORDER TIME IN FORCE (#97): orders.persistence.
//
// Deliberately NOT in SCHEMA alone. SCHEMA runs first and `CREATE TABLE IF NOT
// EXISTS` leaves a pre-existing table exactly as it is, so a deployment created
// before this column existed would never gain it — and every read of it would
// fail with "no such column: persistence", including the sweep itself. That is
// the same trap migrateEligibleAt and migrateBookVersion record, and the only
// environment that can catch it is a database older than the column; a fresh
// :memory: install cannot.
//
// DEFAULT 'PERSIST', which is this venue's entire previous behaviour: an order
// rested until it matched or was cancelled, across the turn in-play like every
// other order. A database upgrading into this feature therefore has every
// pre-existing row already correct — not as a convenient default but because
// those rows WERE persist orders, and rewriting them to LAPSE would cancel a
// resting book nobody had asked to be cancelled.
function migrateOrderPersistence(db) {
  if (!hasColumn(db, 'orders', 'persistence')) {
    try {
      // The CHECK rides on the ALTER for the reason migratePayoutShape gives:
      // a column added here that SCHEMA does not also carry is a column an
      // upgraded database accepts a bad value into.
      db.exec("ALTER TABLE orders ADD COLUMN persistence TEXT NOT NULL DEFAULT 'PERSIST' CHECK (persistence IN ('LAPSE','PERSIST'))");
    } catch (e) {
      if (!hasColumn(db, 'orders', 'persistence')) throw e;
    }
  }
  // The sweep's index, here and not in SCHEMA — the fourth time this repository
  // has hit the "CREATE INDEX validates its columns immediately, and SCHEMA
  // runs before the migrations" trap (migrateEligibleAt records the previous
  // occurrence). Partial on the two predicates that decide the work: the pass
  // runs on a five-second timer, so the scan it avoids is a scan every five
  // seconds forever, and a book with fifty thousand historical orders is the
  // case this exists for.
  db.exec("CREATE INDEX IF NOT EXISTS idx_orders_lapse ON orders (market_id, id) WHERE persistence = 'LAPSE' AND status = 'open'");
}

// BOOK VERSION (#92). Two columns, one per scope, each added independently and
// guarded on its OWN column — the same per-column rule every other phase in
// this file follows, and for the same reason: a single guard over the block
// leaves a database that migrated when this list was shorter permanently
// unable to gain the later columns.
//
// NOT in SCHEMA alone. SCHEMA runs first and `CREATE TABLE IF NOT EXISTS`
// leaves a pre-existing table exactly as it is, so a deployment that predates
// these columns would never gain them and every placement would fail on
// "no such column: book_version". DEFAULT 0 is the right backfill: a database
// upgrading into this feature has no client that has ever read a version, so
// every counter starting at zero is both safe and honest — the first bump
// makes it one, and a client reading a book from that point on has a real
// number to send.
function migrateBookVersion(db) {
  for (const [table, ddl] of [
    ['markets', 'ALTER TABLE markets ADD COLUMN book_version INTEGER NOT NULL DEFAULT 0 CHECK (book_version >= 0)'],
    ['selections', 'ALTER TABLE selections ADD COLUMN book_version INTEGER NOT NULL DEFAULT 0 CHECK (book_version >= 0)'],
  ]) {
    if (hasColumn(db, table, 'book_version')) continue;
    try {
      db.exec(ddl);
    } catch (e) {
      // Lost a race with another opener: fine, as long as it landed.
      if (!hasColumn(db, table, 'book_version')) throw e;
    }
  }
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

// This is the SAME DDL as SCHEMA's tenants table, reached only for a database
  // old enough that no tenants table exists at all — SCHEMA's
  // `CREATE TABLE IF NOT EXISTS` has already run and left it alone. The currency
  // default is the venue's for the same reason as in SCHEMA, so a tenant row
  // created here is not born denominated in a hard-coded literal. migrateVenueCurrency
  // runs immediately after and aligns anything the pre-#104 default left behind.
  function migrateTenants(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    commission_bps INTEGER NOT NULL DEFAULT 250 CHECK (commission_bps >= 0 AND commission_bps <= 2000),
    currency TEXT NOT NULL DEFAULT '${require('./config').VENUE_CURRENCY}',
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
  // reads config for the commission rate and the currency — and this module's
  // remaining migrations reconcile STRUCTURE, which needs no operator input. It
  // is ensured at first use instead.
  //
  // The exceptions are the currency column default above and migrateVenueCurrency
  // below, which both read config. The reason is the same in each: the
  // denomination has to be the SAME value the running venue publishes through
  // /api/branding, or the first account assertion after an upgrade fails on a
  // database that is perfectly correct.
}

// ── #104: THE VENUE'S CURRENCY BECOMES A RECORDED FACT ────────────────────────
//
// WHAT WAS WRONG. `accounts.currency` was written with the literal 'USD' at both
// write sites in lib/accounts.js and read by nothing, and `tenants` had no
// currency column at all — so the currency a venue's money was denominated in
// existed only as a constant in the source of the module that wrote it. Not on
// the tenant, not in the branding, not in anything the browser could read.
//
// WHAT THIS DOES, IN THREE IDEMPOTENT STEPS.
//
//   1. Adds `tenants.currency` to a database created before it. Guarded by a
//      column probe, like every other migration here, so a part-migrated
//      database converges rather than failing on a duplicate ALTER.
//
//   2. Aligns the tenant rows still carrying the old hard-coded literal with
//      the configured venue currency.
//
//   3. Aligns the account rows AND the payment_intent rows still carrying it,
//      for the same reason.
//
// WHY payment_intents IS IN STEP 3 AND NOT AN AFTERTHOUGHT. lib/payments/
// confirmDeposit refuses to credit an intent whose currency is not the paying
// user's tenant's. Leaving the intents behind while relabelling the accounts
// they credit would therefore LOCK every deposit that was pending at the
// moment of the upgrade: the account became AUD, the intent stayed USD, and
// the guard added by this very change refuses every attempt to pay it in. A
// migration that makes existing money unmovable is worse than the decorative
// column it replaced.
//
// WHY THE PREDICATE IS `currency = 'USD'` AND NOT `currency IS NOT <venue>`.
//
// The step-2/3 alignment must touch the rows the REMOVED LITERAL wrote, and
// nothing else. On any database predating #104 that is exactly the rows whose
// value is 'USD': every account came from `ensureUserAccounts`, which passed
// that string regardless of what the venue traded in, and a tenant had no
// currency at all so its row arrives carrying the ALTER's fallback. Naming that
// one legacy value identifies "never configured" unambiguously — whereas
// "anything that differs from the configured venue currency" would also swallow
// a value somebody set deliberately, and silently undo it on the next boot.
// So a deliberate non-default value survives the migration and is then handled
// by the guards in lib/accounts.js and lib/tenants.js, which refuse it loudly.
//
// WHY RELABELLING EXISTING ROWS IS RECORDING, NOT REWRITING HISTORY. Both
// columns carried a literal that no code ever consulted: the accounts value was
// the string 'USD' passed by `ensureUserAccounts` regardless of what the venue
// traded in, and a tenant had no value at all. There is no history here to
// preserve — there was no fact, only a constant in the wrong place. After this
// the ledger records the venue's actual denomination for the first time. The
// alternative — preserving 'USD' on an Australian venue — would be preserving a
// typo, and would then fail every account assertion in lib/accounts.js on the
// first boot after the upgrade.
//
// An operator who changes VENUE_CURRENCY on a database that already holds
// balances relabels them, which is why the setting belongs in .env before a
// venue takes money and not after.
//
// WHY config IS READ HERE. The alignment target must be the SAME value the
// running venue publishes through /api/branding, or a correct database would
// be rejected as inconsistent. Every other migration in this file reconciles
// structure, which needs no operator input; this one reconciles a value the
// operator chose, which is why the require is lazy and local — as are the two
// reads of it in the SCHEMA call and in migrateTenants.
//
// WHY `IS NOT ?`-STYLE SINGLE PASS. Each statement is one UPDATE with an
// equality predicate, so the migration is genuinely re-runnable and writes
// nothing on a healthy boot.
function migrateVenueCurrency(db) {
  if (hasTable(db, 'tenants') && !hasColumn(db, 'tenants', 'currency')) {
    // SQLite cannot ADD COLUMN ... NOT NULL to a table that has rows without a
    // DEFAULT to fall back on, so the literal the old code used is carried
    // here purely to keep the ALTER legal. It is overwritten immediately below
    // and never consulted: lib/tenants.js supplies the value on every insert.
    try {
      db.exec("ALTER TABLE tenants ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
    } catch (e) {
      if (!hasColumn(db, 'tenants', 'currency')) throw e;
    }
  }

  const venue = require('./config').VENUE_CURRENCY;
  // The legacy literal. Named, not inherited: see the note above.
  const LEGACY_HARDCODED = 'USD';
  if (hasTable(db, 'tenants')) {
    db.prepare('UPDATE tenants SET currency = ? WHERE currency = ?').run(venue, LEGACY_HARDCODED);
  }
  if (hasTable(db, 'accounts')) {
    db.prepare('UPDATE accounts SET currency = ? WHERE currency = ?').run(venue, LEGACY_HARDCODED);
  }
  // See step 3 in the note above: an intent left behind here can never be
  // credited, because confirmDeposit compares it against the tenant currency
  // the line above has just changed.
  if (hasTable(db, 'payment_intents')) {
    db.prepare('UPDATE payment_intents SET currency = ? WHERE currency = ?').run(venue, LEGACY_HARDCODED);
  }
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

// ── Compliance migrations (#Australian AML/CTF, data-source register) ───────
//
// TWO THINGS THIS BLOCK GETS RIGHT THAT THE EARLIER ONES ALREADY TEACH, and
// they are the reasons it exists as a migration at all rather than as SCHEMA:
//
//   1. EVERY COLUMN ADD IS GUARDED ON ITS OWN COLUMN, independently. The
//      migrateUserAccounts comment records what happens when a block of five
//      adds is guarded as a block: a database that migrated when the list was
//      shorter has `role` but not `must_change_password`, the guard is false on
//      every subsequent boot, and the column is never added — leaving the
//      database permanently unable to boot. Found on a real local database.
//
//   2. EVERY INDEX LIVES HERE, NOT IN SCHEMA. db.exec(SCHEMA) runs BEFORE the
//      migrations, and CREATE INDEX validates its columns IMMEDIATELY — so an
//      index over a migration-added column aborts the boot of every database that
//      predates the migration. This repository has now hit that trap four times
//      and this block is the fifth place it is respected rather than rediscovered.
//
// AND THE THIRD RULE, WHICH IS THE ONE THAT MATTERS MOST HERE: write nothing on
// a healthy boot. Every statement below is guarded by a probe or by IF NOT
// EXISTS, so a current database pays a handful of pragma reads and changes no
// rows. That matters more than usual for these tables: financial-crime records
// are evidence, and a migration that rewrites them on every boot is a migration
// that destroys them.
function migrateCompliance(db) {
  // ── users: pre-verification state and registration origin ────────────────
  //
  // `identity_status` defaults to 'unverified' for pre-existing rows. That is the
  // correct backfill and NOT a convenient one: the pre-verification obligation
  // has a commencement date, so on a deployment that turns IDENTITY_REQUIRED on,
  // every account that predates it is unverified until the operator brings it
  // into compliance with a reasoned, audited decision. Backfilling them as
  // `verified` would wave the whole existing customer base through an obligation
  // that has been law since 29 September 2024, which is not a migration's call to
  // make.
  const userAdds = [
    ['identity_status', "ALTER TABLE users ADD COLUMN identity_status TEXT NOT NULL DEFAULT 'unverified' CHECK (identity_status IN ('unverified','pending','verified','failed','review'))"],
    ['identity_status_at', 'ALTER TABLE users ADD COLUMN identity_status_at TEXT'],
    ['registration_ip', 'ALTER TABLE users ADD COLUMN registration_ip TEXT'],
    ['registration_device', 'ALTER TABLE users ADD COLUMN registration_device TEXT'],
  ];
  for (const [column, ddl] of userAdds) {
    if (hasColumn(db, 'users', column)) continue;
    try {
      db.exec(ddl);
    } catch (e) {
      // Lost a race with another opener: fine, as long as it landed.
      if (!hasColumn(db, 'users', column)) throw e;
    }
  }
  // The CHECK rides on the ALTER rather than being left to SCHEMA, for the reason
  // migratePayoutShape gives: a column added here that SCHEMA does not also carry
  // is a column an upgraded database accepts a bad value into.
  //
  // And note what the schema deliberately does NOT gain here: no date of birth,
  // no document column, no image. Age assurance is a SEPARATE, individually
  // erasable record (the `age_assurance` table), and the reasoning is written out
  // in full on that table and at the head of lib/identity/index.js.

  // ── result_events: which licensed source an outcome came from ────────────
  //
  // NULLABLE with no default, so a pre-existing row stays exactly what it was:
  // an outcome that arrived before the register existed has no source, and the
  // register's "unattributed settlements" count is the thing that makes those
  // visible rather than the thing that hides them.
  if (!hasColumn(db, 'result_events', 'data_source_id')) {
    try {
      db.exec('ALTER TABLE result_events ADD COLUMN data_source_id INTEGER REFERENCES data_sources(id)');
    } catch (e) {
      if (!hasColumn(db, 'result_events', 'data_source_id')) throw e;
    }
  }

  // ── result_events: the DECLARED DEDUCTION on a withdrawal ─────────────────
  //
  // Two nullable columns, NULL on every row that predates them and on every
  // outcome that carries no withdrawal at all — which is most of them, and is the
  // honest state: a football result raises no deduction question, so inventing a
  // value for it would be worse than the gap.
  //
  // The CHECK rides on the ALTER, exactly as it does for markets.payout_shape and
  // orders.persistence, for the reason the schema comment there gives: a column
  // added by a migration that SCHEMA does not also carry is a column an upgraded
  // database accepts a bad value into. Both halves are in SCHEMA above.
  if (!hasColumn(db, 'result_events', 'deduction_state')) {
    try {
      db.exec("ALTER TABLE result_events ADD COLUMN deduction_state TEXT CHECK (deduction_state IN ('undeclared','declared','rejected'))");
    } catch (e) {
      if (!hasColumn(db, 'result_events', 'deduction_state')) throw e;
    }
  }
  if (!hasColumn(db, 'result_events', 'deductions_json')) {
    try {
      db.exec('ALTER TABLE result_events ADD COLUMN deductions_json TEXT');
    } catch (e) {
      if (!hasColumn(db, 'result_events', 'deductions_json')) throw e;
    }
  }

  // ── payment_intents: the funding side ────────────────────────────────────
  //
  // Four nullable columns, all NULL on every pre-existing row, which is the
  // honest state: this venue did not record who funded a deposit before the
  // columns existed, and backfilling a guess would be worse than the gap.
  const intentAdds = [
    ['payer_name', 'ALTER TABLE payment_intents ADD COLUMN payer_name TEXT'],
    ['funding_country', 'ALTER TABLE payment_intents ADD COLUMN funding_country TEXT'],
    ['funding_instrument_id', 'ALTER TABLE payment_intents ADD COLUMN funding_instrument_id INTEGER REFERENCES funding_instruments(id)'],
    ['payment_method_id', 'ALTER TABLE payment_intents ADD COLUMN payment_method_id INTEGER REFERENCES payment_methods(id)'],
    ['beneficiary_country', 'ALTER TABLE payment_intents ADD COLUMN beneficiary_country TEXT'],
  ];
  for (const [column, ddl] of intentAdds) {
    if (hasColumn(db, 'payment_intents', column)) continue;
    try {
      db.exec(ddl);
    } catch (e) {
      if (!hasColumn(db, 'payment_intents', column)) throw e;
    }
  }

  // The verified subject NAME. Added here rather than in the SCHEMA block above
  // because it rides on the new table, which is created further down in this same
  // function — an ALTER cannot precede the table it alters. Guarded on its own
  // column for the per-column reason in the header.
  if (!hasColumn(db, 'identity_verifications', 'subject_name')) {
    try {
      db.exec('ALTER TABLE identity_verifications ADD COLUMN subject_name TEXT');
    } catch (e) {
      if (!hasColumn(db, 'identity_verifications', 'subject_name')) throw e;
    }
  }

  // THE NEW TABLES. IF NOT EXISTS throughout, so a healthy boot creates nothing
  // and re-runs to the same state. They are created here rather than only in
  // SCHEMA for the same reason the columns are: `CREATE TABLE IF NOT EXISTS`
  // leaves a pre-existing table exactly as it is, so a database predating these
  // tables would never gain them and every read of them would fail with "no such
  // table" — including, for `data_sources`, the FK that result_events now
  // carries.
  //
  // ORDER IS BY DEPENDENCY and it is not cosmetic: `payment_intents` references
  // `funding_instruments` and `payment_methods`, and `result_events` references
  // `data_sources`. Creating a table whose foreign-key parent does not exist yet
  // is permitted by SQLite and then fails at the first INSERT, which is a much
  // worse place to discover it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS age_assurance (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      external_id TEXT,
      method TEXT NOT NULL CHECK (method IN ('privacy_preserving','third_party','document','self_declaration')),
      assurance TEXT NOT NULL CHECK (assurance IN ('attested','verified','self_declared')),
      outcome TEXT NOT NULL CHECK (outcome IN ('pass','fail')),
      attributes TEXT,
      verified_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      erased_at TEXT,
      erased_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS identity_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      provider TEXT NOT NULL,
      external_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','pass','fail','review','expired','closed')),
      decision TEXT CHECK (decision IS NULL OR decision IN ('pending','pass','fail','review','expired','closed')),
      checks TEXT,
      detail TEXT,
      subject_reference TEXT,
      subject_name TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS aml_entitlements (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      granted_by INTEGER REFERENCES users(id),
      reason TEXT,
      granted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS aml_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('high','medium','low')),
      user_id INTEGER REFERENCES users(id),
      detail TEXT,
      evidence TEXT,
      observed_cents INTEGER,
      source TEXT NOT NULL DEFAULT 'scheduled',
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      seen_count INTEGER NOT NULL DEFAULT 1,
      resolved_at TEXT,
      resolved_by INTEGER REFERENCES users(id),
      resolution TEXT
    );
    CREATE TABLE IF NOT EXISTS aml_threshold_obligations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      basis TEXT NOT NULL CHECK (basis IN ('single','related')),
      threshold_cents INTEGER NOT NULL,
      observed_cents INTEGER NOT NULL,
      window_from TEXT NOT NULL,
      window_to TEXT NOT NULL,
      transaction_ids TEXT,
      detail TEXT,
      report_reference TEXT,
      report_generated_at TEXT,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      seen_count INTEGER NOT NULL DEFAULT 1,
      discharged_at TEXT,
      discharged_by INTEGER REFERENCES users(id),
      discharge_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS aml_rule_thresholds (
      rule_id TEXT NOT NULL,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      value_cents INTEGER,
      value_count INTEGER,
      window_days INTEGER,
      updated_by INTEGER REFERENCES users(id),
      reason TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (rule_id, tenant_id)
    );
    CREATE TABLE IF NOT EXISTS funding_instruments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      instrument_kind TEXT NOT NULL CHECK (instrument_kind IN ('bank_account','payid','card','wallet','prepaid','processor_pool')),
      registered_owner TEXT NOT NULL,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('venue','processor','player','unknown')),
      processor_ref TEXT,
      jurisdiction TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS payment_methods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('bank_transfer','debit_card','credit_card','wallet','prepaid','paypal','bpay','other')),
      credit_linked INTEGER NOT NULL DEFAULT 0 CHECK (credit_linked IN (0,1)),
      seller_status TEXT CHECK (seller_status IS NULL OR seller_status IN ('approved_seller','restricted_seller')),
      permitted_countries TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS data_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      authority TEXT,
      licence_ref TEXT,
      fee_terms TEXT,
      permits TEXT NOT NULL DEFAULT '[]',
      starts_at TEXT,
      expires_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // THE INDEXES, HERE AND NOT IN SCHEMA — the fifth time this repository has
  // respected that trap (see the header). Two of them are partial on a predicate
  // that is the whole point of the index: a pending callback lookup is always
  // `external_id IS NOT NULL`, because a pending intent legitimately has none, and
  // an open-alert list is always `resolved_at IS NULL`.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_identity_user ON identity_verifications (user_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_external
      ON identity_verifications (provider, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_aml_alerts_open ON aml_alerts (resolved_at, severity, id);
    CREATE INDEX IF NOT EXISTS idx_aml_alerts_user ON aml_alerts (user_id, id);
    CREATE INDEX IF NOT EXISTS idx_aml_alerts_rule ON aml_alerts (rule_id, id);
    CREATE INDEX IF NOT EXISTS idx_aml_threshold_open ON aml_threshold_obligations (discharged_at, id);
    CREATE INDEX IF NOT EXISTS idx_aml_threshold_user ON aml_threshold_obligations (user_id, id);
    CREATE INDEX IF NOT EXISTS idx_funding_tenant ON funding_instruments (tenant_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_funding_owner ON funding_instruments (registered_owner);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_slug ON payment_methods (tenant_id, slug);
    CREATE INDEX IF NOT EXISTS idx_data_sources_expiry ON data_sources (enabled, expires_at);
    CREATE INDEX IF NOT EXISTS idx_result_events_source ON result_events (data_source_id, id);
    -- The deduction gap, as a QUERY rather than a promise. lib/deductions.js counts
    -- "settled a race with a late scratching and nothing was declared", which is the
    -- total the venue overpaid; an operator reads that number off an index rather
    -- than off a scan of every outcome this venue has ever settled. Same
    -- rule-first predicate as the counts it serves, because a withdrawal is the
    -- RULE and not the decision (see lib/deductions.js).
    CREATE INDEX IF NOT EXISTS idx_result_events_deduction ON result_events (deduction_state, id);
  `);
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
  // SCHEMA is a function so the three currency column defaults carry the
  // VENUE'S currency rather than a literal — see the note on the signature.
  // config is required here, not at module load, so requiring lib/store.js
  // does not drag the whole operator configuration (and its .env read) into
  // processes that only want the schema text.
  db.exec(SCHEMA(require('./config').VENUE_CURRENCY));
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
  migrateOrderPersistence(db);
  migrateBookVersion(db);
  // Order matters: the report indexes reference matches.cashout, which
  // migrateCashoutBuyouts adds. An index created before its column exists
  // aborts the boot of every database predating it.
  migrateCashoutBuyouts(db);
  migrateReportIndexes(db);
  migrateEventIsDemo(db);
  migrateLoginAttempts(db);
  migrateFeedCredentials(db);
  // The other half of the feed's operator surface: the identity map the
  // materialiser writes and the results path reads. Registered beside
  // migrateFeedCredentials because it is that table's counterpart, and it has no
  // dependency either way — it references nothing, so there is no column for a
  // later migration to have to come first.
  migrateFeedMap(db);
  // The matched-volume rollup (#93) and its trigger read `matches`, which every
  // earlier migration has already finished reconciling by this point. It is
  // registered after migrateCashoutBuyouts/migrateReportIndexes because its
  // backfill groups over matches and a half-migrated table would fold the wrong
  // rows into the rollup.
  migratePriceMatchedLevels(db);
  migrateClientOrderId(db);
  migrateTenants(db);
  // After migrateTenants: the currency column has to exist before the rows can
  // be aligned with it.
  migrateVenueCurrency(db);
  // LAST, and in dependency order inside it. Registered after migrateTenants
  // because `aml_rule_thresholds`, `funding_instruments` and `payment_methods` all
  // declare a foreign key to `tenants(id)` — creating those before the tenant
  // table exists is permitted by SQLite and then fails at the first INSERT, which
  // is a far worse place to discover it. And after migrateVenueCurrency because a
  // half-migrated financial-crime table is evidence, and this block writes
  // nothing on a healthy boot by design.
  migrateCompliance(db);
  return db;
}

module.exports = { openStore };
