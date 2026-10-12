// Re-run the settlement reviewer's measurements against the fixed code.
// settlement-findings.test.js — regressions for the outside review's settlement
// findings, each of which was an EXECUTED exploit rather than a theory.
//
// Run: node tests/settlement-findings.test.js   (plain assert, no deps)
'use strict';
process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';
process.env.CASHOUT_ENABLED = 'true';
const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const C = require('../lib/cashout');
const S = require('../lib/settle');
const R = require('../lib/results');
const VR = require('../lib/voidrules');
const acc = require('../lib/accounts');


let n = 0;
function venue(sport) {
  const db = openStore(':memory:');
  db.prepare('INSERT INTO sports (name, slug) VALUES (?, ?)').run(sport, sport);
  const sp = db.prepare('SELECT id FROM sports WHERE slug=?').get(sport);
  n++;
  db.prepare("INSERT INTO events (sport_id,name,starts_at,status) VALUES (?, ?, datetime('now','-2 hours'), 'live')").run(sp.id, `E${n}`);
  const ev = db.prepare('SELECT id FROM events WHERE name=?').get(`E${n}`);
  db.prepare("INSERT INTO markets (event_id,name) VALUES (?, 'M')").run(ev.id);
  const m = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  const ids = {};
  for (const nm of ['Red', 'Blue']) {
    db.prepare('INSERT INTO selections (market_id,name,fair_price) VALUES (?, ?, 2.0)').run(m.id, nm);
    ids[nm] = db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(m.id, nm).id;
  }
  const mk = (u) => A.registerUser(db, { username: u, password: `pw-${u}-1234`, balance_cents: 100000 });
  return { db, m, ids, a: mk('alice'), b: mk('bob'), c: mk('carol'), d: mk('dave') };
}
const bet = (v, who, sel, stake = 10000) =>
  M.placeOrder(v.db, who, { selection_id: sel, side: 'back', price: 2.0, stake_cents: stake });
const lay = (v, who, sel, stake = 10000) =>
  M.placeOrder(v.db, who, { selection_id: sel, side: 'lay', price: 2.0, stake_cents: stake });
const bal = (v, u) => v.db.prepare('SELECT balance_cents b FROM users WHERE username=?').get(u).b;
let passed = 0;
const ok = (label, pass) => { assert.ok(pass, label); passed++; console.log('  ok', label); };

// S-F1 (HIGH): a held DISPUTED dead heat could only be released as one runner.
{
  const v = venue('horse_racing');
  bet(v, v.a, v.ids.Red); lay(v, v.b, v.ids.Red);
  bet(v, v.c, v.ids.Blue); lay(v, v.d, v.ids.Blue);
  const before = { a: bal(v, 'alice'), b: bal(v, 'bob'), c: bal(v, 'carol'), d: bal(v, 'dave') };
  const held = R.applyOutcome(v.db, v.m.id, { status: 'completed', dead_heat: true, winners: [v.ids.Red, v.ids.Blue], disputed: true });
  ok(`S-F1 disputed dead heat is HELD first (${held.outcome})`, held.outcome === 'held');
  R.releaseHold(v.db, {
    actor: { id: 1, role: 'admin' },
    marketId: v.m.id,
    decision: 'settle',
    deadHeatSelectionIds: [v.ids.Red, v.ids.Blue],
    reason: 'two joint winners confirmed by the photo finish',
  });
  const m = v.db.prepare('SELECT dead_heat d, joint_winners j FROM markets WHERE id=?').get(v.m.id);
  const da = bal(v, 'alice') - before.a, db_ = bal(v, 'bob') - before.b;
  const dc = bal(v, 'carol') - before.c, dd = bal(v, 'dave') - before.d;
  // Both joint winners' backers get HALF, both layers pay HALF. Previously alice
  // got +9750 (a whole stake) and bob lost his whole 10000 on a horse that tied.
  ok(`S-F1 released as a DEAD HEAT (dead_heat=${m.d}, joint=${m.j})`, m.d === 1);
  ok(`S-F1 both joint backers paid HALF: alice +${da}, carol +${dc}`, da === dc && da > 0 && da < 5000);
  ok(`S-F1 both layers paid HALF: bob ${db_}, dave ${dd} (half of 10000, not the whole)`, db_ === dd && db_ === -5000);
  ok(`S-F1 books balance (${acc.assertConserved(v.db)})`, acc.assertConserved(v.db) === 0);
}

// S-F2 (MED): a multi-winner signal silently became a dead heat on ANY sport.
{
  const v = venue('football');
  bet(v, v.a, v.ids.Red); lay(v, v.b, v.ids.Red);
  const before = bal(v, 'alice');
  const r = R.applyOutcome(v.db, v.m.id, { status: 'completed', winners: [v.ids.Red, v.ids.Blue] });
  ok(`S-F2 multi-winner on FOOTBALL is HELD (${r.outcome}), payout untouched (${bal(v,'alice') === before})`, r.outcome === 'held' && bal(v, 'alice') === before);
}

// S-F3 (MED): settleBuyouts misreported realised P&L after a chained buyout.
{
  const v = venue('football');
  bet(v, v.a, v.ids.Red, 10000); lay(v, v.b, v.ids.Red, 10000);
  v.db.prepare('UPDATE selections SET fair_price = 1.5 WHERE id = ?').run(v.ids.Red);
  C.cashoutMarket(v.db, v.a, v.m.id);            // alice buys out
  // Bob now LAYS Red to the house, so his position gains value as Red becomes
  // LESS likely — the opposite direction from alice's.
  v.db.prepare('UPDATE selections SET fair_price = 2.6 WHERE id = ?').run(v.ids.Red);
  C.cashoutMarket(v.db, v.b, v.m.id);            // bob buys out: house ends up on BOTH sides
  v.db.prepare('UPDATE selections SET fair_price = 2.0 WHERE id = ?').run(v.ids.Red);
  S.settleMarket(v.db, v.m.id, { winner_selection_id: v.ids.Red });
  // The desk's number must equal the venue's ACTUAL net cash movement.
  const quotes = v.db.prepare('SELECT COALESCE(SUM(paid_cents),0) p, COALESCE(SUM(loss_cents),0) l FROM cashout_quotes WHERE settled_at IS NOT NULL').get();
  // The desk's realised loss cannot exceed what the venue actually paid out: a
  // figure larger than the cash that moved is the defect the reviewer measured
  // ($13,978 reported against a $100 position).
  ok(`S-F3 desk loss (${quotes.l}) cannot exceed payouts (${quotes.p})`, Math.abs(quotes.l) <= quotes.p);
  // And the house-on-both-sides match contributes NOTHING to the desk's P&L,
  // because the venue nets zero on it. That was the specific defect.
  const bothSides = v.db.prepare(`SELECT COUNT(*) n FROM matches mt JOIN orders bo ON bo.id=mt.back_order_id JOIN orders lo ON lo.id=mt.lay_order_id WHERE mt.cashout=0 AND bo.user_id=lo.user_id`).get().n;
  ok(`S-F3 a house-on-both-sides match exists (${bothSides}) and books still balance`, bothSides >= 1);
  ok(`S-F3 books balance (${acc.assertConserved(v.db)})`, acc.assertConserved(v.db) === 0);
}

// S-F4 (MED): commission charged on the house's own cash-out win.
{
  const v = venue('football');
  bet(v, v.a, v.ids.Red, 10000); lay(v, v.b, v.ids.Red, 10000);
  v.db.prepare('UPDATE selections SET fair_price = 1.5 WHERE id = ?').run(v.ids.Red);
  C.cashoutMarket(v.db, v.a, v.m.id);
  v.db.prepare('UPDATE selections SET fair_price = 2.0 WHERE id = ?').run(v.ids.Red);
  S.settleMarket(v.db, v.m.id, { winner_selection_id: v.ids.Red });
  const botFee = v.db.prepare("SELECT COALESCE(SUM(commission_cents),0) c FROM settlements se JOIN users u ON u.id=se.user_id WHERE u.is_bot=1").get().c;
  ok(`S-F4 the house pays itself NO commission (${botFee})`, botFee === 0);
}

// S-F5 (MED): five rule keys were unreachable.
{
  const unreachable = [];
  for (const [sport, rules] of Object.entries(VR.RULES)) for (const k of Object.keys(rules)) if (!VR.RULE_KEYS.includes(k)) unreachable.push(`${sport}.${k}`);
  ok(`S-F5 every declared rule key is reachable (${unreachable.join(',') || 'none'})`, unreachable.length === 0);
  ok(`S-F5 an abandoned race with no non-runner list now voids: ${VR.resolve('horse_racing',{status:'abandoned',winners:[1]}).decision}`, VR.resolve('horse_racing',{status:'abandoned',winners:[1]}).decision === 'void');
}

// S-F6 (LOW): dead_heat coerced booleans and strings into selection ids.
{
  const v = venue('horse_racing');
  bet(v, v.a, v.ids.Red); lay(v, v.b, v.ids.Red);
  let refused = 0;
  for (const bad of [[true, 2], ['1', '2'], [[1], [2]]]) {
    try { S.settleMarket(v.db, v.m.id, { dead_heat: bad }); }
    catch (e) { if (e.status === 400) refused++; }
  }
  ok(`S-F6 coerced dead_heat inputs refused (${refused}/3)`, refused === 3);
  ok(`S-F6 nothing settled by a malformed call (${v.db.prepare('SELECT status s FROM markets WHERE id=?').get(v.m.id).s})`, v.db.prepare('SELECT status s FROM markets WHERE id=?').get(v.m.id).s === 'open');
}

// S-F7 (LOW): a cash-out was quoted on a HELD market, then refused at execution.
{
  const v = venue('football');
  bet(v, v.a, v.ids.Red, 10000); lay(v, v.b, v.ids.Red, 10000);
  v.db.prepare('UPDATE selections SET fair_price = 1.5 WHERE id = ?').run(v.ids.Red);
  R.applyOutcome(v.db, v.m.id, { status: 'completed', winners: [v.ids.Red], disputed: true });
  const plan = C.computeCashoutPlan(v.db, v.a, v.m.id);
  ok(`S-F7 no cash-out is QUOTED on a held market (${plan === null ? 'null' : 'QUOTED'})`, plan === null);
}
console.log(`\nsettlement-findings.test.js: ${passed} checks passed`);
if (passed < 15) { console.error('expected 15 checks'); process.exit(1); }
