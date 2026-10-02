import assert from 'assert';
import { sanitizeConversations } from '../src/services/storage.ts';

/**
 * Regression tests for how a stored conversation is revived.
 *
 * The bug class: a turn saved mid-flight comes back looking live. A message
 * still flagged `isGenerating` spins the typing dot forever, and a web tool
 * still flagged `running` pulses "working…" forever — even though the run that
 * would have finished it is long gone.
 */

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

function conversationWith(messages) {
  return [
    {
      id: 'c1',
      title: 'T',
      messages,
      selectedProviderId: 'p',
      selectedModelId: 'm',
      thinkingLevel: 'Auto',
      createdAt: 1,
      updatedAt: 2,
    },
  ];
}

console.log('Conversation revival\n');

await test('a message saved mid-stream comes back not generating', () => {
  const out = sanitizeConversations(
    conversationWith([{ id: 'm1', role: 'assistant', content: 'half', createdAt: 1, isGenerating: true }])
  );
  assert.strictEqual(out[0].messages[0].isGenerating, false);
});

await test('a tool still marked running is settled as failed', () => {
  const out = sanitizeConversations(
    conversationWith([
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        createdAt: 1,
        toolExecutions: [
          { id: 't1', name: 'web_search', status: 'running', query: 'node lts' },
          { id: 't2', name: 'fetch_url', status: 'done', ok: true, summary: 'Page read' },
        ],
      },
    ])
  );

  const tools = out[0].messages[0].toolExecutions;
  assert.strictEqual(tools.length, 2, 'the trail must be preserved');
  assert.strictEqual(tools[0].status, 'done', 'a running tool must not come back pulsing');
  assert.strictEqual(tools[0].ok, false, 'it never finished, so it must not read as a success');
  assert.strictEqual(tools[0].query, 'node lts', 'what was searched is still worth showing');
  assert.strictEqual(tools[1].status, 'done', 'a finished tool is left alone');
  assert.strictEqual(tools[1].ok, true, 'a successful tool keeps its success');
});

await test('the tool trail survives a round trip', () => {
  const out = sanitizeConversations(
    conversationWith([
      {
        id: 'm1',
        role: 'assistant',
        content: 'answer',
        createdAt: 1,
        toolExecutions: [
          { id: 't1', name: 'image_search', status: 'done', ok: true, summary: '3 images', images: [{ url: 'u' }] },
        ],
      },
    ])
  );
  assert.strictEqual(out[0].messages[0].toolExecutions[0].images.length, 1);
});

await test('a message with no tools is untouched', () => {
  const out = sanitizeConversations(
    conversationWith([{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }])
  );
  assert.strictEqual(out[0].messages[0].toolExecutions, undefined);
});

await test('garbage input does not throw', () => {
  assert.deepStrictEqual(sanitizeConversations(null), []);
  assert.deepStrictEqual(sanitizeConversations(undefined), []);
  const out = sanitizeConversations([{ id: 'c', title: 't' }]);
  assert.deepStrictEqual(out[0].messages, []);
});

console.log('\n====================================================');
if (failures.length === 0) {
  console.log(`\uD83C\uDF89 ALL ${passed} STORAGE TESTS PASSED`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
}
console.log('====================================================\n');

if (failures.length > 0) process.exit(1);
