/**
 * The look-before-you-leap gate.
 *
 * The rule this file pins down is deliberately blunt: a call that would remove
 * or move something the agent has never looked at does not run, and the agent is
 * told exactly what to look at instead. It is enforced in code, not asked for in
 * the system prompt — a prompt cannot make a model obey, and "it deleted a folder
 * it had never opened" is a missing invariant, not a wording problem.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalWorkspace } from '../../server/agent/workspaces/local.js';
import { checkAction, createLedger, observeFile, observeListing, observeOwned, removalTargets } from '../../server/agent/policy.js';

const { test } = globalThis.__agentTest;

console.log('\n[look before you leap]');

const isWin = process.platform === 'win32';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function setup(files) {
  const root = tmp('danav-policy-');
  const ws = new LocalWorkspace({ id: 'ws-policy', kind: 'local', name: 'policy', root, autoRun: true });
  await ws.init();
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  const state = { ledger: createLedger() };
  /** Run the gate the way the loop does. */
  const gate = (name, args) => checkAction({ workspace: ws, state, name, args });
  /** What the agent "looks at" — the same calls the tools make. */
  const list = async (rel, depth = 1) => {
    const abs = await ws.safePath(rel);
    const { entries, truncated } = await ws.listTree(abs, { depth, maxEntries: 300 });
    observeListing(ws, state, abs, entries, { truncated, depth });
  };
  const read = async (rel) => observeFile(state, await ws.safePath(rel));
  return { ws, root, state, gate, list, read };
}

const exists = (p) => fs.existsSync(p);

/**
 * Removal is a shell job now (`delete_file` was retired), so the gate is
 * exercised through the command the agent actually runs.
 */
const remove = (target, recursive = true) => ({
  command: isWin
    ? `${recursive ? 'Remove-Item -Recurse -Force' : 'Remove-Item -Force'} ${target}`
    : `rm ${recursive ? '-rf' : '-f'} ${target}`,
});

// ---------------------------------------------------------------------------

test('removalTargets only claims paths it can actually resolve', () => {
  assert.deepEqual(removalTargets('rm -rf src/legacy'), ['src/legacy']);
  assert.deepEqual(removalTargets('Remove-Item -Recurse -Force build'), ['build']);
  assert.deepEqual(removalTargets('rm -r a b c'), ['a', 'b', 'c']);
  // Not a removing command at all — nothing to second-guess.
  assert.deepEqual(removalTargets('npm run build'), []);
  assert.deepEqual(removalTargets('git status'), []);
  // Globs, substitutions and switches cannot be resolved, so they are skipped
  // rather than guessed at: an unrecognised command is never blocked by mistake.
  assert.deepEqual(removalTargets('rm -rf *'), []);
  assert.deepEqual(removalTargets('rm -rf $(cat list.txt)'), []);
  // A `del /s /q <path>` switch is not a path; the path after it is.
  assert.deepEqual(removalTargets('del /s /q C:\\temp'), ['C:\\temp']);
  // The same command with a real path is still caught.
  assert.deepEqual(removalTargets('rm -rf * && rm -rf real-dir'), ['real-dir']);
});

test('a file that was never opened cannot be deleted', async () => {
  const { gate, root, read } = await setup({ 'notes.txt': 'secret\n' });
  const blocked = await gate('run_command', remove('notes.txt', false));
  assert.ok(blocked, 'the delete is refused');
  assert.match(blocked.message, /has not been inspected in this run/);
  assert.match(blocked.message, /read `notes.txt`/, 'and it says what to do about it');
  assert.equal(blocked.ui.blocked, true);
  assert.ok(exists(path.join(root, 'notes.txt')), 'and nothing was touched');

  // Having read it is enough.
  await read('notes.txt');
  assert.equal(await gate('run_command', remove('notes.txt', false)), null);
});

test('a folder the agent never listed cannot be deleted recursively', async () => {
  const { gate, root, list } = await setup({ 'legacy/a.js': 'a\n', 'legacy/b.js': 'b\n' });
  const blocked = await gate('run_command', remove('legacy'));
  assert.ok(blocked);
  assert.match(blocked.message, /has not been inspected in this run/);
  assert.match(blocked.message, /list `legacy\/`/);
  assert.ok(exists(path.join(root, 'legacy', 'a.js')));

  // Listing it is enough — but only once the WHOLE tree has been seen.
  await list('legacy');
  assert.equal(await gate('run_command', remove('legacy')), null);
});

test('a nested folder is still un-inspected after only the top level was listed', async () => {
  const { gate, list } = await setup({ 'app/index.js': 'x\n', 'app/deep/inner.js': 'y\n' });
  await list('app'); // depth 1: `deep/` is a name, not a contents
  const blocked = await gate('run_command', remove('app'));
  assert.ok(blocked, 'listing a folder is not listing what is inside its folders');
  assert.match(blocked.message, /app\/deep/);
  assert.match(blocked.message, /list `app\/deep\/`/);

  await list('app', 3);
  assert.equal(await gate('run_command', remove('app')), null);
});

test('folders the listing itself skips are not demanded of the agent', async () => {
  const { gate, list } = await setup({
    'proj/index.js': 'x\n',
    'proj/node_modules/pkg/index.js': 'nested\n',
    'proj/dist/bundle.js': 'built\n',
  });
  // list_dir never descends into node_modules / dist, so neither does the gate:
  // asking for a listing the tool refuses to produce would loop forever.
  await list('proj', 4);
  assert.equal(await gate('run_command', remove('proj')), null);
});

test('a generated folder needs one look, not a tour of every package', async () => {
  const { gate, list } = await setup({
    'node_modules/a/index.js': 'a\n',
    'node_modules/b/nested/index.js': 'b\n',
  });
  // Even the target itself: nobody reads every package to delete node_modules.
  const blocked = await gate('run_command', remove('node_modules'));
  assert.ok(blocked, 'but it still has to look at what it is removing');
  await list('node_modules');
  assert.equal(await gate('run_command', remove('node_modules')), null);
  assert.equal(await gate('run_command', { command: 'rm -rf node_modules' }), null);
});

test('a truncated listing proves nothing about the folders it cut off', async () => {
  const { ws, state, gate } = await setup(Object.fromEntries(
    Array.from({ length: 320 }, (_, i) => [`big/f${i}.js`, 'x\n'])
  ));
  const abs = await ws.safePath('big');
  const { entries, truncated } = await ws.listTree(abs, { depth: 1, maxEntries: 300 });
  assert.equal(truncated, true, 'the fixture really does overflow the listing');
  observeListing(ws, state, abs, entries, { truncated, depth: 1 });
  // The folder is marked as listed (its own entries were read), but the file the
  // listing never got to is not — so the delete is still refused.
  const blocked = await gate('run_command', remove('big'));
  assert.ok(blocked, 'an incomplete listing is not an inspection');
  assert.match(blocked.message, /big\/f\d+\.js/);
});

test('the agent may remove what it created itself', async () => {
  const { gate, state, ws } = await setup({});
  const abs = await ws.safePath('scratch.txt');
  observeOwned(state, abs);
  assert.equal(await gate('run_command', remove('scratch.txt', false)), null, 'it does not have to read back its own file');
  // A folder it made is known to be empty.
  const dir = await ws.safePath('scratch');
  observeListing(ws, state, dir, [], { depth: 1 });
  assert.equal(await gate('run_command', remove('scratch')), null);
});

test('a move is refused for a file that was never opened, and for a destination that was', async () => {
  const { gate, read } = await setup({ 'a.txt': 'a\n', 'keep.txt': 'precious\n' });

  // The source: nothing moved that the run has never seen.
  const blocked = await gate('run_command', { command: 'mv a.txt b.txt' });
  assert.ok(blocked);
  assert.match(blocked.message, /has not been inspected in this run/);
  assert.match(blocked.message, /read `a.txt`/);

  // The destination matters just as much: `mv a.txt keep.txt` throws keep.txt away.
  await read('a.txt');
  const clobber = await gate('run_command', { command: 'mv a.txt keep.txt' });
  assert.ok(clobber, 'moving onto an unread file is refused');
  assert.match(clobber.message, /read `keep.txt`/);

  // Once both sides have been looked at, the move goes through.
  await read('keep.txt');
  assert.equal(await gate('run_command', { command: 'mv a.txt keep.txt' }), null);
  assert.equal(await gate('run_command', { command: 'mv a.txt b.txt' }), null);

  // A directory has to have been listed, not just named.
  const dirMove = await gate('run_command', { command: 'mv somewhere b.txt' });
  assert.equal(dirMove, null, 'a source that is not there is the shell\'s business');

  // ...and the workspace itself is never the operand.
  const root = await gate('run_command', { command: 'mv . b.txt' });
  assert.ok(root);
  assert.match(root.message, /workspace itself/);
});

test('a shell command that removes un-inspected files is refused', async () => {
  const { gate, read, list } = await setup({ 'src/app.js': 'x\n', 'src/util.js': 'y\n' });
  // Not a removing command: untouched.
  assert.equal(await gate('run_command', { command: 'node src/app.js' }), null);
  // Nothing there to lose: untouched (the shell's own error is the honest answer).
  assert.equal(await gate('run_command', { command: 'rm -rf nowhere' }), null);

  const blocked = await gate('run_command', { command: 'rm -rf src' });
  assert.ok(blocked, 'a folder the agent never listed is not a folder it may rm');
  assert.match(blocked.message, /src\//);
  assert.match(blocked.message, /list `src\/`/, 'and it is told to list the folder, not to read it');

  await read('src/app.js');
  const stillBlocked = await gate('run_command', { command: 'rm -rf src' });
  assert.ok(stillBlocked, 'reading one file is not inspecting the folder');

  // Listing the folder IS inspecting it: every file inside came back named.
  await list('src');
  assert.equal(await gate('run_command', { command: 'rm -rf src' }), null);
});

test('a command that would remove the workspace itself is refused', async () => {
  const { gate, list, root } = await setup({ 'a.txt': 'a\n' });
  // Listing everything does not make the workspace itself a legal target.
  await list('.', 2);
  for (const command of ['rm -rf .', 'rm -rf ./', `rm -rf ${root}`]) {
    const blocked = await gate('run_command', { command });
    assert.ok(blocked, `${command} is refused`);
    assert.match(blocked.message, /workspace itself/);
  }
  assert.ok(exists(path.join(root, 'a.txt')), 'and nothing was touched');
});

test('a non-destructive call is never in the gate’s way', async () => {
  const { gate } = await setup({ 'a.txt': 'a\n' });
  for (const [name, args] of [
    ['read_file', { path: 'a.txt' }],
    ['write_file', { path: 'new.txt', content: 'x' }],
    ['list_dir', {}],
    ['grep_search', { pattern: 'a' }],
    ['get_preview_url', { port: 3000 }],
  ]) {
    assert.equal(await gate(name, args), null, `${name} is allowed through`);
  }
  // A missing target is the tool's business, not the gate's.
  assert.equal(await gate('run_command', remove('never-existed.txt')), null);
  assert.equal(await gate('run_command', remove('../outside.txt')), null);
});

test('the ledger survives a path spelled the Windows way', async () => {
  if (!isWin) return;
  const { gate, read } = await setup({ 'dir/file.txt': 'x\n' });
  await read('dir\\file.txt');
  assert.equal(await gate('run_command', remove('dir/file.txt', false)), null);
});
