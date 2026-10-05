/**
 * Raw SSE probe: what does the provider actually send, and WHEN?
 *
 *   node scripts/probe-raw.js agnes-3.0-flash
 *   node scripts/probe-raw.js models/gemini-3.5-flash-lite
 *
 * Prints one line per SSE chunk that carries tool-call arguments, with the
 * number of argument characters in that chunk and the gap since the previous
 * one. If every chunk after the first is 0 bytes, the provider dumps the whole
 * call in one frame and there is no stream to follow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../server/agent/config.js';

const model = process.argv[2] || 'agnes-3.0-flash';
const settings = JSON.parse(fs.readFileSync(path.join(dataDir(), 'settings.json'), 'utf8'));
const provider = settings.providers.find((p) => p.models?.some((m) => m.id === model));
// Settings store a list of keys (several may be rotated); older files had a single
// `apiKey`. Accept both, so this probe works against whatever is configured.
const apiKey = [...(Array.isArray(provider?.apiKeys) ? provider.apiKeys : []), provider?.apiKey]
  .find((k) => typeof k === 'string' && k.trim());
if (!apiKey) {
  console.error(`No key for "${model}".`);
  process.exit(2);
}

const body = {
  model,
  stream: true,
  max_tokens: 4096,
  tool_choice: 'auto',
  messages: [
    { role: 'system', content: 'You build web pages. Use the write_file tool. Do not explain.' },
    { role: 'user', content: 'Create index.html: a landing page with a header, three feature cards and a footer. About 50 lines.' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    },
  ],
};

console.log(`\nprovider=${provider.name}  model=${model}\n`);
const t0 = Date.now();
const at = () => String(Date.now() - t0).padStart(6);

const res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify(body),
});
console.log(`${at()}ms  HTTP ${res.status}`);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let lastArgsAt = 0;
let chunkCount = 0;
let argChunks = 0;
let totalArgs = 0;
let firstArgsAt = 0;
let lastArgsLen = 0;
const gaps = [];

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let p;
    try { p = JSON.parse(payload); } catch { continue; }
    chunkCount++;
    const d = p.choices?.[0]?.delta;
    if (!d) continue;
    const tc = d.tool_calls?.[0];
    if (tc) {
      const args = tc.function?.arguments || '';
      const now = Date.now();
      if (args.length) {
        argChunks++;
        totalArgs += args.length;
        if (!firstArgsAt) firstArgsAt = now - t0;
        const gap = lastArgsAt ? now - lastArgsAt : 0;
        if (lastArgsAt) gaps.push(gap);
        lastArgsAt = now;
        lastArgsLen = args.length;
        console.log(`${at()}ms  tool_call idx=${tc.index} name=${tc.function?.name || '-'} +${String(args.length).padStart(5)}B  gap=${String(gap).padStart(6)}ms`);
      }
    }
    if (d.content) process.stdout.write(`\r${at()}ms  content +${d.content.length}      `);
  }
}

console.log(`\n\nchunks=${chunkCount}  argChunks=${argChunks}  totalArgs=${totalArgs}B`);
if (argChunks) {
  const span = lastArgsAt - (t0 + firstArgsAt);
  console.log(`first arg chunk at ${firstArgsAt}ms, last at ${lastArgsAt - t0}ms  ->  span ${span}ms`);
  console.log(`gaps: min=${Math.min(...gaps)}ms max=${Math.max(...gaps)}ms avg=${Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)}ms`);
  console.log(argChunks <= 2 ? '\n>>> ONE-SHOT: the provider does NOT stream tool arguments.' : '\n>>> REAL STREAM: arguments arrive in pieces.');
}
process.exit(0);
