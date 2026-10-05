import assert from 'assert';
import { getStoredProviders, sanitizeConversations, sanitizeProvidersForClient, stripImagePayloads } from '../src/services/storage.ts';

/**
 * Regression tests for how a stored conversation is revived.
 *
 * The bug class: a turn saved mid-flight comes back looking live. A message
 * still flagged `isGenerating` spins the typing dot forever, and a web tool
 * still flagged `running` pulses "working…" forever — even though the run that
 * would have finished it is long gone.
 */

let passed = 0;
let skipped = 0;
const failures = [];
const onlyArg = process.argv.indexOf('--only');
const onlyTest = onlyArg >= 0 ? String(process.argv[onlyArg + 1] || '').toLowerCase() : '';

async function test(name, fn) {
  if (onlyTest && !name.toLowerCase().includes(onlyTest)) {
    skipped++;
    return;
  }
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

await test('legacy provider keys are removed from localStorage but available for one-time backend migration', () => {
  const key = 'danav_chat_providers_v2';
  const secret = 'storage-legacy-provider-secret';
  const values = new Map([[key, JSON.stringify([{
    id: 'legacy', name: 'Legacy', baseUrl: 'https://example.test/v1', apiType: 'openai', apiKey: secret,
    apiKeyConfigured: false, apiKeyCount: 0, models: [],
  }])]]);
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k) => values.get(k) ?? null, setItem: (k, value) => values.set(k, value) },
  });
  try {
    const loaded = getStoredProviders();
    assert.equal(loaded[0].apiKey, secret, 'the current app boot can migrate a legacy key');
    assert.equal(loaded[0].apiKeyConfigured, true);
    assert.equal(loaded[0].apiKeyCount, 1, 'a stale zero count cannot hide a legacy key being migrated');
    assert.doesNotMatch(values.get(key), /storage-legacy-provider-secret/, 'the saved browser copy has no key');
    const safe = sanitizeProvidersForClient(loaded);
    assert.equal(safe[0].apiKey, undefined);
    assert.equal(safe[0].apiKeyConfigured, true);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous });
  }
});

await test('multi-key values and one-shot key intents are removed from browser state', () => {
  const secrets = ['browser-key-one-secret', 'browser-key-two-secret', 'browser-key-three-secret'];
  const safe = sanitizeProvidersForClient([{
    id: 'multi', name: 'Multi', baseUrl: 'https://example.test/v1', apiType: 'openai', models: [],
    apiKeys: secrets.slice(0, 2), apiKeyAdditions: [secrets[2]], clearApiKeys: false,
  }])[0];
  assert.equal(safe.apiKey, undefined);
  assert.equal(safe.apiKeys, undefined);
  assert.equal(safe.apiKeyAdditions, undefined);
  assert.equal(safe.clearApiKeys, undefined);
  assert.equal(safe.apiKeyCount, 3);
  assert.equal(safe.apiKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(safe), /browser-key-(?:one|two|three)-secret/);

  const storageKey = 'danav_chat_providers_v2';
  const values = new Map([[storageKey, JSON.stringify([{
    id: 'multi', name: 'Multi', baseUrl: 'https://example.test/v1', apiType: 'openai', models: [],
    apiKeys: secrets.slice(0, 2), apiKeyAdditions: [secrets[2]], clearApiKeys: false,
  }])]]);
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
  });
  try {
    const loaded = getStoredProviders()[0];
    assert.equal(loaded.apiKeys, undefined);
    assert.equal(loaded.apiKeyAdditions, undefined);
    assert.equal(loaded.clearApiKeys, undefined);
    assert.doesNotMatch(JSON.stringify(loaded), /browser-key-(?:one|two|three)-secret/);
    assert.doesNotMatch(values.get(storageKey), /browser-key-(?:one|two|three)-secret/);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous });
  }
});

await test("a store too large to post keeps the open chat's images and sheds the older ones", () => {
  const img = (name) => ({ id: `a-${name}`, name, type: 'image', size: 10, content: 'data:image/png;base64,AAAA', previewUrl: 'data:image/png;base64,AAAA' });
  const chatWith = (id) => ({
    id,
    title: id,
    messages: [{ id: `${id}-m`, role: 'user', content: 'look', attachments: [img(`${id}.png`)] }],
    selectedProviderId: 'p',
    selectedModelId: 'm',
    thinkingLevel: 'Auto',
    createdAt: 1,
    updatedAt: 2,
  });

  const full = [chatWith('active'), chatWith('old-1'), chatWith('old-2')];
  const lighter = stripImagePayloads(full, new Set(['active']));

  assert.strictEqual(lighter[0].messages[0].attachments[0].content, 'data:image/png;base64,AAAA', 'the open chat keeps its picture');
  for (const conv of lighter.slice(1)) {
    assert.strictEqual(conv.messages[0].attachments[0].content, undefined);
    assert.strictEqual(conv.messages[0].attachments[0].previewUrl, undefined);
    assert.strictEqual(conv.messages[0].attachments[0].name, `${conv.id}.png`, 'the attachment is still listed');
  }
  assert.strictEqual(stripImagePayloads(full, new Set()).length, full.length);
  assert.ok(stripImagePayloads(full).every((c) => c.messages[0].attachments[0].content === undefined));
});

console.log('\n====================================================');
if (failures.length === 0) {
  console.log(`\uD83C\uDF89 ${passed} STORAGE TEST${passed === 1 ? '' : 'S'} PASSED${skipped ? ` (${skipped} unrelated checks skipped)` : ''}`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
}
console.log('====================================================\n');

if (failures.length > 0) process.exit(1);
