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
//     "already done", not treated as a failure. A pre-off WITHDRAWAL is not
//     settled at all — the market stays open — so it cannot lean on a terminal
//     state to be idempotent, and carries its own delivery check instead (#88).
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
const { settleMarket, voidSelection } = require('./settle');
const rules = require('./voidrules');
const audit = require('./audit');

// How the feed reached us. Recorded per outcome so a dispute can be traced to
// the transport as well as the payload.

function recordSource(db, { marketId, eventId, decision, rule, reason, winners, source, externalId, nonRunners, idSpace, feed }) {
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
    // `non_runners` joins `winners` in the payload because a withdrawal is part
    // of the evidence for the decision recorded here, and an operator asking
    // "which runner was withdrawn" months later needs it on the row rather than
    // in a log line that has already rotated.
    //
    // `id_space` is the answer to the FIRST question an operator asks when an
    // outcome looks wrong — did this feed send us its own runner ids, or ours?
    // — and it is unanswerable after the fact unless it was written at the
    // moment the signal was admitted. Omitted entirely (rather than written as
    // null) for a venue's own market, where there is only ever one space and a
    // reader of provenance should not have to tell "local" from "not checked".
    JSON.stringify({
      winners: winners ?? null,
      non_runners: nonRunners ?? null,
      ...(idSpace ? { id_space: idSpace } : {}),
      ...(feed ? { feed_market_id: feed.market_id ?? null, feed_event_id: feed.event_id ?? null, feed_provider: feed.provider ?? null } : {}),
    })
  );
}

// Already delivered under this provider id? A results feed re-delivers, and a
// PRE-OFF withdrawal cannot lean on the market's terminal `settled` state the
// way a settlement does — the market stays open, so a re-delivered notice would
// otherwise reach recordSource and violate the unique index on
// (source, source_event_id). Refusing to record provenance twice is also the
// honest answer: one withdrawal is one decision, however many times it arrives.
function alreadyApplied(db, { source, externalId }) {
  if (externalId === null || externalId === undefined) return false;
  return !!db
    .prepare('SELECT 1 FROM result_events WHERE source = ? AND source_event_id = ?')
    .get(source, String(externalId));
}

/**
 * Apply ONE outcome to ONE market.
 *
 * Returns a result object rather than throwing, because a feed processes many
 * markets and one bad one must not abort the batch. Callers collect the
 * failures and report them.
 *
 * `idSpace` and `feedRefs` are PROVENANCE only (#101): they say which id space
 * the ids in `signal` arrived in, and what the feed calls this market, and they
 * are written to the result_events row. They never change a decision — every
 * decision below is made on ids that are already LOCAL by the time they get
 * here, because `pollOnce` translates them through lib/feedcat.js first.
 */
function applyOutcome(db, marketId, signal, { source = 'poll', externalId = null, actor = null, idSpace = null, feedRefs = null } = {}) {
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (!market) return { market_id: marketId, outcome: 'not_found' };
  if (market.status === 'settled') return { market_id: marketId, outcome: 'already_settled' };

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(market.event_id);
  const sport = event
    ? db.prepare('SELECT slug FROM sports WHERE id = ?').get(event.sport_id)
    : null;
  const slug = sport ? sport.slug : null;
  // Every provenance row this function writes carries the same two extra fields,
  // so they are resolved ONCE here rather than restated at eight call sites —
  // and a call site that forgets to pass them is a provenance row that quietly
  // stops saying which id space the decision was made in.
  const provenance = { source, externalId, idSpace, feed: feedRefs };

  // ── A WITHDRAWAL NOTICE IS NOT AN OUTCOME (#88) ──────────────────────────
  // A signal that names withdrawn runners and NO status is not a race result:
  // it is a pre-off withdrawal. `ruleKey` would answer `null` for it (nothing
  // about the EVENT happened) and the market would be held as `unrecognised`,
  // which is the old behaviour — the runner stays quoted, its backers keep their
  // exposure to a horse that is never going to start, and the only exit is a
  // human. Racing venues are told about withdrawals before the off, and the
  // correct response is to remove that ONE runner and refund its backers while
  // the rest of the market keeps trading.
  //
  // It is handled before `resolve` on purpose: there is no market-level decision
  // to make here at all, so putting it in the rules table would be inventing an
  // outcome the feed did not report. The one thing this path must still ask the
  // rules table is whether the sport has a meaning for a withdrawn runner.
  if (typeof (signal && signal.status) !== 'string' && Array.isArray(signal && signal.non_runners) && signal.non_runners.length > 0) {
    return applyWithdrawal(db, market, { event, slug, signal, provenance, actor });
  }

  const decision = rules.resolve(slug, signal);

  if (decision.decision === rules.HOLD) {
    // Recorded, escalated, and NOT settled. The market stays open so the
    // player still holds a real position — holding is not the same as voiding.
    transaction(db, () => {
      recordSource(db, {
        marketId, eventId: event ? event.id : null, decision: 'hold', rule: decision.rule,
        reason: decision.reason, winners: null, ...provenance,
      });
      db.prepare("UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?").run(decision.reason, marketId);
    });
    return { market_id: marketId, outcome: 'held', rule: decision.rule, reason: decision.reason };
  }

  // Winners must belong to THIS market. Settling a winner id from another
  // market would credit the wrong selection, and settleMarket's own check is
  // the last line of defence — so validate here and refuse cleanly.
  let winners = decision.winners;
  // The selections this outcome declares WITHDRAWN. Empty for every decision
  // that is not `settle_with_voids` (#88), which is the shape every caller
  // written before this fix expects.
  let voidedSelections = decision.voided_selections || [];
  // Declared out here, not inside the block below: the settle call that uses it
  // sits after the block, so a block-scoped const would only resolve by
  // short-circuit luck on the void path.
  let isDeadHeat = false;
  // A SETTLE_WITH_VOIDS is a settlement: it has a winner, and the winner must be
  // paid. It is grouped with SETTLE rather than special-cased because the two
  // differ by what happens to the withdrawn SELECTION, not by what happens to
  // the market.
  const settles = decision.decision === rules.SETTLE || decision.decision === rules.SETTLE_WITH_VOIDS;
  if (settles) {
    const inMarket = new Set(
      db.prepare('SELECT id FROM selections WHERE market_id = ?').all(marketId).map((r) => r.id)
    );
    winners = winners.filter((w) => inMarket.has(w));
    if (winners.length === 0) {
      transaction(db, () => {
        recordSource(db, {
          marketId, eventId: event ? event.id : null, decision: 'hold', rule: decision.rule,
          reason: 'No supplied winner belongs to this market; held for review', winners: null, ...provenance,
        });
        db.prepare("UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?")
          .run('No supplied winner belongs to this market; held for review', marketId);
      });
      return { market_id: marketId, outcome: 'held', rule: decision.rule, reason: 'winner not in market' };
    }
    // A withdrawn selection id must belong to this market for the same reason a
    // winner id does: the id is the instruction to move money, and a foreign one
    // is a feed that answered a different question. Held rather than partly
    // applied — voiding the subset we recognise would leave the rest of the
    // feed's answer unapplied and the market half-refunded.
    const foreign = voidedSelections.filter((x) => !inMarket.has(x));
    if (foreign.length > 0) {
      const reason = `Outcome declared a withdrawn runner that is not in this market (${foreign.join(', ')}); held for review`;
      transaction(db, () => {
        recordSource(db, {
          marketId, eventId: event ? event.id : null, decision: 'hold', rule: decision.rule,
          reason, winners: null, ...provenance, nonRunners: voidedSelections,
        });
        db.prepare('UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?').run(reason, marketId);
      });
      return { market_id: marketId, outcome: 'held', rule: decision.rule, reason: 'withdrawn runner not in market' };
    }
    // A WINNER THAT IS ALSO A DECLARED NON-RUNNER IS A CONTRADICTION, and both
    // halves of it cost money: paying the withdrawn runner's backers means
    // inventing a result for a horse that did not start, and voiding the winner
    // means not paying the runners that did finish. Refused here, where the
    // signal is still readable, rather than downstream.
    const contradiction = winners.filter((w) => voidedSelections.includes(w));
    if (contradiction.length > 0) {
      const reason = `Outcome names the same selection as both a winner and a withdrawn runner (${contradiction.join(', ')}); held for review`;
      transaction(db, () => {
        recordSource(db, {
          marketId, eventId: event ? event.id : null, decision: 'hold', rule: decision.rule,
          reason, winners, ...provenance, nonRunners: voidedSelections,
        });
        db.prepare('UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?').run(reason, marketId);
      });
      return { market_id: marketId, outcome: 'held', rule: decision.rule, reason: 'winner declared a non-runner' };
    }
    // A PLACE MARKET CANNOT BE SETTLED WITH A WITHDRAWAL APPLIED (#88). Its
    // payout depends on a finishing position and its distribution CHANGES when a
    // runner is withdrawn, which this engine cannot compute — it has one payout
    // shape and computes that one. Voiding the runner and paying a 'winner'
    // would be arithmetically wrong for every place bettor in the market, and
    // conservation would balance it exactly as happily.
    //
    // So the venue says so out loud, in the hold reason and in the provenance
    // row, instead of quietly computing the wrong number. This is the whole of
    // "handle place markets": a declared, audited refusal, with #95 (no market
    // types) tracking the modelling that would remove the need for it.
    if (voidedSelections.length > 0 && market.payout_shape === 'place') {
      const reason = 'A place market changes its payout distribution when a runner is withdrawn, which this engine cannot compute; held for review';
      transaction(db, () => {
        recordSource(db, {
          marketId, eventId: event ? event.id : null, decision: 'hold', rule: decision.rule,
          reason, winners: null, ...provenance, nonRunners: voidedSelections,
        });
        db.prepare('UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?').run(reason, marketId);
      });
      return { market_id: marketId, outcome: 'held', rule: decision.rule, reason: 'place market cannot be settled with a withdrawal' };
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
          winners, ...provenance,
        });
        db.prepare('UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?')
          .run('Outcome named multiple winners under a single-winner rule; held for review', marketId);
      });
      return { market_id: marketId, outcome: 'held', rule: decision.rule, reason: 'multiple winners under a single-winner rule' };
    }
    if (isDeadHeat && winners.length < 2) {
      transaction(db, () => {
        recordSource(db, {
          marketId, eventId: event ? event.id : null, decision: 'hold', rule: decision.rule,
          reason: 'Dead heat must name at least two joint winners; held for review', winners, ...provenance,
        });
        db.prepare('UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?')
          .run('Dead heat must name at least two joint winners; held for review', marketId);
      });
      return { market_id: marketId, outcome: 'held', rule: decision.rule, reason: 'underspecified dead heat' };
    }
  }

  try {
    // settleMarket refuses a non-boolean void and an already-settled market;
    // both are legitimate here rather than bugs, so the 409 is absorbed.
    const res = transaction(db, () => {
      // THE WITHDRAWN RUNNERS GO FIRST, AND IN THE SAME TRANSACTION. The refund
      // and the settlement have to be one unit of work: a crash between them
      // would leave a runner marked void with its backers un-refunded (money
      // stranded), or the reverse (a bettor charged on a horse that never
      // started, which is the defect this exists to close). Ordering matters too
      // — voidSelection() sets selections.status = 'void', and aggregateMatches
      // skips voided selections, so the legs it refunded must not then be
      // settled a second time.
      const withdrawal = voidedSelections.length
        ? voidSelection(db, marketId, voidedSelections, {
          actor,
          reason: `${decision.reason} (runner declared a non-runner before the off)`,
        })
        : null;
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
        marketId, eventId: event ? event.id : null, decision: decision.decision === rules.VOID ? 'void' : 'settle',
        rule: decision.rule,
        reason: decision.reason,
        winners: decision.voided ? null : winners, ...provenance,
        nonRunners: voidedSelections.length ? voidedSelections : null,
      });
      return withdrawal ? { ...r, withdrawal } : r;
    });
    return {
      market_id: marketId,
      outcome: decision.decision === rules.VOID ? 'voided' : 'settled',
      rule: decision.rule,
      // Reported so a caller does not have to re-read the selections to learn
      // which runners left the book.
      voided_selections: voidedSelections,
      result: res,
    };
  } catch (e) {
    // 409 = already settled (a concurrent feed delivery won the race). That is
    // the idempotent path, not a failure.
    if (e && e.status === 409) return { market_id: marketId, outcome: 'already_settled' };
    throw e;
  }
}

/**
 * A PRE-OFF WITHDRAWAL: remove one runner, refund its backers, keep the market
 * trading (#88).
 *
 * Separate from `applyOutcome`'s settlement path because the market is NOT
 * resolved. Nothing is settled, so there is no winner to pick and no `settleTx`
 * to call — only `voidSelection`, which is the whole of what a withdrawal means
 * for a selection.
 *
 * The refusals are as much of the function as the action:
 *
 *   - a sport whose rules declare no meaning for a withdrawn runner is HELD,
 *     because applying a racing concept to a football fixture would be inventing
 *     a rule, and doing nothing would leave a player exposed on a runner the feed
 *     says did not start;
 *   - a withdrawal naming no selection of THIS market is HELD, for the same
 *     reason a foreign winner is;
 *   - a withdrawal naming SOME of this market's selections acts on those and
 *     records the foreign ids in the audit row, because the instruction is
 *     unambiguous for the ones it does name.
 *
 * `result_events.decision` is 'void' — the provenance table's vocabulary is
 * closed to settle/void/hold, and 'void' is the true description of what
 * happened to the selection. `rule` says which: `non_runner` names the rule
 * rather than a market-level outcome, which is what an operator filtering
 * settlements by rule needs to tell them apart.
 */
function applyWithdrawal(db, market, { event, slug, signal, provenance, actor }) {
  const marketId = market.id;
  const hold = (rule, reason) => {
    transaction(db, () => {
      recordSource(db, {
        marketId, eventId: event ? event.id : null, decision: 'hold', rule,
        reason, winners: null, ...provenance, nonRunners: rules.declaredNonRunners(signal),
      });
      db.prepare('UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?').run(reason, marketId);
    });
    return { market_id: marketId, outcome: 'held', rule, reason };
  };

  if (!rules.declaresNonRunners(slug)) {
    return hold(
      'non_runner_unspecified',
      `Sport "${slug === null ? 'unknown' : slug}" does not model withdrawn runners; withdrawal notice held for review`
    );
  }
  const declared = rules.declaredNonRunners(signal);
  if (declared.length === 0) {
    // Malformed ids only (booleans, strings, zeros). Dropping them is the whole
    // response: there is no runner the feed usefully named, so there is nothing
    // to remove. Recorded nowhere, because a withdrawal of nothing is not a fact
    // about the market.
    return { market_id: marketId, outcome: 'ignored', rule: 'non_runner', reason: 'no usable selection ids in the withdrawal notice' };
  }
  const inMarket = new Set(
    db.prepare('SELECT id FROM selections WHERE market_id = ?').all(marketId).map((r) => r.id)
  );
  const targets = declared.filter((x) => inMarket.has(x));
  const foreign = declared.filter((x) => !inMarket.has(x));
  if (targets.length === 0) {
    return hold(
      'non_runner_foreign',
      `Withdrawal notice names no selection of this market (${declared.join(', ')}); held for review`
    );
  }
  // A RE-DELIVERY IS A NO-OP. A feed that sends the same notice twice must not
  // refund twice, and must not collide with the unique provenance index either.
  //
  // For a MATERIALISED market this is the guard that actually fires, and it only
  // fires because `pollOnce` passes the feed's own id as `externalId`. A
  // withdrawal is a pre-off notice for a market that STAYS OPEN, so it has no
  // terminal state to lean on the way a settled market has — and before #101
  // `externalId` was null on every polled signal, so this branch was
  // unreachable from the transport and the index it guards never fired.
  if (alreadyApplied(db, { source: provenance.source, externalId: provenance.externalId })) {
    return { market_id: marketId, outcome: 'already_applied', rule: 'non_runner', voided_selections: targets };
  }
  const reason = `Runner declared a non-runner before the off (${provenance.source}${provenance.externalId ? ` ${provenance.externalId}` : ''})`;
  const result = transaction(db, () => {
    const r = voidSelection(db, marketId, targets, { actor, reason });
    recordSource(db, {
      marketId, eventId: event ? event.id : null, decision: 'void', rule: 'non_runner',
      reason: `${reason}; ${targets.length} selection(s) removed, market left open`,
      winners: null, ...provenance,
      nonRunners: foreign.length ? [...targets, ...foreign] : targets,
    });
    return r;
  });
  return {
    market_id: marketId,
    outcome: 'withdrawn',
    rule: 'non_runner',
    voided_selections: result.voided_selections,
    // Ids the feed named that belong to some other market, reported so a
    // mis-configured feed is visible rather than silently half-applied.
    ignored_selections: foreign,
    result,
  };
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
  const pending = rows.filter((r) => {
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
  // THE FEED'S IDS FOR THESE MARKETS (#101), attached here rather than in each
  // caller because BOTH callers need them and because one definition is the
  // whole point of this module's exports:
  //
  //   lib/resultsfeed.js requestBody — the wire, so an operator's results API can
  //     recognise the market it is being asked about at all;
  //   pollOnce below — the inbound direction, so an outcome naming the feed's
  //     runner ids is translated before anything reads them.
  //
  // They ride on the row rather than being a second query per consumer, because
  // `feed_refs` is a property of the market, not of the caller asking about it.
  // For every market that was never materialised — which is every market on a
  // venue that has never run a sync, and every market the venue created itself —
  // the field is absent and everything below treats the venue's own ids as the
  // only space, which is exactly the behaviour that predates #101.
  const refs = require('./feedcat').externalRefs(db, pending.map((r) => r.id));
  for (const r of pending) {
    const ref = refs.get(r.id);
    if (ref) r.feed_refs = ref;
  }
  return pending;
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
  const feedcat = require('./feedcat');
  const results = [];
  for (const m of markets) {
    const signal = outcomes[m.id];
    if (!signal) continue; // feed has nothing for this market yet
    // ── THE ID-SPACE BOUNDARY (#101) ────────────────────────────────────────
    // Everything below — `rules.resolve`, `applyOutcome`, `applyWithdrawal` —
    // reads ids as LOCAL selection ids, and that has always been true of this
    // function's inputs. A materialised market breaks the assumption the moment
    // it exists: the feed's runner ids are its own (Betfair reuses them across
    // markets), and an outcome naming them reaches `inMarket.has(w)` as false
    // for every winner. The failure is fail-safe and operationally fatal at
    // once: `hold('non_runner_foreign')`, then the empty-winner HOLD branch, so
    // nothing settles, the withdrawn runner stays quoted, and real money sits in
    // a held market.
    //
    // So the translation happens HERE, at the point the signal is ADMITTED, and
    // never deeper in. Down there an id that cannot be translated would be
    // indistinguishable from an id that does not belong to the market, which is
    // the one distinction this boundary exists to keep.
    const admitted = feedcat.admitSignal(m.feed_refs || null, signal);
    if (!admitted.ok) {
      results.push(holdUnmappedId(db, m, signal, admitted));
      continue;
    }
    // THE RE-DELIVERY GUARD, applied before the work rather than inside it. A
    // materialised market's signal now carries the feed's own id, and
    // `idx_result_events_source` is UNIQUE on (source, source_event_id) — so a
    // second delivery of a signal that was already RECORDED (a hold, or a
    // withdrawal that could not be applied) would otherwise reach the INSERT and
    // throw, which `pollNow` reports as a consumer failure. A feed that repeats
    // itself is normal, not an error.
    if (admitted.external_id && alreadyApplied(db, { source: 'poll', externalId: admitted.external_id })) {
      results.push({ market_id: m.id, outcome: 'already_applied', rule: 'id_space', id_space: admitted.id_space });
      continue;
    }
    results.push(applyOutcome(db, m.id, admitted.signal, {
      source: 'poll',
      // THE FEED'S ID, for the reasons in lib/feedcat.js admitSignal: it is the
      // only value a re-delivery repeats, and the market's id is strictly finer
      // grained than the event's, so it can never make a DIFFERENT market's
      // outcome read as a repeat of this one.
      externalId: admitted.external_id || null,
      idSpace: admitted.id_space,
      feedRefs: admitted.refs,
    }));
  }
  return { considered: markets.length, applied: results.length, results };
}

/**
 * HOLD a market whose outcome named an id this venue cannot place.
 *
 * The same shape every other hold in this module has: recorded in
 * `result_events` with the rule that fired, `settlement_hold` raised with a
 * reason a human can act on, and the market left OPEN — because a player still
 * holds a position in it, and holding is not the same as voiding.
 *
 * THE THREE REASONS, and none of them is "we did not understand it":
 *   id_space_unmapped   the id is in neither space for this market. Overwhelmingly
 *                       a feed describing a market this venue does not have, or
 *                       one whose catalogue row was never materialised.
 *   id_space_ambiguous  the id resolves to a DIFFERENT selection in each space,
 *                       so settling it is a coin flip on somebody's money.
 *   signal_absent       no signal at all, which is a fault in the caller rather
 *                       than in the feed.
 *
 * The reason names the raw id, because "an outcome was held" is not actionable
 * and "outcome named 58805, which this market does not have" is.
 */
function holdUnmappedId(db, market, signal, admitted) {
  const reason = admitted.rule === 'id_space_ambiguous'
    ? `Outcome id ${admitted.raw} names a different selection in the feed's id space and in this venue's; held for review`
    : admitted.rule === 'signal_absent'
      ? 'A result was delivered for this market carrying no outcome at all; held for review'
      : `Outcome id ${admitted.raw} belongs to neither id space of this market; held for review`;
  const event = db.prepare('SELECT event_id FROM markets WHERE id = ?').get(market.id);
  const declared = (signal && Array.isArray(signal.winners) ? signal.winners : []).concat(
    signal && Array.isArray(signal.non_runners) ? signal.non_runners : []
  );
  transaction(db, () => {
    recordSource(db, {
      marketId: market.id,
      eventId: event ? event.event_id : null,
      decision: 'hold',
      rule: admitted.rule,
      reason,
      winners: null,
      source: 'poll',
      externalId: null,
      // The ids are recorded AS SENT, in the feed's space. A translated signal
      // would carry local ids, and a provenance row that could not tell an
      // operator which space the feed used is the row that cannot be defended.
      nonRunners: declared.length ? declared : null,
      feed: admitted.refs || null,
    });
    db.prepare('UPDATE markets SET settlement_hold = 1, hold_reason = ? WHERE id = ?').run(reason, market.id);
  });
  return { market_id: market.id, outcome: 'held', rule: admitted.rule, reason, id_space: 'unmapped' };
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
  // DE-DUPLICATED AND NOTHING ELSE. The list used to go through
  // `.map(Number).filter(Number.isInteger && > 0)`, which undid exactly what
  // lib/settle.js was hardened against: `Number(true) === 1`, so `[true, 2]`
  // became `[1, 2]` and settled a valid joint favourite. The route above this
  // one says the list is passed through UNCHANGED "so a coerced id must never
  // pick an outcome here", and that was aspirational until now.
  //
  // The `.filter` was not a safety net either — it is worse. It SILENTLY DROPS
  // the malformed element, so `[1, 2, true]` still passed the length check
  // below and settled as a two-winner dead heat with the `true` quietly
  // discarded. Repairing a malformed request is not the same as refusing it:
  // this is the hold-release path, where the audit row records the outcome as
  // though the operator had chosen it deliberately.
  //
  // So the ids go through UNCHANGED and lib/settle.js — which refuses a
  // non-integer, a boolean and a quoted string outright — does the rejecting.
  const deadHeat = Array.isArray(deadHeatSelectionIds) ? [...new Set(deadHeatSelectionIds)] : null;
  if (deadHeatSelectionIds !== undefined && deadHeatSelectionIds !== null) {
    if (decision === rules.VOID) {
      throw Object.assign(new Error('Provide either a winner, a dead_heat list, or void — not both'), { status: 400 });
    }
    // A dead_heat that is not an array cannot be described by the pattern above,
    // so `deadHeat` is null and `deadHeat.length` would throw a TypeError —
    // a 500 on the release route rather than the 400 this is. Caught here.
    if (!Array.isArray(deadHeatSelectionIds)) {
      throw Object.assign(new Error('dead_heat must be an array of at least 2 distinct selection ids'), { status: 400 });
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

module.exports = { applyOutcome, pollOnce, pendingMarkets, releaseHold, alreadyApplied };