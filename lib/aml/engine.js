'use strict';
// lib/aml/engine.js — the context builder, the evaluator, and the tuning resolver.
//
// This module is the MECHANISM around lib/aml/rules.js. The rule table says what
// is suspicious; this says how the venue measures it, and what the operator has
// overridden.
//
// ── WHY THE CONTEXT IS BUILT PER USER AND CACHED ────────────────────────────
//
// node:sqlite is SYNCHRONOUS. Every statement here blocks the whole
// single-threaded server for its duration, and a monitoring pass over a real book
// is dozens of statements. So the pass is shaped around one idea: do the
// expensive shared work once (the per-user figures most rules need), then let the
// rules read them.
//
// The alternative — each rule opening its own queries — is how a monitoring pass
// becomes an outage, and it is why `ctx` is an explicit object with named
// getters rather than each rule receiving `db`.
//
// ── THE HOUSE IS EXCLUDED EVERYWHERE ────────────────────────────────────────
//
// An exchange quotes every market it lists, and this venue's own market maker
// takes a position in every one of them, all day. Every behavioural rule that
// looks at volume, bets or deposits therefore filters `users.is_bot = 0`, and
// every rule that looks at accounts filters them out of the ACCOUNT side too.
//
// This is not a refinement. A "multiple large bets on obscure markets" rule that
// does not exclude the house fires on the house on the first pass, and a rule
// that fires on the house is a rule an operator disables.
//
// ── WHAT A PASS DOES AND DOES NOT DO ────────────────────────────────────────
//
// It produces ALERTS, and an alert is a durable finding for a human
// (lib/aml/findings.js). It does not block, close, suspend or limit anything. Not
// because blocking is always wrong, but because "is this activity suspicious" is
// a legal judgement and this codebase refuses to make it on the operator's
// behalf — see the header of lib/aml/rules.js.
//
// The one place the engine DOES refuse anything is the intake gate in
// lib/funding.js, and that is a different question: not "is this suspicious" but
// "may we accept money from an instrument whose owner we cannot name", on a rail
// where accepting it wrongly is irreversible.
const { transaction } = require('../tx');
const config = require('../config');
const findings = require('./findings');
const { RULES, rulesFor, MAX_WINDOW_DAYS } = require('./rules');

// ── Tuning ───────────────────────────────────────────────────────────────────

/**
 * The parameters a rule actually runs with: an operator override if there is one,
 * otherwise the shipped default.
 *
 * THE ORDER IS LOAD-BEARING and the safe direction. A rule with no override runs
 * on its SHIPPED DEFAULT, not on nothing — so a deployment that has never tuned
 * anything is still MONITORED. The dangerous state on this side of a financial
// crime control is an unmonitored venue, not a badly-calibrated one, and the
 * second is fixable while the first is discovered by a regulator.
 *
 * An override supplies only the fields it names, so an operator who wants to move
 * one number does not have to restate the rest and does not silently reset
 * another to zero by omitting it. That is the same lesson lib/limits.js's
 * setLimits records about absent-versus-null, arrived at the hard way.
 *
 * `window_days` is clamped to MAX_WINDOW_DAYS. An override that asked for a
 * decade of fills would turn a scheduled pass into an outage, and the ceiling is
 * a property of the DATABASE rather than of the rule — which is why it lives in
 * the rules module and not here.
 */
function effectiveTuning(db, rule, tenantId) {
  const shipped = rule.tuning || {};
  if (tenantId === null || tenantId === undefined) return { ...shipped, overridden: false };
  const row = db
    .prepare('SELECT * FROM aml_rule_thresholds WHERE rule_id = ? AND tenant_id = ?')
    .get(rule.id, tenantId);
  if (!row) return { ...shipped, overridden: false };
  const out = { ...shipped, overridden: true };
  // WHICH TUNING KEY each override lands on is declared ON THE RULE (`rule.units`),
  // not in a map here. A separate map is a thing that drifts from the rule it
  // describes, and the drift is silent: a cent figure landing on a duration, or a
  // count landing on a percentage, misfires by a factor of 100 and reads as a
  // working control. Declaring it on the rule makes the two impossible to
  // disagree, and the unit is visible through /api/admin/aml/rules.
  //
  // AN OVERRIDE WITH NOWHERE TO GO IS REFUSED, loudly, rather than ignored. An
  // operator who set a cent threshold on a rule with no money parameter believes
  // they have tightened a control they have not touched at all, which is the
  // worst of both worlds — so it throws at the moment they set it.
  if (row.value_cents !== null && row.value_cents !== undefined) {
    const centsKey = rule.units && rule.units.cents;
    if (!centsKey) {
      throw new Error(
        `aml: rule ${rule.id} has no money parameter, so a cent override cannot be placed on it. ` +
          `Its tunable fields are: ${Object.keys(shipped).join(', ')}.`
      );
    }
    out[centsKey] = row.value_cents;
  }
  if (row.value_count !== null && row.value_count !== undefined) {
    const countKey = rule.units && rule.units.count;
    if (!countKey) {
      throw new Error(`aml: rule ${rule.id} has no count parameter, so a count override cannot be placed on it`);
    }
    out[countKey] = row.value_count;
  }
  if (row.window_days !== null && row.window_days !== undefined) {
    out.window_days = Math.min(Math.max(Number(row.window_days), 1), MAX_WINDOW_DAYS);
  }
  return out;
}

// (There is deliberately no CENT_FIELD_FOR / COUNT_FIELD_FOR map here any more.
// It lived in this file and named, per rule, which tuning key a cent override
// replaces — and it had two wrong entries, both of which would have let a money
// figure land on a duration and misfire by a factor of 100 without ever
// erroring. The declaration is on the rule now, where it cannot disagree with it.)

/** Record an operator's calibration. An audited, reasoned change to a control. */
function setTuning(db, { actor, ruleId, tenantId, value_cents, value_count, window_days, reason }) {
  if (!Object.prototype.hasOwnProperty.call(RULES, ruleId)) {
    throw Object.assign(new Error(`No such AML rule: ${ruleId}`), { status: 400 });
  }
  if (!reason || String(reason).trim().length < 5) {
    throw Object.assign(new Error('A written reason is required to change a financial-crime threshold'), { status: 400 });
  }
  if (window_days !== null && window_days !== undefined && window_days > MAX_WINDOW_DAYS) {
    throw Object.assign(
      new Error(`window_days may not exceed ${MAX_WINDOW_DAYS}: node:sqlite is synchronous and a longer lookback would block the server`),
      { status: 400 }
    );
  }
  // THE UNIT CHECK, AT WRITE TIME, and it belongs here rather than only in
  // effectiveTuning.
  //
  // effectiveTuning also refuses an override with nowhere to go, which is what
  // stops a cent figure misfiring — but that refusal surfaces during a SCAN, at
  // runtime, as a rule that threw. An operator who set a cent threshold on a rule
  // with no money parameter would see the write succeed, see the audit row, and
  // believe they had tightened a control they never touched. The error has to
  // arrive while they are still looking at the screen that set it.
  const rule = RULES[ruleId];
  if (value_cents !== null && value_cents !== undefined && !(rule.units && rule.units.cents)) {
    throw Object.assign(
      new Error(
        `Rule ${ruleId} has no money parameter, so a cent threshold cannot be set on it. ` +
          `It is tuned with: ${Object.keys(rule.tuning || {}).join(', ')}. ` +
          `See GET /api/admin/aml/rules for which column reaches which parameter.`
      ),
      { status: 400 }
    );
  }
  if (value_count !== null && value_count !== undefined && !(rule.units && rule.units.count)) {
    throw Object.assign(
      new Error(`Rule ${ruleId} has no count parameter, so a count threshold cannot be set on it.`),
      { status: 400 }
    );
  }
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO aml_rule_thresholds (rule_id, tenant_id, value_cents, value_count, window_days, updated_by, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(rule_id, tenant_id) DO UPDATE SET
         value_cents = excluded.value_cents, value_count = excluded.value_count,
         window_days = excluded.window_days, updated_by = excluded.updated_by,
         reason = excluded.reason, updated_at = datetime('now')`
    ).run(ruleId, tenantId, value_cents ?? null, value_count ?? null, window_days ?? null, actor ? actor.id : null, String(reason).trim());
    return { rule_id: ruleId, tenant_id: tenantId, value_cents: value_cents ?? null, value_count: value_count ?? null, window_days: window_days ?? null };
  });
}

// ── The per-user context ─────────────────────────────────────────────────────

/**
 * Build the measurement surface for one account.
 *
 * Every method here is LAZY. A rule that does not need a figure does not cause
 * the query that computes it, because on a synchronous connection the cost of an
 * unused query is the cost of an outage.
 */
function contextFor(db, userId, { nowMs = Date.now() } = {}) {
  const cache = new Map();
  const memo = (key, fn) => {
    if (cache.has(key)) return cache.get(key);
    const v = fn();
    cache.set(key, v);
    return v;
  };
  const since = (days) => db.prepare("SELECT datetime('now', ?) AS t").get(`-${Math.max(1, Math.round(days))} days`).t;

  const row = db.prepare('SELECT id, tenant_id, is_bot FROM users WHERE id = ?').get(userId);
  if (!row) return null;
  const tenantId = row.tenant_id === null || row.tenant_id === undefined ? null : row.tenant_id;

  return {
    db,
    userId,
    tenantId,
    isBot: !!row.is_bot,
    nowMs,

    /** Every deposit the LEDGER recorded, from `transactions`. */
    deposits(windowDays) {
      return memo(`deposits:${windowDays}`, () => {
        const rows = db
          .prepare(
            `SELECT amount_cents, at FROM transactions
              WHERE user_id = ? AND type = 'deposit' AND at >= ?`
          )
          .all(userId, since(windowDays));
        return {
          count: rows.length,
          total: rows.reduce((s, r) => s + r.amount_cents, 0),
          amounts: rows.map((r) => r.amount_cents),
          minutes: rows.map((r) => Math.round((nowMs - Date.parse(`${r.at.replace(' ', 'T')}Z`)) / 60000)),
        };
      });
    },

    /** Lifetime deposits — the denominator for AU-OB-04. Deliberately not windowed. */
    lifetimeDeposits() {
      return memo('lifetime_deposits', () =>
        db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions WHERE user_id = ? AND type = 'deposit'").get(userId).s
      );
    },

    /**
     * Confirmed deposit intents whose funding the venue REFUSED.
     *
     * Read from `payment_intents` rather than from the ledger because the
     * question is about how the money ARRIVED, and that is what the intent row
     * carries. A refusal leaves no deposit transaction — which is the whole point
     * — so the ledger is exactly the table that cannot answer it.
     */
    depositsWithRefusals(windowDays) {
      return memo(`refusals:${windowDays}`, () =>
        db
          .prepare(
            `SELECT pi.id, pi.amount_cents, pi.funding_country, pi.payer_name, pi.status, a.after AS refusal
               FROM payment_intents pi
               LEFT JOIN audit_log a
                 ON a.target = 'user:' || pi.user_id
                AND a.action = 'funding.refused'
                AND date(a.at) >= date(?)
              WHERE pi.user_id = ? AND pi.kind = 'deposit' AND pi.created_at >= ?
              ORDER BY pi.id DESC`
          )
          .all(since(windowDays), userId, since(windowDays))
          .filter((r) => r.refusal)
          .map((r) => ({
            id: r.id,
            amount_cents: r.amount_cents,
            funding_country: r.funding_country,
            payer_name: r.payer_name,
            code: parseRefusalCode(r.refusal),
          }))
      );
    },

    /** Confirmed deposits whose funding country is on the operator's restricted list. */
    fundingFromRestricted(windowDays) {
      return memo(`restricted:${windowDays}`, () => {
        if (!config.AML_RESTRICTED_JURISDICTIONS.length) return [];
        const marks = config.AML_RESTRICTED_JURISDICTIONS.map(() => '?').join(',');
        return db
          .prepare(
            `SELECT id, funding_country, amount_cents FROM payment_intents
              WHERE user_id = ? AND kind = 'deposit' AND status = 'confirmed'
                AND funding_country IS NOT NULL
                AND UPPER(funding_country) IN (${marks})
                AND created_at >= ?`
          )
          .all(userId, ...config.AML_RESTRICTED_JURISDICTIONS, since(windowDays))
          .map((r) => r.id);
      });
    },

    /**
     * Betting plunges: one account supplying a large SHARE of one selection's
     * matched volume inside a short window.
     *
     * Venue-shaped, and the shape is the point. An ABSOLUTE stake figure cannot
     * work on an exchange — this venue's own market maker takes a position in
     * every market it quotes, so an absolute threshold either fires on the house
     * or fires on nothing. A share of the selection's own volume asks the
     * question the indicator actually means: did ONE account move this market?
     *
     * BOTH SIDES OF EVERY MATCH COUNT, because both sides are real volume and a
     * customer's own taker fills are as much a plunge as their resting order's.
     */
    plunges(windowMinutes, minSelectionVolumeCents, sharePct) {
      return memo(`plunges:${windowMinutes}:${minSelectionVolumeCents}:${sharePct}`, () => {
        const cutoff = db.prepare("SELECT datetime('now', ?) AS t").get(`-${Math.max(1, Math.round(windowMinutes))} minutes`).t;
        const rows = db
          .prepare(
            `SELECT selection_id, user_id, SUM(stake_cents) AS cents, COUNT(*) AS fills
               FROM (
                 SELECT mt.selection_id AS selection_id, o.user_id AS user_id, mt.stake_cents AS stake_cents
                   FROM matches mt JOIN orders o ON o.id = mt.back_order_id
                  WHERE mt.at >= ? AND mt.cashout = 0
                 UNION ALL
                 SELECT mt.selection_id, o.user_id, mt.stake_cents
                   FROM matches mt JOIN orders o ON o.id = mt.lay_order_id
                  WHERE mt.at >= ? AND mt.cashout = 0
               ) legs
               JOIN users u ON u.id = legs.user_id
              WHERE u.is_bot = 0
              GROUP BY legs.selection_id, legs.user_id`
          )
          .all(cutoff, cutoff);
        const total = new Map();
        const byAcct = new Map();
        for (const r of rows) {
          total.set(r.selection_id, (total.get(r.selection_id) || 0) + r.cents);
          const k = `${r.selection_id}:${r.user_id}`;
          byAcct.set(k, { selection_id: r.selection_id, user_id: r.user_id, cents: r.cents, fills: r.fills });
        }
        const out = [];
        for (const [key, v] of byAcct) {
          const selTotal = total.get(v.selection_id) || 0;
          if (selTotal < minSelectionVolumeCents) continue;
          const share = Math.round((v.cents / selTotal) * 100);
          if (share < sharePct) continue;
          out.push({ ...v, selection_total_cents: selTotal, share_pct: share, key });
        }
        return out.sort((a, b) => b.share_pct - a.share_pct);
      });
    },

    /**
     * Large bets on ILLIQUID selections.
     *
     * "Obscure" is defined as this venue's own liquidity for the selection inside
     * the window: thin total matched stake AND few distinct traded price levels.
     * Both halves, because either alone is wrong on an exchange — a market can
     * carry a lot of volume in one price (the venue's own maker filling against
     * itself) while being effectively untradeable, and it can carry a dozen tiny
     * fills in a wide book that is perfectly liquid.
     */
    largeBetsOnIlliquid(p) {
      return memo(`illiquid:${JSON.stringify(p)}`, () => {
        const cutoff = since(p.window_days);
        const stats = db
          .prepare(
            `SELECT s.id AS selection_id,
                    COALESCE(SUM(mt.stake_cents), 0) AS volume,
                    COUNT(DISTINCT mt.price) AS price_levels
               FROM selections s
               JOIN matches mt ON mt.selection_id = s.id AND mt.cashout = 0
              WHERE mt.at >= ?
              GROUP BY s.id
             HAVING volume < ? AND price_levels <= ?`
          )
          .all(cutoff, p.min_illiquid_volume_cents, p.max_price_levels);
        if (!stats.length) return [];
        const illiquid = new Map(stats.map((s) => [s.selection_id, s]));
        const bets = db
          .prepare(
            `SELECT o.id, o.user_id, o.selection_id, o.side, o.price, o.stake_cents, o.placed_at
               FROM orders o JOIN users u ON u.id = o.user_id
              WHERE o.user_id = ? AND u.is_bot = 0 AND o.placed_at >= ? AND o.stake_cents >= ?
              ORDER BY o.id DESC`
          )
          .all(userId, cutoff, p.min_stake_cents)
          .filter((b) => illiquid.has(b.selection_id));
        if (bets.length < p.min_bets) return [];
        return bets.slice(0, 20).map((b) => ({
          ...b,
          selection_volume_cents: illiquid.get(b.selection_id).volume,
          price_levels: illiquid.get(b.selection_id).price_levels,
        }));
      });
    },

    /**
     * One order whose ESCROW is a near-total of everything the account has ever
     * deposited.
     *
     * ESCROW rather than stake, and the reason is arithmetic rather than
     * editorial: a LAY at price 10.0 freezes round((10-1) x stake) — nine times
     * the stake — so a stake-based rule would flag every layer with any size and
     * would MISS the backer who staked literally everything they had. The escrow
     * is what the customer actually put at risk, and it is the figure the engine
     * itself freezes (lib/match.js escrowFor).
     */
    allInStake(p) {
      return memo(`allin:${JSON.stringify(p)}`, () => {
        const deposited = this.lifetimeDeposits();
        if (deposited <= 0) return null;
        const rows = db
          .prepare(
            `SELECT o.id, o.side, o.price, o.stake_cents, o.matched_cents
               FROM orders o JOIN users u ON u.id = o.user_id
              WHERE o.user_id = ? AND u.is_bot = 0 AND o.placed_at >= ? AND o.stake_cents > 0
              ORDER BY o.stake_cents DESC LIMIT 50`
          )
          .all(userId, since(p.window_days));
        const { escrowFor } = require('../match');
        let worst = null;
        for (const o of rows) {
          const escrow = escrowFor(o.side, o.price, o.stake_cents);
          if (escrow < p.min_escrow_cents) continue;
          const share = Math.round((escrow / deposited) * 100);
          if (share < p.escrow_share_pct) continue;
          if (!worst || share > worst.share_pct) {
            worst = {
              order_id: o.id,
              side: o.side,
              price: o.price,
              stake_cents: o.stake_cents,
              escrow_cents: escrow,
              deposited_cents: deposited,
              share_pct: share,
              window_days: p.window_days,
            };
          }
        }
        return worst;
      });
    },

    /**
     * THE REWRITTEN RULE. See lib/aml/rules.js, AU-EX-02, for why the published
     * indicator cannot be implemented as written.
     *
     * What is measured: the customer's WINNING settlements, the price their
     * winning selection actually traded at, and whether a withdrawal followed one
     * inside the window. Cash-out is excluded from the withdrawal count.
     *
     * The price comes from `matches`, joined to the settlement's market's
     * winner — not from `selections.fair_price`, which is the venue's own model
     * and would be measuring this codebase's opinion rather than what traded.
     */
    shortOddWinsThenWithdraw(p) {
      return memo(`shortodds:${JSON.stringify(p)}`, () => {
        const cutoff = since(p.window_days);
        const wins = db
          .prepare(
            `SELECT se.id, se.market_id, se.pnl_cents, se.at,
                    (SELECT MIN(mt.price) FROM matches mt
                      WHERE mt.selection_id = m.winner_selection_id AND mt.cashout = 0) AS win_price
               FROM settlements se
               JOIN markets m ON m.id = se.market_id
               JOIN users u ON u.id = se.user_id
              WHERE se.user_id = ? AND se.pnl_cents > 0 AND se.at >= ? AND u.is_bot = 0
                AND m.winner_selection_id IS NOT NULL
              ORDER BY se.at DESC`
          )
          .all(userId, cutoff)
          // A settlement with no recorded match on the winning selection has no
          // traded price. It is EXCLUDED rather than assumed short: dropping it
          // is the conservative direction (it cannot manufacture a pattern) and
          // saying so here means the exclusion is not mistaken for a bug.
          .filter((w) => w.win_price !== null && w.win_price <= p.max_price);
        if (wins.length < p.min_wins) return null;

        const won = wins.reduce((s, w) => s + w.pnl_cents, 0);
        const withdraws = db
          .prepare(
            `SELECT pi.created_at, pi.amount_cents, pi.status
               FROM payment_intents pi
              WHERE pi.user_id = ? AND pi.kind = 'withdrawal' AND pi.created_at >= ?`
          )
          .all(userId, cutoff)
          .map((r) => ({ ...r, ms: Date.parse(`${r.created_at.replace(' ', 'T')}Z`) }));
        // CASH-OUT IS EXCLUDED, and this is the line that stops the rule from
        // firing on the venue's headline feature. cashout_quotes is a different
        // table from payment_intents and is never counted here; the reason is
        // written out in lib/rules.js and repeated here because this is where a
        // future contributor would add it back.
        const within = p.withdrawal_within_minutes * 60000;
        const followed = withdraws.filter((w) =>
          wins.some((win) => w.ms - Date.parse(`${win.at.replace(' ', 'T')}Z`) >= 0 && w.ms - Date.parse(`${win.at.replace(' ', 'T')}Z`) <= within)
        );
        if (!followed.length) return null;
        return {
          wins: wins.length,
          won_cents: won,
          max_win_price: Math.max(...wins.map((w) => w.win_price)),
          withdrawals_within_window: followed.length,
          window_minutes: p.withdrawal_within_minutes,
          cash_out_excluded: true,
          window_days: p.window_days,
        };
      });
    },

    /**
     * Withdrawals to a country other than the account's own.
     *
     * "The account's own country" is the tenant's configured jurisdiction set,
     * which is a venue setting rather than an inference: there is no IP-derived
     * country in this schema and inventing one from a header would be
     * defeatable by editing the header.
     */
    internationalWithdrawals(p) {
      return memo(`intlwd:${JSON.stringify(p)}`, () => {
        const own = ownJurisdictions(db, tenantId);
        const rows = db
          .prepare(
            `SELECT id, amount_cents, beneficiary_country, status, created_at
               FROM payment_intents
              WHERE user_id = ? AND kind = 'withdrawal' AND created_at >= ? AND beneficiary_country IS NOT NULL`
          )
          .all(userId, since(p.window_days));
        const hits = rows.filter((r) => {
          const c = String(r.beneficiary_country).toUpperCase();
          // An EMPTY jurisdiction allowlist means unrestricted — lib/tenants.js's
          // rule — so with nothing configured every withdrawal is "domestic" and
          // the rule is quiet rather than firing on everything. Said here because
          // a rule that silently stops working when a config is unset is exactly
          // the dead control this repository keeps finding.
          return own.length ? !own.includes(c) : false;
        });
        return hits;
      });
    },

    /** Groups of accounts sharing a registration IP and/or device. Cross-tenant. */
    sharedOriginGroups() {
      return memo('shared_origin', () => sharedOriginGroups(db, this.userId));
    },

    /** Accounts with recent bets very similar to this one's, that are already flagged. */
    similarToFlagged(p) {
      return memo(`similar:${JSON.stringify(p)}`, () => similarToFlagged(db, this.userId, p));
    },
  };
}

/**
 * Cross-tenant account-link analysis.
 *
 * DELIBERATELY NOT SCOPED BY TENANT. "Multiple betting accounts – inter and intra
 * brand" is an enumerated finding, and on a multi-tenant venue the intra-brand
 * case IS the cross-tenant case: two accounts under two of this venue's own
 * brands are two rows in `users` with two different `tenant_id` values and no
 * relationship between them in any other table. A rule scoped per tenant would
 * never see it, which is the same class of miss as lib/reports.js's tenant_id
 * comment on `matches` — a relationship that exists in the world and in no column.
 *
 * THE EVIDENCE NAMES EVERY TENANT INVOLVED, so an analyst reading one alert can
 * tell an intra-brand case (same tenant) from an inter-brand one without running
 * a query.
 *
 * NOT AN AUTOMATIC BLOCK. A person may plausibly hold accounts with more than one
 * operator, and may share a device with their household. This codebase has no
 * standing to decide which it is and does not try — see the rule's `calibration`.
 */
function sharedOriginGroups(db, userId) {
  const accounts = db
    .prepare(
      `SELECT u.id, u.username, u.tenant_id, u.registration_ip, u.registration_device, u.created_at
         FROM users u
        WHERE u.is_bot = 0
          AND u.created_at >= datetime('now', '-90 days')
          AND (u.registration_ip IS NOT NULL OR u.registration_device IS NOT NULL)
          AND (u.id = ? OR u.id IN (
                SELECT id FROM users
                 WHERE registration_ip IN (SELECT registration_ip FROM users WHERE id = ? AND registration_ip IS NOT NULL)
                    OR registration_device IN (SELECT registration_device FROM users WHERE id = ? AND registration_device IS NOT NULL)
              ))`
    )
    .all(userId, userId, userId);
  const byKey = new Map();
  for (const a of accounts) {
    for (const [kind, value] of [['ip', a.registration_ip], ['device', a.registration_device]]) {
      if (!value) continue;
      const key = `${kind}:${value}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(a);
    }
  }
  const groups = [];
  for (const [key, members] of byKey) {
    if (members.length < 3) continue;
    const usernames = new Set(members.map((m) => String(m.username).toLowerCase()));
    if (usernames.size < 2) continue;
    groups.push({
      key,
      kind: key.split(':')[0],
      origin: key.slice(key.indexOf(':') + 1),
      user_ids: members.map((m) => m.id),
      usernames: [...usernames],
      distinct_usernames: usernames.size,
      tenant_ids: [...new Set(members.map((m) => m.tenant_id).map((t) => (t === null ? 'default' : t)))],
      cross_tenant: new Set(members.map((m) => String(m.tenant_id))).size > 1,
    });
  }
  return groups.sort((a, b) => b.user_ids.length - a.user_ids.length);
}

/**
 * Correlate recent bets against accounts that ALREADY have an open alert.
 *
 * Depends on another control having fired. Stated rather than hidden: a rule whose
 * firing depends on a second control's output is exactly the thing a reviewer
 * needs told, and it is quiet — correctly — on a venue with no alerts at all.
 *
 * MATCHED ON A PRICE BAND rather than exact prices. Two accounts copying each
 * other will not match to the tick, and an exact-price rule would be a rule that
 * fires only on a copy-paste of the last decimal.
 *
 * THE SIGNATURE IS (selection, side, price band) — deliberately not the market
 * alone. A shared market is not a signal at all on a venue with a shared fixture
 * list: two accounts backing the same horse in the same race is what people do.
 */
function similarToFlagged(db, userId, p) {
  const cutoff = since(p.window_days);
  const flagged = db
    .prepare("SELECT DISTINCT user_id FROM aml_alerts WHERE resolved_at IS NULL AND user_id IS NOT NULL")
    .all()
    .map((r) => r.user_id)
    .filter((id) => id !== userId);
  if (!flagged.length) return [];
  const mine = db
    .prepare('SELECT selection_id, side, price, stake_cents, placed_at FROM orders WHERE user_id = ? AND placed_at >= ? ORDER BY id DESC LIMIT 500')
    .all(userId, cutoff);
  if (mine.length < p.min_shared_bets) return [];
  const marks = flagged.map(() => '?').join(',');
  const theirs = db
    .prepare(`SELECT o.selection_id, o.side, o.price, o.stake_cents, o.user_id, o.placed_at FROM orders o WHERE o.user_id IN (${marks}) AND o.placed_at >= ?`)
    .all(...flagged, cutoff);
  const hits = [];
  for (const a of mine) {
    const partners = theirs.filter(
      (b) => b.selection_id === a.selection_id && b.side === a.side && Math.abs(b.price - a.price) <= p.price_band
    );
    if (partners.length >= p.min_shared_bets) {
      hits.push({
        selection_id: a.selection_id,
        side: a.side,
        price: a.price,
        stake_cents: a.stake_cents,
        similar_to: [...new Set(partners.map((x) => x.user_id))],
        similar_count: partners.length,
      });
    }
  }
  return hits;
}

function ownJurisdictions(db, tenantId) {
  if (tenantId === null) return [];
  const row = db.prepare('SELECT jurisdictions FROM tenants WHERE id = ?').get(tenantId);
  if (!row || !row.jurisdictions) return [];
  try {
    const v = JSON.parse(row.jurisdictions);
    return Array.isArray(v) ? v.map((c) => String(c).toUpperCase()) : [];
  } catch {
    return [];
  }
}

function parseRefusalCode(after) {
  if (!after) return 'unknown';
  try {
    const v = JSON.parse(after);
    return v.code || 'unknown';
  } catch {
    return 'unknown';
  }
}

function since(days) {
  const d = new Date(Date.now() - Math.max(1, Math.round(days)) * 86400000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// ── The pass ─────────────────────────────────────────────────────────────────

/**
 * Run every rule for one account.
 *
 * Returns the alerts it raised, already PERSISTED as findings. The return value is
 * a convenience for the caller and for tests; the durable record is the row, and
 * re-running this pass on an account with an open alert for the same rule
 * UPDATES that alert rather than opening a second one — which is the whole
 * difference between a control and a log (lib/jobs.js argues it for
 * reconciliation findings, and the argument transfers unchanged).
 */
function scanUser(db, { userId, actor = null }) {
  const ctx = contextFor(db, userId);
  if (!ctx) return { user_id: userId, skipped: 'no such user' };
  if (ctx.isBot) return { user_id: userId, skipped: 'venue account' };
  const raised = [];
  for (const scope of ['transaction', 'behavioural', 'network']) {
    for (const rule of rulesFor(scope)) {
      const p = effectiveTuning(db, rule, ctx.tenantId);
      let verdict;
      try {
        verdict = rule.evaluate(ctx, p);
      } catch (e) {
        // ONE BROKEN RULE MUST NOT STOP THE PASS. A rule that throws is a rule
        // that has stopped watching, and a monitoring pass that aborts on the
        // first error is a monitoring pass that watches nothing after the first
        // bad night. Recorded on the alert as the failure it is rather than
        // swallowed — the same reasoning lib/results.js gives for applying many
        // outcomes one at a time.
        raised.push({
          rule_id: rule.id,
          error: e.message,
          raised: false,
        });
        continue;
      }
      if (!verdict) continue;
      const scopeKey = findings.alertScope(rule.id, `user:${userId}`);
      const rec = transaction(db, () =>
        findings.recordAlert(db, {
          rule_id: rule.id,
          scope: scopeKey,
          severity: verdict.severity || rule.severity,
          user_id: userId,
          detail: verdict.detail,
          evidence: verdict.evidence || null,
          observed_cents: verdict.observedCents ?? null,
          source: 'scan',
        })
      );
      raised.push({ rule_id: rule.id, ...rec, raised: true, severity: verdict.severity || rule.severity });
    }
  }
  return { user_id: userId, raised };
}

/**
 * Run the pass across a set of accounts.
 *
 * `userIds` is required rather than "all users", because an unbounded scan of
 * every account on a synchronous connection is an outage, and the operator chooses
 * the cohort (recently active, recently funded, all of a tenant). The bounded
 * default cohort is the most recently active accounts, which is where a
 * suspicious pattern is most likely to still be visible.
 */
function scan(db, { actor = null, userIds = null, limit = 200 } = {}) {
  const cohort =
    userIds ||
    db
      .prepare(
        `SELECT id FROM users
          WHERE is_bot = 0 AND created_at >= datetime('now', '-90 days')
          ORDER BY COALESCE((SELECT MAX(at) FROM transactions t WHERE t.user_id = users.id), users.created_at) DESC
          LIMIT ?`
      )
      .all(Math.min(Math.max(Number(limit) || 200, 1), 5000))
      .map((r) => r.id);
  const results = cohort.map((id) => scanUser(db, { userId: id, actor }));
  return {
    scanned: cohort.length,
    raised: results.reduce((s, r) => s + (r.raised ? r.raised.filter((x) => x.raised).length : 0), 0),
    failed_rules: results.flatMap((r) => (r.raised || []).filter((x) => x.error).map((x) => ({ user_id: r.user_id, ...x }))),
    results,
  };
}

module.exports = {
  effectiveTuning,
  setTuning,
  contextFor,
  scanUser,
  scan,
  sharedOriginGroups,
  similarToFlagged,
};