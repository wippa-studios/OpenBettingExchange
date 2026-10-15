'use strict';
// lib/feed/shape.js — the CANONICAL market shape, and the only code that makes it.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
// Everything here used to live inside lib/feed.js, which also owned the `pg`
// pool and the `v_feed1`/`v_feed2` SQL. That was fine while there was one
// reader. The moment a second FEED SOURCE exists — an operator's own HTTP feed
// API instead of the Betfair collector's Postgres views — the question this file
// answers becomes a shared one, and a shared answer needs a shared owner.
//
// The rule this file exists to enforce: THERE IS ONE SHAPER. `groupRows` turns
// rows into markets, `decorate` stamps age and book percentages on them,
// `shape` is the two composed, and `nestNav` builds the navigation tree. Both
// providers call into here; neither re-implements any of it.
//
// A second shaper would not be a duplicate that drifts slowly. It would drift in
// exactly the places that matter, because those places are the awkward ones:
// the sub-1 price boundary, the pounds→cents conversion, the "an incomplete book
// reports null rather than a 980% figure" rule, the composite runner key. Each
// of those is a bug somebody already made once (see the note on `levelFromRow`
// and on `bookPercentages`), and a fix applied to one copy while the other
// serves a different venue's prices is a wrong-price bug the engine cannot
// detect. So the rule is enforced structurally: there is one file, and both
// providers require it.
//
// ── WHAT "CANONICAL" MEANS HERE, EXACTLY ─────────────────────────────────────
// The input is ONE ROW PER (market, selection) — the shape `v_feed2` returns,
// with that selection's ladders already extracted into an `odds` JSONB object.
// The Postgres provider produces those rows from SQL; lib/feed/http.js produces
// the SAME row objects from a vendor's JSON via its field map. Neither shaper is
// involved and neither can see the other's transport, which is precisely why the
// two can be compared for byte-compatibility in the conformance suite rather
// than merely assumed to agree.
//
// Every function here is PURE. No clock of its own (they take `now` or read
// `Date.now()` in one place), no I/O, no config beyond the two thresholds named
// where they are used. That is what lets tests/feed.test.js and the conformance
// battery drive them with synthetic rows and assert the result offline.
const config = require('../config');

const SIDE_BACK = 'BACK';
const SIDE_LAY = 'LAY';

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
 * the query param, but a provider's board() is a lib export, and a direct caller
 * must not be able to ask for unbounded catalogue work.
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
 *
 * IT IS CALLED BY THE PROVIDERS RATHER THAN BY lib/feed.js, because the cap is
 * part of the CONTRACT: "board({limit}) never returns more markets than limit"
 * has to hold for a provider whose `limit` arrives from a vendor URL rather than
 * from this codebase's query string. One implementation, called at both entry
 * points, is what makes that claim true for the Postgres path as well.
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
 * THE ORDER IS THE QUERY'S. `groupRows` walks rows into a Map, and a Map
 * iterates in insertion order, so the markets come out in exactly the sequence
 * the rows arrived — which for the Postgres provider is book freshness first and
 * start time only as a tiebreak (see boardSql), and for the HTTP provider is
 * whatever order the vendor published and the configured limit did not remove.
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
 * There is no ordering here on purpose. The producer is the single place that
 * decides what the board looks like, and `boardSql` is a pure function of the
 * feed number, so it can be asserted offline.
 */
function shape(rows, opts = {}) {
  return decorate(groupRows(rows, { priced: opts.priced }));
}

// A market label that distinguishes markets Betfair names identically.
//
// Retained from the previous implementation, which read `number_of_winners` from
// the recorder's snapshots. This comment used to say the collector does not
// capture that field; it does — see the note on navSql in lib/feed/postgres.js,
// and the collector's own models.py / writer.py / snapshot.py / mapping.py. What
// is missing is the column in navSql's SELECT, so callers pass null today and
// the label falls back to Betfair's own name. Kept because the moment horse
// racing is added this is the function that has to work.
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

function odds_age(t, now = Date.now()) {
  if (!t) return null;
  const ms = now - new Date(t).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

/**
 * The health payload, as a PURE function of what the probe returned.
 *
 * Extracted (like `boardSql` and `healthSql`) so it can be asserted offline,
 * because the question this payload exists to answer — "whose clock is this
 * number on?" — cannot be asked of a live Postgres at all, and was therefore
 * never asked of anything.
 *
 * IT IS HERE, AND NOT IN A PROVIDER, BECAUSE THE PAYLOAD IS THE CONTRACT. Both
 * providers answer in it — the Postgres one from `v_feed1`/`v_feed2` aggregates,
 * the HTTP one from whatever its operator's health resource publishes — and
 * server.js's `/api/feed/health`, `classifyHealth` and the boot line all read
 * these exact field names. Two payload builders would be two chances to
 * disagree about what `ok` means, and the last time two readers of one payload
 * disagreed the route answered the same 503 for a dead database and for a feed
 * that had merely gone quiet.
 *
 * ── TWO CLOCKS, AND THE PROVENANCE CLAIMED FOR EACH ────────────────────────
 * `data_age_seconds` is the age of the DATA, so it is measured from Betfair's
 * `publish_time`. It used to be `odds_age(newest_book)` — OUR poll timestamp —
 * which made it numerically identical to `odds_age_seconds`, two names for one
 * clock, while `delay_note` told the operator in prose it was Betfair's.
 *
 * That was this file's own principle inverted. The header above argues at length
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
 * note on `delayProbe` in lib/feed/postgres.js for what would actually make it
 * read.
 *
 * ── WHAT A NON-POSTGRES PROVIDER PUTS IN `feed` ─────────────────────────────
 * `feed` names the VIEW this answered from, so "healthy" is attributable to one.
 * There is no view behind an HTTP feed, and inventing a number here would be the
 * same fabrication this payload is written against — so the HTTP provider passes
 * `null` and `classifyHealth` propagates it. server.js's boot line says "this
 * feed API" rather than "feed null" when it sees one.
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
    // null when there is no view — see the note above.
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

/**
 * WHAT a health payload means, classified ONCE for every reader.
 *
 * `healthPayload` answers two different questions — could the feed be reached,
 * and is what it returned recent enough — with one `ok` boolean, so every reader
 * has to re-derive which of the two came back negative. Two readers did that
 * separately and one of them got it wrong, in the same file:
 *
 *   the boot line      (`feedBootStatus`) — corrected, and pinned by
 *                      tests/feedboot-line.test.js
 *   GET /api/feed/health                  — left uncorrected, and untested, so
 *                      nothing failed when it was missed
 *
 * The route threw its payload away and sent a fixed
 * `503 {ok:false, error:'Odds feed unavailable'}` for BOTH conditions. So a feed
 * whose collector had stopped polling and a feed whose database was down were
 * byte-identical on the wire and identical in the log, which cost an operator the
 * one distinction that decides which half of the runbook to open. The number that
 * DOES separate them — `odds_age_seconds` — was computed, published on the
 * healthy path, and discarded on the only path that needed it.
 *
 * THE RULE, and it is derived from what `health()` actually returns:
 *
 *   `error` present    UNREACHABLE — health() returns that shape ONLY when the
 *                       probe itself threw; healthPayload sets `ok` and never
 *                       sets `error`. So the PRESENCE of `error` is the
 *                       discriminator, and reading `ok` instead of it is what
 *                       made a stale feed look like a dead one.
 *   `priced === false` UNPRICED — a feed with no odds columns at all, so there
 *                       is no frame to age and nothing that can go stale, and
 *                       healthPayload answers `ok: true` there BY DESIGN. This
 *                       branch therefore outranks `ok`, and deliberately so: a
 *                       feed reporting ok:false forever for a missing ladder is a
 *                       dead control pointed the other way.
 *   otherwise          the frame age against the CALLER's threshold.
 *
 * Returned so no caller has to re-read the payload: `ok` is the verdict to serve,
 * `stale` is staleness specifically (an unreachable feed is not stale), `age` is
 * the number to publish, `frame` is how the boot line phrases it, and `reason` is
 * one line an operator can act on.
 */
function classifyHealth(h, staleSeconds) {
  const configured = Number(staleSeconds);
  // Echoed back rather than assumed: a client told the age needs the window it
  // was judged against, and the route publishes both.
  const threshold = Number.isFinite(configured) ? configured : null;

  // No payload at all. Not "stale" — there is no frame to be out of date — and
  // reported as unreachable because that is the honest word for "never asked".
  if (!h || typeof h !== 'object') {
    return {
      kind: 'no_payload', ok: false, stale: false, age: null, frame: null,
      threshold, feed: null, priced: null,
      reason: 'health check returned no payload',
    };
  }

  if (h.error) {
    return {
      kind: 'unreachable', ok: false, stale: false, age: null, frame: null,
      threshold, feed: h.feed ?? null, priced: h.priced ?? null,
      reason: `unreachable: ${h.error}`,
    };
  }

  if (h.priced === false) {
    return {
      kind: 'unpriced', ok: true, stale: false, age: null, frame: null,
      threshold, feed: h.feed ?? null, priced: false, reason: null,
    };
  }

  const age = typeof h.odds_age_seconds === 'number' ? h.odds_age_seconds : null;
  // `!== true` rather than `=== false`, and the difference is not cosmetic: the
  // route's own guard was `if (h && h.ok)`, so a payload carrying no `ok` at all
  // was a 503 there and a HEALTHY boot line — the two readers already disagreed
  // about a third shape. Comparing against `true` makes them agree.
  //
  // `ok` can only ever make the verdict MORE severe: a caller with a loose window
  // must not be able to talk a not-ok verdict back into a healthy answer.
  const stale = h.ok !== true || (threshold !== null && age !== null && age > threshold);
  // A null age is not a missing measurement, it is a missing frame. "newest frame
  // unknown" would claim we measured and could not report; the collector has
  // simply never written one.
  const frame = age === null ? 'no odds frame recorded yet' : `newest frame ${age}s old`;
  return {
    kind: stale ? 'stale' : 'fresh',
    ok: !stale,
    stale,
    age,
    frame,
    threshold,
    feed: h.feed ?? null,
    priced: h.priced ?? null,
    reason: !stale
      ? null
      : age === null
        ? `stale: ${frame} — the collector has never captured one`
        : threshold === null
          ? `stale: ${frame}`
          : `stale: ${frame}, past the ${threshold}s staleness threshold`,
  };
}

module.exports = {
  SIDE_BACK,
  SIDE_LAY,
  ageSeconds,
  runnerOrder,
  levelFromRow,
  groupRows,
  bookPercentages,
  decorate,
  boardLimit,
  shape,
  marketLabel,
  raceFromRow,
  nestNav,
  odds_age,
  healthPayload,
  classifyHealth,
};