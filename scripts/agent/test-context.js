/** Project guidance discovery stays bounded and reads only conventional rule files. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectProjectGuidance } from '../../server/agent/context.js';
import { LocalWorkspace } from '../../server/agent/workspaces/local.js';

const { test } = globalThis.__agentTest;
console.log('\n[project context]');

test('retries transient guidance discovery, listing, and reads once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-context-retry-'));
  try {
    const nested = path.join(root, 'src', 'AGENTS.md');
    const cursorRule = path.join(root, '.cursor', 'rules', 'project.mdc');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.mkdirSync(path.dirname(cursorRule), { recursive: true });
    fs.writeFileSync(nested, 'Nested rule: preserve the stable public API.');
    fs.writeFileSync(cursorRule, 'Cursor rule: keep errors actionable.');
    const ws = new LocalWorkspace({ id: 'ws-context-retry', kind: 'local', name: 'context retry', root, autoRun: true });
    await ws.init();

    const realFindFiles = ws.findFiles.bind(ws);
    let findAttempts = 0;
    ws.findFiles = async (...args) => {
      findAttempts++;
      if (findAttempts === 1) throw new Error('temporary workspace search failure');
      return realFindFiles(...args);
    };

    const cursorDir = path.join(root, '.cursor', 'rules');
    const realListTree = ws.listTree.bind(ws);
    let listAttempts = 0;
    ws.listTree = async (abs, ...args) => {
      if (abs === cursorDir) {
        listAttempts++;
        if (listAttempts === 1) throw new Error('temporary workspace listing failure');
      }
      return realListTree(abs, ...args);
    };

    const realReadText = ws.readText.bind(ws);
    let readAttempts = 0;
    ws.readText = async (abs, ...args) => {
      if (abs === nested) {
        readAttempts++;
        if (readAttempts === 1) throw new Error('temporary workspace read failure');
      }
      return realReadText(abs, ...args);
    };

    const guidance = await collectProjectGuidance(ws, (s) => s);
    assert.match(guidance, /preserve the stable public API/);
    assert.match(guidance, /keep errors actionable/);
    assert.equal(findAttempts, 2, 'a transient index failure gets one bounded retry');
    assert.equal(listAttempts, 2, 'a transient rule-folder listing gets one bounded retry');
    assert.equal(readAttempts, 2, 'a transient rule-file read gets one bounded retry');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loads bounded root, nested AGENTS, Cursor and Copilot rules but not unrelated or secret files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-context-'));
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('AGENTS.md', 'Root rule: run npm test before finishing.');
  write('src/AGENTS.md', 'Nested rule: keep public APIs backwards compatible.');
  write('.cursor/rules/ui.mdc', 'Cursor rule: use accessible labels and keyboard focus.');
  write('.github/copilot-instructions.md', 'Copilot rule: add regression tests for bug fixes.');
  write('README.md', 'This is documentation, not an instruction file.');
  write('.env', 'NOVITA_API_KEY=do-not-load-this-file');
  write('node_modules/pkg/AGENTS.md', 'Ignored vendor instruction.');

  try {
    const ws = new LocalWorkspace({ id: 'ws-context', kind: 'local', name: 'context', root, autoRun: true });
    await ws.init();
    const guidance = await collectProjectGuidance(ws, (s) => s);
    assert.match(guidance, /Root rule: run npm test/);
    assert.match(guidance, /Nested rule: keep public APIs/);
    assert.match(guidance, /accessible labels and keyboard focus/);
    assert.match(guidance, /regression tests for bug fixes/);
    assert.doesNotMatch(guidance, /This is documentation/);
    assert.doesNotMatch(guidance, /do-not-load-this-file/);
    assert.doesNotMatch(guidance, /Ignored vendor instruction/);
    assert.ok(guidance.length <= 10_000, `guidance remains bounded (${guidance.length} chars)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
