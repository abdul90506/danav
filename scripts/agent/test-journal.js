/** Automatically persisted, queryable workspace run evidence (without prompts or file bodies). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearRunJournal, readRunJournal, recordRun, recentRunsForPrompt, taskKeyFor } from '../../server/agent/journal.js';
import { createTaskMemory } from '../../server/agent/taskMemory.js';

const { test } = globalThis.__agentTest;
console.log('\n[run journal]');

async function withDataDir(fn) {
  const previous = process.env.DANAV_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-journal-'));
  process.env.DANAV_DATA_DIR = root;
  try {
    await fn(root);
  } finally {
    if (previous === undefined) delete process.env.DANAV_DATA_DIR;
    else process.env.DANAV_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('journal keeps bounded change/check evidence and retrieves entries relevant to the current task', async () => {
  await withDataDir((root) => {
    recordRun('ws-journal', {
      stopReason: 'completed',
      changed: [{ path: 'src/App.tsx', added: 8, removed: 3 }],
      checks: [{ name: 'npm run test:agent', passed: true, exitCode: 0 }],
      failures: 0,
      userPrompt: 'PRIVATE PROMPT MUST NOT BE STORED',
      fileBody: 'PRIVATE FILE CONTENT MUST NOT BE STORED',
    });
    recordRun('ws-journal', {
      stopReason: 'completed',
      changed: [{ path: 'README.md', added: 2, removed: 1 }],
      checks: [{ name: 'npm run build', passed: false, exitCode: 1 }],
      failures: 1,
    });

    const recent = readRunJournal('ws-journal');
    assert.equal(recent.length, 2);
    assert.deepEqual(recent[0].changed[0], { path: 'README.md', added: 2, removed: 1 });
    assert.equal(recent[0].checks[0].passed, false);

    const prompt = recentRunsForPrompt('ws-journal', 'src App tests', 3000, 6);
    assert.match(prompt, /src\/App\.tsx/);
    assert.match(prompt, /npm run test:agent passed/);
    assert.doesNotMatch(prompt, /PRIVATE PROMPT|PRIVATE FILE CONTENT/);

    const dataFile = path.join(root, 'agent-runs', 'ws-journal.json');
    const disk = fs.readFileSync(dataFile, 'utf8');
    assert.doesNotMatch(disk, /PRIVATE PROMPT|PRIVATE FILE CONTENT/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(root, 'agent-runs')).mode & 0o777, 0o700);
      assert.equal(fs.statSync(dataFile).mode & 0o777, 0o600);
    }
  });
});

test('automatic task-step memory is compact, redacted, model-summarized in the background, and query-retrieved', async () => {
  await withDataDir((root) => {
    const taskKey = taskKeyFor('assistant-message-private-task-id');
    let summaryInput = null;
    let liveMemory = '';
    const state = {
      plan: [
        { content: 'Trace the authentication guard', status: 'completed' },
        { content: 'Verify an invalid session', status: 'in_progress' },
      ],
      findings: ['The authentication guard runs before the protected route handler.'],
      checks: [{ name: 'node scripts/test-auth.js', passed: true, exitCode: 0 }],
    };
    const memory = createTaskMemory({
      workspaceId: 'ws-task-memory',
      runId: 'run-task-memory',
      taskKey,
      provider: { id: 'summary-provider', baseUrl: 'https://summary.test/v1' },
      model: 'compact-summary',
      redact: (text) => String(text).replaceAll('provider-secret-value', '[REDACTED]'),
      onUpdate: (text) => { liveMemory = text; },
      debounceMs: 60_000,
      summarize: async (input) => {
        summaryInput = input;
        return {
          summary: 'The authentication guard runs before protected routing; the focused check passes.',
          facts: ['Guard validation happens before the protected handler.', 'ACCESS_TOKEN=not-a-real-but-secret-value-123456789'],
          decisions: ['Keep the guard at the request boundary.'],
          errors: [],
          files: ['src/auth.ts', '.env', '../outside.txt'],
          next: 'Verify an invalid session.',
        };
      },
    });

    memory.capture({
      name: 'read_file',
      args: { path: 'src/auth.ts' },
      result: { ok: true, output: 'PRIVATE FILE BODY MUST NOT BE STORED', ui: { kind: 'read', path: 'src/auth.ts', startLine: 1, endLine: 80, ranges: [[1, 40], [70, 80]], totalLines: 120 } },
      state,
    });
    memory.capture({
      name: 'write_file',
      args: { path: 'src/new.ts' },
      result: { ok: true, ui: { kind: 'write', path: 'src/new.ts', created: true, added: 4, removed: 0 } },
      state,
    });
    memory.capture({
      name: 'edit_file',
      args: { path: 'src/auth.ts' },
      result: { ok: true, ui: { kind: 'edit', path: 'src/auth.ts', added: 1, removed: 1, ranges: [[12, 12]] } },
      state,
    });
    memory.capture({
      name: 'run_checks',
      args: { only: 'auth' },
      result: { ok: true, runs: [{ name: 'auth check', passed: true }] },
      state,
    });

    const provisional = readRunJournal('ws-task-memory')[0];
    assert.equal(provisional.runId, 'run-task-memory');
    assert.equal(provisional.memories.length, 1);
    assert.equal(provisional.memories[0].source, 'local', 'a useful fallback is written before the model responds');
    assert.match(provisional.memories[0].steps.join(' '), /Read src\/auth\.ts at L1-L40, L70-L80/);
    assert.match(provisional.memories[0].steps.join(' '), /Created src\/new\.ts/);
    assert.match(provisional.memories[0].steps.join(' '), /Edited src\/auth\.ts.*L12/);
    assert.match(liveMemory, /Read src\/auth\.ts at L1-L40, L70-L80/, 'the current run gets the exact ranges without waiting for a summary model');

    return memory.flush().then(() => {
      const merged = recordRun('ws-task-memory', {
        runId: 'run-task-memory', taskKey, stopReason: 'completed',
        changed: [{ path: 'src/auth.ts', added: 3, removed: 1 }],
        checks: [{ name: 'auth check', passed: true, exitCode: 0 }],
      });
      assert.ok(merged);
      const run = readRunJournal('ws-task-memory')[0];
      assert.equal(readRunJournal('ws-task-memory').length, 1, 'the final run updates the same checkpoint instead of duplicating it');
      assert.equal(run.memories[0].source, 'model');
      assert.match(run.memories[0].summary, /focused check passes/);
      assert.ok(run.memories[0].files.includes('src/auth.ts'));
      assert.ok(run.memories[0].steps.some((step) => /Read src\/auth\.ts at L1-L40, L70-L80/.test(step)), 'model summarization preserves exact read ranges');
      assert.ok(run.memories[0].steps.some((step) => /Created src\/new\.ts/.test(step)), 'file creation remains explicit after summarization');
      assert.ok(run.memories[0].steps.some((step) => /Edited src\/auth\.ts.*L12/.test(step)), 'edit locations remain explicit after summarization');
      assert.equal(run.memories[0].facts.some((fact) => /ACCESS_TOKEN/.test(fact)), false);
      assert.match(JSON.stringify(summaryInput), /src\/auth\.ts/);
      assert.doesNotMatch(JSON.stringify(summaryInput), /PRIVATE FILE BODY|assistant-message-private-task-id|provider-secret-value/);

      const retrieved = recentRunsForPrompt('ws-task-memory', 'authentication guard protected routing', 1800, 6, { taskKey: taskKeyFor('different-task') });
      assert.match(retrieved, /Earlier task memory/);
      assert.match(retrieved, /focused check passes/);
      const resumed = recentRunsForPrompt('ws-task-memory', 'continue', 5000, 6, { taskKey, resume: true });
      assert.match(resumed, /Read src\/auth\.ts at L1-L40, L70-L80/);
      assert.match(resumed, /Created src\/new\.ts/);
      assert.match(resumed, /Edited src\/auth\.ts.*L12/);
      const unrelated = recentRunsForPrompt('ws-task-memory', 'landing page color palette', 1800, 6, { taskKey: taskKeyFor('another-task') });
      assert.equal(unrelated, '', 'unrelated tasks do not inherit the newest checkpoint');

      const disk = fs.readFileSync(path.join(root, 'agent-runs', 'ws-task-memory.json'), 'utf8');
      assert.doesNotMatch(disk, /PRIVATE FILE BODY|assistant-message-private-task-id|ACCESS_TOKEN=|provider-secret-value/);

      const fallback = createTaskMemory({
        workspaceId: 'ws-task-memory', runId: 'run-memory-fallback', taskKey,
        provider: { id: 'unavailable' }, model: 'does-not-matter', debounceMs: 60_000,
        summarize: async () => { throw new Error('offline'); },
      });
      fallback.capture({
        name: 'edit_file', args: { path: 'src/cache.js' },
        result: { ok: true, ui: { kind: 'edit', path: 'src/cache.js', added: 2, removed: 1 }, output: 'source text is not captured' },
        state,
      });
      return fallback.flush().then(() => {
        const savedFallback = readRunJournal('ws-task-memory').find((item) => item.runId === 'run-memory-fallback');
        assert.equal(savedFallback.memories[0].source, 'local', 'provider failures leave the local task note usable');
      });
    });
  });
});

test('finishing a run cancels background summaries and keeps the final local checkpoint', async () => {
  await withDataDir(async () => {
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    let calls = 0;
    const memory = createTaskMemory({
      workspaceId: 'ws-memory-finish',
      runId: 'run-memory-finish',
      taskKey: taskKeyFor('finish-before-summary'),
      debounceMs: 0,
      summarize: async ({ signal }) => {
        calls++;
        startedResolve();
        return new Promise((resolve) => {
          const finishLate = () => setTimeout(() => resolve({
            summary: 'late model summary must not overwrite the local checkpoint',
            facts: ['late result'], decisions: [], errors: [], files: [], next: '',
          }), 10);
          if (signal.aborted) finishLate();
          else signal.addEventListener('abort', finishLate, { once: true });
        });
      },
    });
    const state = {
      plan: [{ content: 'Keep the final local note', status: 'in_progress' }],
      findings: ['The local checkpoint survives provider cancellation.'],
    };
    memory.capture({
      name: 'edit_file',
      args: { path: 'src/thing.ts' },
      result: { ok: true, output: 'source omitted', ui: { path: 'src/thing.ts', added: 1, removed: 0 } },
      state,
    });
    // The production debounce timer is intentionally unref'ed; keep this unit
    // test's event loop alive while it flushes the batch and starts the fake model.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await started; // ensure the model summary is in flight before the run ends
    const before = readRunJournal('ws-memory-finish')[0].memories[0];
    assert.equal(before.source, 'local');

    memory.finish(state);
    await memory.flush();
    const after = readRunJournal('ws-memory-finish')[0].memories[0];
    assert.equal(after.source, 'local', 'a late model response never replaces the local record');
    assert.match(after.facts[0], /local checkpoint survives/);
    assert.doesNotMatch(after.summary, /late model summary/);
    assert.equal(calls, 1);
  });
});

test('journal caps history and never stores arbitrary shell arguments', async () => {
  await withDataDir(() => {
    for (let i = 0; i < 35; i++) {
      recordRun('ws-cap', {
        stopReason: 'completed',
        changed: [{ path: `src/file-${i}.ts`, added: 1, removed: 0 }],
        checks: [{ name: 'npm run test', passed: true, secretArgument: 'not copied', diagnostic: 'ACCESS_TOKEN=not-copied' }],
        rawCommand: 'npm run test --token=not-copied',
      });
    }
    const runs = readRunJournal('ws-cap', 50);
    assert.equal(runs.length, 30);
    assert.equal(runs.some((run) => run.rawCommand || run.userPrompt), false);
    assert.equal(JSON.stringify(runs).includes('not-copied'), false);
  });
});

test('a Continue hand-off restores only the exact task and carries its compact findings', async () => {
  await withDataDir((root) => {
    const taskKey = taskKeyFor('assistant-message-1');
    recordRun('ws-handoff', {
      taskKey,
      stopReason: 'step_limit',
      changed: [{ path: 'src/api.ts', added: 12, removed: 3 }],
      checks: [{ name: 'npm test', passed: false, exitCode: 1, diagnostic: 'AssertionError: expected 2 to equal 3 at src/api.test.js:12' }],
      findings: ['src/api.ts keeps retry state per request; the helper must not share it globally.'],
      plan: [
        { content: 'Explore the API layer', status: 'completed' },
        { content: 'Add the retry helper', status: 'in_progress' },
        { content: 'Run the tests', status: 'pending' },
      ],
      memories: [{ summary: 'First task step traced request-local retry state.', files: ['src/api.ts'], next: 'Add the focused retry regression.' }],
    });
    // A subsequent Continue stores a new run id but must not discard the earlier task notes.
    recordRun('ws-handoff', {
      taskKey,
      stopReason: 'step_limit',
      changed: [{ path: 'src/api.test.js', added: 5, removed: 0 }],
      checks: [{ name: 'npm test', passed: false, exitCode: 1, diagnostic: 'AssertionError: expected 2 to equal 3 at src/api.test.js:12' }],
      findings: ['src/api.ts keeps retry state per request; the helper must not share it globally.'],
      plan: [
        { content: 'Explore the API layer', status: 'completed' },
        { content: 'Add the retry helper', status: 'in_progress' },
        { content: 'Run the tests', status: 'pending' },
      ],
      memories: [{ summary: 'Second task step added the focused retry regression.', files: ['src/api.test.js'], next: 'Run the focused regression.' }],
    });
    // A different conversation's newest open plan must not hijack Continue.
    recordRun('ws-handoff', {
      taskKey: taskKeyFor('other-assistant-message'),
      stopReason: 'step_limit',
      plan: [{ content: 'Delete unrelated assets', status: 'in_progress' }],
    });

    const prompt = recentRunsForPrompt('ws-handoff', 'continue', 3000, 6, { resume: true, taskKey });
    assert.match(prompt, /Checklist saved for this exact continued task/);
    assert.match(prompt, /\[x\] Explore the API layer/);
    assert.match(prompt, /\[~\] Add the retry helper/);
    assert.match(prompt, /\[ \] Run the tests/);
    assert.match(prompt, /retry state per request/);
    assert.match(prompt, /First task step traced request-local retry state/);
    assert.match(prompt, /Second task step added the focused retry regression/);
    assert.match(prompt, /AssertionError: expected 2 to equal 3/);
    assert.doesNotMatch(prompt, /Delete unrelated assets/);
    assert.ok(prompt.length <= 3000, `the hand-off stays within its budget (${prompt.length})`);

    // Ordinary new work gets query-matched evidence, never an unrelated open plan.
    const unrelated = recentRunsForPrompt('ws-handoff', 'style the landing page', 1200, 6, { taskKey: taskKeyFor('new-task') });
    assert.doesNotMatch(unrelated, /Checklist saved|Delete unrelated assets|Add the retry helper/);
    const matching = recentRunsForPrompt('ws-handoff', 'retry state API request', 1200, 6, { taskKey: taskKeyFor('new-task') });
    assert.match(matching, /retry state per request/);

    // A very small budget remains a real upper bound even with a long checklist and findings.
    recordRun('ws-large', {
      taskKey: taskKeyFor('large-task'),
      stopReason: 'step_limit',
      findings: Array.from({ length: 8 }, (_, i) => `src/file-${i}.ts: a verified finding about the request-scoped retry state and bounded cleanup.`),
      plan: Array.from({ length: 12 }, (_, i) => ({ content: `Inspect subsystem ${i} and preserve the observed state carefully.`, status: i ? 'pending' : 'in_progress' })),
    });
    assert.ok(recentRunsForPrompt('ws-large', '', 500, 6, { resume: true, taskKey: taskKeyFor('large-task') }).length <= 500);

    // Unfinished plans are still sanitized; no unchecked status or malformed item is echoed.
    recordRun('ws-junk', { taskKey: taskKeyFor('junk-task'), stopReason: 'time_limit', plan: [{ content: 'ok', status: 'nonsense' }, { status: 'pending' }, 'nope'] });
    const junk = recentRunsForPrompt('ws-junk', '', 3000, 6, { resume: true, taskKey: taskKeyFor('junk-task') });
    assert.match(junk, /\[ \] ok/);
    assert.doesNotMatch(junk, /nonsense|nope/);

    const disk = fs.readFileSync(path.join(root, 'agent-runs', 'ws-handoff.json'), 'utf8');
    assert.doesNotMatch(disk, /assistant-message-1|other-assistant-message/);
  });
});

test('deleting workspace memory also removes its run checkpoint file', async () => {
  await withDataDir((root) => {
    recordRun('ws-delete', { stopReason: 'step_limit', plan: [{ content: 'Finish the task', status: 'in_progress' }] });
    const file = path.join(root, 'agent-runs', 'ws-delete.json');
    assert.equal(fs.existsSync(file), true);
    clearRunJournal('ws-delete');
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(readRunJournal('ws-delete'), []);
  });
});
