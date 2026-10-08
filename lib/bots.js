'use strict';
// lib/bots.js — MarketMakers liquidity bot: quotes a ~3-tick spread around
// each selection's fair price so the exchange is always tradeable, even with
// no other users. Bot orders are ordinary rows; the engine treats all users
// identically (self-match guard keeps the bot's own two sides apart).
const A = require('./auth');
const M = require('./match');
const { escrowFor } = M; // the ONE escrow formula (lib/match.js exports it)
const { release } = require('./ledger');
const { transaction } = require('./tx');
const { nextTick, prevTick } = require('./odds');

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

function ensureBot(db) {
  let bot = db.prepare('SELECT * FROM users WHERE is_bot = 1 ORDER BY id LIMIT 1').get();
  if (!bot) {
    A.createAccount(db, {
      username: BOT_USERNAME,
      password: BOT_PASSWORD,
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
// released using the engine's canonical escrowFor — never a re-derived copy
// of the formula (the rounded cents must match placeOrderTx exactly or the
// wallet drifts).
function cancelBotOrders(db, rows, marketId) {
  for (const o of rows) {
    const remainder = o.stake_cents - o.matched_cents;
    const esc = escrowFor(o.side, o.price, remainder);
    if (esc > 0) release(db, o.user_id, esc, { orderId: o.id, marketId });
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(o.id);
  }
}

// Quote a ~3-tick spread around a selection's fair price: lay offers ABOVE
// fair (users back into them), back offers BELOW fair (users lay into them).
function quoteSpread(db, bot, sel) {
  const F = sel.fair_price;
  for (let k = 1; k <= 3; k++) {
    M.placeOrderTx(db, bot, { selection_id: sel.id, side: 'lay', price: ticksAway(F, k, true), stake_cents: size() });
  }
  for (let k = 1; k <= 3; k++) {
    M.placeOrderTx(db, bot, { selection_id: sel.id, side: 'back', price: ticksAway(F, k, false), stake_cents: size() });
  }
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
    for (const sel of sels) quoteSpread(db, bot, sel);
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
    quoteSpread(db, bot, sel);
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
  BOT_USERNAME,
  BOT_PASSWORD,
  BOT_BANK_CENTS,
};
