'use strict';
// lib/feed.js — the price feed, as the rest of the venue already calls it.
//
// This file used to BE the Postgres collector client. It no longer is: the
// collector's views are now one implementation of the feed contract
// (lib/feed/postgres.js) and an operator's own JSON-over-HTTP API is another
// (lib/feed/http.js). What is left here is the seam itself — a thin facade that
// resolves the configured provider and forwards to it — plus the canonical
// shapers and SQL builders re-exported under the names they have always had.
//
// ── WHY IT IS A FACADE AND NOT A DELETION ────────────────────────────────────
// `require('./lib/feed')` is what server.js calls, and it calls six functions:
// fetchBoard, fetchMarket, fetchNav, health, classifyHealth and close. Renaming
// them, or moving the module, would be a change every caller has to agree with
// for no gain. More to the point, the module OBJECT is itself part of the
// contract: tests/feed_nav.test.js and tests/feedboot-line.test.js swap
// `feed.fetchNav` / `feed.health` on the required object to drive the real
// Express routes without a live recorder. That only works if server.js holds
// THIS object and calls a property on it at request time — which it does, and
// which a facade preserves and a wholesale rewrite would not.
//
// ── WHAT MOVED, AND WHY IT IS STILL EXPORTED HERE ────────────────────────────
//   lib/feed/shape.js     the one shaper: groupRows, shape, nestNav, decorate,
//                         healthPayload, classifyHealth, boardLimit, levelFromRow,
//                         bookPercentages, marketLabel, runnerOrder, ageSeconds
//   lib/feed/postgres.js  the collector's SQL: feedView, boardSql, navSql,
//                         healthSql, priced, BOARD_SQL, and the pool
//   lib/feed/http.js      the generic JSON-over-HTTP provider
//   lib/feed/provider.js  the contract, the registry, and `current()`
//
// The row-shaping and SQL tests (tests/feed.test.js, tests/feed-hygiene.test.js,
// tests/feedhealth-provenance.test.js) import these by their historical names
// from `lib/feed`, and every one of them still passes unchanged. They are the
// regression net for the move: the comments they assert on travelled with the
// code they describe, and the SQL they pin is still assembled by prefixing an
// optional block rather than suffixing one.
//
// ── WHAT THIS FILE IS, AND WHAT IT IS NOT ─────────────────────────────────────
// THIS MODULE IS THE FEED'S READ SIDE, AND IT IS STILL PURE. It fetches a board,
// a market, a nav tree and a health payload, and it writes nothing anywhere — not
// to the collector, not to this venue.
//
// A feed market this venue has not MATERIALISED is still display-only: it has no
// row here, so naming its selection id on POST /api/orders is a 404 (see
// docs/FEED.md and tests/feed-display-only.test.js). Materialising it is
// lib/feedcat.js's job — a separate module, on an explicit operator action
// (POST /api/admin/feed/sync), writing the VENUE's own catalogue rows at the
// VENUE's own prices. Nothing in this file changed to allow that, and no price
// read here ever reaches a price column: the reference board and the venue's book
// stay two things.
const provider = require('./feed/provider');
const shape = require('./feed/shape');
const postgres = require('./feed/postgres');

function fetchBoard(opts) {
  return provider.current().board(opts);
}

function fetchMarket(id, opts) {
  return provider.current().market(id, opts);
}

function fetchNav() {
  return provider.current().nav();
}

function health() {
  return provider.current().health();
}

/**
 * Close the provider, if there is one.
 *
 * `peek()` rather than `current()` on purpose. Building the Postgres provider is
 * what opens the `pg` pool, so a shutdown that constructed a provider in order to
 * close it would OPEN a database connection on its way out — on every deployment
 * that never enabled the feed.
 */
function close() {
  const active = provider.peek();
  if (!active) return Promise.resolve();
  return active.close();
}

module.exports = {
  // The feed surface server.js calls.
  fetchBoard,
  fetchMarket,
  fetchNav,
  health,
  close,
  // The classifier, which stays here rather than behind the provider because
  // server.js's boot line and its health route both call it on a payload the
  // provider produced — and the last time two readers of one payload disagreed
  // about it, the route answered the same 503 for a dead database and for a feed
  // that had merely gone quiet. One rule, in one place, read by both.
  classifyHealth: shape.classifyHealth,
  // The one shaper's internals, re-exported under their historical names.
  groupRows: shape.groupRows,
  shape: shape.shape,
  nestNav: shape.nestNav,
  levelFromRow: shape.levelFromRow,
  bookPercentages: shape.bookPercentages,
  marketLabel: shape.marketLabel,
  runnerOrder: shape.runnerOrder,
  ageSeconds: shape.ageSeconds,
  boardLimit: shape.boardLimit,
  healthPayload: shape.healthPayload,
  // The collector's SQL. Still exported because tests/feed.test.js pins the
  // assembled STRING — a board query whose column list is syntactically
  // terminated on both feeds, a health probe that reads the CONFIGURED view —
  // and none of that is answerable offline any other way.
  feedView: postgres.feedView,
  boardSql: postgres.boardSql,
  navSql: postgres.navSql,
  healthSql: postgres.healthSql,
  priced: postgres.priced,
  BOARD_SQL: postgres.BOARD_SQL,
};