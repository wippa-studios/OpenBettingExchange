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

---

## Two modes, and what each is for

The datafeed publishes **two** feeds from one collector. Which one a venue uses
is its decision, and it is a real one:

| | **feed 1** | **feed 2** |
|---|---|---|
| Contents | fixtures, markets, runners | feed 1 **+ prices, ladders, results** |
| Cadence | 12 h by default | 5 m by default |
| Price data | structurally impossible — no price column exists in `v_feed1` | `market_odds_current` |
| Auto-settlement | yes, on the fixtures cadence | yes, and fresher |
| Use when | the venue sets **its own odds** and only wants a real fixture list | the venue wants a **reference book** and faster settlement |

Both are the same contract document, differing only in whether `price` is
populated. One implementation, so they cannot drift apart.

### Choosing

**Feed 1** if you want to run your own book on real fixtures. You get real
events with real kick-off times and can quote your own prices on them. Feed 2's
prices are then irrelevant to you.

**Feed 2** if you want to see a reference book and settle sooner. Note the limit
on what it means here: this venue is **pre-off only** (see
[EXCHANGE_RULES.md](EXCHANGE_RULES.md)), so Betfair's `inplay` flag and
`bet_delay` do not affect trading. Feed 2's value is fresher fixtures, a
reference ladder, and faster results — not in-play pricing.

---

## Setting it up

The datafeed is configured **from the admin dashboard**. There is no `.env` file
to edit, and the exchange never writes one: it passes the credentials to the
collector as environment variables, which is why the datafeed can boot with no
`.env` at all.

1. **Get a Betfair Delay key.** Accounts API Demo Tool → `createDeveloperAppKeys`.
   Betfair issues two keys per registration — the Delay one is active
   immediately, the Live one is inactive until you pay for it.
2. **Admin → Feed** and paste the **app key**, **username** and **password**.
3. The exchange validates them and starts the collector.

See the datafeed's [README](https://github.com/wippa-studios/OpenBettingExchangeDataFeed#getting-a-betfair-api-key)
for the key-creation steps in full.

### Credential handling

Credentials are stored **per tenant**, encrypted at rest with AES-256-GCM
(`FEED_CREDENTIALS_KEY`), and are never returned by any API — the status
endpoint reports *whether* a field is present, never its value. Every write and
every deletion is audited. If the encryption key is not configured the venue
**refuses to store** a credential rather than falling back to plaintext.

The design point is that no HTTP route can return a secret: `lib/feedcreds.js`
exports no function that serves plaintext to a caller, and a test asserts that
adding one would be a deliberate act rather than a convenience. One function —
`forCollector()` — returns plaintext, and its only caller is the code that
builds the child process's environment.

| | |
|---|---|
| **Cipher** | AES-256-GCM, 12-byte random IV per value, auth tag stored alongside |
| **Envelope** | `v1:<iv>:<tag>:<ciphertext>`, so a future key rotation can tell v1 from v2 |
| **Per field** | each of the three is sealed independently, so one can be rotated alone |
| **Tampering** | a modified row fails the auth tag and is reported as an integrity failure, never decrypted to garbage |
| **No key** | `503`, and **nothing is written** |

### Running the collector

By default the venue **only reads** the collector's database and you run the
collector yourself — systemd, Docker, whatever you already use. Set
`FEED_RUNNER_ENABLED=true` to have the venue supervise it instead: it spawns
`FEED_COLLECTOR_CMD` as a child process, passes the decrypted credentials as
environment variables, and restarts it with exponential backoff.

Three things about that arrangement are worth stating plainly:

- **Credentials go in `env`, never in `argv`.** `ps` is world-readable.
- **A child's environment is readable** via `/proc/<pid>/environ` by the same
  user that started it. Encryption at rest protects the database and its
  backups; it does not make a credential invisible to anyone who can already run
  code as this user. Anyone who can read this process's memory can read it too.
- **Child output is redacted before it is stored or shown.** The collector logs
  its own configuration, and a Betfair error can echo a key. Captured output
  has the known credential values replaced before it reaches a log file, the
  admin API, or a support ticket.

A collector that exits immediately — the normal failure for a wrong password —
is restarted on a backoff from 5 s to 5 min. That is deliberate: retrying every
second against Betfair's login endpoint with a credential already known to be
wrong is a good way to get the account rate-limited or locked. Raising the
backoff resets when a child has stayed up longer than
`FEED_RUNNER_MIN_UPTIME_SECONDS`.

---

## The Delay-key constraint you cannot configure away

Betfair's **Delay** key is what you get by default, and it has two consequences
worth stating before you rely on this:

**Prices are 5 minutes behind, and polling faster does not help.** Betfair
withholds `publish_time` entirely on a Delay key, so the age of the data cannot
be computed from a timestamp. The datafeed reports `app_key_delay: true` and
`data_age_seconds: null` for exactly this reason, and labels `odds_age_seconds`
as *our poll age* so nobody reads it as data freshness. Only a **Live** key
removes the delay, and that is a commercial upgrade with Betfair.

**Some Betfair data simply is not available.** `VENUE` and
`EVENT_RUNNER_DESCRIPTION` are Live-key-only and fail a Delay key's request
with `DSC-0018`. The datafeed's defaults exclude both and `betfeed validate`
fails if you add either back.

Both are the datafeed's problem rather than the exchange's, and both are handled
there. They are recorded here because they change what a venue can promise its
customers.

---

## Feed markets are DISPLAY ONLY

This is the most important rule in this document.

> **A feed market cannot be bet.** Naming a feed selection id on
> `POST /api/orders` returns **404**, refused before any collateral is taken.

The reason is structural. A feed market has **no row in this venue's database** —
it lives only in the collector's Postgres. To trade it you would have to create a
local market, copy prices onto it, and then the venue is betting at a price that
is five minutes old and derived from someone else's book. The failure mode is not
a bad price; it is a good price that a sharp client takes from you.

So the feed is used for two things the venue genuinely needs:

- **a real fixture list** — real competitions, real kick-off times
- **a reference book** — what the market looks like elsewhere

and for **auto-settlement** of the markets you *do* trade. See below.

### Turning feed fixtures into tradeable markets

Creating a local market that mirrors a feed fixture is supported and is the way
to run your own book on real fixtures. It is a **deliberate, explicit act**: a
local market is created with **no price**, and the venue quotes its own. The
mapping from feed market to local market is 1:1 and is never inferred — see
[EXCHANGE_RULES.md](EXCHANGE_RULES.md).

---

## Auto-settlement

Feed 2 carries results, and they are what drive settlement for markets you trade
that share a fixture with a feed event.

Betfair's vocabulary is translated into this venue's before it reaches the
settlement engine:

| Betfair | This venue |
|---|---|
| `voided = true` | VOID, per the sport's rules |
| one `WINNER` | `completed` |
| two or more `WINNER` | `dead_heat` **signal** |
| a `REMOVED` runner | `non_runner` signal |
| terminal, no winner | `postponed` / `abandoned` |

A multi-winner signal is **not** itself a dead heat. The rules table decides
whether a sport pays a joint favourite; the signal is only evidence about what
happened. A two-winner signal on football — a sport with no dead heats — is
**held for review** rather than quietly halving every payout.

Outcomes that cannot be settled safely are **held**, never guessed, and a held
market can be released by an operator with a written reason.

### Freshness, and the lag that matters

Feed 2's odds job captures market books every 5 minutes, and each book carries
its own result — so settlement rides along for free. **Feed 1's results sweep
rides inside its fixtures job**, which defaults to every 12 hours. A match
finishing at 14:00 may not produce a result until 02:00 on feed 1.

If you use feed 1 and want fresher settlement, lower
`FIXTURES_INTERVAL_MINUTES` in the datafeed. That job requests no price data, so
polling it more often does not burn market-data weight.

---

## Reading the feeds

The exchange reads `v_feed1` and `v_feed2` directly. Both are views; neither can
be written to by accident.

```sql
-- everything on today, with prices
SELECT * FROM v_feed2
WHERE market_start_time BETWEEN now() AND now() + interval '1 day';

-- what feed 2 is serving right now, and how old each book is
SELECT market_id, captured_at, now() - captured_at AS age, status
FROM market_odds_current ORDER BY age DESC LIMIT 10;
```

### Health

```
GET /api/feed/health
```

reports collector freshness, row counts, and — because it is the number people
misread — whether the app key is a Delay one:

```jsonc
{
  "ok": true,
  "markets_with_odds": 9456,
  "odds_age_seconds": 171,
  "app_key_delay": true,
  "data_age_seconds": null
}
```

`odds_age_seconds` is **our** poll age. On a Delay key it is not the age of the
data and cannot be made to be.

---

## Schema, and one trap

The datafeed's `selection` table is keyed on **`(market_id, selection_id)`**, and
that is not incidental. Betfair **reuses selection ids across markets**:
`selection_id 1` is `0 - 0` in the Correct Score market of every football match
on the exchange.

Anything that joins or filters on `selection_id` alone is wrong, and will return
the wrong runner names. The datafeed's own history has the measurements.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Board empty, `/api/feed/health` shows `not_configured` | no credentials stored, or `FEED_ENABLED` is off |
| `DSC-0018` in the collector log | a Live-only projection was added to `CATALOGUE_PROJECTION` |
| `ANGX-0001` / `TOO_MUCH_DATA` | `CATALOGUE_MAX_RESULTS` > 200 or `BOOK_CHUNK_SIZE` > 40 on a Delay key |
| `CERT_AUTH_REQUIRED` | `login_mode=certs` on a Delay key — use `password` |
| Prices look 5 minutes behind | expected on a Delay key; only a Live key fixes it |
| Fixtures appear but no results | feed 1's results sweep rides the fixtures job — see above |

Run `betfeed validate` in the datafeed; it names the offending setting rather
than leaving you a stack trace.

---

## Related

- [EXCHANGE_RULES.md](EXCHANGE_RULES.md) — market lifecycle, pre-off gating, void rules, dead heats
- [ARCHITECTURE.md](ARCHITECTURE.md) — where the feed sits in this codebase
- [DataFeed README](https://github.com/wippa-studios/OpenBettingExchangeDataFeed) — the collector itself