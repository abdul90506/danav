/** Automatically persisted, queryable workspace run evidence (without prompts or file bodies). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearRunJournal, readRunJournal, recordRun, recentRunsForPrompt, taskKeyFor } from '../../server/agent/journal.js';

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
