# STATE.md — where this project actually is

Written after the 81-issue review and remediation pass. Every number here was
measured, not remembered. Where something is asserted from memory it says so.

**Purpose:** one page that separates *what exists* from *what is needed*, so
nobody has to re-derive it from the issue tracker. It is a snapshot, not a
contract — if it disagrees with the code, the code is right and this file is a bug.

---

## 1. What exists

### It runs, from a clean clone

Verified end to end in a throwaway clone, not on the author's machine:

```
git clone → npm install → npm run seed → npm start → HTTP 200
```

`npm run seed` produces 5 sports, 6 competitions, 12 events, 12 markets, 33
selections, 3 users, and bot liquidity on every open market.

### The engine is real

A back/lay order book with a matching engine, per-order escrow as the single
source of truth, tick-ladder pricing, a venue-buyout cash-out, an in-play bet
delay, per-user abuse limits, responsible-gambling controls, and an operator desk.
47,803 lines across 32 `lib/` modules, 10 frontend files and a test suite.

### The safeguards are unusually complete

- **Audit trail** on every consequential action, with a transaction so a mutation
  cannot commit without its audit row.
- **Backup** by `VACUUM INTO` — a transactionally consistent snapshot of a *live*
  database — with integrity verification and retention pruning.
- **Responsible gambling**: deposit limits, session limits, reality checks,
  self-exclusion. All wired, and self-exclusion is unconditional.
- **Error handling** that clamps 5xx to a generic message so internals cannot
  reach a browser.
- **Secrets** are refused rather than stored in plaintext when no encryption key
  is configured.

### Engineering discipline

| | |
|---|---|
| Tests | **826 checks / 64 suites**, plus a **212-check** Playwright browser suite |
| CI | 8 jobs: node 22 + 24, browser, guards, load smoke, dependency audit, and two secret scans |
| Supply chain | every action pinned to a full commit SHA, dependabot configured |
| Docs | `check-docs.mjs` **fails the build** when documentation contradicts the code |
| Secrets | a blocking scan of new commits, plus an advisory full-history scan |

The documentation checker is the unusual part. It caught, unprompted: three
stale test counts, an "orphaned" screenshot, a doc claiming the frontend never
calls `/api/branding` (false for months), and a fabricated image link I
introduced while fixing another thing.

### The checks that watch the *checker* — `3f9d648`

Worth calling out because it is the only class of defect that every assertion in
this repository is structurally blind to. `docs/API.md` shipped to `main` with
live `<<<<<<< HEAD` markers in its route table, committed by a blanket `git add`
during a rebase. All 8 CI jobs were green.

Every assertion here asks *"does this claim match the code?"* A conflict marker is
not a wrong claim — it is the **absence** of a file's intended content. No count,
link, route-coverage or contradiction check can see it, because each one reads
the file and reasons about what it says, and this one says nothing.

The same mistake had already been caught once in a worktree, where a suite died on
`SyntaxError: Unexpected token '<<'`. In `server.js` a marker is a syntax error
and the codebase screams; in markdown it is inert text and waits. The lesson is
the asymmetry, not the bug: **the same mistake is loud in code and silent in
prose**, and there had been a safety net for exactly one of them.

`scripts/check-conflict-markers.mjs` now runs in CI. It matches the 7-character
opening marker at the start of a line and nothing else — matching `=======` alone
would fire on horizontal rules and prose, and a check that cries wolf gets
switched off.

### Governance

MIT licence, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/SECURITY.md`,
PR and issue templates, dependabot, and a Keep-a-Changelog `CHANGELOG.md` with
substantive Security entries.

---

## 2. What is needed

Ordered by how much it changes what the project *is*, not by effort.

### 2.1 An external API contract — the defining gap

**Betfair's Exchange API is their product.** The ecosystem around it is the
reason the exchange has users. This project cannot grow past its own UI without
the equivalent.

As measured on `main` before the work started:

| | |
|---|---|
| API version header | **0 occurrences** |
| Rate limits documented | **0 mentions** in `docs/API.md` |
| Machine-readable error codes | partial — some routes carried `details.code`, most carried nothing |
| Stability promise | none |

**Status: MERGED at `8fe1ee9`.** What it builds, and what is deliberately odd
about it:

- `X-API-Version` on **every** `/api` response including errors, because a client
  most needs to know what it is talking to when it is failing. It is a
  *response* header, not a request one — requiring it would break every existing
  call on the day it landed, and a version you can only opt *out* of is not a
  promise.
- `API_VERSION` is a **standalone constant, not a config key**, while almost
  everything else in `lib/config.js` is deployment config read from the
  environment. That asymmetry is the design: an operator who could set it could
  announce version 2 from a `.env` while still serving version 1, and every
  client trusting the header would be wrong undetectably.
- `X-RateLimit-Limit/-Remaining/-Reset` on **every** response through a limited
  route, not only the 429. A disabled bucket emits **no** headers rather than
  `Limit: 0` — a disabled limit is not a limit of zero, and announcing one tells
  a pacing client to back off against a ceiling that does not exist.
- A machine-readable `code` on every error, via a single `apiError()` shaper all
  44 error responses now route through, so the two response paths cannot drift.

Still open in that area, and it is not small: the SSE stream as a documented
subscription with reconnect semantics. What exists is an *invalidation ping*, not
a market data feed — see `#90`, filed during the Betfair-parity deep dive.

### 2.2 A first release — and a changelog that invents two

Measured, not remembered:

| | |
|---|---|
| `git tag` | **0 tags** |
| `package.json` version | `0.1.0` |
| Was `0.2.0` ever set? | **No** — `git log -S'"version": "0.2'` returns nothing |
| `CHANGELOG.md` sections | `[Unreleased]` (343 lines), `[0.2.0] - 2026-09-25`, `[0.1.0] - 2026-09-24` |

So the changelog documents **two releases that never happened**, on the repo's
first two days, with no tags and no version bump behind them. `[0.2.0]` describes
"a real-browser Playwright suite (24 checks)" — that was day 2 of a 166-commit
repo. It is 212 browser checks and 64 suites now.

For an open-source project this is worse than an absent changelog, because it
answers "is this maintained?" wrongly. A reader concludes there is a release
history; there is none. `[0.2.0]` also contains **two separate `### Fixed`
sections**, which Keep a Changelog forbids.

`check-docs.mjs` does not catch any of it, which is the expected result: the
question it asks is "does this doc match the code?", and a fabricated release is
not a contradiction — it is a claim about a *fact that does not exist*. Same
blind spot class as the conflict markers in §1.

Cutting a real `v0.1.0` needs an authorial decision, not a mechanical fix: fold
`0.1.0`/`0.2.0` into `[Unreleased]` (honest, loses nothing), or keep them as
draft headings marked unreleased. Either way the tag and the `package.json`
version have to be made to agree with each other, which today they do not.

### 2.3 User automation — specced, half-built

The product decision: in-app user bots, rules not code, evaluated server-side.
Decomposed into `#75`–`#81`. **`#75` and `#76` are merged.**

Counterparty, as decided: **a user's own manual orders may fill that user's
rules** — audited and visible. The house must NOT fill bot orders.

Two things carry forward:

- **`#77` is deferred by decision, not by neglect.** `#76` shipped one-shot per
  crossing; the product decision said continuous. One-shot was accepted as
  adequate for now, so `#77` is parked rather than pending.
- **Self-generated P&L is the price of the feature.** With the house excluded
  from filling bot orders and one player on the venue, a rule's only counterparty
  is that player's own manual orders. Every such fill is marked
  `matches.self_crossed` and audited, but a player whose numbers are partly
  self-produced needs to be told in the product, not only in the docs. Carried by
  `#79`/`#81`.

### 2.3a `#75` had not enforced the decision it was meant to enforce

Recorded because of what it says about this project's own bookkeeping. The rule
that the **house must not fill bot orders** had been written into an agent brief
as *already done*. It was not: the sweep's only same-party test was
`o.user_id === userId`, so an automated order was matchable by any other user —
which on this venue is the house bot and nothing else. With the bot requoting
every 5 seconds, **every rule order would have been taken by the desk within a
tick**, and the feature would have looked like it worked while quietly being
desk-filled.

The agent found it by checking. It was the second time this pass that an
instruction I wrote about the repo's state turned out to be wrong.

### 2.4 Known defect: the browser suite is order-dependent

**Characterised, not fixed.** Three clean-`main` runs gave pass / fail / pass.
Cause: scenarios in `ui_test.mjs` settle markets, and a later scenario needs a
leftover. A gate that passes or fails on execution order is not a gate.

A related assertion was also found to be vacuous — it waited for a row state
that was already true *before* the action under test, so a no-op would have
passed. Fixed in the frontend branch.

### 2.5 Blocked on a person, not on engineering

A live Betfair app key, username and password were committed to this **public**
repository (`9eac3a4`) and purged from HEAD only (`173a68b`), so the value is
still readable with `git log -p`. Every piece of surrounding tooling is built and
green. **Rotation and a history rewrite are the only remaining actions, and
neither is a code change. Tracked in #128.**

### 2.6 Dark mode: colour-vision deficiency is weaker than it looks

Measured across three standard deuteranopia simulations — they disagree, and one
of them says dark is *better* than light, so the honest statement is a range:

```
dark  1.35 – 1.93 : 1
light 1.04 – 3.16 : 1
```

Dark is consistently near the floor. Re-deriving the hexes was attempted and
**rejected**: maximising colour-vision separation drives the pair to white and
teal, destroying the blue/pink identity the ladder depends on. The fix is a
**non-colour secondary channel** (border or shape), not a different hex.

### 2.7 Adapter / plugin seam — discussed, deliberately paused

The seam partly exists: `lib/resultsfeed.js` already normalises provider signals
so the engine is provider-agnostic, and `lib/results.js` injects the transport
rather than hard-wiring it.

The blocker is the price feed, which is bound to Postgres views (`FROM
${feedView(feed)}`), so any adapter inherits Postgres. The deeper blocker is
semantic: an adapter that half-works does not crash, it **produces wrong prices
or wrong market state**, which the engine cannot detect. Any adapter story needs
a conformance suite before it needs adapters.

---

## 3. What is deliberately not here

- **Dark mode as a palette swap.** The light palette is byte-identical by
  constraint and verified: 0 of 22 tokens changed.
- **Netting opposite orders on a slip** (`#68` §2.5). It changes what a position
  *is*; engine semantics, needs a product decision.
- **A bottom tab bar on mobile** (`#68` §2.3). Costs 56px of a screen the ladder
  is already losing, and adds a second navigation metaphor.

---

## 4. How to read the issue tracker

**105 filed, 75 closed, 30 open** — and `#106` exists, so the true count is at
least 106. Measured with `search_issues`, not counted by hand.

GitHub's issue-search index LAGS, repeatedly and in both directions. It reported
`total: 105` while the highest issue number was `106`; earlier it reported 8 open
when 10 existed, and `issue_write` returned `{}` for two creations that had
succeeded. Never treat a count from this API as authoritative without also
reading the highest issue number.

| | |
|---|---|
| Open | `#67` (parent), `#77` (deferred by decision), `#78`–`#81` (specced, not built) |

- **`[high]` / `[medium]` / `[low]`** title prefixes mirror the `priority:P0`, `priority:P1` and `priority:P2` labels. Labels are created on first use when attached to an issue, so the set is not fixed by the tooling. The launch backlog (#138) uses them.
- **A closed issue means the change merged and CI was green**, not that it was
  written.
- **`#76` reports two things it did not build that are still open**: continuous
  semantics (`#77`, now deferred) and the house-participation gap, which it found
  by checking rather than by being told.

## 4a. A second, concurrent line of work exists

Issues `#88`–`#106` were filed on 2026-10-15, 17:04–17:07, during the window this
work was fixing the API contract and the test harness. They are a **Betfair-parity
deep dive**, and they are not mine: `#88` (`applyOutcome` settling a declared
non-runner as a loser — a money-path defect, said to reproduce on `main` today),
`#90` (the SSE stream is an invalidation ping, not a market data feed), `#95`
(no market type; the engine models one shape), `#100` (operator surface), `#106`
(no navigation read model — no `listEventTypes` equivalent).

The launch backlog built from this review is tracked in #138, with the decisions it depends on at #107–#112.

**Nothing in §2 was written with those in mind**, so this file understates the gap
between this venue and Betfair considerably. Read it alongside the tracker, not
instead of it. Three consequences worth acting on:

- **`#88` claims a reproducible money-path defect on `main`.** If that holds it
  outranks everything in §2 — it loses a bettor's stake rather than omitting a
  feature. Verify before believing; check it first.
- **`#90` is not in the feed plan's estimate.** The plan's stages do not mention the client-facing SSE stream, so its 13–17 day figure excludes it. An earlier version of this file said the plan had costed streaming as already built. That was wrong, and I made the claim without re-reading the plan.
- **`#95` does not touch §2.6.** The colour-separation decision concerns the colour pair on the ladder, not the market model. An earlier version of this file said a second market shape would invalidate it. That claim was unsupported.

## 5. The failure modes worth remembering

Each of these actually cost something on this pass. They are listed because they
are the ones that a future contributor is most likely to repeat.

1. **A comment that asserts behaviour the code does not have.** Twice caught:
   once in a source-level "test" that was really a regex standing in for a
   behavioural check (deleted in `#76`, not kept alongside), and once in my own
   API-contract comment claiming a promotion mechanism was "already used by the
   tenant and cash-out paths" when tracing showed **zero** sites reached it.
2. **Vacuous tests.** Five at the start of the review, two more in
   `selfcross.test.js`, and one that waited for a state that was already true
   *before* the action under test — so a no-op would have passed.
3. **Harnesses that exit on first failure**, hiding every later check behind the
   first one. Hoist the check, or report all failures.
4. **A branch reporting "all green" while running the wrong dependency.** One
   worktree ran Express 4 against a `^5.3.0` manifest. Run `npm ci` in every
   worktree before trusting a suite.
5. **Assuming the repo's state instead of checking it.** Twice, both times the
   brief was wrong rather than the code being broken.