import assert from 'assert';
import { createStreamSplitter } from '../server/streamSplitter.js';

/**
 * Unit tests for the streaming thought/content splitter.
 *
 * These lock down the regression where reasoning leaked into the chat: the old
 * parser stopped recognising <thought> after the first tool tag, so every later
 * reasoning block rendered as visible prose (and a half-stripped tag showed up
 * as a stray "thought>" line).
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

/** Feed chunks through a fresh splitter and collect the two channels. */
function run(chunks) {
  const split = createStreamSplitter();
  let thinking = '';
  let content = '';
  for (const chunk of chunks) {
    for (const event of split(chunk)) {
      if (event.thinking) thinking += event.thinking;
      if (event.content) content += event.content;
    }
  }
  for (const event of split.flush()) {
    if (event.thinking) thinking += event.thinking;
    if (event.content) content += event.content;
  }
  return { thinking, content };
}

console.log('=== STREAM SPLITTER TESTS ===\n');

console.log('Reasoning routing');

test('a simple thought goes to thinking, not content', () => {
  const { thinking, content } = run(['<thought>Let me check the file.</thought>', '\nDone.']);
  assert.strictEqual(thinking, 'Let me check the file.');
  assert.strictEqual(content.trim(), 'Done.');
});

test('EVERY thought after a tool call is still captured', () => {
  // This is the regression: the old parser gave up after the first tool tag.
  const { thinking, content } = run([
    '<thought>Need news.</thought>',
    '\n<web_search query="headlines" />\n',
    '<thought>Now fetch the source.</thought>',
    '\n<fetch_url url="https://example.com" />\n',
    '<thought>That failed, search again.</thought>',
    '\n<web_search query="headlines reuters" />\n',
    'Here are the headlines:',
  ]);
  assert(thinking.includes('Need news.'), `first thought missing: ${thinking}`);
  assert(thinking.includes('Now fetch the source.'), `second thought missing: ${thinking}`);
  assert(thinking.includes('That failed, search again.'), `third thought missing: ${thinking}`);
  assert(!/Now fetch the source|That failed/.test(content), `reasoning leaked: ${content}`);
  assert(!/<thought|<think/.test(content), `raw tag leaked: ${content}`);
  assert(content.includes('Here are the headlines:'), 'final answer must survive');
  assert.strictEqual((content.match(/<web_search/g) || []).length, 2, 'both tool calls survive');
});

test('a tool tag closes an open thought', () => {
  const { thinking, content } = run(['<thought>about to search', '<web_search query="x" />', 'ok']);
  assert(thinking.includes('about to search'), `got: ${thinking}`);
  assert(content.includes('<web_search query="x" />'), 'tool tag must be in content');
  assert(content.includes('ok'), 'text after the tool tag is content');
});

test('an unclosed thought at end of stream is flushed to thinking', () => {
  const { thinking } = run(['<thought>still reasoning']);
  assert.strictEqual(thinking, 'still reasoning');
});

console.log('\nPartial tags split across deltas');

test('"<thought>" split mid-tag never leaves a broken tag', () => {
  const { thinking, content } = run(['<thou', 'ght>', 'Let me look.', '</thought>', '\nOK.']);
  assert.strictEqual(thinking, 'Let me look.');
  assert.strictEqual(content.trim(), 'OK.');
  assert(!/thought>/.test(content), `broken tag residue: ${content}`);
});

test('"</thought>" split mid-tag closes cleanly', () => {
  const { thinking, content } = run(['<thought>reasoning</thou', 'ght>', '\nAnswer.']);
  assert.strictEqual(thinking, 'reasoning');
  assert.strictEqual(content.trim(), 'Answer.');
});

test('a held-back partial is flushed at end of stream', () => {
  const { content } = run(['Done. <']);
  assert(content.includes('Done.'), 'earlier text must survive');
  assert(content.includes('<'), 'the trailing partial must be flushed, not dropped');
});

console.log('\nLiteral tags must survive as data');

test('a <thought> inside a written file stays verbatim in content', () => {
  const { thinking, content } = run([
    '<write_file path="notes.md">',
    'Use <thought> tags for reasoning.\n',
    '</write_file>',
    '\nWrote notes.md.',
  ]);
  assert.strictEqual(thinking, '', 'a file body must never become reasoning');
  assert(
    content.includes('Use <thought> tags for reasoning.'),
    `file body must be verbatim: ${content}`
  );
});

test('a <thought> inside a code fence stays in content', () => {
  const { thinking, content } = run([
    '<thought>Planning the sample.</thought>',
    'Here is an example:\n```html\n',
    '<thought>demo</thought>\n',
    '```\nAll set.',
  ]);
  assert.strictEqual(thinking, 'Planning the sample.');
  assert(content.includes('<thought>demo</thought>'), `fenced sample must be verbatim: ${content}`);
  assert(content.includes('All set.'), 'trailing prose survives');
});

test('a self-closing write_file does not swallow later thoughts', () => {
  const { thinking } = run(['<write_file path="a.txt" />', '<thought>back to thinking</thought>']);
  assert.strictEqual(thinking, 'back to thinking');
});

test('a stray closing tag outside a thought is preserved', () => {
  const { content } = run(['<web_search query="x" />', '\n</thought>\nDone.']);
  assert(content.includes('Done.'), 'prose must survive a stray closing tag');
});

console.log('\nFences and other tools');

test('fence counting is not confused by a thought inside the fence', () => {
  const { thinking, content } = run(['```\n<thought>code</thought>\n```\n', '<thought>real</thought>']);
  assert.strictEqual(thinking, 'real');
  assert(content.includes('<thought>code</thought>'), 'fenced tag stays in content');
});

test('think is accepted as an alias for thought', () => {
  const { thinking, content } = run(['<think>alias reasoning</think>', '\nVisible.']);
  assert.strictEqual(thinking, 'alias reasoning');
  assert.strictEqual(content.trim(), 'Visible.');
});

test('background and ask_user tags are recognised as control tags', () => {
  const { content } = run([
    '<run_background>npm install</run_background>',
    '\n<ask_user question="Which one?" />',
    '\nDone.',
  ]);
  assert(content.includes('<run_background>'), 'run_background must reach content');
  assert(content.includes('<ask_user question="Which one?" />'), 'ask_user must reach content');
  assert(content.includes('Done.'), 'trailing prose survives');
});

test('plain text passes through untouched', () => {
  const { thinking, content } = run(['Just a normal sentence, no tags at all.']);
  assert.strictEqual(thinking, '');
  assert.strictEqual(content, 'Just a normal sentence, no tags at all.');
});

console.log('\n====================================================');
if (failures.length === 0) {
  console.log(`\uD83C\uDF89 ALL ${passed} SPLITTER TESTS PASSED`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
}
console.log('====================================================\n');

if (failures.length > 0) process.exit(1);
