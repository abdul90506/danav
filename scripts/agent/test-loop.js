/** The agent loop and HTTP routes, driven by a scripted fake LLM (no API keys). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { startFakeLlm, HTML, CSS } from '../fake-llm.js';
import { runAgent, pruneMessages } from '../../server/agent/loop.js';
import { LocalWorkspace } from '../../server/agent/workspaces/local.js';
import { registerAgentRoutes, _activeRuns } from '../../server/agent/routes.js';
import { resolveApproval } from '../../server/agent/approvals.js';
import { countLines } from '../../server/agent/textops.js';
import { normalizeAgentBlockForDisk } from '../../server/agent/persist.js';
import { genId } from '../../server/agent/util.js';
import { _resetStoreCache } from '../../server/agent/store.js';

const { test } = globalThis.__agentTest;
const isWin = process.platform === 'win32';

console.log('\n[loop + routes]');

let llm;
const getLlm = async () => (llm ||= await startFakeLlm({ chunkDelayMs: 0 }));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function agentRun({ model = 'fake-build', autoRun = true, history, signal, onEvent, workspace } = {}) {
  const l = await getLlm();
  l.requests.length = 0;
  const dir = workspace?.root || tmp('danav-loop-');
  const ws = workspace || new LocalWorkspace({ id: 'ws-loop', kind: 'local', name: 'loop', root: dir, autoRun });
  await ws.init();
  const events = [];
  const result = await runAgent({
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
  assert.equal(end.steps, 4);

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
  assert.equal(b[0].content, 'sys');
  assert.equal(b[1].content, 'hi');
  assert.ok(assistants(b).length >= 3);
  assert.equal(assistants(b).at(-1).tool_calls[0].id, 'c11');

  // 3) under budget: untouched
  const c = build();
  assert.equal(pruneMessages(c, 1_000_000).pruned, false);
  assert.equal(c.length, 26);
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

test('batching: outline, chunked read and ONE multi_edit across two files, through the real loop', async () => {
  const { events, result, dir } = await agentRun({ model: 'fake-batch' });
  assert.equal(result.stopReason, 'completed');
  const ends = agentEvents(events, 'action_end');
  assert.deepEqual(ends.map((a) => a.result.kind), ['write', 'write', 'outline', 'read', 'edit']);
  assert.ok(ends.every((a) => a.status === 'done'), JSON.stringify(ends.filter((a) => a.status !== 'done')));
  const outline = ends[2].result;
  assert.equal(outline.path, 'big.js');
  assert.equal(outline.count, 3);
  const read = ends[3].result;
  assert.deepEqual(read.ranges, [[1, 5], [40, 45]]);
  const edit = ends[4].result;
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
