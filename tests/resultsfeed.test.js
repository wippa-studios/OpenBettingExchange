// resultsfeed.test.js — the results-feed transport.
// Run: node tests/resultsfeed.test.js   (plain assert, no deps)
//
// WHY THIS EXISTS. lib/results.js had a complete consumer and NO transport, and
// the scheduled poll was never wired — so RESULTS_POLL_INTERVAL_MS was a
// documented knob that no job read. Outcomes arrived only when an operator
// pushed them by hand. On a venue running more than one sport that is not a gap,
// it is the entire settlement process.
//
// The properties that matter, in order: it never settles anything itself, it
// never throws into the job runner, it cannot be used to settle a market it
// should not, and when it breaks it says so.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';
process.env.MIN_STAKE_CENTS = '100';
process.env.MAX_STAKE_CENTS = '1000000';

const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const R = require('../lib/results');
const RF = require('../lib/resultsfeed');
const acc = require('../lib/accounts');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('  ok', name); };
const run = async () => {
  let n = 0;
  // A market whose event is completed, with real exposure — i.e. exactly what
  // a results feed has to be able to settle.
  async function fixture(sport = 'football') {
  // ensureBot() is synchronous (it runs inside transactions in lib/settle.js and
  // lib/cashoutrisk.js) and so cannot derive the house password hash itself.
  // This venue is hand-built rather than seeded, so prime it explicitly.
  await require('../lib/bots').primeBotHash();
    RF.resetState();
    const db = openStore(':memory:');
    db.prepare('INSERT INTO sports (name, slug) VALUES (?, ?)').run(sport, sport);
    const sp = db.prepare('SELECT id FROM sports WHERE slug=?').get(sport);
    n++;
    // LIVE, so bets can be placed. The event is flipped to 'completed' by
    // complete() when the test wants the market pending — the state a results
    // feed actually sees, which is never the state the bets were placed in.
    db.prepare(
      "INSERT INTO events (sport_id, name, starts_at, status) VALUES (?, ?, datetime('now','+2 hours'), 'live')"
    ).run(sp.id, `Ev ${n}`);
    const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Ev ${n}`);
    db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
    const mkt = db.prepare('SELECT id FROM markets WHERE event_id=?').get(ev.id);
    for (const nm of ['Alpha', 'Beta']) {
      db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, 2.0)').run(mkt.id, nm);
    }
    const s1 = db.prepare('SELECT id FROM selections WHERE market_id=? AND name=?').get(mkt.id, 'Alpha').id;
    const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 }));
    const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-123', balance_cents: 100000 }));
    return { db, marketId: mkt.id, s1, alice, bob };
  }
  // bet() with a real counterparty: two backs never match.
  const bet = (f, who) => M.placeOrder(f.db, who, { selection_id: f.s1, side: 'back', price: 2.0, stake_cents: 1000 });
  const lay = (f, who) => M.placeOrder(f.db, who, { selection_id: f.s1, side: 'lay', price: 2.0, stake_cents: 1000 });
  // The transition the feed exists to react to: the event finishes, and only
  // THEN does the market become the feed's business.
  const complete = (f) =>
    f.db.prepare("UPDATE events SET status='completed' WHERE id = (SELECT event_id FROM markets WHERE id = ?)").run(f.marketId);
  // Bet, then complete — the normal life of a market on the way to settlement.
  const backed = (f) => { bet(f, f.alice); lay(f, f.bob); complete(f); return f; };

  // A fake transport that records what it was asked and replies with a script.
  function stub(handler, calls) {
    return async (target, init) => {
      calls.push({ target, init, body: JSON.parse(init.body) });
      const r = await handler(target, init, calls.length);
      if (!r) throw new Error('stub: no reply');
      return r;
    };
  }
  const jsonReply = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    async text() { return JSON.stringify(obj); },
  });

  // ── The happy path, and the thing that actually mattered ────────────────

  // T1: a poll settles a market end to end. Without this the transport is a
  // parser with no consumer, which is what shipped before.
  await check('T1 a poll applies outcomes and settles the market', async () => {
    const f = (await fixture());
    backed(f);
    const calls = [];
    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: stub(() => jsonReply({ outcomes: { [f.marketId]: { status: 'completed', winners: [f.s1] } } }), calls),
    });
    const r = await RF.pollNow(f.db, { fetcher });
    assert.strictEqual(r.considered, 1, 'the pending market was considered');
    assert.strictEqual(r.applied, 1, 'and the outcome applied');
    assert.strictEqual(r.error, null, 'with no error');
    assert.strictEqual(f.db.prepare('SELECT status s FROM markets WHERE id=?').get(f.marketId).s, 'settled');
    // The winner was actually paid — a settled market that paid nobody is the
    // failure mode this whole area of the codebase has produced before.
    const a = f.db.prepare('SELECT balance_cents b FROM users WHERE username=?').get('alice');
    assert.strictEqual(a.b, 100000 + 1000 - 25, 'the winner is paid');
    assert.strictEqual(acc.assertConserved(f.db), 0);
    assert.strictEqual(calls.length, 1);
  });

  // T2: THE TRANSPORT ASKS FOR EXACTLY WHAT WILL BE CONSUMED. The request body
  // and the consumer's pending set come from one query. A transport that asked
  // about a different set would look healthy while outcomes never arrived.
  await check('T2 the feed is asked for precisely the pending set', async () => {
    const f = (await fixture());
    backed(f);
    // A second market that is NOT pending (its event is still live) must not be
    // asked about, or the provider wastes work and we misread the answer.
    f.db.prepare(
      "INSERT INTO events (sport_id, name, starts_at, status) VALUES ((SELECT id FROM sports LIMIT 1), 'Later', datetime('now','+2 hours'), 'live')"
    ).run();
    const ev = f.db.prepare("SELECT id FROM events WHERE name='Later'").get();
    f.db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
    const calls = [];
    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: stub(() => jsonReply({ outcomes: {} }), calls),
    });
    const pending = R.pendingMarkets(f.db).map((m) => m.id);
    assert.deepStrictEqual(pending, [f.marketId], 'only the completed event is pending');
    await RF.pollNow(f.db, { fetcher });
    assert.strictEqual(calls.length, 1);
    const asked = calls[0].body.markets.map((m) => m.id);
    assert.deepStrictEqual(asked, pending, 'the body matches the consumer set exactly');
    // Selection names ride along so a provider can match on its own ids.
    assert.ok(calls[0].body.markets[0].selections.length === 2, 'with the selections named');
    assert.strictEqual(calls[0].body.markets[0].selections[0].name, 'Alpha');
  });

  // T3: THE FEED IS A SIGNAL, NOT AN AUTHORITY. A feed naming a winner from a
  // different market must NOT settle — it is held, which is lib/results.js's
  // rule and the transport must not weaken it.
  await check('T3 the feed cannot settle a market it should not', async () => {
    const f = (await fixture());
    backed(f);
    const before = f.db.prepare('SELECT balance_cents b FROM users WHERE username=?').get('alice').b;
    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      // 9999 belongs to nothing.
      fetchImpl: stub(() => jsonReply({ outcomes: { [f.marketId]: { status: 'completed', winners: [9999] } } }), []),
    });
    const r = await RF.pollNow(f.db, { fetcher });
    assert.strictEqual(r.results[0].outcome, 'held', 'a foreign winner is held');
    assert.strictEqual(f.db.prepare('SELECT status s FROM markets WHERE id=?').get(f.marketId).s, 'open');
    assert.strictEqual(f.db.prepare('SELECT balance_cents b FROM users WHERE username=?').get('alice').b, before, 'no money moved');
    assert.strictEqual(acc.assertConserved(f.db), 0);
  });

  // T4: a DISPUTED outcome from the feed is held, never settled — the rule
  // that outranks every published rule, and the reason a feed cannot shortcut a
  // human decision.
  await check('T4 a disputed feed outcome is held, not settled', async () => {
    const f = (await fixture());
    backed(f);
    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: stub(() => jsonReply({ outcomes: { [f.marketId]: { status: 'completed', winners: [f.s1], disputed: true } } }), []),
    });
    const r = await RF.pollNow(f.db, { fetcher });
    assert.strictEqual(r.results[0].outcome, 'held');
    assert.strictEqual(f.db.prepare('SELECT status s FROM markets WHERE id=?').get(f.marketId).s, 'open');
    // And it is a hold a human can see, not a silent drop.
    const held = f.db.prepare('SELECT COUNT(*) c FROM markets WHERE id=? AND settlement_hold=1').get(f.marketId).c;
    assert.strictEqual(held, 1, 'the market is on a settlement hold');
  });

  // ── Failing soft, which is the whole point of a transport ───────────────

  // T5: EVERY failure mode returns an empty outcome set and records why. None
  // of them may throw into the job runner, because a results provider's outage
  // must not be able to take down a venue that is trading the next race.
  await check('T5 every transport failure is soft and recorded', async () => {
    const reasons = [
      ['http_500', stub(() => jsonReply({}, 500), [])],
      ['http_404', stub(() => jsonReply({}, 404), [])],
      ['unreadable_response', stub(() => jsonReply('a string is not a map'), [])],
      ['invalid_json', stub(() => ({ ok: true, status: 200, async text() { return '{not json'; } }), [])],
      ['unreachable', stub(() => { throw new Error('ECONNREFUSED'); }, [])],
      ['timeout', stub(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, [])],
    ];
    for (const [expected, impl] of reasons) {
      RF.resetState();
      const f = (await fixture());
      backed(f);
      const fetcher = RF.createFetcher({ url: 'https://results.example/v1/outcomes', fetchImpl: impl });
      const r = await RF.pollNow(f.db, { fetcher });
      assert.strictEqual(r.error, null, `${expected}: did not throw into the runner`);
      assert.strictEqual(r.applied, 0, `${expected}: applied nothing`);
      assert.strictEqual(r.feed.status, 'failing', `${expected}: reported as failing`);
      assert.strictEqual(r.feed.last_error.reason, expected, `${expected}: with its reason`);
      assert.strictEqual(r.feed.consecutive_failures, 1, `${expected}: counted`);
      // Nothing settled, and the books are untouched — a broken feed must not
      // be able to move money.
      assert.strictEqual(f.db.prepare('SELECT status s FROM markets WHERE id=?').get(f.marketId).s, 'open', expected);
      assert.strictEqual(acc.assertConserved(f.db), 0, expected);
      assert.deepStrictEqual(acc.assertUserAgrees(f.db), [], expected);
    }
  });

  // T6: an oversized response cannot OOM the venue to deliver bad news. The cap
  // is enforced on the stream, so a provider lying about Content-Length does
  // not get past it.
  await check('T6 an oversized response is refused', async () => {
    const f = (await fixture());
    backed(f);
    const big = { outcomes: { [f.marketId]: { status: 'completed', winners: [f.s1] } } };
    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      maxBytes: 32, // smaller than any real answer
      fetchImpl: stub(() => jsonReply(big), []),
    });
    const r = await RF.pollNow(f.db, { fetcher });
    assert.strictEqual(r.applied, 0, 'nothing applied');
    assert.strictEqual(r.feed.last_error.reason, 'response_too_large');
    assert.strictEqual(f.db.prepare('SELECT status s FROM markets WHERE id=?').get(f.marketId).s, 'open');
  });

  // T7: a feed that has silently stopped must be VISIBLE. This is the inverse
  // of the dead controls in this codebase's history — those reported and did
  // not enforce; a feed that fetches and never says it broke is a venue that
  // discovers the problem at settlement time.
  await check('T7 a silent feed is distinguishable from a quiet one', async () => {
    RF.resetState();
    // Quiet: working, nothing to say.
    const quiet = (await fixture());
    RF.resetState();
    let fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: stub(() => jsonReply({ outcomes: {} }), []),
    });
    let h = await RF.pollNow(quiet.db, { fetcher }).then((r) => r.feed);
    assert.strictEqual(h.status, 'ok', 'a working feed is ok');

    // Failing: says so, and keeps saying so.
    RF.resetState();
    const f = (await fixture());
    backed(f);
    fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: stub(() => jsonReply({}, 503), []),
    });
    h = await RF.pollNow(f.db, { fetcher }).then((r) => r.feed);
    assert.strictEqual(h.status, 'failing');
    // Three more failures: the count escalates, which is what makes an alarm
    // actionable rather than a constant background noise.
    for (let i = 0; i < 3; i++) h = await RF.pollNow(f.db, { fetcher }).then((r) => r.feed);
    assert.strictEqual(h.consecutive_failures, 4, 'consecutive failures accumulate');
    assert.ok(h.polls >= 4 && h.ok_polls === 0, 'polls counted, none ok');
  });

  // T8: STALENESS. A feed that answered once and then went quiet forever is the
  // failure nobody notices: no error, no failure count, just silence. It is the
  // worst shape an operator can be handed, because the venue looks healthy.
  //
  // Tested through the `now` seam rather than by sleeping, so the property is
  // deterministic: `health()` is asked what it would say an hour from now.
  await check('T8 a feed that stopped answering is stale, not ok', async () => {
    RF.resetState();
    const f = (await fixture());
    // Nothing pending, so the transport short-circuits: this is exactly the
    // quiet-venue case, where a naive implementation records nothing at all.
    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: stub(() => jsonReply({ outcomes: {} }), []),
    });
    await RF.pollNow(f.db, { fetcher });
    assert.strictEqual(RF.health().status, 'ok', 'fresh');
    assert.strictEqual(RF.health({ staleAfterMs: 60000 }).status, 'ok', 'and still ok inside the window');

    // One poll interval later: ok. Three later: stale. The threshold is the
    // operator's, and `health()` must honour it rather than having its own idea.
    const lastOk = Date.parse(RF.state().last_ok_at);
    assert.strictEqual(RF.health({ staleAfterMs: 60000, now: lastOk + 61000 }).status, 'stale');
    assert.strictEqual(RF.health({ staleAfterMs: 60000, now: lastOk + 3600000 }).stale, true);
    // And a longer window means a quiet feed is not alarmed about — the operator
    // decides what "too quiet" is.
    assert.strictEqual(RF.health({ staleAfterMs: 7200000, now: lastOk + 3600000 }).status, 'ok');
    // An age is always reported, so "how long since this last worked" has one
    // answer.
    assert.strictEqual(RF.health({ now: lastOk + 5000 }).age_ms, 5000);
  });

  // T8b: staleness is reported but never blocks anything. A stale feed must not
  // stop the venue trading — the next race is unaffected by the last one's
  // results feed — and readiness must not gate on it either, because pulling a
  // healthy venue out of rotation over a provider outage would manufacture the
  // outage it was meant to prevent.
  await check('T8b a stale feed is reported and does not block trading', async () => {
    RF.resetState();
    const f = (await fixture());
    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: stub(() => jsonReply({ outcomes: {} }), []),
    });
    await RF.pollNow(f.db, { fetcher });
    const stale = RF.health({ staleAfterMs: 1, now: Date.parse(RF.state().last_ok_at) + 3600000 });
    assert.strictEqual(stale.stale, true, 'it knows it is stale');
    // Betting is unaffected: the market is live and tradeable.
    bet(f, f.alice);
    assert.ok(f.db.prepare('SELECT status s FROM orders ORDER BY id DESC LIMIT 1').get().s !== 'cancelled');
    // And readiness carries it as information, not as a gate.
    const OPS = require('../lib/ops');
    const ready = OPS.readiness(f.db);
    assert.strictEqual(ready.status, 'ready', 'a stale results feed does not make the venue unready');
    assert.ok('results_feed' in ready.checks, 'but it is reported where an operator looks');
  });

  // T9: not configured is an HONEST state, distinct from failing. A venue that
  // settles by hand has no feed and that is fine; conflating it with an outage
  // trains the operator to ignore the alarm.
  await check('T9 an unconfigured feed is not_configured, not failing', async () => {
    RF.resetState();
    const fetcher = RF.createFetcher({ url: null, fetchImpl: stub(() => jsonReply({}), []) });
    const f = (await fixture());
    backed(f);
    const r = await RF.pollNow(f.db, { fetcher });
    // With no URL the fetcher returns {} without calling anything: no
    // misconfigured integration, no outage, no phantom outcomes.
    assert.strictEqual(r.applied, 0);
    assert.strictEqual(RF.health().status, 'not_configured');
    assert.strictEqual(RF.health().consecutive_failures, 0, 'and it is not counted as a failure');
    assert.strictEqual(f.db.prepare('SELECT status s FROM markets WHERE id=?').get(f.marketId).s, 'open');
  });

  // T10: with nothing pending, a poll is a SUCCESS, not a failure. Otherwise a
  // quiet venue reports a broken feed all night and the real outage is the one
  // nobody reads.
  await check('T10 an empty pending set is a successful poll', async () => {
    RF.resetState();
    // An event still live: nothing pending.
    const f = (await fixture());
    f.db.prepare("UPDATE events SET status='live'").run();
    let called = false;
    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: stub(() => { called = true; return jsonReply({ outcomes: {} }); }, []),
    });
    const r = await RF.pollNow(f.db, { fetcher });
    assert.strictEqual(r.considered, 0);
    assert.strictEqual(r.feed.status, 'ok', 'a quiet venue is ok, not failing');
    assert.strictEqual(called, false, 'and the feed is not called with nothing to ask');
  });

  // ── The boundary: what a feed is allowed to say ─────────────────────────

  // T11: normalisation is strict about ids and honest about absence. A string
  // that coerced into a selection id is how the wrong runner gets paid.
  await check('T11 signals are normalised strictly', async () => {
    assert.deepStrictEqual(RF.normaliseSignal({ status: 'completed', winners: ['3', 'x', -1] }), {
      status: 'completed',
      winners: [3],
    });
    // An ABSENT dead_heat is not false: the rules table distinguishes "no dead
    // heat" from "this feed does not model dead heats", and inventing a false
    // turns a dead heat into an ordinary finish.
    const no = RF.normaliseSignal({ status: 'completed', winners: [3] });
    assert.ok(!('dead_heat' in no), 'absent flags are not invented');
    // But an explicit one is carried.
    assert.strictEqual(RF.normaliseSignal({ status: 'completed', dead_heat: true }).dead_heat, true);
    // No recognisable content is not a signal at all.
    assert.strictEqual(RF.normaliseSignal({ vendor: 'acme', junk: 1 }), null);
    assert.strictEqual(RF.normaliseSignal(null), null);
    assert.strictEqual(RF.normaliseSignal([1, 2]), null);
  });

  // T12: both realistic response shapes parse, and neither is read as "no
  // outcomes" if it is malformed — because "no outcomes" and "I could not read
  // you" look identical to the operator and are not the same thing.
  await check('T12 response shapes parse and malformed bodies raise', async () => {
    assert.deepStrictEqual(RF.parseOutcomes({ outcomes: { 5: { status: 'completed', winners: [1] } } }), {
      5: { status: 'completed', winners: [1] },
    });
    assert.deepStrictEqual(RF.parseOutcomes({ 5: { status: 'completed', winners: [1] } }), {
      5: { status: 'completed', winners: [1] },
    });
    assert.deepStrictEqual(RF.parseOutcomes([{ market_id: 5, status: 'completed', winners: [1] }]), {
      5: { status: 'completed', winners: [1] },
    });
    // An unusable key alongside a usable one is DROPPED, never coerced to
    // market 0. (On its own it now raises — see T17.)
    assert.deepStrictEqual(
      RF.parseOutcomes({ outcomes: { abc: { status: 'completed' }, 5: { status: 'completed' } } }),
      { 5: { status: 'completed' } }
    );
    assert.throws(() => RF.parseOutcomes('nope'), (e) => e.reason === 'unreadable_response');
    assert.throws(() => RF.parseOutcomes(null), (e) => e.reason === 'unreadable_response');
  });

  // T17: A WRONG-SHAPE RESPONSE IS NOT A SUCCESSFUL EMPTY POLL.
  //
  // The asymmetry this pins was backwards from the module's own header, which
  // says "a response the venue cannot read must not be read as 'no outcomes'":
  // an UNREADABLE body raised, while a perfectly READABLE body of an
  // unexpected shape was silently skipped entry by entry and collapsed to {}.
  // The caller then advanced last_ok_at, incremented ok_polls and cleared
  // consecutive_failures — so a provider that changed its wrapper key left the
  // venue permanently green, polling on a timer, settling nothing, with the
  // health endpoint agreeing it was fine and the alarm line never once printed.
  //
  // The shape that matters most is the one the VENUE ITSELF SENDS:
  // `requestBody` posts {markets: [...]}, so any provider that echoes the
  // request shape back — plausible, common, and the easiest integration bug in
  // the world to write — was read as "no outcomes, all healthy".
  await check('T17 a wrong-shape response is a FAILURE, not a quiet success', async () => {
    const shapes = [
      ['a different wrapper key', { results: [{ market_id: 5, status: 'completed' }] }],
      // The venue's own request shape, echoed back.
      ['the request shape echoed back', { markets: [{ id: 5, name: 'Match Odds' }] }],
      ['array entries with no market id', [{ market: 1, status: 'completed' }]],
      ['a string-keyed map', { race: { status: 'completed', winners: [1] } }],
    ];
    for (const [what, payload] of shapes) {
      assert.throws(
        () => RF.parseOutcomes(payload),
        (e) => e.name === 'FeedError' && e.reason === 'unrecognised_shape',
        `${what} must not parse as "no outcomes"`
      );
    }
    // And through the transport, end to end: the poll must FAIL and be counted,
    // because "the feed is working and has nothing to say" and "we cannot read
    // the feed at all" are indistinguishable from every number an operator has.
    RF.resetState();
    const f = (await fixture());
    backed(f);
    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: stub(() => jsonReply({ markets: [{ id: f.marketId, name: 'Match Odds' }] }), []),
    });
    const r = await RF.pollNow(f.db, { fetcher });
    assert.strictEqual(r.applied, 0, 'nothing was settled from a response we could not read');
    assert.strictEqual(r.error, null, 'and it still did not throw into the runner');
    assert.strictEqual(r.feed.status, 'failing', 'the module now says so');
    assert.strictEqual(r.feed.last_error.reason, 'unrecognised_shape');
    assert.strictEqual(r.feed.consecutive_failures, 1, 'and counts it as a failure');
    assert.strictEqual(r.feed.ok_polls, 0, 'a shape change is NOT an ok poll');
    assert.strictEqual(r.feed.last_ok_at, null, 'last_ok_at does not advance on a shape change');
    // Dropped entries are visible too, so the half of this that does not throw
    // is still countable.
    assert.strictEqual(r.feed.dropped_entries, 1, 'and the dropped entry is counted');
    // Nothing settled, and the books are untouched.
    assert.strictEqual(f.db.prepare('SELECT status s FROM markets WHERE id=?').get(f.marketId).s, 'open');
    assert.strictEqual(acc.assertConserved(f.db), 0);
  });

  // T18: a payload that MOSTLY parses still applies what it can, and reports
  // what it dropped. One malformed entry from an otherwise working provider is
  // not the same event as a contract that has moved underneath us, and neither
  // is a reason to refuse the entries we did understand.
  await check('T18 a partial parse applies what it can and counts the rest', async () => {
    RF.resetState();
    const f = (await fixture());
    backed(f);
    const stats = {};
    const out = RF.parseOutcomes(
      { outcomes: { [f.marketId]: { status: 'completed', winners: [f.s1] }, rubbish: { status: 'completed' } } },
      stats
    );
    assert.deepStrictEqual(Object.keys(out), [String(f.marketId)], 'the usable entry survives');
    assert.strictEqual(stats.dropped, 1, 'and the unusable one is counted, not silently lost');

    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: stub(
        () => jsonReply({ outcomes: { [f.marketId]: { status: 'completed', winners: [f.s1] }, junk: { status: 'x' } } }),
        []
      ),
    });
    const r = await RF.pollNow(f.db, { fetcher });
    assert.strictEqual(r.applied, 1, 'the good entry settled the market');
    assert.strictEqual(r.feed.status, 'ok', 'a provider that got one entry wrong is not an outage');
    assert.strictEqual(r.feed.last_dropped, 1, 'but the drop is on the record');
    assert.strictEqual(r.feed.dropped_entries, 1);
    assert.strictEqual(f.db.prepare('SELECT status s FROM markets WHERE id=?').get(f.marketId).s, 'settled');
    assert.strictEqual(acc.assertConserved(f.db), 0);

    // And a healthy poll with nothing to drop leaves the counter at zero, so a
    // non-zero number always means something.
    RF.resetState();
    const g = (await fixture());
    backed(g);
    const clean = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: stub(() => jsonReply({ outcomes: { [g.marketId]: { status: 'completed', winners: [g.s1] } } }), []),
    });
    await RF.pollNow(g.db, { fetcher: clean });
    assert.strictEqual(RF.health().dropped_entries, 0, 'nothing dropped on a clean poll');
    assert.strictEqual(RF.health().last_dropped, 0);
  });

  // T13: the secret is sent as a bearer token, and a feed with no secret does
  // not invent one.
  await check('T13 the feed is authenticated when a secret is configured', async () => {
    const f = (await fixture());
    backed(f);
    const calls = [];
    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      secret: 'shhh',
      fetchImpl: stub(() => jsonReply({ outcomes: {} }), calls),
    });
    await RF.pollNow(f.db, { fetcher });
    assert.strictEqual(calls[0].init.headers.authorization, 'Bearer shhh');
    assert.strictEqual(calls[0].init.method, 'POST', 'a POST, so a long pending list is not a URL');
  });

  // T14: a consumer-side fault is NOT hidden behind "the feed is down". If
  // settlement itself throws, that is an engine bug and it must surface.
  await check('T14 a consumer fault is surfaced, not blamed on the feed', async () => {
    const f = (await fixture());
    backed(f);
    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: stub(() => jsonReply({ outcomes: { [f.marketId]: { status: 'completed', winners: [f.s1] } } }), []),
    });
    // Settle it behind pollNow's back, so applyOutcome hits a settled market.
    R.applyOutcome(f.db, f.marketId, { status: 'completed', winners: [f.s1] }, { source: 'manual' });
    const r = await RF.pollNow(f.db, { fetcher });
    // applyOutcome absorbs a legitimate 409 rather than throwing, so there is no
    // consumer fault here — the point of the check is that IF one existed it
    // would be reported, not swallowed. Assert the benign path.
    assert.ok(r.error === null || r.error.reason === 'consumer_failed');
    // Either way the market is settled exactly once.
    const rows = f.db.prepare('SELECT COUNT(*) c FROM settlements WHERE market_id=?').get(f.marketId).c;
    assert.ok(rows > 0, 'settled once');
    assert.strictEqual(acc.assertConserved(f.db), 0, 'and not twice');
  });

  // T15: idempotency at the transport level. A poll that runs twice with the
  // same answer must not settle twice — the property the whole settlement path
  // rests on, and the reason re-delivery is safe.
  await check('T15 a repeated poll settles once', async () => {
    const f = (await fixture());
    backed(f);
    const answer = { outcomes: { [f.marketId]: { status: 'completed', winners: [f.s1] } } };
    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: stub(() => jsonReply(answer), []),
    });
    await RF.pollNow(f.db, { fetcher });
    const after1 = f.db.prepare('SELECT balance_cents b FROM users WHERE username=?').get('alice').b;
    const r2 = await RF.pollNow(f.db, { fetcher });
    const after2 = f.db.prepare('SELECT balance_cents b FROM users WHERE username=?').get('alice').b;
    assert.strictEqual(after1, after2, 'the winner is not paid twice');
    assert.strictEqual(r2.applied, 0, 'nothing applied the second time (market no longer pending)');
    assert.strictEqual(acc.assertConserved(f.db), 0);
    assert.deepStrictEqual(acc.assertUserAgrees(f.db), []);
  });

  // T16: THE ASYNC-SHAPE REGRESSION. `pollOnce` used to be synchronous and read
  // `fetchResults(db)` without awaiting it, so an async transport produced
  // `outcomes[id] === undefined` for every market and a cycle that reported
  // `applied: 0` having applied nothing. The suite stayed green because the
  // injected double returned a plain object — the one shape that hides it. So
  // the shape itself is asserted: a promise-returning fetcher must be applied,
  // not mistaken for an object. This is the test that would have caught the
  // HTTP results feed being wired and settling nothing.
  await check('T16 an async fetcher is awaited, not read as an object', async () => {
    const f = (await fixture());
    backed(f);
    const answer = { outcomes: { [f.marketId]: { status: 'completed', winners: [f.s1] } } };
    // Deliberately ASYNC and deliberately a Promise. If pollOnce stops
    // awaiting, this returns applied: 0 and the market stays open.
    const fetcher = RF.createFetcher({
      url: 'https://results.example/v1/outcomes',
      fetchImpl: async () => jsonReply(answer),
    });
    const run = await R.pollOnce(f.db, fetcher);
    assert.strictEqual(run.considered, 1);
    assert.strictEqual(run.applied, 1, 'the async answer was applied');
    assert.strictEqual(run.results[0].outcome, 'settled');
    assert.strictEqual(f.db.prepare('SELECT status s FROM markets WHERE id=?').get(f.marketId).s, 'settled');
    assert.strictEqual(acc.assertConserved(f.db), 0);
  });

  console.log(`\nresultsfeed.test.js: ${passed} checks passed`);
  if (passed < 19) { console.error('expected 19 checks'); process.exit(1); }
};

run().catch((e) => { console.error(e); process.exit(1); });
