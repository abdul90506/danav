/** LocalWorkspace: confinement, files, commands, background processes, search. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { LocalWorkspace } from '../../server/agent/workspaces/local.js';
import { createWorkspace, deleteWorkspace } from '../../server/agent/workspaces/index.js';
import { addNote, readNotes } from '../../server/agent/memory.js';
import { readRunJournal, recordRun } from '../../server/agent/journal.js';
import { dataDir } from '../../server/agent/config.js';

const { test } = globalThis.__agentTest;
const isWin = process.platform === 'win32';

console.log('\n[local workspace]');

async function makeWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-ws-'));
  const ws = new LocalWorkspace({ id: 'ws-test', kind: 'local', name: 'test', root: dir });
  await ws.init();
  return { ws, dir };
}

test('resolve keeps paths inside the root and rejects escapes', async () => {
  const { ws, dir } = await makeWs();
  assert.equal(ws.resolve('a/b.txt'), path.join(dir, 'a', 'b.txt'));
  assert.equal(ws.resolve('.'), dir);
  assert.throws(() => ws.resolve('../etc/passwd'), /outside the workspace/);
  assert.throws(() => ws.resolve('a/../../x'), /outside the workspace/);
  assert.throws(() => ws.resolve(path.resolve(dir, '..', 'sibling')), /outside the workspace/);
  assert.equal(ws.resolve(path.join(dir, 'ok.txt')), path.join(dir, 'ok.txt')); // absolute but inside
});

test('credential folders are blocked even inside the root', async () => {
  const { ws } = await makeWs();
  assert.throws(() => ws.resolve('.ssh/id_rsa'), /blocked/);
  assert.throws(() => ws.resolve('nested/.aws/credentials'), /blocked/);
});

test('a symlink cannot be used to escape the workspace', async () => {
  if (isWin) return;
  const { ws, dir } = await makeWs();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(outside, path.join(dir, 'link'));
  await assert.rejects(() => ws.safePath('link/secret.txt'), /outside the workspace through a symlink/);
  await assert.rejects(() => ws.safePath('link/new-file.txt'), /outside the workspace through a symlink/);
  await ws.safePath('regular/new-file.txt'); // a normal new path is fine
});

test('write, read, binary detection and size limits', async () => {
  const { ws } = await makeWs();
  const f = ws.resolve('src/deep/hello.txt');
  await ws.writeText(f, 'hello\nworld\n');
  assert.deepEqual(await ws.readText(f), { text: 'hello\nworld\n', size: 12, binary: false });
  fs.writeFileSync(ws.resolve('bin.dat'), Buffer.from([1, 2, 0, 3]));
  assert.equal((await ws.readText(ws.resolve('bin.dat'))).binary, true);
  await assert.rejects(() => ws.readText(ws.resolve('nope.txt')), /File not found/);
  await assert.rejects(() => ws.readText(ws.resolve('src')), /is a directory/);
  await assert.rejects(() => ws.readText(f, { maxBytes: 4 }), /too large/);
});

test('listTree: depth, ignored dirs are listed but not entered, dirs sort first', async () => {
  const { ws, dir } = await makeWs();
  fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/pkg/index.js'), 'x');
  fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/lib/a.js'), 'a');
  fs.writeFileSync(path.join(dir, 'src/main.js'), 'm');
  fs.writeFileSync(path.join(dir, 'README.md'), 'r');
  const shallow = await ws.listTree(dir, { depth: 1 });
  assert.deepEqual(shallow.entries.map((e) => `${e.type}:${e.path}`), ['dir:node_modules', 'dir:src', 'file:README.md']);
  const deep = await ws.listTree(dir, { depth: 3 });
  const paths = deep.entries.map((e) => e.path);
  assert.ok(paths.includes('src/lib/a.js'));
  assert.ok(!paths.some((p) => p.startsWith('node_modules/')), 'must not descend into node_modules');
  const capped = await ws.listTree(dir, { depth: 3, maxEntries: 2 });
  assert.equal(capped.truncated, true);
});

test('remove: non-empty dirs need recursive; the root is protected', async () => {
  const { ws, dir } = await makeWs();
  await ws.writeText(ws.resolve('d/f.txt'), 'x');
  await assert.rejects(() => ws.remove(ws.resolve('d')), /non-empty directory/);
  await ws.remove(ws.resolve('d'), { recursive: true });
  assert.equal((await ws.stat(ws.resolve('d'))).type, null);
  await assert.rejects(() => ws.remove(dir, { recursive: true }), /workspace root/);
  await assert.rejects(() => ws.remove(ws.resolve('ghost.txt')), /Not found/);
});

test('move: renames, creates parents, refuses to overwrite', async () => {
  const { ws } = await makeWs();
  await ws.writeText(ws.resolve('a.txt'), 'A');
  await ws.writeText(ws.resolve('b.txt'), 'B');
  await ws.move(ws.resolve('a.txt'), ws.resolve('new/dir/a.txt'));
  assert.equal((await ws.readText(ws.resolve('new/dir/a.txt'))).text, 'A');
  await assert.rejects(() => ws.move(ws.resolve('b.txt'), ws.resolve('new/dir/a.txt')), /already exists/);
});

test('exec: output (stdout+stderr), exit code, duration', async () => {
  if (isWin) return;
  const { ws } = await makeWs();
  const r = await ws.exec('echo out; echo err 1>&2; exit 3');
  assert.equal(r.exitCode, 3);
  assert.match(r.output, /out/);
  assert.match(r.output, /err/);
  assert.equal(r.timedOut, false);
  const streamed = [];
  const ok = await ws.exec('echo one; sleep 0.2; echo two', { onData: (c) => streamed.push(c) });
  assert.equal(ok.exitCode, 0);
  assert.ok(streamed.join('').includes('one') && streamed.join('').includes('two'));
});

test('exec: runs inside the workspace and strips ANSI/progress noise', async () => {
  if (isWin) return;
  const { ws, dir } = await makeWs();
  const r = await ws.exec('pwd; printf "\\033[31mred\\033[0m\\nprogress 10%%\\rprogress 100%%\\n"');
  assert.ok(r.output.includes(fs.realpathSync(dir)) || r.output.includes(dir));
  assert.ok(r.output.includes('red') && !r.output.includes('\u001b'));
  assert.ok(r.output.includes('progress 100%') && !r.output.includes('progress 10%\r'));
});

test('exec: a timeout kills the command and its children', async () => {
  if (isWin) return;
  const { ws, dir } = await makeWs();
  const pidFile = path.join(dir, 'child.pid');
  const t0 = Date.now();
  const r = await ws.exec(`sh -c 'sleep 30 & echo $! > "${pidFile}"; wait'`, { timeoutMs: 600 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 6000, 'should return promptly after the timeout');
  const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  await new Promise((res) => setTimeout(res, 1800)); // SIGTERM → SIGKILL escalation window
  assert.throws(() => process.kill(childPid, 0), /ESRCH/, 'grandchild must be dead');
});

test('exec: abort signal stops a running command', async () => {
  if (isWin) return;
  const { ws } = await makeWs();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  const r = await ws.exec('sleep 30', { signal: ac.signal, timeoutMs: 60_000 });
  assert.equal(r.aborted, true);
  assert.ok(Date.now() - t0 < 5000);
});

test('exec: the app\'s own secrets never reach a command', async () => {
  if (isWin) return;
  const { ws } = await makeWs();
  const prev = { key: process.env.NOVITA_API_KEY, hosts: process.env.DANAV_ALLOWED_HOSTS };
  process.env.NOVITA_API_KEY = 'sk_test_secret_value_123456';
  process.env.DANAV_ALLOWED_HOSTS = 'x.example';
  try {
    const r = await ws.exec('echo "key=[${NOVITA_API_KEY}] danav=[${DANAV_ALLOWED_HOSTS}] ci=[${CI}]"');
    assert.match(r.output, /key=\[\] danav=\[\] ci=\[1\]/);
  } finally {
    // put back whatever was there (a real key may have been loaded from .env)
    if (prev.key === undefined) delete process.env.NOVITA_API_KEY; else process.env.NOVITA_API_KEY = prev.key;
    if (prev.hosts === undefined) delete process.env.DANAV_ALLOWED_HOSTS; else process.env.DANAV_ALLOWED_HOSTS = prev.hosts;
  }
});

test('exec: a command that leaves a background process behind does not hang', async () => {
  if (isWin) return;
  const { ws } = await makeWs();
  const t0 = Date.now();
  const r = await ws.exec('sleep 20 & echo started', { timeoutMs: 30_000 });
  assert.match(r.output, /started/);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
  await ws.dispose();
});

test('background process: start, port probe, logs, stop', async () => {
  if (isWin) return;
  const { ws } = await makeWs();
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r)); // free port for the child to take

  const script = `require('http').createServer((q,s)=>s.end('hi')).listen(${port},()=>console.log('listening on ${port}'))`;
  const started = await ws.startBackground(`node -e "${script}"`, { waitMs: 1500 });
  assert.equal(started.exited, false);
  assert.match(started.output, /listening on/);
  assert.equal(await ws.isPortOpen(port), true);

  const logs = await ws.readBackground(started.id, { tail: 5 });
  assert.equal(logs.running, true);
  assert.match(logs.output, /listening on/);
  assert.equal(ws.listBackground().length, 1);

  await ws.stopBackground(started.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await ws.isPortOpen(port), false);
  await assert.rejects(() => ws.readBackground('bg-nope'), /No background process/);
  await ws.dispose();
});

test('grep: line numbers, glob filter, ignored dirs, case-insensitive, bad regex', async () => {
  const { ws, dir } = await makeWs();
  await ws.writeText(ws.resolve('src/a.js'), 'const Alpha = 1;\nfunction beta() {}\n');
  await ws.writeText(ws.resolve('src/b.css'), '.alpha { color: red }\n');
  await ws.writeText(ws.resolve('node_modules/x/c.js'), 'const alpha = 2;\n');
  const all = await ws.grep({ pattern: 'alpha', path: dir, ignoreCase: true });
  assert.deepEqual(all.matches.map((m) => `${m.path}:${m.line}`).sort(), ['src/a.js:1', 'src/b.css:1']);
  const js = await ws.grep({ pattern: 'alpha', path: dir, ignoreCase: true, glob: '*.js' });
  assert.deepEqual(js.matches.map((m) => m.path), ['src/a.js']);
  const exact = await ws.grep({ pattern: 'alpha', path: dir });
  assert.deepEqual(exact.matches.map((m) => m.path), ['src/b.css']); // case-sensitive: "Alpha" excluded
  const bad = await ws.grep({ pattern: 'foo(', path: dir }); // invalid regex falls back to a literal search
  assert.equal(bad.matches.length, 0);
  const limited = await ws.grep({ pattern: '.', path: dir, maxResults: 1 });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.truncated, true);
});

test('findFiles: glob and substring, ignoring node_modules', async () => {
  const { ws, dir } = await makeWs();
  await ws.writeText(ws.resolve('src/App.tsx'), 'x');
  await ws.writeText(ws.resolve('src/utils/app.test.ts'), 'x');
  await ws.writeText(ws.resolve('node_modules/p/App.tsx'), 'x');
  assert.deepEqual((await ws.findFiles({ pattern: '*.tsx', path: dir })).files, ['src/App.tsx']);
  assert.deepEqual((await ws.findFiles({ pattern: 'app', path: dir })).files.sort(), ['src/App.tsx', 'src/utils/app.test.ts']);
  assert.deepEqual((await ws.findFiles({ pattern: 'src/**/*.ts', path: dir })).files, ['src/utils/app.test.ts']);
});

test('workspace deletion clears its notes, task journal, and cached code index', async () => {
  const previousDir = process.env.DANAV_WORKSPACES_DIR;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-workspace-cleanup-'));
  process.env.DANAV_WORKSPACES_DIR = base;
  let workspace;
  try {
    workspace = await createWorkspace({ name: 'cleanup', kind: 'local', path: path.join(base, 'project'), autoRun: true });
    addNote(workspace.id, 'A temporary workspace note.');
    recordRun(workspace.id, { stopReason: 'step_limit', plan: [{ content: 'Finish task', status: 'in_progress' }] });
    const indexDir = path.join(dataDir(), 'code-index');
    fs.mkdirSync(indexDir, { recursive: true });
    const indexFile = path.join(indexDir, `${workspace.id}.json`);
    fs.writeFileSync(indexFile, '{"workspaceId":"cleanup"}');

    await deleteWorkspace(workspace.id);
    assert.deepEqual(readNotes(workspace.id), []);
    assert.deepEqual(readRunJournal(workspace.id), []);
    assert.equal(fs.existsSync(indexFile), false);
  } finally {
    if (previousDir === undefined) delete process.env.DANAV_WORKSPACES_DIR;
    else process.env.DANAV_WORKSPACES_DIR = previousDir;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a path carrying a NUL is refused, not quietly rewritten into another path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-nul-'));
  try {
    const ws = new LocalWorkspace({ id: 'ws-nul', kind: 'local', name: 'n', root: dir, autoRun: true });
    await ws.init();
    // Stripping the NUL turned a request for "a\0b.txt" into "ab.txt" and reported
    // success under the rewritten name: a different file from the one asked for.
    assert.throws(() => ws.resolve('a\u0000b.txt'), /NUL character/);
    await assert.rejects(() => ws.safePath('secret\u0000.png'), /NUL character/);
    assert.equal(fs.existsSync(path.join(dir, 'ab.txt')), false, 'nothing was created under a rewritten name');
    // Ordinary paths are unaffected.
    assert.equal(ws.resolve('a/b.txt'), path.join(dir, 'a', 'b.txt'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
