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
- [Tenants and suspension](#tenants-and-suspension)
- [Markets, events and lifecycle](#markets-events-and-lifecycle)
- [Limits and configuration](#limits-and-configuration)
- [Player rules](#player-rules)
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
4. If a `selection_version` or `market_version` was supplied, it is checked
   against the venue's current book version — see
   [Market version](#market-version) below. **Omitting both preserves the
   behaviour above exactly.**
5. The required escrow must be available (see below). If it is not, **nothing is
   written** — no order, no match, no ledger row.
6. The order is inserted first, then matched, then any remainder rests.

An order is a **limit order**: it takes liquidity immediately at the resting
prices, and the rest sits on the book until cancelled or settled. It is never
filled at your limit price if better resting liquidity exists.

*Tests:* `tests/match.test.js` (E9 validation, E24 off-ladder snap,
E25 stake bounds, E26 selection id + suspension), `tests/tx.test.js` (X6
all-or-nothing).

## Market version

### The gap it closes

Snapping a price is **not** the same problem as knowing which book you priced
against, and this venue already solves the first one. Step 3 above corrects an
off-ladder price rather than refusing it, `GET /api/format/:price` documents
that, and the correction is deliberate (#37 fixed the validation branch around
it). Do not read what follows as a criticism of it.

The gap was narrower and quieter. A client that read a ladder, saw `2.00`
available for `5000` cents and sent that order had it placed at whatever the
ladder said by the time the request arrived. The answer was `201`, with `fills`
showing the outcome, and **the client could not tell**:

- *my order was accepted and did not match* — the market moved, which is normal
- *my order was accepted at a price I did not intend* — the ladder moved under me

Betfair solves this by making the client declare what it priced against
(`marketVersion` on `placeOrders`), and the venue refusing the order when the
book has **materially** changed. Without that declaration the venue is silently
making a pricing decision on the client's behalf, and the client cannot audit it.

### What the version is

Two monotone integer counters — `selections.book_version` and
`markets.book_version` — and nothing more. Betfair's is an opaque string; ours
does not need to be, because it has to answer exactly one question: *has this
book moved materially since the client read it?*

They are **not** Betfair's string and must not be treated as one. A client must
not be able to read meaning out of ours (a price, a timestamp, a hash), because
the first thing that would follow is a client parsing it.

Read them from any of: `GET /api/markets/:id/book` (`market_version`, and
`version` on each runner), `GET /api/events` (`market_version` per market,
`version` per runner), or the `POST /api/orders` response, which carries both so
a client can chain its next order without a refetch.

### What moves it

| Event | Selection version | Market version |
| --- | --- | --- |
| A fill on that runner | +1 | +1 |
| A cancel on that runner | +1 | +1 |
| The market is suspended or resumed, or goes in-play or comes out of it | — | +1 |

Bumped **once per placement**, not once per fill. A sweep can take five fills
off five resting orders; what a client whose claim was refused learned is one
thing — the ladder it read is no longer the ladder it saw.

Three things deliberately do **not** bump it:

- **An order that merely rests.** The reason is not that nothing changed — adding
  size to a level does change the book. It is that the client causing it is the
  client making the claim: this control reports what **someone else** did, and a
  counter your own click moves is a counter that refuses your second order for
  something you already know. **The limitation that follows, stated rather than
  hidden:** another player merely *adding* size at a price is not counted, so a
  client is told when a level was traded or cancelled, not when it grew.
- **The cash-out house leg.** `lib/settle.js` inserts it with
  `status = 'fully_matched'`, and the book is built from `status = 'open'`
  orders, so it is invisible to every reader. The player's resting orders that
  the same transaction cancels *do* bump.
- **Settlement and void.** They set `markets.status = 'settled'` (and
  `selections.status = 'void'`), after which every placement is refused with a
  `409` — the client is told directly and cannot be racing anything.

Cancels are bumped in `cancelOrderTx`, which is the single funnel every
cancellation in this codebase passes through: the cancel route, the bots'
requote, cash-out, self-exclusion, a tenant suspension and the admin desk all
call it rather than writing `orders.status` themselves.

### The materiality threshold, and where it sits

`MARKET_VERSION_MATERIAL_THRESHOLD` is **how many book-altering events on that
scope a client may be behind and still be accepted.** A drift of exactly `T` is
accepted; a drift of `T + 1` is refused, with `409` and
`code: "market_version_stale"`. It defaults to **2**, and the refusal carries
`scope`, `supplied_version`, `current_version`, `drift` and `threshold` so a
client can recover from the response alone rather than making a second request.

**Betfair's threshold is not public.** So this is a judgement, and the judgement
is the deliverable — here is the argument, so it can be argued with:

- **Why not 0** (refuse on any movement at all). This venue's own market maker
  cancels and requotes every `DRIFT_INTERVAL_MS` — 5 s by default. A book
  therefore advances under a client's feet *whether or not anybody is trading*,
  and a human's read-then-click latency spans at least one such cycle. A zero
  tolerance does not protect a ladder client; it refuses the second click of
  every ladder they look at, which is the failure mode the issue explicitly
  warns about.
- **Why not large.** The threshold is the whole control. Once it tolerates a
  number of events at which a reader could not tell the book had changed, it is
  decorative — a client would believe it had a staleness guarantee it did not
  have, which is worse than no handshake at all because it suppresses the
  re-read.
- **Why 2 and not 1 or 3.** 2 is the smallest value that clears this venue's own
  churn with a re-read window left over: one requote cycle is tolerated, so a
  client that reads and clicks inside two drift intervals is not refused for the
  venue's own quoting. 1 leaves nothing for a second legitimate event (a fill
  and a cancel in the same window is ordinary on a liquid runner). 3 begins to
  cover a window long enough for a top-of-book move the client would have wanted
  to know about.
- **What would make it wrong.** A venue with real market makers and no bot
  requoting needs a much lower number — the entire argument for 2 is this
  venue's own liquidity churn. Conversely a venue whose clients deliberately
  re-read between every click should run 0. That is why it is a config key: the
  right number is a property of the venue's liquidity, not a law.

It is asserted **at its boundary**, not merely inside: a drift of exactly `T` is
placed and a drift of exactly `T + 1` is refused (`tests/marketversion.test.js`
MV4). A check that only asserted the refusal would also pass against an
implementation that refused everything.

### Where it runs, and why that is not portable

The comparison runs **inside the placement transaction**, immediately after the
selection is resolved and before any escrow, order row or ledger posting exists.
A refusal therefore writes nothing at all.

The reason is the same one `lib/limits.js` gives for enforcing its caps there:
read the version outside the transaction and two concurrent placements both read
the pre-bump value and both pass.

**This is a control the synchronous engine makes easy and a Postgres rewrite
makes subtle**, and it is worth stating exactly why rather than leaving it to be
rediscovered:

- `node:sqlite` is synchronous, so `placeOrderTx` is one transaction with no
  `await` in it. The version read and the order insert are, structurally,
  adjacent statements.
- `transaction()` opens with **`BEGIN IMMEDIATE`**, so it takes the write lock at
  the *start* of the transaction rather than on first write. Two placements
  serialise at their boundary: the second waits (`busy_timeout`), then runs on a
  fresh snapshot and reads the version the first one wrote. There is no window
  between the read and the insert for another writer to enter.

Under Postgres `READ COMMITTED` the same function has two statements and another
session can commit a bump between them; under `REPEATABLE READ` the loser would
instead fail at `COMMIT` with a serialization error — a *different* failure,
which a client has to be taught about separately. Neither is obviously right
until someone checks. **Do not "simplify" the read out of the transaction
because it looks redundant** — that is the defect this note exists to prevent.

### Omitting the version

`selection_version` and `market_version` are both optional and both default to
absent. With neither supplied the placement is byte-for-byte what it was before
this existed: no check, no refusal, no new code path to fail in. Existing
callers — the web client, the smoke test, any integration written against
Betfair — need no change, and that is asserted rather than assumed
(`tests/marketversion.test.js` MV5).

Two edges worth stating:

- **A malformed version is a `400`, never a silent pass.** The comparison is a
  subtraction; a string would make the drift `NaN`, and `NaN > threshold` is
  false — so a client sending `"5"` would be waved through forever while the
  control believed it had run.
- **An idempotent retry is never refused.** `placeOrderTx` answers a known
  `client_order_id` with the order that already exists, before it validates
  anything. That is the one case where the client's claim is *guaranteed* stale,
  and refusing it would turn a retried request into a lost order.

*Tests:* `tests/marketversion.test.js` (MV1–MV14, including the two-process
concurrency race), `tests/store.test.js` (D8, the migration), `tests/api.test.js`
(the refusal as a top-level `code` over HTTP).

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
  against you — which is why cash-out quotes ignore it. There is exactly one
  deliberate exception, for [player rules](#player-rules): an **automated**
  order may cross that same user's **manual** order, never the reverse and
  never another automated order.
- The book is kept consistent by construction: a resting back and a resting lay
  can never price-cross, because whichever arrived second would have matched.

*Tests:* `tests/match.test.js` — E1 (resting price stands), E2 (partial fill),
E4 (back sweep highest-first), E5 (lay sweep lowest-first), E13 (FIFO within a
level), E6 (self-match guard), E11 (aggregation and ordering), E19 (self-match
guard, back-taker side), E20 (lay-taker FIFO).
`tests/selfcross.test.js` — the width of the automated/manual exception, in both
directions, driven through real rules.

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

### Who funds a buyout

A venue buyout has two costs, paid out of two different things, so "can the
venue afford this?" has no single answer. Stating both is the point: a comment
in `lib/cashout.js` once claimed a quote was checked for affordability against
`availableOf()`, and no such check existed.

| Cost | Paid from | Enforced |
| --- | --- | --- |
| **The payout** — what the player is paid | `house_float → player_funds`, a double-entry posting | `lib/cashoutrisk.js` caps, at **quote** time |
| **The legs** — the collateral the venue inherits with the position | the house bot's own balance, as escrow | `ledger.escrow`, at **execution**, inside the transaction |

The payout is deliberately **not** debited from the bot's `users.balance_cents`,
so there is no balance to test it against — the bot's balance does not move when
a buyout is paid. `house_float` stands at minus the cumulative unpaid buyout
payouts: it is a flow account, not a budget. A `availableOf(house) >= payout`
test written the way that comment described would therefore refuse every quote
from the venue's first buyout onward. The bound is a **policy cap** instead:
`CASHOUT_MAX_OUTSTANDING_CENTS` on unpaid exposure and
`CASHOUT_MAX_DAILY_LOSS_CENTS` on the day's outlay, both read before a quote is
offered.

The legs are different, and are a real balance. `cashoutPosition` moves the
player's collateral onto the house through `ledger.escrow`, which refuses when
available funds cannot cover it. Because that happens **inside** the execution
transaction, an unfundable buyout rolls the whole thing back — no match flagged,
no settlement row, no payout. It is a refusal, not a half-close.

The honest consequence: **a quote is not a promise the venue can always
honour.** An underfunded house can be quoted and then decline at execution with
a `400`. What bounds that is the exposure cap, which bounds how much the venue
can be quoted for in the first place.

*Tests:* `tests/cashout.test.js` (C9 no balance gate on the quote, C10 an
unfundable house rolls the buyout back), `tests/cashoutrisk.test.js` (the caps).

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

## Tenants and suspension

A tenant is a venue. `status = 'suspended'` is the operator taking that venue
off, and it **blocks**: a suspended tenant's players are refused trading.

It used to do nothing at all. The value was validated, stored, audited and
rendered in the admin UI, and read by no code anywhere — so an operator who
suspended a partner brand got a `200`, an audit row saying
`{status: "suspended"}`, a dashboard showing the tenant as suspended, and a
venue that carried on taking bets. That is the most dangerous shape a bug can
take: every signal an operator would check to confirm the suspension took
effect says it did.

### What is refused

| | |
| --- | --- |
| **Placing an order** | `403`, `details.code: "tenant_suspended"` |
| **Cash-out** | `403` — it closes a position and pays the player |
| **Deposits and deposit intents** | `403` — money in creates liability |
| **Logging in, and minting a session** | `403` after the password is proven |
| **The house quoting (bot ladders)** | skipped — a suspended venue does not make markets |

### What is still available, and why

**Reads.** The board and order book, positions, balances, the wallet ledger,
settlement history, `/api/me` (which now reports `tenant_status`). **The admin
desk**, including settlement and the restore call itself.

A suspended tenant's players can be holding **matched** positions. Those are
collateralised on both sides and must still settle, and a player who is not even
shown what they hold, what they are owed, or what their balance is, on a venue
the operator has taken off, produces a complaint the only answer to which is to
un-suspend. That is the opposite of what a suspension is for. It is also the
reasoning `lib/limits.js` already applies to self-exclusion: matched positions
are left alone because releasing them, or refusing to serve them, would mean the
venue chooses which side of a matched bet to honour.

The admin desk stays for the same reason plus one more: **a lock that also
blocks the operator holding the key is a trap, not a control.** The first-run
credential lock in `server.js` already had to be repaired for exactly that, and
a venue that cannot be un-suspended without a direct database edit is a venue
somebody will reach for one.

### Resting orders go with it

Suspending a tenant **cancels its resting orders and releases their escrow**,
inside the same transaction as the status change and its audit row.

No gate can do this. A resting order is not a request, it is live liquidity, and
after the gates it would keep matching: a suspended venue's players taking new
matched positions is precisely what the suspension exists to prevent, and it
re-opens the hole the jurisdiction gate at session creation was built to close.
Matched positions are left alone.

### Where the gates live, and why there

| Gate | Where | Why there |
| --- | --- | --- |
| Session creation | `lib/auth.js` `createSession` | next to the jurisdiction gate, for the same reason: a player who cannot get in never holds a position |
| Trading | `lib/limits.js` `assertTradeable` | the **one** function every money path already calls, so a route added later cannot forget it — and it stops an **already-signed-in** player, not only the next login |
| Resting orders | `lib/tenants.js` `configure` | a status change is the only moment a gate cannot cover |

Both gates run **after** authentication, never before. A refusal raised before
the password check would turn `POST /api/auth/login` into a probe that tells an
unauthenticated caller which usernames exist and which venue is suspended — the
exact disclosure the single generic `401` exists to prevent, and the ordering
`lib/auth.js` already documents for a suspended *account*. A wrong password on a
suspended tenant is still `401 Invalid username or password`, byte-identical to
the answer for an account that does not exist.

A self-excluded player on a suspended tenant is told they are **excluded**, not
that their venue is suspended: the exclusion message is the only answer to that
question that is not an argument, and a suspension leads nowhere straight back
in either.

*Tests:* `tests/tenants.test.js` (T21 login gate and its ordering, T22 the
already-signed-in player, T23 reads and the admin desk survive, T24 resting
orders and escrow, T25 scoped to its own tenant, T26 restoring opens the gate
again), `tests/api.test.js` (the whole surface over HTTP).

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
| `MARKET_VERSION_MATERIAL_THRESHOLD` | 2 | book-altering events a client may be behind before its order is refused as stale; `0` refuses on any movement. Only affects clients that send a version |
| `COMMISSION_RATE` | 0.025 | fee on net winnings, 0–0.2 |
| `FAUCET_MAX_CENTS` | 100000 | cap per faucet deposit |
| `DRIFT_INTERVAL_MS` | 5000 | how often a fair price moves |
| `BOT_ENABLED` / `DRIFT_ENABLED` | true | demo liquidity and price movement |
| `SESSION_TTL_DAYS` | 30 | session lifetime |
| `SCRYPT_N` | 65536 | scrypt cost; floored at 16384 |
| `MAX_SSE_CLIENTS` | 2000 | concurrent live streams |
| `MAX_SSE_CLIENTS_PER_SOURCE` | 20 | concurrent **anonymous** streams from one address |
| `MAX_SSE_CLIENTS_PER_USER` | 8 | concurrent streams bound to one account |
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

## Player rules

A player may author a **rule**: place this order when this price crosses this
threshold. It is a record, not a program — `lib/userrules.js` reads four fields
(`op`, `threshold`, `side`, `stake`) off a `user_rules` row and there is no
expression, no script, no `eval`, and no free-text column anywhere in the table
that the engine reads. A player may hold **three live rules**, counted per user.

The framing is *automated extension of a human's betting*: the orders you would
have placed yourself without watching every race. Everything below follows from
that.

### Where it runs

Server-side, in `lib/drift.js`, immediately after a selection's fair price
changes and **before** the bot requote, inside the drift transaction.

- It is the **only** place in the codebase that moves a fair price, so there is
  no second price source for rules to drift out of step with.
- It is **not** hooked to the SSE stream. An SSE client is a viewer; hooking
  there would make evaluation depend on somebody having a browser tab open.
- Killing the process stops evaluation by definition. There is nothing to
  disable and no client-side copy to fall back to.
- If no price event arrives, no evaluation happens. A rule on a market that has
  stopped moving waits, still armed. This is asserted as a decision
  (`tests/userrules.test.js` V32) rather than left as an accident: a periodic
  re-scan would place orders on observations the venue never made.

### One-shot per crossing — not the continuous semantics

A rule **fires on a crossing**: the tick its condition becomes true, it places
one order and disarms; the tick the condition lifts, it re-arms. State is one
boolean (`user_rules.armed`).

This is deliberately **narrower** than the continuous semantics chosen in #67
("fire on every evaluation while the condition holds"), which needs a per-rule
cool-down and a visible fire counter and is the next piece of work. Crossing
semantics are the safe side of the difference and also the cheap one: a price
resting on the threshold, or oscillating across it at the tick rate, places one
order per genuine crossing rather than one per evaluation.

A rule **created while its own condition already holds starts disarmed.** It
fires when the price next leaves the condition and returns. Setting a threshold
below the current price asks for a reaction to a move, not for the bet that move
already made — and arming it would mean the first tick after creation places an
order, before the player has read the confirmation.

The threshold is **exclusive**. A price exactly on the threshold does not hold
the condition; under continuous semantics `>=` would make such a rule permanently
true and an order per evaluation forever.

### The price the order is placed at

The threshold, **or the observed price where that is better**:

- **back** → the higher of (observed, threshold)
- **lay** → the lower of (observed, threshold)

So "back if the price drops below 2.00" places at 2.00, not at whatever the
price happened to be — a fast market can gap a hundred ticks in one observation,
which is a materially different bet from the one that was asked for. Where the
observation is already the better price ("back if the price **rises** above
2.00"), it is kept. Read as a limit order, which is what these are.

### What a rule cannot do

A rule places through `lib/match.js` `placeOrder` — **the same function
`POST /api/orders` calls**. Consequently, for a rule exactly as for a hand:

- `validateOrder` and every status, off-time and in-play gate;
- the **in-play bet delay** — the rule's order carries the same `eligible_at`,
  is marked `delayed`, and does not sweep on arrival. An automated strategy has
  every incentive to route around the delay and no reason to, and it does not;
- `max_open_stake_cents`, `max_market_liability_cents`,
  `max_daily_settled_cents`, self-exclusion and the RG session/deposit limits,
  which are **per user** and are not per rule;
- the escrow contract, byte for byte.

A rule that fires without the funds is **refused, counted and not retried**: the
rule disarms *before* the placement is attempted, so a condition that keeps
holding cannot hammer the engine every tick. `refusal_count` and `last_error`
record it; `fire_count` counts **orders placed**, so the visible tally never
claims a bet that did not happen.

**Self-exclusion kills live rules on the spot** (`lib/limits.js` `exclude()`).
The placement gate alone would have stopped the trade, but a rule left armed
fires the first time the price crosses after a timed exclusion lapses.

### Who may fill a rule's order

**Not the house.** `lib/bots.js` must not fill an automated order (#67), and the
sweep refuses a crossing where exactly one side is the house *and* exactly one
side is automated — in both directions, because a rule taking the desk's resting
quote is the same conflict of interest with the words reversed. Two players, or
the house against a manual order, are untouched.

With the house excluded and one player on the venue, the only counterparty left
is **that player's own manual orders**, via the audited
self-match exception under [Player rules](#player-rules) below. Every
resulting fill is a `self_crossed` match row and a `trade.self_crossed` audit
row, so the P&L that is partly self-generated is always identifiable.

Two rules of the **same user never match each other**, and neither does a rule
and another rule's order. That is the far larger hole, and it stays shut. The
exact width, asserted behaviourally:

| | |
| --- | --- |
| **Permitted** | one side automated, both this user, either is the taker |
| **Blocked** | two manual orders of one user — unchanged |
| **Blocked** | two automated orders of one user |
| **Blocked** | the house on either side of an automated order |
| **Blocked** | two different players' orders (an ordinary crossing) |

### Not in this version

Deliberately absent, because each is where a real evaluation engine and its cost
arrive: derived state over a running position ("back if my net exposure across
this event exceeds X"), multi-leg conditions, anything needing an expression
language, and the continuous/cool-down/fire-count semantics of #77. There is no
rule management API yet either — #78 owns the surface, so a player cannot
currently author a rule over HTTP.

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
  `house_float → player_funds` rather than debiting the bot's balance — see
  [Who funds a buyout](#who-funds-a-buyout) for why that leaves no balance a
  quote could be tested against.
- **Horizontal scale.** SQLite is single-writer and synchronous — which is *why*
  the sweep is atomic, and a genuine strength — but it is one process on one
  machine. `npm run load` measures that single node (~500 orders/sec placed);
  running more than one requires the Postgres migration, which makes the engine
  async and re-opens the escrow invariant under row-level locking.
- **Rules over derived state.** [Player rules](#player-rules) cover a threshold
  crossing on one runner's price. They do **not** compare against a running
  position ("back if my net exposure across this event exceeds X"), do not span
  legs, and have no expression language — those need a real evaluation engine,
  and building one before the crossing case is proven is how an in-app strategy
  builder turns into a sandbox. Continuous re-firing, a per-rule cool-down and
  the visible fire count are also absent: rules are one-shot per crossing. See
  [Where it runs](#where-it-runs).

**Shipped since this list was first written:** the results feed with per-sport
void rules and dispute holds, multi-runner cash-out, abuse limits and
self-exclusion, market-maker risk caps, double-entry accounting, payments
abstraction, tenancy, player-authored betting rules, and the operational surface
(health, metrics, backup).
