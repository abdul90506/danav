/** Reading tool calls while they are still being written: partial JSON, live "+N −M", salvage. */
import assert from 'node:assert/strict';
import {
  completeLines, decodeJsonStringPartial, extractStringFields, peekPartialArgs, salvageWrite, startedLines,
} from '../../server/agent/partial.js';
import { liveDiffStats, diffSummary } from '../../server/agent/textops.js';

const { test } = globalThis.__agentTest;

console.log('\n[partial tool calls]');

test('decodeJsonStringPartial: escapes, cut-off escapes, the closing quote', () => {
  assert.deepEqual(decodeJsonStringPartial('a\\nb\\t\\"q\\"\\\\z"rest'), { value: 'a\nb\t"q"\\z', complete: true, consumed: 14 });
  assert.equal(decodeJsonStringPartial('caf\\u00e9').value, 'café');
  assert.equal(decodeJsonStringPartial('x\\ud83d\\ude00y').value, 'x😀y');
  // cut anywhere: nothing half-decoded leaks out
  assert.deepEqual(decodeJsonStringPartial('abc\\'), { value: 'abc', complete: false, consumed: 3 });
  assert.deepEqual(decodeJsonStringPartial('abc\\u00'), { value: 'abc', complete: false, consumed: 3 });
  assert.equal(decodeJsonStringPartial('line1\\nli').value, 'line1\nli');
  assert.equal(decodeJsonStringPartial('').complete, false);
});

test('extractStringFields: in order, complete or not, and never fooled by key-like text inside a value', () => {
  const text = '{"path": "a.json", "content": "{\\"path\\": \\"fake\\", \\"content\\": \\"inner\\"}\\nmore", "extra": 1}';
  const f = extractStringFields(text, ['path', 'content']);
  assert.deepEqual(f.map((x) => [x.key, x.complete]), [['path', true], ['content', true]]);
  assert.equal(f[1].value, '{"path": "fake", "content": "inner"}\nmore');
  const cut = extractStringFields('{"path": "a.js", "content": "line1\\nline2\\nli', ['path', 'content']);
  assert.deepEqual(cut.map((x) => [x.key, x.complete, x.value]), [['path', true, 'a.js'], ['content', false, 'line1\nline2\nli']]);
  assert.deepEqual(extractStringFields('{"pa', ['path']), []);
});

test('startedLines / completeLines', () => {
  assert.equal(startedLines(''), 0);
  assert.equal(startedLines('a'), 1);
  assert.equal(startedLines('a\n'), 1);
  assert.equal(startedLines('a\nb'), 2);
  assert.deepEqual(completeLines('a\nb\nc'), ['a', 'b']);
  assert.deepEqual(completeLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(completeLines(''), []);
});

test('peekPartialArgs (write_file): the path arrives early; +N counts started lines; the tail is the last lines', () => {
  const p1 = '{"path": "src/index.html", "content": "<!DOCTYPE html>\\n<html>\\n<head>\\n';
  const a = peekPartialArgs('write_file', p1);
  assert.equal(a.args.path, 'src/index.html');
  assert.equal(a.progress.added, 3);
  assert.deepEqual(a.progress.tail, ['<!DOCTYPE html>', '<html>', '<head>']);
  const p2 = p1 + '<title>Hi</title>\\n</head>\\n<body>\\n<h1>Yo</h1>\\n<p>par';
  const b = peekPartialArgs('write_file', p2);
  assert.equal(b.progress.added, 8, 'the half-typed line counts as started');
  assert.equal(b.progress.tail.length, 6);
  assert.equal(b.progress.tail.at(-1), '<p>par');
  assert.equal(peekPartialArgs('write_file', '{"pa').progress.added, 0);
  assert.deepEqual(peekPartialArgs('write_file', '{"path": "a.js"').args, { path: 'a.js' });
});

test('peekPartialArgs: other tools keep the small display arguments, and unfinished strings are not shown', () => {
  assert.equal(peekPartialArgs('run_command', '{"command": "npm install && npm ru').args.command, undefined);
  assert.equal(peekPartialArgs('run_command', '{"command": "npm install", "background": true}').args.command, 'npm install');
  assert.equal(peekPartialArgs('read_file', '{"file_path": "x/y.js"').args.path, 'x/y.js');
  assert.equal(peekPartialArgs('move_file', '{"from": "a", "to": "b"}').args.to, 'b');
  assert.equal(peekPartialArgs('web_search', '{"query": "vite proxy"').args.query, 'vite proxy');
  assert.equal(peekPartialArgs('list_dir', '{}').progress, undefined);
});

test('peekPartialArgs (overwrite): "−" is what is really being replaced, and the not-yet-reached tail is not counted', () => {
  const old = Array.from({ length: 50 }, (_, i) => `old line ${i + 1}`);
  const body = (n) => Array.from({ length: n }, (_, i) => `new line ${i + 1}`).join('\\n') + '\\n';
  const at = (n) => peekPartialArgs('write_file', `{"path": "a.txt", "content": "${body(n)}`, { oldLines: old }).progress;
  const early = at(5);
  assert.deepEqual([early.added, early.removed], [5, 5], '5 lines written replace 5 old ones so far');
  const later = at(30);
  assert.deepEqual([later.added, later.removed], [30, 30]);
  const all = at(70);
  assert.deepEqual([all.added, all.removed], [70, 50], 'once the new text is longer, all 50 old lines are gone');
  // an overwrite that keeps most of the file only counts what differs
  const same = old.map((l, i) => (i === 10 ? 'CHANGED' : l)).join('\\n') + '\\n';
  const s = peekPartialArgs('write_file', `{"path": "a.txt", "content": "${same}`, { oldLines: old }).progress;
  assert.deepEqual([s.added, s.removed], [1, 1]);
  // a brand-new file removes nothing — and says so with a 0 rather than by
  // leaving the key off, which would put `removed: undefined` in every live
  // update the chat receives.
  const fresh = peekPartialArgs('write_file', '{"path": "n.txt", "content": "a\\nb\\n').progress;
  assert.deepEqual([fresh.added, fresh.removed], [2, 0]);
  assert.equal(typeof fresh.removed, 'number', 'both counters are always numbers');
});

test('peekPartialArgs (edits): "−" from the old text, "+" from the new text, as each arrives', () => {
  const e = peekPartialArgs('edit_file', '{"path": "a.js", "old_string": "x\\ny\\nz", "new_string": "X\\nY');
  assert.deepEqual([e.progress.added, e.progress.removed], [2, 3]);
  assert.deepEqual(e.progress.tail, ['X', 'Y']);
  const m = peekPartialArgs('multi_edit', '{"path": "a.js", "edits": [{"old_string": "a", "new_string": "A\\nA2"}, {"old_string": "b\\nb2", "new_string": "B"}, {"old_string": "c", "new_string": "C\\nC');
  assert.deepEqual([m.progress.added, m.progress.removed], [2 + 1 + 2, 1 + 2 + 1]);
  const lines = peekPartialArgs('multi_edit', '{"edits": [{"start_line": 10, "end_line": 14, "new_string": "x"}, {"start_line": 30, "end_line": 30, "new_string": "y"}]}');
  assert.equal(lines.progress.removed, 5 + 1);
});

test('salvageWrite: a call cut off by the length limit keeps every complete line', () => {
  const cutMidLine = '{"path": "big.js", "content": "line1\\nline2\\nline3\\nline4 half-wri';
  const r = salvageWrite('write_file', cutMidLine);
  assert.deepEqual([r.path, r.content, r.lines, r.truncated], ['big.js', 'line1\nline2\nline3\n', 3, true]);
  const whole = salvageWrite('write_file', '{"path": "x.txt", "content": "a\\nb\\nc\\nd\\n"');
  assert.deepEqual([whole.lines, whole.truncated], [4, false]);
  assert.equal(salvageWrite('append_file', cutMidLine).path, 'big.js');
  assert.equal(salvageWrite('write_file', '{"path": "x.txt", "content": "a\\nb'), null, 'too little to be worth saving');
  assert.equal(salvageWrite('write_file', '{"content": "a\\nb\\nc\\nd\\ne'), null, 'no path, no file');
  assert.equal(salvageWrite('edit_file', cutMidLine), null);
});

test('liveDiffStats follows the final diff as the file grows, and never counts the unreached tail as removed', () => {
  const old = ['a', 'b', 'c', 'd'];
  assert.deepEqual(liveDiffStats(old, []), { added: 0, removed: 0 });
  assert.deepEqual(liveDiffStats(old, ['a', 'b']), { added: 0, removed: 0 }, 'a prefix of the old file: nothing changed yet');
  assert.deepEqual(liveDiffStats(old, ['a', 'X']), { added: 1, removed: 1 }, 'b replaced; c and d are still ahead');
  assert.deepEqual(liveDiffStats(old, ['a', 'b', 'c', 'd', 'e']), { added: 1, removed: 0 });
  assert.deepEqual(liveDiffStats(old, ['a', 'b', 'X', 'c', 'd']), { added: 1, removed: 0 });
  assert.deepEqual(liveDiffStats(old, ['x', 'y', 'z']), { added: 3, removed: 3 });
  // and when the writing is finished it agrees with the real diff
  const done = ['a', 'B', 'c', 'D', 'e'];
  const real = diffSummary(old.join('\n'), done.join('\n'));
  assert.deepEqual(liveDiffStats(old, done), { added: real.added, removed: real.removed });
  // enormous rewrites degrade to a cheap estimate instead of burning CPU
  const big = (p) => Array.from({ length: 3000 }, (_, i) => `${p} ${i}`);
  const t0 = Date.now();
  assert.deepEqual(liveDiffStats(big('old'), big('new')), { added: 3000, removed: 3000 });
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
});
