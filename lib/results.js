'use strict';
// lib/results.js — the results feed consumer.
//
// `settleMarket` was already a single idempotent entry point, so this is a
// CONSUMER, not a rewrite: its whole job is to decide, per market, whether to
// settle, void, or HOLD, and then call settleTx through the ordinary path.
//
// The rules live in lib/voidrules.js and this module does not restate them.
// What this module owns is everything about being a CONSUMER:
//
//   - IDEMPOTENCE. A feed re-delivers. Re-delivering a settled market must be
//     a no-op, not an error and not a second payout. settleMarket already
//     refuses a settled market with 409; that is caught and recorded as
//     "already done", not treated as a failure.
//   - PROVENANCE. Every outcome settled is traceable to the source event, via
//     result_events. An operator disputing a settlement needs to see which
//     feed event caused it, and a settlement with no source is a settlement
//     nobody can defend.
//   - DISPUTES. A held market is NOT settled and NOT voided. It stays open
//     with a recorded reason, and a human releases it. The alternative —
//     guessing — picks a side and the venue cannot undo it.
//   - ONE TRANSACTION PER MARKET. Settling 200 markets must not be all-or-
//     nothing; one bad outcome must not roll back 199 good ones.
const { transaction } = require('./tx');
const { settleMarket } = require('./settle');
const rules = require('./voidrules');
const audit = require('./audit');

// How the feed reached us. Recorded per outcome so a dispute can be traced to
// the transport as well as the payload.
const SOURCES = ['poll', 'webhook', 'manual', 'import'];

function recordSource(db, { marketId, eventId, decision, rule, reason, winners, source, externalId }) {
  db.prepare(
    `INSERT INTO result_events (market_id, source_event_id, source, decision, rule, reason, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    marketId,
    externalId ?? null,
    source,
    decision,
    rule,
    reason,
    JSON.stringify({ winners: winners ?? null })
  );
}

/**
 * Apply ONE outcome to ONE market.
 *
 * Returns a result object rather than throwing, because a feed processes many
 * markets and one bad one must not abort the batch. Callers collect the
 * failures and report them.
 */
function applyOutcome(db, marketId, signal, { source = 'poll', externalId = null, actor = null } = {}) {
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (!market) return { market_id: marketId, outcome: 'not_found' };
  if (market.status === 'settled') return { market_id: marketId, outcome: 'already_settled' };

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(market.event_id);
  const sport = event
    ? db.prepare('SELECT slug FROM sports WHERE id = ?').get(event.sport_id)
    : null;
  const decision = rules.resolve(sport ? sport.slug : null, signal);

  if (decision.decision === rules.HOLD) {
    // Recorded, escalated, and NOT settled. The market stays open so the
    // player still holds a real position — holding is not the same as voiding.
    transaction(db, () => {
      recordSource(db, {
        marketId, eventId: event ? event.id : null, decision: 'hold', rule: decision.rule,
        reason: decision.reason, winners: null, source, externalId,
      });
      db.prepare("UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?").run(decision.reason, marketId);
    });
    return { market_id: marketId, outcome: 'held', rule: decision.rule, reason: decision.reason };
  }

  // Winners must belong to THIS market. Settling a winner id from another
  // market would credit the wrong selection, and settleMarket's own check is
  // the last line of defence — so validate here and refuse cleanly.
  let winners = decision.winners;
  // Declared out here, not inside the block below: the settle call that uses it
  // sits after the block, so a block-scoped const would only resolve by
  // short-circuit luck on the void path.
  let isDeadHeat = false;
  if (decision.decision === rules.SETTLE) {
    const valid = new Set(
      db.prepare('SELECT id FROM selections WHERE market_id = ?').all(marketId).map((r) => r.id)
    );
    winners = winners.filter((w) => valid.has(w));
    if (winners.length === 0) {
      transaction(db, () => {
        recordSource(db, {
          marketId, eventId: event ? event.id : null, decision: 'hold', rule: decision.rule,
          reason: 'No supplied winner belongs to this market; held for review', winners: null, source, externalId,
        });
        db.prepare("UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?")
          .run('No supplied winner belongs to this market; held for review', marketId);
      });
      return { market_id: marketId, outcome: 'held', rule: decision.rule, reason: 'winner not in market' };
    }
    // MULTIPLE WINNERS SETTLE AS A JOINT FAVOURITE. This used to be a HOLD:
    // settleMarket settled exactly one selection, and the rule was to hold
    // rather than pay the first winner and short the rest — a correct refusal
    // of a model the engine did not have. It has the model now (a winner SET,
    // payout divided, floored), so a dead heat settles properly instead of
    // stranding every backer's collateral until an operator voids it, which
    // pays nobody.
    // A MULTI-WINNER SIGNAL DOES NOT MAKE ITS OWN RULES ENTRY. The `||` used
    // to override the table, so a two-winner `completed` signal on FOOTBALL
    // settled as a joint favourite — halving every backer's payout, on a sport
    // with no dead heats, with no human in the loop and no hold. The rules table
    // is the authority on whether a sport pays a joint favourite; the signal is
    // only evidence about what happened.
    //
    // So: a dead heat requires the rule to SAY so (`rule === 'dead_heat'`), and
    // a multi-winner signal on a rule that does not permit one is HELD — which
    // is what a genuine anomaly looks like, and what a hold is for.
    isDeadHeat = decision.rule === 'dead_heat';
    if (winners.length > 1 && !isDeadHeat) {
      transaction(db, () => {
        recordSource(db, {
          marketId, eventId: event ? event.id : null, decision: 'hold', rule: decision.rule,
          reason: `Outcome named ${winners.length} winners under a rule that does not permit a joint favourite; held for review`,
          winners, source, externalId,
        });
        db.prepare("UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?")
          .run('Outcome named multiple winners under a single-winner rule; held for review', marketId);
      });
      return { market_id: marketId, outcome: 'held', rule: decision.rule, reason: 'multiple winners under a single-winner rule' };
    }
    if (isDeadHeat && winners.length < 2) {
      transaction(db, () => {
        recordSource(db, {
          marketId, eventId: event ? event.id : null, decision: 'hold', rule: decision.rule,
          reason: 'Dead heat must name at least two joint winners; held for review', winners, source, externalId,
        });
        db.prepare("UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?")
          .run('Dead heat must name at least two joint winners; held for review', marketId);
      });
      return { market_id: marketId, outcome: 'held', rule: decision.rule, reason: 'underspecified dead heat' };
    }
  }

  try {
    // settleMarket refuses a non-boolean void and an already-settled market;
    // both are legitimate here rather than bugs, so the 409 is absorbed.
    const res = transaction(db, () => {
      // A dead heat settles the winner SET; an ordinary finish settles the one.
      // settleMarket validates both, including that a dead heat names at least
      // two joint winners.
      const r = settleMarket(
        db,
        marketId,
        decision.voided
          ? { void: true }
          : isDeadHeat
            ? { dead_heat: winners }
            : { winner_selection_id: winners[0] }
      );
      recordSource(db, {
        marketId, eventId: event ? event.id : null, decision: decision.decision, rule: decision.rule,
        reason: decision.reason, winners: decision.voided ? null : winners, source, externalId,
      });
      return r;
    });
    return { market_id: marketId, outcome: decision.decision === rules.VOID ? 'voided' : 'settled', rule: decision.rule, result: res };
  } catch (e) {
    // 409 = already settled (a concurrent feed delivery won the race). That is
    // the idempotent path, not a failure.
    if (e && e.status === 409) return { market_id: marketId, outcome: 'already_settled' };
    throw e;
  }
}

/**
 * The markets a poll cycle is responsible for: open, not on a settlement hold,
 * and past its off time — so a result for it can exist.
 *
 * Exported, and used by BOTH the consumer (pollOnce) and the transport
 * (lib/resultsfeed.js asks the feed for exactly this set). The first version of
 * the transport computed its own pending list, which is exactly the kind of
 * duplication that goes wrong quietly: the feed is asked about markets nothing
 * will consume, or the consumer waits on markets nobody asked about, and both
 * sides look healthy while outcomes never arrive. One definition, both callers.
 *
 * ── WHY OFF TIME, AND NOT events.status = 'completed' ────────────────────────
 * This predicate used to require `e.status = 'completed'`. That made it
 * UNSATISFIABLE, and the whole automated results path was a dead control that
 * reported success forever:
 *
 *   settle.js is the ONLY writer of events.status = 'completed', and it fires
 *   only when every market on the event is already `settled`. So a completed
 *   event has no open market, and an event with an open market is never
 *   completed. No row could satisfy both halves.
 *
 * The tests hid this by hand-writing `UPDATE events SET status='completed'` —
 * manufacturing exactly the state production can never reach. So the suite was
 * green, the poll was green, and the venue settled nothing.
 *
 * Off time is the signal that actually reaches this state. It is a property of
 * the CLOCK, not of settlement: an event goes off, it does not wait for a
 * machine to agree. And it is the honest question to ask anyway — "does a
 * result for this market exist yet?" is a question about whether the race has
 * happened, not about whether we have already been told the answer.
 *
 * The comparison goes through lib/offtime.js rather than SQL string
 * comparison, because `events.starts_at` is TEXT in several formats and its
 * normalisation to UTC is the whole reason that module exists. Two answers to
 * "is this event off?" in one codebase is how a venue ends up accepting a bet
 * on a race that has already started.
 *
 * ── WHY THERE IS DELIBERATELY NO LIMIT HERE ────────────────────────────────
 * This query became live with the off-time predicate above; before that its
 * predicate was unsatisfiable and the set was always empty, so its size never
 * mattered. Now it does: on a long-running venue whose results feed has quietly
 * stopped working, every market that goes off stays in the set forever, because
 * nothing settles them.
 *
 * The obvious fix is `LIMIT`, and it is the wrong one — it drops markets
 * SILENTLY. A market outside the limit is never asked about, never settled and
 * never reported, which is the precise failure this entire path exists to
 * prevent, introduced by the fix for "the list grows". Ordering the limit so the
 * longest-waiting markets go last strands exactly those, which are the ones
 * holding a player's money; ordering them first strands whatever is behind them
 * the moment a backlog exceeds the cap. There is no ordering of a truncation
 * that is safe, because the list is not a queue anybody is draining — it is
 * everything the venue still owes money on.
 *
 * So the bound is applied one layer up, to the WIRE: lib/resultsfeed.js posts
 * the set in batches of `batchSize` and asks about every market in it, and
 * publishes `pending_last_poll` / `pending_peak` so a backlog that only grows is
 * visible rather than inferred. This function's contract is therefore that it
 * returns EVERYTHING eligible — a caller that trims it silently re-creates the
 * bug one layer out, and does it where there is no longer a batch loop to make
 * it loud.
 */
function pendingMarkets(db, { nowMs = Date.now() } = {}) {
  const rows = db
    .prepare(
      `SELECT m.id, m.name AS market_name, m.event_id,
              e.name AS event_name,
              e.starts_at,
              (SELECT group_concat(id) FROM selections WHERE market_id = m.id) AS selection_ids,
              (SELECT group_concat(name, ' | ') FROM selections WHERE market_id = m.id) AS selection_names
         FROM markets m
         JOIN events e ON e.id = m.event_id
        WHERE m.status = 'open' AND COALESCE(m.settlement_hold, 0) = 0
        ORDER BY m.id`
    )
    .all();
  const offtime = require('./offtime');
  return rows.filter((r) => {
    // FAIL-CLOSED, matching assertOffNotReached: an event whose off time is
    // missing or unparseable is treated as off. The directions differ and both
    // are deliberate — for BETTING, "cannot prove it is pre-off" must refuse;
    // for SETTLEMENT, "cannot prove it has not finished" must still ask. The
    // cost of asking about a market with no result is one row in a poll body.
    // The cost of not asking is money that never settles and nothing that says
    // so.
    const off = offtime.offTimeMs(r.starts_at);
    return off === null || nowMs >= off;
  });
}

/**
 * A poll cycle: every open, non-held market whose event has a known result.
 *
 * `fetchResults` is injected rather than hard-wired so the transport is a
 * choice — the odds recorder in lib/feed.js, a provider webhook, or a CSV
 * import — and so this is testable without a network.
 *
 * ASYNC, AND IT MUST STAY THAT WAY. This function was synchronous, and it read
 * `fetchResults(db)` without awaiting it. That was correct for the only
 * transport that existed (a synchronous local read) and silently WRONG for
 * every transport that is not one: `outcomes` was a Promise, `outcomes[id]` was
 * undefined for every market, and the cycle reported `applied: 0` having
 * applied nothing. The HTTP results feed (lib/resultsfeed.js) is exactly such a
 * transport, so wiring it would have produced a scheduled job, a green health
 * endpoint and a venue that settled nothing at all.
 *
 * That is the fifth dead control in this codebase, and the same shape as the
 * other four: something that reports and does not act. The reason it survived a
 * green suite is the reason the others did too — the injected double returned
 * a plain object, which is the one shape that hid the bug. So the shape is
 * asserted now: tests/resultsfeed.test.js T16 fails if a promise-returning
 * fetcher is ever applied as if it were a plain object again.
 */
async function pollOnce(db, fetchResults) {
  const markets = pendingMarkets(db);
  const outcomes = (await fetchResults(db)) || {};
  const results = [];
  for (const m of markets) {
    const signal = outcomes[m.id];
    if (!signal) continue; // feed has nothing for this market yet
    results.push(applyOutcome(db, m.id, signal, { source: 'poll' }));
  }
  return { considered: markets.length, applied: results.length, results };
}

/**
 * Manual release of a held market. The human path out of HOLD.
 *
 * Deliberately an EXPLICIT audited action with a mandatory reason: the whole
 * reason a dispute is held is that a machine could not decide it, so letting
 * a machine decide later would defeat the hold.
 */
function releaseHold(db, { actor, marketId, decision, winnerSelectionId, deadHeatSelectionIds, reason }) {
  if (!reason || String(reason).trim().length < 5) {
    throw Object.assign(new Error('A written reason is required to release a held market'), { status: 400 });
  }
  if (![rules.SETTLE, rules.VOID].includes(decision)) {
    throw Object.assign(new Error('decision must be settle or void'), { status: 400 });
  }
  // ── A HELD DEAD HEAT MUST BE RELEASABLE AS A DEAD HEAT ─────────────────
  // This path could only ever settle ONE selection, so a market held because a
  // dead heat was disputed — which is precisely the case a hold exists for —
  // could be released only as a single runner. The operator's alternatives were
  // both wrong: release it as one winner and a whole stake moves to one person,
  // or void it and nobody is paid. Measured: alice's backer on a joint winner
  // received +9750 instead of +4875, and the other joint winner's backer lost
  // his entire 10000 stake on a horse that TIED.
  const deadHeat = Array.isArray(deadHeatSelectionIds)
    ? [...new Set(deadHeatSelectionIds.map(Number).filter((x) => Number.isInteger(x) && x > 0))]
    : null;
  if (deadHeatSelectionIds !== undefined && deadHeatSelectionIds !== null) {
    if (decision === rules.VOID) {
      throw Object.assign(new Error('Provide either a winner, a dead_heat list, or void — not both'), { status: 400 });
    }
    if (deadHeat.length < 2) {
      throw Object.assign(new Error('dead_heat must name at least 2 distinct selection ids'), { status: 400 });
    }
  }
  if (decision !== rules.VOID && deadHeat === null && winnerSelectionId === null) {
    throw Object.assign(new Error('A settle release needs a winner_selection_id or a dead_heat list'), { status: 400 });
  }
  return transaction(db, () => {
    const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
    if (!market) throw Object.assign(new Error('Market not found'), { status: 404 });
    if (market.status === 'settled') throw Object.assign(new Error('Market already settled'), { status: 409 });
    // CLEAR THE HOLD BEFORE SETTLING. settleTx now refuses a held market —
    // the outside audit's F4 was that any caller could bypass the reasoned
    // release, so the hold is enforced in the settlement primitive itself.
    // The human decision comes first; settlement follows from it.
    db.prepare('UPDATE markets SET settlement_hold = 0, hold_reason = NULL WHERE id = ?').run(marketId);
    const r = settleMarket(
      db,
      marketId,
      decision === rules.VOID
        ? { void: true }
        : deadHeat
          ? { dead_heat: deadHeat }
          : { winner_selection_id: winnerSelectionId }
    );
    recordSource(db, {
      marketId, eventId: market.event_id, decision, rule: 'manual_release',
      reason, winners: decision === rules.VOID ? null : (deadHeat || [winnerSelectionId]), source: 'manual',
    });
    audit.record(db, actor, audit.ACTIONS.MARKET_SETTLED, `market:${marketId}`,
      { hold_reason: market.hold_reason }, { decision, reason }, reason);
    return r;
  });
}

module.exports = { applyOutcome, pollOnce, pendingMarkets, releaseHold, SOURCES };