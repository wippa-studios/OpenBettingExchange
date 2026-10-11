# Roadmap: from demo to operator-grade exchange

The thesis: **the operator owns the book.** Not "license our platform" —
the operator holds the player ledger, the risk configuration, the settlement
rules and the data, and can read every line that moves money.

This document is the map from the current codebase to that. It is written
against the code as it stands, not an aspiration.

---

## 1. Where we actually are

An inventory, so the plan is grounded rather than generic.

**Done and load-bearing:**

| Capability | Where | Notes |
| --- | --- | --- |
| Matching engine | `lib/match.js` | price-time priority, best-for-taker, fill at resting price, partial fills, self-match guard |
| Escrow ledger | `lib/ledger.js` | integer cents, single rounding point, available vs frozen, refusal to over-commit |
| Transaction discipline | `lib/tx.js` | savepoint nesting, cross-connection nesting refused loudly |
| Settlement | `lib/settle.js` | pot distribution, void refunds, commission on net winnings, auto-cancel, double-settle blocked |
| Cash-out | `lib/cashout.js` | green-up close, hedge scaled `1/n`, own-liquidity correctly excluded |
| Tick ladder | `lib/odds.js` | Betfair increments, American/fractional/implied, overround |
| Odds feed client | `lib/feed.js` | board/nav contract from a Postgres recorder, staleness reporting |
| Test suite | `tests/` | 17 suites, hand-computed money rules, smoke + Playwright |

**The property worth protecting:** settlement solvency is structural, not
defensive. Every match is collateralised on both sides, so there is no
correlation exposure and no default risk on a matched position. That is the
single most important thing this codebase has, and every change below must
preserve it.

**What "operator owns the book" requires that does not exist:**

- No tenant concept — `COMMISSION_RATE` is a global env var
- Single-entry balances — one `balance_cents` per user, no account types, so
  player funds cannot be segregated from operator funds
- No real money movement — `POST /api/wallet/deposit` is a faucet
- No player lifecycle — no KYC state, no self-exclusion, no deposit limits
- No results feed — settlement is an admin console action
- No abuse controls — a player can hold unlimited liability in one market
- No audit trail of operator actions — only financial movements are recorded
- No operational surface — metrics, reconciliation, backup/restore

---

## 2. Corrections to the risk picture

Two things are commonly assumed about exchanges that are wrong here, and the
plan depends on getting them right.

**Exposure is not solvency risk.** A player cannot win more than their escrow
covers. A back freezes `s`, a lay freezes `(P−1)·s`, the pot is `s·P`, and both
sides release into the winner. Correlation across markets is irrelevant because
each match settles independently. Limits are therefore **not** a solvency
control; they are an *abuse* control (Phase 1) and are about behaviour, not
solvency.

**The venue's real liability is the market maker.** `lib/store.js` allows
`is_bot = 1` accounts to hold a negative balance, which is correct — a house
counterparty must be able to owe money. But the bots in `lib/bots.js` quote a
drifting fair price with no edge, so any bettor with an information advantage
beats them systematically and the venue absorbs the loss. That is an unbounded
loss with no limit anywhere in the system, and it is the sharpest gap in the
code today. Phase 2 addresses it.

---

## 3. Phase plan

Phases 0–2 are prerequisites for a single operator running real money. Phases
3–5 are scale and reach. Phase 6 is the business surface.

### Phase 0 — Make it actually open source

Blocking, and it is not software. `LICENSE`, `CONTRIBUTING.md`, `CHANGELOG.md`
and `CODE_OF_CONDUCT.md` are tracked in git but **deleted from the working
tree**, while the README still links to `LICENSE` and `CONTRIBUTING.md` and
`package.json` declares MIT. `wippa-studios/OpenBettingExchange` returns 404. An MIT
project with no licence file is not open source and cannot be contributed to.

**Work:** restore or rewrite the four files; make the repo public; verify
`LICENSE` and `package.json` agree; correct the README's licence section.
**Done when:** a stranger can clone, read the licence, and contribute.

### Phase 1 — Abuse controls

Not solvency — see §2. These limit what a single account can do.

**Schema:** `limits(user_id, scope, max_open_stake_cents, max_market_liability_cents,
max_daily_settled_cents, period_start)`, plus `users.status` and
`users.excluded_until` for self-exclusion.

**Behaviour:**
- Reject a placement that would take the user's open liability on one market
  past their cap. Computed inside the placement transaction, so it cannot race.
- Clamp net-settlement exposure per user per day. Where exceeded, stop matching
  and leave the remainder resting — never silently cancel, which would change
  the book's meaning to everyone else.
- Self-exclusion is absolute and outranks open positions: exclude, cancel
  resting orders, release escrow, do not re-admit via any path.

**Design note:** limits are a table, not constants. `MIN_STAKE_CENTS` and
`MAX_STAKE_CENTS` stay as venue defaults; per-user limits override them. This is
also where the operator-facing reason code is stored, because a limit breach
that a player can appeal needs a recorded cause.

**Done when:** a user who would exceed a cap is refused with a distinct error,
the refusal is in the audit log, and the check is proven not to race under
concurrent placement.

### Phase 2 — Market-maker risk

The venue's actual P&L exposure. This is the piece that makes the exchange
economically survivable rather than merely technically correct.

**Schema:** `risk_bots(bot_id, max_liability_cents, max_daily_loss_cents,
stop_trading_at, quote_skew)`; extend `settings` for desk-level kill switches.

**Behaviour:**
- Bot liability is bounded per bot and per day. When a bot approaches its cap,
  widen the quoted price by `quote_skew` rather than stopping — the market stays
  open and the venue stops being the sharpest thing in it.
- At the hard cap the bot withdraws quotes. Liquidity disappears, which is
  correct: the alternative is an unbounded loss.
- A desk-level kill switch pulls all bot quotes within one transaction.
- Expose the bots' cumulative P&L on the admin desk. A venue that cannot see its
  own market-maker loss is a venue that discovers it by going bankrupt.

**The honest limit:** skew and caps are *damage limitation*, not edge. An
exchange that wants a positive trading result needs a real quote model — a fair
price from external books with a spread, not a random walk. `lib/drift.js` is
explicitly a random walk and the README says so. Phase 2 makes the loss bounded;
making it positive is Phase 3 work with real odds data.

**Done when:** a bot cannot exceed its daily loss cap, the desk shows the
exposure, and the kill switch is tested.

### Phase 3 — Money: double-entry ledger and real payments

The change that makes this acceptable to a licensed operator. Fund segregation
is a legal requirement, and a single `balance_cents` column cannot express it.

**Schema:** replace single-entry with accounts and postings.

```
accounts(id, tenant_id, kind, currency)          kind ∈ player_funds,
                                                  operator_commission,
                                                  house_float,
                                                  gateway_clearing, bonus
entries(id, tenant_id, transaction_id, account_id, direction, amount_cents)
```

`transactions` becomes a header; `entries` are the postings. **Every operation
becomes balanced entries summing to zero.** Then:
- Fund segregation is an assertion: `sum(player_funds) >= sum(liabilities)`.
- Global conservation is testable: total debits equal total credits, always.
- Operator revenue is `operator_commission`, queryable, not inferred.

`users.balance_cents` survives as a materialised cache with a test asserting it
equals the sum of that user's `player_funds` postings.

**Payments:** replace the faucet with a payment abstraction. Deposit intent →
provider adapter → credit on confirmation (never on initiation). Withdrawals
with a hold, a cooling-off period and a reconciliation step. **No provider is
built in** — the adapter interface plus one reference integration is the
deliverable, because every jurisdiction has a different requirement and the
operator already has a contract with a PSP.

**Why double-entry is not optional:** it is the difference between "we log
money movements" and "we can prove to an auditor that players' funds are
segregated and intact." For the positioning in §0, this is the whole argument.

**Done when:** every cent moves as balanced postings, conservation is asserted
in tests, and segregation is a query rather than a promise.

### Phase 4 — Tenancy

Self-hosting is the degenerate case of multi-tenancy. Modelling it as one is
both simpler to sell and honest about the deployment story.

**Schema:** `tenants(id, slug, name, status, commission_bps, brand JSON,
jurisdictions JSON, feed_config JSON, psp_config JSON)`; `users.tenant_id`;
every operational table gains `tenant_id` and a leading index entry.

**Behaviour:**
- Commission per tenant, replacing the global `COMMISSION_RATE`. Keep the global
  as the default so a single-operator install needs no tenant row to work.
- Brand per tenant: name, logo, palette, terms URL. The frontend already serves
  fonts and logo locally, so theming is a config read, not a build step — which
  is why the no-build frontend turns out to be an asset here.
- Jurisdiction allowlist per tenant, enforced at session creation, not at bet
  placement. A blocked player should never hold a live position.
- Admin scopes to tenant. Cross-tenant reads are a bug, and the tests should
  assert they are impossible rather than merely absent.

**Migration:** every table is touched, so this is one deliberate change rather
than incremental. Do it after Phase 3, once the ledger is already multi-row.

**Done when:** two tenants coexist with separate brands, commissions and
allowlists, and no query can cross them.

### Phase 5 — Feed, market lifecycle, scale

**Results feed.** `settleMarket` is already a single idempotent entry point, so
this is a consumer, not a rewrite. Requirements beyond calling it:
- Per-sport void rules. A red card at 70 minutes, a rained-off race, a walkover.
  A results feed that does not model voids will settle incorrectly and the
  operator will pay for it.
- Disputed outcomes, held rather than settled, with a manual release path.
- The feed's own audit: every outcome settled is traceable to a source event.

**In-play.** Bet delay modelling, a traded-volume ladder, and a clear statement
of the latency you actually offer. In-play without honest delay modelling is
where a venue loses money to sharps.

**Feed resilience.** `FEED_STALE_SECONDS` reports staleness but does not
reconcile. A dropped SSE connection mid-event leaves an unmarked hole. Add gap
detection and a resync path — `crates/adapters/betfair/src/book/recovery.rs` in
Nautilus Trader is a good reference for the lifecycle.

**Persistence — a decision, not a task.** The engine is synchronous and
`DatabaseSync` is single-threaded, which is *why* the sweep is inherently
atomic. That property is load-bearing. Postgres via `pg` is async, so migrating
means:
- the engine becomes async end to end, and
- atomicity now depends on explicit isolation (`SELECT … FOR UPDATE` on the
  selection row) rather than on the absence of yields.

Three options, in the order I'd consider them:
1. **Keep SQLite** — a single operator at modest volume is genuinely fine, and
   it preserves the correctness argument. Cheapest, and honest about the ceiling.
2. **Shard by selection** — SQLite per market, partitioned by a directory
   router. Keeps the synchronous property, scales horizontally by market, but
   forfeits cross-market queries (correlation analytics) and complicates
   settlement.
3. **Postgres** — accepts the async rewrite and buys real concurrency plus
   single-writer-free operation. Highest ceiling, highest cost, and the only one
   that requires re-proving the escrow invariant under row-level locking.

Recommend **1 until an operator's volume forces the decision**, then 3. Do not
take 2; sharding by market is a trap when settlement and analytics are
cross-market by definition.

**Done when:** outcomes settle automatically with void rules, and the persistence
choice is made against a real volume number rather than a guess.

### Phase 6 — Operator surface and the business

**Audit log.** Operator actions are currently invisible: suspend, void, manual
adjust, limit change, bot config. Only money moves are recorded. An immutable
`audit_log(actor, action, target, before, after, reason, at)` is what makes the
platform auditable, and it is the concrete form of "the operator owns the book."
Every privileged action gets one, including the automatic ones, with the actor
distinguished from the system.

**Reconciliation.** A scheduled job proving external balances equal internal
ledgers: PSP settlement reports against `gateway_clearing`, player balances
against `player_funds`. Discrepancies are findings, not exceptions to log.

**Reporting.** Regulatory exports (per-market volume, per-player net
settlement, commission), financial (GGR, hold, margin), and operational
(match rate, unmatched ratio, average bet delay, bot P&L). Operators buy
reporting because it is the alternative to writing it themselves.

**Responsible gambling.** Age verification, reality checks, session limits,
self-exclusion wired to the Phase 1 table. Not optional anywhere it is legal,
and the product should not be deployable to an operator who has not configured
it.

**Positioning.** The one-line pitch is *the operator owns the book*: their
players, their ledger, their data, their risk configuration, and an inspectable
codebase that answers a regulator's question. The incumbent vendors cannot
match it without cannibalising their own lock-in, which is the strongest
available moat. Everything in Phases 3 and 6 exists to make that claim
substantiable rather than rhetorical.

---

## 4. Sequencing and dependencies

```
Phase 0  repo legitimacy              ─┬─ no dependencies, blocks everything public
                                      │
Phase 1  abuse controls               ─┤─ needs 0 for a public repo
                                      │
Phase 2  market-maker risk            ─┘─ needs 1 (limits framework reused)
                                      │
Phase 3  double-entry + payments      ── needs 2 (risk must be bounded before real money)
                                      │
Phase 4  tenancy                      ── needs 3 (ledger is already multi-row)
                                      │
Phase 5  feed / lifecycle / scale     ── needs 3; persistence choice is independent
                                      │
Phase 6  audit, reconciliation, RG    ── needs 3 and 4
```

Phase 2 before Phase 3 is deliberate: the market-maker liability is the one
unbounded loss in the system, and unbounded liability must be fixed before real
funds are involved, not after.

---

## 5. What would kill this

Named up front, because they are more likely than any technical failure.

**The category is crowded and the incumbents bundle.** Matchbook B2B, GammaStack,
Softmatch, BetConstruct and others sell exchange software today, and their pitch
is "launched in 3 days, licence included, payments pre-integrated." A two-week-old
single-author codebase cannot beat that on features and should not try. The entry
has to be markets they ignore, or the auditability angle sold to one technical
operator who would rather self-host than rent.

**Liability.** Holding customer funds and paying winners is a regulated activity.
Phase 3 and Phase 6 make the platform *capable* of supporting a licensed
operation; they do not make the operator licensed. That is months and money,
independent of everything here.

**Support burden.** Self-hosting means operators file bugs against your database
schema. The no-ORM, single-SQL-file design is an asset for *reading* the system
and a liability for *writing migrations for six other people*. Phase 4's
per-tenant migration tooling is where that cost lands.

**Single author.** Fourteen commits, one author, two weeks. The escrow invariant
is correct as written but the design is load-bearing on `orders.frozen_cents`
being mutated only by `lib/match.js` — a convention, not a type. That
convention needs to be enforced mechanically before other people edit the engine.

**Betfair's terms.** The matching semantics are public and Betfair-compatible
semantics are standard practice, but anyone running a licensed exchange will
raise the question. Worth having a written answer before the first serious
conversation.

---

## 6. Immediate next actions

1. **Run the suite.** 196 checks are claimed and unverified. Run `npm test`,
   `npm run test:smoke`, `npm run test:ui` before changing anything, so there is
   a known-good baseline to compare against.
2. **Restore Phase 0.** Four files and a public repo. Smallest possible step to
   making the project real.
3. **Add order idempotency.** A client-supplied `client_order_id`, unique per
   user. Small, and at operator scale a double-submit becomes a financial
   incident rather than an annoyance.
4. **Prove the escrow invariant adversarially.** Partial fills at tick
   boundaries, cancel-during-match, cash-out where the only liquidity is the
   user's own resting orders, settlement after every combination. The suite is
   self-authored; an outside reading of the money path is worth more than
   another self-authored test.

Then Phase 1 and Phase 2, which are the real product work, and Phase 3, which is
the part that makes the positioning true.