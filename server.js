'use strict';
// server.js — OpenBettingExchange exchange server (Express ^5, node:sqlite).
const express = require('express');
const path = require('path');
const config = require('./lib/config');
const { openStore } = require('./lib/store');
const { seedIfNeeded, rollForwardEvents } = require('./lib/seed');
const A = require('./lib/auth');
const { isIsoDateTime } = require('./lib/util');
const L = require('./lib/ledger');
const M = require('./lib/match');
// Two aliases with a reason each. MATCH is the engine under the name the
// in-play release pass uses, so a reader of that job sees M.* and
// MATCH.releaseEligibleOrders in the same file and knows they are one module.
// RG is the responsible-gambling gate. (Both lines were briefly missing after a
// shell-quoting failure in a sed, and nothing noticed until the API suite
// called a route that used them — a reminder that an undefined identifier in a
// rarely-taken route is a runtime error, not a load error.)
const MATCH = M;
const RG = require('./lib/rg');
// NOT `FEED`: that identifier is already the odds recorder (lib/feed.js). The
// two are unrelated transports that happen to both be feeds, and shadowing one
// with the other is a silent, load-time SyntaxError that costs more to find
// than one longer name saves.
const RFEED = require('./lib/resultsfeed');
const REPORTS = require('./lib/reports');
const SET = require('./lib/settle');
const CASH = require('./lib/cashout');
const bots = require('./lib/bots');
const drift = require('./lib/drift');
const ODDS = require('./lib/odds');
const FEED = require('./lib/feed');
const FCREDS = require('./lib/feedcreds');
const FRUN = require('./lib/feedrunner');
const ADM = require('./lib/admin');
const AUDIT = require('./lib/audit');
const LIMITS = require('./lib/limits');
const RISK = require('./lib/risk');
// Scheduled operator work. 0 disables a job. Reconciliation defaults ON at
// 15 minutes: it is cheap, and a control nobody runs is not a control.
const JOBS_INTERVALS = {
  reconcileMs: Number(process.env.RECONCILE_INTERVAL_MS || 900000),
  resultsPollMs: Number(process.env.RESULTS_POLL_INTERVAL_MS || 60000),
  // Backups on a timer, not on request: an operator who forgets to press the
  // button has no backup, and the button is the first thing skipped under
  // pressure. Six hours keeps a day of snapshots with the default retention.
  backupMs: Number(process.env.BACKUP_INTERVAL_MS || 21600000),
  // WAL checkpoint + incremental vacuum, hourly.
  maintenanceMs: Number(process.env.MAINTENANCE_INTERVAL_MS || 3600000),
  // In-play delay release. This is what makes the bet delay ENFORCED rather
  // than merely reported: a delayed order rests until this pass releases it.
  // It has to be a timer, not a side effect of the next placement — otherwise
  // an in-play order would sit unmatched until a taker happened to arrive,
  // which is a venue that quietly stops trading. Five seconds is a sensible
  // cadence: tight enough that a 6-second delay is honoured, loose enough
  // that the scan is trivial. 0 disables it.
  delayReleaseMs: Number(process.env.DELAY_RELEASE_INTERVAL_MS || 5000),
};
const PAY = require('./lib/payments');
const TEN = require('./lib/tenants');
const JOBS = require('./lib/jobs');
const RESULTS = require('./lib/results');
const VOIDRULES = require('./lib/voidrules');
const OPS = require('./lib/ops');
const INPLAY = require('./lib/inplay');
// The credential-abuse counters do their read-modify-write inside a transaction,
// so two processes sharing the database cannot lose a strike between them.
const { transaction } = require('./lib/tx');
const CASHOUTRISK = require('./lib/cashoutrisk');

// Keep the local dashboard alive on stray async failures; log for diagnosis.
// DELIBERATE demo choice (documented in .github/SECURITY.md): this app is
// loopback-only paper money, and a crashed local dashboard is worse than a
// possibly-inconsistent one, so stray async failures are logged and the
// process keeps serving. This is a covenant, not an oversight — if the app
// ever serves real accounts or non-loopback interfaces, these handlers MUST
// become a clean shutdown (drain connections, exit non-zero, let a
// supervisor restart).
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

const app = express();
app.disable('x-powered-by');

// ── Query parser: PINNED, and the audit that justifies it ───────────────────
//
// Express 5 changed this default from `extended` (qs) to `simple` (node's
// querystring). That is not a cosmetic framework change: `extended` expands
// `?filter[a]=1` into a nested object and `simple` leaves it the literal key
// `"filter[a]"`. Any route that read a nested query parameter would silently
// start reading `undefined`.
//
// THE AUDIT (server.js, the only file that reads a query string — nothing in
// lib/ or public/ does). Every read is a flat, single-level key:
//
//   ?limit ?offset ?from ?to ?format ?window ?sport ?sport_id ?id ?q ?role
//   ?status ?target ?action ?actor_id ?tenant_id
//
// and the only query-string BUILDER in the codebase (public/admin.js, two
// `new URLSearchParams(...)` calls) emits flat keys from a literal object. A
// repository-wide search for bracket syntax in a query string
// (`[?&]name[...]=`) across server.js, lib/, public/, docs/ and scripts/ finds
// none, so nothing here can observe the change. That search is re-run
// mechanically by tests/express5.test.js E4, so the audit cannot rot.
//
// WHY `simple` AND NOT `extended`, then: preserving the old default would mean
// depending on `qs` for parsing this app never uses, and `qs` is the package
// that carries the CVE history in this tree (CVE-2026-2391 / -82417 / -82562,
// per issue #74). `simple` keeps that dependency off the query path entirely.
//
// THE POINT IS NOT THE VALUE, IT IS THAT IT IS WRITTEN DOWN. An unset
// `query parser` means the behaviour of every query-string read in the app is
// decided by whichever framework version happens to be installed — exactly the
// class of drift this repository keeps auditing and keeps finding. If a future
// route needs nested syntax it must change this line and say why, rather than
// arriving with a query parameter nobody can read.
app.set('query parser', 'simple');
// Baseline hardening headers (cheap, local-demo appropriate).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  // CSP is strict because the frontend is verifiably inline-free: the only
  // scripts are the three external tags (/ladder.js /app.js /admin.js), all
  // styles live in /style.css, fonts are self-hosted under /fonts and the
  // only images are /assets/*.png — so 'self' everywhere suffices (img-src
  // keeps data: for future inline icons). Net effect: an injected inline
  // <script>, an on*= HTML attribute or a javascript: URL is refused by the
  // browser even if an escaping bug ever slips past esc().
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
  next();
});

// ── Caching ─────────────────────────────────────────────────────────────────
//
// EVERY /api response is `no-store`, without exception.
//
// The money routes (`/api/me`, `/api/wallet`, `/api/positions`,
// `/api/settlements`, `/api/orders`) are cookie-authenticated GETs carrying
// balances, frozen escrow and per-runner exposure. That is precisely the shape a
// shared or corporate proxy caches, and precisely the shape it serves back to
// the WRONG user behind that proxy when the cache key ignores the cookie. The
// venue is loopback-only by default, but the moment it sits behind an edge — the
// deployment this codebase already has `TRUST_PROXY_JURISDICTION` for — a
// cached balance is a real failure mode: a player sees yesterday's money, or
// somebody else's.
//
// `no-store` rather than `no-cache`: `no-cache` still permits STORING a response
// and revalidating it, which is one round trip away from a stale balance.
//
// Blanket, not a list of "sensitive" routes. A per-route list is a second list
// to keep in step with the routes, and the route someone forgets is the one that
// leaks. The public catalogue (`/api/sports`, `/api/events`) could safely be
// cached and deliberately is not: on a loopback venue HTTP caching buys nothing,
// and one rule that cannot be applied to the wrong route is worth more than the
// optimisation. `tests/api.test.js` asserts the header on the money routes, so a
// future blanket relaxation has to be a deliberate edit.
//
// The SSE stream is exempt in effect, not in code: `/api/stream` sets its own
// `Cache-Control: no-cache` through `res.writeHead`, and a header passed to
// writeHead takes precedence over one set with setHeader.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    // The version a client built against, on EVERY /api response. An external
    // strategy has no other way to discover what it is talking to: the URL does
    // not change, so without this there is no signal at all that the contract
    // has moved.
    //
    // A RESPONSE header rather than a request header, deliberately. Requiring
    // clients to send it would break every existing call the day it landed, and
    // a version you can only opt out of is not a stability promise. Additive, and
    // on every response including errors, so a client learns the version from a
    // failure too — which is when it matters most.
    res.setHeader('X-API-Version', config.API_VERSION);
    next();
  });

// ── Origin guard FIRST, before any body parsing ───────────────────────────────
//
// The rule is SIMPLE, and it was previously two rules that were each wrong:
//
//   no Origin            => allowed. A browser ALWAYS sends Origin on a
//                          cross-origin mutating request, so its absence means
//                          this is not a browser: curl, a local agent, a script.
//   Origin present       => it MUST equal the authority the request addressed.
//
// The old check compared `u.hostname` against a loopback set and nothing else:
//
//   - It ignored the PORT, so `http://127.0.0.1:9999` was accepted. Browsers
//     exclude ports from the site calculation, so a page served by ANY local
//     server on a different port is SAME-SITE, `SameSite` does not protect it,
//     and that page could drive the exchange with the operator's session. The
//     guard was written to stop precisely that and did not.
//   - It REJECTED legitimate IPv6 clients: `new URL('http://[::1]:7777')` has
//     hostname `[::1]` WITH the brackets, which never equals the `'::1'` it was
//     compared against. So the venue on ::1 refused its own client.
//
// Matching the full authority (`host:port`) against the `Host` header closes the
// first and fixes the second. Behind a reverse proxy that rewrites Host this
// would need the forwarded host instead — but the venue binds loopback only, so
// direct access is the norm, and a wrong comparison fails CLOSED (403), which is
// the direction to fail in.
//
// Running it before express.json() means a foreign origin gets 403 even when
// the body is malformed.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const u = new URL(origin);
    // `u.host` is authority WITH the port, brackets preserved. Compare the whole
    // thing against the authority the client addressed.
    if (u.host && req.headers.host && u.host === req.headers.host) return next();
  } catch {}
  return apiError(res, 403, 'Forbidden origin');
});

app.use(
  express.json({
    limit: '256kb',
    // The payments webhook authenticates by HMAC over the RAW request body.
    // express.json would otherwise hand the route a re-serialised object whose
    // bytes differ from what the provider signed (key order, whitespace), and
    // the signature would never verify. Capturing the buffer here is the
    // standard fix.
    verify: (req, res, buf) => { req.rawBody = buf; },
  })
);

// DB + idempotent seed on first run.
const db = openStore(config.DB_PATH);
// The feed supervisor reads its credentials from this same handle. Injected after
// openStore so lib/feedrunner.js never has to import lib/store.js.
FRUN.setDb(db);
// Seeding derives three password hashes, and each derivation now runs on
// libuv's threadpool instead of blocking this thread. That makes the seed
// genuinely asynchronous — which lib/tx.js cannot tolerate inside its
// synchronous transaction, and which is exactly why lib/seed.js derives every
// hash BEFORE opening that transaction (see the note there).
//
// The bootstrap is therefore a PROMISE, exported as `ready`. main() awaits it
// before listening, and anything else that requires this module awaits it
// before it assumes the catalogue exists. Nothing here is fire-and-forget:
// a test that read the board while the seed was mid-flight would see an empty
// venue and draw conclusions from it.
const ready = seedIfNeeded(db);
// Housekeeping: drop expired sessions at boot, and hourly while running —
// a long-lived demo otherwise accumulates dead rows forever. The interval is
// unref'd so it never keeps the process (or a test run) alive by itself.
db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
const sessionSweeper = setInterval(() => {
  try {
    db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  } catch {
    /* DB closed during shutdown — nothing left to sweep */
  }
}, 60 * 60 * 1000);
if (sessionSweeper.unref) sessionSweeper.unref();

// ── Engine switches ────────────────────────────────────────────────────────
// With the feed on, the recorder owns prices; bots and drift would requote
// ladders straight over the observed Betfair book, so they are suppressed
// regardless of their own flags. Hoisted ABOVE every use (the admin
// selections route AND main()) so no code path can ever consult the raw
// config flag and quote over a feed-owned market.
const BOTS_ON = config.BOT_ENABLED && !config.FEED_ENABLED;
const DRIFT_ON = config.DRIFT_ENABLED && !config.FEED_ENABLED;

// ── Session (httpOnly cookie + Bearer fallback) ───────────────────────────
// Cookies are host-scoped, not port-scoped: a sibling app on localhost:3000
// can hand this dashboard a cookie it never wrote. decodeURIComponent THROWS
// on a malformed escape ("ob_session=%"), and a throw here would 500 every
// request — including GETs — so a bad escape falls back to the raw value
// (which simply fails the token lookup instead of killing the request).
function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = safeDecode(part.slice(i + 1).trim());
  }
  return out;
}

app.use((req, res, next) => {
  const cookies = parseCookies(req);
  let token = cookies.ob_session;
  const authHeader = req.headers.authorization;
  if (!token && authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
  req.user = A.sessionUser(db, token);
  req.token = token;
  next();
});

// The first-run credential lock, defined ONCE and called from the auth gate.
//
// It used to be an app.use() registered after most of the routes, on the
// reasoning that "a route added later is covered by default". That is false for
// any route registered EARLIER — /api/stream, registered some 350 lines above
// the middleware, answered 200 to a locked account. The design goal was "no
// per-route list", and a middleware's position in the file is exactly such a
// list, maintained by accident.
//
// Checking it inside requireAuth/requireAdmin makes placement irrelevant: any
// route that authenticates is covered, and a new one cannot forget.
// The routes an account locked by the first-run lock must still be able to
// reach, or the lock is a dead end rather than a lock. Declared here, above
// firstRunLockResponse, because BOTH the requireAuth/requireAdmin check and the
// app.use() middleware below consult it and it must be one list, not two.
//
// The minimum needed to GET TO THE FIX and nothing more: whoami,
// change-password, logout, session management. Notably absent is everything a
// demo password should not reach — trading, the wallet, and the entire admin
// desk, which is the account that matters most. An admin left on admin123 who
// can read the ledger and move other people's money is the worst state this
// project can be deployed in.
// Each entry is a route PATTERN: a segment beginning with `:` matches exactly
// one non-empty segment. Writing them as patterns rather than literals is what
// lets a parameterised route be expressible at all — see isSetupRoute below.
const SETUP_ALLOWLIST = [
  ['GET', '/api/me'],
  ['POST', '/api/auth/change-password'],
  ['POST', '/api/auth/logout'],
  ['GET', '/api/auth/sessions'],
  ['DELETE', '/api/auth/sessions/:id'],
];

// Compile one entry to a matcher. The pattern is anchored at both ends and each
// segment is compared individually, so `/api/auth/sessions/:id` matches
// `/api/auth/sessions/abc` and NOT `/api/auth/sessions/a/b`, and no allowlisted
// prefix can grow to cover a route nobody approved.
function compileAllowlistEntry([method, pattern]) {
  const re = new RegExp(
    `^${pattern
      .split('/')
      // The leading empty segment of an absolute path splits to '' and is kept.
      .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')}$`
  );
  return { method, re };
}

const SETUP_ALLOWLIST_COMPILED = SETUP_ALLOWLIST.map(compileAllowlistEntry);

// isSetupRoute: does the request match an allowlisted route PATTERN?
//
// It compared the literal string `${req.method} ${req.path}` against the Set
// before. Four of the five entries happened to be literal already, so the set
// lookup worked and nobody noticed that `DELETE /api/auth/sessions/:id` could
// never match: `req.path` is `/api/auth/sessions/abc` for every real request,
// and comparing that against the string `/api/auth/sessions/:id` misses. The
// entry was dead BY CONSTRUCTION, not by an accident of data — a locked account
// was refused `GET /api/auth/sessions` (200) but `DELETE` of one of them (403),
// which is the exact trap this lock is supposed to avoid being.
//
// Two properties are deliberately preserved from that comparison:
//
//   - `req.path`, not `req.originalUrl`, so a query string cannot turn an
//     allowlisted route into a locked one: `GET /api/me?x=1` must behave
//     identically to `GET /api/me`. (Verified: req.path excludes the query.)
//   - the METHOD is part of the match, not just the path, so allowing a GET
//     never implies allowing a POST to the same path.
//
// Matching a pattern rather than dropping the entry is the right direction: the
// list's own comment says session management is part of the minimum needed to
// reach the fix, and a player who believes a device is stolen should be able to
// sign it out. Narrowing the lock is a product decision; making the mechanism
// match what it already claims is not.
function isSetupRoute(req) {
  const path = req.path;
  return SETUP_ALLOWLIST_COMPILED.some((e) => e.method === req.method && e.re.test(path));
}

function firstRunLockResponse(req, res) {
  if (!mustChangePassword(req.user)) return false;
  // A LOCKED ACCOUNT MUST STILL BE ABLE TO UNLOCK ITSELF.
  //
  // This check was moved into requireAuth/requireAdmin on the reasoning that
  // placement in the file should not matter (correct), but the move DROPPED the
  // allowlist exception: the app.use() middleware that consulted it was left
  // behind, registered some 400 lines later, where it can never run for a route
  // that requireAuth has already answered. So `POST /api/auth/change-password`
  // — the one route that clears the flag — was itself behind the lock.
  //
  // Measured: of the five allowlisted routes, only `POST /api/auth/logout`
  // worked, because it is the only one that does not use requireAuth. Every
  // other route on the list returned 403 'Change your password before using the
  // exchange', and no password could ever be changed. A fresh deployment was
  // unusable and the only way out was a direct database edit.
  //
  // The lock is a control, not a trap: it must block trading while leaving the
  // exit open.
  if (isSetupRoute(req)) return false;
  apiError(res, 403, 'Change your password before using the exchange', {
      code: 'password_change_required',
      username: req.user.username,
      // THE FIXTURE THIS REPLACED: `seeded_password: username === 'admin' ?
      // 'admin123' : 'demo123'`. A password value in an API response, which is
      // the one thing this codebase does not otherwise do — lib/feedcreds has
      // an explicit property that no function there returns a credential, and
      // this line was the counterexample sitting in the same repository.
      //
      // It was not only a disclosure, it was a FALSE one. It answered from a
      // literal rather than from the stored hash, so an operator who seeded
      // ADMIN_PASSWORD (which lib/config.js has always supported) was told
      // `admin123`, which does not open their account. And it answered
      // `demo123` for EVERY other username, so any account that ended up
      // flagged was handed the demo pattern on the strength of a ternary —
      // a password oracle whose only claim to knowledge was "not named admin".
      //
      // The value was never needed to recover, which is what makes removing it
      // cost nothing: this response is only reachable by a caller who has
      // ALREADY proved knowledge of the password it discloses. You cannot be
      // locked out of here without having signed in, and `POST
      // /api/auth/change-password` verifies that same password. So what the
      // client needs is the FLAG — which it already has, from
      // `user.must_change_password` on the login response — and a reason, which
      // is what this now says.
    });
  return true;
}

function requireAuth(req, res, next) {
  if (!req.user) return apiError(res, 401, 'Authentication required');
  // Stamp RG activity on real use. The session clock is reset only after an
  // IDLE gap measured from this, so signing out cannot start a new session —
  // see lib/rg.js.
  try {
    if (Number(config.RG_SESSION_MINUTES || 0) > 0) RG.touch(db, req.user.id);
  } catch {
    // An RG bookkeeping failure must never refuse a request; the gate is
    // authoritative, this is only the idle timer.
  }
  if (firstRunLockResponse(req, res)) return;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return apiError(res, 401, 'Authentication required');
  try {
    if (Number(config.RG_SESSION_MINUTES || 0) > 0) RG.touch(db, req.user.id);
  } catch {
    /* idle timer only */
  }
  // Same first-run lock as requireAuth, for the same reason: the guarantee must
  // not depend on where a route happens to be registered.
  if (firstRunLockResponse(req, res)) return;
  // role is authoritative. The `|| req.user.is_admin` is the same legacy
  // tolerance sanitizeUser applies: a session minted before the accounts
  // migration may carry a row whose role column has not been read yet.
  if (req.user.role !== 'admin' && !req.user.is_admin) {
    return apiError(res, 403, 'Admin only');
  }
  next();
}

// ── Route helpers ──────────────────────────────────────────────────────────
//
// Forward an async handler's rejection to the error middleware.
//
// Express 5 does this ITSELF for a handler that returns a promise, so this
// wrapper is no longer the only thing standing between a rejected `await` and a
// dangling socket. It is KEPT rather than deleted, for one reason: it does not
// depend on the router noticing a thenable return value, so it still holds if
// a handler is ever registered through a path that does not. It also keeps
// working for the handlers that take `(req, res)` and no `next`.
//
// The important thing for the money path is that this is NOT the only defence.
// It never was: every async handler in this file also catches its own rejection
// explicitly (see tests/express5.test.js E7, which asserts that mechanically).
// The two are redundant on purpose — belt and braces, with the explicit catch
// being the one that also carries handler-specific policy (a failed login
// records a strike; a feed outage answers 503 rather than 500).
const aw = (h) => (req, res, next) => Promise.resolve(h(req, res, next)).catch(next);

// :id params arrive as URL strings. Number('12.5'), Number('abc') and
// Number(undefined) produce 12.5, NaN and NaN — none are valid row ids, and
// NaN would throw inside the SQLite binder (a 500, not a 404). Every :id
// route goes through here: non-integers answer 400 before any query runs.
function intId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw A.httpError(400, 'id must be an integer');
  return n;
}

function sessionCookie(token) {
  return `ob_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${config.SESSION_TTL_DAYS * 86400}`;
}

// ── SSE ────────────────────────────────────────────────────────────────────
const clients = new Set();
// Cap on concurrent streams: each holds a socket, a file descriptor and a
// write buffer, so a leak or a script-opening client must not multiply
// without bound. Over the cap the endpoint answers 503 once (no SSE body)
// — EventSource retries on its own schedule as older streams free up.
// A venue's live book IS the product; a player who cannot subscribe has a
// dead board. 100 was appropriate for a loopback demo and is far too low for
// anything public — it answers 503, so the 101st concurrent visitor simply has
// no live prices. Configurable, with the trade-off stated: every stream is a
// held socket and a periodic write, so this is a real memory ceiling, not free.
const MAX_SSE_CLIENTS = Number(config.MAX_SSE_CLIENTS || 2000);

// ── WHY THERE IS MORE THAN ONE CAP ──────────────────────────────────────────
//
// A single global cap is not a capacity control, it is a lottery. Every stream
// in `clients` costs the venue exactly the same — a socket, a descriptor, a
// write buffer, a slot in every broadcast fan-out — and every stream in it
// returns the same, which is NOTHING to an unauthenticated caller: /api/stream
// requires no session, and an anonymous stream receives only public `book`
// frames. So one script could open all 2000 of them, and the cost to the
// attacker was 2000 open TCP connections while the cost to the venue was its
// live UX for every player who then got a 503 on the live-update channel.
//
// Three rules, and each one closes a different hole:
//
//   1. PER SOURCE, on ANONYMOUS streams. The described attack is one script,
//      so the bound has to be on the source. It counts ANONYMOUS streams
//      only, and that is deliberate: if it counted every stream from the
//      address, a flood from a player's own NAT would lock that player out —
//      which is the same unfairness, pointed the other way. An authenticated
//      caller is bounded by rule 2 instead.
//
//   2. PER USER, on streams latched to an account. Without this the "per-user"
//      half of the problem does not exist at all: one account, many tabs, is
//      the same account as far as fairness is concerned, and 2000 tabs is a
//      legitimate-looking way to take the whole pool.
//
//   3. A RESERVATION. Rules 1 and 2 bound one source and one account; neither
//      bounds a flood spread across sources. So anonymous streams may occupy
//      at most ANON_POOL_SHARE of the pool, and the rest is kept for
//      authenticated players whatever else is happening. This is the property
//      that makes "a player is never starved by anonymous traffic" true rather
//      than merely likely.
//
// The session requirement the issue also suggests is NOT applied, and that is a
// judgement rather than an omission: requiring one would mean a signed-out
// viewer loses live prices on a venue whose front page IS the board, in
// exchange for bounding a problem rules 1–3 already bound. The anonymous stream
// is documented behaviour and it stays.
const MAX_SSE_CLIENTS_PER_SOURCE = Number(config.MAX_SSE_CLIENTS_PER_SOURCE || 20);
const MAX_SSE_CLIENTS_PER_USER = Number(config.MAX_SSE_CLIENTS_PER_USER || 8);
// The share of the pool anonymous viewers may occupy. Four fifths is generous
// to anonymous traffic and still leaves a fifth of the pool — 400 streams at
// the default cap — for signed-in players under any flood shape.
const ANON_POOL_SHARE = 0.8;
// Ceil, not floor: a reservation that rounds DOWN to zero would leave no room
// for authenticated players at all, which is the opposite of what it is for.
const ANON_POOL_CAP = Math.max(1, Math.ceil(MAX_SSE_CLIENTS * ANON_POOL_SHARE));

/**
 * Whether a stream may be opened, as a PURE function of the pool's contents.
 *
 * `state` is a list of `{ remote, userId }` and is passed in rather than read
 * from the module so the policy is assertable without opening 2000 sockets —
 * which is the only reason the third rule above can be tested at all: every
 * real connection from an offline test shares one loopback address, so a
 * multi-source flood is not reproducible over HTTP. The route passes the live
 * `clients` set; the tests pass a list they built.
 *
 * Returns null to admit, or the refusal the route should answer. 503 for a
 * CAPACITY refusal (the venue is full) and 429 for a CALLER refusal (this
 * caller is over its share) — a client that is over its own limit can fix that
 * by closing a stream, and saying so with Retry-After is the useful answer.
 *
 * O(n) in the pool per connect. That is deliberate: a second map of per-source
 * counters would be a second source of truth about who is connected, which is
 * exactly the kind of bookkeeping that drifts. Connects are rare and the pool
 * is bounded, so the scan is cheaper than the bookkeeping.
 */
function streamAdmission(state, who, limits) {
  if (state.length >= limits.global) {
    return { status: 503, error: 'Too many concurrent streams' };
  }
  // Counted before any refusal, so every caller learns the same thing about
  // their own share of the pool.
  let anonFromSource = 0;
  let mine = 0;
  for (const c of state) {
    if (c.userId === null && c.remote === who.remote) anonFromSource++;
    if (who.userId !== null && c.userId === who.userId) mine++;
  }
  if (who.userId === null) {
    if (limits.perSource > 0 && anonFromSource >= limits.perSource) {
      return {
        status: 429,
        error: 'Too many concurrent streams from this address',
        retryAfter: 60,
      };
    }
    // The reservation counts EVERY anonymous stream, not just this source's:
    // it is a claim on the pool, and a rule that only applied per address
    // would be defeated by spreading the flood across addresses — which is
    // the one shape rules 1 and 2 cannot see.
    let anonTotal = 0;
    for (const c of state) if (c.userId === null) anonTotal++;
    if (anonTotal >= limits.anonCap) {
      return {
        status: 503,
        error: 'Live stream capacity is reserved for signed-in players; try again shortly',
      };
    }
    return null;
  }
  if (limits.perUser > 0 && mine >= limits.perUser) {
    return { status: 429, error: 'Too many concurrent streams for this account', retryAfter: 60 };
  }
  return null;
}

app.get('/api/stream', (req, res) => {
  // The first-run lock, explicitly. This route uses OPTIONAL auth — a signed-out
  // viewer gets an anonymous stream — so it never passes through requireAuth,
  // and the middleware that used to enforce the lock sat 350 lines BELOW this
  // registration and therefore did not apply. A locked account got a live
  // stream. The lock check now lives in requireAuth/requireAdmin so placement
  // cannot matter, and this one route keeps an explicit call because optional
  // auth is genuinely a different case, not an oversight.
  if (req.user && firstRunLockResponse(req, res)) return;
  const remote = req.socket.remoteAddress || 'unknown';
  const refusal = streamAdmission(
    [...clients],
    { remote, userId: req.user ? req.user.id : null },
    {
      global: MAX_SSE_CLIENTS,
      perSource: MAX_SSE_CLIENTS_PER_SOURCE,
      perUser: MAX_SSE_CLIENTS_PER_USER,
      anonCap: ANON_POOL_CAP,
    }
  );
  if (refusal) {
    if (refusal.retryAfter) res.setHeader('Retry-After', String(refusal.retryAfter));
    return res.status(refusal.status).json({ error: refusal.error });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  // The viewer's identity is latched ONCE, at connect time: a stream opened
  // while signed out stays anonymous forever, and one opened while signed in
  // keeps receiving that user's private frames even after logout (logout only
  // clears the cookie — frames are never re-authenticated per event).
  // Deliberate: per-frame re-auth would cost a DB hit per broadcast, and
  // the loopback demo accepts the stale stream. The browser tears it down on
  // its own logout/reload anyway.
  //
  // `remote` is recorded because the admission rules above count by source:
  // without it on the client there would be no way to answer "how many streams
  // does this address already hold" without keeping a second map in step.
  const client = { res, userId: req.user ? req.user.id : null, remote };
  clients.add(client);
  req.on('close', () => clients.delete(client));
});

// Drop a stream: out of the fan-out and the socket closed.
function dropClient(c) {
  clients.delete(c);
  try {
    c.res.end();
  } catch {
    /* already gone */
  }
}

// Write one frame, dropping the client on failure OR backpressure. A write
// that returns false means the socket buffer is full — the consumer has
// stopped reading. For a broadcast fan-out the only choices are blocking
// every client on one laggard or dropping the laggard; drop the laggard
// (EventSource reconnects automatically).
function writeFrame(c, payload) {
  try {
    if (c.res.write(payload) === false) dropClient(c);
  } catch {
    dropClient(c);
  }
}

// Heartbeat: proxies and load balancers drop idle streams, and a quiet
// exchange can look dead to the browser's EventSource.
function startHeartbeat(ms = 15000) {
  const t = setInterval(() => {
    for (const c of clients) writeFrame(c, ': hb\n\n');
  }, ms);
  if (t.unref) t.unref();
  return t;
}

function closeStreams() {
  for (const c of clients) {
    try {
      c.res.end();
    } catch {
      /* already gone */
    }
  }
  clients.clear();
}

// userId === null → broadcast to everyone; otherwise private to that user.
function broadcast(event, data, userId = null) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (userId !== null && c.userId !== userId) continue;
    writeFrame(c, payload);
  }
}

// ── Auth ───────────────────────────────────────────────────────────────────
// Brute-force guard for the two credential routes (W3). In SQLite, not a Map.
// Counters are per key - the case-normalized username for login, the remote IP
// for login-by-source and for register - and count CONSECUTIVE FAILURES only:
// any success clears the key, so a legitimate user who occasionally mistypes a
// password is never locked out and successes can never accumulate toward a lock.
//
// At RL_MAX_FAILURES consecutive misses the key is locked for RL_LOCK_BASE_MS,
// doubling with each further failure and capped at RL_LOCK_MAX_MS. While
// locked, every attempt answers 429 WITHOUT touching scrypt, so a locked
// account is cheap to defend and expensive to keep guessing at.
//
// WHY THIS IS A TABLE AND NOT A MAP
// It was a module-level Map, with a comment that knew its own cost: "the map is
// process-local (a restart clears it)". A restart handed every locked-out
// attacker a fresh allowance of ten guesses on every account, indefinitely - so
// the effective rate was ten guesses per RESTART CYCLE rather than ten per
// escalating window. A control whose state lives in the process it is meant to
// survive is not a control, and process managers restart on crash, which is
// exactly when brute-force protection matters most.
//
// THE DECISION, stated: a restart now PRESERVES the lock, and the failure count
// with it, so the escalation continues where it left off.
//
// The case for clearing is real - a user locked out by their own typos gets a
// fresh start instead of waiting out a window. But they already get one: the
// lock expires on its own, in 30 seconds rising to at most fifteen minutes. A
// restart shortens that wait for whoever is guessing at the account and for
// nobody else. The costs are not symmetric. Preserving costs a legitimate user
// a wait they would have had to sit through anyway; clearing costs an account
// ten more guesses every time the process cycles, which is the entire reason
// the threshold exists. So it preserves.
//
// THE SWEEP IS A TIMER, not a read. The obvious design - sweep stale rows when
// a key is read - puts a DELETE on the path of every login, which is the one
// request class that already pays a key derivation. A boot pass plus an unref'd
// minute timer costs the same and never sits inside a request.
//
// ROWS ARE SWEPT BY AGE, NEVER BECAUSE THEY EXPIRED: `fails` is meant to keep
// counting after a window lapses, because that is what doubles the next one. The
// TTL is the LONGEST LOCK WINDOW, so a row the sweep deletes is one the limiter
// would have treated as unlocked anyway - and the escalation survives for every
// attacker still trying, which is the only attacker it exists for.
const RL_MAX_FAILURES = 10; // consecutive failures before lockout
const RL_LOCK_BASE_MS = 30 * 1000; // first lockout window
const RL_LOCK_MAX_MS = 15 * 60 * 1000; // cap: further doubling outlives interest

// Read, write and clear are the whole interface, and there is deliberately no
// in-memory cache in front of them: a cache would be a second source of truth
// about whether an account is locked, which is the bug this move exists to fix.
function rlRead(db, key) {
  return db.prepare('SELECT fails, locked_until FROM login_attempts WHERE key = ?').get(key) || null;
}

function rlLocked(db, key) {
  const a = rlRead(db, key);
  return !!a && a.locked_until > Date.now();
}

// A per-SOURCE key is a different kind of control from a per-USERNAME key and
// gets its own numbers.
//
// A username key defends one account from brute force: 10 failures, escalating.
// An IP key does NOT defend an account — it bounds how much CPU an UNAUTHENTICATED
// caller can make the process spend on scrypt. Setting it to the same threshold
// was wrong in a way the API suite caught immediately: 10 failures from one
// shared address locks out everyone behind it, so an office on a single NAT, or
// a phone behind a carrier NAT, is locked out entirely by one person's typos.
//
// So: a higher threshold and a shorter, non-escalating lock. Enough to stop the
// flood (measured: 110 of 120 attempts rejected, /api/sports median 1ms), while
// a shared address is not punished for ten ordinary typos.
const RL_IP_MAX_FAILURES = 30;
const RL_IP_LOCK_MS = 60 * 1000;

// The read-modify-write is inside a transaction so a SECOND process sharing the
// database cannot interleave: without it two processes recording a failure for
// one key could both read fails=9 and both write 10, losing a strike. SQLite is
// single-writer, so BEGIN IMMEDIATE is what serialises them, and the same
// property is what lets this table serve the multi-node case the in-memory Map
// could not have.
function rlRecordFailure(db, key) {
  const perIp = key.startsWith('login-ip:');
  const maxFails = perIp ? RL_IP_MAX_FAILURES : RL_MAX_FAILURES;
  const now = Date.now();
  transaction(db, () => {
    const a = rlRead(db, key) || { fails: 0, locked_until: 0 };
    const fails = a.fails + 1;
    const locked_until = fails >= maxFails
      ? (perIp
        ? now + RL_IP_LOCK_MS
        : now + Math.min(RL_LOCK_BASE_MS * 2 ** (fails - RL_MAX_FAILURES), RL_LOCK_MAX_MS))
      : a.locked_until;
    db.prepare(
      `INSERT INTO login_attempts (key, fails, locked_until, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until,
                                     updated_at = excluded.updated_at`
    ).run(key, fails, locked_until, now);
  });
}

function rlRecordSuccess(db, key) {
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
}

function rlRetryAfterSeconds(db, key) {
  const a = rlRead(db, key);
  return a ? Math.max(1, Math.ceil((a.locked_until - Date.now()) / 1000)) : 0;
}

// Boot pass, then a minute timer. Both unref'd, so neither keeps a test run or
// a shutting-down process alive on its own.
function sweepLoginAttempts() {
  try {
    db.prepare('DELETE FROM login_attempts WHERE updated_at <= ?').run(Date.now() - RL_LOCK_MAX_MS);
  } catch {
    /* DB closed during shutdown - nothing left to sweep */
  }
}
sweepLoginAttempts();
const loginAttemptSweeper = setInterval(sweepLoginAttempts, 60_000);
if (loginAttemptSweeper.unref) loginAttemptSweeper.unref();

// Test seam: clears the counters so a suite can isolate the limiter. Exported
// for tests ONLY - no production path calls this.
function resetLoginLimiter() {
  db.prepare('DELETE FROM login_attempts').run();
}

function rlTooManyAttempts(res, key) {
  return res
    .status(429)
    .setHeader('Retry-After', String(rlRetryAfterSeconds(db, key)))
    .json({ error: 'Too many failed attempts; try again later' });
}

// ── Request VOLUME limiting ────────────────────────────────────────────────
// The counter above limits CONSECUTIVE FAILURES, which is the right shape for
// guessing a password and the wrong shape for everything else. An attacker
// making only VALID requests — placing thousands of orders, hammering
// cash-out, walking the admin catalogue — never trips a failure counter.
//
// So a second, independent limiter counts requests in a sliding window.
// Deliberately SEPARATE from the failure counters rather than merged: a login
// failing ten times and a burst of successful reads are different problems with
// different remedies, and one counter serving both would let traffic of either
// kind clear the other's budget.
//
// COVERAGE, NOT JUST EXISTENCE. This bucket existed and was correctly
// enforced, and it was on ONE of the player read routes. Every route added
// after it inherited nothing: the limiter is an argument at the registration
// site, so a route without that argument is not throttled at all, and nothing
// failed when that happened. The cheap catalogue reads are now on it for the
// same reason as the expensive ones — an unauthenticated caller reaching
// /api/events gets a full board, with a book query per market, per request.
//
// EXEMPTIONS ARE DELIBERATE AND FEW:
//   /api/stream       a long-held connection, not a request; it has its own cap
//                     (MAX_SSE_CLIENTS) and is counted once per connect.
//   /api/branding     one row, no query worth bounding, and it is what a
//                     locked account's page load reads.
//   /healthz /readyz /metrics   supervisor probes. A rate-limited readiness
//                     probe is a venue that gets itself killed.
//   /api/feed/*       the odds-feed board, which is a different data source in
//                     a different mode; it answers 409 before doing any work
//                     when FEED_ENABLED is off, and its cost is a Postgres
//                     round trip the feed bucket does not govern.
const VOLUME_BUCKETS = {
  // Trading is the money path. Generous per user — a scalper legitimately
  // fires many orders — but bounded, because unbounded order placement is a
  // self-DoS on the single-threaded engine.
  // Limits come from config so an operator can tune them; 0 disables a bucket.
  //
  // auth is keyed on the SOURCE, like the failure counters above, and bounds
  // the two routes that pay a key derivation on every request. Registration was
  // the one that had nothing at all: the per-address register counter counts
  // FAILURES, so a flood of SUCCESSFUL registrations never tripped it, and each
  // success cost a full scrypt — so unauthenticated registration was the
  // cheapest CPU flood available. Login is bounded for the same reason: the
  // username counter is cleared by every success, so 200 valid sign-ins in a
  // minute from one address spent 200 derivations and recorded no failures.
  auth: { limit: config.RATE_LIMIT_AUTH, windowMs: 60_000 },
  trade: { limit: config.RATE_LIMIT_TRADE, windowMs: 60_000 },
  cashout: { limit: config.RATE_LIMIT_CASHOUT, windowMs: 60_000 },
  admin: { limit: config.RATE_LIMIT_ADMIN, windowMs: 60_000 },
  wallet: { limit: config.RATE_LIMIT_WALLET, windowMs: 60_000 },
  read: { limit: config.RATE_LIMIT_READ, windowMs: 60_000 },
};
const volumeHits = new Map(); // key -> number[] of timestamps

function volumeKey(req, bucket) {
  // Authenticated routes key on the USER, so one noisy client cannot exhaust
  // the budget of everyone behind the same NAT or proxy address.
  const who = req.user ? `u:${req.user.id}` : `ip:${req.socket.remoteAddress || 'unknown'}`;
  return `${bucket}:${who}`;
}

function volumeExceeded(req, bucket) {
  const cfg = VOLUME_BUCKETS[bucket];
  if (!cfg || cfg.limit <= 0) return 0; // 0 disables the bucket
  const key = volumeKey(req, bucket);
  const now = Date.now();
  const hits = (volumeHits.get(key) || []).filter((t) => now - t < cfg.windowMs);
  if (hits.length >= cfg.limit) {
    // Keep the pruned list so a blocked caller cannot grow memory unbounded.
    volumeHits.set(key, hits);
    return Math.ceil((cfg.windowMs - (now - hits[0])) / 1000);
  }
  hits.push(now);
  volumeHits.set(key, hits);
  return 0;
}

// Periodic sweep. Without it the map grows one entry per distinct
// user/IP/bucket forever — a slow leak driven by exactly the traffic this
// exists to defend against.
const volumeSweeper = setInterval(() => {
  const cutoff = Date.now() - Math.max(...Object.values(VOLUME_BUCKETS).map((b) => b.windowMs));
  for (const [k, hits] of volumeHits) {
    const kept = hits.filter((t) => t > cutoff);
    if (kept.length === 0) volumeHits.delete(k);
    else volumeHits.set(k, kept);
  }
}, 60_000);
if (volumeSweeper.unref) volumeSweeper.unref();

/** Rate-limit middleware factory: 429 with Retry-After once the budget is spent. */
/**
 * The current budget for a route's bucket: limit, remaining, seconds to reset.
 *
 * Returns null for a bucket that is disabled or absent, which is the caller's
 * signal to emit NO headers at all rather than a misleading `X-RateLimit-Limit: 0`.
 * A disabled limit is not a limit of zero — announcing it as one would tell a
 * pacing client to back off against a ceiling that does not exist.
 *
 * `remaining` excludes the request being served right now, so a client reading the
 * header after its own successful call sees what is genuinely left.
 */
function volumeBudget(req, bucket) {
  const cfg = VOLUME_BUCKETS[bucket];
  if (!cfg || cfg.limit <= 0) return null;
  const key = volumeKey(req, bucket);
  const now = Date.now();
  const hits = (volumeHits.get(key) || []).filter((t) => now - t < cfg.windowMs);
  const oldest = hits.length ? hits[0] : now;
  return {
    limit: cfg.limit,
    remaining: Math.max(0, cfg.limit - hits.length),
    resetSeconds: Math.max(0, Math.ceil((cfg.windowMs - (now - oldest)) / 1000)),
  };
}

function limit(bucket) {
  const middleware = (req, res, next) => {
    const retryAfter = volumeExceeded(req, bucket);
    // Budget headers on EVERY response through a limited route, not only on the
    // 429. A client that discovers the limit only by hitting it has no way to
    // back off before it does, and one that has to guess will eventually get it
    // wrong. Exposing `remaining` is what lets a strategy pace itself instead of
    // discovering the ceiling.
    const budget = volumeBudget(req, bucket);
    if (budget) {
      res.setHeader('X-RateLimit-Limit', String(budget.limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, budget.remaining)));
      res.setHeader('X-RateLimit-Reset', String(budget.resetSeconds));
    }
    if (retryAfter > 0) {
      res.setHeader('Retry-After', String(retryAfter));
      return apiError(res, 429, 'Too many requests', { code: 'rate_limited' }, {
        extra: { retry_after_seconds: retryAfter },
      });
    }
    next();
  };
  // The middleware is STAMPED with its bucket so the wiring can be asserted
  // from the live router rather than by scraping the source for the string
  // `limit(`. Coverage is the whole point of this control — the bug was a route
  // registered without the argument, which no test could see — so the bucket a
  // route was given has to be readable from the route itself.
  middleware.volumeBucket = bucket;
  return middleware;
}

function resetVolumeLimits() {
  volumeHits.clear();
}

// async because A.registerUser derives the password hash, and that derivation
// runs on libuv's threadpool rather than on this thread. Express 4 does not
// await a handler, so every error must be caught INSIDE and re-thrown onto the
// error handler explicitly — an async handler's rejection is an unhandled
// promise rejection, not a 500.
app.post('/api/auth/register', limit('auth'), async (req, res, next) => {
  const { username, password, email } = req.body || {};
  // Registration abuse is account-farming or identity enumeration from one
  // machine, so the counter keys on the caller's IP.
  const key = 'register:' + (req.socket.remoteAddress || 'unknown');
  if (rlLocked(db, key)) return rlTooManyAttempts(res, key);
  try {
    const user = await A.registerUser(db, { username, password, email });
    rlRecordSuccess(db, key);
    // Jurisdiction gate at session mint, not at bet placement. The country is
    // read ONLY from a proxy-overwritten header, and only when the operator has
    // asserted that is true — see lib/tenants.js trustedCountry().
    const token = A.createSession(db, user.id, { country: TEN.trustedCountry(req) });
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.status(201).json({ user });
  } catch (e) {
    // A refused registration (validation, duplicate username) is a failed
    // attempt; anything else (a server fault) is not.
    if (e && (e.status === 400 || e.status === 409)) rlRecordFailure(db, key);
    next(e);
  }
});

app.post('/api/auth/login', limit('auth'), async (req, res, next) => {
  // Case-normalized on purpose, and it now AGREES with the rest of the system
  // rather than disagreeing with it. It used to be the odd one out: usernames
  // were case-sensitive in the registry (so `admin` and `ADMIN` were two
  // accounts) while this key folded case (so they were one bucket) — and that
  // pairing is an unauthenticated denial of service, because an attacker
  // registers `ADMIN`, spends ten wrong passwords on it, and locks the
  // documented `admin` account out of its own venue.
  //
  // A username is now case-insensitive IDENTITY, enforced by a unique index on
  // users(username COLLATE NOCASE) and matched that way at registration and at
  // login, so there is no second account to hide behind and the folded key is
  // simply the name. It is still the right key to use: `AdMiN` and `admin`
  // cannot farm separate guessing windows for the one person they are.
  const key = 'login:' + String((req.body || {}).username || '').trim().toLowerCase();
  // AND a per-SOURCE counter. The username key alone was trivially bypassed by
  // an attacker who simply used a fresh username per request. That counter
  // exists because key derivation used to BLOCK the event loop — every attempt
  // froze the whole process, so 120 logins at concurrency 20 took /api/sports
  // from a 1.6ms median to 723ms (p95 1568ms), a ~460x amplification, with
  // orders, matching, settlement, SSE and the admin desk all stopping together.
  //
  // lib/auth.js now derives on libuv's threadpool, so a login no longer stalls
  // concurrent requests. The limiter is KEPT rather than retired: it is still
  // the thing that bounds how much CPU an unauthenticated caller can ask for,
  // and threadpool parallelism moved that cost rather than deleting it — four
  // concurrent guesses still occupy four pool slots. It is no longer the only
  // thing standing between the venue and that, though.
  const ipKey = 'login-ip:' + (req.socket.remoteAddress || 'unknown');
  if (rlLocked(db, ipKey)) return rlTooManyAttempts(res, ipKey);
  if (rlLocked(db, key)) return rlTooManyAttempts(res, key);
  try {
    const { user, token } = await A.loginUser(db, { ...(req.body || {}), country: TEN.trustedCountry(req) });
    rlRecordSuccess(db, key); // a success proves the real user — clear the slate
    rlRecordSuccess(db, ipKey);
    // Sign-in starts the RG session clock, and does NOT restart a session
    // already running: a player who refreshes the page must not get a fresh
    // session limit, which is the easiest way to defeat one.
    const rg = RG.startSession(db, user.id);
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.json({ user, rg });
  } catch (e) {
    if (e && e.status === 401) {
      rlRecordFailure(db, key); // only auth misses count
      rlRecordFailure(db, ipKey); // …and they count against the source too
    }
    // Async handler: hand the error to Express explicitly. A throw here would
    // reject the handler's promise and Express 4 would never see it.
    next(e);
  }
});

// Signing out ENDS the session: a player who has finished for the day should
// be able to come back tomorrow, and a session limit that only ever ratchets
// upward is not a session limit.
app.post('/api/auth/logout', (req, res) => {
  // End the RG session too, but only for a session this request actually owns:
  // the first-run lock allows logout for a locked account, and ending a
  // stranger's session clock on their behalf would be a control with a bypass.
  if (req.user) RG.endSession(db, req.user.id);
  A.destroySession(db, req.token);
  res.setHeader('Set-Cookie', 'ob_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, limit('read'), (req, res) => {
  // `tenant_status` is here because reads REMAIN AVAILABLE on a suspended
  // tenant (#32), and a player who is allowed to look at the book but refused
  // at the bet slip deserves to be told why without having to place an order to
  // find out. It is the only surface that reports it; the refusals carry it in
  // `details.code`.
  //
  // Both changes land on one line, which is why this was a real conflict and not
  // an automatic merge: #32 added the field, #6 added the rate-limit bucket, and
  // dropping either side silently reinstates the other's bug.
  const tenant = TEN.ofUser(db, req.user.id);
  res.json({
    user: {
      ...req.user,
      available_cents: req.user.balance_cents - req.user.frozen_cents,
      tenant_status: tenant ? tenant.status : null,
    },
  });
});

// ── Account self-service ───────────────────────────────────────────────────

// Changing a password revokes every OTHER session, so the response reports how
// many were invalidated — that count is the user's evidence that the action
// did what they think it did.
app.post('/api/auth/change-password', requireAuth, async (req, res, next) => {
  const { currentPassword, newPassword } = req.body || {};
  try {
    const r = await A.changePassword(db, {
      userId: req.user.id,
      currentPassword,
      newPassword,
      keepToken: req.token,
    });
  // Audited as an account-security event: when an operator later investigates
  // a compromised account, "the password was changed at 14:02 by its owner"
  // and "changed at 14:02 by someone else" are both load-bearing facts. The
  // actor is the account itself — no admin was involved.
  AUDIT.record(db, req.user, AUDIT.ACTIONS.USER_PASSWORD_CHANGED, `user:${req.user.id}`, null, {
    sessions_revoked: r.sessionsRevoked,
  });
  res.json({ ok: true, sessions_revoked: r.sessionsRevoked });
  } catch (e) {
    next(e); // async handler — Express 4 cannot see a rejected promise
  }
});

app.get('/api/auth/sessions', requireAuth, limit('read'), (req, res) => {
  res.json({ sessions: A.listSessions(db, req.user.id, req.token) });
});

app.delete('/api/auth/sessions/:id', requireAuth, (req, res) => {
  // revoking the session you are calling from logs you out here; that is a
  // legitimate "sign out this device" action, so it is not special-cased.
  A.revokeSession(db, req.user.id, req.params.id);
  AUDIT.record(db, req.user, AUDIT.ACTIONS.USER_SESSIONS_REVOKED, `user:${req.user.id}`, null, {
    session: req.params.id,
  });
  res.json({ ok: true });
});

// ── Board ──────────────────────────────────────────────────────────────────
/**
 * THE FIRST-RUN LOCK.
 *
 * A boot warning is a suggestion, and suggestions are what get ignored. This
 * makes the seeded credentials a hard block: an account still on a demo
 * password can sign in — it must, or there is no route to the panel that fixes
 * it — but every state-changing route is refused until it is replaced.
 *
 * Enforcement is in TWO places, both consulting the one SETUP_ALLOWLIST above,
 * so they cannot disagree about which routes a locked account may reach:
 *
 *   - inside requireAuth / requireAdmin (firstRunLockResponse). This is what
 *     actually covers authenticated routes, and it is placement-independent:
 *     a route added later cannot forget to be covered. Moving the check here
 *     is what closed /api/stream, which sits far above any app.use().
 *   - an app.use() below, which is what catches a route that reads req.user
 *     WITHOUT requireAuth. There is exactly one of those and it matters.
 */

function mustChangePassword(user) {
  // Reads the STORED FLAG, never re-verifies a scrypt hash: doing that per
  // request would put ~160ms on the hot path for every caller.
  return !!(user && user.must_change_password);
}

/**
 * Boot sweep: flag any account still on a seeded demo password.
 *
 * Runs once at boot rather than at seed time so an EXISTING deployment that was
 * already running demo credentials gets locked too. Idempotent, and it only
 * ever SETS the flag — an account whose password has been changed is never
 * re-flagged, so a boot cannot lock out a venue that has already sorted itself.
 */
async function enforceFirstRunLock() {
  let flagged = 0;
  for (const name of ['admin', 'demo']) {
    if (!(await isDefaultCredential(name))) continue;
    // COLLATE NOCASE, like every other identity lookup in the codebase. A
    // seeded account whose stored spelling is 'ADMIN' is still the seeded
    // account — the first-run lock has to reach it, and an exact match would
    // have flagged nothing.
    const r = db
      .prepare('UPDATE users SET must_change_password = 1 WHERE username = ? COLLATE NOCASE AND must_change_password = 0')
      .run(name);
    flagged += r.changes;
  }
  return flagged;
}

// The second enforcement point described above: it catches a route that reads
// req.user WITHOUT requireAuth, which is what /api/branding is.
//
// IT IS SCOPED TO /api, AND THAT SCOPE IS THE FIX FOR #33. This middleware
// used to be global, so it also answered GET /, GET /style.css and every other
// static asset with a JSON 403 — and the first-run lock's entire purpose is to
// be escapable through the UI. A locked account got a JSON error in the address
// bar where the page should have been, could not load the CSS that renders the
// change-password panel, and reasonably concluded the server was broken. The
// lock blocked the product rather than the trading.
//
// The scope costs nothing: requireAuth/requireAdmin — which cover every route
// that authenticates, placement-independently — never serve a static asset, and
// a static file carries no account state, so there is nothing here to lock.
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (isSetupRoute(req)) return next();
  if (!mustChangePassword(req.user)) return next();
  firstRunLockResponse(req, res);
});

app.get('/api/sports', limit('read'), (req, res) => {
  const sports = db
    .prepare(
      `SELECT s.id, s.name, s.slug,
         (SELECT COUNT(*) FROM events e WHERE e.sport_id = s.id AND e.status IN ('upcoming','live')) AS event_count
       FROM sports s ORDER BY s.sort, s.name`
    )
    .all();
  res.json({ sports });
});

// Feed-backed board: markets and prices come from the betfair-market-snapshots
// recorder's Postgres, so there is no matching book here — the ladder IS the
// observed exchange. Shape matches /api/events so the frontend is unchanged.
app.get('/api/feed/board', aw(async (req, res) => {
  if (!config.FEED_ENABLED) return apiError(res, 409, 'Feed is disabled (set FEED_ENABLED=true)');
  try {
    const markets = await FEED.fetchBoard({ limit: clampFeedLimit(req.query.limit, config.FEED_MARKET_LIMIT) });
    res.json({ markets });
  } catch (e) {
    // A feed outage must not look like a 500 from the exchange itself.
    console.error('[feed] board read failed:', e.message);
    apiError(res, 503, 'Odds feed unavailable', { code: 'feed_unavailable' });
  }
}));

// Board limit clamp: a 0/negative limit would answer an empty board; a huge
// one is unbounded work for the recorder query. Clamp to [1, 500]; junk
// (non-numeric) falls back to the configured default rather than guessing.
// Exported so the clamping behaviour is unit-testable without a live feed.
function clampFeedLimit(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

/**
 * The one line an operator reads about the odds feed at BOOT, as a PURE
 * function of what FEED.health() returned.
 *
 * Extracted (like clampFeedLimit) because the bug it replaces cannot be reached
 * from the suite at all: the line was built inside a `.then()` on a live Postgres
 * probe, so it only ever appeared by booting a server with FEED_ENABLED=true
 * against a real database. Two independent reads were wrong —
 *
 *   h.age_seconds   health() returns `odds_age_seconds`. Both were `undefined`,
 *                   so the ternary ALWAYS took the "unknown" branch, on a feed
 *                   the server had just queried successfully.
 *   h.stale         health() returns no such field, so "(STALE)" was dead text.
 *
 * — and the branch that mattered most never ran at all. `healthPayload` sets
 * `ok: !!newest && age < FEED_STALE_SECONDS` and sets NO `error` field, so a
 * STALE feed arrived as `{ok:false}` with `h.error === undefined` and the line
 * printed `[feed] unreachable: undefined`: the one condition the line exists to
 * report, reported as an unreachable feed with no reason attached.
 *
 * ── AND THE TWIN WAS MISSED, WHICH IS WHY THIS IS NOW A RENDERER ──────────
 * The correction above was applied HERE and nowhere else. `GET /api/feed/health`,
 * further down this same file, still read `h.error || h.detail` — fields
 * healthPayload never sets, so it logged `(no detail)` on every stale feed — and
 * still answered a fixed `503 {ok:false, error:'Odds feed unavailable'}` for a
 * stale feed and an unreachable one alike. Two readers of one payload, one rule
 * each, and they disagreed; the fix had a test here and nothing over there, so
 * nothing failed.
 *
 * So the rule now lives ONCE in `lib/feed.js` (`classifyHealth`, next to the
 * payload it reads) and this function only chooses words. A second copy of the
 * discriminator is what let the twin drift in the first place, and re-introducing
 * one would re-open the defect. Every verdict below is read from `c`, which
 * `tests/feedboot-line.test.js` also drives into the real HTTP route, so the two
 * sites are pinned against each other rather than merely next to each other.
 */
function feedBootStatus(h, staleSeconds) {
  const c = FEED.classifyHealth(h, staleSeconds);
  if (c.kind === 'no_payload') return { level: 'error', message: c.reason };
  if (c.kind === 'unreachable') return { level: 'error', message: c.reason };
  // Feed 1 has no odds columns at all, so there is no frame to age and nothing
  // that can go stale. "newest frame unknown" there is a warning about a number
  // this deployment was never going to publish.
  if (c.kind === 'unpriced') {
    return {
      level: 'log',
      message: `odds feed connected — feed ${c.feed}: ${h.markets || 0} fixtures, no prices on this feed`,
    };
  }
  return {
    level: c.stale ? 'warn' : 'log',
    message: `odds feed connected — ${h.markets || 0} markets, ${c.frame}${c.stale ? ' (STALE)' : ''}`,
  };
}

// One market's ladder, by id. This is what the page prices when you pick a race
// from the tree.
//
// The board above is a capped, recency-sorted list — the catalogue is 1400+
// markets, so it cannot be the source for an arbitrary selection. Answering
// from it anyway made a pick outside the cap render a DIFFERENT market's
// prices, which is worse than an honest empty state.
//
// An id that resolves to nothing open answers 200 with `market: null`. That is
// not a client error: the feed rotates markets away constantly, so "the race
// you picked has closed" is an ordinary outcome the page renders as such, and
// only a missing `id` parameter is a 400.
app.get('/api/feed/market', aw(async (req, res) => {
  if (!config.FEED_ENABLED) return apiError(res, 409, 'Feed is disabled (set FEED_ENABLED=true)');
  const id = req.query.id;
  if (!id || !String(id).trim()) {
    return apiError(res, 400, 'id is required');
  }
  try {
    const market = await FEED.fetchMarket(id);
    res.json({ market: market || null });
  } catch (e) {
    console.error('[feed] market read failed:', e.message);
    apiError(res, 503, 'Odds feed unavailable', { code: 'feed_unavailable' });
  }
}));

// Always 200, including when the feed is off: the browser probes this at boot to
// decide which board to render, and a 409 there logs a console error on every
// non-feed deployment (the browser suite fails a run on any console error).
app.get('/api/feed/nav', aw(async (req, res) => {
  if (!config.FEED_ENABLED) return res.json({ enabled: false, sports: [] });
  try {
    res.json({ enabled: true, sports: await FEED.fetchNav() });
  } catch (e) {
    console.error('[feed] nav read failed:', e.message);
    apiError(res, 503, 'Odds feed unavailable', { code: 'feed_unavailable' });
  }
}));

/**
 * The ONE 503 body for a feed that cannot be served, shaped from the shared
 * classifier.
 *
 * Both failure paths run through here, which is the point. `health()` catches its
 * own driver errors and answers `{ok:false, error}`, so the route's `catch` is the
 * defensive branch — but "the probe threw" and "the probe answered not-ok" are the
 * same event to a client, and two bodies is how they would drift apart.
 *
 * What changed, and what it cost an operator (#85): this used to send one fixed
 * `{ok:false, error:'Odds feed unavailable'}` for a STALE feed as well, so a
 * collector that had quietly stopped polling was indistinguishable from a
 * database that was down — and the log line beside it read `h.error || h.detail`,
 * fields `healthPayload` never sets, so it printed `(no detail)` on every stale
 * feed and never once named the condition. `odds_age_seconds` was computed,
 * published on the healthy path, and thrown away here, on the only path that
 * needs it.
 *
 * So the stale answer now carries the number that separates the two cases and the
 * window it exceeded, under its own `code`. Nothing internal is added: every extra
 * field is either a feed-derived number the `200` already publishes or the
 * configured window that already governs that `200`'s `ok`, and `apiError` still
 * strips `details` from a 5xx.
 */
function feedHealthFailure(res, c) {
  if (c.kind === 'stale') {
    return apiError(res, 503, 'Odds feed stale', { code: 'feed_stale' }, {
      extra: {
        ok: false,
        // The diagnostic that was discarded, and the line it was judged against —
        // "5000" alone does not tell a client whether that is stale.
        odds_age_seconds: c.age,
        stale_after_seconds: c.threshold,
        // Which feed answered, and whether it has odds columns at all: a feed
        // reporting zero ages on a feed with no prices is a different problem.
        feed: c.feed,
        priced: c.priced,
      },
    });
  }
  // Unreachable, or a probe that never answered. `odds_age_seconds: null` rather
  // than absent: no age was measured, and a client reading the field should find
  // the same "nothing measured" answer here as the null a Delay key publishes for
  // `data_age_seconds`, rather than having to tell absent from zero.
  return apiError(res, 503, 'Odds feed unavailable', { code: 'feed_unavailable' }, {
    extra: { ok: false, odds_age_seconds: null },
  });
}

// Feed liveness. The client-facing error is genericized at this boundary:
// a driver failure can embed host/user detail in its message (pg errors do),
// so the detail goes to the server log and the client gets a status that is
// uninformative but true. Resilient to whatever health() returns OR throws —
// including a future detail field with driver messages in it.
//
// The verdict itself is NOT taken here: `classifyHealth` in lib/feed.js decides
// stale-vs-unreachable from the same rule the boot line reads, so the two readers
// of this payload cannot drift (see `feedBootStatus` for how the last time they
// did). What a stale feed publishes is a feed-derived age and the configured
// window, not internals.
app.get('/api/feed/health', aw(async (req, res) => {
  if (!config.FEED_ENABLED) return apiError(res, 409, 'Feed is disabled');
  let h;
  try {
    h = await FEED.health();
  } catch (e) {
    console.error('[feed] health check failed:', e.message);
    // Classified as "never asked", which is what a throw before an answer means.
    return feedHealthFailure(res, FEED.classifyHealth(null, config.FEED_STALE_SECONDS));
  }
  const c = FEED.classifyHealth(h, config.FEED_STALE_SECONDS);
  if (c.ok) return res.json(h);
  // `c.reason` is the diagnosis, from the same classifier that produced the
  // verdict — not `(h.error || h.detail)`, which was undefined on every stale
  // feed and printed `(no detail)` where the operator needed the condition named.
  console.error('[feed] health check reported failure:', c.reason);
  return feedHealthFailure(res, c);
}));

// ── Feed collector: operator surface ──────────────────────────────────────
// Credentials and process supervision. Deliberately SEPARATE from the read-only
// board routes above: those are public, these are admin-only and they touch the
// single most sensitive thing this system stores.
//
// There is no route here that returns a stored credential, and that is a
// property of the design rather than an omission — lib/feedcreds exposes no
// function that serves plaintext to an HTTP caller.

/**
 * Which tenant a feed route is acting on: THE REQUESTER'S OWN, ALWAYS.
 *
 * This used to read `req.params.id`, then `req.body.tenant_id`, then
 * `req.query.tenant_id`, falling back to the caller's own tenant only when none
 * was supplied. requireAdmin checks `role === 'admin'` and nothing else, so ANY
 * admin could name ANY tenant and overwrite, delete, enumerate or stop that
 * tenant's Betfair credentials and collector. No plaintext secret is reachable
 * (status() returns only `*_set` booleans), so this was a write / DoS /
 * cross-tenant-disclosure boundary failure rather than credential exfiltration
 * — a distinction worth keeping when triaging.
 *
 * A tenant named in the request is now REFUSED rather than obeyed or ignored.
 * Obeyed is the bug. Ignored is nearly as bad: the operator asks about tenant
 * 99999, gets 200 describing a different tenant, and cannot tell from the
 * response which one was affected. Refusing is the only honest third option,
 * and it cannot break a real caller, because a real caller names its OWN tenant
 * — which resolves and matches.
 *
 * lib/feedcreds enforces the same rule at the source, which is where it
 * belongs: an optional tenant scope is a scope someone will eventually forget
 * to pass, and a forgotten scope on an admin route is a cross-tenant read. The
 * runner routes have no actor of their own, so they are checked here.
 */
function feedTenantId(req) {
  const own = TEN.ofUser(db, req.user.id)?.id ?? TEN.defaultTenant(db).id;
  const asked = req.params.id || req.body?.tenant_id || req.query.tenant_id;
  if (asked === undefined || asked === '') return own;
  const wanted = Number(asked);
  if (!TEN.byId(db, wanted)) throw A.httpError(404, `No such tenant: ${asked}`);
  if (wanted !== own) {
    throw A.httpError(403, 'Feed credentials and supervision are scoped to your own tenant');
  }
  return own;
}

// Status: WHICH credentials exist, never their values.
//
// ONE shape, for the caller's own tenant. This used to be a LIST of every
// tenant's feed configuration — `configured`, `login_mode`, created/updated
// timestamps for each venue in the database — behind an `admin` role that
// carries no venue-wide meaning. That is the disclosure half of the issue: on a
// per-tenant admin surface, a venue-wide inventory tells one operator that
// other venues exist, when they are configured, and when they were last
// touched. The list route stays (it is a documented endpoint) and answers about
// the caller's own tenant only.
app.get('/api/admin/feed/credentials', requireAdmin, limit('admin'), (req, res) => {
  res.json({ tenants: [FCREDS.status(db, feedTenantId(req))] });
});

app.get('/api/admin/feed/credentials/:id', requireAdmin, limit('admin'), (req, res) => {
  res.json(FCREDS.status(db, feedTenantId(req)));
});

// Store. Exactly three fields, because the collector needs exactly three:
// Betfair's Delay key authenticates with a username and password, and there is
// no certificate on it. Offering a cert upload would imply support that a Delay
// key cannot use.
//
// THE `:id?` THIS ROUTE USED TO HAVE IS GONE, and it is registered twice
// instead — once with `:id` and once without.
//
// WHY, MECHANICALLY: Express 5 compiles routes with path-to-regexp v8, which
// REMOVED optional parameters. `'/api/admin/feed/credentials/:id?'` does not
// merely fail to match, it THROWS at registration:
//
//   TypeError: Unexpected ? at index 31: /api/admin/feed/credentials/:id?
//
// and these are TOP-LEVEL registrations, so the throw happens while server.js is
// being required. The venue did not lose three admin routes; it did not start.
//
// WHY REGISTERING TWICE AND NOT SIMPLY DELETING THE `:id?` FORMS: the optional
// form was a DOCUMENTED endpoint (docs/API.md) and a client may already call
// it. Dropping it would turn a dependency bump into an API break. The `:id`
// form is kept alongside it, so both spellings reach the same handler.
//
// The `?` was decorative in any case: NOTHING in any of the three handlers read
// `req.params.id`. The tenant always came from `feedTenantId(req)`, which is the
// caller's own tenant and refuses a tenant id that is not it. So the two
// registrations are the same handler with the same behaviour, and the pair
// differs only in whether an id is validated as a tenant reference first.
function putFeedCredentials(req, res) {
  const b = req.body || {};
  const result = FCREDS.setCredentials(db, {
    actor: req.user,
    tenantId: feedTenantId(req),
    appKey: b.app_key,
    username: b.username,
    password: b.password,
  });
  // A credential change only takes effect on the next launch, so restart a
  // supervised collector rather than leaving it running on the old one — the
  // single most confusing possible outcome otherwise ("I saved it and nothing
  // changed"). Never restarted without supervision.
  //
  // FRUN.restart(), NOT stop() followed by start(). kill('SIGTERM') is
  // ASYNCHRONOUS, so the old sequence found `state.child` still set one line
  // later, bailed at the already_running guard, and spawned nothing — and then
  // the old child's exit saw stopping===true and returned instead of
  // rescheduling. Net effect: saving rotated credentials PERMANENTLY STOPPED
  // the venue's odds feed, with no error, no log line, and a response claiming
  // a successful restart. See lib/feedrunner.js restart().
  //
  // The response now says which of the two things happened. `collector_
  // restarted` is true only when a new child is already up;
  // `collector_restart_pending` is true when the old process is still
  // terminating and the launch follows on its exit.
  let collector = { restarted: false, pending: false };
  if (FRUN.health(result.tenant_id).running) {
    collector = FRUN.restart(result.tenant_id, { actor: req.user });
  }
  res.json({
    ...result,
    collector_restarted: !!collector.restarted,
    collector_restart_pending: !!collector.pending,
  });
}

app.put('/api/admin/feed/credentials', requireAdmin, limit('admin'), putFeedCredentials);
app.put('/api/admin/feed/credentials/:id', requireAdmin, limit('admin'), putFeedCredentials);

// Same pair, same reason, for the delete.
function deleteFeedCredentials(req, res) {
  const tenantId = feedTenantId(req);
  const result = FCREDS.clearCredentials(db, { actor: req.user, tenantId });
  // A collector holding credentials that no longer exist should stop, not keep
  // polling with them. Stopping is the safe direction: it cannot spend weight.
  let stopped = false;
  if (FRUN.health(tenantId).running) {
    FRUN.stop(tenantId);
    stopped = true;
  }
  res.json({ ...result, collector_stopped: stopped });
}

app.delete('/api/admin/feed/credentials', requireAdmin, limit('admin'), deleteFeedCredentials);
app.delete('/api/admin/feed/credentials/:id', requireAdmin, limit('admin'), deleteFeedCredentials);

// Supervision. The readiness reason comes back verbatim rather than as a bool,
// because "the runner will not start" is useless to an operator who is not told
// which of four conditions is missing.
function getFeedRunner(req, res) {
  res.json(FRUN.health(feedTenantId(req)));
}

// And again for the runner status, which was the third `:id?`.
//
// THE ORDERING IS NOT COSMETIC. `GET /api/admin/feed/runner/start` and
// `/stop` are POST, so a GET `/runner/start` can never reach this pair — but
// the no-id form is registered FIRST, and if a future sibling route is added
// under `/runner/` as a GET it would be shadowed by this handler rather than
// reaching its own. Registering the parameterised form first costs nothing and
// leaves the shorter path as the fallback, which is the safe direction for a
// prefix this short.
app.get('/api/admin/feed/runner/:id', requireAdmin, limit('admin'), getFeedRunner);
app.get('/api/admin/feed/runner', requireAdmin, limit('admin'), getFeedRunner);

app.post('/api/admin/feed/runner/start', requireAdmin, limit('admin'), (req, res) => {
  const result = FRUN.start(feedTenantId(req), { actor: req.user });
  // A refusal is a 409 with the reason, not a 200 with started:false that a UI
  // renders as success.
  // `result` carries `reason` and `started`, both part of the response, so it
  // goes in `extra` rather than being dropped. The spread used to follow `error`
  // in the literal, which meant it could silently OVERRIDE the message if
  // `result` ever grew an `error` key — now `error` and `code` are set first and
  // nothing can displace them.
  if (!result.started) return apiError(res, 409, result.reason, null, { extra: result });
  res.json(result);
});

app.post('/api/admin/feed/runner/stop', requireAdmin, limit('admin'), (req, res) => {
  res.json(FRUN.stop(feedTenantId(req)));
});

app.get('/api/events', limit('read'), (req, res) => {
  const sportSlug = req.query.sport;
  let rows;
  if (sportSlug) {
    const sport = db.prepare('SELECT id FROM sports WHERE slug = ?').get(sportSlug);
    if (!sport) return apiError(res, 404, 'Unknown sport');
    rows = db
      .prepare(
        `SELECT e.*, c.name AS competition_name, s.name AS sport_name
         FROM events e
         LEFT JOIN competitions c ON c.id = e.competition_id
         JOIN sports s ON s.id = e.sport_id
         WHERE e.sport_id = ? AND e.status IN ('upcoming','live')
         ORDER BY e.starts_at`
      )
      .all(sport.id);
  } else {
    rows = db
      .prepare(
        `SELECT e.*, c.name AS competition_name, s.name AS sport_name
         FROM events e
         LEFT JOIN competitions c ON c.id = e.competition_id
         JOIN sports s ON s.id = e.sport_id
         WHERE e.status IN ('upcoming','live')
         ORDER BY e.starts_at`
      )
      .all();
  }
  const events = rows.map((e) => {
    const markets = db
      .prepare("SELECT id, name, status, total_matched_cents FROM markets WHERE event_id = ? AND status IN ('open','suspended') ORDER BY id")
      .all(e.id);
    return {
      id: e.id,
      name: e.name,
      sport: e.sport_name,
      competition: e.competition_name,
      starts_at: e.starts_at,
      status: e.status,
      markets: markets.map((m) => ({
        id: m.id,
        name: m.name,
        status: m.status,
        total_matched_cents: m.total_matched_cents,
        selections: M.bookFor(db, m.id, 3),
      })),
    };
  });
  res.json({ events });
});

app.get('/api/markets/:id/book', limit('read'), (req, res) => {
  const m = db.prepare('SELECT * FROM markets WHERE id = ?').get(intId(req.params.id));
  if (!m) return apiError(res, 404, 'Market not found');
  res.json({ market: m, book: M.bookFor(db, m.id, 5) });
});

// Price formats for the trading desk: the same pure functions the engine uses,
// so the UI never has to re-implement (or drift from) the conversion maths.
app.get('/api/format/:price', limit('read'), (req, res) => {
  const raw = Number(req.params.price);
  if (!Number.isFinite(raw)) return apiError(res, 400, 'Price must be a number');
  // THE RANGE IS CHECKED BEFORE THE SNAP, which is what makes the documented 400
  // reachable at all.
  //
  // It used to be checked after, against the snapped value — and
  // `snapToTick` CLAMPS to [1.01, 1000] and then returns a tick, by
  // construction. So `validTick(snapped)` is always true and that branch was
  // dead code: `GET /api/format/5000` answered `200 {decimal: 1000}` and
  // `GET /api/format/-5` answered `200 {decimal: 1.01}`. A caller checking a
  // price was told a *different* price was fine, which for a validation
  // endpoint is the worst kind of wrong answer.
  //
  // Range only, NOT tick. An off-tick price inside the range — 2.75 — is still
  // snapped, because that is what the desk's fair-price helper is for: a trader
  // types a near-miss and is shown what the engine would make of it (the desk
  // renders "snaps to 2.76"). docs/EXCHANGE_RULES.md makes the same promise for
  // the trading path, where `POST /api/orders` documents the clamp. What is
  // refused here is a number that is not a price at all.
  if (!ODDS.inLadderRange(raw)) return apiError(res, 400, 'Price is outside the 1.01-1000 ladder');
  const p = ODDS.snapToTick(raw);
  res.json({
    decimal: p,
    american: ODDS.toAmerican(p),
    fractional: ODDS.toFractional(p),
    implied_prob: ODDS.impliedProb(p),
  });
});

// ── Trading ────────────────────────────────────────────────────────────────
app.post('/api/orders', requireAuth, limit('trade'), (req, res) => {
  const { selection_id, side, price, stake_cents, client_order_id } = req.body || {};
  const result = M.placeOrder(db, req.user, { selection_id, side, price, stake_cents, client_order_id });
  // A replay created nothing, so it must not broadcast as though it did —
  // otherwise a retried request makes every other client's board flicker for a
  // state change that did not happen.
  if (!result.idempotent_replay) {
    broadcast('book', { market_id: result.order.market_id });
    broadcast('orders', {}, req.user.id);
    broadcast('balance', {}, req.user.id);
  }
  // 200 rather than 201 on a replay: the resource already existed. A client
  // retrying after a timeout can tell "I created this" from "this was already
  // mine" without inspecting the body.
  res.status(result.idempotent_replay ? 200 : 201).json(result);
});

app.get('/api/orders', requireAuth, limit('read'), (req, res) => {
  res.json({ orders: M.openOrdersFor(db, req.user.id) });
});

app.post('/api/orders/:id/cancel', requireAuth, limit('trade'), (req, res) => {
  const order = M.cancelOrder(db, req.user, intId(req.params.id));
  broadcast('book', { market_id: order.market_id });
  broadcast('orders', {}, req.user.id);
  broadcast('balance', {}, req.user.id);
  res.json({ order });
});

app.get('/api/positions', requireAuth, limit('read'), (req, res) => {
  const positions = M.positionsFor(db, req.user.id).map((p) => ({
    ...p,
    cashout: CASH.cashoutQuote(db, req.user, p.market_id),
  }));
  res.json({ positions });
});

app.post('/api/markets/:id/cashout', requireAuth, limit('cashout'), (req, res) => {
  const mid = intId(req.params.id);
  const result = CASH.cashoutMarket(db, req.user, mid);
  broadcast('book', { market_id: mid });
  broadcast('orders', {}, req.user.id);
  broadcast('balance', {}, req.user.id);
  res.json(result);
});

// ── Wallet ─────────────────────────────────────────────────────────────────
app.get('/api/wallet', requireAuth, limit('read'), (req, res) => {
  res.json(L.walletView(db, req.user.id));
});

app.get('/api/settlements', requireAuth, limit('read'), (req, res) => {
  res.json({ settlements: SET.settledFor(db, req.user.id) });
});

app.post('/api/wallet/deposit', requireAuth, limit('wallet'), (req, res) => {
  const amount = req.body ? req.body.amount_cents : undefined;
  // Self-exclusion gates FUNDING as well as trading. It was enforced on
  // /api/orders and /api/markets/:id/cashout but not here or on
  // /api/wallet/deposit-intent, so an excluded account could still fund itself
  // through the faucet — which in a real deployment is the PSP path — and the
  // per-call FAUCET_MAX_CENTS cap is trivially looped.
  //
  // WITHDRAWAL IS DELIBERATELY NOT GATED. Refusing to let someone take their own
  // money out is a far worse failure than the gap above, and self-exclusion is a
  // promise about PLAY, not about custody.
  LIMITS.assertTradeable(db, req.user);
  // The RG deposit limit is checked on BOTH deposit paths, so it cannot be
  // side-stepped by using the payment intent instead of the faucet.
  RG.assertDeposit(db, req.user.id, Number(amount));
  const result = L.deposit(db, req.user.id, amount, config.FAUCET_MAX_CENTS);
  broadcast('balance', {}, req.user.id);
  res.json(result);
});

// ── Responsible gambling ───────────────────────────────────────────────────
// The ENGINE decides whether a check is due (lib/rg.js); this is the
// acknowledgement, which is the only thing that resets its clock. A check the
// player can skip by not clicking is not a check.
app.post('/api/auth/reality-check', requireAuth, limit('wallet'), (req, res) => {
  res.json(RG.acknowledgeRealityCheck(db, req.user.id));
});

app.get('/api/auth/rg', requireAuth, limit('read'), (req, res) => {
  res.json(RG.status(db, req.user.id));
});

// ── Admin (trading desk) ───────────────────────────────────────────────────
function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ── Admin: accounts ────────────────────────────────────────────────────────
// Every route here is audited inside lib/admin.js, in the same transaction as
// the mutation it describes — so an audit row can never exist for a change
// that was rolled back.
//
// The desk's other audited mutators, in lib/tenants.js (commission rate, tenant
// status) and lib/risk.js (the kill switch), are now held to the same rule.
// They were the two exceptions, and the comment above did not mark them (#27).

app.get('/api/admin/users', requireAdmin, limit('admin'), (req, res) => {
  res.json(
    ADM.listUsers(db, {
      q: req.query.q,
      role: req.query.role,
      status: req.query.status,
      // Scoped to the caller's own tenant unless they are a venue-level
      // operator acting on another tenant explicitly.
      tenantId: req.query.tenant_id ? Number(req.query.tenant_id) : null,
      limit: req.query.limit,
      offset: req.query.offset,
    })
  );
});

app.get('/api/admin/users/:id', requireAdmin, limit('admin'), (req, res) => {
  res.json({ user: ADM.userDetail(db, Number(req.params.id)) });
});

app.patch('/api/admin/users/:id', requireAdmin, limit('admin'), (req, res) => {
  const { status, role, reason } = req.body || {};
  const id = Number(req.params.id);
  // Status and role are applied in one request but as two audited actions:
  // they are separate decisions with separate reasons, and collapsing them
  // would lose which half the operator actually intended.
  //
  // ONE REQUEST IS ONE UNIT OF WORK, though. lib/admin.js opens its own
  // transaction() in each of setStatus and setRole, so calling them in
  // sequence gave two commits: setRole could 400 AFTER setStatus had already
  // committed a suspension, cancelled that account's resting orders and
  // deleted its live sessions. The operator saw a 400, re-submitted, and met
  // "Account is already suspended" — with orders cancelled and sessions gone
  // as a side effect of a request that reported failure.
  //
  // lib/tx.js nesting is safe (a nested call becomes a SAVEPOINT), so
  // wrapping the handler in one transaction() makes the pair all-or-nothing
  // without touching lib/admin.js at all.
  const { transaction } = require('./lib/tx');
  try {
    const applied = transaction(db, () => {
      const out = {};
      if (status !== undefined) out.status = ADM.setStatus(db, { actor: req.user, userId: id, status, reason });
      if (role !== undefined) out.role = ADM.setRole(db, { actor: req.user, userId: id, role, reason });
      if (!Object.keys(out).length) {
        throw A.httpError(400, 'Provide status or role');
      }
      return out;
    });
    res.json({ ok: true, ...applied });
  } catch (e) {
    // Re-thrown rather than handled: the transaction has already ROLLED BACK,
    // so the operator gets the real status — and neither the cancellation of
    // the account's orders nor the deletion of its sessions survives.
    throw e;
  }
});

app.post('/api/admin/users/:id/balance', requireAdmin, limit('admin'), (req, res) => {
  const { delta_cents, reason } = req.body || {};
  res.json(
    ADM.adjustBalance(db, {
      actor: req.user,
      userId: Number(req.params.id),
      deltaCents: Number(delta_cents),
      reason,
    })
  );
});

app.get('/api/admin/audit', requireAdmin, limit('admin'), (req, res) => {
  res.json({
    entries: AUDIT.list(db, {
      limit: req.query.limit,
      target: req.query.target,
      action: req.query.action,
      actorId: req.query.actor_id ? Number(req.query.actor_id) : undefined,
    }),
  });
});

// ── Admin: abuse limits + self-exclusion ───────────────────────────────────

app.get('/api/admin/users/:id/limits', requireAdmin, limit('admin'), (req, res) => {
  res.json({ limits: LIMITS.getLimits(db, Number(req.params.id)) });
});

app.put('/api/admin/users/:id/limits', requireAdmin, limit('admin'), (req, res) => {
  const { scope, max_open_stake_cents, max_market_liability_cents, max_daily_settled_cents } = req.body || {};
  res.json(
    LIMITS.setLimits(db, {
      actor: req.user,
      userId: Number(req.params.id),
      scope: scope === undefined ? LIMITS.GLOBAL_SCOPE : scope,
      // A key that is ABSENT leaves that axis untouched; a key present with a
      // null CLEARS the cap. Distinguishing the two matters: omitting
      // max_daily_settled_cents while tightening a stake limit must not
      // silently hand the account an unlimited daily cap.
      ...(max_open_stake_cents === undefined ? {} : { max_open_stake_cents }),
      ...(max_market_liability_cents === undefined ? {} : { max_market_liability_cents }),
      ...(max_daily_settled_cents === undefined ? {} : { max_daily_settled_cents }),
    })
  );
});

// Self-exclusion is an operator-recorded ABSOLUTE action. There is no
// unexclude route on purpose: reinstatement is a separate audited decision,
// and shipping DELETE next to PUT invites the "just clear the flag" shortcut
// that makes exclusion meaningless.
app.post('/api/admin/users/:id/exclude', requireAdmin, limit('admin'), (req, res) => {
  const { until, reason } = req.body || {};
  res.json(LIMITS.exclude(db, { actor: req.user, userId: Number(req.params.id), until: until ?? null, reason }));
});

// ── Admin: market-maker risk desk ─────────────────────────────────────────
// A venue that cannot see its own market-maker loss is a venue that
// discovers it by going bankrupt. The kill switch stops NEW quotes; it does
// not cancel resting ones, so withdraw is a separate explicit action.
app.get('/api/admin/risk', requireAdmin, limit('admin'), (req, res) => {
  res.json({ kill_switch: RISK.killSwitch(db), bots: RISK.desk(db, bots.riskDefaults()) });
});

// BOTH of these prompt for a reason in the UI, and both now keep it.
//
// The kill-switch route used to read only `on`, and the withdraw route used to
// discard the request body entirely — so a justification was collected in the
// browser, sent over the wire, and thrown away by the server, while the prompt
// told the operator it was "recorded in the audit log". The kill switch is the
// most consequential write the venue offers (every bot stops quoting on the
// next pass) and the withdraw is a venue-wide liquidity event; neither left a
// recorded reason, and lib/bots.js had no audit call at all.
app.put('/api/admin/risk/kill-switch', requireAdmin, limit('admin'), (req, res) => {
  const b = req.body || {};
  res.json(RISK.setKillSwitch(db, { actor: req.user, on: !!b.on, reason: b.reason }));
});

app.post('/api/admin/risk/withdraw', requireAdmin, limit('admin'), (req, res) => {
  const { reason } = req.body || {};
  res.json(bots.withdrawAll(db, { actor: req.user, reason }));
});

// No `wrap` indirection: it was invoked exactly once, immediately, and existed
// only to obscure the error handling. The blanket `if (!e.status) e.status =
// 400` inside it stamped a CLIENT error onto anything thrown — a SQLITE_BUSY
// during a restore, a constraint violation, a TypeError — and errorHandler only
// logs at status >= 500, so a genuine fault produced a 400 to the operator AND
// no log line at all. That contradicts the rule this same file enforces a few
// hundred lines down ("Only schema constraints get a fabricated message;
// anything else is a real fault and MUST surface as a 5xx").
//
// lib/risk.js now says 400 at the source for the errors that really are the
// operator's input, so everything else can be forwarded as-is and keep its own
// classification.
app.put('/api/admin/risk/bots/:id', requireAdmin, limit('admin'), (req, res, next) => {
  const b = req.body || {};
  try {
    res.json(
      RISK.configure(db, {
        actor: req.user,
        botId: Number(req.params.id),
        ...(b.max_liability_cents === undefined ? {} : { max_liability_cents: Number(b.max_liability_cents) }),
        ...(b.max_daily_loss_cents === undefined ? {} : { max_daily_loss_cents: Number(b.max_daily_loss_cents) }),
        ...(b.quote_skew === undefined ? {} : { quote_skew: Number(b.quote_skew) }),
        ...(b.enabled === undefined ? {} : { enabled: !!b.enabled }),
      })
    );
  } catch (e) {
    next(e);
  }
});

// ── Payments (Phase 3) ──────────────────────────────────────────────────────
// The faucet route stays as-is for paper money; these are the real-money
// seams. An intent credits nothing until confirmed — that is the whole
// contract, and it is why these are two calls rather than one.
app.post('/api/wallet/deposit-intent', requireAuth, limit('wallet'), (req, res, next) => {
  const amount = Number((req.body || {}).amount_cents);
  // Same reasoning as the faucet above: the intent is a way to move real money
  // in, so self-exclusion has to stop it here too, not only stop trading.
  LIMITS.assertTradeable(db, req.user);
  RG.assertDeposit(db, req.user.id, amount);
  PAY.openDeposit(db, req.user.id, amount)
    .then((r) => res.json(r))
    .catch(next);
});

// NOTE: there is deliberately NO player-callable confirm route here.
//
// The outside audit's critical finding (F1) was that this used to exist: any
// signed-in player could POST /api/wallet/deposit-intent/:id/confirm and mint
// unbounded money. The route checked only that the intent was pending — never
// that money had arrived from the provider, never that the caller owned the
// intent — and the confirmation path credited with the faucet cap disabled
// (Number.MAX_SAFE_INTEGER as the ceiling). "Credit on confirmation, never on
// initiation" is worthless if the PLAYER is the one who confirms.
//
// Confirmation now happens in exactly two places: the provider-authenticated
// webhook below, and the admin desk. Both enforce caps as well.

// ── Payments webhook ───────────────────────────────────────────────────────
// The ONLY automated deposit-confirmation path, and it authenticates the
// CALLER, not the session: an HMAC with a shared secret, compared in constant
// time. Without the secret the route 404s rather than accepting unsigned events
// — the safe default, since this is the path that creates money.
//
// THE SIGNATURE COVERS A DELIVERY TIMESTAMP AS WELL AS THE BODY. It used to
// cover the raw body alone, which meant a captured valid request was replayable
// FOREVER. The only thing stopping a second credit was that the intent was no
// longer PENDING — a STATE-based defence, not a replay defence. Those are not
// the same: state-based idempotency stops re-delivery of one intent, and nothing
// stopped a captured request being replayed later against a still-pending one.
// Binding the timestamp into the MAC bounds the window by time as well.
//
// The timestamp is REQUIRED, not optional. An optional one would be a control the
// caller could bypass by omitting the header, which is worse than no control
// because it would read as one. Five minutes is generous for clock skew between
// the provider and the venue, and comfortably covers a retry cycle.
//
// Wire format: `x-obx-timestamp` is unix seconds; `x-obx-signature` is
// `hex(HMAC-SHA256(secret, "<timestamp>." + rawBody))`. Documented in
// docs/API.md.
const crypto = require('crypto');
const WEBHOOK_REPLAY_WINDOW_SECONDS = 300;
app.post('/api/payments/webhook', limit('wallet'), (req, res) => {
  if (!config.PAYMENTS_WEBHOOK_SECRET) return apiError(res, 404, 'Not found');

  // Shape first: the timestamp is an input to the MAC, so a malformed one is a
  // protocol error and is reported as one rather than as a bad signature.
  const ts = String(req.headers['x-obx-timestamp'] || '');
  if (!/^\d{1,15}$/.test(ts)) {
    return apiError(res, 400, 'x-obx-timestamp is required and must be unix seconds');
  }

  const sig = String(req.headers['x-obx-signature'] || '');
  const expected = crypto
    .createHmac('sha256', config.PAYMENTS_WEBHOOK_SECRET)
    .update(`${ts}.`)
    .update(req.rawBody || Buffer.alloc(0))
    .digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so check first. A plain ===
  // compare would leak the correct signature's length and early-exit timing.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return apiError(res, 401, 'Bad signature');
  }

  // Authenticated, so the freshness of THIS request is a fact about the signed
  // payload rather than anything the caller could have asserted on its own.
  // Checked after the signature deliberately: an unsigned caller learns nothing
  // about the window, and a replay of a genuinely captured request is caught
  // here with its signature still valid.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (age > WEBHOOK_REPLAY_WINDOW_SECONDS) {
    return apiError(res, 400, `Webhook timestamp is outside the ${WEBHOOK_REPLAY_WINDOW_SECONDS}s replay window`);
  }

  const body = req.body || {};
  try {
    const r = PAY.confirmByExternalId(db, {
      provider: body.provider,
      externalId: body.external_id,
      amountCents: Number(body.amount_cents),
    });
    res.json(r);
  } catch (e) {
    // A webhook the provider RETRIES must not credit twice. One referencing an
    // already-confirmed intent is the NORMAL result of at-least-once delivery,
    // and lib/payments now answers it 200 {already_confirmed: true} rather than
    // 404 — so this branch is for genuinely unknown ids, which is a real fault.
    // Either way: answer it, do not crash the process.
    if (e && e.status) return res.status(e.status).json({ error: e.message, details: e.details || null });
    throw e;
  }
});

// ── Withdrawal lifecycle (admin) ────────────────────────────────────────────
// The outside audit's F5: a withdrawal could be opened and debited, and
// NOTHING in the system could complete or refund it — the money sat in
// gateway_clearing forever. These two routes close the lifecycle, and both
// are audited with a written reason.
app.post('/api/admin/payments/intents/:id/complete', requireAdmin, limit('admin'), (req, res) => {
  const reason = (req.body || {}).reason;
  if (!reason || String(reason).trim().length < 5) return apiError(res, 400, 'A written reason is required');
  const r = PAY.completeWithdrawal(db, intId(req.params.id), String(reason).trim());
  AUDIT.record(db, req.user, AUDIT.ACTIONS.PAYMENT_INTENT_COMPLETED, 'payments:intent', r.intent_id, { status: r.status, amount_cents: r.amount_cents }, String(reason).trim());
  res.json(r);
});

app.post('/api/admin/payments/intents/:id/fail', requireAdmin, limit('admin'), (req, res) => {
  const reason = (req.body || {}).reason;
  if (!reason || String(reason).trim().length < 5) return apiError(res, 400, 'A written reason is required');
  const r = PAY.failWithdrawal(db, intId(req.params.id), String(reason).trim());
  AUDIT.record(db, req.user, AUDIT.ACTIONS.PAYMENT_INTENT_FAILED, 'payments:intent', r.intent_id, { status: r.status, refunded_cents: r.refunded_cents }, String(reason).trim());
  res.json(r);
});

app.post('/api/wallet/withdraw', requireAuth, limit('wallet'), (req, res) => {
  const { amount_cents, reason } = req.body || {};
  // UNCOERCED, and the reason is the shape of every other money route here.
  //
  // This route called `Number(amount_cents)`, which made it the ONLY money edge
  // in the codebase that accepted a non-integer: `"100"`, `true` and `[100]` all
  // became a valid cent amount and were DEBITED, each with a proper intent row.
  // Nothing was minted — the coerced amount is exactly what was withdrawn — so
  // this was never a money-printing bug. It was a boundary defect, and boundaries
  // are load-bearing in this codebase: the rest of the money path rejects these
  // types at the edge, which is what stops a future refactor from reaching the
  // ledger believing a half-cent or a boolean is a quantity.
  //
  // lib/payments' `openWithdrawal` ALREADY has the correct check — its first
  // line refuses anything that is not a positive integer. The coercion here was
  // defeating an existing validator, so the fix is to pass the value through
  // untouched and let that validator do its job, not to add a second one.
  res.json(PAY.openWithdrawal(db, req.user.id, amount_cents, reason));
});

app.get('/api/admin/reconciliation', requireAdmin, limit('admin'), (req, res, next) => {
  PAY.reconcile(db).then((r) => res.json(r)).catch(next);
});

// Operator-facing ledger view. players_cents is the segregation figure — the
// players' money as a number, not a promise.
app.get('/api/admin/ledger', requireAdmin, limit('admin'), (req, res) => {
  const ACCT = require('./lib/accounts');
  const seg = ACCT.segregation(db);
  res.json({
    segregation: seg,
    conserved_cents: ACCT.assertConserved(db),
    commission_cents: ACCT.balanceOf(db, ACCT.accountId(db, 'operator_commission', null)),
    house_float_cents: ACCT.balanceOf(db, ACCT.accountId(db, 'house_float', null)),
    gateway_clearing_cents: ACCT.balanceOf(db, ACCT.accountId(db, 'gateway_clearing', null)),
    cache_divergent: ACCT.assertUserAgrees(db),
  });
});

// ── Tenancy (Phase 4) ──────────────────────────────────────────────────────
// Branding is a CONFIG READ served as JSON and applied via CSS custom
// properties — no build step. That is why the no-build frontend survives
// multi-tenancy rather than becoming the thing that has to be rebuilt.
app.get('/api/branding', (req, res) => {
  const tenant = req.user ? TEN.ofUser(db, req.user.id) : TEN.defaultTenant(db);
  res.json({ tenant: tenant ? { id: tenant.id, slug: tenant.slug } : null, ...TEN.branding(db, tenant && tenant.id) });
});

app.get('/api/admin/tenants', requireAdmin, limit('admin'), (req, res) => {
  res.json({ tenants: TEN.list(db) });
});

app.put('/api/admin/tenants/:id', requireAdmin, limit('admin'), (req, res) => {
  const b = req.body || {};
  res.json(
    TEN.configure(db, {
      actor: req.user,
      tenantId: Number(req.params.id),
      ...(b.name === undefined ? {} : { name: b.name }),
      ...(b.status === undefined ? {} : { status: b.status }),
      ...(b.commission_bps === undefined ? {} : { commission_bps: Number(b.commission_bps) }),
      ...(b.brand === undefined ? {} : { brand: b.brand }),
      ...(b.jurisdictions === undefined ? {} : { jurisdictions: b.jurisdictions }),
    })
  );
});

// ── Results feed + reconciliation (operator surface) ───────────────────────
// The automatic polling loop is wired at boot; these are the human paths for
// inspecting held markets and closing reconciliation findings.
// The feed's own state, and a manual poll.
//
// An operator's first question when markets are not settling is "is the feed
// up?", and the answer has to be one GET. A feed that silently stopped is
// otherwise indistinguishable from a feed with nothing to say — and the
// difference is players' money sitting unsettled.
app.get('/api/admin/results/feed', requireAdmin, limit('admin'), (req, res) => {
  res.json(RFEED.health({ staleAfterMs: JOBS_INTERVALS.resultsPollMs * 2 }));
});

app.post('/api/admin/results/poll', requireAdmin, limit('admin'), async (req, res, next) => {
  try {
    // The SAME fetcher the scheduled job uses, including RESULTS_FEED_SECRET.
    // pollNow() falls back to createFetcher() with no arguments and `secret`
    // defaults to null, so the operator's "Poll now" button silently sent no
    // bearer token: the provider answered 401 and the button failed forever
    // while the timer worked. config.js only warns when the secret is UNSET, so
    // an operator who HAD set it got a clean bill of health for a broken button.
    const pollFetcher = RFEED.createFetcher({
      url: config.RESULTS_FEED_URL,
      secret: config.RESULTS_FEED_SECRET,
    });
    res.json(await RFEED.pollNow(db, { fetcher: pollFetcher, staleAfterMs: JOBS_INTERVALS.resultsPollMs * 2 }));
  } catch (e) {
    next(e);
  }
});

// ── Reporting ──────────────────────────────────────────────────────────────
// Regulatory, financial and operational reporting. Every route defaults to CSV,
// because CSV is what an operator actually files and what a regulator asks for;
// ?format=json returns the same figures as JSON with their definitions intact.
//
// The period is validated (strict dates, a bounded span) rather than defaulted
// silently: an operator who asked for a month and was handed the lifetime total
// would file it.
//
// A CONTENT-DISPOSITION filename carries the period, because a report called
// `report.csv` in a downloads folder is unattributable within a week.
const reportPeriod = (req) => REPORTS.period(req.query.from, req.query.to);

// `?format=json` returns the same figures with their definitions; anything else
// is the CSV an operator files. The handlers set the headers themselves rather
// than sharing a helper, because each one's filename differs and a shared
// wrapper here would be one more thing to keep correct.
function req_format_is_json(req) {
  return String(req.query.format || '').toLowerCase() === 'json';
}

// The financial position: commission, the venue's own trading result, and GGR
// with the components beside it and the formula in the payload.
app.get('/api/admin/reports/summary', requireAdmin, limit('admin'), (req, res) => {
  const p = reportPeriod(req);
  const rep = REPORTS.summary(db, p);
  if (req_format_is_json(req)) return res.json(rep);
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="summary_${p.from}_to_${p.to}.csv"`);
  res.send(REPORTS.summaryCsv(rep));
});

// Per-player settlement statements. The document a regulator asks about an
// individual and the one a player disputes with.
app.get('/api/admin/reports/settlements', requireAdmin, limit('admin'), (req, res) => {
  const p = reportPeriod(req);
  const rep = REPORTS.playerStatements(db, p);
  if (req_format_is_json(req)) return res.json(rep);
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="settlements_${p.from}_to_${p.to}.csv"`);
  res.send(REPORTS.statementsCsv(rep));
});

// Volume by market and by selection: the export reconciled against matched-side
// records, and the one that makes venue-only turnover visible.
app.get('/api/admin/reports/volume', requireAdmin, limit('admin'), (req, res) => {
  const p = reportPeriod(req);
  const byMarket = REPORTS.volumeByMarket(db, p);
  // The selection breakdown is a SECOND ~1s query that the CSV path then threw
  // away, so a CSV request did double the work for nothing. node:sqlite is
  // synchronous, so that is double the blocked event loop on a server with one
  // thread. Only computed when it will actually be used.
  if (!req_format_is_json(req)) {
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="volume_${p.from}_to_${p.to}.csv"`);
    return res.send(REPORTS.volumeCsv(byMarket));
  }
  // volumeBySelection returns the rows directly, NOT { rows } — the first
  // version of this route read `.rows` off an array and shipped `undefined` for
  // by_selection, which the API suite caught immediately.
  const bySelection = REPORTS.volumeBySelection(db, p);
  return res.json({
    period: p,
    by_market: byMarket.rows,
    by_selection: bySelection,
    definitions: {
      by_market: byMarket.definitions,
      by_selection: REPORTS.SELECTION_VOLUME_DEFS,
    },
  });
});

app.get('/api/admin/reports/volume-by-selection', requireAdmin, limit('admin'), (req, res) => {
  const p = reportPeriod(req);
  const rows = REPORTS.volumeBySelection(db, p);
  if (req_format_is_json(req)) {
    return res.json({ period: p, rows, definitions: REPORTS.SELECTION_VOLUME_DEFS });
  }
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="volume_by_selection_${p.from}_to_${p.to}.csv"`);
  res.send(REPORTS.selectionVolumeCsv(rows));
});

// Commission by tenant, with the effective rate beside the amount so the
// arithmetic can be checked by hand.
app.get('/api/admin/reports/commission', requireAdmin, limit('admin'), (req, res) => {
  const p = reportPeriod(req);
  const rows = REPORTS.commissionByTenant(db, p);
  if (req_format_is_json(req)) {
    return res.json({ period: p, rows, definitions: REPORTS.COMMISSION_DEFS });
  }
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="commission_${p.from}_to_${p.to}.csv"`);
  res.send(REPORTS.commissionCsv(rows));
});

// Operational health, including the realised bet delay — which is only a
// meaningful figure because that delay is now enforced by the engine.
app.get('/api/admin/reports/operational', requireAdmin, limit('admin'), (req, res) => {
  const p = reportPeriod(req);
  const rep = REPORTS.operational(db, p);
  if (req_format_is_json(req)) return res.json(rep);
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="operational_${p.from}_to_${p.to}.csv"`);
  res.send(REPORTS.operationalCsv(rep));
});

app.get('/api/admin/results/void-rules', requireAdmin, limit('admin'), (req, res) => {
  res.json({ sports: VOIDRULES.knownSports(), rules: VOIDRULES.RULES, default: VOIDRULES.DEFAULT_RULE });
});

app.get('/api/admin/results/held', requireAdmin, limit('admin'), (req, res) => {
  res.json({
    markets: db
      .prepare(
        `SELECT m.id, m.name AS market_name, m.hold_reason, e.name AS event_name
           FROM markets m JOIN events e ON e.id = m.event_id
          WHERE COALESCE(m.settlement_hold, 0) = 1 ORDER BY m.id`
      )
      .all(),
  });
});

// Releasing a hold is explicit, reasoned and audited: the whole point of
// holding a disputed market is that a machine could not decide it.
app.post('/api/admin/results/held/:id/release', requireAdmin, limit('admin'), (req, res) => {
  const { decision, winner_selection_id, dead_heat, reason } = req.body || {};
  res.json(
    RESULTS.releaseHold(db, {
      actor: req.user,
      marketId: intId(req.params.id),
      decision,
      // UNCHANGED, and `Number()` is gone from here too. This route carried the
      // same coercion the joint-favourite list was meant to be free of:
      // `Number(true)` is 1 and `Number("2")` is 2, so a hand-rolled `curl` with
      // a quoted id settled on it as though the operator had chosen it. lib/
      // settle.js refuses both, which is the whole point of that strictness.
      winnerSelectionId: winner_selection_id === undefined ? null : winner_selection_id,
      // A held DEAD HEAT is exactly the case a hold exists for, and this route
      // could only express a single winner — so releasing one paid a whole stake
      // to one runner and charged a joint winner's backer his whole stake. The
      // joint-favourite list is passed through UNCHANGED so lib/results.js
      // validates it; a coerced id must never pick an outcome here.
      deadHeatSelectionIds: dead_heat === undefined ? null : dead_heat,
      reason,
    })
  );
});

app.get('/api/admin/reconciliation/findings', requireAdmin, limit('admin'), (req, res) => {
  res.json({
    findings: db
      .prepare(
        `SELECT f.*, u.username AS resolved_by_username
           FROM reconciliation_findings f
           LEFT JOIN users u ON u.id = f.resolved_by
          ORDER BY f.resolved_at IS NOT NULL, ABS(f.drift_cents) DESC LIMIT ?`
      )
      .all(Number(req.query.limit) || 100),
  });
});

app.post('/api/admin/reconciliation/findings/:id/resolve', requireAdmin, limit('admin'), (req, res) => {
  res.json(JOBS.resolveFinding(db, { actor: req.user, id: intId(req.params.id), reason: (req.body || {}).reason }));
});

// ── In-play desk ──────────────────────────────────────────────────────────
// Suspending a market is the control that stops a sharp trading the venue's
// reaction latency during a goal. Going in-play SUSPENDS by design.
app.post('/api/admin/markets/:id/suspend', requireAdmin, limit('admin'), (req, res) => {
  const b = req.body || {};
  res.json(INPLAY.setSuspended(db, {
    marketId: intId(req.params.id),
    suspended: b.suspended !== false,
    until: b.until ?? null,
    reason: b.reason ?? null,
  }));
});

app.post('/api/admin/markets/:id/inplay', requireAdmin, limit('admin'), (req, res) => {
  const b = req.body || {};
  res.json(INPLAY.setInplay(db, { marketId: intId(req.params.id), inplay: b.inplay !== false, delayMs: b.delay_ms }));
});

// Clearing the kick-off suspension is the ONLY way an in-play market starts
// accepting bets, and it is deliberately a separate action from suspending.
app.post('/api/admin/markets/:id/release', requireAdmin, limit('admin'), (req, res) => {
  res.json(INPLAY.releaseKickoffSuspension(db, intId(req.params.id)));
});

// Manual trigger for the delay-release pass. The timer is the normal path;
// this exists so an operator can drain a backlog immediately (after restoring
// a database, or after turning a delay off mid-event) without waiting a cycle.
app.post('/api/admin/inplay/release-delays', requireAdmin, limit('admin'), (req, res) => {
  // The helper here is `intId`, not `intVal` — there is no `intVal` in this
  // file, so the first version of this route threw a ReferenceError and
  // answered 500 to every caller, including the admin who needed it to drain a
  // backlog after restoring a database. It stayed invisible because no test
  // called the route; tests/api.test.js R1 now does, for exactly that reason.
  // The limit is a hint, so an absent or nonsensical one falls back rather than
  // throwing: an operator's emergency button should not 400 because they typed
  // a limit badly.
  const raw = req.body && req.body.limit;
  const n = Number(raw);
  const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 5000) : 1000;
  const r = MATCH.releaseEligibleOrders(db, { limit });
  res.json(r);
});

app.get('/api/admin/markets/:id/volume', requireAdmin, limit('admin'), (req, res) => {
  const id = intId(req.params.id);
  res.json({ ...INPLAY.tradedVolume(db, id, req.query.window), by_selection: INPLAY.volumeBySelection(db, id, req.query.window) });
});

// ── Cash-out venue risk ───────────────────────────────────────────────────
app.get('/api/admin/risk/cashout', requireAdmin, limit('admin'), (req, res) => {
  res.json(CASHOUTRISK.desk(db, {
    venueMaxOutstandingCents: config.CASHOUT_MAX_OUTSTANDING_CENTS,
    venueMaxDailyLossCents: config.CASHOUT_MAX_DAILY_LOSS_CENTS,
  }));
});

// NOTE: the old "expire stale cash-out quotes" route is deliberately GONE.
// It expired a kind of row that no production path ever wrote (the outside
// audit's F2): quotes and their executions are atomic in the same request,
// so there is no live quote to go stale. What the venue carries now is
// executed BUYOUTS, which resolve at settlement — nothing to sweep.

// ── Operational surface ────────────────────────────────────────────────────
// /healthz is LIVENESS and must not touch the database: a liveness probe that
// queries a dependency restarts the process when that dependency blips, turning
// a database outage into a crash loop. /readyz is READINESS and does check —
// including the ledger, because a venue whose books have drifted must not be
// sent players.
const OPS_TOKEN = config.OPS_TOKEN || null;
// Constant-time string compare, so presenting a near-miss token reveals nothing
// through response timing.
function tokenMatches(presented, expected) {
  if (!presented || !expected) return false;
  const a = crypto.createHash('sha256').update(String(presented)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function opsGuard(req, res, next) {
  // Liveness and readiness are PUBLIC: they are how a supervisor reaches the
  // process, and requiring a token for them means a misconfigured token takes
  // the process down rather than just hiding metrics.
  if (req.path === '/healthz' || req.path === '/readyz') return next();

  // Metrics and the backup controls expose real numbers, so:
  //
  //   OPS_TOKEN unset  => 404. Not "open", not "forbidden" — absent, so that an
  //                       operator who never set one leaks nothing and a scanner
  //                       learns nothing about whether it exists.
  //   OPS_TOKEN set    => the token MUST be presented. This was the inverse:
  //                       `if (publicRoute || OPS_TOKEN) return next()` skipped
  //                       the check exactly when a token existed, so /metrics
  //                       and the backup control were open to anyone — and
  //                       `x-ops-token` was never read anywhere in the codebase.
  if (!OPS_TOKEN) return apiError(res, 404, 'Not found');

  const header = req.get('x-ops-token');
  const auth = req.get('authorization') || '';
  const bearer = /^Bearer\s+(.*)$/i.exec(auth);
  const presented = header || (bearer ? bearer[1].trim() : '');
  if (!tokenMatches(presented, OPS_TOKEN)) {
    return apiError(res, 401, 'Unauthorized');
  }
  return next();
}

app.get('/healthz', opsGuard, (req, res) => res.json(OPS.health()));
app.get('/readyz', opsGuard, (req, res) => {
  const r = OPS.readiness(db);
  res.status(r.status === 'ready' ? 200 : 503).json(r);
});
app.get('/metrics', opsGuard, (req, res) => {
  res.type('text/plain; version=0.0.4').send(OPS.metrics(db));
});

// Backup/restore are deliberately POST and token-gated. `fs` handles the
// snapshot; this only decides WHEN.
//
// NEITHER THE DESTINATION NOR THE RETENTION IS TAKEN FROM THE BODY.
//
// `dir` used to be `req.body.dir || config.BACKUP_DIR`, and lib/ops.js
// mkdirSync's whatever it is handed before VACUUM INTO writes there. So any
// caller who could reach this route could choose the directory, and the route
// is reachable by any ADMIN plus the ops token. That is a write primitive over
// the whole filesystem, and the obvious target is `public/` — which
// express.static serves at the bottom of this file with NO authentication. A
// snapshot dropped there is a complete copy of the players' funds database,
// published to anyone who can fetch a URL.
//
// The destination is now config.BACKUP_DIR and nothing else. An operator who
// wants a different one sets BACKUP_DIR and restarts, which is auditable from
// the environment rather than from whatever the last request said. This is
// deliberately stricter than "confine it to a subpath of BACKUP_DIR": a
// destination that cannot move at runtime is a property you can read off the
// code, and a subpath rule still has to be reasoned about per request.
//
// `retention` is still honoured, because "keep more snapshots than usual for
// this one" is a reasonable thing to ask for — but it is CLAMPED to the same
// 1..1000 range lib/config.js already validates for BACKUP_RETENTION. The
// body could previously send 0, which switches pruning off entirely and lets
// snapshots accumulate until the disk fills, or a number large enough to keep
// every snapshot ever taken.
const BACKUP_RETENTION_MIN = 1;
const BACKUP_RETENTION_MAX = 1000;
const backupRetentionFrom = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return config.BACKUP_RETENTION;
  return Math.min(BACKUP_RETENTION_MAX, Math.max(BACKUP_RETENTION_MIN, Math.trunc(n)));
};

app.post('/api/admin/backup', requireAdmin, opsGuard, limit('admin'), (req, res) => {
  if (!config.BACKUP_DIR) {
    return apiError(res, 400, 'No backup directory configured — set BACKUP_DIR and restart');
  }
  const r = OPS.backup(db, {
    dir: config.BACKUP_DIR,
    retention: backupRetentionFrom((req.body || {}).retention ?? config.BACKUP_RETENTION),
  });
  AUDIT.record(db, req.user, AUDIT.ACTIONS.BACKUP_TAKEN, 'ops:backup', null, { path: r.path, bytes: r.bytes }, (req.body || {}).reason);
  res.json(r);
});

// ── Scheduled jobs ─────────────────────────────────────────────────────────
// Reconciliation ON A TIMER. lib/payments exposed a reconcile() report earlier
// and nothing ran it — a control that is only invoked by hand is not a
// control. Timers are unref'd so they never hold the process open, and each
// skips rather than stacks if a run is still in flight.
const jobTimers = [];
if (JOBS_INTERVALS.reconcileMs > 0) {
  jobTimers.push(
    JOBS.every(JOBS_INTERVALS.reconcileMs, async () => {
      const r = await JOBS.reconcileOnce(db);
      if (!r.ok) console.warn(`[reconcile] ${r.findings.length} finding(s); ${r.open.length} open`);
    })
  );
}

if (JOBS_INTERVALS.backupMs > 0 && config.BACKUP_DIR) {
  jobTimers.push(
    JOBS.every(JOBS_INTERVALS.backupMs, async () => {
      const r = OPS.backup(db, { dir: config.BACKUP_DIR, retention: config.BACKUP_RETENTION });
      console.log(`[backup] ${r.path} (${r.bytes} bytes, ${r.users} users)`);
    })
  );
}

if (JOBS_INTERVALS.delayReleaseMs > 0) {
  jobTimers.push(
    JOBS.every(JOBS_INTERVALS.delayReleaseMs, async () => {
      const r = MATCH.releaseEligibleOrders(db);
      if (r.filled > 0) {
        console.log(`[inplay] released ${r.released} delayed order(s), ${r.filled} cents filled`);
      }
    })
  );
}

// The results poll. This job did not exist even though
// RESULTS_POLL_INTERVAL_MS was documented in the README and pollOnce() had a
// complete consumer — so outcomes only ever arrived when an operator pushed
// them by hand, and the documentation described a feature the server did not
// have. A knob that reads nothing is worse than no knob: an operator who set
// it believed their settlement was automated.
if (JOBS_INTERVALS.resultsPollMs > 0) {
  const fetcher = RFEED.createFetcher({
    url: config.RESULTS_FEED_URL,
    secret: config.RESULTS_FEED_SECRET,
    timeoutMs: config.RESULTS_FEED_TIMEOUT_MS,
  });
  jobTimers.push(
    JOBS.every(JOBS_INTERVALS.resultsPollMs, async () => {
      const r = await RFEED.pollNow(db, { fetcher, staleAfterMs: JOBS_INTERVALS.resultsPollMs * 2 });
      if (r.error) {
        console.warn(`[results] poll failed: ${r.error.reason} ${r.error.detail || ''}`);
      } else if (r.applied > 0) {
        console.log(`[results] applied ${r.applied}/${r.considered} outcome(s) from the feed`);
      } else if (r.feed.status === 'failing') {
        console.warn(`[results] feed ${r.feed.status} (${r.feed.consecutive_failures} in a row): ${r.feed.last_error && r.feed.last_error.reason}`);
      }
    })
  );
}

if (JOBS_INTERVALS.maintenanceMs > 0) {
  jobTimers.push(
    JOBS.every(JOBS_INTERVALS.maintenanceMs, async () => {
      const m = OPS.maintenance(db);
      if (!m.ok) console.warn(`[maintenance] ${m.error}`);
    })
  );
}

// ── SQLite error mapping ───────────────────────────────────────────────────
// The admin catalogue INSERTs fail two ways: a client-correctable mistake
// the schema itself rejects (duplicate slug, unknown foreign key — a
// constraint violation) or a genuine server fault. Only the first kind gets
// a fabricated 4xx message; everything else MUST fall through to next(err)
// so it surfaces as a real 500 instead of a misleading 4xx.
//
// node:sqlite reports constraint violations with a numeric errcode in the
// SQLITE_CONSTRAINT family (all extended codes share the low byte 19) and a
// message ending in "constraint failed"; some drivers also expose a
// 'SQLITE_CONSTRAINT*' .code string. All three signals are checked so the
// mapping stays robust across driver versions.
function isSqliteConstraint(e) {
  if (!e || typeof e !== 'object') return false;
  if (typeof e.errcode === 'number' && (e.errcode & 0xff) === 19) return true;
  if (typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) return true;
  return /constraint failed/i.test(String(e.message || ''));
}

// ── starts_at validation ───────────────────────────────────────────────────
// ISO-8601 date or datetime validation lives in lib/util.js — one definition,
// shared with lib/limits.js, which validates the self-exclusion end date with
// the same predicate. The column stores TEXT and the board sorts it lexically,
// so format matters beyond parseability — a non-ISO string would also sort
// wrong on the board.

app.post('/api/admin/sports', requireAdmin, limit('admin'), (req, res, next) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return apiError(res, 400, 'name required');
  const slug = slugify(name);
  try {
    db.prepare('INSERT INTO sports (name, slug) VALUES (?, ?)').run(name, slug);
  } catch (e) {
    // Only schema constraints get a fabricated message; anything else is a
    // real fault and MUST surface as a 5xx, not a misleading 4xx.
    if (!isSqliteConstraint(e)) return next(e);
    return apiError(res, 409, 'Sport slug already exists');
  }
  res.status(201).json({ sport: db.prepare('SELECT * FROM sports WHERE slug = ?').get(slug) });
});

app.post('/api/admin/competitions', requireAdmin, limit('admin'), (req, res, next) => {
  const { sport_id, name, country } = req.body || {};
  if (!Number.isInteger(Number(sport_id)) || !String(name || '').trim()) {
    return apiError(res, 400, 'sport_id and name required');
  }
  try {
    db.prepare('INSERT INTO competitions (sport_id, name, country) VALUES (?, ?, ?)').run(Number(sport_id), String(name).trim(), country || null);
  } catch (e) {
    if (!isSqliteConstraint(e)) return next(e);
    // sport_id is FK-checked by the schema; a constraint here means it does
    // not exist (name is pre-validated, so NOT NULL cannot fire).
    return apiError(res, 400, 'Invalid sport_id');
  }
  const comp = db.prepare('SELECT * FROM competitions WHERE sport_id = ? AND name = ?').get(Number(sport_id), String(name).trim());
  res.status(201).json({ competition: comp });
});

app.post('/api/admin/events', requireAdmin, limit('admin'), (req, res, next) => {
  const { sport_id, competition_id, name, starts_at } = req.body || {};
  const startsAt = String(starts_at || '').trim();
  if (!Number.isInteger(Number(sport_id)) || !String(name || '').trim() || !startsAt) {
    return apiError(res, 400, 'sport_id, name and starts_at required');
  }
  if (!isIsoDateTime(startsAt)) {
    return apiError(res, 400, 'starts_at must be an ISO-8601 date or datetime (YYYY-MM-DD[ HH:MM[:SS]])');
  }
  const sportId = Number(sport_id);
  let compId = null;
  if (competition_id !== null && competition_id !== undefined && competition_id !== '') {
    compId = Number(competition_id);
    if (!Number.isInteger(compId)) return apiError(res, 400, 'competition_id must be an integer');
    // A competition from a DIFFERENT sport would create inconsistent catalogue
    // data (the board groups by competition but filters by sport).
    const comp = db.prepare('SELECT sport_id FROM competitions WHERE id = ?').get(compId);
    if (!comp || comp.sport_id !== sportId) {
      return apiError(res, 400, 'competition_id does not belong to that sport');
    }
  }
  try {
    db.prepare('INSERT INTO events (sport_id, competition_id, name, starts_at) VALUES (?, ?, ?, ?)').run(
      sportId,
      compId,
      String(name).trim(),
      startsAt
    );
  } catch (e) {
    if (!isSqliteConstraint(e)) return next(e);
    // competition_id was verified above, so a constraint here is the sport FK.
    return apiError(res, 400, 'Invalid sport_id');
  }
  const ev = db.prepare('SELECT * FROM events WHERE sport_id = ? AND name = ? ORDER BY id DESC').get(sportId, String(name).trim());
  res.status(201).json({ event: ev });
});

app.post('/api/admin/markets', requireAdmin, limit('admin'), (req, res, next) => {
  const { event_id, name } = req.body || {};
  if (!Number.isInteger(Number(event_id)) || !String(name || '').trim()) {
    return apiError(res, 400, 'event_id and name required');
  }
  try {
    db.prepare('INSERT INTO markets (event_id, name) VALUES (?, ?)').run(Number(event_id), String(name).trim());
  } catch (e) {
    if (!isSqliteConstraint(e)) return next(e);
    return apiError(res, 400, 'Invalid event_id');
  }
  const m = db.prepare('SELECT * FROM markets WHERE event_id = ? ORDER BY id DESC').get(Number(event_id));
  res.status(201).json({ market: m });
});

app.post('/api/admin/selections', requireAdmin, limit('admin'), (req, res, next) => {
  const { market_id, name, fair_price } = req.body || {};
  if (!Number.isInteger(Number(market_id)) || !String(name || '').trim()) {
    return apiError(res, 400, 'market_id and name required');
  }
  let fair = null;
  if (fair_price !== undefined && fair_price !== null) {
    // NaN/Infinity must not reach snapToTick: it clamps, so garbage would
    // silently become a ladder end and publish a tradable market with a
    // meaningless price.
    const fp = Number(fair_price);
    if (!Number.isFinite(fp)) return apiError(res, 400, 'fair_price must be a number');
    fair = ODDS.snapToTick(fp);
  }
  try {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(Number(market_id), String(name).trim(), fair);
  } catch (e) {
    if (!isSqliteConstraint(e)) return next(e);
    return apiError(res, 400, 'Invalid market_id');
  }
  const sel = db.prepare('SELECT * FROM selections WHERE market_id = ? AND name = ?').get(Number(market_id), String(name).trim());
  // A market created at runtime has no ladders until something quotes it —
  // quote immediately so new markets are tradeable (the bot's own two sides
  // never cross, so a single runner is safe to quote). Gated on the
  // EFFECTIVE switch: when the feed is on, the recorder owns prices and a
  // bot requote would write straight over the observed book.
  if (BOTS_ON) {
    try {
      bots.quoteMarket(db, Number(market_id));
    } catch (e) {
      console.error('[bots] quote-after-create failed:', e.message);
    }
  }
  res.status(201).json({ selection: sel });
});

app.patch('/api/admin/markets/:id', requireAdmin, limit('admin'), (req, res) => {
  const status = (req.body || {}).status;
  if (!['open', 'suspended'].includes(status)) return apiError(res, 400, 'status must be open or suspended');
  const m = db.prepare('SELECT * FROM markets WHERE id = ?').get(intId(req.params.id));
  if (!m) return apiError(res, 404, 'Market not found');
  if (m.status === 'settled') return apiError(res, 409, 'Market is settled');
  db.prepare('UPDATE markets SET status = ? WHERE id = ?').run(status, m.id);
  AUDIT.record(
    db, req.user,
    status === 'suspended' ? AUDIT.ACTIONS.MARKET_SUSPENDED : AUDIT.ACTIONS.MARKET_RESTORED,
    `market:${m.id}`,
    { status: m.status }, { status },
    (req.body || {}).reason || null
  );
  broadcast('book', { market_id: m.id });
  res.json({ market: db.prepare('SELECT * FROM markets WHERE id = ?').get(m.id) });
});

app.post('/api/admin/markets/:id/settle', requireAdmin, limit('admin'), (req, res) => {
  const body = req.body || {};
  const mid = intId(req.params.id);
  // Pass the caller's values through UNCHANGED: lib/settle.js validates
  // strictly (a string "false" must not void a market, a boolean must not
  // become selection id 1). No coercion happens here on purpose.
  // dead_heat is the SET of joint winners; it settles like a win with the
  // payout divided among them. Validation is in lib/settle.js, as with the
  // single-winner path — this route passes values through unchanged so a
  // coerced boolean or a string id cannot pick an outcome.
  const result = SET.settleMarket(db, mid, {
    winner_selection_id: body.winner_selection_id === undefined ? null : body.winner_selection_id,
    void: body.void === undefined ? false : body.void,
    dead_heat: body.dead_heat === undefined ? null : body.dead_heat,
  });
  // Settlement moves the most money of any operator action, so it is audited
  // with the winning runner and the aggregate rather than the per-user rows —
  // the per-user detail already lives in `settlements` and `transactions`.
  AUDIT.record(
    db, req.user,
    AUDIT.ACTIONS.MARKET_SETTLED,
    `market:${mid}`,
    // The status this market WAS, taken from the row the settlement
    // transaction itself read (`settleMarket` returns it). It used to be the
    // string literal 'open', so every settlement audit row asserted a prior
    // state that was simply asserted rather than observed — and a suspended
    // market (which settles normally; only `settled` and `held` are refused)
    // was recorded as having been open. This is the `before` an operator,
    // auditor or regulator reads on the most money-moving action the venue
    // offers, so it must be a record and not a fabrication.
    { status: result.previous_status ?? null },
    { void: !!body.void, winner_selection_id: body.winner_selection_id ?? null, users_settled: result.per_user.length },
    body.reason || null
  );
  broadcast('book', { market_id: mid });
  broadcast('settlement', { market_id: mid });
  for (const u of result.per_user) {
    broadcast('balance', {}, u.user_id);
    broadcast('orders', {}, u.user_id);
  }
  res.json(result);
});

app.get('/api/admin/stats', requireAdmin, limit('admin'), (req, res) => {
  const markets = db
    .prepare(
      `SELECT m.id, m.name, m.status, m.total_matched_cents, e.name AS event_name,
         (SELECT COUNT(*) FROM orders o WHERE o.market_id = m.id AND o.status = 'open') AS open_orders
       FROM markets m JOIN events e ON e.id = m.event_id
       ORDER BY m.id DESC LIMIT 200`
    )
    .all();
  // Per-market overround is computed in JS (it needs the live book), so the
  // desk can see at a glance whether a market is margined or arbitrageable.
  for (const m of markets) m.overround = M.marketOverround(db, m.id);
  res.json({ markets });
});

// Competitions for a sport — the admin desk's create form needs the list.
app.get('/api/admin/competitions', requireAdmin, limit('admin'), (req, res) => {
  const sportId = Number(req.query.sport_id);
  if (!Number.isInteger(sportId)) return apiError(res, 400, 'sport_id required');
  const competitions = db
    .prepare('SELECT id, name, country FROM competitions WHERE sport_id = ? ORDER BY name')
    .all(sportId);
  res.json({ competitions });
});

// ── Static frontend + error handler ────────────────────────────────────────
// Unknown API paths must answer JSON, not Express's HTML 404 page.
//
// THIS IS ALSO WHAT KEEPS EXPRESS 5's AUTOMATIC `OPTIONS` RESPONSE SWITCHED OFF,
// and that is not obvious. Express 5 answers an `OPTIONS` request with a
// generated `Allow: GET, HEAD` listing the matched route's methods — and the
// router produces it BEFORE the route's middleware runs, so `requireAdmin`
// never gets a say. Measured: with this handler removed,
//
//   OPTIONS /api/admin/users  ->  200, Allow: GET, HEAD
//
// which tells an unauthenticated caller that the route exists and which methods
// it accepts, past the admin gate.
//
// It stays off here because this handler RESPONDS and never calls next(): the
// router therefore never reaches the point where it would emit the automatic
// response. That makes this registration load-bearing for authorisation, not
// just for the error shape — so it must remain the last thing registered before
// `express.static`. A route added BELOW it, or a rewrite that lets it fall
// through, re-opens the enumeration. `tests/express5.test.js` E9 asserts the
// behaviour rather than trusting this paragraph.
app.use('/api', (req, res) => {
  apiError(res, 404, 'Unknown endpoint');
});

app.use(express.static(path.join(__dirname, 'public')));

// A 4xx is a decision this app made and its message is safe to return. A 5xx
// FAULT may carry a database message, a file path or a stack frame, so the
// client gets a generic message and the real one goes to the log.
//
// THE EXCEPTION IS OPT-IN, NOT INFERRED. An application state it chose
// deliberately and described in its own words — "FEED_CREDENTIALS_KEY is not
// set, here is the command that fixes it" — is not a fault, and arriving as
// `500 Internal error` leaves an operator unable to distinguish "you have not
// configured this" from "the venue is broken". Two states with completely
// different remedies, one of them written into the message that never arrived.
//
// Such an error sets `err.expose` (see lib/auth.js `serviceUnavailable`). The
// default for anything that does not is unchanged — clamp to 500, generic
// message, real error logged — so a genuine fault still cannot leak. A module
// has to SAY that a 5xx is deliberate; nothing infers it, because a deliberate
// 503 and a thrown TypeError are indistinguishable to this function.
//
// Exported so the behaviour is unit-testable from both sides: a real fault, and
// an opted-in 503.
//
// THE `res.headersSent` GUARD IS NEW IN THE EXPRESS 5 MIGRATION, and it is
// there for a reason that did not exist before. Express 5 forwards a rejected
// promise from an ASYNC handler into this function automatically. Before this
// migration an error could only arrive here from a SYNCHRONOUS throw — a narrow
// window in which no handler here had ever thrown after writing its response.
// Auto-forwarding widens it: a handler that writes a response and then has an
// `await` reject would land here with the status line already gone.
//
// What this function would then do is `res.status(500).json(...)` on a finished
// response, which throws ERR_HTTP_HEADERS_SENT, which Express catches and
// escalates to the default handler. The client keeps the body it already had —
// so the answer is the right one — but the server logs a spurious internal
// error on top of a request that succeeded, which is precisely the noise that
// trains an operator to ignore the log. Handing a post-response error to
// `next(err)` instead is what Express documents, and it lets the default
// handler destroy the socket rather than manufacture a second response.
//
// No handler in this file exercises the guard today (E7 in
// tests/express5.test.js asserts that mechanically, by requiring every async
// handler to catch its own rejection). It is here because the first one that
// does not should log the error it actually threw, not ERR_HTTP_HEADERS_SENT.
// eslint-disable-next-line no-unused-vars
/**
 * Default machine-readable code per HTTP status.
 *
 * Only statuses this venue actually returns, and only where the meaning is
 * unambiguous. 4xx codes name the CALLER's situation; the 5xx entries are
 * deliberately coarse because a 5xx message is generic anyway and inventing a
 * precise code for "something broke" would tell a client more than the venue
 * knows. `rate_limited` is set explicitly by the volume limiter rather than
 * derived, because a 429 on a full venue and a 429 on a rate-limited caller are
 * different events wearing the same status — conflating them is the mistake the
 * API reference already warns about.
 */
const ERROR_CODES = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  422: 'unprocessable',
  503: 'unavailable',
  500: 'internal_error',
};

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const raw = Number(err.status) || 500;
  const expose = raw >= 500 && err.expose === true;
  const status = raw >= 500 && !expose ? 500 : raw;
  if (status >= 500 && !expose) console.error('[api]', err);
  return apiError(
    res,
    status,
    status >= 500 && !expose ? 'Internal error' : err.message || 'Request failed',
    err.details,
    { expose },
  );
}

/**
 * The ONE way an error response is shaped, so the contract cannot drift between
 * the routes that answer directly and the ones that throw.
 *
 * Every 4xx/5xx from an /api route carries a machine-readable `code`:
 *
 *   1. an explicit `details.code` the route set, promoted to the TOP level so a
 *      client can read it without knowing that some codes live in `details` and
 *      some do not;
 *   2. otherwise one derived from the status, so there is always something to
 *      branch on — including on the routes nobody has annotated.
 *
 * (2) is what earns the guarantee. A promise that depends on every future
 * contributor remembering to add a code is not a promise; this one holds on the
 * first request and improves as routes annotate themselves.
 *
 * `opts.expose` is threaded through for one reason: a 5xx must not leak
 * `details`. The route chose its status and its details; the body a client sees
 * is decided here, and for 5xx that decision is not the route's.
 *
 * `opts.extra` carries fields that are part of the response contract but are not
 * the error — `retry_after_seconds` on a 429, `ok: false` on a 503. They are
 * additive and placed before `details` so the three well-known keys
 * (`error`, `code`, `details`) are in a predictable position in every body.
 *
 * NOTE FOR NEW ROUTES. Prefer `apiError(res, ...)` over `res.status().json()`.
 * The 55 direct `res.status().json()` calls still work and are still correct —
 * they just do not carry a top-level `code` unless they pass one. Converting one
 * is a safe, behaviour-preserving cleanup; leaving one is not a bug, because a
 * derived code is always present either way.
 */
function apiError(res, status, error, details, opts) {
  const o = opts || {};
  const body = { error };
  // The ONE place a `code` is decided, so the two response paths cannot drift.
  // A route that knows precisely what happened names it in `details.code`; every
  // other route gets the status-derived default, which is what makes `code`
  // present on ALL of them rather than only the annotated few.
  body.code = (details && typeof details === 'object' && details.code) || ERROR_CODES[status] || 'unexpected_status';
  if (o.extra) Object.assign(body, o.extra);
  // Structured context (which limit was breached, what it is) is a 4xx-only
  // affordance. It is deliberately absent from a 5xx even if present on the
  // error, so an internal failure cannot leak detail through it.
  if (status < 500 && details && typeof details === 'object') {
    body.details = details;
  }
  return res.status(status).json(body);
}

app.use(errorHandler);

// S13: a prominent, honest boot warning while a seeded account still accepts
// its well-known demo password. Checked against the STORED hash, so it stays
// truthful for pre-existing databases — and stops warning exactly when the
// operator changes the password or seeds a custom one.
async function warnDefaultCredentials() {
  for (const name of ['admin', 'demo']) {
    if (!(await isDefaultCredential(name))) continue;
    console.warn(
      `[security] "${name}" still accepts its seeded demo password and must change it before trading.`
    );
  }
}

/**
 * Is this account still on a seeded demo password?
 *
 * VERIFIES AGAINST THE STORED HASH rather than comparing config. That matters:
 * an operator who sets ADMIN_PASSWORD in .env gets a real account and this
 * returns false immediately, whereas comparing config would keep flagging an
 * account that is already safe and train the operator to ignore the warning.
 *
 * THE LITERAL IS DELIBERATELY NOT lib/seed.js's `config.ADMIN_PASSWORD ||
 * 'admin123'`. It looks like the same value and it is not: this asks "does this
 * account still accept the PUBLISHED demo password", which is the only question
 * the warning and the lock are asking. Sourcing it from the seed would make this
 * verify the OPERATOR's chosen password — which the seed used — so every
 * properly-configured deployment would flag and lock its own admin for using a
 * password nobody else knows. Verified here: the account really is unsafe, not
 * merely un-defaulted.
 */
async function isDefaultCredential(username) {
  const DEFAULTS = { admin: 'admin123', demo: 'demo123' };
  // COLLATE NOCASE: a seeded account spelled 'ADMIN' is the same identity and
  // must be recognised as one.
  const row = db.prepare('SELECT pass_hash FROM users WHERE username = ? COLLATE NOCASE').get(username);
  return !!row && (await A.verifyPassword(DEFAULTS[username], row.pass_hash));
}

async function main() {
  // The seed derives its password hashes off the event loop, so the catalogue
  // is not there yet at require() time. Everything below — rolling events
  // forward, quoting the bots' ladders, flipping the first-run lock — reads it,
  // and a venue that listened before the seed landed would answer its first
  // request from an empty board.
  await ready;
  const rolled = rollForwardEvents(db);
  if (rolled) console.log(`[board] ${rolled} past-due event(s) moved to live`);
  startHeartbeat();
  // With the feed on, the recorder owns prices. Bots and drift would requote
  // ladders every DRIFT_INTERVAL_MS straight over the observed Betfair book and
  // the two would fight, so they are forced off rather than left to config
  // discipline. Order still matters: the feed is a price SOURCE, not a
  // replacement for the exchange's own machinery. (BOTS_ON/DRIFT_ON are
  // hoisted at module scope so every route shares this exact definition.)
  if (config.FEED_ENABLED) {
    if (config.BOT_ENABLED) console.log('[feed] on — bots suppressed (feed owns prices)');
    if (config.DRIFT_ENABLED) console.log('[feed] on — drift suppressed (feed owns prices)');
  }
  if (BOTS_ON) {
    try {
      bots.quoteAllMarkets(db);
      console.log('[bots] liquidity quoted on all open markets');
    } catch (e) {
      console.error('[bots]', e.message);
    }
  }
  if (DRIFT_ON) {
    drift.startDrift(db, { intervalMs: config.DRIFT_INTERVAL_MS, broadcast });
    console.log('[drift] on');
  }
  // An operator who has not configured a backup has no backup, and the
  // failure is discovered on the day the disk dies. Said loudly, at boot,
  // every time — this is the last moment it is cheap to act on.
  if (!config.BACKUP_DIR) {
    console.warn(
      '[ops] NO BACKUP CONFIGURED. Set BACKUP_DIR to take scheduled snapshots.\n' +
      '[ops] This database holds player balances; without a snapshot there is no\n' +
      '[ops] recovery path if the disk is lost. Press Enter at any time.'
    );
  }
  if (!config.OPS_TOKEN) {
    console.warn('[ops] OPS_TOKEN unset — /metrics and the backup control return 404.');
  }
  // Responsible gambling. Self-exclusion ships and is always on; the session
  // limit, reality check and deposit limit are operator-configured and default
  // to 0. That is deliberate (no session limit is correct for every operator),
  // but it means a demo deployment is UNGUARDED, and that must be said at boot
  // rather than discovered in an audit.
  if (!RG.configured()) {
    console.warn(
      '[rg] NO RESPONSIBLE-GAMBLING LIMITS CONFIGURED.\n' +
      '[rg] Session limit, reality check and deposit limit are all off, so this\n' +
      '[rg] venue offers unbounded play. Set RG_SESSION_MINUTES,\n' +
      '[rg] RG_REALITY_CHECK_MINUTES and RG_DEPOSIT_DAILY_CENTS before it can\n' +
      '[rg] serve anyone. Self-exclusion (always on) is not a substitute.'
    );
  }

  // The results feed is off unless configured. That is a legitimate way to run
  // (settle by hand or by webhook), so it is not an error — but it is worth
  // one line, because the alternative reading is "results are automatic", and
  // on a venue that reading means nobody notices markets not settling.
  if (!config.RESULTS_FEED_URL) {
    console.warn(
      '[results] RESULTS_FEED_URL unset — no automatic results feed. Markets settle\n' +
      '[results] by webhook or by an operator settling them by hand.'
    );
  }

  // Both verify a stored hash, so both are async now that key derivation runs
  // off the event loop. Awaited rather than fired: the lock has to be in place
  // BEFORE the socket accepts a connection, or the first request of a fresh
  // deployment would be served unlocked.
  await enforceFirstRunLock();
  await warnDefaultCredentials();
  if (config.FEED_ENABLED) {
    FEED.health()
      .then((h) => {
        const line = feedBootStatus(h, config.FEED_STALE_SECONDS);
        if (line.level === 'error') console.error(`[feed] ${line.message}`);
        else if (line.level === 'warn') console.warn(`[feed] ${line.message}`);
        else console.log(`[feed] ${line.message}`);
      })
      .catch((e) => console.error('[feed] health check failed:', e.message));
  }
  const server = app.listen(config.PORT, config.HOST, () => {
    console.log(`OpenBettingExchange on http://${config.HOST}:${config.PORT} (paper money only)`);
  });
  // A hung SSE connection must not keep the process alive on shutdown.
  server.on('close', closeStreams);
  server.on('close', () => { FEED.close().catch(() => {}); });

  installShutdown(server);
}

/**
 * ── SHUTDOWN ──────────────────────────────────────────────────────────────────
 *
 * THERE WAS NO SHUTDOWN PATH. The only `process.on` registrations were
 * unhandledRejection and uncaughtException, so a SIGTERM from systemd, docker or
 * a supervisor took the DEFAULT action and terminated the process immediately:
 * `server.close()` was never called, so the `server.on('close')` handlers
 * (closeStreams, FEED.close) never ran, and — the part that matters —
 * FRUN.stopAll() was never called, because it had no callers at all.
 *
 * The collector is a child process with no parent-death signal. So every
 * deploy, every crash and every Ctrl-C left the previous `betfeed collect`
 * running: still holding a Betfair session, still spending market-data weight,
 * still writing into the feed PostgreSQL, and now competing with the new
 * collector for the same account. The new process started with an empty
 * in-memory `runners` map, so it reported `supervisor: 'idle'` and `stop()`
 * answered "the collector was not running" — the operator was told nothing was
 * running while a zombie was. Two collectors on one Betfair account is the
 * fastest route to being rate-limited or banned.
 *
 * The order matters. Timers first, so no new work is queued; then the
 * collector, because it is the thing that outlives us; then the listener, so
 * in-flight requests finish. And the whole thing has a hard deadline: a
 * shutdown handler that hangs forever is worse than none, because it turns
 * SIGTERM into a hang for whatever supervises the service — so if the drain
 * does not finish we exit anyway rather than sit there.
 */
function installShutdown(server) {
  let shuttingDown = false;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      // A second Ctrl-C must not begin a second shutdown.
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[shutdown] ${sig} — stopping jobs and the feed collector`);
      for (const t of jobTimers) {
        try { t.stop(); } catch { /* a job that is not a timer */ }
      }
      // stopAll() escalates to SIGKILL itself; this is the OUTER bound, so
      // nothing here may hold the process open indefinitely.
      const deadline = setTimeout(() => {
        console.error('[shutdown] drain did not finish in time; exiting anyway');
        process.exit(1);
      }, 10_000);
      FRUN.stopAll()
        .then((r) => {
          console.log(`[shutdown] collector stopped (${r.stopped} process(es), ${r.escalated} SIGKILLed)`);
        })
        .catch(() => {})
        .then(() => {
          clearTimeout(deadline);
          server.close(() => process.exit(0));
          // server.close() waits for keep-alive connections to drain. It is not
          // allowed to be the reason a service restart hangs.
          const hard = setTimeout(() => process.exit(0), 3_000);
          if (hard.unref) hard.unref();
        });
    });
  }
}

// main() is async (it awaits the seed bootstrap and the first-run lock's key
// derivations). A rejection here would otherwise be an unhandled rejection and
// the process would sit there having never listened — which reads exactly like a
// healthy start with no port bound.
if (require.main === module) {
  main().catch((e) => {
    console.error('[boot] failed:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

// `ready` is exported so anything that requires this module can await the
// seed before assuming the catalogue exists. tests/api.test.js, feed.test.js,
// feed_nav.test.js and feedadmin.test.js all listen on `app` themselves.
module.exports = { app, db, broadcast, errorHandler, clampFeedLimit, feedBootStatus, streamAdmission, resetLoginLimiter, resetVolumeLimits, limit, volumeExceeded, jobTimers, ready, OPS,
  // The response shaper, exposed for tests. NOT for production callers: every
  // route should reach the error contract by throwing (so status and details
  // travel together) or by calling this directly with an explicit status, and
  // the two are indistinguishable from here. It is exported rather than
  // re-implemented in the test because a test that re-implements the thing it is
  // testing proves nothing.
  __apiErrorForTest: apiError };
