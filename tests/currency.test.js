// currency.test.js — one currency per tenant (#104).
// Run: node tests/currency.test.js   (plain assert, no deps)
//
// The issue this suite closes: `accounts.currency` was written with the literal
// 'USD' at two sites and READ BY NOTHING, and the unique index on
// (kind, IFNULL(user_id,0)) does not span currency — so a second currency hit
// the index, `INSERT OR IGNORE` swallowed it, and the caller carried on holding
// the account that already existed, in the wrong currency, with no error.
//
// So the properties under test are not "a column exists". They are:
//
//   C1-C3  the currency is a fact that is READ, and disagreeing with it is loud
//   C4     the silent no-op is loud, and leaves the row untouched
//   C5-C7  nothing anywhere still hard-codes a currency
//   C8-C10 the guards survive the paths that used to bypass them
//   C11-14 the migration, the config key, branding, and the payment seam
//
// Every check that acts asserts its PRE-STATE first. A test that passes when the
// code does nothing is a failed test, and the whole point of this issue is a
// control that reported success while doing nothing.
'use strict';

process.env.SCRYPT_N = '16384';
process.env.COMMISSION_RATE = '0.025';
process.env.BOT_ENABLED = 'false';
process.env.DRIFT_ENABLED = 'false';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const acc = require('../lib/accounts');
const L = require('../lib/ledger');
const T = require('../lib/tenants');
const PAY = require('../lib/payments');
const { transaction } = require('../lib/tx');
const config = require('../lib/config');

const VENUE = config.VENUE_CURRENCY;
const ROOT = path.join(__dirname, '..');

let passed = 0;
// Checks here are async (lib/auth.js derives password hashes off the event
// loop), so they are COLLECTED and drained in order at the bottom of this file
// rather than run eagerly.
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

async function fixture() {
  const db = openStore(':memory:');
  const alice = (await A.registerUser(db, { username: 'alice', password: 'pw-alice-123', balance_cents: 100000 }));
  return { db, alice };
}

// ── C1: the column is the venue's currency, not a literal ──────────────────

check('C1 a new account carries the tenant currency, and the tenant row carries it too', async () => {
  const { db, alice } = (await fixture());
  const row = db.prepare("SELECT currency FROM accounts WHERE kind='player_funds' AND user_id=?").get(alice.id);
  assert.strictEqual(row.currency, VENUE, 'the bucket is denominated in the venue currency');
  assert.strictEqual(T.currencyOf(db, T.defaultTenant(db).id), VENUE);
  assert.strictEqual(T.currencyForUser(db, alice.id), VENUE);
  db.close();
});

// The default on all three currency columns used to be the literal 'USD'. On an
// AUD venue that FABRICATED a denomination nobody chose — the exact defect the
// issue describes, one layer below the write sites it named.
check('C2 the schema default is the venue currency, not a hard-coded literal', async () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO users (username, pass_hash) VALUES ('c2', 'x')").run();
  // Deliberately NO currency column in any of these three, because that is the
  // whole point: whatever the database supplies is the assertion.
  const probes = [
    ['accounts', "INSERT INTO accounts (kind, user_id) VALUES ('house_float', NULL)", 0],
    ['payment_intents', "INSERT INTO payment_intents (user_id, provider, kind, amount_cents) VALUES (1, 'probe', 'deposit', 100)", 0],
    ['tenants', "INSERT INTO tenants (slug, name) VALUES ('c2-probe', 'C2 probe')", 0],
  ];
  for (const [table, sql] of probes) {
    db.prepare(sql).run();
    const got = db.prepare(`SELECT currency FROM ${table} ORDER BY rowid DESC LIMIT 1`).get().currency;
    assert.strictEqual(got, VENUE, `${table}.currency defaults to the venue currency, not a literal`);
  }
  // The whole point of that default being the VENUE's: a row inserted by
  // something that forgot a currency is denominated in money the venue trades
  // in, so it agrees with the tenant and every guard below stays quiet.
  assert.strictEqual(
    db.prepare('SELECT currency FROM accounts WHERE kind=? AND user_id IS NULL').get('house_float').currency,
    T.currencyOf(db, T.defaultTenant(db).id),
    'the defaulted bucket agrees with the tenant'
  );
  db.close();
});

// ── C3: a currency that disagrees is refused, naming both ───────────────────

check('C3 a bucket in another currency is refused, and the message names both', async () => {
  const { db, alice } = (await fixture());
  const before = db.prepare('SELECT id, currency FROM accounts WHERE kind=? AND user_id=?').get('player_funds', alice.id);
  assert.strictEqual(before.currency, VENUE, 'pre-state: the bucket is in the venue currency');

  // Ask for the same bucket in a different currency. Before #104 this was a
  // silent no-op: INSERT OR IGNORE lost to the unique index, and the caller
  // received `before.id` and carried on.
  assert.throws(
    () => acc.accountId(db, 'player_funds', alice.id, 'EUR'),
    (e) => /is denominated in AUD/.test(e.message) && /not EUR/.test(e.message),
    'the disagreement is an error naming both currencies'
  );

  // …and it changed nothing on the way out.
  const after = db.prepare('SELECT id, currency FROM accounts WHERE kind=? AND user_id=?').get('player_funds', alice.id);
  assert.deepStrictEqual(after, before, 'the refused call left the row exactly as it was');
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) c FROM accounts WHERE kind=? AND user_id=?').get('player_funds', alice.id).c,
    1,
    'and created no second bucket'
  );
  db.close();
});

// The specific silent no-op, isolated: a plain INSERT OR IGNORE of the same
// (kind, user_id) in a different currency is what the old code did, and what the
// unique index turns into nothing. Asserted directly so the property is pinned
// on the DATABASE's behaviour, not only on the service layer's.
check('C4 the unique index still refuses a second bucket, so option B is not expressible', async () => {
  const { db, alice } = (await fixture());
  const before = db.prepare('SELECT COUNT(*) c FROM accounts WHERE kind=? AND user_id=?').get('player_funds', alice.id).c;
  assert.strictEqual(before, 1, 'pre-state: one player_funds bucket');

  // Exactly what ensureAccountRow's insert does when the currencies disagree.
  const r = db
    .prepare('INSERT OR IGNORE INTO accounts (kind, user_id, currency) VALUES (?, ?, ?)')
    .run('player_funds', alice.id, 'EUR');
  assert.strictEqual(r.changes, 0, 'the insert did NOTHING and reported no error');
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) c FROM accounts WHERE kind=? AND user_id=?').get('player_funds', alice.id).c,
    1,
    'and created nothing — this is the no-op the read-back in ensureAccountRow exists to make loud'
  );
  assert.strictEqual(
    db.prepare('SELECT currency FROM accounts WHERE kind=? AND user_id=?').get('player_funds', alice.id).currency,
    VENUE,
    'the bucket kept the currency it already had'
  );
  db.close();
});

// ── C5: postings refuse to add two currencies together ─────────────────────

check('C5 a posting spanning two currencies is refused and writes NO entries', async () => {
  const { db, alice } = (await fixture());
  // A SECOND user, so two buckets can coexist at all: the unique index is on
  // (kind, IFNULL(user_id,0)), so one user has exactly one bucket per kind no
  // matter the currency (C4). Two USERS can hold different denominations — and
  // that is precisely the state post() has to refuse, because a settlement that
  // moved value between them would be adding two currencies together.
  const bob = (await A.registerUser(db, { username: 'bob', password: 'pw-bob-1234', balance_cents: 0 }));
  // ensureUserAccounts is the supported writer and it takes a currency, so
  // this is a bucket created through the real path — not a hand-written row.
  acc.ensureUserAccounts(db, bob.id, 'EUR');

  const fundsA = acc.accountId(db, 'player_funds', alice.id, VENUE);
  const fundsB = acc.accountId(db, 'player_funds', bob.id, 'EUR');
  assert.strictEqual(
    db.prepare('SELECT currency FROM accounts WHERE id=?').get(fundsB).currency,
    'EUR',
    'pre-state: the two buckets really are in different currencies'
  );

  const entriesBefore = db.prepare('SELECT COUNT(*) c FROM entries').get().c;
  const txBefore = db.prepare('SELECT COUNT(*) c FROM transactions').get().c;
  assert.ok(entriesBefore > 0, 'pre-state: the fixture has postings to lose');

  assert.throws(
    () =>
      transaction(db, () =>
        acc.post(db, {
          transaction_id: 0,
          memo: 'mixed',
          legs: [
            { account_id: fundsA, direction: 'debit', amount_cents: 100 },
            { account_id: fundsB, direction: 'credit', amount_cents: 100 },
          ],
        })
      ),
    (e) => /more than one currency/.test(e.message) && /AUD/.test(e.message) && /EUR/.test(e.message),
    'the mixed posting is refused'
  );

  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM entries').get().c, entriesBefore, 'NO entry was written');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, txBefore, 'and NO transaction row');
  assert.strictEqual(acc.balanceOf(db, fundsA), 100000, 'the real balance is untouched');
  assert.strictEqual(acc.balanceOf(db, fundsB), 0, 'and so is the other one');
  assert.strictEqual(acc.assertConserved(db), 0, 'and the ledger still balances');
  db.close();
});

// A control that refuses EVERYTHING is not a control. The same call in one
// currency must still work.
check('C6 a posting in ONE currency is still accepted — the guard is not "refuse all"', async () => {
  const { db, alice } = (await fixture());
  const funds = acc.accountId(db, 'player_funds', alice.id, VENUE);
  const venue = acc.accountId(db, 'house_float', null, VENUE);
  const before = acc.balanceOf(db, funds);
  transaction(db, () => {
    const txId = Number(
      db
        .prepare("INSERT INTO transactions (user_id, type, amount_cents, balance_after, frozen_after) VALUES (?, 'adjust', ?, ?, 0)")
        .run(alice.id, 250, before - 250).lastInsertRowid
    );
    acc.post(db, {
      transaction_id: txId,
      memo: 'single currency',
      legs: [
        { account_id: funds, direction: 'debit', amount_cents: 250 },
        { account_id: venue, direction: 'credit', amount_cents: 250 },
      ],
    });
  });
  assert.strictEqual(acc.balanceOf(db, funds), before - 250, 'the debit landed');
  assert.strictEqual(acc.balanceOf(db, venue), 250, 'and so did the credit');
  assert.strictEqual(acc.assertConserved(db), 0);
  db.close();
});

// Two callers resolve a PLAYER bucket with three arguments — userBalance()
// below, and the opening balance in lib/auth.js. Both are on the path a
// registering player takes. Resolved from the TENANT rather than defaulted to
// the venue's, because on a correctly configured venue those are the same value
// and the difference is invisible until they are not.
check('C6b a player bucket resolved without a currency follows the TENANT, not the venue', async () => {
  const { db, alice } = (await fixture());
  const bob = (await A.registerUser(db, { username: 'c6b', password: 'pw-c6b-1234', balance_cents: 0 }));
  // Give bob a tenant whose currency is NOT the venue's. configure() refuses
  // that through the API precisely because the ledger cannot hold it — so this
  // is written directly, to reach a state the guards exist to detect.
  const tid = Number(db.prepare("INSERT INTO tenants (slug, name, commission_bps, currency) VALUES ('c6b-other','C6b other',250,'GBP')").run().lastInsertRowid);
  db.prepare('UPDATE users SET tenant_id=? WHERE id=?').run(tid, bob.id);
  acc.ensureUserAccounts(db, bob.id, 'GBP');

  // The three-argument call — what auth.js does. It must resolve the TENANT's
  // currency, so it agrees with bob's GBP bucket and succeeds. The old
  // `currency = config.VENUE_CURRENCY` default would have resolved AUD against
  // a GBP row and thrown: that is the discriminating case.
  assert.strictEqual(
    db.prepare('SELECT currency FROM accounts WHERE id=?').get(acc.accountId(db, 'player_funds', bob.id)).currency,
    'GBP',
    'a player bucket resolved without a currency follows the TENANT'
  );
  // userBalance — the other three-argument caller — reads the same bucket, in
  // the same currency, rather than reporting a balance in the venue's.
  assert.strictEqual(acc.userBalance(db, bob.id, 'player_funds'), 0, 'and userBalance agrees');

  // …and it still ASSERTS: a bucket that disagrees with its own tenant is
  // refused, which is the guard that made the resolution worth doing.
  db.prepare('UPDATE accounts SET currency = ? WHERE kind=? AND user_id=?').run('AUD', 'player_funds', bob.id);
  assert.throws(
    () => acc.accountId(db, 'player_funds', bob.id),
    (e) => /is denominated in AUD/.test(e.message) && /not GBP/.test(e.message),
    'a bucket disagreeing with its TENANT is refused, not silently resolved'
  );
  assert.throws(() => acc.userBalance(db, bob.id, 'player_funds'), /is denominated in AUD/);

  // A venue singleton has no tenant, so it resolves to the venue's.
  assert.strictEqual(
    db.prepare('SELECT currency FROM accounts WHERE id=?').get(acc.accountId(db, 'house_float')).currency,
    VENUE,
    'a venue singleton is denominated in the venue currency'
  );
  db.close();
});

// ── C7: nothing in the source still hard-codes a currency ───────────────────
//
// The issue named eight sites. The regression guard is the thing that stops it
// becoming nine, and it is a grep rather than a test of behaviour because the
// defect being guarded against is precisely "a literal nothing reads".
check('C7 no source file hard-codes a currency literal outside the migration', async () => {
  const LEGITIMATE = [
    // The migration's ALTER fallback and its alignment predicate. Both must name
    // the old literal to recognise the rows it wrote.
    ['lib/store.js', /LEGACY_HARDCODED = 'USD'|ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'/],
    // Prose describing what used to be hard-coded. Comments are not sites:
    // `//`, JSDoc `*` continuations, `#` and SQL `--` all count.
    [null, /^\s*(\/\/|\*|#|--)/],
  ];
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });

  const offenders = [];
  for (const rel of ['lib', 'server.js']) {
    const files = rel.endsWith('.js') ? [path.join(ROOT, rel)] : walk(path.join(ROOT, rel));
    for (const file of files) {
      if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!/'USD'|"USD"/.test(line)) return;
          if (LEGITIMATE.some(([f, re]) => re.test(line) && (f === null || file.endsWith(f)))) return;
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
        });
    }
  }
  assert.deepStrictEqual(offenders, [], `currency literals reintroduced at ${offenders.join(', ')}`);
});

// The browser half. The issue's symptom was a '$' nobody chose, painted over
// every amount on every screen.
//
// A money sign is a '$' that is DATA: either glued to a digit ($10, $1,000) or
  // standing alone inside quotes ('$'). A '$' that opens a template literal or
  // precedes an interpolation is syntax, and OB.$ is the DOM helper — neither
  // is a currency. MONEY_SYMBOLS is the one legitimate place a '$' is a
  // character, because that is a display mapping keyed on the currency rather
  // than a currency anybody assumed.
check('C8 public/ renders no hard-coded money sign', async () => {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'public'))) {
    if (!/\.(js|html)$/.test(file)) continue;
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const isMoney = /\$\d/.test(line) || /['"]\$['"]/.test(line);
        if (!isMoney) return;
        if (/^\s*(\/\/|\*|<!--)/.test(line)) return;              // prose
        if (/MONEY_SYMBOLS\s*=/.test(line)) return;               // the display map
        offenders.push(`${path.relative(ROOT, file)}:${i + 1} ${line.trim().slice(0, 70)}`);
      });
  }
  assert.deepStrictEqual(offenders, [], `money signs left in public/: ${offenders.join(' | ')}`);
});

// The formatter itself, exercised in isolation against the same source the
// browser loads. It is the only place a currency becomes a character.
check('C9 the browser formatter follows the published code, not a literal', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
  const grab = (re) => {
    const m = src.match(re);
    assert.ok(m, `could not find ${re} in core.js — the test is stale, not the code passing`);
    return m[0];
  };
  const table = grab(/const MONEY_SYMBOLS = \{[^}]*\}/);
  const fn = grab(/function moneySymbol\(code\) \{[\s\S]*?\n  \}/);

  // moneySymbol + fmt + signed, evaluated with the real bodies and a real
  // `state`. Returns a formatter bound to a given code.
  const build = new Function(
    'state',
    `${table}\n${fn}\nconst fmt = (cents) => moneySymbol(state.currency) + ((Number(cents) || 0) / 100).toFixed(2);\n` +
      `const signed = (cents) => (cents >= 0 ? '+' : '\\u2212') + fmt(Math.abs(cents));\n` +
      'return { fmt, signed };'
  );

  for (const [code, expected] of [['USD', '$1.00'], ['AUD', 'A$1.00'], ['GBP', '£1.00'], ['EUR', '€1.00']]) {
    const { fmt } = build({ currency: code });
    assert.strictEqual(fmt(100), expected, `${code} renders as ${expected}`);
  }
  // An unlisted but well-formed code renders as ITSELF, not as a neighbour's
  // symbol — '$' is shared by dozens of currencies, which is the whole hazard.
  assert.strictEqual(build({ currency: 'BRL' }).fmt(100), 'BRL 1.00', 'an unlisted code renders as itself');
  // Nothing published renders with NO symbol. A missing symbol is visibly
  // missing; a wrong one is not.
  assert.strictEqual(build({ currency: null }).fmt(100), '1.00', 'no currency, no symbol');
  assert.strictEqual(build({ currency: 'aud' }).fmt(100), '1.00', 'a malformed code is not normalised into a real one');
  // signed() routes through fmt(), so it changes with it.
  assert.strictEqual(build({ currency: 'AUD' }).signed(-14043), '−A$140.43', 'signed() follows the currency');
});

// ── C10: the guards survive the paths that used to get through ──────────────

check('C10 a deposit intent in another currency is refused, and credits nothing', async () => {
  const { db, alice } = (await fixture());
  const balanceBefore = acc.userBalance(db, alice.id, 'player_funds');

  // A row in a currency that is not the tenant's. The column default is now the
  // venue's, so this has to be written deliberately — which is the improvement:
  // the old default did this FOR you, silently.
  const id = Number(
    db
      .prepare("INSERT INTO payment_intents (user_id, provider, external_id, kind, amount_cents, currency) VALUES (?, 'test', 'c10-x', 'deposit', 5000, 'EUR')")
      .run(alice.id).lastInsertRowid
  );
  assert.strictEqual(
    db.prepare('SELECT currency FROM payment_intents WHERE id=?').get(id).currency,
    'EUR',
    'pre-state: the intent really is in EUR'
  );

  assert.throws(
    () => PAY.confirmDeposit(db, id),
    (e) => e.status === 409 && /recorded in EUR/.test(e.message) && /trades in AUD/.test(e.message),
    'refused, naming both currencies'
  );
  assert.strictEqual(db.prepare('SELECT status FROM payment_intents WHERE id=?').get(id).status, 'pending', 'still pending');
  assert.strictEqual(
    acc.userBalance(db, alice.id, 'player_funds'),
    balanceBefore,
    'NOT ONE CENT was credited'
  );
  assert.strictEqual(acc.assertConserved(db), 0, 'and the ledger still balances');
  db.close();
});

// The control against "refuse everything": the ordinary path still works, and
// its ledger record is in the SAME transaction as the credit.
check('C11 a deposit in the tenant currency is credited, with its audit row', async () => {
  const { db, alice } = (await fixture());
  const before = acc.userBalance(db, alice.id, 'player_funds');
  const intent = await PAY.openDeposit(db, alice.id, 5000);
  const row = db.prepare('SELECT currency FROM payment_intents WHERE id=?').get(intent.intent_id);
  assert.strictEqual(row.currency, VENUE, 'the intent was created in the tenant currency');

  const res = PAY.confirmDeposit(db, intent.intent_id);
  assert.strictEqual(res.status, 'confirmed');
  assert.strictEqual(acc.userBalance(db, alice.id, 'player_funds'), before + 5000, 'the credit landed');

  // House rule: a money-moving mutation and its record are ONE transaction.
  // ledger.deposit writes the transactions row and the double-entry postings
  // inside a single transaction(), so the deposit is traceable to its external
  // counterparty — and there is no window in which the balance moved and the
  // posting did not.
  const tx = db.prepare("SELECT * FROM transactions WHERE user_id=? AND type='deposit' ORDER BY id DESC LIMIT 1").get(alice.id);
  assert.ok(tx, 'the credit wrote a ledger transaction');
  assert.strictEqual(tx.amount_cents, 5000, 'for exactly the amount confirmed');
  const legs = db.prepare('SELECT e.amount_cents, e.direction, a.kind FROM entries e JOIN accounts a ON a.id = e.account_id WHERE e.transaction_id = ?').all(tx.id);
  assert.strictEqual(legs.length, 2, 'the deposit posted two legs');
  assert.deepStrictEqual(legs.map((l) => l.kind).sort(), ['gateway_clearing', 'player_funds'], 'from the external clearing account to the player');
  // And the legs are in the same currency as the bucket they credit.
  assert.strictEqual(
    new Set(db.prepare('SELECT DISTINCT currency FROM accounts WHERE id IN (SELECT account_id FROM entries WHERE transaction_id = ?)').all(tx.id).map((r) => r.currency)).size,
    1,
    'one currency across the whole posting'
  );
  assert.strictEqual(acc.assertConserved(db), 0, 'and the ledger still balances');
  db.close();
});

// ── C12: the payment seam cannot pick its own currency ─────────────────────
//
// `createDepositIntent(userId, cents, currency = 'USD')` took a parameter its
// own caller ignored by passing a literal. It is KEPT and made REQUIRED — the
// signature has to be right for the real PSP integration this module exists to
// make room for. What was wrong was the default.
check('C12 the reference provider requires a currency rather than defaulting one', async () => {
  const { referenceProvider } = require('../lib/payments/reference');
  const p = referenceProvider();
  await assert.rejects(() => p.createDepositIntent(1, 1000), /currency must be/, 'no default: it is a refusal');
  await assert.rejects(() => p.createWithdrawal(1, 1000), /currency must be/, 'nor on the withdrawal seam');
  await assert.rejects(() => p.createDepositIntent(1, 1000, 'usd'), /currency must be/, 'and it is not normalised');
  const ok = await p.createDepositIntent(1, 1000, VENUE);
  assert.strictEqual(ok.status, 'pending', 'a named currency is accepted');
  // The provider's own record carries the currency it was told — which is the
  // point of keeping the parameter: a real PSP is handed a currency at intent
  // time and most refuse an intent without one.
  assert.strictEqual((await p.confirmDeposit(ok.externalId)).currency, VENUE, 'and the provider booked it in that currency');
  const w = await p.createWithdrawal(1, 1000, VENUE);
  assert.strictEqual((await p.confirmDeposit(w.externalId)).currency, VENUE, 'on the withdrawal seam too');
});

// ── C13: a tenant cannot be moved to another currency ──────────────────────

check('C13 a tenant currency that is not the venue\'s is refused, and nothing is written', async () => {
  const { db, alice } = (await fixture());
  const tid = T.defaultTenant(db).id;
  const other = Number(
    db.prepare("INSERT INTO tenants (slug, name, commission_bps, currency) VALUES ('c13','C13',250,?)").run('EUR').lastInsertRowid
  );
  const aliceRowBefore = db.prepare('SELECT tenant_id FROM users WHERE id=?').get(alice.id).tenant_id;

  assert.throws(
    () => T.configure(db, { actor: alice, tenantId: tid, currency: 'EUR' }),
    (e) => e.status === 400 && /accounts in AUD only/.test(e.message) && /deferred deliberately as option B/.test(e.message),
    'the refusal names what option B would need'
  );
  assert.strictEqual(db.prepare('SELECT currency FROM tenants WHERE id=?').get(tid).currency, VENUE, 'the row is unchanged');
  assert.strictEqual(db.prepare('SELECT currency FROM tenants WHERE id=?').get(other).currency, 'EUR', 'and so is any other');
  assert.strictEqual(db.prepare('SELECT tenant_id FROM users WHERE id=?').get(alice.id).tenant_id, aliceRowBefore, 'no user moved');

  // The venue's OWN currency is accepted, and audited — a column that cannot be
  // set through the audited path is a corruption waiting to happen.
  T.configure(db, { actor: alice, tenantId: tid, currency: VENUE });
  const audited = db
    .prepare("SELECT after FROM audit_log WHERE action='tenant.configured' AND target=? ORDER BY id DESC LIMIT 1")
    .get(`tenant:${tid}`);
  assert.ok(audited, 'the change was audited');
  assert.ok(JSON.parse(audited.after).currency === VENUE, 'and the audit row records the currency');
  db.close();
});

// ── C14: the migration converges a database written before #104 ────────────

check('C14 a pre-#104 database is aligned, including an intent pending at upgrade', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'obx-c14-'));
  const file = path.join(dir, 'old.db');
  try {
    // A database in the shape #104 found it: every account carrying the literal
    // the old write sites wrote, and a deposit intent still PENDING. That last
    // one is the trap — the migration relabels the account it would credit, so
    // an intent left behind can never be confirmed.
    let db = openStore(file);
    const u = (await A.registerUser(db, { username: 'old', password: 'pw-old-1234', balance_cents: 50000 }));
    T.defaultTenant(db); // lazily created on first use — materialise it
    db.prepare('UPDATE accounts SET currency = ?').run('USD');
    db.prepare('UPDATE tenants SET currency = ?').run('USD');
    const intent = db.prepare("INSERT INTO payment_intents (user_id, provider, external_id, kind, amount_cents, currency) VALUES (?, 'test', 'c14-x', 'deposit', 5000, 'USD')").run(u.id);
    db.close();

    db = openStore(file); // the upgrade
    assert.strictEqual(db.prepare('SELECT currency FROM accounts WHERE user_id=?').get(u.id).currency, VENUE, 'accounts aligned');
    assert.strictEqual(db.prepare('SELECT currency FROM tenants WHERE slug=?').get('default').currency, VENUE, 'tenants aligned');
    assert.strictEqual(
      db.prepare('SELECT currency FROM payment_intents WHERE id=?').get(Number(intent.lastInsertRowid)).currency,
      VENUE,
      'the pending intent was aligned too — otherwise this deposit could never be paid'
    );
    // Idempotent: a second boot writes nothing.
    const snapshot = db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
    db.close();
    db = openStore(file);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM accounts').get().c, snapshot, 're-runnable');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── C15: the config key, and what branding publishes ──────────────────────

check('C15 the venue currency is a real config key, and branding publishes it', async () => {
  assert.strictEqual(typeof config.VENUE_CURRENCY, 'string');
  assert.match(config.VENUE_CURRENCY, /^[A-Z]{3}$/, 'a well-formed code');
  assert.strictEqual(config.VENUE_CURRENCY, 'AUD', 'this deployment is an Australian venue (#138)');
  // The rule is one rule, shared: a tenant and the config are held to it.
  assert.strictEqual(config.isCurrencyCode('AUD'), true);
  assert.strictEqual(config.isCurrencyCode('aud'), false, 'lower case is refused, not normalised');
  assert.strictEqual(config.isCurrencyCode('AU'), false);
  assert.strictEqual(config.isCurrencyCode(null), false, 'and never throws');
  assert.throws(() => config.currencyCode('dollars', 'test'), /three-letter uppercase/);

  const { db, alice } = (await fixture());
  const b = T.branding(db, T.ofUser(db, alice.id).id);
  assert.strictEqual(b.currency, VENUE, 'branding publishes the currency the browser formats with');
  db.close();
});

// A malformed stored code is a MONEY bug and is refused; a well-formed unknown
// one is only a DISPLAY question, and the browser answers that by rendering it.
check('C16 a malformed stored tenant currency is refused, not silently used', async () => {
  const { db, alice } = (await fixture());
  const tid = T.defaultTenant(db).id;
  db.prepare('UPDATE tenants SET currency=? WHERE id=?').run('dollars', tid);
  assert.throws(() => T.currencyOf(db, tid), (e) => e.status === 500 && /no usable currency/.test(e.message));
  // …and the ledger refuses to book against it, rather than inventing a value.
  assert.throws(() => L.deposit(db, alice.id, 1000, 100000), /no usable currency/);
  db.close();
});

(async () => {
  // Drained IN ORDER and awaited: a check that rejects is a failure of this
  // suite, not of the next file.
  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (e) {
      console.error(`  FAIL ${name}`);
      console.error(e);
      process.exit(1);
    }
    passed++;
    console.log('  ok  ', name);
  }
  const expected = checks.length;
  if (passed < expected) { console.error(`expected ${expected} checks`); process.exit(1); }
  console.log(`\ncurrency.test.js: ${passed} checks passed`);
})();