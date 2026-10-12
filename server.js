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
const SET = require('./lib/settle');
const CASH = require('./lib/cashout');
const bots = require('./lib/bots');
const drift = require('./lib/drift');
const ODDS = require('./lib/odds');
const FEED = require('./lib/feed');
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

// ── Origin guard FIRST, before any body parsing: mutating requests need no
// Origin (curl/local tooling) or a loopback/same-host origin (JIT/bet-agent
// pattern). Running it before express.json() means a foreign origin gets 403
// even when the body is malformed. ──────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1') return next();
  } catch {}
  return res.status(403).json({ error: 'Forbidden origin' });
});

app.use(express.json({ limit: '256kb' }));

// DB + idempotent seed on first run.
const db = openStore(config.DB_PATH);
seedIfNeeded(db);
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

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
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

function rlRecordFailure(key) {
  const a = rlAttempts.get(key) || { fails: 0, lockedUntil: 0 };
  a.fails += 1;
  if (a.fails >= RL_MAX_FAILURES) {
    a.lockedUntil = Date.now() + Math.min(RL_LOCK_BASE_MS * 2 ** (a.fails - RL_MAX_FAILURES), RL_LOCK_MAX_MS);
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

app.post('/api/auth/register', (req, res) => {
  const { username, password, email } = req.body || {};
  // Registration abuse is account-farming or identity enumeration from one
  // machine, so the counter keys on the caller's IP.
  const key = 'register:' + (req.socket.remoteAddress || 'unknown');
  if (rlLocked(key)) return rlTooManyAttempts(res, key);
  try {
    const user = A.registerUser(db, { username, password, email });
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
    throw e;
  }
});

app.post('/api/auth/login', (req, res) => {
  // Case-normalized on purpose: 'Admin', 'ADMIN' and 'admin' share one
  // counter, so case variants cannot farm fresh guessing windows.
  const key = 'login:' + String((req.body || {}).username || '').trim().toLowerCase();
  if (rlLocked(key)) return rlTooManyAttempts(res, key);
  try {
    const { user, token } = A.loginUser(db, { ...(req.body || {}), country: TEN.trustedCountry(req) });
    rlRecordSuccess(key); // a success proves the real user — clear the slate
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.json({ user });
  } catch (e) {
    if (e && e.status === 401) rlRecordFailure(key); // only auth misses count
    throw e; // sync throw → Express forwards to the error handler
  }
});

app.post('/api/auth/logout', (req, res) => {
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
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const r = A.changePassword(db, {
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
 * The allowlist is the minimum needed to GET TO THE FIX and nothing more:
 * whoami, change-password, logout, session management. Notably absent is
 * everything a demo password should not reach — trading, the wallet, and the
 * entire admin desk, which is the account that matters most. An admin left on
 * admin123 who can read the ledger and move other people's money is the worst
 * state this project can be deployed in.
 *
 * Enforcement is in middleware rather than per-route so a route added later is
 * covered by default. A list of PROTECTED routes would be the design that
 * fails open.
 */
const SETUP_ALLOWLIST = new Set([
  'GET /api/me',
  'POST /api/auth/change-password',
  'POST /api/auth/logout',
  'GET /api/auth/sessions',
  'DELETE /api/auth/sessions/:id',
]);

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
function enforceFirstRunLock() {
  let flagged = 0;
  for (const name of ['admin', 'demo']) {
    if (!isDefaultCredential(name)) continue;
    const r = db.prepare('UPDATE users SET must_change_password = 1 WHERE username = ? AND must_change_password = 0').run(name);
    flagged += r.changes;
  }
  return flagged;
}

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (SETUP_ALLOWLIST.has(`${req.method} ${req.path}`)) return next();
  if (!mustChangePassword(req.user)) return next();
  res.status(403).json({
    error: 'Change your password before using the exchange',
    details: {
      code: 'password_change_required',
      username: req.user.username,
      // Named so a fresh demo deployment shows the operator what to change.
      seeded_password: req.user.username === 'admin' ? 'admin123' : 'demo123',
    },
  });
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
  const result = L.deposit(db, req.user.id, amount, config.FAUCET_MAX_CENTS);
  broadcast('balance', {}, req.user.id);
  res.json(result);
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
  const applied = {};
  if (status !== undefined) applied.status = ADM.setStatus(db, { actor: req.user, userId: id, status, reason });
  if (role !== undefined) applied.role = ADM.setRole(db, { actor: req.user, userId: id, role, reason });
  if (!Object.keys(applied).length) {
    return res.status(400).json({ error: 'Provide status or role' });
  }
  res.json({ ok: true, ...applied });
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
  PAY.openDeposit(db, req.user.id, Number((req.body || {}).amount_cents))
    .then((r) => res.json(r))
    .catch(next);
});

app.post('/api/wallet/deposit-intent/:id/confirm', requireAuth, limit('wallet'), (req, res) => {
  res.json(PAY.confirmDeposit(db, Number(req.params.id)));
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
  const { decision, winner_selection_id, reason } = req.body || {};
  res.json(
    RESULTS.releaseHold(db, {
      actor: req.user,
      marketId: intId(req.params.id),
      decision,
      winnerSelectionId: winner_selection_id === undefined ? null : Number(winner_selection_id),
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

app.post('/api/admin/risk/cashout/expire', requireAdmin, limit('admin'), (req, res) => {
  const n = CASHOUTRISK.expireStaleQuotes(db);
  audit.record(db, req.user, audit.ACTIONS.CASHOUT_QUOTES_EXPIRED, 'risk:cashout', null, { expired: n }, (req.body || {}).reason);
  res.json({ expired: n });
});

// ── Operational surface ────────────────────────────────────────────────────
// /healthz is LIVENESS and must not touch the database: a liveness probe that
// queries a dependency restarts the process when that dependency blips, turning
// a database outage into a crash loop. /readyz is READINESS and does check —
// including the ledger, because a venue whose books have drifted must not be
// sent players.
const OPS_TOKEN = config.OPS_TOKEN || null;
function opsGuard(req, res, next) {
  // Unauthenticated by default: liveness/readiness are how a SUPERVISOR
  // reaches the process, and requiring a token breaks that. Metrics and the
  // backup controls expose real numbers, so they need OPS_TOKEN — and
  // without one they answer 404 rather than leaking the books.
  const publicRoute = req.path === '/healthz' || req.path === '/readyz';
  if (publicRoute || OPS_TOKEN) return next();
  res.status(404).json({ error: 'Not found' });
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
app.post('/api/admin/backup', requireAdmin, opsGuard, (req, res) => {
  const r = OPS.backup(db, {
    dir: (req.body || {}).dir || config.BACKUP_DIR,
    retention: (req.body || {}).retention ?? config.BACKUP_RETENTION,
  });
  audit.record(db, req.user, audit.ACTIONS.BACKUP_TAKEN, 'ops:backup', null, { path: r.path, bytes: r.bytes }, (req.body || {}).reason);
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
  const result = SET.settleMarket(db, mid, {
    winner_selection_id: body.winner_selection_id === undefined ? null : body.winner_selection_id,
    void: body.void === undefined ? false : body.void,
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
function warnDefaultCredentials() {
  for (const name of ['admin', 'demo']) {
    if (!isDefaultCredential(name)) continue;
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
function isDefaultCredential(username) {
  const DEFAULTS = { admin: 'admin123', demo: 'demo123' };
  const row = db.prepare('SELECT pass_hash FROM users WHERE username = ?').get(username);
  return !!row && A.verifyPassword(DEFAULTS[username], row.pass_hash);
}

function main() {
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

  enforceFirstRunLock();
  warnDefaultCredentials();
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

if (require.main === module) main();

module.exports = { app, db, broadcast, errorHandler, clampFeedLimit, resetLoginLimiter, resetVolumeLimits, limit, volumeExceeded, jobTimers, OPS };
