// tests/config-embeddable.test.js — the package must work with NO .env file.
'use strict';

process.env.SCRYPT_N = process.env.SCRYPT_N || '16384';

// Regression suite for the plug-in contract: OpenBettingExchange supplies
// configuration as ENVIRONMENT VARIABLES and never writes a .env. Before this,
// four settings read `raw` instead of the merged defaults, so a fresh checkout
// with no .env died with
//     ConfigError: EVENT_TYPE_IDS must list at least one Betfair event type id
// even though DEFAULTS said "1,8". It only ever worked because the developer's
// .env already had the key spelled out.
//
// Run against the Python package from the repo root of OpenBettingExchangeDataFeed:
//   .venv/bin/python tests/test_config_is_embeddable.py

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const FEED = '/home/Joel/Desktop/OpenBettingExchangeDataFeed';
const PY = path.join(FEED, '.venv/bin/python');
const ABSENT = '/tmp/opencode/definitely-absent.env';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok', name);
  } catch (e) {
    console.error('  FAIL', name);
    console.error('       ', e.message);
    process.exitCode = 1;
  }
}

if (!fs.existsSync(PY)) {
  console.error('  SKIP — no interpreter at', PY);
  process.exit(0);
}

function boots(env, script) {
  // `env -i` so the ambient environment cannot supply what we mean to test.
  return execFileSync(PY, ['-c', script], {
    env: { PATH: '/usr/bin:/bin', HOME: '/tmp', ...env },
    encoding: 'utf8',
    cwd: '/tmp',
  });
}

const LOAD = `
import sys
sys.path.insert(0, ${JSON.stringify(FEED)})
from betfeed.config import load_config, validate_credentials
c = load_config(env_file=${JSON.stringify(ABSENT)})
missing = validate_credentials(c)
print('SPORTS=' + ','.join(sorted(c.event_type_names)))
print('LOGIN=' + c.login_mode)
print('MISSING=' + ','.join(missing))
print('MAXRES=' + str(c.catalogue_max_results))
print('BOOKCHUNK=' + str(c.book_chunk_size))
print('PROJ=' + ','.join(c.catalogue_projection))
`;

const BASE = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  BETFAIR_APP_KEY: 'k',
  BETFAIR_USERNAME: 'u',
  BETFAIR_PASSWORD: 'p',
};

function field(out, key) {
  const m = out.match(new RegExp(`^${key}=(.*)$`, 'm'));
  assert.ok(m, `${key} missing from output:\n${out}`);
  return m[1];
}

check('C1 boots from environment variables alone, with NO .env present', () => {
  const out = boots(BASE, LOAD);
  assert.strictEqual(field(out, 'SPORTS'), '1,8', `sports: ${out}`);
});

check('C2 the defaults a fresh user gets are DELAY-KEY SAFE', () => {
  // Betfair issues a DELAY key by default (two per registration, the Live one
  // inactive). A default that only works on a paid key breaks the first person
  // to try it, so the safe values must be the DEFAULTS and not something a
  // developer typed into their .env.
  const out = boots(BASE, LOAD);
  const proj = field(out, 'PROJ').split(',');
  assert.ok(!proj.includes('VENUE'), 'VENUE is Live-key-only and fails a DELAY key with DSC-0018');
  assert.ok(!proj.includes('EVENT_RUNNER_DESCRIPTION'), 'EVENT_RUNNER_DESCRIPTION is Live-key-only');
  assert.ok(proj.includes('MARKET_DESCRIPTION'), 'MARKET_DESCRIPTION carries market_type and is delay-safe');
  assert.ok(Number(field(out, 'MAXRES')) <= 200, `max_results ${field(out, 'MAXRES')} > 200 is TOO_MUCH_DATA`);
  assert.ok(Number(field(out, 'BOOKCHUNK')) <= 40, `book_chunk ${field(out, 'BOOKCHUNK')} > 40 is TOO_MUCH_DATA`);
});

check('C3 an explicit environment value still overrides the default', () => {
  const out = boots({ ...BASE, EVENT_TYPE_IDS: '1,7' }, LOAD);
  assert.strictEqual(field(out, 'SPORTS'), '1,7', `override ignored: ${out}`);
});

check('C4 `validate` exits non-zero when the configuration is unusable', () => {
  // A green check that cannot go red is worthless, and a host application or CI
  // step needs the exit code to gate on.
  try {
    execFileSync(PY, ['-m', 'betfeed.cli', 'validate'], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp',
        DATABASE_URL: 'postgresql://n:n@127.0.0.1:59999/none',
        BETFAIR_APP_KEY: 'k',
        BETFAIR_USERNAME: 'u',
        BETFAIR_PASSWORD: 'p',
        CATALOGUE_MAX_RESULTS: '1000',
      },
      encoding: 'utf8',
      cwd: FEED,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.fail('validate should have exited non-zero');
  } catch (e) {
    assert.strictEqual(e.status, 1, `expected exit 1, got ${e.status}`);
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    assert.match(out, /TOO_MUCH_DATA/, 'names the delay-key limit');
    assert.match(out, /not ready/, 'and says so');
  }
});

console.log(`\ntest_config_is_embeddable: ${passed} checks passed`);
if (passed < 4) {
  console.error('expected 4 checks');
  process.exit(1);
}