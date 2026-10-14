# Exchange rules

The behavioural specification: who can bet, at what price, who wins, who pays
what. Every number here is asserted by a test; the test file is named next to
each rule so you can check the arithmetic yourself.

- [Vocabulary](#vocabulary)
- [Prices and the tick ladder](#prices-and-the-tick-ladder)
- [Placing an order](#placing-an-order)
- [Matching](#matching)
- [Escrow](#escrow)
- [Settlement](#settlement)
- [Commission](#commission)
- [Voiding](#voiding)
- [Cash-out](#cash-out)
- [Markets, events and lifecycle](#markets-events-and-lifecycle)
- [Limits and configuration](#limits-and-configuration)
- [What is deliberately not implemented](#what-is-deliberately-not-implemented)

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Back** | Betting that a runner **wins**. Risk = the stake. Win = `stake × (price − 1)`. |
| **Lay** | Betting that a runner **loses**. You accept someone else's stake. Risk = `(price − 1) × stake`; win = the stake. |
| **Stake** | Always expressed in **backer-stake units**: the amount a backer would put in, whatever side you are on. A lay of 100 @ 2.50 accepts 100 of backer stake and risks 150. |
| **Price** | Decimal odds, on the ladder, two decimal places. |
| **Runner / selection** | One outcome inside a market (a team, a player, a trap). |
| **Market** | A set of runners on one event, exactly one of which wins. |
| **LTP** | Last traded price. Only real trades move it — never the bots' quotes or the drift. |
| **Matched** | Executed. **Unmatched** remainder stays on the book as a limit order. |

## Prices and the tick ladder

Prices are decimal odds and must sit on the Betfair ladder:

| Range | Step | | Range | Step |
| --- | --- | --- | --- | --- |
| 1.01 – 2.00 | 0.01 | | 10.5 – 20 | 0.5 |
| 2.02 – 3.00 | 0.02 | | 21 – 30 | 1 |
| 3.05 – 4.00 | 0.05 | | 32 – 50 | 2 |
| 4.10 – 6.00 | 0.10 | | 55 – 100 | 5 |
| 6.20 – 10.0 | 0.20 | | 110 – 1000 | 10 |

The gaps between bands are real: 2.01, 10.2 and 100.5 are **not** prices, and
`lib/odds.js` snaps anything else to the nearest valid tick (ties round up inside
a band, and to the lower band edge in a gap). `valid = snapToTick(p) === p`.

The server is the authority. It re-snaps every price it accepts, so a
hand-typed price is never rejected for being off-ladder — it is corrected.
`GET /api/format/:price` returns the same ladder's value in decimal, American,
fractional and implied-probability form; the admin desk uses it so a trader never
sees a conversion the engine would not agree with. It is the one place that
refuses rather than corrects: a price **outside** `[1.01, 1000]` is not a
hand-typed near-miss, it is not a price at all, so it answers `400` instead of
returning the clamped bound as though it had been asked about.

*Tests:* `tests/odds.test.js` (T1–T10), `tests/seed.test.js` (S3).

## Placing an order

1. A session is required; `selection_id` must be an integer; the selection and
   its market must be `open`, the event must not be `completed`.
2. Stake must be an **integer number of cents** within
   `[MIN_STAKE_CENTS, MAX_STAKE_CENTS]`. Strings and floats are rejected at the
   boundary (`Number("100")` and `Number(true)` are not stakes).
3. The price is snapped to the ladder and must land in `[1.01, 1000]`.
4. The required escrow must be available (see below). If it is not, **nothing is
   written** — no order, no match, no ledger row.
5. The order is inserted first, then matched, then any remainder rests.

An order is a **limit order**: it takes liquidity immediately at the resting
prices, and the rest sits on the book until cancelled or settled. It is never
filled at your limit price if better resting liquidity exists.

*Tests:* `tests/match.test.js` (E9 validation, E24 off-ladder snap,
E25 stake bounds, E26 selection id + suspension), `tests/tx.test.js` (X6
all-or-nothing).

## Matching

For a taker and a resting order to trade, the resting order's price must satisfy
the taker's limit — and the trade happens **at the resting price**, never at the
taker's price or some midpoint.

| Taker | Eligible resting orders | Swept in this order | Filled at |
| --- | --- | --- | --- |
| **Back @ P** | lays with `Q ≥ P` | **highest Q first** (best price for the backer) | the resting `Q` |
| **Lay @ Q** | backs with `P ≤ Q` | **lowest P first** (least liability for the layer) | the resting `P` |

- **Price-time priority**: within one price level, the order that rested longer
  fills first (`ORDER BY price, id`).
- **Partial fills** are the norm. Remainder keeps resting.
- **Self-match guard**: a user's own resting orders are skipped, so you cannot
  lay yourself. This also means your own displayed liquidity is not executable
  against you — which is why cash-out quotes ignore it.
- The book is kept consistent by construction: a resting back and a resting lay
  can never price-cross, because whichever arrived second would have matched.

*Tests:* `tests/match.test.js` — E1 (resting price stands), E2 (partial fill),
E4 (back sweep highest-first), E5 (lay sweep lowest-first), E13 (FIFO within a
level), E6 (self-match guard), E11 (aggregation and ordering), E19 (self-match
guard, back-taker side), E20 (lay-taker FIFO).

## Escrow

Funds move in two directions, and escrow is what stops either side spending money
twice. Each order row tracks its own escrow in `orders.frozen_cents`: the escrow
held against the order's **unmatched remainder** — exactly what a cancel (or
settlement's auto-cancel) releases. The **matched** part's liability stays
frozen in the wallet on top of that column until settlement releases it.

| Event | Backer | Layer |
| --- | --- | --- |
| Place a back | freeze `stake` | — |
| Place a lay @ Q | — | freeze `round((Q − 1) × stake)` |
| A lay fills `f` at match price `P` (own price `Q`) | — | keep `round((P−1)·f)` + `round((Q−1)·remainder)` frozen; release the difference, or top up the rare 1¢ |
| Cancel the remainder | release `orders.frozen_cents` | release `orders.frozen_cents` |
| Settle | consume `stake` | consume `round((P−1)·stake)` |

Why a fill re-derives no formula: placement, matching and settlement each round
a liability **once** (house rule), and three independently rounded formulas do
not compose — `round((Q−1)·S) − round((Q−P)·f)` lands one cent above or below
`round((P−1)·f)` for perfectly reachable stakes. The old release rule
`(Q−P)×fill` could therefore leave the wallet one cent short of what
settlement had to release (a permanent "Settlement integrity error") or one
cent over (stranded forever). Instead, each lay fill makes the layer's wallet
hold **exactly** this fill's settlement liability plus the still-unmatched
remainder's placement liability:

```
delta = frozen_cents − ( round((P−1)·f) + round((Q−1)·remainder) )
delta > 0 → release(delta)          delta < 0 → escrow(−delta)   // a 1¢ top-up
```

The invariant — **the wallet always holds each order's matched liability plus
its tracked remainder escrow** — is the contract: settlement can never release
more than is frozen, no cent is ever stranded, and after a settle or a void
every participant's `frozen_cents` returns to exactly `0`.

Worked examples (all asserted by tests):

- Lay 150 @ 1.04, fully matched at 1.03. Placement freezes
  `round(0.04 × 150) = 6`. The fill's settlement liability is
  `round(0.03 × 150) = round(4.5) = 5`, remainder 0 — so the fill releases
  `6 − 5 = 1` and keeps 5 frozen. Settlement later releases exactly 5. (The
  old `(Q−P)×fill` rule would have released `round(1.5) = 2` and left the
  market permanently unsettleable.)
- Lay 100 @ 1.51, filled 50 @ 1.01 then 50 @ 1.51. Placement freezes 51.
  First fill: keep `round(0.01 × 50) = 1` + remainder escrow
  `round(0.51 × 50) = round(25.5) = 26` → release `51 − 27 = 24`. Second
  fill: keep `26`, remainder 0 → nothing to move. Frozen 27 = 1 + 26 =
  exactly what settlement releases.
- When a single fill's target exceeds what the one placement rounding froze
  (lay 100 @ 1.51, a 50-fill at its own price: `26 + 26 > 51`), the engine
  tops the escrow up by that cent **at fill time** rather than ever letting
  the wallet fall short of settlement.

`available = balance − frozen`. A user can never place an order their available
balance cannot cover, and `frozen_cents` can never go negative (guarded in
`lib/ledger.js` and again by a database `CHECK`).

*Tests:* `tests/ledger.test.js` (L2–L3), `tests/match.test.js` (E3, E5, E7, E8,
E12, E14–E23), `tests/settle.test.js` (S12–S16, S19, and the S20 tick × stake
property sweep asserting frozen ≥ Σ settlement releases and frozen → 0 after
settle/void), `tests/store.test.js` (D3, D7 migration).

## Settlement

A market is settled exactly once, by an admin, with either a **winning runner**
or `void: true`. The input is validated strictly — `void: "false"` is not a
boolean, `true` is not a selection id, and both at once is contradictory.

For a match of stake `s` at price `Q`, the pot is `s + (Q−1)·s = s·Q`:

| Outcome | Backer | Layer |
| --- | --- | --- |
| Backer's runner won | unfreeze `s`, gain `(Q−1)·s` | lose `(Q−1)·s` |
| Layer's runner won | lose `s` | unfreeze `(Q−1)·s`, gain `s` |
| Void | refunded `s` | refunded `(Q−1)·s` |

Then, per user per market:

- `net = Σ wins − Σ losses`
- `commission = round(net × COMMISSION_RATE)` **only when `net > 0`**
- balance moves by `net − commission`; escrow for the market is released

Before that, every **unmatched** order in the market is auto-cancelled and its
remainder escrow released, and the event becomes `completed` when all of its
markets are settled. A settled market is frozen: it rejects new orders and
cannot be settled again.

**Conservation**: the sum of every balance change in a settlement equals
`−(total commission)`. There is no other source or sink — the exchange takes the
commission and nothing else. This is asserted end-to-end in `tests/smoke.sh`
(`100000 − 375 = 99625` across two players).

*Tests:* `tests/settle.test.js` (S1–S20), `tests/smoke.sh` (conservation),
`tests/api.test.js` (settled market frozen).

### Dead heats and joint favourites

Where a sport's rules permit a joint favourite — horse racing, for example — a
dead heat **settles**: the payout is divided among the joint winners at
`floor(liability / n)`, and each side returns its own collateral in full.

The division is on the **payout**, not the stake. Dividing the stake was tried
and rejected — it strands escrow, because the two joint winners' stakes are not
equal in general.

Two rules matter more than the arithmetic:

- **The rules table decides, not the signal.** A multi-winner outcome is only
  *evidence* that something happened. Whether a sport pays a joint favourite is
  the per-sport rule. A two-winner signal on football — a sport with no dead
  heats — is **held for review**, because paying a joint favourite there would
  halve every backer's payout with no human in the loop.
- **A dead heat naming only one winner is not a dead heat**, and is held.

The human release path can express a dead heat too. A market held because a dead
heat was *disputed* is exactly the case a hold exists for, and releasing it as a
single runner — the only option the release route used to offer — paid one
person a whole stake and charged another's backer his entire stake on a horse
that tied.

*Tests:* `tests/results.test.js` (R7, R7a, R7b, R7c), `tests/settle.test.js`.

## Commission

A single rate (`COMMISSION_RATE`, default 2.5%) charged on **net winnings per
user per market**, at settlement — not per bet, not on stake, and not on gross
turnover. Winning one market and losing another in the same session nets out
before the fee is taken.

The one rounding point per fee is `Math.round(net × rate)`. Commission on the
net (rather than per match) is deliberate: for 5050 + 5050 of winnings the fee is
`round(10100 × 0.025) = 253`, not `126 + 126 = 252`.

*Tests:* `tests/settle.test.js` (S7).

## Voiding

`void: true` means the event did not produce a result (cancelled, postponed,
abandoned). Every matched stake returns to the person who committed it — a
backer gets their stake, a layer gets their liability — and nobody pays
commission. Voiding is visible in the wallet as a `refund` transaction and in
history as a settlement with zero P&L.

A void refunds the liability **at the match price**, which is what the escrow
actually froze. A layer who offered 10000 @ 2.10 and matched at 2.00 is
refunded 10000, not 11000, because the extra 1000 was already released when
the better fill happened.

*Tests:* `tests/settle.test.js` (S4, S10).

## Cash-out

Cash-out closes a matched position early. It is a **venue buyout**, not a trade
against the book, and the distinction is not cosmetic — it is the difference
between a feature that works and one that quietly destroys value.

### Why the market hedge was removed

The obvious implementation is to hedge the position against the book: place the
opposite side at top of book and the position goes flat. That works for a single
runner, where there is exactly one outcome to neutralise.

It **cannot** work for multiple runners, and the derivation is worth stating
because "generalise the hedge" is the obvious next step and it is a dead end.
Forcing every outcome to the same value `V`, with hedge stakes `S_i` at each
runner's own top-of-back price `q_i`:

```
S_i    = (k − Payout_i) / q_i          with  k = V + Σ S_i
V      = k(1 − Σ1/q_i) + Σ Payout_i/q_i
net    = V − Σ S_i = k(1 − 2Σ1/q_i) + 2Σ Payout_i/q_i
```

The coefficient of `k` is `1 − 2Σ1/q_i`.

- For a two-runner market quoted at 2.0 both sides, `Σ1/q = 1` and the
  coefficient is **zero** — every `k` yields the same net.
- For any real price dispersion the coefficient is **negative**, so the best
  legal `k` is the smallest one and `net` comes out **negative**.

Hedging a multi-runner position against a fair book therefore always costs the
player money. The apparent arbitrage is the book being fair. The old `v1 scope`
guard — which refused mixed and multi-runner positions — was a **correct
refusal**, not unfinished work.

### What the venue quotes instead

The operator prices the position from its own fair probabilities and buys it:

```
fair_value = Σ_i  p_i · Payout_i
quoted     = floor(fair_value · (1 − CASHOUT_MARGIN_BPS / 10000))
```

`Payout_i` is the player's net if runner `i` wins: a back profits
`(P−1)·s` on its own runner and loses its stake otherwise; a lay is the mirror.
This mirrors `lib/settle.js` exactly — a one-cent disagreement would mean the
quote differs from the settlement the player was avoiding.

`p_i` is **normalised by the sum of implied probabilities**, so a book summing
to 105% does not hand the player the overround. A valuation generalises to any
number of runners immediately, because it is a valuation and not a hedge
construction. The venue's edge is the margin and superior pricing — not an
impossible arbitrage.

### When no quote is offered

Cash-out returns **no quote** rather than a bad number when:

- the market is settled, or the player holds no position;
- a matched runner has **no fair price** — the valuation would ignore a real
  outcome, and a payout that ignores an outcome can be wrong;
- the position is **underwater** relative to the book (`fair_value ≤ 0`).
  Paying a player to take on risk they did not want hands out free money;
- the quoted value is below `MIN_STAKE_CENTS`;
- the player is a bot (the house does not cash itself out);
- `CASHOUT_ENABLED` is false.

A signal the rule table does not recognise is **held for review**, not defaulted
to void and not guessed.

### Execution

Execution is atomic and recomputes the plan **inside** the transaction: the
position can change between a quote and an execute, and a player must never be
paid a quote for a position they no longer hold.

1. The player's matched collateral is released — their own money back. A
   cash-out sells the **position**; it does not confiscate the stake.
2. The quoted value is paid house → player through the normal ledger, so it
   posts to `player_funds` and is visible to an auditor.
3. **The venue takes the player's side**: a replacement match is written with
   the house in the player's slot and the counterparty's order retained in the
   other, and the escrow moves to the house. At settlement the counterparty
   meets the venue exactly as they would have met the player. Skipping this
   would strand the counterparty's collateral forever — a match is between two
   users, so excluding it excludes them too.
4. The original match is flagged `cashout = 1`, which settlement skips. This is
   what makes double settlement impossible.
5. The player's **resting** orders in that market are cancelled and their
   escrow released, so they cannot be matched into a position they no longer
   hold.

*Tests:* `tests/cashout.test.js` (contract), `tests/cashout2.test.js`
(valuation, multi-runner, no double settlement, counterparty safety).

## Pre-off only

> **Bets may only be placed before an event's off time. Cash-out closes at off
> with them.**

An in-play price is a *forecast* of a future event, while the venue's book is
people reacting to what they can see right now — a goal, a red card, a runner
breaking. If the venue publishes prices instantly and the book reacts in 200ms,
the venue is **systematically slower than its own liquidity**, and anyone with a
low-latency feed trades the delay rather than the football. Every real venue
delays in-play prices for exactly this reason. Removing in-play removes that
whole class of sharp instead of trying to manage it.

### What the gate does

`lib/offtime.js` closes two things, at `events.starts_at`:

| | |
|---|---|
| **Placing an order** | `409` at or after off — refused *before* any collateral is frozen |
| **Cash-out** | `409` at or after off |

Both are enforced **in the engine**, not in the routes, so a future caller cannot
forget. A route-only gate is a dead control.

### Why cash-out is part of it

This is the part that is easy to get wrong. Banning in-play *betting* while
leaving cash-out open through the event would have kept in-play **risk**: the
venue still owes money on a position whose fair price just moved on a goal. That
is the exact exposure `lib/inplay.js` exists to contain. Both are now closed at
off.

### Details that matter

- **Off is inclusive.** The instant of off is closed. "Up to and including the
  off" would leave a zero-width window and a clock-skew argument about who got in
  first.
- **A missing or unparseable off time is treated as CLOSED** (fail-closed). A bad
  catalogue row must never be read as "no off ⇒ open forever", or one malformed
  row silently re-opens in-play trading.
- **Every accepted datetime format resolves to the same UTC instant.**
  `Date.parse` reads a zoneless `2030-01-01T12:00:00` as **local** time, while
  SQLite's `datetime('now')` — used by every timestamp in this system — is UTC.
  An off time written in that form would shift with the server's timezone, and
  the venue would open or close betting at the wrong wall-clock moment.
- **The gate reads the off time, not the event status.** `status` is metadata; a
  market still flagged `upcoming` whose off time has passed is closed.
- **One source of truth.** `events.starts_at` — already required and already
  ISO-validated on admin create, and exactly what the feed publishes. There is no
  second column for the two to disagree about.

### What it does *not* do

- It does **not** settle anything at off. At off, exposure is *frozen*: every
  matched stake stands until the result arrives. Nothing is auto-voided or
  auto-laid.
- It does **not** withdraw a cash-out quote issued pre-off. A quote priced
  pre-off stays valid until off; execution at or after off is refused.

`lib/inplay.js` and `orders.eligible_at` remain in the tree — they are tested, and
`eligible_at` is the only mechanism that could carry the gate if in-play is ever
revisited — but neither has a caller driving an in-play suspension now. See
[ROADMAP.md](ROADMAP.md).

---

## Markets, events and lifecycle

```
sport ──< competition ──< event ──< market ──< runner
                                      │
                        open ──suspended──open
                          │
                      settled   (terminal: winner | void | held)
```

- **open** — orders accepted, ladders quoted.
- **suspended** — orders rejected, existing orders still rest (a trader pulls a
  market, or the desk does).
- **settled** — frozen. The winner (or void) is recorded, escrow is distributed,
  and nothing can be placed or settled again.
- **held** (`settlement_hold = 1`) — still **open**: the player genuinely holds
  a position and their collateral is untouched. Excluded from automatic
  settlement until a human releases it with a written reason. A disputed or
  unrecognised outcome parks here rather than being settled or voided, because
  settling picks a side and voiding may give away money the venue owes.
- An event is **completed** when all of its markets are settled. That flag is a
  *settlement* fact and is deliberately NOT what makes a market eligible for
  automatic settlement: it can only be true once every market on the event has
  already settled, so requiring it would make the pending set empty by
  construction. What makes a market eligible is that it is **off** — see
  [Automatic settlement](#automatic-settlement).
- Events whose start time has passed roll from `upcoming` to `live` at boot, so a
  demo left running does not slowly empty its own board.

### Automatic settlement

A market is **pending** — the set a results-feed poll asks about — when it is
`open`, not on a settlement hold, and its event is **off**. Off is the whole
condition, and it is deliberately not a flag anyone writes:

- `events.status = 'completed'` cannot serve. It is written only once every
  market on the event is already `settled`, so an event that is completed has no
  open market, and an event with an open market is never completed. The two
  halves of "open market on a completed event" cannot both hold, which made the
  pending set empty by construction: the poll reported success on every cycle
  while settling nothing.
- **Off time** is reached by the clock. It is also the honest question to ask —
  "might a result exist for this market?" is about whether the race has happened,
  not about whether we have already been told the answer.

The comparison runs through `lib/offtime.js`, not SQL string comparison, because
`events.starts_at` is text in several formats and one codebase must have one
answer to "is this event off?". An event whose off time is missing or
unparseable is treated as **off** here. That is the opposite of the betting
gate, and both are right: for placing a bet "cannot prove it is pre-off" must
refuse, while for settling "cannot prove it has not finished" must still ask.

One definition serves both sides. `lib/results.js` `pendingMarkets` is the single
query, used by the consumer (`pollOnce`) and by the transport, which POSTs
precisely that set — a transport asking about a different set would look healthy
while outcomes never arrived.

**The transport is a signal, not an authority.** A response the venue cannot
read raises rather than being read as "no outcomes", and a payload containing
entries of which none parsed is a shape change, not an absence of results. Both
were silent successes that settled nothing while reporting healthy forever.

## Limits and configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `MIN_STAKE_CENTS` / `MAX_STAKE_CENTS` | 100 / 100000 | order size bounds, inclusive |
| `COMMISSION_RATE` | 0.025 | fee on net winnings, 0–0.2 |
| `FAUCET_MAX_CENTS` | 100000 | cap per faucet deposit |
| `DRIFT_INTERVAL_MS` | 5000 | how often a fair price moves |
| `BOT_ENABLED` / `DRIFT_ENABLED` | true | demo liquidity and price movement |
| `SESSION_TTL_DAYS` | 30 | session lifetime |
| `SCRYPT_N` | 65536 | scrypt cost; floored at 16384 |
| `MAX_SSE_CLIENTS` | 2000 | concurrent live streams |
| `CASHOUT_ENABLED` / `CASHOUT_MARGIN_BPS` | true / 200 | venue cash-out and its margin |
| `RISK_MAX_LIABILITY_CENTS` | 5000000 | market-maker bot debt cap |
| `RISK_MAX_DAILY_LOSS_CENTS` | 1000000 | bot realised daily loss cap |
| `RISK_QUOTE_SKEW` | 0.5 | ticks of widening at full pressure |
| `TRUST_PROXY_JURISDICTION` | false | read the country header at all |
| `OPS_TOKEN` | — | required for `/metrics` and backup; unset ⇒ they 404 |
| `BACKUP_DIR` / `BACKUP_RETENTION` | — / 24 | scheduled snapshots; unset ⇒ backups OFF |
| `MIN_STAKE_CENTS`/`MAX_STAKE_CENTS` limits | per user | abuse caps, enforced in-transaction |

A runner created **without** a fair price is never quoted by the bots — that is
how you build a market with no demo liquidity in it.

## What is deliberately not implemented

Listed so nobody mistakes a scope decision for a bug:

- **Accumulators / parlays.** One selection per order.
- **Each-way betting.** Win markets only.
- **In-play betting.** Withdrawn — the venue is pre-off only. See
  [Pre-off only](#pre-off-only).
- **Partial-fill queueing, cross-market matching.** A taker takes resting
  liquidity immediately and then rests its remainder.
- **Dead heats in sports with no dead-heat rule.** The engine *can* divide a
  payout among joint winners, but only where the sport's rules permit one. A
  multi-winner signal under a single-winner rule is **held**, not settled as a
  joint favourite.
- **Real money.** No PSP is integrated — the payments machinery ships but
  terminates in a reference provider that moves no money. No KYC/AML, no age
  verification, no licensing path, and the seeded bot's fair prices are a
  random walk rather than a model.
- **Cash-out venue risk.** Bounded, by `lib/cashoutrisk.js`, which refuses a
  quote once unpaid exposure reaches `CASHOUT_MAX_OUTSTANDING_CENTS` ($20k) or
  the day's cash-out outlay reaches `CASHOUT_MAX_DAILY_LOSS_CENTS` ($5k). The
  daily cap gates on **outlay** rather than realised loss: realised loss is
  backward-looking, so by the time it is measurable the money is already gone,
  whereas outlay is known at decision time and genuinely bounds the worst case.
  The residual exposure is the venue's own account, which is why cash-out credits
  `house_float → player_funds` rather than debiting the bot's balance.
- **Horizontal scale.** SQLite is single-writer and synchronous — which is *why*
  the sweep is atomic, and a genuine strength — but it is one process on one
  machine. `npm run load` measures that single node (~500 orders/sec placed);
  running more than one requires the Postgres migration, which makes the engine
  async and re-opens the escrow invariant under row-level locking.

**Shipped since this list was first written:** the results feed with per-sport
void rules and dispute holds, multi-runner cash-out, abuse limits and
self-exclusion, market-maker risk caps, double-entry accounting, payments
abstraction, tenancy, and the operational surface (health, metrics, backup).
