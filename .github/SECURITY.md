# Security Policy

## Scope

OpenBettingExchange is **paper-money software**: every balance is play money and
there is no real-money execution path, no payment integration and no
withdrawal. Reports about the accuracy of the demo economy, the fairness of the
bot's prices, or the quality of the seeded data are bug reports, not security
issues.

What *is* in scope:

- Anything that could let a user affect another user's balance, escrow or
  position.
- Authentication and session handling: forging a session, escalating to the
  admin role, bypassing the origin guard, using a revoked session.
- The money engine: a way to place a bet, settle a market, take a payout or a
  cash-out without the arithmetic the client would compute (a conservation
  failure is a security issue, not a cosmetic bug).
- Injection: SQL, stored XSS via admin-authored names, server-side request
  forgery in any outbound path.
- Exposure: anything that makes the service reachable or readable beyond the
  intended loopback-only, local, paper-money boundary.

Out of scope: the demo credentials in `README.md` (they are deliberately
committed for the demo and the server refuses any non-loopback bind), running
the project as a real-money bookmaker, and the bot's price randomness.

## Threat model

The security posture follows from what this software **is**: a loopback-only,
paper-money demo and teaching codebase. The dashboard talks to a server that
aborts the launch on any non-loopback `HOST`, every balance is play money with
no payment or withdrawal path anywhere, and the seeded credentials are
committed on purpose. Within that boundary the shortcuts below are
**deliberate covenants, not oversights** — they are listed so a report can
tell a covenant from a bug.

**Deliberate shortcuts (covenants):**

- **Seeded credentials.** `admin`/`admin123` and `demo`/`demo123` are the
  demo's whole point. `ADMIN_PASSWORD` / `DEMO_PASSWORD` override them at
  seed time, and the server logs a prominent boot warning for as long as
  any seeded account still accepts its well-known password.
- **HTTP only, no `Secure` cookie flag.** The session cookie is
  `HttpOnly; SameSite=Lax` without `Secure` — correct for plain-HTTP
  loopback, where a `Secure` flag would silently break the demo, and
  meaningless to add without TLS.
- **scrypt N=16384** (below OWASP's 2^16 recommendation). Raising N
  invalidates every stored password hash, seeded logins included; for paper
  accounts that never leave loopback, the re-seed cost outweighs the
  hardness gain. Per-user random salt and flat-timing verification are in
  place regardless (see below).
- **Basic limiter only.** Login and registration failures are counted in
  memory: ten consecutive failures lock the key, with backoff doubling
  from 30 s to a 15-minute cap (login is keyed per username, registration
  per caller IP; a success resets the counter). The counters are
  process-local — they reset on restart and are not a hardened
  anti-brute-force or denial-of-service control.
- **`uncaughtException` keep-alive.** Stray async failures are logged and
  the process keeps serving, because for a local paper-money dashboard a
  crashed dashboard is worse than a possibly-inconsistent one.

**Hardening that IS in place:** the origin guard rejects foreign origins
before body parsing; every `/api/admin` route (settle included) checks the
admin role; session tokens are stored only as SHA-256 digests, so a leaked
database file contains no reusable bearer credentials; password comparison
is `timingSafeEqual` scrypt against a precomputed dummy hash, so a missing
username costs the same as a wrong password; `registerUser` cannot mint
admins; `HOST` is validated loopback-only at boot; 5xx bodies are generic
(driver, host and path detail stay in the server log); the response carries
a strict `Content-Security-Policy` — `'self'`-only scripts, styles, images
and connections, `object-src 'none'; base-uri 'self';
frame-ancestors 'none'` (the frontend is verifiably inline-free); expired
sessions are swept at boot and hourly; and concurrent SSE streams are
capped.

**Release blockers if this ever binds beyond loopback or handles real
money:** rate limiting/lockout tuning beyond the basic limiter (durable,
per-IP, lockout policy), scrypt raised to N ≥ 2^16 with a re-hash-on-login
migration, TLS plus `Secure` cookies, a CSP review of the new attack
surface, the keep-alive exception handlers replaced by a clean shutdown,
and the AML/KYC licensing and regulatory compliance a real-money exchange
requires — a path this project explicitly does not provide.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion.**

Report it privately via GitHub's security advisory form for this repository
(**Security → Report a vulnerability** at
<https://github.com/wippa-studios/OpenBettingExchange/security/advisories/new>), or by
email to the maintainer. Include:

- what an attacker can do, and what they need in order to do it;
- the endpoint, module or file, with the exact request sequence if you have one;
- the balance/escrow before and after, in cents, for money issues;
- anything you tried that did not reproduce it.

You should get an acknowledgement within a few days. Because this is an
unscheduled hobby project, a full fix may take longer; you will be kept in the
loop and credited in the advisory unless you prefer otherwise.

## What the project already does

Stated so a report can be judged against a baseline rather than a guess:

- **Loopback only.** `HOST` is validated at boot; `0.0.0.0` and any routable
  address abort the launch. The test suite binds explicitly to `127.0.0.1`.
- **Origin guard before body parsing.** Mutating requests are rejected with
  `403` unless they carry no `Origin` (local tooling) or a loopback origin.
- **Sessions** are 32-byte random tokens delivered in an
  `HttpOnly; SameSite=Lax` cookie (a `Bearer` header is accepted for scripted
  clients), but only their **SHA-256 digests are stored**, so a leaked
  database file contains no reusable credentials. Expired sessions are
  swept at boot and hourly.
- **Login and registration are rate-limited**: ten consecutive failures
  lock the key with exponentially doubling backoff (30 s to a 15-minute
  cap); login is keyed per username, registration per caller IP, and a
  success clears the counter.
- **Passwords** are scrypt (per-user random salt, compared with
  `timingSafeEqual`) against a dummy hash precomputed at module load, so a
  missing user still pays the full scrypt cost and usernames cannot be
  enumerated by timing.
- **Password hashes are never returned** by any endpoint, and 5xx responses are
  replaced with a generic message so database errors and paths never reach a
  client.
- **A strict `Content-Security-Policy`** is sent on every response:
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'
  data:; connect-src 'self'; object-src 'none'; base-uri 'self';
  frame-ancestors 'none'`. The frontend is verifiably inline-free (three
  external scripts, one stylesheet, self-hosted fonts and images — no
  inline handlers, inline styles or `javascript:` URLs), so an injected
  inline script, `on*=` attribute, inline style or `javascript:` URL is
  refused by the browser outright.
- **Concurrent SSE streams are capped**, and a stream that stops reading is
  dropped rather than allowed to wedge the fan-out.
- **All SQL is parameterised.** The only dynamic SQL fragments are fixed
  direction/suffix choices chosen by the server.
- **Output escaping** in the browser for every server-provided string,
  including admin-authored names.
- **Money invariants are enforced in the database** with `CHECK` constraints
  (non-negative integer cents, `matched <= stake`, price inside the ladder), not
  only in JavaScript.
- **Every money-moving operation is a single transaction** via `lib/tx.js`; a
  failure anywhere leaves no partial state.

## Deployment guidance

This project is not hardened for public deployment — see the release blockers
in the threat model above. If you expose it to anyone else: change every
seeded password, put TLS and real rate limiting in front of it, and remember
that the money engine has no real-world regulatory compliance attached to it.
