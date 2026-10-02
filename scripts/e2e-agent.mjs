/**
 * Browser end-to-end for Agent mode: a real browser, the real backend, and a scripted fake LLM.
 * Nothing touches your data: the backend runs on its own port with temp data/workspace folders.
 *
 *   node scripts/e2e-agent.mjs local       # a folder on this machine
 *   node scripts/e2e-agent.mjs sandbox     # a real Novita sandbox (needs NOVITA_API_KEY in .env)
 *
 * Needs `playwright-core` + a Chromium (npm i --no-save playwright-core && npx playwright-core install chromium-headless-shell).
 * Screenshots land in E2E_SHOTS (default ./screenshots/agent).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import net from 'node:net';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startFakeLlm } = await import('./fake-llm.js');

async function loadPlaywright() {
  const attempts = [() => import('playwright-core'), () => import(createRequire(path.join(process.env.PW_DIR || '/tmp/pw', 'x.js')).resolve('playwright-core'))];
  for (const a of attempts) {
    try {
      return await a();
    } catch {
      /* try the next place */
    }
  }
  throw new Error('playwright-core not found. Run: npm i --no-save playwright-core && npx playwright-core install chromium-headless-shell');
}
const pw = await loadPlaywright();
const chromium = pw.chromium ?? pw.default?.chromium;

const SHOTS = process.env.E2E_SHOTS || path.join(repo, 'screenshots', 'agent');
const ROOT = '/tmp/e2e';
// free ports every run: back-to-back runs must never meet a backend that is still shutting down
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const PORT = Number(process.env.E2E_PORT) || (await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const MODE = process.argv[2] || 'local';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(`${ROOT}/data`, { recursive: true });
fs.mkdirSync(`${ROOT}/ws`, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const MODELS = ['fake-build', 'fake-slow', 'fake-loop', 'fake-approval', 'fake-preview', 'fake-project', 'fake-burst', ...(process.env.E2E_MODELS ? process.env.E2E_MODELS.split(',') : [])];
const llm = await startFakeLlm({ port: 0, chunkDelayMs: 28 });
fs.writeFileSync(`${ROOT}/data/settings.json`, JSON.stringify({
  providers: [{
    id: 'provider-fake', name: 'Fake LLM', baseUrl: llm.baseUrl, apiKey: 'test-key', apiType: 'openai', isCustom: true, enabled: true,
    models: MODELS.map((id) => ({ id, name: id, providerId: 'provider-fake', supportsThinking: true })),
  }],
  theme: 'light', lastSelectedProviderId: 'provider-fake', lastSelectedModelId: 'fake-build',
}));

const backend = spawn(process.execPath, ['server/index.js'], {
  cwd: repo,
  env: { ...process.env, PORT: String(PORT), DANAV_DATA_DIR: `${ROOT}/data`, DANAV_WORKSPACES_DIR: `${ROOT}/ws` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let backendLog = '';
// however this script ends (even a crash), the test backend must not outlive it
process.on('exit', () => { try { backend.kill('SIGTERM'); } catch { /* already gone */ } });
process.on('uncaughtException', (e) => { console.error(e); process.exit(1); });
backend.stdout.on('data', (d) => (backendLog += d));
backend.stderr.on('data', (d) => (backendLog += d));
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${BASE}/api/settings`)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text().slice(0, 200)}`); });
page.on('pageerror', (e) => problems.push(`PAGEERROR: ${e.message.slice(0, 300)}`));
page.on('requestfailed', (r) => {
  const aborted = /ERR_ABORTED|aborted/i.test(r.failure()?.errorText || '');
  if (!r.url().includes('fonts.g') && !(aborted && r.url().includes('/api/agent/chat'))) problems.push(`requestfailed: ${r.url().slice(0, 120)} ${r.failure()?.errorText}`);
});
page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/file-icons/')) problems.push(`icon ${r.status()}: ${r.url()}`); });

const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = () => page.$$eval('[data-testid="agent-timeline"] .agent-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
const results = [];
const check = (name, fn) => fn().then(
  () => { results.push(`✓ ${name}`); console.log(`  ✓ ${name}`); },
  (e) => { results.push(`✗ ${name}: ${e.message}`); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, 8).join('\n      ')}`); }
);

async function selectModel(name) {
  await page.click('button[title="Select Model"]');
  await page.click(`text="${name}"`);
}
async function send(text) {
  await page.waitForSelector('button[aria-label="Send message"]', { timeout: 120000 }); // previous run is over
  await page.fill('textarea', text);
  await page.keyboard.press('Enter');
}
// A run is over when the Stop button is gone again (older messages' footers don't count).
async function waitRunEnd(timeout = 90000) {
  await page.waitForSelector('button[aria-label="Stop generation"]', { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('button[aria-label="Stop generation"]', { state: 'detached', timeout });
  await sleep(400);
}

/** The suite is exported as steps so other scripts / future checks can add to it. */
try {
  console.log(`\n[e2e ${MODE}]`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('textarea');
  await sleep(600);

  await check('Agent toggle is shown above the input, off by default', async () => {
    assert.equal(await page.getAttribute('[data-testid="agent-controls"] button', 'aria-pressed'), 'false');
    await shot('01-home');
  });

  await check('turning Agent on opens the workspace dialog (nothing to work in yet)', async () => {
    await page.click('[data-testid="agent-controls"] button:has-text("Agent")');
    await page.waitForSelector('[role="dialog"][aria-label="New workspace"]');
    await sleep(300);
    await shot('02-workspace-dialog');
  });

  await check(`create a ${MODE} workspace`, async () => {
    await page.fill('[data-testid="ws-name"]', MODE === 'sandbox' ? 'e2e-sandbox' : 'demo-site');
    if (MODE === 'local') await page.click('[data-testid="kind-local"]');
    else assert.match(await page.innerText('[role="dialog"]'), /Novita is connected/);
    await page.click('[data-testid="ws-create"]');
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 60000 });
    assert.match(await page.innerText('[data-testid="workspace-chip"]'), MODE === 'sandbox' ? /e2e-sandbox/ : /demo-site/);
    await shot('04-workspace-ready');
  });

  await check('first run: the rows read like "Created index.html +16", "Analyzed … L1–L12", "Edited … +3 −2"', async () => {
    await send('build me a small landing page');
    if (MODE === 'local') {
      await page.waitForSelector('text=/Waiting for approval to run/', { timeout: 30000 });
      assert.equal((await page.$$('.agent-shimmer')).length, 0, 'queued rows must not shimmer while a command waits for approval');
      await page.click('button:has-text("Always allow")');
    }
    await waitRunEnd();
    await sleep(500);
    await shot('06-run-complete');
    const joined = (await rows()).join('\n');
    console.log('      rows:\n        ' + (await rows()).join('\n        '));
    assert.match(joined, /Created\s+index\.html\s+\+\d+/);
    assert.match(joined, /Created\s+style\.css\s+\+4/);
    assert.match(joined, /Analyzed\s+index\.html\s+L1–L12/);
    assert.match(joined, /Edited\s+style\.css\s+L2, L4–L5\s+\+3\s+−2/);
    assert.match(joined, /Edited\s+index\.html\s+L5\s+\+1\s+−1/);
    assert.match(joined, /Ran\s+\$ node -e/);
    assert.match(joined, /Searched\s+“Hello”\s+·\s+\d+ match/);
    assert.match(joined, /Updated plan/);
    assert.ok(!(await page.$('.agent-shimmer')), 'nothing is shimmering once the run is over');
    assert.match(await page.innerText('[data-testid="agent-run-footer"]'), /Changed 2 files\s+\+\d+\s+−\d+/);
    const metas = await page.$$eval('[data-testid="agent-timeline"] .agent-row span.truncate', (els) => els.filter((e) => e.innerText.trim().startsWith('·')).map((e) => ({ text: e.innerText.trim(), clipped: e.scrollWidth > e.clientWidth + 1 })));
    assert.deepEqual(metas.filter((m) => m.clipped), [], 'no meta span is clipped');
  });

  await check('file rows show the REAL file-type icons (html, css) next to the names', async () => {
    const icons = await page.$$eval('[data-testid="agent-timeline"] .agent-row', (els) => els.map((e) => [e.innerText.replace(/\s+/g, ' ').trim().slice(0, 30), [...e.querySelectorAll('img[data-icon]')].map((i) => i.getAttribute('data-icon'))]));
    const find = (re) => icons.find(([t]) => re.test(t));
    assert.deepEqual(find(/^Created index\.html/)[1], ['html']);
    assert.deepEqual(find(/^Created style\.css/)[1], ['css']);
    assert.deepEqual(find(/^Listed/)[1], ['folder']);
    const ok = await page.$$eval('img[data-icon]', (imgs) => imgs.filter((i) => i.offsetParent !== null).every((i) => i.complete && i.naturalWidth > 0));
    assert.ok(ok, 'every visible icon image actually loaded');
  });

  await check('the shimmer runs while a file is written, and +N counts up as the model writes', async () => {
    await selectModel('fake-slow');
    await send('write the page slowly');
    await page.waitForSelector('.agent-row .agent-shimmer', { timeout: 30000 });
    await sleep(400);
    const live = await page.$eval('.agent-row .agent-shimmer', (el) => el.closest('.agent-row')?.innerText.replace(/\s+/g, ' ').trim());
    assert.match(live, /^Creating\s+index\.html\s*\+?\d*/, live);
    const css = await page.$eval('.agent-row .agent-shimmer', (el) => { const c = getComputedStyle(el); return { anim: c.animationName, clip: c.webkitBackgroundClip || c.backgroundClip }; });
    assert.equal(css.anim, 'agentShimmer');
    assert.equal(css.clip, 'text');
    const counts = [];
    const minus = [];
    let tailSeen = '';
    for (let i = 0; i < 14; i++) {
      const t = await page.$$eval('.agent-row .agent-shimmer', (els) => els.map((e) => e.closest('.agent-row')?.innerText || '').join(' '));
      const m = /\+(\d+)/.exec(t);
      if (m) counts.push(Number(m[1]));
      const r = /[−-](\d+)/.exec(t);
      if (r) minus.push(Number(r[1]));
      tailSeen += (await page.$$eval('[data-testid="live-tail"]', (els) => els.map((e) => e.innerText).join('\n'))) + '\n';
      if (i === 3) await shot('07-creating-shimmer');
      await sleep(120);
    }
    console.log('      live +N while writing:', counts.join(', '), '| live −M:', minus.join(', '));
    assert.ok(new Set(counts).size >= 3, 'the counter visibly counts up through several values');
    assert.deepEqual([...counts].sort((a, b) => a - b), counts, 'and never goes backwards');
    assert.ok(minus.length >= 2, 'overwriting an existing file shows a live "−" as well');
    assert.match(tailSeen, /part/, 'the code being typed streams into a live tail under the row');
    await page.waitForSelector('.agent-row:has-text("Running")', { timeout: 30000 });
    await shot('08-running-command');
    await waitRunEnd(60000).catch(() => {});
    await sleep(800);
  });

  await check('a provider that sends the whole file in ONE chunk (Gemini-style) still gets a smooth count-up, with the shimmer until it lands', async () => {
    await selectModel('fake-burst');
    await send('write a big file in one go');
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const s = await page.evaluate(() => {
        const row = [...document.querySelectorAll('[data-testid="agent-timeline"] .agent-row')].find((r) => /big\.js/.test(r.innerText));
        if (!row) return null;
        const t = row.innerText.replace(/\s+/g, ' ').trim();
        return { t, n: Number((/\+(\d+)/.exec(t) || [])[1] || 0), shimmer: Boolean(row.querySelector('.agent-shimmer')), verb: t.split(' ')[0] };
      });
      if (s) samples.push(s);
      if (s && s.verb === 'Created' && !s.shimmer && s.n === 200) break;
      await sleep(40);
    }
    const nums = samples.map((s) => s.n).filter((n) => n > 0);
    console.log('      count-up samples:', [...new Set(nums)].join(' → '));
    assert.equal(nums.at(-1), 200, 'it lands on the real number');
    assert.ok(new Set(nums).size >= 4, `it rolled through several values instead of jumping (${[...new Set(nums)].join(',')})`);
    assert.deepEqual([...nums].sort((a, b) => a - b), nums, 'monotonic');
    assert.ok(samples.some((s) => s.shimmer && s.n > 0 && s.n < 200 && s.verb === 'Creating'), 'the label keeps shimmering ("Creating") while the number is still rolling');
    const last = samples.at(-1);
    assert.deepEqual([last.verb, last.shimmer], ['Created', false], 'then it settles to "Created" and stops shimmering');
    await shot('07b-burst-settled');
  });

  await check('a server started in the background shows its preview link (and the link really serves the page)', async () => {
    await selectModel('fake-preview');
    await send('serve a page and give me the link');
    const href = await page.waitForSelector('.agent-row a[href^="http"]', { timeout: 90000 }).then((a) => a.getAttribute('href'));
    assert.match(href, MODE === 'sandbox' ? /^https:\/\/3000-[a-z0-9]+\.[a-z0-9-]+\.sandbox\.novita\.ai\/?$/ : /^http:\/\/localhost:3000\/?$/);
    await sleep(1500);
    const joined = (await rows()).join('\n');
    assert.match(joined, /Started\s+\$ python3 -m http\.server 3000[^\n]*bg-1/);
    assert.match(joined, /Preview ready on port\s+3000/);
    assert.match(await (await fetch(href)).text(), /PREVIEW OK/);
    await shot('08b-preview');
  });

  await check('a project with many file types: every file gets its own icon, and folders look like css / js / src folders', async () => {
    await selectModel('fake-project');
    await send('set up a project');
    await waitRunEnd();
    await sleep(600);
    const want = { 'index.html': 'html', 'css/style.css': 'css', 'js/app.js': 'javascript', 'src/components/Button.tsx': 'react_ts', 'src/utils/helpers.ts': 'typescript', 'images/logo.svg': 'svg', 'package.json': 'nodejs', 'README.md': 'readme', '.gitignore': 'git', 'data/items.json': 'json', 'server/app.py': 'python', 'tests/app.test.js': 'test-js', Dockerfile: 'docker', 'scripts/build.sh': 'console' };
    const got = await page.$$eval('[data-testid="agent-timeline"] .agent-row', (els) => els.map((e) => ({ text: e.innerText.replace(/\s+/g, ' ').trim(), icon: e.querySelector('img[data-icon]')?.getAttribute('data-icon') })));
    for (const [file, icon] of Object.entries(want)) {
      const row = got.find((r) => r.text.startsWith('Created') && r.text.includes(file));
      assert.ok(row, `row for ${file}`);
      assert.equal(row.icon, icon, `${file} -> ${row.icon}`);
    }
    await shot('09a-project-rows');
  });

  await check('Files panel: folders get their own icons (css, js, src, images…), open variants when expanded, and files open with line numbers', async () => {
    await page.click('[data-testid="agent-controls"] button:has-text("Files")');
    await page.waitForSelector('[data-testid="workspace-panel"]', { timeout: 8000 });
    await page.waitForSelector('[data-testid="file-tree"] button:has-text("package.json")');
    const dirIcons = () => page.$$eval('[data-testid="file-tree"] button', (bs) => Object.fromEntries(bs.map((b) => [b.innerText.replace(/\s+/g, ' ').trim().replace(/ [\d.]+ (B|KB)$/, ''), b.querySelector('img[data-icon]')?.getAttribute('data-icon')])));
    const closed = await dirIcons();
    for (const [dir, icon] of Object.entries({ css: 'folder-css', js: 'folder-javascript', src: 'folder-src', images: 'folder-images', tests: 'folder-test', server: 'folder-server', scripts: 'folder-scripts', data: 'folder-database' })) {
      assert.equal(closed[dir], icon, `${dir} -> ${closed[dir]}`);
    }
    assert.equal(closed['package.json'], 'nodejs');
    assert.equal(closed['README.md'], 'readme');
    await page.click('[data-testid="file-tree"] button:has-text("css")');
    await page.click('[data-testid="file-tree"] button:has-text("src")');
    await page.waitForSelector('[data-testid="file-tree"] button:has-text("components")');
    await page.click('[data-testid="file-tree"] button:has-text("components")');
    await page.waitForSelector('[data-testid="file-tree"] button:has-text("Button.tsx")');
    const open = await dirIcons();
    assert.equal(open.css, 'folder-css-open');
    assert.equal(open.src, 'folder-src-open');
    assert.equal(open.components, 'folder-components-open');
    assert.equal(open['Button.tsx'], 'react_ts');
    assert.equal(open['style.css'], 'css');
    await shot('09-files-panel-icons');
    await page.click('[data-testid="file-tree"] button:has-text("style.css")');
    await page.waitForSelector('[data-testid="file-viewer"]');
    assert.match(await page.innerText('[data-testid="file-viewer"]'), /1\s+body \{ margin: 0; \}/);
    await shot('09b-file-viewer');
    await page.click('button[title="Back to files"]');
  });

  await check('after a reload the whole timeline is still there, settled (no spinners), icons included', async () => {
    await sleep(400);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="agent-timeline"]');
    await sleep(900);
    const r = await rows();
    assert.ok(r.length >= 9, `rows after reload: ${r.length}`);
    assert.ok(!(await page.$('.agent-shimmer')), 'nothing shimmers after reload');
    assert.ok((await page.$$('[data-testid="agent-timeline"] img[data-icon="html"]')).length >= 1, 'icons are back');
    await shot('10-after-reload');
  });

  await check('dark theme keeps rows and icons readable', async () => {
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await sleep(300);
    await shot('11-dark');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
  });

  await check('mobile width: the timeline and controls still fit', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `page scrolls sideways by ${overflow}px`);
    await shot('14-mobile');
    await page.setViewportSize({ width: 1280, height: 860 });
    await sleep(300);
  });

  await check('Stop mid-run settles the running action as "Stopped"', async () => {
    await selectModel('fake-slow');
    await send('again, slowly');
    await page.waitForSelector('.agent-row .agent-shimmer', { timeout: 30000 });
    await page.waitForSelector('.agent-row:has-text("Running")', { timeout: 30000 });
    await page.click('button[aria-label="Stop generation"]');
    await sleep(1500);
    const r = await rows();
    assert.ok(r.some((t) => /^Stopped\s+\$ echo step-1/.test(t)), r.slice(-3).join(' | '));
    assert.ok(!(await page.$('.agent-shimmer')));
    await shot('12-stopped');
  });

  console.log('\n  page problems:', problems.length ? '\n    ' + problems.join('\n    ') : 'none');
} finally {
  try {
    const list = await (await fetch(`${BASE}/api/agent/workspaces`, { headers: { 'x-danav-agent': '1' } })).json();
    for (const w of list.workspaces || []) {
      await fetch(`${BASE}/api/agent/workspaces/${w.id}`, { method: 'DELETE', headers: { 'x-danav-agent': '1' } });
      console.log(`  cleanup: deleted workspace ${w.name} (${w.kind})`);
    }
  } catch (e) { console.log('  cleanup failed:', e.message); }
  await browser.close();
  backend.kill('SIGTERM');
  await llm.close();
  fs.writeFileSync('/tmp/e2e/backend.log', backendLog);
}
const failed = results.filter((r) => r.startsWith('✗'));
console.log(`\n${results.length - failed.length}/${results.length} E2E checks passed${problems.length ? `, ${problems.length} page problem(s)` : ''}`);
process.exit(failed.length || problems.length ? 1 : 0);
