'use strict';
// lib/tenants.js — multi-tenancy.
//
// SELF-HOSTING IS THE DEGENERATE CASE. Modelling self-hosting as
// multi-tenancy is both simpler to sell and honest about the deployment story:
// the operator already runs this as one tenant, so making it explicit means
// nobody has to unpick "single user" assumptions later, when other people's
// code is already on top of them.
//
// THE DEFAULT TENANT EXISTS ALWAYS. Every install gets a row seeded from
// config, and a NULL tenant_id means "the default tenant". That is what lets
// a single-operator install keep working with no tenant row, no migration
// step and no behaviour change — which is the whole reason Phase 4 can land
// without breaking the paper-money deployment.
//
// JURISDICTION IS ENFORCED AT SESSION CREATION, not at bet placement.
//
//   This is the one ordering decision worth defending. Checking at placement
//   means a player in a blocked jurisdiction can register, deposit, and place
//   bets — and is only refused when they try to win. They are then holding a
//   live position the venue is not permitted to honour, which is precisely
//   the position the venue cannot unwind without choosing a side.
//
//   Blocking at login means they never hold one. The cost is that a player's
//   session can lapse while they travel, which is a recoverable inconvenience
//   rather than an unlawful exposure.
const config = require('./config');
const { transaction } = require('./tx');

const DEFAULT_SLUG = 'default';

// The default tenant is resolved by SLUG, never by a hard-coded id. An
// earlier version pinned DEFAULT_TENANT_ID = 1, which is wrong the moment an
// operator creates a tenant before the default has been materialised: that
// tenant takes id 1 and every subsequent "is this the default?" question
// silently answers about the wrong row. Slug is the stable identity; ids are
// an implementation detail that shifts under a restore from backup.
function defaultTenant(db) {
  const existing = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(DEFAULT_SLUG);
  if (existing) return existing;
  db.prepare(
    `INSERT INTO tenants (slug, name, status, commission_bps, brand, jurisdictions)
     VALUES (?, ?, 'active', ?, ?, ?)`
  ).run(
    DEFAULT_SLUG,
    'Default',
    Math.round(config.COMMISSION_RATE * 10000),
    JSON.stringify({ name: 'OpenBettingExchange', logo: '/assets/logo.png' }),
    '[]'
  );
  return db.prepare('SELECT * FROM tenants WHERE slug = ?').get(DEFAULT_SLUG);
}

function byId(db, tenantId) {
  if (tenantId === null || tenantId === undefined) return defaultTenant(db);
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) || null;
}

function bySlug(db, slug) {
  return db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug) || null;
}

/** The tenant a user belongs to. NULL tenant_id means the default tenant. */
function ofUser(db, userId) {
  const row = db.prepare('SELECT tenant_id FROM users WHERE id = ?').get(userId);
  if (!row) return null;
  return row.tenant_id === null || row.tenant_id === undefined ? defaultTenant(db) : byId(db, row.tenant_id);
}

// Commission in BASIS POINTS (integer). Reading a float rate and converting
// per settlement is how a tenant's take ends up a cent off; bps makes the
// stored value exact and the conversion single.
function commissionBps(db, tenantId) {
  const t = byId(db, tenantId);
  if (!t) return Math.round(config.COMMISSION_RATE * 10000);
  return t.commission_bps;
}

/**
 * The commission, in bps, that applies to THIS user's winnings.
 *
 * Exists because the outside audit's F6 was that this number was never read
 * at settlement: an operator could negotiate a tenant down to 100 bps, the
 * admin UI would display it, the audit log would record the change — and
 * every win would silently keep paying the global rate. The stored per-tenant
 * figure has to be the one the money path consults, or it is decoration.
 */
function commissionBpsForUser(db, userId) {
  const t = ofUser(db, userId);
  if (!t) return Math.round(config.COMMISSION_RATE * 10000);
  return t.commission_bps;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch (e) {
    // A malformed config must not take the venue down; it falls back to the
    // documented default and the operator sees the default.
    return fallback;
  }
}

/**
 * Branding for the frontend. A CONFIG READ, not a build step — which is why
 * the no-build frontend survives this phase: per-tenant theming becomes
 * applying CSS custom properties from a JSON response.
 */
function branding(db, tenantId) {
  const t = byId(db, tenantId);
  const brand = parseJson(t && t.brand, {});
  return {
    name: brand.name || (t && t.name) || 'Exchange',
    logo: brand.logo || '/assets/logo.png',
    terms_url: brand.terms_url || null,
    palette: brand.palette || {},
  };
}

/** Jurisdiction allowlist. Empty means unrestricted. */
function jurisdictions(db, tenantId) {
  const t = byId(db, tenantId);
  const list = parseJson(t && t.jurisdictions, []);
  return Array.isArray(list) ? list.map((c) => String(c).toUpperCase()) : [];
}

/**
 * Is this player permitted here? Case-insensitive country comparison, and an
 * EMPTY allowlist means unrestricted — the single-operator case, where the
 * operator has not configured jurisdictions and must not be silently blocked.
 *
 * Returns null when permitted, or a reason string when not, so the caller can
 * audit exactly why a session was refused.
 */
function jurisdictionRefusal(db, tenantId, country) {
  const allowed = jurisdictions(db, tenantId);
  if (allowed.length === 0) return null;
  if (!country) return 'no-jurisdiction-supplied';
  if (!allowed.includes(String(country).toUpperCase())) return 'jurisdiction-not-allowed';
  return null;
}

/** Administrative updates. Audited: these are commercial and legal facts. */
function configure(db, { actor, tenantId, name, status, commission_bps, brand, jurisdictions: juris }) {
  const audit = require('./audit');
  const t = byId(db, tenantId);
  if (!t) {
    const err = new Error(`No such tenant: ${tenantId}`);
    err.status = 404;
    throw err;
  }
  if (status !== undefined && !['active', 'suspended'].includes(status)) {
    const err = new Error(`Unknown tenant status: ${status}`);
    err.status = 400;
    throw err;
  }
  if (commission_bps !== undefined) {
    if (!Number.isInteger(commission_bps) || commission_bps < 0 || commission_bps > 2000) {
      const err = new Error('commission_bps must be an integer in [0, 2000] (0 - 20%)');
      err.status = 400;
      throw err;
    }
  }
  // The UPDATE and the audit row that describes it are ONE transaction (#27).
  // This call previously had no wrapper at all, so a failed audit write left a
  // tenant's commission rate and status changed with nothing recording who
  // changed them. `audit.mustRecord` is what makes the wrapper real — plain
  // `audit.record` swallows its own failure and returns false, so nothing would
  // be thrown and nothing would roll back.
  return transaction(db, () => {
    db.prepare(
      `UPDATE tenants SET
         name = COALESCE(?, name),
         status = COALESCE(?, status),
         commission_bps = COALESCE(?, commission_bps),
         brand = COALESCE(?, brand),
         jurisdictions = COALESCE(?, jurisdictions)
       WHERE id = ?`
    ).run(
      name ?? null,
      status ?? null,
      commission_bps ?? null,
      brand === undefined ? null : JSON.stringify(brand),
      juris === undefined ? null : JSON.stringify(juris),
      t.id
    );
    const after = byId(db, t.id);
    audit.mustRecord(db, actor, audit.ACTIONS.TENANT_CONFIGURED, `tenant:${t.id}`,
      { status: t.status, commission_bps: t.commission_bps },
      { status: after.status, commission_bps: after.commission_bps }, null);
    return after;
  });
}

function list(db) {
  return db.prepare('SELECT * FROM tenants ORDER BY id').all();
}

/**
 * Extract a trusted country code from an inbound request.
 *
 * THE TRUST BOUNDARY, stated plainly because getting it wrong makes the whole
 * control theatre:
 *
 *   A client-supplied country is NOT a jurisdiction. `X-Jurisdiction` in a
 *   request body or query string is whatever the player typed, so reading it
 *   would mean the control can be defeated by editing one header — worse than
 *   having no control, because it would be recorded as enforced.
 *
 *   So the header is only read when TRUST_PROXY_JURISDICTION is on, which is
 *   the operator asserting that EVERY request reaching this process passed
 *   through an edge that OVERWRITES the header. lib/config.js pins HOST to
 *   loopback, so in that deployment the app is not reachable except through
 *   the proxy and the assertion holds. With the flag off, the header is
 *   ignored entirely.
 *
 * A supplied value must be a two-letter ISO code; anything else is discarded
 * rather than passed through, so a proxy misconfiguration cannot smuggle
 * arbitrary strings into the audit trail.
 */
const JURISDICTION_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'x-jurisdiction'];

function trustedCountry(req) {
  if (!config.TRUST_PROXY_JURISDICTION) return null;
  for (const h of JURISDICTION_HEADERS) {
    const raw = req.headers && req.headers[h];
    if (!raw) continue;
    const v = String(raw).trim().toUpperCase();
    // Sentinels FIRST. Several CDNs emit a two-letter 'unknown' code, and a
    // Tor exit marker from Cloudflare is 'T1'. Neither is a jurisdiction, and
    // a regex that accepted any two letters would treat them as one — a
    // country literally called XX is not a thing.
    if (v === 'XX' || v === 'T1' || v === 'ZZ') return null;
    if (!/^[A-Z]{2}$/.test(v)) return null;
    return v;
  }
  return null;
}

module.exports = {
  commissionBpsForUser,
  DEFAULT_SLUG,
  trustedCountry,
  defaultTenant,
  byId,
  bySlug,
  ofUser,
  commissionBps,
  branding,
  jurisdictions,
  jurisdictionRefusal,
  configure,
  list,
};