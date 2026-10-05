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
import { checkAction, createLedger, fileVersion, observeFile, observeFileRange, observeListing, observeOwned, removalTargets } from '../../server/agent/policy.js';

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
  const read = async (rel) => observeFile(state, await ws.safePath(rel), { complete: true });
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

test('a remove of a file that was never opened is looked at first, then allowed', async () => {
  const { gate, root, read, state, ws } = await setup({ 'notes.txt': 'secret\n' });
  const looked = await gate('run_command', remove('notes.txt', false));
  // The run answers the gate's own question: it reads the file, and says so in
  // the result the model reads. Nothing is refused that a look would allow.
  assert.equal(looked?.allow, true, 'the removal is allowed after the look');
  assert.match(looked.note, /Looked first/);
  assert.match(looked.note, /read `notes.txt`/);
  assert.ok(exists(path.join(root, 'notes.txt')), 'the gate itself touches nothing');
  assert.ok(state.ledger.seen.has(await ws.safePath('notes.txt')), 'and the ledger now knows the file');

  // Having read it is enough on its own.
  await read('notes.txt');
  assert.equal(await gate('run_command', remove('notes.txt', false)), null);
});

test('a file too big to look at is still refused, with the reason', async () => {
  const { gate, root, read } = await setup({});
  fs.writeFileSync(path.join(root, 'huge.bin'), Buffer.alloc(3 * 1024 * 1024, 0x41));
  const blocked = await gate('run_command', remove('huge.bin', false));
  assert.ok(blocked && !blocked.allow, 'a file the run cannot look at is not one it may remove');
  assert.match(blocked.message, /not been inspected/);
  assert.match(blocked.message, /huge\.bin/);

  // The model can still do it properly by reading the file itself.
  await read('huge.bin');
  assert.equal(await gate('run_command', remove('huge.bin', false)), null);
});

test('a folder that was never listed is listed first, and then allowed', async () => {
  const { gate, root, list } = await setup({ 'legacy/a.js': 'a\n', 'legacy/b.js': 'b\n' });
  const looked = await gate('run_command', remove('legacy'));
  assert.equal(looked?.allow, true);
  assert.match(looked.note, /listed `legacy\/` — 2 files/);
  assert.ok(exists(path.join(root, 'legacy', 'a.js')), 'the gate only looks');

  await list('legacy');
  assert.equal(await gate('run_command', remove('legacy')), null);
});

test('a nested folder is reached by the automatic look, and named in it', async () => {
  const { gate, list } = await setup({ 'app/index.js': 'x\n', 'app/deep/inner.js': 'y\n' });
  await list('app'); // depth 1: `deep/` is a name, not a contents
  const looked = await gate('run_command', remove('app'));
  assert.equal(looked?.allow, true, 'the deeper listing settles it');
  assert.match(looked.note, /listed `app(\/deep)?\/`/, 'the folder the run had never reached into is listed');
  assert.match(looked.note, /inner\.js/, 'the nested file is in the note, so the model has seen it');

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
  const looked = await gate('run_command', remove('node_modules'));
  assert.equal(looked?.allow, true, 'the look is the whole story for a generated folder');
  await list('node_modules');
  assert.equal(await gate('run_command', remove('node_modules')), null);
  assert.equal(await gate('run_command', { command: 'rm -rf node_modules' }), null);
});

test('overwriting or appending to an existing file requires its contents, not just its name', async () => {
  const { gate, root, list, read, state, ws } = await setup({ 'src/config.json': '{\n  "keep": true\n}\n' });
  try {
    const abs = await ws.safePath('src/config.json');
    const original = fs.readFileSync(abs, 'utf8');
    const forged = await gate('write_file', { path: 'src/config.json', content: 'forged\n', _originalExisted: false });
    assert.ok(forged && !forged.allow, 'model-supplied internal stream metadata cannot bypass the read gate');
    assert.equal(fs.readFileSync(abs, 'utf8'), original);
    const first = await gate('write_file', { path: 'src/config.json', content: '{"replace": true}\n' });
    assert.ok(first && !first.allow, 'an uninspected overwrite is stopped before it runs');
    assert.match(first.message, /complete contents.*read_file/);
    assert.equal(fs.readFileSync(abs, 'utf8'), original);

    await list('src');
    assert.ok(await gate('write_file', { path: 'src/config.json', content: 'replacement\n' }), 'a listing shows the path, not its contents');
    assert.ok(await gate('append_file', { path: 'src/config.json', content: 'more\n' }), 'append is guarded too');

    await read('src/config.json');
    assert.equal(await gate('write_file', { path: 'src/config.json', content: 'replacement\n' }), null);
    assert.equal(await gate('append_file', { path: 'src/config.json', content: 'more\n' }), null);

    const generated = await ws.safePath('src/generated.txt');
    observeOwned(state, generated);
    assert.equal(await gate('append_file', { path: 'src/generated.txt', content: 'more\n' }), null, 'a file this run created is already known');

    const streamed = await ws.safePath('src/streamed.txt');
    fs.writeFileSync(streamed, 'partial live stream\n');
    assert.ok(await gate('write_file', { path: 'src/streamed.txt', _originalExisted: false }), 'internal metadata alone cannot bypass inspection');
    observeOwned(state, streamed); // the real live writer records ownership after its first successful write
    assert.equal(await gate('write_file', { path: 'src/streamed.txt', _originalExisted: false }), null, 'an actually created streaming file is already owned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a versioned read stops authorizing whole-file writes after the file changes', async () => {
  const original = 'setting = original\n';
  const { gate, root, state, ws } = await setup({ 'settings.conf': original });
  try {
    const abs = await ws.safePath('settings.conf');
    observeFile(state, abs, { complete: true, version: fileVersion(original) });
    fs.writeFileSync(abs, 'setting = edited elsewhere\n');

    const stale = await gate('write_file', { path: 'settings.conf', content: 'replacement\n' });
    assert.ok(stale && !stale.allow, 'a complete but stale read does not authorize replacement');
    assert.match(stale.message, /changed after the version you read/);
    const staleAppend = await gate('append_file', { path: 'settings.conf', content: 'more\n' });
    assert.ok(staleAppend && !staleAppend.allow, 'a stale complete read cannot authorize an append either');
    assert.equal(fs.readFileSync(abs, 'utf8'), 'setting = edited elsewhere\n', 'the external change remains untouched');

    const current = fs.readFileSync(abs, 'utf8');
    observeFile(state, abs, { complete: true, version: fileVersion(current) });
    assert.equal(await gate('write_file', { path: 'settings.conf', content: 'replacement\n' }), null, 'reading the new version restores permission');
    assert.equal(await gate('append_file', { path: 'settings.conf', content: 'more\n' }), null, 'the matching current version also permits an append');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('outlines and partial ranges do not authorize a full overwrite; complete ranges do', async () => {
  const original = 'one\ntwo\nthree\n';
  const { gate, root, state, ws } = await setup({ 'src/large.txt': original });
  try {
    const abs = await ws.safePath('src/large.txt');
    const version1 = fileVersion(original);
    observeFile(state, abs, { version: version1 }); // file_outline sees structure, not the full body
    assert.ok(await gate('write_file', { path: 'src/large.txt', content: 'replacement\n' }));

    assert.equal(observeFileRange(state, abs, { startLine: 1, endLine: 1, totalLines: 3, version: version1 }), false);
    assert.ok(await gate('append_file', { path: 'src/large.txt', content: 'more\n' }), 'a partial read is not complete contents');
    assert.equal(observeFileRange(state, abs, { startLine: 2, endLine: 3, totalLines: 3, version: version1 }), true);
    assert.equal(await gate('write_file', { path: 'src/large.txt', content: 'replacement\n' }), null, 'all visible ranges together cover the file');

    // A changed file invalidates old coverage; ranges from two versions cannot combine.
    const changed = 'ONE\ntwo\nthree\n';
    fs.writeFileSync(abs, changed);
    const version2 = fileVersion(changed);
    assert.equal(observeFileRange(state, abs, { startLine: 1, endLine: 1, totalLines: 3, version: version2 }), false);
    assert.ok(await gate('write_file', { path: 'src/large.txt', content: 'stale replacement\n' }));
    assert.equal(observeFileRange(state, abs, { startLine: 2, endLine: 3, totalLines: 3, version: version2 }), true);
    assert.equal(await gate('append_file', { path: 'src/large.txt', content: 'more\n' }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a truncated recursive listing cannot certify a whole folder as inspected', async () => {
  const files = Object.fromEntries(Array.from({ length: 1105 }, (_, i) => [`large/f${String(i).padStart(4, '0')}.txt`, 'x\n']));
  const { gate, root, state, ws } = await setup(files);
  try {
    const abs = await ws.safePath('large');
    const listing = await ws.listTree(abs, { depth: 1, maxEntries: 1000 });
    assert.equal(listing.truncated, true, 'the fixture exceeds the gate listing cap');
    observeListing(ws, state, abs, listing.entries, { truncated: listing.truncated, depth: 1 });

    const blocked = await gate('run_command', remove('large'));
    assert.ok(blocked && !blocked.allow, 'the omitted tail is not silently treated as inspected');
    assert.match(blocked.message, /listing came back incomplete/);
    assert.ok(exists(path.join(root, 'large/f1104.txt')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a tree too big for the automatic look is refused, with the reason', async () => {
  const { ws, state, gate } = await setup(Object.fromEntries(
    Array.from({ length: 320 }, (_, i) => [`big/f${i}.js`, 'x\n'])
  ));
  const abs = await ws.safePath('big');
  const { entries, truncated } = await ws.listTree(abs, { depth: 1, maxEntries: 300 });
  assert.equal(truncated, true, 'the fixture really does overflow a shallow listing');
  observeListing(ws, state, abs, entries, { truncated, depth: 1 });
  // The folder is listed, but the files the shallow listing never reached were not
  // seen — and the automatic look cannot fix that here, because the tree is also
  // wider than the look's own limit. So the gate refuses and says what to do.
  const blocked = await gate('run_command', remove('big'));
  assert.ok(blocked && !blocked.allow, 'an incomplete listing is not an inspection');
  assert.match(blocked.message, /not been inspected/);
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

test('a move looks at both sides — the file it takes and the file it lands on', async () => {
  const { gate, read } = await setup({ 'a.txt': 'a\n', 'keep.txt': 'precious\n' });

  // The source is looked at first: the model is told what it is moving.
  const looked = await gate('run_command', { command: 'mv a.txt b.txt' });
  assert.equal(looked?.allow, true);
  assert.match(looked.note, /read `a\.txt`/);

  // The destination matters just as much: `mv a.txt keep.txt` throws keep.txt away,
  // so that file is read before the command is allowed.
  const clobber = await gate('run_command', { command: 'mv a.txt keep.txt' });
  assert.equal(clobber?.allow, true);
  assert.match(clobber.note, /read `keep\.txt`/, 'the file that would be replaced was read first');

  // Once both sides have been looked at, no note is needed.
  await read('a.txt');
  await read('keep.txt');
  assert.equal(await gate('run_command', { command: 'mv a.txt keep.txt' }), null);
  assert.equal(await gate('run_command', { command: 'mv a.txt b.txt' }), null);

  // A source that is not there is the shell's business.
  assert.equal(await gate('run_command', { command: 'mv somewhere b.txt' }), null);

  // ...and the workspace itself is never the operand.
  const root = await gate('run_command', { command: 'mv . b.txt' });
  assert.ok(root && !root.allow);
  assert.match(root.message, /workspace itself/);
});

test('a shell command that removes un-inspected files looks first, then runs', async () => {
  const { gate, read, list } = await setup({ 'src/app.js': 'x\n', 'src/util.js': 'y\n' });
  // Not a removing command: untouched.
  assert.equal(await gate('run_command', { command: 'node src/app.js' }), null);
  // Nothing there to lose: untouched (the shell's own error is the honest answer).
  assert.equal(await gate('run_command', { command: 'rm -rf nowhere' }), null);

  const looked = await gate('run_command', { command: 'rm -rf src' });
  assert.equal(looked?.allow, true, 'the run lists the folder rather than being refused');
  assert.match(looked.note, /listed `src\/` — 2 files/);
  assert.match(looked.note, /app\.js/, 'the files it is about to remove are named in the result');

  // A file the run has read stays seen; listing the folder is inspecting it.
  await read('src/app.js');
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
