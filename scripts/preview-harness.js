/**
 * Drives `__harness.html` in a real Chrome and prints what it measured.
 *
 *   node scripts/preview-harness.js
 *
 * Needs the dev server running (`npm run dev:web`). This exists because the two
 * things the preview divider is judged on — "does the panel follow the pointer
 * without lag" and "how tall is the header" — cannot be answered by a static
 * render or by a unit test. The harness dispatches real pointer events and
 * counts real React renders, and this script reads the answer back over the
 * DevTools protocol.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const BROWSER = process.env.CHROME_PATH || CANDIDATES.find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.error('No Chrome/Edge found. Set CHROME_PATH.');
  process.exit(2);
}

const PORT = Number(process.env.HARNESS_PORT || 9333);
const URL = process.env.HARNESS_URL || 'http://127.0.0.1:5173/scripts/harness/index.html';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-harness-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(
  BROWSER,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    URL,
  ],
  { stdio: 'ignore' }
);

let ws;
const cleanup = () => {
  try { ws?.close(); } catch { /* already closed */ }
  try { browser.kill(); } catch { /* already gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* windows lock */ }
};
process.on('exit', cleanup);

async function findPage() {
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('/scripts/harness/'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* not listening yet */ }
  }
  return null;
}

const page = await findPage();
if (!page) {
  console.error(`Could not reach ${URL} in the browser. Is the dev server running?`);
  process.exit(1);
}

ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const inflight = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  const settle = inflight.get(msg.id);
  if (settle) { inflight.delete(msg.id); settle(msg); }
});
const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    inflight.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

let lines = [];
for (let i = 0; i < 200; i++) {
  await sleep(150);
  const res = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__harness || null)',
    returnByValue: true,
  });
  const raw = res?.result?.result?.value;
  if (raw && raw !== 'null') {
    lines = JSON.parse(raw);
    if (lines.some((l) => l.startsWith('step="done"') || /^(THREW|UNCAUGHT|REJECTED)/.test(l))) break;
  }
}

console.log(lines.length ? lines.join('\n') : '(the harness produced nothing)');
const failed = !lines.length || lines.some((l) => /^(THREW|UNCAUGHT|REJECTED)/.test(l));
process.exit(failed ? 1 : 0);
