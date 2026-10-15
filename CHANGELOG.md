# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing in this repository has ever been tagged, and `0.1.0` in the manifest is
the only version that has ever existed. Two dated sections written on the
repository's first two days — `[0.1.0]` and `[0.2.0]` — described releases that
never happened: no tag behind them, no version bump, and contents that are a
snapshot of day 2 rather than of a shipped state. They are folded in here rather
than deleted, so the work is preserved and the record stops claiming a release
history that does not exist. `scripts/check-release-facts.mjs` asserts that this
stays true: every dated heading must have a matching git tag, and the manifest
must agree with the highest released heading.

### Added

- **The feed now drives a real, tradeable, venue-priced book** (#101). With
  `FEED_ENABLED=true` the venue had a board of real fixtures and **not one
  bettable market in it**: a feed market has no row in this venue's database, so
  `POST /api/orders` answered `404 Selection not found` before any collateral was
  taken — and the bots, the venue's only source of liquidity, were force-disabled
  while the feed was on, "because a bot requoting over the observed Betfair book
  would fight the price source". There was nothing to fight: the observed book
  has no row here to name.

  `POST /api/admin/feed/sync` (`requireAdmin`, `limit('admin')`, audited as
  `feed.catalogue_synced`) materialises the feed's catalogue into local `sports` /
  `competitions` / `events` / `markets` / `selections`. It reads the catalogue
  from `nav()` — never from the `FEED_MARKET_LIMIT`-capped board — then fetches
  each market's runners through the contract's existing `market(id)`, at most
  `FEED_BOOK_SYNC_CONCURRENCY` at a time and at most `FEED_BOOK_SYNC_LIMIT`
  markets per run, reporting `bounded.remaining` and `bounded.next_offset` so a
  catalogue larger than the cap is **resumable**. No provider contract change was
  needed, so the conformance suite is unchanged and still the gate.

  **A feed price is never copied into `fair_price` or `ltp`.** A new selection is
  seeded with the venue's own even money (`FEED_BOOK_SEED_PRICE`, default 2) and
  an existing selection's `fair_price` is never written at all, so no re-sync can
  move the venue's own price. `docs/FEED.md` has always named the hazard: *the
  failure mode is not a bad price; it is a good price that a sharp client takes
  from you.* What a real launch price should be derived from is the operator's
  decision (#110/#108), not this repository's.

  Other refusals, each with the failure it prevents: an off time the feed cannot
  express is **refused and reported by name** (`lib/offtime.js` treats an
  unreadable off time as CLOSED, so writing one would produce a market that is
  permanently unbetable); `events.is_demo` is never set, so a real fixture's off
  time is never rolled forward; a market that leaves the feed is **suspended,
  never deleted** — and one that left *after* going off is left open, because
  suspending a finished market would stop it being settled. A **capped** run
  deactivates nothing at all, because "this market is gone" is a claim about the
  absence of a row and the markets past the cap are unread rather than missing.

- **Id translation on the results path, in both directions.** Materialising a
  catalogue gives the venue two id spaces for one race, and the results protocol
  speaks integers in both: `requestBody` POSTed local ids an operator's API had
  never seen, and `normaliseSignal` carried winners and non-runners that
  `applyOutcome`/`applyWithdrawal` filtered against local selection ids. Every
  outcome the feed sent after a materialisation would name selections the market
  did not have — fail-safe and operationally fatal at once, since
  `applyWithdrawal` returns `hold('non_runner_foreign')` and `applyOutcome` takes
  the empty-winner HOLD branch, so nothing settles while a withdrawn runner stays
  quoted.

  A new `feed_map` table stores the identity (a runner's feed id is the
  composite `${market_id}:${selection_id}`, because Betfair reuses selection ids
  across markets). The poll body now carries the feed's ids **alongside** the
  venue's, and `lib/resultsfeed.js` `pollOnce` translates inbound ids through
  `lib/feedcat.js` `admitSignal` before anything reads them, recording **which
  space the feed used** in the `result_events` payload. An id in neither space is
  **held** as `id_space_unmapped` with the market left open; one that reads as
  two different runners across the two spaces is **held** as
  `id_space_ambiguous` rather than settled on a coin flip. A materialised market's
  provenance records the **feed's** market id, which is what finally gives
  `idx_result_events_source` and `alreadyApplied` a re-delivery guard to fire on.

  **Bots are no longer suppressed while the feed is on** (`BOTS_ON` is now
  `config.BOT_ENABLED`): a bot cannot requote over a market this venue has no row
  for, so the suppression protected a conflict the schema made impossible while
  leaving a feed-running venue with no liquidity at all. Drift is still
  suppressed, and #87 is untouched.

- **A feed provider seam, and the conformance suite that makes it safe**
  (STATE.md §2.7, docs/ROADMAP.md §Phase 5). `lib/feed.js` read the Betfair
  collector's PostgreSQL views and nothing else — its SQL was hard-wired to
  `v_feed1`/`v_feed2` — so an Australian operator holding a betting-exchange
  licence who has **their own data-feed API** could use this venue only if their
  feed happened to be Betfair's Postgres views. The alternative was forking
  `lib/feed.js`.

  `FEED_PROVIDER` now selects the implementation behind a contract
  (`lib/feed/provider.js`): `postgres` (the collector, unchanged) or `http` (a
  generic JSON-over-HTTP provider, `lib/feed/http.js`, driven entirely by
  `FEED_HTTP_*` configuration — base URL, resource paths, bearer token or static
  header, timeout, and per-resource field maps that rename a vendor's JSON onto
  the canonical feed shape). `FEED_PROVIDER=postgres` is byte-for-byte the
  previous behaviour; nothing changes for the default deployment.

  **The suite is the deliverable, not an afterthought.** STATE.md §2.7 is the
  design brief: *"an adapter that half-works does not crash, it produces wrong
  prices or wrong market state, which the engine cannot detect."* So
  `tests/feedprovider-conformance.test.js` is a reusable, provider-agnostic
  battery run against **both** providers — the HTTP one against a real
  `node:http` server serving vendor-shaped JSON through a real field map — and
  it includes a deliberately broken MUTANT provider asserted to **fail** it, so
  the battery cannot go vacuously green. `lib/feed/provider.js` refuses to
  register a provider whose name is not in its own capability table, which is
  what puts a new adapter in front of a reviewer who runs the battery. Stated
  precisely, because the other reading is wrong: declaring a provider in
  `lib/feed/provider.js` does not run the suite — the registry cannot, and a boot
  is the wrong place for an offline fixture test.

  There is **one shaper** (`lib/feed/shape.js`), shared by both providers: a
  second one beside the original is a wrong-price bug in the making, because the
  ladder bounds, the pounds→cents conversion and the book-percentage
  completeness rule have each already been got wrong once here. The conformance
  suite asserts the two providers produce **byte-identical** boards and nav trees
  from the same underlying data, and caught two real divergences while it was
  being written.

  A misconfigured field map is a **boot error**, not a warning: an empty map, an
  unknown canonical field, an empty entry, a duplicate or a missing required
  field all abort the launch. A half-mapped feed would otherwise serve markets
  with no id, no name and no runners — an empty board, which reads as a quiet
  Tuesday rather than as a misconfiguration.
- **Compliance seams: customer pre-verification, AML/CTF monitoring, and a
  data-source register.** For an operator going live in Australia. Full rationale
  in [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md).

  **`lib/identity/` — the identity provider seam.** Modelled on
  `lib/payments/provider.js`: a contract with a closed decision vocabulary, an
  `assertProvider` that refuses a half-implemented provider at boot, and a
  network-free reference implementation beside it. **No vendor is built in, and
  that is the deliverable** — which KYC provider an Australian venue may use is
  not a technical question, it is a contract somebody has been through legal
  review on.

  Australian law has required identity verification **before** an online gambling
  account is created since **29 September 2024**, and the interim allowance for
  deferring it was **repealed**. The gate is therefore in the **engine**, not in
  routes: `lib/match.js` `validateOrder` beside the off-time gate and before any
  collateral is touched; `lib/limits.js` `assertTradeable`, the one function every
  money path already calls; `confirmDeposit` before the credit (a check at intent
  creation consumes nothing and gates nothing); and `openWithdrawal` before the
  hold — the one place where custody and play pull in opposite directions, since
  refusing a self-excluded player's own money out is right and paying an
  **unverified** account is not. Each refusal carries a distinct
  `details.code`.

  **Age assurance is a separate record from identity, and separately erasable.**
  The reform bill's explanatory memorandum addresses it separately, provides that
  personal information collected for it must be **destroyed once used**, and
  provides that no Australian is to be forced to use government identification
  for it. So there is **no date of birth on `users`, no document column and no
  image anywhere in the schema** — `age_assurance` holds an attestation and an
  opaque vendor handle, and applying a verification decision erases it **in the
  same transaction**. A tombstone is left so the erasure is provable. The record is
  built to be complete if a privacy-preserving digital-identity network returns
  nothing at all, which is the likely shape of the provision.

  **`lib/aml/` — monitoring against AUSTRAC's published online-betting
  indicators**, as a declarative, operator-inspectable rule table (the
  `lib/voidrules.js` pattern). The rule source is the published indicator, and
  every rule carries its calibration reasoning through `/api/admin/aml/rules`.
  **Calibration is treated as the control, not a detail**: the published
  indicator *"continually bets short-odd favourites and then requests an
  immediate withdrawal"* describes an ordinary exchange customer, and is
  therefore measured as the *distribution of a customer's wins*; "obscure market"
  is this venue's own liquidity rather than an absolute stake; and "large bet" is
  the **escrow**, not the stake, because a lay at 10.0 freezes nine times the
  stake. Tests assert the naive reading does **not** fire.

  Alerts are **persistent findings** that re-surface until a human closes them
  with a written reason — the `lib/jobs.js` reconciliation pattern, in its own
  table because the two have opposite retention answers and opposite audiences.
  **Tipping off is a criminal offence**, so the customer's own surface carries no
  screening outcome at all, staff need a row in an `aml_entitlements` table that
  **ships empty**, and no AML gauge is published to `/metrics`.

  The **AUD 5,000** threshold (from 31 March 2026) is configuration, and crossing
  it creates a **durable obligation**, not a log line — on two bases, so
  structuring is caught. Threshold transaction reports and suspicious matter
  reports are **generated** with their definitions and a machine-readable export.
  **Nothing is submitted to any regulator.**

  **`lib/funding.js` — the deposit intake gate.** A third-party-funded deposit is
  **refused**, not flagged, and the check runs before the credit because NPP/Osko
  transfers are irrevocable with no chargeback. The **Osko trap** is handled
  explicitly: an operator's receiving PayID is normally registered to a
  *contracted processor*, not to the venue, so a naive name match would refuse
  every legitimate Australian deposit. `owner_kind` answers "whose instrument is
  it", and `unknown` is **refused** — an instrument whose owner nobody can state
  *is* the third-party case. Payment methods carry the **terms** under which the
  venue may use them (approved-seller status and the countries it covers), and
  `credit_linked` expresses that credit is a *relationship*, not a name — so
  "accepts Apple Pay" and "accepts a credit-linked instrument" are different
  answers. Funding jurisdiction is screened separately from the session-side gate
  already in `lib/tenants.js`.

  **`lib/datasources.js` — the register.** Racing NSW's rules require an approval
  regardless of where the operator is domiciled or licensed, so the venue needs to
  know per source: owner, approval, permitted uses (**display / store / settle**)
  and expiry. It extends `result_events` with `data_source_id` without changing the
  existing coarse `source` vocabulary, and makes an unattributed settlement
  **visible** rather than inventing a licence attribution for it.

  **`lib/retention.js` — which tables a retention job must not delete**, with a
  reason per table, and `age_assurance` explicitly *exempt from protection*
  because it is the one record that must be destroyed.

  Every new key is in `.env.example` with the default `lib/config.js` uses, and
  the server says **loudly at boot** which of these are not enforced on your
  deployment. A deployment that declares itself regulated with no identity provider
  configured **aborts the launch**.

- **Order lifecycle beyond place/fill/cancel** (#97). `PATCH /api/orders/:id`
  amends the price, the size, or both of a resting order **in one transaction**,
  and `POST /api/orders/bulk-cancel` cancels a **list**. `POST /api/orders` and
  the amend now accept a `persistence` — `LAPSE` or `PERSIST` — and a scheduled
  sweep cancels unmatched `LAPSE` orders when their market turns in-play.

  The amend keeps the order's `id`, and that is the point rather than a detail:
  `id` **is** the queue position, because FIFO inside a price level is
  `ORDER BY price, id`. The only previous way to resize a resting order was
  cancel-then-replace, which moves the order to the **back** of its level —
  silently demoting a market maker behind everyone who arrived after them — while
  also churning the ledger through a release and a fresh escrow, in two round
  trips whose worst split leaves a trader flat when they meant to be hedged.

  Escrow moves by **exactly the delta, in both directions, both sides**,
  through `holdRemainderEscrow` — the same helper the partial-fill path uses, so
  the E14–E18 one-cent rounding cases survive an amend rather than being solved a
  second time. Only the **unmatched remainder** moves; an already-matched
  liability is untouched. The abuse limits apply to the delta rather than to the
  whole order, so an amend that *reduces* a trader's exposure is never refused.

  Bulk cancel validates the whole list before it reads or writes anything (the
  `#29` lesson: no element is ever interpolated into SQL), authorises **every id
  independently**, and returns a **partial result** with one outcome per id —
  cancelling 39 of your own and naming a stranger's id cancels 39 and reports
  that one as `not_found`, identically to an id that does not exist. It is
  `200` whatever the per-order outcomes, because a batch in which most of it
  worked is a success that happened.

  `persistence` defaults to `PERSIST`, which is the venue's **entire previous
  behaviour**: an order that says nothing rests until it matches or is
  cancelled, including across the turn in-play, and a database upgrading into
  this feature has every pre-existing row already correct. `MARKET_ON_CLOSE` is
  deliberately refused, by the API *and* by a database `CHECK` — it means "into
  the starting-price auction", and this engine has no auction and no
  `starting_price` field, so accepting it would store a promise with nothing
  behind it.

  The sweep runs on its **own** timer (`LAPSE_INTERVAL_MS`, default 5s, `0`
  disables with a boot warning) rather than on the in-play delay-release pass:
  shipping it nested inside `DELAY_RELEASE_INTERVAL_MS` made an order's
  time-in-force depend on an unrelated operational toggle, silently, which is a
  worse state for a trader than never having had the feature. It re-reads the
  order and the market's in-play flag inside the write transaction, so an order
  is **either matched or cancelled, never both** — proven under concurrency with
  two OS processes released from one barrier, not single-threaded.

- **A market version on placement** (#92). Every runner and every market now
  carries a monotone `book_version`, exposed on every book the venue serves
  (`GET /api/markets/:id/book`, `GET /api/events`, and the placement response).
  `POST /api/orders` accepts an **optional** `selection_version` /
  `market_version` and refuses the order with a distinct
  `409 { "code": "market_version_stale" }` when the book has moved past
  `MARKET_VERSION_MATERIAL_THRESHOLD` (default 2) since the client read it.

  This closes a correctness gap in the money path rather than a fidelity gap.
  Snapping an off-ladder price is deliberate and unchanged — `snapToTick` still
  corrects, and #37 fixed the validation branch around it. What was missing was
  the version **handshake**: a client that read a ladder and sent an order had it
  placed at whatever the ladder said by then, answered `201`, and could not tell
  "accepted and did not match" from "accepted at a price I did not intend".

  The version advances on a fill, a cancel and a suspension/resumption. Both
  fields are optional and **omitting them preserves the previous behaviour
  exactly**, so no existing caller breaks; a malformed version is a `400` rather
  than a silent pass, a version ahead of the venue is refused, and an idempotent
  retry is never refused. The comparison runs inside the placement transaction —
  a control the synchronous engine makes easy, and one a Postgres rewrite would
  make subtle. The rationale for the threshold, and what would make it wrong on
  a different venue, is in `docs/EXCHANGE_RULES.md`.

- **Player-authored betting rules** (`lib/userrules.js`, second piece of the
  user-bots programme). A rule is a declarative record — *if this runner's price
  goes below (or above) this threshold, place this side at this stake* — and it
  places its order through the **same** `placeOrder` a person's click uses, so
  every per-user abuse limit, the in-play bet delay and the escrow contract
  apply unchanged. Three live rules per user, counted server-side.

  Evaluation runs server-side in `lib/drift.js`, immediately after a selection's
  fair price moves and before the bot requote, inside the drift transaction. That
  is the only place in the codebase that moves a price, so there is no second
  source to drift out of step with; it is not hooked to the SSE stream, because
  an SSE client is a viewer and hooking there would make evaluation depend on
  somebody having a tab open. Killing the process stops evaluation by
  definition.

  v1 is deliberately narrow and the narrowness is the safety property: no
  expression column, no script, no `eval`, and no free-text column the engine
  reads. Rules are one-shot per **crossing** and re-arm when the condition
  lifts — narrower than the continuous semantics the product decision chose,
  which is the next piece of work (it needs a cool-down and a fire count). A
  rule created while its condition already holds starts disarmed, and a rule
  that fires without the funds is refused, counted and **not retried**.

- **`orders.rule_id` is now written by the INSERT** rather than left to the
  caller, so an automated order is marked automated at the instant it starts
  matching. It was not client-settable before this and is not now:
  `POST /api/orders` builds its argument field by field, so a `rule_id` in a
  request body never reaches the engine.

- **A selection-level void** (`settle.voidSelection`), distinct from the
  market-level one, for a runner withdrawn from a market that is still on. It
  cancels resting orders on that selection and releases their escrow, refunds
  its matched legs at the match price, and marks the selection `void` — without
  touching any other runner. Until this existed the only void in the venue was
  scoped `WHERE market_id = ?`, so there was no way to remove one runner at all.
  An operator reaches it at
  `POST /api/admin/markets/:id/selections/:selectionId/void` (reason required,
  audited by the primitive inside the refund's own transaction, and a refund
  that cannot be audited does not happen).

- **A withdrawn runner can be expressed as a signal, before or after the off**
  (`results.applyOutcome`). `{ non_runners: [ids] }` with no `status` is a
  withdrawal notice: the runner is removed and refunded and the market stays open
  and tradable. A `completed` outcome carrying `non_runners` settles the market
  on its winner and voids the withdrawn selections on the way — a fourth decision,
  `settle_with_voids`, in `lib/voidrules.js`.

- **`markets.payout_shape`**, declared at creation as `win` (the default) or
  `place`. It exists so an operator can say "this market is not the one shape
  this engine settles". A `place` market whose outcome depends on a withdrawal is
  **held** with the reason recorded, rather than settled with arithmetic that
  would be wrong for every place bettor in it.

- **The house no longer fills an automated order** (#67), in both directions.
  The sweep refuses a crossing where exactly one side is the house *and* exactly
  one side is automated; a rule taking the desk's resting quote is the same
  conflict of interest with the words reversed. Two players, or the house
  against a manual order, are untouched. This was not enforced by the
  self-match work it shipped alongside.

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

- Exchange core: order book, matching engine with best-for-taker sweeps and
  partial fills, liability escrow, settlement with commission, cash-out.
- Seeded liquidity bots and a fair-price drift loop.
- REST API, SSE stream, sessions, admin routes, 78-check test suite.

### Changed

- **The two self-match properties that were pinned structurally are now
  behavioural tests** (`tests/selfcross.test.js`). Automated-as-taker and
  bot-vs-bot both needed an order that was automated *and* was the taker, which
  was impossible while `rule_id` was written after placement; the source-level
  regexes that stood in for them are deleted rather than left in place as
  coverage that checks nothing.

- `lib/odds.js` exports `priceToCents` / `centsToPrice`. A rule's condition is a
  strict comparison against a threshold, and in doubles "is 2.00 strictly below
  2.00" depends on which side of the representation boundary each value fell.

- **Express 4 → 5** (issue #74). Dependabot's bump would not have booted: Express 5
  compiles routes with path-to-regexp v8, which removed the optional-parameter
  syntax `:id?`, and three routes used it —
  `PUT`/`DELETE /api/admin/feed/credentials/:id?` and
  `GET /api/admin/feed/runner/:id?`. Those are **top-level** registrations, so
  the router threw `Unexpected ? at index 31` while `server.js` was being
  `require`d and the venue did not start at all. Each is now registered twice,
  with and without `:id`, reaching one handler; the `?` was decorative, as no
  handler ever read `req.params.id` (the tenant always came from
  `feedTenantId(req)`, which is the caller's own and refuses any other). The
  documented id-less forms therefore keep working.

  Three further Express 5 differences were audited rather than assumed, and none
  required a behaviour change — the reasons are in the source and the checks:
  `query parser` is now pinned explicitly to `simple` (no route reads nested
  bracket syntax; the audit is re-run mechanically); every `req.body` read was
  already guarded for `undefined`, which matters more now that Express 5 leaves
  it `undefined` rather than `{}`; and every async handler already handles its own
  rejection, so Express 5's automatic forwarding has nothing new to forward.

  The one real behaviour change: `errorHandler` now hands a post-response error
  to `next(err)` instead of writing a second response onto a finished one. Express
  5 forwarding a rejected promise widens the window in which that can happen, and
  the old behaviour logged `ERR_HTTP_HEADERS_SENT` on top of a request that had
  already succeeded.

  `playwright` moves 1.62 → 1.64 (dev-only). `tests/express5.test.js` adds 19
  checks, including one that asserts the installed Express major version is 5 so
  the migration cannot be reverted behind a green suite.

  **Correction to issue #74:** `app.param()` was listed as one of the removed
  APIs. It is not removed — it is still a function on an Express 5 application.
  It is unused here, so nothing changes, but the claim was wrong.
- Runner names in the ladder wrap instead of truncating; the selection column
  widened, so real names ("1. Blue and Gold") are readable.
- The board query is set-based and resolves each `(runner, side)` to its newest
  observation across frames. Betfair's `marketChangeMessage` carries only
  *changed* runners, so the newest snapshot per market is a partial book;
  reading prices from that frame alone made runners blink in and out.

- Money column `CHECK` constraints in SQLite: non-negative integer cents,
  `matched <= stake`, price within the ladder range.
- `registerUser` rejects fractional or negative opening balances.
- Transaction handling centralised in `lib/tx.js` (nested calls use savepoints);
  `placeOrderTx` refuses to run outside a transaction.
- `GET /api/format/:price` and per-market overround on the admin stats are now
  backed by the existing, tested pricing library rather than sitting unused.
- Past-due seeded events roll forward to `live` at boot.
- Board hygiene: past-due fixtures roll forward to `live` at boot.

### Security

Found by an adversarial pass against the running system. Two were critical.

- **`opsGuard` was inverted, leaving `/metrics` and the backup control open.**
  `if (publicRoute || OPS_TOKEN) return next()` skipped the check exactly when a
  token existed, and `x-ops-token` was never read anywhere in the codebase — so
  the token was configured but never enforced. Measured: `OPS_TOKEN` set,
  `/metrics` with no credential answered **200**. Now the token must be
  presented (`x-ops-token` or `Authorization: Bearer`, compared in constant
  time) whenever one is configured, and `/healthz` + `/readyz` stay public so a
  supervisor is not locked out by a misconfigured token. Unset still means 404,
  so nothing leaks and a scanner learns nothing.

- **A withdrawal moved money, returned 500, and wrote no audit row.**
  `audit.record(...)` at three call sites; the module is imported as `AUDIT`. The
  payment-intent completion path called `PAY.completeWithdrawal()` FIRST, so the
  transfer committed, the handler then died on a `ReferenceError`, the operator
  saw "Internal error", and `audit_log` recorded nothing. A silent, unaudited
  money movement behind a 500. Fixed at all three sites.

- **The collector child inherited every venue secret.** `env: { ...process.env }`
  handed the child `PAYMENTS_WEBHOOK_SECRET` — the HMAC key authorising the
  deposit webhook — plus `OPS_TOKEN` and the seeded `ADMIN_PASSWORD`. The
  collector is the one component with outbound internet access, running
  third-party Python from another repo. Now built from an allowlist (`PATH`,
  `LANG`, `HOME`, `TZ`, cert paths) plus the three decrypted Betfair fields.

- **Unauthenticated CPU exhaustion via login.** `crypto.scryptSync` blocks the
  event loop, and the rate limiter was keyed per USERNAME — so an attacker
  minted a fresh username per request and touched no limit at all. Measured:
  120 logins at concurrency 20 took `/api/sports` from a 1.6 ms median to
  **723 ms** (p95 1568 ms), ~460x, with orders, matching, settlement, SSE and
  the admin desk all stopping together. Added a per-SOURCE counter: verified 110
  of 120 attempts now rejected with the board median back to 1 ms.
  The two counters deliberately have different numbers — the IP key is a brake
  on CPU cost, not a brute-force defence, so it needs a higher threshold (30)
  and a short non-escalating lock (60 s). Sharing one threshold locked out
  everyone behind a single NAT after ten failures, which the API suite caught.

- **A results-feed redirect could settle real markets from a host nobody
  configured.** The transport validates the SHAPE of an outcome but never the
  IDENTITY of the responder; following a 302 discards exactly the trust the
  operator placed in `RESULTS_FEED_URL`. Measured: a feed that redirects to a
  loopback service settles a real market from that service's answer. Now
  `redirect: 'error'`.

- **`RESULTS_FEED_SECRET` was never sent on the manual poll.** `pollNow()` fell
  back to a fetcher with no secret, so "Poll now" always 401'd against an
  auth-enforcing provider while the timer worked — and config only warns when
  the secret is UNSET, so an operator who had set it got a clean bill of
  health. The route now builds the same authenticated fetcher as the job.

- **HTML injection in the admin audit "Change" cell.** `auditChange()` was the
  only unescaped interpolation in the client. CSP blocked script execution but
  not `form-action`, so the residual risk was phishing/UI redress inside the
  admin desk. Now escaped like every other cell.

- **The financial self-check was permanently red once cash-out was used.** The
  buyout subquery correlated `matches.market_id IN (SELECT id FROM
  cashout_quotes …)` — `id` being the quote row's PRIMARY KEY, an unrelated id
  space. Measured: a buyout taking over 41,648 cents of stake reported
  `venue_took_over_cents: 0`, so `self_check_ok` flipped false on the first
  cash-out and stayed false, on a ledger that is provably conserved. A control
  that is always red is one operators learn to ignore. Now joined on `market_id`,
  and the case that was never tested — a book that used cash-out — is.
- **A self-excluded account could still fund itself.** `assertTradeable` ran on
  `/api/orders` and `/api/markets/:id/cashout` but not on the faucet or
  `/api/wallet/deposit-intent`, so an excluded account kept acquiring funds,
  and the per-call faucet cap is trivially looped. Both funding paths now refuse.
  **Withdrawal is deliberately still open** — refusing to let someone take their
  own money out is a worse failure than the gap.
- **Absent `BACKUP_DIR` surfaced as a generic 500.** "Internal error" for a
  missing configuration. Now 409 naming the setting to set, and a real backup
  failure reports why.

- `HOST` is validated as loopback-only; a routable bind now aborts the launch.
- Origin guard moved ahead of body parsing so a foreign origin is rejected even
  with a malformed body.
- 5xx responses return a generic message; internals only reach the log.
- Constant-time login for unknown users; expired sessions purged at boot.
- `nosniff` and `same-origin` referrer headers; JSON `404` for `/api/*`.

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

- **`accounts.currency` was a decorative column** (#104). It was written with
  the literal `'USD'` and read by **nothing**, so it recorded nothing about what
  a bucket was denominated in and nothing validated it. The issue named eight
  sites; there were eight — two in `lib/accounts.js`, four in `lib/payments/`
  (two of them a `currency = 'USD'` **default parameter** that the module's own
  caller ignored by passing a literal in its place), and two column defaults in
  `lib/store.js`.

  **A venue now trades in exactly one currency**, set by `VENUE_CURRENCY`
  (`AUD`) and carried on the tenant. It is read — never written-and-forgotten —
  at five choke points: `accountId()` asserts the currency of the account it
  resolves, `post()` refuses a set of postings spanning two currencies,
  `confirmDeposit()` refuses to credit an intent in a currency that is not the
  payer's tenant's, `configure()` refuses a tenant off the venue's currency, and
  the browser's one formatter renders the code `/api/branding` publishes.

  **The silent no-op is now loud.** `accounts`' unique index is on
  `(kind, IFNULL(user_id, 0))` and does not span currency, so one player has one
  `player_funds` bucket and the venue one `house_float`. An `INSERT OR IGNORE`
  of a second currency hit that index, was ignored, and the caller carried on
  holding the account that already existed — in the wrong currency, with no
  error. A control that reports success while doing nothing. `ensureAccountRow()`
  now reads the row back and compares its currency.

  Also: the browser's `fmt`/`signed` had a hard-coded `'$'`, so a white-label
  venue painted every amount with a dollar sign — as did four hard-coded
  `$10/$50/$100/$1,000` faucet chips in the wallet. `createDepositIntent` and
  `createWithdrawal` kept their `currency` parameter and lost its `'USD'`
  default, because the signature has to be right for the real PSP integration
  that module exists to make room for; with no default, omitting it is a
  `TypeError` rather than a silent booking in dollars.

  Per-player **multi-currency (option B) is deliberately not implemented**. It
  needs `accounts.tenant_id`, a unique index that spans currency, a rate source,
  and a written rounding policy — because the natural conversion point is
  settlement, which is the worst place in this codebase to introduce a rounding
  decision. See [`docs/EXCHANGE_RULES.md`](docs/EXCHANGE_RULES.md#currency).

  *This is not a behaviour change for the default deployment's arithmetic:
  `postings` still sum, and the existing suites were untouched. What changes is
  that a currency nobody chose can no longer be recorded silently.*

- **A declared non-runner was settled as a loser** (#88, `priority:P0`,
  `area:money`). A race that completed with one runner withdrawn — the ordinary
  case, since a horse is pulled and the rest of the field runs — settled as a
  clean finish: the withdrawn runner's backers were charged their **full stake**
  as though their horse had run and lost, and the selection stayed `open`, still
  quoted in the ladder and priced into the positions P&L matrix. The books
  balanced throughout. Conservation could not see it, because the money went
  somewhere real — just to the wrong person — which is the same blind spot as the
  `greyhounds`/`greyhound` slug mismatch.

  Two causes, one root. `ruleKey` consulted `non_runners` only under
  `status === 'abandoned'`, so the `non_runner` rule was reachable only for a
  race that was abandoned *and* had a withdrawal list — a case `abandoned_other`
  already refunded — and unreachable for the one it exists to handle. And the
  rules table is now consulted **per sport**: a signal is only evidence for a
  sport whose rules define it, so a stray `non_runners` on a football fixture
  changes nothing while a racing one voids that selection.

  `non_runners` is now an independent fact rather than a sub-case of `abandoned`,
  because "a horse was withdrawn" and "the race was abandoned" are orthogonal: an
  abandoned race is refunded in full either way, and a completed one settles on
  its winner either way. Malformed ids are dropped rather than coerced
  (`Number(true) === 1` would void a real runner on a horse that raced), and a
  withdrawn selection's matched legs are excluded from settlement and from
  cash-out, because their escrow has already gone back to the players.

- **A withdrawal that also names the winner as withdrawn, one that names a
  selection from another market, one for a sport with no withdrawal rule, and one
  on a `place` market are all HELD** rather than resolved. Each costs money in one
  direction or the other — paying a runner that never started, or not paying the
  runners that did.

  And the ordering: a withdrawal followed by a **market** void refunds each leg
  exactly once. `markSettled` stamps `status = 'void'` onto every selection when a
  market is voided, so the aggregation can no longer tell which runner a
  withdrawal had already refunded — reading it that way either double-refunded
  (refused as "releasing more than frozen", rolling back the whole payout) or
  refunded nothing and stranded every backer's escrow, and both reported the
  market `settled`. The set of already-refunded ids is now read *before* the
  outcome is stamped.

- **A market void refunds nothing.** `markSettled` sets every selection to `void`
  *before* the legs are aggregated, so the new "skip voided selections" filter hid
  every match from a market void. The filter is now conditional on the market not
  being voided, and `tests/settle.test.js` (S4, S10) covers it.

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

And one defect in this area was not about the feed schema at all (#85), which is
why it is recorded separately: **the feed-health pair had drifted apart.**

- **A stale feed and an unreachable feed answered byte-identical `503`s**, and the
  log line beside them read `h.error || h.detail` — two fields `healthPayload`
  never sets, so it printed `(no detail)` on every stale feed, every time. An
  operator with an empty board could not tell "the collector stopped polling"
  from "the collector's database is down": different pages of the same runbook,
  one answer. `odds_age_seconds`, the number that separates them, was computed,
  published on the healthy path, and discarded on the only path that needed it.
  `/api/feed/health` now answers `503` with `code: "feed_stale"` and the measured
  `odds_age_seconds` beside the `stale_after_seconds` it exceeded, or
  `code: "feed_unavailable"` with `odds_age_seconds: null` when the probe never
  reached the recorder. Both bodies still go through the one `apiError()` shaper.
- **THE SAME BUG WAS ALREADY FIXED, AT THE TWIN SITE.** The boot line carried
  this defect with its history written out and a test pinning the correction, and
  the HTTP route 80 lines below was missed — because the rule had been copied into
  two places and only one of them had a test. The rule now lives once, in
  `lib/feed.js` as `classifyHealth` next to the payload it reads, and
  `tests/feedboot-line.test.js` drives both readers with the same fixtures, so a
  second copy of the discriminator fails the suite instead of the shift.

- `GET /api/feed/nav` no longer answers 409 when the feed is disabled. The
  browser probes it at boot to choose a board, and the 4xx logged a console
  error on every non-feed deployment — which failed `npm run test:ui` outright.
  It now always answers 200 with `enabled:false` when off. A configured feed
  whose database is down still answers 503, so a genuine outage is not mistaken
  for "no markets today".
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
