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
