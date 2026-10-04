/**
 * The project's history, and the project's own checks.
 *
 * Two systems that answer questions an agent cannot answer from the current tree
 * alone: "why is this code like this?" (git log / blame / diff, read-only) and
 * "does this change actually work?" (the checks the project declares, run in one
 * call with the failure extracted rather than poured into the context).
 *
 * Everything here runs against a real repository in a temp folder, created and
 * committed in the test, so the assertions are about behaviour rather than about
 * the shape of a command line.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalWorkspace } from '../../server/agent/workspaces/local.js';
import { buildToolset, pickFailureLines, READ_ONLY_TOOLS, TOOL_DEFINITIONS } from '../../server/agent/tools.js';
import { createRedactor } from '../../server/agent/util.js';
import { formatRepoState, gitBlame, readRepoState } from '../../server/agent/githistory.js';
import { detectChecks, formatChecksHint } from '../../server/agent/verify.js';

const { test } = globalThis.__agentTest;
console.log('\n[git + checks]');

const GIT_ID = ['-c', 'user.email=test@danav.local', '-c', 'user.name=Test'];

async function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-git-'));
  const write = (rel, text) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('src/theme.ts', `export function toggleTheme(current) {\n  return current === 'dark' ? 'light' : 'dark';\n}\n`);
  write('src/app.ts', `import { toggleTheme } from './theme';\nexport const start = () => toggleTheme('light');\n`);
  write('package.json', JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { typecheck: 'node -e "process.exit(0)"' } }, null, 2));
  const ws = new LocalWorkspace({ id: 'ws-git', kind: 'local', name: 'git', root, autoRun: true });
  await ws.init();
  await ws.exec(`git init -q -b main`);
  await ws.exec(`git add -A`);
  await ws.exec(`git ${GIT_ID.join(' ')} commit -q -m "first commit: the theme helper"`);
  return { root, ws, write };
}

function toolsetFor(ws) {
  const tools = buildToolset({
    workspace: ws,
    runSearchTool: async () => ({ success: false, error: 'offline' }),
    redact: createRedactor(),
    lookup: async () => [],
    probe: async () => ({}),
  });
  const ctx = { signal: undefined, emit: () => {}, approve: async () => true, state: { readFiles: new Set(), plan: [], changed: new Map() } };
  return { run: (name, args) => tools.execute(name, args, ctx), ctx };
}

test('the repository state is read once and handed to the model as context', async () => {
  const { root, ws, write } = await makeRepo();
  try {
    const clean = await readRepoState(ws);
    assert.equal(clean.branch, 'main');
    assert.ok(clean.head?.sha, 'HEAD is resolved');
    assert.match(clean.head.subject, /first commit/);
    assert.equal(clean.clean, true);
    assert.equal(clean.recent.length, 1);

    const block = formatRepoState(clean);
    assert.match(block, /branch main/);
    assert.match(block, /Working tree clean/);
    assert.match(block, /first commit: the theme helper/);
    assert.match(block, /repo_history view="log"/, 'the model is told which tool answers the deeper questions');

    // One uncommitted edit changes what the block says.
    write('src/theme.ts', `export function toggleTheme(current) {\n  return current === 'dark' ? 'dark' : 'light';\n}\nexport const THEME_KEY = 'danav-theme';\n`);
    const dirty = await readRepoState(ws);
    assert.equal(dirty.clean, false);
    assert.equal(dirty.dirty.modified, 1);
    assert.match(formatRepoState(dirty), /Uncommitted: 1 modified/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace with no repository says so instead of failing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-nogit-'));
  try {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'hello\n');
    const ws = new LocalWorkspace({ id: 'ws-nogit', kind: 'local', name: 'nogit', root, autoRun: true });
    await ws.init();
    const { run } = toolsetFor(ws);

    assert.equal(await readRepoState(ws), null);
    assert.equal(formatRepoState(null), '', 'no repository means no prompt section');

    const status = await run('repo_status', {});
    assert.match(status.output, /not a git repository/i);
    const history = await run('repo_history', { view: 'log' });
    assert.match(history.output, /not a git repository/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repo_status reports branch, uncommitted files and recent commits', async () => {
  const { root, ws, write } = await makeRepo();
  try {
    write('src/extra.ts', 'export const extra = 1;\n');
    write('src/theme.ts', `export function toggleTheme(current) {\n  return current === 'dark' ? 'light' : 'dark';\n}\nexport const THEME_KEY = 'x';\n`);
    const { run } = toolsetFor(ws);

    const res = await run('repo_status', {});
    assert.match(res.output, /branch main/);
    assert.match(res.output, /1 modified, 1 untracked/, 'both kinds of change are counted');
    assert.match(res.output, /M src\/theme\.ts/);
    assert.match(res.output, /\?\? src\/extra\.ts/);
    assert.match(res.output, /first commit: the theme helper/);
    assert.equal(res.ui.repo, true);
    assert.equal(res.ui.dirty, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repo_history log answers "when and why did this file change"', async () => {
  const { root, ws, write } = await makeRepo();
  try {
    write('src/theme.ts', `export function toggleTheme(current) {\n  return current === 'dark' ? 'light' : 'dark';\n}\nexport const THEME_KEY = 'danav-theme';\n`);
    await ws.exec(`git add -A`);
    await ws.exec(`git ${GIT_ID.join(' ')} commit -q -m "remember the last theme choice"`);

    const { run } = toolsetFor(ws);
    const res = await run('repo_history', { view: 'log', path: 'src/theme.ts' });
    assert.match(res.output, /Commits touching src\/theme\.ts/);
    assert.match(res.output, /remember the last theme choice/);
    assert.match(res.output, /first commit: the theme helper/);
    assert.equal(res.ui.count, 2);

    const other = await run('repo_history', { view: 'log', path: 'package.json' });
    assert.match(other.output, /first commit: the theme helper/);
    assert.ok(!/remember the last theme choice/.test(other.output), 'a file only shows the commits that touched it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repo_history blame groups a symbol by the commit that last changed it', async () => {
  const { root, ws, write } = await makeRepo();
  try {
    write('src/theme.ts', `export function toggleTheme(current) {\n  if (current === 'dark') return 'light';\n  return 'dark';\n}\n`);
    await ws.exec(`git add -A`);
    await ws.exec(`git ${GIT_ID.join(' ')} commit -q -m "split the toggle for readability"`);

    const { run } = toolsetFor(ws);
    const res = await run('repo_history', { view: 'blame', path: 'src/theme.ts', symbol: 'toggleTheme' });
    assert.match(res.output, /Who last changed src\/theme\.ts lines \d+-\d+ \(`toggleTheme`\)/);
    assert.match(res.output, /split the toggle for readability/, 'the commit message is the answer to "why"');
    assert.match(res.output, /L\d+(-\d+)? \(\d+ lines?\)/);
    assert.equal(res.ui.blocks >= 1, true);

    // Blame works from line numbers too, and a bad range is a message, not a crash.
    const byLines = await run('repo_history', { view: 'blame', path: 'src/theme.ts', line_start: 1, line_end: 3 });
    assert.match(byLines.output, /lines 1-3/);
    const bad = await run('repo_history', { view: 'blame', path: 'src/theme.ts', line_start: 900, line_end: 950 });
    assert.match(bad.output, /Error:/);
    assert.match(bad.output, /file_outline|lines/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repo_history diff shows the agent its own uncommitted work', async () => {
  const { root, ws, write } = await makeRepo();
  try {
    write('src/theme.ts', `export function toggleTheme(current) {\n  return current === 'dark' ? 'light' : 'dark';\n}\nexport const THEME_KEY = 'danav-theme';\n`);
    write('src/new-file.ts', 'export const brandNew = true;\n');
    const { run } = toolsetFor(ws);

    const res = await run('repo_history', { view: 'diff' });
    assert.match(res.output, /Uncommitted changes vs HEAD: 1 file/);
    assert.match(res.output, /src\/theme\.ts — \+1 −0/);
    assert.match(res.output, /\+export const THEME_KEY/, 'the hunk is there to review');
    assert.match(res.output, /Untracked \(not in the diff\): src\/new-file\.ts/, 'untracked work is named, since diff cannot show it');
    assert.equal(res.ui.files, 1);

    // Staged-only view sees nothing here: nothing was staged.
    const staged = await run('repo_history', { view: 'diff', staged: true });
    assert.match(staged.output, /Nothing staged/);

    // A path filter narrows it.
    const scoped = await run('repo_history', { view: 'diff', path: 'src/new-file.ts' });
    assert.match(scoped.output, /Nothing uncommitted vs HEAD/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('raw git through the shell is answered with the tool that shapes it — once', async () => {
  const { root, ws } = await makeRepo();
  try {
    const { run, ctx } = toolsetFor(ws);
    const first = await run('run_command', { command: 'git log --oneline -3' });
    assert.match(first.output, /Tip: repo_history answers this in one shaped call/);
    assert.match(first.output, /view="blame"/);

    const second = await run('run_command', { command: 'git status --short' });
    assert.ok(!/Tip:/.test(second.output), 'the tip is said once per run, not after every git command');

    ctx.state.gitTipShown = false;
    const write = await run('run_command', { command: 'git commit --allow-empty -m "nope" -c user.email=x@y.z -c user.name=x' });
    assert.ok(!/Tip: repo_history/.test(write.output), 'a history-WRITING command gets no tip: there is no tool for that on purpose');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the history tools are read-only, in the toolset, and safe in parallel', async () => {
  const names = TOOL_DEFINITIONS.map((d) => d.function.name);
  for (const tool of ['repo_status', 'repo_history', 'run_checks']) {
    assert.ok(names.includes(tool), `${tool} is advertised to the model`);
  }
  assert.ok(READ_ONLY_TOOLS.has('repo_status') && READ_ONLY_TOOLS.has('repo_history'), 'history reads may run in parallel');
  assert.ok(!READ_ONLY_TOOLS.has('run_checks'), 'running checks is a command, not a read');
});

test('run_checks runs the project checks cheapest first and stops at the first failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-checks-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'checks-demo',
        version: '1.0.0',
        scripts: {
          test: 'node -e "console.error(\'AssertionError: expected 2 to equal 3\'); console.error(\'  at src/thing.test.js:12\'); process.exit(1)"',
          typecheck: 'node -e "console.log(\'types fine\')"',
        },
      })
    );
    const ws = new LocalWorkspace({ id: 'ws-checks', kind: 'local', name: 'checks', root, autoRun: true });
    await ws.init();
    const { run } = toolsetFor(ws);

    const res = await run('run_checks', {});
    // tsc/typecheck ranks first, tests second, and the run stops on the failure.
    assert.match(res.output, /typecheck — passed/);
    assert.match(res.output, /test — failed \(exit 1/);
    assert.match(res.output, /AssertionError: expected 2 to equal 3/, 'the failure, not the transcript');
    assert.match(res.output, /at src\/thing\.test\.js:12/);
    assert.equal(res.ok, false, 'a failing check is not a silent success');
    assert.equal(res.failedSoft, true, 'and it is information, not a dead tool');
    assert.deepEqual(
      res.runs.map((r) => [r.name, r.passed]),
      [['npm run typecheck', true], ['npm test', false]],
      'the cheapest check ran first, and the failure stopped the run'
    );
    assert.match(res.runs[1].diagnostic, /AssertionError: expected 2 to equal 3/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run_checks says when everything passes, and only= narrows it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-checks-ok-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'ok-demo', version: '1.0.0', scripts: { test: 'node -e "console.log(\'Tests 3 passed\')"', lint: 'node -e "console.log(\'0 problems\')"' } })
    );
    const ws = new LocalWorkspace({ id: 'ws-checks-ok', kind: 'local', name: 'ok', root, autoRun: true });
    await ws.init();
    const { run } = toolsetFor(ws);

    const all = await run('run_checks', {});
    assert.equal(all.ok, true);
    assert.match(all.output, /lint — passed/);
    assert.match(all.output, /test — passed/);
    assert.match(all.output, /Tests 3 passed/, 'a passing check carries its own summary line');
    assert.match(all.output, /All 2 checks passed/);
    assert.equal(all.runs.length, 2);
    assert.equal(all.ui.passed, true);

    const only = await run('run_checks', { only: 'lint' });
    assert.equal(only.runs.length, 1);
    assert.match(only.output, /lint — passed/);
    assert.ok(!/test —/.test(only.output), 'only= is respected');

    const missing = await run('run_checks', { only: 'playwright' });
    assert.match(missing.output, /Error: No detected check matches "playwright"/);
    assert.match(missing.output, /npm test/, 'and it names the checks that do exist');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a project that declares no test script gets the command inferred, and it runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-checks-inferred-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'inferred', version: '1.0.0' }));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'thing.test.js'),
      "const test = require('node:test');\nconst assert = require('node:assert');\ntest('adds', () => assert.equal(1 + 1, 2));\n"
    );
    const ws = new LocalWorkspace({ id: 'ws-checks-inferred', kind: 'local', name: 'inferred', root, autoRun: true });
    await ws.init();
    const { run } = toolsetFor(ws);

    // The prompt block says where the command came from, so the model is not
    // guessing at a runner it cannot see.
    const hint = formatChecksHint(await detectChecks(ws));
    assert.match(hint, /node --test/);
    assert.match(hint, /inferred/);
    assert.match(hint, /run_checks runs them all in one call/, 'and names the one call that runs them');

    const res = await run('run_checks', {});
    assert.match(res.output, /node --test/);
    assert.equal(res.ok, true, `the inferred runner really passes: ${res.output}`);
    assert.match(res.output, /All 1 check passed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace with no checks of its own is told what to do instead', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-checks-none-'));
  try {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'nothing to run here\n');
    const ws = new LocalWorkspace({ id: 'ws-checks-none', kind: 'local', name: 'none', root, autoRun: true });
    await ws.init();
    const { run } = toolsetFor(ws);

    const res = await run('run_checks', {});
    assert.equal(res.ok, true, 'no checks is not a failure');
    assert.match(res.output, /declares no checks of its own/);
    assert.match(res.output, /write the check you can actually run/);
    assert.equal(res.ui.commands, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failing check output is reduced to its errors', () => {
  const noisy = [
    '> vitest run',
    '',
    ' RUN  v1.6.0 /project',
    ' ✓ src/a.test.ts (3 tests) 12ms',
    ' ✓ src/b.test.ts (2 tests) 9ms',
    ' ❯ src/c.test.ts (2 tests | 1 failed) 21ms',
    '   × adds the totals',
    '     → expected 2 to be 3 // Object.is equality',
    '       at src/c.test.ts:14:19',
    ' Test Files  1 failed | 2 passed (3)',
    '      Tests  1 failed | 6 passed (7)',
  ].join('\n');
  const picked = pickFailureLines(noisy);
  assert.match(picked, /src\/c\.test\.ts/);
  assert.match(picked, /expected 2 to be 3/);
  assert.ok(picked.split('\n').length <= 45);
  // Nothing recognisable: the tail is still better than an empty answer.
  assert.match(pickFailureLines('just some\noutput here'), /output here/);
});
