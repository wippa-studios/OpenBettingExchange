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
    // Multi-winner (a dead heat that pays) is not modelled by settleMarket,
    // which settles exactly one selection. Refuse rather than silently paying
    // the first one and stranding the other.
    if (winners.length > 1) {
      transaction(db, () => {
        recordSource(db, {
          marketId, eventId: event ? event.id : null, decision: 'hold', rule: decision.rule,
          reason: 'Multiple winners are not modelled by this engine; held for review', winners, source, externalId,
        });
        db.prepare("UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?")
          .run('Multiple winners are not modelled by this engine; held for review', marketId);
      });
      return { market_id: marketId, outcome: 'held', rule: decision.rule, reason: 'multiple winners' };
    }
  }

  try {
    // settleMarket refuses a non-boolean void and an already-settled market;
    // both are legitimate here rather than bugs, so the 409 is absorbed.
    const res = transaction(db, () => {
      const r = settleMarket(db, marketId, decision.voided ? { void: true } : { winner_selection_id: winners[0] });
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
 * A poll cycle: every open, non-held market whose event has a known result.
 *
 * `fetchResults` is injected rather than hard-wired so the transport is a
 * choice — the odds recorder in lib/feed.js, a provider webhook, or a CSV
 * import — and so this is testable without a network.
 */
function pollOnce(db, fetchResults) {
  const markets = db
    .prepare(
      `SELECT m.id FROM markets m
         JOIN events e ON e.id = m.event_id
        WHERE m.status = 'open' AND COALESCE(m.settlement_hold, 0) = 0
          AND e.status = 'completed'`
    )
    .all();
  const outcomes = fetchResults(db) || {};
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
function releaseHold(db, { actor, marketId, decision, winnerSelectionId, reason }) {
  if (!reason || String(reason).trim().length < 5) {
    throw Object.assign(new Error('A written reason is required to release a held market'), { status: 400 });
  }
  if (![rules.SETTLE, rules.VOID].includes(decision)) {
    throw Object.assign(new Error('decision must be settle or void'), { status: 400 });
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
    const r = settleMarket(db, marketId, decision === rules.VOID ? { void: true } : { winner_selection_id: winnerSelectionId });
    recordSource(db, {
      marketId, eventId: market.event_id, decision, rule: 'manual_release',
      reason, winners: decision === rules.VOID ? null : [winnerSelectionId], source: 'manual',
    });
    audit.record(db, actor, audit.ACTIONS.MARKET_SETTLED, `market:${marketId}`,
      { hold_reason: market.hold_reason }, { decision, reason }, reason);
    return r;
  });
}

module.exports = { applyOutcome, pollOnce, releaseHold, SOURCES };