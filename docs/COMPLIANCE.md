# COMPLIANCE.md — customer pre-verification, AML/CTF monitoring, and the data-source register

**This document is the seam's contract with the operator.** It says what this
repository enforces, what it deliberately does *not* decide, and where each
decision point sits so you can put a name against it.

Two precedents govern everything here, and both are worth reading before the code:

- [`lib/payments/provider.js`](../lib/payments/provider.js) — *no provider is
  built in, and that is a deliberate deliverable boundary.* Which PSP an operator
  may use is not a technical question; it is a contract they have been through
  legal review on. So the deliverable is the seam plus the contract, and
  `lib/payments/reference.js` proves the seam works end to end.
- [`lib/jobs.js`](../lib/jobs.js) — *a discrepancy has to survive being ignored.*
  Reconciliation findings persist, re-surface on every read, and close only with a
  human's written reason. Every AML alert in this document uses that pattern.

**We are not the compliance authority.** Where something is a legal judgement —
whether an activity is suspicious, what a regulator will accept, whether a licence
suffices — this repository implements the *mechanism*, names the decision point,
and records the operator's decision with a reason. It does not make the call.

---

## 1. Customer pre-verification

### 1.1 What the law requires

Australian law has required identity verification **before** an online gambling
account is created since **29 September 2024**, and the interim allowance for
deferring it in special circumstances was **repealed** rather than extended. So
registration on its own cannot produce a usable account.

### 1.2 The provider seam

[`lib/identity/provider.js`](../lib/identity/provider.js) is the contract, modelled
on the payments one. A provider must implement:

| Method | Purpose |
| --- | --- |
| `name` | Stable identifier; lands on every verification row forever |
| `startVerification(subject)` | Begin a KYC run; returns `{ externalId, status, clientToken? }`. The client token is **optional** — a pure-redirect vendor has none, so nothing may require one |
| `readVerification(externalId)` | The outcome **plus the individual checks that produced it** |
| `checkSelfExclusion(subject)` | The **national** self-exclusion register. Not this venue's own `users.self_excluded` column, which knows nothing about any other operator |
| `screenSanctions(subject, ctx)` | Sanctions / PEP screening. A different obligation with a different cadence, so a separate method rather than a flag. Must return the **lists consulted and their versions** — "we screened against something" is not auditable |
| `closeSession(externalId)` | Tear a vendor session down |
| `verifyCallback(rawBody, headers, signature)` | The path that **writes a decision**. Required from day one even though nothing calls it, because it is the part that is easy to get wrong and impossible to retrofit safely |

`assertProvider()` refuses a half-implemented provider **at boot, loudly** — the
same reason the payments contract has one: a missing method must be a startup
crash, never a runtime surprise on someone's identity.

Decision and check vocabularies are **closed**. A provider that returns an
unrecognised decision is refused at the seam, not passed through: a value outside
the set would fail every comparison in the gate and leave a customer stuck with a
row that says something else.

`lib/identity/reference.js` is a complete, deterministic, network-free provider
that exercises every method including the callback signature check.

### 1.3 Where enforcement sits

| Path | Where | Why there |
| --- | --- | --- |
| **Order placement** | `lib/match.js` `validateOrder()`, immediately after the off-time gate and **before anything is written** | Same position and same reason as `lib/offtime.js`: a refusal that runs before the collateral is taken leaves nothing behind, so a future caller cannot reach the escrow path at all |
| **Cash-out, the faucet, and every money path** | `lib/limits.js` `assertTradeable()` — the one function every money path already calls | This is what makes the control **inherited** rather than remembered. A control in a route is a control the next route forgets |
| **Deposit confirmation** | `lib/payments/index.js` `confirmDeposit()`, before `ledger.deposit` | Deliberately at *confirmation*, not at intent creation: a check that runs before the effect and consumes nothing is not a check on the effect — the argument the RG deposit limit is enforced on for |
| **Withdrawal** | `lib/payments/index.js` `openWithdrawal()`, before the hold | See below |

Each refusal carries a **distinct machine-readable code** —
`identity_unverified`, `identity_pending`, `identity_failed`, `identity_review` —
because the client has to render different advice for each.

### 1.4 Why withdrawal is gated when self-exclusion is not

`/api/wallet/withdraw` deliberately does **not** call `assertTradeable`. The
route's own comment gives the reason: *"Refusing to let someone take their own
money out is a far worse failure than the gap above, and self-exclusion is a
promise about PLAY, not about custody."*

That reasoning is correct for self-exclusion and it **does not transfer to
identity**. An unverified account is an account the venue cannot prove belongs to
the person asking. Paying out of it is not custody of *their* money — it is a
payout to whoever opened the account, on a rail that in the NPP/Osko case cannot
be reversed at all. Identity is therefore gated on the payout, before the hold.

### 1.5 Exemptions — named, not implied

- **The house (`is_bot = 1`).** The venue's own market maker cannot complete a
  customer KYC flow because it is not a customer; gating it would look correct and
  break the product.
- **The operator's own accounts (`role = 'admin'`).** A pre-verification
  obligation is an obligation about *customers*. Staff accounts fall under the
  operator's own HR and AML policy, which is not this codebase's business to
  invent a rule for.

There is deliberately **no `exempt` value** in the identity vocabulary. The
remediation path for an account that predates the obligation is an operator
recording a decision **with a written reason**, which is audited and attributable.

### 1.6 Registration alone does not produce a usable account

`users.identity_status` defaults to `unverified`. An upgraded database therefore
gains every pre-existing account as unverified — which, with `IDENTITY_REQUIRED`
on, means none of them can trade until the operator brings each into compliance.
**That is the obligation's shape**: the rule has a commencement date, and
pre-existing accounts are the operator's remediation problem. Backfilling them as
`verified` would wave the whole existing base through a law that has been in force
since September 2024, which is not a migration's call to make.

### 1.7 Age assurance is a SEPARATE record, and that is the deliverable

The reform bill's explanatory memorandum addresses **age assurance separately from
identity**, and does three things this schema exists to make possible:

1. personal information collected **for age assurance** must be **destroyed once
   used**, absent elevated consent;
2. **no Australian is to be forced to use government identification** (including
   Digital ID) for age assurance;
3. age assurance is not, by itself, an identity control.

So there are two tables with two retention policies:

| Table | Holds | Retention |
| --- | --- | --- |
| `identity_verifications` | the decision, the **constituent checks**, an opaque subject reference and the provider's asserted name | kept — it is financial-crime material |
| `age_assurance` | an **attestation**, a method, an assurance level and an opaque vendor handle | **destroyed once used** |

**There is no date of birth, no document type, no document number and no image
anywhere in this schema.** `tests/compliance.test.js` asserts that at the column
level, because "it is obviously not there" is not a control.

### 1.8 The assumption we are deliberately *not* making

It is entirely plausible that a **privacy-preserving digital-identity network**
proves a person is over 18 **without the venue ever receiving a document or an
identifier of any kind** — that is the point of that design, and it matches the
bill's own safeguard directly. So the record shape is built to be *complete if the
vendor returns nothing at all*: `attributes` may be `NULL`, `outcome` is the whole
payload, and no code path requires a document to have been seen.

A model that assumed a stored document image would have been wrong on day one and
expensive to change.

### 1.9 Erasure is cheap either way

If the provision is not enacted, erasure costs nothing — the record is nulled when
it has been used, and the durable evidence (a check **outcome** inside the
verification's checks list) is untouched. If it is enacted, retrofitting
"separately erasable" onto a schema that conflated the two means splitting a
record class other code is already reading. **That asymmetry is the whole argument
for two tables.**

Erasure is:

- **individual** — one person, one record;
- **reasoned** — it takes a written reason;
- **audited** — `identity.age_assurance_erased`;
- **structural** — applying a verification decision erases the artefact **in the
  same transaction**, so "destroyed once used" is a property of the code and not of
  a job somebody might forget to schedule;
- **a tombstone, not a deletion** — the identifying columns are nulled and
  `erased_at` stamped, because "was it destroyed?" is the first question an auditor
  asks and deleting the row makes it unanswerable.

---

## 2. AML / CTF monitoring

### 2.1 The rule source

AUSTRAC publishes **sector-specific suspicious-activity indicators for the online
betting sector**. Every rule in [`lib/aml/rules.js`](../lib/aml/rules.js) carries
the indicator it encodes in `indicator`, the published wording in `published`, and
its own reasoning in `why`-style prose. `GET /api/admin/aml/rules` returns all of
it (or a CSV of it) so an operator can read what the venue watches for **without
reading the source**.

| Rule | Indicator |
| --- | --- |
| `AU-OB-01` | Betting plunges — massive and sudden support for one selection in a market |
| `AU-OB-02` | Multiple, large or maximum bets on obscure markets |
| `AU-OB-04` | Using the total funds deposited to place a large or maximum bet |
| `AU-EX-02` | Continually places bets on short-odd favourites and then requests an immediate withdrawal when the payout is received |
| `AU-EX-03` | Attempts to withdraw funds to an international bank account |
| `AU-NW-01` | Several betting accounts under different names opened from the same IP address and/or device |
| `AU-NW-02` | The same or very similar bets as other accounts flagged as suspicious |
| `AU-TX-01` | Unusually large deposits |
| `AU-TX-02` | Unusual patterns of deposits |
| `AU-TX-03` | A deposit funded by a person other than the account holder |
| `AU-TX-04` | Deposits from a foreign or restricted jurisdiction |

### 2.2 Calibration is not a detail — it is the control

AUSTRAC's finding against a large Australian operator in December 2024 was not
that it lacked rules. It was that *"transaction monitoring processes were not
appropriate for a business the nature, size and complexity of Entain."* That is a
**calibration** failure. A rule set that would not fire on the concrete activity
that actually happened is not a control; it is a document.

So every rule is expressed in **this venue's own ledger** and calibrated against
**this venue's own normal behaviour**, and `tests/aml.test.js` asserts the naive
reading does *not* fire.

#### The four that would have been catastrophically wrong

**(1) "Continually bets short-odd favourites and then requests an immediate
withdrawal when the payout arrives" describes an ordinary exchange customer.**
Betting short prices and taking profit is what the product is. A rule written
straight off the list alerts on the venue's entire legitimate user base, and an
operator who is alerted on every customer either disables the system or
investigates nobody.

`AU-EX-02` is therefore **not** "bets short odds, then withdraws". It measures the
**distribution of the customer's wins**: every winning settlement at or under the
price ceiling, with a withdrawal inside the window of at least one of them. The
published wording is kept verbatim in the rule so the re-shaping is visible rather
than silent. Cash-out is excluded from the withdrawal count, because cash-out is
this venue's headline feature.

*Honest limit, stated rather than glossed:* a customer who genuinely only ever
bets short favourites and genuinely takes the profit is **indistinguishable on
betting behaviour alone** from the one the indicator describes. No threshold
separates them. That is precisely why this is a signal for an analyst and never a
block.

**(2) "Multiple, large or maximum bets on obscure markets"** — on an exchange,
large bets on thin markets are what the venue's **own market maker** does, on every
market, all day. Taken literally it flags the house. `AU-OB-02` excludes the venue's
own accounts and defines "obscure" by **this venue's own liquidity** (thin matched
volume *and* few distinct traded price levels) rather than by an absolute stake.

**(3) "Using the total funds deposited to place a large or maximum bet"** — on an
exchange the figure that matters is the **escrow**, not the stake, because a LAY
at 10.0 freezes nine times the stake. Measuring stake would flag every layer and
miss every backer who staked everything they had. `AU-OB-04` measures
`round((price−1) × stake)` — the same formula the engine freezes with.

**(4) The same indicator also collides with CASH-OUT**, which is the most ordinary
thing a player does. The rule measures withdrawal after **settlement**, not after
any exit.

#### Also handled

- **"Unusually large"** is measured against the account's **own trailing median**.
  An absolute threshold flags every customer of a high-stakes venue and none of a
  low-stakes one, which is backwards.
- **The house is excluded from every behavioural rule** — numerator *and*
  denominator. A rule that fires on the house is a rule an operator disables.
- **"Obscure"** needs both halves of thinness: a selection can carry a lot of
  volume in one price (the maker filling against itself) while being untradeable,
  and it can carry a dozen tiny fills in a wide book that is perfectly liquid.

#### Units are declared on the rule, and a wrong unit is refused at write time

Every rule declares which of its tuning parameters is a **money** figure and which
is a **count** — on the rule itself, in a `units` field, and surfaced through
`GET /api/admin/aml/rules` as a `tunable` block. It is deliberately *not* a map in
the engine, because a map is a thing that drifts from the rule it describes and
the drift is **silent**: a cent figure landing on a duration, or a count landing
on a percentage, misfires by a factor of 100 and reads as a working control. The
first version of the engine had exactly such a map and exactly such an entry —
`AU-TX-02`'s `min_interval_minutes` was declared as its money parameter, so a
600-cent threshold would have been read as 600 **minutes**.

An override with nowhere to go is **refused when it is set**, not when it is next
read. An operator who sets a cent threshold on a rule with no money parameter and
sees the write succeed has been told they tightened a control they never touched.

An override supplies only the fields it names, so moving one number does not reset
another to zero by omitting it.

### 2.3 Cross-account link analysis, across tenants

`AU-NW-01` is deliberately **not scoped by tenant**. "Multiple betting accounts –
inter and intra brand" is an enumerated finding, and on a multi-tenant venue the
intra-brand case **is** the cross-tenant case: two accounts under two of this
venue's own brands are two `users` rows with two `tenant_id` values and no
relationship between them anywhere else. The evidence names every tenant involved,
so an analyst can tell an intra-brand case from an inter-brand one without running
a query.

It is a **signal and never a block**: a person may plausibly hold an account with
more than one operator, and may share a device with their household.

`AU-NW-02` correlates against accounts that **already have an open alert**, matched
on a **price band** rather than exact prices — two accounts copying each other will
not match to the tick. It is quiet on a clean venue, which is correct.

### 2.4 The threshold — AUD 5,000, as a durable obligation

Since **31 March 2026** the customer-due-diligence exemption threshold for
gambling providers dropped from under AUD 10,000 to under **AUD 5,000**. It is
`config.AML_THRESHOLD_CENTS`, not a constant: the operator holds the licence and
knows their regulator's current position.

Crossing it does **not log**. It creates a row in `aml_threshold_obligations`
that re-surfaces on every read until a human discharges it with a written reason.
A reporting duty has to survive the process that noticed it.

Two bases, because structuring is the point:

- `single` — one transaction at or over the threshold;
- `related` — several transactions that each sat **under** it and crossed it
  together, over a rolling 24 hours.

Repeated crossings **update** one row and increment `seen_count` rather than
opening a new one. Discharging records the **report generation reference**, not a
filing receipt: this repository generates reports and submits nothing, and a
boolean would let an operator mark a statutory duty discharged on the strength of
a file nobody sent.

### 2.4a The pass is a JOB, not only a route

`POST /api/admin/aml/scan` runs the same function the scheduled job runs, and
there is a scheduled job — `lib/jobs.js` `amlPass`, hourly by default. **A rule
set that only fires when an operator presses a button is a rule set that does not
fire**, and the difference is invisible from inside the code: every assertion
passes and no alert is ever raised. That is the dead-control shape this repository
keeps finding, and `reconcileOnce` exists for exactly the same reason.

The pass is **bounded** (a capped cohort, because `node:sqlite` is synchronous and
an unbounded scan over a real book is an outage), it **reports any rule that
threw** rather than folding it into a count, and it returns `enabled: false` with
an explanatory `note` when monitoring is off — so a misconfigured deployment
reports *"off"* rather than *"nothing found"*.

### 2.5 What is deliberately **not** a rule

- **Cash.** AUSTRAC found a monitoring failure to detect cash at an operator whose
  deposit channels were all electronic. This venue has no cash rail, no retail
  top-up and no cashier. Omitting the indicator is a **positive statement about this
  venue's rails**, recorded in the rule table rather than left as a silence. If an
  operator adds a physical or agent-assisted channel, that is the file to change.
- **A named loyalty or prepaid product.** The *mechanism* for one exists —
  `payment_methods.kind` carries `prepaid` and `funding_instruments.instrument_kind`
  carries `prepaid`, so the product class is registrable and its funding pattern is
  measurable — but the **rule** is left to the operator, who knows the product's
  terms.
- **Any regulatory list.** No restricted-jurisdiction list ships with this
  repository, for the reason `lib/tenants.js` refuses to ship an ISO currency
  registry: a stale regulatory list is a control that is **confidently wrong**. We
  ship the *check*; the operator supplies the list, and the boot log says out loud
  when monitoring is on with none configured.

### 2.6 Tipping off is a criminal offence

The exposure runs to **staff who are not entitled to know** as well as to the
customer. Three surfaces, all enforced:

| # | Surface | Control |
| --- | --- | --- |
| 1 | **The customer** | `GET /api/identity/me` returns the account's own status, whether a verification is in progress and what to do next. It contains **no screening outcome, no constituent checks, no operator reason, no alert, and no verified name**. `POST /api/identity/screen` returns `{ screened: true, checks: 2 }` and nothing about the outcome — a screening endpoint that returned `hit: true` would hand the customer the fact that they are on a national register |
| 2 | **Staff** | Every AML surface requires a row in `aml_entitlements`. `'admin'` is the venue's *general* operator role and is held by whoever runs the trading desk, the support desk and the content desk; whether any particular person may read a suspicious-matter file is the operator's compliance officer's call. **The table ships empty**, so nobody is entitled and the surfaces refuse with `aml_not_entitled`. Granting and revoking are audited, reasoned acts |
| 3 | **The audit log and metrics** | Report *generation* is audited with the row ids it covered — but **not the contents**, because the audit log is read by a wider audience than the financial-crime desk. No AML gauge is added to `/metrics`: a count discloses that financial-crime work exists, which is not something to publish to anyone holding an ops token |

An unresolved alert has **no automatic expiry**. Nothing in `lib/aml/findings.js`
ages an alert out; a financial-crime record that disappears on a timer is the
failure mode the whole reconciliation pattern exists to prevent.

### 2.7 Reports — generated, never submitted

| Route | Produces |
| --- | --- |
| `GET /api/admin/aml/reports/threshold-transactions` | threshold transaction report — one row per **open obligation**, because the ledger can be re-derived and an obligation cannot |
| `GET /api/admin/aml/reports/suspicious-matter` | suspicious matter report — one row per **open alert**, each resolving its rule id to the published indicator |

Both default to **CSV** with their definitions block appended (the CSV is the
artefact that gets filed), and both carry an explicit
`submission: { submitted: false, note }`.

**Nothing here talks to a regulator.** A submission is a legal act in the
operator's name, under their licence, through a channel they have a relationship
with. Code in this repository that could do it would be making that act on their
behalf. What this repository does is make the data correct, complete,
self-describing and exportable — and make the duty to file visible as an
undischarged obligation until a human says otherwise.

Every suspicious-matter row carries `basis: "rule-fired"` and a definition that
says, in words, that a row means a rule fired against an account's ledger activity
and **does not** say the account holder has done anything wrong.

### 2.8 "What would this have caught?"

The design has to answer that for a **named scenario**, because that is what
"calibrated" has to mean in practice. Three from AUSTRAC's December 2024 statement
against a large Australian operator, and the outcome is asserted in
`tests/aml.test.js`:

| The finding | What happens here |
| --- | --- |
| **"a person (a third party) other than the person in whose name the betting account was held"** | `lib/funding.js` **refuses at intake** with `funding_instrument_third_party`, before any credit, on a rail where a wrongly-accepted deposit cannot be clawed back. `AU-TX-03` catches retrospectively anything that got through before an instrument was registered |
| **"multiple betting accounts – inter and intra brand"** | `AU-NW-01` groups accounts by shared registration IP **and/or** device, **across tenants**, requiring both a shared origin and two distinct usernames. Signal, never a block |
| **"deposits from a foreign jurisdiction, including from a restricted-jurisdiction list"** | `AU-TX-04` reads the **funding** country on the payment intent, which is the instrument's country and not the customer's — a separate finding from the session-jurisdiction gate, exactly as the regulator treated them |

And the one that is a **calibration** failure rather than a missing rule: every
rule is shaped to this venue's ledger, so an alert means what it says.

---

## 3. Deposit funding — the intake gate

### 3.1 The Osko trap, and how it is avoided

On the NPP/Osko rail in Australia, an operator's **receiving PayID is normally
registered to a payment processor or intermediary company, not to the venue.** So
the naive rule — *"the funding instrument's registered name must equal the account
holder's"* — is **false for every legitimate Osko customer in the country.**

The comparison is therefore **"whose instrument is it"**, answered from a register
the operator maintains (`funding_instruments`):

| `owner_kind` | Meaning | Outcome |
| --- | --- | --- |
| `venue` | the venue's own account | **cleared** |
| `processor` | a contracted processor's **pool**, held on the venue's behalf | **cleared** — *this is the Osko case* |
| `player` | an account holder's own instrument | name **must** match |
| `unknown` | nobody can say | **refused** |

`unknown` is the fail-closed half and it is what makes this a control rather than
a formality: an instrument whose ownership nobody can state **is** the
third-party case by definition.

The register **ships empty**, and an unregistered instrument is refused. Exactly the
posture `lib/config.js` takes for `FEED_CREDENTIALS_KEY`: *"not configured" is
refused, not treated as "allowed."*

### 3.2 Why it must be a refusal at intake

**NPP/Osko transfers are irrevocable with no chargeback.** Once a deposit has been
accepted onto that rail it cannot be clawed back by anyone, including the venue
and including the bank. There is no recovery step at all — so the check either
happens before the credit or it does not happen.

Refusals are **audited even though no money moved**: the question an operator must
be able to answer is *"was this attempted, and how often?"*, and a refusal that
leaves no trace is an absence rather than a control.

### 3.3 Payment methods carry TERMS, not just names

"PayPal" and "PayPal, approved seller, Australian customers only" are different
facts, and only the second can be enforced. `payment_methods` records:

- `kind` — a closed vocabulary;
- `credit_linked` — **credit is a relationship, not a name**. One Australian
  operator prohibits credit cards **and any payment method linked to a credit
  card — including digital wallets and BPAY** — while leaving debit cards
  unaffected. A single `kind` column cannot express that; a wallet can be
  debit-funded or credit-linked and is the same wallet;
- `seller_status` — `approved_seller` / `restricted_seller`;
- `permitted_countries` — **enforced**, so "approved seller, AU customers only"
  stops being a note in a spreadsheet.

A wallet or PayPal **cannot be enabled** without recording `seller_status`. The
refusal is `payment_method_terms_required`.

### 3.4 Funding jurisdiction is a separate question from play jurisdiction

`lib/tenants.js` already gates the **session** side at login. That gate is correct
and it is **not sufficient**: a customer sitting in Sydney can fund an account from
a foreign bank account, and nothing about their session reveals that. The two share
a vocabulary and no code, and they are kept apart for the same reason the regulator
made them separate findings.

`AML_RESTRICTED_JURISDICTIONS` blank means **"you have no restricted list"** — a
real state, and the boot log says which state you are in, because an operator who
believes they have a list and has not configured one is in the dangerous state.

### 3.5 Where the facts come from — and what survives a refusal

`payer_name` and `funding_country` are the only facts the third-party-funding
control has, and they are facts about the **payment**, not about the account. They
arrive on the **PSP's confirmation** and are recorded onto the intent row by
`confirmByExternalId` **before** the gate reads it. The alternative — passing them
straight to the gate as parameters — would make the detection signal a parameter
of the function meant to detect it, so an adapter that forgot to pass them would
produce a control that silently finds nothing.

**The rail's first report wins.** The write is `COALESCE`d, so a later
confirmation cannot restate who funded a deposit or where it came from. "The
processor pool" and then later "somebody else" is drift in exactly the direction
that makes a suspicion disappear, and a financial-crime record must not have it.

**And what survives a refusal** is worth stating plainly, because the answer is
not the obvious one. The funding metadata is written inside `confirmByExternalId`'s
transaction, and a refusal rolls that transaction back — so the intent row does
*not* carry the payer name. That is correct: a row written inside the transaction
that the refusal rolls back does not survive it, and `lib/jobs.js` makes the same
argument about reconciliation findings.

What survives is the **audit row the caller writes once the transaction has
unwound** (`lib/funding.js` `recordRefusal`, called from `server.js`). That is the
answer to *"did you ever see a deposit funded by this name?"*, and the intent stays
`pending` — **not** `failed` — because a refused deposit is a thing a human has to
look at, and failing it would make it invisible to exactly the person who needs to
see it.

---

## 4. The data-source register

Racing NSW's rules require an operator using NSW race-field information to hold an
**approval from Racing NSW regardless of where it is domiciled or licensed**, with
fees payable. "We are licensed somewhere else" is not an answer, so the venue needs
a register of, per source: **who owns it**, **what approval is held**, **what it
may be used for**, and **when it expires**.

### 4.1 Three uses, not one boolean

`permits` is a set over a closed vocabulary — `display`, `store`, `settle` —
because the three have completely different consequences. A display-only approval
that settles a race is a settlement the venue cannot defend, and a store
permission that is never displayed is a database holding data it has no right to
hold.

### 4.2 It extends `result_events`, it does not replace it

`result_events.source` already exists and says something real: `poll` / `webhook` /
`manual` / `import` — **how** the outcome arrived. It does not say **under what
right**, and a transport cannot. So `data_source_id` is **added alongside it**:
nothing that reads `source` changes, the vocabulary is untouched, and an outcome
that arrives with no registered source still records exactly what it recorded
before.

### 4.3 Where it is enforced

| Where | What |
| --- | --- |
| `GET /api/admin/data-sources/:id/check?use=settle` | The **pre-flight check** — "may I rely on this?" answered with a distinct code per cause: `unknown_source`, `source_disabled`, `licence_expired`, `not_yet_active`, `use_not_permitted` |
| `lib/results.js` `applyOutcome` | Validates a `dataSourceId` that **is supplied**. An outcome naming a source whose licence does not permit settling is refused. Also reachable through `pollOnce(db, fetch, { dataSourceId })` — validated **once before any market is touched**, so an expired licence cannot settle the first fifty markets and then refuse the fifty-first — and through `releaseHold`, where it is a parameter of the **release** rather than of the hold, because a manual release is exactly the case where *"under whose approval was this settled?"* is asked months later |
| `GET /api/admin/data-sources` | Reports `unsettled_without_source` |

**And what it deliberately does not do:** refuse an outcome that names **no**
source. That would change settlement for every existing deployment and is out of
scope. The gap is made **visible** instead — forcing a source would mean inventing
a licence attribution, and a fabricated attribution in the provenance row is
precisely the fabrication the register exists to prevent.

Three licence **states**, not two: `active`, `expiring`, `expired`. "Expiring" is
its own state because it is the one an operator most needs to act on, and a
two-valued flag hides it: a licence that expires in three weeks *is* currently
usable, and an operator who reads "active" and stops looking is the failure. The
window is `DATA_SOURCE_EXPIRY_WARN_DAYS`.

The register **ships empty**. A guessed licence reference is worse than none.

---

## 5. Retention

Financial-crime records are kept far longer than operational data, and the failure
mode is specific: a generic retention job that does not know what a table *is* will
delete an alert row, and the deletion is invisible. There is no row saying "this
was deleted by the retention job", no finding, no log.

[`lib/retention.js`](../lib/retention.js) is the answer, and it is **declarative**:

- `PROTECTED_TABLES` — `aml_alerts`, `aml_threshold_obligations`,
  `aml_rule_thresholds`, `aml_entitlements`, `identity_verifications`,
  `funding_instruments`, `payment_methods`, `data_sources`,
  `reconciliation_findings` — each with a **reason**.
- `mayPrune(table)` — the default is **permissive for unlisted tables** (they are
  operational data) and **refusing for listed ones**. The cost of wrongly
  protecting a table is that it keeps more than it needs; the cost of wrongly
  deleting one is that a compliance record is gone and nobody knows.
- `assertPrunable(table)` — the guard a pruner calls, for the next contributor.
- `GET /api/admin/retention` — so an operator can see the list **before** they
  write a housekeeping job against this database.

### 5.1 And the one table that is the opposite

**`age_assurance` is explicitly NOT protected.** It is the one record that must be
**destroyed**, and it is also the one that structurally looks most like
financial-crime material — it sits beside the identity record and is referenced by
an audited action. If the default for "looks like compliance data" were "keep it",
this row would be kept forever by an operator who was being careful.

`tests/aml.test.js` asserts the exclusion from **both** sides: no protected table
appears in a `DELETE FROM` anywhere in `lib/`, and `age_assurance` is not on the
protected list.

### 5.2 There is no pruner for any of it

Deliberately. `lib/marketdata.js` prunes the trade tape to 30 days because a chart
series has a reader whose need expires. Writing a pruner for financial-crime tables
would be writing the defect this module exists to prevent.

What exists instead is **erasure** — narrow, per-record, reasoned and audited.
A retention job is a decision about **everyone** with **no name** against it; an
erasure is a decision about **one person** with a **name** against it. Only one of
those is ever appropriate.

---

## 6. Configuration

Every key is in [`.env.example`](../.env.example) with the default
`lib/config.js` actually uses.

| Key | Default | Meaning |
| --- | --- | --- |
| `REGULATED_DEPLOYMENT` | `false` | "This venue holds a licence and serves real customers." The switch the funding gate and the threshold obligation hang off — on a paper-money install there are no payment instruments to inspect, so a control that refuses an unregistered one would refuse **every** deposit |
| `IDENTITY_REQUIRED` | `false` | Enforce customer pre-verification. **Turning it on with no provider ABORTS THE LAUNCH** |
| `IDENTITY_PROVIDER` | `''` | Which registered provider to select at boot |
| `IDENTITY_CALLBACK_SECRET` | unset | HMAC secret for the decision callback. Unset ⇒ `POST /api/identity/callback` **404s** |
| `AML_MONITORING_ENABLED` | `false` | Run the rule pass |
| `AML_SCAN_INTERVAL_MS` | `3600000` | How often the scheduled pass runs. `0` disables the timer. Read straight from the environment by `server.js` rather than through `lib/config.js`, like every other interval here — these are operational knobs, not compliance posture |
| `AML_THRESHOLD_CENTS` | `500000` | AUD 5,000 — the figure from 31 March 2026 |
| `AML_RESTRICTED_JURISDICTIONS` | `''` | Comma-separated ISO-3166 alpha-2. **Blank is a real state** and the boot log says so |
| `FUNDING_REFUSE_UNREGISTERED` | `true` | Refuse a deposit whose funding instrument is not registered |
| `DATA_SOURCE_EXPIRY_WARN_DAYS` | `30` | When the register starts warning about an expiry |

### 6.1 What the boot log says

Loudly, in the same spirit as the responsible-gambling warning:

- pre-verification is **not** enforced, and the law that requires it;
- `REGULATED_DEPLOYMENT` is not set, and what is therefore inert;
- **no funding instruments registered** ⇒ every deposit will be refused — and what
  to register first;
- `REGULATED_DEPLOYMENT` on but `AML_MONITORING_ENABLED` off ⇒ the threshold
  obligation is live but **no rule is running**;
- monitoring on with **no restricted-jurisdiction list**;
- **nobody is entitled** to financial-crime material, and the surfaces 403 until
  somebody is.

`IDENTITY_REQUIRED=true` with no `IDENTITY_PROVIDER`, or with
`IDENTITY_PROVIDER=reference`, **aborts the launch**. A mock that passes anyone is
exactly what must never sit behind a live customer onboarding flow.

---

## 7. What this repository does not do

- **It does not build a vendor adapter.** The seam is the contract plus a reference
  implementation. Which KYC, screening or payments provider an Australian venue
  may use is not a technical question.
- **It does not submit anything to AUSTRAC or any regulator.** It generates the
  data and records the duty.
- **It does not decide what is suspicious.** Every alert is a signal; the
  characterisation is the operator's compliance officer's, recorded with a reason.
- **It does not block an account.** Nothing in the monitoring path suspends, closes
  or limits anybody. The one exception is the **intake gate**, which answers a
  different question: *may we accept money from an instrument whose owner we cannot
  name?* on a rail where accepting it wrongly is irreversible.
- **It does not build for a law that has not passed.** A monthly deposit cap is
  foreseeable — a private member's bill proposing them was announced for the NT
  parliament on 14 October 2026 — and the deposit-limit surface (`RG_DEPOSIT_DAILY_CENTS`,
  and the per-user `limits` table) is already the shape a monthly cap would take, so
  it would be a configuration change rather than a code change. **No monthly cap is
  implemented.**
- **It does not ship a regulatory list.** A stale restricted-jurisdiction list is a
  control that is confidently wrong.

---

## Related documents

- [`API.md`](API.md) — every route, including the compliance surfaces
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — module layout
- [`EXCHANGE_RULES.md`](EXCHANGE_RULES.md) — the financial invariants
- [`../lib/identity/provider.js`](../lib/identity/provider.js) — the provider contract
- [`../lib/aml/rules.js`](../lib/aml/rules.js) — the rule table and its calibration
- [`../lib/funding.js`](../lib/funding.js) — the deposit intake gate
- [`../lib/datasources.js`](../lib/datasources.js) — the data-source register
- [`../lib/retention.js`](../lib/retention.js) — what may be deleted, and why