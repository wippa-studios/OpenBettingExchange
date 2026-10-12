# OpenBettingExchange

**An open-source betting exchange** — the kind of venue where the house is a
*fee*, not a book. Back and lay against other people, order books with real
depth, a matching engine with price-time priority, and settlement that pays the
pot.

Node 22 · Express · SQLite · zero-build frontend · **paper money only**.

Prices can come from a live odds feed ([`docs/FEED.md`](docs/FEED.md)) or the
built-in demo bots.

![The OpenBettingExchange board showing a Betfair-style ladder](docs/screenshot.png)

Light house palette (white ground, black text, grey accent), Inter self-hosted
in place of Canva Sans, brand wordmark and favicon from `assets/`. No build step
and no CDN: fonts, logo and icon are all served from `public/`.

> **Paper money only.** Every balance is play money and there is **no real-money
> execution path**: no PSP is integrated and there is no licensed operation
> behind this. The payments *machinery* ships (deposit intents, confirmation-
> gated crediting, a withdrawal hold, webhook verification and reconciliation)
> but it terminates in a reference provider that moves no money. See
> [`docs/EXCHANGE_RULES.md`](docs/EXCHANGE_RULES.md) for the full boundary.
>
> Running a real-money exchange additionally requires licensing and regulatory
> compliance (18+, responsible gambling, AML/KYC, fund segregation). Software
> cannot supply any of that — see [`docs/ROADMAP.md`](docs/ROADMAP.md) §5.

## What makes it an exchange

A bookmaker sets the odds and takes the risk. An exchange does neither: **you
bet against other bettors**, and the exchange's only income is a commission on
winnings. That single difference changes the whole design, and this repo is
built around it:

- A **back** bet is "this runner wins" (risk: the stake). A **lay** bet is
  "this runner loses" (risk: `(price − 1) × stake`). The UI puts both on either
  side of every runner, exactly like the exchange you know.
- Orders are **limit orders** matched against a real order book with price-time
  priority, partial fills and a self-match guard. The displayed price is the
  **resting** order's price, not yours.
- Your risk is **escrowed** while a position is open — your balance shows
  available versus frozen.
- The **house edge is a commission on net winnings**, applied at settlement.
- Where a bookmaker protects itself with a spread, an exchange shows you the
  spread: here, the admin desk reports each market's **overround** (the
  arbitrage/margin signal) from the live book.

## 60-second tour

```bash
npm install
npm run seed      # demo catalogue, users and bot liquidity
npm start         # http://127.0.0.1:7777
```

1. Open the board: sports across the top, competition-grouped event cards, and a
   ladder per market — three back prices, the runner and its last traded price,
   three lay prices. Blue flashes are price rises, red are falls.
2. Sign in as `demo` / `demo123`, then **click a price**. The bet slip opens on
   the right with that side and price; adjust the stake or step the price along
   the ladder. Press **Place** — it matches against real liquidity or rests on
   the book.
3. **My Bets → Positions** shows what you are exposed to: per-runner backed and
   laid stakes, your escrow, and the if-this-wins P&L for every runner. A losing
   position on a winning runner can be **cashed out** at top of book.
4. **Wallet** shows available versus frozen, a faucet for play money, and every
   escrow, release, payout and commission as a ledger.
5. Sign in as `admin` / `admin123` for the **trading desk**: create the
   catalogue, read the live fair-price helper in American/fractional/implied
   form, watch matched volume and overround, suspend a market, and **settle** it
   with a winning runner (or void it) — which pays every matched pot net of
   commission, right then.

## What works today

| | Status |
| --- | --- |
| Back/lay order book, aggregated depth, LTP | working |
| Matching engine: best-for-taker sweeps, match at resting price, partial fills, FIFO, self-match guard | working |
| Escrow wallet: available vs frozen, full transaction ledger, faucet | working |
| Settlement: pot distribution, void refunds, commission on net winnings, auto-cancel, double-settle protection | working |
| Cash-out: **venue buyout** from fair probabilities, any number of runners, all-or-nothing | working |
| Liquidity bots + fair-price drift | working (disable with `BOT_ENABLED=false`) |
| Admin trading desk: catalogue, suspend/restore, settle, stats, overround | working |
| Live updates | working (SSE with a 15s poll fallback) |
| Results feed: per-sport void rules, disputes held not guessed, provenance, manual release | working |
| In-play: bet delay modelling, traded-volume ladder | not implemented |
| Accumulators / each-way / dead-heat joint favourite | not implemented |
| Real-money execution (no PSP integrated) | not implemented |

## Architecture

```
browser (public/ — plain HTML/CSS/classic JS, no build step)
     │  REST + SSE (EventSource), httpOnly cookie session
     ▼
┌───────────────────────────────────────────────────────────────────┐
│ server.js  origin guard → sessions → routes → JSON 404 → static │
│  lib/tx        transaction depth; nested calls use savepoints     │
│  lib/match     the engine: sweeps, fills, escrow, book, positions  │
│  lib/ledger    the only writer of balances and the transactions log │
│  lib/settle    pot distribution, commission, void, cash-out close    │
│  lib/cashout   venue buyout quote (any number of runners)            │
│  lib/accounts  double-entry postings; conservation + segregation     │
│  lib/limits    abuse controls (per-user caps, self-exclusion)        │
│  lib/risk      market-maker risk: caps, skew, kill switch            │
│  lib/tenants   multi-tenancy, per-tenant commission, jurisdictions   │
│  lib/payments  provider interface + reference provider               │
│  lib/results   results feed, per-sport void rules, dispute holds     │
│  lib/voidrules the rule table: settle / void / hold per sport        │
│  lib/jobs      scheduled reconciliation and maintenance              │
│  lib/ops       health, readiness, metrics, backup, restore           │
│  lib/audit     append-only operator action log                       │
│  lib/odds      tick ladder, American/fractional, implied, overround │
│  lib/auth      scrypt + opaque session tokens                      │
│  lib/bots      MarketMakers ladders        lib/drift  fair drift │
│  lib/store     schema (SQLite WAL)         lib/seed   fixtures    │
└───────────────────────────────────────────────────────────────────┘
     ▼
  data/openbettingexchange.db   (created on first run, gitignored)
```

The dependencies run one way: `match → ledger → tx`, with `settle` and
`cashout` on top of `match`. There is no ORM, no migration tool, and no runtime
dependency beyond Express and `pg` (the odds feed's recorder client — Playwright
is dev-only, for the browser suite) — the
data model is one readable SQL file of 23 tables. Read
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design and the reasoning.

## The rules that protect the money

If you read one thing before changing the engine, read this table. Every row is
asserted by a test.

| Rule | Why it exists | Tests |
| --- | --- | --- |
| Money is integer **cents**; one `Math.round` per liability, payout and fee | no drift, no two-round disagreements | `ledger`, `settle`, `store` |
| A back freezes its stake; a lay freezes `(price−1) × stake` at its own price | a layer's risk must be reserved before matching | `match` (E1) |
| A lay fill of `f` at `P` keeps `round((P−1)·f)` frozen and adjusts the order's tracked remainder escrow so the wallet holds exactly that plus `round((Q−1)·remainder)` — releasing the difference, or topping up the rare 1¢ | settlement can never release more than is frozen; no cent is stranded | `match` (E3, E5, E14–E18) |
| A back taker sweeps resting lays `Q ≥ P` highest-first; a lay taker sweeps rests `P ≤ Q` lowest-first | the taker gets the best available price | `match` (E4, E5) |
| Fills execute at the **resting** order's price | the resting orderer's price is the market's price | `match` (E1) |
| FIFO within a price level (`id` tiebreak) | price-time priority, not insertion luck | `match` (E13) |
| A user never matches their own order | no self-lay; own liquidity isn't executable | `match` (E6) |
| Pot per match is `s + (Q−1)·s`; the winner is credited the pot | settlement is zero-sum apart from commission | `settle` (S1–S3) |
| Void refunds each side its **own** contribution | nobody wins or loses on a void | `settle` (S4, S10) |
| Commission on **net winnings per user per market**, only if positive | mirrors the real-world model; never a fee on a loser | `settle` (S7) |
| A settled market is frozen and cannot settle twice | no double-pay | `settle` (S6), `api` |
| Cash-out is a **venue buyout** priced at `Σ pᵢ·Payoutᵢ` less a margin, not a market hedge | hedging N runners against a fair book is provably value-destroying; see the derivation in `lib/cashout.js` | `cashout2` (C1–C5) |
| Cash-out **holds** a position the venue cannot price fairly (underwater, unpriced runner) | paying a player to take risk they did not want hands out free money | `cashout2` (C3, C4) |
| A cashed-out match is flagged so settlement can never pay it again | double settlement is the worst bug this system could have | `cashout2` (C7) |
| Cash-out hands the player's side to the venue, not to nobody | excluding the match outright would strand the counterparty's collateral forever | `cashout2` (C8) |
| Cash-out is all-or-nothing, in one transaction | never half-closed | `cashout` (C4) |
| Every money operation is one transaction (`lib/tx.js`) | a failure leaves no partial state | `tx` (X1–X6) |
| The database itself refuses invalid cents (`CHECK`) | the invariant does not rely on JavaScript | `store` (D3) |
| Every posting set sums to **zero**; global conservation is a query | double-entry makes "where did this money come from" answerable | `ledger2` (D2, D7) |
| `users.balance_cents` is a **cache** of `player_funds` + `player_escrow`, proven per user | the two representations cannot drift silently | `ledger2` (D3) |
| Credit on **confirmation**, never on initiation | ten abandoned deposit intents must fund you zero times | `payments` (P1, P4) |
| A `client_order_id` repeat returns the original order and takes **no second escrow** | a double-submit is a financial incident, not an annoyance | `idempotency` (I1, I6) |
| Abuse limits are enforced **inside** the placement transaction | a check-then-act outside would let two concurrent placements both pass | `limits` (L13) |
| A disputed outcome is **held**, never settled or voided | settling picks a side; voiding gives away money the venue may owe | `results` (V3, R3) |
| `orders.frozen_cents` is written only by three named modules | the escrow invariant rests on this, and a convention is not a type | `guard` (G2) |

Full specification, with worked examples: [`docs/EXCHANGE_RULES.md`](docs/EXCHANGE_RULES.md).

## API

JSON in, JSON out; errors are `{ "error": "..." }`. Mutating requests require a
loopback `Origin` (or none, for local tooling). Authenticate with the
`ob_session` httpOnly cookie, or `Authorization: Bearer <token>` for scripts.
Full reference including every parameter lives in
[`docs/API.md`](docs/API.md).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` · `/api/auth/login` · `/api/auth/logout` | account + session |
| `GET` | `/api/me` | you, your balance and escrow |
| `GET` | `/api/sports` · `/api/events` · `/api/markets/:id/book` | the board and the book |
| `GET` | `/api/feed/board` · `/api/feed/health` | board from the odds feed (when `FEED_ENABLED=true`) |
| `POST` | `/api/orders` · `GET /api/orders` · `POST /api/orders/:id/cancel` | trade |
| `GET` | `/api/positions` | exposure, if-win P&L, cash-out quote |
| `POST` | `/api/markets/:id/cashout` | close a position |
| `GET` | `/api/wallet` · `POST /api/wallet/deposit` | balances + ledger |
| `GET` | `/api/settlements` | settled history |
| `GET` | `/api/format/:price` | decimal / American / fractional / implied |
| `GET` | `/api/stream` | SSE: `book`, `balance`, `orders`, `settlement` |
| `POST` | `/api/admin/{sports,competitions,events,markets,selections}` | build the catalogue |
| `GET` | `/api/admin/competitions?sport_id=` | competitions for a sport |
| `PATCH` | `/api/admin/markets/:id` | suspend / restore |
| `POST` | `/api/admin/markets/:id/settle` | settle: winner or `void: true` |
| `GET` | `/api/admin/stats` | matched volume, open orders, overround |

## Configuration

`.env` (see [`.env.example`](.env.example)). Every value is validated at boot;
a bad value **aborts the launch** rather than failing later.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `7777` / `127.0.0.1` | listener; `HOST` is loopback-only by design |
| `DB_PATH` | `data/openbettingexchange.db` | SQLite file (`:memory:` for tests) |
| `COMMISSION_RATE` | `0.025` | fee on net winnings |
| `FAUCET_MAX_CENTS` | `100000` | faucet cap per deposit |
| `MIN_STAKE_CENTS` / `MAX_STAKE_CENTS` | `100` / `100000` | order size bounds |
| `FEED_ENABLED` | `false` | take prices from the odds feed instead of the bots |
| `FEED_DATABASE_URL` | — | recorder Postgres URL; required when the feed is on |
| `FEED_STALE_SECONDS` | `300` | frame age beyond which the board reports stale |
| `FEED_MARKET_LIMIT` | `60` | markets returned to the board |
| `BOT_ENABLED` / `DRIFT_ENABLED` | `true` | demo liquidity and price drift (ignored when the feed is on) |
| `DRIFT_INTERVAL_MS` | `5000` | drift cadence |
| `SESSION_TTL_DAYS` | `30` | session lifetime |
| `SCRYPT_N` | `65536` | password hashing cost; floored at 16384 |
| `MAX_SSE_CLIENTS` | `2000` | concurrent live streams; each is a held socket |
| `TRUST_PROXY_JURISDICTION` | `false` | read the country header at all — only when an edge overwrites it |
| `CASHOUT_ENABLED` / `CASHOUT_MARGIN_BPS` | `true` / `200` | venue cash-out and its margin |
| `RISK_MAX_LIABILITY_CENTS` | `5000000` | how far the market-maker bot may go into debt |
| `RISK_MAX_DAILY_LOSS_CENTS` | `1000000` | bot realised daily loss cap |
| `OPS_TOKEN` | — | required for `/metrics` and the backup control; unset ⇒ they 404 |
| `BACKUP_DIR` / `BACKUP_RETENTION` | — / `24` | scheduled snapshots; unset ⇒ **backups are off** and boot says so |
| `RECONCILE_INTERVAL_MS` | `900000` | scheduled reconciliation cadence |

## Development

```bash
npm test            # 382 checks, 31 suites — unit + API integration, fully offline
npm run test:smoke  # live end-to-end against a real server
npm run test:ui     # 58 checks — real Chromium via Playwright (board + admin desk)
npm run docs:check  # fail if the documentation contradicts the code
```

The suite is dependency-free: plain `assert`, numbered examples, no framework,
no mocks. Tests use in-memory or temporary databases, an ephemeral port, and the
drift loop disabled, so `npm test` needs no credentials and no network. The
browser suite asserts the ladder's *geometry*, not just that cells exist — a
mis-stacked price column looks fine in a screenshot and fails an x/y assertion —
and drives the admin desk end to end.

Contributing, house conventions and where to add things:
[`CONTRIBUTING.md`](CONTRIBUTING.md). Security: [`.github/SECURITY.md`](.github/SECURITY.md).

## Project layout

```
lib/       engine and domain      server.js   HTTP + SSE wiring
public/    frontend (no build)     tests/      31 unit/API suites + smoke + browser + guards
docs/      architecture, rules, feed   data/   SQLite database (gitignored)
```

## Known limitations

**No real-money execution.** The payments machinery ships but no PSP is
integrated, and its reference provider moves no money. No KYC/AML, no age
verification, no licensing path — and no software can supply the licence.

**In-play is absent**: no bet delay modelling, no traded-volume ladder. This
is the difference between a toy and a venue; in-play without honest delay
modelling is where sharps win.

**Not implemented:** accumulators, each-way betting, dead-heat joint-favourite
settlement (held rather than guessed), and cash-out risk capping.

**Cash-out is an uncapped venue risk.** Phase 2 bounds market-maker liability;
nothing yet bounds a player converting positions into guaranteed house payouts.

**Operational:** SQLite is single-writer and synchronous — which is *why* the
sweep is atomic, and a genuine strength — but the ceiling is unmeasured. No
load test ships.

The demo bot's fair prices are a random walk, not a model. Seeded credentials
are committed on purpose for the demo; boot warns loudly and a first-run
password change is required. Never deploy this as-is.

Full list and rationale in
[`docs/EXCHANGE_RULES.md`](docs/EXCHANGE_RULES.md#what-is-deliberately-not-implemented).

## Roadmap

- In-play: bet delay modelling and a traded-volume ladder
- Cap cash-out venue risk in `lib/risk.js`, alongside the bot liability cap
- Integrate a real PSP against the `lib/payments` interface
- Wire the results feed to a live transport (the `fetchResults` seam is ready)
- Dead-heat joint-favourite settlement
- Accumulators and each-way markets
- Odds-history charts and a market-mover view on the board

## Licence

MIT — see [`LICENSE`](LICENSE). © wippa-studios.
