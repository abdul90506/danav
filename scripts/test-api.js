import assert from 'assert';
import { streamChatCompletion } from '../src/services/api.ts';

/**
 * Regression tests for the streaming chat API layer: SSE chunk delivery, the
 * "cut off by the token limit" signal, and error/abort handling.
 */

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

const realFetch = globalThis.fetch;
function stubFetch(response) {
  globalThis.fetch = async () => response;
}

/** A fake SSE response body, so the streaming parser can be exercised. */
function sseResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
  };
}

const PROVIDER = { id: 'p', baseUrl: 'http://example.test', apiType: 'openai' };

async function main() {
  console.log('Streaming layer\n');

  await test('content chunks reach onChunk', async () => {
    stubFetch(sseResponse(['data: {"content":"hello "}\n\n', 'data: {"content":"world"}\n\n', 'data: [DONE]\n\n']));
    let text = '';
    await streamChatCompletion({
      provider: PROVIDER,
      model: 'm',
      thinkingLevel: 'Auto',
      messages: [],
      onChunk: (c) => {
        text += c;
      },
      onError: (e) => {
        throw new Error(e);
      },
      onDone: () => {},
    });
    assert.strictEqual(text, 'hello world');
  });

  await test('stream status events reach onStatus before later content', async () => {
    stubFetch(sseResponse([
      'data: {"status":"Provider is busy — retry 1 of 3 in 2s…"}\n\n',
      'data: {"content":"answer"}\n\n',
      'data: [DONE]\n\n',
    ]));
    const statuses = [];
    let text = '';
    await streamChatCompletion({
      provider: PROVIDER,
      model: 'm',
      thinkingLevel: 'Auto',
      messages: [],
      onStatus: (status) => statuses.push(status),
      onChunk: (chunk) => { text += chunk; },
      onError: (error) => { throw new Error(error); },
      onDone: () => {},
    });
    assert.deepEqual(statuses, ['Provider is busy — retry 1 of 3 in 2s…']);
    assert.equal(text, 'answer');
  });

  await test('thinking is separated from content', async () => {
    stubFetch(sseResponse(['data: {"thinking":"let me think"}\n\n', 'data: {"content":"answer"}\n\n', 'data: [DONE]\n\n']));
    let text = '';
    let think = '';
    await streamChatCompletion({
      provider: PROVIDER,
      model: 'm',
      thinkingLevel: 'Auto',
      messages: [],
      onChunk: (c) => {
        text += c;
      },
      onThinking: (t) => {
        think += t;
      },
      onError: (e) => {
        throw new Error(e);
      },
      onDone: () => {},
    });
    assert.strictEqual(think, 'let me think');
    assert.strictEqual(text, 'answer');
  });

  await test('finishReason "length" is forwarded (the truncation signal)', async () => {
    stubFetch(
      sseResponse([
        'data: {"content":"<write_file path=\\"a\\">half"}\n\n',
        'data: {"finishReason":"length"}\n\n',
        'data: [DONE]\n\n',
      ])
    );
    let reason = '';
    let text = '';
    await streamChatCompletion({
      provider: PROVIDER,
      model: 'm',
      thinkingLevel: 'Auto',
      messages: [],
      onChunk: (c) => {
        text += c;
      },
      onFinishReason: (r) => {
        reason = r;
      },
      onError: (e) => {
        throw new Error(e);
      },
      onDone: () => {},
    });
    assert.strictEqual(reason, 'length', 'the cut-off signal must reach the agent loop');
    assert.strictEqual(text, '<write_file path="a">half');
  });

  await test('a normal stop is forwarded as "stop"', async () => {
    stubFetch(sseResponse(['data: {"content":"done"}\n\n', 'data: {"finishReason":"stop"}\n\n', 'data: [DONE]\n\n']));
    let reason = '';
    await streamChatCompletion({
      provider: PROVIDER,
      model: 'm',
      thinkingLevel: 'Auto',
      messages: [],
      onChunk: () => {},
      onFinishReason: (r) => {
        reason = r;
      },
      onError: (e) => {
        throw new Error(e);
      },
      onDone: () => {},
    });
    assert.strictEqual(reason, 'stop');
  });

  console.log('\nStreaming resilience');

  await test('an error event stops the stream instead of reading on', async () => {
    // Regression: `onError` fired but the reader kept going, so the caller's
    // abort controller had already been cleared while chunks were still
    // arriving — Stop no longer stopped anything.
    stubFetch(
      sseResponse([
        'data: {"content":"partial"}\n\n',
        'data: {"error":"provider exploded"}\n\n',
        'data: {"content":"SHOULD-NOT-ARRIVE"}\n\n',
      ])
    );
    let text = '';
    const errors = [];
    let done = 0;
    await streamChatCompletion({
      provider: PROVIDER,
      model: 'm',
      thinkingLevel: 'Auto',
      messages: [],
      onChunk: (c) => {
        text += c;
      },
      onError: (e) => errors.push(e),
      onDone: () => {
        done++;
      },
    });
    assert.strictEqual(errors.length, 1, `expected one error, got ${JSON.stringify(errors)}`);
    assert(/provider exploded/.test(errors[0]), `got ${errors[0]}`);
    assert.strictEqual(text, 'partial', `nothing after the error may be delivered, got ${text}`);
    assert.strictEqual(done, 0, 'onDone must not fire after an error event');
  });

  await test('a drop AFTER content arrived is not retried (no duplicate reply)', async () => {
    // Regression: the internal retry replayed the whole request, so the model's
    // reply was appended a second time on top of the partial one.
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"content":"hello"}\n\n'));
          },
          // Error only once the queued chunk has been consumed, so the drop
          // genuinely happens AFTER content was delivered.
          pull(controller) {
            controller.error(new Error('stream dropped'));
          },
        }),
      };
    };

    let text = '';
    const errors = [];
    await streamChatCompletion({
      provider: PROVIDER,
      model: 'm',
      thinkingLevel: 'Auto',
      messages: [],
      onChunk: (c) => {
        text += c;
      },
      onError: (e) => errors.push(e),
      onDone: () => {},
    });

    assert.strictEqual(calls, 1, `a retry after content would duplicate the reply (${calls} calls)`);
    assert.strictEqual(text, 'hello', `content must not be duplicated, got ${text}`);
    assert.strictEqual(errors.length, 1, 'the caller must be told the stream dropped');
  });

  console.log('\nWeb tool events');

  await test('tool lifecycle events reach onTool in order', async () => {
    stubFetch(
      sseResponse([
        'data: {"tool":{"id":"t1","name":"web_search","status":"running","query":"node lts"}}\n\n',
        'data: {"content":"Let me check. "}\n\n',
        'data: {"tool":{"id":"t1","name":"web_search","status":"done","ok":true,"sources":[{"domain":"nodejs.org","name":"Node.js"}]}}\n\n',
        'data: {"content":"Node 22 is LTS."}\n\n',
        'data: [DONE]\n\n',
      ])
    );
    const seen = [];
    let text = '';
    await streamChatCompletion({
      provider: PROVIDER,
      model: 'm',
      thinkingLevel: 'Auto',
      messages: [],
      toolsEnabled: true,
      onChunk: (c) => {
        text += c;
      },
      onTool: (t) => seen.push(t),
      onError: (e) => {
        throw new Error(e);
      },
      onDone: () => {},
    });

    assert.strictEqual(seen.length, 2, `expected running + done, got ${JSON.stringify(seen)}`);
    assert.strictEqual(seen[0].status, 'running', 'the first event must be the running state');
    assert.strictEqual(seen[0].query, 'node lts', 'the query the model chose must survive');
    assert.strictEqual(seen[1].status, 'done');
    assert.strictEqual(seen[1].summary, undefined, 'web searches no longer display a bare result count');
    assert.deepStrictEqual(seen[1].sources, [{ domain: 'nodejs.org', name: 'Node.js' }]);
    assert.strictEqual(seen[0].id, seen[1].id, 'both events must share an id so they merge into one row');
    assert.strictEqual(text, 'Let me check. Node 22 is LTS.');
  });

  await test('a failing tool is reported, not swallowed', async () => {
    stubFetch(
      sseResponse([
        'data: {"tool":{"id":"t9","name":"fetch_url","status":"done","ok":false,"query":"https://x.test","summary":"Failed"}}\n\n',
        'data: [DONE]\n\n',
      ])
    );
    const seen = [];
    await streamChatCompletion({
      provider: PROVIDER,
      model: 'm',
      thinkingLevel: 'Auto',
      messages: [],
      onChunk: () => {},
      onTool: (t) => seen.push(t),
      onError: (e) => {
        throw new Error(e);
      },
      onDone: () => {},
    });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].ok, false, 'a failed fetch must arrive as ok:false');
  });

  await test('toolsEnabled is only sent when the toggle is on', async () => {
    let sentBody = null;
    globalThis.fetch = async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return sseResponse(['data: [DONE]\n\n']);
    };

    await streamChatCompletion({
      provider: PROVIDER,
      model: 'm',
      thinkingLevel: 'Auto',
      messages: [],
      onChunk: () => {},
      onError: () => {},
      onDone: () => {},
    });
    assert.strictEqual(
      'toolsEnabled' in sentBody,
      false,
      'a plain chat turn must not advertise tools'
    );

    await streamChatCompletion({
      provider: PROVIDER,
      model: 'm',
      thinkingLevel: 'Auto',
      messages: [],
      toolsEnabled: true,
      onChunk: () => {},
      onError: () => {},
      onDone: () => {},
    });
    assert.strictEqual(sentBody.toolsEnabled, true, 'the toggle must reach the server');
  });

  globalThis.fetch = realFetch;

  console.log('\n====================================================');
  if (failures.length === 0) {
    console.log(`\uD83C\uDF89 ALL ${passed} API TESTS PASSED`);
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`);
    for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  }
  console.log('====================================================\n');

  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
