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
//   3. PER TENANT. One venue, one collector, one Betfair account. Two tenants
//      sharing one Betfair login would share one rate limit and one blast
//      radius.
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
const { httpError } = require('./auth');
const config = require('./config');

// ── the cipher ───────────────────────────────────────────────────────────────

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

/**
 * Encrypt to a self-describing envelope: `v1:<iv>:<tag>:<ciphertext>`.
 *
 * Self-describing so a future key rotation can read an old envelope, tell that
 * it is v1, and re-encrypt — rather than a bare blob that becomes unreadable
 * the moment the format changes. GCM's auth tag is carried alongside rather
 * than appended, so a truncated or tampered row fails loudly on open instead of
 * decrypting to garbage.
 */
function seal(key, plaintext) {
  if (!key) throw httpError(503, 'Feed credential storage is not configured');
  if (typeof plaintext !== 'string') throw new TypeError('seal expects a string');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/**
 * Decrypt an envelope, or throw. A failed auth tag is reported as a CORRUPTION
 * error rather than a generic failure: it means the ciphertext was altered, or
 * the key is wrong, and both are worth saying plainly rather than surfacing as
 * a null.
 */
function open(key, envelope) {
  if (!key) throw httpError(503, 'Feed credential storage is not configured');
  if (typeof envelope !== 'string' || !envelope) return null;
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw httpError(500, 'Stored credential is in an unrecognised format and cannot be read');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, or the row was tampered with. Both are integrity failures and
    // neither should be reported as "no credential".
    throw httpError(500, 'Stored credential could not be decrypted — the encryption key may have changed');
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
    throw httpError(
      503,
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
 */
function setCredentials(db, { actor, tenantId, appKey, username, password }) {
  const key = requireKey();
  const TEN = require('./tenants');
  const tenant = TEN.byId(db, tenantId);
  if (!tenant) throw httpError(404, `No such tenant: ${tenantId}`);

  const clean = validateInput({ appKey, username, password });
  const audit = require('./audit');
  const before = rowFor(db, tenantId);

  const sealed = {
    app_key: seal(key, clean.app_key),
    username: seal(key, clean.betfair_username),
    password: seal(key, clean.betfair_password),
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
  ).run(tenantId, sealed.app_key, sealed.username, sealed.password, actor.id, actor.id);

  audit.record(db, actor, audit.ACTIONS.TENANT_CONFIGURED, `tenant:${tenantId}/feed_credentials`, before ? maskRow(before) : null, maskRow(sealed));
  return status(db, tenantId);
}

/** Delete a tenant's credentials. Audited — removal is an event, not an absence. */
function clearCredentials(db, { actor, tenantId }) {
  const TEN = require('./tenants');
  if (!TEN.byId(db, tenantId)) throw httpError(404, `No such tenant: ${tenantId}`);
  const before = rowFor(db, tenantId);
  if (!before) throw httpError(404, 'No feed credentials stored for this tenant');
  const audit = require('./audit');
  db.prepare('DELETE FROM feed_credentials WHERE tenant_id = ?').run(tenantId);
  audit.record(db, actor, audit.ACTIONS.TENANT_CONFIGURED, `tenant:${tenantId}/feed_credentials`, maskRow(before), null);
  return { cleared: true };
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

/** Every tenant's feed status, for the admin list. Still no secrets. */
function statusAll(db) {
  const TEN = require('./tenants');
  return TEN.list(db).map((t) => status(db, t.id));
}

/**
 * The DECRYPTED credential, for handing to the collector process.
 *
 * This is the ONLY function that returns plaintext, and it is the only thing
 * that should ever call it. The collector is a child process; its environment
 * is built here and nowhere else. Callers must not log the result.
 */
function forCollector(db, tenantId) {
  const key = requireKey();
  const row = rowFor(db, tenantId);
  if (!row) return null;
  return {
    BETFAIR_LOGIN_MODE: row.login_mode || 'password',
    BETFAIR_APP_KEY: open(key, row.app_key),
    BETFAIR_USERNAME: open(key, row.username),
    BETFAIR_PASSWORD: open(key, row.password),
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
  validateInput,
  setCredentials,
  clearCredentials,
  status,
  statusAll,
  forCollector,
  collectorEnv,
  FIELDS,
};