'use strict';
// lib/feedcreds.js — per-tenant Betfair credentials for the feed collector,
// encrypted at rest, never returned by any API.
//
// WHY THIS IS A SEPARATE MODULE. The collector is a separate program
// (OpenBettingExchangeDataFeed) that authenticates to Betfair with real
// account credentials. An operator supplies those in the admin dashboard rather
// than a .env file, so the venue has to hold them: which makes this the most
// sensitive table in the system.
//
// THE RULES, and each exists because the alternative is indefensible:
//
//   1. ENCRYPTED AT REST, ALWAYS. AES-256-GCM. If FEED_CREDENTIALS_KEY is not
//      configured the venue REFUSES to store a credential. It does not fall
//      back to plaintext, and it does not warn and continue. A Betfair
//      password sitting in a SQLite file next to player balances, readable by
//      anyone who can read the database, is not a configuration state anyone
//      should be able to reach by accident.
//   2. NO API EVER RETURNS A SECRET. `status()` reports whether a field is
//      PRESENT, never its value. There is no "show me the password" route, and
//      adding one later would be a serious mistake, so the shape of the module
//      does not permit it.
//   3. PER TENANT, AND THE TENANT IS NOT A PARAMETER. One venue, one collector,
//      one Betfair account: two tenants sharing one Betfair login would share
//      one rate limit and one blast radius. The scope is derived from the actor
//      inside this module, not taken from a route parameter — see setCredentials.
//      Each sealed field is additionally bound to its tenant and field name, so
//      a row MOVED at the database level fails to decrypt rather than becoming
//      another venue's credential — see fieldAad.
//   4. AUDITED ON EVERY WRITE, including deletion. "Who put this credential
//      here, and who took it away" is the first question asked after an
//      incident.
//
// WHAT THIS DOES NOT DO. It does not connect to Betfair. It cannot tell you
// whether a credential is valid — only the collector can, by trying it. That
// distinction matters: `validate()` below is a LOCAL check that refuses
// obviously-wrong input, not a credential test, and it is named so nobody
// mistakes one for the other.

const crypto = require('crypto');
const { httpError, serviceUnavailable } = require('./auth');
const config = require('./config');

// ── the cipher ───────────────────────────────────────────────────────────────

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

// ── associated data ───────────────────────────────────────────────────────────
//
// WHAT THE ENVELOPE IS BOUND TO. GCM authenticates the ciphertext against a
// KEY, and that is all: without additional authenticated data a ciphertext
// sealed for one slot is a valid ciphertext for any other. Concretely, before
// this, a row moved at the database level from tenant B to tenant A decrypted
// CLEANLY and was handed to tenant A's collector as though A had stored it.
//
// The route-level tenant boundary stops that being reached over HTTP. It does
// not stop a restore from a backup, a migration bug, an operator with a sqlite
// prompt, or anyone holding the database file — which is exactly the threat
// model "encrypted at rest" claims. So the envelope now names what it is: the
// tenant it belongs to, the field it fills, and a schema version. Change any of
// the three and the auth tag fails, so a swapped or repurposed row is a loud
// integrity failure rather than a silent cross-tenant disclosure.
//
// The schema version is here so a future change to the stored shape can rotate
// AAD without having to guess which rows were written under which rules.
const AAD_SCHEMA = 'feedcreds.v1';

function fieldAad(tenantId, field) {
  return `${AAD_SCHEMA}|t=${tenantId}|f=${field}`;
}

/**
 * Encrypt to a self-describing envelope: `v1:<iv>:<tag>:<ciphertext>`.
 *
 * Self-describing so a future key rotation can read an old envelope, tell that
 * it is v1, and re-encrypt — rather than a bare blob that becomes unreadable
 * the moment the format changes. GCM's auth tag is carried alongside rather
 * than appended, so a truncated or tampered row fails loudly on open instead of
 * decrypting to garbage.
 *
 * `aad` is optional so the cipher stays a standalone, testable primitive; every
 * call that stores a credential passes one (see fieldAad).
 */
function seal(key, plaintext, aad = '') {
  if (!key) throw httpError(503, 'Feed credential storage is not configured');
  if (typeof plaintext !== 'string') throw new TypeError('seal expects a string');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/**
 * Decrypt an envelope, or throw. A failed auth tag is reported as a CORRUPTION
 * error rather than a generic failure: it means the ciphertext was altered, the
 * key is wrong, or the row is not the one it was sealed for — all three are
 * worth saying plainly rather than surfacing as a null.
 */
function open(key, envelope, aad = '') {
  if (!key) throw httpError(503, 'Feed credential storage is not configured');
  if (typeof envelope !== 'string' || !envelope) return null;
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw httpError(500, 'Stored credential is in an unrecognised format and cannot be read');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    // BEFORE the tag: GCM verifies the tag over the AAD, so this is what makes
    // a row sealed for another tenant (or another field) fail to open.
    if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, the row was tampered with, or it does not belong here. All are
    // integrity failures and none should be reported as "no credential".
    throw httpError(
      500,
      'Stored credential could not be decrypted — the encryption key may have changed, ' +
        'or the stored row does not match this tenant and field'
    );
  }
}

// ── validation ───────────────────────────────────────────────────────────────

// Betfair app keys are exactly 16 characters. Checking the shape here turns a
// silent, minutes-long failure in the collector into a 400 at the point of
// entry, which is the only place anyone can act on it.
const APP_KEY_RE = /^[A-Za-z0-9]{16}$/;
const USERNAME_RE = /^[\w.@+-]{2,64}$/;

/**
 * LOCAL shape validation. This proves nothing about whether a credential works
 * — only the collector can do that, by trying it. It catches the mistakes that
 * are otherwise invisible until a background job fails hours later.
 */
function validateInput({ appKey, username, password }) {
  const app_key = String(appKey ?? '').trim();
  const betfair_username = String(username ?? '').trim();
  // A password is whatever the operator says it is: no trimming, no charset
  // policy. Same rule as user passwords, for the same reason.
  const betfair_password = typeof password === 'string' ? password : '';
  if (!APP_KEY_RE.test(app_key)) {
    throw httpError(400, 'app_key must be Betfair\'s 16-character application key');
  }
  if (!USERNAME_RE.test(betfair_username)) {
    throw httpError(400, 'username looks wrong (2-64 characters, letters/digits/._@+-)');
  }
  if (!betfair_password) {
    throw httpError(400, 'password is required');
  }
  return { app_key, betfair_username, betfair_password };
}

// ── storage ──────────────────────────────────────────────────────────────────

const FIELDS = ['app_key', 'username', 'password'];

function rowFor(db, tenantId) {
  return db.prepare('SELECT * FROM feed_credentials WHERE tenant_id = ?').get(tenantId) || null;
}

function requireKey() {
  if (!config.FEED_CREDENTIALS_KEY) {
    // serviceUnavailable, not httpError(503, ...): the difference is `expose`,
    // which is what lets this status and this message — written for the
    // operator, and containing the exact command that fixes it — reach the
    // caller. `httpError(503, ...)` was clamped to `500 Internal error` by the
    // error handler, so the remediation was logged and never delivered.
    throw serviceUnavailable(
      'Feed credential storage is not configured: set FEED_CREDENTIALS_KEY (openssl rand -hex 32). ' +
        'Credentials are refused rather than stored in plaintext.'
    );
  }
  return config.FEED_CREDENTIALS_KEY;
}

/**
 * Store (or replace) a tenant's credentials. Each field is sealed separately so
 * a rotation of one does not require re-supplying the others, and so the stored
 * rows carry no shape information about which fields are set.
 *
 * ── THE TENANT IS DERIVED FROM THE ACTOR, NOT PASSED IN ──────────────────────
 * `tenantId` used to be a plain parameter checked only for existence, and the
 * route filled it from `:id` / `body.tenant_id` / `?tenant_id=`. requireAdmin
 * checks only `role === 'admin'`, so ANY admin could overwrite ANY tenant's
 * Betfair credentials — and then start that tenant's collector, publishing
 * prices derived from an account they control — or delete them and stop its
 * collector outright. That is a cross-tenant write and a denial of service on
 * another venue's odds feed, with an audit row naming the attacker as the actor.
 *
 * The scope is now structural rather than advisory, the same shape lib/admin.js
 * uses for listUsers: the tenant comes from `TEN.ofUser(db, actor.id)`, and a
 * `tenantId` that disagrees is REFUSED rather than obeyed. An implicit
 * `?tenant_id=` override is not a capability; if cross-tenant administration is
 * ever genuinely needed it needs an explicit role and a separate route, not a
 * query parameter any admin can append.
 */
function setCredentials(db, { actor, tenantId, appKey, username, password }) {
  // ORDER: the tenant is resolved FIRST, then the key is required.
  //
  // It used to be the other way round, so with FEED_CREDENTIALS_KEY unset
  // `requireKey()` threw before the tenant was ever looked up and the 404
  // branch below was unreachable. The sibling `clearCredentials` has always
  // answered `404 No such tenant: 999` for an unknown id, so the two halves of
  // one API disagreed about the same request depending on which half you
  // called.
  //
  // The order is also the more intuitive contract: *who* you are asking about,
  // before *whether the venue is configured* to answer. An unknown tenant is a
  // fact about the request that holds regardless of server configuration, so it
  // should not be masked by one.
  const tenant = actorTenant(db, actor, tenantId);
  const key = requireKey();

  const clean = validateInput({ appKey, username, password });
  const audit = require('./audit');
  const before = rowFor(db, tenant.id);

  const sealed = {
    app_key: seal(key, clean.app_key, fieldAad(tenant.id, 'app_key')),
    username: seal(key, clean.betfair_username, fieldAad(tenant.id, 'username')),
    password: seal(key, clean.betfair_password, fieldAad(tenant.id, 'password')),
  };

  db.prepare(
    `INSERT INTO feed_credentials
       (tenant_id, app_key, username, password, login_mode, created_by, updated_by)
     VALUES (?, ?, ?, ?, 'password', ?, ?)
     ON CONFLICT (tenant_id) DO UPDATE SET
       app_key    = EXCLUDED.app_key,
       username   = EXCLUDED.username,
       password   = EXCLUDED.password,
       login_mode = EXCLUDED.login_mode,
       updated_by = EXCLUDED.updated_by,
       updated_at = datetime('now')`
  ).run(tenant.id, sealed.app_key, sealed.username, sealed.password, actor.id, actor.id);

  audit.record(db, actor, audit.ACTIONS.TENANT_CONFIGURED, `tenant:${tenant.id}/feed_credentials`, before ? maskRow(before) : null, maskRow(sealed));
  return status(db, tenant.id);
}

/** Delete a tenant's credentials. Audited — removal is an event, not an absence. */
function clearCredentials(db, { actor, tenantId }) {
  const tenant = actorTenant(db, actor, tenantId);
  const before = rowFor(db, tenant.id);
  if (!before) throw httpError(404, 'No feed credentials stored for this tenant');
  const audit = require('./audit');
  db.prepare('DELETE FROM feed_credentials WHERE tenant_id = ?').run(tenant.id);
  audit.record(db, actor, audit.ACTIONS.TENANT_CONFIGURED, `tenant:${tenant.id}/feed_credentials`, maskRow(before), null);
  return { cleared: true };
}

/**
 * The tenant an actor may act on: theirs, and only theirs.
 *
 * The existence check runs FIRST so an unknown tenant is still a 404 rather
 * than a 403 — the more accurate answer, and one that does not tell a caller
 * probing ids which of them exist.
 */
function actorTenant(db, actor, asked) {
  const TEN = require('./tenants');
  if (asked !== undefined && asked !== null && asked !== '' && !TEN.byId(db, Number(asked))) {
    throw httpError(404, `No such tenant: ${asked}`);
  }
  const own = actor && actor.id !== undefined && actor.id !== null ? TEN.ofUser(db, actor.id) : null;
  if (!own) {
    throw httpError(403, 'Your account does not belong to a tenant, so it cannot administer feed credentials');
  }
  if (asked !== undefined && asked !== null && asked !== '' && Number(asked) !== own.id) {
    throw httpError(
      403,
      `Feed credentials belong to a tenant: you may only administer ${own.slug}'s. ` +
        'Cross-tenant administration is not available on this role.'
    );
  }
  return own;
}

/**
 * What an operator is allowed to see: WHICH fields are present, never their
 * values. `app_key_set` is a boolean on purpose — the key itself is half of a
 * credential pair and must not be echoed back into a browser.
 */
function status(db, tenantId) {
  const row = rowFor(db, tenantId);
  if (!row) {
    return { tenant_id: tenantId, configured: false, storage_available: !!config.FEED_CREDENTIALS_KEY };
  }
  return {
    tenant_id: tenantId,
    configured: true,
    storage_available: !!config.FEED_CREDENTIALS_KEY,
    login_mode: row.login_mode,
    app_key_set: !!row.app_key,
    username_set: !!row.username,
    password_set: !!row.password,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Deliberately NOT the actor ids or usernames: knowing who set a
    // credential is audit-trail information, not dashboard information.
  };
}

/**
 * The DECRYPTED credential, for handing to the collector process.
 *
 * This is the ONLY function that returns plaintext, and it is the only thing
 * that should ever call it. The collector is a child process; its environment
 * is built here and nowhere else. Callers must not log the result.
 *
 * Each field is opened with the AAD it was sealed with, so a row moved to
 * another tenant at the database level fails the auth tag instead of decrypting
 * cleanly as somebody else's credential.
 */
function forCollector(db, tenantId) {
  const key = requireKey();
  const row = rowFor(db, tenantId);
  if (!row) return null;
  return {
    BETFAIR_LOGIN_MODE: row.login_mode || 'password',
    BETFAIR_APP_KEY: open(key, row.app_key, fieldAad(row.tenant_id, 'app_key')),
    BETFAIR_USERNAME: open(key, row.username, fieldAad(row.tenant_id, 'username')),
    BETFAIR_PASSWORD: open(key, row.password, fieldAad(row.tenant_id, 'password')),
  };
}

/** Everything the collector needs to run, including the database URL. */
function collectorEnv(db, tenantId, extra = {}) {
  const creds = forCollector(db, tenantId);
  if (!creds) return null;
  return {
    ...creds,
    DATABASE_URL: config.FEED_DATABASE_URL,
    LOG_LEVEL: process.env.LOG_LEVEL || 'INFO',
    ...extra,
  };
}

/** `present` markers for audit rows: which fields existed, never their values. */
function maskRow(row) {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    login_mode: row.login_mode,
    app_key: row.app_key ? '[sealed]' : null,
    username: row.username ? '[sealed]' : null,
    password: row.password ? '[sealed]' : null,
  };
}

module.exports = {
  seal,
  open,
  fieldAad,
  validateInput,
  setCredentials,
  clearCredentials,
  status,
  forCollector,
  collectorEnv,
  FIELDS,
};