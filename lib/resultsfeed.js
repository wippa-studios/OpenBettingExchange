'use strict';
// lib/resultsfeed.js — the results-feed TRANSPORT.
//
// WHY THIS EXISTS. lib/results.js has always had a complete consumer: void
// rules per sport, disputes held rather than guessed, provenance for every
// outcome, and a manual release path. It had no transport — and the scheduled
// poll was never wired at all, so RESULTS_POLL_INTERVAL_MS was a documented
// knob that no job read. Outcomes arrived only when an operator pushed them by
// hand. On a venue running three sports that is not a gap, it is the whole
// settlement process.
//
// THE FEED IS A SIGNAL, NOT AN AUTHORITY. This module parses a response and
// nothing more: it never decides an outcome, never picks a winner, never
// settles. That is lib/results.js's job and it is strict there — a winner
// outside the market is HELD, an unrecognised signal is HELD, a disputed one
// outranks every published rule. A feed that says "Red won" for a market whose
// selections are called something else does not get to settle it. The
// transport's job is to be a good pipe and a bad liar.
//
// WHY THE POLL SET IS ASKED-FOR, NOT ASSUMED. A results service that has to
// page through the venue's entire market catalogue every minute is a service
// that will time out, and a timeout that looks like "no results" is
// indistinguishable from a quiet night. So the pending set is computed with
// the SAME query the consumer uses (results.pendingMarkets) and POSTed, so the
// feed is asked for precisely what will be consumed.
//
// FAILING SOFT IS THE POINT. Every failure mode here — DNS, TLS, timeout,
// non-2xx, unparseable body, oversized body — records a reason and returns an
// empty outcome set. It does NOT throw into the job runner and it does NOT
// settle anything. A results feed outage must not be able to take down a venue
// that is happily trading the next race, and the failure must be VISIBLE,
// because a feed that silently stops is indistinguishable from a feed that has
// nothing to say — and the difference is players' money sitting unsettled.
//
// STALENESS IS THE OPERATOR'S ALARM. `state()` reports when the feed last
// succeeded, so a venue whose feed died at 3am can be paged rather than
// discovered at settlement time. This is the inverse of the dead controls in
// this codebase's history: those reported and did not enforce; this one fetches
// and reports whether it is working.

const config = require('./config');

/**
 * Mutable transport state. Kept on ONE object and shared by reference, never
 * exported by value — the convention in this codebase, because exporting a
 * snapshot of the numbers is how two callers end up disagreeing about whether
 * the feed is up.
 */
const state = {
  // The transport's own notion of where it points, which is NOT always
  // config.RESULTS_FEED_URL: a caller may pass an explicit URL (tests today,
  // a second transport tomorrow). health() reported "not_configured" while a
  // perfectly good URL was in use, which would tell an operator their feed is
  // off when it is on.
  target: null,
  last_poll_at: null,
  last_ok_at: null,
  last_error: null,
  consecutive_failures: 0,
  polls: 0,
  ok_polls: 0,
  signals_received: 0,
  // Entries the provider sent that named no usable market id. Zero on a healthy
  // integration, and the only difference between a feed that agrees with us
  // entirely and one that has quietly started describing itself differently.
  dropped_entries: 0,
  // What the LAST poll dropped. A running total can be a healthy provider that
  // mis-sent one entry an hour ago; a non-zero number on every poll is a
  // contract change, and this is where that shows up.
  last_dropped: 0,
  // THE BACKLOG, which is the one number that separates "the feed is fine and
  // nothing has finished" from "the feed is fine and four hundred markets are
  // stuck". Everything else on this object describes the TRANSPORT; these two
  // describe the VENUE's problem — and a transport reporting perfectly while the
  // settlement queue grows without bound is the failure #60 describes from the
  // other end.
  pending_last_poll: 0,
  pending_peak: 0,
  // ── THE PUSH TRANSPORT (POST /api/results/webhook) ─────────────────────────
  //
  // Deliberately on the SAME object rather than on a second one. lib/ops.js's
  // readiness reads `health()` to answer "are outcomes arriving?", and an
  // operator reading `/api/admin/results/feed` reads one page. Splitting the
  // transport's state in two would mean the answer to that question lives in
  // two places and one of them can be stale about the other — which is the
  // failure this module's own header describes when a feed "silently stops" and
  // is indistinguishable from one that has nothing to say.
  //
  // The same failure has a second form here: a venue whose feed is configured to
  // PUSH has no poll at all, so `polls: 0` and `last_ok_at: null` are the
  // HEALTHIEST possible readings of the poll half. Read without the webhook
  // block beside it they say "configured and failing", and an operator pages
  // someone for a feed that is answering perfectly.
  webhook_configured: false,
  webhook_deliveries: 0,
  webhook_outcomes: 0,
  webhook_held: 0,
  webhook_refused: 0,
  webhook_last_at: null,
  webhook_last_error: null,
  webhook_consecutive_failures: 0,
};

/**
 * How many markets go in one request.
 *
 * The poll set is UNCAPPED on purpose — see the note on `createFetcher` — so this
 * is where the bound is applied: on the WIRE, not on the set. Every pending
 * market is asked about, across as many requests as it takes, and a provider is
 * never asked to read a body larger than it can answer in one round trip.
 */
const RESULTS_BATCH_SIZE = 250;

/** Exposed for tests and for the admin endpoint. Never mutated by callers. */
function stateSnapshot() {
  return { ...state };
}

/** Test seam: reset the counters without reloading the module. */
function resetState() {
  Object.assign(state, {
    target: null,
    last_poll_at: null,
    last_ok_at: null,
    last_error: null,
    consecutive_failures: 0,
    polls: 0,
    ok_polls: 0,
    signals_received: 0,
    dropped_entries: 0,
    last_dropped: 0,
    pending_last_poll: 0,
    pending_peak: 0,
    webhook_configured: false,
    webhook_deliveries: 0,
    webhook_outcomes: 0,
    webhook_held: 0,
    webhook_refused: 0,
    webhook_last_at: null,
    webhook_last_error: null,
    webhook_consecutive_failures: 0,
  });
}

/** Raised for every failure, so the job logs one clear line instead of a stack. */
class FeedError extends Error {
  constructor(reason, detail) {
    super(`results feed: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'FeedError';
    this.reason = reason;
    this.detail = detail || null;
  }
}

/**
 * The booleans a provider may state, and what each one means to the rules.
 *
 * SPLIT IN TWO, AND THE SPLIT IS THE FIX.
 *
 * Three of these are REDUNDANT SPELLINGS of `status` — a provider saying
 * `completed: true` and a provider saying `status: 'completed'` are describing
 * the same event, and lib/voidrules.js `ruleKey` reads only `status`. They were
 * carried through normalisation, arrived unchanged, matched no rule, and the
 * market was HELD as `unrecognised`. Concretely: a feed that said "completed,
 * winner 3" produced a hold whose recorded reason blamed the provider for a
 * payload this function had already declared valid, and no operator action
 * would ever clear it. Normalising the spelling is not a new behaviour — it is
 * the behaviour the transport already gave the long form.
 *
 * The risk that creates is bounded, and it is worth stating rather than waving
 * away: `{"abandoned": true}` alone can now VOID a greyhound market, where
 * before it was discarded. That is the same exposure `status: 'abandoned'`
 * has always carried, and `pendingMarkets` only ever asks about markets whose
 * event is OFF — so an abandonment claim can only arrive for a market the venue
 * has already stopped trading. The alternative is money that never settles.
 *
 * `disputed` is NOT a status and is deliberately not mapped to one. It is a
 * claim that the outcome is contested, and `resolve` checks it AHEAD of every
 * published rule precisely so no table can quietly settle a disputed event. It
 * counts as content for that reason: a lone `{"disputed": true}` is the one
 * word a provider can send that the venue must never resolve itself.
 *
 * `red_card` and `dead_heat` are MODIFIERS, not outcomes: `ruleKey` reads them
 * alongside `status`, and neither is ever mapped to one.
 */
const STATUS_SPELLINGS = { completed: 'completed', abandoned: 'abandoned', walkover: 'walkover' };
const MODIFIER_FLAGS = ['dead_heat', 'red_card', 'disputed'];
const SIGNAL_FLAGS = Object.freeze([...MODIFIER_FLAGS, ...Object.keys(STATUS_SPELLINGS)]);

/**
 * Coerce one raw feed entry into the signal shape `applyOutcome` consumes.
 *
 * Deliberately lossy and deliberately strict: unknown fields are dropped
 * (a feed will send you its own metadata and that is fine), but a signal with
 * no usable content is REJECTED rather than passed on as `{}`. Passing `{}` to
 * applyOutcome would produce a "held, unrecognised" outcome and a provenance
 * row blaming the results feed for a malformed entry — an audit trail that
 * points at the wrong component.
 */
function normaliseSignal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if (typeof raw.status === 'string') out.status = raw.status;
  // Winners are integers — or the FEED'S OWN COMPOSITE RUNNER ID, as a string.
  // Anything else is dropped rather than coerced: a string "1" that became
  // selection 1 by accident is precisely the class of coercion that settles the
  // wrong runner.
  //
  // THE COMPOSITE IS NOT A LOOSENING, IT IS THE VENUE'S OWN SPELLING. After
  // #101 `lib/feedcat.js` stores a materialised runner's feed id as
  // `${marketId}:${selectionId}` — because Betfair REUSES a selection id across
  // every 1X2 market on the exchange, so `58805` alone is a label that repeats
  // rather than an identity — and `requestBody` POSTS exactly that string to the
  // provider in each entry's `external_id`. A provider that answers with the ids
  // it was given therefore names its winners and its non-runners in that shape,
  // and `Number('1.234567890:58805')` is NaN: every winner silently dropped, the
  // signal left with nothing to say, and the market HELD as `completed_no_winner`
  // with the provider blamed for a payload this function had just thrown away.
  //
  // The pattern is deliberately narrow — digits, one optional dotted part, a
  // colon, digits — and such a value is carried AS A STRING, never coerced to a
  // number, so it can never be mistaken for a local autoincrement id. Every
  // OTHER input goes through exactly the coercion this function always used, so
  // nothing that worked before this change stops working. `lib/feedcat.js
  // admitSignal` is where a composite is TRANSLATED, and it refuses an ambiguous
  // one rather than picking a runner; this function's whole job is to carry the
  // id there intact.
  const COMPOSITE_RUNNER_ID = /^\d+(\.\d+)?:\d+$/;
  const runnerId = (n) => {
    if (typeof n === 'string' && COMPOSITE_RUNNER_ID.test(n)) return n;
    const v = Number(n);
    return Number.isInteger(v) && v > 0 ? v : null;
  };
  if (Array.isArray(raw.winners)) {
    const w = raw.winners.map(runnerId).filter((n) => n !== null);
    if (w.length) out.winners = w;
  }
  // Booleans are only carried when the feed actually states them. An absent
  // `dead_heat` is not `false`: the rules table distinguishes "no dead heat"
  // from "this feed does not model dead heats", and inventing a false would
  // turn a race into an ordinary finish.
  //
  // A stated `false` is carried verbatim and is NOT dropped below: "there was
  // no red card" is something the feed said, and the signal arriving with it
  // intact is what lets a later reader tell silence from a denial.
  for (const flag of SIGNAL_FLAGS) {
    if (typeof raw[flag] === 'boolean') out[flag] = raw[flag];
  }
  // REDUNDANT SPELLINGS become the field the decision layer reads. An explicit
  // `status` always wins, so a provider that contradicts itself is decided by
  // the field lib/voidrules.js actually looks at, rather than by whichever key
  // happened to be copied first.
  for (const [flag, status] of Object.entries(STATUS_SPELLINGS)) {
    if (out[flag] === true && !out.status) out.status = status;
  }
  if (Array.isArray(raw.non_runners)) {
    const nr = raw.non_runners.map(runnerId).filter((n) => n !== null);
    if (nr.length) out.non_runners = nr;
  }
  // A DECLARED DEDUCTION, carried verbatim and NEVER normalised (#deductions).
  //
  // Every other racing field on this signal is coerced: winners and non_runners go
  // through `Number`, the flags through `Boolean`. A deduction is none of those
  // things, and coercing it here would destroy exactly what lib/deductions.js
  // refuses to destroy. `Number("27") === 27`, so a QUOTED percentage would arrive
  // as a number, pass a range check, and be applied as though the stewards had
  // declared it in the unit they declared it in — and 27 and 0.27 differ by a
  // factor of a hundred depending on which of the two closed units was meant, which
  // is precisely why the unit travels with the figure.
  //
  // So the array is carried AS SENT and lib/deductions.js validates it in place. A
  // malformed element is refused THERE, NAMED, and counted; it is not repaired here,
  // because a repaired figure is a figure nobody declared.
  //
  // It is NOT CONTENT on its own, and it is deliberately absent from the
  // `claimsOutcome` predicate below: a deduction is a charge on the runners that
  // survived a scratching, so a signal carrying one and withdrawing nobody names no
  // outcome. Making it content would turn a stray field into a result the venue
  // acted on. lib/results.js holds that combination under
  // `deduction_without_withdrawal`, which is the honest place for it.
  if (Array.isArray(raw.deductions) && raw.deductions.length) {
    out.deductions = raw.deductions;
  }
  // NO RECOGNISABLE CONTENT IS NOT A SIGNAL — and the test is derived from the
  // list above rather than restating it, because restating it is exactly how
  // `abandoned`, `walkover` and `disputed` came to be accepted, carried, and
  // then discarded: a flag could be added to the carry list without ever
  // appearing in the predicate that decides whether the signal survives.
  //
  // The line is between a CLAIM and its ABSENCE. `dead_heat: true` says the
  // race tied; `dead_heat: false` says no such thing happened, and promoting it
  // to an outcome would turn a provider's silence into a HOLD on a market that
  // has simply not finished. So a flag counts as content only when it is TRUE.
  const claimsOutcome =
    Boolean(out.status) ||
    Boolean(out.winners) ||
    Boolean(out.non_runners) ||
    SIGNAL_FLAGS.some((f) => out[f] === true);
  if (!claimsOutcome) return null;
  return out;
}

/**
 * Accept the two shapes a results service realistically returns: a map keyed by
 * market id, or an array of entries carrying `market_id`. Anything else is a
 * FeedError — a response the venue cannot read must not be read as "no
 * outcomes", which is how a misconfigured integration looks like a quiet one.
 *
 * ── EMPTY AND UNRECOGNISABLE ARE DIFFERENT ANSWERS ─────────────────────────
 * The individual `continue`s below are correct and stay: one bad entry must not
 * abort the batch, and a string that will not coerce into a market id is
 * dropped rather than guessed at. What was wrong is that the DROPS WERE
 * INVISIBLE. `parseOutcomes` collapsed any well-formed JSON of an unexpected
 * shape to `{}`, only a non-object payload ever raised, and the caller then
 * advanced `last_ok_at`, incremented `ok_polls` and cleared
 * `consecutive_failures` — so a provider that changed its wrapper key left the
 * venue permanently green, polling on a timer, settling nothing, with the
 * health endpoint agreeing it was fine.
 *
 * The asymmetry was exactly backwards from this module's own header: an
 * UNREADABLE body threw loudly while a READABLE-BUT-WRONGLY-SHAPED one failed
 * silently. Note which body the venue itself sends — `requestBody` below posts
 * `{markets: [...]}` — so a provider echoing the request shape back was read as
 * "no outcomes, all healthy".
 *
 * So: a payload that CONTAINED entries and produced NONE is a shape change, and
 * raises. Partial parses are still tolerated and reported, because a provider
 * that got one entry wrong is not the same failure as one whose key we no
 * longer recognise, and dropping every entry is what made this invisible.
 *
 * `stats`, when given, receives `{ dropped }` — the entries that named no usable
 * market id. The return value stays a plain `{ [marketId]: signal }` map so no
 * caller has to know this counting exists.
 */
function parseOutcomes(body, stats = null) {
  const note = (dropped) => {
    if (stats) stats.dropped = dropped;
  };
  let payload = body;
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.outcomes !== undefined) {
    payload = payload.outcomes;
  }
  const out = {};
  if (Array.isArray(payload)) {
    let sawEntry = 0;
    let parsed = 0;
    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') continue;
      sawEntry += 1;
      const id = Number(entry.market_id ?? entry.marketId ?? entry.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const signal = normaliseSignal(entry);
      if (signal) {
        out[id] = signal;
        parsed += 1;
      }
    }
    if (sawEntry > 0 && parsed === 0) {
      note(sawEntry);
      throw unrecognisable(sawEntry, 'array entries');
    }
    note(sawEntry - parsed);
    return out;
  }
  if (payload && typeof payload === 'object') {
    let sawEntry = 0;
    let parsed = 0;
    for (const [key, raw] of Object.entries(payload)) {
      sawEntry += 1;
      const id = Number(key);
      if (!Number.isInteger(id) || id <= 0) continue;
      const signal = normaliseSignal(raw);
      if (signal) {
        out[id] = signal;
        parsed += 1;
      }
    }
    if (sawEntry > 0 && parsed === 0) {
      note(sawEntry);
      throw unrecognisable(sawEntry, 'keys');
    }
    note(sawEntry - parsed);
    return out;
  }
  throw new FeedError('unreadable_response', 'expected an object or an array');
}

/**
 * The failure a shape change produces. A distinct reason from
 * `unreadable_response`, because the operator's response to each is different:
 * an unreadable body is a transport problem, and a body we read perfectly well
 * but cannot interpret is an integration whose contract moved underneath us —
 * which is the one to page someone about.
 */
function unrecognisable(sawEntry, what) {
  return new FeedError(
    'unrecognised_shape',
    `${sawEntry} ${what} in the response, none of which named a market id with an outcome`
  );
}

/**
 * The market payload sent to the feed. Selection names ride along so the
 * provider can match on its own identifiers ("Race 4, 3.15pm") rather than on
 * our row ids, which it has never seen.
 *
 * ── AND, SINCE #101, THE FEED'S OWN IDS ALONGSIDE OURS ───────────────────────
 * A market this venue MATERIALISED from the feed is described here in BOTH id
 * spaces, and the reason is that the venue no longer knows anything the feed
 * does not: `id` is a local autoincrement row the provider has never seen,
 * `external_id` is the id it published the market under. Sending only ours makes
 * the provider's answer unroutable back — it would have to match our names, and
 * a fixture it renamed between two polls would then be answered about the wrong
 * market. Sending only theirs would break every results integration that was
 * written before materialisation existed, and would answer an operator who asked
 * "which of my markets is this" with an id they have no way to look up. So both
 * ride along, and `feed_refs` (attached by `results.pendingMarkets`, the one
 * definition of the mapping) is what makes the pair possible.
 *
 * For a market with no `feed_refs` — every venue's own market, and every market
 * on a deployment that has never synced — the entry is BYTE-FOR-BYTE what it was
 * before this change. That is deliberate rather than incidental: an operator's
 * results API that was written against the old body keeps working, and a test
 * that pins the old shape is pinning the compatibility promise rather than an
 * accident of the implementation.
 */
function requestBody(pending) {
  return {
    markets: pending.map((m) => {
      const refs = m.feed_refs || null;
      const entry = {
        id: m.id,
        name: m.market_name,
        event_id: m.event_id,
        event_name: m.event_name,
      };
      if (refs) {
        entry.external_id = refs.market_id;
        entry.event_external_id = refs.event_id;
        entry.external_provider = refs.provider;
      }
      if (refs && refs.selections.length) {
        // Built from the mapping rather than from the `group_concat` pair below,
        // for two reasons. It is ORDERED (the map's rows are ordered by local id)
        // and it carries the pairing explicitly, so no two `group_concat`
        // columns — whose row order SQLite does not document — have to agree with
        // each other for a runner to be named correctly. The old spelling pairs
        // `selection_ids` with `selection_names` BY POSITION, so a venue whose
        // two subqueries returned rows in different orders would post a market
        // where "The Draw" is attached to the wrong id, and the provider would
        // answer about the wrong outcome.
        const names = m.selection_names ? String(m.selection_names).split(' | ') : [];
        entry.selections = refs.selections.map((s) => {
          const local = m.selection_ids ? String(m.selection_ids).split(',').map(Number) : [];
          const at = local.indexOf(s.local_id);
          return {
            id: s.local_id,
            external_id: s.external_id,
            name: at >= 0 && names[at] ? names[at] : null,
          };
        });
      } else {
        entry.selections = m.selection_ids
          ? String(m.selection_ids)
              .split(',')
              .map((id, i) => {
                const names = m.selection_names ? String(m.selection_names).split(' | ') : [];
                return { id: Number(id), name: names[i] || null };
              })
          : [];
      }
      return entry;
    }),
  };
}

/**
 * Create a fetcher compatible with `results.pollOnce(db, fetchResults)`.
 *
 * `fetchImpl` is a seam for tests (and for a future transport that is not
 * HTTP). Everything else is config.
 *
 * ── WHY THE POLL SET IS UNCAPPED AND THE REQUEST IS NOT ─────────────────────
 * #39 gave `pendingMarkets` a satisfiable predicate (off time), so for the first
 * time it returns a set that grows: on a long-running venue whose results feed
 * has quietly stopped working, every market that goes off stays in it forever.
 *
 * The obvious fix is `LIMIT`, and it is the wrong one. A truncated set drops
 * markets SILENTLY — never asked about, never settled, never reported — which is
 * the precise failure this whole path exists to prevent, introduced by the fix
 * for "the list grows". Ordering the limit oldest-off-last strands exactly the
 * markets that have waited longest, i.e. the ones holding a player's money. And
 * a venue cannot even see it happen: the list is not a queue an operator drains.
 *
 * So the bound is applied to the WIRE instead. The set is complete, every market
 * in it is asked about on every poll, and the requests go out in batches of
 * `batchSize` so no single body grows without limit. Nothing is dropped, nothing
 * is deferred, and the backlog is published and announced when it grows.
 */
function createFetcher({
  url,
  secret = null,
  timeoutMs = 10000,
  maxBytes = 1048576,
  fetchImpl = globalThis.fetch,
  pendingFn = null,
  batchSize = RESULTS_BATCH_SIZE,
} = {}) {
  const target = url || config.RESULTS_FEED_URL || null;
  state.target = target;
  const { pendingMarkets } = require('./results');
  // A batch size that is not a usable positive integer is replaced, NOT obeyed.
  // Zero or negative would slice nothing and loop forever asking about markets
  // that are not there; Infinity would produce zero batches and return a
  // successful poll that asked about nothing at all. Both are ways to lose every
  // market silently, which is the one thing this module must not do.
  const size =
    Number.isFinite(Number(batchSize)) && Number(batchSize) >= 1
      ? Math.floor(Number(batchSize))
      : RESULTS_BATCH_SIZE;

  /**
   * Returns `{ [marketId]: signal }`, or `{}` on any failure. Never throws.
   */
  return async function fetchResults(db) {
    const pending = (pendingFn || pendingMarkets)(db);
    state.last_poll_at = new Date().toISOString();
    state.polls += 1;
    state.pending_last_poll = pending.length;
    noteBacklog(pending.length);

    if (!target) {
      // Not configured is a normal, honest state for a venue that settles by
      // hand — not an error to count as a failure.
      state.last_error = null;
      return {};
    }
    if (!fetchImpl) {
      return fail('no_fetch', 'this runtime has no fetch');
    }
    if (pending.length === 0) {
      // Nothing to ask about. Counts as a successful poll: the feed is not
      // implicated in a venue that has nothing pending, and reporting a
      // failure here would train the operator to ignore the alarm.
      state.last_ok_at = state.last_poll_at;
      state.ok_polls += 1;
      state.consecutive_failures = 0;
      return {};
    }

    // ONE POLL, SEVERAL REQUESTS. Outcomes from every batch that answered are
    // kept even if a later batch fails: they are real results for real markets,
    // and throwing them away because batch four timed out is how money that was
    // already in hand gets left unsettled. The failure is still recorded, so the
    // alarm is unaffected by the choice.
    const outcomes = {};
    let broken = null;
    const batches = Math.ceil(pending.length / size);
    for (let i = 0, n = 1; i < pending.length && !broken; i += size, n++) {
      try {
        Object.assign(outcomes, await askOne(pending.slice(i, i + size), n, batches));
      } catch (e) {
        broken = e;
        // Stop asking. A provider that just failed a request will not answer the
        // next nine either, and the point of not capping is not to punish a
        // provider that has stopped for trying.
      }
    }

    if (broken) {
      // Recorded first, so the alarm is identical to a single-request failure.
      // The outcomes already in hand are still returned: they are real results
      // for real markets, and discarding them because a LATER batch timed out
      // strands money the venue is already holding answers for. The caller sees
      // both — a populated outcome map and a `failing` feed.
      fail(broken.reason, broken.detail);
      return outcomes;
    }

    state.last_ok_at = state.last_poll_at;
    state.ok_polls += 1;
    state.consecutive_failures = 0;
    state.last_error = null;
    return outcomes;
  };

  /**
   * Ask the feed about ONE batch. Returns its outcomes; throws a plain
   * `{reason, detail}` for anything that went wrong, so the caller decides what
   * a partial poll means rather than having it decided here.
   */
  async function askOne(batch, nth, of) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Declared out here so the catch below can count entries the provider sent
    // and we could not use — including on the path where it raised.
    const stats = {};
    const where = of > 1 ? ` (batch ${nth} of ${of})` : '';
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json' };
      if (secret) headers.authorization = `Bearer ${secret}`;
      const res = await fetchImpl(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody(batch)),
        signal: controller.signal,
        // NO REDIRECTS. This transport's whole safety argument is "the feed is a
        // signal, not an authority": it validates the SHAPE of an outcome (a
        // winner must be in the market, the rule must be known) but never the
        // IDENTITY of the responder — the operator names one host in
        // RESULTS_FEED_URL and trusts that host. Following a redirect discards
        // exactly that trust: a compromised provider, a hijacked DNS answer, or
        // an open redirect on the configured host can hand the response — and
        // therefore SETTLEMENT — to a host nobody configured. Measured: a feed
        // that 302s to a loopback service settles real markets from that
        // service's answer.
        //
        // (A redirect also downgrades POST to GET and drops the body and the
        // bearer token, so this was never an exfiltration primitive — but the
        // RESPONSE is trusted, and that is what moves money.)
        redirect: 'error',
      });
      if (!res.ok) throw { reason: `http_${res.status}`, detail: `${batch.length} market(s) pending` };
      const raw = await readBounded(res, maxBytes);
      const outcomes = parseOutcomes(safeJson(raw), stats);
      state.signals_received += Object.keys(outcomes).length;
      // Counted on SUCCESS too, because a poll that applied what it could and
      // quietly ignored the rest is the half of this bug that does not throw.
      state.dropped_entries += stats.dropped || 0;
      state.last_dropped = stats.dropped || 0;
      return outcomes;
    } catch (e) {
      // Counted before the branch, because a payload whose entries we could not
      // read is the case worth counting: it is the one that looks like a quiet
      // night from every other number on this page.
      state.dropped_entries += stats.dropped || 0;
      state.last_dropped = stats.dropped || 0;
      // Whatever it was — a FeedError of our own, the plain object thrown above,
      // or somebody's DNS failure — a failed batch leaves as {reason, detail},
      // so the reason strings the health endpoint publishes are exactly the ones
      // it published when there was only ever one request.
      if (e && typeof e.reason === 'string') {
        throw { reason: e.reason, detail: e.detail ? `${e.detail}${where}` : null };
      }
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
        throw { reason: 'timeout', detail: `${timeoutMs}ms${where}` };
      }
      throw { reason: 'unreachable', detail: e && e.message ? `${String(e.message).slice(0, 200)}${where}` : null };
    } finally {
      clearTimeout(timer);
    }
  }

  function fail(reason, detail) {
    state.last_error = { reason, detail: detail || null, at: state.last_poll_at };
    state.consecutive_failures += 1;
    // Thrown from the inner scope by the caller's return, never propagated.
    return {};
  }
}

/**
 * Announce a backlog that has grown, and only that.
 *
 * A growing pending set means markets are going off and not settling. Every other
 * number on `state` describes whether the FEED is working, and a feed can report
 * perfectly while this happens — which is why nothing on this object was able to
 * distinguish the two.
 *
 * The trigger is a NEW HIGH, not a threshold: a venue with a permanently large
 * backlog says so once rather than every cycle, so the line keeps its meaning,
 * and a queue that is merely large but not growing stays silent because it is
 * not getting worse.
 */
function noteBacklog(count) {
  if (count <= state.pending_peak) return;
  const previous = state.pending_peak;
  state.pending_peak = count;
  console.warn(
    `[results] backlog is ${count} market(s) off but unsettled (previous high ${previous}) — ` +
      'every poll asks the feed about all of them'
  );
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new FeedError('invalid_json');
  }
}

/**
 * Read a response body with a hard byte cap.
 *
 * A provider returning a 500MB body must not be able to OOM the venue to
 * deliver bad news. The cap is enforced on the decoded stream, so it holds
 * regardless of the Content-Length header the provider chose to lie about.
 */
async function readBounded(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (text.length > maxBytes) throw new FeedError('response_too_large', `${text.length} bytes`);
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
      throw new FeedError('response_too_large', `>${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Is the feed healthy, in the sense an operator can act on?
 *
 * `stale_after_ms` is the poll interval, so "stale" means "the venue has been
 * waiting longer than one cycle for an answer", which is the honest threshold:
 * one missed poll is jitter, several is an outage. A feed that has never
 * answered at all is the limit of that sentence and is reported the same way —
 * see the note on `stale` below for why it was not before.
 */
function health({ staleAfterMs = 0, now = Date.now() } = {}) {
  const snap = stateSnapshot();
  // Prefer what a transport actually resolved, so an explicitly-passed URL is
  // reported as configured.
  const configured = Boolean(snap.target || config.RESULTS_FEED_URL);
  const failed = snap.consecutive_failures > 0;
  let age = null;
  if (snap.last_ok_at) age = Math.max(0, now - Date.parse(snap.last_ok_at));
  // "STALE" MEANS THE VENUE HAS BEEN WAITING TOO LONG FOR AN ANSWER, and a feed
  // that has never once answered has been waiting since boot — which the age
  // test alone could never say, because there IS no age yet.
  //
  // This used to require a previous success, so a configured feed read `ok`
  // from boot until its first good poll and, if the poll job never ran at all,
  // read `ok` forever. A module whose header calls staleness "the operator's
  // alarm" cannot have a state in which the alarm is structurally incapable of
  // firing, and "configured" is not an answer — it is the question.
  const neverAnswered = configured && snap.last_ok_at === null;
  const waitedTooLong = age !== null && age > staleAfterMs;
  const stale = Boolean(staleAfterMs > 0 && (neverAnswered || waitedTooLong));
  return {
    configured,
    target: snap.target || config.RESULTS_FEED_URL || null,
    // Three states an operator must be able to tell apart, and no more:
    // not set up, failing right now, or working.
    status: !configured ? 'not_configured' : failed ? 'failing' : stale ? 'stale' : 'ok',
    last_poll_at: snap.last_poll_at,
    last_ok_at: snap.last_ok_at,
    last_error: snap.last_error,
    consecutive_failures: snap.consecutive_failures,
    polls: snap.polls,
    ok_polls: snap.ok_polls,
    signals_received: snap.signals_received,
    // Published because the whole failure this module had was invisible, and
    // this is the number that would have shown it. A non-zero value means the
    // provider is describing itself in a way we did not ask for.
    dropped_entries: snap.dropped_entries,
    last_dropped: snap.last_dropped,
    // THE BACKLOG, beside the transport counters on purpose. `status` can be
    // `ok` for every one of these numbers while four hundred off markets sit
    // unsettled, because a feed that answers correctly about markets it is never
    // asked about looks identical to a feed that has everything it needs. A
    // backlog that only ever grows is the one signal that separates them.
    pending_last_poll: snap.pending_last_poll,
    pending_peak: snap.pending_peak,
    // THE OTHER TRANSPORT, on the same page. See the note on `webhook_*` in
    // `state`: a push-configured venue has never polled and never will, so
    // without this block `polls: 0` and `last_ok_at: null` read as "configured
    // and failing" for a feed that is answering perfectly.
    webhook: webhookHealth(),
    age_ms: age,
    stale,
  };
}

/**
 * ACCEPT THE SHAPE A PUSHING PROVIDER SENDS, which is the same shape with one
 * rule deliberately widened, and it is the same SIGNAL for every entry.
 *
 * WHY A SEPARATE ENTRY POINT AND NOT `parseOutcomes`.
 *
 * `parseOutcomes` reads what the venue ASKED for: `requestBody` posts
 * `{markets: [{id, external_id, …}]}`, so a well-behaved provider answers keyed
 * by the integer `id` this venue invented and the provider has never seen. Its
 * key rule is therefore `Number(key)` must be a positive integer — which is
 * exactly right for a pull and exactly wrong for a push.
 *
 * A push has no request to answer. The sender decides which markets to talk about
 * and names them in whatever space it has, which for a licensed feed is its own:
 * `'1.234567890'`. Routed through `parseOutcomes`, that single key becomes
 * `Number('1.234567890')` → not an integer → dropped → "1 keys in the response,
 * none of which named a market id with an outcome" → `unrecognised_shape` → a 400
 * telling a correctly-configured feed operator that their integration is broken.
 * Which is the defect this whole module's header describes, arrived at from the
 * other direction: a transport that cannot read a valid answer looks exactly like
 * one that has nothing to say.
 *
 * WHAT IS NOT FORKED, and is the part that matters: every entry is normalised by
 * `normaliseSignal`, so the rules, the tolerated spellings, the integer-only ids
 * inside `winners` / `non_runners`, and the "no claim is not a signal" test are
 * ONE definition. A second signal shape is the failure this repository has paid
 * for — three redundant spellings of `status` were carried through normalisation,
 * arrived unchanged, matched no void rule and held markets as `unrecognised` while
 * the provider was blamed for a payload the transport had already declared valid.
 * The key is a transport concern; the signal is not.
 *
 * The three container shapes are the same three `parseOutcomes` accepts — the
 * bare map, the `{outcomes: …}` wrapper, and an array of entries carrying
 * `market_id` — and the same rule applies to all of them: a body that CONTAINED
 * entries and produced NONE is a shape change and raises, rather than reading as
 * "no outcomes", which `parseOutcomes`'s own header calls out as the asymmetry
 * that once made a broken integration look permanently healthy.
 *
 * Keys are returned AS SENT. Resolving one to a local market is the caller's job
 * and belongs next to the id-space boundary that does it (lib/feedcat.js), not
 * here — this module parses, it does not decide.
 */
function parseDelivery(body) {
  let payload = body;
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.outcomes !== undefined) {
    payload = payload.outcomes;
  }
  const out = {};
  const entries = [];
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (entry && typeof entry === 'object') {
        entries.push([String(entry.market_id ?? entry.marketId ?? entry.id ?? ''), entry]);
      }
    }
  } else if (payload && typeof payload === 'object') {
    for (const [key, raw] of Object.entries(payload)) entries.push([String(key), raw]);
  } else {
    throw new FeedError('unreadable_response', 'expected an object or an array');
  }
  let saw = 0;
  for (const [key, raw] of entries) {
    // ANY non-empty key is a candidate market id. NOT a numeric filter: the feed's
    // own market ids are TEXT ('1.234567890'), and a filter that dropped them
    // would raise `unrecognised_shape` against a delivery that named a market
    // perfectly correctly. Which id space a key is in is resolved by the caller,
    // next to the id-space boundary that owns that decision.
    if (!key) continue;
    saw += 1;
    const signal = normaliseSignal(raw);
    if (signal) out[key] = signal;
  }
  if (saw > 0 && Object.keys(out).length === 0) {
    throw new FeedError(
      'unrecognised_shape',
      `${saw} ${Array.isArray(payload) ? 'entries' : 'keys'} in the delivery, none of which named a market id with an outcome`
    );
  }
  // Entries we could not read are not entries we may ignore: each one is a market
  // the sender believes exists. Counted rather than dropped silently, for the
  // reason `parseOutcomes` counts `dropped` — the one difference between a feed
  // that agrees with us entirely and one that has quietly started describing
  // itself differently.
  return { outcomes: out, unreadable_entries: saw - Object.keys(out).length };
}

/**
 * The PUSH transport's health, in the shape an operator can act on.
 *
 * Split from `health()` rather than folded into it because the two transports can
 * be configured independently and have genuinely different states — a venue with
 * only a webhook has never polled and never will — and because a poll that is
 * `not_configured` must not make the whole page read as broken. What they share
 * is the question, and `health()` now carries this block under `webhook` so the
 * one GET answers both.
 *
 * `status` is the same four-state vocabulary `health()` uses, for the same
 * reason: an operator has to be able to tell "not set up", "failing right now"
 * and "working" apart at a glance.
 *
 * `never_delivered` is the load-bearing case and it is NOT a failure. A webhook
 * that has been configured for two minutes and not yet been called is working;
 * what is alarming is the configured-and-never-answered shape on the POLL side,
 * which is why `health()` treats it as stale. Here a feed pushes when it has
 * something to say, so silence is the normal state and there is no window to
 * declare stale against. The number that would show a broken integration is
 * `deliveries` staying at zero while outcomes arrive by hand — which is what the
 * BOOT LINE says, in words, before any of it has happened.
 */
function webhookHealth({ configured } = {}) {
  const snap = stateSnapshot();
  // `configured` is overridable so a test can ask about a hypothetical venue
  // without one, and so the route can report the setting it actually enforced
  // rather than re-reading a config that has not changed under it.
  const isConfigured = configured === undefined ? Boolean(config.RESULTS_WEBHOOK_SECRET) : Boolean(configured);
  const failed = snap.webhook_consecutive_failures > 0;
  return {
    configured: isConfigured,
    // Without a secret the route is a 404, so "the webhook is not configured" and
    // "the webhook is not there" are the same statement to a caller. Saying
    // `not_configured` rather than `unauthorized` is what keeps a scanner from
    // learning that the route exists at all.
    status: !isConfigured ? 'not_configured' : failed ? 'failing' : 'ok',
    deliveries: snap.webhook_deliveries,
    outcomes: snap.webhook_outcomes,
    // Outcomes the venue recorded and REFUSED to act on. A non-zero count is not
    // an error rate, it is a queue of disputes waiting for a human, and it is the
    // number an operator should be watching while nobody complains.
    held: snap.webhook_held,
    // Deliveries that never reached the consumer at all: a bad signature, a
    // timestamp outside the replay window, an unreadable body. Counted because an
    // integration that is being called with the wrong secret looks EXACTLY like
    // one that is not being called, and the difference is a feed operator's
    // afternoon.
    refused: snap.webhook_refused,
    last_delivery_at: snap.webhook_last_at,
    last_error: snap.webhook_last_error,
    consecutive_failures: snap.webhook_consecutive_failures,
  };
}

/**
 * Record what one delivered batch did. Called by the webhook route, on the
 * accepted path only — a delivery the venue refused before reading it is counted
 * by `webhookRefusal` instead, so the two numbers never mix.
 */
function noteWebhookDelivery({ outcomes = 0, held = 0 } = {}) {
  state.webhook_deliveries += 1;
  state.webhook_outcomes += outcomes;
  state.webhook_held += held;
  state.webhook_last_at = new Date().toISOString();
  state.webhook_last_error = null;
  state.webhook_consecutive_failures = 0;
  return stateSnapshot();
}

/**
 * Record a delivery the venue REFUSED — bad signature, stale timestamp,
 * replay, unreadable body — and say why, so `/api/admin/results/feed` can show
 * it instead of showing nothing at all.
 */
function noteWebhookRefusal(reason, detail = null) {
  state.webhook_refused += 1;
  state.webhook_consecutive_failures += 1;
  state.webhook_last_error = { reason, detail: detail || null, at: new Date().toISOString() };
  return stateSnapshot();
}

/**
 * WHAT THE BOOT LOG SAYS ABOUT RESULTS, IN WHATEVER CONFIGURATION THE VENUE IS
 * RUNNING. A pure function of its argument, for the reason `feedBootStatus` is:
 * a line built inside `main()` cannot be tested without booting a server and
 * waiting for a feed, and the claim it makes — that markets settle automatically
 * — is exactly the claim an operator has to be able to check before they go
 * live.
 *
 * It is here rather than in server.js because this module owns the transports it
 * describes, and because the previous version of this line lived inline in
 * `main()` where nothing could read it. What it said was:
 *
 *   "[results] RESULTS_FEED_URL unset — no automatic results feed. Markets
 *    settle by webhook or by an operator settling them by hand."
 *
 * "By webhook" was a promise about a route that did not exist. There was no
 * webhook: the only external entry points were the admin-triggered poll and the
 * admin settle route, so an operator reading that line believed they had two
 * automatic transports and had one that they had to press a button for. It is the
 * exact failure STATE.md §5 records as "a comment that asserts behaviour the code
 * does not have", printed at every boot of every venue with no results feed
 * configured.
 *
 * So the line now states which transports are LIVE, and says plainly what happens
 * to a market that is off but not settled when none of them is. Three states that
 * used to collapse into one warning:
 *
 *   nothing configured  no automatic settlement at all; the operator settles
 *   webhook only        a licensed feed pushes outcomes (the normal shape for a
 *                       licensed feed — it will not serve a queue the venue polls,
 *                       and pre-off withdrawals arrive here because
 *                       `pendingMarkets` only ever asks about markets already OFF)
 *   poll only           the venue asks a configured URL for outcomes
 *   both                either will do it
 *
 * `level` follows the same convention as `feedBootStatus`: `warn` when a human
 * must know something, `log` when the venue is configured as intended.
 */
function resultsBootStatus(cfg = config) {
  const hasPoll = Boolean(cfg.RESULTS_FEED_URL);
  const hasPush = Boolean(cfg.RESULTS_WEBHOOK_SECRET);
  const lines = [];
  if (hasPoll && hasPush) {
    lines.push('[results] automatic settlement is configured TWICE: outcomes are polled from');
    lines.push('[results] RESULTS_FEED_URL and accepted pushed to the signed webhook. Both');
    lines.push('[results] apply, and either one is enough.');
  } else if (hasPush) {
    lines.push('[results] results WEBHOOK active — outcomes are accepted pushed, signed and');
    lines.push('[results] timestamped over POST /api/results/webhook. This is also the only');
    lines.push('[results] route a pre-off withdrawal can arrive on: the poll timer only asks');
    lines.push('[results] about markets that are already OFF.');
  } else if (hasPoll) {
    lines.push('[results] results POLL active — pending markets are POSTed to');
    lines.push('[results] RESULTS_FEED_URL on a timer and outcomes are applied on the answer.');
    lines.push('[results] A pre-off withdrawal has no route through the timer (it only asks');
    lines.push('[results] about markets already OFF); set RESULTS_WEBHOOK_SECRET for one, or');
    lines.push('[results] remove the runner from the admin desk.');
  } else {
    // The honest version of the old line. It says what is NOT here instead of
    // naming a route that does not exist, because the only way an operator finds
    // out that nothing settles automatically is by reading this.
    lines.push('[results] NO AUTOMATIC RESULTS TRANSPORT — RESULTS_FEED_URL and');
    lines.push('[results] RESULTS_WEBHOOK_SECRET are both unset. Every market is settled');
    lines.push('[results] by an operator, at POST /api/admin/markets/:id/settle. Outcomes');
    lines.push('[results] pushed to this venue by a feed will be REJECTED with a 404 until');
    lines.push('[results] RESULTS_WEBHOOK_SECRET is set.');
  }
  return {
    message: lines.join('\n'),
    // A venue configured for one transport is told it is on at `log`, not
    // `warn`: warning on every boot about a thing that is working trains
    // operators to skip the block above it, which is where the RG, compliance and
    // backup warnings live and all of which matter more.
    level: hasPoll || hasPush ? 'log' : 'warn',
    poll: hasPoll,
    webhook: hasPush,
  };
}

/**
 * Run one cycle: fetch, then hand the outcomes to the consumer.
 *
 * Returns the consumer's result plus the transport's health, so a caller can
 * log one line with everything an operator would ask for.
 */
async function pollNow(db, { fetcher, staleAfterMs } = {}) {
  const f = fetcher || createFetcher();
  let applied = { considered: 0, applied: 0, results: [] };
  let error = null;
  try {
    const { pollOnce } = require('./results');
    applied = await pollOnce(db, f);
  } catch (e) {
    // The consumer itself threw (a genuine engine fault, not a feed fault).
    // Surfaced rather than swallowed — this is the path where a bug in
    // settlement shows up, and it must not hide behind "the feed is down".
    error = { reason: 'consumer_failed', detail: e && e.message ? String(e.message).slice(0, 200) : null };
  }
  return { ...applied, error, feed: health({ staleAfterMs }) };
}

module.exports = {
  createFetcher,
  pollNow,
  health,
  webhookHealth,
  noteWebhookDelivery,
  noteWebhookRefusal,
  resultsBootStatus,
  state: stateSnapshot,
  resetState,
  normaliseSignal,
  parseOutcomes,
  parseDelivery,
  // EXPORTED SINCE #101, and the reason is the id-space fields this body now
  // carries. `requestBody` decides what an operator's API is told this venue
  // calls a market, and a field added to a wire body that no caller can reach is
  // a field that silently stops being sent — which is exactly the shape of bug
  // the "no silent failure" rule above exists for. It stays a pure function of
  // its argument, so a test can assert the whole body without a socket.
  requestBody,
  FeedError,
};
