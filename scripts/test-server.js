/**
 * Integration tests against a REAL server process, on an isolated data dir.
 *
 * `npm test` (scripts/test-all.js) drives the instance you are using, with your
 * own providers and chats — so it cannot test the destructive paths (saving,
 * shrinking, restoring) without risking real history. This suite starts its own
 * `server/index.js` on a spare port with `DANAV_DATA_DIR` pointing at a temp
 * folder, drives it over HTTP, and throws the folder away afterwards.
 *
 * What it protects:
 *   - provider API keys never leave the server (the browser must only ever see
 *     `apiKeyConfigured`),
 *   - the chat store records who wrote it and what it held, so the safety copy
 *     is taken before a shrink and NOT destroyed when it is used,
 *   - a stale tab that saves the same number of chats but fewer messages is
 *     still recognised as a shrink,
 *   - bad input is answered with a clear 4xx instead of a hang or a 500.
 */
import assert from 'assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-test-'));
const PORT = 3400 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

function startServer({ port, extraEnv = {} } = {}) {
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port || PORT),
      DANAV_HOST: '127.0.0.1',
      DANAV_DATA_DIR: dataDir,
      // An empty value is still "set": dotenv will not overwrite it from .env,
      // so the suite is never affected by a real .env that serves publicly.
      DANAV_ALLOWED_HOSTS: '',
      DANAV_PREVIEW_TOKEN: '',
      DANAV_DISABLE_PREVIEW_AUTH: '',
      // Never let a test touch the developer's real keys.
      NOVITA_API_KEY: '',
      GEMINI_API_KEY: '',
      VYCE_API_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { proc, log: '' };
  proc.stdout.on('data', (d) => {
    state.log += d.toString();
  });
  proc.stderr.on('data', (d) => {
    state.log += d.toString();
  });
  return state;
}

async function waitForServer(instance, base, deadlineMs = 20000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      // Any HTTP answer means the socket is up; /api/settings may legitimately
      // answer 401 when the preview access code is required.
      await fetch(`${base}/api/preview-auth/check`);
      return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not start on ${base}\n--- server output ---\n${instance.log}`);
}

const server = startServer({});
const serverLog = server.log;

const api = async (method, route, body, extraHeaders) => {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(extraHeaders || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
};

const chat = (id, messageCount, title = id) => ({
  id,
  title,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  selectedProviderId: 'provider-test',
  selectedModelId: 'test-model',
  thinkingLevel: 'Auto',
  messages: Array.from({ length: messageCount }, (_, i) => ({
    id: `${id}-m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
    timestamp: Date.now(),
  })),
});

const readStore = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'conversations.json'), 'utf-8'));
const readBackupFile = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'conversations.backup.json'), 'utf-8'));

console.log('\nServer integration (isolated data dir)\n');

await waitForServer(server, BASE);
console.log(`  (server on ${BASE}, data dir ${path.basename(dataDir)})\n`);

await test('GET /api/settings answers and never includes an API key', async () => {
  const { status, json } = await api('GET', '/api/settings');
  assert.strictEqual(status, 200);
  assert.strictEqual(json.success, true);
  assert(Array.isArray(json.settings.providers));
  assert(!JSON.stringify(json).includes('apiKey"'), 'the public payload must not carry apiKey fields');
});

await test('POST /api/settings stores a key server-side and reports only that it is configured', async () => {
  const { status, json } = await api('POST', '/api/settings', {
    providers: [
      {
        id: 'provider-test',
        name: 'Test Provider',
        baseUrl: 'https://example.invalid/v1',
        apiType: 'openai',
        enabled: true,
        apiKey: 'sk-secret-value-123',
        models: [{ id: 'test-model', name: 'test-model', providerId: 'provider-test' }],
      },
    ],
  });
  assert.strictEqual(status, 200);
  const provider = json.settings.providers.find((p) => p.id === 'provider-test');
  assert.strictEqual(provider.apiKeyConfigured, true);
  assert.strictEqual(provider.apiKey, undefined);

  // It IS on disk — the server needs it to call the provider.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf-8'));
  assert.strictEqual(onDisk.providers.find((p) => p.id === 'provider-test').apiKey, 'sk-secret-value-123');
});

await test('a provider update without a key keeps the stored key (no accidental wipe)', async () => {
  await api('POST', '/api/settings', {
    providers: [
      {
        id: 'provider-test',
        name: 'Renamed',
        baseUrl: 'https://example.invalid/v1',
        apiType: 'openai',
        enabled: true,
        models: [{ id: 'test-model', name: 'test-model', providerId: 'provider-test' }],
      },
    ],
  });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf-8'));
  assert.strictEqual(onDisk.providers.find((p) => p.id === 'provider-test').apiKey, 'sk-secret-value-123');
});

await test('POST /api/settings rejects a malformed body with 400, not a crash', async () => {
  const { status, json } = await api('POST', '/api/settings', { providers: 'not-an-array' });
  assert.strictEqual(status, 400);
  assert.match(json.error, /providers/i);
});

await test('a provider list of junk is refused instead of wiping the stored providers', async () => {
  // This one used to answer 200 and write `[{ id: 5 }]` over a real provider —
  // silently destroying the configuration (and the stored key) behind it.
  for (const providers of [[null, { id: 5 }], [{}], ['x'], [null]]) {
    const { status, json } = await api('POST', '/api/settings', { providers });
    assert.strictEqual(status, 400, `expected 400 for ${JSON.stringify(providers)}`);
    assert.match(json.error, /not valid|id/i);
  }

  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf-8'));
  assert.ok(
    onDisk.providers.some((p) => p.id === 'provider-test'),
    'the previously stored provider must still be there'
  );
});

await test('a provider with a junk Base URL is coerced on save, not stored as a number', async () => {
  const { status } = await api('POST', '/api/settings', {
    providers: [
      {
        id: 'provider-coerce',
        name: 'Coerced',
        baseUrl: 123,
        models: [null, 'nope', { id: 42, name: 42 }],
      },
    ],
  });
  assert.strictEqual(status, 200);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf-8'))
    .providers.find((p) => p.id === 'provider-coerce');
  assert.strictEqual(stored.baseUrl, '123', 'a scalar base URL becomes a string');
  assert.strictEqual(stored.models.length, 1, 'only the usable model survives');
  assert.strictEqual(stored.models[0].id, '42');
});

await test('malformed chat requests are answered 400, never 500', async () => {
  const base = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] };

  const numberUrl = await api('POST', '/api/chat', { ...base, provider: { baseUrl: 123 } });
  assert.strictEqual(numberUrl.status, 400);
  assert.match(numberUrl.json.error, /Base URL/i);

  const notAUrl = await api('POST', '/api/chat', { ...base, provider: { baseUrl: 'not a url' } });
  assert.strictEqual(notAUrl.status, 400);
  assert.match(notAUrl.json.error, /not a valid provider Base URL/i);

  const junkMessages = await api('POST', '/api/chat', {
    ...base,
    provider: { baseUrl: 'https://example.invalid/v1' },
    messages: [null, 5, { role: 'user' }],
  });
  assert.strictEqual(junkMessages.status, 400);
  assert.match(junkMessages.json.error, /Message 1 of 3/);

  const badScheme = await api('POST', '/api/chat', { ...base, provider: { baseUrl: 'file:///etc/passwd' } });
  assert.strictEqual(badScheme.status, 400);
  assert.match(badScheme.json.error, /http/i);
});

await test('provider test/models routes answer cleanly for a bad or unreachable Base URL', async () => {
  const badTest = await api('POST', '/api/providers/test', { baseUrl: 123, apiType: 'openai' });
  assert.strictEqual(badTest.status, 400);
  assert.match(badTest.json.error, /Base URL/i);

  const badModels = await api('POST', '/api/providers/models', { baseUrl: 'nonsense' });
  assert.strictEqual(badModels.status, 400);

  // Loopback is allowed by design (local providers), so this reaches a real
  // connection attempt — it must fail as a gateway error with the address in it.
  const unreachable = await api('POST', '/api/providers/models', { baseUrl: 'http://127.0.0.1:9/v1' });
  assert.strictEqual(unreachable.status, 502);
  assert.match(unreachable.json.error, /127\.0\.0\.1:9/);
});

await test('search args of the wrong type are treated as empty, not destructured', async () => {
  const nullArgs = await api('POST', '/api/search', { tool: 'web_search', args: null });
  assert.strictEqual(nullArgs.status, 400);
  assert.match(nullArgs.json.error, /query/i);

  const arrayArgs = await api('POST', '/api/search', { tool: 'web_search', args: ['q'] });
  assert.strictEqual(arrayArgs.status, 400);
});

await test('junk entries in a conversations save are dropped, not fatal', async () => {
  const { status, json } = await api('POST', '/api/conversations', {
    conversations: [null, 1, 'x', chat('keep', 3), { id: 'no-messages' }],
    activeChatId: 'keep',
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.success, true);
  const stored = readStore();
  assert.deepStrictEqual(stored.conversations.map((c) => c.id), ['keep', 'no-messages']);
});

await test('a body over the server limit is a clean 413, not a hang', async () => {
  // The composer keeps one message under 12 MB, so this is the backstop for a
  // caller that ignores it: an answer the UI can show, never a dropped socket.
  const huge = 'x'.repeat(26 * 1024 * 1024);
  const { status, json } = await api('POST', '/api/chat', {
    provider: { baseUrl: 'https://example.invalid/v1' },
    model: 'm',
    messages: [{ role: 'user', content: huge }],
  });
  assert.strictEqual(status, 413);
  assert.ok(json && json.error, 'the refusal must be JSON the client can read');
});

await test('the chat store route accepts a store too big for a chat message', async () => {
  // The store carries every conversation's image attachments, so it has its own
  // (larger) ceiling — a 413 here would silently stop the server's copy of the
  // chat from tracking the browser's.
  const heavy = {
    conversations: [
      {
        ...chat('heavy', 1),
        messages: [{ id: 'h1', role: 'user', content: 'look', attachments: [{ id: 'a1', name: 'x.png', type: 'image', size: 30_000_000, content: 'A'.repeat(30_000_000) }] }],
      },
    ],
    activeChatId: 'heavy',
  };
  const { status, json } = await api('POST', '/api/conversations', heavy);
  assert.strictEqual(status, 200, `a 30 MB store must be accepted, got ${status} ${JSON.stringify(json)}`);
  const stored = readStore();
  assert.strictEqual(stored.conversations[0].id, 'heavy');
});

await test('conversations round-trip through the server store', async () => {
  const save = await api('POST', '/api/conversations', {
    conversations: [chat('a', 4), chat('b', 2)],
    activeChatId: 'a',
  });
  assert.strictEqual(save.status, 200);
  const loaded = await api('GET', '/api/conversations');
  assert.strictEqual(loaded.status, 200);
  assert.strictEqual(loaded.json.conversations.length, 2);
  assert.strictEqual(loaded.json.activeChatId, 'a');
  assert.strictEqual(readStore().conversations.length, 2);
});

await test('a shrink (fewer chats) is backed up before it is written', async () => {
  const save = await api('POST', '/api/conversations', { conversations: [chat('a', 4)], activeChatId: 'a' });
  assert.strictEqual(save.status, 200);
  assert.strictEqual(readStore().conversations.length, 1, 'the new state is what the store holds');
  assert.strictEqual(readBackupFile().conversations.length, 2, 'the previous state is the safety copy');
});

await test('a stale tab saving the same number of chats with fewer messages is still a shrink', async () => {
  // The dangerous case: same five chats, but older/shorter histories.
  await api('POST', '/api/conversations', { conversations: [chat('a', 10), chat('b', 10)], activeChatId: 'a' });
  const before = readStore().conversations.reduce((n, c) => n + c.messages.length, 0);
  assert.strictEqual(before, 20);

  await api('POST', '/api/conversations', { conversations: [chat('a', 1), chat('b', 1)], activeChatId: 'a' });
  const backup = readBackupFile();
  assert.strictEqual(
    backup.conversations.reduce((n, c) => n + c.messages.length, 0),
    20,
    'the 20-message version must be kept as the backup'
  );
});

await test('GET /api/conversations/backup returns the safety copy', async () => {
  const { status, json } = await api('GET', '/api/conversations/backup');
  assert.strictEqual(status, 200);
  assert.strictEqual(json.success, true);
  assert.strictEqual(json.conversations.reduce((n, c) => n + c.messages.length, 0), 20);
});

await test('restore brings the backup back AND keeps it, so it can be repeated', async () => {
  const restored = await api('POST', '/api/conversations/restore');
  assert.strictEqual(restored.status, 200);
  assert.strictEqual(restored.json.success, true);
  assert.strictEqual(restored.json.restored, 2);

  assert.strictEqual(readStore().conversations.reduce((n, c) => n + c.messages.length, 0), 20, 'the live store shows the restored copy');
  assert.strictEqual(
    readBackupFile().conversations.reduce((n, c) => n + c.messages.length, 0),
    20,
    'the backup survives its own restore — a second restore must still work'
  );

  const again = await api('POST', '/api/conversations/restore');
  assert.strictEqual(again.json.restored, 2);
});

await test('the store never rehydrates a conversation as still generating', async () => {
  await api('POST', '/api/conversations', {
    conversations: [
      {
        ...chat('c', 1),
        messages: [{ ...chat('c', 1).messages[0], isGenerating: true, blocks: [{ id: 'b1', type: 'thinking', content: 'x', isStillThinking: true }] }],
      },
    ],
    activeChatId: 'c',
  });
  const { json } = await api('GET', '/api/conversations');
  const message = json.conversations[0].messages[0];
  assert.strictEqual(message.isGenerating, false);
  assert.strictEqual(message.blocks[0].isStillThinking, false);
});

await test('a conversation that outgrew the context window is trimmed and retried, not failed', async () => {
  // A provider that refuses anything longer than 4 messages with the error a real
  // one sends, and answers the retry. Before this, the turn simply died with
  // "Provider error (HTTP 400)" and the user had no way forward.
  const asked = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      asked.push(payload.messages || []);
      if ((payload.messages || []).length > 4) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message:
                "This model's maximum context length is 8192 tokens. However, your messages resulted in 20000 tokens. Please reduce the length of the messages.",
              type: 'invalid_request_error',
            },
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Recovered.' } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const fakePort = fake.address().port;

  try {
    const longHistory = [];
    for (let i = 0; i < 10; i++) {
      longHistory.push({ role: 'user', content: `question ${i}` });
      longHistory.push({ role: 'assistant', content: `answer ${i}` });
    }

    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: { id: 'provider-fake', baseUrl: `http://127.0.0.1:${fakePort}`, apiType: 'openai' },
        model: 'fake-model',
        thinkingLevel: 'Auto',
        messages: longHistory,
      }),
    });

    assert.strictEqual(res.status, 200, 'the retry must reach the stream, not a 400');
    const stream = await res.text();
    assert.match(stream, /Recovered\./, 'the retried request must produce the answer');
    assert.match(stream, /longer than the model's context window/, 'and say what was left out');

    assert(asked.length >= 2, 'the request must be retried, not failed');
    assert(asked[0].length > 4, 'the first attempt carried the whole history');
    const last = asked[asked.length - 1];
    assert(last.length <= 4, `every retry must be trimmed (last sent ${last.length} messages)`);
    assert.strictEqual(last[0].role, 'user', 'the trim must land on a user turn');
    for (const attempt of asked) {
      for (const message of attempt) {
        assert(message.role === 'user' || message.role === 'assistant', 'no orphaned tool message may survive');
      }
    }
  } finally {
    fake.close();
  }
});

await test('a rate-limited provider is retried instead of failing the turn', async () => {
  // The first 429 of the minute used to end a chat with "Rate limit reached".
  // Nothing had been streamed yet, so the request is safe to repeat.
  let calls = 0;
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Second time lucky.' } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const fakePort = fake.address().port;

  try {
    const started = Date.now();
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: { id: 'provider-retry', baseUrl: `http://127.0.0.1:${fakePort}`, apiType: 'openai' },
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(res.status, 200, 'the retry must reach the stream');
    const stream = await res.text();
    assert.match(stream, /Second time lucky\./);
    assert.match(stream, /retried once/, 'the user should know the pause was a retry');
    assert.strictEqual(calls, 2);
    // Retry-After: 0 must be honoured — falling back to the 1s backoff would
    // make this turn take a second longer than the provider asked for.
    assert.ok(elapsed < 900, `expected the header to be honoured, took ${elapsed}ms`);
  } finally {
    fake.close();
  }
});

await test('a provider 5xx is retried, but a 401 fails immediately', async () => {
  let serverErrors = 0;
  const flaky = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      serverErrors += 1;
      if (serverErrors === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        res.end('{"error":{"message":"upstream unavailable"}}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Recovered from 503.' } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => flaky.listen(0, '127.0.0.1', resolve));

  let authCalls = 0;
  const strict = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      authCalls += 1;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"invalid api key"}}');
    });
  });
  await new Promise((resolve) => strict.listen(0, '127.0.0.1', resolve));

  const chatTo = (port) =>
    fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: { id: 'provider-flaky', baseUrl: `http://127.0.0.1:${port}`, apiType: 'openai' },
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

  try {
    const recovered = await chatTo(flaky.address().port);
    assert.strictEqual(recovered.status, 200);
    assert.match(await recovered.text(), /Recovered from 503\./);
    assert.strictEqual(serverErrors, 2, 'a 503 is worth one more try');

    const rejected = await chatTo(strict.address().port);
    assert.strictEqual(rejected.status, 401);
    assert.match(JSON.parse(await rejected.text()).error, /Invalid API Key/);
    assert.strictEqual(authCalls, 1, 'a bad key must not be retried');
  } finally {
    flaky.close();
    strict.close();
  }
});

await test('a fallback chat title stays sidebar-sized, whatever was pasted', async () => {
  // Unreachable provider -> the route answers with its local fallback title.
  const blob = 'x'.repeat(20000);
  const { status, json } = await api('POST', '/api/chat/title', {
    provider: { baseUrl: 'http://127.0.0.1:9/v1' },
    message: blob,
  });
  assert.strictEqual(status, 200);
  assert.ok(json.title.length <= 40, `title must be short, got ${json.title.length} chars`);

  const normal = await api('POST', '/api/chat/title', {
    provider: { baseUrl: 'http://127.0.0.1:9/v1' },
    message: '  "how do i deploy a vite app"  ',
  });
  assert.strictEqual(normal.status, 200);
  assert.match(normal.json.title, /^How Do I Deploy$/);
});

await test('unknown search tool and empty chat payloads get clear 4xx answers', async () => {
  const unknownTool = await api('POST', '/api/search', { tool: 'nope', args: {} });
  assert.strictEqual(unknownTool.status, 400);
  assert.match(unknownTool.json.error, /Unknown search tool/);

  const missingQuery = await api('POST', '/api/search', { tool: 'web_search', args: {} });
  assert.strictEqual(missingQuery.status, 400);

  const noModel = await api('POST', '/api/chat', { provider: { baseUrl: 'https://example.invalid/v1' }, messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(noModel.status, 400);
  assert.match(noModel.json.error, /model/i);

  const noMessages = await api('POST', '/api/chat', { provider: { baseUrl: 'https://example.invalid/v1' }, model: 'm', messages: [] });
  assert.strictEqual(noMessages.status, 400);

  const emptyBody = await api('POST', '/api/conversations', {});
  assert.strictEqual(emptyBody.status, 400);
});

await test('cross-origin callers cannot use this server as a search/fetch proxy', async () => {
  // The UI never calls /api/search (the chat's tools do, in-process). With open
  // CORS, any web page could have made requests from the user's network.
  const res = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ tool: 'web_search', args: { query: 'x' } }),
  });
  assert.strictEqual(
    res.headers.get('access-control-allow-origin'),
    null,
    'no permissive CORS header may be sent for the search tool'
  );
});

await test('fetch_url refuses a local address through the live server', async () => {
  const { status, json } = await api('POST', '/api/search', {
    tool: 'fetch_url',
    args: { url: `http://127.0.0.1:${PORT}/api/settings` },
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.success, false);
  assert.strictEqual(json.refused, true);
  assert.match(json.output, /Only public web pages/);
});

await test('an unknown API route answers in JSON, not with the app HTML', async () => {
  // A client parses every API answer as JSON; Express's default HTML page turned
  // a typo in a route into "Unexpected token '<'".
  const res = await api('GET', '/api/does-not-exist');
  assert.strictEqual(res.status, 404);
  assert.match(String(res.json?.error || ''), /Unknown API route/);
  assert.strictEqual(res.text.trim().startsWith('{'), true, 'the body really is JSON');
});

await test('the SPA catch-all never answers an /api path with the app', async () => {
  const res = await api('POST', '/api/agent/nope');
  assert.ok(res.status >= 400, `expected an error status, got ${res.status}`);
  assert.doesNotMatch(res.text, /<div id="root">/);
});

server.proc.kill();

// ---------------------------------------------------------------------------
// The only authentication this app has: the preview access code. It gates EVERY
// /api route (the chat, the provider keys, and the agent routes that can run
// commands), so it gets its own instance and its own checks.
// ---------------------------------------------------------------------------
const TOKEN = 'test-access-code-123';
const AUTH_PORT = PORT + 1;
const AUTH_BASE = `http://127.0.0.1:${AUTH_PORT}`;
const locked = startServer({ port: AUTH_PORT, extraEnv: { DANAV_PREVIEW_TOKEN: TOKEN } });

try {
  await waitForServer(locked, AUTH_BASE);
  const authApi = async (route, headers) => {
    const res = await fetch(`${AUTH_BASE}${route}`, { headers: headers || {} });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not json */
    }
    return { status: res.status, json };
  };

  await test('with an access code set, every API route answers 401 without it', async () => {
    for (const route of ['/api/settings', '/api/conversations', '/api/agent/workspaces']) {
      const { status, json } = await authApi(route);
      assert.strictEqual(status, 401, `${route} must be locked`);
      assert.strictEqual(json.code, 'preview_auth_required');
    }
  });

  await test('the check endpoint reports that a code is required, without revealing it', async () => {
    const { status, json } = await authApi('/api/preview-auth/check');
    assert.strictEqual(status, 401);
    assert.strictEqual(json.required, true);
    assert.strictEqual(json.authenticated, false);
    assert(!JSON.stringify(json).includes(TOKEN), 'the code itself must never be echoed');
  });

  await test('the access code unlocks the API, and agent routes still need their own header', async () => {
    const header = { 'x-danav-preview-token': TOKEN };
    assert.strictEqual((await authApi('/api/settings', header)).status, 200);
    assert.strictEqual((await authApi('/api/preview-auth/check', header)).json.authenticated, true);

    const agentWithoutHeader = await authApi('/api/agent/workspaces', header);
    assert.strictEqual(agentWithoutHeader.status, 403, 'the agent needs x-danav-agent as well');

    const agent = await authApi('/api/agent/workspaces', { ...header, 'x-danav-agent': '1' });
    assert.strictEqual(agent.status, 200);
  });

  await test('a wrong access code is rejected', async () => {
    const { status } = await authApi('/api/settings', { 'x-danav-preview-token': 'not-the-code' });
    assert.strictEqual(status, 401);
  });
} finally {
  locked.proc.kill();
}

// ---------------------------------------------------------------------------
// A code nobody typed: the one Danav generates for itself the moment the app
// is reachable on a public hostname. Forgetting this path means shipping a
// preview whose API — and therefore whose provider key — is open to any visitor.
// ---------------------------------------------------------------------------
const AUTO_PORT = PORT + 2;
const AUTO_BASE = `http://127.0.0.1:${AUTO_PORT}`;
const autoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-auto-token-'));
const auto = startServer({
  port: AUTO_PORT,
  extraEnv: { DANAV_ALLOWED_HOSTS: '.e2b.app', DANAV_DATA_DIR: autoDir },
});
const tokenFile = path.join(autoDir, 'preview-token.txt');

try {
  await waitForServer(auto, AUTO_BASE);

  await test('a public host generates an access code and gates the API with it', async () => {
    const open = await fetch(`${AUTO_BASE}/api/settings`);
    assert.strictEqual(open.status, 401, 'no code, no settings');
    assert.strictEqual((await open.json()).code, 'preview_auth_required');

    const code = fs.readFileSync(tokenFile, 'utf-8').trim();
    assert.match(code, /^[a-z0-9-]{6,}$/i);

    const unlocked = await fetch(`${AUTO_BASE}/api/settings`, {
      headers: { 'x-danav-preview-token': code },
    });
    assert.strictEqual(unlocked.status, 200);
  });

  await test('the generated code is private to the account and survives a restart', async () => {
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(tokenFile).mode & 0o777, 0o600);
    }
    const code = fs.readFileSync(tokenFile, 'utf-8').trim();
    auto.proc.kill();
    const restarted = startServer({
      port: AUTO_PORT,
      extraEnv: { DANAV_ALLOWED_HOSTS: '.e2b.app', DANAV_DATA_DIR: autoDir },
    });
    try {
      await waitForServer(restarted, AUTO_BASE);
      assert.strictEqual(fs.readFileSync(tokenFile, 'utf-8').trim(), code, 'the code must not rotate');
      const stillWorks = await fetch(`${AUTO_BASE}/api/settings`, {
        headers: { 'x-danav-preview-token': code },
      });
      assert.strictEqual(stillWorks.status, 200, 'a tab that unlocked before the restart stays unlocked');
    } finally {
      restarted.proc.kill();
    }
  });

  await test('an operator can switch the code off, and their own code wins', async () => {
    const optOut = startServer({
      port: AUTO_PORT,
      extraEnv: { DANAV_ALLOWED_HOSTS: '.e2b.app', DANAV_DISABLE_PREVIEW_AUTH: '1', DANAV_DATA_DIR: autoDir },
    });
    try {
      await waitForServer(optOut, AUTO_BASE);
      const open = await fetch(`${AUTO_BASE}/api/settings`);
      assert.strictEqual(open.status, 200, 'disabled means open, on purpose');
    } finally {
      optOut.proc.kill();
    }

    const chosen = startServer({
      port: AUTO_PORT,
      extraEnv: {
        DANAV_ALLOWED_HOSTS: '.e2b.app',
        DANAV_PREVIEW_TOKEN: 'chosen-by-the-operator',
        DANAV_DATA_DIR: autoDir,
      },
    });
    try {
      await waitForServer(chosen, AUTO_BASE);
      const generated = fs.readFileSync(tokenFile, 'utf-8').trim();
      const withGenerated = await fetch(`${AUTO_BASE}/api/settings`, {
        headers: { 'x-danav-preview-token': generated },
      });
      assert.strictEqual(withGenerated.status, 401, 'the generated code must not be a second key');
      const withChosen = await fetch(`${AUTO_BASE}/api/settings`, {
        headers: { 'x-danav-preview-token': 'chosen-by-the-operator' },
      });
      assert.strictEqual(withChosen.status, 200);
    } finally {
      chosen.proc.kill();
    }
  });
} finally {
  auto.proc.kill();
  fs.rmSync(autoDir, { recursive: true, force: true });
}

fs.rmSync(dataDir, { recursive: true, force: true });

console.log('');
if (failures.length) {
  console.log(`\u274c ${failures.length} SERVER INTEGRATION TEST${failures.length === 1 ? '' : 'S'} FAILED`);
  for (const f of failures) console.log(`   - ${f.name}: ${f.err.message}`);
  process.exit(1);
}
console.log('====================================================');
console.log(`\ud83c\udf89 ALL ${passed} SERVER INTEGRATION TESTS PASSED`);
console.log('====================================================');
