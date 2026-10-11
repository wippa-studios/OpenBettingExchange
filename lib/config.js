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
  cfg.FEED_DATABASE_URL = String(raw.FEED_DATABASE_URL || '').trim();
  // A feed that is switched on but unconfigured would otherwise fail on the
  // first board request with an opaque driver error; refuse to launch instead.
  if (cfg.FEED_ENABLED && !cfg.FEED_DATABASE_URL) {
    throw new Error('config: FEED_ENABLED=true requires FEED_DATABASE_URL');
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
