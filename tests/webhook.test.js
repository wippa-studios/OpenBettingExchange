// webhook.test.js — POST /api/payments/webhook, end to end over real HTTP.
//
// Its own file for ONE reason: lib/config.js is evaluated at import, so
// PAYMENTS_WEBHOOK_SECRET cannot be flipped inside a process that has already
// loaded the server. Every other suite runs with the secret UNSET, which is the
// safe default and makes the route 404 — so the authenticated path, where the
// deposit-confirmation money actually moves, had no coverage at all anywhere.
//
// What is pinned here:
//
//   - a correctly signed, fresh delivery confirms the intent and credits once;
//   - a REDELIVERY of the same event answers 2xx with already_confirmed and
//     credits NOTHING a second time (#26). It used to answer 404, which is what
//     a provider retries on and alerts on;
//   - a replayed (timestamp, body, signature) triple is refused once the window
//     has passed (#26), and the timestamp is inside the MAC so it cannot be
//     edited to look fresh;
//   - the route is still default-deny: no secret, or no signature, is refused.
'use strict';

// Set BEFORE the server is required — config reads the environment at import.
process.env.PAYMENTS_WEBHOOK_SECRET = 'test-webhook-secret-not-a-real-secret';
process.env.SCRYPT_N = '16384';
process.env.DB_PATH = ':memory:';
process.env.DRIFT_ENABLED = 'false';
process.env.BOT_ENABLED = 'false';

const assert = require('assert');
const crypto = require('crypto');

let passed = 0;
const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ok  ', name);
  } catch (e) {
    console.error('  FAIL', name);
    console.error(e);
    process.exit(1);
  }
};

const SECRET = process.env.PAYMENTS_WEBHOOK_SECRET;
const WINDOW = 300;

// Exactly the scheme server.js computes, so the test signs what the route
// verifies rather than a paraphrase of it.
function sign(body, timestamp) {
  return crypto.createHmac('sha256', SECRET).update(`${timestamp}.`).update(body).digest('hex');
}

(async () => {
  const srv = require('../server');
  await srv.ready;
  const server = srv.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = async (bodyObj, { timestamp, signature, raw } = {}) => {
    const body = raw !== undefined ? raw : JSON.stringify(bodyObj);
    const headers = { 'content-type': 'application/json' };
    if (timestamp !== undefined) headers['x-obx-timestamp'] = String(timestamp);
    if (signature !== undefined) headers['x-obx-signature'] = signature;
    const res = await fetch(`${base}/api/payments/webhook`, { method: 'POST', headers, body });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };

  const now = () => Math.floor(Date.now() / 1000);
  const newUser = async (name) => {
    const A = require('../lib/auth');
    return A.registerUser(srv.db, { username: name, password: 'secret1', balance_cents: 0 });
  };
  const balanceOf = (id) => srv.db.prepare('SELECT balance_cents b FROM users WHERE id = ?').get(id).b;

  try {
    const { openDeposit } = require('../lib/payments');

    await check('a signed, fresh delivery confirms the deposit once', async () => {
      const u = await newUser('wh1');
      const intent = await openDeposit(srv.db, u.id, 25000);
      assert.strictEqual(balanceOf(u.id), 0, 'opening an intent credits nothing');
      const body = JSON.stringify({ provider: 'reference', external_id: intent.external_id, amount_cents: 25000 });
      // The timestamp is read ONCE. Two separate now() calls can straddle a
      // second boundary, and the signature would then be computed over a
      // different second than the header carries — a flaky test that looks like
      // a security failure.
      const ts = now();
      const r = await post(null, { raw: body, timestamp: ts, signature: sign(body, ts) });
      assert.strictEqual(r.status, 200, `credited (${JSON.stringify(r.json)})`);
      assert.strictEqual(r.json.status, 'confirmed');
      assert.ok(!r.json.already_confirmed, 'the first delivery is not a replay');
      assert.strictEqual(balanceOf(u.id), 25000, 'exactly the intent amount');
    });

    await check('#26 a REDELIVERY answers 2xx already_confirmed and credits nothing more', async () => {
      const u = await newUser('wh2');
      const intent = await openDeposit(srv.db, u.id, 25000);
      const body = JSON.stringify({ provider: 'reference', external_id: intent.external_id, amount_cents: 25000 });
      const first = await post(null, { raw: body, timestamp: now(), signature: sign(body, now()) });
      assert.strictEqual(first.status, 200, 'the first delivery confirms');

      // THE ASSERTION. Before the fix this answered 404 with "No pending deposit
      // intent matches that external id" — indistinguishable from a genuinely
      // unknown id, and a 4xx is exactly what a provider retries and alerts on.
      const ts = now();
      const second = await post(null, { raw: body, timestamp: ts, signature: sign(body, ts) });
      assert.strictEqual(second.status, 200, `a duplicate is a 2xx, not a 404 (got ${second.status} ${JSON.stringify(second.json)})`);
      assert.strictEqual(second.json.already_confirmed, true, 'and says so explicitly');
      assert.strictEqual(second.json.status, 'confirmed');
      // The property that actually matters: the money moved once.
      assert.strictEqual(balanceOf(u.id), 25000, 'the redelivery credited NOTHING');
    });

    await check('a genuinely unknown external id is still a 404', async () => {
      const body = JSON.stringify({ provider: 'reference', external_id: 'ref_does-not-exist', amount_cents: 100 });
      const ts = now();
      const r = await post(null, { raw: body, timestamp: ts, signature: sign(body, ts) });
      // The control for the check above: if this also answered 200, the route
      // would be accepting everything and the duplicate check proves nothing.
      assert.strictEqual(r.status, 404, `an unknown id is still refused (got ${r.status})`);
    });

    await check('#26 a captured request cannot be replayed once the window passes', async () => {
      const u = await newUser('wh3');
      const intent = await openDeposit(srv.db, u.id, 25000);
      const body = JSON.stringify({ provider: 'reference', external_id: intent.external_id, amount_cents: 25000 });
      const capturedTs = now();
      const capturedSig = sign(body, capturedTs);

      const fresh = await post(null, { raw: body, timestamp: capturedTs, signature: capturedSig });
      assert.strictEqual(fresh.status, 200, 'the capture works while fresh');

      // Replay a correctly-signed request from OUTSIDE the window. Its signature
      // is genuine — nothing about it has changed — so only the window can
      // refuse it, and asserting 400 rather than 401 is what proves the window
      // did the refusing rather than the signature check.
      const staleTs = capturedTs - (WINDOW + 60);
      const stale = await post(null, { raw: body, timestamp: staleTs, signature: sign(body, staleTs) });
      assert.strictEqual(stale.status, 400, `a stale delivery is refused (got ${stale.status} ${JSON.stringify(stale.json)})`);
      assert.match(stale.json.error, /replay window/i, 'and says it was the replay window');
      assert.strictEqual(balanceOf(u.id), 25000, 'and nothing was credited');

      // THE IMPORTANT ONE. The same captured body and signature, presented with a
      // FRESH timestamp, must not verify — that is what makes the timestamp part
      // of the MAC rather than a field the route merely reads. If it verified,
      // one captured body would yield an unlimited supply of valid requests,
      // which is a WORSE hole than the one being closed. The timestamp is
      // offset by 60 so it cannot coincide with the captured one by accident.
      const forged = await post(null, { raw: body, timestamp: capturedTs - 60, signature: capturedSig });
      assert.strictEqual(forged.status, 401, `editing the timestamp invalidates the signature (got ${forged.status})`);
      assert.strictEqual(balanceOf(u.id), 25000, 'still nothing credited');
    });

    await check('the route is default-deny: no timestamp, no signature, wrong signature', async () => {
      const body = JSON.stringify({ provider: 'reference', external_id: 'x', amount_cents: 100 });
      // No signature at all.
      assert.strictEqual((await post(null, { raw: body, timestamp: now() })).status, 401, 'unsigned');
      // A valid signature for one timestamp, presented with another.
      const ts = now();
      assert.strictEqual((await post(null, { raw: body, timestamp: ts, signature: sign(body, ts + 1) })).status, 401, 'timestamp swap');
      // Signature over a different body.
      assert.strictEqual((await post(null, { raw: body + ' ', timestamp: ts, signature: sign(body, ts) })).status, 401, 'body tamper');
      // Signature from the wrong secret.
      const wrong = crypto.createHmac('sha256', 'wrong-secret').update(`${ts}.`).update(body).digest('hex');
      assert.strictEqual((await post(null, { raw: body, timestamp: ts, signature: wrong })).status, 401, 'wrong secret');
      // THE DECISIVE ONE. A signature over the body ALONE — the scheme this route
      // used to accept — is refused. This is what makes the replay window real:
      // if a body-only MAC verified, an attacker who captured one could replay it
      // forever simply by sending a fresh `x-obx-timestamp` alongside it, since
      // that header would then be unauthenticated. "Accept both for backwards
      // compatibility" is exactly the change that would have left the hole open
      // while looking like it closed it.
      const bodyOnly = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
      const legacy = await post(null, { raw: body, timestamp: now(), signature: bodyOnly });
      assert.strictEqual(legacy.status, 401, `a body-only signature is refused (got ${legacy.status})`);
      // Missing timestamp entirely — the protocol error, reported as one.
      const noTs = await post(null, { raw: body, signature: sign(body, ts) });
      assert.strictEqual(noTs.status, 400, `a missing timestamp is a 400 (got ${noTs.status})`);
      assert.match(noTs.json.error, /timestamp/i);
    });

    console.log(`\nwebhook.test.js: ${passed} checks passed`);
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});