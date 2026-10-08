'use strict';
// lib/feed.js — read the odds recorded by betfair-market-snapshots.
//
// The recorder (a separate Python service) owns the market data. It writes one
// snapshot row per (market_id, publish_time) plus a price row per ladder point.
// This module only READS that database; the recorder knows nothing about the
// exchange. If the recorder stops, the board goes stale — nothing corrupts.
//
// Why the shape below: the board endpoint already returns runners with `back`
// and `lay` ladders, so feeding the same shape means public/app.js needs no
// changes at all.
//
// DELTA SEMANTICS. Betfair's marketChangeMessage carries only the runners that
// CHANGED in a cycle, so "the latest snapshot per market" is a PARTIAL book —
// a runner that did not move has no price row in that frame. Reading prices
// from the latest frame alone would make runners blink in and out of the
// ladder. Instead each (runner, side) resolves to its own most recent
// observation across frames, and `carried` marks a price older than the
// market's newest frame so the UI can show it as not-live. Both reads — the
// capped board list and a single market's page — carry deltas forward the
// same way; rows that fail the price/size sanity check at the boundary are
// skipped rather than allowed to corrupt the ladders.
const config = require('./config');

const SIDE_BACK = 'BACK';
const SIDE_LAY = 'LAY';

let pool = null;

// Lazily built so a non-feed deployment never loads the driver at all.
function getPool() {
  if (pool) return pool;
  // Required lazily: `pg` is only needed by feed deployments.
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: config.FEED_DATABASE_URL,
    // A read-only poller on a ~3 minute cadence, not a hot path.
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // A wedged query must not hang a request past the connect timeout: pg
    // sends this as a server-side statement_timeout in the startup packet
    // for every client the pool creates, so a stuck read aborts at 5s
    // instead of parking the request forever.
    statement_timeout: 5000,
  });
  pool.on('error', (e) => console.error('[feed] idle client error:', e.message));
  return pool;
}

// Close the pool. Called on server shutdown so the process can exit cleanly.
async function close() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

// Set-based on purpose. Three CTEs:
//   latest_market — newest snapshot per OPEN market (one LATERAL index seek
//                   each, against ix_snapshots_market_pubtime_desc). For the
//                   board variant the newest-N markets are picked HERE, in
//                   SQL — the top-N selection must not happen in JS, or the
//                   query aggregates the whole 1400+-market catalogue just
//                   to throw all but N markets away.
//   market_runners— that market's runners
//   runner_price — each (runner, side)'s newest observation ACROSS frames,
//                   which is what makes the book whole despite deltas
// Looping markets client-side would be one round-trip per market, every cycle.
// The board query, parameterised by whether one market is wanted. $1 is the
// market id in the one-market variant and the market LIMIT in the board
// variant — both arrive as a bound parameter, never interpolated.
//
// Two shapes come from one SQL body so they cannot drift: the capped board
// list and a single market (the ladder the page renders). A single-market
// query is what makes the board work as the catalogue grows: the board list
// is capped and sorted by recency, so a race picked from the tree may not be
// in it at all.
const boardSql = (oneMarket) => `
  WITH latest_market AS (
    SELECT m.market_id,
           s.publish_time AS frame_at,
           s.status       AS market_status,
           s.in_play,
           m.name         AS market_name,
           m.market_type,
           -- How many runners win. This is the ONLY thing separating the
           -- markets Betfair all names "To Be Placed": Any 2 to place has 2,
           -- Any 3 to place has 3. Without it the tree shows N identical
           -- leaves under one meeting.
           s.number_of_winners,
           -- The race's OWN start time, which labels the market header and the
           -- tree leaf ("14:31 R1 300m Mdn"). Not the event's, and not the
           -- snapshot's publish_time.
           m.market_time,
           m.event_id,
           e.name         AS event_name,
           e.market_time  AS event_time
      FROM markets m
      CROSS JOIN LATERAL (
        SELECT publish_time, status, in_play, number_of_winners
          FROM snapshots
         WHERE market_id = m.market_id
         ORDER BY publish_time DESC
         LIMIT 1
      ) s
      LEFT JOIN events e ON e.event_id = m.event_id
     WHERE m.status IN ('OPEN','OPEN_FOR_STREAMING')
       ${oneMarket ? 'AND m.market_id = $1' : 'ORDER BY s.publish_time DESC LIMIT $1'}
  ),
  market_runners AS (
    SELECT lm.market_id, lm.frame_at, lm.market_status, lm.in_play,
           lm.market_name, lm.market_type, lm.number_of_winners, lm.market_time,
           lm.event_id, lm.event_name, lm.event_time,
           r.selection_id, r.name AS runner_name, r.sort_priority
      FROM latest_market lm
      JOIN runners r ON r.market_id = lm.market_id
  ),
  runner_price AS (
    -- Newest price per (market, selection, side).
    --
    -- market_id MUST be in the DISTINCT ON and in every join below. Betfair
    -- selection ids are unique only WITHIN a market: every soccer 1X2 market
    -- reuses 58805 for "The Draw". Deduplicating on selection_id alone
    -- collapsed all 171 priced soccer matches onto a single draw ladder, which
    -- was then served to every one of them - 171 different matches all showing
    -- the same draw price.
    SELECT DISTINCT ON (mr.market_id, p.selection_id, p.side)
           mr.market_id,
           p.selection_id,
           p.side,
           p.price,
           p.size,
           s.publish_time AS price_at
      FROM market_runners mr
      JOIN snapshots s       ON s.market_id = mr.market_id
      JOIN snapshot_prices p ON p.snapshot_id = s.id
                            AND p.selection_id = mr.selection_id
     ORDER BY mr.market_id, p.selection_id, p.side, s.publish_time DESC, p.price
  )
  SELECT mr.market_id, mr.frame_at, mr.market_status, mr.in_play,
         mr.market_name, mr.market_type, mr.number_of_winners, mr.market_time,
         mr.event_id, mr.event_name, mr.event_time,
         mr.selection_id, mr.runner_name, mr.sort_priority,
         rp.side, rp.price, rp.size, rp.price_at
    FROM market_runners mr
    LEFT JOIN runner_price rp ON rp.market_id = mr.market_id
                           AND rp.selection_id = mr.selection_id
`;

function ageSeconds(publishTime) {
  if (!publishTime) return null;
  const ms = Date.now() - new Date(publishTime).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor(ms / 1000));
}

// Runners arrive from Betfair in an arbitrary order (measured: 2, 4, 8, 5, 1,
// 3, 6, 7 for one race), so a ladder in feed order looks broken to anyone who
// knows the sport. Two signals decide the real order, in this priority:
//
//  1. sort_priority - Betfair's own catalogue sortPriority, present on every
//     market collected via REST. Authoritative: soccer arrives Home 1, Away 2,
//     Draw 3, and a race 1..n.
//  2. A number prefix on the name ("1. Blue and Gold"), which some racing
//     catalogue entries carry and the stream path never does.
//
// Falls back to the name so a market with neither still has a stable order.
function runnerOrder(a, b) {
  const pa = a.sort_priority;
  const pb = b.sort_priority;
  // Both present: trust the feed over anything inferred from the label.
  if (pa != null && pb != null && pa !== pb) return pa - pb;

  const num = (s) => {
    const m = /^\s*(\d+)/.exec(String(s || ''));
    return m ? Number(m[1]) : null;
  };
  const na = num(a.name);
  const nb = num(b.name);
  if (na !== null && nb !== null && na !== nb) return na - nb;
  if (na !== null && nb === null) return -1;
  if (na === null && nb !== null) return 1;
  // Equal on both signals (or neither present): fall back to the name so the
  // order is at least stable. Returning `pa - pb` here would report every such
  // pair as equal and leave the ladder in feed order.
  return String(a.name || '').localeCompare(String(b.name || ''));
}

// The market-level object for a row group (created on the first row of each
// market_id).
function marketFor(markets, row) {
  let market = markets.get(row.market_id);
  if (!market) {
    market = {
      market_id: row.market_id,
      market_name: row.market_name,
      market_type: row.market_type,
      number_of_winners: row.number_of_winners == null ? null : Number(row.number_of_winners),
      market_time: row.market_time,
      event_time: row.event_time,
      event_id: row.event_id,
      event_name: row.event_name,
      status: String(row.market_status || '').toUpperCase(),
      in_play: !!row.in_play,
      publish_time: row.frame_at,
      stale: false,
      selections: [],
    };
    markets.set(row.market_id, market);
  }
  return market;
}

// The runner-level object for a row group (created on the first row of each
// (market_id, selection_id) pair).
function runnerFor(market, row) {
  let runner = market.selections.find((s) => s.selection_id === row.selection_id);
  if (!runner) {
    runner = {
      selection_id: row.selection_id,
      name: row.runner_name,
      // Betfair's within-market display order. Carried through so the ladder
      // can fall back to it when the runner name carries no number: catalogue
      // names are bare ("Piteraq", not "1. Piteraq") for some races, and for
      // every non-racing sport, where alphabetical order would put "Away"
      // before "Home".
      sort_priority: row.sort_priority == null ? null : Number(row.sort_priority),
      back: [],
      lay: [],
    };
    market.selections.push(runner);
  }
  return runner;
}

// One price row → one ladder level, or null when the row must not render.
// This is the Postgres boundary: the recorder's REAL columns can come back
// NaN or negative (a wedged capture cycle), and a bad price flowing on would
// corrupt the ladder sorts and the book-percentage sums. Requirements:
// finite price >= 1, finite size >= 0 (a NULL size is a real zero — Betfair
// sends one — an absent/NaN/negative one is not). Skipped rows leave the
// runner rendering with empty ladders, exactly like a runner the frame
// carried no prices for.
function levelFromRow(row, carryForward) {
  if (row.side !== SIDE_BACK && row.side !== SIDE_LAY) return null;
  if (row.price == null) return null;
  const price = Number(row.price);
  const size = Number(row.size);
  if (!Number.isFinite(price) || price < 1) return null;
  if (!Number.isFinite(size) || size < 0) return null;
  const frameAt = row.frame_at ? new Date(row.frame_at).getTime() : null;
  const priceAt = row.price_at ? new Date(row.price_at).getTime() : frameAt;
  const carried = frameAt != null && priceAt != null && priceAt < frameAt;
  // carryForward off: show only prices belonging to the newest frame.
  if (carried && !carryForward) return null;
  const level = {
    price,
    size_cents: Math.round(size * 100),
  };
  // Marked when this price came from an earlier cycle than the market's newest
  // frame, so the UI can present it as not-live.
  if (carried) level.carried = true;
  return { side: row.side, level };
}

// Group flat rows (one per runner/side) into the board shape:
//   market -> runner -> { back[], lay[] }
//
// `back` is what a backer can bet into, best first (highest). `lay` is what a
// layer can bet into, best first (lowest). Row order is irrelevant by design:
// runners and levels are re-sorted after grouping.
function groupRows(rows, opts = {}) {
  const { carryForward = true } = opts;
  const markets = new Map();
  for (const row of rows) {
    const market = marketFor(markets, row);
    const runner = runnerFor(market, row);
    const lv = levelFromRow(row, carryForward);
    if (!lv) continue;
    (lv.side === SIDE_BACK ? runner.back : runner.lay).push(lv.level);
  }
  const out = [...markets.values()];
  for (const market of out) {
    for (const s of market.selections) {
      s.back.sort((a, b) => b.price - a.price);
      s.lay.sort((a, b) => a.price - b.price);
    }
    market.selections.sort(runnerOrder);
  }
  return out;
}

// Betfair's header percentages: "Back all" sums the implied probability of the
// best AVAILABLE-TO-BACK price for every runner, and "Lay all" does the same on
// the other side. 100% is a fair book; above that is overround.
//
// BOTH sides must be complete for either figure to be shown. This is stricter
// than "every runner has a back price", and deliberately so: a market where ten
// runners are all backed at 1.02 and nobody is laying has a back sum of ~980%,
// which reads as an absurd book when in truth there is simply no book. Without a
// two-sided market there is nothing to express an overround about.
function bookPercentages(runnerLadders) {
  const n = runnerLadders.length;
  let backSum = 0;
  let laySum = 0;
  let backCount = 0;
  let layCount = 0;
  for (const s of runnerLadders) {
    const back = (s.back || [])[0];
    const lay = (s.lay || [])[0];
    if (back) { backSum += 1 / back.price; backCount++; }
    if (lay) { laySum += 1 / lay.price; layCount++; }
  }
  const twoSided = n > 0 && backCount === n && layCount === n;
  // One decimal place, expressed as a percentage.
  const round1 = (sum) => Math.round(sum * 1000) / 10;
  return {
    back_pct: twoSided ? round1(backSum) : null,
    lay_pct: twoSided ? round1(laySum) : null,
    back_runners: backCount,
    lay_runners: layCount,
  };
}

// The unfiltered board query, kept as a named export because tests assert on
// its shape and a full-catalogue scan is what the nav/health paths want.
const BOARD_SQL = boardSql(false);

// Age, staleness and book percentages, shared by the list and single-market
// paths so both report a market the same way.
function decorate(markets) {
  for (const m of markets) {
    const age = ageSeconds(m.publish_time);
    m.age_seconds = age;
    m.stale = age == null || age > config.FEED_STALE_SECONDS;
    Object.assign(m, bookPercentages(m.selections || []));
  }
  return markets;
}

// Defensive mirror of the route's clampFeedLimit (server.js): the route clamps
// the query param, but fetchBoard is a lib export, and a direct caller must
// not be able to ask for unbounded catalogue work (or a zero limit).
function boardLimit(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

async function fetchBoard(opts = {}) {
  const fallback = config.FEED_MARKET_LIMIT;
  const limit = boardLimit(opts.limit ?? fallback, fallback);
  const { rows } = await getPool().query(BOARD_SQL, [limit]);
  const markets = groupRows(rows, { carryForward: opts.carryForward !== false });
  // groupRows re-sorts runners but not markets; the board contract is
  // newest-frame-first, so the final order is settled here.
  markets.sort((a, b) => new Date(b.publish_time || 0) - new Date(a.publish_time || 0));
  return decorate(markets);
}

// One market's full ladder, by id.
//
// This is how the page prices the race you selected. The board list is capped
// (FEED_MARKET_LIMIT, 60 by default) and sorted newest-first, so with the
// catalogue at 1400+ markets it cannot be the source for an arbitrary
// selection — picking a race outside the cap used to silently render a
// DIFFERENT market's prices instead of admitting it had none.
async function fetchMarket(marketId) {
  if (marketId == null || String(marketId).trim() === '') return null;
  const p = getPool();
  const { rows } = await p.query(boardSql(true), [String(marketId)]);
  // carryForward: true — same delta semantics as the board list. A runner that
  // did not move has no row in the market's newest frame; a newest-frame-only
  // read made quiet runners blink off the market page while the board still
  // showed them. Carried prices arrive flagged, so the UI can render them as
  // not-live rather than missing.
  const [market] = groupRows(rows, { carryForward: true });
  if (!market) return null;
  decorate([market]);
  return market;
}

// Navigation tree, in the shape a bookmaker site browses by:
//   sport -> country -> track/competition -> meeting (event) -> race (market)
//
// Built in SQL rather than by walking markets in JS: the grouping is cheap for
// Postgres and would otherwise re-scan the same rows for every tree rebuild.
// One row per RACE, so the tree reaches the level a bettor actually clicks and
// carries the race's start time and market type for the node label.
const NAV_SQL = `
  SELECT sp.name                                   AS sport,
         sp.event_type_id                         AS sport_id,
         e.country_code                           AS country,
         COALESCE(e.competition_name, e.venue)    AS competition,
         e.event_id                               AS event_id,
         e.name                                   AS event_name,
         e.market_time                            AS event_time,
         m.market_id                              AS market_id,
         m.name                                   AS market_name,
         m.market_type                            AS market_type,
         m.market_time                            AS market_time,
         m.in_play                                AS in_play,
         m.status                                 AS market_status,
         -- Racing PLACE markets all carry the name "To Be Placed" regardless of
         -- how many runners win, so a meeting can hold eleven of them under one
         -- label. This is what tells Any 2 to place from Any 3 to place.
         sn.number_of_winners
    FROM markets m
    JOIN events e        ON e.event_id = m.event_id
    LEFT JOIN sports sp  ON sp.event_type_id = e.event_type_id
    LEFT JOIN LATERAL (
      SELECT number_of_winners
        FROM snapshots
       WHERE market_id = m.market_id
       ORDER BY publish_time DESC
       LIMIT 1
    ) sn ON TRUE
   WHERE m.status IN ('OPEN','OPEN_FOR_STREAMING')
   ORDER BY 1 NULLS LAST, 3 NULLS LAST, 4 NULLS LAST,
            e.market_time NULLS LAST, m.market_time NULLS LAST, m.name
`;

// A race label that distinguishes markets Betfair names identically.
//
// Racing PLACE markets are all called "To Be Placed"; what differs is how many
// runners win, and Betfair's own UI says "Any 2 to be placed". Without this a
// meeting shows eleven identical leaves and there is no way to tell them apart.
// Single-winner markets keep their plain name, which is already unambiguous.
function marketLabel(name, numberOfWinners) {
  const n = Number(numberOfWinners);
  if (!Number.isFinite(n) || n <= 1) return name;
  if (!/placed/i.test(name)) return `${name} — any ${n}`;
  return `${name} — any ${n} to be placed`;
}

// One nav row → the race leaf it contributes (kept out of the row pass so
// that pass stays flat and readable).
function raceFromRow(r) {
  return {
    market_id: r.market_id,
    market_name: r.market_name || 'Race',
    market_type: r.market_type || 'WIN',
    // Racing PLACE markets share one Betfair name ("To Be Placed"), so the
    // winner count is folded into the label here rather than left for the UI
    // to guess. One winner is a plain win and is not worth the words.
    market_label: marketLabel(r.market_name || 'Race', r.number_of_winners),
    number_of_winners: r.number_of_winners == null ? null : Number(r.number_of_winners),
    market_time: r.market_time,
    in_play: !!r.in_play,
  };
}

// Row-to-level pass of the tree: every level is a Map keyed on its own
// identity, so a race appearing under one meeting is never duplicated.
function navNodes(rows) {
  const sports = new Map();
  for (const r of rows) {
    const sportName = r.sport || 'Other';
    const country = r.country || 'Unknown';
    // The track level. Betfair's COMPETITION projection is empty for racing, so
    // this is normally the venue. An event that has neither yet (the name
    // backfill has not reached it) must still land somewhere real, and
    // "Unknown" is that: a node the user can open, not a stray dash. Using the
    // event name would nest a meeting inside itself.
    const competition = r.competition || 'Unknown track';

    if (!sports.has(sportName)) {
      sports.set(sportName, { sport: sportName, sport_id: r.sport_id, countries: new Map() });
    }
    const sport = sports.get(sportName);
    if (!sport.countries.has(country)) {
      sport.countries.set(country, { country, competitions: new Map() });
    }
    const comps = sport.countries.get(country).competitions;
    if (!comps.has(competition)) {
      comps.set(competition, { competition, meetings: new Map() });
    }
    const meetings = comps.get(competition).meetings;
    if (!meetings.has(r.event_id)) {
      meetings.set(r.event_id, {
        event_id: r.event_id,
        event_name: r.event_name || 'Unnamed meeting',
        starts_at: r.event_time,
        races: [],
      });
    }
    meetings.get(r.event_id).races.push(raceFromRow(r));
  }
  return sports;
}

// Map-to-arrays pass: the plain-JSON tree the API returns, with per-track
// race and in-play counts.
function nestNav(rows) {
  return [...navNodes(rows).values()].map((s) => ({
    sport: s.sport,
    sport_id: s.sport_id,
    countries: [...s.countries.values()].map((c) => ({
      country: c.country,
      competitions: [...c.competitions.values()].map((k) => {
        const meetings = [...k.meetings.values()];
        return {
          competition: k.competition,
          meetings,
          market_count: meetings.reduce((a, m) => a + m.races.length, 0),
          inplay_count: meetings.reduce((a, m) => a + m.races.filter((r) => r.in_play).length, 0),
        };
      }),
    })),
  }));
}

async function fetchNav() {
  const p = getPool();
  const { rows } = await p.query(NAV_SQL);
  return nestNav(rows);
}

// Cheap liveness probe for a health endpoint / admin stats.
async function health() {
  try {
    const p = getPool();
    const { rows } = await p.query(
      `SELECT max(publish_time) AS newest, count(DISTINCT market_id) AS markets
         FROM snapshots`
    );
    const r = rows[0] || {};
    const age = ageSeconds(r.newest);
    return {
      ok: true,
      newest_publish_time: r.newest || null,
      age_seconds: age,
      markets: Number(r.markets || 0),
      stale: age == null || age > config.FEED_STALE_SECONDS,
    };
  } catch (e) {
    // pg errors embed host, user and connection strings; the health body goes
    // to the client, so it must not carry them. Log the real detail
    // server-side (as the board/nav/market paths do) and answer generic.
    console.error('[feed] health check failed:', e.message);
    return { ok: false, error: 'Odds feed unavailable' };
  }
}

module.exports = {
  fetchBoard, fetchMarket, fetchNav, health, close,
  groupRows, nestNav, runnerOrder, bookPercentages, marketLabel,
  ageSeconds, boardSql, BOARD_SQL, NAV_SQL,
};
