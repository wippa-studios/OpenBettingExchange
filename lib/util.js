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

// ── ISO-8601 date/datetime ───────────────────────────────────────────────
// Moved here from server.js, which had the only copy. lib/limits.js needs the
// same predicate to validate the self-exclusion end date before storing it, and
// a second copy of a date validator is a second set of bugs — this file exists
// precisely so there is one definition of each shared shape.
//
// The forms the desk actually sends:
//   2030-01-01 | 2030-01-01T12:00 | 2030-01-01 12:00[:00[.ffffff]][Z|±HH:MM]
// (the admin form and smoke.sh both send a SPACE-separated datetime).
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isIsoDateTime(s) {
  if (!ISO_DATETIME_RE.test(s)) return false;
  // A syntactically valid string can still be a non-date (2030-02-31) or a
  // non-time (25:00). Date.parse is lenient — V8 rolls Feb 31 into Mar 3 —
  // so verify the calendar by round-trip: every component must survive.
  const [d, t] = String(s).split(/[T ]/);
  const [y, mo, da] = d.split('-').map(Number);
  let hh = 0, mi = 0, se = 0;
  if (t) {
    const z = t.match(/(Z|[+-]\d{2}:?\d{2})$/);
    const body = z ? t.slice(0, z.index) : t;
    const parts = body.split(':').map((x) => Math.floor(Number(x)));
    hh = parts[0] ?? 0; mi = parts[1] ?? 0; se = parts[2] ?? 0;
  }
  const dt = new Date(Date.UTC(y, mo - 1, da, hh, mi, se));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === da
    && dt.getUTCHours() === hh && dt.getUTCMinutes() === mi && dt.getUTCSeconds() === se;
}

/**
 * Validate an ISO date/datetime and normalise it to SQLite's shape:
 * `YYYY-MM-DD HH:MM:SS` in UTC. Returns null when the input is not acceptable.
 *
 * The NORMALISATION IS THE POINT, not a nicety. A caller that sends
 * `2030-01-15T00:00:00+05:00` means midnight local, which is 19:00 the
 * previous day in UTC. Storing the string with its offset stripped — the old
 * `.replace('T', ' ').slice(0, 19)` — kept the wall-clock digits and threw the
 * offset away, so the stored instant was five hours early and the exclusion
 * lapsed while the player still believed it was in force.
 *
 * A value with NO offset is read as UTC, matching isIsoDateTime's calendar
 * round-trip and matching what SQLite's own datetime('now') returns. It is not
 * read as local time, which would make the stored instant depend on the
 * server's timezone.
 */
function toSqlUtc(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!isIsoDateTime(s)) return null;
  const [d, t] = s.split(/[T ]/);
  const [y, mo, da] = d.split('-').map(Number);
  let hh = 0, mi = 0, se = 0;
  let offsetMinutes = 0;
  if (t) {
    const z = t.match(/(Z|[+-]\d{2}:?\d{2})$/);
    const body = z ? t.slice(0, z.index) : t;
    const parts = body.split(':').map((x) => Math.floor(Number(x)));
    hh = parts[0] ?? 0; mi = parts[1] ?? 0; se = parts[2] ?? 0;
    if (z && z[1] !== 'Z') {
      // UTC = local − offset. A POSITIVE offset means local time is AHEAD of
      // UTC, so the instant is that much EARLIER: `+05:00` at midnight is
      // 19:00 the previous day. `-08:00` at midnight is 08:00 the same day.
      const digits = z[1].slice(1).replace(':', '');
      const sign = z[1][0] === '+' ? 1 : -1;
      offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    }
  }
  const ms = Date.UTC(y, mo - 1, da, hh, mi, se) - offsetMinutes * 60_000;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = { isIsoDateTime, now, toSqlUtc };
