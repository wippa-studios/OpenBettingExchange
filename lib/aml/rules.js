'use strict';
// lib/aml/rules.js — the DECLARATIVE suspicious-activity rule set.
//
// THE RULE SOURCE IS PUBLIC GUIDANCE. AUSTRAC publishes sector-specific
// suspicious-activity indicators for the online betting sector, and every rule
// below carries the indicator it encodes in `indicator` and its own reasoning
// in `why`. That is the whole design brief for this file: an operator has to be
// able to open /api/admin/aml/rules and read what the venue is watching for and
// WHY, in the venue's own words, without reading this source.
//
// The alternative — thresholds and prose scattered through engine code — is what
// makes a monitoring system impossible to review, and an impossible-to-review
// monitoring system is one an operator either over-trusts or switches off.
//
// ── THE SHAPE, AND WHY IT IS DATA NOT LOGIC ────────────────────────────────
//
// Modelled on lib/voidrules.js, which is the precedent this repository already
// sets: the rule table is pure data, the resolver is separate, and `evaluate()`
// on each rule is the only place a judgement lives. Adding an indicator is adding
// an entry here, not branching in the engine.
//
// A rule is:
//   id          stable, and it lands on every alert row forever
//   indicator   the published wording, or the finding it encodes
//   scope       which evaluator supplies its context
//   severity    a starting priority, not a conclusion
//   tuning      the SHIPPED DEFAULTS — calibration, not law
//   calibration what normal exchange behaviour this was measured NOT to trip on
//   evaluate    (ctx, p) -> null | { severity, detail, evidence }
//
// `tuning` is where the venue-shapedness lives. Read on.
//
// ── CALIBRATION IS NOT A DETAIL. IT IS THE CONTROL. ────────────────────────
//
// AUSTRAC's finding against a large Australian operator was not that the
// operator had no rules. It was that "transaction monitoring processes were not
// appropriate for a business the nature, size and complexity of Entain" — which
// is a CALIBRATION failure. A rule set that would not have fired on the concrete
// activity that actually happened is not a control; it is a document.
//
// So this file does the thing the finding demands: each rule is expressed in
// terms of THIS VENUE'S OWN LEDGER and calibrated against THIS VENUE'S OWN
// NORMAL BEHAVIOUR. Every rule's `calibration` field names the ordinary
// behaviour that a naive reading of the published indicator would have flagged,
// and tests/aml.test.js asserts the naive case does NOT fire.
//
// ── THE FOUR THAT WOULD HAVE BEEN CATASTROPHICALLY WRONG ───────────────────
//
// (1) "continually bets short-odd favourites and then requests an immediate
//      withdrawal when the payout arrives" DESCRIBES AN ORDINARY EXCHANGE
//     CUSTOMER. Betting short prices and taking profit is what the product is.
//     A rule written straight off the list alerts on the venue's entire
//     legitimate user base, and an operator who is alerted on every customer
//     either disables the system or investigates nobody. AU-EX-02 below is
//     therefore NOT "bets short odds, then withdraws". It is "WINS ARE
//     CONCENTRATED IN SHORT ODDS AND THE WITHDRAWAL FOLLOWS THE WIN" — which is a
//     statement about the DISTRIBUTION of a customer's wins, not about their
//     betting, and which no honest bettor produces.
//
// (2) "multiple, large or maximum bets on obscure markets" — on an exchange,
//      large bets on thin markets are what the venue's OWN MARKET MAKER does, on
//     every market, all day. Taken literally it flags the house. AU-OB-02
//      excludes the venue's own accounts and defines "obscure" by THIS venue's
//      own liquidity rather than by an absolute stake figure.
//
// (3) "using the total funds deposited to place a large or maximum bet" — on an
//     exchange the number that matters is the ESCROW, not the stake, because a
//     LAY at 10.0 freezes nine times the stake. Measuring stake would flag every
//     layer and miss every backer who staked everything they had. AU-OB-04
//      measures `round((price-1) * stake)`, the same formula the engine freezes
//      with (lib/match.js escrowFor).
//
// (4) "continually placing bets ... then requesting an immediate withdrawal" ALSO
//      collides with CASH-OUT, which is this venue's headline feature. A cash-out
//      is a customer closing a position and taking the money, and it is the most
//      ordinary thing a player does. The rule measures withdrawal-after-
//      SETTLEMENT, not withdrawal-after-any-exit.
//
// ── WHAT IS DELIBERATELY NOT HERE, AND WHY ─────────────────────────────────
//
// No rule for CASH. AUSTRAC found a transaction-monitoring failure to detect
// cash at an operator whose deposit channels were all electronic. This venue has
// no cash rail, no retail top-up and no cashier: `ledger.deposit` is reached only
// through a payment intent or the paper faucet. Omitting the indicator is a
// POSITIVE STATEMENT ABOUT THIS VENUE'S RAILS, not an oversight, and it is
// recorded here rather than left as a silence. If an operator ever adds a
// physical or agent-assisted top-up channel, this is the file that has to change
// and the comment is the reminder.
//
// No rule for a named loyalty or prepaid product. AUSTRAC found a specific
// operator's club product being funded. The MECHANISM for that is the kind
// vocabulary on `payment_methods` (`prepaid`) and the `instrument_kind`
// vocabulary on `funding_instruments`, so the product class is registrable and
// its funding pattern is measurable — but the RULE is left to the operator, who
// is the one who knows the product's terms.
//
// WE ARE NOT THE COMPLIANCE AUTHORITY. Every threshold in `tuning` is a
// defensible starting point, overridable per tenant through aml_rule_thresholds
// with a written reason, and every ALERT is a signal to an analyst. Nothing in
// this file blocks a customer, closes an account, or makes a legal
// characterisation of anybody's conduct. That last boundary is the whole of the
// module's restraint and it is worth stating as a design property: a rule that
// auto-blocked would be a rule making a legal judgement on the venue's behalf.
//
// ── WHERE WE ARE GUESSING, AND SAYING SO ───────────────────────────────────
//
// Published guidance is not a specification and this file is not a legal reading
// of it. Three places where the honest position is "this is our reading, and an
// operator's compliance officer should check it", written down rather than left
// for someone to discover in production:
//
//   1. THE GROUPING OF INDICATORS INTO RULES. The published indicators are a
//      list of behaviours, not a specification of detections. Deciding that one
//      indicator becomes two rules, or that two become one, is a judgement we
//      made and the operator can make differently. Each rule's `indicator` field
//      names what it encodes so the grouping is visible rather than buried.
//
//   2. THE CALIBRATION THRESHOLDS. There is no published number for "a large
//      share of one selection's volume" on a venue of this size. Every figure in
//      `tuning` is a defensible starting point chosen to sit above normal
//      exchange behaviour, which is a judgement about THIS venue — not a figure
//      from anywhere, and not a legal threshold. They are meant to be tuned.
//
//   3. WHICH SIGNALS ARE ABSENT. A venue that cannot see an activity cannot
//      monitor it. This venue has no cash rail, no retail top-up and no
//      agent-assisted channel, so the corresponding indicators are omitted — and
//      that omission is a statement about this venue's rails, not a claim that
//      the behaviour is unimportant. The three omissions are written out below
//      rather than left as silences, precisely so a reader can tell the
//      difference between "not applicable here" and "we forgot".
//
// The same applies to anything else in this module that reads as a legal rule: it
// is a MECHANISM with a named decision point, and the decision is the operator's.
//
// (This module requires nothing at all. The rule table is pure data and the
// resolver is pure arithmetic, so a rule can be read, reviewed and diffed without
// loading the database, the ledger or the auth layer. lib/voidrules.js is held to
// the same standard for the same reason.)

// The shipped defaults. Every one is CALIBRATION and none is a legal threshold.
const TUNING = {
  // "Betting plunges" — massive and sudden support for one selection. Measured
  // against the SELECTION's own matched volume in the window, so the rule reads
  // the venue's book rather than an absolute stake.
  plunge: { window_minutes: 10, min_selection_volume_cents: 50000, share_of_volume_pct: 40 },
  // "Multiple, large or maximum bets on obscure markets". `obscure` is defined by
  // this venue's own liquidity: a selection whose total matched stake in the
  // window is below this AND whose distinct price levels traded are few. An
  // absolute "large" number cannot work here — see the header.
  obscure_market: { window_days: 7, min_illiquid_volume_cents: 20000, min_bets: 3, max_price_levels: 4, min_stake_cents: 5000 },
  // "Using the total funds deposited to place a large or maximum bet".
  // `escrow_share_pct` is the share of LIFETIME deposits a single order's escrow
  // reaches. 80% means "they put essentially everything they have ever deposited
  // behind one order", which is a different act from staking a large amount.
  all_in_stake: { window_days: 30, escrow_share_pct: 80, min_escrow_cents: 10000 },
  // The short-odd / immediate-withdrawal indicator. See the header: the rule is
  // about the DISTRIBUTION OF WINS, and the window and counts are set so a
  // customer needs a repeated, consistent pattern rather than one lucky day.
  short_odds_withdrawal: { window_days: 90, min_wins: 5, max_price: 1.25, withdrawal_within_minutes: 60, min_cash_out_excluded: true },
  // "The same or very similar bets as other accounts flagged as suspicious".
  similar_bets: { window_days: 30, min_shared_bets: 3, price_band: 0.05 },
  // "Attempts to withdraw funds to an international bank account".
  international_withdrawal: { window_days: 90, min_attempts: 1 },
  // "Several accounts under different names opened from the same IP address
  // and/or device".
  shared_origin: { window_days: 90, min_accounts: 3, distinct_usernames: 2 },
  // "Layering" via multiple small transactions just under a threshold.
  layering: { window_hours: 24, count: 3, ratio_pct: 80 },
  // "Unusually large deposits" and "unusual patterns of deposits", venue-shaped
  // against the ACCOUNT'S OWN trailing behaviour rather than an absolute figure.
  // A shared default would flag every customer of a high-stakes venue and none of
  // a low-stakes one, which is precisely backwards.
  large_deposit: { window_days: 90, multiple_of_median: 5, min_cents: 50000 },
  deposit_pattern: { window_days: 30, count: 8, min_interval_minutes: 10 },
  // Restricted-jurisdiction funding. The LIST is configuration
  // (AML_RESTRICTED_JURISDICTIONS) because this repository deliberately ships no
  // regulatory registry — see lib/config.js. What lives here is the shape.
  restricted_funding: { window_days: 90, min_count: 1 },
};

// How long a lookback window this venue can afford on a synchronous database.
// node:sqlite is SYNCHRONOUS and every rule runs against the live connection, so
// a rule that scans a year of fills blocks the whole server for the duration. The
// per-rule `tuning.window_days` is therefore the authority on how far back any
// rule looks, and this constant is the ceiling that stops a mistuned override
// turning a monitoring pass into an outage.
const MAX_WINDOW_DAYS = 365;

/**
 * The context an evaluator supplies. Deliberately a plain object with named
 * getters rather than a class: rules read figures, and a rule that could call
 * arbitrary methods on the database is a rule whose cost nobody can bound.
 *
 * `db` is available for the two rules that genuinely need a join that is awkward
 * to precompute (the cross-account and similar-bets network rules). Everything
 * else works off the precomputed figures, which is what keeps the whole pass
 * inside one bounded read set.
 */

// ── The evaluators, one per scope ────────────────────────────────────────────
//
// Split by scope rather than shared, for the reason voidrules.js keeps its
// resolver sport-blind: the engine does not have to know which rules need which
// data, so a new scope is a new function and a new entry rather than a new branch
// through every rule.

// TRANSACTION SCOPE — one customer's money movements.
const transactionScope = {
  // "Unusually large deposits". Expressed against the account's OWN trailing
  // median, which is the only version of "unusually large" that means anything on
  // a venue with a spread of customer sizes.
  large_deposit: {
    id: 'AU-TX-01',
    indicator: 'Unusually large deposits',
    scope: 'transaction',
    severity: 'medium',
    tuning: TUNING.large_deposit,
    // WHICH TUNING KEY IS A CENT FIGURE, and which is a COUNT. Declared HERE, on
    // the rule, rather than in a map in the engine, because a separate map is a
    // thing that drifts from the rule it describes and the drift is a silent
    // factor-of-100. `null` means this rule has neither, and a cent override on
    // it is REFUSED at the seam rather than landed on a key of the wrong unit.
    units: { cents: 'min_cents', count: 'multiple_of_median' },
    calibration:
      'Relative to THIS ACCOUNT\'S trailing median, never to a venue-wide figure. An absolute ' +
      'threshold would flag every customer of a high-stakes venue and none of a low-stakes one, ' +
      'which is backwards. A customer who consistently deposits large sums never trips it, because ' +
      'their own median is the large sum.',
    evaluate(ctx, p) {
      const dep = ctx.deposits(p.window_days);
      if (dep.count < p.multiple_of_median) return null;
      const median = medianOf(dep.amounts);
      if (!median) return null;
      const biggest = Math.max(...dep.amounts);
      if (median <= 0 || biggest < median * p.multiple_of_median) return null;
      return {
        severity: 'medium',
        detail: `A deposit of ${biggest} is ${Math.round(biggest / median)}x this account's own trailing median of ${median}`,
        evidence: { deposit_cents: biggest, account_median_cents: median, multiple: Math.round(biggest / median), deposits_in_window: dep.count, window_days: p.window_days },
        observedCents: biggest,
      };
    },
  },

  // "Unusual patterns of deposits" — many deposits, evenly spaced, short window.
  // The shape that is unusual is REGULARITY, not volume: a customer topping up
  // twice a day for a fortnight is a pattern; one who does it once is a person.
  deposit_pattern: {
    id: 'AU-TX-02',
    indicator: 'Unusual patterns of deposits',
    scope: 'transaction',
    severity: 'low',
    tuning: TUNING.deposit_pattern,
    // No cents — `min_interval_minutes` is a DURATION, not a money figure, and the
    // earlier engine map listed it as the cent field. That would have let an
    // operator set a dollar threshold of 600 and had it read as 600 MINUTES: a
    // silent unit bug in the one table an operator edits to comply, misfiring by a
    // factor of 100 and looking like a working control. There IS a count.
    units: { cents: null, count: 'count' },
    calibration:
      'Counts deposits in a window with a MINIMUM GAP between them, so a genuine spread of ' +
      'activity is not what triggers it. A single large deposit is AU-TX-01\'s job and this rule ' +
      'must not also report it — overlapping rules are how an analyst learns to dismiss one of them.',
    evaluate(ctx, p) {
      const dep = ctx.deposits(p.window_days);
      if (dep.count < p.count) return null;
      // The minimum-interval filter is what makes it a PATTERN rule: deposits
      // that are all at least `min_interval_minutes` apart are a rhythm, and one
      // deposit is not a rhythm.
      let spread = 0;
      for (let i = 1; i < dep.minutes.length; i++) {
        if (dep.minutes[i] - dep.minutes[i - 1] >= p.min_interval_minutes) spread++;
      }
      if (spread < p.count - 1) return null;
      return {
        severity: 'low',
        detail: `${dep.count} deposits in ${p.window_days} days, evenly separated`,
        evidence: { deposit_count: dep.count, spread_count: spread, window_days: p.window_days, min_interval_minutes: p.min_interval_minutes },
        observedCents: dep.total,
      };
    },
  },

  // "A person (a third party) other than the person in whose name the betting
  // account was held" — the Entain finding. The RULE here is the retrospective
  // one; the REFUSAL is lib/funding.js, which stops it at intake on an
  // irrevocable rail. Both exist because they answer different questions: the
  // gate stops what has not happened, and this catches what the gate let through
  // before the instrument was registered.
  third_party_funding: {
    id: 'AU-TX-03',
    indicator: 'A deposit funded by a person other than the account holder',
    scope: 'transaction',
    severity: 'high',
    tuning: { window_days: 90, min_count: 1 },
    units: { cents: null, count: 'min_count' },
    calibration:
      'Fires only on a recorded NAME MISMATCH or an unregistered instrument — never on a processor ' +
      "pool. A venue's receiving PayID on the NPP/Osko rail is registered to a contracted processor " +
      'rather than to the venue, so any rule that treated "the rail name is not the customer" as a ' +
      'finding would flag every legitimate Australian deposit.',
    evaluate(ctx, p) {
      const bad = ctx.depositsWithRefusals(p.window_days);
      if (!bad.length) return null;
      const codes = [...new Set(bad.map((r) => r.code))];
      return {
        severity: 'high',
        detail: `A deposit was refused at intake for a funding-instrument reason (${codes.join(', ')})`,
        evidence: { count: bad.length, codes, intents: bad.slice(0, 10).map((r) => r.id), window_days: p.window_days },
        observedCents: bad.reduce((s, r) => s + r.amount_cents, 0),
      };
    },
  },

  // "Deposits from a foreign jurisdiction, including from a restricted-jurisdiction
  // list" — an Entain finding in its own right, and DISTINCT from the session
  // gate lib/tenants.js already runs. Where a person PLAYS is not where the money
  // CAME FROM.
  restricted_funding: {
    id: 'AU-TX-04',
    indicator: 'Deposits from a foreign or restricted jurisdiction',
    scope: 'transaction',
    severity: 'high',
    tuning: TUNING.restricted_funding,
    units: { cents: null, count: 'min_count' },
    calibration:
      'Matches the funding country on the PAYMENT INTENT, which is the instrument\'s country and not ' +
      "the customer's. A customer in Sydney funding from an account abroad is exactly the case, and " +
      'no session-side jurisdiction control can see it.',
    evaluate(ctx, p) {
      const hits = ctx.fundingFromRestricted(p.window_days);
      if (hits.length < p.min_count) return null;
      return {
        severity: 'high',
        detail: `${hits.length} deposit(s) funded from a restricted jurisdiction`,
        evidence: { count: hits.length, intents: hits.slice(0, 10), window_days: p.window_days },
        observedCents: ctx.deposits(p.window_days).total,
      };
    },
  },
};

// BEHAVIOURAL SCOPE — what the customer did with the account.
const behaviouralScope = {
  // "Betting plunges": massive and sudden support for one competitor in a market.
  // Venue-shaped as a SHARE of the selection's own volume, which is the only
  // definition of "massive" that survives a market where the venue's own bots are
  // the only other participant.
  plunge: {
    id: 'AU-OB-01',
    indicator: 'Betting plunges — massive and sudden support for one selection in a market',
    scope: 'behavioural',
    severity: 'high',
    tuning: TUNING.plunge,
    units: { cents: 'min_selection_volume_cents', count: 'share_of_volume_pct' },
    calibration:
      'Expressed as a SHARE of one selection\'s matched volume inside the window, with the venue\'s ' +
      'own accounts excluded. An absolute stake threshold would either fire on every market this ' +
      'venue quotes (its market maker takes a position in every one of them) or on none.',
    evaluate(ctx, p) {
      const hits = ctx.plunges(p.window_minutes, p.min_selection_volume_cents, p.share_of_volume_pct);
      if (!hits.length) return null;
      const worst = hits[0];
      return {
        severity: 'high',
        detail: `${worst.share_pct}% of the matched volume on selection ${worst.selection_id} in ${p.window_minutes} minutes came from one account`,
        evidence: { window_minutes: p.window_minutes, hits: hits.slice(0, 5), max_share_pct: worst.share_pct },
        observedCents: worst.cents,
      };
    },
  },

  // "Multiple, large or maximum bets on obscure markets". See the header: the
  // venue's own market maker is excluded, and "obscure" is this venue's liquidity.
  obscure_market: {
    id: 'AU-OB-02',
    indicator: 'Multiple, large or maximum bets on obscure markets',
    scope: 'behavioural',
    severity: 'medium',
    tuning: TUNING.obscure_market,
    units: { cents: 'min_stake_cents', count: 'min_bets' },
    calibration:
      '"Obscure" is the venue\'s OWN liquidity for that selection in the window — thin matched volume ' +
      'and few distinct traded price levels — never an absolute stake figure, and never the venue\'s ' +
      'own accounts. On an exchange the house takes a position in every market it quotes, so a rule ' +
      'that did not exclude it would flag the market maker.',
    evaluate(ctx, p) {
      const hits = ctx.largeBetsOnIlliquid(p);
      if (!hits.length) return null;
      const total = hits.reduce((s, h) => s + h.stake_cents, 0);
      return {
        severity: 'medium',
        detail: `${hits.length} large bet(s) totalling ${total} on illiquid selections`,
        evidence: { window_days: p.window_days, count: hits.length, total_stake_cents: total, bets: hits.slice(0, 5) },
        observedCents: total,
      };
    },
  },

  // "Using the total funds deposited to place a large or maximum bet".
  // ESCROW, not stake — see the header. A lay at 10.0 freezes nine times the
  // stake, so a stake-based rule misses the backer who staked everything and
  // flags every layer.
  all_in_stake: {
    id: 'AU-OB-04',
    indicator: 'Using the total funds deposited to place a large or maximum bet',
    scope: 'behavioural',
    severity: 'medium',
    tuning: TUNING.all_in_stake,
    units: { cents: 'min_escrow_cents', count: 'escrow_share_pct' },
    calibration:
      'The ESCROW is compared to LIFETIME deposits, using the same round((price-1) * stake) formula ' +
      'the engine freezes with. An 80% escrow-to-lifetime-deposit ratio is "essentially everything ' +
      'they have ever deposited, behind one order", which is a different act from staking a lot.',
    evaluate(ctx, p) {
      const hit = ctx.allInStake(p);
      if (!hit) return null;
      return {
        severity: 'medium',
        detail: `An order's escrow of ${hit.escrow_cents} was ${hit.share_pct}% of lifetime deposits of ${hit.deposited_cents}`,
        evidence: hit,
        observedCents: hit.escrow_cents,
      };
    },
  },

  // THE RULE THAT HAD TO BE REWRITTEN. See the header, item (1) and (4).
  //
  // The published indicator — "continually bets short-odd favourites and then
  // requests an immediate withdrawal when the payout is received" — is a
  // description of an ordinary betting exchange customer. Implemented literally
  // it alerts on this venue's entire legitimate user base.
  //
  // What it is ACTUALLY pointing at is a customer whose WINS are concentrated in
  // short-odd favourites — who essentially only makes money when the favourite
  // wins — and who takes the money out immediately afterwards. Both halves are
  // necessary and neither alone is enough: "wins only at short odds" is
  // statistically odd for a fair bettor, and "withdraws within the hour of a win"
  // is what a person who does not intend to bet again looks like.
  //
  // CASH-OUT IS EXCLUDED FROM THE WITHDRAWAL COUNT, because cash-out is this
  // venue's headline feature and closing a position for cash is the most
  // ordinary thing a player does.
  short_odds_withdrawal: {
    id: 'AU-EX-02',
    indicator: 'Wins concentrated on short-odd favourites, with an immediate withdrawal after the payout',
    // The published wording is kept verbatim in `published` so the operator can
    // see what was re-shaped and why, which is the difference between a
    // calibration decision and an unaccountable one.
    published:
      'continually places bets on short-odd favourites and then requests an immediate withdrawal when the payout is received',
    scope: 'behavioural',
    severity: 'high',
    tuning: TUNING.short_odds_withdrawal,
    units: { cents: null, count: 'min_wins' },
    calibration:
      'THIS IS THE RULE A LITERAL READING GETS WRONG, and the rewriting is the deliverable. The ' +
      'published indicator describes ordinary exchange behaviour. What is measured instead is the ' +
      'DISTRIBUTION of the customer\'s wins — every winning settlement at or under the price ceiling, ' +
      'with a withdrawal inside the window of at least one of them. A customer with one lucky short-odd ' +
      'win does not trip it; the minimum win count is what separates a pattern from a coincidence. ' +
      'Cash-out is excluded from the withdrawal count for the same reason.',
    evaluate(ctx, p) {
      const hit = ctx.shortOddWinsThenWithdraw(p);
      if (!hit) return null;
      return {
        severity: 'high',
        detail: `${hit.wins} winning settlement(s), all at or under ${p.max_price}, with a withdrawal within ${p.withdrawal_within_minutes} minutes of one`,
        evidence: hit,
        observedCents: hit.won_cents,
      };
    },
  },

  // "Attempts to withdraw funds to an international bank account".
  international_withdrawal: {
    id: 'AU-EX-03',
    indicator: 'Attempts to withdraw funds to an international bank account',
    scope: 'behavioural',
    severity: 'medium',
    tuning: TUNING.international_withdrawal,
    units: { cents: null, count: 'min_attempts' },
    calibration:
      'Compares the withdrawal\'s BENEFICIARY country against the account\'s own recorded country, not ' +
      'against a list. "International" is relative to the customer, and an Australian customer paid ' +
      'out to an overseas account is a different fact from an Australian customer paid out to a ' +
      'different Australian bank.',
    evaluate(ctx, p) {
      const hits = ctx.internationalWithdrawals(p);
      if (hits.length < p.min_attempts) return null;
      return {
        severity: 'medium',
        detail: `${hits.length} withdrawal(s) to a country other than the account's own`,
        evidence: { count: hits.length, window_days: p.window_days, withdrawals: hits.slice(0, 10) },
        observedCents: hits.reduce((s, h) => s + h.amount_cents, 0),
      };
    },
  },
};

// NETWORK SCOPE — the customer's relationships with other accounts.
const networkScope = {
  // "Several accounts under different names opened from the same IP address
  // and/or device" — and, per the Entain finding, MULTIPLE BETTING ACCOUNTS both
  // intra- and inter-brand.
  //
  // ACROSS TENANTS. This venue is multi-tenant and `users.tenant_id` scopes
  // operational tables, so an intra-brand-only rule would miss exactly the case
  // the finding describes: the same person holding an account with two of this
  // venue's own brands. The lookup is therefore deliberately NOT scoped by
  // tenant, and the alert's evidence names every tenant involved so an analyst
  // can see that it is a cross-brand case.
  //
  // A SIGNAL AND NEVER A BLOCK. A person may plausibly hold an account with more
  // than one operator, and may share a device with their household. There is no
  // basis in this codebase for deciding which, and that is a judgement for the
  // operator's compliance officer.
  shared_origin: {
    id: 'AU-NW-01',
    indicator: 'Several betting accounts under different names opened from the same IP address and/or device',
    scope: 'network',
    severity: 'high',
    tuning: TUNING.shared_origin,
    units: { cents: null, count: 'min_accounts' },
    calibration:
      'Requires BOTH a shared origin AND at least two distinct usernames, and it reports the distinct ' +
      'tenants involved. It is a signal for an analyst and never an automatic block: a person may ' +
      'legitimately hold accounts with more than one operator, and may share a device with their ' +
      'household. This codebase has no standing to decide which it is.',
    evaluate(ctx, p) {
      const groups = ctx.sharedOriginGroups(p);
      if (!groups.length) return null;
      return {
        severity: 'high',
        detail: `${groups.length} origin(s) shared by ${groups[0].user_ids.length}+ accounts under ${groups[0].distinct_usernames} distinct name(s)`,
        evidence: { window_days: p.window_days, groups: groups.slice(0, 5) },
      };
    },
  },

  // "Making the same or very similar bets as other accounts flagged as
  // suspicious" — a CORRELATION rule, and the only one that reads the alert
  // table rather than the ledger.
  //
  // It cannot fire on a venue with no open alerts, which is correct: there is
  // nothing to be similar to. That dependency is stated rather than hidden,
  // because a rule whose firing depends on another control's output is exactly
  // the thing a reviewer needs told.
  similar_bets: {
    id: 'AU-NW-02',
    indicator: 'The same or very similar bets as other accounts flagged as suspicious',
    scope: 'network',
    severity: 'high',
    tuning: TUNING.similar_bets,
    // `price_band` is a PRICE in decimal odds, not a money figure and not a
    // count. An operator tuning this rule tunes window_days, min_shared_bets and
    // price_band — and price_band is deliberately NOT reachable through the cents
    // or count columns, because there is no unit column that means "a price".
    units: { cents: null, count: 'min_shared_bets' },
    calibration:
      'Compares RECENT ORDERS against accounts that already have an OPEN alert, within a price band ' +
      'rather than on exact prices — two accounts copying each other will not match the last tick. ' +
      'Depends on another control having fired, which is why it is quiet on a clean venue.',
    evaluate(ctx, p) {
      const hits = ctx.similarToFlagged(p);
      if (!hits.length) return null;
      return {
        severity: 'high',
        detail: `${hits.length} account(s) placed bets very similar to accounts already flagged`,
        evidence: { window_days: p.window_days, price_band: p.price_band, hits: hits.slice(0, 5) },
        observedCents: hits.reduce((s, h) => s + h.stake_cents, 0),
      };
    },
  },
};

// The threshold rules live in their own file (lib/aml/thresholds.js) because they
// are not INDICATORS — they are a statutory threshold with a reporting duty
// attached, and mixing the two would suggest the duty is discretionary. That
// separation is the reason `RULES` below contains no threshold entry.

// Every rule, keyed by id.
const RULES = {};
for (const scope of [transactionScope, behaviouralScope, networkScope]) {
  for (const rule of Object.values(scope)) RULES[rule.id] = rule;
}

const SCOPES = { transaction: transactionScope, behavioural: behaviouralScope, network: networkScope };

function knownRules() {
  return Object.keys(RULES).sort();
}

function rulesFor(scope) {
  return SCOPES[scope] ? Object.values(SCOPES[scope]) : [];
}

/**
 * The rule set as an operator sees it: id, the published indicator, the shipped
 * calibration and the reasoning.
 *
 * DELIBERATELY EXCLUDES `evaluate`. A function cannot be inspected from JSON, and
 * shipping it would produce a payload whose fields change on every deploy while
 * giving an operator nothing they can act on. What they get instead is the
 * calibration prose, which is the part that requires judgement to understand.
 */
function describe(effective) {
  return Object.values(RULES)
    .map((r) => ({
      id: r.id,
      indicator: r.indicator,
      published_indicator: r.published || r.indicator,
      scope: r.scope,
      default_severity: r.severity,
      shipped_tuning: r.tuning,
      // WHAT AN OVERRIDE MAY CHANGE, and which column carries it. Surfaced because
      // an operator setting a threshold on a financial-crime control needs to know
      // which of `value_cents` / `value_count` reaches this rule — and a rule with
      // no cents column saying so is more useful than one that silently accepts a
      // cent figure into a duration.
      tunable: {
        value_cents: r.units && r.units.cents ? r.units.cents : null,
        value_count: r.units && r.units.count ? r.units.count : null,
        window_days: Object.prototype.hasOwnProperty.call(r.tuning, 'window_days') ? 'window_days' : null,
      },
      calibration: r.calibration,
      // Present only when an override exists, and named `effective_tuning` so
      // the operator can always tell the shipped default from what their venue
      // is actually running.
      effective_tuning: effective ? effective(r) : null,
      overridden: effective ? !!effective(r).overridden : false,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ── Small numeric helpers, local so this file has no runtime dependency ──────

function medianOf(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

module.exports = {
  TUNING,
  MAX_WINDOW_DAYS,
  RULES,
  SCOPES,
  transactionScope,
  behaviouralScope,
  networkScope,
  knownRules,
  rulesFor,
  describe,
  medianOf,
};