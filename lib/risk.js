'use strict';
// lib/risk.js — market-maker risk. The venue's actual P&L exposure.
//
// WHY THIS MODULE EXISTS (roadmap §2). lib/store.js permits a bot account to
// hold a NEGATIVE balance, and that is correct: a house counterparty must be
// able to owe money, or it could never be the losing side of a bet. But the
// bots in lib/bots.js quote a drifting fair price with NO EDGE. Any bettor with
// an information advantage beats them systematically, and the venue absorbs
// the difference. That is an unbounded loss with no limit anywhere in the
// system — the single sharpest gap in the code before real money.
//
// THE HONEST LIMIT OF WHAT FOLLOWS. Caps and skew are DAMAGE LIMITATION, not
// edge. They bound how much the venue can lose; they do not make it positive.
// A random walk with a spread around it has negative expectancy once the
// bettor is sharp. Making the result positive needs a real quote model — a
// fair price derived from EXTERNAL books, plus a spread — not a random walk.
// This module bounds the loss. Phase 5's feed work is what could address the
// expectancy. Do not describe this as profitability.
//
// The governing idea is SKEW BEFORE STOP:
//
//   As a bot approaches its cap, WIDEN its quotes rather than stopping. The
//   market stays open and tradable, and the venue stops being the sharpest
//   thing in it. Sharp bettors simply stop selecting it, which is the
//   intended outcome and costs nobody a cent.
//
//   Only at the HARD cap do quotes stop. Liquidity disappearing is correct
//   here: the alternative is an unbounded loss. A venue that would rather
//   keep quoting than honour its own cap is a venue that goes bankrupt on a
//   good day.
//
// Every read is cheap and synchronous by design — this runs inside the bot
// quoting loop, which runs inside a transaction.
const { transaction } = require('./tx');
const audit = require('./audit');
// Validation throws here carry a real 4xx so the route can pass genuine faults
// through untouched — see the note in configure().
const { httpError } = require('./auth');

// Desk-level kill switch key in the `settings` table. One row, read on every
// quote: pulling every bot's quotes across the whole venue must be a single
// write that takes effect on the next tick, with no per-bot work to forget.
const KILL_SWITCH_KEY = 'risk.kill_switch';

function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

/** Is the desk kill switch pulled? Absent means not pulled. */
function killSwitch(db) {
  return getSetting(db, KILL_SWITCH_KEY) === '1';
}

/**
 * A written reason is required for the desk controls.
 *
 * Every comparable desk action already enforces this: `reasonOr400` for user
 * status/role/balance (lib/admin.js), a >=5-character reason for a held-market
 * release (lib/results.js) and for reconciliation findings (lib/jobs.js). The
 * two risk controls were the exceptions, and in both the UI actively collected a
 * reason first — so the gap was invisible from either end: the prompt said
 * "recorded in the audit log", the operator believed it, and nothing recorded
 * it. Collecting a justification and throwing it away is worse than not asking,
 * because the act of asking creates a reasonable expectation that it is kept.
 *
 * FIVE CHARACTERS, matching lib/results.js and lib/jobs.js rather than
 * lib/admin.js's bare non-empty: "test" is not a justification, and these are
 * the two controls that can stop the whole venue quoting.
 */
const MIN_REASON = 5;
const MAX_REASON = 500;

function reasonOr400(reason, what) {
  const r = String(reason ?? '').trim();
  if (!r) throw httpError(400, `A reason is required to ${what}`);
  if (r.length < MIN_REASON) throw httpError(400, `The reason must be at least ${MIN_REASON} characters`);
  if (r.length > MAX_REASON) throw httpError(400, `Reason must be ${MAX_REASON} characters or fewer`);
  return r;
}

/**
 * Pull or release the desk kill switch. Every bot's quotes stop on the next
 * quoting pass — this does NOT itself cancel resting orders, because a quote
 * already resting is the venue's promise to the book and ripping it would
 * leave takers with fills they could not have got. Cancelling them is
 * deliberate and separate (see withdrawAll in lib/bots.js).
 *
 * `reason` is MANDATORY and recorded. It used to be collected by the prompt,
 * discarded by the client, never read by the route, and written into the audit
 * row as a hard-coded null — so the single most consequential write the venue
 * offers ("every bot stops quoting on the next pass") left no justification
 * behind at all.
 */
function setKillSwitch(db, { actor, on, reason }) {
  const why = reasonOr400(reason, on ? 'pull the kill switch' : 'release the kill switch');
  transaction(db, () => setSetting(db, KILL_SWITCH_KEY, on ? '1' : '0'));
  audit.record(db, actor, audit.ACTIONS.RISK_KILL_SWITCH, 'desk:risk', { kill_switch: !on }, { kill_switch: !!on }, why);
  return { kill_switch: !!on };
}

/**
 * Ensure a risk row exists for a bot, with the venue defaults. A missing row
 * is NOT "unlimited" here — unlike a user limit, an unconfigured market maker
 * with no cap is precisely the unbounded-loss case this module exists to
 * close. So the default is a real, finite cap.
 */
function ensureRiskRow(db, botId, defaults) {
  const existing = db.prepare('SELECT * FROM risk_bots WHERE bot_id = ?').get(botId);
  if (existing) return existing;
  db.prepare(
    `INSERT INTO risk_bots (bot_id, max_liability_cents, max_daily_loss_cents, quote_skew, enabled)
     VALUES (?, ?, ?, ?, 1)`
  ).run(botId, defaults.max_liability_cents, defaults.max_daily_loss_cents, defaults.quote_skew);
  return db.prepare('SELECT * FROM risk_bots WHERE bot_id = ?').get(botId);
}

/**
 * Roll the daily baseline when the UTC day changes.
 *
 * The baseline is a balance SNAPSHOT, not a sum of ledger rows, because the
 * bot's balance is total funds (frozen escrow does not move it) — so a balance
 * delta is exactly realised P&L, with no need to reclassify escrow noise.
 *
 * Rolled lazily on read rather than by a job: a bot that does not trade for
 * three days should be judged on the day it resumes, not on a stale baseline.
 */
function rollPeriod(db, row) {
  const today = db.prepare("SELECT date('now') AS d").get().d;
  if (row.period_start === today) return row;
  const bal = db.prepare('SELECT balance_cents b FROM users WHERE id = ?').get(row.bot_id);
  db.prepare('UPDATE risk_bots SET period_start = ?, day_start_balance = ? WHERE bot_id = ?')
    .run(today, bal ? bal.b : 0, row.bot_id);
  return db.prepare('SELECT * FROM risk_bots WHERE bot_id = ?').get(row.bot_id);
}

/**
 * The bot's live LAY liability: what the venue stands to pay out if every lay
 * the bot currently has loses.
 *
 * Why this and NOT "how negative is its balance":
 *
 *   A negative balance is ALREADY bounded by the escrow invariant — a bot
 *   cannot lay more than it has escrowed. Capping that would largely
 *   re-measure a guarantee the engine already provides, while leaving the
 *   genuinely uncovered number uncapped.
 *
 *   A lay at price P for stake s escrows (P-1)*s, but if it LOSES the venue
 *   pays the backer's pot of s*P. So the escrow held is NOT the venue's
 *   exposure — the payout is. That gap is where the unbounded loss lives,
 *   and it is this number that has to be bounded.
 *
 * Counted over OPEN markets only: a matched order on a settled market has
 * already been paid out, so including it would ratchet liability permanently
 * upward with every settlement.
 */
function layExposure(db, botId) {
  const r = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN o.side = 'lay' THEN CAST(ROUND((o.price - 1) * (o.stake_cents - o.matched_cents)) AS INTEGER) ELSE 0 END), 0) AS unmatched,
         COALESCE(SUM(CASE WHEN o.side = 'lay' THEN CAST(ROUND((o.price - 1) * o.matched_cents) AS INTEGER) ELSE 0 END), 0) AS matched
       FROM orders o
       JOIN markets m ON m.id = o.market_id
       WHERE o.user_id = ?
         AND m.status = 'open'
         AND o.status IN ('open', 'fully_matched')`
    )
    .get(botId);
  return { unmatched: r.unmatched, matched: r.matched, total: r.unmatched + r.matched };
}

/**
 * Full risk status for one bot.
 *
 * `pressure` is 0..1 — how close the bot is to its more urgent of the two
 * caps. It drives the skew, so both caps are honoured continuously rather
 * than as a cliff at the boundary: a bot at 90% of its liability is already
 * quoting wide, which slows the bleed before the cap is actually reached.
 *
 * `quoting_allowed` is the hard gate. When false, the bot places nothing.
 */
function status(db, botId, defaults) {
  const row = rollPeriod(db, ensureRiskRow(db, botId, defaults));
  const u = db.prepare('SELECT balance_cents b FROM users WHERE id = ?').get(botId);
  const balance = u ? u.b : 0;

  // Exposure the venue has actually taken on: its live lay liability.
  // NOT the negative balance — see layExposure() for why that would mostly
  // re-measure a guarantee the escrow invariant already provides.
  const exposure = layExposure(db, botId);
  const liability = exposure.total;
  // Realised P&L since the day's baseline. Negative is a loss.
  const dailyPnl = balance - row.day_start_balance;

  const liabPressure = row.max_liability_cents > 0 ? liability / row.max_liability_cents : 1;
  const lossPressure = row.max_daily_loss_cents > 0 ? Math.max(0, -dailyPnl) / row.max_daily_loss_cents : 1;
  const pressure = Math.min(1, Math.max(liabPressure, lossPressure));

  let allowed = true;
  let reason = null;
  if (killSwitch(db)) { allowed = false; reason = 'kill_switch'; }
  else if (!row.enabled) { allowed = false; reason = 'disabled'; }
  else if (dailyPnl <= -row.max_daily_loss_cents) { allowed = false; reason = 'daily_loss_cap'; }
  else if (liability >= row.max_liability_cents) { allowed = false; reason = 'liability_cap'; }

  return {
    bot_id: botId,
    balance_cents: balance,
    liability_cents: liability,
    daily_pnl_cents: dailyPnl,
    day_start_balance: row.day_start_balance,
    max_liability_cents: row.max_liability_cents,
    max_daily_loss_cents: row.max_daily_loss_cents,
    quote_skew: row.quote_skew,
    enabled: !!row.enabled,
    pressure,
    quoting_allowed: allowed,
    reason,
  };
}

/**
 * How many extra ticks to widen quotes by, given pressure.
 *
 * `quote_skew` is ticks at FULL pressure, scaled linearly. Zero skew means
 * "no widening" — which is the DEFAULT, and is worth saying plainly: a venue
 * that sets skew to zero gets hard caps and no gradual softening, so bots
 * keep quoting sharp right up to the cap and then vanish. Skew is what makes
 * the cap graceful rather than a cliff.
 */
function skewTicks(db, botId, defaults, maxSkewTicks) {
  const s = status(db, botId, defaults);
  if (!s.quoting_allowed) return null; // null = do not quote at all
  return Math.round(s.pressure * s.quote_skew * maxSkewTicks);
}

/** Update a bot's caps. Audited: these are the numbers bounding venue loss. */
function configure(db, { actor, botId, max_liability_cents, max_daily_loss_cents, quote_skew, enabled }) {
  // These throws carry a REAL 400, expressed here at the source.
  //
  // They used to be bare `new Error(...)`, which carries no status — and the
  // route then stamped 400 onto anything it caught to compensate. That
  // converted every genuine fault this function might hit (a SQLITE_BUSY while
  // a restore held the file, a constraint violation, a TypeError) into a 400
  // reading "your input was rejected". errorHandler only logs at status >= 500,
  // so a real server fault produced a 400 to the operator AND no log line at
  // all: a risk control that silently failed to apply.
  //
  // Saying 400 here means the route can pass everything else through
  // untouched, which is what makes the distinction survive.
  const cap = (v, field) => {
    if (v === undefined) return undefined;
    if (!Number.isInteger(v) || v <= 0) {
      throw httpError(400, `${field} must be a positive integer number of cents`);
    }
    return v;
  };
  const liab = cap(max_liability_cents, 'max_liability_cents');
  const loss = cap(max_daily_loss_cents, 'max_daily_loss_cents');
  if (quote_skew !== undefined && !(quote_skew >= 0 && quote_skew <= 1)) {
    throw httpError(400, 'quote_skew must be between 0 and 1');
  }
  return transaction(db, () => {
    const u = db.prepare('SELECT id, is_bot FROM users WHERE id = ?').get(botId);
    if (!u) throw httpError(404, 'No such bot');
    if (!u.is_bot) throw httpError(400, 'Risk caps apply to bot accounts only');
    ensureRiskRow(db, botId, { max_liability_cents: liab ?? 5000000, max_daily_loss_cents: loss ?? 1000000, quote_skew: quote_skew ?? 0.5 });
    const before = db.prepare('SELECT * FROM risk_bots WHERE bot_id = ?').get(botId);
    db.prepare(
      `UPDATE risk_bots SET
         max_liability_cents  = COALESCE(?, max_liability_cents),
         max_daily_loss_cents = COALESCE(?, max_daily_loss_cents),
         quote_skew           = COALESCE(?, quote_skew),
         enabled              = COALESCE(?, enabled)
       WHERE bot_id = ?`
    ).run(liab ?? null, loss ?? null, quote_skew ?? null, enabled === undefined ? null : (enabled ? 1 : 0), botId);
    const after = db.prepare('SELECT * FROM risk_bots WHERE bot_id = ?').get(botId);
    audit.record(db, actor, audit.ACTIONS.RISK_CONFIGURED, `bot:${botId}`,
      { max_liability_cents: before.max_liability_cents, max_daily_loss_cents: before.max_daily_loss_cents, quote_skew: before.quote_skew, enabled: !!before.enabled },
      { max_liability_cents: after.max_liability_cents, max_daily_loss_cents: after.max_daily_loss_cents, quote_skew: after.quote_skew, enabled: !!after.enabled },
      null);
    return after;
  });
}

/**
 * Desk view: every bot's exposure. A venue that cannot SEE its own
 * market-maker loss is a venue that discovers it by going bankrupt.
 */
function desk(db, defaults) {
  const bots = db.prepare('SELECT id, username FROM users WHERE is_bot = 1 ORDER BY id').all();
  return bots.map((b) => ({ username: b.username, ...status(db, b.id, defaults) }));
}

module.exports = {
  KILL_SWITCH_KEY,
  MIN_REASON,
  MAX_REASON,
  reasonOr400,
  killSwitch,
  setKillSwitch,
  ensureRiskRow,
  layExposure,
  status,
  skewTicks,
  configure,
  desk,
};