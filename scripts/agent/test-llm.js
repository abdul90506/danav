/** Talking to a provider: how saved keys are swept, and when the run actually waits. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamCompletion } from '../../server/agent/llm.js';

const { test } = globalThis.__agentTest;

console.log('\n[llm]');

/** A provider that always answers `status`, recording the key each request carried. */
async function failingProvider(status, bodyText = '{"error":{"message":"rate limit"}}') {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ key: String(req.headers.authorization || '').replace('Bearer ', ''), at: Date.now() });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(bodyText);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
}

test('a rate-limited key is replaced by the next one instantly; only a spent sweep waits', async () => {
  const up = await failingProvider(429);
  const prev = process.env.DANAV_LLM_RETRY_BASE_MS;
  process.env.DANAV_LLM_RETRY_BASE_MS = '400';
  const ctrl = new AbortController();
  const retries = [];
  try {
    await assert.rejects(() => streamCompletion({
      provider: { id: 'sweep', baseUrl: up.baseUrl, apiKeys: ['k1', 'k2', 'k3', 'k4'] },
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ctrl.signal,
      // Stop once the first real backoff has been announced: the rest is more of the same.
      onRetry: (info) => {
        retries.push(info);
        if (info.delayMs > 0) setTimeout(() => ctrl.abort(), 10);
      },
    }));
  } finally {
    process.env.DANAV_LLM_RETRY_BASE_MS = prev ?? '';
    if (prev === undefined) delete process.env.DANAV_LLM_RETRY_BASE_MS;
    up.close();
  }

  // Having four keys is pointless if the run sleeps before reaching the second one.
  assert.deepEqual(up.seen.slice(0, 4).map((s) => s.key), ['k1', 'k2', 'k3', 'k4'], 'every key is tried');
  const gaps = up.seen.slice(1, 4).map((s, i) => s.at - up.seen[i].at);
  for (const gap of gaps) assert.ok(gap < 300, `waited ${gap}ms between two keys; rotation must be immediate`);

  const rotations = retries.filter((r) => r.delayMs === 0);
  assert.equal(rotations.length, 3, 'three free rotations for four keys');
  assert.ok(rotations.every((r) => /trying the next key/.test(r.reason)), rotations.map((r) => r.reason).join(' | '));
  assert.deepEqual(rotations.map((r) => r.credentialIndex), [2, 3, 4], 'the row names which key is in hand');
  assert.ok(rotations.every((r) => r.credentialCount === 4));

  const waits = retries.filter((r) => r.delayMs > 0);
  assert.ok(waits.length >= 1, 'the spent sweep backs off');
  assert.ok(waits[0].delayMs >= 400, `first backoff was ${waits[0].delayMs}ms`);
  assert.equal(waits[0].attempt, 1, 'a whole sweep costs one retry, not one per key');
});

test('a single saved key backs off immediately — there is nothing to rotate to', async () => {
  const up = await failingProvider(503, 'server busy');
  const prev = process.env.DANAV_LLM_RETRY_BASE_MS;
  process.env.DANAV_LLM_RETRY_BASE_MS = '400';
  const ctrl = new AbortController();
  const retries = [];
  try {
    await assert.rejects(() => streamCompletion({
      provider: { id: 'single', baseUrl: up.baseUrl, apiKeys: ['only'] },
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ctrl.signal,
      onRetry: (info) => {
        retries.push(info);
        setTimeout(() => ctrl.abort(), 10);
      },
    }));
  } finally {
    process.env.DANAV_LLM_RETRY_BASE_MS = prev ?? '';
    if (prev === undefined) delete process.env.DANAV_LLM_RETRY_BASE_MS;
    up.close();
  }
  assert.ok(retries.length >= 1);
  assert.ok(retries[0].delayMs >= 400, 'one key means the very first failure is the provider being busy');
  assert.ok(!/trying the next key/.test(retries[0].reason), retries[0].reason);
});

test('a key the provider rejects outright is dropped for the round, not retried', async () => {
  const up = await failingProvider(401, '{"error":{"message":"invalid api key"}}');
  const retries = [];
  try {
    await assert.rejects(() => streamCompletion({
      provider: { id: 'bad', baseUrl: up.baseUrl, apiKeys: ['dead1', 'dead2', 'dead3'] },
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      onRetry: (info) => retries.push(info),
    }));
  } finally {
    up.close();
  }
  // Each key is offered exactly once: a rejected key is not going to start working.
  assert.deepEqual(up.seen.map((s) => s.key), ['dead1', 'dead2', 'dead3']);
  assert.ok(retries.every((r) => r.delayMs === 0), 'no waiting on keys that are simply wrong');
});
