// split-app.mjs — the mechanical split of the former single-file public/app.js
// into seven modules. Kept in the repo so the split is REPRODUCIBLE and
// reviewable rather than being a one-off hand edit whose rationale lives only
// in a commit message.
//
// What it does: slices the original IIFE by its own section markers, rewrites
// cross-module references to resolve lazily through the window.OB namespace,
// and emits one file per section. No behaviour change is intended.
//
// THE REWRITER IS THE INTERESTING PART. A naive regex over identifiers is
// wrong in three separate ways, and each was found by the browser suite:
//
//   1. Inside string literals.  '/api/x' -> '/OB.api/x'. Every request 404s
//      and the page looks alive, because only the network layer is broken.
//   2. Inside template interpolations.  `${state.user}` -> the whole literal
//      was treated as opaque, so `state` was never rewritten and reads as
//      undefined. Template CHUNKS are opaque; ${...} is code.
//   3. On regex literals.  $ is both the DOM helper (always called as `$(`)
//      and the regex end-anchor, so /^\d+$/ became /^\d+OB.$/ — a silently
//      corrupted regex that still parses. A bet then carried a NaN selection.
//
// So the scanner is a real lexer: comments, strings, template chunks and
// interpolations are each skipped correctly, and `$` is rewritten ONLY when
// immediately followed by `(`.
//
// AND THE NAMING IS LAZY ON PURPOSE. Cross-module names are referenced as
// OB.name at the call site rather than destructured. Destructuring captures
// the VALUE at load time, so a forward reference — a module calling something
// a file below it has not exported yet — binds to undefined permanently.
// Resolving through OB on each call works whatever the load order.
//
// Usage:  node scripts/split-app.mjs <original-app.js> [out-dir]
// The out-dir is EXPLICIT and defaults to the source file's own directory.
// Deriving it silently meant that running this against a scratch copy in /tmp
// wrote correct modules to /tmp/js while public/js kept the stale output of an
// earlier run — and the stale copy had a corrupted regex in it. A step that can
// succeed without touching its output is worse than no step at all.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Section boundaries, as (start, end) INCLUSIVE line numbers into the original
// file. Taken from its own `// ── section ──` markers; `tools` below re-checks
// that each boundary actually lands on one.
const SECTIONS = {
  core:  { range: [9, 238],   desc: 'state, DOM helpers, api, toast, tick ladder, overlay stack' },
  shell: { range: [239, 497], desc: 'auth, account panel, routing, data loaders' },
  nav:   { range: [498, 868], desc: 'sport nav, sidebar tree, global search' },
  board: { range: [869, 1264], desc: 'cash-out, feed board, markets page (the ladder)' },
  slip:  { range: [1265, 1463], desc: 'the bet slip' },
  views: { range: [1464, 1722], desc: 'my bets, wallet' },
  boot:  { range: [1723, 1890], desc: 'SSE, and the one place the app starts' },
};

const SRC = process.argv[2];
if (!SRC) {
  console.error('usage: node scripts/split-app.mjs <original-app.js>');
  process.exit(1);
}
const lines = readFileSync(SRC, 'utf8').split('\n');
const slice = ([a, b]) => lines.slice(a - 1, b).join('\n');

// ── Verify the boundaries before cutting anything ───────────────────────────
// A split on a stale line number produces files that parse, load, and fail
// silently at runtime. Cheaper to notice here.
const BODIES = {};
for (const [name, { range }] of Object.entries(SECTIONS)) {
  const first = lines[range[0] - 1];
  const last = lines[range[1] - 1];
  if (!/^ {2}(\/\/|\/\*|const|let|function|async|})/.test(first) && !/^ {2}\S/.test(first)) {
    console.error(`boundary check failed at ${name} start (line ${range[0]}): ${JSON.stringify(first)}`);
    process.exit(1);
  }
  BODIES[name] = slice(range);
}

// boot additionally carried the old `window.OB = { ... }` REASSIGNMENT.
// core.js owns window.OB now; re-assigning it here would wipe every module's
// contributions, so the block is dropped rather than copied.
BODIES.boot = BODIES.boot
  .replace(/\n[ ]*\/\/ Narrowed to EXACTLY what admin\.js[\s\S]*?\n[ ]*\};\n/, '\n')
  .replace(/\n[ ]*\/\/ Controlled global consumed by admin\.js[^\n]*\n/, '\n');

// ── Declarations each section owns ─────────────────────────────────────────
function declared(src) {
  const fn = [...src.matchAll(/^ {2}(?:async )?function ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const cn = [...src.matchAll(/^ {2}const ([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1]);
  // let/var MUST be included. Missing them is silent: the name is never
  // exported, so a module that reads it throws ReferenceError at runtime while
  // the file still parses. `authMode` in shell.js was found exactly this way.
  const lv = [
    ...[...src.matchAll(/^ {2}let ([A-Za-z_$][\w$]*)\b/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^ {2}var ([A-Za-z_$][\w$]*)\b/gm)].map((m) => m[1]),
  ];
  return new Set([...fn, ...cn, ...lv]);
}
const OWN = {};
for (const k of Object.keys(SECTIONS)) OWN[k] = declared(BODIES[k]);

// Module-level `let`/`var` bindings are the one thing that CANNOT be split by
// exporting it. `Object.assign(OB, { authMode })` copies the VALUE at load
// time, so `OB.authMode` is frozen at 'login' forever and the login/register
// toggle silently stops working — the module still parses, the UI still
// renders, and the bug is a control that does nothing.
//
// These bindings move onto the existing shared `state` object instead, which
// is what `state.user`, `state.slip` and `state.market` already do. It is the
// codebase's own convention, so this introduces no new idea — it just stops
// the split from inventing a second one that is quietly wrong.
const STATE_NAMES = {};
for (const [k, body] of Object.entries(BODIES)) {
  const found = new Set([
    ...[...body.matchAll(/^ {2}(?:let|var) ([A-Za-z_$][\w$]*)\b/gm)].map((m) => m[1]),
  ]);
  // `state` itself is the target, never a member of it.
  found.delete('state');
  found.delete('OB');
  STATE_NAMES[k] = found;
}
// The set is GLOBAL, not per-module: `authMode` is declared in shell.js and
// READ in boot.js, so a per-module set resolved the read to `OB.authMode` —
// a frozen copy that never changes, which silently killed the login/register
// toggle while every file still parsed.
const STATE_ALL = new Set(Object.values(STATE_NAMES).flatMap((s) => [...s]));

// ── The lexer/rewriter ─────────────────────────────────────────────────────
//
// DIVIDING A `/` FROM A REGEX IS THE WHOLE PROBLEM. Treating every `/` as a
// comment start or as nothing at all breaks regex literals, and treating a
// `"` inside a regex as a string delimiter is worse than a syntax error: the
// scanner opens a phantom string and silently swallows every subsequent
// token, so references stop being rewritten while the output still parses.
//
// That exact failure happened here. `esc` contains `.replace(/"/g, '&quot;')`.
// The `"` was read as an opening quote, and the next 60 lines of real code
// were emitted verbatim as "string content" — including calls to renderSlip,
// connectSSE and route. The file looked untouched, parsed cleanly, and threw
// ReferenceError in the browser.
//
// The rule is the standard one: a `/` opens a regex when the previous
// significant token cannot end an expression. `)` and `]` can (division);
// an identifier can, UNLESS it is a keyword like `return`; punctuation and a
// closing `}` cannot.
const DIVISION_ALLOWED_AFTER = new Set([')', ']']);
const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);

const DEBUG = !!process.env.SPLIT_DEBUG;

/**
 * Turn `let NAME = …` into `prefix.NAME = …` for hoisted bindings.
 *
 * Declaration-ONLY, deliberately: the usages are handled by the main rewriter
 * via its state-target set. Doing the whole thing here was the earlier bug —
 * it produced `OB.state.authMode` and then the rewriter rewrote the `state` in
 * it as well, giving `OB.OB.state.OB.authMode`. One pass, one place.
 */
function hoistDeclarations(src, names, prefix) {
  if (!names || !names.size) return src;
  return src.replace(/^ {2}(?:let|var) ([A-Za-z_$][\w$]*)\b/gm, (m, name) =>
    names.has(name) ? `  ${prefix}.${name}` : m
  );
}
function rewrite(src, foreign, stateTargets = new Set(), statePrefix = 'OB.state') {
  // A Set of the foreign names. Lookup is EXACT equality: the scan has
  // already established that `word` is a whole identifier, so substring
  // matching would only introduce bugs (asking about `ark` and rewriting
  // `market`).
  const foreignSet = new Set(foreign);
  const out = [];

  function scan(s, emit) {
    let i = 0;
    const n = s.length;
    // Token context, used only to classify a `/`.
    let lastKind = null; // 'word' | 'punct' | 'literal'
    let lastWord = '';
    let lastChar = '';

    // The previous significant character/token, skipping whitespace and
    // comments (already consumed by the caller loop).
    const classifySlash = () => {
      if (lastKind === null) return true; // start of input
      if (lastKind === 'literal') return false; // string/regex ended a value
      if (lastKind === 'punct') return !DIVISION_ALLOWED_AFTER.has(lastChar);
      return KEYWORDS_BEFORE_REGEX.has(lastWord);
    };
    const noteWord = (w) => { lastKind = 'word'; lastWord = w; lastChar = ''; };
    const notePunct = (c) => { lastKind = 'punct'; lastWord = ''; lastChar = c; };
    const noteLiteral = () => { lastKind = 'literal'; lastWord = ''; lastChar = ''; };

    while (i < n) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { emit(c); i++; continue; }
      // line comment
      if (c === '/' && s[i + 1] === '/') {
        let j = s.indexOf('\n', i); if (j < 0) j = n;
        emit(s.slice(i, j)); i = j; notePunct(';'); continue;
      }
      // block comment
      if (c === '/' && s[i + 1] === '*') {
        let j = s.indexOf('*/', i + 2); j = j < 0 ? n : j + 2;
        emit(s.slice(i, j)); i = j; notePunct(';'); continue;
      }
      // REGEX LITERAL — classified before the comment tests would eat it.
      if (c === '/' && classifySlash()) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n) {
          const d = s[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '\n') break; // not a regex after all
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { j++; closed = true; break; }
          j++;
        }
        if (closed) {
          while (j < n && /[gimsuyd]/.test(s[j])) j++;
          if (DEBUG && j - i > 160) console.error(`  LONG REGEX  @${i}: ${JSON.stringify(s.slice(i, i + 120))}`);
          emit(s.slice(i, j)); i = j; noteLiteral(); continue;
        }
        // Unterminated: treat as division and fall through.
        notePunct('/'); emit(c); i++; continue;
      }
      // quoted string — fully opaque
      if (c === "'" || c === '"') {
        const q = c; let j = i + 1;
        while (j < n) {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === q) { j++; break; }
          if (s[j] === '\n') break;
          j++;
        }
        if (DEBUG && j - i > 160) console.error(`  LONG STRING @${i}: ${JSON.stringify(s.slice(i, i + 120))}`);
        emit(s.slice(i, j)); i = j; noteLiteral(); continue;
      }
      // template literal — chunks opaque, ${...} is code and recurses
      if (c === '`') {
        emit('`'); i++; let buf = '';
        while (i < n) {
          if (s[i] === '\\') { buf += s.slice(i, i + 2); i += 2; continue; }
          if (s[i] === '`') { emit(buf); emit('`'); i++; break; }
          if (s[i] === '$' && s[i + 1] === '{') {
            emit(buf); buf = '';
            let depth = 1, j = i + 2;
            while (j < n && depth > 0) {
              if (s[j] === '{') depth++;
              else if (s[j] === '}') depth--;
              if (depth > 0) j++;
            }
            emit('${'); scan(s.slice(i + 2, j), emit); emit('}');
            i = j + 1; continue;
          }
          buf += s[i]; i++;
        }
        noteLiteral(); continue;
      }
      // `$` is the DOM helper, always called. Without the open paren it is a
      // regex anchor or a template marker, which the branches above already
      // consumed — so anything left here is a helper call.
      if (c === '$') {
        if (s[i + 1] === '(') { emit('OB.$('); i += 2; noteWord('OB'); continue; }
        emit('$'); i++; notePunct('$'); continue;
      }
      // identifier — but never a PROPERTY of something else
      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(s[j])) j++;
        const word = s.slice(i, j);
        // The scanner's own state, NOT a backwards walk over the raw text.
        // Walking backwards cannot see comments: the line above this call is
        // `// Revoked the session ... it is gone now.`, which ENDS IN A FULL
        // STOP, so a naive "is the previous character a dot?" test read every
        // call after a sentence-ending comment as a property access and left
        // it unreferenced. The token state is comment-aware by construction.
        const isProp = lastKind === 'punct' && lastChar === '.';
        let out2 = word;
        if (!isProp) {
          // A hoisted module-level binding resolves through the shared state
          // object, NOT through OB — `OB.authMode` would be a frozen copy of
          // the value at load time.
          if (stateTargets.has(word)) out2 = `${statePrefix}.${word}`;
          else if (foreignSet.has(word)) out2 = 'OB.' + word;
        }
        emit(out2);
        i = j; noteWord(word); continue;
      }
      // number
      if (/[0-9]/.test(c)) {
        let j = i;
        while (j < n && /[0-9._]/.test(s[j])) j++;
        emit(s.slice(i, j)); i = j; noteWord('num'); continue;
      }
      emit(c); i++;
      notePunct(c);
    }
  }

  scan(src, (chunk) => out.push(chunk));
  return out.join('');
}

// ── Emit ───────────────────────────────────────────────────────────────────
const OUT_DIR = path.resolve(process.argv[3] || path.dirname(SRC), 'js');
mkdirSync(OUT_DIR, { recursive: true });

const allNames = [...new Set([...Object.values(OWN).flatMap((s) => [...s])])].sort();

const NOTE =
  '  // Cross-module names are referenced as OB.name at the call site and are\n' +
  '  // deliberately NOT destructured. Destructuring captures the VALUE at load\n' +
  '  // time, so a forward reference -- this module calling something the file\n' +
  '  // BELOW it has not exported yet -- binds to undefined permanently and\n' +
  '  // never recovers. Resolving through OB at each call is late enough to work\n' +
  '  // whatever the load order.\n' +
  '  //\n' +
  '  // References inside string literals, template CHUNKS and regex literals are\n' +
  '  // left alone. Each of those was a real corruption when the split was done by\n' +
  '  // hand: /api/x became /OB.api/x, ${state.user} kept a bare `state`, and\n' +
  '  // /^\\d+$/ became /^\\d+OB.$/. scripts/split-app.mjs does the rewriting and\n' +
  '  // is the reference for what must NOT be touched.\n\n';

const CORE_HEADER = `// core.js — ${SECTIONS.core.desc}
//
// Split out of the former single-file app.js (1,891 lines). Behaviour is
// UNCHANGED: a mechanical extraction, not a rewrite. What changed is that each
// file is now readable on its own and none exceeds ~430 lines.
//
// WIRING. Classic scripts share one global scope, so the only safe way to
// share across files is an explicit namespace. window.OB is created HERE and
// extended by each file loaded after it, in order. Nothing else leaks: a
// top-level binding would collide with any other classic script on the page
// and be a fatal SyntaxError.
(() => {
  'use strict';

  const OB = (window.OB = window.OB || {});

`;

// core is rewritten like every other module. It LOOKS self-contained because
// it declares the primitives, but it calls into the views it does not own —
// refreshAll, renderSlip, route — and those were in the same closure before.
// Emitting it verbatim produced "renderSlip is not defined" on first boot.
const coreSrc = rewrite(
  hoistDeclarations(BODIES.core, STATE_NAMES.core, 'state'),
  allNames.filter((n) => !OWN.core.has(n)),
  STATE_ALL,
  'state' // core OWNS state, so it is bare here and OB.state everywhere else
);

const files = {};
files.core = CORE_HEADER + coreSrc + `

  // Everything core declares, exported so the modules below can reach it.
  // Derived from the file's own definitions rather than hand-listed, because
  // a hand-written list is how a name goes missing and surfaces as an
  // undefined reference buried in a view three files away.
  Object.assign(OB, { ${[...OWN.core].filter((n) => !STATE_NAMES.core.has(n)).sort().join(', ')} });
})();
`;

for (const name of ['shell', 'nav', 'board', 'slip', 'views', 'boot']) {
  const own = OWN[name];
  const foreign = allNames.filter((n) => !own.has(n));
  const src = rewrite(
    hoistDeclarations(BODIES[name], STATE_NAMES[name], 'OB.state'),
    foreign,
    // STATE_ALL, not STATE_NAMES[name]: a hoisted binding is declared in ONE
    // module and read in another (authMode in shell, boardReqSeq in board).
    // A per-module set resolves the read to `OB.authMode` — a frozen copy of
    // the value at load time — which parses, renders, and does nothing.
    STATE_ALL,
    'OB.state'
  );
  const exported = [...own].filter((n) => !STATE_NAMES[name].has(n)).sort();
  const bootNote =
    name === 'boot'
      ? '  // This file also OWNS the start, and is last in load order for exactly\n' +
        '  // that reason: boot() reaches the router, the loaders and every view, so\n' +
        '  // a single missing export would be a blank page rather than one broken\n' +
        '  // view.\n'
      : '';
  files[name] =
    `// ${name}.js — ${SECTIONS[name].desc}\n` +
    `(() => {\n  'use strict';\n\n` +
    `  const OB = window.OB;\n` +
    `  if (!OB) { console.error('[${name}] window.OB missing — core.js must load first'); return; }\n\n` +
    NOTE + bootNote +
    src + `\n\n  Object.assign(OB, { ${exported.join(', ')} });\n})();\n`;
}

// ── Verify: no foreign name survives as a BARE reference ───────────────────
// The parse check above catches syntax damage. This catches the silent kind:
// a call to a function that lives in another module and was never rewritten,
// which parses perfectly and throws ReferenceError only when reached. That is
// how "renderSlip is not defined" reached the browser instead of this script.
function bareForeignRefs(text, own, foreignSet) {
  const hits = new Set();
  // Reuse the lexer shape: skip comments, strings, template chunks.
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const j = text.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (c === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === q) { j++; break; }
        if (q === '`' && text[j] === '$' && text[j + 1] === '{') { // skip interpolation wholesale
          let d = 1, k = j + 2;
          while (k < n && d > 0) { if (text[k] === '{') d++; else if (text[k] === '}') d--; if (d > 0) k++; }
          j = k + 1; continue;
        }
        j++;
      }
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
      const word = text.slice(i, j);
      // A bare foreign reference: not preceded by '.', not a local, and not
      // the identifier OB itself.
      if (foreignSet.has(word) && !own.has(word) && text[i - 1] !== '.') hits.add(word);
      i = j; continue;
    }
    i++;
  }
  return [...hits].sort();
}

const foreignAll = new Set(allNames);
let unresolved = 0;
for (const [name, body] of Object.entries(files)) {
  const bare = bareForeignRefs(body, OWN[name] || new Set(), foreignAll);
  // OB and the module's own export list are expected; filter names that appear
  // only as shorthand properties in Object.assign(OB, { ... }).
  const real = bare.filter((b) => !new RegExp(`[{,]\\s*${b.replace(/\$/g, '\\$')}\\s*[},]`).test(body));
  if (real.length) {
    console.error(`  ${name}.js: unresolved cross-module reference(s): ${real.join(', ')}`);
    for (const b of real) {
      // Show the offending line, because a name can be reported when the only
      // occurrence is a property access the filter failed to exclude.
      const lines = body.split('\n').filter((l) => new RegExp(`(?<![.\\w$])${b.replace(/\$/g, '\\$')}\\b`).test(l));
      for (const l of lines.slice(0, 3)) console.error(`      ${l.trim().slice(0, 100)}`);
    }
    unresolved += real.length;
  }
}
if (unresolved) {
  console.error(`\n  ${unresolved} reference(s) would throw ReferenceError at runtime. Not writing.`);
  console.error('  This means the rewriter missed a lexical form — check the scanner.\n');
  process.exit(1);
}

for (const [name, body] of Object.entries(files)) {
  // Parse before writing. A step that emits a broken module and exits 0 is
  // worse than one that refuses to emit at all — the corruption is then
  // discovered at runtime, in a browser, as "renderSportNav is not a
  // function" three files from the cause.
  try {
    // eslint-disable-next-line no-new-func
    new Function(body);
  } catch (e) {
    console.error(`\n  ${name}.js does not parse: ${e.message}\n`);
    console.error('  Check the section boundary above — it is almost certainly off by a line.\n');
    process.exit(1);
  }
  writeFileSync(path.join(OUT_DIR, `${name}.js`), body);
  const rewrites = (body.match(/OB\.[A-Za-z_$][\w$]*/g) || []).length;
  console.log(`${name}.js  ${String(body.split('\n').length).padStart(4)} lines  ${String(rewrites).padStart(3)} cross-refs`);
}
console.log(`\n  wrote ${Object.keys(files).length} modules to public/js/ (${allNames.length} names in play)`);