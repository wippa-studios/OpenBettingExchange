'use strict';
// lib/feed/provider.js — the price-feed INTERFACE, the registry, and the accessor.
//
// ── WHAT THIS SOLVES ─────────────────────────────────────────────────────────
// lib/feed.js read the Betfair collector's Postgres views and nothing else. Its
// SQL was hard-wired to `v_feed1` / `v_feed2` (`feedView`, `boardSql`, `navSql`,
// `healthSql`), so an Australian operator with their own licensed data-feed API
// could use this venue only if their feed happened to be Betfair's Postgres
// views. Otherwise they forked lib/feed.js — and a fork is not a seam, it is a
// copy that drifts.
//
// STATE.md §2.7 named the blocker as semantic, not structural, and the sentence
// is the design brief for everything here:
//
//   "an adapter that half-works does not crash, it produces wrong prices or wrong
//    market state, which the engine cannot detect. Any adapter story needs a
//    conformance suite before it needs adapters."
//
// So the conformance suite (tests/feedprovider-conformance.test.js) ships in the
// SAME change as the first adapter, and the registry below refuses to register a
// provider whose name nobody has DECLARED.
//
// ── WHAT THE REGISTRY ENFORCES, AND WHAT IT DOES NOT ─────────────────────────
// The registry enforces two things: the six method names, and the provider's name
// being in the capability table below. It does NOT run the conformance battery at
// registration, and no arrangement of this file makes it. Running a test suite at
// production startup would be its own class of wrong: it would turn a boot into a
// test run, it would depend on test fixtures being deployed, and it would make
// the venue refuse to start because an assertion about a synthetic fixture
// drifted.
//
// So the gate is a REVIEW GATE, not a runtime one, and it is described here as
// one. Declaring a name in CAPABILITIES is the moment somebody is told what the
// contract is and pointed at tests/feedprovider-conformance.test.js; the review
// that accepts the declaration is where the battery is run. That is a human
// process, and describing it as anything else is the STATE.md §1 failure class —
// a correct number presented wrongly, which is worse than no number because a
// reader stops looking.
//
// If this ever has to be mechanical, the honest place is CI: a job that runs the
// battery against every DECLARED provider. Not the request path, not `main()`.
//
// ── THE CONTRACT ─────────────────────────────────────────────────────────────
// Every provider implements exactly this, and nothing else:
//
//   {
//     name: string,
//     priced(opts): boolean,              // does this feed carry prices at all
//     board({ limit, priced }): Promise<markets[]>,
//     market(id, { priced }): Promise<market|null>,
//     nav(): Promise<navTree>,
//     health(): Promise<healthPayload>,
//     close(): Promise<void>,
//   }
//
// `board` returns the SHAPED market objects public/js/board.js already renders —
// not rows, not a vendor's own shape. That is the whole point: the browser has
// never known a price feed exists, and it must not have to learn one per
// provider.
//
// `health()` returns lib/feed/shape.js's `healthPayload`, because
// server.js's `/api/feed/health` route, `classifyHealth()` and the boot line all
// read those exact field names. A provider that answers a different health shape
// is not a provider, it is a second thing to remember at every call site — which
// is how the route came to send the same 503 for a dead database and for a feed
// that had merely gone quiet.
//
// ── WHAT A PROVIDER MAY NOT DO ───────────────────────────────────────────────
// It may not shape. There is one shaper, lib/feed/shape.js, and both providers
// build the canonical rows it consumes. A provider that also renders markets is a
// second shaper, and a second shaper is a wrong-price bug: the ladder bounds, the
// pounds→cents conversion and the book-percentage completeness rule have each
// already been got wrong once here, and a copy beside the original is three more
// chances at each.
//
// ── WHY A PROVIDER IS RESOLVED LAZILY, ONCE ──────────────────────────────────
// A deployment that never enables the feed must not load `pg`, and a deployment
// that uses the collector must not load the HTTP client's configuration surface.
// So nothing is required until something asks for the provider, and the answer is
// cached: a provider is a connection-pool owner or a transport, and rebuilding
// one per request would be a pool per request.
const config = require('../config');
const shape = require('./shape');
const postgres = require('./postgres');

// Declared, not discovered. `assertProvider` refuses a provider whose `name` is
// not in this table, so an adapter cannot be wired in by someone who has not
// declared what it can do. The table is also the list `FEED_PROVIDER` is
// validated against in lib/config.js, which means a typo in the environment is a
// boot error naming the two real options rather than an "unknown provider" 503 on
// the first board request.
//
// WHAT DECLARING A NAME DOES AND DOES NOT DO, because the difference was stated
// wrongly here once: adding a name here does not cause the conformance battery to
// run. It cannot — the battery is offline, needs fixtures, and belongs in CI
// rather than in a request path (see the header). What adding a name does is put
// a line in a diff a reviewer reads, in a file whose header says what the battery
// is for. The gate is REVIEW, and the reviewer's job is to see the provider added
// to tests/feedprovider-conformance.test.js in the same change.
//
// `priced` is here for the reader, not for the machine: it records that the
// Postgres provider's priced/unpriced distinction is FEED_NUMBER and the HTTP
// provider's is FEED_HTTP_PRICED, which is the one place the two differ.
const CAPABILITIES = {
  postgres: {
    module: './postgres',
    build: () => postgres.postgresProvider(),
    priced: 'FEED_NUMBER (1 = fixtures only, 2 = fixtures and prices)',
  },
  http: {
    module: './http',
    build: () => require('./http').httpProvider(),
    priced: 'FEED_HTTP_PRICED',
  },
};

const CONTRACT = ['priced', 'board', 'market', 'nav', 'health', 'close'];

/**
 * Assert an object implements the contract. Called by the registry on
 * registration, so a half-implemented provider fails at BOOT, loudly, rather than
 * as a 500 on somebody's board an hour later.
 *
 * TWO THINGS ARE ENFORCED, and the error messages say which so nobody has to
 * guess: the six method names, and the provider's name being a key of
 * CAPABILITIES. That is all. It does NOT run tests/feedprovider-conformance
 * .test.js, and the message below used to claim it did — "an adapter that has not
 * passed that battery does not get to serve prices" is not true of this code, and
 * a claim like that is the STATE.md §1 failure class: right in substance, wrong
 * in the one respect a reader would act on. It now says what actually happens.
 */
function assertProvider(p) {
  if (!p || typeof p !== 'object') throw new Error('feed: a provider must be an object');
  if (typeof p.name !== 'string' || !p.name) throw new Error('feed: a provider needs a name');
  if (!Object.prototype.hasOwnProperty.call(CAPABILITIES, p.name)) {
    throw new Error(
      `feed: provider "${p.name}" is not declared in lib/feed/provider.js's CAPABILITIES ` +
      `(known: ${Object.keys(CAPABILITIES).join(', ')}). Declaring it is the review gate: ` +
      'tests/feedprovider-conformance.test.js has to cover the new provider in the same change.'
    );
  }
  const missing = CONTRACT.filter((m) => typeof p[m] !== 'function');
  if (missing.length) {
    throw new Error(`feed: provider "${p.name}" is missing ${missing.join(', ')}`);
  }
  return p;
}

const registry = new Map();

function register(p) {
  assertProvider(p);
  registry.set(p.name, p);
  return p;
}

let active = null;

/**
 * The configured provider, built on first use and cached after.
 *
 * `select(name)` is the seam tests use to pin a provider explicitly;
 * `current()` is what lib/feed.js calls, and it reads FEED_PROVIDER.
 */
function select(name) {
  const want = name || config.FEED_PROVIDER;
  if (!Object.prototype.hasOwnProperty.call(CAPABILITIES, want)) {
    throw new Error(
      `feed: FEED_PROVIDER is "${want}", which is not a provider this build knows ` +
      `(${Object.keys(CAPABILITIES).join(', ')}). lib/config.js should have refused this at boot.`
    );
  }
  active = registry.get(want) || register(build(want));
  return active;
}

function build(name) {
  return CAPABILITIES[name].build();
}

function current() {
  if (!active) return select();
  return active;
}

/** Drop the cached provider. Tests only — a provider owns a pool. */
function reset() {
  active = null;
  registry.clear();
}

module.exports = {
  CAPABILITIES,
  CONTRACT,
  assertProvider,
  register,
  select,
  current,
  reset,
  /**
   * The provider if one has been built, else null — and `close()` must NOT build
   * one just to close it. Building the Postgres provider is what opens the pool,
   * so a shutdown that constructed a provider in order to shut it down would
   * open a database connection on its way out.
   */
  peek() {
    return active;
  },
};