/**
 * Proves the docked preview re-navigates to the NEW build at the SAME url.
 *
 *   npm run harness:preview:reload      (needs `npm run dev:web` running)
 *
 * What it does:
 *   1. serves a mutable page over HTTP with `Cache-Control: max-age=600`, so a
 *      stale copy is genuinely available to be served out of cache;
 *   2. mounts the REAL PreviewPanel in headless Chrome, pointed at that page;
 *   3. rebuilds the page (v1 → v2) and checks the panel is still on v1 — the
 *      exact failure the user reported, which is why the fix cannot be "just
 *      reload it";
 *   4. raises the load token (what opening the preview now does) and checks the
 *      panel really lands on v2, with a fresh request carrying the cache-bust;
 *   5. presses the panel's own Reload button and checks it loads again.
 *
 * Exits non-zero if any of that fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WEB = process.env.HARNESS_WEB || 'http://127.0.0.1:5173';
const DEBUG_PORT = Number(process.env.HARNESS_PORT || 9334);

// ---- the mutable, cacheable "preview server" --------------------------------
let build = 'v1';
/** Every request the browser made, in order. */
const requests = [];

const server = http.createServer((req, res) => {
  const seen = new URL(req.url, 'http://x');
  requests.push({ url: req.url, bust: seen.searchParams.get('__danav') });
  const body = `<!doctype html><meta charset="utf-8"><title>build ${build}</title>
<body><h1 id="build">${build}</h1>
<script>parent.postMessage({ danavBuild: ${JSON.stringify(build)} }, '*');</script>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    // Deliberately cacheable: without a new URL, the browser is entitled to
    // answer the next navigation from its own copy — which is the bug.
    'cache-control': 'public, max-age=600',
  });
  res.end(body);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PREVIEW_PORT = server.address().port;
const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/`;

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${JSON.stringify(detail)})`}`);
  if (!ok) failures.push(label);
};

// ---- the browser -------------------------------------------------------------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-reload-'));
const page = `${WEB}/scripts/harness/reload.html?preview=${encodeURIComponent(PREVIEW_URL)}`;
const browser = spawn(
  BROWSER,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1200,900',
    page,
  ],
  { stdio: 'ignore' }
);

const cleanup = () => {
  try { ws?.close(); } catch { /* already closed */ }
  try { browser.kill(); } catch { /* already gone */ }
  try { server.close(); } catch { /* already closed */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* windows lock */ }
};
process.on('exit', cleanup);

let ws;
async function findPage() {
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const found = list.find((t) => t.type === 'page' && t.url.includes('/scripts/harness/reload.html'));
      if (found?.webSocketDebuggerUrl) return found;
    } catch { /* not listening yet */ }
  }
  return null;
}

const target = await findPage();
if (!target) {
  console.error(`Could not reach the harness page. Is the dev server running at ${WEB}?`);
  process.exit(1);
}

ws = new WebSocket(target.webSocketDebuggerUrl);
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

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res?.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
  return res?.result?.result?.value;
};

const builds = () => evaluate('JSON.stringify(window.__builds || [])').then((v) => JSON.parse(v || '[]'));
const waitFor = async (predicate, ms = 6000) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > until) return null;
    await sleep(100);
  }
};

console.log(`preview server : ${PREVIEW_URL}  (cacheable, mutable)`);
console.log(`harness page   : ${page}\n`);

try {
  const mounted = await waitFor(async () => (await evaluate('window.__harness ? window.__harness.length : 0')) > 0, 15000);
  check(Boolean(mounted), 'the harness mounted and the real PreviewPanel rendered');

  // ---- 1. the first load ---------------------------------------------------
  const first = await waitFor(async () => {
    const b = await builds();
    return b.length ? b : null;
  }, 8000);
  check(first?.[0] === 'v1', 'the panel loaded the first build', first);
  check(requests.length >= 1 && Boolean(requests[0].bust), 'the first load carried a load token', requests[0]);
  const afterFirst = requests.length;

  // ---- 2. the control: a rebuild behind the same URL is invisible ----------
  build = 'v2';
  await sleep(800);
  const unchanged = await builds();
  check(
    unchanged.length === 1 && unchanged[0] === 'v1',
    'CONTROL: with no new token the panel stays on the old build (this is the reported bug)',
    unchanged
  );

  // ---- 3. the fix: a new load token ---------------------------------------
  await evaluate('window.__bump()');
  const reloaded = await waitFor(async () => {
    const b = await builds();
    return b.includes('v2') ? b : null;
  }, 8000);
  check(Boolean(reloaded), 'a new load token makes the panel show the new build', reloaded);
  check(requests.length > afterFirst, 'and it was a real navigation, not a cache hit', requests.length - afterFirst);
  const busts = requests.map((r) => r.bust);
  check(new Set(busts).size === busts.length, 'every load asked for a distinct URL', busts);

  // ---- 4. the panel's own Reload button ------------------------------------
  const beforeButton = (await builds()).length;
  await evaluate(`document.querySelector('[data-testid="preview-panel"] button[title="Reload preview"]').click()`);
  const afterButton = await waitFor(async () => {
    const b = await builds();
    return b.length > beforeButton ? b : null;
  }, 8000);
  check(Boolean(afterButton), 'the Reload button loads the page again', afterButton);
  check(
    requests[requests.length - 1] && requests[requests.length - 1].bust !== requests[requests.length - 2]?.bust,
    'and it did not reuse the previous load token',
    requests.slice(-2).map((r) => r.bust)
  );

  console.log(`\nrequests: ${requests.map((r) => `${r.url}`).join('\n          ')}`);
} catch (err) {
  check(false, `the harness threw: ${err?.message || err}`);
} finally {
  cleanup();
}

console.log(failures.length ? `\n${failures.length} failed` : '\nall good');
process.exit(failures.length ? 1 : 0);
