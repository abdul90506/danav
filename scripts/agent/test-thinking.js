/** Provider-aware reasoning levels and the streamed Gemini thought-card path. */
import assert from 'node:assert/strict';
import { modelForProvider, thinkingParams } from '../../server/agent/thinking.js';
import { streamCompletion } from '../../server/agent/llm.js';

const { test } = globalThis.__agentTest;
const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta/openai/';

console.log('\n[thinking levels]');

test('Gemini 3.5 Flash-Lite Auto preserves its default effort and requests visible thought summaries', () => {
  assert.equal(modelForProvider(GOOGLE, 'models/gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite');
  assert.deepEqual(thinkingParams({ model: 'models/gemini-3.5-flash-lite', baseUrl: GOOGLE, level: 'Auto' }), {
    extra_body: { google: { thinking_config: { include_thoughts: true } } },
  });
});

test('Gemini effort maps Low / Medium / High exactly; Gemini 2.5 keeps token-budget mapping', () => {
  for (const level of ['Low', 'Medium', 'High']) {
    assert.deepEqual(thinkingParams({ model: 'gemini-3.5-flash-lite', baseUrl: GOOGLE, level }), {
      extra_body: { google: { thinking_config: { thinking_level: level.toLowerCase(), include_thoughts: true } } },
    });
  }
  assert.deepEqual(thinkingParams({ model: 'gemini-2.5-flash', baseUrl: GOOGLE, level: 'High' }), {
    extra_body: { google: { thinking_config: { thinking_budget: 24576, include_thoughts: true } } },
  });
});

test('non-Google providers receive the selected reasoning_effort, and Auto is truly Auto', () => {
  const baseUrl = 'https://api.example.test/v1';
  assert.deepEqual(thinkingParams({ model: 'reasoner', baseUrl, level: 'High' }), { reasoning_effort: 'high' });
  assert.deepEqual(thinkingParams({ model: 'reasoner', baseUrl, level: 'Auto' }), {});
});

test('Gemini stream normalizes model ids, sends the chosen level, and routes thought chunks to the thought box', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    const payload = [
      { choices: [{ delta: { content: 'Checking the constraints.', extra_content: { google: { thought: true } } } }] },
      { choices: [{ delta: { content: 'Here is the result.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  try {
    let answer = '';
    let thought = '';
    await streamCompletion({
      provider: { baseUrl: GOOGLE, apiKey: 'test-provider-key' },
      model: 'models/gemini-3.5-flash-lite',
      thinkingLevel: 'High',
      messages: [{ role: 'user', content: 'Check this carefully.' }],
      onText: (s) => { answer += s; },
      onThinking: (s) => { thought += s; },
    });
    assert.equal(body.model, 'gemini-3.5-flash-lite');
    assert.deepEqual(body.extra_body.google.thinking_config, { thinking_level: 'high', include_thoughts: true });
    assert.equal(body.reasoning_effort, undefined, 'Gemini must not receive two conflicting effort controls');
    assert.equal(thought, 'Checking the constraints.');
    assert.equal(answer, 'Here is the result.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a rejected explicit effort is an honest error, never a silent lower-effort retry', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'Unsupported thinking_level for this endpoint' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await assert.rejects(
      streamCompletion({
        provider: { baseUrl: GOOGLE, apiKey: 'test-provider-key' },
        model: 'gemini-3.5-flash-lite',
        thinkingLevel: 'High',
        messages: [{ role: 'user', content: 'reason' }],
      }),
      /rejected the selected High thinking effort/i,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Auto may fall back from unsupported thought-summary display without changing the model default', async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'Unsupported include_thoughts option' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  try {
    await streamCompletion({
      provider: { baseUrl: GOOGLE, apiKey: 'test-provider-key' },
      model: 'gemini-3.5-flash-lite',
      thinkingLevel: 'Auto',
      messages: [{ role: 'user', content: 'quick check' }],
    });
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0].extra_body.google.thinking_config, { include_thoughts: true });
    assert.equal(bodies[1].extra_body, undefined);
    assert.equal(bodies[1].model, 'gemini-3.5-flash-lite');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
