// tests/express5.test.js — the Express 4 → 5 migration, pinned.
//
// Run: node tests/express5.test.js
//
// WHY THIS FILE IS MOSTLY MECHANICAL. A migration is the one kind of change
// where a green suite proves least. Express 5's differences from 4 are, by and
// large, INVISIBLE to a passing suite: the query parser changed default and no
// test failed; `req.body` stopped defaulting to `{}` and no test failed,
// because every read in server.js was already guarded; auto-forwarding of async
// rejections changed nothing, because every async handler already caught its
// own rejection. Those three are the reason the dependency bump could be
// merged as a no-op and nobody would learn anything from the 758 checks that followed it.
//
// So each item below asserts the property directly, in the way that fails if
// the property stops holding — and E0 exists because a migration that only
// proves "the suite still passes" has proved nothing at all.
//
// There is no E2. The numbering skips it deliberately rather than by accident:
// the check that would have been E2 ("server.js can be required at all under
// Express 5") is not a check, it is the absence of a crash — and requiring the
// module IS that, as everything below runs inside `main()` after the import. A
// number left as a gap with the reason attached reads better than a placeholder
// that asserts nothing.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let passed = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ok', name);
  } catch (e) {
    failures.push(name);
    console.error('  FAIL', name);
    console.error('       ', e.message);
    process.exitCode = 1;
  }
};

// Everything the server needs before `require('../server')` is meaningful.
// Pinned here rather than inherited: lib/config.js lets process.env win over the
// repo's .env, so a developer with FEED_ENABLED=true would otherwise see
// several of these fail for a reason that has nothing to do with this code.
process.env.SCRYPT_N = process.env.SCRYPT_N || '16384';
process.env.DB_PATH = ':memory:';
process.env.DRIFT_ENABLED = 'false';
process.env.BOT_ENABLED = 'false';
process.env.FEED_ENABLED = 'false';
process.env.FEED_RUNNER_ENABLED = 'false';
process.env.FEED_DATABASE_URL = '';
process.env.FEED_CREDENTIALS_KEY = require('crypto').randomBytes(32).toString('hex');

const expressVersion = require('express/package.json').version;

/**
 * Remove WHOLE-LINE and block comments from JS source.
 *
 * Both source checks below (E4's bracketed-query scan, E5b's unguarded
 * `req.body` scan) were failing on their own subject matter: server.js
 * documents this very migration in comments that MENTION `?filter[a]=1` and
 * `req.body.dir`, precisely to explain why neither is read. A scan that reads
 * comment text reports the explanation as the bug, and a check with false
 * positives gets switched off.
 *
 * Only WHOLE-LINE comments are removed, and block comments. A naive `//` strip
 * would truncate `console.log(\`...http://...\`)` in server.js at the scheme,
 * silently deleting real code from the text being checked. Every comment in
 * this codebase is on its own line, which is what makes the conservative
 * version sufficient.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*'));
    })
    .join('\n');
}

const SERVER_CODE = stripComments(SERVER_SRC);

async function main() {
  // ── E0: the premise ───────────────────────────────────────────────────────

  // If this one check fails, nothing else in this file means anything, and the
  // whole migration can be silently reverted with a green suite. It is the
  // cheapest possible guard against that and it is worth having for that reason
  // alone.
  await check('E0 express is major version 5 — the migration cannot be silently reverted', () => {
    const major = Number(expressVersion.split('.')[0]);
    assert.strictEqual(major, 5, `express ${expressVersion} is installed; this suite only means something on 5.x`);
    assert.strictEqual(require(path.join(ROOT, 'package.json')).dependencies.express, '^5.3.0');
    assert.strictEqual(require(path.join(ROOT, 'package.json')).devDependencies.playwright, '^1.64.0');
  });

  // ── E1: the boot blocker ──────────────────────────────────────────────────

  // Every registered path, checked against the three syntaxes path-to-regexp v8
  // removed. This is a SOURCE check rather than an HTTP one on purpose: the
  // failure it guards against happens while server.js is being required, so by
  // the time a route could be exercised over HTTP the file has either loaded or
  // it has not — and "it did not load" kills every other check in the suite
  // with an unhelpful require error instead of naming the offending path.
  await check('E1 no registered path uses syntax path-to-regexp v8 removed', () => {
    const registered = [
      ...SERVER_SRC.matchAll(/^app\.(?:get|post|put|patch|delete|use|all|options|head)\(\s*(['"`])([^'"`]+)\1/gm),
    ].map((m) => m[2]);
    assert.ok(registered.length > 50, `found ${registered.length} registrations; the regex missed some`);

    const removed = [
      { re: /:\w+\?/, what: 'optional parameter (:name?)' },
      { re: /:\w+\*/, what: 'zero-or-more parameter (:name*)' },
      { re: /:\w+\+/, what: 'one-or-more parameter (:name+)' },
      { re: /(^|\/)\*(?:\/|$)/, what: 'unnamed wildcard (*)' },
      { re: /\(\?:?/, what: 'inline regex group' },
    ];
    for (const path of registered) {
      for (const { re, what } of removed) {
        assert.ok(!re.test(path), `path "${path}" uses ${what}, which Express 5 throws on at registration`);
      }
    }

    // And the specific claim from issue #74, named rather than pattern-matched:
    // the three routes that made the Dependabot bump unbootable are registered
    // BOTH with an id and without one, so the documented optional form survives.
    for (const [method, base] of [
      ['put', '/api/admin/feed/credentials'],
      ['delete', '/api/admin/feed/credentials'],
      ['get', '/api/admin/feed/runner'],
    ]) {
      for (const suffix of ['', '/:id']) {
        const needle = `app.${method}('${base}${suffix}'`;
        assert.ok(SERVER_SRC.includes(needle), `${method.toUpperCase()} ${base}${suffix} is not registered`);
      }
    }
  });

  // ── E2: the migration itself, over real HTTP ──────────────────────────────
  //
  // Everything below needs a live server, so it is all inside one block. The
  // env above is what makes requiring server.js safe offline.
  const srv = require('../server');
  // Await the seed before listening. `ready` is exported for exactly this, and
  // the first version of this suite skipped it — so registration raced the
  // seed and this suite's own admin landed on user id 1. See E3 for what that
  // coincidence nearly hid.
  await srv.ready;
  const server = srv.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, p, { body, cookie, contentType, raw } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = contentType || 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + p, {
      method,
      headers,
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text, setCookie, headers: res.headers };
  };
  const cookieOf = (r) => (r.setCookie.find((c) => c.startsWith('ob_session=')) || '').split(';')[0];

  const mk = async (username, role, tenantId) => {
    const r = await call('POST', '/api/auth/register', { body: { username, password: 'pw-test-1234' } });
    assert.ok(r.status === 200 || r.status === 201, `register ${username} -> ${r.status} ${r.text.slice(0, 120)}`);
    const id = r.json.user.id;
    if (role) srv.db.prepare(`UPDATE users SET role=? WHERE id=?`).run(role, id);
    if (tenantId !== undefined) srv.db.prepare('UPDATE users SET tenant_id=? WHERE id=?').run(tenantId, id);
    return { id, cookie: cookieOf(r), username };
  };

  const admin = await mk('ex5admin', 'admin');
  const player = await mk('ex5player', null);
  const GOOD = { app_key: 'TESTKEYnotreal12', username: 'ex5.bettfair-demo', password: 'not-a-real-password' };
  const T = '/api/admin/feed';

  // ── E3: the optional form, which had no test at all ───────────────────────
  //
  // Issue #74: "there is also no test exercising the optional form, so the
  // current behaviour is unpinned". This is that test. Before it existed, the
  // migration's first three routes could have been deleted outright and 739
  // green checks would not have noticed — the route the documentation promises
  // is the one the documentation itself describes as untested.
  await check('E3 the no-id form of all three routes works and matches the :id form', async () => {
    // THE ID ON THESE ROUTES IS A TENANT ID, NOT A USER ID.
    //
    // The first version of this check used `admin.id` — a user id — and passed,
    // because in that run the test's own admin had been handed id 1 by racing
    // the seed, and the default tenant is also id 1. Two unrelated ids
    // coinciding is precisely the failure docs/ARCHITECTURE.md warns about
    // ("a regression test that passed with the bug reintroduced, because two
    // ids coincided"). The id is read from the tenants table, and E3c asserts
    // the boundary against a tenant id that is definitely somebody else's.
    const ownTenantId = srv.db.prepare("SELECT id FROM tenants WHERE slug = 'default'").get().id;
    assert.notStrictEqual(ownTenantId, admin.id,
      'this fixture happens to give the admin a user id equal to its tenant id; the check would be coincidence-driven');

    // GET the runner, with and without an id. Same body.
    const withId = await call('GET', `${T}/runner/${ownTenantId}`, { cookie: admin.cookie });
    const withoutId = await call('GET', `${T}/runner`, { cookie: admin.cookie });
    assert.strictEqual(withId.status, 200, withId.text.slice(0, 160));
    assert.strictEqual(withoutId.status, 200, `GET ${T}/runner -> ${withoutId.status} ${withoutId.text.slice(0, 160)}`);
    assert.deepStrictEqual(
      withoutId.json,
      withId.json,
      'the runner status must not depend on whether the caller supplied an id — the :id was never read'
    );

    // PUT credentials without an id, then confirm by reading it back.
    const put = await call('PUT', `${T}/credentials`, { cookie: admin.cookie, body: GOOD });
    assert.strictEqual(put.status, 200, `PUT ${T}/credentials -> ${put.status} ${put.text.slice(0, 160)}`);
    assert.strictEqual(put.json.configured, true);
    for (const secret of Object.values(GOOD)) {
      assert.ok(!put.text.includes(secret), `the no-id PUT leaked ${secret}`);
    }
    const read = await call('GET', `${T}/credentials/${ownTenantId}`, { cookie: admin.cookie });
    assert.strictEqual(read.json.configured, true, 'the no-id write stored a credential');

    // DELETE without an id.
    const del = await call('DELETE', `${T}/credentials`, { cookie: admin.cookie });
    assert.strictEqual(del.status, 200, `DELETE ${T}/credentials -> ${del.status} ${del.text.slice(0, 160)}`);
    assert.strictEqual(del.json.cleared, true);
    const after = await call('GET', `${T}/credentials`, { cookie: admin.cookie });
    assert.strictEqual(after.json.tenants[0].configured, false, 'the no-id delete removed it');
  });

  await check('E3b the no-id forms are still admin-only — the auth gate did not move', async () => {
    // Registering a route twice is exactly the kind of change that can drop a
    // middleware from one of the two registrations, so the guard is re-asserted
    // on the NEW paths rather than assumed from the old ones.
    for (const [method, path, body] of [
      ['PUT', `${T}/credentials`, GOOD],
      ['DELETE', `${T}/credentials`, undefined],
      ['GET', `${T}/runner`, undefined],
    ]) {
      const anon = await call(method, path, { body });
      assert.ok(anon.status === 401 || anon.status === 403, `${method} ${path} anon -> ${anon.status}, expected 401/403`);
      const asPlayer = await call(method, path, { body, cookie: player.cookie });
      assert.ok(
        asPlayer.status === 401 || asPlayer.status === 403,
        `${method} ${path} as a player -> ${asPlayer.status}, expected 401/403`
      );
    }
  });

  await check('E3c the :id form still refuses a foreign tenant, and the no-id form cannot be used to bypass it', async () => {
    // The tenant boundary must not differ between the two registrations. It is
    // checked by naming another tenant every way feedTenantId() reads one: path
    // (the :id form) and body (the no-id form).
    const other = srv.db.prepare("INSERT INTO tenants (slug, name) VALUES ('ex5-other', 'Ex5 Other')").run();
    const otherId = Number(other.lastInsertRowid);

    const viaPath = await call('PUT', `${T}/credentials/${otherId}`, { cookie: admin.cookie, body: GOOD });
    assert.ok(viaPath.status === 403 || viaPath.status === 404,
      `PUT ${T}/credentials/${otherId} -> ${viaPath.status}, expected 403/404`);

    const viaBody = await call('PUT', `${T}/credentials`, { cookie: admin.cookie, body: { ...GOOD, tenant_id: otherId } });
    assert.ok(viaBody.status === 403 || viaBody.status === 404,
      `PUT ${T}/credentials with tenant_id=${otherId} -> ${viaBody.status}, expected 403/404`);

    const delPath = await call('DELETE', `${T}/credentials/${otherId}`, { cookie: admin.cookie });
    assert.ok(delPath.status === 403 || delPath.status === 404, `DELETE .../${otherId} -> ${delPath.status}`);

    const delBody = await call('DELETE', `${T}/credentials`, { cookie: admin.cookie, body: { tenant_id: otherId } });
    assert.ok(delBody.status === 403 || delBody.status === 404, `DELETE no-id with tenant_id -> ${delBody.status}`);

    // An unknown tenant is a 404 either way, which is what A6 pins for the :id
    // form; checked here so the no-id form is not a quieter one.
    const unknown = await call('PUT', `${T}/credentials/99999`, { cookie: admin.cookie, body: GOOD });
    assert.strictEqual(unknown.status, 404, `unknown tenant -> ${unknown.status}, expected 404`);
  });

  // ── E4: the query parser ──────────────────────────────────────────────────

  await check('E4 the query parser is pinned explicitly, and nested syntax is genuinely unused', async () => {
    // Asserted in TWO halves, because the live value alone is not enough and the
    // first version of this check was written that way — which is how it came
    // to pass with the `app.set` line deleted. Express 5's DEFAULT is already
    // 'simple', so `app.get('query parser')` returns 'simple' whether the
    // application pinned it or not, and the check read as proof of a decision
    // that had not been made.
    //
    // What is actually wanted is the pin, not the value: the point of writing
    // the setting down is that the behaviour stops depending on which framework
    // version is installed. So the live value is asserted AND the explicit
    // `app.set` is required to be there.
    assert.strictEqual(srv.app.get('query parser'), 'simple',
      'the live query parser must be `simple`');
    assert.ok(
      /app\.set\(\s*['"]query parser['"]/.test(SERVER_SRC),
      'server.js must set `query parser` EXPLICITLY. Express 5 defaults to the same value, so the live ' +
      'assertion above cannot tell a deliberate pin from an inherited default — which is exactly what ' +
      'happened when this check was first written.'
    );
    // And it is pinned to the value the audit below justifies, not merely to
    // "whatever it currently is".
    assert.match(SERVER_SRC, /app\.set\(\s*['"]query parser['"]\s*,\s*['"]simple['"]\s*\)/,
      'the pinned value must be the audited one (`simple`)');

    // The audit behind that choice, re-run mechanically: a bracketed query
    // parameter anywhere in the codebase would be silently unreadable under
    // `simple`. No route reads one (server.js is the only file that reads a
    // query string at all), and the only query BUILDER — public/admin.js, two
    // URLSearchParams calls — is flat.
    //
    // tests/ is deliberately NOT scanned: this file itself constructs
    // `?filter[a]=1` as the probe that proves `simple` does not expand it, so
    // scanning the tests would make this check fail on its own evidence.
    const scan = ['server.js', 'lib', 'public', 'docs', 'scripts'];
    const hits = [];
    const walk = (p) => {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        for (const f of fs.readdirSync(p)) walk(path.join(p, f));
        return;
      }
      if (!/\.(js|mjs|html|md)$/.test(p)) return;
      let src = fs.readFileSync(p, 'utf8');
      // Comments are excluded from JS for the reason SERVER_CODE documents:
      // server.js explains this very decision in a comment that quotes
      // `?filter[a]=1`, so a naive scan reports the explanation as the bug.
      // Markdown and HTML have no such construct here, and stripping `//` from
      // them would eat URLs, so they are read as written.
      if (/\.(js|mjs)$/.test(p)) src = stripComments(src);
      for (const m of src.matchAll(/[?&][A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])+\s*=/g)) {
        hits.push(`${path.relative(ROOT, p)}: ${m[0]}`);
      }
    };
    for (const rel of scan) walk(path.join(ROOT, rel));
    assert.deepStrictEqual(hits, [], `bracketed query syntax found — \`simple\` would not parse it:\n${hits.join('\n')}`);
  });

  await check('E4b every flat query parameter a route reads still parses identically', async () => {
    // The audit says no route reads nested syntax; this says the parameters they
    // DO read arrive at the handler as the same strings they did under Express 4.
    //
    // It authenticates, and it asserts the filter TOOK EFFECT. The first version
    // of this check called the routes anonymously and accepted "200 or 401",
    // which meant it passed against a parser that ignored the query string
    // entirely — proven by swapping in `app.set('query parser', () => ({}))` and
    // watching it stay green. A check that cannot fail on the thing it names is
    // not a check.
    const alice = await mk('ex5-alice', null);
    const bob = await mk('ex5-bob', null);

    // `q` must actually filter. If the parser dropped it, `?q=ex5-alice` would
    // return the same list as no query at all and the first assertion would see
    // two users, not one.
    const filtered = await call('GET', '/api/admin/users?q=ex5-alice', { cookie: admin.cookie });
    assert.strictEqual(filtered.status, 200, filtered.text.slice(0, 160));
    const users = (filtered.json && filtered.json.users) || [];
    assert.ok(users.length >= 1, `?q=ex5-alice returned no users: ${filtered.text.slice(0, 160)}`);
    assert.ok(users.every((u) => u.username === 'ex5-alice'),
      `?q=ex5-alice returned ${users.map((u) => u.username).join(',')} — the query parameter did not filter`);

    // A different value must select a different set, or `q` is being ignored.
    const other = await call('GET', '/api/admin/users?q=ex5-bob', { cookie: admin.cookie });
    const others = (other.json && other.json.users) || [];
    assert.ok(others.every((u) => u.username === 'ex5-bob'), 'and ?q=ex5-bob selected the wrong set');

    // `limit` must bound the page.
    const limited = await call('GET', '/api/admin/users?limit=1', { cookie: admin.cookie });
    assert.strictEqual(limited.status, 200, limited.text.slice(0, 160));
    assert.ok((limited.json.users || []).length <= 1, `?limit=1 returned ${(limited.json.users || []).length} users`);

    // `from`/`to`/`format` reach REPORTS.period and select the response shape, so
    // a single query exercises two parameters and an observable effect.
    const asJson = await call('GET', '/api/admin/reports/summary?format=json', { cookie: admin.cookie });
    assert.strictEqual(asJson.status, 200, asJson.text.slice(0, 160));
    assert.ok(asJson.json && !String(asJson.json).includes('csv'), '?format=json returned JSON');
    const asCsv = await call('GET', '/api/admin/reports/summary?format=csv', { cookie: admin.cookie });
    assert.ok(asCsv.status === 200 && asCsv.text.includes(','), `?format=csv -> ${asCsv.status} ${asCsv.text.slice(0, 80)}`);

    // A bracketed parameter is NOT expanded, and — the part that would matter if
    // a route ever did start reading one — it does not disturb the flat keys
    // beside it.
    const bracketed = await call('GET', '/api/admin/users?filter%5Ba%5D=1&filter%5Bb%5D=2&q=ex5-alice', { cookie: admin.cookie });
    assert.strictEqual(bracketed.status, 200, bracketed.text.slice(0, 160));
    assert.ok((bracketed.json.users || []).every((u) => u.username === 'ex5-alice'),
      'a bracketed parameter broke the flat `q` beside it, which it must not do');
    assert.ok((bracketed.json.users || []).length < users.length + 5, 'and produced no phantom rows');
  });

  // ── E5: req.body with no matching parser ──────────────────────────────────

  await check('E5 req.body really is undefined under Express 5, not an empty object', async () => {
    // The premise of the whole item, asserted directly rather than assumed. A
    // POST whose Content-Type no parser claims must leave req.body undefined.
    const probe = require('express')();
    probe.use(expressJson());
    let seen = 'not-called';
    probe.post('/probe', (req, res) => {
      seen = req.body === undefined ? 'undefined' : `object:${JSON.stringify(req.body)}`;
      res.json({ seen });
    });
    const s2 = probe.listen(0, '127.0.0.1');
    await new Promise((r) => s2.on('listening', r));
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    // finally, for the same reason as E7b: a failed assertion between here and
    // the close would leak the listener and hang the whole run instead of
    // failing it.
    try {
      const r = await fetch(b2 + '/probe', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'this is not json',
      });
      await r.text();
    } finally {
      s2.close();
    }
    assert.strictEqual(seen, 'undefined',
      'Express 5 leaves req.body undefined when no parser matched — this is the behaviour E5b protects');
  });

  await check('E5b no route reads req.body.x without guarding for undefined', async () => {
    // The audit: every read in server.js is `req.body || {}`, `req.body?.x`, or
    // an explicit `req.body ? ... : ...`. Under Express 4 an unguarded read was
    // a silent `undefined`; under Express 5 it is a TypeError, so this is worth
    // a mechanical check rather than a habit. Comment prose is excluded — see
    // SERVER_CODE, which explains why including it produced false positives.
    const unguarded = [];
    for (const m of SERVER_CODE.matchAll(/req\.body(\.[A-Za-z_$][\w$]*|\[[^\]]+\])/g)) {
      // The line this read is on, up to the read itself.
      const lineStart = SERVER_CODE.lastIndexOf('\n', m.index) + 1;
      const line = SERVER_CODE.slice(lineStart, m.index);
      const guarded =
        /req\.body\s*(\|\||\?\.|\?)/.test(line) ||
        /req\.body\s*\?/.test(line) ||
        /req\.body\s*&&\s*$/.test(line);
      if (!guarded) unguarded.push(`${SERVER_CODE.slice(lineStart, SERVER_CODE.indexOf('\n', m.index)).trim()}`);
    }
    assert.deepStrictEqual(unguarded, [],
      `these read req.body without guarding for undefined, which is a TypeError under Express 5:\n${unguarded.join('\n')}`);
  });

  await check('E5c a body-less POST is a client error, not a 500, on the money routes', async () => {
    // The observable consequence. An unmatched content-type leaves req.body
    // undefined; if any of these handlers dereferenced it blindly the venue
    // would answer 500 — an Internal error — for what is a malformed request.
    // Each of these must answer the SAME way it answers a well-formed request
    // with the fields absent, which is 4xx from the engine's own validation.
    const asText = async (method, p, cookie) =>
      call(method, p, { cookie, raw: 'this is not json', contentType: 'text/plain' });
    const asNoBody = async (method, p, cookie) => call(method, p, { cookie });

    // Wallet deposit with an unparsed body: the engine refuses the amount.
    for (const [label, r] of [
      ['text/plain body', await asText('POST', '/api/wallet/deposit', player.cookie)],
      ['no body at all', await asNoBody('POST', '/api/wallet/deposit', player.cookie)],
    ]) {
      assert.ok(r.status >= 400 && r.status < 500,
        `POST /api/wallet/deposit with ${label} -> ${r.status} ${r.text.slice(0, 120)}; a 500 here means a TypeError on req.body`);
    }

    // The order placement route.
    const order = await asText('POST', '/api/orders', player.cookie);
    assert.ok(order.status >= 400 && order.status < 500,
      `POST /api/orders with an unparsed body -> ${order.status} ${order.text.slice(0, 120)}`);

    // The credential write: this one owns an `req.body || {}` guard of its own.
    const creds = await asText('PUT', `${T}/credentials`, admin.cookie);
    assert.ok(creds.status >= 400 && creds.status < 500,
      `PUT credentials with an unparsed body -> ${creds.status} ${creds.text.slice(0, 120)}`);

    // And a webhook with no parsed body — the signature check runs before the
    // body is read, so it must still answer 401/400 rather than 500.
    const hook = await asText('POST', '/api/payments/webhook', undefined);
    assert.ok(hook.status >= 400 && hook.status < 500,
      `POST /api/payments/webhook with an unparsed body -> ${hook.status} ${hook.text.slice(0, 120)}`);
  });

  // ── E6: the error handler under auto-forwarding ───────────────────────────

  await check('E6 errorHandler hands a post-response error on rather than answering twice', async () => {
    // This is the one place the migration genuinely changes errorHandler. Express
    // 5 forwards a rejected promise from an async handler automatically, so an
    // error can now arrive AFTER a response was written — which this function
    // would previously have tried to answer with a second res.json(). Tested
    // directly, because the condition (headersSent) cannot be produced over HTTP
    // from any route in this file.
    const calls = [];
    const fakeRes = {
      headersSent: true,
      status(code) { calls.push(['status', code]); return this; },
      json(body) { calls.push(['json', body]); return this; },
    };
    const seen = [];
    const err = new Error('arrived after the response');
    srv.errorHandler(err, {}, fakeRes, (e) => seen.push(e));

    assert.deepStrictEqual(seen, [err], 'the error must be passed to next(err), not swallowed');
    assert.deepStrictEqual(calls, [], `nothing may be written to a finished response, but it wrote ${JSON.stringify(calls)}`);
  });

  await check('E6b errorHandler still preserves a 4xx, genericises a 5xx, and still honours an opted-in expose', async () => {
    const run = (err) => {
      let out = null;
      srv.errorHandler(err, {}, { headersSent: false, status(c) { out = { status: c }; return this; }, json(b) { out.body = b; return this; } }, () => {});
      return out;
    };
    assert.strictEqual(run({ status: 400, message: 'nope' }).status, 400, 'a 4xx keeps its status');
    assert.strictEqual(run({ status: 409, message: 'dup' }).body.error, 'dup');
    assert.strictEqual(run(new Error('boom')).status, 500, 'a fault is a 500');
    assert.strictEqual(run(new Error('boom')).body.error, 'Internal error', 'and the message does not leak');
    assert.strictEqual(run({ status: 503, message: 'FEED_CREDENTIALS_KEY is not set', expose: true }).body.error,
      'FEED_CREDENTIALS_KEY is not set', 'an opted-in 503 still speaks');
  });

  // ── E7: async handlers still own their rejections ─────────────────────────

  await check('E7 every async route handler handles its own rejection', async () => {
    // WHY THIS IS ASSERTED RATHER THAN ASSUMED. Express 5 forwarding a rejected
    // promise into errorHandler is only safe if the handlers that carry
    // handler-specific policy on failure — a failed login records a strike
    // against the limiter, a feed outage answers 503 rather than 500 — still
    // reach that policy. A handler that relied on the rejection escaping to
    // crash the process loudly would now have it turned into an ordinary 500,
    // which is precisely the silent behaviour change issue #74 asked about.
    //
    // So the rule is mechanical: an `async` handler, or a promise chain, must
    // either be wrapped in aw() or contain an explicit catch/next(e).
    const offenders = [];
    const lines = SERVER_SRC.split('\n');

    // `app.<verb>(path, ... async (req, res[, next]) => {` … matched to its
    // closing `});` at the same indentation.
    for (let i = 0; i < lines.length; i++) {
      if (!/^app\.\w+\(/.test(lines[i])) continue;
      const isAsync = /,\s*async\s*\(/.test(lines[i]) || /aw\(async\s*\(/.test(lines[i]);
      if (!isAsync) continue;
      if (/aw\(async\s*\(/.test(lines[i])) continue; // aw() forwards explicitly
      const body = [];
      for (let j = i; j < lines.length; j++) {
        body.push(lines[j]);
        if (/^\}\);\s*$/.test(lines[j])) break;
      }
      const text = body.join('\n');
      const handles = /catch\s*\(/.test(text) || /\bnext\(e\)/.test(text);
      if (!handles) offenders.push(`line ${i + 1}: ${lines[i].trim().slice(0, 80)}`);
    }
    assert.deepStrictEqual(offenders, [],
      `these async handlers have no explicit rejection path, so Express 5 would turn a rejection into a bare 500:\n${offenders.join('\n')}`);

    // The promise-chained handlers: `.then(...)` must be terminated by `.catch(next)`
    // or a trailing `.catch(`.
    const chains = [...SERVER_SRC.matchAll(/^\s*(?:res\.json|Promise|PAY\.)[^\n]*\.then\(/gm)];
    for (const m of chains) {
      const tail = SERVER_SRC.slice(m.index, SERVER_SRC.indexOf(';', m.index) + 1);
      assert.ok(/\.catch\(/.test(tail),
        `a promise chain in a handler has no .catch, so Express 5 would be the only thing forwarding it: ${tail.trim().slice(0, 100)}`);
    }
  });

  await check('E7b Express 5 forwards an async rejection into THIS errorHandler, status intact', async () => {
    // The migration's actual question, asked against the real handler.
    //
    // The previous version of this check called POST /api/admin/results/poll,
    // whose name promised exactly this. It did not: lib/resultsfeed.js's
    // pollNow() catches internally and RETURNS `{ error }` rather than
    // rejecting, so the route's try/catch was never entered and the check
    // asserted only that a 200 came back. It stayed green with the catch
    // deleted. A check that cannot fail on the thing it names is worse than no
    // check.
    //
    // So this mounts the REAL exported errorHandler on a throwaway app with
    // handlers that genuinely reject. `srv.app` is untouched; the point is the
    // handler, not the routes.
    const probe = require('express')();
    probe.get('/probe/typed', async () => {
      throw Object.assign(new Error('typed async failure'), { status: 422 });
    });
    probe.get('/probe/untyped', async () => {
      await new Promise((r) => setTimeout(r, 1));
      throw new Error('untyped async fault carrying detail a client must not see');
    });
    probe.get('/probe/after-send', async (req, res) => {
      res.json({ delivered: true });
      await new Promise((r) => setTimeout(r, 1));
      throw new Error('rejected after the response was written');
    });
    probe.use(srv.errorHandler);
    const ps = probe.listen(0, '127.0.0.1');
    await new Promise((r) => ps.on('listening', r));
    const pb = `http://127.0.0.1:${ps.address().port}`;

    // try/finally, and this is not decoration. A `listen()`ed server that is not
    // closed keeps the process alive forever, so a FAILED ASSERTION ANYWHERE in
    // this check used to turn into a HANG rather than a failure — and a hang in
    // run_all.js wedges the remaining ~48 suites behind it, so one broken
    // expectation silently suppressed the entire rest of the suite.
    //
    // That is strictly worse than failing: the run produces no summary at all,
    // so the only evidence anything is wrong is that it stopped. It cost a full
    // diagnostic cycle hunting a hang that was really an assertion failure.
    try {
    // The status must SURVIVE auto-forwarding. If it did not, every 4xx thrown
    // from an async handler in this app would become a 500 — and the handlers
    // that matter here throw 400/403/409 for ordinary client mistakes
    // (validation, a foreign tenant, a duplicate slug).
    const typed = await fetch(pb + '/probe/typed');
    const typedBody = await typed.text();
    assert.strictEqual(typed.status, 422, `a 422 that auto-forwarded arrived as ${typed.status}: ${typedBody}`);
    assert.match(typedBody, /typed async failure/, 'and it carries its own message');

    // An untyped fault is still genericised — the error discipline E6b pins,
    // reached here through the NEW path rather than the old one.
    const untyped = await fetch(pb + '/probe/untyped');
    const untypedBody = await untyped.text();
    assert.strictEqual(untyped.status, 500);
    // The GENERICISING, not the exact byte string. This used to assert the body
    // was exactly `{"error":"Internal error"}`, which also pinned the absence of
    // every field not yet invented — so adding the deliberate `code` (#83) broke
    // it. What this check is for is that the underlying message does not escape,
    // and that is asserted directly below and is a stronger claim than the
    // whole-body comparison was.
    const untypedJson = JSON.parse(untypedBody);
    assert.strictEqual(untypedJson.error, 'Internal error', `untyped fault leaked its own message: ${untypedBody}`);
    assert.strictEqual(untypedJson.code, 'internal_error', 'a 5xx must still be machine-readable (#83)');
    assert.ok(!untypedBody.includes('untyped async fault'), 'the error message reached the client');
    assert.ok(!untypedBody.includes('detail a client must not see'), 'the detail string reached the client');

    // And the case E6's guard exists for: the response is already out, and the
    // rejection arrives anyway.
    //
    // WHAT THIS ASSERTS, PRECISELY: the client keeps the body it was sent. That
    // is true whether or not the `res.headersSent` guard is present — without
    // it, errorHandler writes a second response, Express turns that into
    // ERR_HTTP_HEADERS_SENT, and the default handler destroys the socket AFTER
    // the body was delivered. So this case is deliberately NOT a test of the
    // guard: it is the evidence that adding the guard did not change anything
    // a caller can observe, which is the thing a reviewer needs to know. E6 is
    // what pins the guard itself.
    const after = await fetch(pb + '/probe/after-send');
    const afterBody = await after.text();
    assert.strictEqual(after.status, 200, `the written response was disturbed: ${after.status}`);
    assert.strictEqual(afterBody, JSON.stringify({ delivered: true }), `body was ${afterBody}`);
    } finally {
      ps.close();
    }
  });

  // ── E8: removed APIs ──────────────────────────────────────────────────────

  await check('E8 the APIs Express 5 removed are absent from the codebase', async () => {
    // Re-verified rather than taken on trust (issue #74 says they were already
    // checked; a check nobody can re-run is a claim, not a control).
    const files = ['server.js', 'lib', 'public', 'scripts'];
    const banned = [
      { re: /\.del\s*\(/, what: 'app.del()' },
      { re: /\.sendfile\b/, what: 'res.sendfile' },
      { re: /req\.param\s*\(/, what: 'req.param()' },
      { re: /app\.param\s*\(/, what: 'app.param()' },
      { re: /\.sendstatus\s*\(/, what: 'res.sendstatus()' },
      { re: /res\.redirect\(\s*['"]back['"]/, what: "res.redirect('back')" },
      // `app.param()` still EXISTS in Express 5 (issue #74 says otherwise —
      // see E8b), but it is dead code here either way, so it stays on the list.
      { re: /app\.param\s*\(/, what: 'app.param()' },
    ];
    const hits = [];
    const walk = (p) => {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        for (const f of fs.readdirSync(p)) walk(path.join(p, f));
        return;
      }
      if (!/\.(js|mjs)$/.test(p)) return;
      const src = fs.readFileSync(p, 'utf8');
      for (const { re, what } of banned) {
        if (re.test(src)) hits.push(`${path.relative(ROOT, p)} uses ${what}`);
      }
    };
    for (const rel of files) walk(path.join(ROOT, rel));
    assert.deepStrictEqual(hits, [], hits.join('\n'));
  });

  await check('E8b the removed APIs are genuinely gone from the framework too', async () => {
    // The runtime half of E8. This is what makes E8's source scan worth
    // anything: if a future version restored one of them, this fails and the
    // scan's silence is explained rather than assumed safe.
    //
    // NOTE ON THE MEASUREMENT, because it corrects issue #74. That issue lists
    // `app.param()` among the APIs "verified absent already". It is NOT absent:
    // `app.param` is still a function on an Express 5.3.0 application. What
    // changed is that it is no longer called anywhere in this codebase (E8), so
    // it is dead either way — but the claim as written was wrong, and a
    // reviewer should not be told otherwise. `app.del`, `res.sendfile` and
    // `req.param()` are genuinely gone, as stated.
    //
    // Express 5 exposes `express.response` / `express.request` as OBJECTS of
    // methods rather than prototypes, so membership is tested with `in` on the
    // export and not on `.prototype` — which does not exist, and reading
    // `undefined.sendfile` is how the first version of this check failed.
    const app = require('express')();
    assert.strictEqual(typeof app.del, 'undefined', 'app.del is gone (it was a function on Express 4)');

    const { response, request } = require('express');
    assert.ok(!('sendfile' in response), 'res.sendfile is gone; res.sendFile is the only spelling');
    assert.ok('sendFile' in response, 'res.sendFile is the supported replacement and does exist');
    assert.ok(!('sendstatus' in response), 'res.sendstatus is gone');
    assert.ok(!('param' in request), 'req.param() is gone');
  });

  // ── E9: behaviour measured, not assumed ───────────────────────────────────

  await check('E9 the OPTIONS / auth-ordering behaviour is unchanged', async () => {
    // Express 5 adds an automatic OPTIONS response listing a route's methods,
    // and the router GENERATES IT BEFORE the route's middleware runs — so
    // `requireAdmin` never gets a say. On this app that could have meant
    // `OPTIONS /api/admin/users` answering 200 with an `Allow: GET` header to an
    // UNAUTHENTICATED caller: a route's existence and method set disclosed past
    // the admin gate. That is a real risk class in Express 5, so it is measured
    // on every route shape rather than reasoned about.
    //
    // It does not happen here, and the reason is structural: the `/api` 404
    // handler below the routes responds and never calls next(), so the router
    // never reaches the point where it would emit the automatic response. That
    // reason is worth knowing, because removing the 404 handler would change it —
    // so E9c asserts the 404 handler is load-bearing for this too.
    for (const path of ['/api/admin/users', '/api/orders', '/api/admin/feed/credentials', '/api/nope']) {
      const r = await call('OPTIONS', path);
      assert.strictEqual(r.status, 404, `OPTIONS ${path} -> ${r.status} ${r.text.slice(0, 80)}; a 200 with an Allow header means a route leaked its methods past the auth gate`);
      assert.strictEqual(r.headers.get('allow'), null,
        `OPTIONS ${path} returned an Allow header (${r.headers.get('allow')}) — that is the automatic response, and it bypasses requireAdmin`);
    }

    // An authenticated admin asking directly, to prove the route is genuinely
    // there and only the 404 handler is answering the anonymous case.
    const asAdmin = await call('OPTIONS', '/api/admin/users', { cookie: admin.cookie });
    assert.strictEqual(asAdmin.status, 404, `OPTIONS /api/admin/users as admin -> ${asAdmin.status} (unchanged from Express 4)`);
  });

  await check('E9b trailing slashes and case still behave as they did', async () => {
    // path-to-regexp v8 changed how paths are compiled, so the two tolerances
    // Express 4 had by default (non-strict trailing slash, case-insensitive) are
    // asserted rather than assumed.
    const bare = await call('GET', '/api/sports');
    const slashed = await call('GET', '/api/sports/');
    assert.strictEqual(bare.status, 200, bare.text.slice(0, 80));
    assert.strictEqual(slashed.status, 200, `GET /api/sports/ -> ${slashed.status}; Express 4 matched a trailing slash`);
    const upper = await call('GET', '/API/SPORTS');
    assert.strictEqual(upper.status, 200, `GET /API/SPORTS -> ${upper.status}; Express 4 matched case-insensitively`);
  });

  await check('E9c an unknown /api path is still JSON 404, never Express\'s HTML page', async () => {
    // Doubly load-bearing, not just cosmetic: this 404 is what keeps Express 5's
    // automatic OPTIONS response switched off for admin routes (see E9, and the
    // comment on the registration in server.js). Losing it does not just change
    // an error shape — it starts answering `OPTIONS` with a route's method list
    // to an unauthenticated caller.
    const r = await call('GET', '/api/definitely-not-a-route');
    assert.strictEqual(r.status, 404);
    assert.ok(r.json && r.json.error === 'Unknown endpoint', `expected the JSON 404, got ${r.text.slice(0, 120)}`);
    assert.ok(!/<html/i.test(r.text), 'and it must not be Express\'s HTML error page');
  });

  server.close();
  require('../lib/feedrunner').stopAll();

  console.log(`\nexpress5.test.js: ${passed} checks passed`);
  if (failures.length) {
    console.error(`failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

// express.json, used only by the E5 probe app.
function expressJson() {
  return require('express').json();
}

main().catch((e) => {
  console.error('express5.test.js threw:', e);
  process.exit(1);
});