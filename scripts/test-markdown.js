import assert from 'assert';
import { hasHtmlTags, normalizeMessageContent } from '../src/utils/markdownNormalize.ts';

/**
 * Regression tests for raw HTML showing up as literal text in the chat.
 *
 * From a screenshot: the agent finished building a portfolio site and its final
 * message contained `<strong>✅ Project Complete!</strong>`. react-markdown
 * escapes raw HTML, so the user saw the tag itself instead of bold text.
 */

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

console.log('=== MARKDOWN NORMALISER TESTS ===\n');

console.log('The reported bug');

test('the exact <strong> tag from the screenshot becomes bold', () => {
  const out = normalizeMessageContent('<strong>\u2705 Project Complete!</strong>');
  assert.strictEqual(out, '**\u2705 Project Complete!**');
  assert.ok(!out.includes('<strong>'), 'no literal tag may survive');
});

test('it survives inside a longer message', () => {
  const input =
    'Maine aapke liye website banai hai.\n\n<strong>\u2705 Project Complete!</strong>\n\nAur kuch chahiye?';
  const out = normalizeMessageContent(input);
  assert.ok(out.includes('**\u2705 Project Complete!**'), out);
  assert.ok(!/<strong>/.test(out), out);
});

console.log('\nInline tags');

test('<b> and <strong> both become bold', () => {
  assert.strictEqual(normalizeMessageContent('<b>x</b>'), '**x**');
  assert.strictEqual(normalizeMessageContent('<strong>x</strong>'), '**x**');
});

test('<i> and <em> become italics', () => {
  assert.strictEqual(normalizeMessageContent('<em>x</em>'), '*x*');
  assert.strictEqual(normalizeMessageContent('<i>x</i>'), '*x*');
});

test('<code> becomes a backtick span', () => {
  assert.strictEqual(normalizeMessageContent('use <code>npm run dev</code>'), 'use `npm run dev`');
});

test('<br> becomes a newline', () => {
  assert.strictEqual(normalizeMessageContent('one<br>two'), 'one\ntwo');
  assert.strictEqual(normalizeMessageContent('one<br/>two'), 'one\ntwo');
});

test('<del> becomes strikethrough', () => {
  assert.strictEqual(normalizeMessageContent('<del>old</del>'), '~~old~~');
});

test('an anchor becomes a markdown link', () => {
  assert.strictEqual(
    normalizeMessageContent('see <a href="https://x.dev">the docs</a>'),
    'see [the docs](https://x.dev)'
  );
});

test('nested formatting still works', () => {
  const out = normalizeMessageContent('<strong>done <em>now</em></strong>');
  assert.strictEqual(out, '**done *now***');
});

console.log('\nBlock tags');

test('headings become markdown headings', () => {
  assert.strictEqual(normalizeMessageContent('<h2>Steps</h2>').trim(), '## Steps');
});

test('list items become markdown bullets', () => {
  const out = normalizeMessageContent('<ul><li>one</li><li>two</li></ul>');
  assert.ok(/- one/.test(out), out);
  assert.ok(/- two/.test(out), out);
});

test('paragraph tags become blank-line breaks', () => {
  const out = normalizeMessageContent('<p>first</p><p>second</p>');
  assert.ok(/first\n\nsecond/.test(out), JSON.stringify(out));
});

console.log('\nSafety');

test('code fences are never touched', () => {
  const input = '```html\n<strong>keep me</strong>\n<div class="x">y</div>\n```';
  assert.strictEqual(normalizeMessageContent(input), input);
});

test('inline code is never touched', () => {
  const input = 'use `<strong>` for bold in HTML';
  assert.strictEqual(normalizeMessageContent(input), input);
});

test('a code sample inside prose survives', () => {
  const input = 'Wrap it in <code><div class="box"></div></code> to see.';
  const out = normalizeMessageContent(input);
  assert.ok(out.includes('`<div class="box"></div>`'), out);
});

test('an inline tag INSIDE <code> is left as the tag, not converted to markdown', () => {
  // The inline pass used to run first, so <strong> inside <code> became **
  // before the span existed — the code sample then showed the wrong text.
  const out = normalizeMessageContent('use <code><strong>x</strong></code> for bold');
  assert.strictEqual(out, 'use `<strong>x</strong>` for bold', out);
});

test('an inline tag around a code span still converts', () => {
  const out = normalizeMessageContent('<strong>bold <code>x</code> too</strong>');
  assert.strictEqual(out, '**bold `x` too**', out);
});

test('custom elements and generics are left alone', () => {
  assert.strictEqual(normalizeMessageContent('use <MyWidget /> here'), 'use <MyWidget /> here');
  assert.strictEqual(normalizeMessageContent('Array<T> is generic'), 'Array<T> is generic');
});

test('plain markdown is returned byte-for-byte', () => {
  const md = '# Title\n\nSome **bold** and `code`.\n\n- a\n- b\n';
  assert.strictEqual(normalizeMessageContent(md), md);
});

test('an empty string is safe', () => {
  assert.strictEqual(normalizeMessageContent(''), '');
});

test('entities outside code are decoded', () => {
  assert.strictEqual(normalizeMessageContent('a &amp; b'), 'a & b');
  assert.strictEqual(normalizeMessageContent('x&nbsp;y'), 'x y');
});

test('entities inside code are NOT decoded', () => {
  const input = '`a &amp; b`';
  assert.strictEqual(normalizeMessageContent(input), input);
});

test('hasHtmlTags is a cheap pre-check', () => {
  assert.ok(hasHtmlTags('<strong>x</strong>'));
  assert.ok(!hasHtmlTags('just **markdown**'));
  assert.ok(!hasHtmlTags('a < b and c > d'));
});

console.log('\n====================================================');
if (failures.length === 0) {
  console.log(`\uD83C\uDF89 ALL ${passed} MARKDOWN NORMALISER TESTS PASSED`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
}
console.log('====================================================\n');

if (failures.length > 0) process.exit(1);
