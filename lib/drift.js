'use strict';
// lib/drift.js — gentle random-walk repricing of open selections so the
// exchange feels live without a trader sitting at the desk. The FAIR price
// moves (the bot's view); LTP only ever moves on real trades. Off in tests
// (DRIFT_ENABLED=false).
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
        // This is the hook point, and it is here for two reasons that are
        // really one: it is the ONLY place in the codebase that moves a
        // selection's price, so a rule watching this runner sees every move
        // there is, and no rule can be evaluated from a second source that
        // might lag, batch or be missed. There is no SSE fan-out to hook,
        // because an SSE client is a VIEWER — hooking it would make evaluation
        // depend on somebody having a browser tab open, which is the browser-
        // side evaluation #67 rejected.
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
