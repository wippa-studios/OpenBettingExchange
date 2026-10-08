# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Optional odds feed: `lib/feed.js` reads the `betfair-market-snapshots`
  recorder's Postgres and serves `GET /api/feed/board` + `/api/feed/health`.
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
