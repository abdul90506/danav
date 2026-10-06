/** Line-number edits and file outlines (pure functions). */
import assert from 'node:assert/strict';
import { applyAnyEdits, applyLineEdits, stripLineNumberPrefix } from '../../server/agent/textops.js';
import { formatOutline, languageOf, outline } from '../../server/agent/outline.js';

const { test } = globalThis.__agentTest;

console.log('\n[line edits + outline]');

test('applyLineEdits: replace, delete, insert — all numbers refer to the ORIGINAL file, applied bottom-up', () => {
  const src = 'a\nb\nc\nd\ne\n';
  const r = applyLineEdits(src, [
    { start_line: 2, new_string: 'B1\nB2' },
    { start_line: 4, end_line: 5, new_string: '' },
    { insert_after_line: 0, new_string: 'TOP' },
  ]);
  assert.ok(r.ok, r.error);
  assert.equal(r.content, 'TOP\na\nB1\nB2\nc\n');
  // two inserts at the same spot keep the order they were given in
  const two = applyLineEdits('x\ny\n', [{ insert_after_line: 1, new_string: 'first' }, { insert_after_line: 1, new_string: 'second' }]);
  assert.equal(two.content, 'x\nfirst\nsecond\ny\n');
  assert.equal(applyLineEdits('x\n', [{ insert_after_line: 1, new_string: 'end' }]).content, 'x\nend\n');
});

test('applyLineEdits keeps CRLF, a missing final newline, and handles the empty file', () => {
  assert.equal(applyLineEdits('a\r\nb\r\n', [{ start_line: 1, new_string: 'A' }]).content, 'A\r\nb\r\n');
  assert.equal(applyLineEdits('a\nb', [{ start_line: 2, new_string: 'B' }]).content, 'a\nB');
  assert.equal(applyLineEdits('', [{ insert_after_line: 0, new_string: 'hello' }]).content, 'hello\n');
});

test('applyLineEdits explains every mistake and never half-applies', () => {
  const src = 'a\nb\nc\n';
  assert.equal(applyLineEdits(src, [{ start_line: 4, new_string: 'x' }]).code, 'out_of_range');
  assert.equal(applyLineEdits(src, [{ start_line: 0, new_string: 'x' }]).code, 'out_of_range');
  assert.equal(applyLineEdits(src, [{ start_line: 3, end_line: 2, new_string: 'x' }]).code, 'out_of_range');
  assert.equal(applyLineEdits(src, [{ insert_after_line: 9, new_string: 'x' }]).code, 'out_of_range');
  assert.equal(applyLineEdits(src, [{ start_line: 1, end_line: 2, new_string: 'x' }, { start_line: 2, new_string: 'y' }]).code, 'overlap');
  assert.equal(applyLineEdits(src, [{ start_line: 1 }]).code, 'invalid');
  assert.equal(applyLineEdits(src, [{ insert_after_line: 1, new_string: '' }]).code, 'invalid');
  assert.equal(applyLineEdits(src, []).code, 'invalid');
});

test('stripLineNumberPrefix only fires when EVERY line has the read_file prefix', () => {
  assert.deepEqual(stripLineNumberPrefix('   5\tfoo\n   6\tbar'), { text: 'foo\nbar', stripped: true });
  assert.deepEqual(stripLineNumberPrefix('  5\tfoo\n\n  7\tbar').text, 'foo\n\nbar');
  assert.equal(stripLineNumberPrefix('   5\tfoo\nplain').stripped, false);
  assert.equal(stripLineNumberPrefix('no tabs here').stripped, false);
  assert.equal(stripLineNumberPrefix('1\t2\t3').stripped, true, 'a tab-separated row that starts with a number: stripped once, never twice');
  assert.equal(stripLineNumberPrefix('1\t2\t3').text, '2\t3');
});

test('applyAnyEdits: text edits run in order, line edits are relative to the file as read, mixing is refused', () => {
  assert.equal(applyAnyEdits('a\nb\n', [{ old_string: 'a', new_string: 'A' }, { old_string: 'A\nb', new_string: 'A\nB' }]).content, 'A\nB\n');
  assert.equal(applyAnyEdits('a\nb\n', [{ start_line: 1, new_string: 'x' }, { start_line: 2, new_string: 'y' }]).content, 'x\ny\n');
  assert.equal(applyAnyEdits('a\nb\n', [{ start_line: 1, new_string: 'x' }, { old_string: 'b', new_string: 'y' }]).code, 'mixed');
  // line-number prefixes pasted into text edits are removed first
  assert.equal(applyAnyEdits('one\ntwo\n', [{ old_string: '  2\ttwo', new_string: '  2\tTWO' }]).content, 'one\nTWO\n');
});

const kinds = (o) => o.symbols.map((s) => `${s.line}:${s.kind}`);

test('outline: JavaScript / TypeScript — functions, arrows, classes and their methods, routes, tests, types', () => {
  const js = `import a from 'a';
export default function App() {
  return 1;
}
const handler = async (req, res) => {
  res.end();
};
class Cart {
  constructor() {}
  async add(item) {
    if (item) {
      return 1;
    }
  }
  static make() {
    return new Cart();
  }
}
app.get('/api/items', handler);
describe('cart', () => {});
`;
  const o = outline(js, 'src/cart.js');
  assert.equal(o.language, 'js');
  assert.deepEqual(kinds(o), ['2:function', '5:function', '8:class', '9:method', '10:method', '15:method', '19:route', '20:test']);
  assert.ok(!kinds(o).includes('11:method'), 'an if-statement is not a method');
  assert.match(o.symbols.find((s) => s.kind === 'route').text, /app\.get\('\/api\/items'/);
  const ts = outline("export interface User { id: string }\nexport type Id = string;\nenum Role { A }\nexport const Button = React.memo(() => null);\nexport abstract class Base {}\n", 'x.ts');
  assert.deepEqual(kinds(ts), ['1:type', '2:type', '3:type', '4:component', '5:class']);
});

test('outline: Python, Markdown (ignoring code fences), Go, Rust, Java-like, shell, SQL, YAML', () => {
  assert.deepEqual(kinds(outline('import os\n\nclass A:\n    def f(self):\n        pass\n\nasync def g():\n    pass\n', 'a.py')), ['3:class', '4:def', '7:def']);
  const md = outline('# Title\n\n```bash\n# not a heading\n```\n\n## Usage\ntext\n### Deep\n', 'README.md');
  assert.deepEqual(md.symbols.map((s) => [s.line, s.kind]), [[1, 'h1'], [7, 'h2'], [9, 'h3']]);
  assert.deepEqual(kinds(outline('package main\n\nfunc main() {}\nfunc (s *S) Run() {}\ntype S struct {\n}\n', 'm.go')), ['3:func', '4:func', '5:type']);
  assert.deepEqual(kinds(outline('pub struct A;\nimpl A {\n    pub fn new() -> Self { A }\n}\nfn main() {}\n', 'm.rs')), ['1:type', '2:type', '3:fn', '5:fn']);
  assert.deepEqual(kinds(outline('public class Foo {\n  private static void bar() {}\n}\ninterface Baz {}\n', 'Foo.java')), ['1:class', '4:interface']);
  assert.deepEqual(kinds(outline('#!/bin/bash\nbuild() {\n  echo\n}\nfunction deploy {\n}\n', 'run.sh')), ['2:function', '5:function']);
  assert.deepEqual(kinds(outline('CREATE TABLE users (id int);\nselect 1;\ncreate view v as select 1;\n', 'a.sql')), ['1:create', '3:create']);
  assert.deepEqual(kinds(outline('name: ci\non:\n  push:\njobs:\n  build:\n', 'ci.yml')), ['1:key', '2:key', '4:key']);
});

test('outline: HTML, CSS (skipping comments) and JSON top-level keys', () => {
  const html = outline('<!DOCTYPE html>\n<html>\n<body>\n  <header class="top">\n    <h1>My <b>Site</b></h1>\n  </header>\n  <div id="app"></div>\n  <script src="app.js"></script>\n  <style>\n  </style>\n</body>\n', 'index.html');
  assert.deepEqual(html.symbols.map((s) => [s.line, s.kind, s.text]), [
    [4, 'header', '<header .top>'], [5, 'h1', '<h1> My Site'], [7, 'id', '<div #app>'], [8, 'script', '<script src="app.js">'], [9, 'style', '<style>'],
  ]);
  const css = outline('/* header { not: real } */\nbody {\n  margin: 0;\n}\n.card:hover {\n  color: red;\n}\n@media (max-width: 600px) {\n  .card { color: blue; }\n}\n@keyframes spin {\n}\n', 'a.css');
  assert.deepEqual(css.symbols.map((s) => [s.line, s.kind]), [[2, 'rule'], [5, 'rule'], [8, 'at-rule'], [11, 'at-rule']]);
  const json = outline('{\n  "name": "x",\n  "scripts": {\n    "dev": "vite"\n  },\n  "deps": {}\n}\n', 'package.json');
  assert.deepEqual(json.symbols.map((s) => s.line), [2, 3, 6]);
  assert.equal(outline('[1,2]', 'a.json').symbols.length, 0);
});

test('outline: vue files run both the HTML and the JS scanners; unknown types give nothing; the cap holds; formatting is readable', () => {
  const vue = outline('<template>\n  <section id="x"></section>\n</template>\n<script>\nexport default {}\nfunction helper() {}\n</script>\n', 'A.vue');
  assert.deepEqual(vue.symbols.map((s) => [s.line, s.kind]), [[1, 'template'], [2, 'section'], [4, 'script'], [6, 'function']]);
  assert.equal(languageOf('x.unknownext'), 'unknown');
  assert.equal(outline('whatever', 'file.unknownext').symbols.length, 0);
  const many = outline(Array.from({ length: 500 }, (_, i) => `function f${i}() {}`).join('\n'), 'big.js', { max: 50 });
  assert.equal(many.symbols.length, 50);
  assert.equal(many.truncated, true);
  const text = formatOutline('src/cart.js', outline('class A {\n  m() {\n  }\n}\n', 'cart.js'));
  // Each symbol carries the span it occupies, so a read can ask for exactly it.
  assert.match(text, /^src\/cart\.js — 4 lines, js, 2 symbols\nL1-4 +class A\nL2-4 +  m\(\)/);
  assert.match(formatOutline('x.txt', outline('x', 'x.txt')), /No structure could be detected/);
});
