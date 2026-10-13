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
};

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
  // Winners are integers. Anything else is dropped rather than coerced: a
  // string "1" that became selection 1 by accident is precisely the class of
  // coercion that settles the wrong runner.
  if (Array.isArray(raw.winners)) {
    const w = raw.winners.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (w.length) out.winners = w;
  }
  // Booleans are only carried when the feed actually states them. An absent
  // `dead_heat` is not `false`: the rules table distinguishes "no dead heat"
  // from "this feed does not model dead heats", and inventing a false would
  // turn a race into an ordinary finish.
  for (const flag of ['dead_heat', 'red_card', 'abandoned', 'walkover', 'disputed', 'completed']) {
    if (typeof raw[flag] === 'boolean') out[flag] = raw[flag];
  }
  if (Array.isArray(raw.non_runners)) {
    const nr = raw.non_runners.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (nr.length) out.non_runners = nr;
  }
  // No recognisable content at all is not a signal.
  if (!out.status && !out.winners && !out.non_runners && !out.dead_heat && !out.red_card) {
    return null;
  }
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
 */
function requestBody(pending) {
  return {
    markets: pending.map((m) => ({
      id: m.id,
      name: m.market_name,
      event_id: m.event_id,
      event_name: m.event_name,
      selections: m.selection_ids
        ? String(m.selection_ids)
            .split(',')
            .map((id, i) => {
              const names = m.selection_names ? String(m.selection_names).split(' | ') : [];
              return { id: Number(id), name: names[i] || null };
            })
        : [],
    })),
  };
}

/**
 * Create a fetcher compatible with `results.pollOnce(db, fetchResults)`.
 *
 * `fetchImpl` is a seam for tests (and for a future transport that is not
 * HTTP). Everything else is config.
 */
function createFetcher({
  url,
  secret = null,
  timeoutMs = 10000,
  maxBytes = 1048576,
  fetchImpl = globalThis.fetch,
  pendingFn = null,
} = {}) {
  const target = url || config.RESULTS_FEED_URL || null;
  state.target = target;
  const { pendingMarkets } = require('./results');

  /**
   * Returns `{ [marketId]: signal }`, or `{}` on any failure. Never throws.
   */
  return async function fetchResults(db) {
    const pending = (pendingFn || pendingMarkets)(db);
    state.last_poll_at = new Date().toISOString();
    state.polls += 1;

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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Declared out here so the catch below can count entries the provider sent
    // and we could not use — including on the path where it raised.
    const stats = {};
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json' };
      if (secret) headers.authorization = `Bearer ${secret}`;
      const res = await fetchImpl(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody(pending)),
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
      if (!res.ok) return fail(`http_${res.status}`, `${pending.length} market(s) pending`);
      const raw = await readBounded(res, maxBytes);
      const outcomes = parseOutcomes(safeJson(raw), stats);
      state.last_ok_at = state.last_poll_at;
      state.ok_polls += 1;
      state.consecutive_failures = 0;
      state.last_error = null;
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
      if (e && e.name === 'FeedError') return fail(e.reason, e.detail);
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
        return fail('timeout', `${timeoutMs}ms`);
      }
      return fail('unreachable', e && e.message ? String(e.message).slice(0, 200) : null);
    } finally {
      clearTimeout(timer);
    }
  };

  function fail(reason, detail) {
    state.last_error = { reason, detail: detail || null, at: state.last_poll_at };
    state.consecutive_failures += 1;
    // Thrown from the inner scope by the caller's return, never propagated.
    return {};
  }
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
 * one missed poll is jitter, several is an outage.
 */
function health({ staleAfterMs = 0, now = Date.now() } = {}) {
  const snap = stateSnapshot();
  // Prefer what a transport actually resolved, so an explicitly-passed URL is
  // reported as configured.
  const configured = Boolean(snap.target || config.RESULTS_FEED_URL);
  const failed = snap.consecutive_failures > 0;
  let age = null;
  if (snap.last_ok_at) age = Math.max(0, now - Date.parse(snap.last_ok_at));
  const stale = Boolean(configured && age !== null && staleAfterMs > 0 && age > staleAfterMs);
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
    age_ms: age,
    stale,
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
  state: stateSnapshot,
  resetState,
  normaliseSignal,
  parseOutcomes,
  FeedError,
};
