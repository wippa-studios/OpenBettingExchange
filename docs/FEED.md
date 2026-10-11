# Odds feed

OpenBettingExchange can take its prices from
[`betfair-market-snapshots`](../betfair-market-snapshots) instead of the demo
bots. The recorder is a separate Python service that owns the market data;
OpenBettingExchange only **reads** its Postgres database. Neither imports the other,
and neither writes to the other's tables.

```
betfair-market-snapshots            OpenBettingExchange
  Betfair Stream API                  lib/feed.js
        │                                  │
        ▼                                  ▼
  snapshots + snapshot_prices  ──read──►  board ladder
```

If the recorder stops, the board goes stale. Nothing corrupts.

## Enable it

```bash
# 1. Recorder: capture some prices
cd ../betfair-market-snapshots
docker-compose up -d
uv run alembic upgrade head
uv run betfair-recorder
uv run betfair-backfill-names    # the stream carries no runner names

# 2. OpenBettingExchange
cp .env.example .env             # then set:
#    FEED_ENABLED=true
#    FEED_DATABASE_URL=postgresql://betfair:betfair@127.0.0.1:5432/betfair
npm start
```

```
[feed] on — bots suppressed (feed owns prices)
[feed] on — drift suppressed (feed owns prices)
[feed] odds feed connected — 123 markets, newest frame 41s old
```

`FEED_ENABLED=true` without a URL **aborts the launch**, as does a URL that is
not `postgres://`. A misconfigured feed fails at boot rather than on the first
board request.

## Bots and drift switch off automatically

With the feed on, `BOT_ENABLED` and `DRIFT_ENABLED` are ignored and the boot log
says so. They requote ladders around `fair_price` every few seconds, which would
requote directly over the observed Betfair book — two price sources fighting.
The exchange's own machinery (matching, escrow, settlement) is untouched: the
feed is a price *source*, not a replacement for the engine.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/feed/board?limit=N` | Markets with their runners and both ladders |
| `GET` | `/api/feed/nav` | `{enabled, sports}` — always 200; the boot probe |
| `GET` | `/api/feed/health` | Newest frame, its age, whether it is stale |

Both answer `409` when `FEED_ENABLED=false`. A feed outage answers `503` with
`Odds feed unavailable` rather than a generic `500`, so a recorder problem is
never mistaken for an exchange fault.

```jsonc
// GET /api/feed/board?limit=1
{ "markets": [{
    "market_id": "1.263491462",
    "event_name": "Hawkesbury (AUS) 8th Oct",
    "market_name": "R1 1300m Mdn",
    "status": "OPEN",
    "in_play": false,
    "publish_time": "2026-10-07T14:18:53.776Z",
    "age_seconds": 41,
    "stale": false,
    "selections": [
      { "selection_id": 12345, "name": "2. Landing Gear",
        "back": [{ "price": 11, "size_cents": 314 }],
        "lay":  [{ "price": 25, "size_cents": 108 }] }
    ] }] }
```

`back` is what a backer can bet into, highest first. `lay` is what a layer can
bet into, lowest first. The shape matches `/api/events`, so the existing
frontend renders it unchanged.

## Two things the data does that are easy to get wrong

**Frames are deltas, not full books.** Betfair's `marketChangeMessage` carries
only the runners that *changed* in a cycle, so the newest snapshot for a market
is a partial book — a runner that did not move has no price row in it. Reading
prices from that frame alone makes runners blink in and out of the ladder. The
query therefore resolves each `(runner, side)` to its own newest observation
across frames. A price older than the market's newest frame is flagged
`carried: true` so the UI can present it as not-live. Both reads do this — the
capped board list *and* the single market page — so a quiet runner can never
blink off the market page while the board still shows it.

**Prices are ~3 minutes old by design.** The recorder uses a *delayed* app key,
which batches each cycle's changes into one message every three minutes. This is
not a bug and cannot be tuned away — tick-level data needs a live, KYC-verified,
funded key. `FEED_STALE_SECONDS` (default 300) is what the board compares a
frame's age against.

## Performance

The board query is set-based on purpose. Looping markets client-side would be one
round-trip per market, every cycle, forever.

It leans on `ix_snapshots_market_pubtime_desc` (Alembic migration `0003`), added
because `DISTINCT ON (market_id) ... ORDER BY publish_time DESC` otherwise
seq-scans and sorts the whole table. Measured: that form scanned 99,498 rows
where the real content was 138. With the index, one index-only seek per market.

The board's top-N selection happens in SQL, not in JS: the `latest_market` CTE
orders by `publish_time DESC` and `LIMIT`s to the request's cap (default 60,
ceiling 500) *before* a single runner or price row is joined. The board's cost
is therefore proportional to the limit — flat as history accumulates, and flat
as the catalogue grows — instead of aggregating all 1400+ markets and slicing
to 60 afterwards, which is what this query used to do. (The nav tree and the
health probe still read the whole catalogue deliberately: the tree IS the
catalogue, and the probe counts it.)

The one-market query selects its market by id and joins only that market's
runners and prices, which is what keeps a race picked from the tree — possibly
outside the board's cap — cheap to price.

## Board navigation

With `FEED_ENABLED=true` the board is driven by the feed, not the seeded
catalogue, and browses the way a bookmaker's site does:

```
SPORT           COUNTRY      TRACK           MEETING
Greyhound Racing   AU          Q Straight      Q Straight (AUS) 8th Oct  [12 races]
```

That hierarchy is `sport -> country -> competition -> event -> market`. For
racing the **competition level is the track**, taken from `events.venue` /
`events.competition_name` — Betfair's own competition block is empty for racing,
so the venue is the level that actually exists.

Sport names come from the recorder's `sports` table (`event_type_id` 7 =
"Horse Racing"), not from anything the stream carries. Without the recorder's
`betfair-refresh-sports` step the board would show raw numeric ids.

The board probes `/api/feed/nav` once at boot and reads `enabled`. That
endpoint always answers 200 — a 409 there would log a console error on every
non-feed deployment, and the browser suite fails a run on any console error. So
"feed off" is `{"enabled": false, "sports": []}`, and the page falls back to the
seeded catalogue without a build-time flag in the browser.

`/api/feed/board` still answers 409 when the feed is disabled: it is a data
request, not a capability probe, so an error status is honest there.

### One-sided races are normal

Betfair reports unmatched books as one-sided, so a race can legitimately have
back offers and no lay offers at all. The board says so in the market header
("No lay offers available on this race") rather than rendering an empty column
that looks broken.

## Known gaps

- **No results feed.** The recorder captures prices only. A simulator still needs
  to know who won; settlement remains a manual admin action.
- **Betfair data licensing.** Redistributing Betfair prices commercially is not
  something this code makes legal. Settle the licence before selling any feed
  built on this.
- **Prices are the sharpest in the industry.** They are not margin-bearing. A
  user backing at 2.40 and winning means the counterparty owes — see the house
  account note in `lib/store.js`.
