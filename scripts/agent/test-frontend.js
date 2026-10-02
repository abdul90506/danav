/**
 * Frontend logic (TypeScript compiled on the fly with esbuild):
 * the chronological block state-machine, the wording of every action row, and
 * the whole data path SSE → blocks against the REAL backend + a scripted fake LLM.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { build } from 'esbuild';
import { startFakeLlm } from '../fake-llm.js';
import { registerAgentRoutes } from '../../server/agent/routes.js';
import { _resetStoreCache } from '../../server/agent/store.js';

const { test } = globalThis.__agentTest;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

console.log('\n[frontend logic]');

async function load(entry) {
  const out = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const { AgentTurnState } = await load('src/agent/turnState.ts');
const fmt = await load('src/agent/format.ts');
const icons = await load('src/agent/fileIcons.ts');

const act = (over) => ({ id: 'a1', tool: 'write_file', status: 'done', args: {}, ...over });

// ---------------------------------------------------------------------------
test('turn state keeps thinking → text → action → text in the order the model produced them', () => {
  let t = 1000;
  const s = new AgentTurnState(() => t);
  s.appendThinking('Let me think. ');
  s.appendThinking('Plan it.');
  t += 3200;
  s.appendText("I'll build the page.");
  s.applyAgentEvent({ type: 'action_start', id: 'a1', tool: 'write_file', args: { path: 'index.html' }, progress: { added: 3 } });
  s.appendText('\n\nNow the styles.'); // leading blank lines of a new paragraph are dropped
  s.applyAgentEvent({ type: 'action_start', id: 'a2', tool: 'write_file', args: { path: 'style.css' } });
  s.appendText('All done.');
  const snap = s.snapshot();
  assert.deepEqual(snap.blocks.map((b) => b.type), ['thinking', 'text', 'action', 'text', 'action', 'text']);
  assert.equal(snap.blocks[0].isStillThinking, false);
  assert.equal(snap.blocks[0].duration, 3);
  assert.equal(snap.blocks[0].content, 'Let me think. Plan it.');
  assert.equal(snap.blocks[3].content, 'Now the styles.');
  assert.equal(snap.content, "I'll build the page.\n\nNow the styles.\n\nAll done.");
  assert.equal(snap.thinkingContent, 'Let me think. Plan it.');
});

test('turn state: an action row is updated in place — progress, running, streamed output, end', () => {
  const s = new AgentTurnState(() => 5000);
  s.applyAgentEvent({ type: 'action_start', id: 'a1', tool: 'write_file', args: {}, progress: { added: 2, tail: ['a'] } });
  const get = () => s.snapshot().blocks[0].action;
  assert.equal(get().status, 'pending');
  s.applyAgentEvent({ type: 'action_update', id: 'a1', patch: { args: { path: 'index.html' }, progress: { added: 40, removed: 7, tail: ['x', 'y'] } } });
  assert.deepEqual([get().args.path, get().progress.added, get().progress.removed, get().progress.tail], ['index.html', 40, 7, ['x', 'y']]);
  s.applyAgentEvent({ type: 'action_update', id: 'a1', patch: { status: 'running' } });
  assert.equal(get().status, 'running');
  assert.equal(get().progress.added, 40, 'the last live numbers stay on screen while the tool runs');
  s.applyAgentEvent({ type: 'action_update', id: 'a1', patch: { outputAppend: 'line1\n' } });
  s.applyAgentEvent({ type: 'action_update', id: 'a1', patch: { outputAppend: 'line2\n' } });
  assert.equal(get().output, 'line1\nline2\n');
  s.applyAgentEvent({ type: 'action_end', id: 'a1', status: 'done', ok: true, result: { kind: 'write', added: 77 }, durationMs: 1200 });
  assert.equal(get().status, 'done');
  assert.equal(get().result.added, 77);
  assert.equal(get().approval, null);
  assert.equal(s.snapshot().blocks.length, 1);
});

test('turn state: terminal output is bounded, duplicates and unknown events are ignored, notices stay out of the text', () => {
  const s = new AgentTurnState();
  s.applyAgentEvent({ type: 'action_start', id: 'a1', tool: 'run_command', args: {} });
  s.applyAgentEvent({ type: 'action_start', id: 'a1', tool: 'run_command', args: {} });
  s.applyAgentEvent({ type: 'action_update', id: 'ghost', patch: { status: 'running' } });
  s.applyAgentEvent({ type: 'something_new', x: 1 });
  s.applyAgentEvent({ type: 'action_update', id: 'a1', patch: { outputAppend: 'x'.repeat(30_000) + 'END' } });
  s.applyAgentEvent({ type: 'notice', message: 'The sandbox was recreated.' });
  const snap = s.snapshot();
  assert.equal(snap.blocks.filter((b) => b.type === 'action').length, 1);
  const a = snap.blocks[0].action;
  assert.equal(a.output.length, 20_000);
  assert.ok(a.output.endsWith('END'), 'the tail is kept');
  assert.equal(snap.blocks[1].notice, true);
  assert.equal(snap.content, '', 'a notice is not part of the answer text');
});

test('turn state: anything still live when the turn ends is settled (Stopped / Interrupted)', () => {
  const mk = () => {
    const s = new AgentTurnState();
    s.applyAgentEvent({ type: 'action_start', id: 'a1', tool: 'run_command', args: {} });
    s.applyAgentEvent({ type: 'action_update', id: 'a1', patch: { status: 'awaiting_approval', approval: { key: 'k', command: 'x' } } });
    s.applyAgentEvent({ type: 'action_start', id: 'a2', tool: 'write_file', args: {}, progress: { added: 9 } });
    s.applyAgentEvent({ type: 'action_start', id: 'a3', tool: 'read_file', args: {} });
    s.applyAgentEvent({ type: 'action_end', id: 'a3', status: 'done', result: { kind: 'read' } });
    s.appendThinking('hmm');
    return s;
  };
  const stopped = mk();
  stopped.finish('aborted');
  const sb = stopped.snapshot().blocks;
  assert.deepEqual(sb.filter((b) => b.type === 'action').map((b) => [b.action.status, b.action.error]), [['error', 'Stopped'], ['error', 'Stopped'], ['done', undefined]]);
  assert.equal(sb.find((b) => b.type === 'action').action.approval, null);
  assert.equal(sb[1].action.progress, undefined, 'live numbers are dropped when the turn is settled');
  assert.equal(sb.find((b) => b.type === 'thinking').isStillThinking, false);
  const lost = mk();
  lost.finish();
  assert.equal(lost.snapshot().blocks.find((b) => b.type === 'action').action.error, 'Interrupted');
});

test('queued: calls waiting for an earlier one are in flight but not "working" (no shimmer); Stop settles them too', () => {
  const s = new AgentTurnState();
  s.applyAgentEvent({ type: 'action_start', id: 'a1', tool: 'run_command', args: { command: 'npm install' } });
  s.applyAgentEvent({ type: 'action_start', id: 'a2', tool: 'grep_search', args: { pattern: 'x' } });
  s.applyAgentEvent({ type: 'action_update', id: 'a2', patch: { status: 'queued' } });
  const a2 = () => s.snapshot().blocks[1].action;
  assert.equal(a2().status, 'queued');
  assert.equal(fmt.isLive(a2()), true, 'still in flight, so no "Working…" filler');
  assert.equal(fmt.isWorking(a2()), false, 'but it is not being worked on, so it must not shimmer');
  assert.equal(fmt.isWorking(s.snapshot().blocks[0].action), true);
  assert.equal(fmt.actionLabel(a2()).verb, 'Searching');
  s.applyAgentEvent({ type: 'action_update', id: 'a2', patch: { status: 'running' } });
  assert.equal(fmt.isWorking(a2()), true);
  s.applyAgentEvent({ type: 'action_update', id: 'a2', patch: { status: 'queued' } });
  s.finish('aborted');
  assert.deepEqual(s.snapshot().blocks.map((b) => [b.action.status, b.action.error]), [['error', 'Stopped'], ['error', 'Stopped']]);
});

test('turn state: run_end stores the summary', () => {
  const s = new AgentTurnState();
  s.applyAgentEvent({ type: 'run_end', stopReason: 'completed', steps: 4, toolCalls: 9, durationMs: 5000, changed: [{ path: 'a.js', added: 3, removed: 1 }] });
  assert.deepEqual(s.snapshot().agentRun, { stopReason: 'completed', steps: 4, toolCalls: 9, durationMs: 5000, changed: [{ path: 'a.js', added: 3, removed: 1 }] });
});

// ---------------------------------------------------------------------------
test('file icons: exact file name first, then the LONGEST extension, then the generic file', () => {
  const name = (p) => icons.fileIcon(p).name;
  assert.equal(name('index.html'), 'html');
  assert.equal(name('src/style.css'), 'css');
  assert.equal(name('app.js'), 'javascript');
  assert.equal(name('main.ts'), 'typescript');
  assert.equal(name('src/components/App.tsx'), 'react_ts');
  assert.equal(name('script.py'), 'python');
  assert.equal(name('data.json'), 'json');
  assert.equal(name('notes.md'), 'markdown');
  assert.equal(name('logo.png'), 'image');
  assert.equal(name('logo.svg'), 'svg');
  // special names beat the extension (package.json is not just "json")
  assert.equal(name('package.json'), 'nodejs');
  assert.equal(name('tsconfig.json'), 'tsconfig');
  assert.equal(name('vite.config.ts'), 'vite');
  assert.equal(name('Dockerfile'), 'docker');
  assert.equal(name('.gitignore'), 'git');
  assert.equal(name('README.md'), 'readme');
  assert.equal(name('LICENSE'), 'license');
  // the longest extension wins
  assert.equal(name('types.d.ts'), 'typescript-def');
  assert.equal(name('button.test.ts'), 'test-ts');
  // dotenv variants and unknowns
  assert.equal(name('.env'), 'tune');
  assert.equal(name('.env.local'), 'tune');
  assert.equal(name('mystery.zzzz'), 'file');
  assert.equal(name('noextension'), 'file');
  // case does not matter; directories in the path are ignored
  assert.equal(name('SRC/Main.JS'), 'javascript');
  assert.equal(name('C:\\proj\\README.MD'), 'readme');
});

test('folder icons: css / js / src / node_modules look like what they are, with open variants', () => {
  const f = (p, open) => icons.folderIcon(p, open).name;
  assert.equal(f('css'), 'folder-css');
  assert.equal(f('js'), 'folder-javascript');
  assert.equal(f('src'), 'folder-src');
  assert.equal(f('components'), 'folder-components');
  assert.equal(f('images'), 'folder-images');
  assert.equal(f('node_modules'), 'folder-node');
  assert.equal(f('dist'), 'folder-dist');
  assert.equal(f('tests'), 'folder-test');
  assert.equal(f('docs'), 'folder-docs');
  assert.equal(f('.git'), 'folder-git');
  assert.equal(f('src', true), 'folder-src-open');
  assert.equal(f('css', true), 'folder-css-open');
  assert.equal(f('SRC/Utils/CSS'), 'folder-css', 'last segment, any case');
  assert.equal(f('my-random-folder'), 'folder');
  assert.equal(f('my-random-folder', true), 'folder-open');
  assert.equal(f('.'), 'folder');
});

test('file icons: a light-theme variant is offered where the theme has one, and every image exists on disk', () => {
  assert.ok(icons.fileIcon('Cargo.toml').lightSrc || icons.fileIcon('x.toml').lightSrc, 'toml has a light variant');
  assert.equal(icons.fileIcon('app.js').lightSrc, undefined);
  assert.match(icons.fileIcon('app.js').src, /^\/file-icons\/javascript\.svg$/);
  const dir = path.join(root, 'public', 'file-icons');
  const missing = icons.allIconNames().filter((n) => !fs.existsSync(path.join(dir, `${n}.svg`)));
  assert.deepEqual(missing, [], 'every icon the lookup can return must exist as an SVG');
  for (const n of ['javascript', 'css', 'html', 'folder-src', 'folder-css', 'folder-javascript', 'file', 'folder']) {
    const svg = fs.readFileSync(path.join(dir, `${n}.svg`), 'utf8');
    assert.match(svg, /^<svg[^>]*viewBox="0 0 \d+ \d+"/, `${n} is a scalable SVG (has a viewBox)`);
    assert.ok(!/<rect[^>]*(width="16"[^>]*height="16"|height="16"[^>]*width="16")[^>]*fill="#?(fff|ffffff|white)"/i.test(svg), `${n} has no opaque white background`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'LICENSE')), 'the icon theme license ships with the icons');
});

test('wording: "Creating index.html +37" while streaming, "Created … +77" / "Rewrote … +77 −98" after', () => {
  const live = fmt.actionLabel(act({ status: 'pending', args: { path: 'index.html' }, progress: { added: 37, removed: 12 } }));
  assert.deepEqual([live.verb, live.target, live.added, live.removed, live.expandable], ['Creating', 'index.html', 37, 12, false]);
  const created = fmt.actionLabel(act({ result: { kind: 'write', path: 'index.html', created: true, added: 77, removed: 0, hunks: [{ newStart: 1, lines: [] }] } }));
  assert.deepEqual([created.verb, created.added, created.removed, created.expandable], ['Created', 77, undefined, true]);
  const moved = fmt.actionLabel(act({ tool: 'move_file', result: { kind: 'move', from: 'a.txt', to: 'src/b.css' } }));
  assert.deepEqual([moved.target, moved.iconPath], ['a.txt → src/b.css', 'src/b.css'], 'a move shows the destination file icon');
  const rewrote = fmt.actionLabel(act({ result: { kind: 'write', path: 'index.html', created: false, added: 77, removed: 98 } }));
  assert.deepEqual([rewrote.verb, rewrote.added, rewrote.removed], ['Rewrote', 77, 98]);
});

test('wording: Analyzed with line ranges, Edited with ranges and counts', () => {
  const read = fmt.actionLabel(act({ tool: 'read_file', result: { kind: 'read', path: 'src/App.tsx', startLine: 1, endLine: 120, totalLines: 400, truncated: false } }));
  assert.deepEqual([read.verb, read.target, read.lines], ['Analyzed', 'src/App.tsx', 'L1–L120']);
  const reading = fmt.actionLabel(act({ tool: 'read_file', status: 'running', args: { path: 'a.js', startLine: 10, endLine: 20 } }));
  assert.deepEqual([reading.verb, reading.lines], ['Analyzing', 'L10–L20']);
  const one = fmt.actionLabel(act({ tool: 'read_file', result: { kind: 'read', path: 'a.js', startLine: 5, endLine: 5, totalLines: 5 } }));
  assert.equal(one.lines, 'L5');
  const edit = fmt.actionLabel(act({ tool: 'multi_edit', result: { kind: 'edit', path: 'style.css', ranges: [[12, 18], [40, 44], [80, 80], [90, 91]], added: 9, removed: 4, edits: 4 } }));
  assert.deepEqual([edit.verb, edit.lines, edit.added, edit.removed, edit.meta], ['Edited', 'L12–L18, L40–L44, L80 +1 more', 9, 4, '4 edits']);
  const editing = fmt.actionLabel(act({ tool: 'edit_file', status: 'pending', args: { path: 'a.js' }, progress: { added: 6, removed: 2 } }));
  assert.deepEqual([editing.verb, editing.added, editing.removed], ['Editing', 6, 2]);
});

test('wording: commands — running, success, non-zero exit, timeout, background, approval, denied', () => {
  const running = fmt.actionLabel(act({ tool: 'run_command', status: 'running', args: { command: 'npm install' } }));
  assert.deepEqual([running.verb, running.target, running.targetKind], ['Running', 'npm install', 'command']);
  const ok = fmt.actionLabel(act({ tool: 'run_command', output: 'done', durationMs: 2300, result: { kind: 'command', command: 'npm test', exitCode: 0 } }));
  assert.deepEqual([ok.verb, ok.meta, ok.exitFailed, ok.expandable], ['Ran', '2.3s', false, true]);
  const bad = fmt.actionLabel(act({ tool: 'run_command', status: 'error', error: 'x', output: 'boom', durationMs: 1000, result: { kind: 'command', command: 'npm test', exitCode: 1 } }));
  assert.deepEqual([bad.verb, bad.meta, bad.exitFailed], ['Ran', 'exit 1 · 1.0s', true], 'a failing command ran; the exit code is the news');
  const timeout = fmt.actionLabel(act({ tool: 'run_command', status: 'error', result: { kind: 'command', command: 'sleep 9', exitCode: 124, timedOut: true } }));
  assert.match(timeout.meta, /timed out/);
  const bg = fmt.actionLabel(act({ tool: 'run_command', args: { background: true }, result: { kind: 'background', command: 'vite --host', id: 'bg-1', ports: [5173] } }));
  assert.deepEqual([bg.verb, bg.chips], ['Started', ['bg-1', ':5173']]);
  const reused = fmt.actionLabel(act({ tool: 'run_command', args: { background: true }, result: { kind: 'background', command: 'vite', id: 'bg-1', ports: [5173], reused: true } }));
  assert.deepEqual([reused.verb, reused.chips], ['Already running', ['bg-1', ':5173']]);
  const wait = fmt.actionLabel(act({ tool: 'run_command', status: 'awaiting_approval', approval: { key: 'k', command: 'rm -r build' }, args: { command: 'rm -r build' } }));
  assert.deepEqual([wait.verb, wait.target], ['Waiting for approval to run', 'rm -r build']);
  const denied = fmt.actionLabel(act({ tool: 'run_command', status: 'denied', args: { command: 'rm x' } }));
  assert.deepEqual([denied.verb, denied.meta], ['Skipped', 'not allowed']);
});

test('wording: a tool that FAILED says so, with the first line of the reason', () => {
  const e = fmt.actionLabel(act({ tool: 'edit_file', status: 'error', args: { path: 'a.js' }, error: 'old_string was not found in the file.\n\nClosest match…' }));
  assert.deepEqual([e.verb, e.target, e.meta, e.expandable], ["Couldn't edit", 'a.js', 'old_string was not found in the file.', true]);
  const r = fmt.actionLabel(act({ tool: 'read_file', status: 'error', args: { path: 'nope.txt' }, error: 'File not found: nope.txt' }));
  assert.equal(r.verb, "Couldn't read");
  const s = fmt.actionLabel(act({ tool: 'grep_search', status: 'error', args: { pattern: '(' }, error: 'grep failed' }));
  assert.equal(s.verb, 'Search failed:');
});

test('wording: an action cut off by Stop / a lost connection reads "Stopped" / "Interrupted"', () => {
  const stopped = fmt.actionLabel(act({ tool: 'run_command', status: 'error', error: 'Stopped', args: { command: 'npm install' }, output: 'added 3 packages' }));
  assert.deepEqual([stopped.verb, stopped.target, stopped.meta, stopped.expandable], ['Stopped', 'npm install', undefined, true]);
  const lost = fmt.actionLabel(act({ tool: 'write_file', status: 'error', error: 'Interrupted', args: { path: 'index.html' } }));
  assert.deepEqual([lost.verb, lost.target, lost.added], ['Interrupted', 'index.html', undefined]);
});

test('wording: several chunks, a multi-file edit, an outline', () => {
  const chunks = fmt.actionLabel(act({ tool: 'read_file', result: { kind: 'read', path: 'big.js', startLine: 1, endLine: 300, totalLines: 300, ranges: [[1, 50], [200, 260]] } }));
  assert.deepEqual([chunks.verb, chunks.lines], ['Analyzed', 'L1–L50, L200–L260']);
  const many = fmt.actionLabel(act({ tool: 'multi_edit', result: { kind: 'edit', path: 'a.js', added: 5, removed: 2, edits: 4, ranges: [[1, 1]], changes: [{ path: 'a.js', added: 3, removed: 1, edits: 2 }, { path: 'b.css', added: 2, removed: 1, edits: 2 }] } }));
  assert.deepEqual([many.verb, many.target, many.lines, many.added, many.removed, many.meta], ['Edited', 'a.js', undefined, 5, 2, '2 files · 4 edits']);
  const live = fmt.actionLabel(act({ tool: 'multi_edit', status: 'running', args: { edits: 6 }, progress: { added: 3, removed: 2 } }));
  assert.deepEqual([live.verb, live.meta, live.added, live.removed], ['Editing', '6 edits', 3, 2]);
  const one = fmt.actionLabel(act({ tool: 'multi_edit', result: { kind: 'edit', path: 'a.js', added: 1, removed: 1, edits: 3, ranges: [[4, 4], [9, 9], [20, 22]], hunks: [{ newStart: 4, lines: [] }] } }));
  assert.deepEqual([one.lines, one.meta, one.expandable], ['L4, L9, L20–L22', '3 edits', true]);
  const outline = fmt.actionLabel(act({ tool: 'file_outline', result: { kind: 'outline', path: 'src/App.tsx', count: 18 } }));
  assert.deepEqual([outline.verb, outline.target, outline.meta], ['Outlined', 'src/App.tsx', '18 symbols']);
  assert.equal(fmt.actionLabel(act({ tool: 'file_outline', status: 'running', args: { path: 'x.js' } })).verb, 'Outlining');
  // the next turn remembers every file a batch touched
  const lines = fmt.collectActivity([{ role: 'assistant', content: 'x', blocks: [{ type: 'action', id: 'b', action: act({ tool: 'multi_edit', result: { kind: 'edit', changes: [{ path: 'a.js', added: 3, removed: 1 }, { path: 'b.css', added: 2, removed: 1 }] } }) }] }]);
  assert.deepEqual(lines, ['edited a.js (+3 −1)', 'edited b.css (+2 −1)']);
});

test('wording: search, list, web, plan and the rest', () => {
  assert.equal(fmt.actionLabel(act({ tool: 'grep_search', result: { kind: 'grep', pattern: 'useState', count: 8, files: 3 } })).meta, '8 matches in 3 files');
  assert.equal(fmt.actionLabel(act({ tool: 'grep_search', result: { kind: 'grep', pattern: 'zzz', count: 0, files: 0 } })).meta, 'no matches');
  assert.equal(fmt.actionLabel(act({ tool: 'list_dir', result: { kind: 'list', path: 'src', count: 1 } })).meta, '1 item');
  assert.deepEqual(fmt.actionLabel(act({ tool: 'file_search', result: { kind: 'find', pattern: '*.tsx', count: 5 } })).meta, '5 files');
  const web = fmt.actionLabel(act({ tool: 'web_search', result: { kind: 'web_search', query: 'vite proxy', count: 8 } }));
  assert.deepEqual([web.verb, web.meta], ['Searched the web for', '8 results']);
  assert.equal(fmt.actionLabel(act({ tool: 'fetch_url', result: { kind: 'fetch', url: 'https://www.example.com/docs/a', title: 'Docs' } })).target, 'example.com');
  const plan = fmt.actionLabel(act({ tool: 'update_plan', result: { kind: 'plan', done: 2, total: 5, todos: [{ content: 'x', status: 'completed' }] } }));
  assert.deepEqual([plan.verb, plan.meta, plan.expandable], ['Updated plan', '2/5 done', true]);
  const preview = fmt.actionLabel(act({ tool: 'get_preview_url', result: { kind: 'preview', port: 3000, url: 'https://x' } }));
  assert.deepEqual([preview.verb, preview.target], ['Preview ready on port', '3000']);
  assert.equal(fmt.actionLabel(act({ tool: 'mystery_tool' })).verb, 'Ran');
});

test('formatRanges / formatDuration / changedSummary / stopNotice', () => {
  assert.equal(fmt.formatRanges([[3, 3]]), 'L3');
  assert.equal(fmt.formatRanges([[3, 9]]), 'L3–L9');
  assert.equal(fmt.formatRanges([]), undefined);
  assert.equal(fmt.formatDuration(100), undefined);
  assert.equal(fmt.formatDuration(2345), '2.3s');
  assert.equal(fmt.formatDuration(42_000), '42s');
  assert.equal(fmt.formatDuration(125_000), '2m 5s');
  assert.deepEqual(fmt.changedSummary([{ path: 'a', added: 5, removed: 1 }, { path: 'b', added: 2, removed: 0 }]), { files: 2, added: 7, removed: 1 });
  assert.equal(fmt.changedSummary([]), undefined);
  assert.match(fmt.stopNotice('step_limit'), /continue/);
  assert.equal(fmt.stopNotice('completed'), undefined);
});

test('collectActivity: one line per meaningful action, newest last, reads and searches skipped', () => {
  const blocks = [
    { type: 'text', id: 't', content: 'x' },
    { type: 'action', id: 'b1', action: act({ id: '1', tool: 'write_file', result: { kind: 'write', path: 'a.js', created: true, added: 10, removed: 0 } }) },
    { type: 'action', id: 'b2', action: act({ id: '2', tool: 'read_file', result: { kind: 'read', path: 'a.js' } }) },
    { type: 'action', id: 'b3', action: act({ id: '3', tool: 'edit_file', result: { kind: 'edit', path: 'a.js', added: 2, removed: 1 } }) },
    { type: 'action', id: 'b4', action: act({ id: '4', tool: 'run_command', result: { kind: 'command', command: 'node a.js', exitCode: 0 } }) },
    { type: 'action', id: 'b5', action: act({ id: '5', tool: 'edit_file', status: 'error', error: 'x' }) },
    { type: 'action', id: 'b6', action: act({ id: '6', tool: 'run_command', status: 'denied', args: { command: 'rm x' } }) },
    { type: 'action', id: 'b7', action: act({ id: '7', tool: 'get_preview_url', result: { kind: 'preview', url: 'https://p' } }) },
  ];
  const lines = fmt.collectActivity([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok', blocks }]);
  assert.deepEqual(lines, [
    'created a.js (+10 −0)',
    'edited a.js (+2 −1)',
    'ran `node a.js` → exit 0',
    'run_command (denied by user): rm x',
    'preview: https://p',
  ]);
  assert.equal(fmt.collectActivity([{ role: 'assistant', content: 'x', blocks }], 2).length, 2);
});

// ---------------------------------------------------------------------------
// The real data path: Express route + fake LLM  →  SSE client  →  blocks
// ---------------------------------------------------------------------------

test('data path: runAgentTurn turns a real SSE run into ordered blocks (and Stop settles them)', async () => {
  const saved = {
    DANAV_DATA_DIR: process.env.DANAV_DATA_DIR,
    DANAV_WORKSPACES_DIR: process.env.DANAV_WORKSPACES_DIR,
  };
  process.env.DANAV_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-fe-data-'));
  process.env.DANAV_WORKSPACES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-fe-ws-'));
  _resetStoreCache();
  const llm = await startFakeLlm();
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app, { runSearchTool: async () => ({ success: false }) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, init) => realFetch(typeof u === 'string' && u.startsWith('/') ? base + u : u, init);

  try {
    const { runAgentTurn } = await load('src/agent/runAgentTurn.ts');
    const { createWorkspace } = await load('src/services/agentApi.ts');
    const ws = await createWorkspace({ name: 'fe', kind: 'local', autoRun: true });
    const provider = { id: 'p', name: 'fake', baseUrl: llm.baseUrl, apiType: 'openai', models: [] };

    // 1) a complete run
    const updates = [];
    let finished;
    await runAgentTurn({
      provider, model: 'fake-build', thinkingLevel: 'Auto', workspaceId: ws.id, activity: [],
      messages: [{ role: 'user', content: 'build a page' }],
      signal: new AbortController().signal,
      onUpdate: (snap) => updates.push(snap.blocks.map((b) => b.type + (b.type === 'action' ? `:${b.action.tool}:${b.action.status}` : ''))),
      onFinish: (snap, error, stopReason) => { finished = { snap, error, stopReason }; },
    });
    assert.equal(finished.error, undefined);
    assert.equal(finished.stopReason, 'completed');
    const types = finished.snap.blocks.map((b) => (b.type === 'action' ? `action:${b.action.tool}` : b.type));
    assert.deepEqual(types, [
      'thinking', 'text', 'action:update_plan', 'action:write_file', 'action:write_file',
      'text', 'action:read_file', 'action:multi_edit', 'action:edit_file',
      'action:run_command', 'action:grep_search', 'action:list_dir', 'text',
    ]);
    assert.ok(finished.snap.blocks.filter((b) => b.type === 'action').every((b) => b.action.status === 'done'));
    assert.equal(finished.snap.blocks[0].isStillThinking, false);
    assert.match(finished.snap.content, /^I'll set up a small landing page\.\n\nNow a couple of refinements\.\n\nDone! I created index\.html/);
    assert.equal(finished.snap.agentRun.changed.length, 2);
    // while it ran, an action was seen in the pending state and later as done (live UI)
    assert.ok(updates.some((u) => u.includes('action:write_file:pending')));
    assert.ok(updates.at(-1).every((t) => !t.endsWith(':running') && !t.endsWith(':pending')));

    // 2) press Stop in the middle of a command
    const ac = new AbortController();
    let stopped;
    await runAgentTurn({
      provider, model: 'fake-slow', thinkingLevel: 'Auto', workspaceId: ws.id, activity: [],
      messages: [{ role: 'user', content: 'go' }],
      signal: ac.signal,
      onUpdate: (snap) => {
        const cmd = snap.blocks.find((b) => b.type === 'action' && b.action.tool === 'run_command' && b.action.status === 'running');
        if (cmd && !ac.signal.aborted) setTimeout(() => ac.abort(), 300);
      },
      onFinish: (snap, error) => { stopped = { snap, error }; },
    });
    const cmd = stopped.snap.blocks.find((b) => b.type === 'action' && b.action.tool === 'run_command').action;
    assert.equal(cmd.status, 'error');
    assert.equal(cmd.error, 'Stopped');
    assert.equal(stopped.error, undefined, 'a user stop is not an error');

    // 3) a server-side failure is surfaced, not swallowed
    let failed;
    await runAgentTurn({
      provider: { ...provider, apiType: 'mock' }, model: 'x', thinkingLevel: 'Auto', workspaceId: ws.id, activity: [],
      messages: [{ role: 'user', content: 'go' }],
      signal: new AbortController().signal,
      onUpdate: () => {},
      onFinish: (snap, error) => { failed = error; },
    });
    assert.match(failed, /Demo provider cannot run the agent/);
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await llm.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    _resetStoreCache();
  }
});
