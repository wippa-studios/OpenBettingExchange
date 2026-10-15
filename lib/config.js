'use strict';
// lib/config.js — .env loader + validation (zero deps beyond node builtins).
// House pattern: validate at boot, abort with a clear error on bad values
// instead of failing later (wippa-bet-agent config.py style).
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  PORT: 7777,
  HOST: '127.0.0.1',
  DB_PATH: 'data/openbettingexchange.db',
  // Odds feed (the betfair-market-snapshots recorder's Postgres). When enabled,
  // the board's prices come from the recorder instead of the demo bots.
  FEED_ENABLED: false,
  FEED_DATABASE_URL: '',
  // When true the venue SUPERVISES the collector (spawns `betfeed collect` and
  // restarts it). When false the venue only READS the collector's database and
  // the collector is run by other means — systemd, docker, an operator's shell.
  // Default false, because a venue that already runs the collector on its own
  // must not suddenly find a second copy writing the same rows.
  FEED_RUNNER_ENABLED: false,
  // Which of the collector's two feeds to read: 1 (fixtures only) or 2 (fixtures
  // + prices + results). Default 2, because a board with no prices is not a
  // board. Feed 1 is for a venue running its own book on real fixtures.
  FEED_NUMBER: 2,
  // The collector command. Split on whitespace so it can be an absolute path or
  // a PATH lookup, and so an operator can prefix it with a wrapper (uv, podman,
  // a systemd unit) without this code learning about any of that.
  FEED_COLLECTOR_CMD: 'betfeed collect',
  // Seconds the exchange waits after a credential change before restarting the
  // collector. Non-zero by default because a wrong credential produces an
  // immediate, repeating failure, and a supervisor that retries on every change
  // turns an operator's typo into a login flood against Betfair.
  FEED_RUNNER_MIN_UPTIME_SECONDS: 120,
  // A snapshot older than this is reported as stale rather than served as live.
  // The recorder runs on a DELAYED Betfair key, which batches on a ~3 minute
  // cadence, so the default is deliberately a little over one cycle.
  FEED_STALE_SECONDS: 300,
  FEED_MARKET_LIMIT: 60,
  COMMISSION_RATE: 0.025,
  FAUCET_MAX_CENTS: 100000,
  MIN_STAKE_CENTS: 100,
  MAX_STAKE_CENTS: 100000,
  // scrypt cost for password hashing. The default is OWASP's recommended
  // floor and costs ~160ms per login. Tests pin a lower value (see the
  // process.env preamble in each suite) because they create many accounts and
  // the cost is paid per hash; production must not lower this.
  SCRYPT_N: 65536,
  BOT_ENABLED: true,
  // ── Market-maker risk (Phase 2) ──────────────────────────────────────────
  // A missing risk row defaults to these, NOT to unlimited. An unconfigured
  // market maker with no cap is precisely the unbounded-loss case lib/risk.js
  // exists to close.
  RISK_MAX_LIABILITY_CENTS: 5000000,   // how far the bot may go into debt
  RISK_MAX_DAILY_LOSS_CENTS: 1000000,  // realised daily loss floor
  RISK_QUOTE_SKEW: 0.5,                // 0..1 — ticks of widening at full pressure
  RISK_MAX_SKEW_TICKS: 20,             // ticks of widening at skew=1, pressure=1
  // Jurisdiction gating is only as good as its source of truth. OFF by
  // default, and the header is IGNORED when off — a client-declared country
  // is not a jurisdiction, and trusting one would make the control defeatable
  // by editing a header while still being recorded as enforced.
  //
  // Turn on ONLY when every request provably passed through an edge that
  // OVERWRITES the country header. lib/config.js pins HOST to loopback, so the
  // intended deployment (app behind a reverse proxy) makes that true.
  TRUST_PROXY_JURISDICTION: false,
  // Cash-out: the VENUE quotes the buyout price from its own fair prices,
  // minus this margin. It is the venue's edge — a market hedge has none (see
  // lib/cashout.js for why hedging a multi-runner position is provably
  // value-destroying). 200bps = 2%.
  CASHOUT_ENABLED: true,
  CASHOUT_MARGIN_BPS: 200,
  // ── Operations ──────────────────────────────────────────────────────────
  // Token for /metrics and the backup control. UNSET means they 404 rather
  // than leaking balances to anyone who can reach the port. /healthz and
  // /readyz stay open because a supervisor has to reach them.
  OPS_TOKEN: null,
  // ── Results feed transport ────────────────────────────────────────────────
  // The venue POSTs its pending markets to this URL and expects outcomes back.
  // Unset (the default) means the venue settles by hand or by webhook, which is
  // a legitimate way to run — so this is not required, but RESULTS_POLL_INTERVAL_MS
  // without it is a knob that does nothing, and the boot log says so.
  RESULTS_FEED_URL: '',
  RESULTS_FEED_SECRET: null,
  // AES-256-GCM key for the feed collector's Betfair credentials, as 64 hex
  // characters. UNSET BY DEFAULT, and unset means the venue REFUSES to store a
  // credential rather than falling back to plaintext. Same stance as the RG
  // controls: "not configured" is never quietly treated as "allowed".
  FEED_CREDENTIALS_KEY: null,
  RESULTS_FEED_TIMEOUT_MS: 10000,
  // Where snapshots live. Unset DISABLES the scheduled backup — the log says
  // so at boot rather than silently never backing up.
  BACKUP_DIR: null,
  BACKUP_RETENTION: 24,
  // Concurrent SSE streams. Every stream is a held socket the server writes to
  // periodically, so this is a genuine memory ceiling — but it is ALSO the
  // difference between a live board and a dead one, so it is not 100.
  MAX_SSE_CLIENTS: 2000,
  // Per-CALLER bounds on the stream pool, and the reason there is more than one
  // number. A single global cap is a lottery: every stream costs the venue the
  // same and an unauthenticated one returns nothing but public book frames, so
  // one script could take all 2000 of them.
  //   PER_SOURCE  bounds ANONYMOUS streams from one address (the described
  //               attack). It counts anonymous streams only on purpose —
  //               counting every stream from the address would let a flood
  //               lock out the player sitting behind the same NAT.
  //   PER_USER    bounds streams latched to one account, which is the "per
  //               user" half: one account in 2000 tabs is still one account.
  // A fifth of the pool is reserved for authenticated players regardless
  // (server.js, ANON_POOL_SHARE). 0 disables a bound.
  MAX_SSE_CLIENTS_PER_SOURCE: 20,
  MAX_SSE_CLIENTS_PER_USER: 8,
  // Request-volume limits, per user per minute. CONFIGURABLE because they are
  // a tuning knob, not a law: a scalper legitimately fires many orders, and
  // an operator needs to raise a bound they set without a code change. 0
  // disables the bucket entirely — which is how the load test measures the
  // ENGINE rather than the limiter.
  //
  // `auth` is the pair that pays the key-derivation cost, and it is keyed on
  // the SOURCE rather than a user because neither route has a session yet.
  // 60/minute is ~1 per second: far above what an operator registering or
  // signing in a handful of accounts does, and ~16% of one core of scrypt at
  // the OWASP default N — bounded rather than eliminated, which is what a
  // volume limit on a KDF route can be.
  RATE_LIMIT_AUTH: 60,
  RATE_LIMIT_TRADE: 120,
  RATE_LIMIT_CASHOUT: 30,
  RATE_LIMIT_ADMIN: 240,
  RATE_LIMIT_WALLET: 60,
  RATE_LIMIT_READ: 600,
  // ── Cash-out venue risk ────────────────────────────────────────────────
  // Phase 2's bot liability cap did not travel to cash-out, and cash-out is
  // an easier way to lose: the player picks WHEN to take the offer, so they
  // take it when the venue is worst exposed.
  CASHOUT_MAX_OUTSTANDING_CENTS: 2000000,  // total unpaid exposure ($20k)
  // Total cash-out OUTLAY today ($5k), not realised loss. lib/cashoutrisk.js
  // gates on outlay deliberately: realised loss is backward-looking, so by the
  // time it is measurable the money is gone, whereas outlay is known at decision
  // time and genuinely bounds the worst case. realisedLossToday is still
  // computed, but only for reporting to the desk.
  CASHOUT_MAX_DAILY_LOSS_CENTS: 500000,
  // ── Responsible gambling ───────────────────────────────────────────────
  // Session limit, reality-check interval, and rolling 24-hour deposit limit,
  // all in minutes/cents. 0 means NOT CONFIGURED (not "unlimited but
  // enforced"): there is no session limit that is correct for every operator,
  // and hard-coding one would be the same mistake as hard-coding a PSP. The
  // server warns at boot when all three are unset, because a demo deployment
  // reaching production unguarded is the failure this is here to prevent.
  // Age verification is deliberately NOT here: it is an identity/KYC control
  // with its own (external) verification provider, not a limit.
  RG_SESSION_MINUTES: 0,
  // Idle gap after which a new sign-in starts a FRESH session. The session
  // clock is never reset by signing out — that made the limit defeatable in one
  // click, and (because the clock is per-user) one logout cleared it for every
  // other live session too. This is the only path to a new session: walking
  // away and coming back.
  RG_SESSION_IDLE_RESET_MINUTES: 15,
  RG_REALITY_CHECK_MINUTES: 0,
  RG_DEPOSIT_DAILY_CENTS: 0,
  // ── Deposit limits ─────────────────────────────────────────────────────
  // Per-intent and per-user-per-day caps on confirmed deposits. The outside
  // audit's critical finding was a player-confirmable deposit intent with NO
  // cap on the confirmation path — the faucet cap existed only on the faucet
  // route, and the confirmation credited with Number.MAX_SAFE_INTEGER as the
  // ceiling. These bound the blast radius of ANY confirmation path, including
  // a compromised webhook.
  DEPOSIT_MAX_CENTS: 100000,        // $1,000 per intent
  DEPOSIT_DAILY_MAX_CENTS: 500000,  // $5,000 cumulative per user per day
  DRIFT_ENABLED: true,
  DRIFT_INTERVAL_MS: 5000,
  SESSION_TTL_DAYS: 30,
  // Optional overrides for the SEEDED demo credentials (lib/seed.js consumes
  // these on first run). null means "use the seeded defaults" (admin123 /
  // demo123) — server.js warns loudly at boot while those are active.
  ADMIN_PASSWORD: null,
  DEMO_PASSWORD: null,
};

// The only interfaces the exchange may bind to.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function parseEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, 'utf-8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function intVal(raw, name, lo, hi) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < lo || n > hi) {
    throw new Error(`config: ${name} must be an integer in [${lo}, ${hi}] (got ${JSON.stringify(raw)})`);
  }
  return n;
}

function boolVal(raw, name) {
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  throw new Error(`config: ${name} must be true or false (got ${JSON.stringify(raw)})`);
}

// Passthrough for secret strings (seeded-credential overrides): the value is
// returned exactly as provided, or null when unset/empty. Deliberately NO
// trimming and NO charset policy — a password is whatever the operator says
// it is, including leading/trailing whitespace.
function secretVal(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw);
  return s.length > 0 ? s : null;
}

/**
 * A 32-byte key, hex-encoded. Returns a Buffer, or null when unset.
 *
 * Rejects a wrong-length value LOUDLY at boot rather than at first use: an
 * operator who typed 63 hex characters should find out immediately, not when
 * an admin saves a credential and the save fails with a decryption error. And
 * returns null (not an error) when simply unset, because "not configured" is a
 * legitimate state the venue may be in until they want the feature.
 */
function hexKey32(name, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const s = String(raw).trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error(
      `${name} must be exactly 64 hex characters (32 bytes) for AES-256-GCM; got ${s.length} characters`
    );
  }
  return Buffer.from(s, 'hex');
}

function loadConfig(envFile, overrides) {
  const raw = Object.assign({}, DEFAULTS, parseEnvFile(envFile), overrides || {});
  const cfg = {};

  cfg.PORT = intVal(raw.PORT, 'PORT', 1, 65535);
  cfg.HOST = String(raw.HOST || '').trim() || DEFAULTS.HOST;
  // Loopback only. This app ships seeded admin credentials and has no
  // real-money controls, so binding it to a routable interface by accident
  // (0.0.0.0 / ::) must be a hard launch failure, not a silent exposure.
  if (!LOOPBACK_HOSTS.has(cfg.HOST)) {
    throw new Error(
      `config: HOST must be a loopback address (${[...LOOPBACK_HOSTS].join(', ')}) (got ${JSON.stringify(raw.HOST)})`
    );
  }

  cfg.DB_PATH = String(raw.DB_PATH || '').trim() || DEFAULTS.DB_PATH;
  // Resolve relative DB paths against the project root, not the cwd, so the
  // server can be started from anywhere. (':memory:' stays special.)
  if (cfg.DB_PATH !== ':memory:' && !path.isAbsolute(cfg.DB_PATH)) {
    cfg.DB_PATH = path.join(__dirname, '..', cfg.DB_PATH);
  }

  cfg.FEED_ENABLED = boolVal(raw.FEED_ENABLED, 'FEED_ENABLED');
  cfg.FEED_RUNNER_ENABLED = boolVal(raw.FEED_RUNNER_ENABLED, 'FEED_RUNNER_ENABLED');
  // 1 or 2, nothing else. A feed number that silently fell back to a default
  // would serve prices to a venue that asked for fixtures only — or, worse,
  // hide the price column from one that wanted it.
  cfg.FEED_NUMBER = intVal(raw.FEED_NUMBER, 'FEED_NUMBER', 1, 2);
  cfg.FEED_DATABASE_URL = String(raw.FEED_DATABASE_URL || '').trim();
  cfg.FEED_COLLECTOR_CMD = String(raw.FEED_COLLECTOR_CMD || '').trim();
  if (cfg.FEED_COLLECTOR_CMD.split(/\s+/).length === 0 || !cfg.FEED_COLLECTOR_CMD.split(/\s+/)[0]) {
    cfg.FEED_COLLECTOR_CMD = DEFAULTS.FEED_COLLECTOR_CMD;
  }
  cfg.FEED_RUNNER_MIN_UPTIME_SECONDS = intVal(raw.FEED_RUNNER_MIN_UPTIME_SECONDS, 'FEED_RUNNER_MIN_UPTIME_SECONDS', 0, 86400);
  // A feed that is switched on but unconfigured would otherwise fail on the
  // first board request with an opaque driver error; refuse to launch instead.
  if (cfg.FEED_ENABLED && !cfg.FEED_DATABASE_URL) {
    throw new Error('config: FEED_ENABLED=true requires FEED_DATABASE_URL');
  }
  if (cfg.FEED_RUNNER_ENABLED && !cfg.FEED_ENABLED) {
    console.warn('[config] FEED_RUNNER_ENABLED=true but FEED_ENABLED=false — the runner is inert.');
  }
  if (cfg.FEED_RUNNER_ENABLED && !cfg.FEED_CREDENTIALS_KEY) {
    // Loud, and refuses to start the runner rather than degrading: a supervisor
    // with no key has no credentials to hand a child, so every launch would fail
    // identically. Better to say so once at boot than repeatedly in a log.
    console.warn('[config] FEED_RUNNER_ENABLED=true but FEED_CREDENTIALS_KEY is unset.');
    console.warn('[config] The collector cannot be started. Set it with:  openssl rand -hex 32');
  }
  if (cfg.FEED_DATABASE_URL && !/^postgres(ql)?:\/\//.test(cfg.FEED_DATABASE_URL)) {
    throw new Error(
      `config: FEED_DATABASE_URL must be a postgres:// URL (got ${JSON.stringify(cfg.FEED_DATABASE_URL)})`
    );
  }
  cfg.FEED_STALE_SECONDS = intVal(raw.FEED_STALE_SECONDS, 'FEED_STALE_SECONDS', 30, 86400);
  cfg.FEED_MARKET_LIMIT = intVal(raw.FEED_MARKET_LIMIT, 'FEED_MARKET_LIMIT', 1, 500);

  const rate = Number(raw.COMMISSION_RATE);
  if (!Number.isFinite(rate) || rate < 0 || rate > 0.2) {
    throw new Error(`config: COMMISSION_RATE must be a number in [0, 0.2] (got ${JSON.stringify(raw.COMMISSION_RATE)})`);
  }
  cfg.COMMISSION_RATE = rate;

  const skew = Number(raw.RISK_QUOTE_SKEW);
  if (!Number.isFinite(skew) || skew < 0 || skew > 1) {
    throw new Error(`config: RISK_QUOTE_SKEW must be a number in [0, 1] (got ${JSON.stringify(raw.RISK_QUOTE_SKEW)})`);
  }
  cfg.RISK_QUOTE_SKEW = skew;

  cfg.FAUCET_MAX_CENTS = intVal(raw.FAUCET_MAX_CENTS, 'FAUCET_MAX_CENTS', 1, 100000000);
  cfg.MIN_STAKE_CENTS = intVal(raw.MIN_STAKE_CENTS, 'MIN_STAKE_CENTS', 1, 100000000);
  cfg.MAX_STAKE_CENTS = intVal(raw.MAX_STAKE_CENTS, 'MAX_STAKE_CENTS', cfg.MIN_STAKE_CENTS, 1000000000);

  cfg.BOT_ENABLED = boolVal(raw.BOT_ENABLED, 'BOT_ENABLED');
  cfg.DRIFT_ENABLED = boolVal(raw.DRIFT_ENABLED, 'DRIFT_ENABLED');
  // Risk caps are money. Floored at 1 cent (a 0 cap would mean "instantly at
  // the hard limit", i.e. the bot never quotes) and ceiled generously.
  cfg.RISK_MAX_LIABILITY_CENTS = intVal(raw.RISK_MAX_LIABILITY_CENTS, 'RISK_MAX_LIABILITY_CENTS', 1, 100000000000);
  cfg.RISK_MAX_DAILY_LOSS_CENTS = intVal(raw.RISK_MAX_DAILY_LOSS_CENTS, 'RISK_MAX_DAILY_LOSS_CENTS', 1, 100000000000);
  cfg.RISK_MAX_SKEW_TICKS = intVal(raw.RISK_MAX_SKEW_TICKS, 'RISK_MAX_SKEW_TICKS', 0, 200);
  cfg.TRUST_PROXY_JURISDICTION = boolVal(raw.TRUST_PROXY_JURISDICTION, 'TRUST_PROXY_JURISDICTION');
  cfg.CASHOUT_ENABLED = boolVal(raw.CASHOUT_ENABLED, 'CASHOUT_ENABLED');
  cfg.CASHOUT_MARGIN_BPS = intVal(raw.CASHOUT_MARGIN_BPS, 'CASHOUT_MARGIN_BPS', 0, 5000);
  // Secrets stay strings: never trimmed to "unset", because an operator who
  // sets a one-character token must still get that token.
  cfg.OPS_TOKEN = raw.OPS_TOKEN && String(raw.OPS_TOKEN).length ? String(raw.OPS_TOKEN) : null;
  cfg.RESULTS_FEED_URL = String(raw.RESULTS_FEED_URL || '').trim();
  // http(s) only. A results feed is a POST target and a config mistake here
  // would otherwise become an outbound request to whatever scheme a typo
  // produced (file:, gopher:), which is not something a venue should be able
  // to configure by accident.
  if (cfg.RESULTS_FEED_URL && !/^https?:\/\//.test(cfg.RESULTS_FEED_URL)) {
    throw new Error(
      `config: RESULTS_FEED_URL must be an http(s):// URL (got ${JSON.stringify(cfg.RESULTS_FEED_URL)})`
    );
  }
  cfg.RESULTS_FEED_SECRET = secretVal(raw.RESULTS_FEED_SECRET);
  cfg.FEED_CREDENTIALS_KEY = hexKey32('FEED_CREDENTIALS_KEY', raw.FEED_CREDENTIALS_KEY);
  cfg.RESULTS_FEED_TIMEOUT_MS = intVal(raw.RESULTS_FEED_TIMEOUT_MS, 'RESULTS_FEED_TIMEOUT_MS', 250, 120000);
  // A feed with no secret is allowed but worth refusing to be quiet about: the
  // results endpoint decides who gets paid, and an unauthenticated one is
  // settleable by anyone who can reach it.
  if (cfg.RESULTS_FEED_URL && !cfg.RESULTS_FEED_SECRET) {
    console.warn('[config] RESULTS_FEED_URL is set with no RESULTS_FEED_SECRET — the feed is unauthenticated.');
  }
  if (!cfg.FEED_CREDENTIALS_KEY) {
    console.warn('[config] FEED_CREDENTIALS_KEY is not set.');
    console.warn('[config] Betfair credentials CANNOT be stored, and the feed collector cannot be');
    console.warn('[config] started. Generate one with:  openssl rand -hex 32');
    console.warn('[config] Credentials are refused rather than stored in plaintext.');
  }
  // The supervisor spawns argv[0] with the rest as arguments. Returned split so
  // neither module has to re-parse it, and so a command with no executable in
  // it fails here at boot rather than as an ENOENT in a child process.
  cfg.collectorCommand = function collectorCommand() {
    const parts = cfg.FEED_COLLECTOR_CMD.trim().split(/\s+/).filter(Boolean);
    return parts.length ? parts : DEFAULTS.FEED_COLLECTOR_CMD.split(/\s+/);
  };
  cfg.BACKUP_DIR = raw.BACKUP_DIR && String(raw.BACKUP_DIR).length ? String(raw.BACKUP_DIR) : null;
  cfg.BACKUP_RETENTION = intVal(raw.BACKUP_RETENTION, 'BACKUP_RETENTION', 1, 1000);
  cfg.MAX_SSE_CLIENTS = intVal(raw.MAX_SSE_CLIENTS, 'MAX_SSE_CLIENTS', 10, 1000000);
  cfg.MAX_SSE_CLIENTS_PER_SOURCE = intVal(raw.MAX_SSE_CLIENTS_PER_SOURCE, 'MAX_SSE_CLIENTS_PER_SOURCE', 0, 1000000);
  cfg.MAX_SSE_CLIENTS_PER_USER = intVal(raw.MAX_SSE_CLIENTS_PER_USER, 'MAX_SSE_CLIENTS_PER_USER', 0, 1000000);
  cfg.RATE_LIMIT_AUTH = intVal(raw.RATE_LIMIT_AUTH, 'RATE_LIMIT_AUTH', 0, 1000000);
  cfg.RATE_LIMIT_TRADE = intVal(raw.RATE_LIMIT_TRADE, 'RATE_LIMIT_TRADE', 0, 1000000);
  cfg.RATE_LIMIT_CASHOUT = intVal(raw.RATE_LIMIT_CASHOUT, 'RATE_LIMIT_CASHOUT', 0, 1000000);
  cfg.RATE_LIMIT_ADMIN = intVal(raw.RATE_LIMIT_ADMIN, 'RATE_LIMIT_ADMIN', 0, 1000000);
  cfg.RATE_LIMIT_WALLET = intVal(raw.RATE_LIMIT_WALLET, 'RATE_LIMIT_WALLET', 0, 1000000);
  cfg.RATE_LIMIT_READ = intVal(raw.RATE_LIMIT_READ, 'RATE_LIMIT_READ', 0, 1000000);
  cfg.CASHOUT_MAX_OUTSTANDING_CENTS = intVal(raw.CASHOUT_MAX_OUTSTANDING_CENTS, 'CASHOUT_MAX_OUTSTANDING_CENTS', 0, 100000000000);
  cfg.CASHOUT_MAX_DAILY_LOSS_CENTS = intVal(raw.CASHOUT_MAX_DAILY_LOSS_CENTS, 'CASHOUT_MAX_DAILY_LOSS_CENTS', 0, 100000000000);
  cfg.DEPOSIT_MAX_CENTS = intVal(raw.DEPOSIT_MAX_CENTS, 'DEPOSIT_MAX_CENTS', 1, 100000000000);
  cfg.RG_SESSION_MINUTES = intVal(raw.RG_SESSION_MINUTES, 'RG_SESSION_MINUTES', 0, 1440);
  cfg.RG_REALITY_CHECK_MINUTES = intVal(raw.RG_REALITY_CHECK_MINUTES, 'RG_REALITY_CHECK_MINUTES', 0, 1440);
  cfg.RG_SESSION_IDLE_RESET_MINUTES = intVal(raw.RG_SESSION_IDLE_RESET_MINUTES, 'RG_SESSION_IDLE_RESET_MINUTES', 0, 1440);
  cfg.RG_DEPOSIT_DAILY_CENTS = intVal(raw.RG_DEPOSIT_DAILY_CENTS, 'RG_DEPOSIT_DAILY_CENTS', 0, 100000000000);
  cfg.DEPOSIT_DAILY_MAX_CENTS = intVal(raw.DEPOSIT_DAILY_MAX_CENTS, 'DEPOSIT_DAILY_MAX_CENTS', 1, 100000000000);
  // HMAC secret for the payments webhook. UNSET means the webhook 404s — the
  // safe default, because a confirmable deposit path with no authentication
  // is exactly the critical bug the outside audit found.
  cfg.PAYMENTS_WEBHOOK_SECRET = raw.PAYMENTS_WEBHOOK_SECRET && String(raw.PAYMENTS_WEBHOOK_SECRET).length ? String(raw.PAYMENTS_WEBHOOK_SECRET) : null;
  cfg.DRIFT_INTERVAL_MS = intVal(raw.DRIFT_INTERVAL_MS, 'DRIFT_INTERVAL_MS', 1000, 3600000);
  cfg.SESSION_TTL_DAYS = intVal(raw.SESSION_TTL_DAYS, 'SESSION_TTL_DAYS', 1, 365);

  // Bounded below at 16384: scrypt's cost is exponential in N, and an
  // accidental SCRYPT_N=2 would silently make every password trivially
  // crackable while still looking correctly formatted.
  cfg.SCRYPT_N = intVal(raw.SCRYPT_N, 'SCRYPT_N', 16384, 1048576);

  // Seeded-credential overrides (S13): passthrough strings, null when unset.
  // Consumed by lib/seed.js on first run; server.js warns at boot when the
  // seeded defaults remain active (unset here AND the stored hash verifies).
  cfg.ADMIN_PASSWORD = secretVal(raw.ADMIN_PASSWORD);
  cfg.DEMO_PASSWORD = secretVal(raw.DEMO_PASSWORD);

  return cfg;
}

let config;
try {
  // Process env wins over the .env file (standard Node expectation; also lets
  // tests force DRIFT_ENABLED=false etc. without touching files).
  config = loadConfig(path.join(__dirname, '..', '.env'), process.env);
} catch (e) {
  console.error('[config] aborting launch:', e.message);
  process.exit(1);
}

module.exports = config;
module.exports.loadConfig = loadConfig;
