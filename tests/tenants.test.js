// tenants.test.js — multi-tenancy (Phase 4).
// Run: node tests/tenants.test.js   (plain assert, no deps)
//
// The claims under test are deliberately narrow. Self-hosting is the
// degenerate case, so the important properties are: two tenants coexist with
// separate configuration, and NO QUERY CAN CROSS THEM.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const T = require('./../lib/tenants');
const ADM = require('../lib/admin');
const config = require('../lib/config');
const acc = require('../lib/accounts');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this
// file rather than run eagerly - an eager runner would report a passing
// check whose promise later rejected.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

async function fixture() {
  const db = openStore(':memory:');
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 }));
  return { db, alice };
}

function makeTenant(db, { slug, name, commission_bps, jurisdictions, brand }) {
  const info = db
    .prepare('INSERT INTO tenants (slug, name, commission_bps, jurisdictions, brand) VALUES (?, ?, ?, ?, ?)')
    .run(slug, name, commission_bps, jurisdictions === undefined ? null : JSON.stringify(jurisdictions), brand === undefined ? null : JSON.stringify(brand));
  return Number(info.lastInsertRowid);
}

// T1: the default tenant always exists, so a single-operator install needs no
// configuration and no migration step to work.
check('T1 the default tenant exists and carries config commission', async () => {
  const { db } = (await fixture());
  const t = T.defaultTenant(db);
  assert.strictEqual(t.slug, 'default');
  assert.strictEqual(t.commission_bps, 250, '2.5% of the global default, in bps');
  assert.strictEqual(T.defaultTenant(db).id, t.id, 'idempotent');
});

// T2: NULL tenant_id means the default tenant. This is what lets every
// existing row keep working untouched.
check('T2 a user with no tenant belongs to the default', async () => {
  const { db, alice } = (await fixture());
  assert.strictEqual(db.prepare('SELECT tenant_id FROM users WHERE id=?').get(alice.id).tenant_id, null);
  assert.strictEqual(T.ofUser(db, alice.id).id, T.defaultTenant(db).id);
});

// T3: commission is read PER TENANT, in basis points, and an unconfigured
// tenant falls back to the global rate rather than to zero.
check('T3 commission is per tenant, in basis points', async () => {
  const { db, alice } = (await fixture());
  const t2 = makeTenant(db, { slug: 'vip', name: 'VIP', commission_bps: 175 });
  assert.strictEqual(T.commissionBps(db, t2), 175);
  assert.strictEqual(T.commissionBps(db, T.defaultTenant(db).id), 250);
  assert.strictEqual(T.commissionBps(db, 99999), 250, 'unknown tenant falls back to the global rate');
  db.prepare('UPDATE users SET tenant_id=? WHERE id=?').run(t2, alice.id);
  assert.strictEqual(T.commissionBps(db, T.ofUser(db, alice.id).id), 175);
});

// T4: an out-of-range commission is refused, not clamped. Clamping 5000bps to
// 2000 would quietly charge a different rate than the operator configured.
check('T4 an invalid commission is refused, not clamped', async () => {
  const { db } = (await fixture());
  const ops = { actor: { id: 1 }, tenantId: T.defaultTenant(db).id };
  assert.throws(() => T.configure(db, { ...ops, commission_bps: -1 }), /commission_bps/);
  assert.throws(() => T.configure(db, { ...ops, commission_bps: 2001 }), /commission_bps/);
  assert.throws(() => T.configure(db, { ...ops, commission_bps: 1.5 }), /commission_bps/);
  assert.throws(() => T.configure(db, { ...ops, status: 'weird' }), /Unknown tenant status/);
});

// T5: branding is a CONFIG READ. No build step — which is the reason the
// no-build frontend survives multi-tenancy instead of being the blocker.
check('T5 branding is a per-tenant config read', async () => {
  const { db } = (await fixture());
  const t2 = makeTenant(db, {
    slug: 'vip', name: 'VIP Exchange', commission_bps: 100,
    brand: { name: 'VIP Exchange', logo: '/assets/logo.png', terms_url: '/terms', palette: { accent: '#c00' } },
  });
  const b = T.branding(db, t2);
  assert.strictEqual(b.name, 'VIP Exchange');
  assert.strictEqual(b.terms_url, '/terms');
  assert.strictEqual(b.palette.accent, '#c00');
  // The default tenant still has working branding with no configuration.
  assert.ok(T.branding(db, T.defaultTenant(db).id).name);
});

// T6: malformed brand JSON falls back rather than taking the venue down. A
// bad config must not be a boot-time crash for every player.
check('T6 malformed tenant config degrades, never crashes', async () => {
  const { db } = (await fixture());
  db.prepare("UPDATE tenants SET brand = 'not json at all', jurisdictions = '{{{bad' WHERE id=?").run(T.defaultTenant(db).id);
  const b = T.branding(db, T.defaultTenant(db).id);
  assert.ok(b.name, 'fell back to a usable default');
  assert.deepStrictEqual(T.jurisdictions(db, T.defaultTenant(db).id), [], 'and to an empty allowlist');
});

// T7: JURISDICTION IS ENFORCED AT SESSION CREATION. A blocked player must
// never hold a live position — once they do, refusing to serve them leaves
// the venue choosing which side of a matched bet to honour.
check('T7 a blocked jurisdiction is refused at session creation', async () => {
  const { db, alice } = (await fixture());
  db.prepare("UPDATE tenants SET jurisdictions = ? WHERE id=?").run(JSON.stringify(['GB', 'IE']), T.defaultTenant(db).id);
  assert.throws(() => A.createSession(db, alice.id, { country: 'FR' }), (e) => e.status === 403 && e.details.code === 'jurisdiction-not-allowed');
  // An allowed country gets a session.
  assert.ok(A.createSession(db, alice.id, { country: 'GB' }));
});

// T8: "not supplied" and "not allowed" are DIFFERENT errors. Conflating them
// produces support tickets for a problem the player cannot solve.
check('T8 missing jurisdiction is distinguishable from a blocked one', async () => {
  const { db, alice } = (await fixture());
  db.prepare("UPDATE tenants SET jurisdictions = ? WHERE id=?").run(JSON.stringify(['GB']), T.defaultTenant(db).id);
  assert.throws(() => A.createSession(db, alice.id, {}), (e) => e.details.code === 'no-jurisdiction-supplied');
  assert.throws(() => A.createSession(db, alice.id, { country: 'US' }), (e) => e.details.code === 'jurisdiction-not-allowed');
});

// T9: an EMPTY allowlist means unrestricted — the single-operator case. An
// operator who has not configured jurisdictions must not be locked out of
// their own venue.
check('T9 an empty allowlist is unrestricted, not blocked-everyone', async () => {
  const { db, alice } = (await fixture());
  assert.ok(A.createSession(db, alice.id, { country: 'ZZ' }), 'no configuration, no block');
  assert.strictEqual(T.jurisdictionRefusal(db, T.defaultTenant(db).id, 'ZZ'), null);
});

// T10: jurisdiction comparison is case-insensitive, because a country code
// from a header arrives in whatever case the client sent.
check('T10 jurisdiction matching is case-insensitive', async () => {
  const { db, alice } = (await fixture());
  db.prepare("UPDATE tenants SET jurisdictions = ? WHERE id=?").run(JSON.stringify(['gb']), T.defaultTenant(db).id);
  assert.ok(A.createSession(db, alice.id, { country: 'GB' }));
  assert.ok(A.createSession(db, alice.id, { country: 'gb' }));
});

// T11: ADMIN IS SCOPED TO A TENANT, and the scope is structural — there is no
// argument value that means "every tenant". A forgotten scope on an admin
// route would be a cross-tenant read.
check('T11 admin user listing cannot cross tenants', async () => {
  const { db, alice } = (await fixture());
  const t2 = makeTenant(db, { slug: 'vip', name: 'VIP', commission_bps: 100 });
  db.prepare('UPDATE users SET tenant_id=? WHERE id=?').run(t2, alice.id);

  // Alice is in t2, so a t2-scoped list sees her.
  const inT2 = ADM.listUsers(db, { tenantId: t2 });
  assert.strictEqual(inT2.total, 1);
  // A different tenant sees none of her.
  const t3 = makeTenant(db, { slug: 'other', name: 'Other', commission_bps: 100 });
  assert.strictEqual(ADM.listUsers(db, { tenantId: t3 }).total, 0, 'no cross-tenant leak');
  // And the default tenant — which alice is NOT in — does not see her either.
  assert.strictEqual(ADM.listUsers(db, { tenantId: null }).total, 0, 'default scope did not leak her');
});

// T12: a row with tenant_id NULL still belongs to the default tenant, so the
// migration does not orphan every pre-existing account.
check('T12 pre-existing NULL-tenant rows are reachable via the default scope', async () => {
  const { db, alice } = (await fixture());
  const list = ADM.listUsers(db, { tenantId: null });
  assert.ok(list.total >= 1, 'the NULL-tenant account is visible in the default tenant');
  assert.ok(list.users.some((u) => u.id === alice.id));
});

// T13: every operational table got tenant_id with a LEADING index — leading
// because every operational query scopes by tenant first.
check('T13 tenant_id exists on every operational table, indexed', async () => {
  const { db } = (await fixture());
  const tables = ['users', 'sessions', 'orders', 'matches', 'settlements', 'transactions', 'price_history', 'limits', 'risk_bots', 'payment_intents', 'audit_log', 'sports', 'competitions', 'events', 'markets', 'selections'];
  for (const t of tables) {
    const col = db.prepare('SELECT name FROM pragma_table_info(?) WHERE name=?').get(t, 'tenant_id');
    assert.ok(col, `${t} has tenant_id`);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(`idx_${t}_tenant`);
    assert.ok(idx, `${t} has a tenant index`);
  }
});

// T14: tenant configuration is AUDITED — commission and jurisdiction are
// commercial and legal facts, and who set them has to be answerable.
check('T14 tenant configuration is audited', async () => {
  const { db } = (await fixture());
  const adm = (await A.registerUser(db, { username: 'ops', password: 'pw-ops-123', balance_cents: 0 }));
  db.prepare("UPDATE users SET role='admin', is_admin=1 WHERE id=?").run(adm.id);
  T.configure(db, { actor: adm, tenantId: T.defaultTenant(db).id, commission_bps: 300, jurisdictions: ['GB'] });
  const A2 = require('../lib/audit');
  const rows = A2.list(db, { limit: 50 });
  const row = rows.find((r) => r.action === 'tenant.configured');
  assert.ok(row, 'recorded');
  assert.strictEqual(row.actor_id, adm.id);
  assert.strictEqual(row.after.commission_bps, 300);
});

// T15: configuring a tenant that does not exist is a 404, not a silent no-op.
check('T15 an unknown tenant is a 404, not a silent no-op', async () => {
  const { db } = (await fixture());
  assert.throws(() => T.configure(db, { actor: { id: 1 }, tenantId: 4242, name: 'Ghost' }), (e) => e.status === 404);
});

// T16: the session row records the tenant it was minted for, so an audit of
// "who could act here, and when" is possible.
check('T16 sessions record the tenant they were minted for', async () => {
  const { db, alice } = (await fixture());
  const t2 = makeTenant(db, { slug: 'vip', name: 'VIP', commission_bps: 100 });
  db.prepare('UPDATE users SET tenant_id=? WHERE id=?').run(t2, alice.id);
  A.createSession(db, alice.id);
  const row = db.prepare('SELECT tenant_id FROM sessions WHERE user_id=?').get(alice.id);
  assert.strictEqual(row.tenant_id, t2);
});

// T17: THE TRUST BOUNDARY. A client-declared country is not a jurisdiction.
// With TRUST_PROXY_JURISDICTION off the header is ignored entirely — trusting
// it would make the control defeatable by editing one header while still
// being recorded as enforced.
check('T17 a client-supplied country header is ignored by default', async () => {
  const { db, alice } = (await fixture());
  db.prepare("UPDATE tenants SET jurisdictions = ? WHERE id=?").run(JSON.stringify(['GB']), T.defaultTenant(db).id);
  const spoof = { headers: { 'cf-ipcountry': 'GB', 'x-jurisdiction': 'GB' } };
  // Flag is off in this suite: nothing the client sends is evidence.
  assert.strictEqual(config.TRUST_PROXY_JURISDICTION, false, 'precondition');
  assert.strictEqual(T.trustedCountry(spoof), null, 'header ignored');
  // So an allowlisted jurisdiction still cannot be claimed by asking for it.
  assert.throws(() => A.createSession(db, alice.id, { country: T.trustedCountry(spoof) }), (e) => e.details.code === 'no-jurisdiction-supplied');
});

// T18: with the flag on, only a well-formed ISO code from the header counts.
// A misconfigured proxy must not be able to smuggle arbitrary strings into the
// audit trail, and the conventional "unknown" sentinels carry no information.
check('T18 a trusted header is validated and sentinels discarded', async () => {
  const mk = (h) => {
    const prev = config.TRUST_PROXY_JURISDICTION;
    config.TRUST_PROXY_JURISDICTION = true;
    try { return T.trustedCountry({ headers: h }); } finally { config.TRUST_PROXY_JURISDICTION = prev; }
  };
  assert.strictEqual(mk({ 'cf-ipcountry': 'gb' }), 'GB', 'normalised');
  assert.strictEqual(mk({ 'cf-ipcountry': 'XX' }), null, 'CDN "unknown" sentinel is not a country');
  assert.strictEqual(mk({ 'cf-ipcountry': 'T1' }), null, 'Tor exit sentinel is not a country');
  assert.strictEqual(mk({ 'cf-ipcountry': 'GBR' }), null, 'not a two-letter code');
  assert.strictEqual(mk({ 'cf-ipcountry': "GB'; DROP TABLE users;--" }), null, 'injection-shaped value discarded');
  assert.strictEqual(mk({}), null, 'absent');
});

// T19: gating fails CLOSED when an allowlist is configured but no trusted
// source exists. Blocking every login is the correct behaviour — the
// alternative is silently disabling the control because geolocation was never
// wired up.
check('T19 an allowlist with no trusted source fails closed', async () => {
  const { db, alice } = (await fixture());
  db.prepare("UPDATE tenants SET jurisdictions = ? WHERE id=?").run(JSON.stringify(['GB']), T.defaultTenant(db).id);
  assert.throws(() => A.createSession(db, alice.id, { country: null }), (e) => e.status === 403 && e.details.code === 'no-jurisdiction-supplied');
});

// T20: a tenant's commission rate and status are, in the module's own words,
// "commercial and legal facts" — so a change that cannot be recorded must not
// stand. #27.
//
// THE MECHANISM IS NOT THE ONE THE ISSUE DESCRIBED. It assumed
// `audit.record` throws. It does not: it catches its own errors, logs a warning
// and RETURNS FALSE. So simply wrapping the UPDATE and the audit call in one
// transaction would have been decorative — nothing would roll back, because
// nothing is thrown. The transaction only closes the hole if a failed audit
// write is treated as a failed mutation, which is what `assertAudited` below
// makes explicit.
//
// The audit failure is produced by dropping `audit_log`, which makes the INSERT
// fail the way a full disk or a locked database would.
check('T20 a tenant change that cannot be audited does not stand', async () => {
  const { db, alice } = (await fixture());
  const tid = T.defaultTenant(db).id;
  const ops = { actor: alice, tenantId: tid };
  const before = T.byId(db, tid).commission_bps;

  db.exec('DROP TABLE audit_log');
  assert.throws(
    () => T.configure(db, { ...ops, commission_bps: 999 }),
    (e) => e.status >= 500,
    'the operator is told the change did not happen'
  );
  assert.strictEqual(
    T.byId(db, tid).commission_bps,
    before,
    'and the commission rate is UNCHANGED — the mutation rolled back with its audit row'
  );

  // The status half of the same call: a suspended tenant is an availability
  // fact, so it must roll back on the same terms.
  const statusBefore = T.byId(db, tid).status;
  assert.throws(() => T.configure(db, { ...ops, status: 'suspended' }), (e) => e.status >= 500);
  assert.strictEqual(T.byId(db, tid).status, statusBefore, 'the status is unchanged too');
  db.close();
});

// ── #32: tenant status 'suspended' must BLOCK ────────────────────────────────
//
// The value was validated, stored, audited and rendered in the admin UI, and
// read by nothing. Every user of a suspended tenant could log in, deposit,
// place bets and cash out. Everything below is about the four things the
// control has to do that storing it never did: refuse a login, refuse a trade
// by someone ALREADY signed in, leave the read side working, and stop being a
// trap for the operator holding the key.

const M = require('../lib/match');
const LIM = require('../lib/limits');
const LED = require('../lib/ledger');
const SET = require('../lib/settle');

let evN = 0;
function mkMarket(db, fair = 2.0) {
  db.prepare("INSERT OR IGNORE INTO sports (name, slug) VALUES ('Football', 'football')").run();
  const sport = db.prepare("SELECT id FROM sports WHERE slug='football'").get();
  evN++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now','+2 hours'))")
    .run(sport.id, `S32 Event ${evN}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`S32 Event ${evN}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id = ? ORDER BY id DESC').get(ev.id);
  const sels = {};
  for (const n of ['Red', 'Blue']) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(mkt.id, n, fair);
    sels[n] = db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, n).id;
  }
  return { marketId: mkt.id, s1: sels.Red, s2: sels.Blue };
}

const suspend = (db, actor, tenantId) =>
  T.configure(db, { actor, tenantId, status: 'suspended' });

// T21: THE LOGIN GATE, AND THE ORDERING. A suspension that refuses BEFORE the
// password check turns /api/auth/login into a probe: anyone can learn that a
// username exists AND that its venue is suspended, having proved nothing. The
// same reasoning lib/auth.js already applies to a suspended ACCOUNT.
check('T21 a suspended tenant refuses login, and only after the password is proven', async () => {
  const { db, alice } = (await fixture());
  const tid = T.defaultTenant(db).id;

  // The control: while the tenant is ACTIVE the correct password gets a session.
  const before = await A.loginUser(db, { username: 'alice', password: 'pw-alice-123' });
  assert.ok(before && before.token, 'precondition: an active tenant logs in');

  suspend(db, alice, tid);
  assert.strictEqual(T.suspensionRefusal(db, tid), 'tenant_suspended', 'the tenant reads as suspended');

  await assert.rejects(
    () => A.loginUser(db, { username: 'alice', password: 'pw-alice-123' }),
    (e) => e.status === 403 && e.details && e.details.code === 'tenant_suspended' && /suspended/i.test(e.message),
    'the correct password is refused, with a reason that names the venue'
  );

  // NOT AN ORACLE. A wrong password on a suspended tenant is still the single
  // generic 401, so nothing here distinguishes "exists and is suspended" from
  // "does not exist" or "wrong password". Check the suspension BEFORE the
  // password and this becomes a 403 that says exactly which it is.
  await assert.rejects(
    () => A.loginUser(db, { username: 'alice', password: 'wrong-password' }),
    (e) => e.status === 401 && /Invalid username or password/.test(e.message),
    'a wrong password is still the generic 401 — the gate is not an existence oracle'
  );
  await assert.rejects(
    () => A.loginUser(db, { username: 'nobody-at-all', password: 'wrong-password' }),
    (e) => e.status === 401,
    'and an unknown username is indistinguishable from it'
  );

  // …and the same at the session factory, which is the other entry point.
  assert.throws(
    () => A.createSession(db, alice.id, {}),
    (e) => e.status === 403 && e.details.code === 'tenant_suspended'
  );

  // RESTORING puts it back, which is the property that makes this a control
  // rather than a one-way door.
  T.configure(db, { actor: alice, tenantId: tid, status: 'active' });
  const after = await A.loginUser(db, { username: 'alice', password: 'pw-alice-123' });
  assert.ok(after && after.token, 'restoring the tenant restores trading');
  assert.strictEqual(T.suspensionRefusal(db, tid), null);
  db.close();
});

// T22: AN EXISTING SESSION MUST STOP WORKING. The session below is minted
// BEFORE the suspension and is asserted to still resolve afterwards, so every
// 403 here is a refusal of a live session and not of a dead one.
check('T22 an already-signed-in player is stopped at the next money-moving act', async () => {
  const { db, alice } = (await fixture());
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-1234', balance_cents: 100000 }));
  const tid = T.defaultTenant(db).id;
  const { marketId, s1 } = mkMarket(db);
  M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  const positions = M.positionsFor(db, alice.id);
  assert.strictEqual(positions.length, 1, 'precondition: alice holds a matched position');

  const token = A.createSession(db, alice.id);
  const me = () => A.sessionUser(db, token);
  assert.ok(me(), 'precondition: a live session before the suspension');

  suspend(db, alice, tid);
  assert.ok(me(), 'the session itself still resolves — it is the ACTING that is refused');

  // 1. The engine gate. Every money path already calls this one, which is why
  //    the control lives here and not in a route a future caller can forget.
  assert.throws(
    () => LIM.assertTradeable(db, me()),
    (e) => e.status === 403 && e.details.code === 'tenant_suspended' && /venue is suspended/i.test(e.message)
  );

  // 2. Placing an order.
  assert.throws(
    () => M.placeOrder(db, me(), { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5000 }),
    (e) => e.status === 403 && e.details.code === 'tenant_suspended'
  );

  // 3. Cashing out — the one path that walks out with the venue's money.
  assert.throws(
    () => require('../lib/cashout').cashoutMarket(db, me(), marketId),
    (e) => e.status === 403 && e.details.code === 'tenant_suspended'
  );

  // 4. The position is UNTOUCHED. Refusing to serve a player who holds one
  //    would mean the venue chooses which side of a matched bet to honour.
  assert.strictEqual(M.positionsFor(db, alice.id).length, 1, 'the matched position is left alone');
  assert.strictEqual(
    db.prepare('SELECT frozen_cents f FROM users WHERE id=?').get(alice.id).f,
    10000,
    'and so is the collateral held against it'
  );
  assert.strictEqual(acc.assertConserved(db), 0, 'the books still balance');
  db.close();
});

// T23: READS STAY AVAILABLE. This is the judgement call in #32, so it is
// asserted rather than assumed: a player who can read but not trade is the
// intended state, and the admin desk must not become a trap for the operator
// who has to restore the tenant.
check('T23 a suspended tenant keeps READS and the admin desk; only acting is refused', async () => {
  const { db, alice } = (await fixture());
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-1234', balance_cents: 100000 }));
  const tid = T.defaultTenant(db).id;
  const { marketId, s1, s2 } = mkMarket(db);
  M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  // A RESTING order, so the book has depth and there is something to read.
  M.placeOrder(db, bob, { selection_id: s2, side: 'lay', price: 2.5, stake_cents: 5000 });

  suspend(db, alice, tid);

  // Reads: the position, the balance, the ledger, the book.
  assert.strictEqual(M.positionsFor(db, alice.id).length, 1, 'the player can still see their position');
  const wallet = LED.walletView(db, alice.id);
  assert.strictEqual(wallet.balance_cents, 100000, 'and their balance');
  assert.ok(Array.isArray(wallet.transactions), 'and their ledger');
  assert.ok(M.bookFor(db, marketId).length > 0, 'and the order book');

  // The admin desk still settles. Refusing to settle obligations that already
  // exist is the one thing a suspension must never do.
  const r = SET.settleMarket(db, marketId, { winner_selection_id: s1 });
  assert.ok(r && r.status !== 'rejected', `settlement still works on a suspended tenant (got ${JSON.stringify(r && r.status)})`);
  assert.strictEqual(
    db.prepare('SELECT balance_cents b FROM users WHERE id=?').get(alice.id).b,
    100000 + 10000 - 250,
    'and the winner is paid in full'
  );
  assert.strictEqual(acc.assertConserved(db), 0);
  db.close();
});

// T24: SUSPENSION TAKES THE RESTING ORDERS WITH IT. A gate cannot do this: a
// resting order is not a request, it is live liquidity, and after the new gates
// it would still be matchable — a suspended venue taking new matched positions
// is exactly what the suspension exists to prevent.
check('T24 suspending a tenant cancels its resting orders and releases the escrow', async () => {
  const { db, alice } = (await fixture());
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-1234', balance_cents: 100000 }));
  const tid = T.defaultTenant(db).id;
  const { marketId, s1, s2 } = mkMarket(db);
  M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  // Two resting orders, one per player, so neither side is a special case.
  M.placeOrder(db, alice, { selection_id: s2, side: 'back', price: 3.0, stake_cents: 5000 });
  M.placeOrder(db, bob, { selection_id: s2, side: 'back', price: 4.0, stake_cents: 5000 });
  const alice0 = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id=?').get(alice.id);
  assert.strictEqual(alice0.f, 15000, 'precondition: 10000 matched + 5000 resting is frozen');

  const r = suspend(db, alice, tid);
  assert.strictEqual(r.status, 'suspended');

  assert.strictEqual(M.openOrdersFor(db, alice.id).length, 0, 'alice has no resting orders left');
  assert.strictEqual(M.openOrdersFor(db, bob.id).length, 0, 'nor does bob');
  const alice1 = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id=?').get(alice.id);
  assert.strictEqual(alice1.f, 10000, 'only the MATCHED collateral is still held');
  assert.strictEqual(alice1.b, 100000, 'and the resting escrow came back in full');
  const rows = db.prepare("SELECT frozen_cents f, status FROM orders WHERE status='cancelled'").all();
  assert.strictEqual(rows.length, 2);
  for (const o of rows) assert.strictEqual(o.f, 0, 'a cancelled order leaves no escrow on the row');
  // The audit row records the same transaction, so "cancelled the book" is
  // answerable from the same place as "suspended the tenant".
  const A2 = require('../lib/audit');
  const row = A2.list(db, { limit: 50 }).find((x) => x.action === 'tenant.configured' && x.after.status === 'suspended');
  assert.ok(row, 'the suspension is audited');
  assert.strictEqual(acc.assertConserved(db), 0);
  db.close();
});

// T25: the control against the whole control being "refuse everything". Another
// tenant — and a user outside the suspended one — is untouched by every gate.
check('T25 suspension is scoped to its own tenant', async () => {
  const { db, alice } = (await fixture());
  const otherId = makeTenant(db, { slug: 'live', name: 'Live', commission_bps: 100 });
  const other = (await A.registerUser(db, { username: 'other-player', password: 'pw-other-1234', balance_cents: 100000 }));
  db.prepare('UPDATE users SET tenant_id=? WHERE id=?').run(otherId, other.id);
  const { marketId, s1 } = mkMarket(db);

  suspend(db, alice, T.defaultTenant(db).id);

  assert.strictEqual(T.suspensionRefusal(db, otherId), null, 'the other tenant is not suspended');
  assert.strictEqual(T.suspensionRefusalForUser(db, other.id), null);
  assert.throws(
    () => LIM.assertTradeable(db, alice),
    (e) => e.details.code === 'tenant_suspended',
    'alice is still refused'
  );
  assert.strictEqual(LIM.assertTradeable(db, other), undefined, 'and the other tenant still trades');
  // Awaited, not floated: loginUser derives its hash off the event loop, so an
  // unawaited call resolves after this check has closed the database and kills
  // the process with "database is not open" — nondeterministically, which is
  // worse than a failure.
  const otherLogin = await A.loginUser(db, { username: 'other-player', password: 'pw-other-1234' });
  assert.ok(otherLogin && otherLogin.token, 'and can still log in');
  M.placeOrder(db, other, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  db.close();
});

// T26: a suspension that cannot be undone from the API would be a trap, and the
// first-run credential lock in server.js already had to be repaired for exactly
// that. Restoring is an ordinary configure call on a suspended tenant.
check('T26 a suspended tenant can be restored, and the gate opens again', async () => {
  const { db, alice } = (await fixture());
  const tid = T.defaultTenant(db).id;
  const { marketId, s1 } = mkMarket(db);
  suspend(db, alice, tid);
  assert.throws(() => M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }), (e) => e.status === 403);
  T.configure(db, { actor: alice, tenantId: tid, status: 'active' });
  assert.strictEqual(LIM.assertTradeable(db, alice), undefined, 'the gate is open again');
  const order = M.placeOrder(db, alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  assert.ok(order && order.order, 'and orders are accepted again');
  db.close();
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
  if (passed < 26) { console.error("expected 26 checks"); process.exit(1); }
  console.log(`\ntenants.test.js: ${passed} checks passed`);
})();
