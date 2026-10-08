'use strict';
// lib/util.js — tiny shared helpers (one definition each).
//
// Created in the review remediation: now() was duplicated in lib/match.js
// and lib/settle.js. Every timestamp the exchange writes by hand is the
// same SQLite-shaped "YYYY-MM-DD HH:MM:SS" UTC string, so it lives here
// once. (PKG3's seed.js/drift.js adopt it too; lib/ledger.js writes no
// timestamps by hand — its rows use the database's datetime('now')
// defaults, which produce the identical format.)

// UTC now, in the same shape as SQLite's datetime('now'): second
// resolution, space separator. Order rows, settlements and market state
// all display this verbatim.
function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = { now };
