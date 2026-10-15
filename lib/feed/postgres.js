'use strict';
// lib/feed/postgres.js — the Betfair collector's PostgreSQL, as a feed PROVIDER.
//
// The collector is a separate program that owns the Betfair connection and
// publishes two read-only views:
//
//   v_feed1  fixtures, markets, runners. NO odds column exists in it, so
//            "feed 1 has no prices" is a property of the schema rather than a
//            filter someone has to remember.
//   v_feed2  feed 1 plus each selection's ladder and the market's result.
//
// This module only READS. If the collector stops, the board goes stale; nothing
// corrupts. Why a shape like this at all: the board endpoint already returns
// runners with `back` and `lay` ladders, so feeding the same shape means
// public/js/* needs no changes.
//
// ── WHY IT IS A PROVIDER, AND WHY ITS BEHAVIOUR IS UNCHANGED ────────────────
// This is the code that used to be lib/feed.js, and it is today's behaviour
// byte for byte. That is the requirement, not an accident: FEED_PROVIDER
// defaults to `postgres`, so the default deployment must not change in any
// observable way. Every comment below was written to explain a specific defect
// in THIS code, and moving it without the comment would make the next
// contributor reintroduce the bug it describes.
//
// What moved OUT of it, and why: `groupRows`, `decorate`, `shape` and `nestNav`
// are now lib/feed/shape.js, because the HTTP provider has to produce the same
// market shape from a different transport and there must not be two of them.
// See that file's header. The row contract between this module and it is
// unchanged — one row per (market, selection), ladders in an `odds` object —
// which is why the row-shaping tests in tests/feed.test.js still hold verbatim.
//
// ── THE CONFORMANCE SUITE IS NOT OPTIONAL FOR A NEW PROVIDER ─────────────────
// An adapter that half-works does not crash. It produces wrong prices or wrong
// market state, and nothing downstream can detect that: the engine has no idea
// which provider fed it. So tests/feedprovider-conformance.test.js asserts the
// contract below, and any provider registered in lib/feed/provider.js has to
// pass it before it can be used.
//
// ── AGE, AND WHY IT IS NOT WHAT IT LOOKS LIKE ───────────────────────────────
// Betfair withholds `publish_time` entirely on a Delay key, which is the key
// Betfair issues by default. So on the common path there is NO timestamp from
// which data age can be computed, and no amount of polling changes that.
//
// Every market therefore carries BOTH:
//   age_seconds    our poll age  (now() - odds_captured_at)
//   stale           derived from age_seconds against FEED_STALE_SECONDS
// plus, at the health level, `app_key_delay` and `data_age_seconds: null`.
//
// The naming is deliberate. `age_seconds` measuring when WE polled, on a feed
// that is five minutes behind, is a number that will be misread as freshness by
// anyone who glances at it — so it is never called `data_age` and the honest
// null is published rather than a fabricated one.
//
// ── FEED COLLECTOR SUPERVISION IS NOT HERE ───────────────────────────────────
// FEED_RUNNER_ENABLED and the collector command still belong to
// lib/feedrunner.js, and they still work: this provider is a READER, and a
// venue whose feed API is their own has no collector to spawn. The supervisor
// is left alone deliberately so that turning FEED_PROVIDER on does not
// reconfigure anything a deployment already runs.
//
// A feed market is DISPLAY ONLY. It has no row in this venue's database, so
// naming one on POST /api/orders is a 404 — see docs/FEED.md.
const config = require('../config');
const shape = require('./shape');

let pool = null;

// Lazily built so a non-feed deployment never loads the driver at all.
function getPool() {
  if (!pool) {
    // eslint-disable-next-line global-require
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: config.FEED_DATABASE_URL,
      max: 4,
      // The feed is a read path. A statement that hangs is worse than one that
      // fails: the board would wait forever rather than showing stale data.
      statement_timeout: 10_000,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    // A pool error with no listener takes the process down. The feed dying is
    // survivable; the venue dying because a read connection blipped is not.
    pool.on('error', (e) => console.error('[feed] idle client error:', e.message));
  }
  return pool;
}

async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end().catch(() => {});
  }
}

// ── SQL ──────────────────────────────────────────────────────────────────────

// Feed 2's priced columns. The export of the assembled feed-2 statement is
// BOARD_SQL: feed 1 is feed 2 without prices, so selecting feed 1 means dropping
// this suffix rather than maintaining a second query that can drift from the
// first. (This header used to name `FEED_SQL`, an identifier that exists nowhere
// in the repository — the export has always been `BOARD_SQL`.)
// Feed 2's priced columns. `odds` MUST be here: it is the per-selection ladder
// JSONB the whole board is built from.
//
// It was missing from this list while `health()` counted `odds IS NOT NULL` in
// its own query — so health reported 9,456 markets with odds and the board
// rendered sixty empty ladders. Two queries, one of them right.
const PRICE_COLUMNS = `
       v.odds,
       v.odds_captured_at,
       v.price_age_seconds,
       v.publish_time,
       v.inplay,
       v.bet_delay
`;

const FEED_COLUMNS = `
       v.fixture_id,
       v.sport_slug,
       v.event_name,
       v.competition_id,
       v.competition_name,
       v.country_code,
       v.fixture_venue,
       v.event_type_name,
       v.event_type_id,
       v.market_id,
       v.market_type_code,
       v.market_name,
       v.market_start_time,
       v.market_venue,
       v.market_status,
       v.is_resolved,
       v.total_matched,
       v.selection_id,
       v.runner_name,
       v.sort_priority,
       v.handicap,
       v.selection_status`;

// THE COLUMN LIST IS BUILT BY PREFIXING, NEVER BY SUFFIXING.
//
// FEED_COLUMNS used to end with a trailing comma, with PRICE_COLUMNS appended
// after it. That works for exactly one of the two feeds: `priced(1)` is false, so
// the price block is empty and the dangling comma lands immediately before
// `FROM` —
//
//   SELECT ... v.selection_status,
//     FROM v_feed1 v
//
// which is a Postgres SYNTAX ERROR, not a semantic one. Feed 1 is a supported,
// documented mode (lib/config.js permits FEED_NUMBER=1, docs/FEED.md recommends
// it for a venue running its own book), so every board request on such a
// deployment threw and the route turned it into a flat 503.
//
// The comma now belongs to the OPTIONAL block. A list assembled that way is
// well-formed whether or not the optional part is present, so the two shapes
// cannot drift into a third broken one.
const PRICE_JOIN = ',\n';

/**
 * The view a read goes to. A whitelist, not string interpolation: `feed` comes
 * from configuration, and a config value should never be able to choose a table.
 */
function feedView(feed) {
  const n = Number(feed || config.FEED_NUMBER || 2);
  if (n !== 1 && n !== 2) throw new Error(`FEED_NUMBER must be 1 or 2 (got ${feed})`);
  return n === 1 ? 'v_feed1' : 'v_feed2';
}

function priced(feed) {
  return Number(feed || config.FEED_NUMBER || 2) === 2;
}

/**
 * The board list / single market, from the configured view.
 *
 * Feed 1 has no `odds_captured_at`, so its age is null and every market reads
 * as stale. That is correct and worth stating: feed 1 genuinely has no prices,
 * and a UI that showed it as "live" with empty ladders would be lying.
 */
function boardSql(feed, single) {
  const view = feedView(feed);
  // Comma-PREFIXED: see the note above PRICE_JOIN. Appending a bare block to a
  // comma-terminated base list only works while the block is always present.
  const priceCols = priced(feed) ? `${PRICE_JOIN}${PRICE_COLUMNS.trim()}` : '';
  // The board cap is a cap on MARKETS, not on rows.
  //
  // The first version put LIMIT on the outer select and silently capped
  // SELECTIONS: the view has one row per (market, selection), so a cap of 20
  // returned two markets — a Correct Score market alone is 31 rows. The old
  // recorder's shape (one row per runner per side) had the same flaw, so
  // FEED_MARKET_LIMIT has never actually meant markets. The market list is
  // chosen first, then joined back for the full runner set.
  //
  // GROUP BY rather than DISTINCT, because Postgres requires a SELECT DISTINCT's
  // ORDER BY expressions to appear in its select list, and market_start_time is
  // per-selection in general.
  // WITH must LEAD the statement — an earlier version emitted it after FROM,
  // which is a syntax error Postgres reports as "syntax error at or near WITH".
  //
  // ORDERING, and it differs by feed on purpose:
  //
  //   feed 2 orders by book freshness. A reference book is browsed for prices,
  //     so newest-first is what a bettor wants. Ordering by start time instead
  //     puts ALREADY-FINISHED markets first, because those are the earliest ones
  //     — and they are exactly the markets the odds job does not poll, so the
  //     board led with rows that had no prices at all. Measured: 2,157 of 81,870
  //     rows are past or present, and all of them are unpriced.
  //
  //   feed 1 orders by start time. It has no prices to be fresh about, and a
  //     fixture list is chronological by nature.
  const hasPrices = priced(feed);
  const chosen = `WITH chosen AS (
      SELECT v.market_id,
             min(v.market_start_time) AS start,
             ${hasPrices ? 'max(v.odds_captured_at) AS booked' : 'NULL::timestamptz AS booked'}
        FROM ${view} v
       GROUP BY v.market_id
       ${hasPrices
         ? 'ORDER BY 3 DESC NULLS LAST, 2 NULLS LAST, 1'
         : 'ORDER BY 2 NULLS LAST, 1'}
       LIMIT $1
    )`;
  const outerOrder = hasPrices
    ? 'ORDER BY v.odds_captured_at DESC NULLS LAST, v.market_start_time NULLS LAST, v.market_id, v.sort_priority, v.selection_id'
    : 'ORDER BY v.market_start_time NULLS LAST, v.market_id, v.sort_priority, v.selection_id';
  return `
    ${single ? '' : chosen}
    SELECT ${FEED_COLUMNS}${priceCols}
      FROM ${view} v
     ${single ? 'WHERE v.market_id = $1' : 'JOIN chosen c ON c.market_id = v.market_id'}
     ${single ? 'ORDER BY v.market_start_time NULLS LAST, v.market_id, v.sort_priority, v.selection_id' : outerOrder}
  `;
}

const BOARD_SQL = boardSql(2, false);

// Navigation tree: sport -> country -> competition -> event -> market.
//
// Built in SQL rather than by walking markets in JS: the grouping is cheap for
// Postgres and would otherwise re-scan the same rows on every tree rebuild.
// One row per MARKET, so the tree reaches the level a bettor actually clicks.
//
// `number_of_winners` is selected as NULL, and the REASON has changed.
//
// This block was duplicated verbatim above, and both copies told the next
// contributor to add `number_of_winners` to the collector's `market` table
// before adding horse racing. That was false: the collector has carried the
// column from its initial migration — `models.py` maps it, `writer.py` writes
// it, `snapshot.py` captures it from the book, `mapping.py` reads it off the
// market book. Verified against the collector source, not assumed.
//
// So the gap was never upstream. It is here, in this SELECT, and it is a
// one-line change — but NOT one to make blind: whether `v_feed1`/`v_feed2`
// project the column is not answerable from this repository, and a reference to
// a column a view does not expose is a guaranteed runtime error on the nav
// query, which is the one query whose failure leaves the venue with no sport
// rail at all and no error on the board to explain it.
//
// Until a racing market can actually appear (this venue handles soccer and
// tennis), NULL is the correct value and identical leaves are unreachable. When
// racing arrives: expose the column in the view, select it, and marketLabel
// starts working with no other change.
//
// PARAMETERISED, LIKE boardSql AND healthSql (#69). It was a module constant
// that interpolated `feedView(2)`, so a FEED_NUMBER=1 deployment built its whole
// navigation rail from the priced view it never reads — quietly, unlike the
// board query, which on feed 1 is a guaranteed syntax error against a view with
// no odds columns. Two sites hardcoded feed 2, one was fixed by #59 and this one
// survived it; that is what makes this a guard and not a one-line change.
function navSql(feed) {
  return `
  SELECT v.sport_slug                     AS sport,
         v.event_type_id                  AS sport_id,
         v.event_type_name                AS sport_name,
         v.country_code                   AS country,
         COALESCE(NULLIF(v.competition_name, ''), NULLIF(v.fixture_venue, ''), v.event_name)
                                           AS competition,
         v.fixture_id                     AS event_id,
         v.event_name                     AS event_name,
         v.market_start_time              AS event_time,
         v.market_id                      AS market_id,
         v.market_name                    AS market_name,
         v.market_type_code               AS market_type,
         v.market_start_time              AS market_time,
         v.market_status                  AS market_status,
         -- The venue is pre-off only (docs/EXCHANGE_RULES.md), so a market is
         -- never in-play from this system's point of view regardless of what
         -- Betfair says. Reported, not acted on.
         v.inplay                         AS in_play,
         NULL::int                       AS number_of_winners
    FROM ${feedView(feed)} v
   WHERE v.market_status IN ('OPEN', 'OPEN_FOR_STREAMING', 'OPEN_FOR_BETTING')
   ORDER BY 1 NULLS LAST, 3 NULLS LAST, 4 NULLS LAST,
            v.market_start_time NULLS LAST, v.market_name
`;
}

// ── the provider ─────────────────────────────────────────────────────────────

/**
 * The Postgres provider.
 *
 * `query` is a SEAM, not decoration: the conformance suite has to run the whole
 * contract battery against this provider offline, and a battery that can only
 * run against a live Postgres is a battery that never runs. It defaults to the
 * real pool, so production behaviour is the pool and nothing else.
 *
 * The default argument is evaluated on every call rather than captured, because
 * a capture would bind the pool at CONSTRUCTION time — and constructing a
 * provider must not be what opens a database connection.
 */
function postgresProvider({ query = null } = {}) {
  const run = async (sql, params) => {
    if (query) return query(sql, params);
    return getPool().query(sql, params);
  };

  return {
    name: 'postgres',

    // The contract's spelling. It delegates to the module-level `priced` so the
    // rule "feed 2 has prices, feed 1 does not" has exactly one statement.
    priced(opts) {
      return priced(opts && opts.feed);
    },

    async board({ limit, priced: wantPrices } = {}) {
      const fallback = config.FEED_MARKET_LIMIT;
      const capped = shape.boardLimit(limit == null ? fallback : limit, fallback);
      const { rows } = await run(boardSql(undefined, false), [capped]);
      return shape.shape(rows, { priced: wantPrices === undefined ? priced() : wantPrices });
    },

    async market(id, { priced: wantPrices } = {}) {
      if (id == null || String(id).trim() === '') return null;
      const { rows } = await run(boardSql(undefined, true), [String(id)]);
      const [market] = shape.shape(rows, { priced: wantPrices === undefined ? priced() : wantPrices });
      return market || null;
    },

    async nav() {
      const { rows } = await run(navSql());
      return shape.nestNav(rows);
    },

    async health() {
      // A driver error embeds the host, the user and often part of the connection
      // string. The caller gets a generic message and the detail goes to the server
      // log, which is where an operator can actually act on it.
      try {
        return await _health(run);
      } catch (e) {
        console.error('[feed] health check failed:', e.message);
        return { ok: false, error: 'Odds feed unavailable' };
      }
    },

    close,
  };
}

/**
 * Feed health, answering "is the feed up?" in one GET.
 *
 * The two numbers people misread are handled explicitly, and they are on TWO
 * DIFFERENT CLOCKS:
 *   odds_age_seconds   when WE last polled  (`max(odds_captured_at)`)
 *   app_key_delay      whether this is a Delay key — and therefore whether any
 *                      of that number means the data is 5 minutes old
 *   app_key_delay_source  where that flag came from, because the probe usually
 *                      cannot read it and ASSUMES it
 *   data_age_seconds   how old the DATA is, from Betfair's own
 *                      `max(publish_time)`. Null on a Delay key, because
 *                      Betfair withholds publish_time and the age is then not
 *                      measurable. Published as null rather than substituted,
 *                      because a fabricated age reads as a measurement.
 *
 * The payload itself is built by `healthPayload` (lib/feed/shape.js), which is
 * pure and therefore assertable without a database — and is the SAME builder
 * the HTTP provider uses, so both feed sources answer in one shape.
 */
async function _health(run) {
  const hasPrices = priced();
  const view = feedView();
  const { rows } = await run(healthSql(), []);
  return shape.healthPayload({
    row: rows[0] || {},
    delay: await delayProbe(run),
    hasPrices,
    feed: Number(view.slice(-1)),
  });
}

/**
 * The health probe's SQL, as a pure function of the feed number.
 *
 * Extracted (like `boardSql`) so it can be asserted offline. The bug this
 * replaces — a probe hardcoded to `feedView(2)` — is a bug about WHICH STRING
 * IS SENT, so pinning the string is pinning the behaviour; an assertion about
 * `health()`'s return value could only ever have been made against a live
 * Postgres, i.e. never.
 */
function healthSql(feed) {
  // THE PROBE READS THE CONFIGURED VIEW. It used to hardcode `feedView(2)`,
  // which meant a FEED-1 deployment was probed against a view its board never
  // touches: the probe passed while every board request 503'd, and an operator
  // holding a green health check and a dead board had no way to connect them.
  // A probe that cannot fail for half the supported configurations is not a
  // probe.
  //
  // And because v_feed1 has NO odds columns at all — that is a property of the
  // schema, not a filter — the price aggregates cannot be named unconditionally
  // either: on feed 1 they are typed nulls rather than an unknown column, so
  // the probe can still run and can still fail.
  const priceAggs = priced(feed)
    ? `count(DISTINCT market_id) FILTER (WHERE odds IS NOT NULL)::int AS markets_with_odds,
           max(odds_captured_at)                  AS newest_book,
           min(odds_captured_at)                  AS oldest_book,
           max(publish_time)                      AS newest_publish`
    : `0::int                                      AS markets_with_odds,
           NULL::timestamptz                        AS newest_book,
           NULL::timestamptz                        AS oldest_book,
           NULL::timestamptz                        AS newest_publish`;
  return `
    -- count(DISTINCT market_id), NOT count(*): the view is one row per
    -- (market, selection), so count(*) reports 81,785 "markets" when there are
    -- 9,976. A health endpoint that overstates its inventory by 8x is worse than
    -- one that reports nothing, because it looks like a working number.
    SELECT count(DISTINCT market_id)::int       AS markets,
           ${priceAggs},
           count(DISTINCT market_id) FILTER (WHERE is_resolved)::int AS resolved
      FROM ${feedView(feed)}
  `;
}

/**
 * Whether this is a Delay key.
 *
 * The view cannot answer it, so it is asked of Betfair — but only when asked,
 * and a failure here is treated as "unknown, assume delayed" rather than
 * "live". Assuming live would let a 5-minute-old price be published as current.
 *
 * ── THIS PROBE CURRENTLY ASSUMES, EVERY TIME ───────────────────────────────
 * It reads `feed_run.payload`, and the collector's `feed_run` has no such
 * column: its columns are `run_id`, `job`, `started_at`, `finished_at`, `ok`,
 * `items_ok`, `items_err`, `duration_ms`, `error`. So the query raises every
 * time, the catch takes the fallback, and in practice `app_key_delay` is always
 * `true` with `data_age_seconds` always null. The fallback direction is the safe
 * one — a null age rather than a fabricated one — but a flag that cannot be
 * distinguished from a guess is not information, which is why `source` is now
 * published as `app_key_delay_source`.
 *
 * What would actually make it read: the collector knows, and reports it through
 * `betfeed health` (it derives the answer from `market_odds_current` by asking
 * whether any held book carries a `publish_time`), which is a command and an MCP
 * tool rather than a column this query can reach. Deriving it HERE from
 * `max(publish_time) IS NULL` over v_feed2 would work, and is deliberately not
 * done: that infers the key from the symptom rather than asking, and would
 * report `false` for a live key that simply has not polled since it started.
 * Until the collector writes the flag somewhere reachable, `assumed` is the
 * honest answer and this note is what tells an operator so.
 *
 * ── THE HTTP PROVIDER TAKES THE SAME FALLBACK, AND DELIBERATELY ────────────
 * It has no `feed_run` row to ask at all, so it passes the same
 * `{is_delay:true, source:'assumed'}` with no query. "Assumed delayed is the
 * safe direction: it makes data_age_seconds null rather than wrong." Inventing a
 * `false` there would let an operator's feed API publish a five-minute-old price
 * as current on the strength of a guess made by this codebase.
 */
let delayCache = { at: 0, value: null };
async function delayProbe(run) {
  if (Date.now() - delayCache.at < 60_000 && delayCache.value) return delayCache.value;
  const result = { is_delay: true, source: 'assumed' };
  try {
    // The collector already knows this — `betfeed health` reports it, and it
    // records it on every odds run. Rather than re-authenticate to Betfair from
    // the venue's request path (an API call per health check, plus a session
    // to hold), read what the collector already wrote.
    const { rows } = await run(
      `SELECT payload FROM feed_run WHERE job = 'odds' ORDER BY started_at DESC LIMIT 1`,
      []
    );
    const payload = rows[0] && rows[0].payload;
    const delay = payload && payload.app_key_delay;
    if (typeof delay === 'boolean') {
      result.is_delay = delay;
      result.source = 'collector';
    }
  } catch {
    // feed_run may not exist, or the query may fail. "Assumed delayed" is the
    // safe direction: it makes data_age_seconds null rather than wrong.
  }
  delayCache = { at: Date.now(), value: result };
  return result;
}

module.exports = {
  postgresProvider,
  close,
  feedView,
  priced,
  boardSql,
  navSql,
  healthSql,
  BOARD_SQL,
};