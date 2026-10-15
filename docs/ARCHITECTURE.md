# Architecture

The design a maintainer needs before changing the engine. For the behavioural
rules — who wins, who pays what, and why each is that way — see
[`EXCHANGE_RULES.md`](EXCHANGE_RULES.md). For the HTTP surface, see
[`API.md`](API.md).

## Contents

- [Shape of the system](#shape-of-the-system)
- [Modules and their responsibilities](#modules-and-their-responsibilities)
- [The money path, end to end](#the-money-path-end-to-end)
- [Why these choices](#why-these-choices)
- [Data model](#data-model)
- [Security model](#security-model)
- [Testing strategy](#testing-strategy)
- [Extension points](#extension-points)

## Shape of the system

```text
browser   public/    index.html, style.css, classic scripts — no build step
             js/     core, shell, nav, board, slip, views, boot (window.OB)
             admin.js, admin-risk.js, ladder.js
   │      fetch() + EventSource          same-origin, httpOnly cookie session
   ▼
server    server.js  2,560 lines, 87 routes
             1. baseline security headers
             2. origin guard — BEFORE any body parsing
             3. express.json({ limit: 256kb })
             4. session middleware (cookie ob_session | Bearer)
             5. routes: auth · board · trading · wallet · admin · stream
             6. /api 404 (JSON) → static(public/) → errorHandler

         Express 5. `query parser` is pinned to `simple` rather than left on the
         framework default — see the comment at the top of server.js for the
         audit behind that choice.
   │
   ▼
engine    lib/       31 modules + lib/payments/ — see the table below
   │
   ▼
storage   data/openbettingexchange.db   SQLite (WAL), 28 tables, created on first run
```

There is no ORM, no migration framework and no service layer beyond `lib/`. The
schema is a single readable block of `CREATE TABLE IF NOT EXISTS` in
`lib/store.js`, which is why a fresh clone runs with one command. Express and
`pg` (the feed's Postgres client) are the only runtime dependencies; Playwright is
dev-only and used by the browser suite.

The dependency direction is strictly one way: `match → ledger → tx`, with
`settle`/`cashout → match`. Nothing imports `server.js`.

## Modules and their responsibilities

| Module | Owns | Must not |
| --- | --- | --- |
| `lib/tx.js` | transaction depth; nested calls become savepoints | know anything about betting |
| `lib/util.js` | shared helpers: timestamps, strict UTC/ISO parsing | hold domain state |
| `lib/store.js` | schema, pragmas, connection | contain domain logic |
| `lib/config.js` | `.env` parsing, validation, loopback enforcement | read `process.env` outside the loader |
| `lib/odds.js` | tick ladder, snap/next/prev, American/fractional, implied probability, overround | know about orders or balances |
| `lib/auth.js` | scrypt hashing, sessions, sanitised user shape | touch balances |
| `lib/ledger.js` | the **only** writer of balances/escrow and `transactions` rows | decide who wins |
| `lib/accounts.js` | double-entry postings; conservation and segregation checks | be written to outside `ledger` |
| `lib/match.js` | order validation, book sweeps, fills, `bookFor`, positions, overround | settle anything |
| `lib/settle.js` | market settlement: pot distribution (single winner or a dead heat's joint set), commission, market **and selection** voids, auto-cancel | place orders |
| `lib/cashout.js` | quote and execute a **venue buyout** at `Σ pᵢ·Payoutᵢ` less a margin | touch the raw pot maths, or hedge |
| `lib/cashoutrisk.js` | venue cash-out exposure caps: outstanding and daily outlay | decide what a position is worth |
| `lib/limits.js` | abuse controls: stake, market liability, daily settled, self-exclusion | decide who wins |
| `lib/rg.js` | responsible gambling: session limit, reality check, rolling deposit limit | be enforced anywhere but the one gate in `limits.js` |
| `lib/risk.js` | market-maker risk: liability and loss caps, quote skew, kill switch | place orders directly |
| `lib/results.js` / `lib/voidrules.js` | per-sport void rules, outcome application, withdrawn-runner handling, settlement holds, provenance | invent an outcome |
| `lib/resultsfeed.js` | the results transport: fetch, normalise, report health | decide or settle anything |
| `lib/inplay.js` | suspension and the in-play bet delay gates | unfreeze a market on its own authority |
| `lib/offtime.js` | the pre-off cut-off | be bypassed by a route |
| `lib/reports.js` | reporting: aggregate, state definitions, render CSV | settle anything or write to the ledger |
| `lib/userrules.js` | player-authored betting rules: the record, the per-user cap, and evaluation on the price stream | bypass `placeOrder`, or interpret anything a player wrote — there is nothing to interpret |
| `lib/bots.js` | MarketMakers ladders, requote, withdraw-all | match itself (the engine's self-match guard covers it), or fill an automated order — the engine refuses that |
| `lib/drift.js` | fair-price random walk; also where player rules are evaluated | move LTP (only real trades do) |
| `lib/tenants.js` | multi-tenancy, per-tenant commission, jurisdictions, **tenant suspension**, trusted-country extraction | decide a bet's outcome |
| `lib/payments/` | provider interface, reference provider, withdrawal lifecycle, webhook confirmation | credit on initiation |
| `lib/jobs.js` | scheduled reconciliation and maintenance timers | run inside a placement transaction |
| `lib/ops.js` | health, readiness, metrics, backup, restore | write to balances |
| `lib/audit.js` | the append-only operator action log | be a source of truth for state |
| `lib/admin.js` | operator account mutations: status, role, balance | move money without an audit row |
| `lib/feed.js` | the feed seam: resolve the configured provider and forward to it | decide what a feed price means (see [FEED.md](FEED.md)) |
| `lib/feed/provider.js` | the price-feed contract, the provider registry, and the `FEED_PROVIDER` lookup | serve anything itself |
| `lib/feed/shape.js` | **the one shaper**: rows → markets, markets → nav tree, health → payload | talk to a transport, or be forked for one |
| `lib/feed/postgres.js` | the collector's `v_feed1`/`v_feed2`, as a provider | be the only reader of the feed |
| `lib/feed/http.js` | a generic JSON-over-HTTP feed provider, mapped from configuration | shape markets of its own |
| `lib/feed/fieldmap.js` | the field-map grammar and vocabularies, dependency-free so `lib/config.js` can validate them at boot | import `lib/config.js` — that is the cycle it exists to avoid |
| `lib/feedcreds.js` | per-tenant Betfair credentials: seal, open, status | **return a plaintext credential to an HTTP caller** — no function here does, and a test asserts adding one would be deliberate |
| `lib/feedrunner.js` | supervise the collector as a child process: spawn, restart, backoff, redact its output | poll Betfair itself (the collector does that) |
| `lib/seed.js` | first-run fixtures, board roll-forward | run on every boot unconditionally |

## The money path, end to end

A single back order that matches, from click to settlement:

1. **Route.** `POST /api/orders` validates the body, requires a session, and
   calls `match.placeOrder`.
2. **`placeOrder`** opens a transaction (`lib/tx.js`) and calls `placeOrderTx`.
3. **`placeOrderTx`** validates against the *current* market/selection state,
   asks the ledger to freeze `stake` (a back) or `(price−1) × stake` (a lay),
   inserts the order, then sweeps eligible resting orders:
   - a back taker takes resting **lays** with `Q ≥ P`, highest price first;
   - a lay taker takes resting **backs** with `P ≤ Q`, lowest price first;
   - each fill records a `matches` row **at the resting order's price**;
   - a lay that matches better than its own price releases the excess escrow, or
     tops up the rare 1¢ when per-fill roundings sum above the placement rounding.
4. **Broadcast** sends `book` to everyone and `orders`/`balance` to that user.
5. **Settlement** (`settle.settleMarket`) validates the caller's intent strictly,
   freezes the market, auto-cancels unmatched orders (releasing escrow), then
   walks every match: the winner's side is credited the pot, void refunds each
   side its own contribution, commission is charged on net winnings per user, and
   the event completes when all of its markets are settled. A runner declared a
   **non-runner** takes a different path — `settle.voidSelection` cancels its
   resting orders, refunds its matched legs and marks the selection `void` while
   the market settles on the runners that ran. It is a separate primitive because
   the two operations move different money and end in different states.
6. The wallet is only ever mutated through `ledger.js`, and every mutation
   writes a `transactions` row carrying `balance_after` and `frozen_after`.

Settlement eligibility is driven by **off time** rather than by an event-status
flag, because the clock advances off time — so the "which markets need settling"
predicate cannot drift back into being unsatisfiable, which is exactly the bug
that once made the automated results poll settle nothing while reporting success.

## Why these choices

- **No ORM, no migrations.** The schema is 28 tables of plain SQL with `CHECK`
  constraints on the money columns. A contributor can read the whole data model
  in one file, and the database itself refuses an invalid cent. `docs:check`
  verifies the table count against the code, so the figure above cannot rot.
- **`node:sqlite` instead of a native driver.** No compilation, no prebuilt
  binary to mismatch the platform, nothing to audit in the dependency tree. The
  `ExperimentalWarning` is suppressed by `--no-warnings` in the npm scripts.
- **One transaction helper.** SQLite has no nested `BEGIN` and `node:sqlite`
  cannot tell you whether you are already in one, so depth is tracked in
  `lib/tx.js` and every atomic unit goes through it. `placeOrderTx` is the only
  exported function that assumes a caller-owned transaction, and it checks.
- **Escrow in the database, not in memory.** A crash between "matched" and
  "settled" is survivable because the escrow is a column, not a process-local
  counter. `orders.frozen_cents` is the per-order source of truth, and a guard
  test fails the build if a module outside the three named ones writes it — a
  convention is not a type.
- **Bots as ordinary users.** `is_bot` is a flag, not a code path: the bot's
  orders go through the same engine as a human's, and the self-match guard is
  what stops its own two sides from crossing.
- **Credentials scoped by construction, not by convention.** Feed credentials
  are sealed with AES-256-GCM and bound to tenant and field as additional
  authenticated data, so a row moved in the database fails to decrypt rather than
  becoming another tenant's credential. `open` has no absent answer at all, so an
  edited row — moved, column-swapped, truncated, or emptied — is always a loud
  integrity failure and never reads as an unconfigured field.
- **A tenant that is suspended is off, and "off" is enforced in the engine.**
  A stored status that nothing reads is worse than no status: it is recorded as a
  control and obeyed by nothing. Suspension is gated at session creation
  (`lib/auth.js`, beside the jurisdiction gate) and at
  `lib/limits.js assertTradeable` — the one function every money path already
  calls, so it also stops an *already-signed-in* player — and it cancels the
  tenant's resting orders, which no per-request gate could reach. Reads and the
  admin desk stay open: matched positions must still settle, and a lock that
  blocks the operator holding the key is a trap rather than a control. See
  [EXCHANGE_RULES.md](EXCHANGE_RULES.md#tenants-and-suspension).
- **SSE plus a 15s poll fallback in the browser.** The stream is a nicety; the
  board must still move if a proxy drops it.

## Data model

```text
sports ──< competitions ──< events ──< markets ──< selections
                                                   │        │
users ──< orders >───────────────────────────────┘        │
  │        │  └──< matches >──┘                             │
  │        └──< transactions                                 │
  └──< sessions                                              │
                                    price_history, settlements, settings
                                    price_matched_levels (#93 — rolled-up
                                    matched volume per price, per minute)
```

`orders` is the book *and* the user's history in one table (`status` is
`open` / `fully_matched` / `cancelled`); `matches` is the executed trade tape and
is what settlement reads. `settlements` is a precomputed per-user-per-market
outcome so history is a single indexed read.

Index notes: `orders(selection_id, side, price, id)` serves the book sweep
directly (including the FIFO tiebreak), `orders(user_id, status)` serves the open
orders list, and `matches(market_id)` serves settlement.

### Matched volume, and why there is a rollup

`matches` is one row per fill, forever. The ladder wants matched volume *at each
price* for a *window*, so reading it per board frame would be a scan of the fill
history — and `node:sqlite` is synchronous, so that blocks the whole
single-threaded server for the duration of every poll. `MAX_SSE_CLIENTS` bounds
long-lived streams; it bounds nothing here.

`price_matched_levels` is a minute-bucketed rollup of `matches`, one row per
`(selection_id, price_cents, minute)`, maintained by an `AFTER INSERT` **trigger**
rather than by application code: every fill path belongs to the matching engine,
and a rollup that some code path forgets to update is a rollup that reads zero
while the tape says otherwise. The trigger's cost is that its cost is now part of
a fill, which is a trade this repository has made explicitly.

The read that serves the board and the mover view is a single windowed aggregate
whose cost depends on how many distinct `(selection, price, minute)` combinations
traded — not on how many fills occurred. Two details of its shape are measured
rather than assumed, because both were wrong in the first draft and neither was
visible in the results:

- the market scope is an always-concrete `IN (?, ?, …)` list. The
  `(? IS NULL OR market_id IN (…))` form that would have let one statement answer
  both "these markets" and "every market" makes SQLite plan a **covering-index
  scan** of the rollup. Same rows, same answer, unbounded read.
- the scope is resolved in JS (`openMarketScope()`), not in SQL, so "no markets
  in scope" can mean *nothing* rather than *everything*. `market_id IN (NULL)`
  plans as an index search and matches nothing — a very quiet way to serve an
  empty board.

`price_history` is a different table with the opposite profile: one row per fill
at no aggregation, kept because its job is a *shape* over time rather than a
per-frame figure. It is read by `GET /api/selections/:id/price-history` through
`idx_price_history_selection (selection_id, at)` — an index range over **one
runner's** fills inside the window, bucketed in SQL so the rows crossing into
the process are bounded by the point count asked for. See
[`EXCHANGE_RULES.md`](EXCHANGE_RULES.md#the-trade-tape-and-its-retention) for
what it is kept for and for how long.

## Security model

Deliberately narrow, and asserted by tests rather than assumed:

- **Loopback only.** `config.js` refuses a routable `HOST` at boot; the test
  server binds `127.0.0.1` explicitly.
- **Origin guard before parsing.** Mutating requests need no `Origin` (curl) or a
  loopback origin. Because it runs first, a malformed body from a foreign origin
  is still a `403`.
- **The framework's defaults are pinned, not inherited.** `query parser` is set
  explicitly to `simple`. Express 5 changed this default from `extended` to
  `simple`, and an unset value would mean the behaviour of every query-string
  read is decided by whichever framework version is installed. The audit that
  justifies the value — no route reads nested bracket syntax anywhere — is in
  `server.js` and re-run mechanically by `tests/express5.test.js`.
- **Sessions** are opaque 32-byte tokens stored as SHA-256 digests, delivered in
  an `HttpOnly; SameSite=Lax` cookie. Passwords are scrypt compared with
  `timingSafeEqual`, a missing user still pays the KDF cost, and a non-string
  password is refused rather than coerced.
- **Credential-abuse counters live in SQLite, not in the process.** They were a
  module-level `Map`, so a restart handed a locked-out attacker a fresh ten
  guesses on every account — the effective rate was ten guesses per restart
  cycle rather than ten per escalating window. A restart now **preserves** the
  lock and the failure count: a user locked out by their own typos already gets
  one on the clock (30 s, doubling to at most 15 min), so preserving costs them a
  wait they would have sat through anyway, while clearing costs an account ten
  more guesses every time the process cycles. Rows are swept by age — the TTL is
  the longest possible window, so a swept row is one the limiter would have
  treated as unlocked anyway, and the escalation survives for anyone still
  trying. `tests/login-lock-restart.test.js` pins the choice across a real
  process boundary, because a test inside one process cannot see it.
- **Error discipline.** 4xx messages are ours and safe; anything 5xx is logged
  and replaced with `Internal error` before it reaches a client.
- **No secrets in the repo.** The demo credentials are deliberate and documented;
  a CI guard compares tracked files against the values in the collector repo's
  `.env`, and the browser suite fails the run on any uncaught page error.

## Testing strategy

1023 checks across 72 suites, plus a 217-check browser suite and a live smoke script.
| Layer | Where | What it proves |
| --- | --- | --- |
| Pure maths | `tests/odds.test.js`, `tests/tx.test.js` | ladder, conversions, transaction depth |
| Schema | `tests/store.test.js` | tables, foreign keys, money `CHECK`s |
| Fixtures | `tests/seed.test.js` | idempotent seed, valid fair prices, board roll-forward |
| Services | `tests/{auth,ledger,match,settle,cashout}.test.js` | the money rules, hand-computed |
| HTTP | `tests/api.test.js` | the wire contract, guards, error sanitisation |
| Guards | `tests/guard.test.js` | invariants that are conventions elsewhere — escrow writers, docs that must not contradict the code |
| Live | `tests/smoke.sh` | a real server, real HTTP, real conservation |
| Browser | `tests/ui_test.mjs` | the UI renders and *behaves*, with no page errors |

The domain suites are pure `assert` with numbered examples and no framework, so a
single file can be read end-to-end as executable specification. The browser suite
asserts **geometry**, not just presence: a ladder that renders the wrong number
of cells can still look right in a screenshot, but a mis-stacked price column
cannot pass the x/y assertions.

**Before trusting a test, confirm it can fail.** Deliberately invert the
behaviour it covers and check it goes red. This repository has shipped bugs behind
green tests more than once — including a regression test that passed *with* the
bug reintroduced, because two ids coincided — so an assertion that cannot fail is
worse than no assertion, since it reads as coverage.

## Extension points

- **New market shapes**: add rows. The engine is side-agnostic and settlement
  only needs a winning selection per market.
- **A real results provider**: replace the admin settle call with a feed
  consumer. `settleMarket` is already the single, idempotent, audited entry
  point, and `lib/resultsfeed.js` is already a transport behind that boundary.
- **A different cash-out model**: `lib/cashout.js` builds a plan and
  `cashoutMarket` executes it in one transaction. The derivation lives in that
  file's header; anything that changes the arithmetic should change it there and
  be justified against the venue-buyout derivation rather than a hedge.
- **A real matching venue in front**: the engine's sweep, price-time priority and
  self-match guard are the parts you would keep. Settlement and the ledger are
  independent of them.
- **Multi-tenant branding**: `GET /api/branding` returns a tenant's name,
  logo, favicon, terms URL and palette, the palette is already tokenised as CSS
  custom properties, and the frontend reads all of it at boot — so the theme
  token set is the one place a rebrand has to touch.
