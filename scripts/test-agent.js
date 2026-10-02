/**
 * Agent test-suite (no network, no API keys needed).
 *
 *   node scripts/test-agent.js            # unit + local-workspace + loop tests
 *   NOVITA_API_KEY=sk_... node scripts/test-agent.js --sandbox   # also hit a real Novita sandbox
 *
 * Grows section by section; every section is independent.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Never let tests write their fake agent memories or workspaces into the real app data directory.
const previousDataDir = process.env.DANAV_DATA_DIR;
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-agent-suite-'));
process.env.DANAV_DATA_DIR = testDataDir;

const results = { passed: 0, failed: 0 };
const failures = [];
const pending = [];

export function test(name, fn) {
  pending.push({ name, fn });
}

async function runAll() {
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;
  for (const { name, fn } of pending) {
    if (only && !name.includes(only)) continue;
    const t0 = Date.now();
    try {
      await fn();
      results.passed++;
      const ms = Date.now() - t0;
      console.log(`  ✓ ${name}${ms >= 1500 ? `  (${(ms / 1000).toFixed(1)}s)` : ''}`);
    } catch (err) {
      results.failed++;
      failures.push({ name, err });
      console.log(`  ✗ ${name}\n      ${String(err?.stack || err).split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
}

// ===========================================================================
// 1. textops: lines, diff, edits
// ===========================================================================
import {
  splitLines, numberLines, myersOps, diffSummary, applyEdit, applyEdits, bestMatchHint,
} from '../server/agent/textops.js';

console.log('\n[textops]');

test('splitLines ignores the final newline and normalises CRLF', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a'), ['a']);
  assert.deepEqual(splitLines('a\n'), ['a']);
  assert.deepEqual(splitLines('a\n\n'), ['a', '']);
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
});

test('numberLines right-aligns numbers like cat -n', () => {
  assert.equal(numberLines(['x', 'y'], 9), '   9\tx\n  10\ty');
});

test('diffSummary: a new file is all additions', () => {
  const d = diffSummary('', 'a\nb\nc\n');
  assert.equal(d.added, 3);
  assert.equal(d.removed, 0);
  assert.deepEqual(d.ranges, [[1, 3]]);
});

test('diffSummary: identical text has no changes (even CRLF vs LF)', () => {
  const d = diffSummary('a\r\nb\r\n', 'a\nb\n');
  assert.equal(d.added + d.removed, 0);
  assert.deepEqual(d.ranges, []);
});

test('diffSummary: one replaced line is +1 -1 with the right range', () => {
  const d = diffSummary('a\nb\nc\nd\n', 'a\nB\nc\nd\n');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.deepEqual(d.ranges, [[2, 2]]);
  assert.equal(d.hunks.length, 1);
  assert.deepEqual(d.hunks[0].lines.filter((l) => l.t !== ' ').map((l) => `${l.t}${l.s}`), ['-b', '+B']);
});

test('diffSummary: pure deletion reports removed lines and a point range', () => {
  const d = diffSummary('a\nb\nc\n', 'a\nc\n');
  assert.equal(d.removed, 1);
  assert.equal(d.added, 0);
  assert.deepEqual(d.ranges, [[2, 2]]);
});

test('diffSummary: two distant edits give two ranges', () => {
  const old = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
  const next = [...old];
  next[2] = 'CHANGED3';
  next[30] = 'CHANGED31';
  const d = diffSummary(old.join('\n'), next.join('\n'));
  assert.deepEqual(d.ranges, [[3, 3], [31, 31]]);
  assert.equal(d.hunks.length, 2);
});

test('diffSummary: huge rewrites fall back to an approximation but stay sane', () => {
  const a = Array.from({ length: 4000 }, (_, i) => `old line ${i}`).join('\n');
  const b = Array.from({ length: 4200 }, (_, i) => `new line ${i}`).join('\n');
  const d = diffSummary(a, b);
  assert.equal(d.approximate, true);
  assert.equal(d.added, 4200);
  assert.equal(d.removed, 4000);
});

function bruteLcs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return dp[0][0];
}

test('myersOps: 400 random cases reproduce b from a and match the true LCS', () => {
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let c = 0; c < 400; c++) {
    const alphabet = 1 + rnd(5);
    const a = Array.from({ length: rnd(14) }, () => String(rnd(alphabet)));
    const b = Array.from({ length: rnd(14) }, () => String(rnd(alphabet)));
    const ops = myersOps(a, b);
    assert.ok(ops, 'ops should exist for tiny inputs');
    // replay
    let i = 0;
    let j = 0;
    const out = [];
    for (const op of ops) {
      if (op === '=') {
        assert.equal(a[i], b[j]);
        out.push(a[i]);
        i++;
        j++;
      } else if (op === '-') i++;
      else {
        out.push(b[j]);
        j++;
      }
    }
    assert.equal(i, a.length);
    assert.equal(j, b.length);
    assert.deepEqual(out, b);
    // optimal: number of '=' equals the LCS length
    assert.equal(ops.filter((o) => o === '=').length, bruteLcs(a, b), `a=${a} b=${b}`);
    // and the summary agrees
    const s = diffSummary(a.join('\n'), b.join('\n'));
    assert.equal(s.added, b.length - bruteLcs(a, b));
    assert.equal(s.removed, a.length - bruteLcs(a, b));
  }
});

test('applyEdit: exact unique replacement keeps the rest of the file', () => {
  const r = applyEdit('one\ntwo\nthree\n', { old_string: 'two', new_string: '2' });
  assert.ok(r.ok);
  assert.equal(r.content, 'one\n2\nthree\n');
  assert.deepEqual(r.startLines, [2]);
});

test('applyEdit: ambiguous matches are rejected unless replace_all', () => {
  const src = 'x = 1\ny = 1\nz = 1\n';
  const bad = applyEdit(src, { old_string: '= 1', new_string: '= 2' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'ambiguous');
  assert.match(bad.error, /3 places/);
  const good = applyEdit(src, { old_string: '= 1', new_string: '= 2', replace_all: true });
  assert.ok(good.ok);
  assert.equal(good.content, 'x = 2\ny = 2\nz = 2\n');
  assert.equal(good.replacements, 3);
});

test('applyEdit: CRLF files stay CRLF', () => {
  const r = applyEdit('a\r\nb\r\nc\r\n', { old_string: 'b\n', new_string: 'B1\nB2\n' });
  assert.ok(r.ok);
  assert.equal(r.content, 'a\r\nB1\r\nB2\r\nc\r\n');
});

test('applyEdit: indentation drift is tolerated and re-indented', () => {
  const src = 'function f() {\n    if (x) {\n        run();\n    }\n}\n';
  const r = applyEdit(src, { old_string: 'if (x) {\n    run();\n}', new_string: 'if (y) {\n    go();\n}' });
  assert.ok(r.ok, r.error);
  assert.equal(r.matchedBy, 'whitespace');
  assert.equal(r.content, 'function f() {\n    if (y) {\n        go();\n    }\n}\n');
});

test('applyEdit: not found returns a helpful closest-match hint', () => {
  const src = 'const total = items.reduce((a, b) => a + b, 0);\nconsole.log(total);\n';
  const r = applyEdit(src, { old_string: 'const total = items.map((a) => a)', new_string: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
  assert.match(r.error, /Closest match/);
  assert.match(r.error, /items\.reduce/);
});

test('applyEdit: guards against empty / identical / non-string input', () => {
  assert.equal(applyEdit('a', { old_string: '', new_string: 'b' }).code, 'invalid');
  assert.equal(applyEdit('a', { old_string: 'a', new_string: 'a' }).code, 'invalid');
  assert.equal(applyEdit('a', { old_string: 1, new_string: 'a' }).code, 'invalid');
});

test('applyEdits: sequential, and all-or-nothing on failure', () => {
  const src = 'a\nb\nc\n';
  const ok = applyEdits(src, [
    { old_string: 'a', new_string: 'A' },
    { old_string: 'A\nb', new_string: 'A\nB' }, // depends on the first edit
  ]);
  assert.ok(ok.ok);
  assert.equal(ok.content, 'A\nB\nc\n');
  const bad = applyEdits(src, [
    { old_string: 'a', new_string: 'A' },
    { old_string: 'zzz', new_string: 'Z' },
  ]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Edit 2 of 2 failed — nothing was written/);
});

test('bestMatchHint stays quiet when nothing resembles the needle', () => {
  assert.equal(bestMatchHint('alpha\nbeta\n', 'completely_unrelated_symbol()'), '');
});

// ===========================================================================
// run
// ===========================================================================
const args = process.argv.slice(2);
globalThis.__agentTest = { test, args };

// Later sections are registered by dynamic imports so one file stays readable.
for (const mod of ['./agent/test-partial.js', './agent/test-memory.js', './agent/test-journal.js', './agent/test-context.js', './agent/test-thinking.js', './agent/test-settings.js', './agent/test-edits.js', './agent/test-workspace.js', './agent/test-tools.js', './agent/test-loop.js', './agent/test-frontend.js', './agent/test-sandbox.js']) {
  try {
    await import(mod);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
}

await runAll();
console.log(`\n${results.passed} passed, ${results.failed} failed`);
if (previousDataDir === undefined) delete process.env.DANAV_DATA_DIR;
else process.env.DANAV_DATA_DIR = previousDataDir;
fs.rmSync(testDataDir, { recursive: true, force: true });
// Servers started by the tests (fake LLM, temp apps) would keep the process alive.
process.exit(results.failed ? 1 : 0);
