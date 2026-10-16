'use strict';
// lib/drift.js — gentle random-walk repricing of open selections so the
// exchange feels live without a trader sitting at the desk. The FAIR price
// moves (the bot's view); LTP only ever moves on real trades. Off in tests
// (DRIFT_ENABLED=false), and FORCE-OFF while the licensed feed is on, which is
// deliberate — a random walk must not reprice a book whose prices it cannot see.
//
// WHAT THIS MODULE IS NOT (#87). It is not the user's-rules engine; it is ONE of
// the two places the venue's own price moves, and it calls into
// `lib/userrules.js`. It used to be described as "the ONLY place in the codebase
// that moves a selection's price", which was true of `fair_price` and was read as
// a claim about the engine — so with the feed on (and therefore drift off) user
// rules silently stopped firing anywhere in the venue. The long version of that
// failure is at the `userrules.evaluateSelection` call below; the short version
// is that a control placed inside a disabled feature is not a control.
const { nextTick, prevTick } = require('./odds');
const { transaction } = require('./tx');
const bots = require('./bots');
const userrules = require('./userrules');

function tick(db, broadcast) {
  try {
    const sel = db
      .prepare(
        `SELECT s.* FROM selections s JOIN markets m ON m.id = s.market_id
         WHERE m.status = 'open' AND s.status = 'open' AND s.fair_price IS NOT NULL
         ORDER BY RANDOM() LIMIT 1`
      )
      .get();
    if (!sel) return;
    const p = sel.fair_price;
    // Random walk, clamped at the ladder extremes.
    const up = p <= 1.02 ? true : p >= 990 ? false : Math.random() < 0.5;
    const next = up ? nextTick(p) : prevTick(p);
    if (next !== p) {
      // ONE transaction for the price move AND the requote it triggers: a
      // requote that fails partway (e.g. the bot's bank running short at a
      // very high price) must not leave fair_price moved while the ladder
      // still quotes the old price — the two would disagree until something
      // else hit the selection. requoteSelection nests as a SAVEPOINT inside.
      transaction(db, () => {
        db.prepare('UPDATE selections SET fair_price = ? WHERE id = ?').run(next, sel.id);
        // ── WHERE USER RULES ARE EVALUATED (#76) ──────────────────────────
        //
        // WHAT THE COMMENT HERE USED TO CLAIM, AND WHAT HAPPENED TO IT. It read:
        //
        //   "This is the hook point, and it is here for two reasons that are
        //    really one: it is the ONLY place in the codebase that moves a
        //    selection's price, so a rule watching this runner sees every move
        //    there is."
        //
        // The REASONING was right and is preserved: evaluate where the price is
        // WRITTEN, never from a second reader that might lag, batch or be missed.
        // Both production call sites still satisfy that — see the block above
        // `evaluateSelection` in lib/userrules.js, and lib/match.js's
        // `recordTrades` for the other one.
        //
        // The CLAIM was wrong, and it was wrong in the way this repository has
        // been bitten six times now (STATE.md §5). It was a statement about a
        // WRITE SITE and it was read — by the next reader, and by the test suite
        // — as a statement about the ENGINE. `lib/drift.js` is not the engine;
        // it is one caller, and this function is only ever STARTED when `DRIFT_ON`
        // holds, which is `config.DRIFT_ENABLED && !config.FEED_ENABLED`. So on
        // any venue running a licensed feed, user rules could not be evaluated at
        // all: no order placed, nothing thrown, nothing logged, and the rule row
        // still reading `armed=1`. Nobody checked the claim against whether the
        // path CONTAINING it can run, and the suite was green throughout because
        // `tests/userrules.test.js` calls `evaluateSelection` directly — which
        // bypasses the gate entirely, and is exactly the configuration that hides
        // the defect (#87).
        //
        // WHAT REPLACED IT. Evaluation is no longer a property of the drift
        // engine. It is a property of the VENUE'S OWN PRICE, and it is called
        // from both places that price moves: here (the price walk) and from
        // `lib/match.js`'s `recordTrades` (a real crossing). Neither call site is
        // behind a configuration gate, so a rule works with the feed on and with
        // it off, and the drift gate is free to stay exactly where
        // server.js puts it.
        //
        // The SSE stream is still NOT the hook, and the original comment's
        // reasoning for refusing it stands: an SSE client is a VIEWER, so hooking
        // there would make evaluation depend on somebody having a browser tab
        // open — the browser-side evaluation #67 rejected.
        //
        // It runs inside this transaction, deliberately. The price move, the
        // rule's new observation and any order it placed have to commit
        // together: a price move that rolled back must not leave a rule armed
        // against a price that never existed, or it fires on the next move on a
        // belief the venue no longer holds.
        //
        // BEFORE requoteSelection, not after. The bot's ladder is the house's
        // answer to this price move; a rule crossing the threshold is the
        // player's answer to it. The player's order is placed against the book
        // as it stood BEFORE the desk reacted to the same move, which is the
        // price the player was actually looking at.
        //
        // evaluateSelection never throws: a refusal is caught per rule, recorded
        // on the rule and counted. One user's broken rule must not stop the
        // price move or the other two rules.
        userrules.evaluateSelection(db, sel.id, next);
        // Only the moved runner's ladders are requoted (keeps the order churn
        // proportional to one price move, not to the size of the market).
        bots.requoteSelection(db, sel.id);
      });
      if (broadcast) broadcast('book', { market_id: sel.market_id });
    }
  } catch (e) {
    console.error('[drift]', e.message);
  }
}

function startDrift(db, { intervalMs = 5000, broadcast = null } = {}) {
  const timer = setInterval(() => tick(db, broadcast), intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { startDrift, tick };
