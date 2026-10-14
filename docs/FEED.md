# The Betfair feed

OpenBettingExchange can take its fixtures and prices from
[OpenBettingExchangeDataFeed](https://github.com/wippa-studios/OpenBettingExchangeDataFeed)
— a standalone collector that owns the Betfair connection and writes to
PostgreSQL. The exchange only **reads** that database. Neither project imports
the other, and neither writes to the other's tables.

```
  admin dashboard                OpenBettingExchangeDataFeed
  (app key, username,     ───►   Betfair API  ──►  collector  ──►  PostgreSQL
   password)                            │
                                        │  fixtures · markets · runners
                                        │  prices · ladders · results
                                        ▼
                               OpenBettingExchange
                               lib/feed.js ──read──► v_feed1 · v_feed2
```

If the collector stops, the board goes stale. Nothing corrupts.

**What this is: a price *observation* surface.** Real fixtures, real kick-off
times, a reference ladder, and an operator panel that says how old the data is.

**What this is not: a second book.** Nothing the feed shows can be bet. Turning
it on does not merge a Betfair market into the exchange; it bolts a read-only
view of one onto an engine that keeps trading its own catalogue. That boundary
is enforced by the engine, not by the client, and it is deliberate — see
[Feed markets are display only](#feed-markets-are-display-only).

One more thing to say before the detail: this document is written from
`lib/feed.js`, `lib/feedcreds.js`, `lib/feedrunner.js`, `lib/resultsfeed.js`,
`lib/results.js`, `lib/config.js` and `server.js` in **this** repository.
Claims about the collector — its views, its cadence, its Betfair settings — are
checked against that project's `betfeed/schema.sql` and `betfeed/config.py`, and
are marked as the collector's. Where this repository's code disagrees with one of
them, that is called out rather than smoothed over.

---

## Overview and the display-only boundary

| | |
| --- | --- |
| Owned by | [`lib/feed.js`](../lib/feed.js) — read-only SQL and row shaping |
| Data source | the collector's PostgreSQL, reached over `FEED_DATABASE_URL` |
| Direction | reads only; there is no code path that writes to the feed database |
| Tradeable | **no.** A feed market has no row in this venue's database |
| Side effects on the venue | bots and drift are force-disabled while the feed is on |

The read side is four routes, all public (no session required):

| Route | Answers | When the feed is off |
| --- | --- | --- |
| `GET /api/feed/board` | a capped list of markets with ladders | `409` |
| `GET /api/feed/market?id=` | one market's full ladder | `409` |
| `GET /api/feed/nav` | the sport → country → competition → event → market tree | `200` with `{ enabled: false, sports: [] }` |
| `GET /api/feed/health` | row counts, price age, whether the key is delayed | `409` |

Every one of them returns `503 { "error": "Odds feed unavailable" }` when the
feed database cannot be read. The message is deliberately generic: a `pg` driver
error embeds the host, the user and often part of the connection string, so the
detail goes to the server log and the client gets a status that is
uninformative but true.

### Feed markets are display only

This is the most important rule in this document.

> **A feed market cannot be bet.** Naming a feed selection id on
> `POST /api/orders` returns **404**, refused before any collateral is taken.

The reason is structural. A feed market has **no row in this venue's database** —
it lives only in the collector's Postgres. `lib/match.js` resolves a selection by
joining `selections → markets → events` in the local store, so a feed selection
id resolves to nothing and the engine raises `404 Selection not found`. That
happens inside `validateOrder`, which runs before the escrow call, so nothing is
frozen and no limit is consumed. To trade a feed market you would have to create
a local market, copy prices onto it, and then the venue is betting at a price
that is five minutes old and derived from someone else's book. The failure mode
is not a bad price; it is a good price that a sharp client takes from you.

`tests/feed-display-only.test.js` asserts all three legs of this: the selection
does not exist locally, the engine refuses the order, and the client refuses it
too.

So the feed is used for two things the venue genuinely needs:

- **a real fixture list** — real competitions, real kick-off times
- **a reference book** — what the market looks like elsewhere

### Turning feed fixtures into tradeable markets

Creating a local market that mirrors a feed fixture is supported and is the way
to run your own book on real fixtures. It is a **deliberate, explicit act**: a
local market is created with **no price**, and the venue quotes its own. The
mapping from feed market to local market is 1:1 and is never inferred — see
[EXCHANGE_RULES.md](EXCHANGE_RULES.md).

Read [What feed mode does NOT do](#what-feed-mode-does-not-do) before planning
around that, because in feed mode the venue has no price source of its own.

---

## Two modes, and what each is for

The datafeed publishes **two** feeds from one collector. Which one a venue uses
is its decision, and it is a real one:

| | **feed 1** | **feed 2** |
|---|---|---|
| Contents | fixtures, markets, runners | feed 1 **+ prices, ladders, results** |
| Price data | structurally impossible — no price column exists in `v_feed1` | joined in from `market_odds_current` |
| Collector cadence | 12 h (`FIXTURES_INTERVAL_MINUTES`) | 5 m (`ODDS_INTERVAL_MINUTES`) |
| Board order | by start time — a fixture list is chronological | by book freshness — a price board is not chronological |
| Health `ok` | always `true` | `false` once the newest book is older than `FEED_STALE_SECONDS` |
| Use when | the venue sets **its own odds** and only wants a real fixture list | the venue wants a **reference book** and fresher settlement |

`FEED_NUMBER` selects which one the venue reads (default `2`), and
`lib/config.js` validates it as the integer `1` or `2` — a value that silently
fell back to a default would either serve prices to a venue that asked for
fixtures only, or hide the price column from one that wanted it.

Both are the same contract document, differing only in whether `price` is
populated. One implementation, so they cannot drift apart.

### Feed 2's results ride its odds job

Feed 2's odds job captures a market book every 5 minutes and each book carries
its own result, so the collector publishes results at that cadence. Feed 1's
results sweep rides inside its fixtures job, which defaults to every 12 hours — a
match finishing at 14:00 may not produce a result until 02:00. Lowering
`FIXTURES_INTERVAL_MINUTES` in the collector fixes that; that job requests no
price data, so polling it more often does not burn market-data weight.

Note what that is worth to *this* venue: the collector publishes the result, and
nothing in this codebase reads it to settle. See
[The results feed](#the-results-feed).

### A resolved market stays readable

The collector marks a settled market inactive so its odds job stops polling it.
Both views still publish it, for seven days. That matters more than it sounds:
filtering on "active" alone removed every settled market from both feeds, so the
result was collected, stored, and then made invisible to every consumer.
Measured on a real collector run: six rows in `market_result`, zero visible in
`v_feed2`.

A **non-runner never voids a market.** `REMOVED` is an input to settlement, not an
outcome: a football fixture with one late withdrawal must not be reported as a
cancellation. In `lib/voidrules.js` a non-runner list only changes the outcome
when the signal is `abandoned` — a `completed` signal that happens to name a
withdrawn runner settles normally — and `VOIDED` is the only status that voids.

### Feed 1 is supported, and it loads

`FEED_NUMBER=1` used to be a dead configuration. `FEED_COLUMNS` ended in a
trailing comma and the price block was appended after it, so the generated
statement for an unpriced feed was

```sql
SELECT ... v.selection_status,
  FROM v_feed1 v
```

— a Postgres **syntax** error, not a semantic one. Every `fetchBoard` and
`fetchMarket` call threw and the route turned it into a flat
`503 Odds feed unavailable`, so a feed-1 deployment had a board that could not
render at all. The separator now belongs to the **optional** block, which makes
the assembled list well-formed whether or not the price columns are present.

What a feed-1 board actually contains:

| Field | Feed 1 |
| --- | --- |
| `selections[].back` / `.lay` | empty arrays — there is no price column to read |
| `poll_age_seconds`, `age_seconds` | `null` |
| `stale` | `true` — correct: there is no ladder that could be out of date |
| `back_pct` / `lay_pct` / `percent_book` | `null`, with `runners` still counted |
| `in_play`, `bet_delay` | `false` / `null` — both columns are selected only on feed 2 |
| ordering | `market_start_time`, then market id, sort priority, selection id |

**The board's order is the query's, on both feeds.** `fetchBoard` used to end
with a start-time sort, which silently re-keyed the order the SQL had chosen —
and the comment above `boardSql` argues at length that feed 2 must lead with the
freshest books, because start-time ordering puts the *already-finished* markets
first and those are exactly the ones the odds job stopped polling. The sort made
that reasoning dead text and left `ORDER BY v.odds_captured_at DESC` relevant
only to which markets survived the CTE `LIMIT`. It is gone; `shape()` groups
rows and decorates them, in the order the statement returned them.

`?limit=` with a blank, a zero or a negative now falls back to
`FEED_MARKET_LIMIT` instead of clamping to one market. `Number('') === 0` is
finite, so the old `!Number.isFinite(n)` guard let the most likely junk a URL
produces through to `Math.max(1, 0)` — a one-market board, no error, no warning.
The 500 ceiling still applies.

Every market carries `sport_id`, read from `v.event_type_id` — the column
`NAV_SQL` already aliased correctly. The board field used to read
`row.sport_type_id`, which no view has, so it was `undefined` on every response
while its name promised otherwise.

`/api/feed/health` on feed 1 answers from `v_feed1`, with the price aggregates as
**typed nulls** rather than unknown columns — the probe can run, and can still
fail:

```jsonc
{
  "ok": true,           // nothing on feed 1 can go stale — there are no prices
  "feed": 1,
  "priced": false,
  "markets": 1234,      // count(DISTINCT market_id), NOT count(*)
  "markets_with_odds": 0,
  "resolved": 210,
  "odds_age_seconds": null,
  "oldest_odds_age_seconds": null,
  "data_age_seconds": null,
  "app_key_delay": true,
  "app_key_delay_source": "assumed",   // the probe could not read it; see below
  "delay_note": "…"
}
```

The probe used to be hardcoded to feed 2's view, which meant a feed-1 deployment
was probed against a view its board never reads: the probe passed while every
board request failed, and an operator holding a green health check and a dead
board had nothing to connect them.

**One exception**, and it is not fixed: `GET /api/feed/nav` reads `v_feed2` on
feed 1. See [Known gaps](#known-gaps).

---

## Enabling the feed

```
FEED_ENABLED=true
FEED_DATABASE_URL=postgres://collector@localhost:5432/betfair_feed
FEED_NUMBER=2
```

With `FEED_ENABLED=true` and no `FEED_DATABASE_URL`, `lib/config.js` **aborts the
launch** rather than failing on the first board request with a driver error. A
switch that is on but unconfigured is a misconfiguration, and a venue that boots
and then serves an empty board is harder to diagnose than one that refuses to
start.

A `.env` file is read if present (`lib/config.js` loads `./.env`, then process
environment wins), but the exchange **never writes one**. Credentials are passed
to the collector as environment variables, which is why the collector can boot
with no configuration file at all.

On boot with the feed on, the server logs what it suppressed and what it found:

```
[feed] on — bots suppressed (feed owns prices)
[feed] on — drift suppressed (feed owns prices)
[feed] odds feed connected — 9976 markets, newest frame unknown
```

The two suppression lines print only when `BOT_ENABLED` / `DRIFT_ENABLED` were
on, since suppressing something already off is not news. The connection line
reads `health()`'s `age_seconds` and `stale`, and `health()` returns
`odds_age_seconds` and neither — so it always prints `newest frame unknown` and
never appends `(STALE)`. The freshness numbers are on `/api/feed/health`.

---

## Configuration

Every `FEED_*` key, with the default read from `lib/config.js`:

| Key | Default | Effect |
| --- | --- | --- |
| `FEED_ENABLED` | `false` | read fixtures and prices from the feed. Display only |
| `FEED_DATABASE_URL` | `''` | collector's Postgres URL. **Required** when the feed is on, and must match `postgres://` or `postgresql://` |
| `FEED_NUMBER` | `2` | which view to read: `1` fixtures only, `2` prices and results. Validated as the integer 1 or 2 |
| `FEED_STALE_SECONDS` | `300` | age beyond which a price is reported stale. Range 30–86400 |
| `FEED_MARKET_LIMIT` | `60` | markets returned to the board. Range 1–500 |
| `FEED_CREDENTIALS_KEY` | unset | 64 hex characters, the AES-256-GCM key. Unset means credentials are **refused** |
| `FEED_RUNNER_ENABLED` | `false` | supervise the collector as a child process instead of running it separately |
| `FEED_COLLECTOR_CMD` | `betfeed collect` | split on whitespace, so an absolute path or a wrapper works |
| `FEED_RUNNER_MIN_UPTIME_SECONDS` | `120` | uptime a child must reach before a restart counts as healthy. Range 0–86400 |

Two of these are worth their own paragraph because a wrong value is worse than a
missing one.

**`FEED_MARKET_LIMIT` caps MARKETS, not rows.** The view holds one row per
(market, selection), and a cap applied to the outer select silently capped
*selections* instead — a Correct Score market alone is 31 rows, so a cap of 20
returned two markets. The market list is now chosen first, then joined back for
the full runner set. `?limit=` on `/api/feed/board` is clamped to `[1, 500]`, and
the same clamp is applied inside `lib/feed.js` so a direct caller cannot ask for
unbounded catalogue work.

**`FEED_STALE_SECONDS` is about prices.** It is compared against
`age_seconds`, which is our poll age. On feed 1 there is no price, so
`age_seconds` is `null` and every market reads `stale: true` — which is the
truth about a feed with no prices in it, not a bug.

Two more variables are read straight from the environment rather than through
`lib/config.js`:

| Variable | Default | Effect |
| --- | --- | --- |
| `RESULTS_POLL_INTERVAL_MS` | `60000` | results-feed poll cadence. `0` disables the job |
| `FEED_COLLECTOR_VERBOSE` | unset | `1` relays the collector's scrubbed output to the server's own stdout |

---

## Betfair credentials: per tenant, sealed, never returned

The collector needs exactly three things from Betfair: an app key, a username
and a password. There is no certificate option, because Betfair's Delay key
authenticates with a password and has no certificate to offer — offering an
upload would imply support a Delay key cannot use.

### Routes

| Route | What |
| --- | --- |
| `GET /api/admin/feed/credentials` | the caller's own tenant's status, as a one-element list |
| `GET /api/admin/feed/credentials/:id` | one tenant's status |
| `PUT /api/admin/feed/credentials/:id?` | store all three fields; restarts a supervised collector |
| `DELETE /api/admin/feed/credentials/:id?` | remove them; stops a supervised collector |

All four are `requireAdmin` plus the admin rate limit. **No route returns a
secret.** `status()` reports `app_key_set`, `username_set` and `password_set` as
booleans, and deliberately not who set them — knowing who touched a credential
is audit-trail information, not dashboard information.

`login_mode` is reported too, and is always `password`: the store writes that
literal. Betfair's Delay key authenticates with a username and a password and
has no certificate to offer, so there is no mode to choose.

`lib/feedcreds.js` exports no function that serves plaintext to an HTTP caller,
and `tests/feedcreds.test.js` asserts that adding one would be a deliberate act.
One function returns plaintext — `forCollector()` — and its only consumer is the
code that builds the child process's environment.

### The tenant comes from the actor, not from the URL

The scope is derived inside `lib/feedcreds.js` from the authenticated actor, and
a tenant named in the request is **refused rather than obeyed**:

| Named tenant | Answer |
| --- | --- |
| the caller's own | proceeds |
| another tenant that exists | `403` |
| a tenant that does not exist | `404` |
| absent | the caller's own |

Existence is checked first, so an unknown id is a `404` rather than a `403` —
the more accurate answer, and one that does not confirm which ids exist to a
caller probing them.

`tenantId` used to be a plain parameter filled from `:id`, then
`body.tenant_id`, then `?tenant_id=`, behind an admin role that carries no
venue-wide meaning. Any admin could therefore have named any tenant and
overwritten its Betfair credentials — then started that tenant's collector,
publishing prices derived from an account they control — or deleted them and
stopped its collector outright: a cross-tenant write and a denial of service on
another venue's odds feed, with an audit row naming the attacker as the actor.

**There is no venue-wide feed inventory endpoint.** `statusAll()` is deleted and
there is no export by which to reach it; `GET /api/admin/feed/credentials`
returns exactly one entry, the caller's own. A venue-wide list behind an admin
role told one operator that every other venue in the database had feed
credentials, whether they had them, and when they were last touched.

The supervisor routes (`/api/admin/feed/runner/*`) have no actor of their own,
so the same rule is applied in the route layer before `lib/feedrunner.js` is
reached.

### The envelope is bound to where it belongs

| | |
| --- | --- |
| **Cipher** | AES-256-GCM, 12-byte random IV per value, auth tag stored alongside |
| **Envelope** | `v1:<iv>:<tag>:<ciphertext>`, so a future key rotation can tell v1 from v2 |
| **Per field** | each of the three is sealed independently, so one can be rotated alone |
| **Bound to** | `feedcreds.v1\|t=<tenant id>\|f=<field name>` as GCM additional authenticated data |
| **No key** | `503`, and **nothing is written** |

The bound is the property that makes per-tenant isolation hold against someone
who already has the database. GCM authenticates the ciphertext against a *key*,
so without associated data a value sealed for one slot is a perfectly valid
ciphertext for any other — and before this, a row **moved** at the database
level from tenant B to tenant A decrypted cleanly and was handed to tenant A's
collector as though A had stored it.

The route boundary stops that being reached over HTTP. It does not stop a
restore from a backup, a migration bug, an operator at a `sqlite` prompt, or
anyone holding the file — which is exactly the threat model "encrypted at rest"
claims. Because the tenant, the field and a schema version are authenticated
alongside the ciphertext, a swapped or repurposed row is now a loud integrity
failure rather than a silent cross-tenant disclosure:

```
500 Stored credential could not be decrypted — the encryption key may have
    changed, or the stored row does not match this tenant and field
```

`validateInput` is a **local shape check**, not a credential test: a 16-character
app key, a plausible username, a non-empty password. The exchange cannot tell you
whether a credential works; only the collector can, by trying it. A wrong
password therefore looks like a success until the collector exits immediately.

Every write and every deletion is audited with `[sealed]` markers, recording
which fields existed and never their values.

---

## Collector supervision

By default the venue **only reads** the collector's database and you run the
collector yourself — systemd, Docker, whatever you already use. Set
`FEED_RUNNER_ENABLED=true` to have the venue supervise it instead: it spawns
`FEED_COLLECTOR_CMD` as a child process, passes the decrypted credentials as
environment variables, and restarts it with exponential backoff.

`FEED_RUNNER_ENABLED=true` without `FEED_CREDENTIALS_KEY` warns twice at boot and
starts nothing — a supervisor with no key has no credentials to hand a child, so
every launch would fail identically.

### Readiness

`start()` refuses, with the reason rather than a boolean, when any of four
conditions is missing: `FEED_ENABLED`, `FEED_RUNNER_ENABLED`,
`FEED_DATABASE_URL`, `FEED_CREDENTIALS_KEY`. The route turns a refusal into a
`409`, not a `200` carrying `started: false` that a UI renders as success.

### Three things about running it as a child

- **Credentials go in `env`, never in `argv`.** `ps` is world-readable.
- **A child's environment is readable** via `/proc/<pid>/environ` by the same
  user that started it. Encryption at rest protects the database and its
  backups; it does not make a credential invisible to anyone who can already run
  code as this user. Anyone who can read this process's memory can read it too.
- **The child's environment is an allowlist, not `process.env`.** It receives
  `PATH`, `LANG`, `LC_ALL`, `TZ`, `HOME`, `TMPDIR`, `SSL_CERT_FILE`,
  `SSL_CERT_DIR`, plus the three Betfair variables, `BETFAIR_LOGIN_MODE`, the
  collector's `DATABASE_URL` and `LOG_LEVEL`. It does **not** receive
  `PAYMENTS_WEBHOOK_SECRET` — the HMAC key that authorises the deposit webhook —
  nor `OPS_TOKEN`, nor the seeded `ADMIN_PASSWORD`. The collector has outbound
  internet access to Betfair and runs third-party Python dependencies from
  another repository; handing it the deposit-webhook key couples a market-data
  collector to a payments boundary it has no reason to be near.

**Child output is redacted before it is stored or shown.** The collector logs its
own configuration, and a Betfair error can echo a key. Captured output has the
known credential values replaced before it reaches a log file, the admin API, or
a support ticket — and before it is relayed to the server's own console when
`FEED_COLLECTOR_VERBOSE=1`. Redaction is exact-value only; a regex that tried to
recognise "things that look like app keys" would also mangle prices and market
ids. The log tail is capped at 200 lines of 500 characters, and
`/api/admin/feed/runner` returns the last 20.

### Restart is a sequence, not two calls

`POST /api/admin/feed/runner/start` · `/stop`, and `GET /api/admin/feed/runner/:id?`:

| Field | Meaning |
| --- | --- |
| `running` | derived from whether a **process** exists, not whether a handle does |
| `pid` | `null` whenever `running` is `false` — never a pid that does not exist |
| `supervisor` | `running` · `restarting` · `waiting to restart` · `stopped` · `idle` |
| `restart_pending` | a restart was asked for and is waiting on the child's exit |
| `restarts`, `consecutive_failures`, `last_exit`, `last_start_error` | history |
| `configured` | which credential fields exist, for this tenant |
| `recent_log` | the scrubbed tail |

`kill('SIGTERM')` is asynchronous, so the line after it still sees a live child.
A route that did `stop()` then `start()` therefore hit the `already_running`
guard, spawned nothing, and then the old child's exit saw `stopping === true`
and returned instead of rescheduling — **saving rotated credentials permanently
stopped the collector**, with no error, no log line, and a response claiming
`collector_restarted: true`. `lib/feedrunner.js` `restart()` sequences it in the
module that owns the lifecycle, honouring the launch from the exit handler, and
the `PUT` route reports which of the two states you are in:

| Field | Meaning |
| --- | --- |
| `collector_restarted` | a new collector is already up |
| `collector_restart_pending` | the old process is terminating; the launch follows on its exit |

Liveness is derived the same way. A failed spawn (`ENOENT` — a typo in
`FEED_COLLECTOR_CMD`, a missing venv, a PATH difference between your shell and
the service user) emits `error` and `close` but **not** `exit`, and leaves `pid`
undefined, so a handle-based check reported `running: true` for a collector that
was never born, made every later `start()` answer `already_running`, and left
`stop()` killing nothing. `alive()` now requires an assigned pid and neither an
exit code nor a signal, which is true the moment `start()` returns.

A collector that exits unexpectedly is restarted on a backoff from **5 s to
5 min**, doubling per consecutive failure. That is deliberate: retrying every
second against Betfair's login endpoint with a credential already known to be
wrong is a good way to get the account rate-limited or locked. The backoff resets
only when a child has stayed up longer than `FEED_RUNNER_MIN_UPTIME_SECONDS`, so
a crash-loop that survives ten seconds each time does not reset it to 5 s and
retry forever.

The **first** restart used to wait 10 s. The exit path recorded the failure and
*then* asked how long to wait, so the count it read on the first crash was 1 and
the ladder started one rung above where it claims to. `BACKOFF_START_MS` was a
value the code could not produce. The wait is now computed before the failure is
counted, so 5 s is reachable; the log line still names the crash it is reporting,
which is why it reads "retrying in 5s (failure 1)".

### Shutdown drains the collector

`SIGTERM` and `SIGINT` are handled. In order: every job timer is stopped, then
`lib/feedrunner.js` `stopAll()` runs, then the listener is closed, then the
process exits `0`. `stopAll()` clears each pending restart, sends each live child
`SIGTERM`, escalates to `SIGKILL` after 5 seconds, and resolves on the children's
`close` so the collector is known to be gone before exit. A hard 10-second
deadline exits `1` if the drain does not finish, and a second Ctrl-C is ignored
rather than starting a second shutdown.

Before this existed, `stopAll()` had no callers at all: the default signal action
terminated the process, `server.on('close')` never fired, and the old
`betfeed collect` survived **every deploy, crash and Ctrl-C** — still holding a
Betfair session, still spending market-data weight, still writing into the feed
database, and now competing with the new collector for the same account. The new
process started with an empty in-memory map, reported `supervisor: 'idle'`, and
answered "the collector was not running". Two collectors on one Betfair account
is the fastest route to being rate-limited or banned.

**The child is deliberately not spawned detached.** Node has no parent-death
signal, so a detached child in its own process group would *guarantee* an orphan
on a parent crash rather than merely risk one, and it would move the collector
out of the group a terminal's Ctrl-C reaches. `stopAll()` signals the direct
child instead — the one process this module can prove it started.

---

## The results feed

This is a **different** integration from the odds feed above, and conflating the
two is the most common mistake in reading this repository.

| | Odds feed | Results feed |
| --- | --- | --- |
| Owner | [`lib/feed.js`](../lib/feed.js) | [`lib/resultsfeed.js`](../lib/resultsfeed.js) |
| Direction | reads the collector's Postgres | **POSTs to** `RESULTS_FEED_URL` and gets outcomes back |
| Settles markets | **no** | yes, via `lib/results.js` |
| Configuration | `FEED_*` | `RESULTS_FEED_URL`, `RESULTS_FEED_SECRET`, `RESULTS_FEED_TIMEOUT_MS`, `RESULTS_POLL_INTERVAL_MS` |

Nothing in this codebase reads the collector's results table and settles
anything with it. Settlement happens through `lib/settle.js`, reached either from
an operator's intent or from `lib/results.js` `applyOutcome` — which is fed by
the HTTP transport below, by a webhook, or by hand. If a feed fixture's result is
what you want to settle on, the venue's markets are settled by a provider you
configure, and the Betfair collector's own results stay in its database.

### The transport

The venue POSTs the markets it wants settled and expects outcomes back. Every
failure mode — DNS, TLS, timeout, non-2xx, unparseable body, oversized body —
records a reason and returns an empty outcome set. It does **not** throw into the
job runner and it does **not** settle anything: a results outage must not be able
to take down a venue that is happily trading the next race, and the failure must
be visible.

The request carries selection names alongside ids, so a provider can match on its
own identifiers rather than on row ids it has never seen. Redirects are refused
(`redirect: 'error'`): the transport validates the *shape* of an outcome but
never the identity of the responder, so following a redirect would hand
settlement to a host nobody configured. Bodies are read with a hard byte cap
enforced on the decoded stream, so a provider returning a 500 MB body cannot OOM
the venue to deliver bad news.

### What the venue asks about

The poll set is computed by `lib/results.js` `pendingMarkets()`: every market
that is `open`, not on a settlement hold, and whose event is **off** — where
"off" runs through `lib/offtime.js`, and an event whose off time is missing or
unparseable counts as off. It is the same query the consumer iterates and the
transport POSTs, so the feed is asked for precisely what will be consumed.

That set is **not capped**. See [Known gaps](#known-gaps).

### A wrong-shaped response is a failure, not an empty poll

`parseOutcomes` accepts a map keyed by market id, or an array of entries
carrying `market_id`. Anything else raises — and so does the case that mattered
most:

> A payload that **contained** entries and produced **none** is a shape change,
> and raises `unrecognised_shape`.

It used to collapse to `{}`. The caller then advanced `last_ok_at`, incremented
`ok_polls`, cleared `consecutive_failures`, and never set `last_error` — so a
provider that renamed its wrapper key left the venue permanently green: polling
on a timer, settling nothing, with the health endpoint agreeing it was fine. The
shape most likely to trigger it is the one **the venue itself sends**
(`{"markets": [...]}`), so a provider echoing the request back read as "no
outcomes, all healthy".

The asymmetry was exactly backwards: an unreadable body threw loudly while a
readable-but-wrongly-shaped one failed silently.

Partial parses are still tolerated, because one bad entry is not the same failure
as a lost key — but they are **counted**:

| Counter | Meaning |
| --- | --- |
| `dropped_entries` | running total of entries the provider sent that named no usable market id |
| `last_dropped` | what the **last** poll dropped |

A running total can be a healthy provider that mis-sent one entry an hour ago; a
non-zero number on every poll is a contract change, and that is what
`last_dropped` is for. Both are published in the health response rather than
buried in a log, because the whole failure this module had was invisible.

### Results-feed health

```
GET  /api/admin/results/feed      the transport's state
POST /api/admin/results/poll      one cycle, on demand
```

| Field | Meaning |
| --- | --- |
| `status` | `not_configured` · `failing` · `stale` · `ok` — a setup state and three running states an operator must be able to tell apart |
| `target` | the URL actually in use, which may have been passed explicitly rather than read from config |
| `last_poll_at` · `last_ok_at` · `age_ms` | when the venue last succeeded |
| `last_error` | `{ reason, detail, at }`; `reason` is what tells an operator where to look |
| `polls` · `ok_polls` · `signals_received` | totals |
| `dropped_entries` · `last_dropped` | see above |
| `pending_last_poll` · `pending_peak` | how many markets the last poll asked about, and the high-water mark since boot. The backlog, not the transport — see [The poll set is bounded, not truncated](#the-poll-set-is-bounded-not-truncated) |
| `stale` | configured, and the venue has been waiting too long for an answer: the last success is older than `staleAfterMs`, **or there has never been one** |

A feed that has been configured and has **never once answered** reports `stale`,
not `ok`. `stale_after_ms` is the poll interval and the test is "has the venue
been waiting too long for an answer", which from boot is already true. It used
to require a previous success to have an age to measure, so a configured feed
read `ok` until its first good poll and — if the poll job never ran at all —
read `ok` forever: the one state in which the alarm was structurally incapable
of firing. The four states above are unchanged; only the rule for reaching
`stale` moved. (`stale_after_ms` defaults to 0, which turns staleness off
entirely; `/readyz` calls `health()` with no arguments, and the feed is
reported there rather than gating on it.)

Reasons an operator will see: `unreadable_response`, `invalid_json`,
`unrecognised_shape`, `response_too_large`, `timeout`, `unreachable`,
`no_fetch`, `http_<status>`, `consumer_failed`. They are distinct on purpose —
an unreadable body is a transport problem, a body read perfectly well but not
interpreted is an integration whose contract moved underneath you, and that is
the one to page someone about.

### The poll set is bounded, not truncated

A results service that has to page through the venue's entire market catalogue
in one request is a service that will time out. `pendingMarkets` therefore has
**no `LIMIT`**, and that is deliberate rather than an oversight.

It became a live query when #39 replaced its unsatisfiable predicate (which
required `events.status = 'completed'` — a state production cannot reach, since
`settle.js` only writes it once every market on the event is already settled)
with off time. Before that the set was always empty, so its size never mattered.
Now it does: on a long-running venue whose results feed has quietly stopped
working, every market that goes off stays in the set forever.

A `LIMIT` fixes that by **dropping markets silently**. A market outside the limit
is never asked about, never settled and never reported — the exact failure this
whole path exists to prevent, introduced by the fix for "the list grows". The
ordering does not save it: putting the longest-waiting markets last strands
precisely those, which are the ones holding a player's money, and putting them
first strands whatever is behind them the moment the backlog exceeds the cap.
The list is not a queue an operator is draining; it is everything the venue
still owes money on.

So the bound is on the **wire** instead:

| | |
| --- | --- |
| `pendingMarkets` | returns everything eligible. No cap, ever |
| `createFetcher({ batchSize })` | the set is posted in batches, default **250** markets per request |
| `pending_last_poll` / `pending_peak` | published in `health()`, so a backlog that only grows is visible rather than inferred |
| the log | a **new high** in the backlog is announced once, when it happens |

Every pending market is asked about on every poll, across as many requests as it
takes. Nothing is dropped and nothing is deferred.

A failed batch **stops** the poll and keeps the outcomes from the batches that
already answered. Stopping avoids hammering a provider that has just failed a
request; keeping them is because those outcomes are real results for real
markets, and discarding them because a later batch timed out strands money the
venue is already holding answers for. The health entry is identical to a
single-request failure either way.

The high-water trigger is a new high rather than a threshold, so a venue with a
permanently large backlog says so once instead of every cycle and the line keeps
its meaning; a queue that is merely large but not growing stays silent, because
it is not getting worse.

The feed is reported in `/readyz` and deliberately **not** gated on it: a dead
results feed means outcomes arrive late and a human settles, not that the book
is wrong.

### The Delay-key constraint you cannot configure away

Betfair's **Delay** key is what you get by default, and it has two consequences
worth stating before you rely on this.

**Prices are 5 minutes behind, and polling faster does not help.** Betfair
withholds `publish_time` entirely on a Delay key, so the age of the data cannot
be computed from a timestamp. This is why every market carries `age_seconds`
*and* `stale` — the first measuring when **we** polled, never called
`data_age` — and why the honest null is published rather than a fabricated one.

**Some Betfair data is simply not available.** `VENUE` and
`EVENT_RUNNER_DESCRIPTION` are Live-key-only and fail a Delay key's request with
`DSC-0018`. The collector's `CATALOGUE_PROJECTION` default excludes both, and
`betfeed validate` fails if you add either back.

Both are the collector's problem rather than the exchange's, and both are handled
there. They are recorded here because they change what a venue can promise its
customers.

How `/api/feed/health` actually answers the delay question:

The probe does not re-authenticate to Betfair from the venue's request path. It
tries to ask the collector what it already knows:

```sql
SELECT payload FROM feed_run WHERE job = 'odds' ORDER BY started_at DESC LIMIT 1
```

and reads `payload.app_key_delay`. Any failure is caught, and the probe falls
back to `is_delay: true`. The answer is cached for 60 seconds.

**`feed_run` has no `payload` column.** Its columns are `run_id`, `job`,
`started_at`, `finished_at`, `ok`, `items_ok`, `items_err`, `duration_ms` and
`error`. The query therefore raises on every call, and the probe takes its
fallback every time, so in practice:

- `app_key_delay` is **always `true`**
- `data_age_seconds` is **always `null`**

The collector does know the answer — `betfeed health` computes it from
`market_odds_current` by checking whether any held book has a `publish_time` — but
it reports it through its own command and MCP tool, not through a column this
query can reach.

The fallback direction is the safe one: a null age rather than a fabricated one.
The flag carries no information in that state, so the response now publishes
**`app_key_delay_source`** — `collector` if the probe actually read it,
`assumed` if it fell back — and `delay_note` says so in words. `delay_note`
will still tell a Delay-key operator that prices are ~5 minutes behind whatever
the key actually is. See [Known gaps](#known-gaps).

### `data_age_seconds` is Betfair's clock, not ours

`data_age_seconds` used to be `max(odds_captured_at)` — **our** poll timestamp —
which made it numerically identical to `odds_age_seconds`, while `delay_note`
told the operator in prose that it was measured from Betfair's `publish_time`.
It was not, and it never could be: `healthSql` did not select `publish_time` at
all.

That contradicted this document's own argument, which is that a number measuring
when *we* polled "is a number that will be misread as freshness by anyone who
glances at it — so it is never called `data_age`". The name was kept and the
meaning was not. It was also inconsistent in the honest direction: a Delay key
published a null *with* an explanation of why, while a live key published a
number with an explanation that was false — and a null cannot be misread, a
number will be.

The probe now aggregates `max(v.publish_time)` and `data_age_seconds` reads
from it. Three branches, and `delay_note` describes the one that actually ran:

| Branch | `data_age_seconds` | `delay_note` |
| --- | --- | --- |
| Delay key | `null` | Betfair withholds `publish_time`, so it cannot be measured |
| Live key, books stamped | Betfair's age | measured from Betfair `publish_time`, not from our poll time |
| Live key, no `publish_time` recorded | `null` | live key, but nothing to measure yet |

The third is not hypothetical. `max()` over nulls is null, so a live key before
the collector has ever captured a `publish_time` lands there, and the old note
would have promised a measurement it had not made.

---

## Known gaps

Documented rather than implied. None of these is fixed, and none of them is
discovered by reading a green dashboard.

| Gap | Where | What actually happens |
| --- | --- | --- |
| The nav tree reads feed 2 on feed 1 | `NAV_SQL`, `lib/feed.js` | `NAV_SQL` interpolates `feedView(2)` at module load while `boardSql` and `healthSql` take the configured feed, and `fetchNav()` takes no argument. With `FEED_NUMBER=1` the navigation tree describes `v_feed2` while the board and market routes read `v_feed1`. |
| The results poll set is uncapped | `pendingMarkets`, `lib/results.js` | Every open, non-held, off market is asked about, every cycle. There is deliberately **no `LIMIT`** — see [The poll set is bounded, not truncated](#the-poll-set-is-bounded-not-truncated). The bound is on the request body, and the backlog is published as `pending_last_poll` / `pending_peak`. |
| The delay probe asks for a column that does not exist | `delayProbe`, `lib/feed.js` | It selects `feed_run.payload`; the collector's `feed_run` has no such column, so the query raises, the fallback is `is_delay: true`, and `app_key_delay` is always `true` with `data_age_seconds` always `null`. The response now publishes `app_key_delay_source`, so an operator can tell an assumed flag from a read one — but the flag itself still carries no information until the collector writes it somewhere a query can reach. |

On the second: the predicate was previously unreachable. It also required
`events.status = 'completed'`, which cannot co-exist with an open market, so the
set was empty by construction and the absence of a cap had nothing to act on.
Removing the dead clause is what made the list real. It is still uncapped, on
purpose — see
[The poll set is bounded, not truncated](#the-poll-set-is-bounded-not-truncated).

---

## What feed mode does NOT do

The things a reader is most likely to assume, and the code for each.

| It does not | Because |
| --- | --- |
| make feed markets tradeable | they have no local row; `POST /api/orders` 404s on a feed selection id, before collateral is taken |
| suspend markets when the feed goes stale | there is no local market to suspend. A guard doing that would close the venue's *real* book because an unrelated market's prices were old — see `tests/feed-display-only.test.js` |
| copy feed prices onto local markets | a local market is created with no price and the venue quotes its own |
| give the venue a price source of its own | `BOTS_ON` and `DRIFT_ON` are `BOT_ENABLED && !FEED_ENABLED` and `DRIFT_ENABLED && !FEED_ENABLED`, hoisted above every use. **In feed mode the venue's own markets are unquoted**, whatever their flags say |
| settle anything from the collector's results | settlement runs through `lib/settle.js`, from an operator's intent or from the HTTP results transport |
| write to the collector's database | `lib/feed.js` only ever reads |
| merge into the existing board | `/api/feed/*` is a parallel surface; the demo board and the feed board are served by different routes |

That row about bots and drift is the honest summary of feed mode: **an
observation tool attached to an engine, not a merged product.** The engine keeps
trading its own catalogue, and in feed mode nothing is quoting it.

---

## Reading the feeds directly

The exchange reads `v_feed1` and `v_feed2`. Both are views, so neither can be
written to by accident. Read them yourself when diagnosing:

```sql
-- everything on today, with prices
SELECT * FROM v_feed2
WHERE market_start_time BETWEEN now() AND now() + interval '1 day';

-- what feed 2 is serving right now, and how old each book is
SELECT market_id, captured_at, now() - captured_at AS age, status
FROM market_odds_current ORDER BY age DESC LIMIT 10;
```

### Schema, and one trap

The collector's `selection` table is keyed on **`(market_id, selection_id)`**,
and that is not incidental. Betfair **reuses selection ids across markets**:
`selection_id 1` is `0 - 0` in the Correct Score market of every football match
on the exchange. Anything that joins or filters on `selection_id` alone is wrong
and will return the wrong runner names. `lib/feed.js` keys each runner on the
composite `${market_id}:${selection_id}` for exactly this reason.

The ladder is read from the per-selection `odds` JSONB and rebuilt here: best
back highest-first, best lay lowest-first, because that is what puts the price a
taker wants at the top. A level whose price is below 1, whose size is negative,
or whose size does not convert to a safe integer count of cents is **dropped at
the boundary** rather than carried into the UI, where it would render as
`$NaN` or as a stake that does not exist.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Board empty, `/api/feed/board` returns `409` | `FEED_ENABLED` is off. `/api/feed/health` answers `409` for the same reason |
| Every board request returns `503` | the feed database is unreachable, or the view does not exist. The real message is in the server log |
| Feed 1 board renders but every market is `stale` | correct — feed 1 has no prices, so there is no poll age to be fresh |
| Nav tree lists markets the board does not show | `FEED_NUMBER=1`; the nav query is still hardcoded to `v_feed2`. See [Known gaps](#known-gaps) |
| `markets_with_odds: 0` on feed 2 | the collector's price block is empty. `markets` counts `DISTINCT market_id`, not rows, so the two numbers are not comparable to a row count — but `markets` high and `markets_with_odds` zero means the view is publishing no prices |
| `app_key_delay: true`, `data_age_seconds: null` | expected on a Delay key; also what you get when the probe cannot read `feed_run.payload` — check `app_key_delay_source`. See [Known gaps](#known-gaps) |
| `DSC-0018` in the collector log | `VENUE` or `EVENT_RUNNER_DESCRIPTION` added to the collector's `CATALOGUE_PROJECTION`. Live-key-only; `betfeed validate` fails on it |
| `ANGX-0001` / `TOO_MUCH_DATA` | `CATALOGUE_MAX_RESULTS` > 200 (its default) or `BOOK_CHUNK_SIZE` > 40 (its default) on a Delay key |
| `CERT_AUTH_REQUIRED` | the collector configured `login_mode=certs`, which POSTs to Betfair's *certificate* endpoint — use `password`. The exchange's own credential store always writes `password`, so this can only come from a collector you run yourself |
| Prices look 5 minutes behind | expected on a Delay key; only a Live key fixes it |
| `403` on a credential route naming another tenant | working as intended; cross-tenant administration is not available on this role |
| `404` on a credential route | that tenant id does not exist — checked before the ownership rule so probing ids reveals nothing |
| `409` from `/api/admin/feed/runner/start` | the readiness reason is in the response body: a missing flag, a missing `FEED_DATABASE_URL`, a missing `FEED_CREDENTIALS_KEY`, or no credential stored |
| `supervisor: "stopped"` but a `betfeed` process exists | an orphan from before the shutdown path existed. Check `ps` for a collector whose parent is gone |
| `running: false`, `last_start_error: "… is not installed or not on PATH"` | `FEED_COLLECTOR_CMD`, or the service user's `PATH`. A spawn that never happened used to leave a handle that reported `running: true` with `pid: undefined`; liveness is now derived from the process itself |
| Results feed green but nothing settles | check `dropped_entries` and `last_dropped`, then `last_error.reason`. `unrecognised_shape` means the provider's response changed |

The collector's own `betfeed validate` names the offending collector setting
rather than leaving you a stack trace.

---

## Related

- [EXCHANGE_RULES.md](EXCHANGE_RULES.md) — market lifecycle, pre-off gating, void rules, dead heats, automatic settlement
- [ARCHITECTURE.md](ARCHITECTURE.md) — where the feed sits in this codebase
- [API.md](API.md) — every route, including the feed's
- [DataFeed README](https://github.com/wippa-studios/OpenBettingExchangeDataFeed) — the collector itself