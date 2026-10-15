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
//
// ── #104: THE CURRENCY IS NOW A FACT THE LEDGER CHECKS ───────────────────────
//
// `currency` on this table used to be written with the literal 'USD' at both
// write sites below and read by NOTHING. A column written with a literal and
// read by nobody is decoration: it could not be USD *and* EUR, it recorded
// nothing about what a bucket was denominated in, and nothing validated it.
//
// It is now read in three places, which is what makes it a control rather than
// a label:
//
//   1. ensureAccountRow() ASSERTS the currency of the row it resolves. This is
//      also the answer to the silent no-op. `idx_accounts_kind_user` does not
//      span currency, so one player has exactly one `player_funds` bucket and
//      the venue exactly one `house_float`. A second currency therefore hits the
//      unique index, `INSERT OR IGNORE` swallows the conflict, the caller
//      carries on, and the account it resolves is the one that ALREADY EXISTED
//      — in the wrong currency, with no error anywhere. That is a control
//      reporting success while doing nothing, which is the exact failure shape
//      this codebase has been burned by repeatedly. It is now loud: the row is
//      read back and its currency compared, and a disagreement throws.
//
//   2. post() REFUSES a set of legs spanning two currencies. (1) makes each
//      bucket individually correct; this makes the ARITHMETIC correct. Without
//      it, a player bucket in one currency and a venue bucket in another could
//      each pass (1) and then have their cents added together by postTransfer —
//      a silent FX conversion with no rate, which is worse than an error because
//      the books would balance and be wrong.
//
//   3. Nothing else has to check, because there is nowhere else a currency can
//      enter. Both insert sites pass the tenant's, and both are asserted.
//
// WHY ONE CURRENCY AND NOT A CHOICE (#104 option B, deferred).
//
//   `accounts` has NO tenant_id, and its unique index spans (kind, user_id)
//   alone. So per-player multi-currency is not merely unimplemented here, it is
//   not expressible: there is no column to put a second currency in and no index
//   that would let two currencies coexist for one player. Implementing it needs,
//   in order:
//
//     - `accounts.tenant_id` (and the venue singletons stop being singletons);
//     - the unique index spanning currency, or the constraint above comes back;
//     - a rate SOURCE and a conversion POINT. The obvious point — settlement —
//       is the worst one available, because commission and the pot are integer
//       cents and a converted amount has to be rounded somewhere. Rounding
//       inside settlement is a money bug of the class the README's invariant
//       table exists to prevent, so it needs a written policy: rate source,
//       conversion timing relative to commission and settlement, the rounding
//       point, and proof the rounding is house-favourable — the treatment
//       commission rounding already got.
//
//   Until that policy exists, posting() throws rather than guessing, which is
//   why option A is safe to ship and option B is not.
//
// WHAT THE VENUE CURRENCY IS: config.VENUE_CURRENCY, seeded onto the default
// tenant's row by lib/tenants.js and read back from there per tenant, so the
// ledger, /api/branding and the browser's formatter are all reading one fact.
const { httpError } = require('./auth');
const config = require('./config');

// Fixed account kinds. A CHECK in the schema is the real guard; this list is
// for readable errors and for the venue-singleton distinction.
const PLAYER_KINDS = ['player_funds', 'player_escrow'];
const VENUE_KINDS = ['operator_commission', 'house_float', 'gateway_clearing', 'bonus'];
const ALL_KINDS = [...PLAYER_KINDS, ...VENUE_KINDS];

/**
 * Create the account if it is absent, then PROVE it is the account asked for.
 *
 * The insert keeps OR IGNORE because creating a row that already exists is
 * genuinely a no-op here and accountId() runs on every balance read — but the
 * read-back is what makes that safe. Before #104 the function ended at the
 * insert, so an ignored conflict meant a caller resolved a row it had not
 * created and never looked at.
 *
 * The currency is compared, not defaulted. A caller asking for an EUR bucket
 * that already exists in AUD gets an error naming both, which is the only
 * outcome that tells an operator their ledger is not what they think it is.
 */
function ensureAccountRow(db, kind, userId, currency) {
  db.prepare('INSERT OR IGNORE INTO accounts (kind, user_id, currency) VALUES (?, ?, ?)').run(kind, userId, currency);
  const row = userId
    ? db.prepare('SELECT id, currency FROM accounts WHERE kind = ? AND user_id = ?').get(kind, userId)
    : db.prepare('SELECT id, currency FROM accounts WHERE kind = ? AND user_id IS NULL').get(kind);
  if (!row) throw httpError(500, `Could not resolve account ${kind}`);
  if (row.currency !== currency) {
    throw httpError(
      500,
      `Account ${kind}${userId ? ` for user ${userId}` : ''} is denominated in ${row.currency}, not ${currency}. ` +
        'One player cannot hold two currencies and one venue has one house account; accounts.currency is ' +
        'not a display setting and there is no conversion rate in this codebase to reconcile the ' +
        "difference. See #104 option B for what multi-currency would require."
    );
  }
  return row.id;
}

// Create the per-user accounts. Idempotent: the UNIQUE(kind, user_id) index
// makes a second call a no-op, so this is safe on every balance read — and
// ensureAccountRow() is what makes that no-op verifiable rather than assumed.
function ensureUserAccounts(db, userId, currency) {
  for (const kind of PLAYER_KINDS) ensureAccountRow(db, kind, userId, currency);
}

// Create the venue singletons (user_id NULL). Also idempotent, and also
// currency-asserted.
function ensureVenueAccounts(db, currency) {
  for (const kind of VENUE_KINDS) ensureAccountRow(db, kind, null, currency);
}

/**
 * Resolve an account id, creating it if absent.
 * `userId` is required for player kinds and forbidden for venue kinds —
 * a player_funds row without an owner would be money belonging to nobody,
 * which is exactly the kind of ambiguity fund segregation exists to remove.
 *
 * `currency` is the denomination the caller expects, and it is REQUIRED rather
 * than defaulted. It used to be a 'USD' literal at both write sites, so a
 * caller could not name a currency even if it wanted to; making it an argument
 * is what let this column stop being decoration. A player account's currency is
 * the TENANT's, resolved by the caller; a venue singleton's is the venue's,
 * because `accounts` has no tenant_id and the singletons are global.
 */
function accountId(db, kind, userId = null, currency = config.VENUE_CURRENCY) {
  if (!ALL_KINDS.includes(kind)) throw httpError(400, `Unknown account kind: ${kind}`);
  const isPlayer = PLAYER_KINDS.includes(kind);
  if (isPlayer && !userId) throw httpError(500, `Account kind ${kind} requires a user`);
  if (!isPlayer && userId) throw httpError(500, `Account kind ${kind} must not have a user`);
  if (isPlayer) ensureUserAccounts(db, userId, currency);
  else ensureVenueAccounts(db, currency);
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
 * ONE CURRENCY PER SET OF POSTINGS (#104).
 *
 * The check belongs here, at the only place postings are written, for the same
 * reason the balance check does: a property asserted once at the choke point is
 * a property of the system, and the same property checked at fifty call sites is
 * a property of fifty call sites.
 *
 * Without it, ensureAccountRow()'s per-account assertion is not enough. Each
 * bucket could be individually correct in a different currency — a player in
 * EUR against a house_float in the venue's AUD — and postTransfer would add the
 * two numbers together and call the result money. There is no rate in this
 * codebase, so that is a conversion by arithmetic, i.e. an FX rate of 1.
 * Worse than an error: the set still balances, so conservation would still
 * hold and the books would still look clean.
 *
 * One query for the whole set, since a posting is a handful of legs and
 * node:sqlite is synchronous.
 */
function assertSingleCurrency(db, legs) {
  const ids = [...new Set(legs.map((l) => l.account_id))];
  const seen = new Map();
  for (const id of ids) {
    const row = db.prepare('SELECT currency FROM accounts WHERE id = ?').get(id);
    if (!row) throw httpError(500, `Posting references account ${id}, which does not exist`);
    seen.set(id, row.currency);
  }
  const distinct = [...new Set(seen.values())];
  if (distinct.length > 1) {
    const named = ids.map((id) => `${id}:${seen.get(id)}`).join(', ');
    throw httpError(
      500,
      `Posting spans more than one currency (${distinct.join(', ')} across accounts ${named}). ` +
        'There is no conversion rate in this ledger, so these amounts cannot be added. Mixed-currency ' +
        'posting is refused rather than silently summed; see #104 option B.'
    );
  }
  return distinct[0];
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
  // …and never commit a set that adds two currencies together. Checked after
  // the zero-legs are dropped so a dropped leg's account cannot fail the query,
  // and before any INSERT so nothing is written when it throws.
  assertSingleCurrency(db, kept);

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
  assertSingleCurrency,
  balanceOf,
  userBalance,
  post,
  postTransfer,
  assertConserved,
  segregation,
  assertUserAgrees,
};