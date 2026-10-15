'use strict';
// lib/feed.js — read OpenBettingExchangeDataFeed's PostgreSQL.
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
// ── WHY THERE IS NO CARRY-FORWARD HERE ──────────────────────────────────────
// The previous implementation carried prices forward across frames, because
// Betfair's Stream API sends only the runners that CHANGED in a cycle and
// "the newest frame per market" was therefore a partial book. It marked carried
// levels so the UI could show them as not-live — and the UI never read that
// flag, so it was dead weight on top of a schema it no longer matched.
//
// The collector does not use the Stream API. It polls a market book at a time
// and writes the COMPLETE ladder for every market into market_odds_current,
// which v_feed2 joins per selection. Every row of a market is therefore from
// the same poll, there is nothing to carry forward, and the machinery would
// only ever report `carried: false`. It is gone, and the "carried" tests went
// with it rather than being kept to exercise dead code.
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
// A feed market is DISPLAY ONLY. It has no row in this venue's database, so
// naming one on POST /api/orders is a 404 — see docs/FEED.md.
const config = require('./config');

const SIDE_BACK = 'BACK';
const SIDE_LAY = 'LAY';

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

// ── shaping ───────────────────────────────────────────────────────────────────

/** Seconds since a timestamp, or null when there is no timestamp to measure from. */
function ageSeconds(publishTime) {
  if (!publishTime) return null;
  const t = new Date(publishTime).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

/**
 * Runners in the order a bettor expects: numbered first, in number order, then
 * unnumbered by the collector's own sort priority, then alphabetically.
 *
 * The numeric-prefix rule exists because Betfair names runners "1", "2", "3"
 * far more often than not, and "10" sorting before "2" is the kind of small
 * wrongness that makes a ladder look broken.
 */
function runnerOrder(a, b) {
  const an = /^\s*(\d+)\b/.exec(a.name || '');
  const bn = /^\s*(\d+)\b/.exec(b.name || '');
  if (an && bn) {
    const d = Number(an[1]) - Number(bn[1]);
    if (d !== 0) return d;
  } else if (an) return -1;
  else if (bn) return 1;

  // sort_priority is Betfair's own ordering hint, and it is stable where the
  // name is not ("Draw" / "Home" / "Away" all have no digits).
  const ap = a.sort_priority == null ? Number.MAX_SAFE_INTEGER : a.sort_priority;
  const bp = b.sort_priority == null ? Number.MAX_SAFE_INTEGER : b.sort_priority;
  if (ap !== bp) return ap - bp;

  return String(a.name || '').localeCompare(String(b.name || ''));
}

function marketFor(markets, row) {
  let m = markets.get(row.market_id);
  if (!m) {
    m = {
      market_id: row.market_id,
      event_id: row.fixture_id,
      event_name: row.event_name,
      sport_slug: row.sport_slug,
      sport_name: row.event_type_name,
      // `event_type_id`, and it is SELECTED — the two were previously separate
      // mistakes. The field read `row.sport_type_id`, a column no view has, so it
      // was `undefined` on every board and market response while the field's
      // name promised otherwise; and the board query did not select the column
      // that does exist either. NAV_SQL already had this right, aliasing
      // `v.event_type_id AS sport_id`, so the board was the only reader getting
      // a dead field.
      sport_id: row.event_type_id == null ? null : Number(row.event_type_id),
      competition_name: row.competition_name,
      competition_id: row.competition_id,
      country_code: row.country_code,
      venue: row.fixture_venue || row.market_venue || null,
      market_name: row.market_name,
      market_type_code: row.market_type_code,
      start_time: row.market_start_time,
      market_start_time: row.market_start_time,
      publish_time: row.publish_time || null,
      // Named `status`, not `market_status`: this is the board's contract field
      // (public/js/board.js renders `m.status` on the card). The row's column is
      // market_status; carrying both invites one of them to drift.
      status: String(row.market_status || '').toUpperCase(),
      in_play: !!row.inplay,
      bet_delay: row.bet_delay == null ? null : Number(row.bet_delay),
      is_resolved: !!row.is_resolved,
      total_matched: row.total_matched == null ? null : Number(row.total_matched),
      // Feed 1 carries no odds_captured_at at all, so the market-level age is
      // null and `stale` is true — which is the truth about a feed with no
      // prices in it.
      price_captured_at: row.odds_captured_at || null,
      poll_age_seconds: ageSeconds(row.odds_captured_at),
      selections: [],
      _seen: new Set(),
    };
    markets.set(row.market_id, m);
  }
  return m;
}

/**
 * A ladder level, or null if it cannot be rendered.
 *
 * Every bound here is a place where a plausible-looking but wrong number would
 * be worse than no level at all: a price below 1 or a negative size would let a
 * client compute a stake that does not exist. Rejected at the boundary rather
 * than carried into the UI.
 */
function levelFromRow(o, side) {
  const price = o == null ? null : Number(o.price);
  const size = o == null ? null : Number(o.size);
  if (!Number.isFinite(price) || price < 1) return null;
  if (!Number.isFinite(size) || size < 0) return null;
  // Betfair reports size in pounds and the board's contract is integer cents.
  // A NaN here would render as "$NaN", so it is rejected rather than rounded.
  const cents = Math.round(size * 100);
  if (!Number.isSafeInteger(cents)) return null;
  return { price, size_cents: cents, side };
}

function runnerFor(market, row) {
  // The COMPOSITE key matters: Betfair reuses selection ids across markets, so
  // selection_id alone would merge "0 - 0" from one match's Correct Score
  // market into another's.
  const key = `${row.market_id}:${row.selection_id}`;
  let s = market._seen.has(key) ? market.selections.find((x) => x.key === key) : null;
  if (!s) {
    s = {
      key,
      selection_id: String(row.selection_id),
      name: row.runner_name,
      sort_priority: row.sort_priority,
      handicap: row.handicap == null ? null : Number(row.handicap),
      status: String(row.selection_status || '').toUpperCase() || null,
      back: [],
      lay: [],
    };
    market._seen.add(key);
    market.selections.push(s);
  }
  return s;
}

/**
 * Rows from either view to the board's market shape.
 *
 * Ladders come from the `odds` JSONB the view joins per selection: `{back:[…],
 * lay:[…]}`, each level `{price, size}`. Betfair returns them unordered, so
 * they are sorted here — best back highest-first, best lay lowest-first, which
 * is what makes the top of each ladder the price a taker wants.
 */
function groupRows(rows, opts = {}) {
  const markets = new Map();
  for (const row of rows) {
    const m = marketFor(markets, row);
    const s = runnerFor(m, row);
    const odds = opts.priced === false ? null : row.odds;
    if (!odds) continue;

    const seen = { [SIDE_BACK]: new Set(), [SIDE_LAY]: new Set() };
    for (const [jsonKey, side] of [[SIDE_BACK.toLowerCase(), SIDE_BACK], [SIDE_LAY.toLowerCase(), SIDE_LAY]]) {
      const levels = Array.isArray(odds[jsonKey]) ? odds[jsonKey] : [];
      for (const o of levels) {
        const level = levelFromRow(o, side);
        if (!level) continue;
        // A duplicated level would show as a repeated price cell; the collector
        // can emit one after a resumption, and the UI has no way to render it.
        const sig = `${level.price}:${level.size_cents}`;
        if (seen[side].has(sig)) continue;
        seen[side].add(sig);
        s[side === SIDE_BACK ? 'back' : 'lay'].push(level);
      }
    }
    s.back.sort((a, b) => b.price - a.price);
    s.lay.sort((a, b) => a.price - b.price);
    s.last_price_traded =
      odds.last_price_traded == null ? null : Number(odds.last_price_traded);
  }

  for (const m of markets.values()) {
    m._seen.clear();
    delete m._seen;
    m.selections.sort(runnerOrder);
  }
  return [...markets.values()];
}

/**
 * Overround, as the percentage of book on each side.
 *
 * A lay of the same selection at the same price is liability, not matched
 * volume, so it is excluded — including it would report a book that is always
 * over 100% and tell an operator nothing.
 */
function bookPercentages(runnerLadders) {
  let back = 0;
  let lay = 0;
  for (const r of runnerLadders) {
    const backs = (r.back || []).map((l) => l.price).filter((x) => Number.isFinite(x));
    const lays = (r.lay || []).map((l) => l.price).filter((x) => Number.isFinite(x));
    if (backs.length) back += 1 / Math.max(...backs);
    if (lays.length) lay += 1 / Math.min(...lays);
  }
  const round1 = (x) => Math.round((x * 100 + Number.EPSILON) * 10) / 10;
  const backRunners = runnerLadders.filter((r) => (r.back || []).length).length;
  const layRunners = runnerLadders.filter((r) => (r.lay || []).length).length;
  // A book percentage is reported only for a COMPLETE TWO-SIDED book: every
  // runner priced on the back AND on the lay.
  //
  // Not "when each side is non-empty". Two cases force this:
  //
  //   - Three runners where only two carry a back price sums to an undercount,
  //     and a percentage that quietly omits a runner is worse than no number.
  //   - Ten runners at 1.02 with NO lays sums to ~980% on the back side, which
  //     reads as a broken feed rather than as "there are no lays here". That is
  //     not a 980% book; it is one side of a book, and a book has two sides.
  //
  // So a half-presented book reports null for both sides. The runner counts are
  // still returned, so a renderer can say WHICH side is incomplete instead of
  // showing a blank cell with no explanation.
  const total = runnerLadders.length;
  const complete = total > 0 && backRunners === total && layRunners === total;
  return {
    back_pct: complete ? round1(back) : null,
    lay_pct: complete ? round1(lay) : null,
    percent_book: complete ? round1((back + lay) / 2) : null,
    back_runners: backRunners,
    lay_runners: layRunners,
    runners: total,
  };
}

function decorate(markets) {
  for (const m of markets) {
    const age = m.poll_age_seconds;
    m.age_seconds = age;
    // No poll time at all (feed 1, or a market the odds job has not reached)
    // is stale. Calling it fresh because "we don't know" is how a board ends up
    // showing yesterday's prices as though they were live.
    m.stale = age == null || age > config.FEED_STALE_SECONDS;
    Object.assign(m, bookPercentages(m.selections || []));
  }
  return markets;
}

/**
 * The market cap a caller may ask for, or the configured default.
 *
 * Defensive mirror of the route's clampFeedLimit (server.js): the route clamps
 * the query param, but fetchBoard is a lib export, and a direct caller must not
 * be able to ask for unbounded catalogue work.
 *
 * ── WHY "JUNK" IS A SET AND NOT A TYPE ─────────────────────────────────────
 * `Number(raw)` decides this, and `Number` is far more willing than it looks:
 * `Number('') === 0` and `Number('  ') === 0`, both finite. The old guard was
 * `if (!Number.isFinite(n)) return fallback`, so `/api/feed/board?limit=` — the
 * single most likely piece of junk a URL produces, and what a browser sends for
 * an empty input — fell through to `Math.max(1, 0)` and returned a board of ONE
 * MARKET, with no error and no warning. `?limit=0` and `?limit=-5` did the same.
 *
 * So the test is not "is it a number" but "is it a number somebody meant": a
 * blank, a zero and a negative are all absent intent, not a request for no
 * markets, and each falls back to the configured default. A ceiling still
 * applies, so a caller cannot ask for the whole catalogue.
 */
function boardLimit(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string' && raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(500, Math.floor(n));
}

/**
 * Rows from a board query to the served board.
 *
 * The ORDER IS THE QUERY'S. `groupRows` walks rows into a Map, and a Map
 * iterates in insertion order, so the markets come out in exactly the sequence
 * the statement returned — which for feed 2 is book freshness first and start
 * time only as a tiebreak.
 *
 * That matters because this function used to end with a start-time sort, which
 * silently re-keyed an order the SQL had chosen on purpose. boardSql argues at
 * length that feed 2 must lead with the freshest books, because ordering a
 * price board by start time leads with the ALREADY-FINISHED markets — which are
 * exactly the ones the odds job stopped polling, so the board opened with rows
 * that had no prices in them. The sort made the comment's own reasoning dead
 * text and left `ORDER BY v.odds_captured_at DESC` relevant only to which
 * markets survived the CTE `LIMIT`.
 *
 * There is no ordering here on purpose. The query is the single place that
 * decides what the board looks like, and `boardSql` is a pure function of the
 * feed number, so it can be asserted offline.
 */
function shape(rows, opts = {}) {
  return decorate(groupRows(rows, { priced: opts.priced }));
}

async function fetchBoard(opts = {}) {
  const fallback = config.FEED_MARKET_LIMIT;
  const limit = boardLimit(opts.limit ?? fallback, fallback);
  const { rows } = await getPool().query(boardSql(opts.feed, false), [limit]);
  return shape(rows, { priced: priced(opts.feed) });
}

/**
 * One market's full ladder, by id.
 *
 * This is how the page prices the market a bettor selected. The board list is
 * capped, so it cannot be the source for an arbitrary selection — picking a
 * market outside the cap used to silently render a DIFFERENT market's prices
 * instead of admitting it had none.
 */
async function fetchMarket(marketId, opts = {}) {
  if (marketId == null || String(marketId).trim() === '') return null;
  const { rows } = await getPool().query(boardSql(opts.feed, true), [String(marketId)]);
  const [market] = shape(rows, { priced: priced(opts.feed) });
  if (!market) return null;
  return market;
}

// A market label that distinguishes markets Betfair names identically.
//
// Retained from the previous implementation, which read `number_of_winners` from
// the recorder's snapshots. This comment used to say the collector does not
// capture that field; it does — see the note on navSql, and the collector's own
// models.py / writer.py / snapshot.py / mapping.py. What is missing is the
// column in navSql's SELECT, so callers pass null today and the label falls back
// to Betfair's own name. Kept because the moment horse racing is added this is
// the function that has to work.
function marketLabel(name, numberOfWinners) {
  const base = String(name || '');
  if (!numberOfWinners || numberOfWinners <= 1) return base;
  if (/^to be placed$/i.test(base)) return `${base} — any ${numberOfWinners} to be placed`;
  return base;
}

// A leaf of the nav tree.
//
// Field names are the renderer's contract, not this module's preference:
// public/js/nav.js walks `sport -> countries[].country -> competitions[].competition
// -> meetings[].{event_id,event_name} -> races[].{market_id,market_time,
// market_label,market_name,in_play}`. Renaming `meetings` to `events` here, or
// `competition` to `name`, silently empties the entire tree.
function raceFromRow(r) {
  const label = marketLabel(r.market_name, r.number_of_winners);
  return {
    market_id: r.market_id,
    market_name: r.market_name,
    // market_label WINS over market_name in the renderer, so that is where the
    // "Any 3 to be placed" disambiguation has to live.
    market_label: label === r.market_name ? null : label,
    market_type: r.market_type,
    market_time: r.market_time,
    start_time: r.market_time,
    in_play: !!r.in_play,
    status: r.market_status,
    market_status: r.market_status,
  };
}

function nestNav(rows) {
  const sports = new Map();
  for (const r of rows) {
    // A node name must never be an empty string or a placeholder glyph: the
    // renderer prints it as the clickable label, and a blank row in a tree is
    // unreachable. `r.competition` is already COALESCEd in SQL, but an offline
    // or synthetic row can still arrive empty, so fall back again here.
    const label = (v, fallback) => (v == null || String(v).trim() === '' ? fallback : String(v));

    let sport = sports.get(r.sport);
    if (!sport) {
      sport = { sport: r.sport, id: r.sport_id, name: r.sport_name || r.sport, countries: new Map() };
      sports.set(r.sport, sport);
    }
    let country = sport.countries.get(r.country || '');
    if (!country) {
      country = { country: r.country || null, competitions: new Map() };
      sport.countries.set(r.country || '', country);
    }
    const compName = label(r.competition, r.event_name || r.sport || 'Events');
    let competition = country.competitions.get(compName);
    if (!competition) {
      competition = { competition: compName, meetings: new Map() };
      country.competitions.set(compName, competition);
    }
    let meeting = competition.meetings.get(r.event_id);
    if (!meeting) {
      meeting = {
        event_id: r.event_id,
        event_name: label(r.event_name, r.market_name || 'Event'),
        event_time: r.event_time,
        races: [],
      };
      competition.meetings.set(r.event_id, meeting);
    }
    meeting.races.push(raceFromRow(r));
  }

  // Maps were the right structure for BUILDING; the response is plain nested
  // arrays, which is what the renderer walks. `meetings` is the level name it
  // expects (public/js/nav.js: `for (const m of k.meetings)`).
  return [...sports.values()].map((s) => ({
    sport: s.sport,
    countries: [...s.countries.values()].map((c) => ({
      country: c.country,
      competitions: [...c.competitions.values()].map((comp) => ({
        competition: comp.competition,
        meetings: [...comp.meetings.values()],
      })),
    })),
  }));
}

async function fetchNav() {
  const { rows } = await getPool().query(navSql());
  return nestNav(rows);
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
 * The payload itself is built by `healthPayload`, which is pure and therefore
 * assertable without a database.
 */
async function health() {
  // A driver error embeds the host, the user and often part of the connection
  // string. The caller gets a generic message and the detail goes to the server
  // log, which is where an operator can actually act on it.
  try {
    return await _health();
  } catch (e) {
    console.error('[feed] health check failed:', e.message);
    return { ok: false, error: 'Odds feed unavailable' };
  }
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

async function _health() {
  const hasPrices = priced();
  const view = feedView();
  const { rows } = await getPool().query(healthSql());
  return healthPayload({
    row: rows[0] || {},
    delay: await delayProbe(),
    hasPrices,
    feed: Number(view.slice(-1)),
  });
}

/**
 * The health payload, as a PURE function of what the probe returned.
 *
 * Extracted (like `boardSql` and `healthSql`) so it can be asserted offline,
 * because the question this payload exists to answer — "whose clock is this
 * number on?" — cannot be asked of a live Postgres at all, and was therefore
 * never asked of anything.
 *
 * ── TWO CLOCKS, AND THE PROVARIANCE CLAIMED FOR EACH ───────────────────────
 * `data_age_seconds` is the age of the DATA, so it is measured from Betfair's
 * `publish_time`. It used to be `odds_age(newest_book)` — OUR poll timestamp —
 * which made it numerically identical to `odds_age_seconds`, two names for one
 * clock, while `delay_note` told the operator in prose it was Betfair's.
 *
 * That was this file's own principle inverted. The header argues at length
 * that a number measuring when WE polled "is a number that will be misread as
 * freshness by anyone who glances at it — so it is never called data_age". The
 * name was kept and the meaning was not. The two paths were also inconsistent
 * in the honest direction: a Delay key published a null WITH an explanation, a
 * live key published a number with an explanation that was false — and a null
 * cannot be misread, while a number will be.
 *
 * So `publish_time` is aggregated in `healthSql` and `data_age_seconds` reads
 * from it. Three branches, and the note describes the one that actually ran:
 *
 *   delay key          null — Betfair withholds publish_time, nothing to measure
 *   live key, stamped  the age of Betfair's own publish_time
 *   live key, unstamped  null — the column exists but no row carries one
 *
 * The third is not hypothetical: `max()` over nulls is null, so a live key
 * before the collector has ever captured a publish_time lands here, and the
 * old note would have promised a measurement that had not been made.
 *
 * `app_key_delay_source` is published for the same reason. `delayProbe` selects
 * `feed_run.payload`, a column the collector's `feed_run` does not have, so the
 * query raises and `is_delay: true` is ASSUMED on every call — which means
 * `app_key_delay: true` on its own carries no information whatsoever. See the
 * note on `delayProbe` below for what would actually make it read.
 */
function healthPayload({ row = {}, delay = { is_delay: true, source: 'assumed' }, hasPrices = true, feed = 2, now = Date.now() } = {}) {
  const r = row;
  const newest = r.newest_book ? new Date(r.newest_book).getTime() : null;
  const oldest = r.oldest_book ? new Date(r.oldest_book).getTime() : null;
  const dataAge = delay.is_delay ? null : odds_age(r.newest_publish, now);

  return {
    // Staleness is a statement about PRICES, so only a priced feed can be stale.
    // On feed 1 the honest answer is that this probe answered at all: the board
    // has no ladder to be out of date, and reporting `ok: false` forever would
    // be a second dead control pointed the other way.
    ok: hasPrices ? !!newest && now - newest < config.FEED_STALE_SECONDS * 1000 : true,
    // Which view this answered from, so "healthy" is attributable to a feed.
    feed,
    priced: hasPrices,
    markets: r.markets || 0,
    markets_with_odds: r.markets_with_odds || 0,
    resolved: r.resolved || 0,
    odds_age_seconds: newest ? Math.round((now - newest) / 1000) : null,
    oldest_odds_age_seconds: oldest ? Math.round((now - oldest) / 1000) : null,
    // Betfair's clock, never ours. See the note above.
    data_age_seconds: dataAge,
    app_key_delay: delay.is_delay,
    // WHERE THE FLAG CAME FROM, so `app_key_delay: true` stops being a value
    // that means "true" and "we could not find out" at the same time.
    app_key_delay_source: delay.source,
    // WHY, in words, because a null with no explanation reads as a bug — and
    // because this string is the one place the payload's provenance is stated
    // in a language an operator reads rather than parses.
    delay_note: delay.is_delay
      ? 'Betfair withholds publish_time on a Delay key, so data age cannot be measured. ' +
        'odds_age_seconds is how long ago WE polled, not how old the data is. Prices are ~5 minutes behind.' +
        (delay.source === 'collector' ? '' : ' (app_key_delay was ASSUMED, not read from the collector.)')
      : dataAge === null
        ? 'Live key, but no publish_time has been recorded yet, so data_age_seconds cannot be measured and is null.'
        : 'Live key: data_age_seconds is measured from Betfair publish_time, not from our poll time.',
  };
}

function odds_age(t, now = Date.now()) {
  if (!t) return null;
  const ms = now - new Date(t).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
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
 */
let delayCache = { at: 0, value: null };
async function delayProbe() {
  if (Date.now() - delayCache.at < 60_000 && delayCache.value) return delayCache.value;
  const result = { is_delay: true, source: 'assumed' };
  try {
    // The collector already knows this — `betfeed health` reports it, and it
    // records it on every odds run. Rather than re-authenticate to Betfair from
    // the venue's request path (an API call per health check, plus a session
    // to hold), read what the collector already wrote.
    const { rows } = await getPool().query(
      `SELECT payload FROM feed_run WHERE job = 'odds' ORDER BY started_at DESC LIMIT 1`
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
  fetchBoard,
  fetchMarket,
  fetchNav,
  health,
  healthPayload,
  close,
  groupRows,
  nestNav,
  runnerOrder,
  bookPercentages,
  marketLabel,
  ageSeconds,
  boardSql,
  boardLimit,
  healthSql,
    navSql,
  shape,
  feedView,
  priced,
  levelFromRow,
  BOARD_SQL,
};