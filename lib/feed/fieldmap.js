'use strict';
// lib/feed/fieldmap.js — the field-map grammar, the vocabularies, and nothing else.
//
// ── WHY THIS IS A SEPARATE MODULE, AND WHY IT HAS NO REQUIREMENTS ────────────
// lib/config.js parses the HTTP feed provider's field maps AT BOOT, so it must be
// able to require this module. And this module must not require lib/config.js —
// not as a matter of taste, but because that combination is a cycle: config.js
// evaluates its own `loadConfig()` call before it assigns `module.exports`, so a
// module required from inside that call captures an EMPTY exports object and
// keeps it for the life of the process.
//
// That is not theoretical. It was exactly what happened: lib/config.js required
// lib/feed/http.js for `parseMap`, http.js captured the half-initialised config,
// and the provider was then built with an empty configuration — no field map, no
// base URL — while the boot log cheerfully reported a valid one. Two shapers of
// the truth about the deployment's own configuration, and the wrong one at
// runtime.
//
// So: this file depends on NOTHING. Not on config, not on the transport, not on
// the shaper. config.js can require it; lib/feed/http.js can require it; neither
// can poison the other. The one rule this module exists to enforce is that the
// map grammar has exactly ONE implementation, shared by the boot-time validator
// and the runtime mapper — two copies would be two chances to disagree about
// which fields are required, and the disagreement would only show up as an empty
// board.
//
// ── THE GRAMMAR ──────────────────────────────────────────────────────────────
// `key=path,key=path`, dotted paths, and a bare `key` meaning `key=key`.
//
// The KEY is a canonical feed field — the column the collector's views project,
// which is what lib/feed/shape.js reads — and the PATH is where that field lives
// in the operator's JSON. Anchoring the vocabulary to the canonical names is what
// lets the conformance suite assert that two providers produce BYTE-IDENTICAL
// boards from the same data: both are required to speak the same names, and the
// transport is the only thing allowed to differ.

// The board map. Every key here is either read by `marketFor`/`runnerFor` in
// lib/feed/shape.js or names a container, which is why the vocabulary can be
// described as "the fields the shaper consumes" rather than as a guess at what
// an operator might send.
const BOARD_VOCABULARY = {
  markets: { required: true, what: 'the array of markets' },
  market_id: { required: true },
  market_name: { required: true },
  market_start_time: { required: true },
  market_status: {},
  fixture_id: {},
  event_name: {},
  sport_slug: {},
  event_type_id: {},
  event_type_name: {},
  competition_id: {},
  competition_name: {},
  country_code: {},
  fixture_venue: {},
  market_type_code: {},
  market_venue: {},
  is_resolved: {},
  total_matched: {},
  inplay: {},
  bet_delay: {},
  publish_time: {},
  odds_captured_at: {},
  runners: { required: true, what: "each market's array of runners" },
  selection_id: { required: true },
  runner_name: { required: true },
  sort_priority: {},
  handicap: {},
  selection_status: {},
  odds: {},
  back: {},
  lay: {},
  price: {},
  size: {},
  // Read from INSIDE the odds object, like `back` and `lay`. It was left
  // unmapped at first — "one optional scalar no Betfair-shaped feed omits" — and
  // the cross-provider parity check caught it within the hour: the Postgres
  // provider published `last_price_traded` and the HTTP provider published
  // null, on identical data. A field that one provider can see and the other
  // cannot is a silent divergence between two implementations of one contract,
  // which is the whole thing the conformance suite exists to prevent.
  last_price_traded: {},
};

// The catalogue map, feeding the nav tree. The canonical names here are the
// ALIASES lib/feed/postgres.js's navSql produces, because `nestNav` consumes
// those and the tree must reach the browser in one shape whichever provider
// served it.
const NAV_VOCABULARY = {
  markets: { required: true, what: 'the array of catalogue entries' },
  market_id: { required: true },
  market_name: { required: true },
  market_time: { required: true },
  market_type: {},
  market_status: {},
  number_of_winners: {},
  sport: {},
  sport_id: {},
  sport_name: {},
  country: {},
  competition: {},
  event_id: {},
  event_name: {},
  event_time: {},
  in_play: {},
};

// The health map, onto the probe row healthSql produces. `markets` and
// `newest_book` are required because `ok` is computed from the newest book: a
// health document that cannot answer those two questions is not a health
// document, and publishing `ok: false` from it would blame a feed that is fine.
const HEALTH_VOCABULARY = {
  markets: { required: true },
  markets_with_odds: {},
  resolved: {},
  newest_book: { required: true },
  oldest_book: {},
  newest_publish: {},
};

/**
 * Parse a `key=path,key=path` field map, or throw.
 *
 * PURE, and called from lib/config.js at boot so a bad map stops the launch
 * rather than surfacing as an empty board an hour later. The rules, and the bug
 * each one exists to stop:
 *
 *   an empty entry        `markets=markets,,id=id` — a trailing comma from a
 *                         copied line. Silently skipping it makes the NEXT pair
 *                         attach to the wrong key, or makes a required key look
 *                         unmapped for no visible reason.
 *   a bare key            `markets` means `markets=markets`. Not a spelling, a
 *                         shorthand: an operator whose vendor already uses these
 *                         names should not have to write 34 redundant pairs.
 *   an unknown key        caught here rather than ignored. A map naming
 *                         `marketId` where the vocabulary says `market_id` would
 *                         otherwise parse into a map that renames nothing —
 *                         which is the half-works hazard with a config key.
 *   a duplicate key       LAST-WINS SILENTLY would mean the operator reads their
 *                         own config, sees the right value, and gets the other
 *                         one.
 *   a missing required key  boot error. Without it the feed serves markets with
 *                         no id, no name or no start time, and an empty board
 *                         looks like a quiet Tuesday rather than like a
 *                         misconfiguration.
 */
function parseMap(spec, vocabulary, keyName) {
  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new Error(
      `config: ${keyName} is empty. It maps canonical feed fields onto the paths in your provider's ` +
      "JSON; an empty map cannot be distinguished from a misconfigured one, and a misconfigured one " +
      'serves an empty board.'
    );
  }
  const out = new Map();
  for (const rawEntry of spec.split(',')) {
    const entry = rawEntry.trim();
    if (entry === '') {
      throw new Error(
        `config: ${keyName} has an empty entry — a trailing or doubled comma, which would otherwise ` +
        'attach the next field to the wrong key.'
      );
    }
    const eq = entry.indexOf('=');
    const key = (eq < 0 ? entry : entry.slice(0, eq)).trim();
    const path = (eq < 0 ? entry : entry.slice(eq + 1)).trim();
    if (key === '') {
      throw new Error(`config: ${keyName} has an entry with no canonical field name: ${JSON.stringify(entry)}`);
    }
    if (path === '') {
      throw new Error(`config: ${keyName} maps "${key}" to nothing; every field needs a path`);
    }
    if (!Object.prototype.hasOwnProperty.call(vocabulary, key)) {
      throw new Error(
        `config: ${keyName} names "${key}", which is not a canonical feed field. Known fields: ` +
        `${Object.keys(vocabulary).join(', ')}`
      );
    }
    if (out.has(key)) {
      throw new Error(
        `config: ${keyName} maps "${key}" twice (${JSON.stringify(out.get(key))} and ${JSON.stringify(path)}); ` +
        'the second would silently win'
      );
    }
    out.set(key, path);
  }
  const missing = Object.entries(vocabulary)
    .filter(([, v]) => v.required)
    .map(([k]) => k)
    .filter((k) => !out.has(k));
  if (missing.length) {
    throw new Error(
      `config: ${keyName} does not map required field(s) ${missing.join(', ')}. Without them the feed ` +
      'serves markets with no id, no name or no start time, which renders as an empty board rather ' +
      'than as an error.'
    );
  }
  return out;
}

/**
 * Read `path` out of `obj`. Dotted; a numeric segment indexes an array.
 *
 * Returns undefined rather than throwing on a missing branch: most of these
 * fields are legitimately absent for some markets (a race has no `country_code`,
 * an unstarted market has no `odds`). What is NOT tolerated is a market whose
 * REQUIRED fields are absent, and that is asserted in lib/feed/http.js where the
 * row is built.
 */
function pick(obj, path) {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

module.exports = { BOARD_VOCABULARY, NAV_VOCABULARY, HEALTH_VOCABULARY, parseMap, pick };