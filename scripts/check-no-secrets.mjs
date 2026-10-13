#!/usr/bin/env node
// scripts/check-no-secrets.mjs — refuse to commit a value that is in .env.
//
// Added after the real Betfair app key and username were committed to a PUBLIC
// repository by me, using the operator's own `.env` values as "obviously fake"
// sample data in a test fixture. They were not fake.
//
// The existing CI guards checked for key FILES (.env, certs/, *.pem, *.key) and
// for private-key markers. Neither fired, because the leak was a credential
// VALUE in an ordinary tracked .js file. File-name hygiene cannot catch that.
//
// WHAT THIS DOES. If a .env exists, every value in it is hashed, and every
// TRACKED file is scanned for those values. A hit fails the run.
//
// WHAT THIS CANNOT DO, stated plainly:
//   - On CI there is no .env, so it finds nothing. The check only has teeth on
//     the operator's machine, in `npm run check:secrets` and as a pre-commit
//     hook. That is a real limitation, not a caveat.
//   - It cannot see a value that was committed once and then removed from the
//     working tree, and it cannot see git history at all. For history you want
//     `git log -p | ` piped through a real scanner.
//
// For those gaps the honest answer is a proper scanner (gitleaks / trufflehog)
// over the full history, run in CI. This is the cheap, dependency-free check
// that stops the common case — "I copied a value out of .env to use as test
// data" — at the moment it happens.
//
// Exit 0 when clean or when there is no .env. Exit 1 on a hit.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Which .env files count as the credential source. The exchange's own .env holds
// ports, rates and booleans and contains NO secret — the Betfair credentials live
// in the COLLECTOR's .env. Checking only the local one would have found nothing
// and passed, which is exactly the false all-clear that let the incident through.
// So: this repo's .env, an explicit DATAFEED_ENV, and the conventional sibling
// checkout, deduplicated, existing ones only.
const ENV_PATHS = [
  join(ROOT, '.env'),
  process.env.DATAFEED_ENV,
  join(ROOT, '..', 'OpenBettingExchangeDataFeed', '.env'),
].filter(Boolean);

// Values short enough to match by accident in ordinary prose or code. A 6-char
// "secret" is not a secret, and matching on it would make this check useless.
const MIN_LEN = 8;

// Only keys whose NAME implies a credential are treated as secrets. Enumerating
// the non-secrets instead was the wrong way round and produced 68 false
// positives on the first run — BETFAIR_LOGIN_MODE has the value "password",
// which of course appears in prose and code everywhere. A value that is a word
// is not a secret, and an allowlist of key names cannot be complete.
const SECRET_KEY = /(KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL|PRIVATE|DSN)/i;
// …except these, whose names match but whose values are configuration: a login
// MODE is an enum ('password' | 'certs'), and a path or a schema is not a secret.
const NOT_SECRET = /(_MODE|_PATH|_DIR|_SCHEMA|_FILE|_TEMPLATE|_URL_TEMPLATE)/i;

function parseEnv(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!value || value.length < MIN_LEN) continue;
    if (!SECRET_KEY.test(key) || NOT_SECRET.test(key)) continue;
    // A few known ENUM values whose keys happen to match the credential pattern.
    // An explicit list, not a shape heuristic: a generic "looks like a word"
    // filter silently excluded the real 16-character app key, because a random
    // alnum string passes /^[a-z][a-z0-9_-]*$/. A shape heuristic that rejects
    // the exact thing you are hunting for is worse than no filter at all.
    if (['password', 'certs', 'session_token'].includes(value.toLowerCase())) continue;
    out.push({ key, value, hash: createHash('sha256').update(value).digest('hex').slice(0, 12) });
  }
  return out;
}

const present = [...new Set(ENV_PATHS)].filter((p) => existsSync(p));
if (!present.length) {
  console.log('check-no-secrets: no .env found here, nothing to compare against (this is the CI case).');
  process.exit(0);
}

const secrets = [];
const sources = [];
for (const path of present) {
  let parsed;
  try {
    parsed = parseEnv(readFileSync(path, 'utf8'));
  } catch (e) {
    // An unreadable .env must not fail the run; CI has the same case, and a
    // permission error here is not evidence of anything.
    console.log(`check-no-secrets: skipped ${path} (${e.code || e.message})`);
    continue;
  }
  if (parsed.length) sources.push(`${path} (${parsed.length})`);
  secrets.push(...parsed.map((s) => ({ ...s, from: path })));
}

if (!secrets.length) {
  console.log('check-no-secrets: .env has no value long enough to be a credential.');
  process.exit(0);
}

const tracked = execSync('git ls-files -z', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  .toString()
  .split('\0')
  .filter(Boolean)
  // Skip binary-ish files and the lockfile, which are legitimately dense.
  .filter((f) => !/\.(png|jpe?g|gif|webp|ico|woff2?|db|sqlite3?|lock|sum)$/i.test(f));

const hits = [];
for (const file of tracked) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    continue;
  }
  for (const s of secrets) {
    if (text.includes(s.value)) {
      const line = text.slice(0, text.indexOf(s.value)).split('\n').length;
      hits.push({ file, line, key: s.key, hash: s.hash, from: s.from });
    }
  }
}

if (hits.length) {
  console.error('\ncheck-no-secrets: FAILED — a credential from .env is committed.\n');
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  contains ${h.key} from ${h.from} (sha256:${h.hash})`);
  }
  console.error('\n  Do NOT paste that value anywhere, including this message.');
  console.error('  Replace it with an obviously synthetic value, and rotate the');
  console.error('  credential if it has already been pushed.\n');
  process.exit(1);
}

console.log(
  `check-no-secrets: clean — ${secrets.length} value(s) from [${sources.join(', ')}] ` +
    `checked against ${tracked.length} tracked files.`
);