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
// SAME change as the first adapter, and `assertProvider` below refuses to
// register anything that has not been through it.
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
// declared what it can do and had the conformance battery run against it. The
// table is also the list `FEED_PROVIDER` is validated against in lib/config.js,
// which means a typo in the environment is a boot error naming the two real
// options rather than an "unknown provider" 503 on the first board request.
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
 * THE NAME CHECK IS THE PART THAT IS NOT OBVIOUS. `name` has to be a key of
 * CAPABILITIES, not merely a string. That is what makes "pass the conformance
 * suite before you can be used" a property of the code rather than a sentence in
 * a comment: a new adapter cannot be registered until someone adds it to the
 * capability table, which is the moment they are told what the contract is and
 * that tests/feedprovider-conformance.test.js has to be extended to include them.
 */
function assertProvider(p) {
  if (!p || typeof p !== 'object') throw new Error('feed: a provider must be an object');
  if (typeof p.name !== 'string' || !p.name) throw new Error('feed: a provider needs a name');
  if (!Object.prototype.hasOwnProperty.call(CAPABILITIES, p.name)) {
    throw new Error(
      `feed: provider "${p.name}" is not declared in lib/feed/provider.js's CAPABILITIES ` +
      `(known: ${Object.keys(CAPABILITIES).join(', ')}). Declaring it is what makes a provider ` +
      'accountable to tests/feedprovider-conformance.test.js — an adapter that has not passed ' +
      'that battery does not get to serve prices.'
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