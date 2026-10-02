/** Project guidance discovery stays bounded and reads only conventional rule files. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectProjectGuidance } from '../../server/agent/context.js';
import { LocalWorkspace } from '../../server/agent/workspaces/local.js';

const { test } = globalThis.__agentTest;
console.log('\n[project context]');

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
