'use strict';
// lib/feedrunner.js — supervises the external feed collector as a child
// process.
//
// WHY A SUPERVISOR RATHER THAN A LIBRARY CALL. The collector is a separate
// program (OpenBettingExchangeDataFeed) that owns a long-lived connection to
// Betfair, holds market-data weight, and decides its own cadence. Embedding it
// as a library would make every Betfair rate limit, every library upgrade and
// every upstream failure an outage of the venue's own process. A child process
// fails in a way the exchange can observe, restart, and — crucially — survive.
//
// THE CONTRACT IS THE ENVIRONMENT. The collector boots from environment
// variables and has no configuration file, which is exactly why the exchange
// never has to write one. Credentials are decrypted per launch and live only
// in the child's environment.
//
// THREE THINGS THIS IS HONEST ABOUT, because each is a real property of the
// design and pretending otherwise would be worse than the limitation:
//
//   1. A CHILD'S ENVIRONMENT IS READABLE. On Linux, `/proc/<pid>/environ` is
//      readable by the same user that started the process. Encrypting at rest
//      protects the database and its backups; it does not make the credential
//      invisible to anyone who can already run code as this user. The
//      alternative — a credentials file — is worse (it persists), and a pipe
//      on stdin is not supported by the collector. Anyone who can read this
//      process's environment can already read this process's memory.
//
//   2. CREDENTIALS ARE NEVER IN ARGV. `ps` is world-readable. Every credential
//      goes through `env`, and `health()` reports the command WITHOUT any
//      interpolated secret, so an operator copying it into a support ticket
//      cannot leak one by accident.
//
//   3. CHILD OUTPUT IS SCRUBBED BEFORE IT IS STORED OR SHOWN. The collector
//      logs its own configuration, and a Betfair error can echo a key or a
//      username. Captured output passes through `redact()` so a credential
//      cannot reach a log file, an admin API response, or a support ticket
//      merely because an upstream error mentioned it.

const { spawn } = require('child_process');
const config = require('./config');
const FC = require('./feedcreds');

// How much child output to keep for /health. Enough to diagnose, bounded so a
// chatty process cannot grow the venue's memory without limit.
const LINE_LIMIT = 200;
const LINE_CHARS = 500;

// Restart backoff. A collector that fails on a bad credential will fail
// instantly and forever; retrying it every second would hammer Betfair's login
// endpoint with a credential we already know is wrong, which is a good way to
// get an account rate-limited or locked.
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;
// Only reset the backoff once the child has stayed up long enough to prove the
// configuration works. Otherwise a crash-loop that survives 10 seconds each
// time resets the backoff to 5s and retries forever. Configurable because the
// right value depends on how long a full fixtures cycle takes: on a fast
// connection a genuine crash is immediate, and a long threshold just delays
// recovery.
function stableAfterMs() {
  return (config.FEED_RUNNER_MIN_UPTIME_SECONDS ?? 120) * 1000;
}

/** One supervisor per tenant. This is a singleton table, not a pool. */
const runners = new Map();

// The database handle is injected at boot rather than required at module load,
// to keep this out of an import cycle with store.js.
let db = null;

function setDb(handle) {
  if (db && db !== handle) {
    throw new Error(
      'feedrunner.setDb called twice with different handles — the supervisor would read the wrong database'
    );
  }
  db = handle;
}

// ── redaction ────────────────────────────────────────────────────────────────

/**
 * Remove any known secret from a line of child output.
 *
 * Exact-value matching only — no clever patterns. A regex trying to recognise
 * "things that look like app keys" would also mangle prices and market ids, and
 * a redaction scheme that garbles output is a redaction scheme operators turn
 * off.
 */
function redact(line, secrets) {
  let out = String(line);
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * The child's environment, built from an ALLOWLIST rather than `...process.env`.
 *
 * Spreading process.env handed the collector EVERY secret the venue holds. The
 * collector needs five variables and was being sent all of them, including
 * PAYMENTS_WEBHOOK_SECRET — the HMAC key that authorises the deposit webhook
 * and therefore the money path — plus OPS_TOKEN and the seeded ADMIN_PASSWORD.
 *
 * The collector is the one component with outbound internet access to Betfair,
 * running third-party Python dependencies from a separate repository. Handing it
 * the key that authorises deposits couples a market-data collector to a payments
 * boundary it has no reason to be near.
 *
 * PATH is forwarded deliberately: `betfeed` is usually a PATH lookup, and
 * dropping it would make the documented default command unusable.
 */
function collectorProcessEnv(collectorEnv) {
  const allow = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HOME', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  const env = {};
  for (const key of allow) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // The decrypted credential, and nothing else of the venue's.
  return { ...env, ...collectorEnv };
}

// ── the supervisor ────────────────────────────────────────────────────────────

function runnerFor(tenantId) {
  return (
    runners.get(tenantId) || {
      tenantId,
      child: null,
      startedAt: null,
      restarts: 0,
      consecutiveFailures: 0,
      lastExit: null,
      lastStartError: null,
      stopping: false,
      timer: null,
      log: [],
    }
  );
}

function pushLog(state, line, secrets) {
  const text = redact(line, secrets).slice(0, LINE_CHARS);
  state.log.push({ at: new Date().toISOString(), line: text });
  if (state.log.length > LINE_LIMIT) state.log.splice(0, state.log.length - LINE_LIMIT);
}

function backoffMs(state) {
  const ms = BACKOFF_START_MS * 2 ** Math.min(state.consecutiveFailures, 10);
  return Math.min(ms, BACKOFF_MAX_MS);
}

/**
 * Why the runner refuses to start. Checked at the point of use so an operator
 * gets a specific answer rather than a child process that exits immediately
 * with an error they have to find in a log.
 */
function readiness() {
  if (!config.FEED_ENABLED) {
    return { ready: false, reason: 'FEED_ENABLED is false' };
  }
  if (!config.FEED_RUNNER_ENABLED) {
    return { ready: false, reason: 'FEED_RUNNER_ENABLED is false (run the collector yourself)' };
  }
  if (!config.FEED_DATABASE_URL) {
    return { ready: false, reason: 'FEED_DATABASE_URL is not set — the collector has nowhere to write' };
  }
  if (!config.FEED_CREDENTIALS_KEY) {
    return {
      ready: false,
      reason: 'FEED_CREDENTIALS_KEY is not set — credentials cannot be stored (openssl rand -hex 32)',
    };
  }
  return { ready: true, reason: null };
}

/** Launch the collector. Synchronous; the spawn itself is async. */
function start(tenantId, { actor } = {}) {
  const state = runnerFor(tenantId);
  runners.set(tenantId, state);

  const ready = readiness();
  if (!ready.ready) {
    state.lastStartError = ready.reason;
    return { started: false, reason: ready.reason };
  }

  if (!db) throw new Error('feedrunner.start called before setDb — the supervisor has no database to read credentials from');

  let collectorEnv;
  try {
    collectorEnv = FC.collectorEnv(db, tenantId);
  } catch (e) {
    // No credential stored, or it cannot be decrypted. Either way, do not guess.
    state.lastStartError = e.message;
    return { started: false, reason: e.message };
  }
  if (!collectorEnv) {
    state.lastStartError = 'no Betfair credentials stored for this tenant';
    return { started: false, reason: state.lastStartError };
  }

  if (state.child) return { started: true, already_running: true, pid: state.child.pid };

  if (state.startedAt === null && state.lastExit) state.restarts += 1;

  const [command, ...args] = config.collectorCommand();
  // The secrets redaction will match. Collected from the same decrypted object
  // the child receives, so there is no second source to fall out of step.
  const secrets = [collectorEnv.BETFAIR_APP_KEY, collectorEnv.BETFAIR_USERNAME, collectorEnv.BETFAIR_PASSWORD];

  state.stopping = false;
  state.lastStartError = null;

  let child;
  try {
    child = spawn(command, args, {
      env: collectorProcessEnv(collectorEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    state.lastStartError = `could not launch ${command}: ${e.message}`;
    pushLog(state, state.lastStartError, secrets);
    return { started: false, reason: state.lastStartError };
  }

  state.child = child;
  state.startedAt = new Date().toISOString();
  pushLog(state, `started ${command} ${args.join(' ')} (pid ${child.pid})`, secrets);

  // Redact before writing ANYTHING to our console. The child's stdout is not
  // trusted to be safe just because we produced it.
  const relay = (stream, source) => {
    let buffered = '';
    stream.on('data', (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        const safe = redact(line, secrets);
        pushLog(state, safe, secrets);
        if (process.env.FEED_COLLECTOR_VERBOSE === '1') process[source].write(`[feed] ${safe}\n`);
      }
    });
    stream.on('end', () => {
      if (buffered.trim()) {
        const safe = redact(buffered, secrets);
        pushLog(state, safe, secrets);
        if (process.env.FEED_COLLECTOR_VERBOSE === '1') process[source].write(`[feed] ${safe}\n`);
      }
    });
  };
  relay(child.stdout, 'stdout');
  relay(child.stderr, 'stderr');

  child.on('error', (e) => {
    // ENOENT: the command is not installed. The most common cause by far, and
    // it deserves a message that says so rather than "spawn failed".
    const hint =
      e.code === 'ENOENT'
        ? `${command} is not installed or not on PATH for the service user`
        : e.message;
    state.lastStartError = hint;
    pushLog(state, `launch failed: ${hint}`, secrets);
  });

  child.on('exit', (code, signal) => {
    const ranFor = state.startedAt ? Date.now() - Date.parse(state.startedAt) : 0;
    state.child = null;
    state.startedAt = null;
    state.lastExit = {
      code,
      signal: signal || null,
      at: new Date().toISOString(),
      ran_for_ms: ranFor,
      by_request: state.stopping,
    };

    if (state.stopping) {
      pushLog(state, `stopped (exit ${code ?? signal})`, secrets);
      return;
    }

    state.consecutiveFailures += 1;
    const wait = backoffMs(state);
    pushLog(
      state,
      `exited unexpectedly (code ${code}, signal ${signal ?? 'none'}) after ${Math.round(ranFor / 1000)}s — ` +
        `retrying in ${Math.round(wait / 1000)}s (failure ${state.consecutiveFailures})`,
      secrets
    );

    if (ranFor >= stableAfterMs()) state.consecutiveFailures = 0;

    state.timer = setTimeout(() => {
      state.timer = null;
      start(tenantId);
    }, wait);
    if (state.timer.unref) state.timer.unref();
  });

  return { started: true, pid: child.pid, command, args };
}

/** Stop the collector, and do NOT restart it. This is an explicit operator act. */
function stop(tenantId) {
  const state = runners.get(tenantId);
  if (!state) return { stopped: false, reason: 'the collector was not running' };
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.stopping = true;
  if (!state.child) {
    state.stopping = false;
    return { stopped: true, already_stopped: true };
  }
  const pid = state.child.pid;
  state.child.kill('SIGTERM');
  return { stopped: true, pid };
}

/**
 * What the operator is shown. Deliberately excludes the command's environment
 * and any child stdout beyond the scrubbed tail — health is not a place to
 * carry a credential, and this endpoint is polled.
 */
function health(tenantId) {
  const state = runners.get(tenantId);
  const ready = readiness();
  const stored = safeStatus(tenantId);
  if (!state) {
    return {
      ...ready,
      running: false,
      configured: stored,
      supervisor: 'idle',
    };
  }
  return {
    ...ready,
    running: !!state.child,
    pid: state.child ? state.child.pid : null,
    started_at: state.startedAt,
    restarts: state.restarts,
    consecutive_failures: state.consecutiveFailures,
    last_exit: state.lastExit,
    last_start_error: state.lastStartError,
    supervisor: state.child ? 'running' : state.timer ? 'waiting to restart' : 'stopped',
    configured: stored,
    recent_log: state.log.slice(-20),
  };
}

/** `status()` throws if the stored row cannot be decrypted; health must not. */
function safeStatus(tenantId) {
  try {
    return FC.status(db, tenantId);
  } catch (e) {
    return { configured: true, error: e.message };
  }
}

function stopAll() {
  for (const [tenantId, state] of runners) {
    if (state.timer) clearTimeout(state.timer);
    state.stopping = true;
    if (state.child) state.child.kill('SIGTERM');
    runners.delete(tenantId);
  }
}

module.exports = { start, stop, stopAll, health, readiness, redact, backoffMs, setDb, collectorProcessEnv };