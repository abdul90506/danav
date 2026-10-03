import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('=== STARTING COMPLETE APPLICATION VERIFICATION SUITE ===\n');

/**
 * This suite drives the instance you are using — which, when the app is served
 * on a public hostname, is behind the preview access code. Read the same code
 * the server would (env, or the file it keeps), so the suite tests the real app
 * instead of failing on 401.
 */
function previewAccessCode() {
  const fromEnv = String(process.env.DANAV_PREVIEW_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = process.env.DANAV_DATA_DIR || path.join(root, 'server', 'data');
  try {
    return fs.readFileSync(path.join(dataDir, 'preview-token.txt'), 'utf-8').trim();
  } catch {
    return '';
  }
}

const ACCESS_CODE = previewAccessCode();

/** fetch() with the access header, when this instance asks for one. */
const apiFetch = (url, init = {}) =>
  fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), ...(ACCESS_CODE ? { 'x-danav-preview-token': ACCESS_CODE } : {}) },
  });


async function runTests() {
  const BASE_URL = 'http://localhost:5173';
  if (ACCESS_CODE) console.log(`(sending the preview access code from ${process.env.DANAV_PREVIEW_TOKEN ? 'DANAV_PREVIEW_TOKEN' : 'server/data/preview-token.txt'})\n`);

  // 1. Check Root UI HTML loads
  console.log('Test 1: Frontend HTML delivery...');
  const rootRes = await fetch(`${BASE_URL}/`);
  assert.strictEqual(rootRes.status, 200);
  const html = await rootRes.text();
  assert(html.includes('<!DOCTYPE html>'), 'Must include HTML5 doctype');
  assert(html.includes('/src/main.tsx'), 'Must include main script tag');
  console.log('✓ Passed: Frontend serves index.html with correct root and script tags.\n');

  // 2. Test Provider Connection Testing (Success)
  console.log('Test 2: Test Provider Connection (Mock/Local)...');
  const testConnRes = await apiFetch(`${BASE_URL}/api/providers/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiType: 'mock' }),
  });
  assert.strictEqual(testConnRes.status, 200);
  const testConnData = await testConnRes.json();
  assert.strictEqual(testConnData.success, true);
  console.log('✓ Passed: Provider connection test returns success for valid provider.\n');

  // 3. Test Provider Connection Testing (Failure / Graceful error)
  console.log('Test 3: Provider Connection Failure Handling...');
  const failConnRes = await apiFetch(`${BASE_URL}/api/providers/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:59999', apiType: 'openai' }),
  });
  const failConnData = await failConnRes.json();
  assert.strictEqual(failConnData.success, false);
  assert(failConnData.error, 'Must provide clear human readable error message');
  console.log('✓ Passed: Graceful error returned on unreachable provider:', failConnData.error, '\n');

  // 4. Test Fetching Models
  console.log('Test 4: Dynamic Model Fetching...');
  const fetchModelsRes = await apiFetch(`${BASE_URL}/api/providers/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiType: 'mock' }),
  });
  assert.strictEqual(fetchModelsRes.status, 200);
  const modelsData = await fetchModelsRes.json();
  assert.strictEqual(modelsData.success, true);
  assert(Array.isArray(modelsData.models), 'models must be an array');
  assert(modelsData.models.length >= 2, 'Should return at least 2 models');
  const reasoningModel = modelsData.models.find((m) => m.supportsThinking);
  assert(reasoningModel, 'Should include model that supports thinking');
  console.log('✓ Passed: Dynamic models fetched:', modelsData.models.map((m) => m.name), '\n');

  // 5. Test Chat SSE Streaming with Standard Model
  console.log('Test 5: Chat SSE Streaming (Standard)...');
  const chatRes1 = await apiFetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: { id: 'p1', baseUrl: 'http://localhost:3001', apiType: 'mock' },
      model: 'demo-assistant-v2',
      thinkingLevel: 'Auto',
      messages: [{ role: 'user', content: 'Give me a comparison table' }],
    }),
  });
  assert.strictEqual(chatRes1.status, 200);
  const reader1 = chatRes1.body.getReader();
  const decoder1 = new TextDecoder();
  let receivedContent1 = '';
  let receivedStatus1 = false;
  let isDone1 = false;

  while (true) {
    const { done, value } = await reader1.read();
    if (done) break;
    const chunk = decoder1.decode(value);
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const payloadStr = line.slice(6);
        if (payloadStr === '[DONE]') {
          isDone1 = true;
          continue;
        }
        try {
          const parsed = JSON.parse(payloadStr);
          if (parsed.status) receivedStatus1 = true;
          if (parsed.content) receivedContent1 += parsed.content;
          if (parsed.done) isDone1 = true;
        } catch {}
      }
    }
  }

  assert(receivedStatus1, 'Should have received status event (e.g. Generating...)');
  assert(receivedContent1.length > 50, 'Should have streamed markdown content');
  assert(receivedContent1.includes('|'), 'Response should include markdown table');
  assert(isDone1, 'Stream should cleanly terminate with [DONE]');
  console.log('✓ Passed: SSE streaming received chunks, table, and finished cleanly.\n');

  // 6. Test Chat SSE Streaming with Reasoning Model & High Thinking Level
  console.log('Test 6: Chat SSE Streaming with Reasoning & Thinking Level (High)...');
  const chatRes2 = await apiFetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: { id: 'p1', baseUrl: 'http://localhost:3001', apiType: 'mock' },
      model: 'demo-reasoning-pro',
      thinkingLevel: 'High',
      messages: [{ role: 'user', content: 'Write a python script for async processing' }],
    }),
  });
  assert.strictEqual(chatRes2.status, 200);
  const reader2 = chatRes2.body.getReader();
  const decoder2 = new TextDecoder();
  let receivedContent2 = '';
  let thinkingStatusReceived = false;

  while (true) {
    const { done, value } = await reader2.read();
    if (done) break;
    const chunk = decoder2.decode(value);
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const payloadStr = line.slice(6);
        if (payloadStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payloadStr);
          if (parsed.status && (parsed.status.includes('Thinking') || parsed.status.includes('Reasoning'))) {
            thinkingStatusReceived = true;
          }
          if (parsed.content) receivedContent2 += parsed.content;
        } catch {}
      }
    }
  }

  assert(thinkingStatusReceived, 'Should receive unobtrusive thinking status event');
  assert(receivedContent2.includes('```python'), 'Response should contain python code block');
  console.log('✓ Passed: Reasoning model streams thinking status and python code block.\n');

  // 7. Test Missing Fields in Chat Request
  console.log('Test 7: Missing fields validation in Chat...');
  const chatErrRes = await apiFetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.strictEqual(chatErrRes.status, 400);
  const chatErrData = await chatErrRes.json();
  assert(chatErrData.error, 'Must return error message for missing provider');
  console.log('✓ Passed: Validates missing payload with HTTP 400 and clear error.\n');

  console.log('====================================================');
  console.log('🎉 ALL INTEGRATION VERIFICATION TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================\n');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
