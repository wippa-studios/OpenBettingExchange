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

// Feed 2's priced columns. FEED_SQL is feed 1's prefix: feed 1 is feed 2
// without prices, so selecting feed 1 means dropping this suffix rather than
// maintaining a second query that can drift from the first.
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
// `number_of_winners` is NOT selected, and that is a real gap rather than an
// oversight: racing PLACE markets are all named "To Be Placed", and only the
// winner count tells "Any 2 to place" from "Any 3 to place". The collector
// captures soccer (type 1) and tennis (type 8) only, so no racing market can
// appear here today. Anyone adding horse racing must add `number_of_winners` to
// the collector's `market` table first, or the tree will show identical leaves.
// Navigation tree: sport -> country -> competition -> event -> market.
//
// Built in SQL rather than by walking markets in JS: the grouping is cheap for
// Postgres and would otherwise re-scan the same rows on every tree rebuild.
// One row per MARKET, so the tree reaches the level a bettor actually clicks.
//
// `number_of_winners` is NOT selected, and that is a real gap rather than an
// oversight: racing PLACE markets are all named "To Be Placed", and only the
// winner count tells "Any 2 to place" from "Any 3 to place". The collector
// captures soccer (type 1) and tennis (type 8) only, so no racing market can
// appear here today. Anyone adding horse racing must add `number_of_winners` to
// the collector's `market` table first, or the tree will show identical leaves.
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
      sport_id: row.sport_type_id,
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

// Defensive mirror of the route's clampFeedLimit (server.js): the route clamps
// the query param, but fetchBoard is a lib export, and a direct caller must not
// be able to ask for unbounded catalogue work.
function boardLimit(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

async function fetchBoard(opts = {}) {
  const fallback = config.FEED_MARKET_LIMIT;
  const limit = boardLimit(opts.limit ?? fallback, fallback);
  const { rows } = await getPool().query(boardSql(opts.feed, false), [limit]);
  const markets = groupRows(rows, { priced: priced(opts.feed) });
  // groupRows orders markets by the SQL's ORDER BY only insofar as Map preserves
  // insertion order, which it does — so this is belt and braces for a caller
  // that reordered rows, not the primary sort.
  markets.sort((a, b) => new Date(a.start_time || 0) - new Date(b.start_time || 0));
  return decorate(markets);
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
  const [market] = groupRows(rows, { priced: priced(opts.feed) });
  if (!market) return null;
  decorate([market]);
  return market;
}

// A market label that distinguishes markets Betfair names identically.
//
// Retained from the previous implementation, which read `number_of_winners` from
// the recorder's snapshots. The current collector does not capture that field
// (see navSql), so callers pass null and the label falls back to Betfair's own
// name. Kept because the moment horse racing is added this is the function that
// has to work.
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

function navNodes(rows) {
  return rows.map(raceFromRow);
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
 * The two numbers people misread are handled explicitly:
 *   odds_age_seconds   when WE last polled
 *   app_key_delay      whether this is a Delay key — and therefore whether any
 *                      of that number means the data is 5 minutes old
 *   data_age_seconds   null on a Delay key, because Betfair withholds
 *                      publish_time and the age is not measurable. Published as
 *                      null rather than substituted, because a fabricated age
 *                      reads as a measurement.
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
           min(odds_captured_at)                  AS oldest_book`
    : `0::int                                      AS markets_with_odds,
           NULL::timestamptz                        AS newest_book,
           NULL::timestamptz                        AS oldest_book`;
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
  const r = rows[0] || {};
  const delay = await delayProbe();
  const newest = r.newest_book ? new Date(r.newest_book).getTime() : null;
  const oldest = r.oldest_book ? new Date(r.oldest_book).getTime() : null;

  return {
    // Staleness is a statement about PRICES, so only a priced feed can be stale.
    // On feed 1 the honest answer is that this probe answered at all: the board
    // has no ladder to be out of date, and reporting `ok: false` forever would
    // be a second dead control pointed the other way.
    ok: hasPrices ? !!newest && Date.now() - newest < config.FEED_STALE_SECONDS * 1000 : true,
    // Which view this answered from, so "healthy" is attributable to a feed.
    feed: Number(view.slice(-1)),
    priced: hasPrices,
    markets: r.markets || 0,
    markets_with_odds: r.markets_with_odds || 0,
    resolved: r.resolved || 0,
    odds_age_seconds: newest ? Math.round((Date.now() - newest) / 1000) : null,
    oldest_odds_age_seconds: oldest ? Math.round((Date.now() - oldest) / 1000) : null,
    // Honest null on a Delay key. See the note above.
    data_age_seconds: delay.is_delay ? null : odds_age(r.newest_book),
    app_key_delay: delay.is_delay,
    // WHY, in words, because a null with no explanation reads as a bug.
    delay_note: delay.is_delay
      ? 'Betfair withholds publish_time on a Delay key, so data age cannot be measured. ' +
        'odds_age_seconds is how long ago WE polled, not how old the data is. Prices are ~5 minutes behind.'
      : 'Live key: data_age_seconds is measured from Betfair publish_time.',
  };
}

function odds_age(t) {
  if (!t) return null;
  const ms = Date.now() - new Date(t).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

/**
 * Whether this is a Delay key.
 *
 * The view cannot answer it, so it is asked of Betfair — but only when asked,
 * and a failure here is treated as "unknown, assume delayed" rather than
 * "live". Assuming live would let a 5-minute-old price be published as current.
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
  close,
  groupRows,
  nestNav,
  navNodes,
  runnerOrder,
  bookPercentages,
  marketLabel,
  ageSeconds,
  boardSql,
  healthSql,
  navSql,
  feedView,
  priced,
  levelFromRow,
  BOARD_SQL,
};