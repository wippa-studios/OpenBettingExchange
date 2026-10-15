'use strict';
// lib/ledger.js — wallet movements with full integrity.
//
// Money is integer cents. users.balance_cents = TOTAL funds (incl. frozen);
// users.frozen_cents = escrow. available = balance − frozen.
//
// Every movement writes a transactions row with balance_after + frozen_after.
// Each op is a single transaction (via lib/tx.js, so it nests correctly when a
// service already holds one) and refuses to create an invalid state:
// over-committing available funds, releasing more than is frozen, or
// settling into a negative balance.
//
// #104: every amount in this file is in the CURRENCY OF THE PLAYER'S TENANT,
// which is resolved per call rather than assumed, because the two hard-coded
// 'USD' write sites in lib/accounts.js that used to decide this are now read
// and asserted — a bucket denominated in something other than its tenant's is
// refused by lib/accounts.js before a cent moves, not after.
const { httpError } = require('./auth');
const { transaction } = require('./tx');
const accounts = require('./accounts');
const { currencyForUser } = require('./tenants');
const config = require('./config');

// A player bucket is denominated in the currency of the TENANT THE PLAYER
// BELONGS TO. Resolved per call rather than read from config, so a tenant is
// the thing that carries a currency and this module has no opinion of its own
// about what that is.
function playerCurrency(db, userId) {
  return currencyForUser(db, userId);
}

// Shorthands for the four venue-side buckets. Resolved at call time rather than
// cached, so a database created or migrated mid-process still works.
//
// A VENUE bucket has no player and therefore no tenant — `accounts` carries no
// tenant_id and these four are global singletons — so it is denominated in the
// venue's currency. lib/accounts.js refuses a posting that spans a player
// bucket and a venue bucket in different currencies, which is what makes that
// asymmetry safe rather than merely described.
const fundsOf = (db, userId) => accounts.accountId(db, 'player_funds', userId, playerCurrency(db, userId));
const escrowOf = (db, userId) => accounts.accountId(db, 'player_escrow', userId, playerCurrency(db, userId));
const venueOf = (db, kind) => accounts.accountId(db, kind, null, config.VENUE_CURRENCY);

// An amount in cents, rendered for a player- or operator-facing message in the
// currency it is actually denominated in. The `$${(cap / 100).toFixed(2)}`
// literals this replaces were a dollar sign nobody chose; a limit message that
// names a dollar sign while the books say AUD is the same class of error as the
// formatter this issue opened with, just in an exception string.
//
// Bare code plus number, deliberately: a symbol lookup table in the server would
// be a second currency registry to keep current, and the ISO code is
// unambiguous where a symbol is not ('$' is shared by dozens of currencies).
function amountIn(currency, cents) {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

function getUser(db, userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) throw httpError(404, 'User not found');
  return u;
}

function availableOf(u) {
  return u.balance_cents - u.frozen_cents;
}

function insertTx(db, userId, type, amountCents, balanceAfter, frozenAfter, ref) {
  const info = db
    .prepare(
      `INSERT INTO transactions (user_id, type, amount_cents, balance_after, frozen_after, order_id, market_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      type,
      amountCents,
      balanceAfter,
      frozenAfter,
      ref.orderId ?? null,
      ref.marketId ?? null
    );
  return Number(info.lastInsertRowid);
}

// Faucet deposit (paper money). Cap enforced per deposit.
function deposit(db, userId, cents, capCents) {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw httpError(400, 'Deposit must be a positive integer amount of cents');
  }
  if (!Number.isInteger(capCents) || capCents <= 0) {
    throw httpError(400, 'Faucet cap misconfigured');
  }
  if (cents > capCents) {
    throw httpError(400, `Deposit exceeds the faucet cap of ${amountIn(playerCurrency(db, userId), capCents)}`);
  }
  return transaction(db, () => {
    const u = getUser(db, userId);
    const bal = u.balance_cents + cents;
    db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(bal, userId);
    const txId = insertTx(db, userId, 'deposit', cents, bal, u.frozen_cents, {});
    // Phase 3: money entering the venue from OUTSIDE, so the counterparty is
    // the external clearing account, not the house. This is the posting that
    // makes a deposit traceable to an external source.
    accounts.postTransfer(db, { transaction_id: txId, from: venueOf(db, 'gateway_clearing'), to: fundsOf(db, userId), deltaCents: cents, memo: 'deposit' });
    return { balance_cents: bal, frozen_cents: u.frozen_cents };
  });
}

// Freeze escrow (order placement / matched pot). Refuses to over-commit
// available funds.
function escrow(db, userId, cents, ref = {}) {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw httpError(400, 'Escrow must be a positive integer amount of cents');
  }
  return transaction(db, () => {
    const u = getUser(db, userId);
    if (availableOf(u) < cents) {
      throw httpError(400, 'Insufficient available balance');
    }
    const fro = u.frozen_cents + cents;
    db.prepare('UPDATE users SET frozen_cents = ? WHERE id = ?').run(fro, userId);
    const txId = insertTx(db, userId, 'escrow', cents, u.balance_cents, fro, ref);
    // Escrow is an INTRA-PLAYER split: the player's own money moving from
    // spendable to held. Both legs are the SAME player, which is exactly why
    // modelling it as a real liability account keeps the rule exception-free —
    // if it moves money it posts, and escrow posts.
    accounts.postTransfer(db, { transaction_id: txId, from: fundsOf(db, userId), to: escrowOf(db, userId), deltaCents: cents, memo: 'escrow' });
    return { balance_cents: u.balance_cents, frozen_cents: fro };
  });
}

// Unfreeze (cancel remainder / lay excess release / auto-cancel at settle).
function release(db, userId, cents, ref = {}) {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw httpError(400, 'Release must be a positive integer amount of cents');
  }
  return transaction(db, () => {
    const u = getUser(db, userId);
    if (u.frozen_cents < cents) {
      throw httpError(400, 'Cannot release more than is frozen');
    }
    const fro = u.frozen_cents - cents;
    db.prepare('UPDATE users SET frozen_cents = ? WHERE id = ?').run(fro, userId);
    const txId = insertTx(db, userId, 'release', cents, u.balance_cents, fro, ref);
    // The mirror of escrow: held money becomes spendable again. No external
    // counterparty, because this is the player's own money coming back.
    accounts.postTransfer(db, { transaction_id: txId, from: escrowOf(db, userId), to: fundsOf(db, userId), deltaCents: cents, memo: 'release' });
    return { balance_cents: u.balance_cents, frozen_cents: fro };
  });
}

// Settlement for ONE user on ONE market, atomic:
//   balance += balanceDelta − commissionCents
//   frozen −= frozenRelease
//   rows: refund (void refunds), settle (net, may be negative = loss),
//         commission (fee, only when > 0).
function settleUser(db, userId, { balanceDelta, frozenRelease, commissionCents = 0, refundCents = 0, marketId = null }) {
  if (!Number.isInteger(balanceDelta)) {
    throw httpError(400, 'Settlement balanceDelta must be an integer (cents)');
  }
  if (!Number.isInteger(frozenRelease) || frozenRelease < 0) {
    throw httpError(400, 'Settlement frozenRelease must be a non-negative integer (cents)');
  }
  if (!Number.isInteger(commissionCents) || commissionCents < 0) {
    throw httpError(400, 'Commission must be a non-negative integer (cents)');
  }
  if (!Number.isInteger(refundCents) || refundCents < 0) {
    throw httpError(400, 'Refund must be a non-negative integer (cents)');
  }
  return transaction(db, () => {
    const u = getUser(db, userId);
    if (u.frozen_cents < frozenRelease) {
      throw httpError(500, 'Settlement integrity error: releasing more than frozen');
    }
    const bal = u.balance_cents + balanceDelta - commissionCents;
    // A PLAYER going negative is a hard integrity error — it means escrow
    // under-collateralised a position somewhere upstream.
    //
    // The HOUSE is the exception, and the schema already says so
    // (CHECK (is_bot = 1 OR balance_cents >= 0)): with no user-to-user
    // pot to draw on, a won bet is paid out of the venue's own balance, so
    // the house account MUST be allowed to go negative or settlement throws,
    // rolls back the ENTIRE market's payout, and leaves a live market
    // un-settleable with no repair path — the outside audit's F10, and a
    // single point of failure. The ledger refused it anyway, contradicting
    // its own schema; this makes the two agree.
    if (bal < 0 && !u.is_bot) {
      throw httpError(500, 'Settlement integrity error: negative balance');
    }
    const fro = u.frozen_cents - frozenRelease;
    db.prepare('UPDATE users SET balance_cents = ?, frozen_cents = ? WHERE id = ?').run(bal, fro, userId);

    // ── Phase 3 postings ────────────────────────────────────────────────────
    // Settlement's effect on the cache is:
    //     frozen  -= frozenRelease
    //     balance += balanceDelta - commissionCents
    // which is THREE transfers, and decomposing it this way is what makes each
    // piece independently meaningful to an auditor:
    //
    //   A. the player's own held money comes back      (escrow -> funds)
    //   B. the result against the book                 (house  -> funds)
    //   C. the fee the venue earned, paid BY the player
    //                                             (funds -> commission)
    //
    // C is charged to the PLAYER because that is what `bal` above subtracts;
    // taking it from house_float instead would leave the cache and the
    // postings disagreeing by the fee. And it is a separate posting rather
    // than a netted figure so operator revenue stays a QUERY.
    const funds = fundsOf(db, userId);
    const escrow = escrowOf(db, userId);
    const house = venueOf(db, 'house_float');
    const commissionAcct = venueOf(db, 'operator_commission');

    // Preserve the original row semantics exactly: a refund row only when
    // refunding, a settle row only when there is a net move. A settlement that
    // moves nothing must leave NO row, or the wallet ledger fills with zeros.
    let mainTxId = null;
    if (refundCents > 0) {
      mainTxId = insertTx(db, userId, 'refund', refundCents, bal, fro, { marketId });
    } else if (balanceDelta !== 0) {
      mainTxId = insertTx(db, userId, 'settle', balanceDelta, bal, fro, { marketId });
    }
    // A pure escrow release (a void that refunds with no net move) still needs
    // a transaction_id to hang its postings on, so mint one ONLY in that case.
    const postsAnything = frozenRelease !== 0 || balanceDelta !== 0;
    if (postsAnything && mainTxId === null) {
      mainTxId = insertTx(db, userId, 'settle', 0, bal, fro, { marketId });
    }

    if (mainTxId !== null) {
      // A. Return the held collateral. On a void this is the whole refund.
      accounts.postTransfer(db, { transaction_id: mainTxId, from: escrow, to: funds, deltaCents: frozenRelease, memo: 'settle release' });
      // B. The result against the book. Negative means the player paid out.
      // This is the FULL balanceDelta: the collateral already came back in A,
      // so crediting only the remainder would short the player by exactly the
      // amount released — which is the bug this comment replaced.
      accounts.postTransfer(db, { transaction_id: mainTxId, from: house, to: funds, deltaCents: balanceDelta, memo: 'settle pnl' });
    }


    // C. Venue revenue, charged to the PLAYER (this is why bal above subtracts
    // it). Kept as its own posting, out of player funds and into a dedicated
    // revenue account, so operator take is a QUERY rather than an inference
    // from a netted figure.
    if (commissionCents > 0) {
      const commTxId = insertTx(db, userId, 'commission', commissionCents, bal, fro, { marketId });
      accounts.postTransfer(db, { transaction_id: commTxId, from: funds, to: commissionAcct, deltaCents: commissionCents, memo: 'commission' });
    }
    return { balance_cents: bal, frozen_cents: fro };
  });
}

// Operator balance adjustment — the only way money moves without a market,
// a faucet or a settlement behind it. `deltaCents` is signed: positive credits,
// negative debits (a clawback).
//
// The floor is `balance − frozen`, NOT zero. Withdrawing down to zero would
// leave `frozen_cents` collateralising matched positions with no funds behind
// it, converting a solvent book into an unbacked one. That is the invariant
// the whole engine exists to protect, so an adjustment is refused rather than
// allowed to breach it.
//
// Refuses: zero, non-integers, a debit larger than the unencumbered balance,
// and the house counterparty (is_bot), whose negative balance is legal and
// meaningful.
function adjust(db, userId, deltaCents) {
  if (!Number.isInteger(deltaCents) || deltaCents === 0) {
    throw httpError(400, 'Adjustment must be a non-zero integer amount of cents');
  }
  return transaction(db, () => {
    const u = getUser(db, userId);
    if (u.is_bot) {
      throw httpError(400, 'The house account cannot be adjusted manually');
    }
    const bal = u.balance_cents + deltaCents;
    if (bal < 0) {
      throw httpError(400, 'Adjustment would leave a negative balance');
    }
    if (bal < u.frozen_cents) {
      throw httpError(
        400,
        `Adjustment would leave ${amountIn(playerCurrency(db, userId), u.frozen_cents)} of escrow uncollateralised`
      );
    }
    db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(bal, userId);
    const txId = insertTx(db, userId, 'adjust', deltaCents, bal, u.frozen_cents, {});
    // Venue money in (or a clawback out), so the counterparty is the house's
    // own float. Note this is deliberately NOT gateway_clearing: an operator
    // adjustment is the venue acting on its own account, not a player payment
    // arriving from a provider.
    accounts.postTransfer(db, { transaction_id: txId, from: venueOf(db, 'house_float'), to: fundsOf(db, userId), deltaCents: deltaCents, memo: 'adjust' });
    return { balance_cents: bal, frozen_cents: u.frozen_cents };
  });
}

// Wallet view for the server: balance split + recent transactions.
//
// 'opening' rows are EXCLUDED from the player-facing ledger. They are how a
// seeded or provisioned account was funded, not something the player did, and
// showing every account a line they did not create is noise on the screen
// that matters to them. They are NOT hidden from the books: the row exists,
// the postings exist, and /api/admin plus the accounts ledger see both. A
// player's wallet shows their movements; the operator sees the provenance.
function walletView(db, userId, limit = 100) {
  const u = getUser(db, userId);
  const txs = db
    .prepare(
      "SELECT * FROM transactions WHERE user_id = ? AND type != 'opening' ORDER BY id DESC LIMIT ?"
    )
    .all(userId, limit);
  return {
    balance_cents: u.balance_cents,
    frozen_cents: u.frozen_cents,
    available_cents: availableOf(u),
    transactions: txs,
  };
}

// Withdrawal hold: debit immediately, park in gateway_clearing.
//
// A withdrawal request must reduce spendable balance AT ONCE — a player who
// could open several withdrawals against the same balance and walk away with
// all of them is the reason this is a single ledger op and not a status flag
// on a row. The money moves to the provider-facing clearing account and stays
// there until the withdrawal completes (money sent) or fails (refunded).
//
// This op exists so that lib/payments never writes users.balance_cents
// directly — tests/guard.test.js enforces that this module is the ONLY
// writer, and a direct UPDATE in payments was the one hole in that guarantee
// until it was moved in here.
function withdrawHold(db, userId, cents) {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw httpError(400, 'Withdrawal must be a positive integer amount of cents');
  }
  return transaction(db, () => {
    const u = getUser(db, userId);
    const available = availableOf(u);
    if (cents > available) throw httpError(400, 'Withdrawal exceeds available balance');
    const bal = u.balance_cents - cents;
    db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(bal, userId);
    const txId = insertTx(db, userId, 'withdraw', -cents, bal, u.frozen_cents, {});
    // Held for the provider: the player's funds become a position against the
    // clearing account. Frozen funds are untouchable by construction because
    // `cents > available` was refused above — the hold can never eat escrow.
    accounts.postTransfer(db, {
      transaction_id: txId,
      from: fundsOf(db, userId),
      to: venueOf(db, 'gateway_clearing'),
      deltaCents: cents,
      memo: 'withdrawal held',
    });
    return { balance_cents: bal, frozen_cents: u.frozen_cents };
  });
}

// Refund a withdrawal hold back to the player (the withdrawal failed, or was
// cancelled inside its cooling-off window). The reverse posting of
// withdrawHold, so a failed withdrawal leaves the books exactly as if it had
// never been opened.
function withdrawRefund(db, userId, cents) {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw httpError(400, 'Refund must be a positive integer amount of cents');
  }
  return transaction(db, () => {
    const u = getUser(db, userId);
    const bal = u.balance_cents + cents;
    db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(bal, userId);
    const txId = insertTx(db, userId, 'withdraw_refund', cents, bal, u.frozen_cents, {});
    accounts.postTransfer(db, {
      transaction_id: txId,
      from: venueOf(db, 'gateway_clearing'),
      to: fundsOf(db, userId),
      deltaCents: cents,
      memo: 'withdrawal refunded',
    });
    return { balance_cents: bal, frozen_cents: u.frozen_cents };
  });
}

module.exports = {
  getUser,
  availableOf,
  deposit,
  escrow,
  release,
  settleUser,
  adjust,
  withdrawHold,
  withdrawRefund,
  walletView,
};
