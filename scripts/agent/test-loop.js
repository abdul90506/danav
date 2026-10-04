/** The agent loop and HTTP routes, driven by a scripted fake LLM (no API keys). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { startFakeLlm, HTML, CSS } from '../fake-llm.js';
import { runAgent, pruneMessages, revealPlan, worklogLines, verificationLabel } from '../../server/agent/loop.js';
import { LocalWorkspace } from '../../server/agent/workspaces/local.js';
import { registerAgentRoutes, _activeRuns } from '../../server/agent/routes.js';
import { resolveApproval } from '../../server/agent/approvals.js';
import { countLines } from '../../server/agent/textops.js';
import { normalizeAgentBlockForDisk } from '../../server/agent/persist.js';
import { readRunJournal } from '../../server/agent/journal.js';
import { genId } from '../../server/agent/util.js';
import { _resetStoreCache } from '../../server/agent/store.js';

const { test } = globalThis.__agentTest;
const isWin = process.platform === 'win32';

console.log('\n[loop + routes]');

let llm;
const getLlm = async () => (llm ||= await startFakeLlm({ chunkDelayMs: 0 }));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('the reveal of a dumped tool call is paced for a person to watch', () => {
  // Every provider measured on this app hands over the whole write_file call in
  // ONE SSE frame (see scripts/probe-raw.js), so this reveal is the only thing
  // that can show a file being written. It used to be a fixed 6–45 steps at 30ms,
  // which finished a 40-line file in 240ms — a blur that read as a jump.
  const perSec = Number(process.env.DANAV_REVEAL_CHARS_PER_SEC) || 1100;
  const minMs = Number(process.env.DANAV_REVEAL_MIN_MS) || 800;
  const maxMs = Number(process.env.DANAV_REVEAL_MAX_MS) || 2800;

  // A small file is still on screen long enough to read.
  assert.equal(revealPlan(0).durationMs, minMs);
  assert.equal(revealPlan(120).durationMs, minMs, 'a tiny body gets the floor, not a flash');

  // A typical file lands in the middle of the range...
  const typical = revealPlan(1800);
  assert.ok(typical.durationMs > minMs && typical.durationMs < maxMs, `1800 chars -> ${typical.durationMs}ms`);

  // ...and a huge one is capped so it cannot hold the run up.
  assert.equal(revealPlan(200_000).durationMs, maxMs, 'a huge body is capped');

  // Bigger bodies are revealed for longer, up to the cap.
  assert.ok(revealPlan(4000).durationMs >= typical.durationMs);

  // The steps are small: several per 100ms, so the count climbs instead of jumping.
  const stepsPerSecond = typical.steps / (typical.durationMs / 1000);
  assert.ok(stepsPerSecond >= 20, `expected a smooth ~30 updates a second, got ${stepsPerSecond.toFixed(1)}`);
  assert.ok(typical.steps >= 20, `a typical file is revealed over many steps, got ${typical.steps}`);
  assert.ok(revealPlan(200_000).steps <= 120, 'and the step count stays bounded');

  // Never fewer than two, so even the floor produces a visible climb.
  assert.ok(revealPlan(1).steps >= 2);
  assert.ok(Number.isFinite(revealPlan(NaN).durationMs), 'a nonsense size does not produce a nonsense plan');
});

test('a live update always carries a number for BOTH counters', async () => {
  // A brand-new file removes nothing, and the payload used to omit `removed`
  // entirely — every live update then carried `removed: undefined`.
  const { events } = await agentRun({ model: 'fake-burst' });
  const progress = events
    .map((e) => e.agent?.patch?.progress)
    .filter(Boolean);
  assert.ok(progress.length > 0, 'the write was reported');
  for (const p of progress) {
    assert.equal(typeof p.added, 'number', `added must be a number: ${JSON.stringify(p)}`);
    assert.equal(typeof p.removed, 'number', `removed must be a number: ${JSON.stringify(p)}`);
    assert.ok(Number.isFinite(p.added) && Number.isFinite(p.removed));
    assert.ok(Array.isArray(p.tail));
  }
});

/** Everything the user saw in the chat, in order: the streamed answer. */
const saidSoFar = (events) => events.filter((e) => typeof e.content === 'string').map((e) => e.content).join('');

/** The one-line notices the run showed the user. */
const noticesSeen = (events) =>
  events.filter((e) => e.agent?.type === 'notice').map((e) => String(e.agent.message || ''));

async function agentRun({ model = 'fake-build', autoRun = true, history, signal, onEvent, workspace } = {}) {
  const l = await getLlm();
  l.requests.length = 0;
  const dir = workspace?.root || tmp('danav-loop-');
  const ws = workspace || new LocalWorkspace({ id: 'ws-loop', kind: 'local', name: 'loop', root: dir, autoRun });
  await ws.init();
  const events = [];
  const previousDataDir = process.env.DANAV_DATA_DIR;
  const testDataDir = tmp('danav-loop-data-');
  process.env.DANAV_DATA_DIR = testDataDir;
  let result;
  try {
    result = await runAgent({
      provider: { baseUrl: l.baseUrl, apiKey: 'test-key-1234567890' },
      model,
      thinkingLevel: 'Auto',
      history: history || [{ role: 'user', content: 'build me a landing page' }],
      activity: [],
      workspace: ws,
      runSearchTool: async () => ({ success: false, error: 'offline' }),
      send: (e) => {
        events.push(e);
        onEvent?.(e);
      },
      signal: signal || new AbortController().signal,
      runId: genId('run'),
    });
  } finally {
    if (previousDataDir === undefined) delete process.env.DANAV_DATA_DIR;
    else process.env.DANAV_DATA_DIR = previousDataDir;
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
  return { events, result, ws, dir, requests: l.requests };
}

const agentEvents = (events, type) => events.filter((e) => e.agent?.type === type).map((e) => e.agent);

function assertConsistentTranscript(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const ids = m.tool_calls.map((t) => t.id);
      const answers = [];
      for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) answers.push(messages[j].tool_call_id);
      assert.deepEqual(answers.sort(), [...ids].sort(), 'every tool call needs exactly one answer, right after it');
    }
    if (m.role === 'tool') {
      let k = i - 1;
      while (k >= 0 && messages[k].role === 'tool') k--;
      assert.ok(messages[k]?.role === 'assistant' && messages[k].tool_calls?.length, 'a tool message must follow an assistant tool_calls message');
    }
  }
}

// ---------------------------------------------------------------------------

test('happy path: plan, write, read, multi-edit, edit, command, search, list — in order', async () => {
  const { events, result, dir, requests } = await agentRun();
  assert.equal(result.stopReason, 'completed');

  const kinds = events.filter((e) => e.agent).map((e) => e.agent.type);
  assert.equal(kinds[0], 'run_start');
  assert.equal(kinds.at(-1), 'run_end');

  const started = agentEvents(events, 'action_start').map((a) => a.tool);
  assert.deepEqual(started, ['update_plan', 'write_file', 'write_file', 'read_file', 'multi_edit', 'edit_file', 'run_command', 'grep_search', 'list_dir']);

  const ends = agentEvents(events, 'action_end');
  assert.equal(ends.length, 9);
  assert.ok(ends.every((a) => a.status === 'done' && a.ok), JSON.stringify(ends.filter((a) => a.status !== 'done')));

  // each action: start -> (updates) -> end, and the narration arrives before the actions of its round
  for (const s of agentEvents(events, 'action_start')) {
    const iStart = events.findIndex((e) => e.agent?.id === s.id && e.agent.type === 'action_start');
    const iEnd = events.findIndex((e) => e.agent?.id === s.id && e.agent.type === 'action_end');
    assert.ok(iStart >= 0 && iEnd > iStart);
  }
  const firstText = events.findIndex((e) => e.content);
  const firstAction = events.findIndex((e) => e.agent?.type === 'action_start');
  assert.ok(firstText >= 0 && firstText < firstAction, 'text before the first action');
  assert.ok(events.some((e) => e.thinking), 'reasoning is streamed');

  // the numbers the UI shows
  const write = ends.find((a) => a.result.kind === 'write' && a.result.path === 'index.html');
  assert.equal(write.result.created, true);
  assert.equal(write.result.added, countLines(HTML));
  const read = ends.find((a) => a.result.kind === 'read');
  assert.deepEqual([read.result.startLine, read.result.endLine, read.result.totalLines], [1, 12, countLines(HTML)]);
  const multi = ends.find((a) => a.result.kind === 'edit' && a.result.edits === 2);
  assert.deepEqual(multi.result.ranges, [[2, 2], [4, 5]]);
  assert.equal(multi.result.added, 3);
  assert.equal(multi.result.removed, 2);
  const cmd = ends.find((a) => a.result.kind === 'command');
  assert.match(cmd.output, /\d+ lines/);

  // files really changed on disk
  const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
  assert.match(css, /#0a58ca/);
  assert.match(css, /border-radius: 8px/);
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /Hello — Danav/);

  // run summary
  const end = agentEvents(events, 'run_end')[0];
  const changed = Object.fromEntries(end.changed.map((c) => [c.path, c]));
  assert.equal(changed['index.html'].added, countLines(HTML) + 1);
  assert.equal(changed['index.html'].removed, 1);
  assert.equal(changed['style.css'].added, countLines(CSS) + 3);
  assert.equal(end.steps, 5, 'three working rounds, the answer, and one verification round');

  // the model finished without a check of its own accord, so the run asked once
  assert.ok(
    noticesSeen(events).some((n) => /no check has been run/i.test(n)),
    'the run asked for a check before accepting the answer'
  );

  // the 2nd and 3rd calls of a round are announced as queued; the 1st goes straight to running
  const queuedIds = events.filter((e) => e.agent?.patch?.status === 'queued').map((e) => e.agent.id);
  assert.equal(queuedIds.length, 2 + 2 + 2, 'rounds of 3 calls queue two each');
  const starts = agentEvents(events, 'action_start');
  for (const first of [starts[0], starts.find((a) => a.tool === 'read_file'), starts.find((a) => a.tool === 'run_command')]) {
    assert.ok(!queuedIds.includes(first.id), `${first.tool} is first in its round, so it is never queued`);
  }
  assert.ok(queuedIds.includes(starts.find((a) => a.tool === 'write_file').id), 'the 2nd call of round 1 waits its turn');

  // what the model was shown
  assert.match(requests[0].messages[0].content, /Danav Agent/);
  assert.match(requests[0].messages[0].content, /fresh workspace/);
  assert.match(requests[0].messages[0].content, /ALREADY inside it/);
  assert.ok(requests[0].tools.length >= 15);
  assertConsistentTranscript(requests.at(-1).messages);
  const finalText = events.filter((e) => e.content).map((e) => e.content).join('');
  assert.match(finalText, /Done! I created index\.html/);
});

test('runAgent wires delegate_task to a bounded child completion with only supplied excerpts', async () => {
  const root = tmp('danav-delegate-loop-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'review.ts'), 'export const normalize = (value: string) => value.trim();\n');
  const ws = new LocalWorkspace({ id: 'ws-delegate-loop', kind: 'local', name: 'delegate', root, autoRun: true });
  await ws.init();
  try {
    const { events, result, requests } = await agentRun({
      model: 'fake-delegate',
      workspace: ws,
      history: [{ role: 'user', content: 'Ask for a second opinion on the handler.' }],
    });
    assert.equal(result.stopReason, 'completed');
    const action = agentEvents(events, 'action_end').find((a) => a.result?.kind === 'delegate');
    assert.ok(action?.ok, 'the delegated review should complete through the normal tool lifecycle');
    assert.equal(action.result.kind, 'delegate');

    const child = requests.find((r) => String(r.messages?.[0]?.content || '').includes('read-only software-review subagent'));
    assert.ok(child, 'the loop should make a separate child completion request');
    assert.equal(child.tools, undefined, 'the child has no tools and therefore cannot modify the workspace');
    assert.match(JSON.stringify(child.messages), /src\/review\.ts/);
    assert.match(JSON.stringify(child.messages), /value\.trim/);
    // The reviewer is told what the review is FOR, or it judges the excerpts
    // against a goal it was never given.
    assert.match(JSON.stringify(child.messages), /Ask for a second opinion on the handler\./);
    assert.match(JSON.stringify(child.messages), /Task assigned to you/);
    const parentFollowup = requests.find((r) => r.tools?.length && r.messages.some((m) => m.role === 'tool'));
    assert.ok(parentFollowup);
    assert.match(JSON.stringify(parentFollowup.messages), /empty-input regression test/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('successful verification is journaled automatically and available in the next workspace run', async () => {
  const l = await getLlm();
  const previousDataDir = process.env.DANAV_DATA_DIR;
  const dataDir = tmp('danav-journal-loop-data-');
  const root = tmp('danav-journal-loop-workspace-');
  process.env.DANAV_DATA_DIR = dataDir;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'journal-fixture', private: true,
    scripts: { 'test:agent': 'node -e "console.log(42)"' },
  }, null, 2));
  const ws = new LocalWorkspace({ id: 'ws-journal-loop', kind: 'local', name: 'journal', root, autoRun: true });
  await ws.init();
  const run = async (model, request) => {
    const events = [];
    const result = await runAgent({
      provider: { baseUrl: l.baseUrl, apiKey: 'test-key-1234567890' },
      model,
      thinkingLevel: 'Auto',
      history: [{ role: 'user', content: request }],
      activity: [],
      workspace: ws,
      runSearchTool: async () => ({ success: false, error: 'offline' }),
      send: (e) => events.push(e),
      signal: new AbortController().signal,
      runId: genId('run'),
    });
    return { events, result };
  };
  try {
    const first = await run('fake-check', 'run the focused test');
    assert.equal(first.result.stopReason, 'completed');
    const records = readRunJournal(ws.id);
    assert.equal(records.length, 1);
    assert.ok(records[0].checks.some((c) => c.name === 'npm run test:agent' && c.passed));

    l.requests.length = 0;
    const second = await run('fake-build', 'what was the test command?');
    assert.equal(second.result.stopReason, 'completed');
    assert.match(l.requests[0].messages[0].content, /Recent workspace evidence/);
    assert.match(l.requests[0].messages[0].content, /npm run test:agent passed/);
    const onDisk = fs.readFileSync(path.join(dataDir, 'agent-runs', `${ws.id}.json`), 'utf8');
    assert.doesNotMatch(onDisk, /what was the test command/i, 'journal never stores the user prompt');
  } finally {
    if (previousDataDir === undefined) delete process.env.DANAV_DATA_DIR;
    else process.env.DANAV_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live progress: the action row appears early and its line count grows while the model writes', async () => {
  const l = await getLlm();
  const slow = await startFakeLlm({ chunkDelayMs: 12 });
  try {
    const events = [];
    const ws = new LocalWorkspace({ id: 'ws-p', kind: 'local', name: 'p', root: tmp('danav-prog-'), autoRun: true });
    await ws.init();
    await runAgent({
      provider: { baseUrl: slow.baseUrl },
      model: 'fake-slow',
      history: [{ role: 'user', content: 'go' }],
      workspace: ws,
      runSearchTool: async () => ({}),
      send: (e) => events.push(e),
      signal: new AbortController().signal,
      runId: genId('run'),
    });
    const start = events.findIndex((e) => e.agent?.type === 'action_start' && e.agent.tool === 'write_file');
    const running = events.findIndex((e, i) => i > start && e.agent?.patch?.status === 'running');
    const updates = events.slice(start, running).filter((e) => e.agent?.patch?.progress?.added);
    const counts = updates.map((e) => e.agent.patch.progress.added);
    assert.ok(start >= 0 && running > start, 'start precedes running');
    assert.ok(counts.length >= 3, `expected several progress updates, got ${counts}`);
    assert.deepEqual([...counts].sort((a, b) => a - b), counts, 'line count never goes backwards');
    assert.ok(counts.at(-1) > counts[0]);
    // the path is known early, from the partial JSON
    const early = events.slice(start, running).find((e) => e.agent?.patch?.args?.path || e.agent?.args?.path);
    assert.ok(early, 'path arrives before execution starts');
  } finally {
    await slow.close();
  }
});

test('a tool call that arrives ALL AT ONCE is still watched being written (replayed, not dumped)', async () => {
  // Providers such as Vyce/agnes send a whole tool call in a single frame. The row must not
  // jump straight to "+200": the body is replayed so the count climbs and the tail scrolls.
  const { events, dir } = await agentRun({ model: 'fake-burst' });

  const start = events.findIndex((e) => e.agent?.type === 'action_start' && e.agent.tool === 'write_file');
  const running = events.findIndex((e, i) => i > start && e.agent?.patch?.status === 'running');
  const end = events.findIndex((e, i) => i > running && e.agent?.type === 'action_end');
  assert.ok(start >= 0 && running > start && end > running, `start < running < end (${start}, ${running}, ${end})`);

  // the row opens at "+0" — a real reading of a file that has no lines yet — and the final
  // count is never claimed up front
  assert.equal(events[start].agent.progress?.added, 0, 'a one-shot call opens at +0, not at its final count');
  assert.notEqual(events[start].agent.progress?.added, 200, 'the final count is never claimed up front');

  const replayed = events
    .slice(running, end)
    .filter((e) => e.agent?.patch?.progress)
    .map((e) => e.agent.patch.progress);
  const counts = replayed.map((p) => p.added);
  assert.ok(counts.length >= 5, `expected the body to be replayed over several updates, got ${counts}`);
  assert.deepEqual([...counts].sort((a, b) => a - b), counts, `the replayed count never goes backwards: ${counts}`);
  assert.ok(counts[0] < counts.at(-1), `the count climbs: ${counts[0]} -> ${counts.at(-1)}`);
  assert.equal(counts[0], 0, 'the count starts at zero, before the first line is on disk');
  assert.ok(replayed.some((p) => p.tail?.length > 0), 'the lines being written scroll by');

  // the replay is display only: the file on disk is the full one, and the row ends with real numbers
  const written = fs.readFileSync(path.join(dir, 'big.js'), 'utf8');
  assert.equal(countLines(written), 200);
  assert.equal(events[end].agent.result.added, 200);
  assert.equal(counts.at(-1), 200, 'the replay reaches the number the result confirms');
});

test('a provider that really streams is never replayed twice', async () => {
  // The live count already grew while the model was writing; after `running` there is nothing left to show.
  const slow = await startFakeLlm({ chunkDelayMs: 6 });
  try {
    const events = [];
    const ws = new LocalWorkspace({ id: 'ws-nr', kind: 'local', name: 'nr', root: tmp('danav-noreplay-'), autoRun: true });
    await ws.init();
    await runAgent({
      provider: { baseUrl: slow.baseUrl },
      model: 'fake-slow',
      history: [{ role: 'user', content: 'go' }],
      workspace: ws,
      runSearchTool: async () => ({}),
      send: (e) => events.push(e),
      signal: new AbortController().signal,
      runId: genId('run'),
    });
    const start = events.findIndex((e) => e.agent?.type === 'action_start' && e.agent.tool === 'write_file');
    const running = events.findIndex((e, i) => i > start && e.agent?.patch?.status === 'running');
    const end = events.findIndex((e, i) => i > running && e.agent?.type === 'action_end');
    const before = events.slice(start, running).filter((e) => e.agent?.patch?.progress?.added).length;
    const after = events.slice(running, end).filter((e) => e.agent?.patch?.progress?.added).length;
    assert.ok(before >= 3, `a streaming provider is followed live (${before} updates before running)`);
    assert.equal(after, 0, `nothing is replayed once the call was already streamed (${after} updates after running)`);
  } finally {
    await slow.close();
  }
});

test('a stream squeezed inside the throttle window still counts up (replay covers what the throttle swallowed)', async () => {
  // A provider can deliver every fragment within ~100ms: the 140ms throttle then suppresses every
  // intermediate update, and without the replay the row would jump straight to its final number.
  const fast = await startFakeLlm({ chunkDelayMs: 1 });
  try {
    const events = [];
    const ws = new LocalWorkspace({ id: 'ws-fast', kind: 'local', name: 'fast', root: tmp('danav-fast-'), autoRun: true });
    await ws.init();
    await runAgent({
      provider: { baseUrl: fast.baseUrl },
      model: 'fake-slow',
      history: [{ role: 'user', content: 'go' }],
      workspace: ws,
      runSearchTool: async () => ({}),
      send: (e) => events.push(e),
      signal: new AbortController().signal,
      runId: genId('run'),
    });
    const start = events.findIndex((e) => e.agent?.type === 'action_start' && e.agent.tool === 'write_file');
    const end = events.findIndex((e, i) => i > start && e.agent?.type === 'action_end');
    const counts = events
      .slice(start, end)
      .filter((e) => e.agent?.patch?.progress?.added)
      .map((e) => e.agent.patch.progress.added);
    assert.ok(counts.length >= 3, `the count must climb in several steps, got ${counts}`);
    assert.deepEqual([...counts].sort((a, b) => a - b), counts, `never backwards: ${counts}`);
    assert.equal(counts.at(-1), events[end].agent.result.added, 'the replay lands on the number the result confirms');
  } finally {
    await fast.close();
  }
});

test('the file really exists and grows ON DISK while it is being written', async () => {
  // The counter in the chat is not an animation standing in for the write. Every time the chat
  // reports "+N", the file on disk is read straight away and must already hold those lines.
  const l = await getLlm();
  const dir = tmp('danav-disk-');
  const ws = new LocalWorkspace({ id: 'ws-disk', kind: 'local', name: 'disk', root: dir, autoRun: true });
  await ws.init();
  const file = path.join(dir, 'big.js');

  const samples = []; // { claimed, onDisk }
  const send = (e) => {
    const added = e.agent?.patch?.progress?.added;
    if (added === undefined) return;
    let onDisk = -1;
    try {
      const text = fs.readFileSync(file, 'utf8');
      onDisk = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
    } catch {
      onDisk = -1; // not created yet
    }
    samples.push({ claimed: added, onDisk });
  };

  await runAgent({
    provider: { baseUrl: l.baseUrl },
    model: 'fake-burst',
    history: [{ role: 'user', content: 'go' }],
    workspace: ws,
    runSearchTool: async () => ({}),
    send,
    signal: new AbortController().signal,
    runId: genId('run'),
  });

  assert.ok(samples.length >= 3, `the write was reported in several steps: ${samples.length}`);
  const created = samples.filter((s) => s.onDisk >= 0);
  assert.ok(created.length >= 3, `the file existed while it was being written: ${JSON.stringify(samples)}`);
  assert.ok(created.some((s) => s.onDisk > 0 && s.onDisk < 200), `it was caught half-written: ${JSON.stringify(created)}`);

  for (let i = 1; i < created.length; i++) {
    assert.ok(created[i].onDisk >= created[i - 1].onDisk, `the file never shrinks: ${JSON.stringify(created)}`);
  }
  // the claim never runs ahead of the real file (at most the one line still being typed)
  for (const s of created) {
    assert.ok(s.claimed <= s.onDisk + 1, `chat says +${s.claimed} but the file holds ${s.onDisk} lines`);
  }
  assert.equal(created.at(-1).onDisk >= 188, true, `it reaches (nearly) the full file: ${created.at(-1).onDisk}`);
  assert.equal(fs.readFileSync(file, 'utf8').trimEnd().split('\n').length, 200, 'the file on disk ends up complete');
});

test('an overwrite diffs against what was REALLY there, not against the half-written draft', async () => {
  const l = await getLlm();
  const dir = tmp('danav-owdiff-');
  fs.writeFileSync(path.join(dir, 'big.js'), Array.from({ length: 30 }, (_, i) => `old line ${i + 1}`).join('\n') + '\n');
  const ws = new LocalWorkspace({ id: 'ws-owd', kind: 'local', name: 'owd', root: dir, autoRun: true });
  await ws.init();
  const events = [];
  await runAgent({
    provider: { baseUrl: l.baseUrl },
    model: 'fake-burst',
    history: [{ role: 'user', content: 'go' }],
    workspace: ws,
    runSearchTool: async () => ({}),
    send: (e) => events.push(e),
    signal: new AbortController().signal,
    runId: genId('run'),
  });
  const end = events.find((e) => e.agent?.type === 'action_end');
  // the file on disk was our own draft when the tool ran; the numbers must still describe the
  // real before/after: 30 old lines replaced by 200 new ones.
  assert.deepEqual([end.agent.result.added, end.agent.result.removed], [200, 30]);
  assert.equal(end.agent.result.created, false, 'it is reported as an overwrite, not a new file');
});

test('a run stopped mid-write leaves no half-written file behind', async () => {
  const l = await getLlm();
  const dir = tmp('danav-rollback-');
  const ws = new LocalWorkspace({ id: 'ws-rb', kind: 'local', name: 'rb', root: dir, autoRun: true });
  await ws.init();
  const file = path.join(dir, 'big.js');

  /** Stop the run on the first sign of life, which is always before the tool itself runs. */
  const stopOnFirstProgress = () => {
    const ac = new AbortController();
    let stopped = false;
    return {
      signal: ac.signal,
      send: (e) => {
        if (!stopped && e.agent?.patch?.progress) {
          stopped = true;
          ac.abort();
        }
      },
    };
  };

  const first = stopOnFirstProgress();
  await runAgent({
    provider: { baseUrl: l.baseUrl },
    model: 'fake-burst',
    history: [{ role: 'user', content: 'go' }],
    workspace: ws,
    runSearchTool: async () => ({}),
    send: first.send,
    signal: first.signal,
    runId: genId('run'),
  });
  assert.equal(fs.existsSync(file), false, 'a file that was never finished is removed again');

  // and an interrupted overwrite gives back the file that was there
  fs.writeFileSync(file, 'PRECIOUS\n');
  const second = stopOnFirstProgress();
  await runAgent({
    provider: { baseUrl: l.baseUrl },
    model: 'fake-burst',
    history: [{ role: 'user', content: 'go' }],
    workspace: ws,
    runSearchTool: async () => ({}),
    send: second.send,
    signal: second.signal,
    runId: genId('run'),
  });
  assert.equal(fs.readFileSync(file, 'utf8'), 'PRECIOUS\n', 'an interrupted overwrite is put back');
});

test('overwriting a file: "−" is live too (what really differs from the file on disk), with the tail of what is being typed', async () => {
  const slow = await startFakeLlm({ chunkDelayMs: 12 });
  try {
    const events = [];
    const dir = tmp('danav-over-');
    const ws = new LocalWorkspace({ id: 'ws-o', kind: 'local', name: 'o', root: dir, autoRun: true });
    await ws.init();
    const old = Array.from({ length: 30 }, (_, i) => `old line ${i + 1}`).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'index.html'), old);
    await runAgent({
      provider: { baseUrl: slow.baseUrl },
      model: 'fake-slow',
      history: [{ role: 'user', content: 'go' }],
      workspace: ws,
      runSearchTool: async () => ({}),
      send: (e) => events.push(e),
      signal: new AbortController().signal,
      runId: genId('run'),
    });
    const start = events.findIndex((e) => e.agent?.type === 'action_start' && e.agent.tool === 'write_file');
    const end = events.findIndex((e) => e.agent?.type === 'action_end' && e.agent.result?.kind === 'write');
    const live = events.slice(start, end).map((e) => e.agent?.patch?.progress || e.agent?.progress).filter(Boolean);
    const removed = live.map((p) => p.removed).filter((n) => n !== undefined);
    assert.ok(removed.length >= 3, `"−" is reported while writing (${removed})`);
    assert.ok(removed.every((n) => n <= 30), 'never more than the old file has');
    assert.ok(removed.at(-1) > removed[0], 'and it grows as more of the old file is replaced');
    assert.ok(live.some((p) => p.tail?.length >= 2 && /part/.test(p.tail.join('\n'))), 'the last lines being typed are streamed');
    const final = events[end].agent.result;
    assert.equal(final.created, false);
    assert.equal(final.removed, 30, 'the final numbers are the exact diff');
    assert.equal(events[end].agent.result.added, countLines(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')));
    // the final numbers were also shown BEFORE the tool ran (the throttle can swallow the last lines)
    const running = events.findIndex((e, i) => i > start && e.agent?.patch?.status === 'running');
    const lastLive = events.slice(start, running + 1).map((e) => e.agent?.patch?.progress).filter(Boolean).at(-1);
    assert.ok(lastLive.added >= final.added - 1, `the last live "+" (${lastLive.added}) matches the final (${final.added})`);
  } finally {
    await slow.close();
  }
});

test('terminal output streams into the action while the command runs', async () => {
  if (isWin) return;
  const { events } = await agentRun({ model: 'fake-slow' });
  const chunks = events.filter((e) => e.agent?.patch?.outputAppend).map((e) => e.agent.patch.outputAppend).join('');
  assert.match(chunks, /step-1/);
  assert.match(chunks, /step-2/);
  const end = agentEvents(events, 'action_end').find((a) => a.result.kind === 'command');
  assert.match(end.output, /step-1\nstep-2/);
});

test('repeated identical failures: recovery hint, then a forced wrap-up without tools', async () => {
  const { events, result, requests } = await agentRun({ model: 'fake-fail' });
  assert.equal(result.stopReason, 'repeated_failures');
  const ends = agentEvents(events, 'action_end');
  assert.equal(ends.length, 4);
  assert.ok(ends.every((a) => a.status === 'error'));
  const allToolText = requests.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
  assert.match(allToolText, /\[RECOVERY\] This exact call has now failed 2 times/);
  assert.match(allToolText, /does not exist/);
  assert.equal(requests.at(-1).tools, undefined, 'the last round has no tools');
  assert.match(events.filter((e) => e.content).map((e) => e.content).join(''), /Wrapping up without using more tools/);
  assertConsistentTranscript(requests.at(-1).messages);
});

test('step limit: the run wraps up with a summary instead of looping forever', async () => {
  process.env.DANAV_AGENT_MAX_STEPS = '3';
  try {
    const { events, result, requests } = await agentRun({ model: 'fake-loop' });
    assert.equal(result.stopReason, 'step_limit');
    assert.equal(agentEvents(events, 'action_end').length, 3);
    assert.equal(requests.at(-1).tools, undefined);
    assert.match(requests.at(-1).messages.at(-1).content, /continue/);
  } finally {
    delete process.env.DANAV_AGENT_MAX_STEPS;
  }
});

test('stopping mid-run aborts within seconds and kills the running command', async () => {
  if (isWin) return;
  const ac = new AbortController();
  const t0 = Date.now();
  let abortedAt = 0;
  const { events, result } = await agentRun({
    model: 'fake-slow',
    signal: ac.signal,
    onEvent: (e) => {
      if (e.agent?.type === 'action_update' && e.agent.patch?.status === 'running' && !abortedAt && e.agent.patch.args?.command) {
        abortedAt = Date.now();
        setTimeout(() => ac.abort(), 500);
      }
    },
  });
  assert.equal(result.stopReason, 'aborted');
  assert.ok(abortedAt > 0, 'the command started');
  assert.ok(Date.now() - abortedAt < 3500, `stop took ${Date.now() - abortedAt}ms`);
  assert.ok(Date.now() - t0 < 12000);
  const types = agentEvents(events, 'run_end');
  assert.equal(types[0].stopReason, 'aborted');
});

test('approval: an un-approved command waits, runs when allowed', async () => {
  if (isWin) return;
  let key = null;
  const { events, result } = await agentRun({
    model: 'fake-approval',
    autoRun: false,
    onEvent: (e) => {
      const p = e.agent?.patch;
      if (p?.status === 'awaiting_approval') {
        key = p.approval.key;
        assert.equal(p.approval.command, 'echo approved-output');
        setTimeout(() => resolveApproval(key, true), 50);
      }
    },
  });
  assert.ok(key, 'approval was requested');
  assert.equal(result.stopReason, 'completed');
  const end = agentEvents(events, 'action_end').find((a) => a.result.kind === 'command');
  assert.equal(end.status, 'done');
  assert.match(end.output, /approved-output/);
});

test('approval: denying skips the command and the model is told', async () => {
  if (isWin) return;
  const { events, requests } = await agentRun({
    model: 'fake-approval',
    autoRun: false,
    onEvent: (e) => {
      if (e.agent?.patch?.status === 'awaiting_approval') setTimeout(() => resolveApproval(e.agent.patch.approval.key, false), 50);
    },
  });
  const end = agentEvents(events, 'action_end').find((a) => a.result.kind === 'command');
  assert.equal(end.status, 'denied');
  const toolMsg = requests.at(-1).messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /did not allow/);
});

test('approval: an unanswered request is denied when the run is stopped', async () => {
  if (isWin) return;
  const ac = new AbortController();
  const { result } = await agentRun({
    model: 'fake-approval',
    autoRun: false,
    signal: ac.signal,
    onEvent: (e) => {
      if (e.agent?.patch?.status === 'awaiting_approval') setTimeout(() => ac.abort(), 100);
    },
  });
  assert.equal(result.stopReason, 'aborted');
});

test('silent finish: the model is nudged once to tell the user what it did', async () => {
  const { events, requests } = await agentRun({ model: 'fake-silent' });
  assert.match(events.filter((e) => e.content).map((e) => e.content).join(''), /I created a\.txt/);
  assert.ok(requests.at(-1).messages.some((m) => m.role === 'user' && /finished without a message/.test(m.content)));
});

test('bad tool calls: unknown tool, truncated JSON and a failing read all come back as readable errors', async () => {
  const { events, requests, result } = await agentRun({ model: 'fake-bad-calls' });
  const ends = agentEvents(events, 'action_end');
  assert.equal(ends.length, 3);
  assert.ok(ends.every((a) => a.status === 'error'));
  const tools = requests.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(tools[0], /Unknown tool "no_such_tool"/);
  assert.match(tools[1], /not valid JSON/);
  assert.match(tools[2], /File not found/);
  assert.equal(result.stopReason, 'completed');
  assertConsistentTranscript(requests.at(-1).messages);
  // a broken arguments blob must never be echoed back to the provider
  const echoed = requests.at(-1).messages.find((m) => m.tool_calls)?.tool_calls.map((t) => t.function.arguments);
  for (const a of echoed) JSON.parse(a);
});

test('malformed tool-call JSON is recovered end to end: the file is written, no invalid-JSON error', async () => {
  const dir = tmp('danav-mangled-');
  const ws = new LocalWorkspace({ id: 'ws-m', kind: 'local', name: 'm', root: dir, autoRun: true });
  const { requests, result } = await agentRun({ model: 'fake-mangled', workspace: ws });
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /<!DOCTYPE html>/, 'the recovered content reached disk');
  const toolMsgs = requests.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.ok(!toolMsgs.some((c) => /not valid JSON/.test(c)), 'the malformed call is recovered, not surfaced as an error');
  assert.equal(result.stopReason, 'completed');
});

test('context pruning: old tool output and file bodies are elided first; whole rounds only as a last resort', async () => {
  const build = () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    for (let i = 0; i < 12; i++) {
      msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: `f${i}.js`, content: 'x'.repeat(5000) }) } }] });
      msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 'y'.repeat(5000) });
    }
    return msgs;
  };
  const chars = (msgs) => msgs.reduce((n, m) => n + (m.content?.length || 0) + JSON.stringify(m.tool_calls || '').length, 0);
  const assistants = (msgs) => msgs.filter((m) => m.role === 'assistant');

  // 1) a moderate budget is met by eliding alone: every round is still there
  const a = build();
  assert.ok(chars(a) > 110_000);
  const r1 = pruneMessages(a, 70_000);
  assert.equal(r1.pruned, true);
  assert.equal(r1.droppedRounds, 0);
  assert.equal(assistants(a).length, 12, 'no round was dropped');
  assert.ok(chars(a) <= 70_000);
  assertConsistentTranscript(a);
  assert.ok(!/x{60}/.test(JSON.stringify(assistants(a)[0])), 'old file bodies are elided');
  assert.match(assistants(a)[0].tool_calls[0].function.arguments, /f0\.js/, 'but the path is kept');
  assert.match(a.filter((m) => m.role === 'tool')[0].content, /older tool output elided/);
  assert.equal(a.filter((m) => m.role === 'tool').at(-1).content.length, 5000, 'the latest result is untouched');
  assert.ok(/x{60}/.test(JSON.stringify(assistants(a).at(-1))), 'the latest call keeps its body');

  // 2) an impossible budget drops the oldest whole rounds, keeping pairs intact and the last 3 rounds
  const b = build();
  const r2 = pruneMessages(b, 20_000);
  assert.ok(r2.droppedRounds > 0);
  assertConsistentTranscript(b);
  // ...and what the dropped rounds found is not simply lost: one line each, in
  // one small message right after the system prompt, before the conversation.
  const log = b.find((m) => m.role === 'user' && m.content.startsWith('[work so far]'));
  assert.ok(log, 'a work log was written');
  assert.equal(b.indexOf(log), 1, 'the log sits at the top, where later passes cannot drop it');
  assert.equal(b[0].content, 'sys');
  assert.equal(b[2].content, 'hi');
  assert.ok(log.content.length < 4600, 'the log stays small');
  const lines = worklogLines(b);
  assert.ok(lines.length >= r2.droppedRounds, `one line per dropped call at least: ${JSON.stringify(lines.slice(0, 3))}`);
  assert.ok(lines.some((l) => /write_file f\d+\.js/.test(l)), 'the files that were written are remembered');
  assert.ok(!/elided/.test(lines.join('\n')), 'the log keeps what the tool said, not the placeholder');
  assert.ok(assistants(b).length >= 3);
  assert.equal(assistants(b).at(-1).tool_calls[0].id, 'c11');
  JSON.parse(assistants(b).at(-1).tool_calls[0].function.arguments);

  // 3) an emergency provider-sized budget can compact even the newest file body while keeping its tool pair valid
  const d = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'keep this current request' }];
  for (let i = 0; i < 3; i++) {
    d.push({ role: 'assistant', content: null, tool_calls: [{ id: `z${i}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: `new${i}.js`, content: 'x'.repeat(5000) }) } }] });
    d.push({ role: 'tool', tool_call_id: `z${i}`, content: 'y'.repeat(10_000) });
  }
  const r3 = pruneMessages(d, 3000);
  assert.equal(r3.overBudget, false);
  assert.ok(r3.droppedRounds >= 1);
  assert.ok(d.some((m) => /keep this current request/.test(String(m.content))), 'the current request survives');
  assertConsistentTranscript(d);
  const lastArgs = JSON.parse(d.find((m) => m.role === 'assistant' && m.tool_calls)?.tool_calls[0].function.arguments);
  assert.match(lastArgs.content, /omitted from history/);

  // 4) under budget: untouched
  const c = build();
  assert.equal(pruneMessages(c, 1_000_000).pruned, false);
  assert.equal(c.length, 26);
});

test('pruning never clips a multimodal message into a broken string', () => {
  const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const content = [
    { type: 'text', text: 'What is wrong with this screenshot? '.repeat(60) },
    { type: 'image_url', image_url: { url: imageUrl } },
  ];
  const filler = (n) => ({ role: 'user', content: 'x'.repeat(n) });
  const messages = [
    { role: 'system', content: 'rules' },
    ...Array.from({ length: 12 }, () => filler(4000)),
    // The current request is the one carrying the image.
    { role: 'user', content },
  ];

  // A budget tight enough to force real compaction.
  pruneMessages(messages, 8000);

  const withImage = messages.find((m) => Array.isArray(m.content));
  assert.ok(withImage, 'the current message kept its image');
  assert.ok(Array.isArray(withImage.content), 'its content is still the multimodal array');
  assert.equal(withImage.content[1].type, 'image_url');
  assert.equal(withImage.content[1].image_url.url, imageUrl, 'the image bytes are untouched');
});

test('provider context-limit errors trigger bounded history compaction and a safe retry', async () => {
  const history = [
    { role: 'user', content: 'ARCHIVE_MARKER '.repeat(7000) },
    { role: 'assistant', content: 'Older summary one.' },
    { role: 'user', content: 'Older question two.' },
    { role: 'assistant', content: 'Older answer two.' },
    { role: 'user', content: 'Older question three.' },
    { role: 'assistant', content: 'Older answer three.' },
    { role: 'user', content: 'Older question four.' },
    { role: 'assistant', content: 'Older answer four.' },
    { role: 'user', content: 'build me a landing page' },
  ];
  const { events, result, requests } = await agentRun({ model: 'fake-context', history });
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.contextRetries, 1);
  assert.ok(requests.length >= 2, 'the oversized request is retried after compaction');
  const firstChars = JSON.stringify(requests[0].messages).length;
  const retryChars = JSON.stringify(requests[1].messages).length;
  assert.ok(firstChars > 35_000, `first prompt exceeds the fake provider limit: ${firstChars}`);
  assert.ok(retryChars < 35_000, `compacted retry fits the provider limit: ${retryChars}`);
  const retriedMessages = JSON.stringify(requests[1].messages);
  assert.match(retriedMessages, /build me a landing page/, 'the current task survives compaction');
  assert.ok(retriedMessages.length < firstChars / 2, 'the oversized history is dramatically smaller');
  assert.match(retriedMessages, /older conversation omitted/, 'compaction clearly marks retained fragments of old context');
  assert.ok(events.some((e) => /context limit hit.*retrying/i.test(e.status || '')), 'the user sees why the agent is retrying');
});

test('provider errors surface as a clear error event (after retrying), and the run still ends cleanly', async () => {
  process.env.DANAV_LLM_RETRY_BASE_MS = '5';
  try {
    const { events, result, requests } = await agentRun({ model: 'fake-http-500' });
    assert.equal(result.stopReason, 'error');
    assert.match(events.find((e) => e.error).error, /upstream exploded/);
    assert.equal(requests.length, 4, 'a 5xx is retried three times before giving up');
    assert.ok(events.some((e) => /retrying in/.test(e.status || '')), 'the user is told it is retrying');
    assert.equal(agentEvents(events, 'run_end').length, 1);
    const noTools = await agentRun({ model: 'fake-no-tools' });
    assert.match(noTools.events.find((e) => e.error).error, /does not support tool calling/);
    assert.equal(noTools.requests.length, 1, 'a 400 is not retried');
  } finally {
    delete process.env.DANAV_LLM_RETRY_BASE_MS;
  }
});

test('same-file edit streaks in one model response become one atomic multi_edit action', async () => {
  const { events, result, dir, requests } = await agentRun({ model: 'fake-edit-streak' });
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.toolCalls, 2, 'the initial write plus one combined edit were executed');

  const starts = agentEvents(events, 'action_start');
  assert.deepEqual(starts.map((action) => action.tool), ['write_file', 'multi_edit']);
  const edit = agentEvents(events, 'action_end').find((action) => action.result?.kind === 'edit');
  assert.ok(edit);
  assert.equal(edit.result.edits, 3);
  assert.deepEqual(edit.result.ranges, [[26, 26], [147, 147], [924, 924]]);

  const lines = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').split('\n');
  assert.equal(lines[25], 'line 26 updated');
  assert.equal(lines[146], 'line 147 updated');
  assert.equal(lines[923], 'line 924 updated');

  const transcript = requests.at(-1).messages;
  assertConsistentTranscript(transcript);
  const assistantCall = transcript.find((message) => message.role === 'assistant' && message.tool_calls?.length === 4);
  assert.deepEqual(assistantCall.tool_calls.map((call) => call.function.name), [
    'write_file', 'edit_file', 'edit_file', 'edit_file',
  ], 'the provider transcript retains its original call ids and schemas');
});

test('batching: outline, chunked read and ONE multi_edit across two files, through the real loop', async () => {
  const { events, result, dir } = await agentRun({ model: 'fake-batch' });
  assert.equal(result.stopReason, 'completed');
  const ends = agentEvents(events, 'action_end');
  const kinds = ends.map((a) => a.result.kind);
  assert.equal(ends.length, 5, JSON.stringify(kinds));
  assert.deepEqual(kinds.slice(0, 2), ['write', 'write'], JSON.stringify(kinds));
  // file_outline and read_file are read-only, so the loop runs them in PARALLEL:
  // their action_end order is whichever finishes first, not the request order.
  // Both must be present, in either order.
  assert.deepEqual([...kinds.slice(2, 4)].sort(), ['outline', 'read'], JSON.stringify(kinds));
  assert.equal(kinds[4], 'edit', JSON.stringify(kinds));
  assert.ok(ends.every((a) => a.status === 'done'), JSON.stringify(ends.filter((a) => a.status !== 'done')));
  const outline = ends.find((a) => a.result.kind === 'outline').result;
  assert.equal(outline.path, 'big.js');
  assert.equal(outline.count, 3);
  const read = ends.find((a) => a.result.kind === 'read').result;
  assert.deepEqual(read.ranges, [[1, 5], [40, 45]]);
  const edit = ends.find((a) => a.result.kind === 'edit').result;
  assert.equal(edit.edits, 4, 'four edits in a single call');
  assert.deepEqual(edit.changes.map((c) => [c.path, c.edits]), [['big.js', 3], ['style.css', 1]]);
  const js = fs.readFileSync(path.join(dir, 'big.js'), 'utf8').split('\n');
  assert.equal(js[2], '  // changed line 3');
  assert.equal(js.at(-2), 'done();');
  assert.equal(js.length, 59, '60 lines: line 3 replaced (±0), lines 50–52 deleted (−3), one line appended (+1) → 58 lines + the trailing newline');
  assert.match(fs.readFileSync(path.join(dir, 'style.css'), 'utf8'), /color: blue/);
  assert.equal(agentEvents(events, 'action_start').filter((a) => a.tool === 'multi_edit').length, 1);
});

test('a write cut off by the output limit keeps its complete lines; the model carries on with append_file', async () => {
  const { events, result, dir, requests } = await agentRun({ model: 'fake-truncate' });
  assert.equal(result.stopReason, 'completed');
  const ends = agentEvents(events, 'action_end');
  assert.deepEqual(ends.map((a) => [a.result.kind, a.status]), [['write', 'done'], ['append', 'done']]);
  assert.equal(ends[0].result.partial, true, 'the first write is marked as rescued');
  assert.equal(ends[0].result.added, 40, 'the 40 complete lines were saved, the half-written 41st was dropped');
  const file = fs.readFileSync(path.join(dir, 'data.js'), 'utf8').split('\n');
  assert.equal(file.length, 61, '60 lines + the trailing newline');
  assert.equal(file[40], 'const row41 = 41;');
  assert.equal(file[59], 'const row60 = 60;');
  // what the model was told after the cut-off
  const toolMsg = requests[1].messages.filter((m) => m.role === 'tool')[0].content;
  assert.match(toolMsg, /hit the length limit/);
  assert.match(toolMsg, /saved the 40 complete lines/);
  assert.match(toolMsg, /ends with:\nconst row38 = 38;\nconst row39 = 39;\nconst row40 = 40;/);
  assert.match(toolMsg, /call append_file/);
  assert.ok(!/SYNTAX/.test(toolMsg), 'an unfinished file is not judged yet');
  assertConsistentTranscript(requests.at(-1).messages);
});

test('read-only tools of one round run IN PARALLEL; the model still sees the results in order', async () => {
  const l = await getLlm();
  l.requests.length = 0;
  const dir = tmp('danav-par-');
  const ws = new LocalWorkspace({ id: 'ws-par', kind: 'local', name: 'par', root: dir, autoRun: true });
  await ws.init();
  const events = [];
  const t0 = Date.now();
  await runAgent({
    provider: { baseUrl: l.baseUrl },
    model: 'fake-parallel',
    history: [{ role: 'user', content: 'research' }],
    workspace: ws,
    runSearchTool: async (name, args) => {
      await new Promise((r) => setTimeout(r, 350));
      return { success: true, output: `result for ${args.query}`, results: [{}] };
    },
    send: (e) => events.push(e),
    signal: new AbortController().signal,
    runId: genId('run'),
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1100, `four 350ms searches should overlap (took ${elapsed}ms)`);
  const starts = events.filter((e) => e.agent?.patch?.status === 'running').map((e) => e.agent.id);
  const firstEnd = events.findIndex((e) => e.agent?.type === 'action_end');
  const startedBeforeFirstEnd = events.slice(0, firstEnd).filter((e) => e.agent?.patch?.status === 'running').length;
  assert.equal(startedBeforeFirstEnd, 4, 'all four were already running when the first one finished');
  assert.equal(starts.length, 4);
  const toolMsgs = l.requests.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.deepEqual(toolMsgs.map((c) => /result for (q\d)/.exec(c)[1]), ['q1', 'q2', 'q3', 'q4'], 'results are handed back in the order they were asked');
  assertConsistentTranscript(l.requests.at(-1).messages);
});

test('the run refuses to delete what it has never looked at, and says what to look at', async () => {
  // The whole point of the gate: a model that goes straight for the delete does
  // not get to make it. Nothing is asked of the system prompt — the call simply
  // does not run, and the tool result tells the model what evidence is missing.
  const root = tmp('danav-gate-');
  fs.mkdirSync(path.join(root, 'legacy', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'legacy', 'old.js'), 'old\n');
  fs.writeFileSync(path.join(root, 'legacy', 'nested', 'deep.js'), 'deep\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'app\n');
  const ws = new LocalWorkspace({ id: 'ws-gate', kind: 'local', name: 'gate', root, autoRun: true });

  // The run is synchronous, so "was anything touched?" has to be sampled the
  // moment the refusal lands — by the end of the run the agent has done it right.
  const atRefusal = [];
  const { events, requests } = await agentRun({
    model: 'fake-gate',
    workspace: ws,
    onEvent: (e) => {
      if (e.agent?.type === 'action_end' && e.agent.status === 'blocked') {
        atRefusal.push({
          legacy: fs.existsSync(path.join(root, 'legacy', 'old.js')),
          src: fs.existsSync(path.join(root, 'src', 'app.js')),
        });
      }
    },
  });
  const ends = agentEvents(events, 'action_end');
  const starts = agentEvents(events, 'action_start');

  // 1. the un-inspected delete never ran
  assert.equal(ends[0].status, 'blocked', `expected a refusal, got ${ends[0].status}: ${ends[0].error}`);
  assert.equal(ends[0].ok, false);
  assert.equal(ends[0].result.blocked, true);
  assert.match(ends[0].error, /not looked inside/);
  assert.match(ends[0].error, /list_dir/, 'and it names the call that would fix it');
  assert.equal(atRefusal[0].legacy, true, 'the folder was still there when it was refused');
  const refusal = requests.flatMap((r) => r.messages).find((m) => m.role === 'tool' && /Refused/.test(m.content));
  assert.ok(refusal, 'the model reads the refusal back as the tool result');
  assert.match(refusal.content, /list_dir/);

  // 2. after listing it, the same delete goes through
  assert.equal(starts[1].tool, 'list_dir');
  assert.equal(ends[1].status, 'done');
  assert.equal(starts[2].tool, 'delete_file');
  assert.equal(ends[2].status, 'done');
  assert.equal(fs.existsSync(path.join(root, 'legacy')), false, 'and now it is really gone');

  // 3. the same rule covers a destructive shell command
  assert.equal(starts[3].tool, 'run_command');
  assert.equal(ends[3].status, 'blocked', `expected a refusal, got ${ends[3].status}: ${ends[3].error}`);
  assert.match(ends[3].error, /src\//);
  assert.equal(atRefusal[1].src, true, 'the command did not run');
  assert.equal(starts[4].tool, 'list_dir');
  assert.equal(ends[5].status, 'done');
  assert.equal(fs.existsSync(path.join(root, 'src')), false);

  // A refusal is guidance, not a failure streak: the run finishes normally.
  assert.equal(agentEvents(events, 'run_end')[0].stopReason, 'completed');
  assertConsistentTranscript(requests.at(-1).messages);
});

test('persist: unfinished actions are settled as interrupted; everything is bounded', () => {
  const running = normalizeAgentBlockForDisk({ id: 'b1', type: 'action', action: { id: 'a1', tool: 'run_command', status: 'running', args: { command: 'npm install' }, output: 'x'.repeat(20000) } });
  assert.equal(running.action.status, 'error');
  assert.match(running.action.error, /Interrupted/);
  assert.equal(running.action.output.length, 4000);
  const done = normalizeAgentBlockForDisk({
    id: 'b2', type: 'action',
    action: { id: 'a2', tool: 'write_file', status: 'done', args: { path: 'a.js', content: 'SHOULD-NOT-SURVIVE'.repeat(100) }, result: { kind: 'write', added: 5, removed: 1, ranges: [[1, 5]], hunks: [{ newStart: 1, lines: Array.from({ length: 200 }, (_, i) => ({ t: '+', n: i + 1, s: 'l'.repeat(900) })) }], secret: { nested: 1 } } },
  });
  assert.equal(done.action.status, 'done');
  assert.ok(done.action.args.content.length <= 600);
  assert.equal(done.action.result.added, 5);
  assert.equal(done.action.result.secret, undefined);
  assert.ok(done.action.result.hunks[0].lines.length <= 40);
  assert.ok(done.action.result.hunks[0].lines[0].s.length <= 200);
  const multi = normalizeAgentBlockForDisk({
    id: 'b3', type: 'action',
    action: { id: 'a3', tool: 'multi_edit', status: 'done', result: { kind: 'edit', path: 'a.js', added: 5, removed: 2, changes: Array.from({ length: 30 }, (_, i) => ({ path: `f${i}.js`, added: 1, removed: 0, edits: 2, ranges: [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8]], hunks: [{ newStart: 1, lines: Array.from({ length: 50 }, () => ({ t: '+', n: 1, s: 'x' })) }] })) } },
  });
  assert.equal(multi.action.result.changes.length, 12, 'a long per-file list is capped');
  assert.ok(multi.action.result.changes.every((f) => f.ranges.length <= 6 && f.hunks[0].lines.length <= 6));
  assert.equal(normalizeAgentBlockForDisk({ id: 'x', type: 'text', content: '' }), null);
  assert.equal(normalizeAgentBlockForDisk({ id: 'x', type: 'action', action: { nope: 1 } }), null);
  assert.equal(normalizeAgentBlockForDisk({ id: 'x', type: 'text', content: 'hello' }).content, 'hello');
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

async function startApp() {
  const dataDir = tmp('danav-data-');
  const wsDir = tmp('danav-wsdir-');
  const saved = {
    DANAV_DATA_DIR: process.env.DANAV_DATA_DIR,
    DANAV_WORKSPACES_DIR: process.env.DANAV_WORKSPACES_DIR,
    NOVITA_API_KEY: process.env.NOVITA_API_KEY,
    DANAV_ALLOWED_HOSTS: process.env.DANAV_ALLOWED_HOSTS,
    DANAV_ALLOW_ANY_LOCAL_PATH: process.env.DANAV_ALLOW_ANY_LOCAL_PATH,
  };
  process.env.DANAV_DATA_DIR = dataDir;
  process.env.DANAV_WORKSPACES_DIR = wsDir;
  delete process.env.NOVITA_API_KEY;
  delete process.env.DANAV_ALLOWED_HOSTS;
  delete process.env.DANAV_ALLOW_ANY_LOCAL_PATH;
  _resetStoreCache();

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  registerAgentRoutes(app, { runSearchTool: async () => ({ success: false }) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { 'Content-Type': 'application/json', 'x-danav-agent': '1' };
  const api = async (method, url, body, headers = H) => {
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json };
  };
  const stop = async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    _resetStoreCache();
  };
  return { base, api, H, dataDir, wsDir, stop, server };
}

async function readSse(res, onEvent) {
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') { events.push('[DONE]'); continue; }
      const obj = JSON.parse(payload);
      events.push(obj);
      onEvent?.(obj);
    }
  }
  return events;
}

test('routes: the request guard needs the header and a loopback Host', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.api('GET', '/api/agent/config', undefined, { 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await app.api('GET', '/api/agent/config')).status, 200);
    // DNS-rebinding style: right header, wrong Host
    const status = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: new URL(app.base).port, path: '/api/agent/config', headers: { Host: 'evil.example.com', 'x-danav-agent': '1' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    assert.equal(status, 403);
    process.env.DANAV_ALLOWED_HOSTS = '.example.com';
    const allowed = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: new URL(app.base).port, path: '/api/agent/config', headers: { Host: 'agent.example.com', 'x-danav-agent': '1' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    assert.equal(allowed, 200);
    // and no CORS headers are ever sent
    const r = await fetch(`${app.base}/api/agent/config`, { headers: { ...app.H, Origin: 'https://evil.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  } finally {
    await app.stop();
  }
});

test('routes: config never reveals the Novita key; workspace creation rules', async () => {
  const app = await startApp();
  try {
    const realKey = process.env.NOVITA_API_KEY; // startApp() removed it; stop() puts it back
    process.env.NOVITA_API_KEY = 'sk_never_show_this_key_000111';
    const cfg = await app.api('GET', '/api/agent/config');
    assert.equal(cfg.json.novita.configured, true);
    assert.equal(cfg.json.novita.source, 'env');
    assert.ok(!JSON.stringify(cfg.json).includes('never_show_this'));
    delete process.env.NOVITA_API_KEY;
    assert.equal((await app.api('GET', '/api/agent/config')).json.novita.configured, false);

    const a = await app.api('POST', '/api/agent/workspaces', { name: 'My Cool App!', kind: 'local' });
    assert.equal(a.status, 200);
    const memory = await app.api('GET', `/api/agent/workspaces/${a.json.workspace.id}/memory`);
    assert.deepEqual(memory.json.notes, []);
    assert.deepEqual(memory.json.runs, []);
    assert.equal(a.json.workspace.kind, 'local');
    assert.equal(a.json.workspace.autoRun, false); // local defaults to asking
    assert.equal(path.dirname(a.json.workspace.root), app.wsDir);
    assert.equal(path.basename(a.json.workspace.root), 'my-cool-app');
    assert.ok(fs.statSync(a.json.workspace.root).isDirectory());
    const b = await app.api('POST', '/api/agent/workspaces', { name: 'My Cool App!', kind: 'local' });
    assert.equal(path.basename(b.json.workspace.root), 'my-cool-app-2', 'a second workspace gets its own folder');

    const outside = await app.api('POST', '/api/agent/workspaces', { kind: 'local', path: path.join(os.tmpdir(), 'somewhere-else') });
    assert.equal(outside.status, 400);
    assert.equal(outside.json.code, 'path_not_allowed');
    assert.equal((await app.api('POST', '/api/agent/workspaces', { kind: 'local', path: os.homedir() })).status, 400);
    assert.equal((await app.api('POST', '/api/agent/workspaces', { kind: 'local', path: 'relative/path' })).status, 400);
    assert.equal((await app.api('POST', '/api/agent/workspaces', { kind: 'cloud' })).status, 400);
    const noKey = await app.api('POST', '/api/agent/workspaces', { kind: 'sandbox' });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.json.code, 'no_key');

    const inside = path.join(app.wsDir, 'existing-project');
    fs.mkdirSync(inside);
    const custom = await app.api('POST', '/api/agent/workspaces', { kind: 'local', path: inside, name: 'Existing' });
    assert.equal(custom.json.workspace.root, inside);

    const list = await app.api('GET', '/api/agent/workspaces');
    assert.equal(list.json.workspaces.length, 3);
    const patched = await app.api('PATCH', `/api/agent/workspaces/${a.json.workspace.id}`, { autoRun: true, name: 'Renamed' });
    assert.equal(patched.json.workspace.autoRun, true);
    assert.equal(patched.json.workspace.name, 'Renamed');

    // persisted metadata holds no secrets
    const stored = fs.readFileSync(path.join(app.dataDir, 'agent-workspaces.json'), 'utf8');
    assert.ok(!/sk_/.test(stored));

    assert.equal((await app.api('DELETE', `/api/agent/workspaces/${b.json.workspace.id}`)).status, 200);
    assert.ok(fs.existsSync(b.json.workspace.root), 'deleting a local workspace keeps your files');
    assert.equal((await app.api('GET', '/api/agent/workspaces')).json.workspaces.length, 2);
    assert.equal((await app.api('DELETE', '/api/agent/workspaces/ws-nope')).status, 404);
  } finally {
    await app.stop();
  }
});

test('routes: file tree and viewer are confined and redact secrets', async () => {
  const app = await startApp();
  try {
    const ws = (await app.api('POST', '/api/agent/workspaces', { name: 'view', kind: 'local' })).json.workspace;
    fs.mkdirSync(path.join(ws.root, 'src'));
    fs.writeFileSync(path.join(ws.root, 'src/a.js'), 'console.log(1);\n');
    process.env.NOVITA_API_KEY = 'sk_viewer_secret_value_99999'; // startApp() restores the real value on stop
    fs.writeFileSync(path.join(ws.root, '.env'), 'NOVITA_API_KEY=sk_viewer_secret_value_99999\n');
    const tree = await app.api('GET', `/api/agent/workspaces/${ws.id}/tree`);
    assert.deepEqual(tree.json.entries.map((e) => `${e.type}:${e.path}`), ['dir:src', 'file:.env']);
    const sub = await app.api('GET', `/api/agent/workspaces/${ws.id}/tree?path=src`);
    assert.equal(sub.json.entries[0].path, 'src/a.js');
    const file = await app.api('GET', `/api/agent/workspaces/${ws.id}/file?path=src/a.js`);
    assert.equal(file.json.text, 'console.log(1);\n');
    const env = await app.api('GET', `/api/agent/workspaces/${ws.id}/file?path=.env`);
    assert.ok(!env.json.text.includes('viewer_secret'));
    assert.equal((await app.api('GET', `/api/agent/workspaces/${ws.id}/file?path=../../etc/passwd`)).status, 400);
    assert.equal((await app.api('GET', `/api/agent/workspaces/${ws.id}/tree?path=..`)).status, 400);
  } finally {
    await app.stop();
  }
});

test('routes: /chat streams the whole run over SSE, enforces one run per workspace, and releases the lock', async () => {
  const l = await getLlm();
  const app = await startApp();
  try {
    const ws = (await app.api('POST', '/api/agent/workspaces', { name: 'sse', kind: 'local', autoRun: true })).json.workspace;
    const body = (model) => JSON.stringify({ provider: { id: 'p', baseUrl: l.baseUrl, apiType: 'openai', apiKey: 'k1234567890' }, model, thinkingLevel: 'Auto', messages: [{ role: 'user', content: 'go' }], workspaceId: ws.id });

    // validation
    const bad = await fetch(`${app.base}/api/agent/chat`, { method: 'POST', headers: app.H, body: JSON.stringify({ provider: { apiType: 'mock' }, model: 'x', messages: [{ role: 'user', content: 'hi' }], workspaceId: ws.id }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Demo provider cannot run the agent/);
    const gone = await fetch(`${app.base}/api/agent/chat`, { method: 'POST', headers: app.H, body: JSON.stringify({ provider: { baseUrl: l.baseUrl }, model: 'fake-build', messages: [{ role: 'user', content: 'hi' }], workspaceId: 'ws-missing' }) });
    assert.equal(gone.status, 404);

    // a real run, with a concurrent attempt part-way through
    let second = null;
    const res = await fetch(`${app.base}/api/agent/chat`, { method: 'POST', headers: app.H, body: body('fake-slow') });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = await readSse(res, async (e) => {
      if (e.agent?.type === 'action_start' && !second) {
        second = fetch(`${app.base}/api/agent/chat`, { method: 'POST', headers: app.H, body: body('fake-build') }).then((r) => r.status);
      }
    });
    assert.equal(await second, 409, 'a second run in the same workspace is refused');
    assert.equal(events.at(-1), '[DONE]');
    assert.ok(events.some((e) => e.agent?.type === 'run_start'));
    assert.equal(events.find((e) => e.agent?.type === 'run_end').agent.stopReason, 'completed');
    assert.equal(_activeRuns.has(ws.id), false, 'lock released');
    const memory = await app.api('GET', `/api/agent/workspaces/${ws.id}/memory`);
    assert.equal(memory.json.runs.length, 1);
    assert.equal(memory.json.runs[0].changed[0].path, 'index.html', 'the UI endpoint exposes only the compact change journal');

    // client disconnect cancels the run and frees the workspace
    const ac = new AbortController();
    const res2 = await fetch(`${app.base}/api/agent/chat`, { method: 'POST', headers: app.H, body: body('fake-loop'), signal: ac.signal });
    const reader = res2.body.getReader();
    await reader.read();
    ac.abort();
    for (let i = 0; i < 40 && _activeRuns.has(ws.id); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(_activeRuns.has(ws.id), false, 'lock released after the client left');
  } finally {
    await app.stop();
  }
});

test('routes: approving a command over HTTP lets the run continue', async () => {
  if (isWin) return;
  const l = await getLlm();
  const app = await startApp();
  try {
    const ws = (await app.api('POST', '/api/agent/workspaces', { name: 'appr', kind: 'local', autoRun: false })).json.workspace;
    const res = await fetch(`${app.base}/api/agent/chat`, {
      method: 'POST', headers: app.H,
      body: JSON.stringify({ provider: { baseUrl: l.baseUrl }, model: 'fake-approval', messages: [{ role: 'user', content: 'go' }], workspaceId: ws.id }),
    });
    let answered = false;
    const events = await readSse(res, async (e) => {
      const p = e.agent?.patch;
      if (p?.status === 'awaiting_approval' && !answered) {
        answered = true;
        const r = await app.api('POST', `/api/agent/approvals/${encodeURIComponent(p.approval.key)}`, { allow: true });
        assert.equal(r.json.success, true);
      }
    });
    assert.ok(answered);
    const end = events.find((e) => e.agent?.type === 'action_end');
    assert.equal(end.agent.status, 'done');
    assert.match(end.agent.output, /approved-output/);
    // answering twice is harmless
    assert.equal((await app.api('POST', '/api/agent/approvals/run-x:a-y', { allow: true })).json.success, false);
  } finally {
    await app.stop();
  }
});

test('routes: "always allow" flips the workspace to auto-run', async () => {
  const app = await startApp();
  try {
    const ws = (await app.api('POST', '/api/agent/workspaces', { name: 'al', kind: 'local', autoRun: false })).json.workspace;
    await app.api('POST', '/api/agent/approvals/run-1:a-1', { allow: true, always: true, workspaceId: ws.id });
    const list = await app.api('GET', '/api/agent/workspaces');
    assert.equal(list.json.workspaces.find((w) => w.id === ws.id).autoRun, true);
  } finally {
    await app.stop();
  }
});

// ===========================================================================
// Recovery and self-awareness of a run: a dropped answer, an empty turn, a
// call that answers nothing new, and code that was never checked.
// ===========================================================================

test('a dropped answer is picked up without repeating what was already read', async () => {
  // The connection dies mid-answer (a proxy, a flaky network) and the provider
  // writes the same opening again. The user must end up with the whole answer,
  // each part exactly once — losing it, or showing it twice, both read as broken.
  const { events, requests } = await agentRun({ model: 'fake-drop', history: [{ role: 'user', content: 'say the sentence' }] });
  assert.equal(requests.length, 2, 'the request was repeated once');

  const streamed = saidSoFar(events);
  assert.equal(streamed, 'First half of the answer. Second half of the answer.');
  assert.equal((streamed.match(/First half/g) || []).length, 1, 'the repeated opening was not shown twice');

  const notices = noticesSeen(events);
  assert.ok(notices.some((n) => /asking the provider again/i.test(n)), `expected a notice about the retry, got ${JSON.stringify(notices)}`);
});

test('a provider that keeps dropping leaves the partial answer and the run lives on', async () => {
  const { events, result } = await agentRun({ model: 'fake-drop-always', history: [{ role: 'user', content: 'say the sentence' }] });
  const streamed = saidSoFar(events);
  assert.match(streamed, /Only this much/);
  assert.match(streamed, /connection to the provider dropped/i, 'the user is told why the answer stops');
  assert.notEqual(result.stopReason, 'error');
  assert.ok(events.some((e) => e.agent?.type === 'run_end'), 'the run still ended properly');
});

test('an empty response is never the end of the run in silence', async () => {
  // A reasoning model that spent its whole turn thinking, or an endpoint that
  // returned an empty choice: no answer, no tool call. This used to end the run
  // with a blank assistant message.
  const { events, requests } = await agentRun({ model: 'fake-empty-first', history: [{ role: 'user', content: 'hello there' }] });
  assert.equal(saidSoFar(events), 'Here is the answer you asked for.');
  assert.equal(requests.length, 2, 'the empty turn was retried instead of ending the run');
  assert.match(JSON.stringify(requests[1].messages), /empty/i, 'the model was told what it did wrong');

  // ...and if it keeps returning nothing, the user is told rather than left with silence
  const always = await agentRun({ model: 'fake-empty-always', history: [{ role: 'user', content: 'hello there' }] });
  assert.match(noticesSeen(always.events).join(' | '), /empty/i, 'a message, not silence');
});

test('a call that keeps answering the same thing stops the run instead of spinning', async () => {
  const { events, result, requests } = await agentRun({ model: 'fake-no-progress', history: [{ role: 'user', content: 'look at notes.txt' }], workspace: (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-np-'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'fixed content\n');
    return new LocalWorkspace({ id: 'ws-np', kind: 'local', name: 'np', root: dir, autoRun: true });
  })() });

  assert.equal(result.stopReason, 'no_progress', 'the loop stopped itself');
  assert.ok(requests.length <= 6, `it did not grind through the whole budget (${requests.length} requests)`);
  const modelView = requests.map((r) => JSON.stringify(r.messages)).join('\n');
  assert.match(modelView, /\[NO PROGRESS\]/, 'the model was told the call gave it nothing new');
  // The user-facing explanation for a stopped run comes from the frontend's
  // stopNotice(stopReason), which is covered in the frontend suite — what matters
  // here is that the run reports a reason at all, and it reached the journal.
  assert.equal(events.find((e) => e.agent?.type === 'run_end').agent.stopReason, 'no_progress');
});

test('code that was changed but never checked is verified before the run ends', async () => {
  const { events, result, ws } = await agentRun({ model: 'fake-unverified', history: [{ role: 'user', content: 'write app.js' }] });
  assert.ok(fs.existsSync(path.join(ws.root, 'app.js')), 'the file was written');
  assert.equal(result.stopReason, 'completed');
  assert.ok(
    noticesSeen(events).some((n) => /no check has been run/i.test(n)),
    'the user can see why the model is still working'
  );
  const commands = events.filter((e) => e.agent?.type === 'action_start' && e.agent.tool === 'run_command');
  assert.ok(commands.length >= 1, 'a real check ran after the nudge');
  assert.match(saidSoFar(events), /verified/i, 'the run ended with the check it ran');
});

test('each budget warning is said once, and the prompt states the budget', async () => {
  const previous = process.env.DANAV_AGENT_MAX_STEPS;
  process.env.DANAV_AGENT_MAX_STEPS = '12';
  try {
    const { events, requests } = await agentRun({ model: 'fake-loop', history: [{ role: 'user', content: 'keep going' }] });
    const notices = noticesSeen(events);
    assert.equal(notices.length, new Set(notices).size, 'no notice is repeated');
    assert.ok(notices.some((n) => /steps for one run remain/i.test(n)), `a low-steps warning arrived: ${JSON.stringify(notices)}`);

    const lastMessages = requests[requests.length - 1].messages.map((m) => String(m.content)).join('\n');
    assert.match(lastMessages, /steps for one run remain/, 'the model was told the budget is nearly gone');

    const system = String(requests[0].messages[0].content);
    assert.match(system, /up to 12 model turns/, 'the prompt states the real step budget');
    assert.match(system, /documentation true/i);
    assert.match(system, /context as finite/i);
  } finally {
    if (previous === undefined) delete process.env.DANAV_AGENT_MAX_STEPS;
    else process.env.DANAV_AGENT_MAX_STEPS = previous;
  }
});

test('a check is recognized in a chained command, and never from raw shell text', () => {
  // Labels come from a fixed vocabulary, so a remembered "check" can never carry
  // an argument or a secret — and a run that really verified is not recorded as
  // one that changed files and checked nothing.
  assert.equal(verificationLabel('npm test'), 'npm test');
  assert.equal(verificationLabel('cd app && npm test'), 'npm test');
  assert.equal(verificationLabel('npm ci && npm run build'), 'npm run build');
  assert.equal(verificationLabel('CI=1 npx vitest run --coverage'), 'npx vitest');
  assert.equal(verificationLabel('node --test src/greet.test.js'), 'node --test');
  assert.equal(verificationLabel('python3 -m unittest discover'), 'python -m unittest');
  assert.equal(verificationLabel('go test ./...'), 'go test');
  assert.equal(verificationLabel('cargo test --release'), 'cargo test');
  assert.equal(verificationLabel('npm run test:unit'), 'npm run test:unit');
  assert.equal(verificationLabel('npm test -- --token=sk-secret'), 'npm test');
  assert.equal(verificationLabel('echo "npm test is good"'), null);
  assert.equal(verificationLabel('node script.js'), null);
  assert.equal(verificationLabel(''), null);
});

test('work that goes deep without a plan is reminded once, and the plan is kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-plan-'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'line one\nline two\n');
  const ws = new LocalWorkspace({ id: 'ws-plan', kind: 'local', name: 'plan', root: dir, autoRun: true });
  const { events, requests } = await agentRun({ model: 'fake-plan-late', history: [{ role: 'user', content: 'start the job' }], workspace: ws });

  const withReminder = requests.findIndex((r) => JSON.stringify(r.messages).includes('no plan is recorded'));
  assert.ok(withReminder >= 1, 'the model was reminded to plan');
  const usedThen = requests[withReminder].messages.filter((m) => m.role === 'tool').length;
  assert.ok(usedThen >= 5, `the reminder came once the run was really underway (${usedThen} calls)`);
  // said once: the last request of the run still carries exactly one reminder
  const occurrences = (JSON.stringify(requests.at(-1).messages).match(/no plan is recorded/g) || []).length;
  assert.equal(occurrences, 1, 'the reminder is not repeated every round');

  const plans = events.filter((e) => e.agent?.type === 'action_end' && e.agent.result?.kind === 'plan');
  assert.equal(plans.length, 1, 'the plan reached the chat');
  assert.equal(plans[0].agent.result.todos[1].status, 'in_progress');
  assert.equal(plans[0].agent.result.done, 1);
});

test('a plan survives the trimming of the round that produced it', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do the job' },
  ];
  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'p1',
      type: 'function',
      function: {
        name: 'update_plan',
        arguments: JSON.stringify({ todos: [{ content: 'Read the module', status: 'completed' }, { content: 'Add the retry helper', status: 'in_progress' }, { content: 'Run the tests', status: 'pending' }] }),
      },
    }],
  });
  messages.push({ role: 'tool', tool_call_id: 'p1', content: 'Plan updated: 1/3 done.' });
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: `echo ${i}` }) } }] });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, content: `ok ${i} `.repeat(200) });
  }

  pruneMessages(messages, 6000);
  const log = worklogLines(messages).join('\n');
  assert.match(log, /plan \(1\/3 done\)/, `the checklist is in the work log: ${log.slice(0, 300)}`);
  assert.match(log, /\[~\] Add the retry helper/);
  assert.match(log, /\[ \] Run the tests/);
  assert.ok(!messages.some((m) => m.role === 'assistant' && m.tool_calls?.some((tc) => tc.function.name === 'update_plan')), 'the round itself is gone');
});

// ===========================================================================
// The arguments a weak model really sends: almost-JSON, and a body without a
// destination. Both used to cost the user the whole step.
// ===========================================================================

test('a write whose JSON is almost-right is repaired, not rejected', async () => {
  // A missing comma, literal newlines in the body and unescaped quotes in the
  // HTML — the exact shape that used to answer "The arguments are not valid JSON".
  const { events, result, ws } = await agentRun({ model: 'fake-mangle-comma', history: [{ role: 'user', content: 'make the page' }] });
  assert.equal(result.stopReason, 'completed');
  const written = fs.readFileSync(path.join(ws.root, 'index.html'), 'utf8');
  assert.match(written, /^<!DOCTYPE html>/);
  assert.match(written, /<h1>Hello, world<\/h1>/, 'the body survived in full');
  assert.match(written, /class="lead"/, 'inner quotes are kept, not escaped away');
  assert.match(written, /<\/html>\n?$/, 'nothing was dropped from the end');
  const end = agentEvents(events, 'action_end').find((a) => a.result?.kind === 'write');
  assert.equal(end.status, 'done', 'the write reported success');
});

test('a write with no path keeps its body and asks for the destination', async () => {
  const { events, result, ws, requests } = await agentRun({ model: 'fake-mangle-nopath', history: [{ role: 'user', content: 'make the page' }] });
  assert.equal(result.stopReason, 'completed');
  assert.match(fs.readFileSync(path.join(ws.root, 'index.html'), 'utf8'), /Hello, world/, 'the file ended up where it belongs');

  const text = (r) => r.messages.map((m) => String(m.content || '')).join('\n');
  const modelView = requests.map(text).join('\n');
  assert.match(modelView, /without a usable "path"/, 'the model was told what went wrong');
  assert.match(modelView, /move_file with from="\.danav-recovered\//, 'and exactly how to fix it');
  assert.match(modelView, /do NOT send the body again/, 'the body is not to be re-written');
  // The body was written once: no assistant turn repeats it after the loss.
  const resent = requests.filter((r) => r.messages.some((m) => m.role === 'assistant' && String(m.content || '').includes('<h1>Hello, world</h1>'))).length;
  assert.equal(resent, 0, 'the model never had to retype the file');
  assert.equal(fs.readFileSync(path.join(ws.root, 'index.html'), 'utf8'), HTML + '', 'the recovered file is the whole page');
  assert.equal(fs.existsSync(path.join(ws.root, '.danav-recovered')), false, 'nothing is left behind');
});

test('a file longer than one output limit is written in parts and completed', async () => {
  // 120+ lines: the first call is cut off mid-string by the provider, the model
  // continues the SAME file with append_file. Long files are the point.
  const { events, result, ws, requests } = await agentRun({ model: 'fake-long-parts', history: [{ role: 'user', content: 'write a long file' }] });
  assert.equal(result.stopReason, 'completed');
  const written = fs.readFileSync(path.join(ws.root, 'big.js'), 'utf8');
  assert.match(written, /^\/\/ part 0-60/);
  assert.match(written, /export const value119 = 119;/, 'the last line of the last part is there');
  assert.ok(!/^\s*$/.test(written.trim()), 'no empty file');
  const lines = written.trim().split('\n');
  const parts = lines.filter((l) => l.startsWith('// part'));
  assert.equal(parts.length, 3, `three parts: ${JSON.stringify(parts)}`);
  assert.equal(new Set(lines).size, lines.length, 'no line was written twice while continuing');

  const modelView = requests.map((r) => JSON.stringify(r.messages)).join('\n');
  assert.match(modelView, /Continue WITHOUT repeating anything/, 'the cut-off part is explained');
  assert.match(modelView, /append_file/, 'and the way forward is named');
});
