'use strict';
// lib/admin.js — operator actions on accounts.
//
// Every mutation here is audited (lib/audit.js) and every one of them that
// touches money goes through lib/ledger.js, never around it. The admin desk
// is the only surface in the app that can change a balance without a market
// behind it, so it is also the only surface where a mistake is invisible to
// the settlement tests.
//
// Three lockout guards are absolute, because each one has a known failure mode
// where the system becomes unadministrable:
//
//   - an operator cannot suspend or demote THEMSELVES (an accidental click
//     would otherwise strand the desk behind a login it cannot pass);
//   - the LAST active admin cannot be suspended or demoted, by anyone,
//     including a second admin trying to tidy up;
//   - a change to money or access requires a written reason, so the audit row
//     is useful months later rather than just non-null.
//
// Suspending cancels RESTING orders and releases their escrow. It deliberately
// does NOT touch matched positions: those are collateralised on both sides and
// must still settle, or the venue would be choosing which side of a matched
// bet to honour.
const { httpError } = require('./auth');
const { transaction } = require('./tx');
const ledger = require('./ledger');
const match = require('./match');
const audit = require('./audit');

const ROLES = new Set(['user', 'admin']);
const STATUSES = new Set(['active', 'suspended']);

function getRow(db, userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) throw httpError(404, 'User not found');
  return u;
}

function isAdmin(u) {
  return (u.role || (u.is_admin ? 'admin' : 'user')) === 'admin';
}

function reasonOr400(reason) {
  const r = String(reason ?? '').trim();
  if (!r) throw httpError(400, 'A reason is required for this action');
  if (r.length > 500) throw httpError(400, 'Reason must be 500 characters or fewer');
  return r;
}

// How many admins could still act after this change. Used to refuse the change
// when it would reach zero.
function activeAdminCount(db, { excludingUserId = null, requiringStatus = null } = {}) {
  const rows = db.prepare("SELECT id, role, is_admin, status FROM users").all();
  let n = 0;
  for (const r of rows) {
    if (excludingUserId !== null && r.id === excludingUserId) continue;
    if (!isAdmin(r)) continue;
    if (requiringStatus && r.status !== requiringStatus) continue;
    n++;
  }
  return n;
}

/** Admin desk list. Search matches username OR email; filters compose. */
/**
 * List accounts, ALWAYS scoped to a tenant.
 *
 * `tenantId` is a required part of the filter rather than an optional one,
 * and NULL is normalised to the default tenant. That is deliberate: an
 * optional tenant scope is a scope that someone will eventually forget to
 * pass, and a forgotten scope on an admin route is a cross-tenant read. Making
 * it structural — the parameter has no default that means "everything" — is
 * what turns "cross-tenant reads are a bug" into "cross-tenant reads are not
 * expressible".
 */
function listUsers(db, { q, role, status, tenantId = null, limit = 50, offset = 0 } = {}) {
  const where = ['is_bot = 0']; // bots are venue machinery, not accounts
  const params = [];
  const tenants = require('./tenants');
  const tenant = tenantId === null || tenantId === undefined ? tenants.defaultTenant(db) : tenants.byId(db, tenantId);
  if (!tenant) throw httpError(404, 'No such tenant');
  where.push('IFNULL(tenant_id, ?) = ?');
  // NULL tenant_id means "the default tenant", resolved by slug rather than a
  // hard-coded id — see lib/tenants.js on why an id is the wrong identity.
  params.push(tenant.id, tenant.id);
  if (role) {
    if (!ROLES.has(role)) throw httpError(400, `Unknown role: ${role}`);
    where.push('role = ?');
    params.push(role);
  }
  if (status) {
    if (!STATUSES.has(status)) throw httpError(400, `Unknown status: ${status}`);
    where.push('status = ?');
    params.push(status);
  }
  if (q) {
    const like = `%${String(q).trim().toLowerCase()}%`;
    where.push('(LOWER(username) LIKE ? OR LOWER(COALESCE(email, \'\')) LIKE ?)');
    params.push(like, like);
  }
  const clause = 'WHERE ' + where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM users ${clause}`).get(...params).c;
  const rows = db
    .prepare(
      `SELECT id, username, email, role, is_admin, status, balance_cents, frozen_cents, created_at
         FROM users ${clause}
        ORDER BY id LIMIT ? OFFSET ?`
    )
    .all(...params, Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0));
  return {
    total,
    users: rows.map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email ?? null,
      role: r.role,
      is_admin: !!r.is_admin,
      status: r.status,
      balance_cents: r.balance_cents,
      frozen_cents: r.frozen_cents,
      available_cents: r.balance_cents - r.frozen_cents,
      created_at: r.created_at,
    })),
  };
}

/** One account in depth: profile, exposure, resting orders, recent sessions. */
function userDetail(db, userId) {
  const u = getRow(db, userId);
  const open = match.openOrdersFor(db, userId);
  const sessions = db
    .prepare('SELECT token, created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(userId);
  const current = currentDigest(db, userId);
  return {
    id: u.id,
    username: u.username,
    email: u.email ?? null,
    role: u.role,
    is_admin: !!u.is_admin,
    is_bot: !!u.is_bot,
    status: u.status,
    balance_cents: u.balance_cents,
    frozen_cents: u.frozen_cents,
    available_cents: u.balance_cents - u.frozen_cents,
    created_at: u.created_at,
    password_changed_at: u.password_changed_at ?? null,
    open_orders: open,
    open_order_count: open.length,
    // Sessions are identified by digest prefix only, exactly as the
    // self-service listing does — a raw token never leaves the process.
    sessions: sessions.map((s) => ({
      id: s.token.slice(0, 12),
      created_at: s.created_at,
      expires_at: s.expires_at,
      current: current !== null && s.token === current,
    })),
    audit: audit.list(db, { target: `user:${u.id}`, limit: 25 }),
  };
}

function currentDigest(db, userId) {
  const row = db.prepare('SELECT token FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId);
  return row ? row.token : null;
}

/** Suspend or reinstate. Cancels resting orders on suspension. */
function setStatus(db, { actor, userId, status, reason }) {
  if (!STATUSES.has(status)) throw httpError(400, `Unknown status: ${status}`);
  const why = reasonOr400(reason);
  return transaction(db, () => {
    const u = getRow(db, userId);
    if (u.is_bot) throw httpError(400, 'Bots cannot be suspended');
    if (u.status === status) throw httpError(400, `Account is already ${status}`);

    if (status === 'suspended') {
      if (userId === actor.id) throw httpError(400, 'You cannot suspend your own account');
      if (isAdmin(u) && activeAdminCount(db, { excludingUserId: userId, requiringStatus: 'active' }) === 0) {
        throw httpError(400, 'Cannot suspend the last active admin');
      }
    }

    // Release anything resting before the account goes quiet, so the balance
    // is not trapped in escrow the holder can no longer trade against.
    let cancelled = 0;
    let releasedCents = 0;
    if (status === 'suspended') {
      for (const o of match.openOrdersFor(db, userId)) {
        if (o.frozen_cents > 0) releasedCents += o.frozen_cents;
        match.cancelOrder(db, { id: userId }, o.id);
        cancelled++;
      }
      // Live tokens stop working immediately; suspension must not wait for a
      // 30-day TTL to take effect.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }

    const before = { status: u.status };
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);

    audit.record(
      db, actor, audit.ACTIONS.USER_STATUS_CHANGED, `user:${userId}`,
      before, { status }, why
    );
    return { id: userId, status, cancelled_orders: cancelled, released_cents: releasedCents };
  });
}

/** Promote or demote. */
function setRole(db, { actor, userId, role, reason }) {
  if (!ROLES.has(role)) throw httpError(400, `Unknown role: ${role}`);
  const why = reasonOr400(reason);
  return transaction(db, () => {
    const u = getRow(db, userId);
    if (u.is_bot) throw httpError(400, 'Bots cannot be given a role');
    const currentRole = isAdmin(u) ? 'admin' : 'user';
    if (currentRole === role) throw httpError(400, `Account is already ${role}`);
    if (userId === actor.id) throw httpError(400, 'You cannot change your own role');
    if (currentRole === 'admin' && activeAdminCount(db, { excludingUserId: userId, requiringStatus: 'active' }) === 0) {
      throw httpError(400, 'Cannot demote the last active admin');
    }

    const before = { role: currentRole };
    // is_admin is the legacy mirror; role is authoritative. Both move together
    // so a partially-migrated caller cannot read a stale privilege flag.
    db.prepare('UPDATE users SET role = ?, is_admin = ? WHERE id = ?').run(
      role, role === 'admin' ? 1 : 0, userId
    );

    audit.record(
      db, actor, audit.ACTIONS.USER_ROLE_CHANGED, `user:${userId}`,
      before, { role }, why
    );
    return { id: userId, role };
  });
}

/** Operator credit or debit. Routed through the ledger so the escrow floor holds. */
function adjustBalance(db, { actor, userId, deltaCents, reason }) {
  const why = reasonOr400(reason);
  if (userId === actor.id) throw httpError(400, 'You cannot adjust your own balance');
  return transaction(db, () => {
    const u = getRow(db, userId);
    const before = { balance_cents: u.balance_cents, frozen_cents: u.frozen_cents };
    const after = ledger.adjust(db, userId, Number(deltaCents));
    audit.record(
      db, actor, audit.ACTIONS.BALANCE_ADJUSTED, `user:${userId}`,
      before, after, why
    );
    return { id: userId, ...after };
  });
}

module.exports = {
  ROLES,
  STATUSES,
  listUsers,
  userDetail,
  setStatus,
  setRole,
  adjustBalance,
};
