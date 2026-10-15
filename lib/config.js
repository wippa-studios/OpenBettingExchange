'use strict';
// lib/config.js — .env loader + validation (zero deps beyond node builtins).
// House pattern: validate at boot, abort with a clear error on bad values
// instead of failing later (wippa-bet-agent config.py style).
const fs = require('fs');
const path = require('path');

// The API contract version, emitted as `X-API-Version` on every /api response.
//
// A STANDALONE CONSTANT AND NOT A CONFIG KEY, and that is the whole design.
// Almost everything else in this file is deployment config: the operator tunes
// it, and it arrives from the environment. This one describes the CODE.
//
// The asymmetry is load-bearing. If an operator could set it, they could announce
// version 2 from a .env while still serving version 1, and every client that
// trusted the header would be wrong in a way nothing could detect — a contract
// version that lies is worse than no contract version at all. So there is no
// raw.API_VERSION read anywhere and no intVal line; the only way to move it is to
// edit this line, which lands in review.
//
// Bump it when the contract genuinely moves, and record what changed. See
// docs/API.md for the stability policy that makes the promise meaningful.
const API_VERSION = '1';


// The ONE currency the venue trades in (#104).
//
// This key exists because the currency used to be a hard-coded literal at EIGHT
// sites — two in lib/accounts.js, four in lib/payments/ (two of them a default
// parameter its own caller ignored) and two column defaults in lib/store.js —
// writing into columns that were read by nothing. A value nobody reads cannot
// be a venue setting; it is a default dressed up as data. So the currency is
// now READ — by lib/accounts.js, by lib/payments/, by /api/branding and by the
// browser's formatter — and this is where an operator sets it.
//
// AUD, not USD, because this deployment is an Australian venue (#138). The old
// default was not a decision about the venue; it was the first thing someone
// typed. Anything that is not one currency per venue has to be earned with a
// written FX policy, not inherited from a literal: see lib/accounts.js and
// docs/EXCHANGE_RULES.md for what multi-currency would cost.
const DEFAULTS = {
  PORT: 7777,
  HOST: '127.0.0.1',
  DB_PATH: 'data/openbettingexchange.db',
  // Seeded onto the default tenant's row and READ back from there — by
  // lib/accounts.js, lib/payments/, /api/branding and the browser's formatter.
  // It is also the schema default for the three currency columns, so an insert
  // that forgets one gets the venue's own money rather than a stale constant.
  VENUE_CURRENCY: 'AUD',
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
  // WHICH IMPLEMENTATION OF THE FEED CONTRACT SERVES THE BOARD — 'postgres' or
  // 'http'. Default 'postgres', which is byte-for-byte the behaviour this
  // deployment had before the seam existed, and that is the requirement rather
  // than an accident: the default venue must not change in any observable way.
  //
  // 'http' points the venue at the OPERATOR'S OWN data-feed API — the case that
  // could not be served at all before, because lib/feed.js's SQL was hard-wired
  // to the collector's `v_feed1`/`v_feed2` and the only alternative was forking
  // it. STATE.md §2.7 names the real blocker, though, and it is not the SQL: an
  // adapter that half-works does not crash, it produces wrong prices or wrong
  // market state, which the engine cannot detect. That is why the conformance
  // suite (tests/feedprovider-conformance.test.js) ships in the same change as
  // the first adapter, and why lib/feed/provider.js refuses to register a
  // provider whose name is not in its own capability table. (A review gate, not
  // a runtime one — see that file's header for why the registry cannot run an
  // offline battery and should not try.)
  FEED_PROVIDER: 'postgres',
  // The collector command. Split on whitespace so it can be an absolute path or
  // a PATH lookup, and so an operator can prefix it with a wrapper (uv, podman,
  // a systemd unit) without this code learning about any of that.
  FEED_COLLECTOR_CMD: 'betfeed collect',
  // Seconds the exchange waits after a credential change before restarting the
  // collector. Non-zero by default because a wrong credential produces an
  // immediate, repeating failure, and a supervisor that retries on every change
  // turns an operator's typo into a login flood against Betfair.
  FEED_RUNNER_MIN_UPTIME_SECONDS: 120,
  // ── HTTP feed provider (the operator's own data-feed API) ────────────────
  // Everything below is inert unless FEED_PROVIDER=http. It exists so an
  // Australian operator holding a betting-exchange licence can point this venue
  // at THEIR OWN JSON-over-HTTP feed without writing a line of code — which is
  // the customer this seam was built for.
  //
  // The defaults below are IDENTITY: every canonical field maps to the field of
  // the same name. That is the right default because a vendor whose API is
  // already shaped like Betfair's needs no configuration at all, and because a
  // written-out map doubles as the documentation of WHICH fields can be renamed
  // — an operator reads .env.example, sees the whole vocabulary, and knows the
  // exact spelling their own API has to match.
  //
  // It is deliberately NOT '' meaning "identity". An empty map cannot be told
  // from a misconfigured one, and a misconfigured map yields markets with no id,
  // no name and no runners — which render as an empty board that looks like a
  // quiet Tuesday. A blank here is a BOOT ERROR instead.
  FEED_HTTP_URL: '',
  FEED_HTTP_BOARD_PATH: '/board',
  // `{id}` is replaced, percent-encoded. With no placeholder the id is appended
  // as `?id=`, because guessing wrong is something the operator should not have
  // to discover from a 404.
  FEED_HTTP_MARKET_PATH: '/market',
  // The nav tree is built from the CATALOGUE, not from the capped board: the
  // board is limited to FEED_MARKET_LIMIT markets and a tree built from a capped
  // list is a tree with most of the sport missing from it.
  FEED_HTTP_CATALOGUE_PATH: '/catalogue',
  FEED_HTTP_HEALTH_PATH: '/health',
  // A bearer token. Never logged, never echoed in an error, never published by a
  // route — it goes on the wire and nowhere else. Blank is a legitimate state
  // (an operator's API may be behind the venue's own edge with no token at all),
  // which is why it is not REQUIRED the way the base URL is.
  FEED_HTTP_TOKEN: null,
  // A static header, for the vendors that authenticate with `X-Api-Key` and
  // friends rather than with a bearer token. The NAME is not a secret; the
  // VALUE is a credential in every real deployment, which is why .env.example
  // ships it blank.
  FEED_HTTP_HEADER_NAME: '',
  FEED_HTTP_HEADER_VALUE: '',
  // One attempt per request, then this timeout. No retry loop: retrying a feed
  // that is already slow turns one slow upstream into N concurrent slow
  // upstreams and the venue pays for it in sockets.
  FEED_HTTP_TIMEOUT_MS: 10000,
  // IN-FLIGHT REQUESTS, capped. The Postgres provider was implicitly bounded by
  // `new Pool({ max: 4 })`: four sockets, everything else queued inside the
  // driver. HTTP removed that bound — Node's global fetch agent is uncapped — so
  // N concurrent board requests opened N sockets to the operator's own licensed
  // feed API, each able to buffer up to 8 MiB, and nothing in the route chain
  // stopped N from arriving.
  //
  // The default is 4 BECAUSE THAT IS WHAT THE POSTGRES PATH HAD. Not because 4
  // is a number anyone measured for an HTTP feed: a venue whose feed API is
  // local and fast can raise it, and one behind a slow link can lower it. What
  // is not negotiable is that it is a number.
  FEED_HTTP_MAX_CONCURRENCY: 4,
  // AND A BOUNDED QUEUE, because an unbounded wait queue is the same exhaustion
  // with a longer fuse: the callers still hold their requests, responses and
  // timers, and the venue still runs out of memory — later, and with a much
  // worse log. Queue full is a fast failure with the provider's own generic
  // error, never a longer wait.
  //
  // A wait is bounded by FEED_HTTP_TIMEOUT_MS, the same budget the request
  // itself gets, so one call cannot spend two.
  FEED_HTTP_MAX_QUEUE: 16,
  // Does this feed carry prices at all? The HTTP provider's analogue of
  // FEED_NUMBER=1 — a fixtures-only catalogue, which must render with empty
  // ladders and read as stale rather than as a broken feed.
  FEED_HTTP_PRICED: true,
  // Multiplied into every ladder size before it reaches the shaper. The
  // canonical unit is POUNDS — Betfair's — because lib/feed/shape.js converts
  // pounds to integer cents once, for both providers, and must not fork. Set
  // 0.01 for a vendor publishing cents. Getting this wrong is a 100x error on
  // every stake shown to a bettor, so it is a config key with a stated unit
  // rather than something the mapper guesses at.
  FEED_HTTP_SIZE_SCALE: 1,
  // The field maps. `key=path,key=path`, dotted paths, a bare `key` meaning
  // `key=key`. They are PARSED HERE, at boot, by the SAME parser the provider
  // uses (lib/feed/fieldmap.js), so a typo or a missing required field aborts
  // the launch with a message naming the key — rather than serving an empty
  // board to a venue that believes it has a live one.
  FEED_HTTP_MAP_BOARD:
    'markets=markets,market_id=market_id,market_name=market_name,market_start_time=market_start_time,' +
    'market_status=market_status,fixture_id=fixture_id,event_name=event_name,sport_slug=sport_slug,' +
    'event_type_id=event_type_id,event_type_name=event_type_name,competition_id=competition_id,' +
    'competition_name=competition_name,country_code=country_code,fixture_venue=fixture_venue,' +
    'market_type_code=market_type_code,market_venue=market_venue,is_resolved=is_resolved,' +
    'total_matched=total_matched,inplay=inplay,bet_delay=bet_delay,publish_time=publish_time,' +
    'odds_captured_at=odds_captured_at,runners=runners,selection_id=selection_id,' +
    'runner_name=runner_name,sort_priority=sort_priority,handicap=handicap,' +
    'selection_status=selection_status,odds=odds,back=back,lay=lay,price=price,size=size,' +
    'last_price_traded=last_price_traded',
  FEED_HTTP_MAP_NAV:
    'markets=markets,market_id=market_id,market_name=market_name,market_time=market_time,' +
    'market_type=market_type,market_status=market_status,number_of_winners=number_of_winners,' +
    'sport=sport,sport_id=sport_id,sport_name=sport_name,country=country,competition=competition,' +
    'event_id=event_id,event_name=event_name,event_time=event_time,in_play=in_play',
  FEED_HTTP_MAP_HEALTH:
    'markets=markets,markets_with_odds=markets_with_odds,resolved=resolved,newest_book=newest_book,' +
    'oldest_book=oldest_book,newest_publish=newest_publish',
  // A snapshot older than this is reported as stale rather than served as live.
  // The recorder runs on a DELAYED Betfair key, which batches on a ~3 minute
  // cadence, so the default is deliberately a little over one cycle.
  FEED_STALE_SECONDS: 300,
  FEED_MARKET_LIMIT: 60,
  COMMISSION_RATE: 0.025,
  FAUCET_MAX_CENTS: 100000,
  MIN_STAKE_CENTS: 100,
  MAX_STAKE_CENTS: 100000,
  // MARKET VERSION MATERIALITY (#92). How many book-altering events on a
  // selection or a market are TOLERATED between the version a client read and
  // the one it submits with its order, before the venue refuses it as stale.
  //
  // CONFIG, and not a constant, because the correct number is a property of the
  // venue's own liquidity: this one's market maker cancels and requotes every
  // DRIFT_INTERVAL_MS, so a book advances under a client's feet whether or not
  // anybody is trading. Zero would refuse ordinary ladder clicks; a large
  // number makes the control decorative. The argument for 2, and what would make
  // it wrong, is written out in docs/EXCHANGE_RULES.md — it is a judgement
  // call, so it belongs somewhere an operator can move it rather than somewhere
  // only a code edit can.
  //
  // 0 is a legitimate setting and means "refuse on ANY movement": correct for a
  // client that re-reads between every click, and the boundary the tests pin.
  MARKET_VERSION_MATERIAL_THRESHOLD: 2,
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

// An ISO-4217-shaped currency code: three ASCII letters, and the venue's own
// in upper case.
//
// UPPERCASE IS REQUIRED rather than normalised, because a lowercase code means
// two different spellings of one currency can both exist in the database — and
// the accounts assertion in lib/accounts.js compares these strings, so 'aud'
// and 'AUD' would pass as two accounts in different currencies and then be
// summed as one. The check is the SHAPE, not membership of the ISO registry:
// this codebase deliberately ships no currency table (see the note in
// lib/tenants.js), and an unknown-but-well-formed code is a display question,
// not a money bug.
//
// Shared rather than re-declared: lib/tenants.js imports this so a tenant
// currency and a configured venue currency are held to one rule.
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** True when `code` is a well-formed currency code. Never throws. */
function isCurrencyCode(code) {
  return typeof code === 'string' && CURRENCY_CODE.test(code);
}

/**
 * Normalise and validate a currency code for STORAGE. Throws on anything that
 * is not a code, so a bad value is refused where it is set rather than
 * rendered later.
 */
function currencyCode(raw, what) {
  if (!isCurrencyCode(raw)) {
    throw new Error(`${what} must be a three-letter uppercase ISO 4217 code, e.g. AUD (got ${JSON.stringify(raw)})`);
  }
  return raw;
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
  // Not from `raw` — see the API_VERSION note at the top of this file. Deliberately
  // unread from the environment, so the announced version cannot be made to lie.
  cfg.API_VERSION = API_VERSION;

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

  // One currency for the whole venue (#104). Validated HERE, at boot, rather
  // than at the first deposit: a bad code must stop the operator before any
  // row is written with it. See the DEFAULTS note for why one, and lib/accounts.js
  // for why not more than one.
  cfg.VENUE_CURRENCY = currencyCode(String(raw.VENUE_CURRENCY || '').trim(), 'config: VENUE_CURRENCY');

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

  // WHICH PROVIDER ANSWERS, resolved BEFORE anything that depends on the answer.
  //
  // The ordering is load-bearing and it is not decorative. The check immediately
  // below reads `cfg.FEED_PROVIDER`, and it sat BELOW this line once — so on
  // every deployment it saw `undefined`, `undefined === 'postgres'` was false,
  // and `FEED_ENABLED=true` with no FEED_DATABASE_URL stopped being a boot
  // error. It was caught by the conformance suite's "the default deployment is
  // still the collector" check, which is the only reason it could not ship.
  //
  // Two orders are available in a file like this one and neither is obvious from
  // the statement, so: a value another line reads is defined before the line
  // that reads it. That is the whole rule.
  cfg.FEED_PROVIDER = String(raw.FEED_PROVIDER || '').trim() || DEFAULTS.FEED_PROVIDER;
  if (cfg.FEED_PROVIDER !== 'postgres' && cfg.FEED_PROVIDER !== 'http') {
    throw new Error(
      `config: FEED_PROVIDER must be 'postgres' or 'http' (got ${JSON.stringify(raw.FEED_PROVIDER)})`
    );
  }

  // A feed that is switched on but unconfigured would otherwise fail on the
  // first board request with an opaque driver error; refuse to launch instead.
  //
  // SCOPED TO THE POSTGRES PROVIDER, and that scoping is new and load-bearing:
  // an operator running FEED_PROVIDER=http has no collector database at all,
  // and demanding FEED_DATABASE_URL of them would make the provider this seam
  // exists to enable unusable with the most obvious configuration. The message
  // is unchanged for every deployment that has not opted out of the collector.
  if (cfg.FEED_ENABLED && cfg.FEED_PROVIDER === 'postgres' && !cfg.FEED_DATABASE_URL) {
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

  // ── THE HTTP FEED PROVIDER'S OWN CONFIGURATION ─────────────────────────────
  // WHICH PROVIDER ANSWERS was settled above `FEED_ENABLED`'s check, because
  // that check reads it. This block is the other question: is the HTTP
  // provider's configuration coherent enough to be worth starting for?
  //
  // The settings are PARSED, not merely stored. Every field map
  // goes through the provider's own `parseMap`, so the boot-time rules and the
  // runtime rules are ONE implementation rather than two that can disagree:
  //
  //   - an empty or unparseable map is a boot error, not a warning;
  //   - a map naming a field this build does not have is a boot error, because
  //     otherwise it would parse into a map that silently renames nothing;
  //   - a map missing a REQUIRED field is a boot error, because the markets it
  //     would produce have no id, no name or no start time — which render as an
  //     empty board, and an empty board looks like "no fixtures today" rather
  //     than like a misconfiguration. This is the specific hazard STATE.md §2.7
  //     warns about: an adapter that half-works does not crash.
  //
  // Required here rather than only in lib/feed/http.js so the operator is told
  // at LAUNCH, by a process that is about to start, instead of on the first
  // board request from a running venue.
  cfg.FEED_HTTP_URL = String(raw.FEED_HTTP_URL || '').trim();
  cfg.FEED_HTTP_BOARD_PATH = String(raw.FEED_HTTP_BOARD_PATH || '').trim() || DEFAULTS.FEED_HTTP_BOARD_PATH;
  cfg.FEED_HTTP_MARKET_PATH = String(raw.FEED_HTTP_MARKET_PATH || '').trim() || DEFAULTS.FEED_HTTP_MARKET_PATH;
  cfg.FEED_HTTP_CATALOGUE_PATH = String(raw.FEED_HTTP_CATALOGUE_PATH || '').trim() || DEFAULTS.FEED_HTTP_CATALOGUE_PATH;
  cfg.FEED_HTTP_HEALTH_PATH = String(raw.FEED_HTTP_HEALTH_PATH || '').trim() || DEFAULTS.FEED_HTTP_HEALTH_PATH;
  // secretVal, not a trim-to-empty: a one-character token is still a token, and
  // trimming it to "unset" would silently send unauthenticated requests to an
  // operator's licensed feed API.
  cfg.FEED_HTTP_TOKEN = secretVal(raw.FEED_HTTP_TOKEN);
  cfg.FEED_HTTP_HEADER_NAME = String(raw.FEED_HTTP_HEADER_NAME || '').trim();
  cfg.FEED_HTTP_HEADER_VALUE = String(raw.FEED_HTTP_HEADER_VALUE == null ? '' : raw.FEED_HTTP_HEADER_VALUE);
  cfg.FEED_HTTP_TIMEOUT_MS = intVal(raw.FEED_HTTP_TIMEOUT_MS, 'FEED_HTTP_TIMEOUT_MS', 250, 120000);
  // Read here, BEFORE the provider branch, because a bad cap is a bad cap on a
  // postgres deployment too — an operator who typed it while experimenting with
  // the HTTP provider should be told at the next launch, not the one after they
  // switch back. Both floors are 1, not 0: `0` is how an operator expresses
  // "unlimited" everywhere else in this file (a disabled rate-limit bucket, an
  // unset limit), and accepting it here would silently restore the unbounded
  // fan-out this cap exists to remove — a control switched off with a value that
  // looks like it configures something.
  cfg.FEED_HTTP_MAX_CONCURRENCY = intVal(raw.FEED_HTTP_MAX_CONCURRENCY, 'FEED_HTTP_MAX_CONCURRENCY', 1, 512);
  cfg.FEED_HTTP_MAX_QUEUE = intVal(raw.FEED_HTTP_MAX_QUEUE, 'FEED_HTTP_MAX_QUEUE', 1, 4096);
  cfg.FEED_HTTP_PRICED = boolVal(raw.FEED_HTTP_PRICED, 'FEED_HTTP_PRICED');

  const sizeScale = Number(raw.FEED_HTTP_SIZE_SCALE);
  if (!Number.isFinite(sizeScale) || sizeScale <= 0 || sizeScale > 1) {
    throw new Error(
      `config: FEED_HTTP_SIZE_SCALE must be a positive multiplier of 1 or less (got ${JSON.stringify(raw.FEED_HTTP_SIZE_SCALE)})`
    );
  }
  cfg.FEED_HTTP_SIZE_SCALE = sizeScale;

  if (cfg.FEED_PROVIDER === 'http') {
    // A BOOT ERROR, not a warning. The alternative — starting with no base URL —
    // produces a venue whose board 503s on every request with an error naming a
    // configuration key the operator set to `http`, which is the least useful
    // sentence anyone can be handed at 3am.
    if (!cfg.FEED_HTTP_URL) {
      throw new Error('config: FEED_PROVIDER=http requires FEED_HTTP_URL');
    }
    // http(s) only, exactly like RESULTS_FEED_URL. A typo'd scheme would
    // otherwise become an outbound request to whatever the operator's typo
    // produced, which is not something a licensed venue should be able to
    // configure by accident.
    if (!/^https?:\/\//.test(cfg.FEED_HTTP_URL)) {
      throw new Error(
        `config: FEED_HTTP_URL must be an http(s):// URL (got ${JSON.stringify(cfg.FEED_HTTP_URL)})`
      );
    }
    // Userinfo in the URL is refused, and this is a credentials-hygiene rule
    // rather than a syntax one: `https://key@host/` puts a credential in a
    // string that is far more likely to be logged, echoed into a bug report or
    // pasted into a support ticket than the FEED_HTTP_TOKEN that exists to keep
    // it out of exactly those places. FEED_HTTP_TOKEN is the only way to
    // authenticate this provider.
    //
    // Kept ALONGSIDE the composed-origin check below, not replaced by it, and the
    // reason is worth recording because the origin rule looks like it subsumes
    // this one: it does not. `https://key@feeds.example.com.au/board` and
    // `https://feeds.example.com.au/board` have the SAME origin — WHATWG puts
    // `key` in the userinfo and strips it before comparing — so a base carrying a
    // credential passes the origin check while still being exactly the string
    // this rule exists to keep credentials out of. Two checks, two jobs: one says
    // "no credential in a string we log", the other says "a suffix cannot move
    // the request somewhere else".
    if (/^https?:\/\/[^/]*@/.test(cfg.FEED_HTTP_URL)) {
      throw new Error(
        'config: FEED_HTTP_URL must not carry credentials (no "user:pass@"); use FEED_HTTP_TOKEN or FEED_HTTP_HEADER_VALUE'
      );
    }
    //
    // …AND THE SECOND CHECK IS ON THE COMPOSED TARGET, NOT ON THE BASE ALONE,
    // which is what it used to be. The base is only half of the string that is
    // requested: the resource paths are appended to it, and the check below runs
    // after that concatenation. So
    //
    //   FEED_HTTP_URL=https://legit-feed.example.com.au
    //   FEED_HTTP_BOARD_PATH=@evil.example.net/collect
    //
    // composes `https://legit-feed.example.com.au@evil.example.net/collect`,
    // where WHATWG parsing puts the configured host in the USERINFO and
    // `evil.example.net` in the HOST — and the Authorization header goes with it.
    // The old check passed, because the string it looked at had no `@` in it.
    //
    // The rule below is the INVARIANT rather than a spelling of it: a resource
    // path may change the PATH and the QUERY and nothing else. Comparing origins
    // after parsing refuses the `@` case, a protocol-relative path, a backslash,
    // and a path that is itself an absolute URL — every way a suffix can move the
    // authority — in one rule, and it cannot be satisfied by any spelling that
    // lands somewhere else.
    //
    // WHAT IS NOT CLAIMED, because this is defence in depth and not an SSRF
    // control: these keys are operator configuration, `tenants.feed_config` is
    // dead schema and lib/tenants.js accepts none of them, so there is no
    // attacker-reached path to this today. lib/feed/http.js re-checks the
    // composed target on every request, so the invariant holds even for a caller
    // that built a provider without going through this loader.
    for (const key of ['FEED_HTTP_BOARD_PATH', 'FEED_HTTP_MARKET_PATH', 'FEED_HTTP_CATALOGUE_PATH', 'FEED_HTTP_HEALTH_PATH']) {
      const composed = `${cfg.FEED_HTTP_URL.replace(/\/+$/, '')}${cfg[key]}`;
      let origin = null;
      try {
        origin = new URL(composed).origin;
      } catch {
        origin = null;
      }
      if (origin === null || origin !== new URL(cfg.FEED_HTTP_URL).origin) {
        throw new Error(
          `config: ${key} changes the host of FEED_HTTP_URL, which is refused. A resource path may ` +
          'only change the path and the query — an "@", a "//host" or an absolute URL in a path ' +
          'sends the request, and the feed credential, to a host nobody configured.'
        );
      }
    }
    // Required from the DEPENDENCY-FREE fieldmap module, not from
    // lib/feed/http.js. lib/config.js is mid-evaluation when it runs — it calls
    // loadConfig() before it assigns module.exports — so requiring the transport
    // here would hand that transport a half-initialised config to capture for
    // ever. See lib/feed/fieldmap.js's header for what that cost.
    const { parseMap, BOARD_VOCABULARY, NAV_VOCABULARY, HEALTH_VOCABULARY } = require('./feed/fieldmap');
    cfg.FEED_HTTP_MAP_BOARD = String(raw.FEED_HTTP_MAP_BOARD == null ? '' : raw.FEED_HTTP_MAP_BOARD).trim();
    cfg.FEED_HTTP_MAP_NAV = String(raw.FEED_HTTP_MAP_NAV == null ? '' : raw.FEED_HTTP_MAP_NAV).trim();
    cfg.FEED_HTTP_MAP_HEALTH = String(raw.FEED_HTTP_MAP_HEALTH == null ? '' : raw.FEED_HTTP_MAP_HEALTH).trim();
    // The parser is the provider's own, so the vocabulary and the rules can
    // never drift apart; it returns a Map this loader discards, because the
    // provider re-parses from the same validated strings at construction.
    parseMap(cfg.FEED_HTTP_MAP_BOARD, BOARD_VOCABULARY, 'FEED_HTTP_MAP_BOARD');
    parseMap(cfg.FEED_HTTP_MAP_NAV, NAV_VOCABULARY, 'FEED_HTTP_MAP_NAV');
    parseMap(cfg.FEED_HTTP_MAP_HEALTH, HEALTH_VOCABULARY, 'FEED_HTTP_MAP_HEALTH');
    if (cfg.FEED_HTTP_TOKEN && cfg.FEED_HTTP_HEADER_NAME) {
      console.warn('[config] FEED_HTTP_TOKEN and FEED_HTTP_HEADER_NAME are both set — the token wins on Authorization; check the header is what you meant.');
    }
    if (!cfg.FEED_HTTP_TOKEN && !cfg.FEED_HTTP_HEADER_NAME) {
      // Warned about, not refused: "not configured" is a legitimate state for a
      // feed API behind the venue's own edge, and refusing to launch for it would
      // make the key read as a control it is not.
      console.warn('[config] FEED_PROVIDER=http with no FEED_HTTP_TOKEN and no FEED_HTTP_HEADER_NAME — the feed is unauthenticated.');
    }
  } else {
    // Unset, and NOT ''. Same reason RESULTS_FEED_URL defaults to '' and
    // RESULTS_FEED_SECRET to null: an operator reading a config dump must be
    // able to tell "not configured" from "configured with nothing".
    cfg.FEED_HTTP_URL = '';
    cfg.FEED_HTTP_BOARD_PATH = DEFAULTS.FEED_HTTP_BOARD_PATH;
    cfg.FEED_HTTP_MARKET_PATH = DEFAULTS.FEED_HTTP_MARKET_PATH;
    cfg.FEED_HTTP_CATALOGUE_PATH = DEFAULTS.FEED_HTTP_CATALOGUE_PATH;
    cfg.FEED_HTTP_HEALTH_PATH = DEFAULTS.FEED_HTTP_HEALTH_PATH;
    cfg.FEED_HTTP_TOKEN = null;
    cfg.FEED_HTTP_HEADER_NAME = '';
    cfg.FEED_HTTP_HEADER_VALUE = '';
    cfg.FEED_HTTP_TIMEOUT_MS = DEFAULTS.FEED_HTTP_TIMEOUT_MS;
    // Reset to the defaults rather than kept as configured: on a collector
    // deployment these are inert, and an operator reading a config dump should
    // not conclude from a number they once typed that the venue has a feed-API
    // connection cap it is not using.
    cfg.FEED_HTTP_MAX_CONCURRENCY = DEFAULTS.FEED_HTTP_MAX_CONCURRENCY;
    cfg.FEED_HTTP_MAX_QUEUE = DEFAULTS.FEED_HTTP_MAX_QUEUE;
    cfg.FEED_HTTP_PRICED = boolVal(raw.FEED_HTTP_PRICED, 'FEED_HTTP_PRICED');
    cfg.FEED_HTTP_SIZE_SCALE = sizeScale;
    cfg.FEED_HTTP_MAP_BOARD = DEFAULTS.FEED_HTTP_MAP_BOARD;
    cfg.FEED_HTTP_MAP_NAV = DEFAULTS.FEED_HTTP_MAP_NAV;
    cfg.FEED_HTTP_MAP_HEALTH = DEFAULTS.FEED_HTTP_MAP_HEALTH;
  }

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
  // 0..1000. The floor is 0 rather than 1 because "refuse on any movement at
  // all" is a real, defensible configuration for a venue whose clients re-read
  // between every click, and refusing to boot on it would make the knob a
  // policy statement rather than a setting. The ceiling is far above anything
  // meaningful: past a few hundred events the version is no longer a staleness
  // signal, and an operator who sets that has disabled the control while
  // believing they have tuned it.
  //
  // AN EMPTY VALUE IS "UNSET", NOT ZERO, and that needs saying because 0 is a
  // real setting here. `intVal('')` is `Number('')` is `0`, which for every
  // other key in this file is either out of range or indistinguishable from
  // zero-cap semantics that nobody reads as "the strict end of the range".
  // Here it would silently switch the control to its strictest setting — an
  // operator writing the key with nothing after the `=` would get a venue that
  // refuses every versioned order and no error at boot. Treated as unset.
  const rawThreshold = raw.MARKET_VERSION_MATERIAL_THRESHOLD;
  cfg.MARKET_VERSION_MATERIAL_THRESHOLD = intVal(
    rawThreshold === undefined || String(rawThreshold).trim() === '' ? DEFAULTS.MARKET_VERSION_MATERIAL_THRESHOLD : rawThreshold,
    'MARKET_VERSION_MATERIAL_THRESHOLD',
    0,
    1000
  );

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
// The currency-code rule, exported so lib/tenants.js holds a tenant currency
// and a configured venue currency to ONE rule rather than two regexes that can
// drift. Exported as helpers, not a regex, so a caller cannot widen the pattern
// at its call site and end up with two spellings of one currency in the
// database.
module.exports.isCurrencyCode = isCurrencyCode;
module.exports.currencyCode = currencyCode;
