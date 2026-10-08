'use strict';
// lib/tx.js — the single way this codebase opens a transaction.
//
// SQLite has no nested BEGIN and node:sqlite exposes no inTransaction()
// introspection, so this module owns the depth: the outermost call issues
// BEGIN/COMMIT and any nested call (a ledger op inside settleMarket, say)
// uses a SAVEPOINT instead. Every money-moving unit of work goes through
// here, which is what makes "all-or-nothing" a property of the code rather
// than a convention someone has to remember.
//
// Depth is tracked per connection (WeakMap), not per-process: if a second
// DatabaseSync ever appears, a nested call against it is a programming
// error (SQLite cannot nest across connections — the inner COMMIT would
// release the outer one) and fails fast here instead of silently
// corrupting the outer transaction's depth.
const depths = new WeakMap(); // db -> { n: open depth on that connection }
let activeDb = null; // the connection holding the outermost transaction

function depthOf(db) {
  let d = depths.get(db);
  if (!d) {
    d = { n: 0 };
    depths.set(db, d);
  }
  return d;
}

// Without an argument: is ANY transaction open on any connection? (Kept
// for the existing zero-argument call sites and tests.) With a db: is
// that particular connection mid-transaction?
function inTransaction(db) {
  return db ? depthOf(db).n > 0 : activeDb !== null;
}

function transaction(db, fn) {
  const d = depthOf(db);
  if (d.n > 0) {
    // Same-connection nesting: a SAVEPOINT gives the inner body its own
    // rollback point without touching the outer BEGIN/COMMIT.
    const sp = `sp_tx_${d.n}`;
    db.exec(`SAVEPOINT ${sp}`);
    d.n += 1;
    try {
      const out = fn();
      db.exec(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (e) {
      db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
      db.exec(`RELEASE SAVEPOINT ${sp}`);
      throw e;
    } finally {
      d.n -= 1;
    }
  }
  if (activeDb !== null) {
    // A DIFFERENT connection is mid-transaction while this one is not:
    // cross-connection nesting is never valid. Fail loudly rather than
    // letting the inner COMMIT end the outer transaction half-done.
    throw new Error('transaction: nested call on a different connection while another transaction is open');
  }
  db.exec('BEGIN');
  activeDb = db;
  d.n = 1;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    d.n = 0;
    activeDb = null;
  }
}

module.exports = { transaction, inTransaction };
