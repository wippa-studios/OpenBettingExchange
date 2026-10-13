'use strict';
// server.js — OpenBettingExchange exchange server (Express ^4, node:sqlite).
const express = require('express');
const path = require('path');
const config = require('./lib/config');
const { openStore } = require('./lib/store');
const { seedIfNeeded, rollForwardEvents } = require('./lib/seed');
const A = require('./lib/auth');
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
  return res.status(403).json({ error: 'Forbidden origin' });
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
const SETUP_ALLOWLIST = new Set([
  'GET /api/me',
  'POST /api/auth/change-password',
  'POST /api/auth/logout',
  'GET /api/auth/sessions',
  'DELETE /api/auth/sessions/:id',
]);

// isSetupRoute: the exact key the allowlist is written in, from the request.
// `req.path` is used rather than `req.originalUrl` so a query string does not
// turn an allowlisted route into a locked one — `GET /api/me?x=1` must behave
// identically to `GET /api/me`, and originalUrl would compare 'GET /api/me?x=1'
// against 'GET /api/me' and miss.
function isSetupRoute(req) {
  return SETUP_ALLOWLIST.has(`${req.method} ${req.path}`);
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
  res.status(403).json({
    error: 'Change your password before using the exchange',
    details: {
      code: 'password_change_required',
      username: req.user.username,
      // Named so a fresh demo deployment shows the operator what to change.
      seeded_password: req.user.username === 'admin' ? 'admin123' : 'demo123',
    },
  });
  return true;
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
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
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
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
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ── Route helpers ──────────────────────────────────────────────────────────
// Express 4 does NOT forward async rejections to the error middleware: an
// `await` that throws inside a route handler leaves the request hung until
// the client gives up (no 500, no timeout — just a dangling socket). Every
// async handler is wrapped so rejections become next(err). Express 5
// removes the need for this; until then, aw() is the band-aid.
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

app.get('/api/stream', (req, res) => {
  // The first-run lock, explicitly. This route uses OPTIONAL auth — a signed-out
  // viewer gets an anonymous stream — so it never passes through requireAuth,
  // and the middleware that used to enforce the lock sat 350 lines BELOW this
  // registration and therefore did not apply. A locked account got a live
  // stream. The lock check now lives in requireAuth/requireAdmin so placement
  // cannot matter, and this one route keeps an explicit call because optional
  // auth is genuinely a different case, not an oversight.
  if (req.user && firstRunLockResponse(req, res)) return;
  if (clients.size >= MAX_SSE_CLIENTS) return res.status(503).json({ error: 'Too many concurrent streams' });
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
  const client = { res, userId: req.user ? req.user.id : null };
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
// Brute-force guard for the two credential routes (W3). In-memory, no deps.
// Counters are per key — the case-normalized username for login, the remote
// IP for register — and count CONSECUTIVE FAILURES only: any success clears
// the key, so a legitimate user who occasionally mistypes a password is
// never locked out and successes can never accumulate toward a lock.
//
// At RL_MAX_FAILURES consecutive misses the key is locked for RL_LOCK_BASE_MS,
// doubling with each further failure and capped at RL_LOCK_MAX_MS. While
// locked, every attempt answers 429 WITHOUT touching scrypt, so a locked
// account is cheap to defend and expensive to keep guessing at. The map is
// process-local (a restart clears it) — right for a single-node loopback
// demo; a multi-node deployment would need a shared store instead.
const RL_MAX_FAILURES = 10; // consecutive failures before lockout
const RL_LOCK_BASE_MS = 30 * 1000; // first lockout window
const RL_LOCK_MAX_MS = 15 * 60 * 1000; // cap: further doubling outlives interest
const rlAttempts = new Map(); // key → { fails, lockedUntil }

function rlLocked(key) {
  const a = rlAttempts.get(key);
  return !!a && a.lockedUntil > Date.now();
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

function rlRecordFailure(key) {
  const perIp = key.startsWith('login-ip:');
  const maxFails = perIp ? RL_IP_MAX_FAILURES : RL_MAX_FAILURES;
  const a = rlAttempts.get(key) || { fails: 0, lockedUntil: 0 };
  a.fails += 1;
  if (a.fails >= maxFails) {
    a.lockedUntil = perIp
      ? Date.now() + RL_IP_LOCK_MS
      : Date.now() + Math.min(RL_LOCK_BASE_MS * 2 ** (a.fails - RL_MAX_FAILURES), RL_LOCK_MAX_MS);
  }
  rlAttempts.set(key, a);
}

function rlRecordSuccess(key) {
  rlAttempts.delete(key);
}

function rlRetryAfterSeconds(key) {
  const a = rlAttempts.get(key);
  return a ? Math.max(1, Math.ceil((a.lockedUntil - Date.now()) / 1000)) : 0;
}

// Test seam: clears the in-memory counters so a suite can isolate the
// limiter. Exported for tests ONLY — no production path calls this.
function resetLoginLimiter() {
  rlAttempts.clear();
}

function rlTooManyAttempts(res, key) {
  return res
    .status(429)
    .setHeader('Retry-After', String(rlRetryAfterSeconds(key)))
    .json({ error: 'Too many failed attempts; try again later' });
}

// ── Request VOLUME limiting ────────────────────────────────────────────────
// The counter above limits CONSECUTIVE FAILURES, which is the right shape for
// guessing a password and the wrong shape for everything else. An attacker
// making only VALID requests — placing thousands of orders, hammering
// cash-out, walking the admin catalogue — never trips a failure counter.
//
// So a second, independent limiter counts requests in a sliding window.
// Deliberately SEPARATE from rlAttempts rather than merged: a login failing
// ten times and a burst of successful reads are different problems with
// different remedies, and one counter serving both would let traffic of
// either kind clear the other's budget.
const VOLUME_BUCKETS = {
  // Trading is the money path. Generous per user — a scalper legitimately
  // fires many orders — but bounded, because unbounded order placement is a
  // self-DoS on the single-threaded engine.
  // Limits come from config so an operator can tune them; 0 disables a bucket.
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
function limit(bucket) {
  return (req, res, next) => {
    const retryAfter = volumeExceeded(req, bucket);
    if (retryAfter > 0) {
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests', retry_after_seconds: retryAfter });
    }
    next();
  };
}

function resetVolumeLimits() {
  volumeHits.clear();
}

// async because A.registerUser derives the password hash, and that derivation
// runs on libuv's threadpool rather than on this thread. Express 4 does not
// await a handler, so every error must be caught INSIDE and re-thrown onto the
// error handler explicitly — an async handler's rejection is an unhandled
// promise rejection, not a 500.
app.post('/api/auth/register', async (req, res, next) => {
  const { username, password, email } = req.body || {};
  // Registration abuse is account-farming or identity enumeration from one
  // machine, so the counter keys on the caller's IP.
  const key = 'register:' + (req.socket.remoteAddress || 'unknown');
  if (rlLocked(key)) return rlTooManyAttempts(res, key);
  try {
    const user = await A.registerUser(db, { username, password, email });
    rlRecordSuccess(key);
    // Jurisdiction gate at session mint, not at bet placement. The country is
    // read ONLY from a proxy-overwritten header, and only when the operator has
    // asserted that is true — see lib/tenants.js trustedCountry().
    const token = A.createSession(db, user.id, { country: TEN.trustedCountry(req) });
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.status(201).json({ user });
  } catch (e) {
    // A refused registration (validation, duplicate username) is a failed
    // attempt; anything else (a server fault) is not.
    if (e && (e.status === 400 || e.status === 409)) rlRecordFailure(key);
    next(e);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  // Case-normalized on purpose: 'Admin', 'ADMIN' and 'admin' share one
  // counter, so case variants cannot farm fresh guessing windows.
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
  if (rlLocked(ipKey)) return rlTooManyAttempts(res, ipKey);
  if (rlLocked(key)) return rlTooManyAttempts(res, key);
  try {
    const { user, token } = await A.loginUser(db, { ...(req.body || {}), country: TEN.trustedCountry(req) });
    rlRecordSuccess(key); // a success proves the real user — clear the slate
    rlRecordSuccess(ipKey);
    // Sign-in starts the RG session clock, and does NOT restart a session
    // already running: a player who refreshes the page must not get a fresh
    // session limit, which is the easiest way to defeat one.
    const rg = RG.startSession(db, user.id);
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.json({ user, rg });
  } catch (e) {
    if (e && e.status === 401) {
      rlRecordFailure(key); // only auth misses count
      rlRecordFailure(ipKey); // …and they count against the source too
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

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: { ...req.user, available_cents: req.user.balance_cents - req.user.frozen_cents } });
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

app.get('/api/auth/sessions', requireAuth, (req, res) => {
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
    const r = db.prepare('UPDATE users SET must_change_password = 1 WHERE username = ? AND must_change_password = 0').run(name);
    flagged += r.changes;
  }
  return flagged;
}

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (isSetupRoute(req)) return next();
  if (!mustChangePassword(req.user)) return next();
  firstRunLockResponse(req, res);
});

app.get('/api/sports', (req, res) => {
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
  if (!config.FEED_ENABLED) return res.status(409).json({ error: 'Feed is disabled (set FEED_ENABLED=true)' });
  try {
    const markets = await FEED.fetchBoard({ limit: clampFeedLimit(req.query.limit, config.FEED_MARKET_LIMIT) });
    res.json({ markets });
  } catch (e) {
    // A feed outage must not look like a 500 from the exchange itself.
    console.error('[feed] board read failed:', e.message);
    res.status(503).json({ error: 'Odds feed unavailable' });
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
  if (!config.FEED_ENABLED) return res.status(409).json({ error: 'Feed is disabled (set FEED_ENABLED=true)' });
  const id = req.query.id;
  if (!id || !String(id).trim()) {
    return res.status(400).json({ error: 'id is required' });
  }
  try {
    const market = await FEED.fetchMarket(id);
    res.json({ market: market || null });
  } catch (e) {
    console.error('[feed] market read failed:', e.message);
    res.status(503).json({ error: 'Odds feed unavailable' });
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
    res.status(503).json({ error: 'Odds feed unavailable' });
  }
}));

// Feed liveness. The client-facing error is genericized at this boundary:
// a driver failure can embed host/user detail in its message (pg errors do),
// so the detail goes to the server log and the client gets a status that is
// uninformative but true. Resilient to whatever health() returns OR throws —
// including a future detail field with driver messages in it.
app.get('/api/feed/health', aw(async (req, res) => {
  if (!config.FEED_ENABLED) return res.status(409).json({ error: 'Feed is disabled' });
  let h;
  try {
    h = await FEED.health();
  } catch (e) {
    console.error('[feed] health check failed:', e.message);
    return res.status(503).json({ ok: false, error: 'Odds feed unavailable' });
  }
  if (h && h.ok) return res.json(h);
  console.error('[feed] health check reported failure:', (h && (h.error || h.detail)) || '(no detail)');
  res.status(503).json({ ok: false, error: 'Odds feed unavailable' });
}));

// ── Feed collector: operator surface ──────────────────────────────────────
// Credentials and process supervision. Deliberately SEPARATE from the read-only
// board routes above: those are public, these are admin-only and they touch the
// single most sensitive thing this system stores.
//
// There is no route here that returns a stored credential, and that is a
// property of the design rather than an omission — lib/feedcreds exposes no
// function that serves plaintext to an HTTP caller.

/** Which tenant the request is acting on. Defaults to the requester's own. */
function feedTenantId(req) {
  const asked = req.params.id || req.body?.tenant_id || req.query.tenant_id;
  return asked === undefined || asked === '' ? TEN.ofUser(db, req.user.id)?.id ?? TEN.defaultTenant(db).id : Number(asked);
}

// Status: WHICH credentials exist, never their values.
//
// Two GET shapes, because an operator setting up a venue wants the LIST and one
// troubleshooting wants the DETAIL. A separate `/credentials-all` path was the
// first attempt and it is a trap: it reads as a sibling of `/credentials` but
// sits at the same level as `/credentials/:id`, so any future refactor that
// reorders these silently starts routing it as a tenant id called "-all".
app.get('/api/admin/feed/credentials', requireAdmin, limit('admin'), (req, res) => {
  res.json({ tenants: FCREDS.statusAll(db) });
});

app.get('/api/admin/feed/credentials/:id', requireAdmin, limit('admin'), (req, res) => {
  res.json(FCREDS.status(db, feedTenantId(req)));
});

// Store. Exactly three fields, because the collector needs exactly three:
// Betfair's Delay key authenticates with a username and password, and there is
// no certificate on it. Offering a cert upload would imply support that a Delay
// key cannot use.
app.put('/api/admin/feed/credentials/:id?', requireAdmin, limit('admin'), (req, res) => {
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
  let restarted = false;
  if (FRUN.health(result.tenant_id).running) {
    FRUN.stop(result.tenant_id);
    FRUN.start(result.tenant_id);
    restarted = true;
  }
  res.json({ ...result, collector_restarted: restarted });
});

app.delete('/api/admin/feed/credentials/:id?', requireAdmin, limit('admin'), (req, res) => {
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
});

// Supervision. The readiness reason comes back verbatim rather than as a bool,
// because "the runner will not start" is useless to an operator who is not told
// which of five conditions is missing.
app.get('/api/admin/feed/runner/:id?', requireAdmin, limit('admin'), (req, res) => {
  res.json(FRUN.health(feedTenantId(req)));
});

app.post('/api/admin/feed/runner/start', requireAdmin, limit('admin'), (req, res) => {
  const result = FRUN.start(feedTenantId(req), { actor: req.user });
  // A refusal is a 409 with the reason, not a 200 with started:false that a UI
  // renders as success.
  if (!result.started) return res.status(409).json({ error: result.reason, ...result });
  res.json(result);
});

app.post('/api/admin/feed/runner/stop', requireAdmin, limit('admin'), (req, res) => {
  res.json(FRUN.stop(feedTenantId(req)));
});

app.get('/api/events', (req, res) => {
  const sportSlug = req.query.sport;
  let rows;
  if (sportSlug) {
    const sport = db.prepare('SELECT id FROM sports WHERE slug = ?').get(sportSlug);
    if (!sport) return res.status(404).json({ error: 'Unknown sport' });
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

app.get('/api/markets/:id/book', (req, res) => {
  const m = db.prepare('SELECT * FROM markets WHERE id = ?').get(intId(req.params.id));
  if (!m) return res.status(404).json({ error: 'Market not found' });
  res.json({ market: m, book: M.bookFor(db, m.id, 5) });
});

// Price formats for the trading desk: the same pure functions the engine uses,
// so the UI never has to re-implement (or drift from) the conversion maths.
app.get('/api/format/:price', (req, res) => {
  const raw = Number(req.params.price);
  if (!Number.isFinite(raw)) return res.status(400).json({ error: 'Price must be a number' });
  const p = ODDS.snapToTick(raw);
  if (!ODDS.validTick(p)) return res.status(400).json({ error: 'Price is outside the 1.01-1000 ladder' });
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

app.get('/api/orders', requireAuth, (req, res) => {
  res.json({ orders: M.openOrdersFor(db, req.user.id) });
});

app.post('/api/orders/:id/cancel', requireAuth, limit('trade'), (req, res) => {
  const order = M.cancelOrder(db, req.user, intId(req.params.id));
  broadcast('book', { market_id: order.market_id });
  broadcast('orders', {}, req.user.id);
  broadcast('balance', {}, req.user.id);
  res.json({ order });
});

app.get('/api/positions', requireAuth, (req, res) => {
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
app.get('/api/wallet', requireAuth, (req, res) => {
  res.json(L.walletView(db, req.user.id));
});

app.get('/api/settlements', requireAuth, (req, res) => {
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

app.put('/api/admin/risk/kill-switch', requireAdmin, limit('admin'), (req, res) => {
  res.json(RISK.setKillSwitch(db, { actor: req.user, on: !!(req.body || {}).on }));
});

app.post('/api/admin/risk/withdraw', requireAdmin, limit('admin'), (req, res) => {
  res.json(bots.withdrawAll(db));
});

app.put('/api/admin/risk/bots/:id', requireAdmin, limit('admin'), (req, res) => {
  const b = req.body || {};
  const wrap = (req, res, next) => {
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
      if (!e.status) e.status = 400;
      next(e);
    }
  };
  wrap(req, res, next);
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
// CALLER, not the session: an HMAC over the raw body with a shared secret,
// compared in constant time. Without the secret the route 404s rather than
// accepting unsigned events — the safe default, since this is the path that
// creates money.
const crypto = require('crypto');
app.post('/api/payments/webhook', limit('wallet'), (req, res) => {
  if (!config.PAYMENTS_WEBHOOK_SECRET) return res.status(404).json({ error: 'Not found' });
  const sig = String(req.headers['x-obx-signature'] || '');
  const expected = crypto
    .createHmac('sha256', config.PAYMENTS_WEBHOOK_SECRET)
    .update(req.rawBody || Buffer.alloc(0))
    .digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so check first. A plain ===
  // compare would leak the correct signature's length and early-exit timing.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Bad signature' });
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
    // A webhook the provider RETRIES must not credit twice, and one that
    // references an unknown or already-confirmed intent is the normal result
    // of at-least-once delivery — answer it, do not crash the process.
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
  if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'A written reason is required' });
  const r = PAY.completeWithdrawal(db, intId(req.params.id), String(reason).trim());
  AUDIT.record(db, req.user, AUDIT.ACTIONS.PAYMENT_INTENT_COMPLETED, 'payments:intent', r.intent_id, { status: r.status, amount_cents: r.amount_cents }, String(reason).trim());
  res.json(r);
});

app.post('/api/admin/payments/intents/:id/fail', requireAdmin, limit('admin'), (req, res) => {
  const reason = (req.body || {}).reason;
  if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'A written reason is required' });
  const r = PAY.failWithdrawal(db, intId(req.params.id), String(reason).trim());
  AUDIT.record(db, req.user, AUDIT.ACTIONS.PAYMENT_INTENT_FAILED, 'payments:intent', r.intent_id, { status: r.status, refunded_cents: r.refunded_cents }, String(reason).trim());
  res.json(r);
});

app.post('/api/wallet/withdraw', requireAuth, limit('wallet'), (req, res) => {
  const { amount_cents, reason } = req.body || {};
  res.json(PAY.openWithdrawal(db, req.user.id, Number(amount_cents), reason));
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
      winnerSelectionId: winner_selection_id === undefined ? null : Number(winner_selection_id),
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
  if (!OPS_TOKEN) return res.status(404).json({ error: 'Not found' });

  const header = req.get('x-ops-token');
  const auth = req.get('authorization') || '';
  const bearer = /^Bearer\s+(.*)$/i.exec(auth);
  const presented = header || (bearer ? bearer[1].trim() : '');
  if (!tokenMatches(presented, OPS_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
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

app.post('/api/admin/backup', requireAdmin, opsGuard, (req, res) => {
  if (!config.BACKUP_DIR) {
    return res.status(400).json({
      error: 'No backup directory configured — set BACKUP_DIR and restart',
    });
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
// ISO-8601 date or datetime, in the forms the desk actually sends:
//   2030-01-01 | 2030-01-01T12:00 | 2030-01-01 12:00[:00[.ffffff]][Z|±HH:MM]
// (the admin form and smoke.sh both send a SPACE-separated datetime). The
// column stores TEXT and the board sorts it lexically, so format matters
// beyond parseability — a non-ISO string would also sort wrong on the board.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function isIsoDateTime(s) {
  if (!ISO_DATETIME_RE.test(s)) return false;
  // A syntactically valid string can still be a non-date (2030-02-31) or a
  // non-time (25:00). Date.parse is lenient — V8 rolls Feb 31 into Mar 3 —
  // so verify the calendar by round-trip: every component must survive.
  const [d, t] = s.split(/[T ]/);
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

app.post('/api/admin/sports', requireAdmin, limit('admin'), (req, res, next) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const slug = slugify(name);
  try {
    db.prepare('INSERT INTO sports (name, slug) VALUES (?, ?)').run(name, slug);
  } catch (e) {
    // Only schema constraints get a fabricated message; anything else is a
    // real fault and MUST surface as a 5xx, not a misleading 4xx.
    if (!isSqliteConstraint(e)) return next(e);
    return res.status(409).json({ error: 'Sport slug already exists' });
  }
  res.status(201).json({ sport: db.prepare('SELECT * FROM sports WHERE slug = ?').get(slug) });
});

app.post('/api/admin/competitions', requireAdmin, limit('admin'), (req, res, next) => {
  const { sport_id, name, country } = req.body || {};
  if (!Number.isInteger(Number(sport_id)) || !String(name || '').trim()) {
    return res.status(400).json({ error: 'sport_id and name required' });
  }
  try {
    db.prepare('INSERT INTO competitions (sport_id, name, country) VALUES (?, ?, ?)').run(Number(sport_id), String(name).trim(), country || null);
  } catch (e) {
    if (!isSqliteConstraint(e)) return next(e);
    // sport_id is FK-checked by the schema; a constraint here means it does
    // not exist (name is pre-validated, so NOT NULL cannot fire).
    return res.status(400).json({ error: 'Invalid sport_id' });
  }
  const comp = db.prepare('SELECT * FROM competitions WHERE sport_id = ? AND name = ?').get(Number(sport_id), String(name).trim());
  res.status(201).json({ competition: comp });
});

app.post('/api/admin/events', requireAdmin, limit('admin'), (req, res, next) => {
  const { sport_id, competition_id, name, starts_at } = req.body || {};
  const startsAt = String(starts_at || '').trim();
  if (!Number.isInteger(Number(sport_id)) || !String(name || '').trim() || !startsAt) {
    return res.status(400).json({ error: 'sport_id, name and starts_at required' });
  }
  if (!isIsoDateTime(startsAt)) {
    return res.status(400).json({ error: 'starts_at must be an ISO-8601 date or datetime (YYYY-MM-DD[ HH:MM[:SS]])' });
  }
  const sportId = Number(sport_id);
  let compId = null;
  if (competition_id !== null && competition_id !== undefined && competition_id !== '') {
    compId = Number(competition_id);
    if (!Number.isInteger(compId)) return res.status(400).json({ error: 'competition_id must be an integer' });
    // A competition from a DIFFERENT sport would create inconsistent catalogue
    // data (the board groups by competition but filters by sport).
    const comp = db.prepare('SELECT sport_id FROM competitions WHERE id = ?').get(compId);
    if (!comp || comp.sport_id !== sportId) {
      return res.status(400).json({ error: 'competition_id does not belong to that sport' });
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
    return res.status(400).json({ error: 'Invalid sport_id' });
  }
  const ev = db.prepare('SELECT * FROM events WHERE sport_id = ? AND name = ? ORDER BY id DESC').get(sportId, String(name).trim());
  res.status(201).json({ event: ev });
});

app.post('/api/admin/markets', requireAdmin, limit('admin'), (req, res, next) => {
  const { event_id, name } = req.body || {};
  if (!Number.isInteger(Number(event_id)) || !String(name || '').trim()) {
    return res.status(400).json({ error: 'event_id and name required' });
  }
  try {
    db.prepare('INSERT INTO markets (event_id, name) VALUES (?, ?)').run(Number(event_id), String(name).trim());
  } catch (e) {
    if (!isSqliteConstraint(e)) return next(e);
    return res.status(400).json({ error: 'Invalid event_id' });
  }
  const m = db.prepare('SELECT * FROM markets WHERE event_id = ? ORDER BY id DESC').get(Number(event_id));
  res.status(201).json({ market: m });
});

app.post('/api/admin/selections', requireAdmin, limit('admin'), (req, res, next) => {
  const { market_id, name, fair_price } = req.body || {};
  if (!Number.isInteger(Number(market_id)) || !String(name || '').trim()) {
    return res.status(400).json({ error: 'market_id and name required' });
  }
  let fair = null;
  if (fair_price !== undefined && fair_price !== null) {
    // NaN/Infinity must not reach snapToTick: it clamps, so garbage would
    // silently become a ladder end and publish a tradable market with a
    // meaningless price.
    const fp = Number(fair_price);
    if (!Number.isFinite(fp)) return res.status(400).json({ error: 'fair_price must be a number' });
    fair = ODDS.snapToTick(fp);
  }
  try {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(Number(market_id), String(name).trim(), fair);
  } catch (e) {
    if (!isSqliteConstraint(e)) return next(e);
    return res.status(400).json({ error: 'Invalid market_id' });
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
  if (!['open', 'suspended'].includes(status)) return res.status(400).json({ error: 'status must be open or suspended' });
  const m = db.prepare('SELECT * FROM markets WHERE id = ?').get(intId(req.params.id));
  if (!m) return res.status(404).json({ error: 'Market not found' });
  if (m.status === 'settled') return res.status(409).json({ error: 'Market is settled' });
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
    { status: 'open' },
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
  if (!Number.isInteger(sportId)) return res.status(400).json({ error: 'sport_id required' });
  const competitions = db
    .prepare('SELECT id, name, country FROM competitions WHERE sport_id = ? ORDER BY name')
    .all(sportId);
  res.json({ competitions });
});

// ── Static frontend + error handler ────────────────────────────────────────
// Unknown API paths must answer JSON, not Express's HTML 404 page.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown endpoint' });
});

app.use(express.static(path.join(__dirname, 'public')));

// A 4xx is a decision this app made and its message is safe to return. A 5xx
// may carry a database message, a file path or a stack frame, so the client
// gets a generic message and the real one goes to the log. Exported so the
// behaviour is unit-testable (no API path can provoke a 5xx on purpose).
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const raw = Number(err.status) || 500;
  const status = raw >= 500 ? 500 : raw;
  if (status >= 500) console.error('[api]', err);
  const body = { error: status >= 500 ? 'Internal error' : err.message || 'Request failed' };
  // Structured context (which limit was breached, what it is) is a 4xx-only
  // affordance. It is deliberately absent from a 5xx even if present on the
  // error, so an internal failure cannot leak detail through it.
  if (status < 500 && err.details && typeof err.details === 'object') {
    body.details = err.details;
  }
  res.status(status).json(body);
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
 */
async function isDefaultCredential(username) {
  const DEFAULTS = { admin: 'admin123', demo: 'demo123' };
  const row = db.prepare('SELECT pass_hash FROM users WHERE username = ?').get(username);
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
        if (h.ok) {
          console.log(
            `[feed] odds feed connected — ${h.markets} markets, newest frame ${
              h.age_seconds == null ? 'unknown' : `${h.age_seconds}s old`
            }${h.stale ? ' (STALE)' : ''}`
          );
        } else {
          console.error(`[feed] unreachable: ${h.error}`);
        }
      })
      .catch((e) => console.error('[feed] health check failed:', e.message));
  }
  const server = app.listen(config.PORT, config.HOST, () => {
    console.log(`OpenBettingExchange on http://${config.HOST}:${config.PORT} (paper money only)`);
  });
  // A hung SSE connection must not keep the process alive on shutdown.
  server.on('close', closeStreams);
  server.on('close', () => { FEED.close().catch(() => {}); });
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
module.exports = { app, db, broadcast, errorHandler, clampFeedLimit, resetLoginLimiter, resetVolumeLimits, limit, volumeExceeded, jobTimers, ready, OPS };
