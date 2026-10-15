'use strict';
// lib/feed/http.js — a GENERIC JSON-over-HTTP feed provider, driven by config.
//
// WHO THIS IS FOR. An Australian business holding a betting-exchange licence
// who has THEIR OWN data-feed API. Until now the only way to use that API was
// to fork lib/feed.js, because the price feed was hard-wired to the collector's
// `v_feed1`/`v_feed2` Postgres views. A fork is not a seam: it is a copy that
// drifts, and this codebase's most expensive recurring defect is a component
// that half-works rather than crashing.
//
// ── THE ONE RULE: IT DOES NOT SHAPE ANYTHING ─────────────────────────────────
// There is no second shaper here. This module's entire job is to turn a vendor's
// JSON into THE canonical row objects — one per (market, selection), ladders in
// an `odds` object — and then hand them to lib/feed/shape.js, which is the same
// code the Postgres provider uses. tests/feedprovider-conformance.test.js
// asserts the two produce deep-equal boards from the same underlying data.
//
// Two shapers would drift, and a drifting shaper is a wrong-price bug: the
// sub-1 price boundary, the pounds→cents conversion, the "an incomplete book
// reports null rather than a 980% figure" rule and the composite runner key are
// all things that have already been got wrong once here. A copy of that logic
// beside the original is four more chances.
//
// ── A MISCONFIGURED MAPPING FAILS LOUDLY, AT BOOT AND THEN ON THE WIRE ───────
// The specific hazard: a field map that names the wrong key produces markets
// with no name, no start time and no runners. Rendered, that is an empty board
// that LOOKS like "no fixtures today" — and an operator will read it as a quiet
// Tuesday. So:
//
//   AT BOOT    lib/config.js parses every map. A syntax error, an unknown key, an
//              empty key, an empty path, a duplicate key, or a MISSING REQUIRED
//              key all abort the launch. `node scripts/check-env-example.mjs`
//              compares the documented default against this code, so the two
//              cannot drift either.
//   ON THE WIRE  a market that maps to nothing usable, or a runner that does,
//              throws. The route turns that into the same 503 `feed_unavailable`
//              an unreachable feed gets, with the reason in the server log.
//
// A loud empty board is recoverable. A silent one is a venue that stops
// publishing prices and does not know it.
//
// ── NOTHING FROM CONFIG IS EVER LOGGED OR ECHOED ─────────────────────────────
// The bearer token and the static header value are read from config and used as
// header values. They never appear in an error message, a log line, or a body.
// The route's 503 body is the fixed generic `Odds feed unavailable` — the same
// boundary lib/feed/postgres.js relies on for `pg` errors, which embed the host,
// the user and often part of the connection string. The error this module throws
// carries the CONFIGURED PATH (`/board`) so an operator can tell which resource
// failed, and nothing else.
//
// ── ONE ATTEMPT PER REQUEST, AND WHY THERE IS NO RETRY ───────────────────────
// A retry loop against a feed that is already slow turns one slow upstream into
// N concurrent slow upstreams, and the venue pays for it in sockets and event
// loop. The timeout is the control; a caller that wants a second attempt asks
// again. One request, one timeout, one failure.
//
// ── THE BOUNDED READ ─────────────────────────────────────────────────────────
// An unbounded read from a third-party endpoint is a memory denial of service
// ON THE VENUE: a provider that answers with a 500MB body can OOM a process that
// was only trying to draw a ladder. The cap is enforced on the decoded stream,
// so it holds regardless of a Content-Length the provider chose to lie about.
// Same rule, same reasoning, and near enough the same code as
// `readBounded()` in lib/resultsfeed.js.
const config = require('../config');
const shape = require('./shape');
// The grammar and the vocabularies live in a dependency-free module so that
// lib/config.js can validate these maps at boot without importing this one.
// See lib/feed/fieldmap.js's header for what happens otherwise.
const { parseMap, pick, BOARD_VOCABULARY, NAV_VOCABULARY, HEALTH_VOCABULARY } = require('./fieldmap');

// A board of 60 markets with full ladders is a few hundred KB. 8 MiB is
// generous enough that no plausible feed trips it and small enough that a
// runaway response cannot take the process with it.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// The market statuses the Postgres provider's nav query keeps
// (`market_status IN ('OPEN','OPEN_FOR_STREAMING','OPEN_FOR_BETTING')`). The HTTP
// provider applies the SAME set so the two nav trees describe the same thing —
// but only to rows that actually carry a status. A vendor that does not publish
// one gets no filter, because inventing "not open" for a field it never sent
// would empty the entire sport rail.
const OPEN_STATUSES = new Set(['OPEN', 'OPEN_FOR_STREAMING', 'OPEN_FOR_BETTING']);

// ── mapping ──────────────────────────────────────────────────────────────────
/**
 * The path a canonical field maps to, DEFAULTING TO THE FIELD ITS OWN NAME.
 *
 * A field the operator did not mention is not mapped to nothing — it is mapped
 * to itself, which is what "the vendor already calls it that" means. Reading it
 * this way is why FEED_HTTP_MAP_* can list only the fields that actually need
 * renaming, instead of forcing an operator to write out thirty-four pairs to say
 * "use the defaults".
 */
const at = (map, key) => map.get(key) || key;

// Names, not literals: `groupRows` reads `odds.back` and `odds.lay` by those
// keys, and a typo here would produce a two-sided book with one empty side that
// looks like a real one-sided market. The shaper's own SIDE_BACK/SIDE_LAY are
// 'BACK'/'LAY' — the values it puts in each level's `side` — and these are the
// KEYS of the object it reads them from, which are the JSON's spelling.
const KEY_BACK = 'back';
const KEY_LAY = 'lay';

/**
 * One vendor market to its canonical ROWS — one per runner.
 *
 * The row shape is lib/feed/shape.js's contract and has not changed: the Postgres
 * provider gets it from SQL, this gets it from a field map, and both then go
 * through the same `shape()`. Anything this function cannot map is a THROW,
 * because the alternative is a market the renderer draws as a blank card.
 */
function rowsFromMarket(market, map, scale) {
  const marketId = pick(market, at(map, 'market_id'));
  const marketName = pick(market, at(map, 'market_name'));
  const startTime = pick(market, at(map, 'market_start_time'));
  if (marketId == null || String(marketId).trim() === '') {
    throw new Error('feed http: a market carried no id — the field map points market_id at the wrong path');
  }
  if (marketName == null || String(marketName).trim() === '') {
    throw new Error(`feed http: market ${marketId} carried no name — check the market_name mapping`);
  }
  if (startTime == null || String(startTime).trim() === '') {
    // Not a soft failure. `lib/offtime.js` treats an unparseable off time as
    // CLOSED, so a bad start time does not open trading — but a whole board of
    // markets with no start time is a board nobody can read, and it must not
    // arrive as an empty-looking success.
    throw new Error(`feed http: market ${marketId} carried no start time — check the market_start_time mapping`);
  }
  const list = pick(market, at(map, 'runners'));
  if (!Array.isArray(list)) {
    throw new Error(`feed http: market ${marketId} has no runners array — check the runners mapping`);
  }

  // Market-level fields, resolved once and copied onto every row: the canonical
  // row carries them per-selection because the view joins them per-selection, and
  // the shaper reads the first one it sees. Same contract, same consequence.
  const head = {
    market_id: marketId,
    market_name: marketName,
    market_start_time: startTime,
    market_status: pick(market, at(map, 'market_status')),
    fixture_id: pick(market, at(map, 'fixture_id')),
    event_name: pick(market, at(map, 'event_name')),
    sport_slug: pick(market, at(map, 'sport_slug')),
    event_type_id: pick(market, at(map, 'event_type_id')),
    event_type_name: pick(market, at(map, 'event_type_name')),
    competition_id: pick(market, at(map, 'competition_id')),
    competition_name: pick(market, at(map, 'competition_name')),
    country_code: pick(market, at(map, 'country_code')),
    fixture_venue: pick(market, at(map, 'fixture_venue')),
    market_type_code: pick(market, at(map, 'market_type_code')),
    market_venue: pick(market, at(map, 'market_venue')),
    is_resolved: pick(market, at(map, 'is_resolved')),
    total_matched: pick(market, at(map, 'total_matched')),
    inplay: pick(market, at(map, 'inplay')),
    bet_delay: pick(market, at(map, 'bet_delay')),
    publish_time: pick(market, at(map, 'publish_time')),
    odds_captured_at: pick(market, at(map, 'odds_captured_at')),
  };

  return list.map((runner) => {
    const selectionId = pick(runner, at(map, 'selection_id'));
    const runnerName = pick(runner, at(map, 'runner_name'));
    if (selectionId == null || String(selectionId).trim() === '') {
      throw new Error(`feed http: market ${marketId} has a runner with no id — check the selection_id mapping`);
    }
    if (runnerName == null || String(runnerName).trim() === '') {
      // A nameless runner renders as an empty ladder cell the bettor cannot
      // price, and there is no honest way to show that as anything else.
      throw new Error(`feed http: selection ${selectionId} of market ${marketId} has no name — check the runner_name mapping`);
    }
    return {
      ...head,
      selection_id: selectionId,
      runner_name: runnerName,
      sort_priority: pick(runner, at(map, 'sort_priority')),
      handicap: pick(runner, at(map, 'handicap')),
      selection_status: pick(runner, at(map, 'selection_status')),
      odds: oddsFromRunner(runner, map, scale),
    };
  });
}

/**
 * The `odds` object lib/feed/shape.js reads: `{back:[{price,size}], lay:[...]}`.
 *
 * The SIZE UNIT is the one thing this mapping cannot infer, and getting it wrong
 * is a 100x error on every stake shown to a bettor. The canonical unit is
 * POUNDS — Betfair's — because `levelFromRow` multiplies by 100 to reach integer
 * cents and that line is shared with the Postgres provider and must not fork.
 * So `FEED_HTTP_SIZE_SCALE` multiplies the provider's number into pounds before
 * it gets there: a vendor publishing cents sets `0.01`. The default of 1 is
 * right for a Betfair-shaped feed and wrong for most other conventions, which is
 * stated here, in .env.example and in docs/FEED.md rather than guessed at.
 */
function oddsFromRunner(runner, map, scale) {
  // THE PATHS HAVE DIFFERENT BASES, and it is worth stating once because it is
  // the thing an operator gets wrong first:
  //   `odds`      is read from the RUNNER;
  //   `back`/`lay` are read from inside the odds object it returned;
  //   `price`/`size` are read from inside each LEVEL.
  // So a vendor publishing `prices: {bets, offers}` maps as `odds=prices,
  // back=bets, lay=offers` — not `back=prices.bets`, which would look for
  // `prices.prices.bets` and quietly produce an empty ladder.
  const odds = pick(runner, at(map, 'odds'));
  if (odds == null || typeof odds !== 'object') return null;
  const backPath = at(map, 'back');
  const layPath = at(map, 'lay');
  const pricePath = at(map, 'price');
  const sizePath = at(map, 'size');
  const read = (levels, side) => {
    if (!Array.isArray(levels)) return [];
    return levels.map((l) => {
      const size = pick(l, sizePath);
      return {
        price: pick(l, pricePath),
        // `null` rather than 0 when there is no size: Betfair really does send
        // size = NULL for a price with no size behind it, and levelFromRow turns
        // a null into a level at ZERO cents rather than vanishing it. Multiplying
        // that null here would invent a zero BEFORE the shaper's own rule ran.
        size: size == null ? null : Number(size) * scale,
      };
    });
  };
  return {
    back: read(pick(odds, backPath), KEY_BACK),
    lay: read(pick(odds, layPath), KEY_LAY),
    // Mapped like the ladders, not hard-coded. See the note on the key in
    // lib/feed/fieldmap.js: an unmapped field is a field one provider can see
    // and the other cannot, which is a silent divergence on identical data.
    last_price_traded: pick(odds, at(map, 'last_price_traded')),
  };
}

// ── transport ────────────────────────────────────────────────────────────────

function FeedHttpError(message, reason) {
  const e = new Error(message);
  e.reason = reason;
  return e;
}

/**
 * One GET, one attempt, one timeout, a byte cap and a JSON parse.
 *
 * `path` is used only as a label in the error message, and the full URL is never
 * included: it carries the operator's host, and a host is infrastructure an
 * operator reads in their own log but has no business in a string that could be
 * echoed anywhere.
 */
async function getJson(cfg, fetchImpl, path, search) {
  if (!cfg.FEED_HTTP_URL) {
    // Configuration, not a transport failure — but it still has to be a 503
    // rather than a TypeError, because the route's catch is the only thing that
    // turns "this feed is unusable" into "Odds feed unavailable".
    throw FeedHttpError(`feed http: ${path} — FEED_HTTP_URL is not set`, 'not_configured');
  }
  // String join rather than `new URL(path, base)`: WHATWG resolution treats a
  // leading slash as absolute and throws away a base URL's path component, so
  // an operator hosting their feed API at https://example.com/v2/feed would
  // silently lose /v2/feed on every request.
  const base = String(cfg.FEED_HTTP_URL).replace(/\/+$/, '');
  const target = `${base}${path}${search || ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.FEED_HTTP_TIMEOUT_MS);
  try {
    const headers = { accept: 'application/json' };
    // Secrets go on the wire and NOWHERE ELSE. Not into the error, not into a
    // log, not into a state object a health endpoint could publish.
    if (cfg.FEED_HTTP_TOKEN) headers.authorization = `Bearer ${cfg.FEED_HTTP_TOKEN}`;
    if (cfg.FEED_HTTP_HEADER_NAME) headers[cfg.FEED_HTTP_HEADER_NAME] = cfg.FEED_HTTP_HEADER_VALUE || '';
    const res = await fetchImpl(target, {
      method: 'GET',
      headers,
      signal: controller.signal,
      // NO REDIRECTS, for the reason lib/resultsfeed.js gives at length: the
      // operator names one host and trusts that host, and following a redirect
      // discards exactly that trust — a compromised provider, a hijacked DNS
      // answer, or an open redirect on the configured host can hand the RESPONSE
      // to a host nobody configured. A price feed that answers from somewhere
      // else is a wrong-price feed.
      redirect: 'error',
    });
    if (!res.ok) {
      // Status only. The body is the vendor's, and a vendor error page can
      // contain the request URL, an internal hostname or a stack trace.
      throw FeedHttpError(`feed http: ${path} returned HTTP ${res.status}`, `http_${res.status}`);
    }
    return safeJson(await readBounded(res, MAX_RESPONSE_BYTES, path));
  } catch (e) {
    if (e && e.reason) throw e;
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw FeedHttpError(`feed http: ${path} timed out after ${cfg.FEED_HTTP_TIMEOUT_MS}ms`, 'timeout');
    }
    // An operator gets "unreachable" plus whatever the runtime said. Node's own
    // messages carry the host, which is fine HERE — this string goes to the
    // server log and nowhere else; the 503 body the client sees is fixed.
    throw FeedHttpError(`feed http: ${path} unreachable (${e && e.message ? String(e.message).slice(0, 200) : 'unknown'})`, 'unreachable');
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw FeedHttpError('feed http: response was not JSON', 'invalid_json');
  }
}

/**
 * Read a response body with a hard byte cap.
 *
 * A provider returning a 500MB body must not be able to OOM the venue to
 * deliver bad news. The cap is enforced on the decoded stream, so it holds
 * regardless of the Content-Length the provider chose to lie about.
 * Mirrors `readBounded()` in lib/resultsfeed.js.
 */
async function readBounded(res, maxBytes, path) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (text.length > maxBytes) throw FeedHttpError(`feed http: ${path} exceeded ${maxBytes} bytes`, 'response_too_large');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* the stream is being abandoned */ }
      throw FeedHttpError(`feed http: ${path} exceeded ${maxBytes} bytes`, 'response_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ── the provider ─────────────────────────────────────────────────────────────

/**
 * @param cfg       a config-shaped object; defaults to lib/config.js. Passed in
 *                  rather than required directly so the conformance suite can
 *                  exercise the transport with a base URL of 127.0.0.1 without
 *                  a second process.
 * @param fetchImpl the HTTP function. Defaults to the runtime's `fetch` and is a
 *                  seam only; nothing in this module mocks it.
 */
function httpProvider({ cfg = config, fetchImpl = globalThis.fetch } = {}) {
  const maps = {
    board: parseMap(cfg.FEED_HTTP_MAP_BOARD, BOARD_VOCABULARY, 'FEED_HTTP_MAP_BOARD'),
    nav: parseMap(cfg.FEED_HTTP_MAP_NAV, NAV_VOCABULARY, 'FEED_HTTP_MAP_NAV'),
    health: parseMap(cfg.FEED_HTTP_MAP_HEALTH, HEALTH_VOCABULARY, 'FEED_HTTP_MAP_HEALTH'),
  };
  const scale = Number(cfg.FEED_HTTP_SIZE_SCALE);
  const isPriced = (opts) => {
    // The contract asks the PROVIDER whether it carries prices; the operator
    // declares it, because a JSON feed cannot be asked what it does not
    // publish. An unpriced feed is a fixture list, and that is a legitimate
    // thing to point a venue at.
    if (opts && opts.priced !== undefined) return Boolean(opts.priced);
    return cfg.FEED_HTTP_PRICED !== false;
  };

  /** The markets array out of a response, or a loud failure. */
  const marketList = (doc, map, path) => {
    const list = pick(doc, at(map, 'markets'));
    if (!Array.isArray(list)) {
      throw FeedHttpError(`feed http: ${path} returned no array at the mapped markets path`, 'bad_shape');
    }
    return list;
  };

  return {
    name: 'http',

    priced: isPriced,

    async board({ limit, priced: wantPrices } = {}) {
      const fallback = cfg.FEED_MARKET_LIMIT;
      const capped = shape.boardLimit(limit == null ? fallback : limit, fallback);
      const doc = await getJson(cfg, fetchImpl, cfg.FEED_HTTP_BOARD_PATH);
      // The cap is applied HERE, on the market list, because it is a cap on
      // MARKETS. Applying it to rows is the bug boardSql's comment describes in
      // full: the view is one row per selection, so a cap of 20 returned two
      // markets. A vendor document is nested the same way, so it is sliced
      // before expansion rather than after.
      const list = marketList(doc, maps.board, cfg.FEED_HTTP_BOARD_PATH);
      const rows = [];
      for (const m of list.slice(0, capped)) {
        rows.push(...rowsFromMarket(m, maps.board, scale));
      }
      return shape.shape(rows, { priced: wantPrices === undefined ? isPriced({}) : wantPrices });
    },

    async market(id, { priced: wantPrices } = {}) {
      if (id == null || String(id).trim() === '') return null;
      const path = marketPath(cfg, id);
      const doc = await getJson(cfg, fetchImpl, path);
      // ONE RULE, and it is the field map's own: read the document through the
      // SAME `markets` path the board endpoint uses. A vendor that answers a
      // single-market read with `{markets:[…]}` gets its one element; a vendor
      // whose single-market resource IS the object at the root gets the object,
      // because the mapped path resolves to nothing there. Guessing a second
      // convention per vendor is the kind of thing an operator should not have
      // to discover from a 404.
      const listed = pick(doc, at(maps.board, 'markets'));
      // An EMPTY list is a market that does not exist — the feed rotates markets
      // away constantly, so "the race you picked has closed" is an ordinary
      // outcome the page renders as such, and the route answers 200 with
      // `market: null`. Only a document that is not a market at all is a mapping
      // failure, and that one is loud.
      if (Array.isArray(listed) && listed.length === 0) return null;
      const market = Array.isArray(listed) ? listed[0] : doc;
      if (market == null || typeof market !== 'object') {
        throw FeedHttpError('feed http: single-market read returned no market', 'bad_shape');
      }
      const rows = rowsFromMarket(market, maps.board, scale);
      const [shaped] = shape.shape(rows, { priced: wantPrices === undefined ? isPriced({}) : wantPrices });
      return shaped || null;
    },

    async nav() {
      const doc = await getJson(cfg, fetchImpl, cfg.FEED_HTTP_CATALOGUE_PATH);
      const list = marketList(doc, maps.nav, cfg.FEED_HTTP_CATALOGUE_PATH);
      const rows = [];
      for (const entry of list) {
        const row = {};
        for (const key of Object.keys(NAV_VOCABULARY)) {
          if (key === 'markets') continue;
          row[key] = pick(entry, at(maps.nav, key));
        }
        // The SAME open-status filter the Postgres nav query applies, and only
        // to rows that carry a status — see OPEN_STATUSES.
        if (row.market_status != null && !OPEN_STATUSES.has(String(row.market_status).toUpperCase())) continue;
        if (row.market_id == null || String(row.market_id).trim() === '') {
          throw FeedHttpError('feed http: a catalogue entry carried no market id — check the market_id mapping', 'bad_shape');
        }
        rows.push(row);
      }
      return shape.nestNav(rows);
    },

    async health() {
      // Same generic-message contract as the Postgres provider, for the same
      // reason: a fetch failure can carry the operator's host, and the caller
      // gets "Odds feed unavailable" while the reason goes to the server log.
      try {
        const doc = await getJson(cfg, fetchImpl, cfg.FEED_HTTP_HEALTH_PATH);
        const row = {};
        for (const key of Object.keys(HEALTH_VOCABULARY)) {
          row[key] = pick(doc, at(maps.health, key));
        }
        return shape.healthPayload({
          row,
          // NO DELAY PROBE, and the answer is the assumed one rather than a
          // fresh one. There is no `feed_run` row behind an operator's API to
          // ask, so `assumed` is not a shortcut — it is the only honest answer
          // available. "Assumed delayed is the safe direction: it makes
          // data_age_seconds null rather than wrong."
          delay: { is_delay: true, source: 'assumed' },
          hasPrices: isPriced({}),
          // There is no view behind this feed, and inventing a feed number
          // would be the same fabrication healthPayload is written against.
          feed: null,
        });
      } catch (e) {
        console.error('[feed] health check failed:', e.message);
        return { ok: false, error: 'Odds feed unavailable' };
      }
    },

    async close() {
      // Nothing is held: the transport is the runtime's process-global fetch
      // pool, shared with the rest of the venue, and it is torn down when the
      // process exits. This exists because the contract requires `close()` and
      // server.js calls it on shutdown — a provider that implements it by doing
      // nothing is honest, where one that pretended to release the pool would
      // not be.
    },
  };
}

/**
 * The single-market path, with the id substituted.
 *
 * `{id}` anywhere in the configured path is replaced, percent-encoded. With no
 * placeholder the id is appended as a query parameter, because that is the other
 * near-universal convention and guessing which one a vendor uses is exactly the
 * kind of thing an operator should not have to find out from a 404.
 */
function marketPath(cfg, id) {
  const raw = cfg.FEED_HTTP_MARKET_PATH || '/market';
  const encoded = encodeURIComponent(String(id));
  if (raw.includes('{id}')) return raw.split('{id}').join(encoded);
  return raw.includes('?') ? `${raw}&id=${encoded}` : `${raw}?id=${encoded}`;
}

module.exports = {
  httpProvider,
  marketPath,
  MAX_RESPONSE_BYTES,
  // The grammar and the vocabularies are re-exported here so that the whole
  // field-mapping surface is reachable from the provider that uses it, while the
  // implementation stays in a dependency-free module lib/config.js can also
  // reach. See lib/feed/fieldmap.js.
  parseMap,
  pick,
  BOARD_VOCABULARY,
  NAV_VOCABULARY,
  HEALTH_VOCABULARY,
};