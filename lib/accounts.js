'use strict';
// lib/accounts.js — double-entry posting layer.
//
// WHY THIS EXISTS. Until now the ledger was SINGLE-entry: every movement was a
// bare `UPDATE users SET balance_cents = ?`. A deposit created money from
// nothing and a loss destroyed it, with no counterparty recorded anywhere. The
// only reason the smoke test could assert "money conserved" was that it
// happened to check one scenario.
//
// Single-entry answers "what does this account show?". Double-entry answers
// "where did this money come from and where did it go?", and that is the
// difference between "we log money movements" and "we can prove to an auditor
// that players' funds are segregated and intact". Fund segregation is a legal
// requirement, and a single balance column cannot express it.
//
// THE MODEL. An account is a bucket; a posting moves value between buckets and
// is half of a balanced pair. Every operation in this codebase now produces
// entries that sum to ZERO, which makes three properties ASSERTABLE rather
// than asserted-in-prose:
//
//   global conservation  total debits == total credits, always
//   segregation          sum(player_funds + player_escrow) is the players'
//                       money, and it is a QUERY, not a promise
//   revenue              operator take is operator_commission, queryable
//
// WHY ESCROW IS A REAL ACCOUNT. Escrow is an INTRA-PLAYER split (available ->
// frozen), not a transfer between counterparties, which makes it awkward in a
// naive model where escrow is just a memo column. Modelling it as a genuine
// per-user `player_escrow` liability account keeps one rule with no
// exceptions: if it is not a balanced posting, it is not money. That rule is
// what an auditor can actually check.
//
// THE MIGRATION IS ADDITIVE, DELIBERATELY. users.balance_cents and
// users.frozen_cents are still written exactly as before — they are now a
// MATERIALISED CACHE of the postings, not the record. assertUserAgrees() proves
// the cache equals the postings for every user, so the two cannot silently
// drift. Flipping the authority the other way (dropping the columns) is a
// separate, later step once the postings have proven themselves in production.
const { httpError } = require('./auth');

// Fixed account kinds. A CHECK in the schema is the real guard; this list is
// for readable errors and for the venue-singleton distinction.
const PLAYER_KINDS = ['player_funds', 'player_escrow'];
const VENUE_KINDS = ['operator_commission', 'house_float', 'gateway_clearing', 'bonus'];
const ALL_KINDS = [...PLAYER_KINDS, ...VENUE_KINDS];

// Create the per-user accounts. Idempotent: the UNIQUE(user_id, kind) index
// makes a second call a no-op, so this is safe on every balance read.
function ensureUserAccounts(db, userId) {
  for (const kind of PLAYER_KINDS) {
    db.prepare('INSERT OR IGNORE INTO accounts (kind, user_id, currency) VALUES (?, ?, ?)').run(kind, userId, 'USD');
  }
}

// Create the venue singletons (user_id NULL). Also idempotent.
function ensureVenueAccounts(db) {
  for (const kind of VENUE_KINDS) {
    db.prepare('INSERT OR IGNORE INTO accounts (kind, user_id, currency) VALUES (?, NULL, ?)').run(kind, 'USD');
  }
}

/**
 * Resolve an account id, creating it if absent.
 * `userId` is required for player kinds and forbidden for venue kinds —
 * a player_funds row without an owner would be money belonging to nobody,
 * which is exactly the kind of ambiguity fund segregation exists to remove.
 */
function accountId(db, kind, userId = null) {
  if (!ALL_KINDS.includes(kind)) throw httpError(400, `Unknown account kind: ${kind}`);
  const isPlayer = PLAYER_KINDS.includes(kind);
  if (isPlayer && !userId) throw httpError(500, `Account kind ${kind} requires a user`);
  if (!isPlayer && userId) throw httpError(500, `Account kind ${kind} must not have a user`);
  if (isPlayer) ensureUserAccounts(db, userId);
  else ensureVenueAccounts(db);
  const row = isPlayer
    ? db.prepare('SELECT id FROM accounts WHERE kind = ? AND user_id = ?').get(kind, userId)
    : db.prepare('SELECT id FROM accounts WHERE kind = ? AND user_id IS NULL').get(kind);
  if (!row) throw httpError(500, `Could not resolve account ${kind}`);
  return row.id;
}

/** Signed balance of an account in cents, from its postings alone. */
function balanceOf(db, accountId) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_cents ELSE -amount_cents END), 0) AS bal
         FROM entries WHERE account_id = ?`
    )
    .get(accountId);
  return r.bal;
}

function userBalance(db, userId, kind) {
  return balanceOf(db, accountId(db, kind, userId));
}

/**
 * Write one balanced set of postings.
 *
 * `legs` is [{ account_id, direction, amount_cents }]. The sum of signed
 * amounts MUST be zero or this throws — the check is here, at the only place
 * postings are written, so an unbalanced operation cannot be committed
 * anywhere in the codebase. That single assertion is what makes conservation
 * a property of the system rather than a hope about every call site.
 *
 * Zero-amount legs are dropped rather than rejected: a settlement with no
 * commission is normal, and forcing callers to filter is how a future
 * caller forgets and posts a spurious 0 row.
 */
function post(db, { transaction_id, legs, memo = null }) {
  if (!Number.isInteger(transaction_id)) throw httpError(500, 'post requires a transaction_id');
  if (!Array.isArray(legs) || legs.length === 0) throw httpError(500, 'post requires at least one leg');

  const kept = [];
  let signed = 0;
  for (const leg of legs) {
    if (!Number.isInteger(leg.amount_cents)) {
      throw httpError(500, `Posting amount must be an integer number of cents, got ${JSON.stringify(leg.amount_cents)}`);
    }
    if (!Number.isInteger(leg.account_id) || !['debit', 'credit'].includes(leg.direction)) {
      throw httpError(500, 'Posting needs an integer account_id and a debit|credit direction');
    }
    if (leg.amount_cents < 0) throw httpError(500, 'Posting amount must be non-negative (direction carries the sign)');
    if (leg.amount_cents === 0) continue; // no-op leg, see above
    signed += leg.direction === 'credit' ? leg.amount_cents : -leg.amount_cents;
    kept.push(leg);
  }
  if (kept.length === 0) return { posted: 0 };
  if (signed !== 0) {
    // Never commit an unbalanced set. This is the guard that makes global
    // conservation structural.
    throw httpError(500, `Unbalanced postings: net ${signed} cents across ${kept.length} legs`);
  }

  const ins = db.prepare(
    'INSERT INTO entries (transaction_id, account_id, direction, amount_cents, memo) VALUES (?, ?, ?, ?, ?)'
  );
  for (const leg of kept) ins.run(transaction_id, leg.account_id, leg.direction, leg.amount_cents, memo);
  return { posted: kept.length };
}

/**
 * Build a balanced two-sided posting from a signed net delta.
 *
 * `from` pays, `to` receives. A POSITIVE delta moves value from -> to; a
 * NEGATIVE delta moves it to -> from. Used by every operation whose economics
 * are "one account pays another", which is nearly all of them, and is the
 * reason settlement does not need a bespoke balancing routine.
 */
function postTransfer(db, { transaction_id, from, to, deltaCents, memo = null }) {
  const amount = Math.abs(deltaCents);
  if (amount === 0) return { posted: 0 };
  const dir = deltaCents > 0 ? ['debit', 'credit'] : ['credit', 'debit'];
  return post(db, {
    transaction_id,
    memo,
    legs: [
      { account_id: from, direction: dir[0], amount_cents: amount },
      { account_id: to, direction: dir[1], amount_cents: amount },
    ],
  });
}

/**
 * GLOBAL CONSERVATION: total debits equal total credits, always.
 * Returns the signed net, which must be 0. This is the auditor's first
 * question and it is answered by one query.
 */
function assertConserved(db) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_cents ELSE -amount_cents END), 0) AS net
         FROM entries`
    )
    .get();
  return r.net;
}

/**
 * FUND SEGREGATION as an assertion rather than a promise: the players' money
 * is every player account, and the venue's own money is every venue account.
 * A positive segregation gap is players' funds intact and unencumbered by
 * venue losses; a negative one means the venue has eaten into player money,
 * which must never happen.
 *
 * `playerNet` is players' total (funds + escrow). `venueNet` is the venue's
 * total. In a healthy book venueNet is negative (the venue owes the pot it is
 * holding) and the SUM is 0.
 */
function segregation(db) {
  let playerNet = 0;
  for (const row of db.prepare("SELECT id, user_id FROM accounts WHERE kind IN ('player_funds','player_escrow')").all()) {
    playerNet += balanceOf(db, row.id);
  }
  let venueNet = 0;
  for (const row of db.prepare("SELECT id FROM accounts WHERE user_id IS NULL").all()) {
    venueNet += balanceOf(db, row.id);
  }
  return { player_cents: playerNet, venue_cents: venueNet, net: playerNet + venueNet };
}

/**
 * THE CACHE TEST. users.balance_cents / frozen_cents are materialised copies
 * of the postings, and this proves they agree, per user, so the two
 * representations cannot drift apart unnoticed.
 *
 * balance_cents is TOTAL funds INCLUDING frozen — that is the column's
 * existing meaning and it is load-bearing (available = balance - frozen).
 * So it maps to player_funds + player_escrow, NOT to player_funds alone.
 * Comparing it against funds alone would report every escrow as a divergence.
 *
 * Returns a list of divergent users (empty when healthy) rather than throwing,
 * so a caller can report all of them at once instead of one per boot.
 */
function assertUserAgrees(db) {
  const rows = db.prepare('SELECT id, balance_cents, frozen_cents FROM users ORDER BY id').all();
  const divergent = [];
  for (const u of rows) {
    const funds = userBalance(db, u.id, 'player_funds');
    const escrowBal = userBalance(db, u.id, 'player_escrow');
    if (funds + escrowBal !== u.balance_cents || escrowBal !== u.frozen_cents) {
      divergent.push({
        user_id: u.id,
        balance_cents: u.balance_cents,
        postings_total: funds + escrowBal,
        frozen_cents: u.frozen_cents,
        escrow_postings: escrowBal,
      });
    }
  }
  return divergent;
}

module.exports = {
  PLAYER_KINDS,
  VENUE_KINDS,
  ALL_KINDS,
  ensureUserAccounts,
  ensureVenueAccounts,
  accountId,
  balanceOf,
  userBalance,
  post,
  postTransfer,
  assertConserved,
  segregation,
  assertUserAgrees,
};