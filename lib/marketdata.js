'use strict';
// lib/marketdata.js — matched volume per price level, the price-history series,
// the market-mover view, and the retention policy for the trade tape (#93).
//
// WHY THIS FILE EXISTS. `price_history` was written on every fill and read by
// nothing in production: a complete, indexed table consulted by no code path.
// That is not a missing feature, it is the same shape as the dead controls in
// docs/ROADMAP.md — a thing that exists and reports nothing. It was also the
// reason the ladder had no matched-volume column, which is the column Betfair
// traders read on every level of every price.
//
// FOUR READERS, AND THEY HAVE DIFFERENT NEEDS. That difference is what the
// retention policy is built from, so it is stated before the code:
//
//   1. THE LADDER — matched volume at each price, for a WINDOW. A trader reads
//      the last few minutes of trading, not the history of the market. Default
//      window is 10 minutes, which is lib/inplay.js's own default for
//      windowed traded volume — the two are the same question asked twice, and
//      this file answers both from ONE query rather than two that can disagree.
//
//   2. THE PRICE SERIES (the chart) — the shape of the price over a window, at
//      a resolution a client can plot. This is the reader that makes
//      price_history worth keeping at all, and it is the one that sets the
//      retention window below.
//
//   3. MOVERS — which runners moved, in money, in the window. The board's
//      mover view is `movers()` below, which calls the SAME `matchedByLevel()`
//      the ladder calls and rolls its rows up by selection. There is no second
//      query for it: two would drift, and the drift would be silent.
//
//   4. AN AUDIT — and this one does NOT need price_history. `matches` is the
//      executed tape that settlement reads and it is never pruned;
//      `audit_log` is the audit trail, with its own retention. price_history
//      carries no field those do not already carry (selection_id, price, at,
//      one row per fill — all on the match), so it is a DERIVED projection and
//      pruning it loses nothing that cannot be recomputed. That is why the
//      ladder's matched column is computed from the rollup rather than from the
//      tape: a money figure must never depend on a table that may be deleted.
//
// WHY NOT JUST SELECT FROM price_history FOR THE LADDER. Because node:sqlite is
// SYNCHRONOUS. docs/ARCHITECTURE.md already flags that a scan "blocks the whole
// single-threaded server for its duration", and MAX_SSE_CLIENTS bounds
// long-lived streams while nothing bounds a synchronous read. The board polls
// every 15 seconds, so a per-frame aggregate over the whole fill history is
// exactly the read this codebase must not add. So:
//
//   - MATCHED VOLUME reads `price_matched_levels`, a MINUTE-BUCKETED rollup
//     maintained by a trigger in lib/store.js. Its cost depends on how many
//     distinct (selection, price, minute) combinations traded in the window,
//     not on how many fills occurred — the property that makes a per-frame read
//     flat as venue volume grows.
//   - THE SERIES reads `price_history` through `idx_price_history_selection
//     (selection_id, at)`, which is the index that table was built for: an
//     index RANGE over ONE selection's fills inside the requested window, then
//     bucketed in SQL so the rows that reach this process are bounded by the
//     point count rather than by the fill count.
//
// Both are aggregates, and both have a hard cap on the rows they can return.
const { httpError } = require('./auth');

// ── The numbers, and why each one is here ────────────────────────────────

// 10 minutes: lib/inplay.js's default for `tradedVolume` and
// `volumeBySelection`. Reusing it is deliberate — the ladder's matched column
// and the in-play windowed-volume report answer the same question ("what
// traded lately, in money") and two defaults would be two answers.
const DEFAULT_WINDOW_MINUTES = 10;

// THE RETENTION WINDOW. 30 days.
//
// It is a compromise between two real constraints, and it is worth naming both:
//   - a chart of a market's price shape is only interesting while somebody is
//     still looking at it, and 30 days is longer than any serious read;
//   - an audit that needs a price older than 30 days needs `matches` (never
//     pruned) or `audit_log` (its own retention), not this table.
//
// The value is a CONSTANT and not a config key for the same reason
// lib/config.js's API_VERSION is: it is the contract of a reader. An operator
// who could shorten it from a .env could silently make a chart that answered
// last week 400 for a window that worked yesterday, with no version change and
// nothing in a release note. If that trade-off ever needs to move per venue,
// the honest move is to move this line in review.
const RETENTION_DAYS = 30;

// The series endpoint may not be asked for more than the retention window. A
// chart silently truncated to what survived the prune is a WRONG chart — it
// looks like a quiet market rather than a deleted one — so the request is
// refused instead, with `window_too_wide` as the machine-readable code.
const MAX_WINDOW_MINUTES = RETENTION_DAYS * 24 * 60;

// Series resolution. The point count is what bounds the rows this process
// receives; `points` is a cap, and the bucket size is derived from the window
// so a short window still returns detail rather than one averaged point.
const MAX_SERIES_POINTS = 240;
const MIN_BUCKET_SECONDS = 60;

// A hard ceiling on the rows ONE aggregate may return.
//
// `matchedByLevel` groups by (selection, market, price); on a venue with a
// pathological number of distinct prices per runner that product can be large,
// and a synchronous `LIMIT`-less GROUP BY over it is the unbounded read this
// file exists to avoid. Truncation is ordered biggest-first, so what is dropped
// is the smallest level of a market nobody is trading — and the failure
// direction is the safe one: a level outside the top MAX_LEVEL_GROUPS reads as
// UNMATCHED ONLY, which understates liquidity rather than inventing it.
const MAX_LEVEL_GROUPS = 5000;

// How many markets one aggregate may be asked about. See openMarketScope(): the
// scope has to be a concrete id list for the index to be usable at all, and a
// ten-thousand-placeholder IN list is a different problem in a different shape.
const MAX_MARKET_SCOPE = 250;

// Pruning is batched AND capped, for the same reason a read is. An unbounded
// DELETE on a synchronous connection holds the single writer for its duration,
// so one pass deletes at most PRUNE_MAX_BATCHES × PRUNE_BATCH_ROWS rows and then
// says so, rather than blocking the server for however long a huge tape takes.
const PRUNE_BATCH_ROWS = 2000;
const PRUNE_MAX_BATCHES = 25;

// ── The one query the ladder and the movers share ─────────────────────────
//
// ONE template, called with the market set it should answer for. `movers()`
// below passes no market set; the ladder passes one market. If that ever became
// two SQL strings, the board's mover view and the ladder's matched column
// would be able to disagree about the same minute, and nothing would notice.
//
// THE MARKET SCOPE IS AN ALWAYS-CONCRETE `IN (?, ?, …)` LIST, and the reason is
// measured, not stylistic. The first version of this query wrote the filter as
//
//     AND (? IS NULL OR market_id IN (SELECT value FROM json_each(?)))
//
// so one statement could answer "every market" and "these markets". On SQLite
// 3.53 that disjunction defeats the index: the planner falls back to
//
//     SCAN price_matched_levels USING COVERING INDEX idx_price_matched_levels_market
//
// i.e. every minute-bucket row on the venue, on every board frame. node:sqlite
// is synchronous, so that is precisely the unbounded per-frame read this file
// exists to prevent, and it was completely invisible — the query returns the
// right rows either way. The `json_each` half is innocent on its own: with the
// disjunction removed it plans as `SEARCH … (market_id=? AND bucket>?)` like the
// plain list. It is the `OR` that costs the index.
//
// So the scope is always concrete. "Every market" is resolved by
// `openMarketScope()` rather than expressed in SQL, which also settles what an
// EMPTY scope means: no ids ⇒ no rows, never "everything". `market_id IN (NULL)`
// plans as an index search and matches nothing at all, which is a very quiet way
// to serve an empty board.
//
// The bucket cutoff is a BOUND PARAMETER from `bucketCutoff()` rather than an
// inline `strftime(…, datetime('now', ?))`. Both plan as an index range here —
// that one really is equivalent — but the bound parameter is a single definition
// of "the start of the current minute" shared with the pruner, so the window and
// the retention cutoff cannot drift apart.
const MARKET_ID_LIST = '{{MARKET_IDS}}';
const MATCHED_BY_LEVEL_SQL = `
  SELECT selection_id,
         market_id,
         price_cents,
         price_cents / 100.0 AS price,
         SUM(matched_cents) AS matched_cents,
         SUM(fills) AS fills
    FROM price_matched_levels
   WHERE market_id IN (${MARKET_ID_LIST})
     AND bucket >= ?
   GROUP BY selection_id, market_id, price_cents
   ORDER BY matched_cents DESC
   LIMIT ?`;

/**
 * The start of the current minute, as a bucket key.
 *
 * Floored rather than truncated-toward-now, so the window INCLUDES the minute
 * in progress. `price_matched_levels.bucket` and this are the same
 * `YYYY-MM-DD HH:MM` string for the same reason — the trigger builds buckets
 * with SQLite's `strftime('%Y-%m-%d %H:%M', at)` — and a mismatch between them
 * would silently drop the current minute's trading, which is the minute a
 * trader most wants to see.
 */
function bucketCutoff(minutes) {
  const ms = Date.now() - minutes * 60_000;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

/**
 * Clamp a caller-supplied window.
 *
 * Mirrors lib/inplay.js's `-${Math.max(1, Number(m) || 10)} minutes` handling so
 * the two report the same window for the same input, and adds the ceiling: a
 * window past the retention window is a REFUSAL, not a clamp. Clamping it
 * would answer a different question than the one asked and say nothing.
 */
function windowMinutes(raw, { max = MAX_WINDOW_MINUTES } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_MINUTES;
  if (n > max) {
    throw httpError(400, 'Window is wider than the retained price history', {
      code: 'window_too_wide',
      window_minutes: n,
      max_window_minutes: max,
      retention_days: RETENTION_DAYS,
    });
  }
  return Math.floor(n);
}

function marketIds(marketIdsIn) {
  if (marketIdsIn == null) return null;
  return [...new Set(marketIdsIn.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

/**
 * The board's default scope: the markets it can actually show, capped.
 *
 * A mover view has to answer for the WHOLE board, so "every market" cannot be
 * written as "no market filter": the rollup's index leads on market_id, so a
 * bare `bucket >= ?` plans as a covering-index SCAN of every minute bucket on
 * the venue (measured on SQLite 3.53 — see the note on MATCHED_BY_LEVEL_SQL
 * above). The scope is therefore always a concrete id list.
 *
 * The cap is reported, never silent: a caller that asked about a venue with
 * 900 open markets gets the busiest 250 and a `markets_available` saying 900.
 * A view that quietly covered a tenth of the board and claimed the rest was
 * flat would be the exact failure this repo keeps finding.
 */
function openMarketScope(db) {
  const rows = db
    .prepare("SELECT id FROM markets WHERE status IN ('open','suspended') ORDER BY id")
    .all();
  return { ids: rows.slice(0, MAX_MARKET_SCOPE).map((r) => r.id), available: rows.length };
}

/**
 * Matched volume per (selection, price) over a window. THE reader behind both
 * the ladder's matched column and the board's mover view.
 *
 * Returns `[{ selection_id, market_id, price, matched_cents, fills }]`,
 * biggest first.
 *
 * An EMPTY market scope answers with the empty array rather than with every
 * market: "the board asked about these markets and none of them exist" must not
 * be answered by the whole venue's volume. That, and the index constraint above,
 * are why the scope can never be a nullable list inside the SQL.
 *
 * CASHED-OUT LEGS ARE INCLUDED. `matches.cashout` is authoritative for money —
 * a buyout supersedes a leg's exposure, so every report filters `cashout = 0` —
 * but the ladder renders this beside `markets.total_matched_cents` and the
 * in-play `tradedVolume`, neither of which excludes buyouts. A ladder that
 * quietly disagreed with the market's own matched total would be worse than
 * having no column at all. `price_matched_levels`'s comment says the same thing
 * where the number is produced, so the two cannot drift.
 */
function matchedByLevel(db, { marketIds: scope = null, window = DEFAULT_WINDOW_MINUTES } = {}) {
  const minutes = windowMinutes(window);
  const ids = marketIds(scope);
  if (!ids || !ids.length) return [];
  const sql = MATCHED_BY_LEVEL_SQL.replace(MARKET_ID_LIST, ids.map(() => '?').join(', '));
  return db.prepare(sql)
    .all(...ids, bucketCutoff(minutes), MAX_LEVEL_GROUPS)
    .map((r) => ({
      selection_id: r.selection_id,
      market_id: r.market_id,
      price: r.price,
      matched_cents: r.matched_cents,
      fills: r.fills,
    }));
}

/**
 * Attach matched volume to a book, level by level, IN PLACE.
 *
 * `book` is `lib/match.js`'s bookFor() output and is left structurally
 * untouched: every level gains `matched_cents` and `matched_fills`, and each
 * selection gains the window's total. A level that never traded gains `0`/`0`
 * rather than being absent. An existing reader of `book` sees exactly the same
 * levels, prices and sizes it saw before — the column is additive, which is the
 * same contract bookFor() itself makes when it started carrying `version` (#92).
 *
 * PURE, and it takes rows rather than a database: the board renders EVERY
 * market, so calling the querying form once per market would multiply the
 * single-threaded server's blocking read by the size of the catalogue. The
 * caller fetches ONCE with `matchedByLevel` over the whole market set and
 * merges each market's rows here — which is also what makes the ladder and the
 * mover view demonstrably the same read.
 */
function attachRows(book, rows) {
  const bySelection = new Map();
  for (const r of rows) {
    const key = `${r.selection_id}:${r.price.toFixed(2)}`;
    const agg = bySelection.get(key) || { matched_cents: 0, fills: 0 };
    agg.matched_cents += r.matched_cents;
    agg.fills += r.fills;
    bySelection.set(key, agg);
  }
  // The SELECTION total, for the reason in the comment on `selections[].m`.
  const totals = new Map();
  for (const r of rows) {
    const agg = totals.get(r.selection_id) || { matched_cents: 0, fills: 0 };
    agg.matched_cents += r.matched_cents;
    agg.fills += r.fills;
    totals.set(r.selection_id, agg);
  }
  for (const sel of book) {
    for (const side of ['back', 'lay']) {
      for (const lv of sel[side] || []) {
        const hit = bySelection.get(`${sel.selection_id}:${Number(lv.price).toFixed(2)}`);
        lv.matched_cents = hit ? hit.matched_cents : 0;
        lv.matched_fills = hit ? hit.fills : 0;
      }
    }
    // THE SELECTION'S OWN TOTAL, and it is not a convenience.
    //
    // `bookFor` only lists prices with UNMATCHED size left, so a price level
    // that has been completely traded out vanishes from the ladder — and with it
    // the matched figure for the place where all that money actually changed
    // hands. The level column therefore cannot be the whole story, and a trader
    // watching a level disappear would see the volume leave the screen.
    //
    // The mover view already needs the number (it is the same rows, rolled up),
    // so the ladder gets it on the runner row instead of losing it.
    const t = totals.get(sel.selection_id);
    sel.matched_cents = t ? t.matched_cents : 0;
    sel.matched_fills = t ? t.fills : 0;
    sel.matched_window_minutes = DEFAULT_WINDOW_MINUTES;
  }
  return book;
}

/** `attachRows` for the one-market case, which is what the trading desk reads. */
function attachMatchedLevels(db, book, { marketId, window = DEFAULT_WINDOW_MINUTES } = {}) {
  return attachRows(book, matchedByLevel(db, { marketIds: [marketId], window }));
}

/**
 * The board's mover view: runners ranked by what traded in the window.
 *
 * BUILT ON `matchedByLevel`, not on a second query. It is the same statement,
 * the same window and the same rows the ladder reads — this function only rolls
 * them up by selection instead of keeping the price level. A separate mover
 * query would be a second answer to "what traded lately", and the two would
 * disagree the first time either was edited.
 *
 * `marketIds` scopes it to the board's own markets; omitted, it answers for
 * every open market up to MAX_MARKET_SCOPE and says how many it covered.
 */
function movers(db, { marketIds: scope = null, window = DEFAULT_WINDOW_MINUTES, limit = 20 } = {}) {
  const minutes = windowMinutes(window);
  const resolved = scope == null ? openMarketScope(db) : { ids: marketIds(scope) || [], available: null };
  const rows = matchedByLevel(db, { marketIds: resolved.ids, window: minutes });
  const bySelection = new Map();
  for (const r of rows) {
    const key = r.selection_id;
    const agg = bySelection.get(key) || {
      selection_id: r.selection_id,
      market_id: r.market_id,
      name: null,
      matched_cents: 0,
      fills: 0,
      levels: 0,
      top_price: null,
      lowest_price: null,
    };
    agg.matched_cents += r.matched_cents;
    agg.fills += r.fills;
    agg.levels += 1;
    if (agg.top_price === null || r.price > agg.top_price) agg.top_price = r.price;
    if (agg.lowest_price === null || r.price < agg.lowest_price) agg.lowest_price = r.price;
    bySelection.set(key, agg);
  }
  const names = new Map(
    db.prepare('SELECT id, name FROM selections WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...bySelection.keys()]))
      .map((r) => [r.id, r.name])
  );
  const ranked = [...bySelection.values()]
    .map((m) => ({ ...m, name: names.get(m.selection_id) || null }))
    .sort((a, b) => b.matched_cents - a.matched_cents || a.selection_id - b.selection_id);
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20;
  return {
    window_minutes: minutes,
    markets_considered: resolved.ids.length,
    markets_available: resolved.available,
    movers: ranked.slice(0, cap),
  };
}

// ── The price-history series: price_history's production reader ──────────

/**
 * A runner's traded price over a window, bucketed in SQL.
 *
 * The bucket is what makes this an aggregate rather than a read: SQLite groups
 * inside the index range and returns `points` rows, so the row count this
 * process receives is bounded by the resolution asked for rather than by how
 * many fills happened. Bucket size is derived from the window (never below
 * MIN_BUCKET_SECONDS) so a ten-minute chart still has shape.
 *
 * `price` is the bucket's mean, with `low`/`high` beside it because a mean is
 * not a price a trader can back at. The window is capped at the retention
 * window — see windowMinutes() — so the endpoint cannot be asked for a window
 * in which rows have been pruned.
 */
// The price_history index is (selection_id, at), so this is an index RANGE over
// one runner's fills inside the window — never a table scan. Exported so
// tests/marketdata.test.js asserts the plan of the statement actually used
// rather than of a copy that could drift.
const PRICE_SERIES_SQL = `
  SELECT CAST(CAST(strftime('%s', at) AS INTEGER) / ? AS INTEGER) AS bucket,
         MIN(at)              AS at,
         ROUND(AVG(price), 4) AS price,
         MIN(price)           AS low,
         MAX(price)           AS high,
         COUNT(*)             AS fills
    FROM price_history
   WHERE selection_id = ?
     AND at >= datetime('now', ?)
   GROUP BY bucket
   ORDER BY bucket`;

function priceSeries(db, selectionId, { window = DEFAULT_WINDOW_MINUTES, points = MAX_SERIES_POINTS } = {}) {
  const minutes = windowMinutes(window);
  const sel = db.prepare('SELECT id, name, market_id, ltp FROM selections WHERE id = ?').get(selectionId);
  if (!sel) throw httpError(404, 'Selection not found');

  const wanted = Number.isInteger(points) && points > 0 ? Math.min(points, MAX_SERIES_POINTS) : MAX_SERIES_POINTS;
  const bucketSeconds = Math.max(MIN_BUCKET_SECONDS, Math.ceil((minutes * 60) / wanted));
  const rows = db.prepare(PRICE_SERIES_SQL).all(bucketSeconds, selectionId, `-${minutes} minutes`);

  return {
    selection_id: sel.id,
    name: sel.name,
    market_id: sel.market_id,
    ltp: sel.ltp,
    window_minutes: minutes,
    bucket_seconds: bucketSeconds,
    retention_days: RETENTION_DAYS,
    points: rows.length,
    series: rows.map((r) => ({
      at: r.at,
      price: r.price,
      low: r.low,
      high: r.high,
      fills: r.fills,
    })),
  };
}

// ── Retention ────────────────────────────────────────────────────────────

/**
 * THE RETENTION POLICY, as one object, so the docs, the tests, the endpoint
 * that refuses over-wide windows and the pruner cannot disagree about it.
 *
 * Every field here is derived from a reader above; none of them is a round
 * number someone liked.
 */
function retentionPolicy() {
  return {
    table: 'price_history',
    rollup_table: 'price_matched_levels',
    // The window every reader above is served from. A chart can show this far
    // back; the ladder and the movers ask for a WINDOW inside it.
    retention_days: RETENTION_DAYS,
    default_window_minutes: DEFAULT_WINDOW_MINUTES,
    max_window_minutes: MAX_WINDOW_MINUTES,
    max_series_points: MAX_SERIES_POINTS,
    // Bounded, because a synchronous DELETE blocks the single writer.
    prune_batch_rows: PRUNE_BATCH_ROWS,
    prune_max_batches: PRUNE_MAX_BATCHES,
    // What actually constrains the window. Stated so the next person who
    // proposes shortening it has to read why before they do.
    readers: [
      {
        reader: 'ladder matched volume',
        needs: `a window (default ${DEFAULT_WINDOW_MINUTES} minutes)`,
        served_by: 'price_matched_levels',
      },
      {
        reader: 'price series (chart)',
        needs: `up to ${RETENTION_DAYS} days, bucketed`,
        served_by: 'price_history',
      },
      {
        reader: 'market movers',
        needs: `a window (default ${DEFAULT_WINDOW_MINUTES} minutes)`,
        served_by: 'price_matched_levels',
      },
      {
        reader: 'audit',
        needs: 'nothing from this table — matches is the executed tape and is never pruned; audit_log carries its own retention',
        served_by: 'matches',
      },
    ],
  };
}

/**
 * Prune the tape and its rollup to the retention window.
 *
 * A pass deletes at most `PRUNE_BATCH_ROWS × PRUNE_MAX_BATCHES` rows of each and
 * then STOPS, reporting `more_remaining`. That is not a limitation dressed up:
 * node:sqlite is synchronous and holds the single writer for the duration of a
 * statement, so a prune that tried to catch up in one call would block the
 * server for as long as it took. An operator calls it again (or schedules it)
 * and the response says whether there is more to do.
 *
 * THE CONTRACT THIS EXISTS TO KEEP: nothing inside the retention window is
 * deleted. The cutoff is computed the same way `priceSeries` bounds a window, so
 * a chart the endpoint will still serve is a chart the pruner cannot empty.
 * tests/marketdata.test.js asserts it from both sides — the rows inside the
 * window survive a pass that removes rows outside it.
 *
 * BOTH TABLES, because pruning only the tape leaves the rollup to become the
 * next unbounded table, which is the same conversation one table later.
 */
function prunePriceHistory(db, { retentionDays = RETENTION_DAYS } = {}) {
  const days = Number.isFinite(Number(retentionDays)) && Number(retentionDays) > 0
    ? Math.floor(Number(retentionDays))
    : RETENTION_DAYS;
  const cutoff = db.prepare("SELECT datetime('now', ?) AS t").get(`-${days} days`).t;

  const drain = (table, column, keyCols) => {
    // The key columns, not `rowid`: price_matched_levels is WITHOUT ROWID, so
    // it has no rowid to select and a delete addressed by one would throw
    // "no such column" — the failure mode this file's own comments keep
    // warning about. Row-value IN is SQLite 3.15+ and the engine here is 3.53.
    const inList = `(${keyCols.join(', ')}) IN (SELECT ${keyCols.join(', ')} FROM ${table} WHERE ${column} < ? LIMIT ?)`;
    let deleted = 0;
    let batches = 0;
    for (; batches < PRUNE_MAX_BATCHES; batches++) {
      const n = db.prepare(`DELETE FROM ${table} WHERE ${inList}`).run(cutoff, PRUNE_BATCH_ROWS).changes;
      deleted += n;
      if (n < PRUNE_BATCH_ROWS) return { deleted, batches: batches + 1, more: false };
    }
    return { deleted, batches, more: true };
  };

  const tape = drain('price_history', 'at', ['id']);
  const rollup = drain('price_matched_levels', 'bucket', ['selection_id', 'price_cents', 'bucket']);
  const oldest = db.prepare('SELECT MIN(at) AS at FROM price_history').get().at;
  return {
    retention_days: days,
    cutoff,
    oldest_remaining_at: oldest,
    tape_rows_deleted: tape.deleted,
    rollup_rows_deleted: rollup.deleted,
    batches: tape.batches + rollup.batches,
    // TRUE means "there is more to do — call again". Never silently implied.
    more_remaining: tape.more || rollup.more,
  };
}

module.exports = {
  DEFAULT_WINDOW_MINUTES,
  // Exported so tests/marketdata.test.js can assert the QUERY PLAN of the
  // statement actually used, rather than of a copy of it that could drift.
  MATCHED_BY_LEVEL_SQL,
  MAX_WINDOW_MINUTES,
  MAX_SERIES_POINTS,
  PRICE_SERIES_SQL,
  RETENTION_DAYS,
  attachMatchedLevels,
  attachRows,
  bucketCutoff,
  matchedByLevel,
  movers,
  openMarketScope,
  priceSeries,
  prunePriceHistory,
  retentionPolicy,
  windowMinutes,
};