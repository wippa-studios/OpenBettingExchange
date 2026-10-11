// bots.test.js — the liquidity bot's quoting rules: the market-status guard,
// the spread it quotes, escrow parity with the engine's escrowFor, and
// failure isolation across markets.
// Run: node tests/bots.test.js   (plain assert, no deps, offline)
'use strict';

// scrypt cost: this suite creates many accounts and pays the hash once per
// account, but asserts NOTHING about the stored hash format. auth.test.js
// runs at the real default (SCRYPT_N=65536) and owns that coverage.
process.env.SCRYPT_N = '16384';
// Hermeticity: pin the money knobs the engine reads at require time, so an
// ambient .env can never change what this suite asserts against.
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.FAUCET_MAX_CENTS = '100000';

const assert = require('assert');
const { openStore } = require('../lib/store');
const bots = require('../lib/bots');
const M = require('../lib/match');
const A = require('../lib/auth');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

// One open market with one fair-priced selection (the minimum the bot needs
// to quote). Fresh :memory: db per example — no shared state.
function fixture(opts = {}) {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('S', 's')").run();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1, 'E', '2099-01-01 00:00:00')").run();
  db.prepare('INSERT INTO markets (event_id, name, status) VALUES (1, ?, ?)').run('M', opts.marketStatus || 'open');
  const marketId = db.prepare('SELECT id FROM markets').get().id;
  db.prepare("INSERT INTO selections (market_id, name, fair_price, status) VALUES (?, 'Sel', ?, 'open')").run(
    marketId,
    opts.fair ?? 2.5
  );
  const selectionId = db.prepare('SELECT id FROM selections').get().id;
  return { db, marketId, selectionId };
}

// B1: the market-status guard quoteMarket previously lacked (its sibling
// requoteSelection had it): a suspended market gains no fresh bot quotes —
// and no bot account is minted for a market that will not be quoted.
check('B1 quoteMarket places nothing on a suspended market', () => {
  const { db, marketId } = fixture({ marketStatus: 'suspended' });
  bots.quoteMarket(db, marketId);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0, 'no orders placed');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_bot = 1').get().n, 0, 'no bot minted');
});

// B2: quoting an open market lays a 3-tick spread around fair: lay offers
// ABOVE fair (users back into them), back offers BELOW fair (users lay into
// them). fair 2.5 → lays 2.52/2.54/2.56, backs 2.48/2.46/2.44.
check('B2 quoteMarket quotes 3 lay levels above and 3 back levels below fair', () => {
  const { db, marketId, selectionId } = fixture({ fair: 2.5 });
  bots.quoteMarket(db, marketId);
  const bot = db.prepare('SELECT * FROM users WHERE is_bot = 1').get();
  assert.ok(bot, 'the bot account exists after quoting');
  const orders = db.prepare('SELECT * FROM orders WHERE selection_id = ?').all(selectionId);
  assert.strictEqual(orders.length, 6, '3 + 3 levels');
  const lays = orders.filter((o) => o.side === 'lay').map((o) => o.price).sort((a, b) => a - b);
  const backs = orders.filter((o) => o.side === 'back').map((o) => o.price).sort((a, b) => a - b);
  assert.deepStrictEqual(lays, [2.52, 2.54, 2.56]);
  assert.deepStrictEqual(backs, [2.44, 2.46, 2.48]);
  assert.ok(orders.every((o) => o.user_id === bot.id), 'every order belongs to the bot');
  assert.ok(orders.every((o) => o.status === 'open'), 'resting, unmatched');
});

// B3: escrow parity — the bot froze exactly escrowFor(side, price, stake)
// per order (the engine's one formula; the bot must never carry a re-derived
// copy), and the wallet's frozen total is the sum of the order escrows.
check('B3 every quoted order froze exactly escrowFor(side, price, stake)', () => {
  const { db, marketId } = fixture({ fair: 3.05 });
  bots.quoteMarket(db, marketId);
  const bot = db.prepare('SELECT * FROM users WHERE is_bot = 1').get();
  const orders = db.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'open'").all(bot.id);
  assert.strictEqual(orders.length, 6, 'a full spread was quoted');
  let total = 0;
  for (const o of orders) {
    assert.strictEqual(o.frozen_cents, M.escrowFor(o.side, o.price, o.stake_cents), `order ${o.id} escrow`);
    total += o.frozen_cents;
  }
  assert.strictEqual(bot.frozen_cents, total, 'wallet frozen is the sum of per-order escrows');
});

// B4: failure isolation in quoteAllMarkets. Market A (fair 990) makes the
// bot's first lay need >= round(999 x 3000) = 2,997,000 cents — far beyond
// the deliberately small bank below — so quoting A throws and its whole
// transaction rolls back; market B (quoted AFTER A) must still get its full
// spread. B's worst-case need is 152,400 cents (3 lays at 2.52-2.56 plus
// 3 backs, max size 20000), inside the 200,000-cent bank.
check('B4 quoteAllMarkets isolates one failing market and keeps quoting the rest', () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('S', 's')").run();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1, 'E', '2099-01-01 00:00:00')").run();
  const addMarket = (name, fair) => {
    db.prepare('INSERT INTO markets (event_id, name, status) VALUES (1, ?, ?)').run(name, 'open');
    const mid = db.prepare('SELECT id FROM markets WHERE name = ?').get(name).id;
    db.prepare("INSERT INTO selections (market_id, name, fair_price, status) VALUES (?, 'Sel', ?, 'open')").run(mid, fair);
  };
  addMarket('A-exhausts-bot', 990); // created first: fails before B is reached
  addMarket('B-normal', 2.5);
  A.createAccount(db, {
    username: bots.BOT_USERNAME,
    password: bots.BOT_PASSWORD,
    is_bot: 1,
    balance_cents: 200000, // always enough for B, never for A
  });
  bots.quoteAllMarkets(db); // must log A's failure and continue
  const countIn = (name) => {
    const mid = db.prepare('SELECT id FROM markets WHERE name = ?').get(name).id;
    return db.prepare('SELECT COUNT(*) AS n FROM orders WHERE market_id = ?').get(mid).n;
  };
  assert.strictEqual(countIn('A-exhausts-bot'), 0, 'the failed market rolled back to no orders');
  assert.strictEqual(countIn('B-normal'), 6, 'the market after the failure is fully quoted');
});

console.log(`\nbots.test.js: ${passed} checks passed`);
