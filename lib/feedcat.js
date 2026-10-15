'use strict';
// lib/feedcat.js — MATERIALISE the feed's catalogue into the venue's own book,
// and translate between the two id spaces that creates.
//
// ── WHY THIS EXISTS (#101) ─────────────────────────────────────────────────────
// With FEED_ENABLED the venue showed a feed's fixtures, its off times and its
// reference ladders — and could not bet a single one of them. That was not a
// bug in the feed, the board or the engine; it was structural. A feed market
// lived only in the feed's database, `lib/match.js` resolves a selection through
// `selections → markets → events` in THIS store, and so a feed selection id
// resolved to nothing and `POST /api/orders` answered `404 Selection not found`
// before any collateral was taken. Worse, `server.js` suppressed the bots and
// the drift engine whenever the feed was on, because a bot requoting a ladder
// over the observed Betfair book would fight the venue's own price source. So
// the venue had a board full of real fixtures and no tradeable market anywhere
// in it: the bots were the only source of liquidity and they were the thing
// switched off.
//
// ── WHAT IT DOES, AND WHAT IT REFUSES TO DO ───────────────────────────────────
// It creates LOCAL rows — sports, competitions, events, markets, selections —
// for the fixtures the feed publishes, and records every id it maps in
// `feed_map` (lib/store.js). The feed supplies FIXTURES, OFF TIMES and RESULTS.
// The venue quotes its OWN prices. Four rules carry that split, and each of
// them exists because of a specific way of getting it wrong:
//
//   1. A FEED PRICE NEVER BECOMES `fair_price` OR `ltp`. docs/FEED.md names the
//      hazard exactly: "The failure mode is not a bad price; it is a good price
//      that a sharp client takes from you." `fair_price` is the VENUE's price —
//      it is what lib/bots.js quotes a ladder around and what lib/cashout.js
//      computes a buyout from. A new selection is seeded with an even
//      `FEED_BOOK_SEED_PRICE` (2.00 by default), which is a neutral starting
//      position rather than a view, and an EXISTING selection's fair_price is
//      never written at all — so a re-sync can never move the venue's own price,
//      whatever the feed says. The real launch price model is a product decision
//      the operator owns (#110/#108); this repository seeds a number and says so.
//
//   2. `starts_at` MUST PARSE, OR THE ROW IS REFUSED. lib/offtime.js treats an
//      unparseable off time as CLOSED — "a bad catalogue row must never
//      silently re-open in-play trading" — so writing a market whose off time is
//      garbage would produce a market that is permanently unbetable and
//      unsettleable, and a null one would produce a market that never closes.
//      Either way the row is refused AND REPORTED BY NAME: a refused fixture is
//      a fact an operator needs, and a silently skipped one looks exactly like
//      a feed with no fixtures.
//
//   3. `is_demo` IS NEVER SET. `events.is_demo` marks the seeded showcase book
//      and is the ONLY thing whose off time lib/seed.js rolls forward. A feed
//      event is real: rolling its off time forward to keep a stale catalogue
//      tradeable would be moving a customer's fixture, which the schema comment
//      on that column already calls "a far worse bug than a stale demo".
//
//   4. NOTHING IS EVER DELETED. A feed rotates markets away constantly, and a
//      market a player holds a position on is money. A market that leaves the
//      feed is SUSPENDED (`markets.status`), which stops new orders and leaves
//      every order, match and settlement exactly where it was.
//
// ── WHY THE IDENTITY MAP, RATHER THAN NAMES ───────────────────────────────────
// The moment the catalogue is local, there are two id spaces: the feed's
// (`'1.234567890'`, `58805`, `'10'`) and this venue's (autoincrement integers).
// The results protocol speaks integers in BOTH directions, so without a mapping
// every outcome the feed sends names selections the market does not have: the
// withdrawal path holds as `non_runner_foreign` and the outcome path takes the
// empty-winner HOLD branch — real money in a held market, withdrawn runners
// still quoted, and nothing settling. `feed_map` stores the mapping, and
// `admitSignal` below is the only place an inbound outcome is read.
//
// WHY A RUNNER'S FEED ID IS THE COMPOSITE `${market_id}:${selection_id}`.
// Betfair REUSES selection ids across markets — `58805` is "The Draw" in every
// soccer 1X2 market on the exchange. A bare selection id is therefore not an
// identity, it is a label that repeats, and keying on it merges one match's
// runners into another's. lib/feed/shape.js already keys every runner on that
// composite (`runnerFor`), so this module uses the same key rather than
// inventing a second spelling of the same fact.
//
// ── HOW THE CATALOGUE IS READ, AND WHY IT IS BOUNDED TWICE ────────────────────
// `nav()` for the hierarchy — one row per market, no runners, and crucially NOT
// capped by FEED_MARKET_LIMIT, which is why lib/config.js builds the HTTP
// provider's nav from `/catalogue` rather than from the board. Then ONE
// `market(id)` per market for its runners, through a bounded concurrency pool.
// That needs no contract change: `nav()` and `market(id)` are methods both
// providers already satisfy, and tests/feedprovider-conformance.test.js already
// proves they answer.
//
// The alternative — paging the board — cannot work, and the reason is in the
// contract's own comment: `board({limit})` is capped at FEED_MARKET_LIMIT
// (default 60) against a catalogue the docs put at 1400+ markets. Walking the
// catalogue through a cap designed to keep a page responsive would mean
// repeating the same 60 markets until a rotating feed stopped producing new
// ones — a sync that looks like it is making progress and is not.
//
// So the N+1 is real and is bounded twice on purpose: `FEED_BOOK_SYNC_LIMIT`
// markets per run (a hard cap) and `FEED_BOOK_SYNC_CONCURRENCY` concurrent
// `market()` calls (a hard cap on pressure put on a licensed feed's API). A run
// reports how much of the catalogue it saw and where the next run resumes
// (`bounded.next_offset`), which is what makes a huge catalogue resumable
// rather than merely throttled.
//
// ── IDEMPOTENCE, AND THE ONE DEACTIVATION RULE THAT NEEDS IT ─────────────────
// `feed_map` is the identity authority, so a second sync of an unchanged feed
// re-derives the same local ids and writes nothing new. `synced_at` records that
// this venue saw the row.
//
// DEACTIVATION NEEDS WHOLE-CATALOGUE KNOWLEDGE. "This market is gone" is a claim
// about the ABSENCE of a row, so a capped, resumable sync cannot make it: the
// markets past the cap are not missing, they are unread. So a truncated run
// deactivates NOTHING and says so in the report, and only a run that walked the
// whole nav tree may suspend a mapped market it did not see. Getting that
// backwards would suspend most of a venue's book on the first sync of a large
// catalogue.
//
// ── WHAT THIS MODULE KNOWS NOTHING ABOUT ─────────────────────────────────────
// Prices (it asks the provider for them unpriced and ignores them), matching,
// settlement arithmetic, and the drift engine. It writes catalogue rows and
// identity. Everything that moves money is downstream of it and unchanged by it.
const config = require('./config');
const offtime = require('./offtime');
const odds = require('./odds');
const util = require('./util');
const { transaction } = require('./tx');

// How a materialised market's `markets.status` follows the feed's own market
// status. Deliberately a SMALL vocabulary, because this is the one place a
// vendor's string becomes a venue's trading state: anything not listed as open
// suspends the market, which is the fail-closed direction — a market nobody can
// bet is a mistake somebody notices, and a market somebody can bet when it
// should not be is a loss somebody does not.
//
// A SETTLED LOCAL MARKET IS NEVER MOVED, in either direction. See writeMarket.
const OPEN_MARKET_STATUSES = new Set(['', 'OPEN', 'ACTIVE', 'IN_PLAY', 'SCHEDULED']);

// A runner the feed reports as anything other than active is suspended rather
// than deleted. `void` is a LOCAL decision — a withdrawal, a dead heat, a rule
// firing — and the feed never gets to undo one.
const ACTIVE_SELECTION_STATUSES = new Set(['', 'ACTIVE', 'OPEN']);

// ── the plan ──────────────────────────────────────────────────────────────────

/**
 * Flatten a nav tree into the markets a sync would materialise, in a STABLE
 * ORDER.
 *
 * Pure, and the only place the nav shape is read, so both the order and the
 * refusals are assertable offline. `nav()` returns
 * sport → countries[] → competitions[] → meetings[] → races[]; a feed
 * publishes one row per market, so the flattening is lossless in the fields the
 * venue needs (sport, competition, country, fixture name and time, market id,
 * name and status) and carries nothing else.
 *
 * THE ORDER IS THE ORDER nav() RETURNED, and it is load-bearing in one narrow
 * way: on a FIRST sync into an empty catalogue the local ids are handed out in
 * this order, so two syncs of the same catalogue agree. It is not sorted, and
 * deliberately so — the sync is not a board and has no reason to reorder a
 * provider's catalogue. A resumed run takes a SLICE of this list, which is only
 * meaningful because the order is stable for an unchanged catalogue; if a
 * provider reordered between runs, `next_offset` is a hint rather than a
 * guarantee, and the sync is still idempotent because `feed_map` — not the
 * offset — is what decides identity.
 */
function planFrom(nav) {
  const out = [];
  for (const sport of Array.isArray(nav) ? nav : []) {
    const sportKey = sport.sport == null ? '' : String(sport.sport);
    const sportName = sport.name || sportKey;
    for (const country of Array.isArray(sport.countries) ? sport.countries : []) {
      for (const comp of Array.isArray(country.competitions) ? country.competitions : []) {
        for (const meeting of Array.isArray(comp.meetings) ? comp.meetings : []) {
          for (const race of Array.isArray(meeting.races) ? meeting.races : []) {
            if (race.market_id === null || race.market_id === undefined || String(race.market_id).trim() === '') continue;
            out.push({
              // Both spellings are candidates for the venue slug, because a feed
              // is free to send a stable key ('horse_racing') in `sport` and a
              // display label ('Horse Racing') in `sport_name`, or the reverse.
              sport_key: sportKey,
              sport_name: String(sportName || ''),
              country: country.country == null ? null : String(country.country),
              competition: String(comp.competition == null ? '' : comp.competition),
              event_external_id: meeting.event_id == null ? null : String(meeting.event_id),
              event_name: String(meeting.event_name == null ? '' : meeting.event_name),
              event_time: meeting.event_time == null ? null : String(meeting.event_time),
              market_external_id: String(race.market_id).trim(),
              // `market_label` wins where the feed disambiguates two markets it
              // names identically (shape.js's marketLabel) — same precedence the
              // nav renderer uses, so the desk and the book agree on the name.
              market_name: String(race.market_label || race.market_name || '').trim(),
              market_time: race.market_time == null ? null : String(race.market_time),
              market_status: race.market_status == null ? null : String(race.market_status),
              in_play: !!race.in_play,
            });
          }
        }
      }
    }
  }
  return out;
}

// ── the identity map ──────────────────────────────────────────────────────────

/** The local row for one external id, or null. Never throws on a missing table. */
function lookup(db, provider, kind, externalId) {
  if (externalId === null || externalId === undefined || String(externalId).trim() === '') return null;
  const row = db
    .prepare('SELECT local_id FROM feed_map WHERE provider = ? AND kind = ? AND external_id = ?')
    .get(provider, kind, String(externalId));
  return row ? row.local_id : null;
}

/**
 * Record an external id, or refresh the timestamp on one already recorded.
 *
 * ON CONFLICT DO UPDATE rather than an insert-or-ignore, and the distinction is
 * not cosmetic: `synced_at` is the evidence that this venue still sees the
 * row, and the deactivation pass depends on it. An ignore-on-conflict map would
 * carry a `synced_at` from the first sync and nothing after it.
 */
function record(db, provider, kind, externalId, localId) {
  db.prepare(
    `INSERT INTO feed_map (provider, kind, external_id, local_id, synced_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (provider, kind, external_id)
       DO UPDATE SET local_id = excluded.local_id, synced_at = excluded.synced_at`
  ).run(provider, kind, String(externalId), localId);
}

/**
 * The feed's ids for a set of LOCAL markets — the reverse direction, for the
 * results path.
 *
 * TWO queries for the whole set, chunked to stay inside SQLite's
 * bound-parameter limit, and both `ORDER BY` the ids so the caller never has to
 * reason about row order. A per-market query here would be the N+1 that
 * lib/marketdata.js's header calls out as the thing that must not happen on a
 * read path, and this runs on EVERY poll cycle for every pending market.
 *
 * The markets and their runners are read SEPARATELY on purpose. One join would
 * have to be an INNER join (a market with no runners has no selection row to
 * inner-join to) and would therefore silently drop exactly the market whose
 * runners a sync could not write — which is a market the transport still has to
 * be able to name.
 *
 * The whole function is skipped when the map is empty, which is the state of
 * every venue that has never run a sync: the default deployment pays one
 * `SELECT 1 … LIMIT 1` per poll and no join at all.
 */
function externalRefs(db, marketIds, { provider = config.FEED_PROVIDER } = {}) {
  const ids = [...new Set((marketIds || []).map(Number).filter(Number.isInteger))];
  const out = new Map();
  if (ids.length === 0) return out;
  if (!db.prepare('SELECT 1 FROM feed_map LIMIT 1').get()) return out;

  const CHUNK = 500;
  const holes = (n) => Array.from({ length: n }, () => '?').join(',');
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const args = [provider, provider, ...slice];
    for (const r of db
      .prepare(
        `SELECT m.id AS local_market_id,
                fm.external_id AS market_external_id,
                efm.external_id AS event_external_id
           FROM markets m
           LEFT JOIN feed_map fm  ON fm.provider = ? AND fm.kind = 'market' AND fm.local_id = m.id
           LEFT JOIN feed_map efm ON efm.provider = ? AND efm.kind = 'event'  AND efm.local_id = m.event_id
          WHERE m.id IN (${holes(slice.length)})
          ORDER BY m.id`
      )
      .all(...args)) {
      out.set(r.local_market_id, {
        provider,
        market_id: r.market_external_id || null,
        event_id: r.event_external_id || null,
        selections: [],
      });
    }
    for (const r of db
      .prepare(
        `SELECT m.id AS local_market_id,
                s.id AS local_selection_id,
                sfm.external_id AS selection_external_id
           FROM selections s
           JOIN markets m ON m.id = s.market_id
           LEFT JOIN feed_map sfm ON sfm.provider = ? AND sfm.kind = 'selection' AND sfm.local_id = s.id
          WHERE m.id IN (${holes(slice.length)})
          ORDER BY m.id, s.id`
      )
      .all(provider, ...slice)) {
      const ref = out.get(r.local_market_id);
      if (ref) ref.selections.push({ local_id: r.local_selection_id, external_id: r.selection_external_id || null });
    }
  }
  // A market the feed knows about but that has no local row, or a local market
  // nobody mapped, is NOT an entry here: the map's whole job is to say which
  // local markets are the feed's, and a default entry for every market would
  // make `admitSignal` re-derive that from empty strings.
  for (const [id, ref] of [...out]) {
    if (ref.market_id === null) out.delete(id);
  }
  return out;
}

/**
 * Whether this local market was materialised from the feed.
 *
 * ONE indexed read, and it is deliberately not a cached set: a market can be
 * materialised at any moment (an admin sync) and a cached answer would be wrong
 * for the rest of the process's life.
 */
function isMaterialised(db, marketId, { provider = config.FEED_PROVIDER } = {}) {
  return !!db
    .prepare('SELECT 1 FROM feed_map WHERE provider = ? AND kind = ? AND local_id = ?')
    .get(provider, 'market', marketId);
}

/** The feed's id for a local market, or null. */
function lookupMarketExternalId(db, marketId, provider = config.FEED_PROVIDER) {
  const row = db
    .prepare('SELECT external_id FROM feed_map WHERE provider = ? AND kind = ? AND local_id = ?')
    .get(provider, 'market', marketId);
  return row ? row.external_id : null;
}

// ── id translation (the money path) ──────────────────────────────────────────

/**
 * Translate ONE inbound signal's ids into this venue's selection ids, or refuse
 * it with a named reason.
 *
 * PURE, and it takes the refs rather than the database, because the rules below
 * are where money is moved by an instruction that arrived from outside and the
 * only way to be confident about them is to be able to read them.
 *
 * ── WHY ANY OF THIS IS NEEDED ─────────────────────────────────────────────────
 * `lib/resultsfeed.js`'s `normaliseSignal` carries `winners` and `non_runners`
 * as INTEGERS, and `lib/results.js` filters them against the LOCAL selection
 * ids of the market. Before materialisation those were the same number space, so
 * the filter worked. The moment a market is materialised they are not: the
 * feed's runner ids are Betfair's, this venue's are autoincrement, and every
 * outcome arrives naming selections the market does not have. The consequence is
 * fail-safe and operationally fatal at the same time — `applyWithdrawal` returns
 * `hold('non_runner_foreign')` and `applyOutcome` takes the empty-winner HOLD
 * branch, so nothing settles and a withdrawn runner stays quoted while players
 * hold real positions in a market the venue has parked.
 *
 * ── THE THREE ID SPACES A RAW ID CAN BE IN ───────────────────────────────────
 *   1. THE FEED'S, within THIS market. `${feedMarketId}:${selectionId}` is the
 *      key `feed_map` stores (see the header on composite runner keys), so a
 *      provider sending its own selection id — which is what a results API
 *      actually does — is recognised by rebuilding the composite from the
 *      market it named. The bare composite is accepted too, for a provider that
 *      echoes back what we sent it.
 *   2. THIS VENUE'S. `lib/resultsfeed.js` sends local ids BESIDE the feed's, so
 *      an operator's API may legitimately answer in either space, and an answer
 *      in this space is only accepted when the id is a selection OF THIS MARKET.
 *   3. NEITHER. Refused.
 *
 * ── AND THE CASE THAT MUST NOT BE GUESSED ─────────────────────────────────────
 * An id that resolves in BOTH spaces to DIFFERENT local selections of the same
 * market is not translated at all. It is HELD as `id_space_ambiguous`. This is
 * not a theoretical branch: local ids are small integers assigned in insert
 * order and a feed's runner ids are small integers too, so a materialised
 * market whose first runner is local id 2 and whose feed names runner 2 for a
 * different runner is an ordinary coincidence, and picking either one settles
 * somebody's money on a coin flip. The alternative — prefer the feed — is
 * exactly the guess the hold exists to prevent.
 *
 * THE ID SPACE IS RECORDED, in the returned object and (by lib/results.js) in
 * the provenance row. "Which space did this feed use" is the first question an
 * operator asks when an outcome looks wrong, and it is unanswerable unless
 * something wrote it down at the moment the signal was admitted.
 *
 * The ids this reads are the ones `normaliseSignal` produced: positive INTEGERS,
 * or nothing. A string, a float or a boolean never matches either space and is
 * therefore refused rather than coerced — the same rule `lib/voidrules.js`
 * applies to a coerced withdrawal id, for the same reason.
 *
 * A signal that carries NO ids at all (`{"status": "abandoned"}`) is reported as
 * `id_space: "feed"`. It named no runner, so it was not read in either space —
 * but it is an outcome about the feed's market, and that is what the recorded
 * source id has to be either way.
 */
function admitSignal(refs, signal) {
  if (!signal || typeof signal !== 'object') return { ok: false, rule: 'signal_absent', reason: 'no signal to admit' };
  // NOT MATERIALISED: nothing to translate. The venue's own markets keep
  // speaking their own id space, which is what every existing caller and every
  // existing test passes, and which is why this function is a no-op rather than
  // a rewrite for a venue that never runs a sync.
  if (!refs) {
    return { ok: true, signal, id_space: null, external_id: null, refs: null };
  }

  const feedSpace = new Map();
  const localSpace = new Map();
  for (const sel of refs.selections || []) {
    if (sel.external_id) {
      feedSpace.set(String(sel.external_id), sel.local_id);
      // The bare selection id, scoped to THIS market. `split(':').pop()` is the
      // runner part of the composite, and it is only ever matched against this
      // market's own map — never a global one — because the whole reason the
      // composite exists is that the bare id is not an identity.
      const bare = String(sel.external_id).split(':').pop();
      if (bare !== '' && !feedSpace.has(bare)) feedSpace.set(bare, sel.local_id);
    }
    if (!localSpace.has(sel.local_id)) localSpace.set(sel.local_id, sel.local_id);
  }

  let usedFeed = false;
  let usedLocal = false;
  const mapOne = (raw) => {
    const key = String(raw);
    const viaFeed = feedSpace.has(key) ? feedSpace.get(key) : undefined;
    const viaLocal = localSpace.has(raw) ? localSpace.get(raw) : undefined;
    if (viaFeed !== undefined && viaLocal !== undefined && viaFeed !== viaLocal) {
      return { error: { rule: 'id_space_ambiguous', raw, feed: viaFeed, local: viaLocal } };
    }
    if (viaFeed !== undefined) { usedFeed = true; return { id: viaFeed }; }
    if (viaLocal !== undefined) { usedLocal = true; return { id: viaLocal }; }
    return { error: { rule: 'id_space_unmapped', raw } };
  };

  const out = { ...signal };
  for (const field of ['winners', 'non_runners']) {
    if (!Array.isArray(signal[field])) continue;
    const mapped = [];
    for (const raw of signal[field]) {
      const r = mapOne(raw);
      if (r.error) return { ok: false, rule: r.error.rule, raw: r.error.raw, detail: r.error, refs };
      // De-duplicated HERE rather than downstream: two feed ids that map to one
      // local selection would otherwise become a two-element winner list, and
      // lib/settle.js settles a dead heat from a list's LENGTH.
      if (!mapped.includes(r.id)) mapped.push(r.id);
    }
    out[field] = mapped;
  }

  // A materialised market's provenance id is the FEED'S id for it, whatever
  // space the runner ids inside the signal used: the outcome is about the
  // feed's market, and that is the id a re-delivery repeats.
  //
  // THE MARKET'S FEED ID, NOT THE EVENT'S, and the reason is a live hazard
  // rather than a preference. `result_events` carries a UNIQUE index on
  // (source, source_event_id), and `alreadyApplied` consults it: one feed EVENT
  // — one fixture, one meeting — has MANY markets in it (a Win market and a To
  // Be Placed market are the same race), and a pre-off withdrawal is checked
  // against that index BEFORE it acts. Recording the event id would therefore
  // make the SECOND market's withdrawal read as a re-delivery of the first and
  // return `already_applied` with the runner still quoted and its backers still
  // charged. The market id is strictly finer-grained, so it can never
  // under-detect a genuine re-delivery of the same market, which is the only
  // thing the guard is for. The feed's EVENT id is carried alongside it in the
  // provenance payload so an operator reading the log still has it.
  return {
    ok: true,
    signal: out,
    id_space: usedLocal && !usedFeed ? 'local' : 'feed',
    external_id: refs.market_id,
    event_id: refs.event_id,
    provider: refs.provider,
    refs,
  };
}

// ── the slug rule ─────────────────────────────────────────────────────────────

/**
 * The venue slug for a feed sport, and why it is not server.js's `slugify`.
 *
 * `slugify` (lib/util.js) maps every run of non-alphanumerics to a hyphen, so
 * 'horse_racing' — Betfair's own sport key, and the key lib/voidrules.js
 * publishes its racing rules under — becomes 'horse-racing'. That is a
 * SETTLEMENT defect, not a cosmetic one: `rules.resolve` on an unknown sport
 * falls through to DEFAULT_RULE, which is VOID, so every horse race the venue
 * materialised would be refunded to nobody and paid to nobody. lib/seed.js
 * already says its own slug "must match the `horse_racing` key in
 * lib/voidrules.js" for the same reason.
 *
 * So underscores survive here, and the candidate is then resolved against the
 * venue's OWN catalogue before anything is inserted: a sport the venue already
 * has — under the feed's spelling, the feed's display name, or the same slug
 * with hyphens and underscores folded together — wins. That is what makes "two
 * feeds spelling one sport differently must not create two sports" a property
 * of the code rather than a hope about spelling, and it means a feed's
 * `soccer` lands beside a venue that already calls it `football` only when
 * nothing better exists — the two are genuinely different words and pretending
 * otherwise is an operator's mapping decision, not this module's.
 */
function normaliseSlug(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function foldSlug(slug) {
  return String(slug).replace(/-/g, '_');
}

function resolveSport(db, candidates, name) {
  const seen = [];
  for (const c of candidates) {
    const slug = normaliseSlug(c);
    if (!slug || seen.includes(slug)) continue;
    seen.push(slug);
  }
  if (!seen.length) return null;
  // An EXISTING venue sport wins over inserting a new one, under any of the
  // spellings. `sports.slug` is UNIQUE, so this lookup is also what stops a
  // second sync of a renamed fixture from raising a constraint failure.
  for (const slug of seen) {
    const row = db.prepare('SELECT * FROM sports WHERE slug = ?').get(slug);
    if (row) return { id: row.id, name: row.name, slug, created: false };
  }
  for (const slug of seen) {
    const folded = foldSlug(slug);
    const row = db
      .prepare('SELECT * FROM sports WHERE slug = ? OR slug = ? LIMIT 1')
      .get(folded, folded.replace(/_/g, '-'));
    if (row) return { id: row.id, name: row.name, slug: row.slug, created: false };
  }
  const slug = seen[0];
  db.prepare('INSERT INTO sports (name, slug) VALUES (?, ?)').run(String(name || slug), slug);
  return { id: db.prepare('SELECT id FROM sports WHERE slug = ?').get(slug).id, name: String(name || slug), slug, created: true };
}

// ── writing one market ────────────────────────────────────────────────────────

/** `YYYY-MM-DD HH:MM:SS` in UTC, from an instant lib/offtime.js has parsed. */
function sqlUtc(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * The market's local status, given what the feed says and what the venue has.
 *
 * `settled` is TERMINAL and is never left: a market the venue has settled is a
 * market the operator has paid out, and no catalogue update may reopen it.
 * `settlement_hold` is likewise never cleared here — releasing a hold is a
 * human decision with a written reason (lib/results.js `releaseHold`).
 */
function localMarketStatus(current, feedStatus) {
  if (current === 'settled') return 'settled';
  const open = OPEN_MARKET_STATUSES.has(String(feedStatus == null ? '' : feedStatus).toUpperCase());
  return open ? 'open' : 'suspended';
}

/**
 * Write ONE market and its runners, inside the caller's transaction.
 *
 * Every id is resolved through `feed_map` FIRST and the local row second, and
 * that order is what makes a second sync a no-op rather than a duplicate: the
 * map is the identity, and the row is looked up by the id the map already
 * holds. A mapped row that has since been deleted by an operator is re-created
 * (with a new local id, because the old one is genuinely gone) and reported,
 * because silently re-pointing the map at a different row is the sort of thing
 * that should be visible in the sync report.
 *
 * WHAT IS NEVER WRITTEN HERE, and each omission is a rule in the header:
 *   - `selections.fair_price` on an EXISTING row (a re-sync may not move the
 *     venue's own price), and only ever the seeded even price on a NEW one;
 *   - `selections.ltp`, ever — it is the venue's own last traded price, written
 *     by the matching engine on a fill;
 *   - `events.is_demo`, ever;
 *   - `orders`, `matches`, `settlements`, `transactions`, `selections.status`
 *     where it is `void` — a void is a local decision.
 */
function writeMarket(db, ctx, entry, market, nowMs) {
  const provider = ctx.provider;
  const stats = ctx.counts;

  // ── the two refusals that cost a market its whole row ─────────────────────
  // BOTH ARE CHECKED BEFORE ANY WRITE, because a half-written fixture — a sport
  // and a competition with no event, or an event with no market — is a row
  // nothing can reach and nothing will ever clean up. A refusal is reported by
  // name so an operator can see the fixture the venue could not take.
  if (entry.event_external_id === null || String(entry.event_external_id).trim() === '') {
    ctx.refuse('market', entry.market_name, entry.market_external_id, 'no_event_id',
      'the feed published this market with no fixture id, and without one the results path cannot name it');
    return { skipped: true };
  }
  const offMs = offtime.offTimeMs(entry.event_time);
  if (offMs === null) {
    ctx.refuse('event', `${entry.event_name || '(unnamed fixture)'}`, entry.event_external_id, 'unparseable_off_time',
      `the feed's off time (${JSON.stringify(entry.event_time)}) is not a timestamp lib/offtime.js can read, and an unreadable off time is CLOSED — so its markets would be permanently unbetable`);
    return { skipped: true };
  }
  if (offMs <= nowMs) {
    ctx.refuse('event', `${entry.event_name || '(unnamed fixture)'}`, entry.event_external_id, 'off_time_past',
      `the fixture is already off (${sqlUtc(offMs)}); a finished fixture is not a market the venue can open`);
    return { skipped: true };
  }

  const sport = resolveSport(db, [entry.sport_key, entry.sport_name], entry.sport_name || entry.sport_key);
  if (!sport) {
    ctx.refuse('market', entry.market_name, entry.market_external_id, 'no_sport',
      'the feed named no sport for this market');
    return { skipped: true };
  }
  if (sport.created) stats.sports_created += 1;

  // competition — identified by (sport, name), because `feed_map`'s closed
  // vocabulary is event/market/selection: a competition is a display label, and
  // two feeds spelling one differently is a cosmetic duplicate in a filter
  // rather than a second book.
  let competitionId = null;
  const compName = entry.competition.trim();
  if (compName) {
    const existing = db
      .prepare('SELECT id FROM competitions WHERE sport_id = ? AND name = ?')
      .get(sport.id, compName);
    if (existing) competitionId = existing.id;
    else {
      db.prepare('INSERT INTO competitions (sport_id, name, country) VALUES (?, ?, ?)').run(sport.id, compName, entry.country);
      competitionId = db.prepare('SELECT id FROM competitions WHERE sport_id = ? AND name = ?').get(sport.id, compName).id;
      stats.competitions_created += 1;
    }
  }

  // ── event row ─────────────────────────────────────────────────────────────
  let eventId = lookup(db, provider, 'event', entry.event_external_id);
  let event = eventId === null ? null : db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (eventId !== null && !event) {
    ctx.note('recreated', `event ${entry.event_external_id}: the mapped local event no longer exists`);
    eventId = null;
    event = null;
  }
  const startsAt = sqlUtc(offMs);
  if (event === null) {
    // NEVER is_demo. See the header: that column marks the seeded showcase book,
    // and it is the only thing whose off time is ever rolled forward.
    const info = db
      .prepare('INSERT INTO events (sport_id, competition_id, name, starts_at, tenant_id) VALUES (?, ?, ?, ?, ?)')
      .run(sport.id, competitionId, entry.event_name || compName || entry.market_name || 'Event', startsAt, ctx.tenantId);
    eventId = Number(info.lastInsertRowid);
    stats.events_created += 1;
  } else {
    // THE OFF TIME IS THE FEED'S TO MOVE, WITH ONE FAIL-SAFE DIRECTION.
    // A fixture that has not gone off yet may be rescheduled either way: that
    // is a real-world reschedule and the venue's gate follows it. A fixture
    // that IS already off may only move EARLIER. Moving it later would re-open
    // betting on something that has already started, which is precisely the
    // hazard lib/offtime.js's fail-closed rule exists to prevent — and the
    // venue would do it because a catalogue said so.
    const currentOff = offtime.offTimeMs(event.starts_at);
    const alreadyOff = currentOff === null || currentOff <= nowMs;
    if (!alreadyOff || offMs < currentOff) {
      db.prepare('UPDATE events SET starts_at = ?, competition_id = COALESCE(?, competition_id), name = ? WHERE id = ?')
        .run(startsAt, competitionId, entry.event_name || event.name, eventId);
    } else if (startsAt !== event.starts_at) {
      ctx.note('off_time_pinned', `event ${entry.event_name}: already off at ${event.starts_at}, the feed now says ${startsAt} — not moved later`);
    }
  }
  record(db, provider, 'event', entry.event_external_id, eventId);

  // ── market ────────────────────────────────────────────────────────────────
  const marketName = market.market_name || entry.market_name || 'Market';
  let marketId = lookup(db, provider, 'market', entry.market_external_id);
  let row = marketId === null ? null : db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (marketId !== null && !row) {
    ctx.note('recreated', `market ${entry.market_external_id}: the mapped local market no longer exists`);
    marketId = null;
    row = null;
  }
  const wanted = localMarketStatus(row ? row.status : null, entry.market_status ?? market.status);
  if (row === null) {
    // payout_shape stays 'win' and is never inferred from the feed's market
    // type. #95 is the issue that models other shapes: this engine has one
    // payout, and a venue that materialises a market the engine cannot settle
    // correctly gets an explicit, audited HOLD rather than a plausible wrong
    // number. Declaring it 'place' here would buy that refusal and no book.
    const info = db
      .prepare('INSERT INTO markets (event_id, name, payout_shape, status, tenant_id) VALUES (?, ?, ?, ?, ?)')
      .run(eventId, marketName, 'win', wanted, ctx.tenantId);
    marketId = Number(info.lastInsertRowid);
    stats.markets_created += 1;
  } else {
    if (row.name !== marketName) db.prepare('UPDATE markets SET name = ? WHERE id = ?').run(marketName, marketId);
    // `inplay` comes from the feed because it is a fact about the fixture, and
    // it is the one column here that selects a trading REGIME rather than a
    // display value — lib/inplay.js's delay applies to it. A pre-off venue never
    // receives orders on an in-play market anyway (lib/offtime.js refuses them),
    // so this records the truth without changing what the venue will accept.
    db.prepare('UPDATE markets SET status = ?, inplay = ? WHERE id = ?')
      .run(wanted, entry.in_play ? 1 : 0, marketId);
  }
  record(db, provider, 'market', entry.market_external_id, marketId);

  // ── runners ───────────────────────────────────────────────────────────────
  for (const sel of market.selections || []) {
    const externalSelection = sel.selection_id == null ? null : String(sel.selection_id).trim();
    if (!externalSelection) {
      ctx.refuse('selection', sel.name || '(unnamed runner)', `${entry.market_external_id}:?`, 'no_selection_id',
        'a runner with no feed id cannot be identified across syncs, so it is not written');
      continue;
    }
    const composite = `${entry.market_external_id}:${externalSelection}`;
    const name = String(sel.name == null ? externalSelection : sel.name).trim() || externalSelection;
    let selectionId = lookup(db, provider, 'selection', composite);
    let srow = selectionId === null ? null : db.prepare('SELECT * FROM selections WHERE id = ?').get(selectionId);
    if (selectionId !== null && !srow) {
      ctx.note('recreated', `selection ${composite}: the mapped local selection no longer exists`);
      selectionId = null;
      srow = null;
    }
    if (srow === null) {
      // THE SEED PRICE. Even money, the venue's own neutral starting position,
      // and the ONLY number from config that reaches a price column in this
      // module. See rule 1 in the header: `fair_price` is the venue's price.
      const info = db
        .prepare('INSERT INTO selections (market_id, name, fair_price, tenant_id) VALUES (?, ?, ?, ?)')
        .run(marketId, name, odds.snapToTick(config.FEED_BOOK_SEED_PRICE), ctx.tenantId);
      selectionId = Number(info.lastInsertRowid);
      stats.selections_created += 1;
    } else {
      // Name only. fair_price and ltp are deliberately absent from this
      // statement, and that absence is the rule: a re-sync may rename a runner
      // but must never re-price it.
      if (srow.name !== name) db.prepare('UPDATE selections SET name = ? WHERE id = ?').run(name, selectionId);
      const active = ACTIVE_SELECTION_STATUSES.has(String(sel.status == null ? '' : sel.status).toUpperCase());
      // open → suspended only. A 'void' selection is never resurrected, and a
      // suspended one is never silently reopened: the feed withdrawing a runner
      // is a fact, and the venue deciding to accept it again is a decision
      // somebody has to make deliberately.
      if (srow.status === 'open' && !active) {
        db.prepare('UPDATE selections SET status = ? WHERE id = ?').run('suspended', selectionId);
      }
    }
    record(db, provider, 'selection', composite, selectionId);
  }
  return { market_id: marketId };
}

// ── the sync ──────────────────────────────────────────────────────────────────

/**
 * Run `worker` over `items` with at most `limit` in flight, IN ORDER of start.
 *
 * The bound is on CONCURRENCY because that is what puts pressure on somebody
 * else's licensed API, and on ORDER because two syncs of the same catalogue
 * must reach the same rows in the same sequence — the first sync of an empty
 * catalogue hands out local ids in this order.
 *
 * One item's failure must not end the pool: `worker` is expected to catch its
 * own errors (writeMarket's caller does), and this function exists to bound
 * work, not to decide what a failure means.
 */
async function eachLimited(items, limit, worker) {
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

/**
 * Materialise the feed's catalogue into local rows.
 *
 * Returns a REPORT rather than a boolean, and the report is the operator's
 * only evidence that the sync did what it was asked: what it saw, what it wrote,
 * what it REFUSED AND WHY, what it deactivated, and — the number a large
 * catalogue makes essential — how much of the catalogue it did not read and
 * where to resume.
 *
 * `opts`:
 *   provider      a provider object; defaults to the configured one
 *   tenantId      stamped on every row this run creates
 *   limit         markets to materialise, capped at FEED_BOOK_SYNC_LIMIT
 *   offset        where in the catalogue to start, for a resumed run
 *   concurrency   simultaneous `market()` calls, capped at
 *                 FEED_BOOK_SYNC_CONCURRENCY
 *   nowMs         the clock, injectable so the off-time rules are testable
 */
async function sync(db, opts = {}) {
  const provider = opts.provider || require('./feed/provider').current();
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const hardLimit = config.FEED_BOOK_SYNC_LIMIT;
  const asked = Number(opts.limit);
  // `boardLimit`'s rule rather than a bare `Number()`: a blank, a zero and a
  // negative are all absent intent, not a request for no markets, and
  // `Number('') === 0` would otherwise silently sync nothing.
  const limit = Math.max(1, Math.min(Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : hardLimit, hardLimit));
  const concurrencyCap = config.FEED_BOOK_SYNC_CONCURRENCY;
  const askedConcurrency = Number(opts.concurrency);
  const concurrency = Math.max(1, Math.min(Number.isFinite(askedConcurrency) && askedConcurrency >= 1 ? Math.floor(askedConcurrency) : concurrencyCap, concurrencyCap));
  const offset = Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0;

  const counts = {
    sports_created: 0,
    competitions_created: 0,
    events_created: 0,
    markets_created: 0,
    selections_created: 0,
  };
  const refused = [];
  const notes = [];
  const seenExternals = new Set();
  const ctx = {
    provider: provider.name,
    tenantId: opts.tenantId === undefined ? null : opts.tenantId,
    counts,
    refuse(scope, name, externalId, reason, detail) {
      refused.push({ scope, name, external_id: externalId, reason, detail });
    },
    note(kind, detail) {
      notes.push({ kind, detail });
    },
  };

  // nav() is the CATALOGUE and not the board: board() is capped at
  // FEED_MARKET_LIMIT markets, and a catalogue read through a cap cannot be
  // walked (lib/config.js says so about the HTTP provider's /catalogue for the
  // same reason). One call, and the whole tree.
  const nav = await provider.nav();
  const catalogue = planFrom(nav);
  const window = catalogue.slice(offset, offset + limit);
  const remaining = Math.max(0, catalogue.length - offset - window.length);

  let materialised = 0;
  let failed = 0;
  await eachLimited(window, concurrency, async (entry) => {
    // ONE market read per planned market, and asked for UNPRICED. The ladders
    // are never read on this path — rule 1 in the header — so fetching them
    // would be megabytes of JSON a licensed feed's API is asked to serve for no
    // reason at all.
    let market = null;
    try {
      market = await provider.market(entry.market_external_id, { priced: false });
    } catch (e) {
      failed += 1;
      ctx.refuse('market', entry.market_name, entry.market_external_id, 'market_read_failed', String(e && e.message ? e.message : e).slice(0, 200));
      return;
    }
    if (!market) {
      // The feed rotates markets away between the catalogue read and this one.
      // That is an ordinary outcome, not an error: the race closed in the
      // seconds between two calls, and it is reported rather than written.
      ctx.refuse('market', entry.market_name, entry.market_external_id, 'vanished', 'the feed no longer publishes this market');
      return;
    }
    const runners = Array.isArray(market.selections) ? market.selections : [];
    if (runners.length === 0) {
      ctx.refuse('market', entry.market_name, entry.market_external_id, 'no_runners', 'the feed published this market with no runners, so there is nothing to bet');
      return;
    }
    seenExternals.add(entry.market_external_id);
    try {
      // One transaction PER MARKET. Not one for the sync: the sync awaits a
      // licensed API between markets, and holding SQLite's single write lock
      // across network calls would block every other writer in the venue for
      // the length of a feed round trip. A sync is idempotent and resumable, so
      // a partial run is a partial run the next one completes — which is a
      // better failure mode than one long transaction that rolls back an hour
      // of work because market 140 threw.
      const out = transaction(db, () => writeMarket(db, ctx, entry, market, nowMs));
      if (out && !out.skipped) materialised += 1;
    } catch (e) {
      failed += 1;
      ctx.refuse('market', entry.market_name, entry.market_external_id, 'write_failed', String(e && e.message ? e.message : e).slice(0, 200));
    }
  });

  // ── deactivation, ONLY from a whole-catalogue view ─────────────────────────
  let deactivated = [];
  let leftTheFeedAlreadyOff = [];
  let deactivationSkipped = null;
  if (remaining > 0) {
    deactivationSkipped = 'bounded';
    notes.push({
      kind: 'deactivation_skipped',
      detail: `this run read ${window.length} of ${catalogue.length - offset} markets from offset ${offset}; ` +
        'a capped run cannot tell a market that left the feed from one it did not read',
    });
  } else {
    // `ctx.provider` — the provider's NAME, not the object. The name is what
    // `feed_map` is keyed by, and passing the object would bind its properties
    // as named parameters.
    const gone = deactivateAbsent(db, ctx.provider, seenExternals, nowMs);
    deactivated = gone.suspended;
    leftTheFeedAlreadyOff = gone.alreadyOff;
    if (leftTheFeedAlreadyOff.length) {
      notes.push({
        kind: 'left_feed_after_off',
        detail: `${leftTheFeedAlreadyOff.length} mapped market(s) left the feed AFTER going off and were left open on purpose: ` +
          'suspending one would stop it being settled, and lib/offtime.js already refuses an order on it',
      });
    }
  }

  return {
    provider: ctx.provider,
    started_at: new Date(nowMs).toISOString(),
    seed_price: config.FEED_BOOK_SEED_PRICE,
    catalogue: {
      markets: catalogue.length,
      events: new Set(catalogue.map((e) => e.event_external_id)).size,
      considered: window.length,
    },
    materialised,
    created: { ...counts },
    failed,
    deactivated,
    left_the_feed_already_off: leftTheFeedAlreadyOff,
    deactivation_skipped: deactivationSkipped,
    refused,
    notes,
    bounded: {
      limit,
      offset,
      remaining,
      concurrency,
      truncated: remaining > 0,
      // WHERE THE NEXT RUN RESUMES. `remaining` rather than a cursor: the plan
      // is derived from the provider's catalogue rather than from a stored
      // position, so the resume point is "past what this run read" and a run
      // that starts at 0 after a full pass is simply a fresh, idempotent pass.
      next_offset: offset + window.length,
    },
  };
}

/**
 * Suspend mapped markets the feed no longer publishes. NEVER deletes, and never
 * touches `settlement_hold`, a settled market, or a market that has already gone
 * off.
 *
 * The set is built from `feed_map` rather than from the local catalogue, so a
 * market whose LOCAL row is missing (an operator deleted it) is not resurrected
 * by a sync, and a market that is `settled` or held is left exactly as it is.
 *
 * ── WHY "ALREADY OFF" IS EXEMPT, AND IT IS THE WHOLE POINT ───────────────────
 * Suspension's only effect on a market that has NOT gone off is to stop new
 * orders — which is exactly what a market the feed has dropped needs. Its effect
 * on a market that HAS gone off is to stop it being SETTLED: `pendingMarkets`
 * asks about open markets only, so a suspended finished race can never receive
 * the outcome that pays its backers, and the venue sits on a position nobody can
 * close. A feed that drops a market as soon as it goes off is the ORDINARY case,
 * not an edge — which means exempting the off market is what keeps the results
 * path working at all rather than an optimisation.
 *
 * And nothing is lost by the exemption: lib/offtime.js already refuses an order
 * on an off event, fail-closed, so an off market cannot be bet whether or not
 * this function touches it.
 */
function deactivateAbsent(db, provider, seenExternals, nowMs) {
  const rows = db
    .prepare(
      `SELECT fm.local_id, fm.external_id, m.status, e.starts_at
         FROM feed_map fm
         JOIN markets m ON m.id = fm.local_id
         JOIN events e ON e.id = m.event_id
        WHERE fm.provider = ? AND fm.kind = 'market'`
    )
    .all(provider);
  const suspended = [];
  const alreadyOff = [];
  for (const r of rows) {
    if (seenExternals.has(r.external_id)) continue;
    // Already suspended, already settled, or held for a human: leave it. A hold
    // is a reason somebody wrote down, and a catalogue sweep is not a reason to
    // clear one.
    if (r.status === 'settled' || r.status === 'suspended') continue;
    const off = offtime.offTimeMs(r.starts_at);
    if (off === null || off <= nowMs) {
      alreadyOff.push({ market_id: r.local_id, external_id: r.external_id });
      continue;
    }
    db.prepare('UPDATE markets SET status = ? WHERE id = ?').run('suspended', r.local_id);
    suspended.push({ market_id: r.local_id, external_id: r.external_id });
  }
  return { suspended, alreadyOff };
}

module.exports = {
  sync,
  planFrom,
  externalRefs,
  admitSignal,
  lookup,
  lookupMarketExternalId,
  record,
  isMaterialised,
  normaliseSlug,
  eachLimited,
};