# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Documentation

A full pass against the code, prompted by the screenshots having aged out of
the truth: they were captured before the sport filter moved into the left rail,
so the README's own picture contradicted its own text.

- **The README configuration table was broken.** A prose section had been
  inserted into the middle of it, leaving seven rows stranded after it with no
  header — GitHub rendered them as loose text, and `FEED_STALE_SECONDS` through
  `DELAY_RELEASE_INTERVAL_MS` were effectively undocumented. The section now
  sits after the table.
- **Regenerated every screenshot** against the current UI, and added the one
  that was missing: the board in feed mode reading a **live Betfair collector**.
  `scripts/shoot.mjs` replaces `scripts/capture-screenshots.mjs`; it walks
  seeded mode and feed mode, and refuses to save a capture it has not verified —
  each shot is preceded by DOM assertions that the thing worth showing is on
  screen (the old script produced no assertions at all, which is how seven stale
  images got committed in the first place). `docs/screenshot.png` is gone,
  superseded by `docs/shots/board.png`, and all eight images are wired into a
  README gallery instead of one being referenced and six being orphaned.
- **Three claims contradicted each other.** Dead-heat settlement was listed as
  "not implemented" twice and "working" once; it is implemented and tested, so
  the two stale rows are gone and the roadmap item is struck through.
- **In-play was framed as a gap.** It is a deliberate product decision — the
  venue is pre-off only, and `lib/offtime.js` enforces it — so "Known
  limitations" now says so and links the rules, rather than describing the
  absence of something no venue should want unguarded.
- Badges (CI, MIT, Node, paper-money) on the README; counts resynced across
  README/CONTRIBUTING/WORKSTREAMS (45 suites, 74 browser checks).
- **`docs/API.md` documented none of the feed routes.** Added the four public
  read-only routes — with the response shapes as actually served, including
  `selection_id` as a string (Postgres BIGINT), `back_pct`/`lay_pct` null unless
  both sides are complete, and `data_age_seconds: null` on a Delay key — and
  the six admin credential/supervisor routes, including the 503-with-no-write
  refusal when `FEED_CREDENTIALS_KEY` is unset.
- The 60-second tour no longer says "sports across the top" (they are in the
  left rail) and no longer hands a new user the `demo` login without mentioning
  the mandatory password change that locks it out of trading.

### Fixed

The feed read path was still written against the retired `betfair-market-snapshots`
schema (`markets`, `snapshots`, `market_runners`). Rewritten against the
collector's `v_feed1`/`v_feed2`, and every bug below was invisible until it ran
against a real database with 9,456 books in it:

- **The board rendered empty ladders for every market.** `PRICE_COLUMNS` listed
  `odds_captured_at`, `price_age_seconds`, `publish_time`, `inplay` and
  `bet_delay` — and not `odds`, the per-selection ladder the board is built from.
  Nothing threw. `health()` counts `odds IS NOT NULL` in its *own* query, so it
  reported 9,456 markets with odds while all sixty markets on the board were
  price-free. Two queries, one of them right.
- **`FEED_MARKET_LIMIT` has never actually capped markets.** The limit was on the
  outer select, and the view is one row per *selection* — a Correct Score market
  is 31 rows, so "limit 5" returned one market. The market list is now chosen in
  a CTE and joined back. `limit 60` returns 60 markets.
- **The single-market read carried `LIMIT 1`**, returning one *runner* of a
  twenty-runner market. A single market is now unlimited and filtered by id.
- **The board led with dead markets.** Ordering by start time ascending puts
  already-finished markets first — and those are exactly the ones the odds job
  does not poll, so the top of the board had no prices by construction. Feed 2
  now orders by book freshness; feed 1 still orders by start time, because a
  fixture list is chronological and feed 1 has no prices to be fresh about.
- **`bookPercentages` published `percent_book` while the UI reads `back_pct` and
  `lay_pct`** — fields it never produced, so the ladder headers would have shown
  nothing. It now computes the overround, the sum of 1/price over every runner,
  and reports a percentage only for a **complete two-sided book**. Ten runners at
  1.02 with no lays read ~980% under the old rule; that is one side of a book,
  not a book.
- **`runnerOrder` read `runner_name` but sorts selection objects**, which carry
  `name`, so the numeric-prefix rule never fired and "10" sorted before "2".
- **`nestNav` emitted `events`/`name` where the renderer walks `meetings`/`competition`**,
  which would have emptied the entire nav tree. Caught by reading
  `public/js/nav.js` rather than by a failing test.
- **`health()` leaked the driver error** — host, user and connection string —
  instead of failing closed with the generic message. Caught by the outage suite.
- **`health()` counted selection rows and called them markets** — 81,785 against
  9,976 actual.

### Removed

- **Delta carry-forward and the `carried` flag.** The Stream API sent only the
  runners that changed, so a "latest frame" book was partial and prices were
  carried forward from earlier cycles. The collector polls whole books, so every
  level in a ladder comes from one poll and there is nothing to carry — and the
  flag was never read by the UI in any case. The three tests that covered it went
  with it, replaced by the cases that can now actually occur (a market the odds
  job has not reached; a feed-1 market with no price column).
- `market_count` on nav competitions. One commit introduced it and nothing has
  ever read it.

### Added

- `FEED_NUMBER` (1 or 2) — which feed to read. Anything else is refused at boot
  rather than silently falling back, because falling back would serve prices to a
  venue that asked for fixtures only.
- Six checks pinning the SQL shape, since the omissions above are exactly the
  ones an offline suite cannot catch by joining Postgres.

- **Betfair credentials in the admin dashboard.** An operator supplies an app
  key, username and password per tenant; the exchange stores them encrypted
  (AES-256-GCM) and passes them to the collector as environment variables. It
  never writes a `.env`, which is what lets the collector boot from the
  environment alone.
  - `lib/feedcreds.js`, the `feed_credentials` table, and admin routes for
    status / store / delete. **No route returns a secret** — status reports
    booleans, and no exported function serves plaintext to an HTTP caller.
  - **If `FEED_CREDENTIALS_KEY` is unset, storing is refused with a 503 and
    nothing is written.** There is no plaintext fallback. "Not configured" is
    never quietly treated as "allowed".
  - Every write and every deletion is audited, with sealed values recorded as
    `[sealed]`.

- **Collector supervision** (`FEED_RUNNER_ENABLED`, default off so a venue that
  already runs the collector does not acquire a second copy):
  - `lib/feedrunner.js` spawns `FEED_COLLECTOR_CMD` and restarts it with
    exponential backoff from 5s to 5min. A wrong password produces an immediate
    repeating failure, and retrying that every second is a good way to get a
    Betfair account rate-limited.
  - Credentials go in `env`, never in `argv` — `ps` is world-readable.
  - **Child output is redacted before it is stored or shown.** The collector
    logs its own configuration and a Betfair error can echo a key; captured
    output has known credential values replaced before reaching a log file, the
    admin API, or a support ticket.
  - Storing or deleting a credential restarts or stops a supervised collector,
    so a change can never be silently ignored by a process still running on the
    old one.

- Optional odds feed: `lib/feed.js` reads the feed collector's Postgres
  (`v_feed1`/`v_feed2`) and serves `GET /api/feed/board` + `/api/feed/health`.
  Set `FEED_ENABLED=true` and `FEED_DATABASE_URL`; the board then shows
  recorded Betfair prices instead of the demo bots. Bots and drift are
  suppressed automatically, since two price sources would fight. See
  `docs/FEED.md`.
- `tests/feed.test.js` (15 checks) covering ladder ordering, the delta
  carry-forward case and stale marking; `tests/feed_nav.test.js` and
  `tests/feed_outage.test.js` pin the feed-mode contract in separate processes,
  because `lib/config.js` and the pg pool are both built at import time.
- Companion change in `betfair-market-snapshots`: Alembic migration `0003`
  adds `ix_snapshots_market_pubtime_desc`. Without it, "latest snapshot per
  market" seq-scans and sorts all of history — measured at 99,498 rows where
  the real content was 138.
  *(Historical: `betfair-market-snapshots` has since been replaced by
  [OpenBettingExchangeDataFeed](https://github.com/wippa-studios/OpenBettingExchangeDataFeed),
  which supersedes the recorder, its Alembic schema and this migration. Left in
  place because a changelog records what happened, not what is currently true.)*
- House-account exemption in the money invariant: `CHECK (is_bot = 1 OR
  balance_cents >= 0)`. The house counterparty may go negative (it owes
  `(price-1)*stake` when a bet wins and there is no matched pot to pay from);
  every human account stays non-negative, enforced by the database.
- Feed config: `FEED_ENABLED`, `FEED_DATABASE_URL`, `FEED_STALE_SECONDS`,
  `FEED_MARKET_LIMIT`. A feed that is enabled without a URL, or with a
  non-postgres URL, aborts the launch rather than failing on first request.

### Added
- Light house palette: white ground, black text, light-grey accent. Previously a
  dark theme with an amber highlight. Primary buttons are black-on-white
  inverted rather than a colour, so the only accent is grey.
- Brand assets: the wordmark and favicon from `assets/`, trimmed to their ink
  and served from `public/assets/`. Both are `<img>`s, so the logo's tight -100
  tracking is baked into the file rather than applied in CSS.
- Inter, self-hosted in `public/fonts/` at 400/500/700/800 (woff2, ~10kB each,
  preloaded for the two weights used above the fold). Canva Sans is proprietary
  and cannot be redistributed; Inter is the closest freely-available
  substitute. No CDN dependency.
- Bookmaker-style board navigation: sport -> country -> track -> meeting ->
  race, from `GET /api/feed/nav`. Sport labels come from the recorder's `sports`
  table, so the board shows "Greyhound Racing" rather than event_type_id 4339.
- Feed mode is detected at boot from `/api/feed/nav`; a 409 falls back to the
  seeded catalogue, so the flag is never shipped to the browser as a constant.
- Markets with genuinely one-sided liquidity now say which side is missing
  instead of rendering an empty column.

### Changed
- Runner names in the ladder wrap instead of truncating; the selection column
  widened, so real names ("1. Blue and Gold") are readable.
- The board query is set-based and resolves each `(runner, side)` to its newest
  observation across frames. Betfair's `marketChangeMessage` carries only
  *changed* runners, so the newest snapshot per market is a partial book;
  reading prices from that frame alone made runners blink in and out.

## [0.2.0] - 2026-09-25

### Added
- Betfair-style ladder UI: three back prices, runner + LTP, three lay prices
  per runner, with green/red price-change flashes fed by SSE.
- Bet slip with tick steppers, typed prices snapped to the ladder, live
  profit/liability preview, and per-order placement.
- "My bets": open orders with cancel, matched positions with the if-win P&L
  matrix and cash-out, settled history with commission.
- Wallet: available vs frozen balances, faucet deposits, full transaction ledger.
- Admin trading desk: catalogue creation, suspend/restore, settle dialog
  (winner or void), per-market matched volume and open-order counts, live
  fair-price helper showing American/fractional/implied from the server, and a
  per-market overround (margin or arbitrage) signal.
- Verification: a live end-to-end smoke script (33 checks) and a real-browser
  Playwright suite (24 checks, including ladder geometry, the admin desk and
  zero page errors).
- `GET /api/format/:price` and `GET /api/settlements`; `GET /api/admin/competitions`.
- Repository process: contributing guide, security policy, code of conduct,
  changelog, issue and PR templates, `.editorconfig`, `.nvmrc`.
- `docs/ARCHITECTURE.md`, `docs/EXCHANGE_RULES.md` and `docs/API.md`;
  `docs/screenshot.png` as the board image.

### Fixed
- `GET /api/feed/nav` no longer answers 409 when the feed is disabled. The
  browser probes it at boot to choose a board, and the 4xx logged a console
  error on every non-feed deployment — which failed `npm run test:ui` outright.
  It now always answers 200 with `enabled:false` when off. A configured feed
  whose database is down still answers 503, so a genuine outage is not mistaken
  for "no markets today".

### Security
- `HOST` is validated as loopback-only; a routable bind now aborts the launch.
- Origin guard moved ahead of body parsing so a foreign origin is rejected even
  with a malformed body.
- 5xx responses return a generic message; internals only reach the log.
- Constant-time login for unknown users; expired sessions purged at boot.
- `nosniff` and `same-origin` referrer headers; JSON `404` for `/api/*`.

### Fixed
- Settlement input is validated strictly — `void: "false"` no longer voids a
  market and a boolean can no longer become a selection id.
- Cash-out quotes exclude the caller's own resting orders and pre-validate
  stake, escrow and balance, so a quoted cash-out is executable.
- Drift requotes only the runner whose fair price moved instead of every order
  in the market.
- A fair-priced runner created at runtime is quoted immediately.
- Bet-slip DOM race: rows update in place instead of being rebuilt from inside
  their own input's change handler (fixes `NotFoundError`, preserves focus).
- Ladder layout: each price side is a column stack (CSS grid auto-placement is
  row-major, which had scattered the three prices of a side across columns).
- Typed slip prices are honoured; enum values escaped; async renderers re-check
  container connectivity; the SSE stream rebinds on sign-in/out.
- Seeded fair prices are stored on the ladder (a hand-written `2.75` is not a
  tick in the `2.02–3.00` band).

### Changed
- Money column `CHECK` constraints in SQLite: non-negative integer cents,
  `matched <= stake`, price within the ladder range.
- `registerUser` rejects fractional or negative opening balances.
- Transaction handling centralised in `lib/tx.js` (nested calls use savepoints);
  `placeOrderTx` refuses to run outside a transaction.
- `GET /api/format/:price` and per-market overround on the admin stats are now
  backed by the existing, tested pricing library rather than sitting unused.
- Past-due seeded events roll forward to `live` at boot.
- Board hygiene: past-due fixtures roll forward to `live` at boot.

## [0.1.0] - 2026-09-24

### Added
- Exchange core: order book, matching engine with best-for-taker sweeps and
  partial fills, liability escrow, settlement with commission, cash-out.
- Seeded liquidity bots and a fair-price drift loop.
- REST API, SSE stream, sessions, admin routes, 78-check test suite.
