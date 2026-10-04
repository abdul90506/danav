/**
 * Real Novita sandbox: runs only with `--sandbox` and NOVITA_API_KEY set.
 *   node --env-file=.env scripts/test-agent.js --sandbox
 * Creates ONE sandbox, exercises every capability against it, then kills it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeLlm, HTML } from '../fake-llm.js';
import { runAgent } from '../../server/agent/loop.js';
import { buildToolset } from '../../server/agent/tools.js';
import { SandboxWorkspace, loadNovitaSdk } from '../../server/agent/workspaces/sandbox.js';
import { createWorkspace, deleteWorkspace, openWorkspace, _instances } from '../../server/agent/workspaces/index.js';
import { getWorkspaceRecord, _resetStoreCache } from '../../server/agent/store.js';
import { createRedactor, genId } from '../../server/agent/util.js';
import { getNovitaKey } from '../../server/agent/config.js';

const { test, args } = globalThis.__agentTest;

if (args.includes('--sandbox')) {
  console.log('\n[novita sandbox — REAL]');

  const key = getNovitaKey();
  if (!key) {
    test('sandbox: NOVITA_API_KEY is configured', () => assert.fail('set NOVITA_API_KEY (e.g. node --env-file=.env …)'));
  } else {
    let ws;
    let tools;
    let ctx;
    let llm;
    let sandboxId;
    let originalDataDir;
    const run = (name, a) => tools.execute(name, a, ctx);

    test('sandbox: create a workspace (a real sandbox boots)', async () => {
      process.env.NOVITA_API_KEY = key; // earlier sections may have touched the variable
      originalDataDir = process.env.DANAV_DATA_DIR;
      process.env.DANAV_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-sbxdata-'));
      _resetStoreCache();
      const t0 = Date.now();
      ws = await createWorkspace({ name: 'IT Test', kind: 'sandbox' });
      sandboxId = ws.record.sandboxId;
      assert.ok(sandboxId, 'sandbox id is recorded');
      assert.equal(ws.root, '/home/user/it-test');
      assert.equal(ws.autoRun, true);
      assert.equal(getWorkspaceRecord(ws.id).sandboxId, sandboxId, 'the id is persisted');
      console.log(`      (sandbox ${sandboxId} ready in ${Date.now() - t0}ms)`);
      tools = buildToolset({ workspace: ws, runSearchTool: async () => ({ success: false }), redact: createRedactor() });
      ctx = { signal: undefined, emit: () => {}, approve: async () => true, state: { readFiles: new Set(), plan: [], changed: new Map() } };
      llm = await startFakeLlm();
    });

    test('sandbox: write, read ranges, edit, multi_edit — with the same numbers as local', async () => {
      const w = await run('write_file', { path: 'app/index.html', content: HTML });
      assert.equal(w.ok, true, w.output);
      assert.equal(w.ui.created, true);
      assert.equal(w.ui.added, HTML.split('\n').length - 1);
      const r = await run('read_file', { path: 'app/index.html', start_line: 3, end_line: 6 });
      assert.deepEqual([r.ui.startLine, r.ui.endLine], [3, 6]);
      assert.match(r.output, /\n\s+3\t<head>\n\s+4\t\s*<meta charset/);
      const e = await run('edit_file', { path: 'app/index.html', old_string: '<title>Hello</title>', new_string: '<title>Sandboxed</title>' });
      assert.equal(e.ok, true, e.output);
      assert.deepEqual(e.ui.ranges, [[5, 5]]);
      assert.equal(e.ui.added, 1);
      const bad = await run('edit_file', { path: 'app/index.html', old_string: 'nope nope', new_string: 'x' });
      assert.equal(bad.ok, false);
      const m = await run('multi_edit', { path: 'app/index.html', edits: [{ old_string: 'Hello, world', new_string: 'Hi' }, { old_string: 'Click me', new_string: 'Press' }] });
      assert.equal(m.ok, true, m.output);
      assert.equal((await ws.readText(ws.resolve('app/index.html'))).text.includes('Press'), true);
    });

    test('sandbox: list_dir, grep_search (PCRE, glob), file_search, binary files', async () => {
      await run('write_file', { path: 'app/src/util.js', content: 'export const answer = 42;\nexport function Hello() {}\n' });
      await run('write_file', { path: 'node_modules/pkg/index.js', content: 'const answer = 1;\n' });
      const ls = await run('list_dir', { path: 'app', depth: 2 });
      assert.match(ls.output, /src\/\n/);
      assert.match(ls.output, /src\/util\.js/);
      const g = await run('grep_search', { pattern: 'answer\\s*=\\s*\\d+' });
      assert.match(g.output, /app\/src\/util\.js:1:/);
      assert.ok(!g.output.includes('node_modules'), 'ignored dirs are skipped');
      const gi = await run('grep_search', { pattern: 'hello', case_insensitive: true, glob: '*.js' });
      assert.match(gi.output, /util\.js:2:/);
      assert.ok(!gi.output.includes('index.html'));
      const one = await run('grep_search', { pattern: 'answer', path: 'app/src/util.js' });
      assert.match(one.output, /app\/src\/util\.js:1:/);
      // An unclosed group is not a regex: it is searched literally, and the result
      // says so rather than reporting the pattern as simply absent.
      const badRe = await run('grep_search', { pattern: '(unclosed' });
      assert.equal(badRe.ok, true);
      assert.match(badRe.output, /not a valid regular expression/);
      assert.match(badRe.output, /literal/);
      // A path with a typo is answered with the names that exist, in the cloud too.
      const typo = await run('read_file', { path: 'app/src/utilz.js' });
      assert.equal(typo.ok, false);
      assert.match(typo.output, /Did you mean "app\/src\/util\.js"\?/);
      const f = await run('file_search', { pattern: '*.js' });
      assert.match(f.output, /app\/src\/util\.js/);
      assert.ok(!f.output.includes('node_modules'));
      await ws.execRaw('printf "\\x00\\x01\\x02" > /home/user/it-test/blob.bin');
      const bin = await run('read_file', { path: 'blob.bin' });
      assert.equal(bin.ok, false);
      assert.match(bin.output, /binary file/);
    });

    test('sandbox: delete, move, mkdir', async () => {
      // No create_dir tool: the parents come from writing the file.
      assert.equal((await run('write_file', { path: 'tmpdir/a/b/f.txt', content: 'x\n' })).ok, true);
      assert.equal((await ws.stat(ws.resolve('tmpdir/a/b'))).type, 'dir');
      assert.equal((await run('delete_file', { path: 'tmpdir' })).ok, false, 'needs recursive');
      assert.equal((await run('move_file', { from: 'tmpdir/a/b/f.txt', to: 'moved/f.txt' })).ok, true);
      assert.equal((await ws.stat(ws.resolve('moved/f.txt'))).type, 'file');
      assert.equal((await run('delete_file', { path: 'tmpdir', recursive: true })).ok, true);
      assert.equal((await ws.stat(ws.resolve('tmpdir'))).type, null);
      assert.match((await run('delete_file', { path: '.' })).output, /workspace root/);
    });

    test('sandbox: run_command — output, exit codes, cwd, env, no leaked app secrets', async () => {
      const ok = await run('run_command', { command: 'echo hello; node -v; python3 --version' });
      assert.equal(ok.ok, true, ok.output);
      assert.match(ok.output, /hello\nv\d+\./);
      assert.match(ok.output, /Python 3/);
      const bad = await run('run_command', { command: 'echo oops 1>&2; exit 3' });
      assert.equal(bad.ok, false);
      assert.match(bad.output, /oops[\s\S]*\[exit code 3\]/);
      const cwd = await run('run_command', { command: 'pwd', cwd: 'app' });
      assert.match(cwd.output, /\/home\/user\/it-test\/app/);
      const env = await run('run_command', { command: 'echo "ci=$CI key=[$NOVITA_API_KEY] home=$HOME"' });
      assert.match(env.output, /ci=1 key=\[\]/);
      // a command that prints the real key (e.g. through a file) is redacted on the way out
      await ws.writeText(ws.resolve('leak.txt'), `token=${getNovitaKey()}\n`);
      const leak = await run('run_command', { command: 'cat leak.txt' });
      assert.ok(!leak.output.includes(getNovitaKey()));
      assert.match(leak.output, /\[REDACTED\]/);
    });

    test('sandbox: a timeout kills the command AND its children', async () => {
      const t0 = Date.now();
      const r = await run('run_command', { command: 'sh -c "sleep 300 & echo started; wait"', timeout_seconds: 2 });
      assert.equal(r.ui.timedOut, true, r.output);
      assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0}ms`);
      await new Promise((res) => setTimeout(res, 1500));
      const left = await ws.execRaw('pgrep -f "[s]leep 300" | wc -l');
      assert.equal(left.stdout.trim(), '0', 'no orphaned sleep left behind');
    });

    test('sandbox: stopping a run kills what it was running', async () => {
      const ac = new AbortController();
      const localCtx = { ...ctx, signal: ac.signal };
      setTimeout(() => ac.abort(), 1500);
      const t0 = Date.now();
      const r = await tools.execute('run_command', { command: 'sh -c "sleep 301 & wait"', timeout_seconds: 120 }, localCtx);
      assert.equal(r.ui.aborted, true, r.output);
      assert.ok(Date.now() - t0 < 20000);
      await new Promise((res) => setTimeout(res, 1500));
      const left = await ws.execRaw('pgrep -f "[s]leep 301" | wc -l');
      assert.equal(left.stdout.trim(), '0', 'aborted run left nothing behind');
    });

    test('sandbox: a long-running server survives, has a public preview URL, and can be stopped', async () => {
      await run('write_file', { path: 'site/index.html', content: '<h1>SANDBOX PREVIEW OK</h1>\n' });
      const dev = await run('run_command', { command: 'python3 -m http.server 3000 --bind 0.0.0.0', cwd: 'site' });
      assert.equal(dev.ok, false, 'foreground servers are refused');
      assert.match(dev.output, /background=true/);

      const bg = await run('run_command', { command: 'python3 -m http.server 3000 --bind 0.0.0.0', cwd: 'site', background: true });
      assert.equal(bg.ok, true, bg.output);
      const id = bg.ui.id;
      assert.match(id, /^bg-\d+$/);

      const preview = await run('get_preview_url', { port: 3000 });
      assert.equal(preview.ok, true, preview.output);
      assert.match(preview.ui.url, /^https:\/\/3000-.+\.sandbox\.novita\.ai$/);
      assert.equal(preview.ui.status, 200);
      const page = await fetch(preview.ui.url);
      assert.match(await page.text(), /SANDBOX PREVIEW OK/);

      const logs = await run('read_process_output', { id });
      assert.match(logs.output, /^RUNNING/);

      // a brand-new server-side instance (as after a restart) still knows the process
      const fresh = new SandboxWorkspace(getWorkspaceRecord(ws.id));
      const again = await fresh.readBackground(id);
      assert.equal(again.running, true);

      assert.equal((await run('stop_process', { id })).ok, true);
      await new Promise((res) => setTimeout(res, 1200));
      assert.equal(await ws.isPortOpen(3000), false);
      assert.equal((await run('get_preview_url', { port: 3000 })).ok, false);
      assert.equal((await run('read_process_output', { id })).ui.running, false);
    });

    test('sandbox: the full agent loop works end to end in the cloud', async () => {
      const events = [];
      llm.requests.length = 0;
      const result = await runAgent({
        provider: { baseUrl: llm.baseUrl, apiKey: 'k1234567890' },
        model: 'fake-build',
        history: [{ role: 'user', content: 'build me a page' }],
        workspace: ws,
        runSearchTool: async () => ({ success: false }),
        send: (e) => events.push(e),
        signal: new AbortController().signal,
        runId: genId('run'),
      });
      assert.equal(result.stopReason, 'completed');
      const ends = events.filter((e) => e.agent?.type === 'action_end').map((e) => e.agent);
      assert.equal(ends.length, 9);
      assert.ok(ends.every((a) => a.status === 'done'), JSON.stringify(ends.filter((a) => a.status !== 'done').map((a) => [a.result?.kind, a.error])));
      assert.match((await ws.readText(ws.resolve('style.css'))).text, /#0a58ca/);
      assert.match(llm.requests[0].messages[0].content, /Cloud sandbox: Debian 12/);
      assert.match(llm.requests[0].messages[0].content, /Root: \/home\/user\/it-test/);
    });

    test('sandbox: reconnect to the same sandbox (files survive a server restart)', async () => {
      _instances.delete(ws.id); // as if the Danav server had been restarted
      const reopened = await openWorkspace(ws.id);
      await reopened.init();
      assert.equal(reopened.record.sandboxId, sandboxId, 'same sandbox, not a new one');
      assert.match((await reopened.readText(reopened.resolve('app/index.html'))).text, /Sandboxed/);
    });

    // Runs no matter what happened above: a failed assertion must never leave a sandbox billing.
    test('sandbox: cleanup — the sandbox is killed and really gone from the account', async () => {
      try { await llm?.close(); } catch { /* already closed */ }
      const { Sandbox } = await loadNovitaSdk();
      try {
        if (ws && getWorkspaceRecord(ws.id)) await deleteWorkspace(ws.id);
        else if (sandboxId) await (await Sandbox.connect(sandboxId, { apiKey: key })).kill();
      } finally {
        if (originalDataDir === undefined) delete process.env.DANAV_DATA_DIR;
        else process.env.DANAV_DATA_DIR = originalDataDir;
        _resetStoreCache();
      }
      if (!sandboxId) return;
      let left = [];
      for (let i = 0; i < 10; i++) {
        left = (await Sandbox.list({ apiKey: key, query: { state: ['running', 'paused'], metadata: { workspace: ws.id } } }).nextItems());
        if (left.length === 0) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert.equal(left.length, 0, 'no sandbox left running (no billing)');
    });
  }
}
