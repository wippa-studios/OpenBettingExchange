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

// crypto.scrypt's callback form hands the KDF to libuv's threadpool, so the
// event loop keeps serving the board, the SSE stream and every other in-flight
// request for the whole ~42ms (N=16384) or ~160ms (the OWASP default) the
// derivation takes. The synchronous form this replaced froze ALL of them: one
// login stalled every concurrent request on the process.
//
// THE PARAMETERS ARE UNCHANGED — same N, r, p, maxmem and keylen. Only the
// calling convention moved. Every hash already on disk verifies exactly as
// before and nothing migrates.
function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, KEYLEN, params, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_PARAMS);
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
async function verifyPassword(password, stored) {
  try {
    const parsed = parseStored(stored);
    if (!parsed || !parsed.saltHex || !parsed.hashHex) return false;
    const hash = await scrypt(password, Buffer.from(parsed.saltHex, 'hex'), {
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
    // Exposed to the client so the UI can route the account straight to the
    // password panel instead of letting them discover the lock by clicking.
    must_change_password: !!(row.must_change_password || row.must_change_password === 1),
    balance_cents: row.balance_cents,
    frozen_cents: row.frozen_cents,
  };
}

function validateCredentials(username, password) {
  if (!USERNAME_RE.test(String(username || ''))) {
    throw httpError(400, 'Username must be 3-32 chars (letters, digits, _ or -)');
  }
  // TYPE, not just content. `String(password)` before this check meant
  // `["secret"]` and `[["secret"]]` hashed as `"secret"` — Array.prototype
  // .toString() recurses through single-element arrays — so a JSON body could
  // authenticate with a password the client never sent as a string, and
  // register an account whose real secret differs from anything transmitted.
  // Measured: `{"username":"admin","password":["…"]}` returned a full admin
  // session. It is not a takeover (the plaintext is still required), but it
  // breaks the invariant that a password is a string, and any layer that
  // inspects `typeof` — a WAF, a rate limiter, an audit log — now disagrees
  // with what scrypt hashed.
  if (typeof password !== 'string') {
    throw httpError(400, 'Password must be a string');
  }
  const pw = password;
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
//     suite. ASYNC, because it derives the password hash off the event loop.
//     Runs inside the caller's transaction when one is open (single
//     synchronous connection); it never begins or commits one itself.
//
//   createAccountSync(db, opts) — the same factory with the hash ALREADY
//     derived, for the one caller that cannot await: lib/seed.js wraps the
//     entire catalogue in a single transaction(). See the note below.
//
//   registerUser(db, opts)  — the public /api/auth/register path. It CANNOT
//     mint an admin: the is_admin flag is refused outright. The balance_cents
//     and is_bot options remain supported for in-repo callers that predate
//     the split — the engine's test suites fund wallets with balance_cents
//     and lib/bots.js marks the house counterparty bot with is_bot — but
//     neither is reachable from the HTTP route, which passes only
//     {username, password} through.
//
// WHY THE SYNC CORE EXISTS, and the rule that makes it safe.
//
// lib/tx.js's transaction() is synchronous: it runs `const out = fn()` and then
// immediately COMMITs. Hand it an async function and it commits BEFORE the
// promise settles — the transaction ends early and every write after the first
// await runs outside it. So an `await` must never appear between BEGIN and
// COMMIT, anywhere in this codebase.
//
// The rule this module follows, and the reason a sync core is safe here: the
// password hash is ALWAYS derived before any transaction is opened.
// createAccount derives it first and only then calls createAccountSync, which
// is the sole thing that touches the database. lib/seed.js derives all three
// of its hashes before it opens its transaction and passes them in. Seed is the
// only caller in this repository that opens a transaction around an auth call,
// and it uses the sync core for exactly that reason.
function createAccountSync(db, { username, password, email, role, is_admin = 0, is_bot = 0, balance_cents = 0, passHash }) {
  validateCredentials(username, password);
  if (typeof passHash !== 'string' || !passHash) {
    throw new Error('createAccountSync requires a precomputed passHash — call createAccount() instead');
  }
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
      passHash,
      effRole,
      effRole === 'admin' ? 1 : 0,
      is_bot ? 1 : 0,
      start,
      new Date().toISOString().replace('T', ' ').slice(0, 19)
    );
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

  // Phase 3: an opening balance is money, so it posts like any other money —
  // and it gets its OWN transaction type rather than being recorded as a
  // deposit. Without this every seeded and test account would carry a
  // non-zero balance_cents with no player_funds postings behind it, and the
  // cache-agreement check would fail on the first row of every seed.
  //
  // 'opening' rather than 'deposit' because it is a distinct event with
  // distinct meaning: an account funded at creation is not a player payment.
  // Keeping it separate is what lets every other transaction type keep
  // meaning exactly what it meant before.
  //
  // lib/accounts.js is required LAZILY because it requires this module for
  // httpError — a top-level require here would be a cycle. Same escape hatch
  // store.js and limits.js use for the same reason.
  if (start !== 0) {
    const { transaction, inTransaction } = require('./tx');
    const accounts = require('./accounts');
    const userId = Number(info.lastInsertRowid);
    const fund = () => {
      const txId = Number(
        db
          .prepare(
            `INSERT INTO transactions (user_id, type, amount_cents, balance_after, frozen_after)
             VALUES (?, 'opening', ?, ?, 0)`
          )
          .run(userId, start, start).lastInsertRowid
      );
      accounts.postTransfer(db, {
        transaction_id: txId,
        from: accounts.accountId(db, 'gateway_clearing', null),
        to: accounts.accountId(db, 'player_funds', userId),
        deltaCents: start,
        memo: 'opening balance',
      });
    };
    // Respect a transaction the caller already holds. lib/seed.js opens one
    // with a raw BEGIN (it also writes the seeded flag in the same unit of
    // work), which tx.js cannot see, so BEGIN would fail with "cannot start a
    // transaction within a transaction" — and worse, a COMMIT here would end
    // the seed's transaction early.
    if (inTransaction(db)) fund();
    else transaction(db, fund);
  }

  return sanitizeUser(row);
}

// The async factory: validate cheaply FIRST, then derive the hash off the event
// loop, and only then touch the database.
//
// Validating before hashing is deliberate, not incidental. A malformed request
// (two-character username, non-string password) would otherwise cost a full
// key derivation before being told it was invalid — an unauthenticated way to
// make the server spend CPU. createAccountSync re-validates, which is cheap
// and keeps the invariant true regardless of which tier is called.
async function createAccount(db, opts) {
  const { username, password, passHash } = opts || {};
  validateCredentials(username, password);
  const hash = passHash || (await hashPassword(password));
  return createAccountSync(db, { ...opts, passHash: hash });
}

async function registerUser(db, opts) {
  const { username, password, email, balance_cents = 0, is_bot = 0 } = opts || {};
  if (opts && opts.is_admin) {
    throw httpError(400, 'Admin accounts cannot be created through registerUser');
  }
  // Same discipline one tier up: role, like is_admin, is granted only by the
  // internal factory. The HTTP route cannot reach either.
  if (opts && opts.role) {
    throw httpError(400, 'Roles cannot be assigned through registerUser');
  }
  // Rebuilt field by field, never spread: `passHash` is dropped here, so the
  // internal factory's precomputed-hash seam cannot be reached from the HTTP
  // registration path even by a caller that puts it in the body.
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

/**
 * Create a session, gated on the tenant's jurisdiction allowlist.
 *
 * GATED HERE, NOT AT BET PLACEMENT. A blocked player must never hold a live
 * position: once they have one, refusing to serve them leaves the venue
 * choosing which side of a matched bet to honour. Refusing at login means they
 * simply never get one. See lib/tenants.js for the full argument.
 *
 * An EMPTY allowlist is unrestricted, which is the single-operator case — an
 * operator who has not configured jurisdictions must not be silently locked
 * out of their own venue.
 */
function createSession(db, userId, { country } = {}) {
  const tenants = require('./tenants');
  const refusal = tenants.jurisdictionRefusal(db, tenants.ofUser(db, userId)?.id, country);
  if (refusal) {
    // Distinct messages: "not supplied" is fixable by the client sending the
    // header, "not allowed" is not. Conflating them produces support tickets
    // for a problem the player cannot solve.
    throw httpError(
      403,
      refusal === 'no-jurisdiction-supplied'
        ? 'Could not determine your jurisdiction'
        : 'This service is not available in your jurisdiction',
      { code: refusal }
    );
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.SESSION_TTL_DAYS * 86400 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const tenant = tenants.ofUser(db, userId);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, tenant_id) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    expires,
    tenant ? tenant.id : null
  );
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
// wrong password and cannot be told apart by timing. Derived at module load —
// not lazily — so the very first probe costs the same as every later one and no
// first-request timing difference exists at all. It is a PROMISE now: the work
// starts at load and resolves off the event loop, so the first unknown-username
// login still pays full scrypt cost rather than racing an unwarmed cache.
const dummyHash = hashPassword('dummy-password-for-constant-work');
async function dummyVerify() {
  await verifyPassword('not-the-password', await dummyHash);
}

// Accepts EITHER identifier: the username as typed (case-sensitive, since
// usernames are not normalized) or the email, which is matched lowercased
// because that is how it is stored. `identifier` is an explicit alias so a
// client can be unambiguous about what it is sending.
async function loginUser(db, { username, email, identifier, password, country } = {}) {
  const ident = String(identifier ?? username ?? email ?? '').trim();
  const row = db
    .prepare(
      `SELECT * FROM users
        WHERE username = ? OR (email IS NOT NULL AND email = ?)
        LIMIT 1`
    )
    .get(ident, ident.toLowerCase());
  if (!row) {
    await dummyVerify();
    throw httpError(401, 'Invalid username or password');
  }
  if (!(await verifyPassword(password, row.pass_hash))) {
    throw httpError(401, 'Invalid username or password');
  }
  if (row.is_bot) {
    await dummyVerify();
    throw httpError(401, 'Invalid username or password');
  }
  // Deliberately AFTER the password check. Refusing a suspended account before
  // verifying would turn the endpoint into a probe for which usernames exist,
  // and would let anyone learn an account was suspended without ever knowing
  // its password.
  if (row.status && row.status !== 'active') {
    throw httpError(403, 'Account is suspended');
  }
  // `country` comes from the trusted source resolved by the caller, never from
  // the request body — a client-declared country is not a jurisdiction.
  const token = createSession(db, row.id, { country });
  // Rehash-on-login. The password was just proven, so this is the only moment
  // the plaintext is available to re-derive a stronger hash from. Doing it here
  // rather than in a migration is what lets the cost parameter rise without
  // anyone being locked out: accounts migrate as their owners next sign in.
  //
  // A rejected write is NOT fatal — the login itself has already succeeded and
  // the old hash still verifies, so the account simply migrates next time.
  if (needsRehash(row.pass_hash)) {
    try {
      const stronger = await hashPassword(password);
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(stronger, row.id);
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
async function changePassword(db, { userId, currentPassword, newPassword, keepToken }) {
  // Same type rule as registration, enforced here too: this route is not
  // behind validateCredentials, so without it a client could set an account's
  // password to a coerced non-string form.
  if (typeof newPassword !== 'string') {
    throw httpError(400, 'Password must be a string');
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw httpError(404, 'Account not found');
  if (!(await verifyPassword(currentPassword, row.pass_hash))) {
    await dummyVerify();
    throw httpError(401, 'Current password is incorrect');
  }
  const pw = String(newPassword || '');
  if (pw.length < 6 || pw.length > 128) {
    throw httpError(400, 'Password must be 6-128 chars');
  }
  if (await verifyPassword(pw, row.pass_hash)) {
    throw httpError(400, 'New password must be different from the current one');
  }
  // The password is replaced here, so the first-run lock is released HERE and
  // nowhere else — there is no other path that could leave the flag set against
  // a changed password, which is the failure that would lock an operator out of
  // their own venue.
  //
  // The new hash is derived BEFORE the UPDATE so no await straddles the write.
  const replacement = await hashPassword(pw);
  db.prepare('UPDATE users SET pass_hash = ?, password_changed_at = ?, must_change_password = 0 WHERE id = ?').run(
    replacement,
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
//
// THE MATCH IS A PREFIX COMPARISON, NOT A LIKE. This used to interpolate the
// caller's id into `token LIKE ?` with no escaping, and in SQLite's LIKE `_`
// matches any single character and `%` any sequence. Several entirely ordinary
// inputs therefore revoked EVERY session the account had and still answered
// {revoked: true}, because `info.changes` was non-zero:
//
//   '_'          -> pattern '_%'      -> every session row
//   '' / null    -> pattern '%'       -> every session row
//   '%'          -> pattern '%%'      -> every session row
//
// An endpoint whose entire purpose is "revoke ONE session" reporting success
// after revoking all of them is a correctness bug, and `_` is a plausible thing
// to paste when the UI shows a truncated id. substr(token, 1, N) = ? has no
// wildcard semantics at all, so the class cannot come back by accident. The
// cost is that the statement cannot use the token PRIMARY KEY's LIKE-prefix
// optimisation; the sessions table is a handful of rows per account, so that is
// not a trade worth making for a session revocation.
//
// An EMPTY id is rejected with a 400 rather than becoming a 404: "revoke
// session ''" is not a lookup that missed, it is a request that was never
// well-formed, and it must never reach the all-sessions path.
function revokeSession(db, userId, sessionId) {
  const prefix = String(sessionId ?? '').slice(0, 12);
  if (!prefix) throw httpError(400, 'Session id is required');
  const info = db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND substr(token, 1, 12) = ?')
    .run(userId, prefix);
  if (!info.changes) throw httpError(404, 'Session not found');
  return { revoked: true };
}

module.exports = {
  httpError,
  hashPassword,
  verifyPassword,
  createAccountSync,
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
