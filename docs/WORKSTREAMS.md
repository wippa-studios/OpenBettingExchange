# Workstreams

Three parts: **front end**, **engine**, **back end**. What each owns, what
each needs, and where the seams are.

The split follows the existing module boundaries, with two deliberate moves:
`server.js` becomes a composition root, and the domain gets a hard interface
between it and everything that talks to it.

---

## The three parts

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. FRONT END — public/                                           │
│    board · bet slip · positions · wallet · admin desk · theming  │
│    zero build, vanilla, no framework                             │
└──────────────────────────┬──────────────────────────────────────┘
                           │ REST + SSE, cookie session
                           │ contract only — never sees domain logic
┌──────────────────────────▼──────────────────────────────────────┐
│ 3. BACK END — server.js + lib/{auth,config,feed,store}          │
│    HTTP · sessions · admin · tenant config · feeds · accounts   │
│    payment adapters · KYC state · audit log                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │ narrow domain interface
┌──────────────────────────▼──────────────────────────────────────┐
│ 2. ENGINE — lib/{match,ledger,settle,cashout,odds,tx,bots,drift} │
│    matching · escrow · settlement · cash-out · pricing · risk    │
│    no HTTP, no SQL, no rendering, no payment                     │
└─────────────────────────────────────────────────────────────────┘
                           │
                    node:sqlite (WAL)  →  Postgres (Phase 5)
```

The engine is the part that must stay uncorrupted. It is the only piece with
a correctness argument, so it gets the strictest boundaries and the least
willingness to take dependencies.

---

## 1. Front end

**Today:** `public/app.js` (1,768 lines, one IIFE, ~40 top-level functions),
`admin.js` (329), `ladder.js` (118), `index.html` (86), `style.css` (725).
Zero build step, classic scripts, self-hosted Inter fonts.

### Work

**a. Split `app.js`.** The single biggest frontend task and pure mechanical
work. It's already organised into named render functions — `renderMarkets`,
`renderBets`, `renderWallet`, `renderSlip`, `renderSidebar`, `renderRaces` —
so the seams exist. Target layout:

| File | Owns |
| --- | --- |
| `core/api.js` | `fetch` wrapper, error shape, session expiry |
| `core/stream.js` | SSE subscription, reconnect, 15s poll fallback |
| `core/state.js` | the single `state` object, mutation rules |
| `core/dom.js` | `el`, `esc`, `attr`, `setHtml`, `toast` |
| `core/overlay.js` | focus trap, `overlayStack`, open/close |
| `views/board.js` | sport nav, sidebar, market cards, ladder mounting |
| `views/slip.js` | bet slip, stepper, price ladder clicks |
| `views/bets.js` | positions, open orders, cash-out |
| `views/wallet.js` | balance, ledger |
| `views/auth.js` | auth modal, register/login |

Keep classic scripts and load order explicit in `index.html`. No bundler —
that's a deliberate product decision for operators who want to read and patch
the thing, and it survives Phase 4 because per-tenant theming is a config read.

**b. Money display correctness.** `fmt(cents)` and `signed(cents)` are the only
money formatters. Once commission, refunds and multi-currency exist, these need
a shared spec: which values are integer cents, where rounding is visible, how
negative balances render. Operator-visible money must never be formatted
loosely.

**c. Positions view — the real gap.** Currently positions show per-runner
exposure and if-this-wins P&L. An operator's players need:
- exposure across the whole account, not per market
- which limit was hit and why a bet was refused
- multi-runner cash-out (Phase 3, engine)
- settlement history with commission shown separately from net

**d. Refusal surfaces.** Phase 1 introduces refusals (limit breach, excluded).
Right now the client handles 4xx as a toast. A refusal that changes a player's
ability to bet needs to be visible on the positions view, not a transient toast.

**e. Theming.** Phase 4 needs per-tenant brand. Today assets are fixed files
under `public/assets/`. Target: a `GET /api/branding` returning the tenant's
palette/logo/terms URL, applied via CSS custom properties on `:root`. No build
step involved. Fonts stay self-hosted; add a fallback stack for operators who
want to drop the Inter files.

**f. Accessibility and keyboard.** There's already a focus trap and
`FOCUSABLE` handling in `overlay.js` territory — good. Extend it: full keyboard
navigation of the ladder (a price is a button and must be reachable), live
regions for price changes so a screen reader announces fills, and
`prefers-reduced-motion` on the flash animations.

**g. Test coverage.** `test:ui` has 74 checks and asserts ladder *geometry*.
Add: slip arithmetic (stake/price/liability preview matches what the server
will escrow), refusal rendering, and a viewport pass at mobile width — the
board is a three-column layout that almost certainly breaks on phone.

**Definition of done:** no file over ~400 lines, every view mountable in
isolation, and the UI suite covering slip arithmetic and refusal states.

---

## 2. Engine

**Today:** `lib/match.js` (452), `lib/settle.js` (174), `lib/ledger.js` (158),
`lib/cashout.js` (114), `lib/odds.js`, `lib/tx.js`, `lib/bots.js`,
`lib/drift.js`. Strictly one-way: `match → ledger → tx`, with
`settle`/`cashout → match`. No HTTP, no rendering.

This is the crown jewel and it's already correct on the hard parts. The work
here is **additive**, not corrective.

### Work

**a. Order idempotency.** Smallest high-value item in the whole project. Client
supplies `client_order_id`; unique index per user; a repeat returns the existing
order rather than placing a second. At operator scale a double-submit is a
financial incident, not an annoyance. Schema: `orders.client_order_id` +
`CREATE UNIQUE INDEX ... ON orders(user_id, client_order_id)`.

**b. Per-user limits (abuse, not solvency).** `limits` table plus enforcement
inside the placement transaction so it can't race. A breach refuses with a
distinct error code and a recorded reason — the player will appeal, so the
cause has to be retrievable. `users.status` and `users.excluded_until` for
self-exclusion, which outranks open positions: exclude, cancel resting orders,
release escrow, no re-admission path.

**c. Market-maker risk.** The one unbounded loss in the system.
`risk_bots` with per-bot and per-day liability caps. Behaviour is **skew before
stop** — widen the quoted price as the cap approaches, so the market stays open
and the venue stops being the sharpest thing in it. At the hard cap, withdraw
quotes. A desk-level kill switch pulls all bot quotes in one transaction.
Expose cumulative bot P&L on the admin desk.

State the limit honestly: this bounds the loss, it does not make it positive.
That needs a real quote model from external books, and `lib/drift.js` is
explicitly a random walk.

**d. Multi-runner cash-out.** `cashout.js` currently returns `null` for mixed
or multi-selection positions (line 29 — the v1 scope guard). Generalise plan
construction: net all the user's legs across the market into a single hedge
direction and stake. The engine primitives are already there; it's plan
construction that changes.

**e. Accumulators and each-way.** Roadmap items, currently not implemented.
Each-way is a settlement shape change (per-selection win/loss rather than one
winner per market). Accumulators are a genuine new pricing problem — correlated
legs need a combined probability, which pulls in the de-vig machinery.
Defer both; they are not on the operator-critical path.

**f. In-play.** Bet delay modelling and a traded-volume ladder. In-play without
honest delay modelling is where a venue loses money to sharps, so model the
delay you actually offer and publish it in the UI.

**g. Enforce the frozen_cents convention mechanically.** The escrow invariant is
correct as written, but it holds only because `orders.frozen_cents` is mutated
*exclusively* by `lib/match.js`. That's a convention, not a type — and Phase 4
puts other people's code near it. Options: a schema-level guard, a write-path
audit test that fails if any module other than `match.js` issues an UPDATE
against `orders`, or moving remainder escrow into a dedicated table only the
engine writes. Do at least one before other contributors arrive.

**h. Persistence (a decision, not a task).** The engine is synchronous and
`DatabaseSync` never yields — **that is why the sweep is inherently atomic.**
Postgres via `pg` is async, so migrating means the engine goes async end to end
and atomicity moves from "no yields" to explicit `SELECT … FOR UPDATE`.

Keep SQLite until a real operator's volume forces this. Do not shard by market:
settlement and correlation analytics are cross-market by definition. When the
day comes, it is Postgres, and the escrow invariant gets re-proved under
row-level locking.

**Definition of done:** idempotent orders, limits enforceable under
concurrency, bounded bot liability, multi-runner cash-out, and the frozen_cents
convention enforced by something other than a code comment.

---

## 3. Back end

**Today:** `server.js` (880 lines — origin guard, sessions, SSE broadcaster,
rate limiter, ~35 routes, static, error handler), `lib/auth.js` (scrypt +
opaque tokens), `lib/config.js` (validated at boot, aborts on bad value),
`lib/feed.js` (23KB, Postgres recorder client), `lib/store.js` (13 tables,
pragmas, idempotent migration).

### Work

**a. Carve `server.js` into a composition root.** 880 lines with SSE lifecycle,
rate limiting, auth middleware, slugify, ISO-date validation and SQL-constraint
mapping is too much in one file. Target:

```
server.js              boot, middleware order, route mounting
routes/auth.js         register · login · logout · me
routes/board.js        sports · events · book · feed/*
routes/trading.js      orders · positions · cashout
routes/wallet.js       wallet · deposit
routes/admin.js        catalogue · suspend · settle · stats
lib/session.js         cookie, token, requireAuth/requireAdmin
lib/stream.js          SSE clients, broadcast, heartbeat
lib/ratelimit.js       login limiter
lib/validate.js        slugify · intId · ISO datetime · constraint mapping
```

Middleware order is load-bearing and already documented — origin guard **before**
body parsing, so a malformed body from a foreign origin is still a 403. Keep
that order and keep asserting it in tests.

**b. Domain interface.** Today routes import `lib/match.js` directly. Introduce
a narrow façade (`lib/domain.js`) exposing intent-level operations —
`placeOrder`, `cancelOrder`, `settleMarket`, `quoteCashout` — rather than 30
function names. This is what lets Phase 4 multi-tenancy wrap every operation in
tenant context without touching the engine.

**c. Double-entry ledger.** The change that makes this acceptable to a licensed
operator. Accounts and balanced postings:

```
accounts(id, tenant_id, kind, currency)      player_funds · operator_commission
                                             house_float · gateway_clearing · bonus
entries(id, tenant_id, transaction_id, account_id, direction, amount_cents)
```

Every operation becomes balanced entries summing to zero. Then fund
segregation is an *assertion* (`sum(player_funds) >= sum(liabilities)`) and
global conservation is testable. Operator revenue becomes a query, not an
inference. `users.balance_cents` survives as a materialised cache with a test
proving it matches the postings.

This touches `ledger.js` (engine) — the one place the back end legitimately
reaches into the engine. Sequence it with the engine work, not after.

**d. Payments.** Replace the faucet with a provider abstraction: deposit intent
→ adapter → credit on **confirmation**, never initiation. Withdrawals with a
hold, cooling-off period, reconciliation. Ship the interface plus one reference
adapter; every jurisdiction differs and the operator already has a PSP
contract. No provider built in.

**e. Tenancy.** `tenants(id, slug, name, status, commission_bps, brand JSON,
jurisdictions JSON, feed_config JSON, psp_config JSON)`, `users.tenant_id`, and
`tenant_id` on every operational table with the index leading. Self-hosting is
the degenerate case — keep `COMMISSION_RATE` as the default so a single-operator
install needs no tenant row. Jurisdiction allowlist enforced **at session
creation**, not at bet placement: a blocked player should never hold a position.

**f. Results feed and market lifecycle.** `settleMarket` is already a single
idempotent entry point, so this is a consumer, not a rewrite. Needs per-sport
void rules (red card at 70', rained-off race, walkover), disputed outcomes held
rather than settled with a manual release path, and an audit link from every
settlement to its source event.

**g. Feed resilience.** `FEED_STALE_SECONDS` reports staleness but doesn't
reconcile — a dropped connection leaves an unmarked hole. Add gap detection and
resync. `crates/adapters/betfair/src/book/recovery.rs` in Nautilus Trader is a
good reference for the lifecycle.

**h. Accounts and KYC.** Registration exists (username + scrypt). An operator
needs: email verification, password reset, KYC status on `users` with
verification tiers, deposit limits per KYC level, self-exclusion wired to the
engine's exclusion, and age attestation.

**i. Admin and audit.** The admin desk exists for catalogue and settlement.
Operator grade needs: tenant config, limits UI, bot P&L and kill switch,
manual adjustments **with a mandatory reason**, and an immutable
`audit_log(actor, action, target, before, after, reason, at)` covering every
privileged action including automatic ones. Only money movements are logged
today; this is the concrete form of "the operator owns the book."

**j. Reconciliation and reporting.** Scheduled job proving external balances
equal internal ledgers — PSP settlement reports vs `gateway_clearing`, player
balances vs `player_funds`. Discrepancies are findings, not log lines.
Reporting: regulatory (per-market volume, per-player net settlement,
commission), financial (GGR, hold, margin), operational (match rate, unmatched
ratio, avg bet delay, bot P&L).

**Definition of done:** thin composition root, domain façade, double-entry with
segregation proven by test, one working payment adapter, tenancy with
jurisdiction gating, automatic settlement with void rules, and an audit log an
operator's auditor would accept.

---

## Cross-cutting

**Order of work.** The engine's additive work (idempotency, limits, bot risk)
comes first because it's small and it de-risks everything downstream. Then
double-entry, because once money moves for real the ledger shape is expensive
to change. Then tenancy — one deliberate change across every table rather than
incremental patches. Frontend work interleaves: split `app.js` early since it's
mechanical, but the positions and refusal surfaces depend on engine and
back-end limits existing first.

**Testing strategy is already right; keep it.** Plain `assert`, numbered
examples, no mocks, executable specification per file. The browser suite
asserting ladder *geometry* rather than presence is a good instinct — extend
the same rigor to slip arithmetic and refusal rendering.

**The verification gap — DISCHARGED (see docs/ROADMAP.md).** An outside
reviewer read every money-path module and ran exploit scripts against the
real modules. Ten findings, three of them real-money blockers, all fixed and
regression-tested (tests/audit.test.js). The outside pass also found a
lay-side cash-out bug that every self-authored test had masked, because they
all cashed out a back position. The `orders.frozen_cents` allowlist this
document demanded is now enforced by tests/guard.test.js — along with the
equivalent for `users.balance_cents` / `users.frozen_cents`, which the audit
found was the actual hole (the withdrawal path wrote it directly, outside
the posting layer).

**One risk that cuts across all three:** the `orders.frozen_cents` convention.
It's the linchpin of the escrow invariant, it's currently protected by a comment
rather than a mechanism, and all three parts will eventually want to write
against `orders`. Enforce it before the other work lands.

---

## Quick reference

| | Front end | Engine | Back end |
| --- | --- | --- | --- |
| **Owns** | rendering, slip UX, theming, a11y | matching, escrow, settlement, pricing, risk | HTTP, sessions, feeds, payments, tenants, admin, audit |
| **Must never** | compute money the server didn't confirm | import HTTP, SQL, or render code | reimplement matching or settlement logic |
| **Today** | 3,026 lines, 1 file dominates | correct, well-tested, ~1,200 lines | 880-line monolith + 4 modules |
| **Biggest task** | split `app.js`; positions & refusal UX | bot risk + limits (additive) | double-entry + carve `server.js` |
| **Blocking for** | operator trust (readable, patchable) | everything | licensing, real money, positioning |

The engine column is the short one, and that's the point: the hard part is
already built. The other two columns are volume, not difficulty.