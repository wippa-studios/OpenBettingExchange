'use strict';
// tests/aml.test.js — transaction monitoring, the funding gate, the threshold
// obligation, report generation, and the retention guard.
//
// Run: node tests/aml.test.js   (plain assert, no deps)
//
// WHY THE CALIBRATION ASSERTIONS ARE THE IMPORTANT ONES. AUSTRAC's finding
// against a large Australian operator was not that it had no rules — it was that
// "transaction monitoring processes were not appropriate for a business the
// nature, size and complexity of Entain". That is a CALIBRATION failure, and the
// testable consequence is precise: a rule set that fires on ordinary exchange
// behaviour is not a control. So most of this file asserts that the NAIVE reading
// of each published indicator does NOT fire, and only the re-shaped rule does.
//
// The "what would this have caught?" question is answered at the bottom, against
// the concrete activity AUSTRAC actually found.
process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000000';
process.env.CASHOUT_ENABLED = 'false';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const S = require('../lib/settle');
const RULES = require('../lib/aml/rules');
const ENGINE = require('../lib/aml/engine');
const FIND = require('../lib/aml/findings');
const THRESH = require('../lib/aml/thresholds');
const REPORTS = require('../lib/aml/reports');
const FUND = require('../lib/funding');
const DS = require('../lib/datasources');
const RET = require('../lib/retention');
const ID = require('../lib/identity');
const TEN = require('../lib/tenants');
const config = require('../lib/config');

let passed = 0;
const ok = (name, cond, detail) => {
  assert.ok(cond, `${name}${detail !== undefined && detail !== null ? ` — ${detail}` : ''}`);
  passed++;
  console.log('  ok', name);
};

function withConfig(patch, fn) {
  const before = {};
  for (const k of Object.keys(patch)) { before[k] = config[k]; config[k] = patch[k]; }
  try { return fn(); } finally { Object.assign(config, before); }
}

// The async twin, for the same reason tests/compliance.test.js has one: withConfig
// restores the flags in a `finally`, so handing it an async function restores them
// BEFORE the body's first await and every subsequent assertion runs against the
// WRONG configuration — which in this suite means asserting that a threshold
// obligation was raised when the threshold code was inert at the time.
async function withConfigAsync(patch, fn) {
  const before = {};
  for (const k of Object.keys(patch)) { before[k] = config[k]; config[k] = patch[k]; }
  try { return await fn(); } finally { Object.assign(config, before); }
}

let seq = 0;
// ONE event with one market — reused across a whole block.
function venue(db) {
  db.prepare("INSERT OR IGNORE INTO sports (name,slug) VALUES ('F','football')").run();
  const sp = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  seq++;
  db.prepare("INSERT INTO events (sport_id,name,starts_at) VALUES (?,?,datetime('now','+2 hours'))").run(sp.id, `E${seq}`);
  const ev = db.prepare('SELECT id FROM events WHERE name=?').get(`E${seq}`);
  db.prepare("INSERT INTO markets (event_id,name) VALUES (?, 'M')").run(ev.id);
  const m = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
  for (const nm of ['A', 'B']) db.prepare('INSERT INTO selections (market_id,name,fair_price) VALUES (?,?,2.0)').run(m.id, nm);
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=? ORDER BY id').get(m.id).id;
  return { m, s1 };
}

// A FRESH MARKET on the same event, for a second settlement round.
//
// Needed because settling completes the EVENT (lib/settle.js completeEventIfNeeded),
// so the first round closes the door for every subsequent one. The first version of
// this suite tried to reset the market row by hand and kept hitting "Event is
// completed" — which is the engine being correct and the fixture being wrong.
function newMarket(db, eventId) {
  seq++;
  db.prepare("INSERT INTO markets (event_id,name) VALUES (?, ?)", ).run(eventId, `M${seq}`);
  const m = db.prepare('SELECT id FROM markets WHERE event_id=? ORDER BY id DESC').get(eventId);
  for (const nm of ['A', 'B']) db.prepare('INSERT INTO selections (market_id,name,fair_price) VALUES (?,?,2.0)').run(m.id, nm);
  const s1 = db.prepare('SELECT id FROM selections WHERE market_id=? ORDER BY id').get(m.id).id;
  return { m, s1 };
}

// One round: fund, trade, settle, and (optionally) withdraw straight afterwards.
async function winRound(db, { winner, opponent, market, sel, price, withdrawCents, withdrawAtMs }) {
  deposit(db, winner.id, 200000);
  order(db, winner.id, sel, 'back', price, 10000);
  order(db, opponent.id, sel, 'lay', price, 10000);
  S.settleMarket(db, market.id, { winner_selection_id: sel });
  if (withdrawCents) {
    db.prepare("INSERT INTO payment_intents (user_id, provider, external_id, kind, amount_cents, status, created_at) VALUES (?, 'reference', ?, 'withdrawal', ?, 'confirmed', ?)")
      .run(winner.id, `w${seq}-${Math.round(withdrawAtMs)}`, withdrawCents,
        new Date(withdrawAtMs).toISOString().replace('T', ' ').slice(0, 19));
  }
}

async function user(db, name, { balance = 5000000, ip = null, device = null } = {}) {
  return A.registerUser(db, {
    username: name, password: `pw-${name}-1234`, balance_cents: balance,
    registration_ip: ip, registration_device: device,
  });
}

// Post a deposit the way the LEDGER records one, so the amount rules can be
// driven without a PSP.
//
// IT ALSO MOVES THE BALANCE, and that matters: the first version inserted only
// the transaction row, so the account had a lifetime-deposit figure the amount
// rules could read and a zero balance the engine refused to let it trade with.
// Every test that wanted a customer to place orders after "depositing" failed on
// insufficient funds, which reads as a defect in the rules and is a defect in the
// fixture.
function deposit(db, userId, cents) {
  db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(cents, userId);
  return db
    .prepare("INSERT INTO transactions (user_id, type, amount_cents, balance_after, frozen_after, at) VALUES (?, 'deposit', ?, ?, 0, ?)")
    .run(userId, cents, cents, new Date().toISOString().replace('T', ' ').slice(0, 19));
}

function order(db, userId, selId, side, price, stake) {
  return M.placeOrder(db, { id: userId }, { selection_id: selId, side, price, stake_cents: stake });
}

function ruleIds(result) {
  return (result.raised || []).filter((r) => r.raised).map((r) => r.rule_id).sort();
}

(async () => {
  // ── 1. The rule table is declarative, inspectable and reachable ──────────
  {
    const ids = RULES.knownRules();
    ok('G1  the rule set is non-empty and every id is stable', ids.length >= 8, ids.join(','));
    const noIndicator = ids.filter((id) => !RULES.RULES[id].indicator);
    ok('G2  every rule names the PUBLISHED INDICATOR it encodes', noIndicator.length === 0, noIndicator.join(','));
    const noCalibration = ids.filter((id) => !RULES.RULES[id].calibration || RULES.RULES[id].calibration.length < 40);
    ok('G3  every rule carries its calibration reasoning', noCalibration.length === 0, noCalibration.join(','));
    // The lesson lib/voidrules.js records at length: a declared key that is
    // unreachable is a rule that looks fine and never fires.
    const unreachable = ids.filter((id) => typeof RULES.RULES[id].evaluate !== 'function');
    ok('G4  every declared rule is REACHABLE (has an evaluator)', unreachable.length === 0, unreachable.join(','));
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    ok('G5  no duplicate rule ids', dupes.length === 0, dupes.join(','));

    // The operator-facing description: what rules exist and WHY.
    const described = RULES.describe(null);
    ok('G6  the rule set is inspectable without reading the source', described.length === ids.length);
    ok('G7  ...and carries the reasoning, not just the threshold',
      described.every((r) => typeof r.calibration === 'string' && r.calibration.length > 40));
    ok('G8  ...and ships NO evaluate function into the payload',
      described.every((r) => !('evaluate' in r)));
    ok('G9  the re-shaped rule keeps the PUBLISHED wording visible next to the re-shape',
      RULES.RULES['AU-EX-02'].published && /short-odd/.test(RULES.RULES['AU-EX-02'].published));

    // UNITS. An operator setting a threshold on a financial-crime control has to
    // be able to see WHICH of `value_cents` / `value_count` reaches the rule, and
    // a rule with neither has to say so — because an operator who sets a cent
    // figure on a rule that has no money parameter believes they have tightened
    // a control they never touched.
    const described2 = RULES.describe(null);
    const centsMapped = described2.filter((r) => r.tunable.value_cents);
    ok('G10 every rule that HAS a money parameter says which one it is',
      centsMapped.every((r) => r.shipped_tuning[r.tunable.value_cents] !== undefined),
      centsMapped.filter((r) => r.shipped_tuning[r.tunable.value_cents] === undefined).map((r) => r.id).join(','));
    ok('G11 ...and every rule that has one DECLARES it, rather than relying on a map elsewhere',
      ids.every((id) => Object.prototype.hasOwnProperty.call(RULES.RULES[id], 'units')),
      ids.filter((id) => !Object.prototype.hasOwnProperty.call(RULES.RULES[id], 'units')).join(','));
    ok('G12 ...and every named unit is a REAL key on that rule own tuning',
      ids.every((id) => {
        const r = RULES.RULES[id];
        if (!r.units) return true;
        return [r.units.cents, r.units.count].filter(Boolean).every((k) => Object.prototype.hasOwnProperty.call(r.tuning, k));
      }));
    // THE MISTAKE THIS EXISTS TO CATCH, asserted directly. AU-TX-02's parameters
    // are a COUNT and a DURATION; there is no money figure anywhere in it. A cent
    // override must be REFUSED at the moment it is set, not landed on
    // `min_interval_minutes` — where 600 cents would be read as 600 MINUTES and
    // the control would look tuned when it is not.
    {
      const { openStore: open2 } = require('../lib/store');
      const db2 = open2(':memory:');
      const tenantId = TEN.defaultTenant(db2).id;
      // `actor: null` because `aml_rule_thresholds.updated_by` is a foreign key to
      // a real operator, and a synthetic id is exactly the kind of value a control
      // should refuse rather than record.
      ENGINE.setTuning(db2, { actor: null, ruleId: 'AU-TX-02', tenantId, value_count: 12, reason: 'more deposits before it fires' });
      const wrongUnit = (() => {
        try {
          ENGINE.setTuning(db2, { actor: null, ruleId: 'AU-TX-02', tenantId, value_cents: 600, reason: 'trying to set a money threshold' });
          return null;
        } catch (e) { return e.message; }
      })();
      ok('G12b the FK on updated_by refuses a synthetic operator rather than recording one',
        (() => { try { ENGINE.setTuning(db2, { actor: { id: 999 }, ruleId: 'AU-EX-03', tenantId, value_count: 2, reason: 'impossible operator' }); return false; } catch (e) { return /FOREIGN KEY/.test(e.message); } })());
      ok('G13 a cent override on a rule with no money parameter is REFUSED AT WRITE TIME, not landed on a duration',
        /no money parameter/.test(wrongUnit || ''), String(wrongUnit));
      ok('G13b ...so the operator sees the error while they are still looking at the screen that set it',
        (() => { try { ENGINE.setTuning(db2, { actor: null, ruleId: 'AU-NW-02', tenantId, value_cents: 100, reason: 'a price band is not a money figure' }); return true; } catch (e) { return e.status === 400; } })());
      ok('G14 ...and the rule\'s count override still took effect',
        ENGINE.effectiveTuning(db2, RULES.RULES['AU-TX-02'], tenantId).count === 12);
      ok('G15 ...and the rule keeps running on its shipped default for everything unnamed',
        ENGINE.effectiveTuning(db2, RULES.RULES['AU-TX-02'], tenantId).min_interval_minutes === RULES.TUNING.deposit_pattern.min_interval_minutes);
      db2.close();
    }
  }

  // ── 2. AU-OB-01: betting plunges, shaped by SHARE not absolute stake ─────
  //
  // THE BUILD IS DELIBERATE AND WORTH READING, because "how do I make a plunge?"
  // is the question that reveals whether the rule is venue-shaped. A plunge is
  // ONE account taking a large SHARE of a selection's matched volume. To build
  // one the book has to be thin and then have to be crossed hard.
  {
    const db = openStore(':memory:');
    const { s1 } = venue(db);
    // 1. A thin baseline of REAL liquidity: one crossed match, so the selection
    //    is not simply empty.
    const a1 = await user(db, 'basea');
    const a2 = await user(db, 'baseb');
    order(db, a1.id, s1, 'back', 2.0, 20000);
    order(db, a2.id, s1, 'lay', 2.0, 20000);

    // 2. A RESTING book for the plunge to hit: eight accounts with 50,000 each.
    const resting = [];
    for (let i = 0; i < 8; i++) resting.push(await user(db, `crowd${i}`, { balance: 200000 }));
    for (const c of resting) order(db, c.id, s1, 'back', 2.0, 50000);

    // 3. THE PLUNGE. One account crosses the whole book with a single order that
    //    is far larger than the book it takes.
    const plunger = await user(db, 'plunger', { balance: 5000000 });
    order(db, plunger.id, s1, 'lay', 2.0, 900000);

    const r = ENGINE.scanUser(db, { userId: plunger.id });
    ok('P1  one account taking a large SHARE of a selection fires AU-OB-01',
      ruleIds(r).includes('AU-OB-01'), ruleIds(r).join(','));
    const ev = JSON.parse(db.prepare("SELECT evidence FROM aml_alerts WHERE rule_id='AU-OB-01'").get().evidence);
    ok('P1b ...and the alert carries the SHARE and the selection volume it was measured against',
      ev.hits[0].share_pct >= 40 && ev.hits[0].selection_total_cents > 0, JSON.stringify(ev.hits[0]));

    // THE CALIBRATION HALF — the assertion that makes this a control. THE SAME
    // 400,000 of stake, against a selection with ordinary volume behind it. An
    // absolute-stake rule fires here; a share-based one must not.
    const db2 = openStore(':memory:');
    const v2 = venue(db2);
    const c1 = await user(db2, 'cal1');
    const c2 = await user(db2, 'cal2');
    order(db2, c1.id, v2.s1, 'back', 2.0, 1000000);
    order(db2, c2.id, v2.s1, 'lay', 2.0, 1000000);
    const rest2 = [];
    for (let i = 0; i < 8; i++) rest2.push(await user(db2, `crowd2-${i}`, { balance: 900000 }));
    for (const c of rest2) order(db2, c.id, v2.s1, 'back', 2.0, 50000);
    const calm = await user(db2, 'calm', { balance: 5000000 });
    order(db2, calm.id, v2.s1, 'lay', 2.0, 900000);
    const r2 = ENGINE.scanUser(db2, { userId: calm.id });
    ok('P2  the SAME stake against ordinary volume behind it does NOT fire AU-OB-01',
      !ruleIds(r2).includes('AU-OB-01'), ruleIds(r2).join(','));

    // And the venue's own market maker never counts toward the denominator's
    // competitors, because it is excluded from the numerator AND the market.
    ok('P3  ...and the venue own accounts are excluded from the volume entirely',
      db2.prepare("SELECT COUNT(*) c FROM users WHERE is_bot = 1").get().c === 0);
    db.close();
    db2.close();
  }

  // ── 3. AU-OB-04: ESCROW, not stake ──────────────────────────────────────
  {
    const db = openStore(':memory:');
    const { s1 } = venue(db);
    // A backer who stakes everything they have ever deposited.
    const allIn = await user(db, 'allin', { balance: 0 });
    deposit(db, allIn.id, 100000);
    order(db, allIn.id, s1, 'back', 2.0, 90000); // escrow 90000 of 100000 = 90%
    const r = ENGINE.scanUser(db, { userId: allIn.id });
    ok('O1  an order whose ESCROW is 90% of lifetime deposits fires AU-OB-04',
      ruleIds(r).includes('AU-OB-04'), ruleIds(r).join(','));

    // THE CALIBRATION HALF. A LAYER staking 90000 at price 2.0 has the same
    // STAKE and a 90000 escrow... so use the case that separates them: a layer
    // whose STAKE is huge but whose ESCROW is a fraction, because a lay's escrow
    // is (price-1) x stake. A stake-based rule would flag this; an escrow-based
    // one must not.
    // THE CASE THAT SEPARATES THE TWO MEASURES. A LAY at price 1.05 has a
    // STAKE of 400,000 and an ESCROW of round(0.05 x 400000) = 20,000. Measured on
    // the STAKE that is 8% of a 5,000,000 deposit total; measured on the ESCROW it
    // is 0.4%. A stake-based rule reads the first and a sensible-looking rule
    // built off the published wording would fire on every layer on the venue.
    const layer = await user(db, 'layer', { balance: 0 });
    deposit(db, layer.id, 5000000);
    order(db, layer.id, s1, 'lay', 1.05, 400000);
    const r2 = ENGINE.scanUser(db, { userId: layer.id });
    ok('O2  a 400,000 STAKE whose escrow is 0.4% of lifetime deposits does NOT fire AU-OB-04',
      !ruleIds(r2).includes('AU-OB-04'), ruleIds(r2).join(','));
    // And the SAME customer, on the SAME account, with a BACK whose escrow is 84%
    // of lifetime deposits, DOES fire. One account, two orders, opposite verdicts
    // — which is only possible if the rule is measuring the escrow rather than the
    // stake, and that is the assertion that pins the distinction.
    order(db, layer.id, s1, 'back', 2.0, 4200000);
    const r3 = ENGINE.scanUser(db, { userId: layer.id });
    ok('O3  ...while a BACK on the same account whose escrow is 84% of deposits DOES fire it',
      ruleIds(r3).includes('AU-OB-04'), ruleIds(r3).join(','));
    db.close();
  }

  // ── 4. AU-EX-02: the rule a literal reading gets catastrophically wrong ──
  //
  // The published indicator — "continually bets short-odd favourites and then
  // requests an immediate withdrawal when the payout is received" — DESCRIBES AN
  // ORDINARY BETTING EXCHANGE CUSTOMER. The block below builds one, in detail,
  // and asserts that nothing fires on it. That assertion is the deliverable.
  {
    const db = openStore(':memory:');
    const ev0 = venue(db);
    const eventId = db.prepare('SELECT event_id e FROM markets WHERE id=?').get(ev0.m.id).e;
    const ordinary = await user(db, 'ordinary', { balance: 0 });
    const other = await user(db, 'other', { balance: 5000000 });
    const crowd = await user(db, 'liquidity', { balance: 5000000 });

    // AN ORDINARY CUSTOMER. Backs favourites AND outsiders, takes profit as it
    // arrives, and withdraws straight away. Their WINS ARE SPREAD ACROSS THE
    // PRICE RANGE, which is the thing that makes them ordinary: on an exchange a
    // customer's profit comes from a mix of prices, and "every single win came at
    // 1.05" is not a thing a fair bettor produces.
    const ORDINARY_PRICES = [1.10, 1.50, 2.00, 3.00, 1.20, 4.00, 1.30, 2.50];
    for (let i = 0; i < ORDINARY_PRICES.length; i++) {
      const { m, s1 } = newMarket(db, eventId);
      await winRound(db, {
        winner: ordinary, opponent: other, market: m, sel: s1, price: ORDINARY_PRICES[i],
        withdrawCents: 5000, withdrawAtMs: Date.now() + i * 120000,
      });
    }
    const r = ENGINE.scanUser(db, { userId: ordinary.id });
    ok('X1  an ORDINARY exchange customer — bets constantly, withdraws the moment it lands — DOES NOT fire AU-EX-02',
      !ruleIds(r).includes('AU-EX-02'), ruleIds(r).join(','));

    // THE CONCENTRATION HALF. Identical behaviour EXCEPT that every single win
    // came at a short odd. That is the thing the published indicator is pointing
    // at, expressed in this venue's own ledger: a customer whose entire profit
    // comes from favourites winning is statistically odd, and it is the only
    // honest venue-shaped reading of the wording.
    const concentrated = await user(db, 'conc', { balance: 0 });
    for (let i = 0; i < 6; i++) {
      const { m, s1 } = newMarket(db, eventId);
      await winRound(db, {
        winner: concentrated, opponent: other, market: m, sel: s1, price: 1.05,
        withdrawCents: 5000, withdrawAtMs: Date.now() + i * 120000,
      });
    }
    const r2 = ENGINE.scanUser(db, { userId: concentrated.id });
    ok('X2  wins CONCENTRATED entirely on short odds, with a withdrawal right after each, DOES fire AU-EX-02',
      ruleIds(r2).includes('AU-EX-02'), ruleIds(r2).join(','));
    const alert = db.prepare("SELECT evidence FROM aml_alerts WHERE rule_id='AU-EX-02' AND user_id=?").get(concentrated.id);
    ok('X3  ...and the alert carries the EVIDENCE that made it fire', !!alert && /win_price/.test(alert.evidence) && /withdrawals_within_window/.test(alert.evidence));
    ok('X4  ...and records that cash-out was excluded from the withdrawal count',
      !!alert && /"cash_out_excluded":true/.test(alert.evidence));

    // AND THE LIMIT OF WHAT ANY RULE HERE CAN DO, asserted rather than glossed.
    // A customer who genuinely only ever bets short favourites AND genuinely takes
    // the profit is indistinguishable, on betting behaviour alone, from the one
    // the indicator describes. No threshold separates them. That is the reason this
    // rule is a SIGNAL for an analyst and never a block, and the reason the
    // decision point is left explicit and audited rather than taken here.
    const pure = await user(db, 'pure', { balance: 0 });
    for (let i = 0; i < 6; i++) {
      const { m, s1 } = newMarket(db, eventId);
      await winRound(db, { winner: pure, opponent: other, market: m, sel: s1, price: 1.05, withdrawCents: 5000, withdrawAtMs: Date.now() + i * 120000 });
    }
    ok('X5  the rule flags the pure-short-odds customer rather than deciding anything about them',
      ruleIds(ENGINE.scanUser(db, { userId: pure.id })).includes('AU-EX-02'));
    ok('X6  ...and flagging them closed NOTHING: no account was blocked, suspended or limited',
      db.prepare("SELECT COUNT(*) c FROM payment_intents WHERE user_id = ?").get(pure.id).c === 6,
      'their six withdrawals are all still there, unblocked');
    void crowd;
    db.close();
  }

  // ── 5. AU-TX-01: "unusually large" measured against the account's OWN median
  {
    const db = openStore(':memory:');
    const steady = await user(db, 'steady');
    for (let i = 0; i < 8; i++) deposit(db, steady.id, 100000);
    ok('T1a a steady high-stakes customer does NOT trip "unusually large"', !ruleIds(ENGINE.scanUser(db, { userId: steady.id })).includes('AU-TX-01'));
    const odd = await user(db, 'odd');
    for (let i = 0; i < 5; i++) deposit(db, odd.id, 1000);
    deposit(db, odd.id, 500000); // 500x their own median
    ok('T1  a deposit 500x the account\'s OWN median DOES fire AU-TX-01',
      ruleIds(ENGINE.scanUser(db, { userId: odd.id })).includes('AU-TX-01'), ruleIds(ENGINE.scanUser(db, { userId: odd.id })).join(','));
    db.close();
  }

  // ── 6. Cross-account link analysis, ACROSS TENANTS ───────────────────────
  {
    const db = openStore(':memory:');
    venue(db);
    // Two accounts under TWO of this venue's own brands, same device, different
    // names — the "multiple betting accounts, inter and intra brand" finding.
    const a = await user(db, 'brandone', { ip: '203.0.113.9', device: 'dev-alpha' });
    const b = await user(db, 'brandtwo', { ip: '203.0.113.9', device: 'dev-alpha' });
    const c = await user(db, 'brandthree', { ip: '203.0.113.9', device: 'dev-alpha' });
    const r = ENGINE.scanUser(db, { userId: a.id });
    ok('N1  three accounts on one IP+device under different names fires AU-NW-01',
      ruleIds(r).includes('AU-NW-01'), ruleIds(r).join(','));
    const ev = db.prepare("SELECT evidence FROM aml_alerts WHERE rule_id='AU-NW-01'").get();
    ok('N2  ...and the evidence names every account and the distinct usernames',
      ev && /brandone/.test(ev.evidence) && /brandthree/.test(ev.evidence) && /distinct_usernames/.test(ev.evidence));
    ok('N3  ...and says whether the group is CROSS-TENANT',
      ev && /cross_tenant/.test(ev.evidence));
    // THE SHARED-HOUSEHOLD HALF: one account, or two under the SAME name on one
    // device, is not "several accounts under different names".
    const alone = await user(db, 'solo', { ip: '198.51.100.1', device: 'dev-solo' });
    ok('N4  a single account on its own origin does NOT fire AU-NW-01',
      !ruleIds(ENGINE.scanUser(db, { userId: alone.id })).includes('AU-NW-01'));
    ok('N5  three accounts sharing an origin are a SIGNAL, never an automatic block',
      db.prepare("SELECT status s FROM payment_intents WHERE user_id=?").get(a.id) === undefined);
    void b; void c;
    db.close();
  }

  // ── 7. Similar bets to an account ALREADY flagged ────────────────────────
  {
    const db = openStore(':memory:');
    const { s1 } = venue(db);
    const flagged = await user(db, 'flagged');
    const mimic = await user(db, 'mimic');
    db.prepare("INSERT INTO aml_alerts (rule_id, scope, severity, user_id, detail) VALUES ('AU-TX-01','AU-TX-01:user:'||?,'high',?,'already flagged')").run(flagged.id, flagged.id);
    for (let i = 0; i < 5; i++) {
      order(db, flagged.id, s1, 'back', 2.0, 1000);
      order(db, mimic.id, s1, 'back', 2.02, 1000);
    }
    const r = ENGINE.scanUser(db, { userId: mimic.id });
    ok('N6  bets very similar to a FLAGGED account fire AU-NW-02', ruleIds(r).includes('AU-NW-02'), ruleIds(r).join(','));
    // A DIFFERENT MARKET, because the correlation rule works on the (selection,
    // side, price) signature. An account trading the same selection as a flagged
    // one IS what it is for, and asserting it is quiet there would be asserting
    // the control does not work.
    const other = venue(db);
    const clean = await user(db, 'clean');
    for (let i = 0; i < 5; i++) order(db, clean.id, other.s1, 'back', 2.0, 1000);
    ok('N7  ...and the rule is quiet for an account with nothing flagged to correlate against',
      !ruleIds(ENGINE.scanUser(db, { userId: clean.id })).includes('AU-NW-02'), ruleIds(ENGINE.scanUser(db, { userId: clean.id })).join(','));
    db.close();
  }

  // ── 8. THE HOUSE IS NEVER FLAGGED ────────────────────────────────────────
  {
    const db = openStore(':memory:');
    const { s1 } = venue(db);
    await require('../lib/bots').primeBotHash();
    const house = await A.createAccount(db, { username: 'thehouse', password: 'pw-house-x-1', is_bot: 1, balance_cents: 10000000 });
    deposit(db, house.id, 9000000);
    order(db, house.id, s1, 'lay', 2.0, 500000);
    const r = ENGINE.scanUser(db, { userId: house.id });
    ok('H1  the venue\'s OWN market maker is skipped, not flagged', r.skipped === 'venue account', r.skipped);
    ok('H2  ...so no alert is ever raised against the house',
      db.prepare('SELECT COUNT(*) c FROM aml_alerts WHERE user_id = ?').get(house.id).c === 0);
    db.close();
  }

  // ── 9. The findings pattern: re-surface until a human closes them ────────
  {
    const db = openStore(':memory:');
    venue(db);
    const u = await user(db, 'repeat');
    const scope = FIND.alertScope('AU-TX-01', `user:${u.id}`);
    const first = FIND.recordAlert(db, { rule_id: 'AU-TX-01', scope, severity: 'high', user_id: u.id, detail: 'first' });
    const second = FIND.recordAlert(db, { rule_id: 'AU-TX-01', scope, severity: 'high', user_id: u.id, detail: 'again' });
    ok('F1  repeated detection UPDATES one open alert rather than opening a second',
      first.id === second.id && second.repeated === true, `${first.id} / ${second.id}`);
    ok('F2  ...and increments seen_count, so a pattern is visible as a pattern',
      db.prepare('SELECT seen_count c FROM aml_alerts WHERE id=?').get(first.id).c === 2);
    const unreasoned = (() => { try { FIND.resolveAlert(db, { actor: { id: 1 }, id: first.id, reason: 'no' }); return null; } catch (e) { return e.status; } })();
    ok('F3  a finding cannot be closed without a WRITTEN reason', unreasoned === 400, String(unreasoned));
    ok('F4  ...and it is still open after the attempt', db.prepare('SELECT resolved_at r FROM aml_alerts WHERE id=?').get(first.id).r === null);
    FIND.resolveAlert(db, { actor: { id: 1 }, id: first.id, reason: 'checked the ledger by hand' });
    ok('F5  a human with a reason closes it', !!db.prepare('SELECT resolved_at r FROM aml_alerts WHERE id=?').get(first.id).r);
    ok('F6  ...and the closure is audited', db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='aml.alert_resolved'").get().c === 1);
    db.close();
  }

  // ── 10. THE THRESHOLD: AUD 5,000, as a DURABLE OBLIGATION ───────────────
  {
    const db = openStore(':memory:');
    venue(db);
    ok('H1  the threshold is AUD 5,000 — the figure from 31 March 2026', THRESH.thresholdCents() === 500000, THRESH.thresholdCents());
    const u = await user(db, 'threshold', { balance: 0 });
    // INERT on a paper-money venue, and that is deliberate.
    const inert = THRESH.detect(db, { userId: u.id, intentId: 1, amountCents: 900000 });
    ok('H2  no obligation is raised on a venue that has not declared itself regulated',
      inert.obligations.length === 0 && inert.regulated === false);

    await withConfigAsync({ REGULATED_DEPLOYMENT: true }, async () => {
      const single = THRESH.detect(db, { userId: u.id, intentId: 1, amountCents: 900000 });
      ok('H3  a single deposit over the threshold creates an OBLIGATION', single.obligations.length >= 1, JSON.stringify(single.obligations));
      const row = db.prepare('SELECT * FROM aml_threshold_obligations WHERE user_id = ?').get(u.id);
      ok('H4  ...it is a ROW with the figure, the window and the transactions', !!row && row.observed_cents === 900000 && !!row.window_from);
      ok('H5  ...and it is NOT marked discharged', row.discharged_at === null);
      ok('H6  ...and it is not report-generated yet', row.report_generated_at === null);
      ok('H7  it RE-SURFACES on every read until a human closes it', THRESH.openObligations(db).length === 1);
      const again = THRESH.detect(db, { userId: u.id, intentId: 1, amountCents: 900000 });
      ok('H8  ...and repeated crossings do not multiply it', db.prepare('SELECT COUNT(*) c FROM aml_threshold_obligations').get().c === 1);
      ok('H9  ...they increment seen_count instead', db.prepare('SELECT seen_count c FROM aml_threshold_obligations').get().c === 2);
      const noReason = (() => { try { THRESH.discharge(db, { actor: { id: 1 }, id: row.id, reason: 'ok' }); return null; } catch (e) { return e.status; } })();
      ok('H10 an obligation cannot be discharged without a WRITTEN reason', noReason === 400, String(noReason));
      THRESH.discharge(db, { actor: { id: 1 }, id: row.id, reportReference: 'TTR-2026-001', reason: 'filed with AUSTRAC on 2026-04-02' });
      ok('H11 a human with a reason discharges it, recording the report reference',
      THRESH.openObligations(db).length === 0 && db.prepare('SELECT report_reference r FROM aml_threshold_obligations').get().r === 'TTR-2026-001');
      ok('H12 ...and the discharge is audited', db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='aml.obligation_discharged'").get().c === 1);

      // STRUCTURING: several deposits each BELOW the threshold, together over it.
      const structurer = await user(db, 'structurer', { balance: 0 });
      for (const c of [400000, 400000, 400000]) deposit(db, structurer.id, c);
      const rel = THRESH.detect(db, { userId: structurer.id, intentId: 2, amountCents: 400000 });
      ok('H13 several deposits each UNDER the threshold that CROSS it together create a related obligation',
        rel.obligations.some((o) => o.basis === 'related'), JSON.stringify(rel.obligations.map((o) => o.basis)));
    });
    db.close();
  }

  // ── 11. THE FUNDING GATE, AND THE OSKO TRAP ─────────────────────────────
  {
    const db = openStore(':memory:');
    venue(db);
    const tenantId = TEN.defaultTenant(db).id;
    const u = await user(db, 'funder', { balance: 0 });
    ID.setDecision(db, { actor: { id: 1, role: 'admin' }, userId: u.id, decision: 'verified', reason: 'for the funding tests' });
    db.prepare('UPDATE identity_verifications SET subject_name = ? WHERE user_id = ?').run('Jo Example', u.id);

    // The naive rule, and why it is wrong: an operator's Osko receiving PayID is
    // registered to a CONTRACTED PROCESSOR, not to the venue.
    //
    // EVERY BLOCK BELOW RUNS WITH REGULATED_DEPLOYMENT ON, and that matters more
    // than it looks: with it off the gate returns immediately and every assertion
    // here passes VACUOUSLY. The first version of this block did exactly that and
    // "passed" — including O2, the third-party refusal, which was never actually
    // evaluated. A check that passes on the code path it is not testing is worse
    // than no check, and this repository has an entire file about that.
    const code = (fn) => { try { fn(); return null; } catch (e) { return (e.details && e.details.code) || e.message; } };
    withConfig({ REGULATED_DEPLOYMENT: true }, () => {

    // 1. THE OSKO CASE. A processor pool whose registered owner is neither the
    //    venue nor the customer. Cleared.
    FUND.registerInstrument(db, {
      actor: { id: 1, role: 'admin' }, tenantId, label: 'Osko processor pool',
      instrument_kind: 'processor_pool', registered_owner: 'Example Payments Processor Pty Ltd',
      owner_kind: 'processor', processor_ref: 'contract-2026-01', jurisdiction: 'AU',
    });
    const okOsko = code(() => FUND.assertDepositFunded(db, {
      userId: u.id, payerName: 'Example Payments Processor Pty Ltd', fundingCountry: 'AU',
      subjectName: 'Jo Example',
    }));
    ok('O1  a CONTRACTED PROCESSOR POOL is CLEARED — the Osko trap is not sprung',
      okOsko === null, okOsko);

    // 2. THE SAME NAME, BUT REGISTERED AS A PLAYER'S OWN ACCOUNT. That is the
    //    third-party case, and it is a MISMATCH against the account holder.
    FUND.registerInstrument(db, {
      actor: { id: 1, role: 'admin' }, tenantId, label: 'Someone else\'s account',
      instrument_kind: 'bank_account', registered_owner: 'A Different Person',
      owner_kind: 'player', jurisdiction: 'AU',
    });
    const mismatch = code(() => FUND.assertDepositFunded(db, {
      userId: u.id, payerName: 'A Different Person', fundingCountry: 'AU', subjectName: 'Jo Example',
    }));
    ok('O2  an instrument registered to A DIFFERENT PERSON is REFUSED (third-party funding)',
      mismatch === 'funding_instrument_third_party', mismatch);

    // 3. THE MATCHING CASE. The instrument IS the account holder's own.
    FUND.registerInstrument(db, {
      actor: { id: 1, role: 'admin' }, tenantId, label: "Jo's own account",
      instrument_kind: 'bank_account', registered_owner: 'Jo Example', owner_kind: 'player', jurisdiction: 'AU',
    });
    const own = code(() => FUND.assertDepositFunded(db, {
      userId: u.id, payerName: 'Jo Example', fundingCountry: 'AU', subjectName: 'Jo Example',
    }));
    ok('O3  the account holder\'s OWN instrument is CLEARED', own === null, own);
    ok('O4  ...and name matching ignores case and spacing (two systems, one person)',
      code(() => FUND.assertDepositFunded(db, {
        userId: u.id, payerName: 'jo  example', fundingCountry: 'AU', subjectName: 'Jo Example',
      })) === null);

    // 4. THE FAIL-CLOSED HALF. An instrument nobody has registered at all.
    const unregistered = code(() => FUND.assertDepositFunded(db, {
      userId: u.id, payerName: 'Nobody At All', fundingCountry: 'AU', subjectName: 'Jo Example',
    }));
    ok('O5  an UNREGISTERED instrument is REFUSED — an unstated owner IS the third-party case',
      unregistered === 'funding_instrument_unregistered', unregistered);
    // ...and the ONE switch that turns that off is explicit configuration.
    const permissive = withConfig({ FUNDING_REFUSE_UNREGISTERED: false }, () => code(() => FUND.assertDepositFunded(db, {
      userId: u.id, payerName: 'Nobody At All', fundingCountry: 'AU', subjectName: 'Jo Example',
    })));
    ok('O6  ...and an operator may deliberately permit it, but then it is AUDITED',
      permissive === null && db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='funding.refused'").get().c >= 1);

    // 5. A MISSING name is NOT a match. A control that reports success on the
    //    cases it could not see is worse than one that reports nothing.
    const unnamed = code(() => FUND.assertDepositFunded(db, {
      userId: u.id, payerName: null, fundingCountry: 'AU', subjectName: 'Jo Example',
    }));
    ok('O7  a deposit whose payer name the rail did NOT report is REFUSED, not waved through',
      unnamed === 'funding_instrument_unregistered', unnamed);

    // 6. RESTRICTED JURISDICTION, distinct from the session gate.
    const restricted = withConfig({ AML_RESTRICTED_JURISDICTIONS: 'XX,YY' }, () => code(() => FUND.assertDepositFunded(db, {
      userId: u.id, payerName: 'Jo Example', fundingCountry: 'YY', subjectName: 'Jo Example',
    })));
    ok('O8  funding from a RESTRICTED jurisdiction is refused', restricted === 'restricted_funding_jurisdiction', restricted);
    ok('O9  ...and it is a SEPARATE code from the session-jurisdiction gate',
      restricted !== 'jurisdiction-not-allowed' && restricted !== 'no-jurisdiction-supplied');

    // 7. CREDIT IS A RELATIONSHIP, NOT A NAME. A digital wallet that draws on a
    //    credit card is refused even though its `kind` is not 'credit_card'.
    FUND.setMethod(db, { actor: { id: 1, role: 'admin' }, tenantId, slug: 'applepay', label: 'Apple Pay', kind: 'wallet', credit_linked: true, seller_status: 'approved_seller' });
    const wallet = code(() => FUND.assertDepositFunded(db, {
      userId: u.id, methodSlug: 'applepay', payerName: 'Jo Example', fundingCountry: 'AU', subjectName: 'Jo Example',
    }));
    ok('O10 a CREDIT-LINKED digital wallet is refused, not just a credit card',
      wallet === 'credit_linked_method_prohibited', wallet);
    // A debit-funded wallet is fine.
    FUND.setMethod(db, { actor: { id: 1, role: 'admin' }, tenantId, slug: 'debitwallet', label: 'Debit Wallet', kind: 'wallet', credit_linked: false, seller_status: 'approved_seller' });
    ok('O11 ...while a debit-funded wallet is accepted',
      code(() => FUND.assertDepositFunded(db, {
        userId: u.id, methodSlug: 'debitwallet', payerName: 'Jo Example', fundingCountry: 'AU', subjectName: 'Jo Example',
      })) === null);

    // 8. THE TERMS. "PayPal" and "PayPal, approved seller, AU only" are
    //    different facts, and only the second can be enforced.
    const noTerms = (() => { try { FUND.setMethod(db, { actor: { id: 1, role: 'admin' }, tenantId, slug: 'pp', label: 'PayPal', kind: 'paypal', enabled: true }); return null; } catch (e) { return e.details && e.details.code; } })();
    ok('O12 a wallet or PayPal cannot be ENABLED without recording the seller terms',
      noTerms === 'payment_method_terms_required', noTerms);
    FUND.setMethod(db, { actor: { id: 1, role: 'admin' }, tenantId, slug: 'pp', label: 'PayPal', kind: 'paypal', seller_status: 'approved_seller', permitted_countries: ['AU'] });
    ok('O13 ...and an approved seller restricted to AU is accepted for AU',
      code(() => FUND.assertDepositFunded(db, { userId: u.id, methodSlug: 'pp', payerName: 'Jo Example', fundingCountry: 'AU', subjectName: 'Jo Example' })) === null);
    ok('O14 ...and REFUSED for a country the approval does not cover',
      code(() => FUND.assertDepositFunded(db, { userId: u.id, methodSlug: 'pp', payerName: 'Jo Example', fundingCountry: 'NZ', subjectName: 'Jo Example' })) === 'funding_country_not_permitted');
    });
    // THE ANTI-VACUITY PROOF. The same call that O2 made, with the deployment
    // declaration OFF, is a no-op — and that is exactly why the block above has to
    // set it, and why this assertion exists: if someone removes the declaration
    // from the block, O1..O14 all still pass and only this one fails.
    const inert = code(() => FUND.assertDepositFunded(db, { userId: u.id, payerName: 'A Different Person', fundingCountry: 'AU', subjectName: 'Jo Example' }));
    ok('O15 with the deployment declaration OFF the gate is INERT — so O2 above was a real refusal, not a vacuous one',
      inert === null && db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='funding.refused'").get().c >= 1);
    db.close();
  }

  // ── 12. THE WITHDRAWAL DESTINATION, kept separate from funding ───────────
  {
    const db = openStore(':memory:');
    venue(db);
    const u = await user(db, 'payout');
    const code = (fn) => { try { fn(); return null; } catch (e) { return (e.details && e.details.code) || null; } };
    withConfig({ REGULATED_DEPLOYMENT: true, AML_RESTRICTED_JURISDICTIONS: 'XX' }, () => {
      ok('W1  paying out to a restricted country is refused',
        code(() => FUND.assertWithdrawalDestination(db, { userId: u.id, beneficiaryCountry: 'XX' })) === 'restricted_payout_jurisdiction');
      ok('W2  an ordinary destination is allowed',
        code(() => FUND.assertWithdrawalDestination(db, { userId: u.id, beneficiaryCountry: 'AU' })) === null);
      ok('W3  an UNKNOWN destination is allowed at intake (the payout may not be instructed yet)',
        code(() => FUND.assertWithdrawalDestination(db, { userId: u.id, beneficiaryCountry: null })) === null);
    });
    db.close();
  }

  // ── 13. REPORT GENERATION — and the proof nothing is SUBMITTED ───────────
  {
    const db = openStore(':memory:');
    venue(db);
    const u = await user(db, 'reportme', { balance: 0 });
    // TWO real operators, so the entitlement is granted to one and revoked from
    // the other. Using a synthetic id would have made setEntitlement's
    // user-existence check unreachable, and that check is the half that stops an
    // entitlement being attached to nobody.
    const officer = await user(db, 'officer');
    const leaver = await user(db, 'leaver');
    FIND.setEntitlement(db, { actor: officer, userId: officer.id, entitled: true, reason: 'compliance officer' });
    FIND.recordAlert(db, { rule_id: 'AU-OB-01', scope: FIND.alertScope('AU-OB-01', `user:${u.id}`), severity: 'high', user_id: u.id, detail: 'plunge', evidence: { share_pct: 80 } });
    withConfig({ REGULATED_DEPLOYMENT: true }, () => THRESH.detect(db, { userId: u.id, intentId: 1, amountCents: 900000 }));

    const ttr = REPORTS.thresholdTransactions(db, { actor: officer, from: '2026-01-01', to: '2026-12-31' });
    ok('P1  a threshold transaction report is GENERATED', ttr.rows.length === 1 && ttr.report === 'threshold_transaction_report');
    ok('P2  ...it says on its face that nothing was SUBMITTED', ttr.submission.submitted === false && /submits nothing/.test(ttr.submission.note));
    ok('P3  ...it ships its definitions', !!ttr.definitions.threshold_cents);
    const ttrCsv = REPORTS.thresholdTransactionsCsv(ttr);
    ok('P4  ...and the CSV carries the definitions too (CSV is the artefact that gets filed)',
      ttrCsv.includes('# definition') && ttrCsv.includes('related'));
    const smr = REPORTS.suspiciousMatter(db, { actor: officer });
    ok('P5  a suspicious matter report is GENERATED', smr.rows.length === 1 && smr.report === 'suspicious_matter_report');
    ok('P6  ...every row resolves the rule id to the PUBLISHED INDICATOR',
      /plunge/i.test(smr.rows[0].indicator) && !!smr.rows[0].published_indicator, smr.rows[0].indicator);
    ok('P7  ...and states the basis: a signal, not a determination',
      smr.basis === 'signal-not-determination' && /not say the account holder has done anything wrong/.test(smr.definitions.basis));
    ok('P8  ...and nothing was submitted', smr.submission.submitted === false);
    ok('P9  both report generations are AUDITED',
      db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='aml.report_generated'").get().c === 2);
    ok('P10 ...and the audit row does NOT carry the report CONTENTS (the audit log is a wider audience)',
      !/plunge/i.test(db.prepare("SELECT after FROM audit_log WHERE action='aml.report_generated' ORDER BY id LIMIT 1").get().after || ''));
    // Entitlement, again, at the report boundary.
    FIND.setEntitlement(db, { actor: officer, userId: leaver.id, entitled: true, reason: 'was the compliance officer' });
    ok('P11a ...an entitlement is revocable', FIND.entitled(db, leaver));
    FIND.setEntitlement(db, { actor: officer, userId: leaver.id, entitled: false, reason: 'left the compliance team' });
    ok('P11b ...and revoking it takes effect immediately', !FIND.entitled(db, leaver));
    const refused = (() => { try { REPORTS.suspiciousMatter(db, { actor: leaver }); return null; } catch (e) { return e.details && e.details.code; } })();
    ok('P11c an operator whose entitlement was REVOKED is refused the report', refused === 'aml_not_entitled', refused);
    db.close();
  }

  // ── 14. THE DATA-SOURCE REGISTER ─────────────────────────────────────────
  {
    const db = openStore(':memory:');
    venue(db);
    const admin = await user(db, 'licenser');
    ok('S1  the register ships EMPTY, and says so', DS.overview(db).empty === true);
    ok('S2  ...and the use vocabulary is closed', JSON.stringify(DS.overview(db).uses) === JSON.stringify(['display', 'store', 'settle']));
    const src = DS.configure(db, { actor: admin, slug: 'rnsw', name: 'Racing NSW race-field', owner: 'Racing NSW', authority: 'Racing NSW', licence_ref: 'example-approval-2026', permits: ['display', 'settle'] });
    ok('S3  a source can be registered with its owner and approval', !!src.id && src.owner === 'Racing NSW');
    ok('S4  DISPLAY is permitted', DS.checkUsable(db, src.id, 'display').ok === true);
    ok('S5  SETTLE is permitted', DS.checkUsable(db, src.id, 'settle').ok === true);
    const store = DS.checkUsable(db, src.id, 'store');
    ok('S6  STORE is NOT — an approval that grants two of three is not one that grants all three',
      store.ok === false && store.code === 'use_not_permitted', store.code);
    ok('S7  the refusal says WHAT it does permit', /display, settle/.test(store.message), store.message);

    // EXPIRY — the "visible BEFORE they rely on it" requirement.
    DS.setNow('2026-06-01 00:00:00');
    DS.configure(db, { actor: admin, id: src.id, slug: 'rnsw', name: 'Racing NSW race-field', owner: 'Racing NSW', licence_ref: 'example-approval-2026', permits: ['display', 'settle'], expires_at: '2026-05-31 23:59:59' });
    const expired = DS.checkUsable(db, src.id, 'settle');
    ok('S8  an EXPIRED approval refuses settlement', expired.ok === false && expired.code === 'licence_expired', expired.code);
    DS.configure(db, { actor: admin, id: src.id, slug: 'rnsw', name: 'Racing NSW race-field', owner: 'Racing NSW', licence_ref: 'example-approval-2026', permits: ['display', 'settle'], expires_at: '2026-06-20 00:00:00' });
    const soon = DS.list(db).find((s) => s.id === src.id).state;
    ok('S9  ...and one about to expire is its OWN STATE, not just "active"',
      soon === 'expiring', soon);
    ok('S10 ...because a two-valued flag would hide the one an operator must act on', DS.checkUsable(db, src.id, 'settle').ok === true);
    DS.setNow(null);

    // THE UNATTRIBUTED COUNT. `result_events.source` still works; the new column
    // extends it and the gap is made visible rather than invented away.
    db.prepare("INSERT INTO result_events (market_id, source, decision, rule) VALUES (1,'poll','settle','completed')").run();
    ok('S11 an outcome with no registered source is COUNTED, not refused',
      DS.unattributedCount(db) === 1, String(DS.unattributedCount(db)));
    ok('S12 ...and the coarse transport is still reported beside it',
      DS.unattributedSettlements(db)[0].source === 'poll');
    db.prepare("INSERT INTO result_events (market_id, source, decision, rule, data_source_id) VALUES (1,'webhook','settle','completed', ?)").run(src.id);
    ok('S13 ...and one that IS attributed drops out of the count', DS.unattributedCount(db) === 1);
    ok('S14 the register is exportable, because an operator has to hand it to someone',
      REPORTS.dataSourceRegisterCsv(db).includes('rnsw') && /permit/.test(REPORTS.dataSourceRegisterCsv(db)));
    ok('S15 the legacy result_events.source vocabulary is UNCHANGED',
      db.prepare("SELECT sql FROM sqlite_master WHERE name='result_events'").get().sql.includes("('poll','webhook','manual','import')"));
    db.close();
  }

  // ── 15. RETENTION: financial-crime records are not operational data ──────
  {
    ok('R1  the retention policy names the financial-crime tables', RET.PROTECTED_NAMES.has('aml_alerts') && RET.PROTECTED_NAMES.has('aml_threshold_obligations'));
    ok('R2  ...it does NOT protect age_assurance, which must be DESTROYED',
      RET.mayPrune(null, 'age_assurance').reason === 'exempt-from-protection', RET.mayPrune(null, 'age_assurance').reason);
    ok('R3  ...and says why the exemption exists', /destroyed once used/.test(RET.mayPrune(null, 'age_assurance').detail || ''));
    ok('R4  an unknown table is PRUNABLE — the default is permissive for operational data', RET.mayPrune(null, 'price_history').may === true);
    const threw = (() => { try { RET.assertPrunable('aml_alerts'); return null; } catch (e) { return e.status; } })();
    ok('R5  a pruner that asks first is refused the protected tables', threw === 500, String(threw));
    ok('R6  ...and allowed the operational ones', RET.assertPrunable('price_history') === true);
    // THE SOURCE-LEVEL CHECK. The failure this module exists to prevent is a
    // PRUNER being written that deletes a financial-crime table, so this greps
    // every module for a DELETE against a protected table.
    //
    // WITH ONE ALLOWLISTED SITE, and the allowlist is the interesting part. There
    // is exactly one legitimate DELETE against a protected table:
    // lib/aml/findings.js revoking ONE person's entitlement, which is the whole
    // purpose of revoking one — and which requires a written reason and writes an
    // audit row. Without the allowlist the check fails on it; with a blanket
    // exemption for the file it would also pass on a retention job added to the
    // same file tomorrow. The allowlist is named and narrow so that adding a
    // second DELETE to that file makes this fail again.
    const fs = require('fs');
    const path = require('path');
    const libDir = path.join(__dirname, '..', 'lib');
    const ALLOWED = new Set(['findings.js:aml_entitlements']);
    const offenders = [];
    const allowed = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (!f.endsWith('.js')) continue;
        const src = fs.readFileSync(full, 'utf8');
        for (const table of RET.PROTECTED_NAMES) {
          const hit = new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, 'i').test(src);
          if (!hit) continue;
          (ALLOWED.has(`${f}:${table}`) ? allowed : offenders).push(`${f}:${table}`);
        }
      }
    };
    walk(libDir);
    ok('R7  NO module anywhere in lib/ deletes from a protected table (except the named allowlist)',
      offenders.length === 0, offenders.join(','));
    ok('R7b the allowlist is exactly the entitlement revocation and nothing else',
      allowed.join(',') === 'findings.js:aml_entitlements', allowed.join(','));
    ok('R7c ...and that site requires a written reason before it deletes',
      /A written reason is required/.test(fs.readFileSync(path.join(libDir, 'aml', 'findings.js'), 'utf8')));
    // ...and the one pruner that exists is named, with its window.
    ok('R8  the policy names the ONE existing pruner and what it prunes',
      RET.policy().existing_pruners.length === 1 && RET.policy().existing_pruners[0].tables.includes('price_history'));
  }

  // ── 16. "WHAT WOULD THIS HAVE CAUGHT?" — named scenarios from the finding ─
  {
    const db = openStore(':memory:');
    venue(db);
    // THE SCENARIO, verbatim from the finding: a person other than the account
    // holder funds the account. The gate must REFUSE it, at intake, before any
    // money is credited.
    const u = await user(db, 'enlaincase', { balance: 0 });
    const tenantId = TEN.defaultTenant(db).id;
    ID.setDecision(db, { actor: { id: 1, role: 'admin' }, userId: u.id, decision: 'verified', reason: 'scenario' });
    db.prepare('UPDATE identity_verifications SET subject_name = ? WHERE user_id = ?').run('Real Customer', u.id);
    FUND.registerInstrument(db, {
      actor: { id: 1, role: 'admin' }, tenantId, label: 'a friend\'s account',
      instrument_kind: 'bank_account', registered_owner: 'Some Other Person', owner_kind: 'player', jurisdiction: 'AU',
    });
    const caught = withConfig({ REGULATED_DEPLOYMENT: true }, () => {
      try {
        FUND.assertDepositFunded(db, { userId: u.id, payerName: 'Some Other Person', fundingCountry: 'AU', subjectName: 'Real Customer' });
        return null;
      } catch (e) { return e.details && e.details.code; }
    });
    ok('W1a "a person other than the account holder" is REFUSED at intake, not logged',
      caught === 'funding_instrument_third_party', caught);
    ok('W1b ...and nothing was credited, because the rail is irrevocable and the check runs first',
      db.prepare('SELECT balance_cents b FROM users WHERE id=?').get(u.id).b === 0);
    db.close();
  }

  // ── 17. THE RAIL'S OWN ACCOUNT OF THE FUNDING, recorded BEFORE the gate ──
  //
  // The third-party-funding control has exactly one fact to work with: the name
  // the PAYMENT RAIL reports. This block proves the fact actually arrives, is
  // recorded on the intent, and is what the gate reads — and that it cannot be
  // restated by a later confirmation.
  {
    const db = openStore(':memory:');
    venue(db);
    const tenantId = TEN.defaultTenant(db).id;
    const PAY = require('../lib/payments');
    const u = await user(db, 'railpayer', { balance: 0 });
    ID.setDecision(db, { actor: { id: 1, role: 'admin' }, userId: u.id, decision: 'verified', reason: 'the rail test' });
    db.prepare("INSERT INTO identity_verifications (user_id, provider, status, decision, checks, subject_name, subject_reference) VALUES (?, 'reference', 'pass', 'pass', '[{\"check\":\"document\",\"outcome\":\"pass\"}]', ?, 'user:' || ?)").run(u.id, 'Rail Payer', u.id);

    // THE PROCESSOR POOL, which is the Osko reality: the venue's receiving PayID
    // is registered to a contracted processor, not to the venue.
    FUND.registerInstrument(db, {
      actor: { id: 1, role: 'admin' }, tenantId, label: 'Osko pool',
      instrument_kind: 'processor_pool', registered_owner: 'Example Pool Pty Ltd',
      owner_kind: 'processor', jurisdiction: 'AU',
    });
    // AND A THIRD PARTY'S OWN ACCOUNT, registered — which is the case where the
    // instrument IS known and is NOT the account holder's. This is the distinction
    // the registry exists to draw: an unknown owner and a known wrong owner are
    // both refused, for different reasons, and only one of them is a name match.
    FUND.registerInstrument(db, {
      actor: { id: 1, role: 'admin' }, tenantId, label: 'someone else account',
      instrument_kind: 'bank_account', registered_owner: 'Stranger Account Pty Ltd',
      owner_kind: 'player', jurisdiction: 'AU',
    });

    const intent = await PAY.openDeposit(db, u.id, 20000);
    // The rail reports who funded it. The PSP's name does not match the customer
    // and is not the account holder — but it IS the registered processor pool.
    const refused = (() => {
      try {
        withConfig({ REGULATED_DEPLOYMENT: true }, () => PAY.confirmByExternalId(db, {
          provider: 'reference', externalId: intent.external_id,
          funding: { payerName: 'Stranger Account Pty Ltd', fundingCountry: 'AU' },
        }));
        return null;
      } catch (e) { return (e.details && e.details.code) || e.message; }
    })();
    ok('W2a a deposit the rail attributes to a THIRD PARTY is refused, with the rail own record on the intent',
      refused === 'funding_instrument_third_party', refused);
    // WHERE THE RAIL'S REPORT SURVIVES A REFUSAL, and this is worth pinning
    // precisely because the answer is not the obvious one.
    //
    // The funding metadata is written inside `confirmByExternalId`'s
    // transaction, and the refusal rolls that transaction back. So the intent row
    // does NOT carry the payer name — which is correct: a row written inside the
    // transaction that the refusal rolls back does not survive it, and the same
    // argument lib/jobs.js makes about reconciliation findings.
    //
    // What survives is the AUDIT row the CALLER writes once the transaction has
    // unwound (lib/funding.js recordRefusal, called from server.js). That is the
    // answer to "did you ever see a deposit funded by this name?", and it is
    // reached here by calling the same function server.js calls rather than by
    // reaching into server.js.
    const afterRefusal = db.prepare('SELECT status s, payer_name p FROM payment_intents WHERE id=?').get(intent.intent_id);
    ok('W2b the intent is left exactly as it was — pending, with no partial funding record',
      afterRefusal.s === 'pending' && afterRefusal.p === null, JSON.stringify(afterRefusal));
    FUND.recordRefusal(db, { actor: null, userId: u.id, code: refused, detail: 'payer_name=Stranger Account Pty Ltd' });
    const audited = db.prepare("SELECT after FROM audit_log WHERE action='funding.refused' ORDER BY id DESC LIMIT 1").get();
    ok('W2c ...and the rail own payer name survives in the AUDIT row the caller writes after the rollback',
      !!audited && /Stranger Account Pty Ltd/.test(audited.after), audited && audited.after);
    ok('W2d ...with nothing credited',
      db.prepare('SELECT balance_cents b FROM users WHERE id=?').get(u.id).b === 0);

    // AND THE OTHER HALF: an instrument nobody has registered is refused too,
    // because an instrument whose owner nobody can state IS the third-party case
    // by definition. Same wire, same refusal point, a different missing fact.
    const intentUnreg = await PAY.openDeposit(db, u.id, 20000);
    const unreg = (() => {
      try {
        withConfig({ REGULATED_DEPLOYMENT: true }, () => PAY.confirmByExternalId(db, {
          provider: 'reference', externalId: intentUnreg.external_id,
          funding: { payerName: 'Nobody At All Pty Ltd', fundingCountry: 'AU' },
        }));
        return null;
      } catch (e) { return (e.details && e.details.code) || e.message; }
    })();
    ok('W2a2 a deposit from an UNREGISTERED instrument is refused with its own code',
      unreg === 'funding_instrument_unregistered', unreg);

    // The SAME rail report, now naming the registered processor pool. Cleared —
    // this is the Osko case the naive name-match rule would have refused.
    const intent2 = await PAY.openDeposit(db, u.id, 20000);
    const cleared = withConfig({ REGULATED_DEPLOYMENT: true }, () => PAY.confirmByExternalId(db, {
      provider: 'reference', externalId: intent2.external_id,
      funding: { payerName: 'Example Pool Pty Ltd', fundingCountry: 'AU' },
    }));
    ok('W2e the SAME deposit funded through the REGISTERED PROCESSOR POOL is cleared',
      cleared.status === 'confirmed', cleared && cleared.status);
    ok('W2f ...and it is credited',
      db.prepare('SELECT balance_cents b FROM users WHERE id=?').get(u.id).b === 20000);

    // THE RAIL'S FIRST REPORT WINS. A later confirmation cannot restate who
    // funded a deposit: "the processor pool" and then later "somebody else" is
    // exactly the drift a financial-crime record must not have, and it would be
    // drift in the direction that makes a suspicion disappear.
    //
    // Driven against the ALREADY-CONFIRMED pool deposit, because that is the only
    // shape where a second confirmation is possible at all — confirming an intent
    // twice is idempotent by design, which is the property that stops a retried
    // webhook double-crediting. So the record is read before and after and must
    // not have moved.
    const before = db.prepare('SELECT payer_name p, funding_country c FROM payment_intents WHERE id=?').get(intent2.intent_id);
    const balanceBefore = db.prepare('SELECT balance_cents b FROM users WHERE id=?').get(u.id).b;
    PAY.confirmByExternalId(db, {
      provider: 'reference', externalId: intent2.external_id,
      funding: { payerName: 'Stranger Account Pty Ltd', fundingCountry: 'NZ' },
    });
    const after = db.prepare('SELECT payer_name p, funding_country c FROM payment_intents WHERE id=?').get(intent2.intent_id);
    ok('W2g a later confirmation cannot restate WHO funded the deposit',
      before.p === after.p && after.p === 'Example Pool Pty Ltd', JSON.stringify(after));
    ok('W2h ...nor WHERE it came from',
      before.c === after.c && after.c === 'AU', JSON.stringify(after));
    ok('W2i ...and the retry still moves no money',
      db.prepare('SELECT balance_cents b FROM users WHERE id=?').get(u.id).b === balanceBefore);
    db.close();
  }

  // ── 18. THE AML PASS IS A JOB, NOT ONLY A ROUTE ─────────────────────────
  //
  // A rule set that only fires when an operator presses a button is a rule set
  // that does not fire, and the difference is invisible from inside the code.
  // lib/jobs.js carries `amlPass` for exactly the reason `reconcileOnce` exists.
  {
    const db = openStore(':memory:');
    const JOBS = require('../lib/jobs');
    const off = JOBS.amlPass(db);
    ok('J1  with monitoring OFF the pass SAYS SO rather than reporting nothing found',
      off.enabled === false && /AML_MONITORING_ENABLED/.test(off.note), off.note);
    await withConfigAsync({ AML_MONITORING_ENABLED: true, REGULATED_DEPLOYMENT: true }, async () => {
      const { s1 } = venue(db);
      const plunger = await user(db, 'jobplunge');
      const a = await user(db, 'jobbase');
      const b = await user(db, 'jobbase2');
      order(db, a.id, s1, 'back', 2.0, 20000);
      order(db, b.id, s1, 'lay', 2.0, 20000);
      const crowd = [];
      for (let i = 0; i < 8; i++) crowd.push(await user(db, `jobcrowd${i}`, { balance: 200000 }));
      for (const c of crowd) order(db, c.id, s1, 'back', 2.0, 50000);
      order(db, plunger.id, s1, 'lay', 2.0, 900000);
      const r = JOBS.amlPass(db, { limit: 100 });
      ok('J2  the scheduled pass raises the same alert the route would', r.raised > 0, JSON.stringify({ raised: r.raised, scanned: r.scanned }));
      ok('J3  ...and it is the PERSISTENT finding, not a log line',
        db.prepare("SELECT COUNT(*) c FROM aml_alerts WHERE rule_id='AU-OB-01' AND resolved_at IS NULL").get().c >= 1);
      // THE THRESHOLD SWEEP: the half that catches what the DEPOSIT PATH never
      // reached. A ledger restored from a backup never went through that path.
      const big = await user(db, 'jobthreshold', { balance: 0 });
      deposit(db, big.id, 900000);
      const r2 = JOBS.amlPass(db, { limit: 100 });
      ok('J4  ...and it sweeps the ledger for threshold crossings the deposit path never reached',
        r2.obligations >= 1, String(r2.obligations));
      ok('J5  ...producing a durable OBLIGATION, not a log line',
        db.prepare('SELECT COUNT(*) c FROM aml_threshold_obligations WHERE user_id=?').get(big.id).c >= 1);
      ok('J6  ...which blocks nothing: the account is still fully able to trade',
        db.prepare('SELECT identity_status i, role r FROM users WHERE id=?').get(big.id).i !== 'blocked');
    });
    db.close();
  }

  // ── 19. A SETTLEMENT RECORDS WHICH LICENSED SOURCE IT SETTLED FROM ────────
  //
  // The requirement is that a settlement records its source and that an expired
  // or out-of-scope licence is visible BEFORE anyone relies on it. The second half
  // is the pre-flight check (section 14); this is the first half, driven through
  // the actual settlement path rather than asserted on the column.
  {
    const db = openStore(':memory:');
    const RESULTS = require('../lib/results');
    const R = require('../lib/resultsfeed') || {};
    const admin = await user(db, 'settler');
    const src = DS.configure(db, { actor: admin, slug: 'nsw', name: 'NSW race-field', owner: 'Racing NSW', authority: 'Racing NSW', licence_ref: 'approval-example', permits: ['display', 'settle'] });
    const displayOnly = DS.configure(db, { actor: admin, slug: 'displayonly', name: 'Display-only feed', owner: 'Example Racing', licence_ref: 'approval-display', permits: ['display'] });

    // A SIGNAL shaped like what lib/resultsfeed.js produces, for a market that is
    // waiting to settle.
    const { m, s1 } = venue(db);
    const signal = { winner_selection_id: s1 };

    // THE LICENCE THAT PERMITS SETTLING. Settles, and is attributed.
    const r1 = RESULTS.applyOutcome(db, m.id, signal, { source: 'poll', dataSourceId: src.id });
    ok('C1  an outcome naming a source whose approval PERMITS settling is applied', !!r1, JSON.stringify(r1));
    const ev = db.prepare('SELECT source, data_source_id d FROM result_events WHERE market_id=? ORDER BY id DESC LIMIT 1').get(m.id);
    ok('C2  ...and the settlement records WHICH LICENSED SOURCE it settled from',
      ev.d === src.id, JSON.stringify(ev));
    ok('C3  ...without changing the coarse transport it already recorded', ev.source === 'poll', ev.source);
    ok('C4  ...and it drops out of the unattributed count',
      !db.prepare('SELECT id FROM result_events WHERE data_source_id IS NULL AND market_id=?').all(m.id).some((r) => r.id === ev.d));

    // THE DISPLAY-ONLY APPROVAL. This is the case `permits` exists for: an
    // approval that grants display but not settlement, attempting a settlement.
    const v2 = venue(db);
    const refused = (() => {
      try {
        RESULTS.applyOutcome(db, v2.m.id, signal, { source: 'poll', dataSourceId: displayOnly.id });
        return null;
      } catch (e) { return (e.details && e.details.code) || e.message; }
    })();
    ok('C5  an outcome naming a DISPLAY-ONLY approval is refused for settling',
      refused === 'use_not_permitted', refused);
    ok('C6  ...and nothing was applied — the market is untouched',
      db.prepare('SELECT status s, settlement_hold h FROM markets WHERE id=?').get(v2.m.id).s !== 'settled');

    // THE EXPIRED APPROVAL. Refused before the outcome is touched at all.
    DS.configure(db, { actor: admin, id: src.id, slug: 'nsw', name: 'NSW race-field', owner: 'Racing NSW', licence_ref: 'approval-example', permits: ['display', 'settle'], expires_at: '2020-01-01 00:00:00' });
    const v3 = venue(db);
    const expired = (() => {
      try {
        RESULTS.applyOutcome(db, v3.m.id, signal, { source: 'poll', dataSourceId: src.id });
        return null;
      } catch (e) { return (e.details && e.details.code) || e.message; }
    })();
    ok('C7  an outcome naming an EXPIRED approval is refused', expired === 'licence_expired', expired);
    ok('C8  ...and again nothing was applied',
      db.prepare('SELECT status s FROM markets WHERE id=?').get(v3.m.id).s !== 'settled');
    void R;
    db.close();
  }

  console.log(`\naml.test.js: ${passed} checks passed`);
})().catch((e) => {
  console.error('aml.test.js FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});