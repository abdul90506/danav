/** The agent's tools on a local workspace: results, UI summaries, safety rails. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { LocalWorkspace } from '../../server/agent/workspaces/local.js';
import { assertPublicUrl, buildToolset, displayArgs, isPrivateAddress, peekPartialArgs, portsInCommand, READ_ONLY_TOOLS, resolveSafeUrl, TOOL_DEFINITIONS } from '../../server/agent/tools.js';
import { createRedactor } from '../../server/agent/util.js';
import { repairJsonText } from '../../server/agent/partial.js';

const { test } = globalThis.__agentTest;
const isWin = process.platform === 'win32';

console.log('\n[tools]');

async function setup({ autoRun = true, search, probe, runSubagent } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-tools-'));
  const ws = new LocalWorkspace({ id: 'ws-t', kind: 'local', name: 't', root: dir, autoRun });
  await ws.init();
  const tools = buildToolset({
    workspace: ws,
    runSearchTool: search || (async () => ({ success: false, error: 'offline' })),
    runSubagent,
    redact: createRedactor(),
    lookup: async () => [{ address: '93.184.216.34' }], // tests never touch real DNS
    probe: probe || (async () => ({ status: 200, headers: new Headers(), body: null })), // ...or the real network
  });
  const events = [];
  const ctx = {
    signal: undefined,
    emit: (p) => events.push(p),
    approve: async () => true,
    state: { readFiles: new Set(), plan: [], changed: new Map() },
  };
  const run = (name, args, c = ctx) => tools.execute(name, args, c);
  return { ws, dir, tools, ctx, events, run };
}

test('every tool has a schema and an implementation', async () => {
  const { tools } = await setup();
  const names = TOOL_DEFINITIONS.map((d) => d.function.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const n of names) assert.ok(tools.has(n), `missing implementation for ${n}`);
  for (const d of TOOL_DEFINITIONS) assert.equal(d.function.parameters.type, 'object');
});

test('memory tools save structured notes, search relevant history, and reject known secrets', async () => {
  const previousDir = process.env.DANAV_DATA_DIR;
  const previousKey = process.env.NOVITA_API_KEY;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-memory-tools-'));
  process.env.DANAV_DATA_DIR = data;
  process.env.NOVITA_API_KEY = 'test_memory_secret_token_123456789012345';
  try {
    const { tools, run } = await setup();
    assert.ok(tools.definitions.some((d) => d.function.name === 'search_memory'));
    assert.ok(READ_ONLY_TOOLS.has('search_memory'));
    const saved = await run('remember', {
      note: 'Run the focused suite with npm run test:agent',
      category: 'workflow', importance: 4, tags: ['tests'],
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.ui.category, 'workflow');
    const found = await run('search_memory', { query: 'npm test agent' });
    assert.equal(found.ok, true);
    assert.equal(found.ui.count, 1);
    assert.match(found.output, /npm run test:agent/);

    const rejected = await run('remember', { note: `NOVITA_API_KEY=${process.env.NOVITA_API_KEY}` });
    assert.equal(rejected.ok, false);
    assert.match(rejected.output, /will not save/);
    assert.doesNotMatch(rejected.output, /test_memory_secret_token/);
  } finally {
    if (previousDir === undefined) delete process.env.DANAV_DATA_DIR;
    else process.env.DANAV_DATA_DIR = previousDir;
    if (previousKey === undefined) delete process.env.NOVITA_API_KEY;
    else process.env.NOVITA_API_KEY = previousKey;
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('delegate_task runs a bounded read-only second opinion and excludes secret files', async () => {
  let received;
  const { run, dir, ctx, tools } = await setup({
    runSubagent: async (input) => {
      received = input;
      return 'The handler misses an empty-input guard; add a regression test.';
    },
  });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'handler.ts'), 'export function handler(value: string) { return value.trim(); }\n');
  fs.writeFileSync(path.join(dir, '.env'), 'DO_NOT_SEND=this-is-a-test-secret\n');

  assert.ok(READ_ONLY_TOOLS.has('delegate_task'));
  assert.ok(tools.definitions.some((d) => d.function.name === 'delegate_task'));
  const r = await run('delegate_task', { task: 'Review the handler for likely edge cases.', paths: ['src/handler.ts', '.env'] });
  assert.equal(r.ok, true);
  assert.match(r.output, /empty-input guard/);
  assert.match(r.output, /sensitive path excluded/);
  assert.deepEqual(received.files.map((f) => f.path), ['src/handler.ts']);
  assert.match(received.files[0].content, /value\.trim/);
  assert.doesNotMatch(JSON.stringify(received), /DO_NOT_SEND|this-is-a-test-secret/);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'handler.ts'), 'utf8'), 'export function handler(value: string) { return value.trim(); }\n');
  assert.equal(ctx.state.subagentCalls, 1);

  await run('delegate_task', { task: 'Review one more independent part.', paths: ['src/handler.ts'] });
  const overLimit = await run('delegate_task', { task: 'Review a third task.', paths: ['src/handler.ts'] });
  assert.equal(overLimit.ok, false);
  assert.match(overLimit.output, /limit of two delegated reviews/);
});

test('write_file creates a file and reports +lines', async () => {
  const { run, dir, ctx } = await setup();
  const r = await run('write_file', { path: 'src/index.html', content: '<h1>Hi</h1>\n<p>x</p>\n<p>y</p>\n' });
  assert.equal(r.ok, true);
  assert.equal(r.ui.kind, 'write');
  assert.equal(r.ui.created, true);
  assert.equal(r.ui.added, 3);
  assert.equal(r.ui.removed, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'src/index.html'), 'utf8'), '<h1>Hi</h1>\n<p>x</p>\n<p>y</p>\n');
  assert.match(r.output, /Created src\/index\.html \(3 lines\)/);
  assert.deepEqual(ctx.state.changed.get('src/index.html'), { added: 3, removed: 0 });
});

test('write_file over an existing file reports +added −removed with a diff preview', async () => {
  const { run } = await setup();
  await run('write_file', { path: 'a.txt', content: 'one\ntwo\nthree\nfour\n' });
  const r = await run('write_file', { path: 'a.txt', content: 'one\nTWO\nthree\nfour\nfive\n' });
  assert.equal(r.ui.created, false);
  assert.equal(r.ui.added, 2);
  assert.equal(r.ui.removed, 1);
  assert.ok(r.ui.hunks.length >= 1);
  assert.match(r.output, /Overwrote a\.txt/);
});

test('write_file repairs a double-escaped body, but only when it is unmistakable', async () => {
  const { run, dir } = await setup();
  await run('write_file', { path: 'x.js', content: 'const a = 1;\\nconst b = 2;\\nconsole.log(a + b);\\n' });
  assert.equal(fs.readFileSync(path.join(dir, 'x.js'), 'utf8'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n');
  // real newlines present -> never touched, even with literal \n in a string
  await run('write_file', { path: 'y.js', content: 'const s = "a\\nb";\nconst t = "c\\nd";\nconst u = "e\\nf";\n' });
  assert.equal(fs.readFileSync(path.join(dir, 'y.js'), 'utf8'), 'const s = "a\\nb";\nconst t = "c\\nd";\nconst u = "e\\nf";\n');
});

test('read_file: numbered lines, ranges, clamping, and paging hint', async () => {
  const { run } = await setup();
  const body = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  await run('write_file', { path: 'big.txt', content: body });

  const first = await run('read_file', { path: 'big.txt' });
  assert.equal(first.ui.startLine, 1);
  assert.equal(first.ui.endLine, 2000);
  assert.equal(first.ui.totalLines, 2500);
  assert.equal(first.ui.truncated, true);
  assert.match(first.output, /Continue with read_file start_line=2001/);
  assert.match(first.output, /\n\s+1\tline 1\n/);

  const slice = await run('read_file', { path: 'big.txt', start_line: 100, end_line: 104 });
  assert.equal(slice.ui.startLine, 100);
  assert.equal(slice.ui.endLine, 104);
  assert.equal(slice.ui.truncated, false);
  assert.match(slice.output, /lines 100-104 of 2500/);

  const clamp = await run('read_file', { path: 'big.txt', start_line: 2495, end_line: 99999 });
  assert.equal(clamp.ui.endLine, 2500);

  const missing = await run('read_file', { path: 'nope.txt' });
  assert.equal(missing.ok, false);
  assert.match(missing.output, /File not found/);
});

test('argument aliases: file_path / contents work like path / content', async () => {
  const { run, dir } = await setup();
  const r = await run('write_file', { file_path: 'alias.txt', contents: 'hi\n' });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'alias.txt'), 'utf8'), 'hi\n');
});

test('edit_file: success reports ranges and +/−; the file changes', async () => {
  const { run, dir } = await setup();
  await run('write_file', { path: 'app.js', content: 'a();\nb();\nc();\nd();\n' });
  const r = await run('edit_file', { path: 'app.js', old_string: 'b();', new_string: 'B1();\nB2();' });
  assert.equal(r.ok, true);
  assert.equal(r.ui.kind, 'edit');
  assert.equal(r.ui.added, 2);
  assert.equal(r.ui.removed, 1);
  assert.deepEqual(r.ui.ranges, [[2, 3]]);
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'a();\nB1();\nB2();\nc();\nd();\n');
  assert.match(r.output, /Edited app\.js: 1 replacement, \+2 −1 \(L2-L3\)/);
});

test('edit_file: failures are tool errors with guidance, and write nothing', async () => {
  const { run, dir } = await setup();
  await run('write_file', { path: 'm.js', content: 'const total = items.reduce((a, b) => a + b, 0);\nconst x = 1;\nconst y = 1;\n' });
  const before = fs.readFileSync(path.join(dir, 'm.js'), 'utf8');
  const nf = await run('edit_file', { path: 'm.js', old_string: 'const total = items.map(f)', new_string: 'z' });
  assert.equal(nf.ok, false);
  assert.match(nf.output, /not found[\s\S]*Closest match[\s\S]*items\.reduce/i);
  const amb = await run('edit_file', { path: 'm.js', old_string: ' = 1;', new_string: ' = 2;' });
  assert.equal(amb.ok, false);
  assert.match(amb.output, /matches 2 places/);
  const none = await run('edit_file', { path: 'ghost.js', old_string: 'a', new_string: 'b' });
  assert.match(none.output, /does not exist/);
  assert.equal(fs.readFileSync(path.join(dir, 'm.js'), 'utf8'), before);
});

test('multi_edit: ordered, atomic, combined ranges; accepts a JSON-string edits array', async () => {
  const { run, dir } = await setup();
  const lines = Array.from({ length: 30 }, (_, i) => `row${i + 1}`);
  await run('write_file', { path: 'm.txt', content: lines.join('\n') + '\n' });
  const ok = await run('multi_edit', {
    path: 'm.txt',
    edits: [
      { old_string: 'row7', new_string: 'ROW7' }, // unique ("row7" is not a prefix of any other row)
      { old_string: 'row25', new_string: 'ROW25' },
    ],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.ui.edits, 2);
  assert.deepEqual(ok.ui.ranges, [[7, 7], [25, 25]]);
  assert.equal(ok.ui.added, 2);
  const before = fs.readFileSync(path.join(dir, 'm.txt'), 'utf8');
  const bad = await run('multi_edit', { path: 'm.txt', edits: JSON.stringify([{ old_string: 'row4', new_string: 'X' }, { old_string: 'nonexistent', new_string: 'Y' }]) });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /Edit 2 of 2 failed — nothing was written/);
  assert.equal(fs.readFileSync(path.join(dir, 'm.txt'), 'utf8'), before);
});

test('delete / move / create_dir, and writes inside .git are refused', async () => {
  const { run, dir } = await setup();
  await run('write_file', { path: 'd/f.txt', content: 'x\n' });
  await run('write_file', { path: 'd/nested/g.txt', content: 'x\n' });
  assert.equal((await run('delete_file', { path: 'd' })).ok, false); // non-empty without recursive
  const gone = await run('delete_file', { path: 'd', recursive: true });
  assert.equal(gone.ok, true);
  // A recursive delete says how much it covered: that is the part a person
  // cannot see for themselves.
  assert.equal(gone.ui.files, 2);
  assert.equal(gone.ui.isDir, true);
  assert.match(gone.output, /2 files removed/);
  await run('write_file', { path: 'a.txt', content: 'x\n' });
  const mv = await run('move_file', { from: 'a.txt', to: 'sub/b.txt' });
  assert.equal(mv.ui.kind, 'move');
  assert.ok(fs.existsSync(path.join(dir, 'sub/b.txt')));
  assert.equal((await run('create_dir', { path: 'x/y/z' })).ui.kind, 'mkdir');
  const git = await run('write_file', { path: '.git/hooks/pre-commit', content: 'x' });
  assert.equal(git.ok, false);
  assert.match(git.output, /\.git is blocked/);
  const out = await run('write_file', { path: '../escape.txt', content: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.output, /outside the workspace/);
});

test('list_dir, grep_search and file_search', async () => {
  const { run } = await setup();
  await run('write_file', { path: 'src/a.js', content: 'const needle = 1;\n' });
  await run('write_file', { path: 'src/b.js', content: 'nothing\n' });
  const ls = await run('list_dir', { depth: 2 });
  assert.match(ls.output, /src\/\nsrc\/a\.js/);
  assert.equal(ls.ui.kind, 'list');
  const g = await run('grep_search', { pattern: 'needle' });
  assert.match(g.output, /src\/a\.js:1: const needle = 1;/);
  assert.equal(g.ui.count, 1);
  const none = await run('grep_search', { pattern: 'absent_xyz' });
  assert.match(none.output, /No matches/);
  const f = await run('file_search', { pattern: '*.js' });
  assert.equal(f.ui.count, 2);
});

test('run_command: output, exit codes (a failing command is info, not a tool error)', async () => {
  if (isWin) return;
  const { run } = await setup();
  const ok = await run('run_command', { command: 'echo hello' });
  assert.equal(ok.ok, true);
  assert.match(ok.output, /\$ echo hello\nhello\n\[exit code 0\]/);
  assert.equal(ok.ui.exitCode, 0);
  const bad = await run('run_command', { command: 'echo oops; exit 2' });
  assert.equal(bad.ok, false);
  assert.equal(bad.failedSoft, true);
  assert.match(bad.output, /\[exit code 2\]/);
  assert.equal(bad.uiOutput.trim(), 'oops');
});

test('run_command: timeout is reported and the command is killed', async () => {
  if (isWin) return;
  const { run } = await setup();
  const t0 = Date.now();
  const r = await run('run_command', { command: 'sleep 20', timeout_seconds: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.ui.timedOut, true);
  assert.match(r.output, /timed out after 1s/);
  assert.ok(Date.now() - t0 < 8000);
});

test('run_command: servers must use background=true; destructive commands are blocked', async () => {
  const { run } = await setup();
  const server = await run('run_command', { command: 'npm run dev' });
  assert.equal(server.ok, false);
  assert.match(server.output, /background=true/);
  for (const cmd of ['rm -rf /', 'rm -rf ~', 'sudo rm -rf / --no-preserve-root', 'mkfs.ext4 /dev/sda1', ':(){ :|:& };:', 'shutdown now']) {
    const r = await run('run_command', { command: cmd });
    assert.equal(r.ok, false, cmd);
    assert.match(r.output, /destructive/, cmd);
  }
  // a normal rm inside the workspace is fine
  await run('write_file', { path: 'tmp.txt', content: 'x' });
  const rm = await run('run_command', { command: 'rm tmp.txt' });
  assert.equal(rm.ok, true);
});

test('background process + get_preview_url + read_process_output + stop_process', async () => {
  if (isWin) return;
  const { run, ws } = await setup();
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const early = await run('get_preview_url', { port });
  assert.equal(early.ok, false);
  assert.match(early.output, /Nothing is listening on port/);

  const script = `require('http').createServer((q,s)=>s.end('PREVIEW')).listen(${port},()=>console.log('server on http://localhost:${port}'))`;
  const bg = await run('run_command', { command: `node -e "${script}"`, background: true });
  assert.equal(bg.ok, true);
  assert.equal(bg.ui.kind, 'background');
  assert.deepEqual(bg.ui.ports, [port]);
  const id = bg.ui.id;
  assert.match(id, /^bg-\d+$/, 'friendly process id, same shape as in the sandbox');

  const preview = await run('get_preview_url', { port });
  assert.equal(preview.ok, true);
  assert.equal(preview.ui.url, `http://localhost:${port}`);
  assert.equal(preview.ui.status, 200);

  const logs = await run('read_process_output', { id });
  assert.match(logs.output, /^RUNNING/);
  assert.match(logs.output, /server on/);

  assert.equal((await run('stop_process', { id })).ok, true);
  await ws.dispose();
});

test('portsInCommand finds the port a command will listen on', () => {
  assert.deepEqual(portsInCommand('python3 -m http.server 3000 --bind 0.0.0.0'), [3000]);
  assert.deepEqual(portsInCommand('python3 -m http.server --bind 0.0.0.0 8080'), [8080]);
  assert.deepEqual(portsInCommand('npx vite --host 0.0.0.0 --port 5173'), [5173]);
  assert.deepEqual(portsInCommand('PORT=4000 node server.js'), [4000]);
  assert.deepEqual(portsInCommand('flask run -p 5000'), [5000]);
  assert.deepEqual(portsInCommand('npx http-server -p 8081'), [8081]);
  assert.deepEqual(portsInCommand('curl http://localhost:9000/health'), [9000]);
  assert.deepEqual(portsInCommand('sleep 1000'), [], 'a bare number is not a port');
  assert.deepEqual(portsInCommand('echo hello'), []);
});

test('background servers: readiness is probed, a duplicate start is not repeated, stop frees the port', async () => {
  if (isWin) return;
  const { run, ws } = await setup();
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  // silent on purpose: output redirected away, like the model did against the real sandbox
  const cmd = `node -e "require('http').createServer((q,s)=>s.end('x')).listen(${port})" > /dev/null 2>&1`;

  const first = await run('run_command', { command: cmd, background: true });
  assert.equal(first.ok, true, first.output);
  assert.equal(first.ui.listening, true);
  assert.deepEqual(first.ui.ports, [port]);
  assert.match(first.output, new RegExp(`Port ${port} is accepting connections`));
  const id = first.ui.id;

  // the model tries again (it could not see output before): nothing new is started
  const again = await run('run_command', { command: cmd, background: true });
  assert.equal(again.ok, true);
  assert.equal(again.ui.reused, true);
  assert.equal(again.ui.id, id);
  assert.match(again.output, new RegExp(`Not started: port ${port} is already being served by background process ${id}`));
  assert.match(again.output, /get_preview_url/);
  assert.match(again.output, /stop_process/);
  assert.equal(ws.listBackground().length, 1, 'still exactly one process');

  // restart on purpose: stop, then start
  assert.equal((await run('stop_process', { id })).ok, true);
  await new Promise((r) => setTimeout(r, 600));
  const restarted = await run('run_command', { command: cmd, background: true });
  assert.equal(restarted.ui.listening, true);
  assert.notEqual(restarted.ui.id, id);
  await ws.dispose();
});

test('recoverArgs: mangled or cut-off tool-call JSON is rescued, garbage is not', async () => {
  const { tools } = await setup();
  // the agnes failure mode: a missing comma between fields, but both values complete
  const mangled = '{"path": "index.html" "content": "<!DOCTYPE html>\n<html>\n<body>\n</body>\n</html>\n"}';
  const r = tools.recoverArgs('write_file', mangled);
  assert.ok(r, 'a missing comma is recovered');
  assert.equal(r.args.path, 'index.html');
  assert.match(r.args.content, /<!DOCTYPE html>/);
  assert.equal(r.truncated, false);

  // a genuinely truncated write with a real piece of the file is rescued and flagged
  const full = JSON.stringify({ path: 'a.js', content: 'l1\nl2\nl3\nl4\nhalf line' });
  const cut = full.slice(0, full.length - 14);
  const t = tools.recoverArgs('write_file', cut);
  assert.ok(t, 'a cut-off write with several lines is recovered');
  assert.equal(t.truncated, true);

  // one stray line is noise, not work: left alone so it surfaces as an error
  assert.equal(tools.recoverArgs('write_file', '{"path": "x.txt", "content": "unterminated'), null);

  // garbage stays garbage
  assert.equal(tools.recoverArgs('write_file', 'not json at all'), null);
  assert.equal(tools.recoverArgs('run_command', '{"command": "ls'), null);
});

test('list_processes: the agent can recover the ids of servers it started in an earlier turn', async () => {
  if (isWin) return;
  const { run, ws } = await setup();

  const empty = await run('list_processes', {});
  assert.equal(empty.ok, true, empty.output);
  assert.equal(empty.ui.count, 0);
  assert.match(empty.output, /No background processes/);

  const started = await run('run_command', { command: 'node -e "setTimeout(()=>{},30000)"', background: true });
  assert.equal(started.ok, true, started.output);
  const id = started.ui.id;

  const listed = await run('list_processes', {});
  assert.equal(listed.ok, true, listed.output);
  assert.equal(listed.ui.count, 1);
  assert.equal(listed.ui.running, 1);
  assert.match(listed.output, new RegExp(`${id}\\s+RUNNING`), listed.output);
  assert.match(listed.output, /setTimeout/, 'the command line is shown so the right process can be picked out');

  // still useful once it dies: an id whose server crashed must not look alive
  await run('stop_process', { id });
  await new Promise((r) => setTimeout(r, 500));
  const after = await run('list_processes', {});
  assert.equal(after.ui.count, 1);
  assert.equal(after.ui.running, 0);
  assert.match(after.output, /EXITED/);
  await ws.dispose();
});

test('background servers: a process that never opens its port is called out', async () => {
  if (isWin) return;
  const prev = process.env.DANAV_BG_PORT_WAIT_MS;
  process.env.DANAV_BG_PORT_WAIT_MS = '500';
  try {
    const { run, ws } = await setup();
    const r = await run('run_command', { command: 'PORT=45999 node -e "setTimeout(()=>{},30000)"', background: true });
    assert.equal(r.ok, true);
    assert.equal(r.ui.listening, false);
    assert.match(r.output, /Port 45999 is not accepting connections yet/);
    assert.match(r.output, /0\.0\.0\.0/, 'it reminds the model to bind to all interfaces');
    await ws.dispose();
  } finally {
    if (prev === undefined) delete process.env.DANAV_BG_PORT_WAIT_MS; else process.env.DANAV_BG_PORT_WAIT_MS = prev;
  }
});

test('approvals: a workspace without auto-run asks first; denial is respected', async () => {
  if (isWin) return;
  const { run, ctx, dir } = await setup({ autoRun: false });
  const asked = [];
  ctx.approve = async (info) => {
    asked.push(info.command);
    return !/forbidden/.test(info.command);
  };
  const ok = await run('run_command', { command: 'echo allowed' });
  assert.equal(ok.ok, true);
  const denied = await run('run_command', { command: 'echo forbidden > nope.txt' });
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, true);
  assert.match(denied.output, /did not allow/);
  assert.ok(!fs.existsSync(path.join(dir, 'nope.txt')), 'a denied command must not run');
  assert.deepEqual(asked, ['echo allowed', 'echo forbidden > nope.txt']);
});

test('secrets are redacted from what the model (and the chat) can see', async () => {
  if (isWin) return;
  const prevKey = process.env.NOVITA_API_KEY;
  process.env.NOVITA_API_KEY = 'sk_test_REDACT_ME_1234567890';
  try {
    const { run } = await setup();
    await run('write_file', { path: '.env', content: 'NOVITA_API_KEY=sk_test_REDACT_ME_1234567890\nOTHER=1\n' });
    const read = await run('read_file', { path: '.env' });
    assert.ok(!read.output.includes('sk_test_REDACT_ME'), read.output);
    assert.match(read.output, /\[REDACTED\]/);
    const cat = await run('run_command', { command: 'cat .env' });
    assert.ok(!cat.output.includes('sk_test_REDACT_ME'));
    assert.ok(!cat.uiOutput.includes('sk_test_REDACT_ME'));
    const grep = await run('grep_search', { pattern: 'NOVITA' });
    assert.ok(!grep.output.includes('sk_test_REDACT_ME'));
  } finally {
    if (prevKey === undefined) delete process.env.NOVITA_API_KEY; else process.env.NOVITA_API_KEY = prevKey;
  }
});

test('web tools go through the injected search runner; failures are tool errors', async () => {
  const calls = [];
  const search = async (name, args) => {
    calls.push([name, args]);
    if (args.query === 'boom') return { success: false, error: 'blocked' };
    if (name === 'web_search') return { success: true, output: '1. Result — https://x.dev', results: [{}, {}] };
    if (name === 'fetch_url') return { success: true, output: '# Page\nbody', title: 'Page' };
    return { success: true, images: [{ title: 'cat', url: 'https://i/c.png', thumbnail: 'https://i/t.png' }] };
  };
  const { run } = await setup({ search });
  const s = await run('web_search', { query: 'vite config' });
  assert.equal(s.ui.count, 2);
  const f = await run('fetch_url', { url: 'https://x.dev' });
  assert.match(f.output, /Untrusted web content/);
  assert.equal(f.ui.title, 'Page');
  assert.equal((await run('image_search', { query: 'cats' })).ui.count, 1);
  const bad = await run('web_search', { query: 'boom' });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /Web search failed: blocked/);
  assert.equal(calls.length, 4);
});

test('SSRF: fetch_url refuses local / private / metadata addresses before anything is fetched', async () => {
  let reached = 0;
  const search = async () => {
    reached++;
    return { success: true, output: 'page text', title: 'T' };
  };
  const { run } = await setup({ search });
  const blocked = [
    'http://127.0.0.1:3001/api/settings',
    'http://localhost:3001/api/settings',
    'http://app.localhost/x',
    'http://[::1]:3001/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3/',
    'http://172.20.0.5/',
    'http://192.168.0.1/admin',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[fd00::1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a00:1]/',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[0:0:0:0:0:0:0:1]/',
    'http://[fe80::1]/',
    'http://intranet.local/x',
    'http://service.internal/',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'not a url',
  ];
  for (const url of blocked) {
    const r = await run('fetch_url', { url });
    assert.equal(r.ok, false, `${url} must be refused`);
  }
  assert.equal(reached, 0, 'not one blocked URL reached the fetcher');
  assert.match((await run('fetch_url', { url: 'http://localhost:3001/api/settings' })).output, /local or private network/);
  const ok = await run('fetch_url', { url: 'http://93.184.216.34/page' });
  assert.equal(ok.ok, true);
  assert.equal(reached, 1);
});

test('SSRF: a public-looking hostname that RESOLVES to a private address is refused too (DNS rebinding)', async () => {
  await assert.rejects(() => assertPublicUrl('http://totally-public.example/', async () => [{ address: '127.0.0.1' }]), /local or private/);
  await assert.rejects(() => assertPublicUrl('http://mixed.example/', async () => [{ address: '93.184.216.34' }, { address: '10.0.0.8' }]), /local or private/);
  await assert.rejects(() => assertPublicUrl('http://nope.example/', async () => { throw new Error('ENOTFOUND'); }), /Could not resolve/);
  await assertPublicUrl('https://docs.example/page', async () => [{ address: '93.184.216.34' }, { address: '2606:2800:220:1::1' }]);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('172.15.0.1'), false, '172.15 is public, 172.16–31 is private');
  assert.equal(isPrivateAddress('172.32.0.1'), false);
  assert.equal(isPrivateAddress('2606:4700::1111'), false);
  assert.equal(isPrivateAddress('172.16.0.1'), true);
  assert.equal(isPrivateAddress('garbage'), true, 'anything that is not an IP is unsafe');
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false, 'a mapped PUBLIC address is public');
  assert.equal(isPrivateAddress('::ffff:808:808'), false);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('1:2:3:4:5:6:7:8:9'), true, 'malformed is unsafe');
});

test('SSRF: a redirect chain is followed by hand and every hop is checked', async () => {
  const hops = [];
  const chain = {
    'http://93.184.216.34/start': 'http://93.184.216.35/middle',
    'http://93.184.216.35/middle': 'http://93.184.216.36/final',
    'http://93.184.216.36/final': null,
    'http://93.184.216.37/evil': 'http://127.0.0.1:3001/api/settings',
    'http://93.184.216.38/meta': 'http://169.254.169.254/latest/meta-data/',
    'http://93.184.216.39/rel': '/next', // relative Location
    'http://93.184.216.39/next': null,
  };
  const probe = async (url) => {
    hops.push(url);
    const next = chain[url];
    return { status: next ? 302 : 200, headers: new Headers(next ? { location: next } : {}), body: null };
  };
  const lookup = async () => [{ address: '93.184.216.34' }];

  assert.equal(await resolveSafeUrl('http://93.184.216.34/start', { lookup, probe }), 'http://93.184.216.36/final');
  assert.deepEqual(hops, ['http://93.184.216.34/start', 'http://93.184.216.35/middle', 'http://93.184.216.36/final']);
  assert.equal(await resolveSafeUrl('http://93.184.216.39/rel', { lookup, probe }), 'http://93.184.216.39/next', 'relative redirects resolve');

  hops.length = 0;
  await assert.rejects(() => resolveSafeUrl('http://93.184.216.37/evil', { lookup, probe }), /local or private/);
  assert.ok(!hops.includes('http://127.0.0.1:3001/api/settings'), 'the private hop was never requested');
  await assert.rejects(() => resolveSafeUrl('http://93.184.216.38/meta', { lookup, probe }), /local or private/);

  const loop = async () => ({ status: 302, headers: new Headers({ location: 'http://93.184.216.40/again' }), body: null });
  await assert.rejects(() => resolveSafeUrl('http://93.184.216.40/again', { lookup, probe: loop }), /redirects too many times/);
  const down = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await resolveSafeUrl('http://93.184.216.41/x', { lookup, probe: down }), 'http://93.184.216.41/x', 'an unreachable host is left for the real fetcher to report');

  // through the tool: the fetcher receives the VERIFIED FINAL url, and an evil chain never reaches it
  const seen = [];
  const search = async (name, args) => { seen.push(args.url); return { success: true, output: 'ok', title: 't' }; };
  const { run } = await setup({ search, probe });
  const ok = await run('fetch_url', { url: 'http://93.184.216.34/start' });
  assert.equal(ok.ok, true);
  assert.deepEqual(seen, ['http://93.184.216.36/final']);
  const evil = await run('fetch_url', { url: 'http://93.184.216.37/evil' });
  assert.equal(evil.ok, false);
  assert.match(evil.output, /local or private network/);
  assert.equal(seen.length, 1, 'the evil redirect never reached the fetcher');
});

test('update_plan stores a sanitised checklist', async () => {
  const { run, ctx } = await setup();
  const r = await run('update_plan', {
    todos: [
      { content: 'Scaffold', status: 'completed' },
      { content: 'Build UI', status: 'in_progress' },
      { content: 'Test', status: 'bogus' },
      { nope: true },
    ],
  });
  assert.equal(r.ui.total, 3);
  assert.equal(r.ui.done, 1);
  assert.equal(ctx.state.plan[2].status, 'pending');
});

test('missing / wrong arguments become readable tool errors, not crashes', async () => {
  const { run } = await setup();
  assert.match((await run('read_file', {})).output, /Missing required argument "path"/);
  assert.match((await run('write_file', { path: 'a.txt' })).output, /Missing required argument "content"/);
  assert.match((await run('get_preview_url', { port: 'abc' })).output, /port must be a number/);
  assert.match((await run('update_plan', { todos: 'x' })).output, /must be an array/);
});

test('displayArgs never leaks file bodies or edit text to the UI', () => {
  const big = 'x'.repeat(5000);
  assert.deepEqual(displayArgs('write_file', { path: 'a.js', content: big }), { path: 'a.js' });
  assert.deepEqual(displayArgs('edit_file', { path: 'a.js', old_string: big, new_string: big }), { path: 'a.js' });
  assert.deepEqual(displayArgs('multi_edit', { path: 'a.js', edits: [{ old_string: big, new_string: big }] }), { path: 'a.js', edits: 1 });
  assert.equal(displayArgs('run_command', { command: 'npm i', background: true }).background, true);
});

test('progress tracker: an overwrite waits for the file on disk, and the live numbers only ever grow', async () => {
  const { tools, dir } = await setup();
  fs.writeFileSync(path.join(dir, 'old.txt'), Array.from({ length: 40 }, (_, i) => `old ${i + 1}`).join('\n') + '\n');
  const body = (n) => Array.from({ length: n }, (_, i) => `new ${i + 1}`).join('\\n');
  const head = '{"path": "old.txt", "content": "';

  // overwrite: no numbers until we know what is on disk (so "+N" never changes meaning mid-way)
  const t = tools.progressTracker('write_file');
  assert.equal(t.update(head + body(4)).progress, undefined);
  assert.equal(t.update(head + body(5)).args.path, 'old.txt', 'the path is shown right away');
  await new Promise((r) => setTimeout(r, 60));
  const seq = [4, 8, 6, 20, 35, 50].map((n) => t.update(head + body(n)).progress);
  assert.ok(seq.every((p) => p && p.added >= 0 && p.removed !== undefined));
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i].added >= seq[i - 1].added, `+ never decreases (${seq.map((p) => p.added)})`);
    assert.ok(seq[i].removed >= seq[i - 1].removed, `− never decreases (${seq.map((p) => p.removed)})`);
  }
  assert.ok(seq.at(-1).removed <= 40);

  // a brand-new file: numbers appear immediately (after the quick "does it exist?" check) and the "−" is a real 0
  const n = tools.progressTracker('write_file');
  n.update('{"path": "fresh.txt", "content": "a');
  await new Promise((r) => setTimeout(r, 60));
  const fresh = n.update('{"path": "fresh.txt", "content": "a\\nb\\nc').progress;
  assert.deepEqual([fresh.added, fresh.removed], [3, 0]);

  // other tools need no disk lookup at all
  assert.equal(tools.progressTracker('edit_file').update('{"path": "a.js", "old_string": "x", "new_string": "y\\nz').progress.added, 2);
});

test('progress tracker: a call that puts "content" BEFORE "path" still gets live numbers', async () => {
  // Real models vary the field order. Without the path the tracker cannot know what is on disk,
  // and an overwrite used to replay with no "+N −M" at all.
  const { tools, dir } = await setup();
  fs.writeFileSync(path.join(dir, 'notes.css'), Array.from({ length: 45 }, (_, i) => `.old-${i + 1} { color: red; }`).join('\n') + '\n');
  // real newlines: JSON.stringify escapes them, exactly as a provider's stream would
  const body = Array.from({ length: 67 }, (_, i) => `.rule-${i + 1} { display: flex; }`).join('\n') + '\n';
  const argsText = JSON.stringify({ content: body, path: 'notes.css' });
  assert.ok(argsText.indexOf('"content"') < argsText.indexOf('"path"'), 'the fixture really does put content first');

  // primed with the path the caller already knows (a call that arrived complete)
  const t = tools.progressTracker('write_file', { path: 'notes.css' });
  await new Promise((r) => setTimeout(r, 60));
  const seen = [0.3, 0.6, 1].map((f) => t.update(argsText.slice(0, Math.round(argsText.length * f))).progress);
  assert.ok(seen.every((p) => p), `every prefix reports progress: ${JSON.stringify(seen)}`);
  assert.equal(seen.at(-1).added, 67, 'the final prefix reports the whole file');
  assert.ok(seen.at(-1).removed > 0, 'an overwrite shows what it replaces');

  // and without the hint it still works once the path itself arrives
  const u = tools.progressTracker('write_file');
  u.update(argsText);
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(u.update(argsText).progress, 'the path in the text primes it too');
});

test('peekPartialArgs is re-exported from tools with the progress shape the loop relies on', () => {
  const p = peekPartialArgs('write_file', '{"path": "src/index.html", "content": "<!DOCTYPE html>\\n<html>\\n<head>\\n');
  assert.equal(p.args.path, 'src/index.html');
  assert.equal(p.progress.added, 3);
  assert.deepEqual(p.progress.tail, ['<!DOCTYPE html>', '<html>', '<head>']);
});


// ---------------------------------------------------------------------------
// Phase 3: many edits in ONE call, chunked reading, outlines
// ---------------------------------------------------------------------------

const numbered = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

test('multi_edit by LINE NUMBERS: replace, delete and insert in ONE call, top to bottom, numbers relative to the file as read', async () => {
  const { run, dir } = await setup();
  await run('write_file', { path: 'a.txt', content: numbered(10) });
  const r = await run('multi_edit', {
    path: 'a.txt',
    edits: [
      { start_line: 2, end_line: 3, new_string: 'TWO\nTHREE\nTHREE-B' }, // 2 lines -> 3 lines (shifts everything below)
      { start_line: 6, new_string: 'SIX' },                               // still "line 6" of the ORIGINAL file
      { start_line: 8, end_line: 9, new_string: '' },                     // delete 8 and 9
      { insert_after_line: 0, new_string: 'TOP' },
      { insert_after_line: 10, new_string: 'END' },
    ],
  });
  assert.equal(r.ok, true, r.output);
  assert.equal(
    fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'),
    ['TOP', 'line 1', 'TWO', 'THREE', 'THREE-B', 'line 4', 'line 5', 'SIX', 'line 7', 'line 10', 'END'].join('\n') + '\n'
  );
  assert.equal(r.ui.kind, 'edit');
  assert.equal(r.ui.edits, 5);
  assert.ok(r.ui.ranges.length >= 3, 'several separate ranges are reported');
  assert.match(r.output, /5 replacements/);
});

test('multi_edit: line-number mistakes are explained and nothing is written', async () => {
  const { run, dir } = await setup();
  await run('write_file', { path: 'a.txt', content: numbered(5) });
  const before = fs.readFileSync(path.join(dir, 'a.txt'), 'utf8');
  const oob = await run('multi_edit', { path: 'a.txt', edits: [{ start_line: 2, new_string: 'x' }, { start_line: 9, new_string: 'y' }] });
  assert.equal(oob.ok, false);
  assert.match(oob.output, /Edit 2 of 2: start_line\/end_line must satisfy 1 ≤ start ≤ end ≤ 5/);
  const overlap = await run('multi_edit', { path: 'a.txt', edits: [{ start_line: 2, end_line: 4, new_string: 'x' }, { start_line: 3, new_string: 'y' }] });
  assert.match(overlap.output, /overlaps/);
  const mixed = await run('multi_edit', { path: 'a.txt', edits: [{ start_line: 1, new_string: 'x' }, { old_string: 'line 3', new_string: 'y' }] });
  assert.match(mixed.output, /Do not mix edit styles/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), before);
});

test('multi_edit across SEVERAL FILES in one call, atomically', async () => {
  const { run, dir } = await setup();
  await run('write_file', { path: 'a.js', content: 'const a = 1;\nconst b = 2;\n' });
  await run('write_file', { path: 'src/b.css', content: 'body { color: red; }\nh1 { margin: 0; }\n' });
  const ok = await run('multi_edit', {
    edits: [
      { path: 'a.js', old_string: 'const a = 1;', new_string: 'const a = 100;' },
      { path: 'src/b.css', old_string: 'color: red;', new_string: 'color: blue;' },
      { path: 'a.js', old_string: 'const b = 2;', new_string: 'const b = 200;' },
    ],
  });
  assert.equal(ok.ok, true, ok.output);
  assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'const a = 100;\nconst b = 200;\n');
  assert.match(fs.readFileSync(path.join(dir, 'src/b.css'), 'utf8'), /color: blue/);
  assert.equal(ok.ui.changes.length, 2);
  assert.deepEqual(ok.ui.changes.map((f) => [f.path, f.edits]), [['a.js', 2], ['src/b.css', 1]]);
  assert.equal(ok.ui.edits, 3);
  assert.equal(ok.ui.added, ok.ui.changes.reduce((n, f) => n + f.added, 0));
  assert.match(ok.output, /Total: 2 files, 3 edits/);

  // the second file cannot be edited -> the FIRST file must be untouched too
  const before = fs.readFileSync(path.join(dir, 'a.js'), 'utf8');
  const bad = await run('multi_edit', {
    edits: [
      { path: 'a.js', old_string: 'const a = 100;', new_string: 'const a = 7;' },
      { path: 'src/b.css', old_string: 'no such text', new_string: 'x' },
    ],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /^Error: src\/b\.css: /);
  assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), before, 'a failed batch changes no file at all');
  assert.equal((await run('multi_edit', { edits: [{ old_string: 'a', new_string: 'b' }] })).ok, false, 'an edit with no file anywhere is refused');
  assert.match((await run('multi_edit', { edits: [{ path: 'ghost.js', old_string: 'a', new_string: 'b' }] })).output, /does not exist/);
});

test('edit_file: separate calls on the same file earn a "use multi_edit" tip; multi_edit resets it; line-number prefixes are stripped', async () => {
  const { run } = await setup();
  await run('write_file', { path: 'a.js', content: 'let a = 1;\nlet b = 2;\nlet c = 3;\n' });
  const first = await run('edit_file', { path: 'a.js', old_string: 'let a = 1;', new_string: 'let a = 10;' });
  assert.ok(!/Tip:/.test(first.output));
  const second = await run('edit_file', { path: 'a.js', old_string: 'let b = 2;', new_string: 'let b = 20;' });
  assert.match(second.output, /Tip: that was separate edit_file call #2 on a\.js/);
  assert.match(second.output, /multi_edit/);
  await run('multi_edit', { path: 'a.js', edits: [{ old_string: 'let a = 10;', new_string: 'let a = 11;' }] });
  const afterReset = await run('edit_file', { path: 'a.js', old_string: 'let c = 3;', new_string: 'let c = 30;' });
  assert.ok(!/Tip:/.test(afterReset.output), 'the counter starts over after a batch');
  // read_file's own "  12\t" prefix pasted into old_string/new_string is not part of the file
  const pasted = await run('edit_file', { path: 'a.js', old_string: '   2\tlet b = 20;', new_string: '   2\tlet b = 21;' });
  assert.equal(pasted.ok, true, pasted.output);
  const { run: r2, dir } = await setup();
  await r2('write_file', { path: 'x.txt', content: 'one\ntwo\nthree\n' });
  const viaMulti = await r2('multi_edit', { path: 'x.txt', edits: [{ old_string: '   2\ttwo', new_string: '   2\tTWO' }] });
  assert.equal(viaMulti.ok, true, viaMulti.output);
  assert.equal(fs.readFileSync(path.join(dir, 'x.txt'), 'utf8'), 'one\nTWO\nthree\n');
});

test('read_file: several CHUNKS in one call (ranges), merged, clamped, with a clear header', async () => {
  const { run } = await setup();
  await run('write_file', { path: 'big.txt', content: numbered(300) });
  const r = await run('read_file', { path: 'big.txt', ranges: [[200, 205], [1, 3], [3, 5], [299, 999]] });
  assert.equal(r.ok, true, r.output);
  assert.deepEqual(r.ui.ranges, [[1, 5], [200, 205], [299, 300]], 'sorted, overlapping chunks merged, end clamped');
  assert.match(r.output, /big\.txt — 300 lines; 3 chunks: 1-5, 200-205, 299-300/);
  assert.match(r.output, /── lines 200-205 ──\n\s+200\tline 200/);
  assert.ok(!/line 100\b/.test(r.output), 'nothing outside the chunks is shown');
  assert.equal(r.ui.startLine, 1);
  assert.equal(r.ui.endLine, 300);
  // object style and junk entries
  const o = await run('read_file', { path: 'big.txt', ranges: [{ start_line: 10, end_line: 12 }, 'junk', [null, null]] });
  assert.deepEqual(o.ui.ranges, undefined);
  assert.deepEqual([o.ui.startLine, o.ui.endLine], [10, 12]);
  // a single chunk behaves exactly like start_line/end_line
  const one = await run('read_file', { path: 'big.txt', ranges: [[7, 9]] });
  assert.match(one.output, /lines 7-9 of 300/);
});

test('file_outline: structure with line numbers, then targeted reads', async () => {
  const { run } = await setup();
  await run('write_file', { path: 'src/app.js', content: "import x from 'x';\n\nexport function render(a) {\n  return a;\n}\n\nclass Store {\n  load() {\n    return 1;\n  }\n}\n\nconst add = (a, b) => a + b;\n" });
  const r = await run('file_outline', { path: 'src/app.js' });
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /src\/app\.js — 13 lines, js, 4 symbols/);
  assert.match(r.output, /L3\s+export function render\(a\)/);
  assert.match(r.output, /L7\s+class Store/);
  assert.match(r.output, /L8\s+\s*load\(\)/);
  assert.match(r.output, /L13\s+const add = \(a, b\) => a \+ b;/);
  assert.match(r.output, /ranges: \[\[a,b\],\[c,d\]\]/);
  assert.deepEqual([r.ui.kind, r.ui.count, r.ui.totalLines, r.ui.language], ['outline', 4, 13, 'js']);
  fs.writeFileSync(path.join((await setup()).dir, 'x.bin'), Buffer.from([0, 1, 2]));
  assert.equal((await run('file_outline', { path: 'missing.js' })).ok, false);
  await run('write_file', { path: 'notes.xyz', content: 'just words\n' });
  assert.match((await run('file_outline', { path: 'notes.xyz' })).output, /No structure could be detected/);
});


// ---------------------------------------------------------------------------
// Phase 4: append, project-wide replace, instant syntax checks, richer preview
// ---------------------------------------------------------------------------

test('append_file: builds a big file in parts, never glues onto a half-written line', async () => {
  const { run, dir } = await setup();
  const a = await run('append_file', { path: 'big.txt', content: 'one\ntwo\n' });
  assert.equal(a.ok, true, a.output);
  assert.equal(a.ui.created, true);
  assert.deepEqual([a.ui.kind, a.ui.added, a.ui.totalLines], ['append', 2, 2]);
  const b = await run('append_file', { path: 'big.txt', content: 'three\nfour\n' });
  assert.equal(b.ui.created, false);
  assert.match(b.output, /Appended 2 lines to big\.txt — it now has 4 lines/);
  // a file that does not end with a newline: the next part starts on its own line
  fs.appendFileSync(path.join(dir, 'big.txt'), 'five-half');
  await run('append_file', { path: 'big.txt', content: 'six\n' });
  assert.equal(fs.readFileSync(path.join(dir, 'big.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nfive-half\nsix\n');
  assert.equal((await run('append_file', { path: 'big.txt', content: '' })).ok, false);
  assert.equal((await run('append_file', { path: '.git/x', content: 'a' })).ok, false);
});

test('replace_in_files: literal text with regex characters, many files, one call', async () => {
  const { run, dir } = await setup();
  await run('write_file', { path: 'a.js', content: 'import { foo.bar(x) } from "./a";\nfoo.bar(x);\nfoo.bar(x);\n' });
  await run('write_file', { path: 'src/b.js', content: 'const y = foo.bar(x) + 1;\nfooXbarYx;\n' });
  await run('write_file', { path: 'node_modules/p/c.js', content: 'foo.bar(x)\n' });
  fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.concat([Buffer.from('foo.bar(x)'), Buffer.from([0, 1, 2])]));
  const r = await run('replace_in_files', { pattern: 'foo.bar(x)', replacement: 'baz.qux(x, y)' });
  assert.equal(r.ok, true, r.output);
  assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'import { baz.qux(x, y) } from "./a";\nbaz.qux(x, y);\nbaz.qux(x, y);\n');
  assert.equal(fs.readFileSync(path.join(dir, 'src/b.js'), 'utf8'), 'const y = baz.qux(x, y) + 1;\nfooXbarYx;\n', '"." and "(" were matched literally, not as a regex');
  assert.equal(fs.readFileSync(path.join(dir, 'node_modules/p/c.js'), 'utf8'), 'foo.bar(x)\n', 'node_modules untouched');
  assert.ok(fs.readFileSync(path.join(dir, 'img.bin')).includes('foo.bar(x)'), 'binary files untouched');
  assert.deepEqual([r.ui.kind, r.ui.count, r.ui.fileCount, r.ui.dryRun], ['replace', 4, 2, false]);
  assert.deepEqual(r.ui.changes.map((c) => [c.path, c.edits]).sort(), [['a.js', 3], ['src/b.js', 1]]);
  assert.match(r.output, /4 replacements in 2 files/);
  assert.match(r.output, /a\.js: 3 replacements/);
});

test('replace_in_files: regex with $1, case-insensitive, glob, dry run, no matches, "$&" in a literal replacement', async () => {
  const { run, dir } = await setup();
  await run('write_file', { path: 'a.css', content: '.Btn { color: red; }\n.btn-big { color: red; }\n' });
  await run('write_file', { path: 'a.js', content: "const c = 'red';\n" });
  const rx = await run('replace_in_files', { pattern: '\\.(btn)(-\\w+)?', replacement: '.ui-$1$2', regex: true, case_sensitive: false, glob: '*.css' });
  assert.equal(rx.ok, true, rx.output);
  assert.equal(fs.readFileSync(path.join(dir, 'a.css'), 'utf8'), '.ui-Btn { color: red; }\n.ui-btn-big { color: red; }\n');
  assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), "const c = 'red';\n", 'the glob kept .js out');
  const before = fs.readFileSync(path.join(dir, 'a.css'), 'utf8');
  const dry = await run('replace_in_files', { pattern: 'red', replacement: 'blue', dry_run: true });
  assert.match(dry.output, /^DRY RUN — nothing was written\. Would replace "red"/);
  assert.equal(dry.ui.dryRun, true);
  assert.equal(dry.ui.count, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'a.css'), 'utf8'), before, 'a dry run changes nothing');
  const none = await run('replace_in_files', { pattern: 'zzz-not-here', replacement: 'x' });
  assert.match(none.output, /No matches for "zzz-not-here"/);
  assert.equal(none.ui.count, 0);
  await run('write_file', { path: 'p.txt', content: 'price: X\n' });
  await run('replace_in_files', { pattern: 'X', replacement: '$& and $1', glob: 'p.txt' });
  assert.equal(fs.readFileSync(path.join(dir, 'p.txt'), 'utf8'), 'price: $& and $1\n', 'a literal replacement is inserted as written');
  assert.match((await run('replace_in_files', { pattern: '(', replacement: 'x', regex: true })).output, /Invalid regular expression/);
  assert.match((await run('replace_in_files', { pattern: 'a' })).output, /Missing required argument "replacement"/);
});

test('replace_in_files: too many files is refused, and a replacement that breaks a file is flagged', async () => {
  const { run } = await setup();
  for (let i = 0; i < 101; i++) await run('write_file', { path: `many/f${i}.txt`, content: 'needle\n' });
  const big = await run('replace_in_files', { pattern: 'needle', replacement: 'x' });
  assert.equal(big.ok, false);
  assert.match(big.output, /matches 101\+? files — too many/);
  await run('write_file', { path: 'ok.js', content: 'const a = 1;\nfoo(a);\n' });
  const broke = await run('replace_in_files', { pattern: 'foo(a);', replacement: 'foo(a;', glob: 'ok.js' });
  assert.equal(broke.ok, true);
  assert.match(broke.output, /⚠ SYNTAX ERROR in ok\.js/);
  assert.equal(broke.ui.check.ok, false);
});

test('syntax check: JSON, JS/JSX/TS/TSX and CSS are parsed the moment they are written — in the same tool result', async () => {
  const { run } = await setup();
  const goodJs = await run('write_file', { path: 'a.js', content: 'export const f = (x) => x * 2;\nconsole.log(f(2));\n' });
  assert.ok(!/SYNTAX/.test(goodJs.output));
  assert.deepEqual(goodJs.ui.check, { lang: 'jsx', ok: true });
  const badJs = await run('write_file', { path: 'b.js', content: 'function f( {\n  return 1;\n}\n' });
  assert.equal(badJs.ok, true, 'the file IS written; the model is told it is broken');
  assert.match(badJs.output, /Created b\.js/);
  assert.match(badJs.output, /⚠ SYNTAX ERROR in b\.js \(jsx\): \d+:\d+ — /);
  assert.match(badJs.output, /fix it now/);
  assert.equal(badJs.ui.check.ok, false);
  assert.equal(badJs.ui.check.path, 'b.js');
  // JSX inside a .js file is normal (React projects) and must not be flagged
  assert.ok(!/SYNTAX/.test((await run('write_file', { path: 'c.js', content: 'export const A = () => <div className="x">hi</div>;\n' })).output));
  assert.ok(!/SYNTAX/.test((await run('write_file', { path: 'd.tsx', content: 'export const B = ({ n }: { n: number }) => <b>{n}</b>;\n' })).output));
  assert.ok(!/SYNTAX/.test((await run('write_file', { path: 'e.ts', content: 'interface A { x: number }\nexport const a: A = { x: 1 };\n' })).output));
  assert.match((await run('write_file', { path: 'f.ts', content: 'const a: number = ;\n' })).output, /SYNTAX ERROR in f\.ts/);
  // JSON with a precise position; JSON-with-comments files are left alone
  const badJson = await run('write_file', { path: 'data.json', content: '{\n  "a": 1,\n  "b": ,\n}\n' });
  assert.match(badJson.output, /⚠ SYNTAX ERROR in data\.json \(json\): .*line 3/);
  assert.ok(!/SYNTAX/.test((await run('write_file', { path: 'package.json', content: '{"name":"x","version":"1.0.0"}\n' })).output));
  assert.ok(!/SYNTAX/.test((await run('write_file', { path: 'tsconfig.json', content: '{\n  // comments are fine here\n  "compilerOptions": {},\n}\n' })).output));
  // CSS
  assert.match((await run('write_file', { path: 'bad.css', content: 'a { color: red;\n' })).output, /SYNTAX ERROR in bad\.css/);
  assert.ok(!/SYNTAX/.test((await run('write_file', { path: 'good.css', content: 'a { color: red; }\n' })).output));
  // a file kind we have no parser for: no verdict, no noise
  const md = await run('write_file', { path: 'x.md', content: '# {{{ not code\n' });
  assert.equal(md.ui.check, undefined);
});

test('syntax check: edits are checked too (edit_file, multi_edit), including a break introduced by an edit', async () => {
  const { run } = await setup();
  await run('write_file', { path: 'a.js', content: 'function f() {\n  return 1;\n}\n' });
  const e = await run('edit_file', { path: 'a.js', old_string: 'return 1;', new_string: 'return (1;' });
  assert.equal(e.ok, true);
  assert.match(e.output, /⚠ SYNTAX ERROR in a\.js/);
  const fixed = await run('multi_edit', { path: 'a.js', edits: [{ old_string: 'return (1;', new_string: 'return 1;' }] });
  assert.ok(!/SYNTAX/.test(fixed.output));
  assert.deepEqual(fixed.ui.check, { lang: 'jsx', ok: true });
  await run('write_file', { path: 'b.json', content: '{"a": 1}\n' });
  const multi = await run('multi_edit', { edits: [{ path: 'a.js', old_string: 'return 1;', new_string: 'return 2;' }, { path: 'b.json', old_string: '"a": 1', new_string: '"a": ' }] });
  assert.match(multi.output, /⚠ SYNTAX ERROR in b\.json/);
  assert.equal(multi.ui.check.ok, false, 'one broken file in a batch is reported');
  assert.equal(multi.ui.check.path, 'b.json');
});

test('syntax check: Python and shell are parsed in the workspace, but only where commands may run without asking', async () => {
  if (isWin) return;
  const { run } = await setup();
  assert.ok(!/SYNTAX/.test((await run('write_file', { path: 'ok.py', content: 'def f():\n    return 1\n' })).output));
  const badPy = await run('write_file', { path: 'bad.py', content: 'def f(:\n    return 1\n' });
  assert.match(badPy.output, /⚠ SYNTAX ERROR in bad\.py \(python\)/);
  assert.match((await run('write_file', { path: 'bad.sh', content: 'if [ 1 -eq 1 ]; then\necho hi\n' })).output, /⚠ SYNTAX ERROR in bad\.sh \(shell\)/);
  assert.ok(!/SYNTAX/.test((await run('write_file', { path: 'ok.sh', content: 'echo hi\n' })).output));
  // a workspace that asks before running commands never runs anything on its own
  const { run: strict } = await setup({ autoRun: false });
  assert.equal((await strict('write_file', { path: 'bad.py', content: 'def f(:\n' })).ui.check, undefined);
  // ... but in-process checks still work there
  assert.match((await strict('write_file', { path: 'bad.js', content: 'let = ;\n' })).output, /SYNTAX ERROR/);
});

test('get_preview_url tells the model what the page actually says (title, first words), and flags error pages', async () => {
  if (isWin) return;
  const { run, ws } = await setup();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/missing')) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      return res.end('<html><head><title>404</title></head><body>Not Found</body></html>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title> My  Shop </title><style>x{}</style></head><body><script>var a=1</script><h1>Welcome to the shop</h1><p>Best prices</p></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await run('get_preview_url', { port });
    assert.equal(r.ok, true, r.output);
    assert.match(r.output, /HTTP 200 \(text\/html\)/);
    assert.match(r.output, /page title: "My Shop"/);
    assert.match(r.output, /the page starts with: "Welcome to the shop Best prices"/);
    assert.ok(!/var a=1/.test(r.output), 'scripts are not part of the visible text');
    assert.equal(r.ui.title, 'My Shop');
    assert.equal(r.ui.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
    await ws.dispose();
  }
});

// ===========================================================================
// Tool-call arguments the way models really send them
// ===========================================================================

test('parseArgs: valid JSON passes through, almost-JSON is repaired, garbage is refused with a reason', async () => {
  const { tools } = await setup();
  const ok = tools.parseArgs('{"path": "a.txt", "content": "hi"}');
  assert.deepEqual(ok, { ok: true, args: { path: 'a.txt', content: 'hi' }, repaired: false });

  // a call with no arguments at all is not an error
  assert.deepEqual(tools.parseArgs(''), { ok: true, args: {}, repaired: false });
  assert.deepEqual(tools.parseArgs('   {}  '), { ok: true, args: {}, repaired: false });

  const cases = {
    'a missing comma between members': '{"path": "index.html" "content": "<h1>Hi</h1>\n<p>text</p>\n"}',
    'raw newlines inside the body': '{"path": "a.md", "content": "# Title\n\n- one\n- two\n"}',
    'unescaped quotes in HTML': '{"path": "p.html", "content": "<a href="x.html">go</a>\n<span class="y">z</span>\n"}',
    'bare keys': '{path: "b.txt", content: "one\ntwo\nthree\n"}',
    'a trailing comma': '{"path": "c.txt", "content": "x\ny\nz\n",}',
    'a fenced code block': '```json\n{"path": "d.txt", "content": "1\n2\n3\n"}\n```',
    'prose around the object': 'Here are the arguments:\n{"path": "e.txt", "content": "1\n2\n3\n"}\nDone.',
    'single quotes': "{'path': 'f.txt', 'content': 'alpha\nbeta\ngamma\n'}",
  };
  for (const [what, text] of Object.entries(cases)) {
    const r = tools.parseArgs(text);
    assert.equal(r.ok, true, `${what}: ${JSON.stringify(r)}`);
    assert.equal(r.repaired, true, `${what} was repaired`);
    assert.equal(typeof r.args.path, 'string', `${what}: the path survived`);
    assert.match(r.args.content, /\n|\<h1\>/, `${what}: the body survived`);
  }
  assert.equal(
    tools.parseArgs("{'path': 'f.txt', 'content': 'alpha\nbeta\ngamma\n'}").args.content,
    'alpha\nbeta\ngamma\n',
    'single-quoted text is not mangled'
  );

  // the provider wrapped the whole object in a JSON string
  const dr = tools.parseArgs(JSON.stringify(JSON.stringify({ path: 'g.txt', content: 'one\ntwo\n' })));
  assert.equal(dr.ok, true);
  assert.equal(dr.args.path, 'g.txt');

  // what cannot be repaired says exactly why
  const bad = tools.parseArgs('{"path": "a.txt", "content": ');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'json');
  assert.match(bad.message, /not valid JSON/);
  assert.match(bad.message, /Send a single valid JSON object/);
  assert.equal(tools.parseArgs('[1,2,3]').reason, 'not-object');
  assert.equal(tools.parseArgs('"a string"').reason, 'not-object');
});

test('repairJsonText fixes structure only: the text inside the strings survives byte for byte', async () => {
  const { tools } = await setup();
  const body = 'const re = /\\d+/;\nconst s = "quoted";\nif (s) console.log(re);\n';
  const good = JSON.stringify({ path: 'a.js', content: body });
  const unchanged = repairJsonText(good);
  assert.equal(unchanged.changed, false, 'valid JSON is left exactly as it is');
  assert.equal(unchanged.text, good);

  // the exact shape from the bug report: a missing comma between two members
  const broken = good.replace('","content"', '" "content"');
  assert.notEqual(broken, good);
  const fixed = repairJsonText(broken);
  assert.equal(fixed.changed, true);
  assert.deepEqual(JSON.parse(fixed.text), { path: 'a.js', content: body }, 'backslashes and quotes are still the body');

  // a template literal a model escaped by hand: \\' and \\n are not JSON escapes
  const mangled = String.raw`{"path": "a.txt", "content": "Don\'t worry\nsecond line\n"}`;
  const repaired = repairJsonText(mangled);
  assert.equal(repaired.changed, true);
  assert.equal(JSON.parse(repaired.text).content, "Don't worry\nsecond line\n");

  // A body that IS a Windows path keeps its backslashes — JSON would otherwise
  // read `\n` as a line break and silently corrupt `C:\new\file.txt`.
  const win = String.raw`{"path": "w.txt", "content": "C:\Users\me\notes.txt"}`;
  assert.equal(JSON.parse(repairJsonText(win).text).content, String.raw`C:\Users\me\notes.txt`);
  // Anywhere else, \n is a line break and a lone backslash is kept as text.
  const mixed = String.raw`{"path": "m.txt", "content": "line one\ntext with C:\Users\me in it\nend\n"}`;
  assert.equal(
    JSON.parse(repairJsonText(mixed).text).content,
    'line one\ntext with ' + String.raw`C:\Users\me` + ' in it\nend\n'
  );
});

test('recoverBody keeps a file body whose call lost its path', async () => {
  const { tools } = await setup();
  const body = 'line one\nline two\nline three\n';
  const got = tools.recoverBody('write_file', JSON.stringify({ content: body, language: 'text' }));
  assert.equal(got.content, body);
  assert.equal(got.truncated, false);
  assert.equal(tools.recoverBody('write_file', JSON.stringify({ file_content: body })).content, body, 'an alias key works');
  assert.equal(tools.recoverBody('write_file', '{"content": "just one line"}'), null, 'one stray line is noise');
  assert.equal(tools.recoverBody('run_command', '{"command": "ls"}'), null, 'not this tool');

  const cut = JSON.stringify({ content: body + 'half' }).slice(0, -6);
  const t = tools.recoverBody('write_file', cut);
  assert.equal(t.truncated, true, 'a cut-off body is flagged');
  assert.match(t.content, /line three/);
});

test('a path with a typo is answered with the names that exist', async () => {
  const { run, ws } = await setup();
  await ws.writeText(await ws.resolve('app.js'), 'x\n');
  await ws.writeText(await ws.resolve('notes.txt'), 'x\n');
  await ws.mkdirp(await ws.resolve('src'));
  await ws.writeText(await ws.resolve('src/app.js'), 'y\n');

  const miss = await run('read_file', { path: 'app.ts' });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /File not found: app\.ts/);
  assert.match(miss.error, /Did you mean "app\.js"\?/);

  // inside a folder the suggestion stays a full, workspace-relative path
  const nested = await run('read_file', { path: 'src/app.ts' });
  assert.match(nested.error, /Did you mean "src\/app\.js"\?/);

  const dir = await run('list_dir', { path: 'sr' });
  assert.equal(dir.ok, false);
  assert.match(dir.error, /Did you mean "src\/"\?/);

  const edit = await run('edit_file', { path: 'notes.tx', old_string: 'x', new_string: 'y' });
  assert.match(edit.error, /Did you mean "notes\.txt"\?/);

  // a path that exists but is the wrong kind gets no pointless suggestion
  const isDir = await run('read_file', { path: 'src' });
  assert.match(isDir.error, /is a directory, not a file/);
  assert.ok(!/Did you mean/.test(isDir.error));

  // nothing similar in the folder: the error stays plain
  const far = await run('read_file', { path: 'zzzz-qwerty.txt' });
  assert.ok(!/Did you mean/.test(far.error));
});

test('a broken regular expression is reported as such, not as "no matches"', async () => {
  const { run, ws } = await setup();
  await ws.writeText(await ws.resolve('a.txt'), 'value (x) here\nplain line\n');

  const bad = await run('grep_search', { pattern: '([' });
  assert.equal(bad.ok, true);
  assert.match(bad.output, /not a valid regular expression/);
  assert.match(bad.output, /literal/);

  // a search for text that really contains those characters still finds it
  const lit = await run('grep_search', { pattern: '(x)' });
  assert.match(lit.output, /value \(x\) here/);

  // a valid regex says nothing about literal matching
  const ok = await run('grep_search', { pattern: 'va\\w+' });
  assert.match(ok.output, /value \(x\) here/);
  assert.ok(!/literal/.test(ok.output));
});

test('run_command understands "timeout" as timeout_seconds', async () => {
  if (isWin) return;
  const { run } = await setup();
  const r = await run('run_command', { command: 'sleep 3', timeout: 1 });
  assert.equal(r.ui.timedOut, true, 'the timeout was applied');
  assert.match(r.output, /timed out after 1s/);
  assert.equal(r.failedSoft, true, 'a killed command is information, not a failure streak');
});

test('move_file records the file it produced, so the run knows what it made', async () => {
  const { run, ws, ctx } = await setup();
  await ws.writeText(await ws.resolve('.danav-recovered/draft.txt'), 'restored page\nsecond line\n');

  const moved = await run('move_file', { from: '.danav-recovered/draft.txt', to: 'index.html' });
  assert.equal(moved.ok, true);
  assert.equal(moved.ui.to, 'index.html');
  assert.equal(ctx.state.changed.has('index.html'), true, 'the new file is part of this run');
  assert.match((await ws.readText(await ws.resolve('index.html'))).text, /restored page/);

  // a rename onto an existing file is a change too, but it is not a new file
  ctx.state.changed.clear();
  await run('move_file', { from: 'index.html', to: 'index.html.bak' });
  assert.equal(ctx.state.changed.has('index.html.bak'), true);
});
