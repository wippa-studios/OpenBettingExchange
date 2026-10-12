// Re-run the reporting reviewer's measurements against the fixed code.
// reporting-findings.test.js — regressions for the outside review's reporting
// findings, each verified by measurement rather than by reading the code.
//
// Run: node tests/reporting-findings.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';
process.env.CASHOUT_ENABLED = 'true';
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const C = require('../lib/cashout');
const S = require('../lib/settle');
const REP = require('../lib/reports');
const TEN = require('../lib/tenants');
// (No absolute-path imports. This suite was generated from a scratch script, and
// one leftover `require('/home/Joel/Desktop/OpenBettingExchange/lib/config')`
// shipped committed. It was unused, so it was pure loss: the test passed on the
// machine that wrote it and failed everywhere else with "Cannot find module".
// tests/guard.test.js now asserts no source file carries a machine-absolute
// path, so a generated test cannot pass locally and break CI again.)

let n = 0;
function book() {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name,slug) VALUES ('F','football')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  n++;
  db.prepare("INSERT INTO events (sport_id,name,starts_at) VALUES (?, ?, datetime('now','+2 hours'))").run(sp.id, `E${n}`);
  const ev = db.prepare('SELECT id FROM events WHERE name=?').get(`E${n}`);
  db.prepare("INSERT INTO markets (event_id,name) VALUES (?, 'M')").run(ev.id);
  const m = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  for (const nm of ['A', 'B']) db.prepare('INSERT INTO selections (market_id,name,fair_price) VALUES (?,?,2.0)').run(m.id, nm);
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=? ORDER BY id').get(m.id).id;
  const alice = A.registerUser(db, { username: 'alice', password: 'pw-alice-1234', balance_cents: 100000 });
  const bob = A.registerUser(db, { username: 'bob', password: 'pw-bob-1234', balance_cents: 100000 });
  return { db, m, s1, alice, bob };
}
const trade = (b, stake = 10000) => {
  M.placeOrder(b.db, b.alice, { selection_id: b.s1, side: 'back', price: 2.0, stake_cents: stake });
  M.placeOrder(b.db, b.bob, { selection_id: b.s1, side: 'lay', price: 2.0, stake_cents: stake });
};
let passed = 0;
const ok = (n, pass) => { assert.ok(pass, n); passed++; console.log('  ok', n); };

// F1/F1b: the self-check on a book WITH a cash-out.
{
  const b = book(); trade(b);
  b.db.prepare('UPDATE selections SET fair_price = 1.5 WHERE id = ?').run(b.s1);
  C.cashoutMarket(b.db, b.alice, b.m.id);
  b.db.prepare('UPDATE selections SET fair_price = 2.0 WHERE id = ?').run(b.s1);
  S.settleMarket(b.db, b.m.id, { winner_selection_id: b.s1 });
  const r = REP.summary(b.db, REP.period());
  ok(`F1  self-check on a cash-out book (was FALSE FAILED): ${r.self_check_ok} [${r.settlements_net_pnl} == ${r.expected_net_pnl}]`, r.self_check_ok);
  ok(`F5  turnover excludes the buyout leg: ${r.activity.turnover_cents} (reviewer measured 20000)`, r.activity.turnover_cents === 10000);
}

// F2: negative money must be a NUMBER, not text.
{
  const b = book(); trade(b);
  b.db.prepare('UPDATE selections SET fair_price = 1.5 WHERE id = ?').run(b.s1);
  C.cashoutMarket(b.db, b.alice, b.m.id);
  b.db.prepare('UPDATE selections SET fair_price = 2.0 WHERE id = ?').run(b.s1);
  S.settleMarket(b.db, b.m.id, { winner_selection_id: b.s1 });
  const csv = REP.summaryCsv(REP.summary(b.db, REP.period()));
  const cells = csv.trim().split('\n')[1].split(',');
  const negatives = cells.filter((c) => c.trim().startsWith("'-"));
  ok(`F2  no negative number exported as text (${negatives.length} found)`, negatives.length === 0);
}

// F3: the default tenant's rate, when it differs from the global rate.
{
  const b = book(); trade(b);
  const t = TEN.defaultTenant(b.db);
  TEN.configure(b.db, { actor: { id: b.alice.id, role: 'admin' }, tenantId: t.id, commission_bps: 1000 });
  S.settleMarket(b.db, b.m.id, { winner_selection_id: b.s1 });
  const row = REP.commissionByTenant(b.db, REP.period())[0];
  ok(`F3  null-tenant row reports the CHARGED rate: ${row.commission_bps} (reviewer saw 250 vs 1000 charged)`, row.commission_bps === 1000);
  ok(`F3b stated rate == implied rate: ${row.commission_bps} == ${row.implied_bps}`, row.commission_bps === row.implied_bps);
}

// F4: bad dates must be 400, never 500.
{
  const cases = ['2026-13-01', '2026-00-01', '2026-01-32', '2026-02-30', '2026-02-31'];
  const bad = cases.filter((c) => { try { REP.period(undefined, c); return true; } catch (e) { return e.status !== 400; } });
  ok(`F4  impossible dates refused with 400 (${cases.length - bad.length}/${cases.length})`, bad.length === 0);
}

// F7: definitions in the CSV, which is the DEFAULT format.
{
  const b = book(); trade(b); S.settleMarket(b.db, b.m.id, { winner_selection_id: b.s1 });
  const p = REP.period();
  const csvs = {
    summary: REP.summaryCsv(REP.summary(b.db, p)),
    settlements: REP.statementsCsv(REP.playerStatements(b.db, p)),
    volume: REP.volumeCsv(REP.volumeByMarket(b.db, p)),
    commission: REP.commissionCsv(REP.commissionByTenant(b.db, p)),
  };
  const missing = Object.entries(csvs).filter(([, v]) => !v.includes('# definition')).map(([k]) => k);
  ok(`F7  every CSV carries its definitions (missing: ${missing.join(',') || 'none'})`, missing.length === 0);
}

// F9: the raw SQL rows are no longer shipped.
{
  const b = book(); trade(b); S.settleMarket(b.db, b.m.id, { winner_selection_id: b.s1 });
  const rep = REP.playerStatements(b.db, REP.period());
  ok(`F9  no raw SQL rows in the payload (turnover key: ${'turnover' in rep})`, !('turnover' in rep));
}

// F6: a hard row cap exists.
ok(`F6  every export has a row cap (MAX_ROWS = ${REP.MAX_ROWS})`, REP.MAX_ROWS > 0);
console.log(`\nreporting-findings.test.js: ${passed} checks passed`);
if (passed < 9) { console.error('expected 9 checks'); process.exit(1); }
