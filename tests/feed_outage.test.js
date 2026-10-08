'use strict';
// tests/feed_outage.test.js — a configured-but-unreachable feed must be a 503.
//
// Own process on purpose: lib/config.js reads FEED_DATABASE_URL at import and
// lib/feed.js builds its pg pool on first use, so pointing either at a dead port
// after import has no effect. This file exists to boot the app with a URL that
// cannot connect.
//
// The distinction this pins: "feed disabled" is a configuration state and
// answers 200 with enabled:false (tests/feed_nav.test.js). "Feed configured but
// the recorder is down" is an outage and must answer 503 — silently returning an
// empty board would look to a user like there are simply no markets today.
process.env.DB_PATH = ':memory:';
process.env.FEED_ENABLED = 'true';
process.env.DRIFT_ENABLED = 'false';
process.env.BOT_ENABLED = 'false';
// Port 59999 is reserved and nothing listens on it, so the connection is
// refused immediately rather than hanging on a real timeout.
process.env.FEED_DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:59999/nope';

const assert = require('assert');
const { findNavHandler, navCall } = require('./feed.test');

let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
};

(async () => {
  await check('nav answers 503 when the recorder database is unreachable', async () => {
    const { sent } = await navCall();
    assert.strictEqual(sent.code, 503, 'an outage is a 503, not a silent empty board');
    assert.strictEqual(sent.body.error, 'Odds feed unavailable');
  });

  await check('the 503 body leaks no driver or host detail', async () => {
    const { sent } = await navCall();
    const body = JSON.stringify(sent.body);
    assert.ok(!/59999|nobody|ECONNREFUSED|postgres:\/\//i.test(body), `body was ${body}`);
  });

  await check('health reports ok:false with a generic message, not driver detail', async () => {
    const feed = require('../lib/feed');
    const h = await feed.health();
    assert.strictEqual(h.ok, false);
    assert.strictEqual(h.error, 'Odds feed unavailable', 'the documented generic message');
    // pg errors embed host, user and the connection string; none of that may
    // reach a body the client sees. (The real reason is logged server-side.)
    assert.ok(!/59999|nobody|ECONNREFUSED|postgres:\/\//i.test(String(h.error)), `error was ${JSON.stringify(h.error)}`);
  });

  console.log(`\nfeed_outage.test.js: ${passed} checks passed`);
})();
