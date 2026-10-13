// reports.test.js — regulatory, financial and operational reporting.
// Run: node tests/reports.test.js   (plain assert, no deps)
//
// WHY THIS EXISTS. Phase 6 calls reporting the thing operators buy because the
// alternative is writing it themselves, and there was none of it — the data was
// all there (settlements, matches, buyouts, the ledger) and had never been
// shaped into a statement an operator could file.
//
// TWO THINGS ARE ASSERTED THAT A NAIVE REPORT GETS WRONG:
//
//  1. THE DEFINITIONS. GGR is not one thing. On a peer-to-peer exchange the
//     venue earns commission and carries its own trading risk, and those are
//     different lines for different regulators. So the report states its
//     formula and breaks the headline into components, rather than presenting
//     a single total that means whatever the reader assumed.
//
//  2. THE SELF-CHECK. Every settlement is zero-sum BETWEEN PLAYERS, so
//     SUM(pnl_cents) must be exactly zero, with commission charged on top of
//     that pool. I asserted `SUM(pnl) + SUM(commission) = 0` first — wrong by
//     exactly the venue's fee — and it reported FAILED on a correct book at
//     750 cents. An invariant written from reasoning rather than from the
//     ledger produces confident nonsense, and an operator would have filed
//     that as a real discrepancy. R1 pins the correct one.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const S = require('../lib/settle');
const IP = require('../lib/inplay');
const REP = require('../lib/reports');
const config = require('../lib/config');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

/**
 * A minimal RFC 4180 reader: fields separated by commas, double-quoted fields
 * with "" for a literal quote, newlines permitted inside quotes.
 *
 * Present so the CSV tests can assert a value ROUND-TRIPS rather than asserting
 * on the text. Checking the raw string is how the previous version of R15
 * counted a quoted newline as an extra record and called the export broken.
 */
function parseCsv(text) {
  const records = [];
  let field = '';
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n') { record.push(field); records.push(record); record = []; field = ''; }
    else field += c;
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  return records;
}

let n = 0;
/**
 * A venue with real settled history: alice wins one market and loses another,
 * so her net is zero but she has traded — which is the shape that distinguishes
 * "no activity" from "activity that nets out".
 */
function book({ delayMs = 0 } = {}) {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  const mk = (u) => A.registerUser(db, { username: u, password: `pw-${u}-1234`, balance_cents: 500000 });
  const alice = mk('alice');
  const bob = mk('bob');
  const carol = mk('carol');

  function market() {
    n++;
    db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now','+2 hours'))").run(sp.id, `E${n}`);
    const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`E${n}`);
    db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
    const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
    for (const nm of ['Alpha', 'Beta']) {
      db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, nm);
    }
    return {
      id: mkt.id,
      s1: db.prepare("SELECT id FROM selections WHERE market_id=? AND name='Alpha'").get(mkt.id).id,
      s2: db.prepare("SELECT id FROM selections WHERE market_id=? AND name='Beta'").get(mkt.id).id,
    };
  }
  // One matched market: alice+carol back Alpha, bob lays. 10000 + 5000.
  function trade(m, { aliceSide = 'back', stakeA = 10000, stakeC = 5000 } = {}) {
    M.placeOrder(db, alice, { selection_id: m.s1, side: aliceSide, price: 2.0, stake_cents: stakeA });
    M.placeOrder(db, bob, { selection_id: m.s1, side: aliceSide === 'back' ? 'lay' : 'back', price: 2.0, stake_cents: stakeA });
    M.placeOrder(db, carol, { selection_id: m.s1, side: aliceSide, price: 2.0, stake_cents: stakeC });
    M.placeOrder(db, bob, { selection_id: m.s1, side: aliceSide === 'back' ? 'lay' : 'back', price: 2.0, stake_cents: stakeC });
  }
  return { db, market, trade, settle: (m, winner) => S.settleMarket(db, m.id, { winner_selection_id: winner }), alice, bob, carol, delayMs };
}

const p = () => REP.period();

// ── The self-check, and the invariant I got wrong ──────────────────────────

// R1: THE INVARIANT. Settlements are zero-sum between players, so SUM(pnl) is
// exactly 0 and commission is charged on top of that pool. The first version
// asserted `SUM(pnl) + SUM(commission) = 0` and reported a 750-cent failure on
// a perfectly correct book — wrong by exactly the fee.
check('R1 SUM(pnl) equals the buyout identity, and commission is reported apart', () => {
  const b = book();
  const m1 = b.market();
  b.trade(m1);
  b.settle(m1, m1.s1); // alice and carol win
  const m2 = b.market();
  b.trade(m2);
  b.settle(m2, m2.s2); // they lose

  const rep = REP.summary(b.db, p());
  const raw = b.db.prepare('SELECT COALESCE(SUM(pnl_cents),0) p, COALESCE(SUM(commission_cents),0) c FROM settlements').get();
  assert.notStrictEqual(raw.c, 0, 'the book really did charge commission');
  assert.strictEqual(raw.p, 0, 'and the players really did net to zero');
  assert.strictEqual(rep.settlements_net_pnl, 0, 'so the players net to zero with no buyout');
  assert.strictEqual(rep.expected_net_pnl, 0, 'and the identity agrees: 0 == paid(0) - took over(0)');
  assert.strictEqual(rep.self_check_ok, true);
  assert.ok(rep.self_check_basis, 'and the invariant is STATED, not just asserted');
  assert.strictEqual(rep.financial.commission_cents, raw.c, 'commission is reported separately');
});

// R2: THE SELF-CHECK CAN FAIL, and must not be hard-coded to pass. A check that
// always says OK is decoration. Corrupt a settlement row and the report must
// say so rather than filing the corruption as normal.
check('R2 the self-check reports a failure rather than always passing', () => {
  const b = book();
  const m = b.market();
  b.trade(m);
  b.settle(m, m.s1);
  assert.strictEqual(REP.summary(b.db, p()).self_check_ok, true, 'clean book passes');
  // A settlement row rewritten out from under the ledger — precisely what a bug
  // or a tampered database looks like.
  b.db.prepare('UPDATE settlements SET pnl_cents = pnl_cents + 5000 WHERE id = 1').run();
  const rep = REP.summary(b.db, p());
  assert.strictEqual(rep.settlements_net_pnl, 5000, 'the drift is visible');
  assert.strictEqual(rep.expected_net_pnl, 0, 'and it does not match the identity');
  assert.strictEqual(rep.self_check_ok, false, 'and the report says it is not ok');
});

// R2b: THE SELF-CHECK WITH A CASH-OUT. This is the case that was never tested,
// and it is the case the bug lived in.
//
// The buyout subquery correlated `matches.market_id IN (SELECT id FROM
// cashout_quotes ...)` — `id` being the QUOTE ROW's primary key, an unrelated
// id space. So `venue_took_over_cents` was always 0 once any cash-out existed,
// and `self_check_ok` flipped to FALSE permanently on a ledger that is provably
// conserved. Measured before the fix: a buyout taking over 41,648 cents of stake
// reported 0 taken over, and six consecutive buyouts left the operator's
// financial summary red every time.
//
// A control that is always red is worse than no control: it is one operators
// learn to ignore. So this asserts the self-check is GREEN on a book that used
// cash-out — which it could not be before.
check('R2b the self-check stays ok on a book that used cash-out', () => {
  const b = book();
  const m = b.market();
  b.trade(m);

  // A taken buyout: the venue takes over one side, and a cashout_quotes row
  // records it. Written directly rather than driven through the cash-out engine,
  // because this is a REPORTING test and the engine is covered in cashout2.
  b.db.prepare('UPDATE matches SET cashout = 1 WHERE id = (SELECT MIN(id) FROM matches WHERE market_id = ?)').run(m.id);
  const taken = b.db.prepare('SELECT COALESCE(SUM(stake_cents),0) s FROM matches WHERE market_id = ? AND cashout = 1').get(m.id).s;
  assert.ok(taken > 0, 'the fixture really did mark a match as taken over');
  // fair_value_cents and expires_at are NOT NULL in the schema; a partial insert
  // fails with a bare "SQL logic error" that says nothing about which column.
  //
  // THE THROWAWAY QUOTE IS THE POINT, and it took two attempts to get right.
  //
  // Both tables AUTOINCREMENT from 1, so a naive fixture has the market id and
  // the quote id BOTH equal to 1 — and the buggy predicate
  // `market_id IN (SELECT id …)` then ACCIDENTALLY matches. The first version of
  // this test passed with the bug deliberately reintroduced.
  //
  // A second throwaway fixed the id arithmetic but not the test: it carried a
  // settled_at INSIDE the period, so the buggy subquery still returned {1,2} and
  // 1 was still a member.
  //
  // The throwaway is therefore settled_at = NULL — excluded from the subquery
  // entirely — so it burns id 1 while contributing nothing, the real quote gets
  // id 2, and the market's id 1 is in neither result set. The assertions below
  // then verify the fixture can actually tell the two predicates apart, so a
  // future edit cannot silently restore the coincidence.
  b.db
    .prepare(
      `INSERT INTO cashout_quotes
         (market_id, user_id, fair_value_cents, paid_cents, status, expires_at, settled_at)
       VALUES (?, 1, 0, 0, 'open', datetime('now','+1 hour'), NULL)`
    )
    .run(m.id);
  b.db
    .prepare(
      `INSERT INTO cashout_quotes
         (market_id, user_id, fair_value_cents, paid_cents, status, expires_at, settled_at)
       VALUES (?, 1, 0, ?, 'taken', datetime('now','+1 hour'), datetime('now'))`
    )
    .run(m.id, taken);

  // The fixture must DISCRIMINATE: correct predicate finds the stake, the buggy
  // one finds nothing. If these are equal the rest of this test proves nothing.
  const per = (col) =>
    b.db
      .prepare(
        `SELECT COALESCE(SUM(mt.stake_cents), 0) s
           FROM matches mt
          WHERE mt.cashout = 1
            AND mt.market_id IN (SELECT ${col} FROM cashout_quotes
                                  WHERE settled_at IS NOT NULL)`
      )
      .get().s;
  const viaMarket = per('market_id');
  const viaQuoteRowId = per('id');
  assert.strictEqual(viaMarket, taken, 'the correct predicate finds the taken-over stake');
  assert.strictEqual(
    viaQuoteRowId, 0,
    `the fixture must make the wrong predicate find nothing, or it cannot detect the bug (it found ${viaQuoteRowId})`
  );

  b.settle(m, m.s1);
  const rep = REP.summary(b.db, p());
  assert.ok(rep.buyout_paid_cents > 0, 'a buyout was actually paid, so this is not a vacuous pass');
  assert.strictEqual(
    rep.venue_took_over_cents, taken,
    `the stake the venue took over must be reported (got ${rep.venue_took_over_cents}, expected ${taken})`
  );
  assert.strictEqual(
    rep.self_check_ok, true,
    'the identity must hold on a book that used cash-out — this was permanently false'
  );
  assert.strictEqual(rep.expected_net_pnl, rep.settlements_net_pnl, 'and the two sides agree');
});

// ── The financial summary ───────────────────────────────────────────────────

// R3: THE GGR DEFINITION IS STATED, and the arithmetic is checkable by hand.
// An operator must be able to take the components and reproduce the headline.
check('R3 GGR is defined in the payload and its components reconcile', () => {
  const b = book();
  const m1 = b.market();
  b.trade(m1);
  b.settle(m1, m1.s1);
  const m2 = b.market();
  b.trade(m2);
  b.settle(m2, m2.s2);

  const rep = REP.summary(b.db, p());
  // Every definition is present and non-empty: an undefined figure is worse
  // than an absent one, because it gets used.
  for (const k of ['commission', 'bot_pnl', 'buyout_loss', 'trading_pnl', 'ggr', 'turnover', 'margin_bps', 'hold']) {
    assert.ok(rep.definitions[k] && rep.definitions[k].length > 10, `defines ${k}`);
  }
  // The headline is reproducible from the components.
  const f = rep.financial;
  assert.strictEqual(f.trading_pnl_cents, f.bot_pnl_cents - f.buyout_loss_cents, 'trading = bot − buyout loss');
  assert.strictEqual(f.ggr_cents, f.commission_cents - f.trading_pnl_cents, 'ggr = commission − trading');
  assert.strictEqual(f.ggr_cents, f.commission_cents, 'and with no trading, ggr is the commission');
  // Turnover counts each match ONCE, not both sides. The first version of the
  // statements report summed both, overstating turnover by exactly 2x.
  assert.strictEqual(rep.activity.turnover_cents, 30000, 'two markets at 15000 each, counted once');
  assert.strictEqual(rep.rates.margin_bps, 250, '2.5% of 30000 is 750 = 250bps');
  assert.strictEqual(rep.rates.hold_bps, 250);
});

// R4: deposits are NOT turnover. Matched stakes are not money entering the
// venue, and counting them as "staked" would overstate exposure by an order of
// magnitude — the single most common way an exchange's volume report lies.
check('R4 deposits are reported separately from turnover', () => {
  const b = book();
  const m = b.market();
  b.trade(m);
  b.settle(m, m.s1);
  const ledger = require('../lib/ledger');
  ledger.deposit(b.db, b.alice.id, 50000, config.FAUCET_MAX_CENTS);
  const rep = REP.summary(b.db, p());
  assert.strictEqual(rep.financial.deposits_cents, 50000, 'the deposit is counted');
  assert.strictEqual(rep.activity.turnover_cents, 15000, 'and turnover is matched stake only');
  assert.notStrictEqual(rep.financial.deposits_cents, rep.activity.turnover_cents);
  // And the definition says so, so nobody has to infer it.
  assert.match(rep.definitions.turnover, /not deposits/i);
});

// R5: money is reported in cents AND as a decimal. Cents are what the ledger
// uses and must never be rounded for display; the decimal is what a finance
// team types into a spreadsheet. Both, or someone rounds a rounding error.
check('R5 money is reported in exact cents and as a decimal', () => {
  const b = book();
  const m = b.market();
  b.trade(m);
  b.settle(m, m.s1);
  const rep = REP.summary(b.db, p());
  assert.strictEqual(rep.financial.ggr_cents % 1, 0, 'cents are an integer');
  assert.match(rep.financial.ggr, /^\d+\.\d{2}$/, 'and the decimal has exactly 2dp');
  assert.strictEqual(REP.money(1500), '15.00');
  assert.strictEqual(REP.money(0), '0.00');
  assert.strictEqual(REP.money(1), '0.01');
  assert.strictEqual(REP.money(-1500), '-15.00', 'negatives survive');
});

// ── Player statements ───────────────────────────────────────────────────────

// R6: a player statement reports what they TRADED as well as what they were
// settled. A statement showing only net winnings cannot answer "how much did I
// turn over", which is the question a regulator asks about turnover
// responsibility.
check('R6 a statement reports staked, net and commission per player', () => {
  const b = book();
  const m1 = b.market();
  b.trade(m1);
  b.settle(m1, m1.s1);
  const rep = REP.playerStatements(b.db, p());
  const alice = rep.statements.find((s) => s.username === 'alice');
  assert.ok(alice, 'alice has a statement');
  assert.strictEqual(alice.staked_cents, 10000, 'she staked 10000');
  assert.strictEqual(alice.net_cents, 10000, 'and won 10000 net');
  assert.strictEqual(alice.commission_paid_cents, 250, 'paying 2.5% commission');
  assert.strictEqual(alice.markets_settled, 1);
  // Bob laid BOTH orders, so his staked is the sum of them (both sides of a
  // match count toward turnover) and his loss is the sum of both liabilities.
  const bob = rep.statements.find((s) => s.username === 'bob');
  assert.strictEqual(bob.staked_cents, 15000, 'both sides count toward turnover');
  assert.strictEqual(bob.net_cents, -15000, 'he laid 10000 and 5000 and lost both');
  assert.strictEqual(bob.commission_paid_cents, 0, 'and pays no commission: it is charged on net WINNINGS only');
  // The statement lines must net to zero across the players, which is the same
  // invariant R1 pins, seen from the per-player side.
  assert.strictEqual(
    rep.statements.filter((x) => !x.is_bot).reduce((a, x) => a + x.net_cents, 0),
    0,
    'players net to zero between themselves'
  );
  // 2x the matched stake, once per side of each match. Summed from the
  // STATEMENTS rather than from the raw per-user SQL rows, which used to be
  // returned alongside the same figures (the reviewer's F9) and are gone.
  assert.strictEqual(rep.statements.reduce((a, x) => a + x.staked_cents, 0), 30000);
});

// R7: statements exist for every settled player, including bots, and bots are
// LABELLED. A regulatory export that silently omitted the venue's own accounts
// would understate turnover; one that mixed them in without a flag would
// misattribute the house's trading as player activity.
check('R7 statements label the venue own accounts as bots', () => {
  const b = book();
  const m = b.market();
  b.trade(m);
  b.settle(m, m.s1);
  const bots = require('../lib/bots');
  const bot = bots.ensureBot(b.db);
  // The house settles nothing here, so just prove the flag is derivable and
  // that a bot with a settlement would be labelled.
  b.db.prepare(
    'INSERT INTO settlements (market_id, user_id, pnl_cents, commission_cents) VALUES (?, ?, 100, 0)'
  ).run(m.id, bot.id);
  const rep = REP.playerStatements(b.db, p());
  const botRow = rep.statements.find((s) => s.user_id === bot.id);
  assert.ok(botRow, 'the bot appears in the export');
  assert.strictEqual(botRow.is_bot, true, 'and is flagged as the venue own account');
  for (const s of rep.statements.filter((x) => !x.is_bot)) {
    assert.strictEqual(s.is_bot, false, 'players are not flagged');
  }
});

// ── Volume ──────────────────────────────────────────────────────────────────

// R8: volume is grouped per market with the event and sport, which is what a
// regulator reconciles against, and turnover is ordered so the biggest market
// is first (an operator reads the top of the list).
check('R8 volume is per market with event and sport, biggest first', () => {
  const b = book();
  const m1 = b.market();
  b.trade(m1);
  b.settle(m1, m1.s1);
  const m2 = b.market();
  b.trade(m2, { stakeA: 100, stakeC: 100 });
  b.settle(m2, m2.s1);
  const rep = REP.volumeByMarket(b.db, p());
  assert.strictEqual(rep.rows.length, 2);
  assert.strictEqual(rep.rows[0].turnover_cents, 15000, 'the bigger market first');
  assert.strictEqual(rep.rows[1].turnover_cents, 200);
  for (const r of rep.rows) {
    assert.ok(r.sport && r.event && r.market, 'labelled with sport, event and market');
    assert.ok(r.matches > 0, `with a match count (got ${r.matches})`);
  }
});

// R9: volume by selection, because a regulatory view is per-outcome, not just
// per-event.
check('R9 volume is available per selection', () => {
  const b = book();
  const m = b.market();
  b.trade(m);
  b.settle(m, m.s1);
  const rows = REP.volumeBySelection(b.db, p());
  const alpha = rows.find((r) => r.selection === 'Alpha');
  assert.ok(alpha, 'Alpha has volume');
  assert.strictEqual(alpha.turnover_cents, 15000);
  assert.strictEqual(alpha.market_id, m.id);
});

// ── Commission by tenant ────────────────────────────────────────────────────

// R10: the EFFECTIVE rate is reported, not the stored one. Users with no tenant
// row pay the global COMMISSION_RATE, so reporting COALESCE(t.commission_bps, 0)
// tells an operator they charged nothing when they charged the full rate — the
// kind of report that gets filed.
check('R10 commission reports the EFFECTIVE rate, not the stored one', () => {
  const b = book();
  const m = b.market();
  b.trade(m);
  b.settle(m, m.s1);
  const rows = REP.commissionByTenant(b.db, p());
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.commission_bps, 250, 'the global 2.5%, not 0');
  // 250bps of alice's 10000 win is 250, and of carol's 5000 is 125. Bob loses,
  // so he pays nothing: commission is charged on net winnings only.
  assert.strictEqual(r.commission_cents, 375, '250 + 125, on net winnings only');
  // The commission BASE is the sum of positive settlements only — 10000 + 5000 —
  // which is what makes the fee reproducible by hand: 250bps of 15000 is 375.
  assert.strictEqual(r.win_base_cents, 15000, 'the base commission is charged on');
  assert.strictEqual(r.net_cents, 0, 'and the group nets to zero, which is a different figure');
  assert.strictEqual(r.implied_bps, 250, 'the implied rate matches the stated one');
  assert.strictEqual(r.players, 3);
});

// R11: a tenant with its OWN rate reports that rate, so a per-tenant fee is not
// averaged away into a blended figure.
check('R11 a tenant own rate is reported as its own', () => {
  const b = book();
  // The DEFAULT tenant already exists and carries its own rate, so use it: a
  // per-tenant fee is the point of this check and it must not be a tenant this
  // codebase happens not to have created.
  const TEN = require('../lib/tenants');
  const t = TEN.defaultTenant(b.db);
  TEN.configure(b.db, { actor: { id: 1, role: 'admin' }, tenantId: t.id, commission_bps: 400 });
  assert.strictEqual(TEN.commissionBps(b.db, t.id), 400, 'the tenant rate is set');
  b.db.prepare('UPDATE users SET tenant_id = ? WHERE id = ?').run(t.id, b.carol.id);
  const m = b.market();
  b.trade(m);
  b.settle(m, m.s1);
  const rows = REP.commissionByTenant(b.db, p());
  const gold = rows.find((r) => r.tenant_id === t.id);
  assert.ok(gold, 'the tenant appears as its own line');
  assert.strictEqual(gold.commission_bps, 400, 'its own rate');
  assert.ok(rows.length >= 1);

  // THE POINT OF THE FIX. A user with NO tenant row is billed by tenants.ofUser
  // at the DEFAULT TENANT's rate, not at config.COMMISSION_RATE — and an
  // operator can change that rate. This check used to assert the opposite ("the
  // default line keeps the global rate"), which is the finding itself: the
  // report told the operator 250 while 400 was actually charged.
  const allDefault = rows.find((r) => r.tenant_id === 0);
  assert.ok(allDefault, 'the null-tenant bucket is present');
  assert.strictEqual(allDefault.commission_bps, 400, 'reports the rate actually CHARGED');
  assert.strictEqual(allDefault.global_rate_bps, 250, 'and shows the global rate beside it for comparison');
  assert.match(allDefault.tenant, /default tenant/i, 'and names what those users are really billed through');
  // The two columns agree, which is the whole point of reporting implied_bps.
  assert.strictEqual(allDefault.implied_bps, allDefault.commission_bps, 'stated rate == implied rate');
});

// ── Operational ─────────────────────────────────────────────────────────────

// R12: the average bet delay is computed from REAL placement-to-match time over
// orders that carried a delay. This figure is only meaningful because the delay
// is enforced; for months the venue reported a delay and matched instantly, so
// this would have been a measurement of nothing.
check('R12 the average bet delay is measured from real fill times', () => {
  const b = book();
  const m = b.market();
  IP.setInplay(b.db, { marketId: m.id, inplay: true, delayMs: 60000 });
  IP.releaseKickoffSuspension(b.db, m.id);
  // Alice lays, bob takes it — bob's order is DELAYED, so it rests until
  // released, and then matches.
  M.placeOrder(b.db, b.alice, { selection_id: m.s1, side: 'lay', price: 2.0, stake_cents: 1000 });
  const delayed = M.placeOrder(b.db, b.bob, { selection_id: m.s1, side: 'back', price: 2.0, stake_cents: 1000 });
  assert.strictEqual(delayed.fills.length, 0, 'held by the delay');
  // Make the wait REAL: the order is aged to have been PLACED 60 seconds ago,
  // and the release pass then matches it now. Faking only eligible_at would
  // leave the wall-clock gap at zero milliseconds and the metric would report
  // 0ms — which is the correct answer to a question about a wait that never
  // happened, so the setup has to age the placement, not the eligibility.
  b.db.prepare(
    "UPDATE orders SET eligible_at = datetime('now','-1 second'), placed_at = datetime('now','-60 seconds') WHERE eligible_at IS NOT NULL"
  ).run();
  M.releaseEligibleOrders(b.db);
  const op = REP.operational(b.db, p());
  assert.ok(op.rates.delayed_matches >= 1, 'a delayed match is counted');
  // The delay was 60s, so the mean wait cannot be under that.
  assert.ok(
    op.rates.average_bet_delay_ms >= 59000 && op.rates.average_bet_delay_ms <= 70000,
    `the realised delay reflects the 60s actually waited (got ${op.rates.average_bet_delay_ms}ms)`
  );
  assert.match(op.definitions.average_bet_delay_ms, /offered latency|enforced/i);
});

// R13: operational rates are guarded against a zero denominator. A venue with
// no orders must report null, not NaN or Infinity — an operator filing "NaN"
// in a regulatory return is a self-inflicted wound.
check('R13 rates are null on an empty book, never NaN', () => {
  const b = book();
  const op = REP.operational(b.db, p());
  for (const k of ['match_rate', 'unmatched_ratio', 'average_bet_delay_ms']) {
    assert.strictEqual(op.rates[k], null, `${k} is null, not NaN`);
  }
  const sum = REP.summary(b.db, p());
  assert.strictEqual(sum.rates.margin_bps, null, 'margin is null on no turnover');
  assert.strictEqual(sum.rates.hold_bps, null);
  assert.strictEqual(sum.self_check_ok, true, 'and an empty book still self-checks (0 == 0)');
  // And the CSV for it is still well-formed.
  assert.match(REP.operationalCsv(op), /^period_from,period_to,/);
});

// ── CSV, including the part that is a security control ──────────────────────

// R14: FORMULA INJECTION. A CSV of player statements gets opened in a
// spreadsheet by a human, and a cell beginning `=`, `+`, `-` or `@` is a
// FORMULA, not text — so a name like `=cmd|'/c calc'!A0` is evaluated on the
// operator's machine when they open the export.
//
// Worth being precise about where this actually bites, because it changes which
// fields matter. A USERNAME cannot carry it: auth.js restricts usernames to
// letters, digits, `_` and `-`, so that vector is already closed upstream. The
// fields that are genuinely free text — event names, market names, selection
// names, tenant names — are the ones at risk, and those arrive from a feed
// import or an operator's catalogue rather than from a typed registration.
//
// So this is defence in depth, and it lives at the export boundary rather than
// in each name field, because a boundary guard survives the next field that
// forgets and each field's own policy does not.
check('R14 CSV neutralises formula injection in free-text fields', () => {
  const b = book();
  const m = b.market();
  b.trade(m);
  b.settle(m, m.s1);

  // The upstream policy that closes the username vector, stated so the CSV guard
  // is not mistaken for the only defence.
  assert.throws(
    () => A.registerUser(b.db, { username: '=cmd', password: 'pw-x-1234', balance_cents: 1000 }),
    (e) => e.status === 400 && /Username/.test(e.message),
    'usernames cannot carry a formula anyway'
  );

  // But a free-text name can, and it reaches the export.
  const EVIL = `=cmd|'/c calc'!A0`;
  b.db.prepare('UPDATE events SET name = ? WHERE id = (SELECT event_id FROM markets WHERE id = ?)').run(EVIL, m.id);
  const out = REP.volumeCsv(REP.volumeByMarket(b.db, p()));
  assert.ok(out.includes(`'${EVIL}`), `the dangerous name is neutralised in the CSV:\n${out}`);
  assert.ok(!/(^|,)=cmd/m.test(out), 'never emitted as a bare formula cell');

  // Every dangerous leading character is covered, not just '='. The property is
  // NOT "prefixed with a quote" — a cell containing a newline is neutralised by
  // being QUOTED instead, which is equally safe and loses nothing — but "never
  // begins with something a spreadsheet will evaluate".
  for (const v of ['=SUM(A1)', '+1+1', '-1+1', '@import', '\tX', '\rY']) {
    const cell = REP.csvCell(v);
    assert.ok(!REP.FORMULA_PREFIX.test(cell), `${JSON.stringify(v)} -> ${JSON.stringify(cell)} is not a formula`);
  }
  // A LEADING SPACE before the formula, and other whitespace or control
  // characters, since a spreadsheet trims them before deciding the cell is a
  // formula. The first version of this guard tested position 0 only, so
  // ' =1+1' sailed through and was still evaluated on the operator's machine.
  for (const v of [' =1+1', '\t=1+1', '\n=1+1', '\u0000=cmd', '   @import']) {
    const cell = REP.csvCell(v);
    assert.ok(!REP.FORMULA_PREFIX.test(cell.replace(REP.LEADING_JUNK, '')),
      `${JSON.stringify(v)} -> ${JSON.stringify(cell)} is not a formula once trimmed`);
  }
  // And the leading whitespace itself is preserved, so nothing is silently lost
  // from the operator's data.
  assert.strictEqual(REP.csvCell(' =1+1'), "' =1+1", 'the value is preserved, only quoted');
});

// R15: CSV quoting is correct for the shapes that appear in real data — commas
// in a market name, quotes in a username, a newline in an event name. A report
// that mis-quotes one row is worse than no report, because it is wrong silently.
check('R15 CSV quoting survives commas, quotes and newlines', () => {
  const b = book();
  const m = b.market();
  b.db.prepare("UPDATE markets SET name = ? WHERE id = ?").run('Match, Odds "2"\nSecond line', m.id);
  b.trade(m);
  b.settle(m, m.s1);
  // Set the comma AND the quote on the free-text field that can carry them, since
  // a username cannot (auth.js restricts its charset).
  b.db.prepare('UPDATE markets SET name = ? WHERE id = ?').run('Match, Odds "2"\nSecond line', m.id);
  const out = REP.volumeCsv(REP.volumeByMarket(b.db, p()));
  assert.ok(out.includes('"Match, Odds ""2"'), 'embedded quotes doubled and the field quoted');
  assert.ok(out.includes('Second line'), 'the newline is inside a quoted field');
  assert.strictEqual(
    REP.csvCell('quote"and,comma'),
    '"quote""and,comma"',
    'a quote inside a quoted field is doubled'
  );
  // A quoted newline is PART OF THE FIELD, so splitting on newlines counts
  // records wrongly — the first version of this check did exactly that and
  // reported a spurious extra row. So the quoting is verified the only way it
  // can honestly be: parse it back and check the value round-trips.
  const records = parseCsv(out);
  // The CSV is now HEADER + DATA + a DEFINITIONS BLOCK, because CSV is the
  // default format and the operator's primary artefact must explain its own
  // columns. So the data row is the one that matches the header's width, and
  // the definitions follow below it.
  const header = records[0];
  const width = header.length;
  const dataRows = records.slice(1).filter((r) => r.length === width && !r[0].startsWith('#'));
  assert.strictEqual(dataRows.length, 1, 'exactly one market data row');
  assert.strictEqual(dataRows[0][header.indexOf('market')], 'Match, Odds "2"\nSecond line',
    'the awkward name round-trips EXACTLY — comma, quotes and newline all intact');
  // And the definitions survived the round trip too.
  const defIndex = records.findIndex((r) => r[0] === '# definition');
  assert.ok(defIndex > 0, 'the export carries its own definitions');
  const turnoverDef = records.slice(defIndex).find((r) => r[1] === 'turnover_cents');
  assert.ok(turnoverDef, 'and turnover_cents is defined');
  assert.match(turnoverDef[2], /once per trade/i, 'saying it is counted once per trade');
});

// R16: every CSV has a header an operator can read and a stable column order.
// An export without headers is a spreadsheet someone has to reverse-engineer.
check('R16 every CSV export carries a header row', () => {
  const b = book();
  const m = b.market();
  b.trade(m);
  b.settle(m, m.s1);
  const p0 = p();
  const csvs = {
    summary: REP.summaryCsv(REP.summary(b.db, p0)),
    statements: REP.statementsCsv(REP.playerStatements(b.db, p0)),
    volume: REP.volumeCsv(REP.volumeByMarket(b.db, p0)),
    selections: REP.selectionVolumeCsv(REP.volumeBySelection(b.db, p0)),
    commission: REP.commissionCsv(REP.commissionByTenant(b.db, p0)),
    operational: REP.operationalCsv(REP.operational(b.db, p0)),
  };
  for (const [name, body] of Object.entries(csvs)) {
    assert.ok(body.endsWith('\n'), `${name}: trailing newline`);
    const header = body.trim().split('\n')[0];
    assert.ok(header.split(',').length >= 3, `${name}: has named columns (${header.slice(0, 60)})`);
    assert.ok(/^[a-z_]+/.test(header), `${name}: columns are snake_case keys`);
  }
});

// ── Period validation ───────────────────────────────────────────────────────

// R17: the period is validated, not defaulted silently. An operator who asked
// for a month and was handed the lifetime total would file it.
check('R17 the reporting period is validated and bounded', () => {
  assert.throws(() => REP.period('nope'), (e) => e.status === 400);
  assert.throws(() => REP.period('2026-01-01', 'nope'), (e) => e.status === 400);
  // EITHER parameter alone, which is the shape a query string actually arrives
  // in. The first version defaulted the missing end and then derived the start
  // from it, so `?to=garbage` produced an Invalid Date whose toISOString()
  // threw a TypeError with no status — a 500 for a bad query parameter.
  assert.throws(() => REP.period(undefined, 'nope'), (e) => e.status === 400 && /`to`/.test(e.message));
  assert.throws(() => REP.period('nope', undefined), (e) => e.status === 400 && /`from`/.test(e.message));
  assert.throws(() => REP.period('nope', 'nope'), (e) => e.status === 400);
  // An EMPTY parameter is the same as absent (a form posting an empty field),
  // not a malformed date.
  assert.strictEqual(REP.period('', '').days, 31, 'empty means absent');
  assert.throws(() => REP.period('2026-02-01', '2026-01-01'), (e) => e.status === 400 && /must not be after/.test(e.message));
  // SQL metacharacters are rejected by the format check, before any SQL runs.
  assert.throws(() => REP.period("2026-01-01' OR 1=1 --"), (e) => e.status === 400);
  assert.throws(() => REP.period('2026-01-01; DROP TABLE users'), (e) => e.status === 400);
  // A window that would mean a lifetime total is refused.
  assert.throws(() => REP.period('2000-01-01', '2026-01-01'), (e) => e.status === 400 && /exceed/.test(e.message));
  // Boundaries that MUST work.
  const same = REP.period('2026-01-01', '2026-01-01');
  assert.strictEqual(same.days, 1, 'from == to is ONE day, not an empty range');
  assert.strictEqual(REP.period('2026-01-01', '2026-01-31').days, 31, 'inclusive of both ends');
  // The default is a sensible recent window, not all time.
  const d = REP.period();
  assert.ok(d.days <= 31 && d.days >= 28, `defaults to about a month (got ${d.days})`);
});

// R18: the window is INCLUSIVE of the `to` day. A settlement at 14:00 on the
// last day of the period belongs in the report; an off-by-one here silently
// drops a day's money from a regulatory return.
check('R18 the window includes the whole of the final day', () => {
  const b = book();
  const m = b.market();
  b.trade(m);
  b.settle(m, m.s1);
  const today = REP.period().to;
  const rep = REP.summary(b.db, REP.period(today, today));
  // One settlement row per paying participant: alice, carol and bob.
  assert.strictEqual(rep.activity.settlements, 3, "today's settlements are inside today's window");
  // And yesterday's window excludes them.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const prev = REP.summary(b.db, REP.period(yesterday, yesterday));
  assert.strictEqual(prev.activity.settlements, 0, "and not in yesterday's");
});

console.log(`\nreports.test.js: ${passed} checks passed`);
if (passed < 18) { console.error('expected 18 checks'); process.exit(1); }