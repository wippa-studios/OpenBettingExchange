# Roadmap: from demo to operator-grade exchange

The thesis: **the operator owns the book.** Not "license our platform" —
the operator holds the player ledger, the risk configuration, the settlement
rules and the data, and can read every line that moves money.

This document is the map from the current codebase to that. It is written
against the code as it stands, not an aspiration.

> **Note on reading this document.** Phases 1–4 and the bulk of section 6 are
> **history**, kept because the reasoning behind each control is the part worth
> keeping — several of these were "done" controls that existed only in their
> reporting, and the record of *how that was found* is more useful than the fact.
> Section 6's **Outstanding** subsection is the live list; everything else in
> section 6 is completed work.

## Contents

- [1. Where we actually are](#1-where-we-actually-are)
  - [What the checks cannot see, and the one that now covers it](#what-the-checks-cannot-see-and-the-one-that-now-covers-it--84)
  - [Do not re-add the `.env.example` key count to prose](#do-not-re-add-the-envexample-key-count-to-prose--103)
- [2. Corrections to the risk picture](#2-corrections-to-the-risk-picture)
- [3. Phase plan](#3-phase-plan)
  - [Phase 0 — Make it actually open source](#phase-0--make-it-actually-open-source)
  - [Phase 1 — Abuse controls](#phase-1--abuse-controls-shipped)
  - [Phase 2 — Market-maker risk](#phase-2--market-maker-risk-shipped)
  - [Phase 3 — Money](#phase-3--money-double-entry-ledger-and-real-payments-partially-shipped)
  - [Phase 4 — Tenancy](#phase-4--tenancy-shipped)
  - [Phase 5 — Feed, market lifecycle, scale](#phase-5--feed-market-lifecycle-scale)
  - [Phase 6 — Operator surface and the business](#phase-6--operator-surface-and-the-business)
- [4. Sequencing and dependencies](#4-sequencing-and-dependencies)
- [5. What would kill this](#5-what-would-kill-this)
- [6. Immediate next actions](#6-immediate-next-actions)
  - [Recently completed](#recently-completed)
  - [Completed since the first plan](#completed-since-the-first-plan)
  - [Outstanding](#outstanding)
  - [The verification gap — DISCHARGED](#the-verification-gap--discharged)

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
| Cash-out | `lib/cashout.js` | venue buyout at `Σ pᵢ·Payoutᵢ` less a margin; held when the venue cannot price it fairly; risk-bounded by `lib/cashoutrisk.js` |
| Tick ladder | `lib/odds.js` | Betfair increments, American/fractional/implied, overround |
| Odds feed client | `lib/feed.js` | board/nav contract from a Postgres recorder, staleness reporting |
| Test suite | `tests/` | 68 suites, hand-computed money rules, smoke + Playwright |

**The property worth protecting:** settlement solvency is structural, not
defensive. Every match is collateralised on both sides, so there is no
correlation exposure and no default risk on a matched position. That is the
single most important thing this codebase has, and every change below must
preserve it.

**What "operator owns the book" requires that does not exist:**

- ~~No tenant concept~~ ✅ `lib/tenants.js`, per-tenant commission in bps
- ~~Single-entry balances~~ ✅ `lib/accounts.js` — accounts + balanced postings;
  `users.balance_cents` is now a proven materialised cache
- ~~No player lifecycle~~ partially — `status` and self-exclusion ship; **KYC
  and deposit limits do not**
- ~~No abuse controls~~ ✅ `lib/limits.js`
- ~~No audit trail of operator actions~~ ✅ `lib/audit.js`
- ~~Market-maker loss unbounded~~ ✅ `lib/risk.js` — bounded and skewed before
  stop. Bounded, not profitable: `drift.js` is still a random walk
- ~~No tenant concept~~ ✅

**Still absent, and still blocking a licensed operation:**
- `POST /api/wallet/deposit` is still a faucet; the real-money path exists as
  an adapter seam with a reference provider, but no PSP is integrated
- No results feed — settlement is still an admin console action, with no
  per-sport void rules
- No reconciliation timer — the report exists, nothing schedules it
- No KYC, age verification, reality checks or session limits
- No backup/restore path, and no monitoring surface

### What the checks cannot see, and the one that now covers it — #84

`scripts/check-docs.mjs` is the unusual part of this repository, and its track
record is kept in **`STATE.md` §1** rather than duplicated here — a second copy of
a list of findings is itself a number that rots. Read it there.

The part worth carrying into this document is the *shape* of its limit. Every
assertion it makes asks *"does this claim match the code?"* A conflict marker is
not a wrong claim, it is the **absence** of a file's intended content:
`0597862` shipped `<<<<<<< HEAD` inside `docs/API.md`'s route table, every CI
run was green, and `3f9d648` (#82) is what added
`scripts/check-conflict-markers.mjs`. Nothing that reads a file and reasons about
what it says can see it, because it says nothing.

`scripts/check-release-facts.mjs` is a check about a fact that is **absent**
rather than a claim that is wrong — the same blind spot class, one step further
out. `CHANGELOG.md` documents `[0.1.0] - 2026-09-24` and `[0.2.0] - 2026-09-25`;
`git tag` returns nothing and `package.json` says `0.1.0`. No count, link or
contradiction check can see a release that was never tagged, because nothing in
the codebase contradicts a tag that does not exist. The check asserts that every
dated release heading has a git tag, and that `package.json` agrees with the
highest released heading.

**It is red on `main` today, and that is the check working.** Two dated releases
with no tag, and the manifest disagreeing with the changelog. Which of the three
sources is right is an author decision (#84), not a mechanical one, and the script
reports the disagreement without taking a side.

Its most important behaviour is the one that is *not* an assertion. It refuses to
run on a shallow checkout, because a depth-1 fetch carries no tags and "no tags"
cannot be told apart from "never tagged". A checker that produces a specific and
wrong accusation because of how the harness fetched the repository is worse than
no checker at all, so it reports that it cannot verify, and stops.

### DO NOT RE-ADD THE `.env.example` KEY COUNT TO PROSE — #103

Three documents gave three numbers for one fact: `README.md` said **61**,
`docs/ROADMAP.md` said **58**, and the derived surface is **61**. All three were
true when written, and all three rotted, which is the entire argument.

**The count now appears in no prose at all.** It is printed by
`npm run check:env-example`, derived from `lib/config.js` and `server.js`, and it
is written down nowhere a future contributor could copy it and let it drift. The
guarantee that actually matters — every key the code reads is documented, with
the value the code defaults to, and no phantoms — is asserted mechanically by a
check that fails the build, so it does not need a number beside it to be
believed. If you find yourself adding a key count to a document, do not: add the
key to `.env.example` and let the checker count it.

That decision was **not** applied to the unit test count, because
`check-docs.mjs` already derives that number by running `npm test` and comparing
it against every document that states it — one derivation, several correct
restatements. `STATE.md` was the exception: it is not in that check's document
list, deliberately, because §2.2 quotes the fabricated `[0.2.0]` changelog
verbatim and an unscoped count check would destroy that evidence. So `STATE.md`'s
own table row is asserted separately and **anchored on the row** rather than on a
pattern, and the row now says in the cell that it is a dated snapshot — because a
reader who lands on the number never sees the preamble that says so.

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

### Phase 1 — Abuse controls ✅ SHIPPED

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
concurrent placement. ✅ All satisfied — `tests/limits.test.js` (16 checks).

**Three decisions worth keeping:**
- A missing limits row means NO CAP; a stored `0` is a real zero. Reading "no
  row" as `0` would silently freeze every account on upgrade.
- A market scope overrides global **per axis**, so setting a market liability
  cap does not clear the user's global daily cap.
- `self_excluded` is a separate flag from `excluded_until`, because
  "permanently excluded" and "not excluded" must both be expressible. A
  nullable date alone is ambiguous between them, and resolving it wrongly
  reads a permanent exclusion as "never excluded" — the worst possible failure
  of a responsible-gambling control.

### Phase 2 — Market-maker risk ✅ SHIPPED

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

**The honest limit is unchanged.** Skew and caps are *damage limitation*, not
edge. `lib/drift.js` is still explicitly a random walk and the README says so.
Phase 2 makes the loss bounded; making it positive needs a real quote model from
external books, which is Phase 5 feed work — not this phase.

**Done when:** a bot cannot exceed its daily loss cap, the desk shows the
exposure, and the kill switch is tested. ✅ `tests/risk.test.js` (17 checks).

**Correction worth recording.** The first implementation measured liability as
the bot's *negative balance*, and a test caught it: that is already bounded by
the escrow invariant, so it mostly re-measured a guarantee the engine already
provides while leaving the uncovered number uncapped. A lay at `P` for `s`
escrows `(P-1)*s` but pays `s*P` if it loses — **that gap is the venue's real
exposure**, and it is what is now capped, counted over open markets only so it
cannot ratchet upward with every settlement.

### Phase 3 — Money: double-entry ledger and real payments ✅ PARTIALLY SHIPPED

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
equals the sum of that user's `player_funds` postings. ✅ Implemented in
`lib/accounts.js`; `tests/ledger2.test.js` (15 checks) asserts conservation,
segregation, revenue-is-a-query, and cache-equals-postings per user.

**Escrow is a real per-user `player_escrow` account**, not a memo column. It is
an intra-player split, which is awkward in a naive model; as a genuine
liability account the rule stays exception-free — if it moves money it posts.
`direction` carries the sign so `amount_cents` is always a positive magnitude.

**Two arithmetic bugs the cache test caught immediately**, both in `settleUser`:
commission was posted house→operator_commission when the PLAYER pays it, and
the P&L leg credited `balanceDelta - frozenRelease` when the collateral had
already returned via the release leg. Both are the kind of off-by-a-fee error
that a total-only conservation check cannot see.

**The migration is additive and deliberately so.** `balance_cents` /
`frozen_cents` are still written exactly as before and are now a materialised
cache; `assertUserAgrees` proves cache == postings for every user. Flipping
authority the other way is a later, separate step.

**Payments:** ✅ Interface plus a complete reference provider shipped in
`lib/payments/`; **no PSP chosen, deliberately** — every jurisdiction differs,
gambling is restricted almost everywhere, and the operator already holds a PSP
contract that has been through legal review. The concrete integration is the
one piece left. Deposit intent →
provider adapter → credit on confirmation (never on initiation). Withdrawals
with a hold, a cooling-off period and a reconciliation step. **No provider is
built in** — the adapter interface plus one reference integration is the
deliverable, because every jurisdiction has a different requirement and the
operator already has a contract with a PSP.

**Why double-entry is not optional:** it is the difference between "we log
money movements" and "we can prove to an auditor that players' funds are
segregated and intact." For the positioning in §0, this is the whole argument.

**Done when:** every cent moves as balanced postings, conservation is asserted
in tests, and segregation is a query rather than a promise. ✅ First two;
✅ third (`lib/accounts.js segregation()`, `/api/admin/ledger`). Outstanding:
one real PSP adapter, and a scheduled reconciliation JOB (the report exists;
nothing invokes it on a timer yet).

**Credit on confirmation, never on initiation** — opening ten deposit intents
and abandoning them funds you zero times, and confirmation is idempotent by
intent id so a retried webhook cannot double-credit. An incomplete provider is
refused **at boot**, and `REAL_PAYMENTS` hard-refuses the reference provider: a
mock that instantly confirms must never sit behind a live payment button.

### Phase 4 — Tenancy ✅ SHIPPED

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
allowlists, and no query can cross them. ✅ `tests/tenants.test.js` (19 checks).

**The default tenant is resolved by SLUG, never a hard-coded id.** An earlier
draft pinned `DEFAULT_TENANT_ID = 1`, and a test caught it: the moment an
operator creates a tenant before the default is materialised, that tenant
takes id 1 and every later "is this the default?" question silently answers
about the wrong row.

**Jurisdiction is enforced at SESSION CREATION, not at bet placement.** Checked
at placement, a blocked player registers, deposits and places bets and is
refused only on trying to win — at which point they hold a live position the
venue is not permitted to honour, and unwinding it means choosing a side.

**The country is NOT client-claimed.** `createSession` originally accepted a
`country` that nothing ever supplied, so gating could only fail closed and lock
out every login — inert-but-configured being the worst failure mode, because
the tenant believes the control is running. Reading it from a request header
would be a hole rather than a control. `TRUST_PROXY_JURISDICTION` (default
**false**) is the operator asserting every request passed an edge that
overwrites the header; with it off the header is ignored entirely, and with an
allowlist set but no trusted source, gating fails closed.

**Admin scope is structural.** `listUsers` has no argument value meaning "every
tenant" — an optional scope is one someone eventually forgets to pass, and a
forgotten scope on an admin route is a cross-tenant read.

### Phase 5 — Feed, market lifecycle, scale

**Results feed.** `settleMarket` is already a single idempotent entry point, so
this is a consumer, not a rewrite. Requirements beyond calling it:
- Per-sport void rules. A red card at 70 minutes, a rained-off race, a walkover.
  A results feed that does not model voids will settle incorrectly and the
  operator will pay for it.
- Disputed outcomes, held rather than settled, with a manual release path.
- The feed's own audit: every outcome settled is traceable to a source event.

**In-play. ❌ WITHDRAWN — the venue is PRE-OFF ONLY.** The product decision is
that bets may only be placed before an event's off time, and cash-out is closed
at off with it. In-play without honest delay modelling is where a venue loses
money to sharps; removing in-play removes that whole class of sharp rather than
managing it. `lib/inplay.js` and `orders.eligible_at` stay in the tree — they
are tested, and `eligible_at` is the only mechanism that could carry the gate if
in-play is ever revisited — but they no longer have a caller driving an in-play
suspension, and `lib/offtime.js` is now the control that closes markets.

**The off-time gate — `lib/offtime.js` ✅.** Nothing tied tradability to
`events.starts_at` before this: the in-play gate checked *suspension*, and with
the feed off nothing suspended a market at kick-off. A control with no driver —
the dead-control shape this repo keeps finding. The gate:
- closes order placement AND cash-out at `events.starts_at`, in the engine
  (not the routes), so a future caller cannot walk out with venue money;
- refuses *before* any collateral is frozen;
- treats an unparseable off time as CLOSED, because a bad catalogue row must
  never silently re-open in-play trading;
- resolves every admin-accepted datetime form to UTC, so the off time does not
  move when the server's timezone does.

**Cash-out at off is part of the gate, not an afterthought.** Banning in-play
betting while leaving cash-out open would have kept in-play *risk*: the venue
still owes money on a position whose price just moved on a goal.

**Feed resilience.** ✅ Investigated, and the answer is that the risk is not
real *as the system stands*. `FEED_STALE_SECONDS` reports staleness and does not
reconcile, which reads like a money-path gap: a venue must not trade against a
book that has stopped moving. I built the control — a pass that suspends markets
whose prices have gone stale — and then checked the premise before shipping it,
which said no.

**Feed markets are DISPLAY ONLY, end to end:**

1. A feed market has no local row. The recorder's catalogue lives in its own
   Postgres database; the venue's tradeable markets are rows in this one.
2. The engine refuses an order naming a feed selection id — 404, because that
   selection does not exist here — and refuses *before* taking any collateral.
3. The client refuses too, and says "Feed markets are display-only".

So no money can be at stake in a stale feed price, and a guard built on that fear
would protect nothing while introducing a real hazard: it would take FEED market
ids and try to suspend LOCAL venue markets, closing the venue's real book
because an unrelated market's prices were old. I deleted it.
`tests/feed-display-only.test.js` pins the three facts so the reasoning survives
whoever comes next, and F4 also asserts the hoist in `server.js` still suppresses
the bots and drift when the feed is on — the one part here that IS load-bearing.

**What this actually leaves open** is a product decision rather than a control:
with `FEED_ENABLED=true` the venue has no price source of its own, because the
bots and drift are force-disabled so they cannot requote over the observed book.
Feed mode is an observation tool attached to an engine, not a merged product,
and in that mode the venue's own markets are unquoted. That is coherent — but it
was written down nowhere, and "odds feed integration" does not describe it.
Making feed markets tradeable needs a market mapping and a liquidity source, and
that is a feature with a cost, not a control.

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

**Reporting.** ✅ `lib/reports.js`, `/api/admin/reports/*`. Regulatory (per-market
and per-selection volume, per-player statements, commission by tenant), financial
(summary with GGR, hold and margin), operational (match rate, unmatched ratio,
realised bet delay, resting orders). CSV by default, `?format=json` for the same
figures with their definitions. Operators buy reporting because it is the
alternative to writing it themselves.

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

Reassessed after Phases 1–4, the follow-on work, and the first outside
review of the money path. The suite is now **885 checks across 68 suites**,
plus a live smoke script and a 217-check browser suite, all green.
### Recently completed

The two fix batches driven by the outside review, which closed 23 filed issues
across the engine, the feed stack and the collector. Recorded here because the
**pattern** is the durable part, not any individual fix:

- **Dead controls that reported success while doing nothing.** `pendingMarkets()`
  had an unsatisfiable predicate — it required a market `open` on an event
  `completed`, and the only writer of `completed` fires once every market is
  already settled — so the automated results poll asked about an empty set
  forever, advanced `last_ok_at`, and reported `ok`. The feed-1 board SQL had a
  dangling comma before `FROM`, a hard Postgres syntax error, so an entire
  supported configuration could not load a board. `maybeForceSetup` was called on
  every login and defined nowhere.
- **A function that could never return true.** `isClientOrderIdConflict` tested
  for an index name that SQLite does not put in a UNIQUE violation message, so
  the idempotency race-recovery catch was unreachable — idempotency held
  single-threaded and failed in exactly the concurrent case its comment claimed
  to cover.
- **A control that failed open.** Self-exclusion validated `until` with
  `Date.parse` (which accepts `"15 Jan 2030"`), stored it mangled, then compared
  **lexicographically** against `'YYYY-MM-DD HH:MM:SS'` — so a plausible date
  string sorted before the current timestamp and the exclusion read as lapsed the
  instant it was made. It now fails closed on any value it cannot parse.
- **Tests that could not fail.** Several, in this repo's own suite, not just in
  the code: a rollback test that asserted "no half-written state" against an
  empty table; a test *named* "counts NET settlement, not gross" whose every row
  had `commission_cents = 0`; an async suite that never awaited, so failures
  printed `ok` and the rejection crashed the process afterwards; a UI smoke test
  whose wait was vacuously true and which listened for no page errors.

### Completed since the first plan

The items below are **done**. They are kept here rather than deleted because
each records a control that existed only in its reporting before it was made
real, and the record of how that was found is the useful part.

- Order idempotency (`client_order_id`) — the smallest high-value item, now
  the largest single behavioural change in the engine and the one whose
  migration bug would have been invisible in CI.
- Multi-runner cash-out — reimplemented as a **venue buyout**. The v1
  market-hedge model was not merely incomplete, it was *provably
  value-destroying*: hedging N runners against a fair book gives
  `net = k(1 − 2Σ1/q) + 2Σ Payout_i/q`, whose best legal value is negative.
  The `v1 scope` guard was a correct refusal. Derivation in `lib/cashout.js`.
- Results feed with per-sport void rules, disputes **held** rather than
  guessed, provenance for every outcome, and a manual release path.
- Scheduled reconciliation with findings that persist and re-surface until a
  human closes them with a written reason.
- The `orders.frozen_cents` convention is now enforced mechanically by
  `tests/guard.test.js`, verified by deliberately introducing a violating
  `UPDATE`.
- Collector supervision is now a managed lifecycle: `alive()` rather than "a
  child handle exists", a real restart rather than two sequential calls, and a
  `SIGTERM`/`SIGINT` drain so a restart cannot orphan a collector still spending
  Betfair market-data weight. Feed credentials are scoped to the actor inside
  `lib/feedcreds.js` and bound to tenant and field as GCM additional
  authenticated data, so a row moved in the database fails to decrypt rather than
  becoming another tenant's credential.

### Outstanding

1. **One real PSP adapter.** The interface and reference provider ship; the
   concrete integration does not. This is the only item on this list that blocks
   the operator thesis.
2. **KYC and age verification.** Deliberately absent: an identity control with
   an external verification provider, not a limit. `lib/tenants.js` carries
   jurisdiction data, but nothing verifies anybody against it.
3. **Complete `.env.example`.** DONE — every key the server reads is documented
   with the value `lib/config.js` actually defaults to, and
   `scripts/check-env-example.mjs` (run in CI) fails if one goes missing, if a
   default value drifts, or if the file documents a key nothing reads.
   *Deliberately no count is written here — see §1.*
4. **The escrow top-up path in `lib/match.js`.** A 1-cent rounding top-up when a
   resting layer has no available balance can abort the taker's entire
   placement, including a stranger's, and reports the taker as insufficient.
   The divergence is common rather than rare (353,793 reachable cases in a
   bounded sweep), and the fix needs a behavioural decision: skip that layer
   mid-sweep, or fail the fill. Not attempted, deliberately.
5. **Every open issue in the tracker.** 51 remain, most of them documented
   defects rather than missing features.

### Detailed record of the completed items

1. ~~Cash-out is an uncapped venue risk.~~ ✅ Fixed — `lib/cashoutrisk.js`,
   then **rewritten** after the outside review found the first version was a
   dead control: it tracked quotes, but quotes are atomic with their
   execution here, so nothing ever wrote the rows it read and exposure was
   zero forever. It now records EXECUTED BUYOUTS inside the paying
   transaction, bounds outstanding fair-value exposure and daily payout
   outlay (venue-wide and per-user), and resolves each buyout at settlement so
   the realised loss is paid-minus-what-the-position-actually-returned.
2. ~~In-play / bet delay modelling.~~ ✅ `lib/inplay.js` + `orders.eligible_at`
   — market suspension (enforced in `placeOrderTx`), kick-off suspension that
   releases into the delay, windowed traded volume per market and per
   selection, and the bet delay **enforced by the engine**: an order's
   `eligible_at` gates both sides of the match, and a scheduled release pass
   (`releaseEligibleOrders`) puts a delayed order into the book when the delay
   expires, as a maker at its OWN price.

   This was the **fourth control that existed only in its reporting**. For
   months the API told the client "your order becomes matchable at
   02:05:59" and the engine matched it on arrival, every time — proven, not
   theorised:
   `delay reported to the client: 60000ms | bob matched on arrival: true`.
   A reported-but-unenforced delay is worse than no delay: the player believes
   they are protected, and the venue is systematically slower than its own
   liquidity — the exact condition in-play delay exists to prevent.
   Regression-tested both directions in `tests/inplay2.test.js` (12 checks).
3. **One real PSP adapter.** The interface and reference provider ship; the
   concrete integration does not. The only item here that blocks the operator
   thesis — see [Outstanding](#outstanding).
4. ~~Trading-side split of the results feed.~~ ✅ `lib/resultsfeed.js` — the
   consumer in `lib/results.js` existed the whole time and had NO transport, and
   the scheduled poll had never been wired at all, so
   `RESULTS_POLL_INTERVAL_MS` was a documented knob that no job read: outcomes
   arrived only when an operator pushed them by hand. The transport POSTs the
   pending set (the SAME query the consumer uses, so the two cannot drift) to
   `RESULTS_FEED_URL`, with a bearer secret, a hard timeout, and a byte cap so a
   provider cannot OOM the venue to deliver bad news. Every failure mode records
   a reason and returns nothing rather than throwing into the job runner.

   The design decisions that make it a control rather than a hope:
   - **The feed is a signal, not an authority.** It never decides an outcome. A
     feed naming a winner outside the market, or a disputed result, is HELD —
     the strictness already in `lib/results.js` and the reason a machine cannot
     shortcut a human decision.
   - **Every failure is soft and recorded, and three states are
     distinguishable**: `not_configured`, `failing`, `stale`. A feed that
     silently stopped is otherwise indistinguishable from a feed with nothing
     to say, and the difference is players' money sitting unsettled.
   - **Staleness never blocks trading and never gates readiness.** A dead feed
     means late outcomes and a human, not a wrong book; pulling a healthy venue
     out of rotation over a provider outage would manufacture the outage it was
     meant to prevent.
   - **A poll with nothing pending is a SUCCESS.** Otherwise a quiet venue
     reports a broken feed all night and the real outage is the one nobody reads.

   ── THE BUG THIS FOUND, AND IT IS THE FIFTH DEAD CONTROL ─────────────────
   `pollOnce` called `fetchResults(db)` WITHOUT AWAITING IT. It was synchronous
   and written for the one transport that existed — a synchronous local read —
   so for every async transport `outcomes` was a Promise, `outcomes[id]` was
   undefined for every market, and the cycle reported `applied: 0` having
   applied nothing. Wiring the HTTP feed would have produced a scheduled job, a
   green health endpoint and a venue that settled nothing at all.

   It survived a green suite for the same reason the other four did: the
   injected double returned a plain object, which is the single shape that hides
   it. `pollOnce` is async now, and T16 asserts the SHAPE — a promise-returning
   fetcher must be applied, not read as an object.
5. ~~Dead-heat / joint-favourite settlement.~~ ✅ The engine now settles a
   winner SET. What divides is the PAYOUT (the liability shared n ways) and
   each side still returns its own collateral in full, so nobody's escrow is
   stranded; the share is FLOORED so splitting a win into many small matches
   cannot harvest the rounding — the same arbitrage the audit found in
   commission. `voidrules` settles a named dead heat and still HOLDS one that
   names fewer than two joint winners.
6. ~~Responsible gambling surface.~~ ✅ `lib/rg.js` — self-exclusion (Phase 1),
   session limit, reality check and rolling 24-hour deposit limit. All three
   new controls are asserted by the ENGINE, inside the one function every
   betting path already calls, because a session limit enforced in the UI is a
   suggestion. Age verification is deliberately absent: it is an identity/KYC
   control with an external verification provider, not a limit, and it was
   deferred deliberately.

   Three details that decide whether such a control is real:
   - **Signing in again does not restart the session clock.** A session limit
     defeated by refreshing the page is not a limit; only signing OUT ends a
     session.
   - **The reality check is decided by the engine**, and only the
     acknowledgement clears it — a check the player can skip by not clicking
     the dialog is not a check.
   - **The deposit limit is a ROLLING window and covers BOTH deposit paths.**
     A calendar-day limit is trivially gamed at 23:59 and 00:01, and a limit
     guarding only the faucet is defeated by paying through the card instead.

   All three default to 0 — *not configured*, not "unlimited but enforced",
   because no session limit is correct for every operator. The server says so
   at boot rather than letting an unguarded demo reach production quietly.

   Found while building it: the reality clock was originally stamped by the
   SESSION LIMIT's row creation, so configuring a reality check without a
   session limit left the check permanently not-due — a control that appears in
   the config and does nothing, which is the precise failure this module exists
   to prevent.
7. **Reporting and exports.** ✅ `lib/reports.js` — see Phase 6. Two things it
   does that a naive report does not, both learned by getting them wrong first:

   - **It states its definitions and checks itself against the ledger.** Every
     figure ships with the formula that produced it, because GGR is not one
     thing: on an exchange the venue earns commission and carries its own
     trading risk, and those are different lines for different regulators. The
     self-check is `SUM(pnl_cents) = 0` — settlements are zero-sum BETWEEN
     PLAYERS, with commission charged on top of that pool. The first version
     asserted `SUM(pnl) + SUM(commission) = 0`, which is wrong by exactly the
     venue's fee, and it reported a 750-cent FAILURE on a perfectly correct
     book. An invariant written from reasoning rather than from the ledger
     produces confident nonsense, and an operator would have filed it as a real
     discrepancy against themselves.

   - **CSV export is a security control, not formatting.** A cell beginning
     `=`, `+`, `-` or `@` is a FORMULA in a spreadsheet, and a free-text event or
     market name carrying `=cmd|'/c calc'!A0` executes on the operator's machine
     when they open the export. Usernames cannot carry it (auth.js restricts the
     charset), which is why the guard lives at the export boundary rather than
     in each field: a boundary guard survives the next field that forgets.
     Testing position 0 alone left a hole — `' =1+1'` has a leading space, and a
     spreadsheet trims it and then evaluates the `=`. Found by the test that was
     written to check the guard.

8. **The rule table and the seed must agree.** Found while building dead-heat
   settlement, and it was silently VOIDING MONEY: the seed creates
   `greyhounds` while the table was keyed `greyhound`, and `basketball` was
   seeded with no rule set at all. Both fell through the unknown-sport default
   to VOID, so a finished greyhound race and a finished NBA game paid NOBODY —
   winners got nothing, layers kept the pot, and the books still balanced
   perfectly, because conservation cannot tell you a settled market paid the
   wrong person. `tests/rules-consistency.test.js` now makes the table/seed
   agreement an invariant rather than a convention.
### The verification gap — DISCHARGED

An outside review of the money path ran (a fresh reviewer with no prior
exposure, reading every money-path module and running exploit scripts against
the real modules). It found **ten findings**, of which three were serious
enough to have been blockers for real money — and every one was found by
someone who had not written the code:

1. **CRITICAL — a player could mint unlimited money.** The deposit-intent
   confirm route was player-callable: it checked only that the intent was
   pending, never that money had arrived or who was calling, and credited
   with the faucet cap bypassed. Fixed: the route is gone; confirmation is
   provider-webhook-only (HMAC over the raw body, constant-time) or admin;
   per-intent and per-user-daily caps bound even a compromised webhook.
2. **HIGH — the cash-out risk caps were dead controls.** The module tracked
   quotes, but quotes are atomic with their execution here, so nothing ever
   wrote the rows it read: exposure was zero forever while the roadmap
   claimed a defence. Fixed: executed BUYOUTS are recorded inside the paying
   transaction, resolved at settlement; the realised-loss metric is
   paid-minus-what-the-position-returned, not the margin.
3. **HIGH — cashoutPosition defended nothing.** No market-state check, so a
   direct call paid out against a settled market and stranded another
   market's escrow, bricking its settlement. Fixed: the primitive checks
   market status and hold itself, so no second caller can inherit an
   unguarded money path.

Plus: settlement_hold now enforced in the settlement primitive (the plain
admin settle route could bypass the reasoned release); the withdrawal
lifecycle completed (complete + fail-with-refund routes, previously a dead
end that stranded money in gateway_clearing); per-tenant commission actually
charged at settlement (stored, audited, displayed — and previously ignored);
commission rounding made house-favourable (ceil; round let a splitter shave
the fee); `BEGIN IMMEDIATE` for multi-process accidents; the house may settle
negative per its own schema (previously a bricked market, no repair path);
and `guard.test.js` now mechanically enforces that only `ledger.js` writes
the wallet columns.

**The second outside pass found a fourth blocker the first missed**: a
one-token bug in the lay-side cash-out replacement paired the house with the
player's own dead order and DROPPED THE COUNTERPARTY — stranding their escrow
and bricking settlement of the whole market. Every existing test cashed out a
BACK position, which masked the broken branch. Now regression-tested both
sides (cashout2 C8/C13).

The lesson the project takes from this: **an author cannot review their own
money path.** The self-authored suite grew from 340 to 584 checks and every
one of the ten findings was reproducible as a test — but none of them was
FOUND by the suite, because the suite tested what the author intended, and
the code did something else. A second outside reading before real money
remains worthwhile; the first one paid for itself twice.
