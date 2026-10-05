/** Project skills are discoverable on demand, bounded and confined to the workspace. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSkillRegistry } from '../../server/agent/skills.js';
import { buildToolset, READ_ONLY_TOOLS } from '../../server/agent/tools.js';
import { LocalWorkspace } from '../../server/agent/workspaces/local.js';

const { test } = globalThis.__agentTest;
console.log('\n[project skills]');

const write = (root, relative, text) => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('discovers standard skill packs, keeps their bodies out of the prompt, and loads only the selected one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-skills-'));
  try {
    write(root, '.agents/skills/review/SKILL.md', '---\nname: review\ndescription: Review a focused code change for regressions.\n---\n# Review\n\nCheck the changed code against its callers and tests.');
    write(root, '.claude/skills/review/SKILL.md', '---\nname: review\ndescription: Review a security boundary.\n---\n# Security review\n\nTrace untrusted inputs to the privileged operation.');
    write(root, '.cursor/skills/accessible-ui/SKILL.md', '---\nname: accessible-ui\ndescription: Improve keyboard and screen-reader access.\n---\nUse labels and visible focus states.');
    write(root, '.danav/skills/syntax/SKILL.md', '---\nname: syntax\ndescription: Check if frontmatter parsing survives a quoted colon: safely.\n---\nDescriptions are data.');
    write(root, '.agents/skills/nested/deeper/SKILL.md', 'Must not be crawled.');
    write(root, 'README.md', 'Not a skill.');

    const ws = new LocalWorkspace({ id: 'ws-skills', kind: 'local', name: 'skills', root, autoRun: true });
    await ws.init();
    const registry = createSkillRegistry(ws);
    const first = await registry.discover();
    const second = await registry.discover();
    assert.deepEqual(second, first, 'catalog is cached for the run');
    assert.ok(first.some((s) => s.key === 'accessible-ui' && /keyboard/.test(s.description)));
    assert.ok(first.some((s) => s.key === 'syntax' && /quoted colon/.test(s.description)));
    assert.ok(first.some((s) => s.key === 'review [.agents/skills]'));
    assert.ok(first.some((s) => s.key === 'review [.claude/skills]'));
    assert.ok(first.some((s) => s.key === 'systematic-debugging' && s.source === 'Danav built-in'));
    assert.ok(first.some((s) => s.key === 'focused-verification' && /smallest meaningful/.test(s.description)));
    assert.ok(!first.some((s) => s.key === 'deeper' || s.key === 'nested'));

    const prompt = registry.promptText();
    assert.match(prompt, /accessible-ui/);
    assert.doesNotMatch(prompt, /Trace untrusted inputs/, 'full playbook is progressive-disclosure only');
    assert.doesNotMatch(prompt, /Write down one testable cause/, 'bundled skill bodies are also loaded only on demand');
    const debugging = await registry.load('systematic-debugging');
    assert.equal(debugging.source, 'Danav built-in');
    assert.match(debugging.body, /one testable cause/);
    const loaded = await registry.load('review [.claude/skills]');
    assert.equal(loaded.path, '.claude/skills/review/SKILL.md');
    assert.match(loaded.body, /Trace untrusted inputs to the privileged operation/);
    const tools = buildToolset({ workspace: ws, runSearchTool: async () => ({}), redact: (text) => text, skillRegistry: registry });
    const result = await tools.execute('load_skill', { skill: 'review [.claude/skills]' }, { state: {} });
    assert.equal(result.ok, true);
    assert.match(result.output, /Loaded project skill/);
    assert.match(result.output, /Trace untrusted inputs/);
    assert.ok(READ_ONLY_TOOLS.has('load_skill'));
    await assert.rejects(() => registry.load('../README.md'), /No project skill named/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skips likely-secret skill content and cannot follow a skill symlink outside the workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-skills-safe-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-skill-outside-'));
  try {
    write(root, '.agents/skills/leaky/SKILL.md', '---\nname: leaky\ndescription: Not safe.\n---\nPRIVATE_API_KEY=abcd-1234567890');
    write(outside, 'SKILL.md', '---\nname: escape\ndescription: Outside.\n---\nNever readable from the project.');
    fs.mkdirSync(path.join(root, '.claude/skills'), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(root, '.claude/skills/escape'), 'dir');
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'ENOTSUP') return;
      throw err;
    }
    const ws = new LocalWorkspace({ id: 'ws-skill-safe', kind: 'local', name: 'skills', root, autoRun: true });
    await ws.init();
    const registry = createSkillRegistry(ws);
    const catalog = await registry.discover();
    assert.equal(catalog.length, 2, 'only the two curated built-ins remain; secret-bearing and outside-linked project files are hidden');
    assert.equal(catalog.some((skill) => skill.key === 'leaky' || skill.key === 'escape'), false);
    await assert.rejects(() => registry.load('escape'), /No project skill named/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
