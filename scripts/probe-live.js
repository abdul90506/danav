/**
 * End-to-end probe of the LIVE agent stream — the real HTTP/SSE path the browser
 * uses, not the loop in isolation.
 *
 *   node scripts/probe-live.js agnes-3.0-flash
 *   node scripts/probe-live.js models/gemini-3.5-flash-lite
 *
 * Boots the agent routes on a throwaway port, creates a local workspace, sends a
 * build request, and prints every event with the gap since the previous one — so
 * the cadence the user actually sees is measurable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { dataDir } from '../server/agent/config.js';
import { providerApiKeys } from '../server/settings.js';
import { registerAgentRoutes } from '../server/agent/routes.js';
import { _resetStoreCache } from '../server/agent/store.js';

const model = process.argv[2] || 'agnes-3.0-flash';
const settings = JSON.parse(fs.readFileSync(path.join(dataDir(), 'settings.json'), 'utf8'));
const provider = settings.providers.find((p) => p.models?.some((m) => m.id === model));
// Settings keep a list of keys; older files had a single `apiKey`. Read both.
const [apiKey] = providerApiKeys(provider);
if (!apiKey) {
  console.error(`No provider in settings.json offers "${model}" with a key.`);
  process.exit(2);
}

const dataDirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-live-data-'));
const wsDirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-live-ws-'));
process.env.DANAV_DATA_DIR = dataDirTmp;
process.env.DANAV_WORKSPACES_DIR = wsDirTmp;
delete process.env.DANAV_ALLOWED_HOSTS;
_resetStoreCache();

const app = express();
app.use(express.json({ limit: '10mb' }));
registerAgentRoutes(app, { runSearchTool: async () => ({ success: false }) });
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const H = { 'Content-Type': 'application/json', 'x-danav-agent': '1' };

const ws = await (
  await fetch(`${base}/api/agent/workspaces`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name: 'live', kind: 'local', autoRun: true }),
  })
).json();
if (!ws?.workspace?.id) {
  console.error('Could not create a workspace:', JSON.stringify(ws));
  process.exit(1);
}
console.log(`\nprovider=${provider.name}  model=${model}\nworkspace=${ws.workspace.root || ws.workspace.id}\n`);

const res = await fetch(`${base}/api/agent/chat`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    provider: { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, apiKey },
    model,
    thinkingLevel: 'Auto',
    workspaceId: ws.workspace.id,
    activity: [],
    messages: [{ role: 'user', content: 'Create index.html: a landing page with a header, three feature cards and a footer. Keep it about 45 lines.' }],
  }),
});

const t0 = Date.now();
const at = () => String(Date.now() - t0).padStart(6);
let prev = 0;
const gaps = [];
let lastProgress = null;
const captured = [];

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split('\n\n');
  buf = parts.pop() || '';
  for (const part of parts) {
    const line = part.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(payload); } catch { continue; }
    captured.push({ t: Date.now() - t0, ...obj });
    const now = Date.now();
    const gap = prev ? now - prev : 0;
    prev = now;
    if (obj.content) continue; // assistant text, already known to stream
    if (obj.agent) {
      const a = obj.agent;
      if (a.type === 'action_start') {
        console.log(`${at()}ms  START  ${a.tool} ${JSON.stringify(a.progress || null)}`);
      } else if (a.type === 'action_update') {
        const p = a.patch?.progress;
        if (p) {
          gaps.push(gap);
          lastProgress = p;
          console.log(`${at()}ms  +${String(p.added).padStart(3)} -${String(p.removed).padStart(3)}  tail=${p.tail?.length ?? 0}  gap=${String(gap).padStart(4)}ms`);
        } else if (a.patch?.status) {
          console.log(`${at()}ms  ${a.patch.status}`);
        }
      } else if (a.type === 'action_end') {
        console.log(`${at()}ms  END    ${a.result?.kind} +${a.result?.added} -${a.result?.removed} ${a.result?.path || ''}`);
      } else if (a.type === 'run_end') {
        console.log(`${at()}ms  RUN END`);
      }
    } else if (obj.status) {
      console.log(`${at()}ms  status: ${obj.status}`);
    } else if (obj.error) {
      console.log(`${at()}ms  ERROR: ${obj.error}`);
    }
  }
}

if (gaps.length) {
  const sorted = [...gaps].sort((a, b) => a - b);
  console.log(
    `\n${gaps.length} live updates  gap min=${sorted[0]}ms median=${sorted[Math.floor(sorted.length / 2)]}ms max=${sorted.at(-1)}ms`
  );
  console.log(`last published: +${lastProgress.added} -${lastProgress.removed}`);
}

// `--dump <file>` keeps the raw stream so the harness can replay it through the
// real components and show what the row actually looked like.
const dumpIdx = process.argv.indexOf('--dump');
if (dumpIdx > -1 && process.argv[dumpIdx + 1]) {
  const target = path.resolve(process.argv[dumpIdx + 1]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(captured));
  console.log(`\ndumped ${captured.length} events -> ${target}`);
}

server.closeAllConnections?.();
await new Promise((r) => server.close(r));
fs.rmSync(dataDirTmp, { recursive: true, force: true });
fs.rmSync(wsDirTmp, { recursive: true, force: true });
process.exit(0);
