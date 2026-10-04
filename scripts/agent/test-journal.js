/** Automatically persisted, queryable workspace run evidence (without prompts or file bodies). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRunJournal, recordRun, recentRunsForPrompt } from '../../server/agent/journal.js';

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
        checks: [{ name: 'npm run test', passed: true, secretArgument: 'not copied' }],
        rawCommand: 'npm run test --token=not-copied',
      });
    }
    const runs = readRunJournal('ws-cap', 50);
    assert.equal(runs.length, 30);
    assert.equal(runs.some((run) => run.rawCommand || run.userPrompt), false);
    assert.equal(JSON.stringify(runs).includes('not-copied'), false);
  });
});

test('an unfinished run hands its plan to the next one', async () => {
  await withDataDir(() => {
    recordRun('ws-handoff', {
      stopReason: 'step_limit',
      changed: [{ path: 'src/api.ts', added: 12, removed: 3 }],
      checks: [{ name: 'npm test', passed: false, exitCode: 1 }],
      plan: [
        { content: 'Explore the API layer', status: 'completed' },
        { content: 'Add the retry helper', status: 'in_progress' },
        { content: 'Run the tests', status: 'pending' },
      ],
    });

    const prompt = recentRunsForPrompt('ws-handoff', 'add the retry helper', 3000, 6);
    assert.match(prompt, /unfinished/, 'the hand-off is called out');
    assert.match(prompt, /\[x\] Explore the API layer/);
    assert.match(prompt, /\[~\] Add the retry helper/);
    assert.match(prompt, /\[ \] Run the tests/);
    assert.match(prompt, /Continue from this plan/, 'the next run is told what to do with it');
    assert.ok(prompt.length <= 3200, `the hand-off stays within its budget (${prompt.length})`);

    // A finished run says nothing about plans.
    recordRun('ws-done', { stopReason: 'completed', changed: [{ path: 'a.ts', added: 1, removed: 0 }], plan: [{ content: 'x', status: 'pending' }] });
    assert.doesNotMatch(recentRunsForPrompt('ws-done', '', 3000, 6), /unfinished/);

    // Junk in a stored plan is dropped, not echoed.
    recordRun('ws-junk', { stopReason: 'time_limit', plan: [{ content: 'ok', status: 'nonsense' }, { status: 'pending' }, 'nope'] });
    const junk = recentRunsForPrompt('ws-junk', '', 3000, 6);
    assert.match(junk, /\[ \] ok/);
    assert.doesNotMatch(junk, /nonsense|nope/);
  });
});
