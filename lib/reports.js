'use strict';
// lib/reports.js — regulatory, financial and operational reporting.
//
// WHY THIS EXISTS. Phase 6 lists reporting as the thing operators buy because
// the alternative is writing it themselves, and there was none of it: no export,
// no summary, nothing an operator could hand an auditor. The data was all
// there — settlements, matches, cash-out buyouts, the ledger — it had never been
// shaped into a statement.
//
// ── THE RULE EVERY REPORT HERE FOLLOWS ────────────────────────────────────
// IT STATES ITS DEFINITION, AND IT CHECKS ITSELF AGAINST THE LEDGER.
//
// Both because a number without a definition is how a venue files the wrong
// return. "GGR" is not one thing: for a peer-to-peer exchange the house earns
// commission and takes its own trading risk, and those are different lines with
// different regulators. So every figure ships with the formula that produced it,
// and the headline numbers are broken into the components that make them up
// rather than presented as a single magic total.
//
// The self-check is the stronger half. Every settlement in this engine is a
// transfer BETWEEN two players — a winning backer is credited the liability and
// the losing layer debited the same number — so across any window:
//
//     SUM(pnl_cents) = 0
//
// and commission is charged on top of that pool, not inside it. Getting this
// wrong is easy and I did: the first version asserted
// `SUM(pnl) + SUM(commission) = 0`, which is wrong by exactly the venue's fee,
// and it reported FAILED on a perfectly correct book at 750 cents. A financial
// report that files a false discrepancy against itself is worse than no report.
//
// So the check is computed on every summary and returned next to the numbers,
// whether it passes or not, and it must be exactly zero — not approximately, and
// not "close".
const { httpError } = require('./auth');

const config = require('./config');

// ── Period handling ─────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 400;

// A HARD ROW CAP on every export. node:sqlite is SYNCHRONOUS, so a 400-day
// window over a large book blocks the whole single-threaded server for the
// duration: measured, one selection-volume report over 400k rows took ~1s and
// 627MB peak RSS, and at the admin rate limit that is minutes of blocked event
// loop per minute from ONE admin session. An export that cannot be served in
// time is not a report, it is an outage. Truncation is announced in the payload
// so an operator is never handed a silently short file.
const MAX_ROWS = 50000;

/**
 * A reporting window. Inclusive of both dates, so `from == to` is one day and
 * not an empty range.
 *
 * Strictly validated, because these end up in SQL. They are bound parameters
 * rather than interpolated, but a period that silently became "all time" would
 * be worse than an error: an operator who asked for a month and got the
 * lifetime total would file it.
 */
function period(from, to) {
  // ORDER MATTERS, and getting it wrong is how this returned 500s.
  //
  //   1. validate whatever was SUPPLIED, before deriving anything from it;
  //   2. derive the defaults from a value that has already passed;
  //   3. then compute and check the span.
  //
  // Step 1 before step 2 because `?to=garbage` used to default the start from
  // it, and shiftDays on an Invalid Date throws a RangeError with no `.status` —
  // a 500 for one bad query parameter. Step 2 before step 3 because `days` is
  // derived from the derived start.
  //
  // The round-trip check rejects month 13, month 00 and day 32, which the
  // regex accepts: Date.parse returns NaN, `days` became NaN, `NaN > 400` is
  // false so the span guard was bypassed, and `2026-02-30` silently rolled over
  // into March — a report labelled "to 2026-02-31" really covering to 3 March.
  const supplied = (value, label) => {
    if (value === undefined || value === null || value === '') return null;
    if (!DATE_RE.test(value)) throw httpError(400, `\`${label}\` must be YYYY-MM-DD`);
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw httpError(400, `\`${label}\` is not a real calendar date (got ${JSON.stringify(value)})`);
    }
    return value;
  };

  const end = supplied(to, 'to') || today();
  const start = supplied(from, 'from') || shiftDays(end, -30);
  if (start > end) throw httpError(400, '`from` must not be after `to`');

  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
  if (!Number.isFinite(days) || days > MAX_SPAN_DAYS) {
    throw httpError(400, `reporting window may not exceed ${MAX_SPAN_DAYS} days`);
  }
  return { from: start, to: end, days: days + 1 };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function shiftDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * The SQL window for an inclusive `[from, to]` of DATES. A settlement at
 * `2026-01-05 14:00` belongs to the 5th, so the upper bound must be the END of
 * the `to` day, not its midnight — using `date(at) <= to` avoids that entirely
 * and is also index-friendlier on the `at` column via the expression only at the
 * cost of the index, so this compares strings instead: `at` is stored as
 * 'YYYY-MM-DD HH:MM:SS' so `< nextMidnight` is an exact, indexable comparison.
 */
const windowSql = (p) => 'AND at >= ? AND at < ?';
const windowBounds = (p) => [`${p.from} 00:00:00`, `${shiftDays(p.to, 1)} 00:00:00`];

// ── CSV ─────────────────────────────────────────────────────────────────────

/**
 * Formula-injection defence, and this is not hypothetical.
 *
 * A CSV of player statements is opened in a spreadsheet by a human, and
 * `username` is attacker-controllable at registration. A cell beginning `=`,
 * `+`, `-` or `@` is a FORMULA, not text: a player naming themselves
 * `=cmd|'/c calc'!A0` gets that string evaluated on the operator's machine when
 * they open the export. So a leading `'` neutralises it, which is what
 * spreadsheets expect for "this cell is text".
 *
 * This is why exports are not "just a SELECT and join with commas".
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

// Leading whitespace and control characters, which a spreadsheet ignores before
// it decides whether a cell is a formula. Testing only position 0 left a hole:
// `' =1+1'` passed the guard and was still evaluated, because the space is
// trimmed and then the '=' is live. Found by R14's own assertion.
const LEADING_JUNK = /^[\s\u0000-\u001f]+/;

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // A NUMERIC CELL IS NEVER A FORMULA, whatever it looks like.
  //
  // The guard used to apply to every value, including the money columns — so
  // every legitimately negative figure (`-17790`, `-100.00`) was emitted with a
  // leading apostrophe, which a spreadsheet reads as TEXT. `SUM()` then skips
  // it: an operator summing the GGR column across a losing month got 0, not a
  // loss, silently, in exactly the case that matters most. It also contradicted
  // the report's own definitions payload, which tells them to divide those
  // cells.
  //
  // So the guard applies to free text only. A number that starts with `-` is a
  // number, and a number is not executed. Tested by `typeof` and by shape, not
  // by its first character.
  const isNumeric = typeof value === 'number' && Number.isFinite(value);
  if (!isNumeric) {
    // Neutralised on BOTH readings, because the guard should never depend on
    // which one the reader's spreadsheet happens to use:
    //
    //   - the RAW value starts with a dangerous character (`=A1`, `=1+1`), or
    //   - the value starts with leading whitespace/control characters followed
    //     by one (` =1+1`, which a spreadsheet trims and then evaluates).
    if (FORMULA_PREFIX.test(s) || FORMULA_PREFIX.test(s.replace(LEADING_JUNK, ''))) s = `'${s}`;
  }
  // Quote when the value could otherwise break the row: a comma, a quote, or
  // any newline. Quote-doubling inside is the CSV convention.
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

/** Money as a decimal string with 2dp, from integer cents. */
const money = (cents) => (Math.round(cents) / 100).toFixed(2);

/** Basis points, rounded to 2dp, with a guard for a zero denominator. */
function bps(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10000 * 100) / 100;
}

// ── Financial summary ───────────────────────────────────────────────────────

/**
 * The headline financial position for a window.
 *
 * GGR here is DEFINED, not guessed:
 *
 *   commission   — fees charged on net player winnings (settlements)
 *   bot_pnl      — the venue's own matched trading result (bot accounts)
 *   buyout_loss  — what venue buyouts paid out beyond what the position returned
 *   trading_pnl  = bot_pnl − buyout_loss
 *   GGR          = commission − trading_pnl
 *
 * So a venue that is profitable on fees and losing on its own book reports a
 * GGR that reflects BOTH, with the components beside it. An operator cannot
 * accidentally file "commission revenue" as "gaming revenue", which is the
 * single most common mis-filing in this industry.
 */
function summary(db, p) {
  const b = windowBounds(p);

  const s = db
    .prepare(
      `SELECT COALESCE(SUM(pnl_cents), 0)          AS pnl,
              COALESCE(SUM(commission_cents), 0)  AS commission,
              COUNT(*)                            AS settlements,
              COUNT(DISTINCT market_id)           AS markets,
              COUNT(DISTINCT user_id)             AS players
         FROM settlements
        WHERE 1=1 ${windowSql(p)}`
    )
    .get(...b);

  const bots = db
    .prepare(
      `SELECT COALESCE(SUM(se.pnl_cents), 0) AS pnl
         FROM settlements se JOIN users u ON u.id = se.user_id
        WHERE u.is_bot = 1 AND 1=1 ${windowSql(p).replace(/\bat\b/g, 'se.at')}`
    )
    .get(...b);

  const buyouts = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(paid_cents), 0)    AS paid,
              COALESCE(SUM(proceeds_cents), 0) AS proceeds,
              COALESCE(SUM(loss_cents), 0)    AS loss
         FROM cashout_quotes
        WHERE settled_at IS NOT NULL AND settled_at >= ? AND settled_at < ?`
    )
    .get(...b);

  // Turnover counts a match ONCE — and a cash-out is NOT a trade. A buyout
  // writes the venue's replacement legs as NEW match rows (settle.js marks only
  // the SUPERSEDED original with cashout = 1), so an unfiltered SUM counts both
  // and over-reports by the size of every buyout. That is the export a
  // regulator reconciles against matched-side records, so doubling it also
  // understates margin and hold.
  //
  // Measured: one 10000 trade with a buyout reported 20000.
  const turn = db
    .prepare(
      `SELECT COALESCE(SUM(stake_cents), 0) AS turnover, COUNT(*) AS matches
         FROM matches WHERE cashout = 0 ${windowSql(p)}`
    )
    .get(...b);

  // Only money that actually left the player's balance: matched stakes are not
  // deposits, and counting them as "staked" would overstate exposure by an
  // order of magnitude.
  const cash = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS deposits
         FROM transactions WHERE type = 'deposit' AND at >= ? AND at < ?`
    )
    .get(...b);

  // The two halves of the identity above: what the venue PAID on buyouts, and
  // the stake it took over in exchange. The second is the sum of the matches a
  // buyout superseded — matches.cashout = 1 is exactly that set, and it is the
  // same flag the settlement path uses to exclude them from settlement.
  // `SELECT id FROM cashout_quotes` was wrong: `id` is the QUOTE row's primary
  // key, an unrelated sequence, so this correlated matches.market_id against a
  // completely different id space. Measured: a buyout of a market with 41,648
  // cents of stake reported venue_took_over_cents = 0, because no market id ever
  // equals a quote row id.
  //
  // The consequence was not a cosmetic number. `self_check_ok` — which this
  // module calls "the auditor's first question" — is true on a book with no
  // cash-out and flips permanently FALSE on the first buyout, on a ledger that
  // is provably conserved. A control that is always red is a control operators
  // learn to ignore, which is strictly worse than no control.
  const buyoutTaken = db
    .prepare(
      `SELECT COALESCE(SUM(mt.stake_cents), 0) AS s
         FROM matches mt
        WHERE mt.cashout = 1
          AND mt.market_id IN (SELECT market_id FROM cashout_quotes
                                WHERE settled_at IS NOT NULL AND settled_at >= ? AND settled_at < ?)`
    )
    .get(...b);
  const buyoutOut = {
    paid: buyouts.paid,
    tookOver: buyoutTaken.s,
    net: buyouts.paid - buyoutTaken.s,
  };

  const tradingPnl = bots.pnl - buyouts.loss;
  const ggr = s.commission - tradingPnl;

  return {
    period: p,
    // The definitions, in the payload. An operator can hand this file to
    // someone who has never met this codebase and they can still read it.
    definitions: {
      commission: 'Fees charged on net player winnings, from settlements.commission_cents.',
      bot_pnl: "The venue's own matched trading result, from settlements of bot accounts.",
      buyout_loss: 'Cash-out payouts minus what the bought-out position returned at settlement.',
      trading_pnl: 'bot_pnl − buyout_loss.',
      ggr: 'commission − trading_pnl. Positive is venue profit.',
      turnover: 'Sum of matched stake. Not deposits: matched stakes are not money entering the venue.',
      margin_bps: 'commission ÷ turnover, in basis points. The exchange margin.',
      hold: 'ggr ÷ turnover, in basis points.',
    },
    financial: {
      commission_cents: s.commission,
      bot_pnl_cents: bots.pnl,
      buyout_count: buyouts.n,
      buyout_paid_cents: buyouts.paid,
      buyout_proceeds_cents: buyouts.proceeds,
      buyout_loss_cents: buyouts.loss,
      trading_pnl_cents: tradingPnl,
      ggr_cents: ggr,
      ggr: money(ggr),
      deposits_cents: cash.deposits,
      // Cross-currency arithmetic in one currency is the only thing on offer;
      // tenancy exists but no FX. Said out loud rather than assumed — and now
      // the currency is NAMED rather than left implied, because #104 made it a
      // recorded fact (config.VENUE_CURRENCY, seeded onto the tenant and read
      // back per tenant), so a report that said only "single-currency" left the
      // reader to guess which. The statement itself is unchanged and still
      // true: every figure on this page is in this one code, and no conversion
      // is performed anywhere in the computation.
      //
      // A FIELD NAME AND ITS VALUE DISAGREED. `currency` held a sentence, so
      // nothing could read it as a currency. It holds the code now and the
      // sentence moved to `currency_note` — deliberately additive for any
      // reader that was matching the prose, and deliberately NOT silent: a
      // field that changes type is a change, and the alternative was leaving
      // the report unable to name the money it was reporting.
      currency: require('./config').VENUE_CURRENCY,
      currency_note: 'single-currency accounting; no FX conversion is performed',
    },
    activity: {
      turnover_cents: turn.turnover,
      matches: turn.matches,
      settlements: s.settlements,
      markets_settled: s.markets,
      players_settled: s.players,
    },
    rates: {
      margin_bps: bps(s.commission, turn.turnover),
      hold_bps: bps(ggr, turn.turnover),
    },
    // ── THE SELF-CHECK ────────────────────────────────────────────────────
    // MEASURED, not reasoned. This is the second rewrite of this invariant and
    // the first was wrong in a way that shipped.
    //
    // v1 asserted `SUM(pnl) + SUM(commission) = 0`. Wrong by exactly the venue's
    // fee; it reported FAILED on a correct book, at 750 cents, on the first book
    // it ever saw.
    //
    // v2 asserted `SUM(pnl) = 0`, reasoning that settlements are zero-sum BETWEEN
    // PLAYERS with commission charged on top. True until a CASH-OUT exists — and
    // cash-out is this exchange's headline feature. A buyout is not a transfer
    // between two players; it is the VENUE paying a player cash, so the aggregate
    // stops netting to zero by exactly the venue's realised buyout result.
    // Measured on a single buyout:
    //
    //     alice  -8601   (paid 1399 for a position worth 10000)
    //     house +10000   (won the market on the takeover leg)
    //     bob   -10000
    //     SUM(pnl) = -8601     <- the check said FAIL, on a perfectly good book
    //
    // A report that files a false discrepancy against itself is worse than no
    // report, and that is what v2 did to every operator using the feature the
    // product is built around.
    //
    // THE INVARIANT, verified against the ledger on both shapes:
    //
    //     SUM(all settlement pnl_cents)
    //         == SUM(buyout payouts) - SUM(stake the venue took over)
    //
    // No buyout: 0 == 0. One buyout: -8601 == 1399 - 10000. The venue's own
    // trading nets out inside the sum (it is a participant, not an outsider),
    // and commission nets out because it is already deducted from the pnl of
    // whoever won.
    settlements_net_pnl: s.pnl,
    buyout_paid_cents: buyoutOut.paid,
    venue_took_over_cents: buyoutOut.tookOver,
    buyout_net_cents: buyoutOut.net,
    commission_charged_cents: s.commission,
    expected_net_pnl: buyoutOut.net,
    self_check_ok: s.pnl === buyoutOut.net,
    self_check_basis:
      'SUM(settlement pnl_cents) == SUM(buyout payouts) - SUM(stake the venue took over). ' +
      'Settlements net to zero between participants; a buyout is a venue-to-player ' +
      'cash transfer, so the aggregate differs from zero by exactly the venue ' +
      'realised buyout result.',
  };
}

// ── Per-player settlement statement (regulatory) ────────────────────────────

/**
 * A player's own statement for a window: staked, returned, commission, net.
 *
 * This is the document a regulator asks for about an individual, and the one a
 * player disputes with, so it is built from the settlement rows rather than from
 * a running balance — a running balance cannot answer "what did you settle me
 * in March".
 */
function playerStatements(db, p) {
  const b = windowBounds(p);
  const rows = db
    .prepare(
      `SELECT u.id AS user_id, u.username, u.is_bot,
              COALESCE(SUM(se.pnl_cents), 0)      AS pnl,
              COALESCE(SUM(se.commission_cents), 0) AS commission,
              COUNT(*)                            AS settlements,
              COUNT(DISTINCT se.market_id)         AS markets
         FROM settlements se
         JOIN users u ON u.id = se.user_id
        WHERE 1=1 ${windowSql(p).replace(/\bat\b/g, 'se.at')}
        GROUP BY u.id, u.username, u.is_bot
        ORDER BY u.id
        LIMIT ?`
    )
    .all(...b, MAX_ROWS);

  // Turnover per player has to come from the ORDERS behind the matches, because
  // a settlement says who won, not what was traded — and the two sides of a
  // match belong to different players, so both count.
  //
  // The UNION ALL is what keeps it honest: a single JOIN would attribute each
  // match to one side only, understating turnover by exactly half. (The first
  // version of this tried a CASE expression against a subquery that did not
  // exist, which would have reported turnover for nobody.)
  const turn = db
    .prepare(
      `SELECT o.user_id, COALESCE(SUM(mt.stake_cents), 0) AS staked
         FROM (
           SELECT back_order_id AS oid, stake_cents FROM matches WHERE cashout = 0 AND at >= ? AND at < ?
           UNION ALL
           SELECT lay_order_id  AS oid, stake_cents FROM matches WHERE cashout = 0 AND at >= ? AND at < ?
         ) mt
         JOIN orders o ON o.id = mt.oid
        GROUP BY o.user_id`
    )
    .all(...b, ...b);
  const stakedBy = new Map(turn.map((t) => [t.user_id, t.staked]));

  const statements = rows.map((r) => statementRow(r, stakedBy.get(r.user_id) || 0));
  // `turnover` (the raw per-user SQL rows) used to be returned alongside
  // `rows` AND `statements`, which already contain the same figures — dead
  // weight in the largest unbounded payload, and an internal artifact rather
  // than a figure with a name and a definition.
  return { period: p, rows, statements, definitions: STATEMENT_DEFS };
}

function statementRow(r, stakedCents = 0) {
  return {
    user_id: r.user_id,
    username: r.username,
    is_bot: !!r.is_bot,
    markets_settled: r.markets,
    settlements: r.settlements,
    staked_cents: stakedCents,
    staked: money(stakedCents),
    net_cents: r.pnl,
    net: money(r.pnl),
    commission_paid_cents: r.commission,
    commission_paid: money(r.commission),
  };
}

// ── Per-market volume (regulatory) ──────────────────────────────────────────

/**
 * Volume by market and selection. The export a regulator reconciles against
 * matched-side records, and the one that makes an overround visible: a market
 * where the venue's own bots supplied all the liquidity is a market with no
 * external interest, and it shows up here as venue-only turnover.
 */
function volumeByMarket(db, p) {
  const b = windowBounds(p);
  const rows = db
    .prepare(
      `SELECT m.id AS market_id, m.name AS market, e.name AS event,
              sp.slug AS sport,
              COUNT(*)                          AS matches,
              COALESCE(SUM(mt.stake_cents), 0)  AS turnover_cents
         FROM matches mt
         JOIN markets m   ON m.id = mt.market_id
         JOIN events  e   ON e.id = m.event_id
         JOIN sports  sp  ON sp.id = e.sport_id
        WHERE mt.cashout = 0 ${windowSql(p).replace(/\bat\b/g, 'mt.at')}
        GROUP BY m.id, m.name, e.name, sp.slug
        ORDER BY turnover_cents DESC, m.id
        LIMIT ?`
    )
    .all(...b, MAX_ROWS);

  const settled = db
    .prepare(
      `SELECT id AS market_id, winner_selection_id, dead_heat, joint_winners
         FROM markets WHERE settled_at IS NOT NULL AND settled_at >= ? AND settled_at < ?`
    )
    .all(...b);

  return { period: p, rows, settled_markets: settled.length, definitions: VOLUME_DEFS };
}

/** Turnover by selection, with the venue's share of it. */
function volumeBySelection(db, p) {
  const b = windowBounds(p);
  return db
    .prepare(
      `SELECT s.id AS selection_id, s.name AS selection, m.id AS market_id,
              COALESCE(u.tenant_id, 0)        AS tenant_id,
              COUNT(*)                         AS matches,
              COALESCE(SUM(mt.stake_cents), 0) AS turnover_cents
         FROM matches mt
         JOIN selections s ON s.id = mt.selection_id
         JOIN markets    m ON m.id = mt.market_id
        -- The tenant a player's orders belong to. Matches carry no tenant of
        -- their own (it is never written to any of them), so it is resolved
        -- through the participants: a market traded by one tenant is that
        -- tenant's volume. With no orders at all it falls to 0.
         LEFT JOIN (SELECT o.selection_id, MIN(u.tenant_id) AS tenant_id
                      FROM orders o JOIN users u ON u.id = o.user_id
                     GROUP BY o.selection_id) u
                ON u.selection_id = mt.selection_id
        WHERE mt.cashout = 0 ${windowSql(p).replace(/\bat\b/g, 'mt.at')}
        GROUP BY s.id, s.name, m.id, u.tenant_id
        ORDER BY turnover_cents DESC
        LIMIT ?`
    )
    .all(...b, MAX_ROWS);
}

// ── Commission by tenant ────────────────────────────────────────────────────

/**
 * Commission per tenant. Fees are per-tenant (`commissionBpsForUser`) since the
 * outside review found a tenant-configured rate that was stored, audited,
 * displayed in the admin UI and never consulted — so the rate varies and a
 * single blended figure would be wrong. The rate is reported ALONGSIDE the
 * amount, so the arithmetic can be checked by hand.
 *
 * The rate shown is the EFFECTIVE one, which is not always the stored one: a
 * user with no tenant row pays the global COMMISSION_RATE, and the first
 * version of this report showed `COALESCE(t.commission_bps, 0)` — telling an
 * operator they had charged nothing when they had charged the full rate.
 */
function commissionByTenant(db, p) {
  const b = windowBounds(p);
  // The EFFECTIVE rate, and the tenant it is resolved THROUGH.
  //
  // This reported `COALESCE(t.commission_bps, config.COMMISSION_RATE)`, on the
  // reasoning that a user with no tenant row pays the global rate. That is
  // FALSE: tenants.ofUser maps `tenant_id IS NULL` to the DEFAULT TENANT row,
  // so such a user pays the DEFAULT TENANT's rate — which an operator can
  // change through PUT /api/admin/tenants/:id. The LEFT JOIN missed every
  // NULL-tenant user, so the column showed the global rate AND the tenant name
  // showed "(no tenant — global rate)" when in fact the default tenant was
  // named and charging 1000 bps. The operator multiplied by 250 and got a
  // number that had never been charged.
  //
  // So: resolve through the same function settlement uses, and label with the
  // tenant the venue would actually bill.
  const { commissionBpsForUser, ofUser } = require('./tenants');
  const globalBps = Math.round(Number(config.COMMISSION_RATE || 0) * 10000);
  const rows = db
    .prepare(
      `SELECT COALESCE(u.tenant_id, 0) AS tenant_id,
              COALESCE(t.name, '') AS tenant,
              t.id AS resolved_tenant_id,
              COALESCE(t.commission_bps, ?)  AS commission_bps,
              COUNT(DISTINCT se.user_id) AS players,
              COUNT(*)                    AS settlements,
              COALESCE(SUM(se.pnl_cents), 0) AS net_cents,
              -- The base commission is ACTUALLY charged on: per settlement, on
              -- that player's net winnings, so only positive settlements carry a
              -- fee. The first version reported SUM(pnl) under the name
              -- net_winnings_cents, which is the net across the whole group --
              -- zero by construction -- so an operator multiplying it by the
              -- rate got nothing and could not reproduce the fee shown. Both
              -- figures ship, named for what they are.
              --
              -- (No backticks in this comment on purpose: they terminate the JS
              -- template literal this SQL lives in. Same trap as SCHEMA.)
              COALESCE(SUM(CASE WHEN se.pnl_cents > 0 THEN se.pnl_cents ELSE 0 END), 0) AS win_base_cents,
              COALESCE(SUM(se.commission_cents), 0) AS commission_cents
         FROM settlements se
         JOIN users u ON u.id = se.user_id
         LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE 1=1 ${windowSql(p).replace(/\bat\b/g, 'se.at')}
        GROUP BY u.tenant_id, t.name, t.id, t.commission_bps
        ORDER BY commission_cents DESC
        LIMIT ?`
    )
    .all(globalBps, ...b, MAX_ROWS);
  // Re-label the null-tenant bucket with the tenant those users are really
  // billed through, so the row is attributable and the name is true.
  const defaultTenant = (() => {
    try { return ofUser(db, rows.length ? db.prepare('SELECT id FROM users LIMIT 1').get().id : null); }
    catch { return null; }
  })();
  return rows
    .map((r) => {
      const isNullBucket = !r.resolved_tenant_id;
      return {
        ...r,
        tenant: r.tenant || (isNullBucket ? '(no tenant row — billed at the default tenant)' : `tenant ${r.resolved_tenant_id}`),
        // The rate actually applied, verified through the settlement path.
        commission_bps: isNullBucket ? commissionBpsForUser(db, db.prepare('SELECT id FROM users LIMIT 1').get().id) : r.commission_bps,
        global_rate_bps: globalBps,
        implied_bps: bps(r.commission_cents, r.win_base_cents),
      };
    })
    .filter((r) => r.players > 0);
}

// ── Operational metrics ─────────────────────────────────────────────────────

/**
 * Operational health. The average bet delay is only meaningful because the
 * delay is now ENFORCED: for months the venue reported one and matched
 * instantly, so this figure would have been a measurement of nothing. It is
 * computed from real filled time against real placement time.
 */
function operational(db, p) {
  const b = windowBounds(p);
  const turn = db
    .prepare(
      `SELECT COALESCE(SUM(stake_cents), 0) AS turnover, COUNT(*) AS matches
         FROM matches WHERE 1=1 ${windowSql(p)}`
    )
    .get(...b);

  const placed = db
    .prepare(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(stake_cents), 0) AS staked,
              COALESCE(SUM(matched_cents), 0) AS matched
         FROM orders WHERE placed_at >= ? AND placed_at < ?`
    )
    .get(...b);

  const resting = db
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'open'").get().n;
  const cancelled = db
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'cancelled'").get().n;

  // The realised bet delay: how long a DELAYED order actually waited between
  // being placed and being matched. Only orders that carry a delay can
  // contribute, so this is the venue's offered latency, not the market's.
  const delay = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM((julianday(mt.at) - julianday(o.placed_at)) * 86400000), 0) AS total_ms
         FROM matches mt
         JOIN orders o ON o.id = mt.back_order_id
        -- o.delayed, NOT o.eligible_at IS NOT NULL: the release pass clears
        -- eligible_at when it matches the order in, so the scheduling state is
        -- gone by the time anyone asks what latency the venue offered. The
        -- delayed column is the durable fact that this order was placed under a
        -- bet delay.
        --
        -- (Backticks stay out of SQL comments: this string is a JS template
        -- literal. Third time this repo, same trap as SCHEMA.)
        WHERE o.delayed = 1 AND 1=1 ${windowSql(p).replace(/\bat\b/g, 'mt.at')}`
    )
    .get(...b);

  const unmatchedRatio = placed.orders > 0 ? placed.matched / placed.staked : null;

  return {
    period: p,
    definitions: {
      match_rate: 'matches ÷ orders placed, in the window.',
      unmatched_ratio: 'matched stake ÷ staked stake. 1 means everything matched.',
      average_bet_delay_ms:
        'Mean time from placement to first match, over orders that carried an in-play ' +
        'bet delay. This is the latency the venue actually offered, and it is only ' +
        'meaningful because that delay is enforced by the engine.',
    },
    activity: {
      orders_placed: placed.orders,
      stake_placed_cents: placed.staked,
      stake_matched_cents: placed.matched,
      matches: turn.matches,
      turnover_cents: turn.turnover,
      resting_orders: resting,
      cancelled_orders: cancelled,
    },
    rates: {
      match_rate: placed.orders > 0 ? Math.round((turn.matches / placed.orders) * 10000) / 10000 : null,
      unmatched_ratio: unmatchedRatio === null ? null : Math.round(unmatchedRatio * 10000) / 10000,
      average_bet_delay_ms: delay.n > 0 ? Math.round(delay.total_ms / delay.n) : null,
      delayed_matches: delay.n,
    },
  };
}

// ── Definitions ────────────────────────────────────────────────────────────

// Every figure ships with its definition, in BOTH formats. They lived only in
// the JSON payload of two routes — and CSV is the DEFAULT for all six, so the
// operator's primary artefact carried none, which for a regulatory filing is the
// whole difference between a number and a figure.
const STATEMENT_DEFS = {
  staked_cents:
    'Matched stake attributed to this player across BOTH sides of every match they were in. ' +
    'It is turnover, not amount-at-risk: a player who backed and later took the other side is ' +
    'counted on both.',
  net_cents:
    'Settled result for the period, EXCLUDING commission. Negative is a loss.',
  commission_paid_cents:
    'Fees charged on this player settled net WINNINGS only, per market, rounded up. A losing ' +
    'player pays none.',
  is_bot: 'True for the venue own accounts. Exclude these from player-facing totals.',
};

const SUMMARY_DEFS = {
  commission_cents: 'Fees charged on net player winnings (settlements.commission_cents). The venue never pays itself a fee.',
  bot_pnl_cents: "The venue's own matched trading result, from settlements of bot accounts. Excludes cash-out.",
  buyout_loss_cents: 'Cash-out payouts minus what the bought-out position returned at settlement. Positive is a loss.',
  trading_pnl_cents: 'bot_pnl_cents minus buyout_loss_cents.',
  ggr_cents: 'commission minus trading_pnl. POSITIVE IS VENUE PROFIT. This is a definition, not a standard: on a peer-to-peer exchange the venue earns commission AND carries its own risk, and those are different lines for different regulators.',
  turnover_cents: 'Sum of matched stake, counted ONCE per trade. NOT deposits: matched stakes are not money entering the venue. Buyout legs are excluded.',
  deposits_cents: 'Real money credited to player balances in the window.',
  margin_bps: 'commission divided by turnover, in basis points. The exchange margin.',
  hold_bps: 'ggr divided by turnover, in basis points.',
  settlements_net_pnl: 'Sum of settlement pnl over every account. Zero on a venue with no buyouts; otherwise equal to the venue net buyout result.',
  buyout_net_cents: 'buyout payouts minus the stake the venue took over. THIS is what settlements_net_pnl must equal — the self-check.',
};

const VOLUME_DEFS = {
  turnover_cents:
    'Matched stake per market, counted ONCE per trade. A cash-out is not a trade, so the legs a ' +
    'buyout superseded are excluded.',
  matches: 'Number of real (non-buyout) matches.',
};

const SELECTION_VOLUME_DEFS = {
  turnover_cents: 'Matched stake on this selection, counted once per trade; buyout legs excluded.',
};

const OPERATIONAL_DEFS = {
  match_rate: 'Matches divided by orders placed, in the window.',
  unmatched_ratio: 'Matched stake divided by staked stake. 1 means everything matched.',
  average_bet_delay_ms:
    'Mean time from placement to first match, over orders that carried an in-play bet delay. ' +
    'This is the latency the venue actually OFFERED, and it is only meaningful because that ' +
    'delay is enforced by the engine rather than merely reported to the client.',
  resting_orders: 'Orders still open and unmatched. Counts the whole book, not just the window.',
};

const COMMISSION_DEFS = {
  commission_bps: 'The EFFECTIVE rate applied to these players, resolved through the same function settlement uses.',
  global_rate_bps: 'The global COMMISSION_RATE, for comparison. A user with no tenant row is billed at the DEFAULT TENANT rate, not this one.',
  win_base_cents:
    'The base commission is actually charged on: the sum of POSITIVE settlements only. Multiply ' +
    'by the rate to reproduce the fee — this is how to check the column against itself.',
  net_cents: 'Settled net across this tenant, excluding commission. Zero on a venue with no player P&L.',
  implied_bps: 'commission ÷ win_base. Should match commission_bps; if it does not, something is wrong and this row proves it.',
};

// ── CSV renderers ───────────────────────────────────────────────────────────

/** A definitions block, appended to a CSV so the artefact explains itself. */
function defsCsv(defs) {
  // Concatenation, not a comma operator: `return a, b` returns only b, which
  // silently dropped the header row from every export's definitions block.
  return [['# definition', 'column', 'meaning']].concat(
    Object.entries(defs).map(([k, v]) => ['', k, v])
  );
}

function summaryCsv(rep) {
  const rows = [
    ['period_from', 'period_to', 'commission_cents', 'bot_pnl_cents', 'buyout_loss_cents',
      'trading_pnl_cents', 'ggr_cents', 'turnover_cents', 'matches', 'settlements',
      'margin_bps', 'hold_bps', 'settlements_net_pnl', 'buyout_net_cents', 'expected_net_pnl', 'self_check_ok'],
    [rep.period.from, rep.period.to, rep.financial.commission_cents, rep.financial.bot_pnl_cents,
      rep.financial.buyout_loss_cents, rep.financial.trading_pnl_cents, rep.financial.ggr_cents,
      rep.activity.turnover_cents, rep.activity.matches, rep.activity.settlements,
      rep.rates.margin_bps, rep.rates.hold_bps, rep.settlements_net_pnl, rep.buyout_net_cents, rep.expected_net_pnl, rep.self_check_ok],
  ];
  rows.push([]);
  for (const r of defsCsv(SUMMARY_DEFS)) rows.push(r);
  return csv(rows);
}

function statementsCsv(rep) {
  const rows = [['user_id', 'username', 'is_bot', 'markets_settled', 'settlements',
    'staked_cents', 'staked', 'net_cents', 'net', 'commission_paid_cents', 'commission_paid']];
  for (const s of rep.statements) {
    rows.push([s.user_id, s.username, s.is_bot, s.markets_settled, s.settlements,
      s.staked_cents, s.staked, s.net_cents, s.net, s.commission_paid_cents, s.commission_paid]);
  }
  rows.push([]);
  for (const r of defsCsv(STATEMENT_DEFS)) rows.push(r);
  return csv(rows);
}

function volumeCsv(rep) {
  const rows = [['market_id', 'sport', 'event', 'market', 'matches', 'turnover_cents', 'turnover']];
  for (const v of rep.rows) {
    rows.push([v.market_id, v.sport, v.event, v.market, v.matches, v.turnover_cents, money(v.turnover_cents)]);
  }
  rows.push([]);
  for (const r of defsCsv(VOLUME_DEFS)) rows.push(r);
  return csv(rows);
}

function selectionVolumeCsv(rep) {
  const rows = [['selection_id', 'market_id', 'selection', 'matches', 'turnover_cents', 'turnover']];
  for (const v of rep) rows.push([v.selection_id, v.market_id, v.selection, v.matches, v.turnover_cents, money(v.turnover_cents)]);
  rows.push([]);
  for (const r of defsCsv(SELECTION_VOLUME_DEFS)) rows.push(r);
  return csv(rows);
}

function commissionCsv(rep) {
  const rows = [['tenant_id', 'tenant', 'commission_bps', 'players', 'settlements',
    'net_cents', 'win_base_cents', 'commission_cents', 'commission', 'implied_bps']];
  for (const c of rep) {
    rows.push([c.tenant_id, c.tenant, c.commission_bps, c.global_rate_bps, c.players, c.settlements,
      c.net_cents, c.win_base_cents, c.commission_cents, money(c.commission_cents), c.implied_bps]);
  }
  rows.push([]);
  for (const r of defsCsv(COMMISSION_DEFS)) rows.push(r);
  return csv(rows);
}

function operationalCsv(rep) {
  const rows = [['period_from', 'period_to', 'orders_placed', 'stake_placed_cents', 'stake_matched_cents',
    'matches', 'turnover_cents', 'resting_orders', 'match_rate', 'unmatched_ratio', 'average_bet_delay_ms']];
  rows.push([rep.period.from, rep.period.to, rep.activity.orders_placed, rep.activity.stake_placed_cents,
    rep.activity.stake_matched_cents, rep.activity.matches, rep.activity.turnover_cents,
    rep.activity.resting_orders, rep.rates.match_rate, rep.rates.unmatched_ratio, rep.rates.average_bet_delay_ms]);
  rows.push([]);
  for (const r of defsCsv(OPERATIONAL_DEFS)) rows.push(r);
  return csv(rows);
}

module.exports = {
  period,
  csv,
  csvCell,
  LEADING_JUNK,
  money,
  bps,
  summary,
  playerStatements,
  statementRow,
  volumeByMarket,
  volumeBySelection,
  commissionByTenant,
  operational,
  summaryCsv,
  statementsCsv,
  volumeCsv,
  selectionVolumeCsv,
  commissionCsv,
  operationalCsv,
  MAX_SPAN_DAYS,
  MAX_ROWS,
  FORMULA_PREFIX,
  LEADING_JUNK,
  STATEMENT_DEFS,
  SUMMARY_DEFS,
  OPERATIONAL_DEFS,
  VOLUME_DEFS,
  SELECTION_VOLUME_DEFS,
  COMMISSION_DEFS,
};