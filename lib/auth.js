'use strict';
// lib/auth.js — scrypt password hashing + opaque DB session tokens.
// Users never leave this module with a pass_hash. Errors carry a .status
// property for the server's error handler.
const crypto = require('node:crypto');
const config = require('./config');

// scrypt with per-hash random salt, and the cost parameters recorded IN the
// stored hash, so the strength of any individual password can be raised later
// without invalidating anything:
//
//   scrypt$<N>$<salt hex>$<hash hex>      current format
//   scrypt$<salt hex>$<hash hex>          legacy (N=16384), still verified
//
// The legacy form carries no N, which is precisely why it is readable at all:
// it is assumed to be LEGACY_SCRYPT_N and is re-hashed to SCRYPT_N on the
// account's next successful login. That is the whole point — a parameter bump
// is a one-line change here and touches no stored data.
const LEGACY_SCRYPT_N = 16384;
// OWASP's recommended floor for scrypt password storage. The cost is real and
// deliberate — roughly 160ms per login against 40ms at N=16384. That is the
// price of not being trivially crackable if the database is ever separated
// from the passphrase. 128*N*r bytes are needed, plus Node's own working
// overhead, which is why maxmem is generous: it is a ceiling the allocator is
// refused past, not an amount it eagerly takes.
const SCRYPT_N = config.SCRYPT_N;
const SCRYPT_PARAMS = { N: SCRYPT_N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEYLEN = 64;

const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

function httpError(status, message, details) {
  const e = new Error(message);
  e.status = status;
  // Optional structured context for the CLIENT (e.g. which cap was breached
  // and what it is). Only ever surfaced on a 4xx by the error handler: a 5xx
  // returns a generic message, and internals must never reach the browser.
  if (details && typeof details === 'object') e.details = details;
  return e;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Parses either stored form into { N, saltHex, hashHex }. Returns null for
// anything unrecognised, which the caller treats as "does not verify".
function parseStored(stored) {
  const parts = String(stored).split('$');
  if (parts[0] !== 'scrypt') return null;
  if (parts.length === 4) {
    const n = Number(parts[1]);
    if (!Number.isSafeInteger(n) || n < 2) return null;
    return { N: n, saltHex: parts[2], hashHex: parts[3] };
  }
  if (parts.length === 3) return { N: LEGACY_SCRYPT_N, saltHex: parts[1], hashHex: parts[2] };
  return null;
}

// Verify against the parameters the hash was ACTUALLY created with, not the
// current ones — verifying a legacy hash at the new cost would simply fail.
function verifyPassword(password, stored) {
  try {
    const parsed = parseStored(stored);
    if (!parsed || !parsed.saltHex || !parsed.hashHex) return false;
    const hash = crypto.scryptSync(String(password), Buffer.from(parsed.saltHex, 'hex'), KEYLEN, {
      N: parsed.N, r: 8, p: 1, maxmem: SCRYPT_PARAMS.maxmem,
    });
    const expected = Buffer.from(parsed.hashHex, 'hex');
    // Length check first: timingSafeEqual throws on a length mismatch, and a
    // throw here would become a false "wrong password".
    if (hash.length !== expected.length) return false;
    return crypto.timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

// True when a hash predates the current cost, i.e. it is worth re-deriving at
// SCRYPT_N the next time its owner proves the password.
function needsRehash(stored) {
  const parsed = parseStored(stored);
  return !parsed || parsed.N !== SCRYPT_N;
}

// Shape returned to the browser — NEVER includes pass_hash.
function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email ?? null,
    // role is the authoritative privilege flag; is_admin is reported alongside
    // it only so older clients that branch on it keep working until they are
    // updated. New code must read role.
    role: row.role || (row.is_admin ? 'admin' : 'user'),
    is_admin: !!(row.role === 'admin' || row.is_admin),
    is_bot: !!row.is_bot,
    status: row.status || 'active',
    balance_cents: row.balance_cents,
    frozen_cents: row.frozen_cents,
  };
}

function validateCredentials(username, password) {
  if (!USERNAME_RE.test(String(username || ''))) {
    throw httpError(400, 'Username must be 3-32 chars (letters, digits, _ or -)');
  }
  const pw = String(password || '');
  if (pw.length < 6 || pw.length > 128) {
    throw httpError(400, 'Password must be 6-128 chars');
  }
}

// Deliberately permissive: one @, a non-empty local part, a dotted domain, no
// spaces. This is an identity uniqueness key, not a deliverability check —
// nothing in this codebase sends mail yet, so rejecting unusual-but-legal
// addresses would cost more than it protects.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// Returns null for an absent/empty value (most accounts have no address), the
// trimmed value otherwise. Lowercased so 'A@B.com' and 'a@b.com' are one
// identity — email local-parts are technically case-sensitive, but no real
// provider treats them that way and treating them as distinct would let one
// person hold two accounts.
function normalizeEmail(email) {
  if (email === undefined || email === null) return null;
  const s = String(email).trim();
  if (!s) return null;
  if (!EMAIL_RE.test(s)) throw httpError(400, 'Enter a valid email address');
  return s.toLowerCase();
}

// ── Account creation ───────────────────────────────────────────────────────
// Two tiers, deliberately split:
//
//   createAccount(db, opts) — internal factory and the ONLY place account
//     privileges are granted (is_admin, is_bot, opening balance). Trusted
//     callers only: lib/seed.js's first-run demo accounts and the test
//     suite. Runs inside the caller's transaction when one is open (single
//     synchronous connection); it never begins or commits one itself.
//
//   registerUser(db, opts)  — the public /api/auth/register path. It CANNOT
//     mint an admin: the is_admin flag is refused outright. The balance_cents
//     and is_bot options remain supported for in-repo callers that predate
//     the split — the engine's test suites fund wallets with balance_cents
//     and lib/bots.js marks the house counterparty bot with is_bot — but
//     neither is reachable from the HTTP route, which passes only
//     {username, password} through.
function createAccount(db, { username, password, email, role, is_admin = 0, is_bot = 0, balance_cents = 0 }) {
  validateCredentials(username, password);
  // Money boundary: integer cents, never negative. A fractional or negative
  // opening balance would break the settlement conservation invariant.
  const start = Number(balance_cents);
  if (!Number.isSafeInteger(start) || start < 0) {
    throw httpError(400, 'Opening balance must be a non-negative integer number of cents');
  }
  const name = String(username).trim();
  const mail = normalizeEmail(email);
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (exists) throw httpError(409, 'Username already taken');
  // The partial unique index on users(email) is the real guarantee; this check
  // exists only to turn a constraint violation into the same 409 shape the
  // username collision uses, instead of an opaque SQLITE_CONSTRAINT.
  if (mail && db.prepare('SELECT id FROM users WHERE email = ?').get(mail)) {
    throw httpError(409, 'Email already registered');
  }
  // role is authoritative and stays in the row as the legacy mirror so code
  // that has not been migrated yet keeps reading a correct value.
  //
  // `is_admin` is honoured as an INPUT as well, because existing callers
  // (lib/seed.js, the test suites) still mint privileged accounts that way.
  // Honouring it here is what keeps those callers correct without forcing
  // every one of them to change in the same commit.
  const effRole = (role === 'admin' || is_admin) ? 'admin' : 'user';
  const info = db
    .prepare(
      `INSERT INTO users
         (username, email, pass_hash, role, is_admin, is_bot, balance_cents, password_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      mail || null,
      hashPassword(password),
      effRole,
      effRole === 'admin' ? 1 : 0,
      is_bot ? 1 : 0,
      start,
      new Date().toISOString().replace('T', ' ').slice(0, 19)
    );
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  return sanitizeUser(row);
}

function registerUser(db, opts) {
  const { username, password, email, balance_cents = 0, is_bot = 0 } = opts || {};
  if (opts && opts.is_admin) {
    throw httpError(400, 'Admin accounts cannot be created through registerUser');
  }
  // Same discipline one tier up: role, like is_admin, is granted only by the
  // internal factory. The HTTP route cannot reach either.
  if (opts && opts.role) {
    throw httpError(400, 'Roles cannot be assigned through registerUser');
  }
  return createAccount(db, { username, password, email, is_bot, balance_cents });
}

// Session tokens are stored as SHA-256 digests, never as the token itself:
// a leaked database file must not contain reusable bearer credentials. Every
// lookup hashes the presented token first, so a digest match is a 256-bit
// preimage problem — no constant-time comparison is needed at the SQL
// boundary (finding the row already proves possession of the token).
// Existing sessions are invalidated once by this change: their stored
// plaintext no longer matches any digest. Acceptable for the demo.
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.SESSION_TTL_DAYS * 86400 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, expires);
  return token;
}

function sessionUser(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    )
    .get(hashToken(token));
  return sanitizeUser(row);
}

function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(hashToken(token));
}

// A fixed dummy hash (salt+hash of a random value) is verified when the
// username does not exist, so a missing user costs the same scrypt work as a
// wrong password and cannot be told apart by timing. Precomputed at module
// load — not lazily — so the very first probe costs the same as every later
// one and no first-request timing difference exists at all.
const dummyHash = hashPassword('dummy-password-for-constant-work');
function dummyVerify() {
  verifyPassword('not-the-password', dummyHash);
}

// Accepts EITHER identifier: the username as typed (case-sensitive, since
// usernames are not normalized) or the email, which is matched lowercased
// because that is how it is stored. `identifier` is an explicit alias so a
// client can be unambiguous about what it is sending.
function loginUser(db, { username, email, identifier, password } = {}) {
  const ident = String(identifier ?? username ?? email ?? '').trim();
  const row = db
    .prepare(
      `SELECT * FROM users
        WHERE username = ? OR (email IS NOT NULL AND email = ?)
        LIMIT 1`
    )
    .get(ident, ident.toLowerCase());
  if (!row) {
    dummyVerify();
    throw httpError(401, 'Invalid username or password');
  }
  if (!verifyPassword(password, row.pass_hash)) {
    throw httpError(401, 'Invalid username or password');
  }
  if (row.is_bot) {
    dummyVerify();
    throw httpError(401, 'Invalid username or password');
  }
  // Deliberately AFTER the password check. Refusing a suspended account before
  // verifying would turn the endpoint into a probe for which usernames exist,
  // and would let anyone learn an account was suspended without ever knowing
  // its password.
  if (row.status && row.status !== 'active') {
    throw httpError(403, 'Account is suspended');
  }
  const token = createSession(db, row.id);
  // Rehash-on-login. The password was just proven, so this is the only moment
  // the plaintext is available to re-derive a stronger hash from. Doing it here
  // rather than in a migration is what lets the cost parameter rise without
  // anyone being locked out: accounts migrate as their owners next sign in.
  //
  // A rejected write is NOT fatal — the login itself has already succeeded and
  // the old hash still verifies, so the account simply migrates next time.
  if (needsRehash(row.pass_hash)) {
    try {
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), row.id);
    } catch (e) {
      console.warn('[auth] rehash failed for user', row.id, '->', e.message);
    }
  }
  return { user: sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id)), token };
}

// Password change. Requires the CURRENT password so a stolen session cookie
// alone cannot lock the real owner out, and revokes every other session for
// the account — a password change is the standard response to a suspected
// compromise, and it is useless if the attacker's sessions survive it.
//
// Returns the new token so the caller can keep the CURRENT session alive and
// the caller does not have to re-authenticate.
function changePassword(db, { userId, currentPassword, newPassword, keepToken }) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw httpError(404, 'Account not found');
  if (!verifyPassword(currentPassword, row.pass_hash)) {
    dummyVerify();
    throw httpError(401, 'Current password is incorrect');
  }
  const pw = String(newPassword || '');
  if (pw.length < 6 || pw.length > 128) {
    throw httpError(400, 'Password must be 6-128 chars');
  }
  if (verifyPassword(pw, row.pass_hash)) {
    throw httpError(400, 'New password must be different from the current one');
  }
  db.prepare('UPDATE users SET pass_hash = ?, password_changed_at = ? WHERE id = ?').run(
    hashPassword(pw),
    new Date().toISOString().replace('T', ' ').slice(0, 19),
    userId
  );
  // Everything except the caller's own session is invalidated.
  const all = db.prepare('SELECT token FROM sessions WHERE user_id = ?').all(userId);
  const keep = keepToken ? hashToken(keepToken) : null;
  for (const s of all) {
    if (keep && s.token === keep) continue;
    db.prepare('DELETE FROM sessions WHERE token = ?').run(s.token);
  }
  return { sessionsRevoked: all.length - (keep ? 1 : 0) };
}

// Session management. Tokens are never returned — only a stable digest prefix
// so the UI can tell sessions apart, plus created/expiry and whether the row
// is the caller's current one.
function listSessions(db, userId, currentToken) {
  const currentDigest = currentToken ? hashToken(currentToken) : null;
  return db
    .prepare('SELECT token, created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
    .map((s) => ({
      id: s.token.slice(0, 12),
      created_at: s.created_at,
      expires_at: s.expires_at,
      current: currentDigest !== null && s.token === currentDigest,
    }));
}

// Revoke one session. Scoped by user_id in the WHERE clause so a guessed id
// can never reach another account's session row.
function revokeSession(db, userId, sessionId) {
  const info = db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND token LIKE ?')
    .run(userId, String(sessionId || '').slice(0, 12) + '%');
  if (!info.changes) throw httpError(404, 'Session not found');
  return { revoked: true };
}

module.exports = {
  httpError,
  hashPassword,
  verifyPassword,
  needsRehash,
  parseStored,
  hashToken,
  normalizeEmail,
  registerUser,
  createAccount,
  createSession,
  sessionUser,
  destroySession,
  loginUser,
  changePassword,
  listSessions,
  revokeSession,
};
