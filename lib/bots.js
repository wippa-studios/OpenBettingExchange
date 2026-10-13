'use strict';
// lib/bots.js — MarketMakers liquidity bot: quotes a ~3-tick spread around
// each selection's fair price so the exchange is always tradeable, even with
// no other users. Bot orders are ordinary rows; the engine treats all users
// identically (self-match guard keeps the bot's own two sides apart).
const A = require('./auth');
const M = require('./match');
const { escrowFor } = M; // the ONE escrow formula (lib/match.js exports it)
const { transaction } = require('./tx');
const { nextTick, prevTick } = require('./odds');
const config = require('./config');
const risk = require('./risk');

// Shared definition of the house counterparty bot. lib/seed.js imports these
// so the seeded demo and the quoter can never disagree about the bot's
// identity, bank or credentials.
const BOT_USERNAME = 'MarketMakers';
// A CONSTANT, documented-non-secret placeholder. The bot never logs in —
// auth.js rejects every login attempt on an is_bot account with the same
// 401 as an unknown user — so the per-boot random password this used to be
// bought nothing (it only made the seeded hash irreproducible).
const BOT_PASSWORD = 'bot-account-password-never-usable';
const BOT_BANK_CENTS = 100000000; // $1M paper bank

// The house account's password hash, derived OFF the event loop and memoised.
//
// ensureBot() is called from inside transactions (lib/settle.js's cash-out,
// lib/cashoutrisk.js's buyout settlement) and from the bot quoting loop, so it
// CANNOT await — lib/tx.js's transaction() commits the instant its callback
// returns, and an await inside would end the transaction early. Rather than
// reintroduce a blocking scryptSync on those paths, the one hash this account
// can ever need is derived once, asynchronously, by primeBotHash(); ensureBot
// then only ever performs the INSERT.
//
// primeBotHash() is idempotent and safe to call from anywhere. lib/seed.js
// awaits it before opening its transaction, which is what guarantees the hash
// is ready before any ensureBot() call in a seeded venue.
let botHash = null;
let botHashPromise = null;
function primeBotHash() {
  if (!botHashPromise) {
    botHashPromise = A.hashPassword(BOT_PASSWORD).then((h) => {
      botHash = h;
      return h;
    });
  }
  return botHashPromise;
}

// Synchronous on purpose — see above. Creates the house account when absent,
// which requires a hash that was primed beforehand.
function ensureBot(db) {
  let bot = db.prepare('SELECT * FROM users WHERE is_bot = 1 ORDER BY id LIMIT 1').get();
  if (!bot) {
    if (!botHash) {
      throw new Error(
        'bots.ensureBot: the house account is absent and its password hash has not been primed — ' +
          'await bots.primeBotHash() first (lib/seed.js does)'
      );
    }
    A.createAccountSync(db, {
      username: BOT_USERNAME,
      password: BOT_PASSWORD,
      passHash: botHash,
      is_bot: 1,
      balance_cents: BOT_BANK_CENTS,
    });
    bot = db.prepare('SELECT * FROM users WHERE is_bot = 1 ORDER BY id LIMIT 1').get();
  }
  return bot;
}

function size() {
  return 3000 + Math.floor(Math.random() * 17000); // $30-$200 per level
}

function ticksAway(price, k, up) {
  let p = price;
  for (let i = 0; i < k; i++) p = up ? nextTick(p) : prevTick(p);
  return p;
}

// Cancel the bot's open orders in one market/selection. The MATCHED part's
// liability stays frozen for settlement; the unmatched remainder's escrow is
// released.
//
// This DELEGATES to lib/match.js's cancelOrder rather than repeating the
// work, and that is the whole point. The previous version re-derived the
// escrow from the formula instead of releasing the TRACKED column, and never
// zeroed orders.frozen_cents — so a cancelled row kept claiming collateral the
// wallet no longer held. Its own comment denied the thing it was doing ("never
// a re-derived copy of the formula"), which is how a wrong invariant survives
// review. It also made bots.js a SECOND writer of orders.frozen_cents, which
// tests/guard.test.js exists to prevent; delegating removes the second writer
// instead of widening the allowlist to admit it.
//
// No reader joins cancelled rows today — marketLiability, openOrdersFor and
// autoCancelOpenOrders all filter status='open' — so no balance is wrong yet.
// That is the reason to fix it now rather than later: "cancelled implies
// frozen_cents = 0" holds only by the accident that nobody has written the
// query that would catch a violation, and the next aggregate over orders
// (a desk liability report, a per-user exposure view, a reconcile check that
// forgets the status filter) double-counts the bot's collateral.
function cancelBotOrders(db, rows, marketId) {
  for (const o of rows) {
    // cancelOrder releases exactly the tracked remainder escrow and zeroes the
    // column, in one place, for every caller. Its own transaction() nests here
    // as a SAVEPOINT (lib/tx.js), which is safe and costs nothing.
    M.cancelOrder(db, { id: o.user_id }, o.id);
  }
}

// Quote a ~3-tick spread around a selection's fair price: lay offers ABOVE
// fair (users back into them), back offers BELOW fair (users lay into them).
//
// `skew` widens BOTH sides AWAY from fair — lays go higher, backs go lower.
// That is the Phase 2 "skew before stop" behaviour: as the bot's risk
// pressure rises it stops being the sharpest thing in the book, so sharp
// bettors stop selecting it and the bleed slows BEFORE the hard cap is hit.
// Widening only one side would still leave the bot the best counterparty on
// the other, which is no mitigation at all.
function quoteSpread(db, bot, sel, skew = 0) {
  const F = sel.fair_price;
  for (let k = 1; k <= 3; k++) {
    M.placeOrderTx(db, bot, { selection_id: sel.id, side: 'lay', price: ticksAway(F, k + skew, true), stake_cents: size() });
  }
  for (let k = 1; k <= 3; k++) {
    M.placeOrderTx(db, bot, { selection_id: sel.id, side: 'back', price: ticksAway(F, k + skew, false), stake_cents: size() });
  }
}

// Risk defaults for a bot that has no risk_bots row yet.
function riskDefaults() {
  return {
    max_liability_cents: config.RISK_MAX_LIABILITY_CENTS,
    max_daily_loss_cents: config.RISK_MAX_DAILY_LOSS_CENTS,
    quote_skew: config.RISK_QUOTE_SKEW,
  };
}

/**
 * Skew (in ticks) for this bot right now, or null when it must not quote.
 * Returns 0 for a bot with no loss pressure, so a healthy desk is unchanged.
 */
function skewFor(db, bot) {
  return risk.skewTicks(db, bot.id, riskDefaults(), config.RISK_MAX_SKEW_TICKS);
}

/**
 * Pull every bot quote across the whole venue, in ONE transaction.
 * Deliberately separate from the kill switch: killing the desk stops NEW
 * quotes, but quotes already resting are promises the book has seen. This
 * cancels them and releases their escrow, which is a real, visible withdrawal
 * of liquidity and must be an explicit operator decision.
 *
 * `actor` and `reason` are MANDATORY, and the audit row is written in the same
 * transaction as the cancellation — so a withdrawal can never exist without a
 * record of who did it and why. This function used to write NO audit row at
 * all (`grep -c audit lib/bots.js` returned 0) while the UI prompted for a
 * reason and sent it, and the route discarded the body. For the one control
 * that removes every resting quote in the venue and frees real escrow, "who
 * pulled the quotes, and what did it free?" was unanswerable months later.
 *
 * The row carries the cancelled count and the released cents, because those
 * are what an operator reviewing the desk later actually wants to know — a
 * liquidity event with no size recorded is a liquidity event nobody can reason
 * about.
 *
 * It is recorded under the existing RISK_KILL_SWITCH action with a distinct
 * `desk:risk/quotes` target rather than a new free-text action string. lib/
 * audit.js keeps its action vocabulary deliberately closed ("a typo cannot
 * invent a new category") and is being edited concurrently in another worktree,
 * so inventing an action here would be the worse of the two faults. A dedicated
 * `RISK_QUOTES_WITHDRAWN` constant belongs in that table; until it is added
 * there, both desk controls are findable by target.
 */
function withdrawAll(db, { actor, reason } = {}) {
  const audit = require('./audit');
  const why = risk.reasonOr400(reason, 'withdraw every bot quote');
  return transaction(db, () => {
    const bot = db.prepare('SELECT id FROM users WHERE is_bot = 1 ORDER BY id LIMIT 1').get();
    if (!bot) return { cancelled_orders: 0, released_cents: 0 };
    const open = db.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'open'").all(bot.id);
    let released = 0;
    for (const o of open) {
      const esc = escrowFor(o.side, o.price, o.stake_cents - o.matched_cents);
      if (esc > 0) released += esc;
      cancelBotOrders(db, [o], o.market_id);
    }
    audit.record(
      db,
      actor,
      audit.ACTIONS.RISK_KILL_SWITCH,
      'desk:risk/quotes',
      { resting_bot_quotes: open.length },
      { cancelled_orders: open.length, released_cents: released },
      why
    );
    return { cancelled_orders: open.length, released_cents: released };
  });
}

// Requote ONE market's bot ladders around the current fair prices
// (cancel + replace, so bots follow drift without crossing the spread).
function quoteMarket(db, marketId) {
  // Market-status guard, mirroring requoteSelection below: only an OPEN
  // market gains fresh bot quotes. Checked before ensureBot so quoting a
  // non-open market neither places orders nor mints the bot account.
  const market = db.prepare('SELECT status FROM markets WHERE id = ?').get(marketId);
  if (!market || market.status !== 'open') return;
  const bot = ensureBot(db);
  const sels = db
    .prepare("SELECT * FROM selections WHERE market_id = ? AND status = 'open' AND fair_price IS NOT NULL")
    .all(marketId);
  transaction(db, () => {
    const open = db
      .prepare("SELECT * FROM orders WHERE user_id = ? AND market_id = ? AND status = 'open'")
      .all(bot.id, marketId);
    cancelBotOrders(db, open, marketId);
    // Re-quote only if risk allows. At the hard cap (or with the desk kill
    // switch pulled) the old ladder stays CANCELLED and nothing replaces it —
    // liquidity disappears, which is the correct outcome. The alternative is
    // continuing to offer the sharpest price in the book while knowingly
    // exceeding the loss the venue agreed to carry.
    const skew = skewFor(db, bot);
    if (skew === null) return;
    for (const sel of sels) quoteSpread(db, bot, sel, skew);
  });
}

// Requote ONE selection's bot ladders around its current fair price
// (cancel + replace). Used by the drift loop so a single price move does not
// churn every order in the market.
function requoteSelection(db, selectionId) {
  const sel = db
    .prepare("SELECT * FROM selections WHERE id = ? AND status = 'open' AND fair_price IS NOT NULL")
    .get(selectionId);
  if (!sel) return;
  const market = db.prepare('SELECT status FROM markets WHERE id = ?').get(sel.market_id);
  if (!market || market.status !== 'open') return;
  const bot = ensureBot(db);
  transaction(db, () => {
    const open = db
      .prepare("SELECT * FROM orders WHERE user_id = ? AND selection_id = ? AND status = 'open'")
      .all(bot.id, selectionId);
    cancelBotOrders(db, open, sel.market_id);
    const skew = skewFor(db, bot);
    if (skew === null) return;
    quoteSpread(db, bot, sel, skew);
  });
}

function quoteAllMarkets(db) {
  const markets = db.prepare("SELECT id FROM markets WHERE status = 'open'").all();
  for (const m of markets) {
    try {
      quoteMarket(db, m.id);
    } catch (e) {
      // Failure isolation: one throwing market must not abort quoting for
      // every market after it. Reachable for real — the bot's bank can run
      // short when drifted fair prices push lay escrow into the millions of
      // cents. quoteMarket is one transaction, so the failed market is left
      // exactly as it was (old ladder intact, no partial requote) and
      // quoting continues down the board.
      console.error(`[bots] quoting market ${m.id} failed:`, e.message);
    }
  }
}

module.exports = {
  quoteMarket,
  requoteSelection,
  quoteAllMarkets,
  ensureBot,
  primeBotHash,
  withdrawAll,
  riskDefaults,
  skewFor,
  BOT_USERNAME,
  BOT_PASSWORD,
  BOT_BANK_CENTS,
};
