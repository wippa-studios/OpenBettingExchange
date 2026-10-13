// admin.test.js — operator account management and the audit trail.
// Run: node tests/admin.test.js   (plain assert, no deps)
//
// The money invariants in this suite are the reason it exists. A balance
// adjustment is the only way in the entire system to move money with no
// market, no faucet and no settlement behind it, so it is the one path the
// existing engine tests cannot cover. Everything else here is lockout guards:
// each one corresponds to a specific way an exchange becomes unadministrable.
'use strict';
// scrypt cost: this suite creates many accounts and pays the hash once per
// account, but asserts NOTHING about the stored hash format. auth.test.js
// runs at the real default (SCRYPT_N=65536) and owns that coverage.
process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '100000';
process.env.FAUCET_MAX_CENTS = '100000';
const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const ADM = require('../lib/admin');
const AUDIT = require('../lib/audit');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

let evCounter = 0;
function mkMarket(db) {
  let sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  if (!sport) {
    db.prepare("INSERT INTO sports (name, slug) VALUES ('Football','football')").run();
    sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  }
  evCounter++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now','+2 hours'))").run(sport.id, `E${evCounter}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`E${evCounter}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id = ?').get(ev.id);
  const ids = [];
  for (const name of ['Alpha', 'Beta']) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, name);
    ids.push(db.prepare('SELECT id FROM selections WHERE market_id = ? AND name = ?').get(mkt.id, name).id);
  }
  return { market_id: mkt.id, s1: ids[0], s2: ids[1] };
}

// An admin plus two players, on a fresh in-memory database.
async function fixture() {
  const db = openStore(':memory:');
  const admin = (await A.createAccount(db, { username: 'boss', password: 'secret1', role: 'admin', balance_cents: 1000000 }));
  const alice = (await A.registerUser(db, { username: 'alice', password: 'secret1', balance_cents: 100000 }));
  const bob = (await A.registerUser(db, { username: 'bob', password: 'secret1', balance_cents: 100000, email: 'Bob@Example.com' }));
  return { db, admin, alice, bob };
}
const balanceOf = (db, id) => {
  const r = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(id);
  return { b: r.b, f: r.f };
};

// P2: search and filter behaviour.
check('P2 search matches username or email; bots excluded', async () => {
  const db = openStore(':memory:');
  const admin = (await A.createAccount(db, { username: 'boss', password: 'secret1', role: 'admin' }));
  const alice = (await A.registerUser(db, { username: 'alice', password: 'secret1', balance_cents: 1000 }));
  const bob = (await A.registerUser(db, { username: 'bob', password: 'secret1', balance_cents: 1000, email: 'Bob@Example.com' }));
  await A.createAccount(db, { username: 'HouseBot', password: 'botpw123', is_bot: 1, balance_cents: 500 });
  db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(alice.id);

  assert.strictEqual(ADM.listUsers(db).total, 3, 'boss, alice, bob — the bot is excluded');
  assert.deepStrictEqual(ADM.listUsers(db, { q: 'bob' }).users.map((u) => u.username), ['bob']);
  // Case-insensitive, and it reaches the stored (lowercased) email.
  assert.deepStrictEqual(ADM.listUsers(db, { q: 'BOB@EXAMPLE' }).users.map((u) => u.username), ['bob']);
  assert.strictEqual(ADM.listUsers(db, { status: 'suspended' }).total, 1);
  assert.strictEqual(ADM.listUsers(db, { role: 'admin' }).total, 1);
  assert.strictEqual(ADM.listUsers(db, { role: 'admin', status: 'active' }).total, 1);
  assert.throws(() => ADM.listUsers(db, { role: 'superuser' }), (e) => e.status === 400);

  const page = ADM.listUsers(db, { limit: 2, offset: 0 });
  assert.strictEqual(page.users.length, 2);
  assert.strictEqual(page.total, 3, 'total is the unpaged count');
  assert.strictEqual(ADM.listUsers(db, { limit: 2, offset: 2 }).users.length, 1);
});

// P3: suspending releases resting escrow and kills live sessions. A suspended
// holder whose orders still rest has money they can never trade again.
check('P3 suspension releases escrow and revokes sessions', async () => {
  const { db, admin, alice, bob } = (await fixture());
  const m = mkMarket(db);
  // Alice rests an unmatched back: 100 @ 2.0 freezes the full 10000c stake.
  const o = M.placeOrder(db, alice, { selection_id: m.s1, side: 'back', price: 2.0, stake_cents: 10000 }).order;
  assert.deepStrictEqual(balanceOf(db, alice.id), { b: 100000, f: 10000 });
  const session = A.createSession(db, alice.id);
  assert.ok(A.sessionUser(db, session));

  const r = ADM.setStatus(db, { actor: admin, userId: alice.id, status: 'suspended', reason: 'chargeback' });
  assert.strictEqual(r.cancelled_orders, 1);
  assert.strictEqual(r.released_cents, 10000);
  assert.deepStrictEqual(balanceOf(db, alice.id), { b: 100000, f: 0 }, 'escrow fully released');
  assert.strictEqual(M.openOrdersFor(db, alice.id).length, 0);
  assert.strictEqual(A.sessionUser(db, session), null, 'the live token stops working');
  await assert.rejects(A.loginUser(db, { username: 'alice', password: 'secret1' }), (e) => e.status === 403);
});

// P4: suspension must NOT unwind matched positions. They are collateralised on
// both sides; choosing which side to honour is not the operator's decision.
check('P4 suspension leaves matched positions intact', async () => {
  const { db, admin, alice, bob } = (await fixture());
  const m = mkMarket(db);
  const lay = M.placeOrder(db, alice, { selection_id: m.s1, side: 'lay', price: 2.0, stake_cents: 10000 }).order;
  const back = M.placeOrder(db, bob, { selection_id: m.s1, side: 'back', price: 2.0, stake_cents: 10000 }).order;
  const matched = db.prepare('SELECT matched_cents m FROM orders WHERE id=?').get(back.id).m;
  assert.strictEqual(matched, 10000, 'fully matched before suspension');

  ADM.setStatus(db, { actor: admin, userId: alice.id, status: 'suspended', reason: 'fraud review' });
  const after = db.prepare('SELECT status, matched_cents FROM orders WHERE id=?').get(lay.id);
  assert.strictEqual(after.status, 'fully_matched', 'a matched lay is not cancelled');
  assert.strictEqual(after.matched_cents, 10000);
  // And it can still be settled — the collateral is still there.
  const res = require('../lib/settle').settleMarket(db, m.market_id, { winner_selection_id: m.s1 });
  assert.ok(res.per_user.length >= 2);
});

// P5: the lockout guards. Each prevents a distinct unadministrable state.
check('P5 lockout guards', async () => {
  const { db, admin } = (await fixture());
  const asActor = { id: admin.id };

  // Self-harm is refused outright, whatever the reason.
  assert.throws(() => ADM.setStatus(db, { actor: asActor, userId: admin.id, status: 'suspended', reason: 'oops' }), (e) => e.status === 400);
  assert.throws(() => ADM.setRole(db, { actor: asActor, userId: admin.id, role: 'user', reason: 'oops' }), (e) => e.status === 400);
  assert.throws(() => ADM.adjustBalance(db, { actor: asActor, userId: admin.id, deltaCents: 500, reason: 'oops' }), (e) => e.status === 400);

  // The LAST active admin cannot be removed by anyone — including an actor id
  // that is not itself a counted admin (a stale session, or a caller that got
  // this far some other way). The guard is on the resulting state, not on the
  // caller's identity.
  const stranger = { id: 999999 };
  assert.throws(() => ADM.setStatus(db, { actor: stranger, userId: admin.id, status: 'suspended', reason: 'x' }), (e) => e.status === 400);
  assert.throws(() => ADM.setRole(db, { actor: stranger, userId: admin.id, role: 'user', reason: 'x' }), (e) => e.status === 400);

  // With a second ACTIVE admin present, the first may be demoted.
  const boss2 = (await A.createAccount(db, { username: 'boss2', password: 'secret1', role: 'admin' }));
  assert.strictEqual(ADM.setRole(db, { actor: asActor, userId: boss2.id, role: 'user', reason: 'handover' }).role, 'user');
  // Now `admin` is the only admin again, and the guard closes behind it.
  assert.throws(() => ADM.setRole(db, { actor: stranger, userId: admin.id, role: 'user', reason: 'x' }), (e) => e.status === 400);

  // A SUSPENDED admin is not a spare. boss3 is created, immediately suspended,
  // and must not then count as a second admin who could be left behind.
  const boss3 = (await A.createAccount(db, { username: 'boss3', password: 'secret1', role: 'admin' }));
  ADM.setStatus(db, { actor: asActor, userId: boss3.id, status: 'suspended', reason: 'review' });
  assert.throws(() => ADM.setStatus(db, { actor: stranger, userId: admin.id, status: 'suspended', reason: 'x' }), (e) => e.status === 400);
  // Reinstating boss3 re-opens the door — and the successful demotion below is
  // performed by boss3, a REAL admin. (The `stranger` actor is used only for
  // operations that must be REFUSED, so an audit row is never attempted for a
  // user id that does not exist.)
  ADM.setStatus(db, { actor: asActor, userId: boss3.id, status: 'active', reason: 'cleared' });
  assert.strictEqual(
    ADM.setStatus(db, { actor: { id: boss3.id }, userId: admin.id, status: 'suspended', reason: 'x' }).status,
    'suspended'
  );
});

// P6: a reason is required for anything that changes money or access.
check('P6 reason is mandatory', async () => {
  const { db, admin, alice } = (await fixture());
  for (const missing of [undefined, '', '   ', null]) {
    assert.throws(() => ADM.adjustBalance(db, { actor: admin, userId: alice.id, deltaCents: 100, reason: missing }), (e) => e.status === 400, String(missing));
    assert.throws(() => ADM.setStatus(db, { actor: admin, userId: alice.id, status: 'suspended', reason: missing }), (e) => e.status === 400, String(missing));
    assert.throws(() => ADM.setRole(db, { actor: admin, userId: alice.id, role: 'admin', reason: missing }), (e) => e.status === 400, String(missing));
  }
  assert.throws(() => ADM.adjustBalance(db, { actor: admin, userId: alice.id, deltaCents: 100, reason: 'x'.repeat(501) }), (e) => e.status === 400);
});

// P7: the escrow floor. An adjustment must never leave matched liability
// uncollateralised — that would convert a solvent book into an unbacked one,
// and it is the single most dangerous thing this endpoint could do.
check('P7 adjustment cannot eat into escrow', async () => {
  const { db, admin, alice } = (await fixture());
  const m = mkMarket(db);
  M.placeOrder(db, alice, { selection_id: m.s1, side: 'back', price: 2.0, stake_cents: 10000 });
  assert.deepStrictEqual(balanceOf(db, alice.id), { b: 100000, f: 10000 });

  // Debiting to exactly the escrow floor is allowed...
  assert.strictEqual(ADM.adjustBalance(db, { actor: admin, userId: alice.id, deltaCents: -90000, reason: 'clawback' }).balance_cents, 10000);
  // ...one cent past it is not.
  assert.throws(() => ADM.adjustBalance(db, { actor: admin, userId: alice.id, deltaCents: -1, reason: 'one more' }), (e) => e.status === 400);
  assert.deepStrictEqual(balanceOf(db, alice.id), { b: 10000, f: 10000 });

  // A refused adjustment moves nothing at all.
  assert.throws(() => ADM.adjustBalance(db, { actor: admin, userId: alice.id, deltaCents: -99999, reason: 'x' }), (e) => e.status === 400);
  assert.deepStrictEqual(balanceOf(db, alice.id), { b: 10000, f: 10000 });
});

// P8: adjustment writes BOTH records — a ledger row (the money) and an audit
// row (the authority and the reason). One without the other is incomplete.
check('P8 adjustment writes ledger and audit together', async () => {
  const { db, admin, alice } = (await fixture());
  ADM.adjustBalance(db, { actor: admin, userId: alice.id, deltaCents: 2500, reason: 'goodwill credit' });
  ADM.adjustBalance(db, { actor: admin, userId: alice.id, deltaCents: -500, reason: 'correction' });

  // Excludes the 'opening' row written when the account was funded, so this
  // asserts the two ADJUSTMENTS and nothing else.
  const txs = db.prepare("SELECT type, amount_cents, balance_after FROM transactions WHERE user_id=? AND type != 'opening' ORDER BY id").all(alice.id);
  assert.strictEqual(txs.length, 2);
  assert.strictEqual(txs[0].type, 'adjust', 'NOT mislabelled as a faucet deposit');
  assert.strictEqual(txs[0].amount_cents, 2500);
  assert.strictEqual(txs[1].amount_cents, -500);
  assert.strictEqual(txs[1].balance_after, 102000);
  assert.deepStrictEqual(balanceOf(db, alice.id), { b: 102000, f: 0 });

  const rows = AUDIT.list(db, { target: `user:${alice.id}` });
  const adj = rows.filter((r) => r.action === AUDIT.ACTIONS.BALANCE_ADJUSTED);
  assert.strictEqual(adj.length, 2);
  assert.strictEqual(adj[0].reason, 'correction');
  assert.strictEqual(adj[0].actor_id, admin.id);
  assert.strictEqual(adj[0].before.balance_cents, 102500);
  assert.strictEqual(adj[0].after.balance_cents, 102000);
});

// P9: refusals are input validation, not audit events. A rejected request is
// not an action taken, and recording it as one would make the log lie.
check('P9 a refused action leaves no audit row', async () => {
  const { db, admin, alice } = (await fixture());
  assert.throws(() => ADM.adjustBalance(db, { actor: admin, userId: alice.id, deltaCents: 0, reason: 'zero' }), (e) => e.status === 400);
  assert.throws(() => ADM.adjustBalance(db, { actor: admin, userId: alice.id, deltaCents: 10.5, reason: 'fraction' }), (e) => e.status === 400);
  assert.throws(() => ADM.setRole(db, { actor: admin, userId: alice.id, role: 'superuser', reason: 'nope' }), (e) => e.status === 400);
  assert.throws(() => ADM.setStatus(db, { actor: admin, userId: 999999, status: 'suspended', reason: 'ghost' }), (e) => e.status === 404);
  assert.strictEqual(AUDIT.list(db, { target: `user:${alice.id}` }).length, 0);
  assert.deepStrictEqual(balanceOf(db, alice.id), { b: 100000, f: 0 });
});

// P10: the audit trail distinguishes a human actor from the system, and never
// leaks a session token even in the admin detail view.
check('P10 audit separates system from human, leaks nothing', async () => {
  const { db, admin, alice } = (await fixture());
  AUDIT.record(db, admin, AUDIT.ACTIONS.USER_LOGIN, `user:${alice.id}`);
  AUDIT.record(db, null, 'market.settled', 'market:1'); // system action
  const rows = AUDIT.list(db, {});
  const system = rows.filter((r) => r.actor_id === null);
  assert.strictEqual(system.length, 1, 'a system action is not attributed to the admin');
  assert.strictEqual(system[0].action, 'market.settled');

  const token = A.createSession(db, alice.id);
  const detail = ADM.userDetail(db, alice.id);
  assert.ok(detail.sessions.length >= 1);
  assert.ok(!JSON.stringify(detail).includes(token), 'no raw token anywhere in the detail payload');
  assert.ok(detail.audit.length >= 1, 'the detail view carries that account\'s trail');
});

// P11: role changes keep the legacy is_admin mirror in step, so a caller that
// has not been migrated cannot read a stale privilege flag.
check('P11 role change moves the legacy mirror too', async () => {
  const { db, admin, alice } = (await fixture());
  assert.strictEqual(ADM.setRole(db, { actor: admin, userId: alice.id, role: 'admin', reason: 'promoted' }).role, 'admin');
  // Field-by-field rather than deepStrictEqual: node:sqlite hands back
  // null-prototype row objects, which deepStrictEqual refuses to match against
  // an object literal.
  const row = db.prepare('SELECT role, is_admin FROM users WHERE id=?').get(alice.id);
  assert.strictEqual(row.role, 'admin');
  assert.strictEqual(row.is_admin, 1);
  // ...and back down again.
  ADM.setRole(db, { actor: admin, userId: alice.id, role: 'user', reason: 'demoted' });
  const back = db.prepare('SELECT role, is_admin FROM users WHERE id=?').get(alice.id);
  assert.strictEqual(back.role, 'user');
  assert.strictEqual(back.is_admin, 0);
  assert.throws(() => ADM.setRole(db, { actor: admin, userId: alice.id, role: 'user', reason: 'again' }), (e) => e.status === 400);
});

(async () => {
  // Drain the collected checks IN ORDER, awaiting each. A check that rejects
  // is a failure of this suite, not of the next file: exiting here stops
  // the rest of this suite running rather than letting a broken assertion
  // print a green line for a body that never completed.
  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (e) {
      console.error(`  FAIL ${name}`);
      console.error(e);
      process.exit(1);
    }
    passed++;
    console.log('  ok', name);
  }
  console.log(`\nadmin.test.js: ${passed} checks passed`);
})();
