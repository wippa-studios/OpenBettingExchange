'use strict';
// tests/feedprovider-conformance.test.js — the PROVIDER CONTRACT, as a battery.
//
// ── WHY THIS FILE IS THE DELIVERABLE AND NOT A TEST OF ONE PROVIDER ─────────
// STATE.md §2.7, on the price-feed adapter seam:
//
//   "The blocker is the price feed, which is bound to Postgres views … The
//    deeper blocker is semantic: an adapter that half-works does not crash, it
//    PRODUCES WRONG PRICES OR WRONG MARKET STATE, which the engine cannot
//    detect. Any adapter story needs a conformance suite before it needs
//    adapters."
//
// The engine cannot detect a wrong price because it has no idea which provider
// fed it: lib/match.js takes a validated order and never asks where the ladder
// came from. So the only place a bad adapter can be caught is HERE, at the seam,
// by a battery every provider has to pass — and the battery ships in the SAME
// change as the first adapter, because an adapter without one is the exact
// hazard that sentence describes.
//
// ── HOW IT IS STRUCTURED, AND WHY ────────────────────────────────────────────
// `runConformance(ctx, check)` below is the reusable half. It knows nothing
// about Postgres and nothing about HTTP; it drives a provider through the
// contract and asserts what came out. The bottom of this file runs that same
// battery against BOTH shipped providers, plus a deliberately-broken MUTANT that
// must FAIL it.
//
// The mutant is what makes the rest mean anything. A battery that asserts
// nothing is green and worthless, and this repository has been bitten by exactly
// that class of bug five times over (STATE.md §5.2 lists vacuous tests as a
// recurring failure mode). A contract battery is the single most likely place to
// grow one: every assertion compares something the provider itself produced, so
// a battery that quietly stopped comparing anything would still be green.
//
// So the suite asserts NEGATIVELY as well as positively. If a provider that
// returns "abc" as a price, an unparseable off time, a market with no runners,
// more markets than the limit it was given and a nav tree that reshuffles
// between two calls can PASS this battery, then the battery is decorative and
// every green line above it is a lie. See C9, which also asserts WHICH checks
// caught it — so a future edit cannot quietly weaken one the mutant misses.
//
// ── AND WHAT ENFORCES IT, STATED WITHOUT OVERCLAIMING ────────────────────────
// This file is enforced by CI and by REVIEW. `lib/feed/provider.js` refuses to
// register a provider whose `name` is not in its capability table, and that is a
// real gate; it is NOT a conformance gate, because running an offline fixture
// suite inside a venue's boot would be its own class of wrong. C10 now asserts
// both halves of that statement, including the uncomfortable one: the mutant,
// given a DECLARED name, is ACCEPTED by the interface. It is this file, not
// `assertProvider`, that would catch it — which is the argument for the two
// existing separately, stated as a fact rather than as a slogan.
//
// ── WHY IT PROVES THE TRANSPORT, NOT JUST THE MAPPER ────────────────────────
// The HTTP provider runs against a real `node:http` server started here, on an
// ephemeral loopback port, serving VENDOR-SHAPED JSON — `prices.bets` /
// `prices.offers` / `odds` / `stake`, `startTime`, `eventRef` — mapped through
// FEED_HTTP_MAP_* by configuration. A stubbed fetcher would prove the mapper and
// nothing else, and the transport is where the timeouts, the byte cap, the auth
// headers and the generic-error boundary actually live.
//
// The Postgres provider runs against an injected `query` seam returning rows
// shaped exactly as `v_feed2` returns them. A battery that can only run against
// a live Postgres is a battery that never runs.
//
// ── WHY THE lib/ REQUIRES ARE DEFERRED ──────────────────────────────────────
// The fixture server has to be listening before its port can be written into
// FEED_HTTP_URL, and lib/config.js reads the environment once at import. So the
// environment is pinned after `listen()` and every lib module is required after
// that — which is the same constraint every feed suite in this repo works under,
// spelled out here because the alternative looks like an oversight.
//
// ── THE SERVER IS CLOSED IN A `finally` ──────────────────────────────────────
// Because tests/express5.test.js once left a `listen()`ed server open after a
// failed assertion and took the entire runner down with it — which is why
// tests/run_all.js now carries a 5-minute per-suite timeout. A suite that opens a
// socket has to be the reason that timeout exists rarely, not often.
const http = require('node:http');
const assert = require('assert');

// ── the fixture ──────────────────────────────────────────────────────────────

// ONE dataset, expressed once, and projected into whatever each provider needs.
// That is what makes the cross-provider comparison a statement about the two
// PROVIDERS rather than about two hand-written fixtures that were built to agree.
//
// The shapes are the ones a real licensed feed API returns, not the ones the
// Postgres views happen to have: dotted Betfair ids, a competition rather than a
// sport tree, and — deliberately — a market with no ladder at all and a market
// whose book is one-sided, because those are the two cases that made the empty
// ladder and the book-percentage-completeness rules exist in the first place.
const T0 = Date.now();
const iso = (secondsAgo) => new Date(T0 - secondsAgo * 1000).toISOString();

/** A future start time, so nothing in the fixture is already off. */
const future = (hoursAhead) => new Date(T0 + hoursAhead * 3600 * 1000).toISOString();

function goodFixture() {
  return {
    markets: [
      {
        market_id: '1.100',
        market_name: 'Match Odds',
        market_start_time: future(3),
        market_status: 'OPEN',
        event_id: '10',
        event_name: 'Arsenal v Chelsea',
        sport_slug: 'soccer',
        event_type_id: 7,
        event_type_name: 'Soccer',
        competition_name: 'Premier League',
        country_code: 'GB',
        fixture_venue: 'Emirates',
        odds_captured_at: iso(60),
        runners: [
          {
            selection_id: 1, runner_name: 'Arsenal', sort_priority: 1,
            back: [{ price: 2.6, size: 100 }, { price: 2.4, size: 250 }],
            lay: [{ price: 2.42, size: 400 }],
            last_price_traded: 2.4,
          },
          {
            // NO ODDS AT ALL: a market inside the fixtures scope the odds job
            // has not reached. The runner must still render, with empty ladders.
            selection_id: 2, runner_name: 'Chelsea', sort_priority: 2,
          },
          {
            selection_id: 3, runner_name: 'Draw', sort_priority: 3,
            back: [{ price: 3.4, size: 75 }],
            lay: [{ price: 3.45, size: 90 }],
          },
        ],
      },
      {
        market_id: '1.200',
        market_name: 'Over/Under 2.5',
        market_start_time: future(5),
        market_status: 'OPEN',
        event_id: '10',
        event_name: 'Arsenal v Chelsea',
        sport_slug: 'soccer',
        event_type_id: 7,
        event_type_name: 'Soccer',
        competition_name: 'Premier League',
        country_code: 'GB',
        odds_captured_at: iso(120),
        runners: [
          {
            // Numbered names, because `runnerOrder` exists for them and a
            // fixture that never exercises it proves nothing about ordering.
            selection_id: 11, runner_name: '2. Landing Gear', sort_priority: 2,
            back: [{ price: 1.8, size: 10 }],
            lay: [{ price: 1.82, size: 10 }],
          },
          {
            selection_id: 10, runner_name: '1. Devil Wings', sort_priority: 1,
            back: [{ price: 2.02, size: 10 }],
            lay: [{ price: 2.04, size: 10 }],
          },
          {
            // ONE-SIDED BOOK: back only. `bookPercentages` must report null for
            // both sides here rather than an inflated figure — and the total
            // must not be read as a broken feed.
            selection_id: 12, runner_name: '3. Quiet Question', sort_priority: 3,
            back: [{ price: 6.2, size: 5 }],
          },
        ],
      },
      {
        // A market whose book is ancient. Unpriced, and therefore honestly stale.
        market_id: '1.300',
        market_name: 'To Be Placed',
        market_start_time: future(26),
        market_status: 'OPEN',
        event_id: '20',
        event_name: 'Rosehill 10th Oct',
        sport_slug: 'horse-racing',
        event_type_id: 7,
        event_type_name: 'Horse Racing',
        competition_name: 'Rosehill',
        country_code: 'AU',
        odds_captured_at: iso(9000),
        runners: [
          { selection_id: 31, runner_name: 'Piteraq', sort_priority: 1 },
        ],
      },
    ],
  };
}

// ── the vendor projection (what an operator's API would actually return) ─────

// DELIBERATELY not the canonical names. Every field below has to go through
// FEED_HTTP_MAP_BOARD to become something lib/feed/shape.js recognises, so a
// battery run over this proves the field map works rather than proving that an
// identity map copies strings.
const VENDOR_FIELD_MAP_BOARD = [
  'markets=data.events',
  'market_id=id', 'market_name=name', 'market_start_time=startTime', 'market_status=state',
  'fixture_id=eventRef', 'event_name=eventTitle', 'sport_slug=discipline', 'event_type_id=disciplineRef',
  'event_type_name=disciplineLabel', 'competition_name=league', 'fixture_venue=venue', 'country_code=region',
  'odds_captured_at=capturedAt', 'runners=legs', 'selection_id=legRef', 'runner_name=label',
  'sort_priority=order', 'odds=prices', 'back=bets', 'lay=offers',
  'price=odds', 'size=stake', 'last_price_traded=traded',
].join(',');

const VENDOR_FIELD_MAP_NAV = [
  'markets=sports',
  'market_id=marketRef', 'market_name=marketName', 'market_time=startAt',
  'market_type=kind', 'market_status=state', 'sport=discipline', 'sport_id=disciplineRef',
  'sport_name=disciplineLabel', 'country=region', 'competition=venue',
  'event_id=meetingRef', 'event_name=meetingName', 'event_time=meetingAt',
].join(',');

// `stat.total` and `freshest` are the kinds of names a licensed feed API really
// does use, and neither exists in the canonical vocabulary, so this map is not
// cosmetic.
const VENDOR_FIELD_MAP_HEALTH = [
  'markets=stat.total', 'markets_with_odds=stat.priced', 'resolved=stat.settled',
  'newest_book=freshest', 'oldest_book=stalest', 'newest_publish=latest',
].join(',');

function vendorMarketObject(m) {
  return {
    id: m.market_id,
    name: m.market_name,
    startTime: m.market_start_time,
    state: m.market_status,
    eventRef: m.event_id,
    eventTitle: m.event_name,
    discipline: m.sport_slug,
    disciplineRef: m.event_type_id,
    disciplineLabel: m.event_type_name,
    league: m.competition_name,
    venue: m.fixture_venue == null ? undefined : m.fixture_venue,
    region: m.country_code,
    capturedAt: m.odds_captured_at,
    legs: (m.runners || []).map((r) => ({
      legRef: r.selection_id,
      label: r.runner_name,
      order: r.sort_priority,
      // `bets`/`offers` rather than `back`/`lay`, `odds`/`stake` rather than
      // `price`/`size`: a vendor naming them by outcome type is exactly the
      // case this provider exists for. And ABSENT, not empty, when the runner
      // has no book — which is what the
      // collector's view sends (a NULL `odds` column) and therefore what the
      // canonical row carries. Sending an empty object here instead would make
      // the two providers differ by one absent-vs-null key on identical data,
      // which is a fixture artefact wearing the costume of a provider divergence.
      ...(r.back || r.lay
        ? {
          prices: {
            bets: (r.back || []).map((l) => ({ odds: l.price, stake: l.size })),
            offers: (r.lay || []).map((l) => ({ odds: l.price, stake: l.size })),
            traded: r.last_price_traded == null ? null : r.last_price_traded,
          },
        }
        : {}),
    })),
  };
}

function vendorBoard(f) {
  return { data: { events: f.markets.map(vendorMarketObject) } };
}

function vendorSingleMarket(f, marketId) {
  const m = f.markets.find((x) => x.market_id === marketId);
  // Answered in the SAME envelope as the board, with one element, because that
  // is what the field map already says the markets are — so `market()` needs no
  // second convention for a second guess.
  return m ? { data: { events: [vendorMarketObject(m)] } } : { data: { events: [] } };
}

function vendorNav(f) {
  return {
    sports: f.markets.map((m) => ({
      marketRef: m.market_id,
      marketName: m.market_name,
      startAt: m.market_start_time,
      kind: 'WIN',
      state: m.market_status,
      discipline: m.sport_slug,
      disciplineRef: m.event_type_id,
      disciplineLabel: m.event_type_name,
      region: m.country_code,
      venue: m.competition_name,
      meetingRef: m.event_id,
      meetingName: m.event_name,
      meetingAt: m.market_start_time,
    })),
  };
}

function vendorHealth(f) {
  const stamped = f.markets.map((m) => m.odds_captured_at).filter(Boolean).sort();
  const priced = f.markets.filter((m) => (m.runners || []).some((r) => (r.back || []).length || (r.lay || []).length));
  return {
    stat: { total: f.markets.length, priced: priced.length, settled: 0 },
    freshest: stamped.length ? stamped[stamped.length - 1] : null,
    stalest: stamped.length ? stamped[0] : null,
    // Deliberately null: the fixture's feed is a DELAY key, so there is no
    // publish time and `data_age_seconds` must be null rather than invented.
    latest: null,
  };
}

// ── the Postgres projection (rows as v_feed2 returns them) ───────────────────

function postgresRows(f) {
  const rows = [];
  for (const m of f.markets) {
    for (const r of m.runners || []) {
      rows.push({
        market_id: m.market_id,
        market_name: m.market_name,
        market_start_time: m.market_start_time,
        market_status: m.market_status,
        fixture_id: m.event_id,
        event_name: m.event_name,
        sport_slug: m.sport_slug,
        event_type_id: m.event_type_id,
        event_type_name: m.event_type_name,
        competition_name: m.competition_name,
        country_code: m.country_code,
        fixture_venue: m.fixture_venue,
        selection_id: r.selection_id,
        runner_name: r.runner_name,
        sort_priority: r.sort_priority,
        odds_captured_at: m.odds_captured_at,
        // ONE ROW PER SELECTION, with that selection's ladders already extracted
        // into an `odds` JSONB object by the view. That is the row contract
        // lib/feed/shape.js consumes, and it is why the HTTP provider builds the
        // same objects rather than a parallel representation.
        odds:
          r.back || r.lay
            ? {
              back: (r.back || []).map((l) => ({ price: l.price, size: l.size })),
              lay: (r.lay || []).map((l) => ({ price: l.price, size: l.size })),
              last_price_traded: r.last_price_traded == null ? null : r.last_price_traded,
            }
            : null,
      });
    }
  }
  return rows;
}

function postgresNavRows(f) {
  return f.markets.map((m) => ({
    sport: m.sport_slug,
    sport_id: m.event_type_id == null ? null : String(m.event_type_id),
    sport_name: m.event_type_name,
    country: m.country_code,
    competition: m.competition_name,
    event_id: m.event_id,
    event_name: m.event_name,
    event_time: m.market_start_time,
    market_id: m.market_id,
    market_name: m.market_name,
    market_type: 'WIN',
    market_time: m.market_start_time,
    market_status: m.market_status,
    in_play: false,
    number_of_winners: null,
  }));
}

function postgresHealthRow(f) {
  const stamped = f.markets.map((m) => m.odds_captured_at).filter(Boolean).sort();
  const priced = f.markets.filter((m) => m.runners.some((r) => (r.back || []).length || (r.lay || []).length));
  return {
    markets: f.markets.length,
    markets_with_odds: priced.length,
    resolved: 0,
    newest_book: stamped.length ? stamped[stamped.length - 1] : null,
    oldest_book: stamped.length ? stamped[0] : null,
    newest_publish: null,
  };
}

/**
 * A stand-in for the `pg` pool, dispatching on which statement it was handed.
 *
 * The board branch caps MARKETS and then returns every row of each chosen one,
 * because that is what the CTE in `boardSql` does and why the CTE exists: a cap
 * applied to ROWS silently capped selections, so a limit of 20 returned two
 * markets. A stub that truncated the row list would let the battery pass on a
 * provider that had reintroduced the exact bug the CTE prevents.
 */
function postgresQuery(fixtureRef, isDown) {
  return async (sql, params) => {
    if (isDown()) throw new Error('connection to feed database failed: ECONNREFUSED 127.0.0.1:5432');
    const f = fixtureRef();
    if (/WITH chosen AS/.test(sql)) {
      const limit = Number(params && params[0]);
      const chosen = new Set(f.markets.slice(0, Number.isFinite(limit) ? limit : f.markets.length).map((x) => x.market_id));
      return { rows: postgresRows(f).filter((r) => chosen.has(r.market_id)) };
    }
    if (/WHERE v\.market_id = \$1/.test(sql)) {
      const id = String((params && params[0]) || '');
      return { rows: postgresRows(f).filter((r) => r.market_id === id) };
    }
    if (/SELECT v\.sport_slug/.test(sql)) return { rows: postgresNavRows(f) };
    if (/count\(DISTINCT market_id\)::int/.test(sql)) return { rows: [postgresHealthRow(f)] };
    if (/FROM feed_run/.test(sql)) {
      // THE REALITY, reproduced: the collector's feed_run has no `payload`
      // column, so this query raises on every call and `delayProbe` falls back
      // to `{is_delay:true, source:'assumed'}`. A stub that answered it would
      // be testing a column that does not exist.
      throw new Error('column "payload" does not exist');
    }
    return { rows: [] };
  };
}

// ── the battery ──────────────────────────────────────────────────────────────

// Fields derived from the CLOCK, and therefore not comparable byte-for-byte
// between two providers called milliseconds apart. They are compared separately,
// and with a tolerance — a check that flakes is a check that gets deleted.
const CLOCK_FIELDS = ['poll_age_seconds', 'age_seconds'];

function stripClocks(markets) {
  return markets.map((m) => {
    const copy = { ...m };
    for (const f of CLOCK_FIELDS) delete copy[f];
    return copy;
  });
}

/**
 * THE CONTRACT. Everything a provider must do, and nothing about how.
 *
 * @param ctx  { name, provider, fixture(), priced, stale(), fresh(), fail(), recover() }
 * @param check (name, fn) — the caller decides whether a failure is printed and
 *              counted, or collected. The negative control (C9) passes a
 *              collecting `check` so it can assert the battery SAW the defect.
 * @returns    the short names of the checks that failed, in order.
 */
async function runConformance(ctx, check) {
  // Required HERE rather than at module scope, so this exported function can be
  // called from a suite that pins the environment after its fixture server is
  // listening. See the header note on deferred requires.
  // eslint-disable-next-line global-require
  const config = require('../lib/config');
  // eslint-disable-next-line global-require
  const odds = require('../lib/odds');
  // eslint-disable-next-line global-require
  const offtime = require('../lib/offtime');
  // eslint-disable-next-line global-require
  const feed = require('../lib/feed');
  // eslint-disable-next-line global-require
  const provider = require('../lib/feed/provider');

  const p = ctx.provider;
  const f = () => ctx.fixture();
  const failed = [];

  const one = (short, fn) => check(`${ctx.name}: ${short}`, async () => {
    try {
      await fn();
    } catch (e) {
      failed.push(short);
      throw e;
    }
  });

  // ── 1. the interface itself ────────────────────────────────────────────────
  await one('implements the whole provider contract', () => {
    for (const m of provider.CONTRACT) {
      assert.strictEqual(
        typeof p[m], 'function',
        `${m} must be a function; the contract is not optional (missing: ${provider.CONTRACT.filter((x) => typeof p[x] !== 'function').join(', ')})`
      );
    }
    assert.ok(typeof p.name === 'string' && p.name.length > 0, 'a provider needs a name');
  });

  await one('declares a name the registry knows', () => {
    // The property that makes "pass the conformance suite before you can be
    // used" a rule rather than a sentence: an adapter cannot be registered
    // without a capability-table entry, and that table is also what
    // lib/config.js validates FEED_PROVIDER against.
    assert.ok(
      Object.prototype.hasOwnProperty.call(provider.CAPABILITIES, p.name),
      `provider "${p.name}" is not declared in lib/feed/provider.js CAPABILITIES ` +
      `(known: ${Object.keys(provider.CAPABILITIES).join(', ')})`
    );
  });

  await one('answers whether it carries prices, as a boolean', () => {
    const v = p.priced({});
    assert.strictEqual(typeof v, 'boolean', `priced() must be a boolean; got ${typeof v}`);
    if (ctx.priced !== undefined) {
      assert.strictEqual(v, ctx.priced, `priced() disagrees with the deployment's own answer (${v} vs ${ctx.priced})`);
    }
  });

  // ── 2. board shape ─────────────────────────────────────────────────────────
  let board = null;
  await one('a board is an array of markets', async () => {
    board = await p.board({ limit: config.FEED_MARKET_LIMIT });
    assert.ok(Array.isArray(board), `board() must resolve an array; got ${typeof board}`);
    assert.strictEqual(board.length, f().markets.length, 'the fixture has three markets and all three must be served');
  });

  await one('every market has an id, a name, a start time and at least one runner', () => {
    for (const m of board) {
      assert.ok(m.market_id != null && String(m.market_id).trim() !== '', `market_id missing: ${JSON.stringify(m.market_id)}`);
      assert.ok(typeof m.market_name === 'string' && m.market_name.trim() !== '', `market_name missing on ${m.market_id}`);
      assert.ok(Array.isArray(m.selections) && m.selections.length >= 1,
        `${m.market_id} has ${m.selections ? m.selections.length : 'no'} runners; a market with none is unreachable`);
    }
  });

  await one('every runner has an id, a name, and two ladder arrays', () => {
    for (const m of board) {
      for (const s of m.selections) {
        assert.ok(s.selection_id != null && String(s.selection_id) !== '', `selection_id missing on ${m.market_id}`);
        assert.ok(typeof s.name === 'string' && s.name.trim() !== '', `runner name missing on ${s.selection_id}`);
        // NEVER null and NEVER undefined. public/js/board.js reads
        // `sel.back.length` unguarded, so a missing ladder is a thrown TypeError
        // in the browser rather than a blank cell.
        assert.ok(Array.isArray(s.back), `back must be an array on ${m.market_id}/${s.selection_id}; got ${typeof s.back}`);
        assert.ok(Array.isArray(s.lay), `lay must be an array on ${m.market_id}/${s.selection_id}; got ${typeof s.lay}`);
      }
    }
  });

  await one('an unpriced market still renders, with empty ladders', () => {
    const bare = board.find((m) => m.market_id === '1.300');
    assert.ok(bare, 'the unpriced market must still be listed — a fixture list is the point of an unpriced feed');
    for (const s of bare.selections) {
      assert.strictEqual(s.back.length, 0, 'no book, so no back ladder — but an empty one, not a missing one');
      assert.strictEqual(s.lay.length, 0);
    }
    assert.strictEqual(bare.poll_age_seconds > config.FEED_STALE_SECONDS, true,
      'a market whose book is ancient must read stale, not live');
  });

  await one('runners arrive in the order a bettor expects', () => {
    const market = board.find((m) => m.market_id === '1.200');
    assert.deepStrictEqual(
      market.selections.map((s) => s.name),
      ['1. Devil Wings', '2. Landing Gear', '3. Quiet Question'],
      'numbered names sort by number, not alphabetically and not by arrival'
    );
  });

  // ── 3. price sanity ────────────────────────────────────────────────────────
  await one('every ladder level is a price this engine can trade, with a finite size', () => {
    if (!p.priced({})) return; // an unpriced feed has no ladder to be wrong about
    let levels = 0;
    for (const m of board) {
      for (const s of m.selections) {
        for (const level of [...s.back, ...s.lay]) {
          levels++;
          const where = `${m.market_id}/${s.selection_id} ${level.side} ${JSON.stringify(level.price)}`;
          // The RANGE first, then the LADDER. `inLadderRange` asks "is this a
          // price at all" (1.01–1000); `validTick` asks the stricter "is this
          // exactly a price the ladder quotes". Both live in lib/odds.js, and
          // validTick's own comment names this exact caller: "a feed adapter
          // returning a price it could not put on the ladder".
          assert.ok(odds.inLadderRange(level.price), `price outside [1.01, 1000] at ${where}`);
          assert.ok(odds.validTick(level.price),
            `price is not on the tick ladder at ${where} (snapToTick would move it to ${odds.snapToTick(level.price)})`);
          // >= 0 and not > 0, because Betfair really does send size = NULL for a
          // price with no size behind it and `levelFromRow` turns that into a
          // level at ZERO cents. Zero is a level; a negative or fractional or
          // NaN size is not.
          assert.ok(
            Number.isSafeInteger(level.size_cents) && level.size_cents >= 0,
            `size must be a finite count of cents at ${where}; got ${JSON.stringify(level.size_cents)}`
          );
        }
      }
    }
    assert.ok(levels > 0, 'a priced provider served no ladder levels at all, so this check proved nothing');
  });

  await one('a non-numeric or negative level is dropped at the shared boundary, not rendered', () => {
    // THE ONE SHAPER IS A CONTROL, and this is where it is asserted.
    //
    // The check above asserts the SERVED board, which means it can only catch
    // what SURVIVED the shaper. `price: "abc"` does not survive it: lib/feed/
    // shape.js's `levelFromRow` refuses a non-finite price, a price below 1 and
    // a negative size, and that refusal is why a half-worked feed cannot put
    // "abc" on a ladder cell. So this check drives the same `shape()` BOTH
    // providers call — the real pipeline, not a copy of it — with exactly the
    // levels a mis-mapped vendor field produces, and asserts that none of them
    // reach a selection.
    //
    // Worth being explicit, because it is the one defect class the served board
    // cannot show on its own: an off-ladder price like 2.75 IS what the check
    // above catches, because 2.75 is finite, positive and above 1, so it walks
    // straight through `levelFromRow` and lands in the UI as a cell the engine
    // would snap to 2.76. Neither check subsumes the other, and the mutant in
    // C9 cannot exercise this one — it returns pre-shaped markets and never
    // enters the pipeline — so it is asserted here rather than there.
    // eslint-disable-next-line global-require
    const shape = require('../lib/feed/shape');
    const head = {
      market_id: '0.1', market_name: 'Boundary', market_start_time: future(1),
      market_status: 'OPEN', odds_captured_at: new Date().toISOString(),
    };
    const out = shape.shape([
      {
        ...head,
        selection_id: '1', runner_name: 'Home',
        odds: {
          back: [
            { price: 'abc', size: 10 },
            { price: 2.5, size: -5 },
            { price: 0.5, size: 10 },
            { price: 2.4, size: 10 }, // the one usable level, which must survive
          ],
          lay: [],
        },
      },
    ]);
    const s = out[0].selections[0];
    assert.deepStrictEqual(
      s.back.map((l) => l.price), [2.4],
      'only a level that is a real price with a real size behind it may reach the board'
    );
    for (const level of s.back) {
      assert.strictEqual(typeof level.price, 'number', 'a rendered price is always a number');
      assert.ok(Number.isSafeInteger(level.size_cents) && level.size_cents >= 0, 'and always a finite count of cents');
    }
  });

  await one('a one-sided book reports no percentage rather than an inflated one', () => {
    if (!p.priced({})) return;
    const market = board.find((m) => m.market_id === '1.200');
    assert.strictEqual(market.percent_book, null,
      'two runners priced on both sides and one on the back only is NOT a complete book, so no percentage is the honest answer');
    assert.strictEqual(market.lay_runners, 2);
    assert.strictEqual(market.runners, 3);
  });

  // ── 4. time ────────────────────────────────────────────────────────────────
  await one('every start time parses, and lib/offtime.js agrees', () => {
    for (const m of board) {
      const ms = offtime.offTimeMs(m.start_time);
      // NOT a soft warning. `offtime.offTimeMs` returns null for an unparseable
      // value and `isOffReached` then treats that as CLOSED — so a bad catalogue
      // row does not re-open trading, it closes it. A feed full of unparseable
      // start times is a feed with a closed book and no way to say so.
      assert.ok(ms !== null, `start_time on ${m.market_id} does not parse: ${JSON.stringify(m.start_time)}`);
      assert.ok(ms > Date.now(), `the fixture is in the future; ${m.market_id} reads ${new Date(ms).toISOString()}`);
      assert.ok(!Number.isNaN(new Date(m.start_time).getTime()), `Date cannot read start_time on ${m.market_id}`);
    }
  });

  // ── 5. limits ──────────────────────────────────────────────────────────────
  await one('board({limit}) never returns more markets than it was asked for', async () => {
    for (const limit of [1, 2, 3]) {
      const got = await p.board({ limit });
      assert.ok(got.length <= limit, `limit ${limit} returned ${got.length} markets`);
    }
  });

  await one('a junk limit falls back to the configured default, never to one market', async () => {
    // The bug this mirrors is the one `boardLimit` exists for: `Number('') === 0`,
    // so `?limit=` — the single most likely piece of junk a URL produces, and
    // what a browser sends for an empty input — fell through to a clamp of one
    // and served a ONE-MARKET board with no error and no warning.
    const defaultLimit = config.FEED_MARKET_LIMIT;
    const total = f().markets.length;
    for (const junk of ['', '   ', 0, '0', -5, '-5', 'abc', null, undefined, NaN]) {
      const got = await p.board({ limit: junk });
      assert.ok(got.length <= defaultLimit,
        `limit=${JSON.stringify(junk)} returned ${got.length} markets, past the configured default of ${defaultLimit}`);
      if (total <= defaultLimit) {
        assert.strictEqual(got.length, total,
          `limit=${JSON.stringify(junk)} is junk, so the configured default applies and all ${total} fixtures come back`);
      }
    }
  });

  await one('a huge limit is still bounded', async () => {
    const got = await p.board({ limit: 999_999 });
    assert.ok(got.length <= 500, `the 500-market ceiling must hold; got ${got.length}`);
  });

  // ── 6. a single market ─────────────────────────────────────────────────────
  await one('market(id) returns that market, and an unknown id is null', async () => {
    const one2 = await p.market('1.100');
    assert.ok(one2 && one2.market_id === '1.100', `market('1.100') returned ${JSON.stringify(one2 && one2.market_id)}`);
    assert.ok(one2.selections.length >= 1, 'a single-market read must carry the whole ladder, not one selection');
    assert.strictEqual(await p.market('no-such-market'), null, 'an unknown id is null, not an error and not another market');
  });

  await one('a blank id is refused without a request', async () => {
    assert.strictEqual(await p.market(null), null);
    assert.strictEqual(await p.market(''), null);
    assert.strictEqual(await p.market('   '), null);
  });

  await one('the same market read twice is deep-equal', async () => {
    const [a, b] = [await p.market('1.100'), await p.market('1.100')];
    // Clock fields compared separately, for the same reason as the parity check:
    // two calls milliseconds apart can round to different whole seconds, and a
    // check that flakes is a check that gets deleted.
    assert.deepStrictEqual(stripClocks([a]), stripClocks([b]), 'market() is not deterministic');
    assert.ok(Math.abs(a.poll_age_seconds - b.poll_age_seconds) <= 1, 'the two reads must agree on the clock to within a second');
  });

  // ── 7. the nav tree ────────────────────────────────────────────────────────
  await one('nav() builds the tree public/js/nav.js walks', async () => {
    const tree = await p.nav();
    assert.ok(Array.isArray(tree) && tree.length > 0, 'nav must return a non-empty array of sports');
    for (const sport of tree) {
      assert.ok(Array.isArray(sport.countries), `sport ${sport.sport} has no countries`);
      for (const c of sport.countries) {
        assert.ok(Array.isArray(c.competitions), `country ${c.country} has no competitions`);
        for (const comp of c.competitions) {
          // `meetings` is the renderer's name for this level. Renaming it to
          // `events` empties the whole tree with no error anywhere — which is
          // why it is asserted by NAME rather than by "something is there".
          assert.ok(Array.isArray(comp.meetings), `competition ${comp.competition} has no meetings`);
          assert.ok(comp.meetings.length > 0, `competition ${comp.competition} has no meetings to click`);
          assert.ok(typeof comp.competition === 'string' && comp.competition.trim() !== '',
            'a node label must never be blank or a placeholder glyph — it is the clickable text');
          for (const meeting of comp.meetings) {
            assert.ok(Array.isArray(meeting.races) && meeting.races.length > 0, 'every meeting must reach at least one race');
            for (const race of meeting.races) {
              assert.ok(race.market_id != null, 'every race must carry the id the ladder is fetched by');
              assert.ok(typeof race.market_name === 'string' && race.market_name.trim() !== '', 'every race must carry a name');
              assert.ok(!Number.isNaN(new Date(race.market_time).getTime()),
                `race ${race.market_id} has an unparseable market_time: ${JSON.stringify(race.market_time)}`);
            }
          }
        }
      }
    }
  });

  await one('two nav() calls are deep-equal', async () => {
    assert.deepStrictEqual(await p.nav(), await p.nav(), 'nav() is not deterministic');
  });

  // ── 8. health ──────────────────────────────────────────────────────────────
  let healthPayload = null;
  await one('health() answers in the shape server.js and classifyHealth read', async () => {
    healthPayload = await p.health();
    assert.ok(healthPayload && typeof healthPayload === 'object', 'health() must resolve an object');
    if (healthPayload.error) {
      // A probe that threw answers ONLY this, and that is legitimate — the
      // failure battery below covers it. Nothing further may be claimed.
      assert.strictEqual(healthPayload.error, 'Odds feed unavailable', 'the generic message is the contract');
      return;
    }
    assert.strictEqual(typeof healthPayload.ok, 'boolean', 'ok must be a boolean');
    assert.strictEqual(typeof healthPayload.priced, 'boolean', 'priced must be a boolean');
    assert.ok('feed' in healthPayload, 'feed must be present, even when it is null');
    assert.ok(Number.isInteger(healthPayload.markets), 'markets must be a count');
    assert.ok(Number.isInteger(healthPayload.markets_with_odds), 'markets_with_odds must be a count');
    assert.ok(Number.isInteger(healthPayload.resolved), 'resolved must be a count');
    assert.ok(healthPayload.odds_age_seconds === null || typeof healthPayload.odds_age_seconds === 'number',
      'odds_age_seconds must be a number or an honest null');
    assert.ok(healthPayload.data_age_seconds === null || typeof healthPayload.data_age_seconds === 'number',
      'data_age_seconds must be a number or an honest null');
    assert.strictEqual(typeof healthPayload.app_key_delay, 'boolean', 'app_key_delay must be a boolean');
    assert.ok(typeof healthPayload.app_key_delay_source === 'string' && healthPayload.app_key_delay_source,
      'an app_key_delay nobody can distinguish from a guess carries no information, so its source is published');
    assert.ok(typeof healthPayload.delay_note === 'string' && healthPayload.delay_note.length > 0,
      'a field nobody can explain is how the data_age_seconds provenance bug started');
  });

  await one('health() classifies into exactly one verdict classifyHealth understands', () => {
    if (healthPayload.error) return;
    const c = feed.classifyHealth(healthPayload, config.FEED_STALE_SECONDS);
    assert.ok(['fresh', 'stale', 'unpriced'].includes(c.kind), `unknown verdict kind: ${c.kind}`);
    assert.strictEqual(c.priced, p.priced({}), 'the payload and the provider disagree about whether this feed has prices');
  });

  await one('a delay-key feed publishes a NULL data age, never a fabricated one', () => {
    if (healthPayload.error) return;
    if (healthPayload.app_key_delay) {
      assert.strictEqual(healthPayload.data_age_seconds, null,
        'a Delay key cannot measure data age, and a number here would be read as current by anyone who glances at it');
    }
  });

  await one('a stale book is reported stale, not as unreachable', async () => {
    if (!p.priced({})) return;
    ctx.stale();
    let stale;
    try {
      stale = await p.health();
    } finally {
      ctx.fresh();
    }
    assert.ok(!stale.error, 'a stale feed is not an outage; it must answer, so an operator opens the runbook that fits');
    const verdict = feed.classifyHealth(stale, config.FEED_STALE_SECONDS);
    assert.strictEqual(verdict.kind, 'stale',
      `an ancient book must classify as stale; got ${verdict.kind} (odds_age_seconds ${JSON.stringify(stale.odds_age_seconds)})`);
    assert.strictEqual(verdict.stale, true);
    assert.ok(verdict.age > config.FEED_STALE_SECONDS,
      'the age must be published — it is the number that separates this case from an outage');
    // The distinction that costs an operator time when it is missing: a feed
    // that has merely gone quiet and a feed that cannot be reached must never
    // classify the same way.
    const dead = feed.classifyHealth({ ok: false, error: 'Odds feed unavailable' }, config.FEED_STALE_SECONDS);
    assert.strictEqual(dead.kind, 'unreachable');
    assert.notStrictEqual(dead.kind, verdict.kind, 'stale and unreachable collapsed into one verdict again');
  });

  await one('a healthy book is reported fresh', async () => {
    if (!p.priced({})) return;
    ctx.fresh();
    const h = await p.health();
    const c = feed.classifyHealth(h, config.FEED_STALE_SECONDS);
    assert.strictEqual(c.kind, 'fresh',
      `a book ${h.odds_age_seconds}s old against a ${config.FEED_STALE_SECONDS}s window must be fresh; got ${c.kind}`);
  });

  // ── 9. failure ─────────────────────────────────────────────────────────────
  await one('a failing feed answers health() with the generic message only', async () => {
    ctx.fail();
    let h = null;
    try {
      h = await p.health();
    } finally {
      ctx.recover();
    }
    assert.ok(h && h.error, 'a failing probe must answer, not throw and not hang');
    assert.strictEqual(h.error, 'Odds feed unavailable');
    assert.ok(!/http:\/\/|127\.0\.0\.1|ECONNREFUSED|postgres:\/\/|password/i.test(JSON.stringify(h)),
      `the health body leaked connection detail: ${JSON.stringify(h)}`);
  });

  await one('a failing feed REJECTS board() rather than returning an empty board', async () => {
    // The other half of the same hazard, and the more dangerous one. A board
    // endpoint that answers `[]` on a transport failure looks exactly like a
    // venue with no fixtures today: 200, empty, no log line, nothing to alarm.
    ctx.fail();
    let threw = false;
    try {
      await p.board({ limit: 10 });
    } catch {
      threw = true;
    } finally {
      ctx.recover();
    }
    assert.ok(threw, 'board() swallowed a transport failure and would have served an empty board instead');
  });

  return failed;
}

// ── the negative control ─────────────────────────────────────────────────────

// A provider that satisfies every part of the interface and produces WRONG data.
// Each constant breaks the battery in a specific, named way.
const MUTANT_MARKET = {
  market_id: '9.1',
  market_name: 'Mutant Match Odds',
  status: 'OPEN',
  start_time: new Date(Date.now() + 3600_000).toISOString(),
  selections: [
    {
      selection_id: '1',
      name: 'Home',
      // Not a number, off the tick ladder, and a negative size — the three
      // price defects a real feed adapter produces and the engine cannot see.
      back: [
        { price: 'abc', size_cents: 100, side: 'BACK' },
        { price: 2.75, size_cents: 500, side: 'BACK' },
        { price: 2.5, size_cents: -100, side: 'BACK' },
      ],
      // null, not []. public/js/board.js reads `sel.lay.length` unguarded.
      lay: null,
    },
  ],
};
const MUTANT_EMPTY = {
  market_id: '9.2',
  market_name: '',
  status: 'OPEN',
  start_time: 'not-a-timestamp',
  selections: [],
};

/**
 * THE MUTANT, and the reason it exists.
 *
 * It breaks eight things at once, in the eight ways the battery above is written
 * to catch: a non-numeric price, an off-ladder price, a negative size, a null
 * ladder, an empty market name, an unparseable start time, a market with no
 * runners, more markets than the limit it was given, and a nav tree that
 * reshuffles between two reads.
 *
 * It is NOT registered — `assertProvider` refuses it, and C10 proves that — so it
 * exists purely as something the battery must reject.
 */
function mutantProvider() {
  let navCallCount = 0;
  return {
    name: 'mutant',
    priced: () => true,
    async board() {
      // IGNORES the limit entirely, which is the boardSql CTE bug in a transport
      // that has no SQL to hide behind.
      return [
        { ...MUTANT_MARKET, selections: [{ ...MUTANT_MARKET.selections[0] }] },
        { ...MUTANT_EMPTY, market_id: '9.2' },
        { ...MUTANT_EMPTY, market_id: '9.3' },
      ];
    },
    async market(id) {
      if (id == null || String(id).trim() === '') return null;
      return {
        market_id: String(id),
        market_name: 'Mutant',
        start_time: new Date(Date.now() + 3600_000).toISOString(),
        selections: [{ selection_id: '1', name: 'Home', back: [], lay: [] }],
      };
    },
    async nav() {
      navCallCount += 1;
      return [{
        sport: 'Mutant Sport',
        countries: [{
          country: 'XX',
          competitions: [{
            competition: 'Mutant League',
            // Different on every call: a tree that reshuffles between two reads
            // is, to a user, indistinguishable from a feed that is lying.
            meetings: [{
              event_id: `e${navCallCount}`,
              event_name: `Meeting ${navCallCount}`,
              event_time: null,
              races: [{
                market_id: `m${navCallCount}`,
                market_name: 'Race',
                market_type: 'WIN',
                market_time: 'whenever',
                market_status: 'OPEN',
                in_play: false,
              }],
            }],
          }],
        }],
      }];
    },
    async health() {
      return {
        ok: true, feed: null, priced: true, markets: 1, markets_with_odds: 1, resolved: 0,
        odds_age_seconds: 1, oldest_odds_age_seconds: 1, data_age_seconds: 1,
        app_key_delay: false, app_key_delay_source: 'collector',
        delay_note: 'Live key: data_age_seconds is measured from Betfair publish_time, not from our poll time.',
      };
    },
    async close() {},
  };
}

// ── the fixture server ───────────────────────────────────────────────────────

/**
 * A real `node:http` server speaking a vendor's JSON, on an ephemeral loopback
 * port, with the request log kept so the battery can assert that the AUTH
 * HEADERS and the RESOURCE PATHS actually arrived.
 */
function startFixtureServer(state) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({
      path: url.pathname,
      query: url.search,
      authorization: req.headers.authorization || null,
      apiKey: req.headers['x-api-key'] || null,
    });
    if (state.mode === 'unreachable') {
      // A real transport failure, not a 404: the socket dies with no answer, so
      // the provider has to survive a connection that was never established.
      req.socket.destroy();
      return undefined;
    }
    const f = state.fixture();
    let body;
    if (url.pathname === state.boardPath) body = vendorBoard(f);
    else if (url.pathname === state.cataloguePath) body = vendorNav(f);
    else if (url.pathname === state.healthPath) body = vendorHealth(f);
    else if (url.pathname === state.marketPath) body = vendorSingleMarket(f, url.searchParams.get('id'));
    else {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'no such resource' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

module.exports = {
  runConformance,
  goodFixture,
  vendorBoard,
  vendorSingleMarket,
  postgresRows,
  postgresQuery,
  startFixtureServer,
  mutantProvider,
  VENDOR_FIELD_MAP_BOARD,
  VENDOR_FIELD_MAP_NAV,
  VENDOR_FIELD_MAP_HEALTH,
};

// ── the suite ────────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push([name, e]);
    console.error(`  FAIL ${name}\n       ${e && e.message}`);
  }
};

if (require.main === module) (async () => {
  const state = {
    mode: 'good',
    fixture: goodFixture,
    boardPath: '/board',
    cataloguePath: '/catalogue',
    marketPath: '/market',
    healthPath: '/health',
  };
  const { server, port, requests } = await startFixtureServer(state);

  // The environment is pinned HERE — after `listen()`, before any lib import —
  // and everything it configures is REAL: a live socket, real credentials, and
  // the vendor field maps below. Nothing is stubbed except the Postgres pool.
  const BASE = `http://127.0.0.1:${port}`;
  process.env.DB_PATH = ':memory:';
  process.env.SCRYPT_N = '16384';
  process.env.DRIFT_ENABLED = 'false';
  process.env.BOT_ENABLED = 'false';
  process.env.FEED_ENABLED = 'true';
  process.env.FEED_PROVIDER = 'http';
  process.env.FEED_DATABASE_URL = '';
  process.env.FEED_HTTP_URL = BASE;
  process.env.FEED_HTTP_BOARD_PATH = state.boardPath;
  process.env.FEED_HTTP_MARKET_PATH = state.marketPath;
  process.env.FEED_HTTP_CATALOGUE_PATH = state.cataloguePath;
  process.env.FEED_HTTP_HEALTH_PATH = state.healthPath;
  // Obviously fake, and named so: nothing here is a credential.
  process.env.FEED_HTTP_TOKEN = 'test-token-not-a-secret';
  process.env.FEED_HTTP_HEADER_NAME = 'X-Api-Key';
  process.env.FEED_HTTP_HEADER_VALUE = 'test-header-value-not-a-secret';
  process.env.FEED_HTTP_MAP_BOARD = VENDOR_FIELD_MAP_BOARD;
  process.env.FEED_HTTP_MAP_NAV = VENDOR_FIELD_MAP_NAV;
  process.env.FEED_HTTP_MAP_HEALTH = VENDOR_FIELD_MAP_HEALTH;

  try {
    // eslint-disable-next-line global-require
    const config = require('../lib/config');
    // eslint-disable-next-line global-require
    const provider = require('../lib/feed/provider');
    // eslint-disable-next-line global-require
    const { postgresProvider } = require('../lib/feed/postgres');
    // eslint-disable-next-line global-require
    const { httpProvider, marketPath, composeTarget, makeGate, MAX_RESPONSE_BYTES } = require('../lib/feed/http');
    assert.strictEqual(config.FEED_PROVIDER, 'http', `the pinned environment did not take: ${config.FEED_PROVIDER}`);
    assert.strictEqual(config.FEED_HTTP_URL, BASE, `the pinned base URL did not take: ${config.FEED_HTTP_URL}`);

    // One dataset, swapped between phases. `stale` ages every book past
    // FEED_STALE_SECONDS, which reaches the staleness branch without anyone
    // having to wait five minutes for it.
    let current = goodFixture();
    const swap = (next) => { current = next(); state.fixture = () => current; };
    const freshFixture = () => {
      const f = goodFixture();
      for (const m of f.markets) if (m.market_id !== '1.300') m.odds_captured_at = new Date(Date.now() - 60_000).toISOString();
      return f;
    };
    const staleFixture = () => {
      const f = goodFixture();
      for (const m of f.markets) m.odds_captured_at = new Date(Date.now() - (config.FEED_STALE_SECONDS + 600) * 1000).toISOString();
      return f;
    };

    const httpProv = provider.current();
    assert.strictEqual(httpProv.name, 'http', `FEED_PROVIDER=http must resolve the http provider; got ${httpProv.name}`);
    // `down` is shared by both transports: the battery's failure phase has to be
    // able to take EITHER of them offline, and a fault injected into one provider
    // only would let the other's failure battery assert nothing.
    const wire = { down: false };
    const pgProv = postgresProvider({ query: postgresQuery(() => current, () => wire.down) });

    const ctxFor = (name, prov) => ({
      name,
      provider: prov,
      fixture: () => current,
      priced: true,
      stale: () => swap(staleFixture),
      fresh: () => swap(freshFixture),
      fail: () => { state.mode = 'unreachable'; wire.down = true; },
      recover: () => { state.mode = 'good'; wire.down = false; },
    });

    await check('C1 the HTTP provider resolves from FEED_PROVIDER alone, with no code change', () => {
      assert.strictEqual(provider.current().name, 'http');
      assert.ok(provider.CAPABILITIES.http, 'and the registry declares it');
      assert.ok(provider.CAPABILITIES.postgres, 'alongside the collector it replaced as the default');
    });

    await check('C2 the HTTP battery, against a real node:http server and a vendor field map', async () => {
      swap(goodFixture);
      await runConformance(ctxFor('http', httpProv), check);
    });

    await check('C3 the Postgres battery, against an injected pool returning v_feed2 rows', async () => {
      swap(goodFixture);
      await runConformance(ctxFor('postgres', pgProv), check);
    });

    await check('C4 the credentials and the resource paths actually reached the server', () => {
      assert.ok(requests.length > 0, 'no request arrived; the battery proved nothing about the transport');
      for (const r of requests) {
        assert.strictEqual(r.authorization, 'Bearer test-token-not-a-secret', `no bearer token on ${r.path}`);
        assert.strictEqual(r.apiKey, 'test-header-value-not-a-secret', `no static header on ${r.path}`);
      }
      const paths = new Set(requests.map((r) => r.path));
      for (const want of [state.boardPath, state.cataloguePath, state.healthPath, state.marketPath]) {
        assert.ok(paths.has(want), `the ${want} resource was never requested`);
      }
      const single = requests.find((r) => r.path === state.marketPath);
      assert.strictEqual(single.query, '?id=1.100',
        `the id must be appended as a query parameter when the path carries no {id}; got ${single.query}`);
    });

    await check('C5 the id reaches the market path, and the base URL keeps its own path', () => {
      // `new URL('/board', 'https://example.com/v2/feed')` throws away /v2/feed
      // — WHATWG resolution treats a leading slash as absolute. An operator
      // hosting their feed API under a path would lose it on every request.
      assert.strictEqual(marketPath({ FEED_HTTP_MARKET_PATH: '/mkt' }, 'a b'), '/mkt?id=a%20b');
      assert.strictEqual(marketPath({ FEED_HTTP_MARKET_PATH: '/mkt/{id}' }, 'a b'), '/mkt/a%20b');
      assert.strictEqual(marketPath({ FEED_HTTP_MARKET_PATH: '/mkt?x=1' }, '7'), '/mkt?x=1&id=7');
    });

    await check('C6 an oversized body is refused rather than buffered', async () => {
      // An unbounded read from a third-party endpoint is a memory denial of
      // service ON THE VENUE: a provider that answers with a 500MB body can OOM
      // a process that was only trying to draw a ladder. The stream below keeps
      // producing past the cap, so the reader has to be what stops it.
      let chunk = 0;
      const capped = httpProvider({
        cfg: config,
        fetchImpl: async () => ({
          ok: true,
          body: {
            getReader: () => ({
              async read() {
                chunk += 1;
                return chunk > 32 ? { done: true } : { done: false, value: Buffer.alloc(1024 * 1024, 0x20) };
              },
              async cancel() { /* the stream is being abandoned on purpose */ },
            }),
          },
        }),
      });
      let refused = null;
      try {
        await capped.board({ limit: 1 });
      } catch (e) {
        refused = e;
      }
      assert.ok(refused && /exceeded \d+ bytes/.test(refused.message),
        `an oversized body must be refused, not buffered; got ${refused && refused.message}`);
      assert.ok(chunk < 32, `the reader must stop at the cap rather than drain the stream; it read ${chunk} chunks`);
      assert.ok(MAX_RESPONSE_BYTES > 0, 'and the cap is a real bound');
    });

    await check('C7 the two providers produce byte-identical boards from the same data', async () => {
      swap(goodFixture);
      const [a, b] = [
        await pgProv.board({ limit: config.FEED_MARKET_LIMIT }),
        await httpProv.board({ limit: config.FEED_MARKET_LIMIT }),
      ];
      // The clock fields are compared separately and with a tolerance: two calls
      // milliseconds apart can round to different whole seconds, and a check
      // that flakes is a check that gets deleted.
      assert.deepStrictEqual(stripClocks(a), stripClocks(b),
        'the HTTP provider and the Postgres provider must shape identical data identically — one shaper, or two shapers that have already drifted');
      for (let i = 0; i < a.length; i++) {
        assert.deepStrictEqual(a[i].price_captured_at, b[i].price_captured_at,
          'both providers must publish the same capture timestamp, so a freshness claim means the same thing on both');
        assert.ok(Math.abs(a[i].poll_age_seconds - b[i].poll_age_seconds) <= 1, 'the two clocks must agree to within a second');
        assert.strictEqual(a[i].stale, b[i].stale, 'staleness is a verdict, not a rounding difference');
      }
    });

    await check('C8 the two providers produce byte-identical nav trees from the same data', async () => {
      swap(goodFixture);
      assert.deepStrictEqual(await pgProv.nav(), await httpProv.nav(),
        'the same catalogue must reach the same renderer shape whichever provider served it');
    });

    await check('C9 NEGATIVE CONTROL: the battery rejects a deliberately broken provider', async () => {
      // THE POINT OF THIS CHECK. If a provider that returns "abc" as a price,
      // an unparseable off time, a market with no runners, more markets than the
      // limit and a nav tree that changes between calls can PASS, then the
      // battery is decorative and every green line above it is a lie.
      const collected = [];
      const collect = async (name, fn) => {
        try {
          await fn();
        } catch (e) {
          collected.push({ name, message: e && e.message });
        }
      };
      const failed = await runConformance(ctxFor('mutant', mutantProvider()), collect);
      assert.ok(failed.length > 0, 'the broken provider PASSED the battery, so the battery asserts nothing');
      // …and it failed for the RIGHT reasons. Naming them is what stops a future
      // edit from quietly weakening a check into one the mutant happens to miss.
      const expected = [
        'every market has an id, a name, a start time and at least one runner',
        'every runner has an id, a name, and two ladder arrays',
        'every ladder level is a price this engine can trade, with a finite size',
        'every start time parses, and lib/offtime.js agrees',
        'board({limit}) never returns more markets than it was asked for',
        'two nav() calls are deep-equal',
      ];
      for (const want of expected) {
        assert.ok(failed.includes(want),
          `the battery did not catch "${want}" on a provider built to fail it; it caught: ${failed.join(' | ') || '(nothing)'}`);
      }
      // …and the interface check still PASSES on the mutant, which is the point
      // of separating "implements the contract" from "produces correct data":
      // `assertProvider` cannot see any of these defects, which is why the
      // battery has to.
      assert.ok(!failed.includes('implements the whole provider contract'),
        'the mutant does implement the interface — if this ever fails, the check is measuring something else');
      assert.ok(collected.length >= expected.length, 'and the individual failures were recorded, not swallowed');
    });

    await check('C10 the registry refuses a provider nobody declared', () => {
      // PRECISELY WHAT C10 DOES AND DOES NOT ESTABLISH, because this suite's
      // header used to imply more than it could:
      //
      //   IT DOES      enforce the six method names and the capability-table
      //                name. That is a real gate — an adapter nobody declared
      //                cannot be wired in at all.
      //   IT DOES NOT  run this battery at registration, and cannot. Running an
      //                offline fixture suite at production startup would turn a
      //                boot into a test run and make the venue refuse to start
      //                because an assertion about a synthetic fixture drifted. So
      //                the battery is enforced by CI and by review, and this file
      //                is the artefact the reviewer is pointed at.
      //
      // The mutant implements all six methods, so "complete" and "correct" are
      // visibly different things — which is the whole argument for a battery that
      // exists separately from the interface.
      assert.throws(
        () => provider.register(mutantProvider()),
        /not declared in lib\/feed\/provider\.js/,
        'an undeclared provider must not be registrable'
      );
      // The method check is asserted on `assertProvider` directly. Registering a
      // throwaway under a DECLARED name would work too, and would also replace
      // the live provider in the registry — so the registry is left alone and
      // the same code path is driven directly.
      assert.throws(
        () => provider.assertProvider({ name: 'http', board() {} }),
        /missing/,
        'a provider missing half the contract must be refused'
      );
      // And the gate is not merely a name filter.
      assert.throws(
        () => provider.assertProvider(mutantProvider()),
        /not declared in lib\/feed\/provider\.js/,
        'a COMPLETE implementation of an undeclared provider is still refused'
      );
      assert.doesNotThrow(
        () => provider.assertProvider(provider.select('postgres')),
        'and a real provider passes its own gate, so the gate is not refusing everything'
      );
      assert.throws(
        () => provider.select('half'),
        /is not a provider this build knows/,
        'and selecting a name no build knows must refuse rather than fall back to a default'
      );
      // …and the complement, which is the whole reason this file exists: give
      // the mutant a DECLARED name and the interface accepts it, because the
      // interface cannot see that its prices are "abc". If this assertion ever
      // starts failing the interface has become strong enough to do the battery's
      // job and the battery is redundant; if it ever passes silently, someone has
      // swapped it for a weaker check.
      assert.doesNotThrow(
        () => provider.assertProvider({ ...mutantProvider(), name: 'postgres' }),
        'a complete provider with a declared name is ACCEPTED — which is exactly why the battery, not assertProvider, is the real control'
      );
    });

    await check('C11 a bad provider configuration is a BOOT error, not a warning', () => {
      const { loadConfig } = require('../lib/config');
      const base = { FEED_PROVIDER: 'http', FEED_HTTP_URL: 'https://feeds.example.com.au/v2' };
      const floor = { PORT: '7777', HOST: '127.0.0.1', DB_PATH: ':memory:', SCRYPT_N: '16384' };
      const cases = [
        [{ FEED_PROVIDER: 'http' }, /requires FEED_HTTP_URL/, 'the HTTP provider with no base URL'],
        [{ FEED_PROVIDER: 'http', FEED_HTTP_URL: 'file:///etc/passwd' }, /must be an http\(s\):\/\/ URL/, 'a non-http scheme'],
        [{ FEED_PROVIDER: 'http', FEED_HTTP_URL: 'https://key@feeds.example.com.au' }, /must not carry credentials/, 'a credential in the URL'],
        [{ FEED_PROVIDER: 'kafka' }, /must be 'postgres' or 'http'/, 'an unknown provider name'],
        [{ ...base, FEED_HTTP_MAP_BOARD: '' }, /is empty/, 'an empty field map'],
        [{ ...base, FEED_HTTP_MAP_BOARD: 'markets=markets,,id=id' }, /empty entry/, 'a doubled comma'],
        [{ ...base, FEED_HTTP_MAP_BOARD: 'markets=markets,marketId=id' }, /not a canonical feed field/, 'a field from the old camelCase sketch'],
        [{ ...base, FEED_HTTP_MAP_BOARD: 'markets=' }, /maps "markets" to nothing/, 'a field mapped to nothing'],
        [{ ...base, FEED_HTTP_MAP_BOARD: 'markets=markets,market_id=id,market_id=jdx' }, /twice/, 'a duplicated field'],
        [{ ...base, FEED_HTTP_MAP_BOARD: 'markets=markets,market_name=name' }, /required field/, 'a map missing required fields'],
        [{ ...base, FEED_HTTP_TIMEOUT_MS: '5' }, /FEED_HTTP_TIMEOUT_MS/, 'a timeout below the floor'],
        [{ ...base, FEED_HTTP_SIZE_SCALE: '0' }, /FEED_HTTP_SIZE_SCALE/, 'a size scale of zero'],
        [{ ...base, FEED_HTTP_SIZE_SCALE: 'nope' }, /FEED_HTTP_SIZE_SCALE/, 'a size scale that is not a number'],
      ];
      for (const [over, why, label] of cases) {
        assert.throws(() => loadConfig(null, Object.assign({}, floor, over)), why, `${label} must abort the launch`);
      }
    });

    await check('C12 the default deployment is still the collector, byte for byte', () => {
      const { loadConfig } = require('../lib/config');
      const plain = loadConfig(null, { PORT: '7777', HOST: '127.0.0.1', DB_PATH: ':memory:', SCRYPT_N: '16384' });
      assert.strictEqual(plain.FEED_PROVIDER, 'postgres', 'the default provider must be the one this venue had before the seam');
      // Every HTTP key exists and is INERT on a Postgres deployment. "Inert" is
      // the load-bearing word: a value that parses but is then used would mean
      // FEED_PROVIDER was not really deciding anything.
      assert.strictEqual(plain.FEED_HTTP_URL, '', 'no base URL is invented for a deployment that never asked for one');
      assert.strictEqual(plain.FEED_HTTP_TOKEN, null, 'and no token is either');
      assert.strictEqual(plain.FEED_HTTP_BOARD_PATH, '/board', 'paths keep their defaults');
      // And a Postgres deployment does not demand a base URL at all.
      assert.throws(
        () => loadConfig(null, { PORT: '7777', HOST: '127.0.0.1', DB_PATH: ':memory:', SCRYPT_N: '16384', FEED_ENABLED: 'true', FEED_DATABASE_URL: '' }),
        /requires FEED_DATABASE_URL/,
        'the collector path still refuses to boot without its database URL'
      );
    });

    await check('C13 a provider that throws becomes a 503 feed_unavailable with nothing leaked', async () => {
      // The end-to-end half. The battery proves the provider fails; this proves
      // the VENUE's answer to that failure is the generic one — a property of
      // server.js rather than of any provider, and load-bearing, because a driver
      // error embeds the host, the user and often part of the connection string.
      //
      // Port 59998 is reserved and nothing listens on it, so on LOOPBACK the
      // connection is refused in milliseconds rather than hanging on a timeout.
      // "Offline" has to mean "fast" or the suite stops being a suite.
      const failing = httpProvider({ cfg: Object.assign({}, config, { FEED_HTTP_URL: 'http://127.0.0.1:59998' }) });
      provider.register(failing);
      provider.select('http');

      const { findNavHandler } = require('./feed.test');
      const srv = require('../server');
      const handler = findNavHandler(srv.app);
      assert.ok(handler, 'a /api/feed/nav handler is registered');
      const sent = { code: null, body: null };
      const res = {
        status(c) { sent.code = c; return this; },
        json(b) { if (sent.code === null) sent.code = 200; sent.body = b; return this; },
      };
      const logged = [];
      const realError = console.error;
      console.error = (...a) => logged.push(a.map(String).join(' '));
      try {
        await handler({}, res);
      } finally {
        console.error = realError;
        // Put the good provider back so nothing after this sees a dead transport.
        provider.register(httpProv);
        provider.select('http');
      }

      assert.strictEqual(sent.code, 503, 'an outage is a 503, not a silent empty board');
      assert.strictEqual(sent.body.error, 'Odds feed unavailable', 'the documented generic message');
      assert.strictEqual(sent.body.code, 'feed_unavailable', 'and the code an operator routes on');
      assert.deepStrictEqual(Object.keys(sent.body).sort(), ['code', 'error'],
        `nothing beyond error+code may escape: ${JSON.stringify(sent.body)}`);
      const body = JSON.stringify(sent.body);
      assert.ok(!/59998|ECONNREFUSED|127\.0\.0\.1|http:\/\/|test-token-not-a-secret|unreachable/i.test(body),
        `the 503 body leaked detail: ${body}`);
      // …and the operator still gets the reason, in the SERVER LOG, which is
      // where an operator can act on it. Both halves or neither is worthless:
      // logging nothing is as bad as leaking everything.
      assert.ok(logged.some((l) => /feed http/.test(l)),
        `the failure must be logged server-side with its reason; got ${JSON.stringify(logged)}`);
      assert.ok(logged.every((l) => !/test-token-not-a-secret|test-header-value-not-a-secret/.test(l)),
        `a secret reached the log: ${JSON.stringify(logged)}`);
    });

    // ── Finding 1: the credential in the log ─────────────────────────────────
    //
    // C13's blind spot, and why it was blind. It drives the transport to
    // ECONNREFUSED, where undici's message is the bare `fetch failed` — no host,
    // no credential, nothing to leak. So a suite that asserted the no-leak
    // invariant on that branch was asserting something true about a message that
    // happened to be harmless, and said nothing at all about the messages that
    // are not.
    //
    // The realistic trigger is a credential that undici REFUSES. A header value
    // containing CRLF or NUL raises
    //   TypeError: Headers.append: "<the entire value>" is an invalid header value.
    // — the whole value, verbatim. A PEM private key pasted into
    // FEED_HTTP_HEADER_VALUE is exactly that shape, and the exception was
    // interpolated into this module's own error, which server.js logs at four
    // call sites and this module logs at one. So an unauthenticated
    // `GET /api/feed/board` printed the operator's licensed feed-API credential
    // to stdout on every request.
    //
    // C14 reproduces it through the REAL transport — real `fetch`, real
    // undici, a header value with real newlines in it — and asserts the secret
    // appears in NONE of: the thrown error's message, `console.error` output, or
    // anything a route could echo.
    await check('C14 a credential undici REFUSES never reaches the log or the error', async () => {
      // Obviously fake and obviously shaped like the real thing: a PEM block is
      // newlines plus base64, and that shape is the vulnerability.
      const PEM = [
        '-----BEGIN PRIVATE KEY-----',
        'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ',
        '-----END PRIVATE KEY-----',
      ].join('\n');
      // A second value, so a fix that merely special-cases one shape is caught.
      const NUL_BEARING = 'abc def';
      const configured = [
        Object.assign({}, config, { FEED_HTTP_URL: 'http://127.0.0.1:59997', FEED_HTTP_TOKEN: PEM, FEED_HTTP_HEADER_NAME: '' }),
        Object.assign({}, config, {
          FEED_HTTP_URL: 'http://127.0.0.1:59997', FEED_HTTP_TOKEN: null,
          FEED_HTTP_HEADER_NAME: 'X-Api-Key', FEED_HTTP_HEADER_VALUE: PEM,
        }),
        Object.assign({}, config, {
          FEED_HTTP_URL: 'http://127.0.0.1:59997', FEED_HTTP_TOKEN: NUL_BEARING, FEED_HTTP_HEADER_NAME: '',
        }),
      ];
      const needles = [PEM, PEM.split('\n')[1], NUL_BEARING];

      for (const cfg of configured) {
        const labelled = httpProvider({ cfg });
        // Every call site that can reach a secret-bearing failure. `board` is the
        // unauthenticated GET an attacker can trigger; `health` is the one this
        // module logs ITSELF, from its own catch, at lib/feed/http.js's
        // `console.error`.
        for (const call of [
          () => labelled.board({ limit: 5 }),
          () => labelled.nav(),
          () => labelled.market('1.100'),
          () => labelled.health(),
        ]) {
          const logged = [];
          const realError = console.error;
          console.error = (...a) => logged.push(a.map(String).join(' '));
          let thrown = null;
          let returned = null;
          try {
            returned = await call();
          } catch (e) {
            thrown = e;
          } finally {
            console.error = realError;
          }
          // `health()` answers rather than throwing by contract; the others must
          // reject. Either way the message and the log line are the leak
          // surface, so both are scanned.
          const surfaces = [
            thrown && thrown.message ? thrown.message : '',
            thrown && thrown.stack ? thrown.stack : '',
            JSON.stringify(returned),
            logged.join('\n'),
          ].join('\n');
          for (const needle of needles) {
            assert.ok(!surfaces.includes(needle),
              `a configured credential reached an operator-visible surface.\n` +
              `     needle : ${JSON.stringify(needle)}\n` +
              `     surface: ${JSON.stringify(surfaces)}`);
          }
          // …and the failure is still a failure. A fix that swallowed the error
          // to stop the leak would pass the scan above and break the contract,
          // so the two are asserted together.
          assert.ok(thrown || (returned && returned.error === 'Odds feed unavailable'),
            `the call must still fail; it resolved with ${JSON.stringify(returned)}`);
          // `health()` answers with the fixed generic message BY CONTRACT, so the
          // resource is named in the LOG there rather than in the returned
          // value — and the log was scanned above. Only a THROWN error has to
          // name the resource in its own text.
          if (thrown) {
            assert.ok(thrown.message.startsWith('feed http: '),
              `a thrown feed error must name the resource, which is the part an operator needs; got ${JSON.stringify(thrown.message)}`);
            assert.strictEqual(returned, null,
              'a call that threw must not also have resolved with an error object');
          }
        }
      }
    });

    // The other half of C13's blind spot, asserted separately so a future fix
    // cannot quietly restore it: even on the branch where undici's own message
    // IS harmless today, nothing from the runtime may be forwarded. A host is
    // exactly the thing that ends up in a support ticket, and the module's own
    // header says the composed URL never appears in an error.
    await check('C15 no runtime string is forwarded into a provider error, on any branch', async () => {
      // A fetchImpl whose failure message is hostile by construction: it echoes
      // back everything it was handed, which is the worst a real transport can
      // be and is exactly what undici does with an invalid header value.
      const hostile = new Error('connect ECONNREFUSED 127.0.0.1:59997 with token super-secret-token-value');
      const cfg = Object.assign({}, config, {
        FEED_HTTP_URL: 'http://127.0.0.1:59997',
        FEED_HTTP_TOKEN: 'super-secret-token-value',
      });
      const p = httpProvider({ cfg, fetchImpl: async () => { throw hostile; } });
      let thrown = null;
      try {
        await p.board({ limit: 5 });
      } catch (e) {
        thrown = e;
      }
      assert.ok(thrown, 'a transport failure must still reject');
      for (const banned of ['super-secret-token-value', '127.0.0.1', 'ECONNREFUSED', '59997', 'http://']) {
        assert.ok(!thrown.message.includes(banned),
          `the thrown message forwarded a runtime string (${banned}): ${JSON.stringify(thrown.message)}`);
      }
      assert.match(thrown.message, /^feed http: \/board unreachable$/,
        `the sanitised message must be exactly the path and the class, and nothing else; got ${JSON.stringify(thrown.message)}`);
    });

    // ── Finding 2a: in-flight requests are capped ──────────────────────────────
    //
    // Under FEED_PROVIDER=postgres the venue was implicitly bounded by
    // `new Pool({ max: 4 })`. HTTP removed that bound: Node's global fetch agent
    // is uncapped, so N concurrent board requests opened N sockets to the
    // operator's OWN licensed feed API, each able to buffer up to 8 MiB.
    //
    // C16 proves the cap is real by MEASURING the provider's own concurrency
    // from inside the transport, rather than by counting requests: a test that
    // asserted "at most N requests were issued" would still pass against an
    // implementation that queued without limit, which is the half of this that
    // actually exhausts memory.
    await check('C16 the provider caps in-flight requests and fails fast when its queue is full', async () => {
      const CONCURRENCY = 2;
      const QUEUE = 1;
      let inFlight = 0;
      let peak = 0;
      let served = 0;
      // A server that HOLDS each request, so overlap is real rather than
      // something the event loop happened to serialise.
      const gateCfg = Object.assign({}, config, {
        FEED_HTTP_MAX_CONCURRENCY: CONCURRENCY,
        FEED_HTTP_MAX_QUEUE: QUEUE,
        // Long enough that no waiter can time out during the test and be
        // mistaken for a queue-full refusal, short enough not to slow the suite.
        FEED_HTTP_TIMEOUT_MS: 5000,
      });
      const holding = httpProvider({
        cfg: gateCfg,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          body: {
            getReader() {
              let sent = false;
              return {
                async read() {
                  if (sent) return { done: true };
                  sent = true;
                  inFlight += 1;
                  peak = Math.max(peak, inFlight);
                  await new Promise((r) => setTimeout(r, 30));
                  inFlight -= 1;
                  served += 1;
                  const body = JSON.stringify({ data: { events: [] } });
                  return { done: false, value: Buffer.from(body, 'utf8') };
                },
                async cancel() { /* the stream is being abandoned */ },
              };
            },
          },
        }),
      });

      // CONCURRENCY in flight, plus QUEUE waiting, plus one that must be refused:
      // the total that the cap and the bounded queue together permit.
      const burst = CONCURRENCY + QUEUE + 3;
      const results = await Promise.allSettled(
        Array.from({ length: burst }, () => holding.board({ limit: 1 }))
      );
      const refused = results.filter((r) => r.status === 'rejected');
      const ok = results.filter((r) => r.status === 'fulfilled');

      assert.ok(ok.length >= CONCURRENCY,
        `at least the configured ${CONCURRENCY} requests must be served, or the cap is refusing work it should hold; served ${ok.length}`);
      assert.strictEqual(served, ok.length,
        'and every served request must have reached the transport exactly once');
      assert.ok(peak <= CONCURRENCY,
        `at most ${CONCURRENCY} requests may be in flight at once; the peak was ${peak} — an unbounded fan-out`);
      assert.ok(refused.length >= 3,
        `past the cap and the queue, callers must be REFUSED rather than queued without limit; ${refused.length} of ${burst} were refused`);
      for (const r of refused) {
        assert.ok(r.reason && r.reason.reason === 'busy',
          `a queue-full refusal must carry the provider's own 'busy' class, so the route turns it into the generic 503; got ${JSON.stringify(r.reason && r.reason.message)}`);
        assert.ok(/^feed http: \/board — too many requests already in flight/.test(r.reason.message),
          `and must say why, in words this module wrote; got ${JSON.stringify(r.reason.message)}`);
      }
      // The message reports the CONFIGURED numbers, so an operator reading the log
      // can tell "the venue is full" from "I set that wrong".
      const first = refused[0].reason.message;
      assert.ok(first.includes(`${CONCURRENCY} in flight, ${QUEUE} queued`),
        `the refusal must name the configured cap, which is the number an operator has to tune; got ${JSON.stringify(first)}`);
    });

    await check('C17 a freed slot is handed to the next caller, and close() drops the queue', async () => {
      // The accounting half of C16, and the reason it is a separate check: a gate
      // that leaks a slot looks correct under a burst and then serves one request
      // at a time for ever, which is a DIFFERENT bug and one C16 cannot see — it
      // only counts a peak.
      const gate = makeGate({ max: 1, queue: 2, waitMs: 5000 });
      const order = [];
      const first = gate('/x').then((release) => { order.push('a'); return release; });
      await new Promise((r) => setImmediate(r));
      const second = gate('/x').then((release) => { order.push('b'); return release; });
      await new Promise((r) => setImmediate(r));
      assert.deepStrictEqual(order, ['a'], 'the second caller must wait while the slot is held');

      const stats = gate.stats();
      assert.strictEqual(stats.active, 1, 'exactly one slot is held');
      assert.strictEqual(stats.queued, 1, 'and exactly one caller is waiting');

      // Release the first. The slot must TRANSFER to the waiter with no window in
      // which a third caller could overtake it, which is why `release` hands off
      // rather than decrementing and re-acquiring.
      const releaseA = await first;
      releaseA();
      const releaseB = await second;
      releaseB();
      assert.deepStrictEqual(order, ['a', 'b'], 'the slot goes to the waiter, in order');
      assert.strictEqual(gate.stats().active, 0,
        'and the count returns to zero, or the next burst is smaller than the cap it claims to have');

      // close() must not leave callers waiting out the full timeout: a shutdown
      // that lingers is a shutdown the operator notices. A caller has to be
      // genuinely QUEUED for this to mean anything — one that finds a free slot
      // is served immediately and `close` is irrelevant to it.
      const held = await gate('/x');
      const blocked = gate('/x');
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(gate.stats().queued, 1, 'the second caller really is waiting, so close() has something to drop');
      gate.close('closed');
      held();
      await blocked.then(
        () => { throw new Error('a queued caller was handed a slot after close()'); },
        (e) => {
          assert.strictEqual(e.reason, 'busy');
          assert.match(e.message, /the provider is closing/);
        }
      );
      await gate('/x').then(
        () => { throw new Error('a closed gate admitted a caller'); },
        (e) => assert.strictEqual(e.reason, 'busy', 'and a closed gate admits nobody')
      );
    });

    await check('C18 the default cap is the number the Postgres path effectively had', async () => {
      // Not a tautology about a constant: it asserts the DEFAULT matches
      // `new Pool({ max: 4 })` in lib/feed/postgres.js, read from that file. So
      // somebody who raises the pool has to decide about the HTTP cap, rather
      // than the two silently diverging and nobody noticing which one the venue
      // is honouring.
      const pgSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'feed', 'postgres.js'), 'utf8');
      const poolMax = /new Pool\(\{[\s\S]*?max:\s*(\d+)/.exec(pgSrc);
      assert.ok(poolMax, 'the pg pool has a `max:` to read; if this fails the pool was restructured and the default needs re-deciding by hand');
      assert.strictEqual(config.FEED_HTTP_MAX_CONCURRENCY, Number(poolMax[1]),
        `the HTTP default cap must be what the collector's pool had (${poolMax[1]}), so switching provider does not silently change the venue's concurrency`);
    });

    // ── Finding 3: the composed target's authority ───────────────────────────
    await check('C19 a resource path cannot move the request to another host', () => {
      const base = 'https://legit-feed.example.com.au';
      // The configuration-only path, checked at BOOT.
      const { loadConfig } = require('../lib/config');
      const floor = { PORT: '7777', HOST: '127.0.0.1', DB_PATH: ':memory:', SCRYPT_N: '16384', FEED_PROVIDER: 'http', FEED_HTTP_URL: base };
      for (const [key, value] of [
        ['FEED_HTTP_BOARD_PATH', '@evil.example.net/collect'],
        ['FEED_HTTP_CATALOGUE_PATH', 'https://evil.example.net/collect'],
        ['FEED_HTTP_HEALTH_PATH', 'https://user:pass@evil.example.net/collect'],
        ['FEED_HTTP_MARKET_PATH', 'https://legit-feed.example.com.au.evil.example.net/m'],
      ]) {
        assert.throws(() => loadConfig(null, Object.assign({}, floor, { [key]: value })),
          /changes the host of FEED_HTTP_URL/,
          `${key}=${value} must abort the launch`);
      }
      assert.throws(() => loadConfig(null, Object.assign({}, floor, { FEED_HTTP_URL: 'https://key@legit-feed.example.com.au' })),
        /must not carry credentials/,
        'a base carrying a credential is still refused — the origin rule does not catch it, because WHATWG strips userinfo before comparing origins');

      // …and the paths that are NOT an attack must still work, or the check is
      // simply "refuse everything".
      for (const [key, value] of [
        ['FEED_HTTP_BOARD_PATH', '/board'],
        ['FEED_HTTP_BOARD_PATH', '/v2/feed/board?x=1'],
        ['FEED_HTTP_MARKET_PATH', '/market/{id}'],
        ['FEED_HTTP_BOARD_PATH', '//evil.example.net/collect'],
        ['FEED_HTTP_URL', 'https://legit-feed.example.com.au/v2/feed'],
      ]) {
        assert.doesNotThrow(() => loadConfig(null, Object.assign({}, floor, { [key]: value })),
          `${key}=${value} is a legitimate configuration and must be accepted`);
      }

      // And the SAME rule at REQUEST time, which is the layer that holds for a
      // provider built without going through the loader.
      assert.strictEqual(composeTarget({ FEED_HTTP_URL: base }, '/board', undefined), 'https://legit-feed.example.com.au/board');
      // `//evil.example.net/c` is deliberately NOT in this list, and the reason is
      // worth stating: composition is a STRING JOIN, so it becomes
      // `https://host//evil.example.net/c` — a path with a doubled slash on the
      // configured host. It would only be protocol-relative if it were resolved
      // against a base the WHATWG way, which is exactly why this module does not.
      for (const path of ['@evil.example.net/collect', 'https://evil.example.net/collect']) {
        assert.throws(() => composeTarget({ FEED_HTTP_URL: base }, path, undefined),
          /changes the host of FEED_HTTP_URL/,
          `a request-time composition of "${path}" must be refused`);
      }
      // …and the refusal must not quote the COMPOSED URL. Naming the offending
      // path is correct and useful — it is the key an operator has to go and fix —
      // but the base is the operator's own host and does not belong in a string
      // that four call sites in server.js write to a log.
      try {
        composeTarget({ FEED_HTTP_URL: base }, '@evil.example.net/collect', undefined);
        throw new Error('expected a refusal');
      } catch (e) {
        assert.ok(!/legit-feed\.example\.com\.au|https:\/\//.test(e.message),
          `the refusal must not quote the composed URL or the configured base; got ${JSON.stringify(e.message)}`);
        assert.ok(e.message.includes('@evil.example.net/collect'),
          `but it must name the offending path, which is the key the operator has to fix; got ${JSON.stringify(e.message)}`);
      }
    });

    console.log(`\nfeedprovider-conformance.test.js: ${passed} checks passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
  } catch (e) {
    console.error('\nfeedprovider-conformance.test.js: SUITE ERROR');
    console.error(e);
    process.exit(1);
  } finally {
    // THE FINALLY, and the reason tests/run_all.js has a timeout at all:
    // tests/express5.test.js once leaked a listening socket after a failed
    // assertion and the whole runner stopped with no output and no exit code.
    // `closeAllConnections` is there because the runtime's fetch keeps the
    // connection alive, and `close()` alone waits for it for ever.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
})();