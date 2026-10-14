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
      // Set by restart(): "a stop is in flight and a launch must follow it".
      // The stop is ASYNCHRONOUS, so a caller that wants "running on the new
      // credentials" cannot express it as stop(); start() — see restart().
      pendingRestart: false,
      pendingRestartActor: null,
      timer: null,
      log: [],
    }
  );
}

/**
 * IS THERE A PROCESS? Not "is there a handle".
 *
 * `state.child` is a ChildProcess object in both cases, and the difference
 * between them is the entire difference between a collector that is running and
 * one that was never born:
 *
 *   - `pid` is assigned by the spawn syscall. Node emits 'error' and 'close'
 *     but NOT 'exit' when the spawn itself fails (ENOENT, EACCES), and leaves
 *     `pid` undefined. Verified in this runtime, and it is undefined
 *     SYNCHRONOUSLY, so this is true the moment start() returns.
 *   - `exitCode` and `signalCode` are null for a live process and set once it
 *     has finished, so they also catch a child that has already died.
 *
 * The old code cleared `state.child` only from the 'exit' handler. When the
 * spawn failed, that handler never ran, so the handle stayed set for the life of
 * the process: health() reported `running: true` with `pid: undefined` for a
 * collector that did not exist, `supervisor: 'running'`, every later start()
 * returned `already_running`, and stop() killed nothing while health() still
 * said it was running. The module's own message calls ENOENT "the most common
 * cause by far" — a typo in FEED_COLLECTOR_CMD, a missing venv, a PATH
 * difference between the operator's shell and the service user.
 *
 * Note that the no-'exit' behaviour is DESIRABLE and is kept: nothing here
 * schedules a respawn on failure, so a missing binary cannot become a respawn
 * storm. The defect was only that the handle was left set.
 */
function alive(child) {
  return (
    !!child &&
    child.pid !== undefined &&
    child.pid !== null &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

/** Detach the handle, but only if it is still the one we think it is. */
function clearChild(state, child) {
  if (state.child !== child) return false;
  state.child = null;
  state.startedAt = null;
  return true;
}

function pushLog(state, line, secrets) {
  const text = redact(line, secrets).slice(0, LINE_CHARS);
  state.log.push({ at: new Date().toISOString(), line: text });
  if (state.log.length > LINE_LIMIT) state.log.splice(0, state.log.length - LINE_LIMIT);
}

/**
 * How long to wait before restarting, given how many failures have been
 * recorded SO FAR.
 *
 * The count is a property of the SUPERVISOR, not of the exit being handled, so
 * the exit path must ask this BEFORE recording the failure it is about to
 * record. See the note at the call site — the two orders produce identical
 * arithmetic for every call except the first, and the first is the one the
 * constant names.
 */
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

  // `alive()`, not `state.child` — see its note. A handle left over from a
  // failed spawn must not read as a collector to refuse a start against.
  if (alive(state.child)) return { started: true, already_running: true, pid: state.child.pid };

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
    // Release the handle HERE as well as from 'exit'. A failed spawn emits
    // 'error' and 'close' but never 'exit', so before this the runner kept a
    // ChildProcess for a process that did not exist: health() said running with
    // pid undefined, every later start() answered already_running, and stop()
    // killed nothing. `stopping` is set so that IF an 'exit' ever does arrive
    // late it takes the stopped branch instead of scheduling a respawn — the
    // guard is `clearChild` returning false when the handle has already moved
    // on, so a late event cannot resurrect state that a newer child owns.
    if (clearChild(state, child)) state.stopping = true;
  });

  child.on('exit', (code, signal) => {
    const ranFor = state.startedAt ? Date.now() - Date.parse(state.startedAt) : 0;
    clearChild(state, child);
    state.lastExit = {
      code,
      signal: signal || null,
      at: new Date().toISOString(),
      ran_for_ms: ranFor,
      by_request: state.stopping,
    };

    if (state.stopping) {
      pushLog(state, `stopped (exit ${code ?? signal})`, secrets);
      // A restart requested before the child finished its SIGTERM. Honoured
      // HERE, where the process is known to be gone — the only place a launch
      // can be correct. See restart().
      if (state.pendingRestart) {
        state.pendingRestart = false;
        const who = state.pendingRestartActor;
        state.pendingRestartActor = null;
        pushLog(state, 'restarting with the new configuration', secrets);
        start(tenantId, { actor: who });
      }
      return;
    }

    // ── THE WAIT IS COMPUTED BEFORE THE FAILURE IS COUNTED ─────────────────
    // `consecutiveFailures` is how many failures the supervisor has already
    // recorded, so the FIRST crash sees 0 and must wait `BACKOFF_START_MS` —
    // the 5 s the constant names and docs/FEED.md describes. This used to
    // increment first and ask afterwards, which made the count 1 on the first
    // crash: BACKOFF_START_MS became a value the code could not produce, and
    // every restart waited twice as long as documented. The sequence is
    // otherwise unchanged — 5 s, 10 s, 20 s, … — and the floor is now reachable.
    //
    // It also makes tests/feedrunner.test.js R4 meaningful rather than
    // accidentally correct: R4 asserts backoffMs grows between 0 and 1, and 0 is
    // the state this exit path really produces.
    //
    // The log line below still names the count AFTER the increment, because the
    // operator reading it wants to know how many crashes have happened, not how
    // many had happened when the timer was armed.
    const wait = backoffMs(state);
    state.consecutiveFailures += 1;
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
  // `alive()`, not `state.child`: a handle from a failed spawn must not be
  // signalled, and `stopping` must not be left set for a collector that was
  // never running (which would make the next crash look operator-requested).
  if (!alive(state.child)) {
    state.stopping = false;
    return { stopped: true, already_stopped: true };
  }
  const pid = state.child.pid;
  state.child.kill('SIGTERM');
  return { stopped: true, pid };
}

/**
 * Stop the collector and bring it back on the current configuration.
 *
 * WHY THIS IS NOT stop(); start(). `child.kill('SIGTERM')` is ASYNCHRONOUS, so
 * the line after it still sees a live handle. The old route did exactly that:
 * `start()` hit the `already_running` guard one line after `stop()` had bailed,
 * NO new child was spawned, and then the old child's exit arrived, saw
 * `stopping === true` and returned early instead of rescheduling. Net result:
 * saving rotated Betfair credentials PERMANENTLY STOPPED the collector — on the
 * credential-rotation path, with no error, no log line, and an API response
 * asserting `collector_restarted: true`.
 *
 * A restart is a SEQUENCING problem, so it is sequenced here, in the module
 * that owns the lifecycle, rather than in a route that cannot express it. The
 * alternative (a completion callback on stop()) was rejected because the exit
 * handler is shared by three outcomes — an operator stop, a crash, and a failed
 * spawn — and only one of them should mean "and now start again". A flag
 * consumed in exactly one branch says that, in a form that survives the route
 * layer.
 *
 * The return value is HONEST about which of the two happened:
 *   restarted: true   a new child is already up (nothing was running)
 *   pending:   true   the old child is terminating; the launch follows on exit
 */
function restart(tenantId, { actor } = {}) {
  const state = runners.get(tenantId);
  if (!state || !alive(state.child)) {
    // Nothing to stop, so there is no race: start() is correct immediately.
    // (This also covers the ENOENT case, where the handle is stale.)
    const r = start(tenantId, { actor });
    return { restarted: !!r.started, pending: false, ...r };
  }
  state.pendingRestart = true;
  state.pendingRestartActor = actor ?? null;
  const stopped = stop(tenantId);
  return { restarted: false, pending: true, ...stopped };
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
  const running = alive(state.child);
  return {
    ...ready,
    running,
    // `null`, never `undefined`. A handle with no pid surviving into health() was
    // the tell for the missing-binary wedge: `running: true` beside a pid that
    // does not exist is not a state this endpoint can express at all now.
    pid: running ? state.child.pid : null,
    started_at: state.startedAt,
    restarts: state.restarts,
    consecutive_failures: state.consecutiveFailures,
    last_exit: state.lastExit,
    last_start_error: state.lastStartError,
    // A restart that has been asked for but is waiting on the child's exit is a
    // third state, not "running" and not "stopped": the operator asked for a
    // credential change and the feed is about to come back.
    supervisor: running
      ? 'running'
      : state.pendingRestart
        ? 'restarting'
        : state.timer
          ? 'waiting to restart'
          : 'stopped',
    restart_pending: !!state.pendingRestart,
    configured: stored,
    recent_log: state.log.slice(-20),
  };
}

/**
 * What the operator is shown when the credential store itself cannot be read.
 *
 * The old comment claimed `status()` "throws if the stored row cannot be
 * decrypted". It cannot: `FC.status` never decrypts anything — it checks
 * `!!row.app_key` — so the only way to reach this fallback is the store being
 * closed, null or broken, and the comment described a cause that does not exist.
 *
 * The fallback then guessed `configured: true`, which is a wrong-but-plausible
 * value in the one view an operator uses to decide whether the collector can
 * start. It is `null` here — explicitly UNKNOWN, not `false`. `false` would be a
 * claim ("nothing is stored") this function also cannot support, and it has to
 * survive JSON, which drops `undefined` and would leave a bare `{error}` for a
 * consumer that reads `configured`. The reason is kept: an unknown that does not
 * say why is the same defect with the number removed.
 */
function safeStatus(tenantId) {
  try {
    return FC.status(db, tenantId);
  } catch (e) {
    return { configured: null, error: e && e.message ? String(e.message) : 'credential store unreadable' };
  }
}

/**
 * How long a collector is given to honour SIGTERM before it is killed outright.
 *
 * The child is third-party Python (`betfeed`), so it may not install a handler
 * at all, and a shutdown path that waits forever is WORSE than no shutdown
 * path: it converts the service manager's SIGTERM into a hang, and a manager
 * that eventually SIGKILLs the parent leaves the collector running anyway.
 */
const KILL_GRACE_MS = 5_000;

/**
 * Stop every supervised collector and resolve when they are actually gone.
 *
 * This existed and did the right thing, and had NO CALLERS. The server
 * registered only unhandledRejection and uncaughtException — no SIGTERM, no
 * SIGINT, no server.close() — so the default signal behaviour killed the
 * process immediately, `server.on('close')` never fired, and this never ran.
 * The collector is a detached-by-default child with no parent-death signal, so
 * on EVERY deploy, crash or Ctrl-C the old `betfeed collect` survived: still
 * holding a Betfair session, still spending market-data weight, still writing
 * into the feed database, and now competing with the new collector for the
 * same account — the fastest route to being rate-limited or banned. The new
 * process then reported `supervisor: 'idle'` while a zombie ran on.
 *
 * Escalates to SIGKILL after the grace period, and resolves on the children's
 * 'close' so a caller can know the collector is genuinely gone before exiting.
 *
 * NOTE ON THE PROCESS GROUP. The spawn is deliberately NOT `detached`. In its
 * own group the collector would leave the group a terminal's Ctrl-C reaches,
 * and — with no parent-death signal anywhere in Node — a parent CRASH would
 * then guarantee an orphan rather than merely risk one. The direct child is
 * signalled here instead: the one process this module can prove it started.
 */
function stopAll({ killAfterMs = KILL_GRACE_MS } = {}) {
  const children = [];
  for (const [tenantId, state] of runners) {
    if (state.timer) clearTimeout(state.timer);
    state.stopping = true;
    // A restart requested moments before shutdown must NOT resurrect a
    // collector on the way out.
    state.pendingRestart = false;
    state.pendingRestartActor = null;
    if (alive(state.child)) children.push(state.child);
    runners.delete(tenantId);
  }
  if (children.length === 0) return Promise.resolve({ stopped: 0, escalated: 0 });

  return new Promise((resolve) => {
    let outstanding = children.length;
    let escalated = 0;
    let finished = false;
    // NOT unref'd: during shutdown this is the only thing standing between a
    // SIGTERM-ignoring child and a process that never exits.
    const escalate = setTimeout(() => {
      for (const c of children) {
        if (!alive(c)) continue;
        try {
          c.kill('SIGKILL');
          escalated += 1;
        } catch {
          /* already gone */
        }
      }
      // Let the kill land, then stop waiting regardless of what the child does.
      const after = setTimeout(() => done(), 100);
      if (after.unref) after.unref();
    }, killAfterMs);

    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(escalate);
      resolve({ stopped: children.length, escalated });
    };
    for (const c of children) {
      c.once('close', () => {
        outstanding -= 1;
        if (outstanding === 0) done();
      });
    }
  });
}

module.exports = {
  start,
  stop,
  restart,
  stopAll,
  health,
  readiness,
  redact,
  backoffMs,
  setDb,
  collectorProcessEnv,
  alive,
};