# API reference

Base URL `http://127.0.0.1:7777`, loopback only. `server.js` registers **87
routes** — 84 under `/api` and the three operational endpoints below — and this
file documents all of them. Each route's status codes, field names and error
shapes were read from the handler that serves it; where a handler is thin, the
table points at the module that does the work rather than guessing at it.

Responses are JSON except where a table says otherwise (the report exports
return `text/csv`). Money is always an integer number of **cents** in every
field named `*_cents`. Prices are decimal odds; the engine snaps them to the
tick ladder in [`lib/odds.js`](../lib/odds.js).

---

## The API version, and what it promises

Every `/api` response carries:

```
X-API-Version: 1
```

Read it once at startup and refuse to run against a version you were not built
for. That is the entire point of the header: **the URL never changes**, so without
it there is no signal at all that the contract has moved underneath you.

The value is a **constant in the code**, not a configuration key. An operator
cannot set it from the environment — deliberately, because an operator who could
would be able to announce version 2 from a `.env` while still serving version 1,
and a client that trusted the header would be wrong in a way nothing could
detect. A contract version that lies is worse than no contract version at all.

### What version 1 promises

**Stable within v1, without exception:**

| | |
|---|---|
| Route paths and HTTP methods | a route is not renamed or moved in v1 |
| Field names | request and response field names do not change |
| Integer cents | every `*_cents` stays an integer; never a float, never a string |
| `code` on errors | present on every response that has one, and derived from status when a route does not set it explicitly |
| Status codes | a documented status for a documented condition does not change |
| `X-RateLimit-*` and `Retry-After` | emitted on the same routes as today |

**Explicitly NOT promised in v1:**

- **Field semantics.** A field will not be renamed or retyped, but a description
  may be clarified, and a field may be *added*. Treat every field you do not
  recognise as if it were not there.
- **New routes, or new fields on existing routes.** These will be added, and a
  strict client that rejects unknown fields will break.
- **Rate limits.** The values are deployment config (`RATE_LIMIT_*`), so they
  differ per venue and an operator may change them without a version bump. **Read
  the headers; do not hard-code the numbers.**
- **Ordering** of any array not documented as ordered.
- **The `/api/stream` payload's internal shape.** The envelope is stable; the
  event types are documented individually below and may be added to.

### How it will change

Additive first. A new version is cut only when a change **cannot** be made
additively — a field must change type or meaning, or a route must change
semantics. When that happens:

1. The **old version keeps working** for at least one release cycle.
2. The header moves to `2`. A client sending nothing, or sending `1`, is served
   v1.
3. The changelog records what changed and what to do about it.

There is currently no request-header override, because a version you can only
opt *out* of is not a promise. If a v2 is ever cut, a `X-API-Version: 1` request
header will select v1 explicitly.

---

## Conventions

These hold for every route. They are stated once here rather than repeated per
endpoint.

| Rule | Detail |
| --- | --- |
| Origin guard | Any `POST`/`PUT`/`PATCH`/`DELETE` is `403 Forbidden origin` unless it carries **no** `Origin` (local tooling) or an `Origin` whose authority — host **and** port — equals the `Host` header. It runs before body parsing, so a malformed body from a foreign origin is still `403` |
| Session cookie | `ob_session`, httpOnly, `Path=/`, `SameSite=Lax`, `Max-Age = SESSION_TTL_DAYS × 86400` (30 days by default) |
| Bearer token | `Authorization: Bearer <token>` is accepted anywhere the cookie is. The token is **only** in the `Set-Cookie` header — `register` and `login` put no token in the JSON body — so a script reads it out of the response headers |
| `:id` parameters | Routes that validate their id call `intId` and answer `400 id must be an integer` for anything non-numeric, before any query runs. Admin account routes take `Number(req.params.id)` instead and fall through to a `404` — the two conventions disagree, and both are documented below per route |
| Body limit | `256 kB`. Over it is `413` with `{ "error": "request entity too large" }` |
| Unknown `/api` path | `404 { "error": "Unknown endpoint" }`, never Express's HTML page |
| Caching | **Every `/api` response carries `Cache-Control: no-store`**, including the money routes (`/api/me`, `/api/wallet`, `/api/positions`, `/api/settlements`, `/api/orders`) and the public catalogue. Those are cookie-authenticated GETs carrying balances and exposure — the shape a shared proxy caches and serves back to the wrong user. `no-store` rather than `no-cache`: the latter still permits storing a response and revalidating it. The rule is blanket because a per-route list is a list to forget, and the forgotten route is the one that leaks. `GET /api/stream` is the exception and keeps its own `no-cache` |
| Scheduling | Reconciliation, the results poll, backups, the in-play delay release and WAL maintenance run on timers (`JOBS_INTERVALS` in `server.js`). Each is operator-triggerable through the routes below except maintenance |

### Rate limits

Every response that passes through a volume-limited route carries the caller's
current budget, **whether or not the request succeeded**:

```
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 597
X-RateLimit-Reset: 60
```

`X-RateLimit-Reset` is seconds until the oldest hit in the sliding window ages
out — not a wall-clock timestamp, so you do not need to synchronise a clock to
use it.

**Read these and pace yourself.** A client that only learns the limit by hitting
it has no way to back off before it does, and one that has to guess will
eventually get it wrong. Backing off on your own reading of `Remaining` costs
nothing; backing off after a `429` costs a refused request every time.

Two things a client must not do:

- **Do not hard-code the numbers.** They are deployment config (`RATE_LIMIT_*`)
  and differ per venue. An operator may change them without a version bump,
  which is why they are not part of what v1 promises.
- **Do not treat a missing header as unlimited.** A route whose bucket is
  disabled emits **no** `X-RateLimit-*` headers rather than `Limit: 0` — a
  disabled limit is not a limit of zero, and announcing one would tell a pacing
  client to back off against a ceiling that does not exist. Absent means "not
  configured", which is not the same claim as "unlimited".

When a request *is* refused, `Retry-After` carries the same value in seconds and
the body is `429 { "error": "Too many requests", "code": "rate_limited",
"retry_after_seconds": n }`. Note that only the volume limiter produces this
shape — see [Error codes](#error-codes) for the other sources of a `429`, which
are not rate limits and cannot be retried.


### Authentication

| Surface | Requirement |
| --- | --- |
| Public | `GET /api/sports`, `/api/events`, `/api/markets/:id/book`, `/api/format/:price`, `/api/branding`, `/api/stream`, the four `/api/feed/*` reads, `/healthz`, `/readyz` |
| Session | `401 Authentication required` with no valid, unexpired session |
| Admin | `401` without a session; `403 Admin only` for a signed-in non-admin. `role` is authoritative, with `is_admin` accepted as a legacy mirror |
| Ops token | `/metrics` and `POST /api/admin/backup` are additionally gated on `OPS_TOKEN` (`x-ops-token` header or `Authorization: Bearer`). Unset token ⇒ `404 Not found`; wrong token ⇒ `401 Unauthorized`. `/healthz` and `/readyz` are always public |
| Payments webhook | HMAC-SHA256 over `"<x-obx-timestamp>." + rawBody`, hex in `x-obx-signature`, compared in constant time. `x-obx-timestamp` is **required** and **part of the MAC**, and a request outside a 300 s window is refused — see the webhook signing note below. Without `PAYMENTS_WEBHOOK_SECRET` the route is `404` |

**The first-run lock.** An account still on a seeded demo password (`admin` /
`admin123`, `demo` / `demo123`) can sign in but is refused `403` on every route
outside a five-route allowlist — `GET /api/me`, `POST /api/auth/change-password`,
`POST /api/auth/logout`, `GET /api/auth/sessions`,
`DELETE /api/auth/sessions/:id`. Each entry is a route **pattern**: a `:id`
segment matches exactly one non-empty path segment, so `/api/auth/sessions/abc`
is allowlisted while `/api/auth/sessions/a/b` is not, and the HTTP method is part
of the match. The refusal carries
`details.code = "password_change_required"` and `details.username`, and nothing
else: no password, seeded or otherwise. It does not need one — the refusal is
only reachable by a caller who has already signed in with the very password it
would otherwise disclose, and the client acts on `user.must_change_password`
from the login response before it ever sees a `403`.
The check lives inside `requireAuth`/`requireAdmin`, so a route's position in
the file cannot exempt it.

**A suspended tenant.** `PUT /api/admin/tenants/:id { "status": "suspended" }`
takes that venue off: it cancels the tenant's resting orders, releases their
escrow, and refuses everything that moves money or creates liability —
`POST /api/orders`, `POST /api/markets/:id/cashout`,
`POST /api/wallet/deposit`, `POST /api/wallet/deposit-intent` — with
`403` and `details.code = "tenant_suspended"`. New logins for that tenant's
users are refused with the same code.

**Reads are not suspended.** The board, the book, positions, balances, the
ledger, `/api/me` (which reports `tenant_status`) and the whole admin desk —
including settlement and the restore call — keep working, because a suspended
tenant's players can hold matched positions that must still settle, and a venue
that cannot be un-suspended from its own API is a trap. `GET /api/me` exists so
a player who is allowed to look but not trade can be told why without having to
place an order to find out.

Both refusals sit **after** the password is proven: a wrong password on a
suspended tenant is still `401 Invalid username or password`, byte-identical to
the answer for an account that does not exist, so the login endpoint is not a
probe for which usernames exist or which venue is suspended. See
[EXCHANGE_RULES.md](EXCHANGE_RULES.md#tenants-and-suspension).

The lock covers **`/api` only**. Static assets (`/`, `/style.css`, `/ladder.js`,
`/js/*`) are served normally to a locked account, because the only route out of
the lock is the UI that renders the change-password panel — a global lock blocked
the product rather than the trading, and a locked operator saw a JSON `403` in
the address bar with no way to conclude anything except that the server was
broken.

### Credential-abuse state

The login and registration failure counters are rows in `login_attempts`, not
process memory. **A restart preserves them**: the lockout and the failure count
both carry over, so the doubling window continues where it left off and a
restarted venue does not hand a locked-out attacker a fresh allowance of ten
guesses. That is a decision, not an accident — the alternative (clear on
restart) shortens the wait for whoever is guessing at an account and for nobody
else.

The escape route is unchanged and needs no database edit: the window expires on
its own, and a successful sign-in **deletes** the row. Rows are swept in the
background by age, never because a lock expired — `fails` is meant to keep
counting after a window lapses, because that is what doubles the next one.

The keys are the source-level identifiers the counters have always used:
`login:<username>`, `login-ip:<address>`, `register:<address>`.

### Username identity

A username is **case-insensitive**. `admin`, `Admin` and `ADMIN` are one account:
registration refuses the second and later spellings with `409`, and login accepts
any of them. The guarantee is a `UNIQUE INDEX` on `users (username COLLATE
NOCASE)` in the database itself, not a service-layer check — so it cannot be
bypassed by any writer that is not `lib/auth.js`.

The stored **spelling** is preserved. `username` is displayed in the UI, in the
admin desk and in audit targets, so identity is case-folded and display is not.

Two paths that are not the login path — the boot sweep that flags seeded demo
accounts and the one that warns about them — match the same way, so a seeded
account spelled `ADMIN` is still locked and still warned about.

The reason this is a rule and not a preference: the credential-abuse counters
have always keyed on the **folded** name (so case variants cannot farm separate
guessing windows), while the registry was case-**sensitive**. That combination is
an unauthenticated denial of service against a name the README publishes —
register `ADMIN`, spend ten wrong passwords on it, and the documented `admin`
account is locked out of its own venue without the attacker ever touching it.

`COLLATE NOCASE` folds ASCII only, and that is sufficient because the charset
restriction above admits only `[A-Za-z0-9_-]`. Under a Unicode username policy
this decision would have to be revisited: `İ` and `i` are two identities to
`NOCASE`.

A database that **already** holds two accounts differing only by case refuses to
boot, naming them. Merging them is not automatic because each carries its own
balance, orders and settlements; rename one of each and start again.

### Error codes

Every response that carries an error also carries a **machine-readable `code`**
alongside the human `error` string:

```json
{ "error": "Too many requests", "code": "rate_limited", "retry_after_seconds": 4 }
```

**Branch on `code`. Never on `error`.** `error` is prose and its wording is not
promised; `code` is. This is the difference that lets a strategy react correctly
to a refusal instead of pattern-matching an English sentence.

A route that knows exactly what went wrong sets its own code. Every other route
gets one **derived from the status**, so `code` is present on all of them rather
than only the annotated few:

| `code` | Derived from | Set explicitly for |
| --- | --- | --- |
| `bad_request` | `400` | — |
| `unauthenticated` | `401` | — |
| `forbidden` | `403` | — |
| `not_found` | `404` | — |
| `conflict` | `409` | — |
| `payload_too_large` | `413` | — |
| `unprocessable` | `422` | — |
| `internal_error` | `500` | — |
| `rate_limited` | `429` | the **request-volume** limiter only |
| `feed_unavailable` | `503` | the odds-feed reads, when the collector cannot be reached |
| `feed_stale` | `503` | `GET /api/feed/health` only, when the collector answered and its prices are out of date |

The two feed codes are the reason the derived list cannot be the whole answer.
Both are `503`, they mean opposite things operationally — go and look at the
recorder's **database** versus at its **polling loop** — and they used to be one
answer, so a client could not tell an outage from stale data and neither could an
operator reading the response. See [the feed health 503](#feed-health-says-which-of-two-things-went-wrong).

Two deliberate choices in that table:

**The 5xx entries are coarse.** The message is a generic `Internal error` and
inventing a precise code would tell a client more than the venue actually knows
about a fault it has only just detected. The two feed codes above are the
deliberate exception: they name a condition the venue has *observed* — the
recorder answered, and what it answered is out of date — rather than a fault it
has detected.

**A route-supplied `code` survives onto a 5xx, even though `details` does not.**
This is the one asymmetry, and it is deliberate. `details` is the leak channel
and is stripped from every 5xx. A `code` is a short machine token written by the
venue's own routes, so it carries no user data — and stripping it would remove
the only thing that tells a *deliberate* refusal apart from a *genuine* fault.
Both are 5xx; today the venue answers `503 { "code": "feed_unavailable" }` when
the price feed is down and `500 { "code": "internal_error" }` when something
actually broke. A client that can only see the status cannot act on the
difference; a client that can see the code can wait rather than retry.

**`rate_limited` is explicit, not derived from the `429` status.** Two unrelated
events in this API share that status — a caller exceeding a volume budget, and
the venue being full — and a client that treats them alike will do the wrong
thing for one of them. Conflating them is exactly what the 429 table below warns
about, so the limiter names its own code. The other 429 sources are described
below and currently fall through to the status-derived default.

| Status | Meaning as the code actually uses it |
| --- | --- |
| `400` | Invalid input from the client — **and, on several money routes, a money invariant** (see the divergences) |
| `401` | No session, bad credentials, bad webhook signature, wrong ops token |
| `403` | Wrong role, a foreign `Origin`, the first-run lock, a suspended or self-excluded account, or a jurisdiction refusal |
| `404` | Unknown id — or, on `DELETE /api/orders/:id/cancel`, an order that is not yours |
| `409` | State conflict: market not open, already settled, held, no cash-out available, intent already final |
| `413` | Body over 256 kB |
| `429` | **Two different things** (see below) |
| `500` | Every 5xx. Logged with the real error, reported as `{ "error": "Internal error" }` |

`errorHandler` keeps `details` on a 4xx and strips it from a 5xx, so an internal
fault cannot leak detail through it.

**`429` means two unrelated things, and they are shaped differently.**

| Source | Body | `Retry-After` |
| --- | --- | --- |
| Request-volume limiter (`limit('trade'\|'cashout'\|'admin'\|'wallet'\|'read')`, 60-second sliding window keyed on user or IP) | `{ "error": "Too many requests", "retry_after_seconds": N }` | set |
| Credential-abuse counters on register/login (10 consecutive failures per username, escalating 30 s → 15 min; 30 per source IP, flat 60 s). **Stored in SQLite, so they survive a restart** — see [Credential-abuse state](#credential-abuse-state) | `{ "error": "Too many failed attempts; try again later" }` | set |
| **Abuse limits** (`lib/limits.js`) — market liability and stake caps | `{ "error": "…", "details": { "code": "market_liability_exceeded" \| "stake_limit_exceeded", … } }` | **absent** |

The last row is the divergence worth naming: an abuse-limit refusal uses `429`,
a status that elsewhere in this API means "slow down, retry", yet it carries no
`Retry-After` and retrying cannot help — the cap is state, not rate.

**Divergences this file records rather than smooths over.**

1. **`400` is not "never a money invariant."** Insufficient available balance on
   placement is `400` ([`lib/match.js`](../lib/match.js), `placeOrderTx`), as are
   `ledger.deposit`, `withdrawHold` and `escrow`. The older claim in this file was
   wrong.
2. **"Already in a terminal state" is split.** `POST /api/orders/:id/cancel`
   answers **`400`** for both `Order already cancelled` and
   `Order is fully matched — nothing to cancel`, while the equivalent condition
   on settlement — `POST /api/admin/markets/:id/settle` — is **`409 Market
   already settled`** ([`lib/settle.js`](../lib/settle.js)). Both are “this
   cannot happen again”; the statuses differ.
3. **A deliberate `503` reaches the client; a fault still does not.**
   `errorHandler` clamps every `status >= 500` to `500 Internal error`, and that
   is right for a **fault** — a thrown database error or a `TypeError` can carry
   a path, a query or a stack frame. An application state that was chosen
   deliberately and described in its own words is not a fault, so an error may
   **opt in** with `err.expose` (built by `serviceUnavailable()` in
   [`lib/auth.js`](../lib/auth.js)): the status and the message then survive, and
   the message must contain no path, no internal identifier and no stack.
   `lib/feedcreds.js` uses it for the `FEED_CREDENTIALS_KEY` refusal, whose
   message carries the exact command that fixes it. The default is unchanged —
   `httpError(503, …)` is *not* opted in and still clamps, so a module that does
   not know about the mechanism cannot leak by accident. Nothing infers the
   distinction: a deliberate `503` and a thrown fault are indistinguishable to the
   handler, which is why it has to be stated.
4. **Id validation is inconsistent.** `intId` routes answer `400` for
   `/api/markets/abc/book`; `Number()`-parsing admin routes answer `404` for
   `/api/admin/users/abc`.
5. **A non-string password is refused at all three credential routes, with
   different statuses.** Register `400 Password must be a string`, change-password
   `400`, login **`401 Invalid username or password`** — `verifyPassword` fails
   closed on a non-string and login answers with its one generic message.
6. **Withdrawal is deliberately not gated by self-exclusion.** Deposit, order
   placement and cash-out are all `403` for an excluded account; `POST
   /api/wallet/withdraw` is not. Self-exclusion is a promise about play, not custody.

---

## Public and session

| Route | Request | Success | Errors |
| --- | --- | --- | --- |
| `POST /api/auth/register` | `{ username, password, email? }` | `201 { user }` + session cookie. `username` 3–32 chars `[A-Za-z0-9_-]`, matched **case-insensitively** (see [Username identity](#username-identity)); `password` 6–128 chars; `email` lowercased and unique | `400` invalid username, non-string or wrong-length password, malformed email; `409` username or email taken; `429` abuse counter |
| `POST /api/auth/login` | `{ username \| email \| identifier, password }` | `200 { user, rg }` + session cookie. `username` is matched case-insensitively. Starts the responsible-gambling session clock | `401` unknown user, wrong password or bot account (one message, constant-time); `403 Account is suspended`; `403` jurisdiction; `429` abuse counter |
| `POST /api/auth/logout` | — | `200 { ok: true }`, cookie cleared. It stamps activity on the responsible-gambling state **for the token presented** (not every session) | — |

Logout does **not** clear the session clock. `lib/rg.js`'s `endSession` only
refreshes `last_active_at`, so signing out and straight back in buys no fresh
session limit — the clock resets only after a real idle gap
(`RG_SESSION_IDLE_RESET_MINUTES`, 15 minutes by default).
| `GET /api/me` | — | `200 { user }` with `available_cents = balance_cents − frozen_cents` and `tenant_status` (`'active'` \| `'suspended'`) | `401`; `403` first-run lock |
| `GET /api/sports` | — | `200 { sports: [{ id, name, slug, event_count }] }`; `event_count` covers `upcoming` and `live` events | — |
| `GET /api/events` | `?sport=<slug>` | `200 { events }`, 3-level book per runner | `404 Unknown sport` |
| `GET /api/markets/:id/book` | — | `200 { market, book }` at 5 levels | `400` non-integer id; `404` unknown market |
| `GET /api/format/:price` | — | `200 { decimal, american, fractional, implied_prob }`. An off-tick price **inside** the ladder is snapped, so the desk can show a trader what the engine would make of a hand-typed `2.75` | `400 Price must be a number`; `400 Price is outside the 1.01-1000 ladder` |
| `GET /api/branding` | — | `200 { tenant, name, logo, favicon, terms_url, palette }` — the caller's tenant, or the default when signed out. `logo` and `favicon` default to `/assets/logo.png` and `/assets/favicon.png`; both must be a path **on this venue**, because the CSP is `img-src 'self' data:` and a remote URL is refused by the browser | — |
| `GET /api/stream` | — | `200 text/event-stream`; see the event table below | `403` first-run lock. Capacity: `503 Too many concurrent streams` at `MAX_SSE_CLIENTS`, `503` once anonymous streams hold their reserved share (a fifth of the pool), `429` for a caller over `MAX_SSE_CLIENTS_PER_SOURCE` (anonymous streams from one address) or `MAX_SSE_CLIENTS_PER_USER` (one account) |

`user` is always `lib/auth.js`'s `sanitizeUser` shape:
`{ id, username, email, role, is_admin, is_bot, status, must_change_password,
balance_cents, frozen_cents }`.

### Account self-service

| Route | Request | Success | Errors |
| --- | --- | --- | --- |
| `POST /api/auth/change-password` | `{ currentPassword, newPassword }` — both must be JSON **strings**, `newPassword` 6–128 chars and different from the current one. **Every other session for the account is revoked**; the one you called from survives | `200 { ok: true, sessions_revoked }`, audited as `user.password_changed` | `400` a non-string password, a non-string `currentPassword`, a wrong length, or a new password equal to the old; `401 Current password is incorrect`; `404 Account not found`; `401` without a session |
| `GET /api/auth/sessions` | — | `200 { sessions: [{ id, created_at, expires_at, current }] }`. `id` is a **12-character digest prefix** — a raw token never leaves the process | `401`; `403` first-run lock |
| `DELETE /api/auth/sessions/:id` | `id` is that digest prefix. Revoking the session you are calling from logs you out here; that is a legitimate "sign out this device" action and is not special-cased | `200 { ok: true }`, audited as `user.sessions_revoked` | `400 Session id is required` for an empty id; `404 Session not found` for a prefix that matches nothing. In practice the router answers `404 Unknown endpoint` for a bare `/api/auth/sessions/`, because `:id` matches nothing there |

The revoke matches with `substr(token, 1, 12) = ?`, a **prefix comparison and
not a `LIKE`** (issue #29). It used to interpolate the id into `token LIKE ?` with
no escaping, so `_` matched any single character and `%` any sequence:
`DELETE /api/auth/sessions/_` revoked **every** session the account had and still
answered `{ ok: true }`, because the change count was non-zero. An endpoint whose
entire purpose is "revoke ONE session" reporting success after revoking all of
them is a correctness bug, and `_` is a plausible thing to paste when the UI
shows a truncated id. The match is scoped by `user_id` as well, so a guessed id
cannot reach another account's row.

```jsonc
// GET /api/events — the shape the frontend prices from
{ "events": [{
  "id": 1, "name": "Arsenal vs Chelsea", "sport": "Football",
  "competition": "Premier League", "starts_at": "2026-10-14 12:04:07", "status": "upcoming",
  "markets": [{
    "id": 1, "name": "Match Odds", "status": "open", "total_matched_cents": 0,
    "selections": [{
      "selection_id": 1, "name": "Arsenal", "status": "open", "ltp": null,
      "back": [{ "price": 3.35, "size_cents": 5062 }],  // resting LAYS, highest first
      "lay":  [{ "price": 3.05, "size_cents": 8428 }]   // resting BACKS, lowest first
    }]
  }]
}] }
```

`back` is what a backer can bet into; `lay` is what a layer can bet into. `ltp`
is `null` until the runner trades.

### `GET /api/format/:price` refuses a price outside the ladder, and snaps one that is merely off-tick

The **range** is checked before the snap, with `ODDS.inLadderRange`. It used to
be checked after, against the snapped value — and `snapToTick` clamps to
`[1.01, 1000]` and always returns a tick, so that branch was dead code and
`5000`, `99999` and `-5` all answered `200` with `1000`, `1000` and `1.01`. For a
route whose job is to answer "is this a price", returning a confident different
price is the worst kind of wrong answer, so it is now `400`.

A price **inside** the ladder that is merely off-tick — `2.75` — is still
snapped, and that is deliberate. It is the fair-price helper the trading desk
types into, and it exists to show what the engine would make of a near-miss. The
trading path makes the same promise: `POST /api/orders` corrects an off-ladder
price rather than rejecting it, and [`EXCHANGE_RULES.md`](EXCHANGE_RULES.md)
documents that.

### `GET /api/stream`

Server-sent events. Identity is latched once at connect: a stream opened signed
out stays anonymous, and one opened signed in keeps that user's private frames
even after logout.

| Event | Sent to | Data |
| --- | --- | --- |
| `book` | everyone | `{ "market_id": 1 }` — refetch the book |
| `balance` | the user | `{}` — balance or escrow changed |
| `orders` | the user | `{}` — your open orders changed |
| `settlement` | everyone | `{ "market_id": 1 }` |

A `: hb` comment goes out every 15 s. A replayed order broadcast is suppressed,
so a retried request does not flicker every other client's board. Connect with
`EventSource('/api/stream')`; it reconnects on its own.

---

## Trading

| Route | Request | Success | Errors |
| --- | --- | --- | --- |
| `POST /api/orders` | `{ selection_id, side, price, stake_cents, client_order_id? }` | `201 { order, fills, book }`; `200` with `idempotent_replay: true` when `client_order_id` has been seen | see below |
| `GET /api/orders` | — | `200 { orders }` — unmatched orders only, newest first | `401` |
| `POST /api/orders/:id/cancel` | — | `200 { order }`; releases the escrow on the unmatched remainder | `400` non-integer id, already cancelled, or fully matched; `404` not your order |
| `GET /api/positions` | — | `200 { positions }` — exposure, if-win P&L and a cash-out quote per market | `401` |
| `POST /api/markets/:id/cashout` | — | `200` — the venue **buyout**, see below | `400` non-integer id; `404` unknown market; `403` suspended/self-excluded/RG; `409` off time, held market, or no quotable position |

`POST /api/orders` errors: `400` bad side, a `selection_id` that is not a JSON
integer, a `stake_cents` that is not a number or falls outside
`[MIN_STAKE_CENTS, MAX_STAKE_CENTS]`, a `price` that is not a finite JSON
**number** (a quoted `"2.4"` is refused — the boundary is type-strict, not
coerced), **insufficient available balance for the stake/liability**, or a
`client_order_id` that is not a string / longer than 64 chars / contains
anything but `[A-Za-z0-9._:-]`; `429` for a stake or market-liability cap breach;
`403` for a session limit, an owed reality check or a self-exclusion; `404
Selection not found` — which is also what a **feed** selection id gets, before
any collateral is taken; `409` for market not open, selection not open, event
completed, market suspended, or the event off.

`validateOrder` also carries a `400 Price out of range` branch. It is a
**redundant backstop**: `snapToTick` clamps to `[1.01, 1000]` first, and
`lib/match.js` labels it as kept so a future ladder change fails at the API edge.
It is left in place on purpose — the clamp is what this route wants (a near-miss
price still trades), so unlike `GET /api/format/:price`, which refuses rather
than clamps, this one cannot make that branch the primary check.

`order.status` is `open` (has a remainder), `fully_matched` or `cancelled`.
`fills` is `[{ price, stake_cents }]` at the **resting** order's price. An order
placed on an in-play market is accepted and escrowed but carries
`delayed: true` and an `eligible_at`; it does not match until the delay expires.

### Cash-out is a venue buyout, not a market hedge

The engine in [`lib/cashout.js`](../lib/cashout.js) does **not** hedge the
position against the book. That model was removed (issue #54) because hedging *N*
runners against a fair book always destroys value. The venue instead quotes
`fair_value = Σ pᵢ · Payoutᵢ` with the overround removed, less
`CASHOUT_MARGIN_BPS`, and takes the player's side. **Multi-runner positions are
supported** — `payouts` covers every selection in the market, and the outcome
universe is not limited to the runners the player holds.

`GET /api/positions` decorates each position with the quote (`cashout` is `null`
when none can be offered honestly — no position, market not open, held, no fair
prices, an unpriced matched runner, a non-positive fair value, a payout below
`MIN_STAKE_CENTS`, a bot account, or a venue risk-cap refusal):

```jsonc
"cashout": {
  "market_id": 1, "mode": "buyout", "selection_count": 3, "legs": 2,
  "fair_value_cents": 986, "value_cents": 966, "margin_bps": 200,
  "payouts": [ { "selection_id": 1, "payout_cents": 20000 },
               { "selection_id": 2, "payout_cents": 20000 },
               { "selection_id": 3, "payout_cents": -26900 } ]
}
```

`POST /api/markets/:id/cashout` returns the plan **plus** the execution result:

```jsonc
{ "market_id": 1, "mode": "buyout", "selection_count": 3, "legs": 2,
  "fair_value_cents": 986, "value_cents": 966, "margin_bps": 200,
  "payouts": [ /* as above */ ],
  "frozen_release_cents": 26900,   // the player's matched collateral, released
  "payout_cents": 966,             // what the venue paid them
  "matches_closed": 2,             // legs taken off the board
  "transferred_cents": 26900,      // SAME figure as frozen_release_cents — see below
  "cancelled_orders": 1 }          // the player's resting orders in that market
```

`transferred_cents` is **an alias for `frozen_release_cents`, not a second
quantity**. The collateral released from the player per leg and the escrow the
house takes on per leg are the same number moving between balances, so the two
can never differ. Both are returned because both are documented response fields
and dropping one would be a breaking API change; a client must not read the pair
as independent. It used to be two separate accumulators producing two names for
one number (#20), which promised a distinction that does not exist.

It is all-or-nothing in one transaction, and the plan is recomputed **inside**
it. The venue takes over the player's slot in each match so the counterparty is
never stranded, and the player's legs are flagged `cashout` so settlement cannot
pay them twice.

---

## Wallet, payments and settlements

| Route | Request | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/wallet` | — | `200 { balance_cents, frozen_cents, available_cents, transactions }`, latest 100 | `401` |
| `GET /api/settlements` | — | `200 { settlements }` | `401` |
| `POST /api/wallet/deposit` | `{ amount_cents }` | `200 { balance_cents, frozen_cents }` (play-money faucet, capped by `FAUCET_MAX_CENTS`) | `400` not a positive integer or over the cap; `403` self-excluded / suspended / over the RG deposit limit |
| `POST /api/wallet/deposit-intent` | `{ amount_cents }` | `200 { intent_id, external_id, status, client_secret }` — **credits nothing** | `400` not positive, or over `DEPOSIT_MAX_CENTS`; `403` self-excluded or over the RG deposit limit |
| `POST /api/wallet/withdraw` | `{ amount_cents, reason? }`. `amount_cents` must be a JSON **integer** — a quoted `"100"`, `true` or `[100]` is refused, not coerced | `200 { status: "pending", amount_cents }` — funds debited and held in `gateway_clearing` at once | `400` not a positive integer, over available balance, or a bot account. **Not gated by self-exclusion** |
| `POST /api/payments/webhook` | `{ provider, external_id, amount_cents }` + `x-obx-timestamp` + `x-obx-signature` | `200` confirms the matching deposit intent. A **redelivery** of an already-confirmed intent is `200 { already_confirmed: true }`, not a `404` — at-least-once delivery is the normal case, not an error | `404` no `PAYMENTS_WEBHOOK_SECRET`, or an external id no deposit intent has; `401 Bad signature`; `400` missing/malformed `x-obx-timestamp`, outside the 300 s replay window, provider mismatch, or amount disagreeing with the recorded intent; `429` abuse counter |

**Webhook signing and the replay window.** The signature is
`hex(HMAC-SHA256(PAYMENTS_WEBHOOK_SECRET, "<timestamp>." + rawBody))`, where
`<timestamp>` is `x-obx-timestamp` in unix seconds, compared in constant time
against `x-obx-signature`.

The timestamp is **required** and is **inside the MAC**, and both matter. It was
neither before: the MAC covered the raw body alone, so a captured valid request
was replayable indefinitely, and the only thing preventing a second credit was
that the intent was no longer pending — a *state*-based defence, which stops
re-delivery of one intent but not a captured request replayed later.

Making the timestamp optional would have been worse than leaving it out: a
caller can bypass an optional control by omitting it, so a captured body-only
request could be replayed forever with a fresh timestamp beside it. A signature
over the body alone is therefore refused, not accepted for compatibility.
Requests older or newer than **300 seconds** are rejected with `400`; five
minutes is generous for clock skew between provider and venue and comfortably
covers a retry cycle.

Note the ordering: the timestamp's *shape* is checked first (a malformed one is
a `400` protocol error), then the signature (`401`), then the *window* (`400`).
The window is evaluated only after the request has authenticated, so the
timestamp it reads is one the provider actually signed rather than one the caller
asserted.

There is deliberately **no player-callable confirm route.** A deposit is credited
only by the provider-authenticated webhook or by the admin desk below, and both
enforce `DEPOSIT_MAX_CENTS` per intent and `DEPOSIT_DAILY_MAX_CENTS` **per user
per day** — issue #22, and the reason the cap is not a venue-wide total.

### Admin: the payment lifecycle

| Route | Request | Success | Errors |
| --- | --- | --- | --- |
| `POST /api/admin/payments/intents/:id/complete` | `{ reason }` — **required**, ≥5 chars, audited | `200 { intent_id, status: "confirmed", amount_cents }` for a withdrawal; the hold is discharged and the money stays booked against `gateway_clearing`. Re-completing returns `200 { already_confirmed: true, … }` rather than an error | `400` on the reason, a non-integer id, or a non-withdrawal intent; `404 Payment intent not found`; `409` the intent is already failed |
| `POST /api/admin/payments/intents/:id/fail` | `{ reason }` — same requirement | `200 { intent_id, status: "failed", refunded_cents }`; the player is refunded in full and the books return to their pre-request state | `400` on the reason, a non-integer id, or a non-withdrawal intent; `404`; `409` the intent is not pending |
| `GET /api/admin/reconciliation` | — | `200 { provider, provider_settled, provider_unmatched, provider_settled_cents, recorded_confirmed_cents, drift_cents, withdrawals_pending_cents, gateway_clearing_cents }` | `401`/`403` |
| `GET /api/admin/ledger` | — | `200 { segregation, conserved_cents, commission_cents, house_float_cents, gateway_clearing_cents, cache_divergent }`. `segregation.player_cents` is the players' money as a number, not a promise; `conserved_cents` must be `0` and `cache_divergent` must be `[]` | `401`/`403` |

Without `complete` and `fail` a withdrawal could be opened and debited and
nothing could ever finish it, so the money sat in `gateway_clearing` forever.
`drift_cents` is a deliberate **external** comparison — what the provider says it
settled, minus what we recorded as confirmed — because comparing two of our own
totals to each other proves nothing about whether real money arrived.

### `GET /api/wallet` transaction types

`deposit`, `escrow` (freeze), `release` (unfreeze), `settle` (net P&L, may be
negative), `commission`, `refund` (void), **`adjust`** (an operator balance
change), **`withdraw`** (a hold, always negative) and **`withdraw_refund`** (a
failed or cancelled withdrawal returned in full). Each row is
`{ id, user_id, type, amount_cents, balance_after, frozen_after, order_id,
market_id, at, tenant_id }`. `opening` rows — how a seeded or provisioned
account was funded — exist in the table but are excluded from the player-facing
list; the operator still sees them in the books.

---

## Responsible gambling

All three controls default to `0`, which means **not configured** rather than
unlimited. The server says so loudly at boot when none is set.

| Route | Success | Errors |
| --- | --- | --- |
| `GET /api/auth/rg` | `200` with `session_limit_minutes`, `session_started_at`, `played_minutes`, `session_remaining_minutes`, `session_reached`, `reality_check_minutes`, `reality_check_due`, `reality_check_due_in_minutes`, `deposit_limit_cents`, `deposited_24h_cents`, `deposit_limit_remaining_cents`, `configured` | `401`; `429` volume |
| `POST /api/auth/reality-check` | `200 { acknowledged_at, net_settled_today_cents, balance_cents }` | `409 { details: { code: "reality_check_not_due", due_in_minutes } }` when no check is actually owed — the acknowledgement resets the clock only when it is due; `401`; `429` volume |

The same gate refuses **betting**: a session limit, an owed reality check or a
self-exclusion is a `403` on `POST /api/orders`, `POST /api/markets/:id/cashout`,
`POST /api/wallet/deposit` and `POST /api/wallet/deposit-intent`, with a distinct
`details.code` in each case (`session_limit_reached`, `reality_check_due`,
`self_excluded`). The deposit limit is **per user** over a rolling 24 hours and is
checked on both deposit paths, so it cannot be side-stepped by choosing the
intent instead of the faucet.

---

## Odds feed (read-only)

Requires `FEED_ENABLED=true`. These serve a **reference board** from the
collector's PostgreSQL. Feed markets are **display only** — they have no row in
this venue's database, so naming a feed selection id on `POST /api/orders` is a
`404` before any collateral is taken. See [`FEED.md`](FEED.md).

| Route | Success | Errors |
| --- | --- | --- |
| `GET /api/feed/board?limit=` | `200 { markets }`; `limit` clamped to `[1, 500]` and counts **markets**, not rows | `409` feed disabled; `503 Odds feed unavailable` |
| `GET /api/feed/market?id=` | `200 { market }`, or `{ "market": null }` when the id is not in the feed | `409`; `400 id is required`; `503` |
| `GET /api/feed/nav` | `200 { enabled, sports }` — the browsing tree, expanded along one branch. **Always `200`**, including `{ "enabled": false, sports: [] }` when the feed is off, because the browser probes it at boot | `503` |
| `GET /api/feed/health` | `200 { feed, priced, markets, markets_with_odds, resolved, odds_age_seconds, oldest_odds_age_seconds, data_age_seconds, app_key_delay, app_key_delay_source, delay_note }` — the whole health payload; `ok` is deliberately absent because on a `200` it can only be `true` | `409` feed disabled; `503` — **two** bodies, see below |

```jsonc
// GET /api/feed/board
{ "markets": [{
  "market_id": "1.262760123",        // strings: Postgres BIGINT
  "event_id": "33696285", "event_name": "Famalicao v Alverca",
  "sport_slug": "soccer", "competition_name": "Portuguese Primeira Liga",
  "country_code": "PT", "market_name": "Over/Under 3.5 Goals",
  "market_type_code": "OVER_UNDER_35", "status": "OPEN",
  "start_time": "2026-10-12T19:15:00.000Z", "in_play": false,
  "age_seconds": 3693,               // OUR poll age, not the data's age
  "stale": false,
  "back_pct": 100.2, "lay_pct": 99.6, // null unless EVERY runner is priced both sides
  "selections": [{ "selection_id": "1222344", "name": "Under 3.5 Goals",
                   "back": [{ "price": 1.55, "size_cents": 16071, "side": "BACK" }],
                   "lay":  [{ "price": 1.57, "size_cents": 9122,  "side": "LAY" }],
                   "last_price_traded": 1.55 }]
}] }
```

`data_age_seconds` is **null on a Delay key** and published as null rather than
substituted: Betfair withholds `publish_time`, and a fabricated age would read as
a measurement.

<a id="feed-health-says-which-of-two-things-went-wrong"></a>
### Feed health says WHICH of two things went wrong

`GET /api/feed/health` answers `503` for two different failures, under two codes,
because they send an operator to different places:

| | Unreachable | Stale |
| --- | --- | --- |
| `code` | `feed_unavailable` | `feed_stale` |
| `error` | `Odds feed unavailable` | `Odds feed stale` |
| `odds_age_seconds` | `null` — nothing was measured | the measured age |
| `stale_after_seconds` | absent | the `FEED_STALE_SECONDS` it exceeded |
| `feed`, `priced` | absent | which view answered, and whether it has odds columns |
| means | the probe could not reach the recorder — database, network, credentials | the probe answered, and what it returned is out of date — the collector's polling loop, or the threshold |

```jsonc
// 503, prices out of date
{ "error": "Odds feed stale", "code": "feed_stale", "ok": false,
  "odds_age_seconds": 5000, "stale_after_seconds": 300, "feed": 2, "priced": true }

// 503, the collector could not be reached
{ "error": "Odds feed unavailable", "code": "feed_unavailable", "ok": false,
  "odds_age_seconds": null }
```

`ok: false` is on both, and `odds_age_seconds` is on both — `null` where nothing
was measured, for the same reason `data_age_seconds` is published as null rather
than substituted.

This distinction did not exist before #85. Both conditions answered one fixed
`503 { ok: false, error: "Odds feed unavailable" }`, and the log line beside them
read fields the health payload never sets, so it printed `(no detail)` on every
stale feed. A collector that had quietly stopped polling was indistinguishable
from a database that was down, and the age that separates them — which the route
computed and then discarded — never reached the client.

---

## Feed credentials and the collector supervisor

Admin-only, and **scoped to the caller's own tenant**. `:id` may only name that
tenant: a tenant the caller does not belong to is `403`, a tenant that does not
exist is `404`. The rule is enforced inside [`lib/feedcreds.js`](../lib/feedcreds.js)
against the actor, not by the route, so a caller that reaches the module directly
gets the same answer.

The credentials are exactly three fields — app key, username, password — because
that is exactly what a Betfair Delay key authenticates with. They are sealed with
AES-256-GCM, and **no route returns a secret**: every response reports which
fields *exist*. Storing and deleting are audited.

| Route | What |
| --- | --- |
| `GET /api/admin/feed/credentials` | `{ tenants: [ status ] }` for **the caller's own tenant only**. There is no venue-wide feed inventory; `statusAll()` was removed (issue #43) |
| `GET /api/admin/feed/credentials/:id` | One tenant's status, same scope |
| `PUT /api/admin/feed/credentials` **or** `PUT /api/admin/feed/credentials/:id` | `{ app_key, username, password }`. Restarts a supervised collector |
| `DELETE /api/admin/feed/credentials` **or** `DELETE /api/admin/feed/credentials/:id` | Removes them and stops a supervised collector |
| `GET /api/admin/feed/runner/:id` **or** `GET /api/admin/feed/runner` | Supervisor state, restarts, exit codes, scrubbed log tail |
| `POST /api/admin/feed/runner/start` | Start the collector |
| `POST /api/admin/feed/runner/stop` | Stop the collector |

> **Why two spellings rather than `:id?`.** These routes were written with an
> optional `:id?`, which **path-to-regexp v8 removed** — the router Express 5
> uses throws at registration (`Unexpected ? at index 31`), and these are
> top-level registrations, so the server did not start at all (issue #74). Each
> is now registered twice, with and without `:id`, reaching the same handler.
>
> The `?` was decorative: no handler ever read `req.params.id`. The tenant
> always came from `feedTenantId(req)`, which is the caller's **own** tenant and
> refuses any other. So the two forms behave identically — with the single
> difference that the `:id` form validates the id as a tenant reference first,
> answering `404` for an unknown tenant and `403` for someone else's. Both forms
> are admin-only, and `tests/express5.test.js` pins all of that.

Errors: `400` a malformed app key, username or a missing password; `403` a foreign
tenant, or an account that belongs to no tenant; `404` an unknown tenant, or
`DELETE` with nothing stored; `409` from `/runner/start` carrying the **specific**
missing condition (`FEED_ENABLED is false`, `FEED_RUNNER_ENABLED is false`,
`FEED_DATABASE_URL is not set`, `FEED_CREDENTIALS_KEY is not set`, or no
credentials stored) rather than a `200` claiming a start that did not happen.

If `FEED_CREDENTIALS_KEY` is unset, storing is refused with `503` and **nothing
is written** — no plaintext fallback. That `503` is one of the deliberately
exposable ones, so its message — including the `openssl rand -hex 32` that fixes
it — reaches the caller; see the error-code divergences.

A tenant that does not exist is `404` **whatever the key is set to**: the tenant
is resolved before the key is required, matching the sibling `DELETE`, so the two
halves of this API cannot disagree about the same request.

```jsonc
// GET /api/admin/feed/credentials/1
{ "tenant_id": 1, "configured": true, "storage_available": true,
  "login_mode": "password",
  "app_key_set": true, "username_set": true, "password_set": true,  // booleans, never values
  "created_at": "2026-10-12 20:10:04", "updated_at": "2026-10-12 20:10:04" }
```

Each sealed field is bound to its tenant, its field name and a schema version as
GCM associated data, so a row moved at the database level fails the auth tag
rather than decrypting as another tenant's credential.

`PUT` restarts a supervised collector rather than leaving it running on the old
credentials, and the response says which of two things happened:

| Field | Meaning |
| --- | --- |
| `collector_restarted` | a new collector is already running |
| `collector_restart_pending` | the old process is terminating; the launch follows on its exit |

`GET /api/admin/feed/runner` reports `running` from whether a **process** exists,
not from whether a handle does — a failed spawn leaves `pid: null` and
`running: false`. While a restart is in flight, `supervisor` is `"restarting"`
and `restart_pending` is `true`. The supervisor restarts with exponential backoff
(5 s to 5 min) so a wrong password cannot hammer Betfair's login endpoint, and
every captured collector log line is scrubbed of stored credential values first.
On `SIGTERM`/`SIGINT` the server stops the job timers, stops the collector
(SIGTERM, escalating to SIGKILL after a grace period), closes the listener and
exits 0.

---

## Tenancy

| Route | Request | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/admin/tenants` | — | `200 { tenants }` — all rows; `brand` and `jurisdictions` are stored as JSON **strings** | `401`/`403` |
| `PUT /api/admin/tenants/:id` | `{ name?, status?, commission_bps?, brand?, jurisdictions? }`. `status` is `active`/`suspended`; `commission_bps` an integer in `[0, 2000]`; `brand` and `jurisdictions` are **objects**, stored JSON-encoded. An absent key leaves that column untouched | `200` the tenant row. The `UPDATE` and its `tenant.configured` audit row are one transaction, and the change is **refused outright** if the audit write fails — a commission rate or a tenant status that cannot be recorded does not stand | `400` unknown status or out-of-range `commission_bps`; `404 No such tenant`; `500` the audit log could not be written |

A `NULL` `tenant_id` on a user means the default tenant. Jurisdiction is enforced
at **session mint**, not at bet placement, and only from a proxy-overwritten
country header when `TRUST_PROXY_JURISDICTION=true`; otherwise the header is
ignored entirely and every session is permitted.

---

## Admin: catalogue, markets and settlement

Every route answers `401` without a session and `403 Admin only` for a non-admin.

| Route | Request | Success | Errors |
| --- | --- | --- | --- |
| `POST /api/admin/sports` | `{ name }`; the slug is derived | `201 { sport }` | `400 name required`; `409 Sport slug already exists` |
| `POST /api/admin/competitions` | `{ sport_id, name, country? }` | `201 { competition }` | `400` missing fields, or a `sport_id` the schema rejects |
| `GET /api/admin/competitions?sport_id=` | — | `200 { competitions: [{ id, name, country }] }` | `400 sport_id required` |
| `POST /api/admin/events` | `{ sport_id, competition_id?, name, starts_at }`. `starts_at` must be ISO-8601 `YYYY-MM-DD[ HH:MM[:SS]]` and is stored as given. `competition_id`, if given, must belong to `sport_id` | `201 { event }` | `400` missing fields, bad `starts_at`, a foreign `competition_id`, or a rejected `sport_id` |
| `POST /api/admin/markets` | `{ event_id, name }` | `201 { market }` | `400` missing fields or a rejected `event_id` |
| `POST /api/admin/selections` | `{ market_id, name, fair_price? }`. `fair_price` is snapped to the ladder; when bots are on, the market is quoted immediately | `201 { selection }` | `400` missing fields, a non-finite `fair_price`, or a rejected `market_id` |
| `PATCH /api/admin/markets/:id` | `{ status: "open" \| "suspended", reason? }` | `200 { market }`, audited, broadcasts `book` | `400` any other status or a non-integer id; `404` unknown market; `409 Market is settled` |
| `POST /api/admin/markets/:id/settle` | Exactly one of `{ winner_selection_id }`, `{ dead_heat: [ids] }` or `{ void: true }`. Values pass through **unchanged** — a string `"false"` is not a boolean, `true` is not a selection id | `200 { market, previous_status, per_user: [{ user_id, pnl_cents, commission_cents }] }`, audited, broadcasts `book` and `settlement`. `previous_status` is the status the market **was** — it comes from the row the settlement transaction itself read, so the `market.settled` audit row records an observed prior state rather than an asserted one | `400` bad input, a winner from a different market, a `dead_heat` naming fewer than two distinct ids, or a non-integer id; `404` unknown market; `409` already settled, or held pending review |
| `GET /api/admin/stats` | — | `200 { markets }` — latest 200 with `total_matched_cents`, `open_orders`, `overround` | `401`/`403` |

`overround` is Σ implied probability of the best price a backer can get on every
runner, minus 1. **Negative** means the runners can all be backed for a
guaranteed profit; positive means the market is margined; `null` means some runner
has no available price.

---

## Admin: accounts, limits and audit

| Route | Request | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/admin/users` | `?q=&role=&status=&limit=&offset=`. Always scoped to a tenant — the default unless `tenant_id` is supplied. `limit` clamped to `[1, 200]`, default 50. Bots are never listed | `200 { total, users }` | `400 Unknown role`/`Unknown status`; `404 No such tenant` |
| `GET /api/admin/users/:id` | — | `200 { user }` with `open_orders`, recent sessions (digest prefixes only) and 25 audit rows | `404 User not found` — **including for a non-numeric id** |
| `PATCH /api/admin/users/:id` | `{ status?, role?, reason }` — reason required, ≤500 chars | `200 { ok, status?, role? }` | see below |
| `POST /api/admin/users/:id/balance` | `{ delta_cents, reason }` — reason required | `200 { id, balance_cents, frozen_cents }` | `400` missing/oversized reason, a zero or non-integer delta, adjusting yourself, or a delta the ledger refuses; `404` unknown user |
| `GET /api/admin/users/:id/limits` | — | `200 { limits }` — one row per scope, ordered by scope | `401`/`403`. An unknown user yields `200 { limits: [] }`, not `404` |
| `PUT /api/admin/users/:id/limits` | `{ scope?, max_open_stake_cents?, max_market_liability_cents?, max_daily_settled_cents? }`. `scope` is `global` (default) or `market:<id>`. A **non-negative integer or `null`**; `null` clears the cap. An **absent key leaves that axis untouched** | `200 { user_id, scope, …the three effective caps… }` | `400 Invalid limit scope`, or a non-integer/negative cap; `404 User not found` |
| `POST /api/admin/users/:id/exclude` | `{ until?, reason? }`. `until` is `null` for permanent, or a strict ISO-8601 datetime normalised to UTC. `reason` is recorded but **not required** | `200 { id, excluded_until, cancelled_orders, released_cents }` | `400` an unparseable `until`, or a bot; `404 User not found` |
| `GET /api/admin/audit` | `?limit=&target=&action=&actor_id=`; `limit` clamped to `[1, 1000]`, default 100 | `200 { entries }` — `{ id, actor_id, action, target, before, after, reason, at }` | `401`/`403` |

`PATCH /api/admin/users/:id` applies status and role in **one transaction**:
either both land or neither does (issue #23). Previously `setRole` could `400`
after `setStatus` had already committed — cancelling the account's resting
orders and deleting its sessions — so an operator re-submitted and met
`Account is already suspended` after the damage was done. Each half is still a
separate audited action with its own reason. `400` for: neither field supplied,
`Unknown status`/`Unknown role`, a missing or >500-char reason, `Bots cannot be
suspended`/`cannot be given a role`, `Account is already <status|role>`, acting
on yourself (`You cannot suspend your own account` / `change your own role`), or
removing the **last active admin in that tenant** (`Cannot suspend the last
active admin` / `Cannot demote the last active admin`).

Exclusion cancels the account's resting orders and releases their escrow, and
leaves **matched** positions alone — they must still settle, or the venue would
be choosing which side of a matched bet to honour. There is deliberately no
`unexclude` route.

A breach of a cap is refused with a distinct `details.code`:
`market_liability_exceeded` or `stake_limit_exceeded`. When the **daily settled**
cap is reached the order still rests — it simply stops participating in matching,
because an order that vanished for no stated reason is a support incident.

---

## Admin: market-maker risk desk

| Route | Request | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/admin/risk` | — | `200 { kill_switch, bots }`; each bot carries `liability_cents`, `daily_pnl_cents`, `pressure` (0–1), `quoting_allowed` and `reason` | `401`/`403` |
| `PUT /api/admin/risk/kill-switch` | `{ on, reason }` — **reason required**, 5–500 chars | `200 { kill_switch }`. The setting write and its `risk.kill_switch` audit row are one transaction, and the switch is **not pulled** if the audit write fails — the most consequential write the venue offers must not land with no record of who did it | `400` missing, under 5 or over 500 chars; `500` the audit log could not be written |
| `POST /api/admin/risk/withdraw` | `{ reason }` — same requirement | `200 { cancelled_orders, released_cents }`, audited | `400` on the reason |
| `PUT /api/admin/risk/bots/:id` | `{ max_liability_cents?, max_daily_loss_cents?, quote_skew?, enabled? }` — caps are **positive integers**, `quote_skew` is `0`–`1` | `200` the updated `risk_bots` row, audited | `400` a non-positive cap, `quote_skew must be between 0 and 1`, or a non-bot account; `404 No such bot` |
| `GET /api/admin/risk/cashout` | — | `200 { outstanding_cents, outlay_today_cents, realised_loss_today_cents, open_buyouts, taken_today, max_outstanding_cents, max_daily_outlay_cents, outstanding_headroom_cents, daily_outlay_headroom_cents, quoting_allowed }` | `401`/`403` |

The kill switch stops **new** quotes; it does not cancel resting ones, which is
why `withdraw` is a separate action. A bot widens its quotes as it approaches a
cap and only stops at the hard cap — `pressure` drives the skew so both caps are
honoured continuously rather than as a cliff.

`PUT /api/admin/risk/bots/:id` takes `next` correctly (issue #25): invalid input
is a real `400`, and a genuine fault — a `SQLITE_BUSY` during a restore, a
constraint violation — surfaces as a `5xx` **and is logged**, instead of being
stamped `400` with no log line at all.

`GET /api/admin/risk/cashout` is the venue's cash-out exposure desk. The daily
cap gates on **outlay** (what has been paid today) rather than realised loss:
outlay is known at decision time and genuinely bounds the worst case; realised
loss is backward-looking, so by the time it is measurable the money is gone.
There is no "expire stale cash-out quotes" route and there is no live quote to
sweep — quotes and their executions are atomic, and what the venue carries is
executed buyouts, which resolve at settlement.

---

## Admin: results, disputes and the in-play desk

| Route | Request | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/admin/results/feed` | — | `200 { configured, target, status, last_poll_at, last_ok_at, last_error, consecutive_failures, polls, ok_polls, signals_received, dropped_entries, last_dropped, age_ms, stale }`. `status` is `not_configured` \| `failing` \| `stale` \| `ok` | `401`/`403` |
| `POST /api/admin/results/poll` | — | `200 { considered, applied, results, error, feed }` — runs one cycle through the same fetcher the scheduled job uses, including `RESULTS_FEED_SECRET` | `401`/`403`; a transport failure is reported inside the payload, not as a status |
| `GET /api/admin/results/void-rules` | — | `200 { sports, rules, default }` — the per-sport table from [`lib/voidrules.js`](../lib/voidrules.js) | `401`/`403` |
| `GET /api/admin/results/held` | — | `200 { markets }` — every market with `settlement_hold = 1`, with its `hold_reason` | `401`/`403` |
| `POST /api/admin/results/held/:id/release` | `{ decision: "settle" \| "void", winner_selection_id?, dead_heat?, reason }` — reason required, ≥5 chars. Ids pass through **uncoerced**: `winner_selection_id` and every `dead_heat` entry must be a JSON integer, so a quoted `"2"`, `true` or `[2]` is refused rather than parsed | `200` the settlement result, audited | `400` missing reason, unknown `decision`, a `settle` with neither a winner nor a `dead_heat`, a `void` **and** a winner, a `dead_heat` that is not an array or names fewer than two distinct integer ids, a winner id that is not a positive integer, or a non-integer `:id`; `404` unknown market; `409` already settled. On refusal the market stays **held and open** — a malformed request must never clear the hold, even to roll it back |
| `GET /api/admin/reconciliation/findings` | `?limit=` (default 100). Unresolved first, then by descending drift | `200 { findings }` | `401`/`403` |
| `POST /api/admin/reconciliation/findings/:id/resolve` | `{ reason }` — required, ≥5 chars | `200 { id, resolved }`, or `{ id, already_resolved }`, audited | `400` on the reason; `404 Finding not found`; `400` non-integer id |
| `POST /api/admin/markets/:id/suspend` | `{ suspended?, until?, reason? }`. `suspended` defaults to `true`; `until` is `null` for open-ended | `200 { market_id, suspended, until, reason }` | `400` unparseable `until`, or a non-integer id; `404` unknown market; `409` only an open market can be suspended |
| `POST /api/admin/markets/:id/inplay` | `{ inplay?, delay_ms? }` — `delay_ms` an integer in `[0, 600000]`. Going in-play **suspends** the market by design | `200 { market_id, inplay, delay_ms }` | `400` a delay outside the range, or a non-integer id; `404`; `409` only an open market can go in-play |
| `POST /api/admin/markets/:id/release` | — | `200 { market_id, released, delay_ms }`; `{ released: false, reason: "not in-play" }` when the market is not in-play | `400` non-integer id; `404` |
| `POST /api/admin/inplay/release-delays` | `{ limit? }` — a hint; a nonsensical one falls back to 1000 rather than `400`ing an operator's emergency button | `200 { considered, released, filled, skipped }` | `401`/`403` |
| `GET /api/admin/markets/:id/volume` | `?window=` in minutes (default 10, floored at 1) | `200 { window_minutes, fills, staked_cents, turned_over_cents, by_selection }` | `400` non-integer id; `401`/`403` |

Releasing a hold is explicit, reasoned and audited because the whole point of
holding a disputed market is that a machine could not decide it. A held **dead
heat** is releasable as a dead heat: `dead_heat` passes through unchanged so
`lib/results.js` validates it and a coerced id can never pick an outcome.

`POST /api/admin/markets/:id/release` is the only way an in-play market starts
accepting bets, and it is deliberately separate from suspending.
`POST /api/admin/inplay/release-delays` exists so an operator can drain a
backlog immediately — after restoring a database, or turning a delay off
mid-event — without waiting a cycle.

---

## Reports

All six accept `?from=` and `?to=` as strict `YYYY-MM-DD` dates and validate
them rather than defaulting silently: an operator who asked for a month and was
handed the lifetime total would file it. `to` defaults to today, `from` to
`to − 30 days`, and the span may not exceed **400 days**.

Every report defaults to **CSV** — what an operator actually files, and what a
regulator asks for — with a `Content-Disposition` filename carrying the period.
`?format=json` returns the same figures with their definitions intact.

| Route | CSV filename | JSON payload |
| --- | --- | --- |
| `GET /api/admin/reports/summary` | `summary_<from>_to_<to>.csv` | `{ period, definitions, financial, activity, rates, … self-check fields }` |
| `GET /api/admin/reports/settlements` | `settlements_<from>_to_<to>.csv` | `{ period, rows, statements, definitions }` |
| `GET /api/admin/reports/volume` | `volume_<from>_to_<to>.csv` | `{ period, by_market, by_selection, definitions }` — the selection breakdown is computed **only** for the JSON path, so a CSV request does not pay for it |
| `GET /api/admin/reports/volume-by-selection` | `volume_by_selection_<from>_to_<to>.csv` | `{ period, rows, definitions }` |
| `GET /api/admin/reports/commission` | `commission_<from>_to_<to>.csv` | `{ period, rows, definitions }` — effective rate beside the amount, so the arithmetic can be checked by hand |
| `GET /api/admin/reports/operational` | `operational_<from>_to_<to>.csv` | `{ period, definitions, … }` including the realised bet delay, which is only meaningful because that delay is enforced by the engine |

Errors on all six: `400` for a malformed or impossible period; `401`/`403` for
the role guards.

`summary` carries a **self-check**: `settlements_net_pnl` must equal
`buyout_paid_cents − venue_took_over_cents`, and `self_check_ok` says whether it
does. Turnover counts matched stake once per trade and is **not** deposits; buyout
legs are excluded, because a cash-out is not a trade.

---

## Ops

| Route | Auth | Success | Errors |
| --- | --- | --- | --- |
| `GET /healthz` | public | `200 { status: "ok", uptime_seconds, pid, version }`. Deliberately does **not** touch the database — a liveness probe that queries a dependency turns a database blip into a crash loop | — |
| `GET /readyz` | public | `200 { status: "ready", checks }` or `503 { status: "not_ready", checks }`. `checks` covers `database`, `ledger`, `cache`, `risk_desk` and `results_feed`. A drifted ledger or a divergent balance cache is **not ready** | `503` |
| `GET /metrics` | `OPS_TOKEN` | `200 text/plain; version=0.0.4` — match rate, unmatched ratio, matched stake, held markets, open reconciliation findings, ledger drift, users, uptime | `404` token unset; `401` wrong token |
| `POST /api/admin/backup` | admin **and** `OPS_TOKEN` | `200 { path, bytes, users, integrity: "ok" }`, audited. Takes a `VACUUM INTO` snapshot of the live database, verifies it opens, then prunes | `400` no `BACKUP_DIR` configured; `404` token unset; `401` wrong token; `401`/`403` for the role guards |

`POST /api/admin/backup` takes its destination **from config only** (issue #24).
`dir` in the request body is ignored — the route is reachable by any admin plus
the ops token, and `lib/ops.js` `mkdirSync`s whatever it is handed, so a caller
who could choose the directory had a filesystem write primitive whose obvious
target is `public/`, which `express.static` serves unauthenticated. An operator
who wants a different directory sets `BACKUP_DIR` and restarts, which is
auditable from the environment rather than from whatever the last request said.
`retention` **is** honoured but clamped to `[1, 1000]`; an unclamped `0` switched
pruning off entirely and let snapshots accumulate until the disk filled.

The results feed is reported in `/readyz` and deliberately **not** a readiness
gate: a dead feed means outcomes arrive late and a human settles, and pulling a
trading venue out of rotation over it would manufacture an outage.

---

## Related documents

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — module layout and the rationale behind it
- [`EXCHANGE_RULES.md`](EXCHANGE_RULES.md) — the financial invariants, in full
- [`FEED.md`](FEED.md) — the odds-feed collector, credentials and supervision
- [`ROADMAP.md`](ROADMAP.md) — what is deliberately not built, and why