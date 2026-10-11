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

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

function fixture() {
  const db = openStore(':memory:');
  const alice = A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 });
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
check('T1 the default tenant exists and carries config commission', () => {
  const { db } = fixture();
  const t = T.defaultTenant(db);
  assert.strictEqual(t.slug, 'default');
  assert.strictEqual(t.commission_bps, 250, '2.5% of the global default, in bps');
  assert.strictEqual(T.defaultTenant(db).id, t.id, 'idempotent');
});

// T2: NULL tenant_id means the default tenant. This is what lets every
// existing row keep working untouched.
check('T2 a user with no tenant belongs to the default', () => {
  const { db, alice } = fixture();
  assert.strictEqual(db.prepare('SELECT tenant_id FROM users WHERE id=?').get(alice.id).tenant_id, null);
  assert.strictEqual(T.ofUser(db, alice.id).id, T.defaultTenant(db).id);
});

// T3: commission is read PER TENANT, in basis points, and an unconfigured
// tenant falls back to the global rate rather than to zero.
check('T3 commission is per tenant, in basis points', () => {
  const { db, alice } = fixture();
  const t2 = makeTenant(db, { slug: 'vip', name: 'VIP', commission_bps: 175 });
  assert.strictEqual(T.commissionBps(db, t2), 175);
  assert.strictEqual(T.commissionBps(db, T.defaultTenant(db).id), 250);
  assert.strictEqual(T.commissionBps(db, 99999), 250, 'unknown tenant falls back to the global rate');
  db.prepare('UPDATE users SET tenant_id=? WHERE id=?').run(t2, alice.id);
  assert.strictEqual(T.commissionBps(db, T.ofUser(db, alice.id).id), 175);
});

// T4: an out-of-range commission is refused, not clamped. Clamping 5000bps to
// 2000 would quietly charge a different rate than the operator configured.
check('T4 an invalid commission is refused, not clamped', () => {
  const { db } = fixture();
  const ops = { actor: { id: 1 }, tenantId: T.defaultTenant(db).id };
  assert.throws(() => T.configure(db, { ...ops, commission_bps: -1 }), /commission_bps/);
  assert.throws(() => T.configure(db, { ...ops, commission_bps: 2001 }), /commission_bps/);
  assert.throws(() => T.configure(db, { ...ops, commission_bps: 1.5 }), /commission_bps/);
  assert.throws(() => T.configure(db, { ...ops, status: 'weird' }), /Unknown tenant status/);
});

// T5: branding is a CONFIG READ. No build step — which is the reason the
// no-build frontend survives multi-tenancy instead of being the blocker.
check('T5 branding is a per-tenant config read', () => {
  const { db } = fixture();
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
check('T6 malformed tenant config degrades, never crashes', () => {
  const { db } = fixture();
  db.prepare("UPDATE tenants SET brand = 'not json at all', jurisdictions = '{{{bad' WHERE id=?").run(T.defaultTenant(db).id);
  const b = T.branding(db, T.defaultTenant(db).id);
  assert.ok(b.name, 'fell back to a usable default');
  assert.deepStrictEqual(T.jurisdictions(db, T.defaultTenant(db).id), [], 'and to an empty allowlist');
});

// T7: JURISDICTION IS ENFORCED AT SESSION CREATION. A blocked player must
// never hold a live position — once they do, refusing to serve them leaves
// the venue choosing which side of a matched bet to honour.
check('T7 a blocked jurisdiction is refused at session creation', () => {
  const { db, alice } = fixture();
  db.prepare("UPDATE tenants SET jurisdictions = ? WHERE id=?").run(JSON.stringify(['GB', 'IE']), T.defaultTenant(db).id);
  assert.throws(() => A.createSession(db, alice.id, { country: 'FR' }), (e) => e.status === 403 && e.details.code === 'jurisdiction-not-allowed');
  // An allowed country gets a session.
  assert.ok(A.createSession(db, alice.id, { country: 'GB' }));
});

// T8: "not supplied" and "not allowed" are DIFFERENT errors. Conflating them
// produces support tickets for a problem the player cannot solve.
check('T8 missing jurisdiction is distinguishable from a blocked one', () => {
  const { db, alice } = fixture();
  db.prepare("UPDATE tenants SET jurisdictions = ? WHERE id=?").run(JSON.stringify(['GB']), T.defaultTenant(db).id);
  assert.throws(() => A.createSession(db, alice.id, {}), (e) => e.details.code === 'no-jurisdiction-supplied');
  assert.throws(() => A.createSession(db, alice.id, { country: 'US' }), (e) => e.details.code === 'jurisdiction-not-allowed');
});

// T9: an EMPTY allowlist means unrestricted — the single-operator case. An
// operator who has not configured jurisdictions must not be locked out of
// their own venue.
check('T9 an empty allowlist is unrestricted, not blocked-everyone', () => {
  const { db, alice } = fixture();
  assert.ok(A.createSession(db, alice.id, { country: 'ZZ' }), 'no configuration, no block');
  assert.strictEqual(T.jurisdictionRefusal(db, T.defaultTenant(db).id, 'ZZ'), null);
});

// T10: jurisdiction comparison is case-insensitive, because a country code
// from a header arrives in whatever case the client sent.
check('T10 jurisdiction matching is case-insensitive', () => {
  const { db, alice } = fixture();
  db.prepare("UPDATE tenants SET jurisdictions = ? WHERE id=?").run(JSON.stringify(['gb']), T.defaultTenant(db).id);
  assert.ok(A.createSession(db, alice.id, { country: 'GB' }));
  assert.ok(A.createSession(db, alice.id, { country: 'gb' }));
});

// T11: ADMIN IS SCOPED TO A TENANT, and the scope is structural — there is no
// argument value that means "every tenant". A forgotten scope on an admin
// route would be a cross-tenant read.
check('T11 admin user listing cannot cross tenants', () => {
  const { db, alice } = fixture();
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
check('T12 pre-existing NULL-tenant rows are reachable via the default scope', () => {
  const { db, alice } = fixture();
  const list = ADM.listUsers(db, { tenantId: null });
  assert.ok(list.total >= 1, 'the NULL-tenant account is visible in the default tenant');
  assert.ok(list.users.some((u) => u.id === alice.id));
});

// T13: every operational table got tenant_id with a LEADING index — leading
// because every operational query scopes by tenant first.
check('T13 tenant_id exists on every operational table, indexed', () => {
  const { db } = fixture();
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
check('T14 tenant configuration is audited', () => {
  const { db } = fixture();
  const adm = A.registerUser(db, { username: 'ops', password: 'pw-ops-123', balance_cents: 0 });
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
check('T15 an unknown tenant is a 404, not a silent no-op', () => {
  const { db } = fixture();
  assert.throws(() => T.configure(db, { actor: { id: 1 }, tenantId: 4242, name: 'Ghost' }), (e) => e.status === 404);
});

// T16: the session row records the tenant it was minted for, so an audit of
// "who could act here, and when" is possible.
check('T16 sessions record the tenant they were minted for', () => {
  const { db, alice } = fixture();
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
check('T17 a client-supplied country header is ignored by default', () => {
  const { db, alice } = fixture();
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
check('T18 a trusted header is validated and sentinels discarded', () => {
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
check('T19 an allowlist with no trusted source fails closed', () => {
  const { db, alice } = fixture();
  db.prepare("UPDATE tenants SET jurisdictions = ? WHERE id=?").run(JSON.stringify(['GB']), T.defaultTenant(db).id);
  assert.throws(() => A.createSession(db, alice.id, { country: null }), (e) => e.status === 403 && e.details.code === 'no-jurisdiction-supplied');
});

console.log(`\ntenants.test.js: ${passed} checks passed`);
if (passed < 19) { console.error('expected 19 checks'); process.exit(1); }