/** Persistent, ranked workspace memory and its privacy boundaries. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addNote, clearNotes, memoryForPrompt, readNotes, searchNotes } from '../../server/agent/memory.js';

const { test } = globalThis.__agentTest;
console.log('\n[memory]');

async function withDataDir(fn) {
  const previous = process.env.DANAV_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-memory-'));
  process.env.DANAV_DATA_DIR = root;
  try {
    await fn(root);
  } finally {
    if (previous === undefined) delete process.env.DANAV_DATA_DIR;
    else process.env.DANAV_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('memory migrates legacy notes and ranks relevant facts plus durable preferences', async () => {
  await withDataDir((root) => {
    const workspaceId = 'ws-memory';
    const dir = path.join(root, 'agent-memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${workspaceId}.json`), JSON.stringify({ notes: [
      { id: 'legacy-1', text: 'Run project tests with npm run test:agent', createdAt: 10 },
    ] }));

    const legacy = readNotes(workspaceId)[0];
    assert.equal(legacy.category, 'project');
    assert.equal(legacy.importance, 3);
    assert.deepEqual(legacy.tags, []);

    addNote(workspaceId, 'User prefers replies in Roman Urdu', { category: 'preference', importance: 5, tags: ['language'] });
    addNote(workspaceId, 'Use Vite preview for product screenshots', { category: 'workflow', importance: 2 });

    const found = searchNotes(workspaceId, 'npm run test agent', 5);
    assert.equal(found[0].id, 'legacy-1');
    assert.equal(found.length, 1, 'search returns matching notes, not the whole memory store');

    const prompt = memoryForPrompt(workspaceId, 1200, 'npm run test agent');
    assert.match(prompt, /npm run test:agent/);
    assert.match(prompt, /Roman Urdu/, 'important user preferences remain available even when wording differs');
    assert.doesNotMatch(prompt, /Vite preview/, 'unrelated low-priority notes do not crowd relevant context');
  });
});

test('memory deduplicates durable facts, updates metadata, and never stores likely credentials', async () => {
  await withDataDir((root) => {
    const workspaceId = 'ws-safe-memory';
    const first = addNote(workspaceId, 'Tests run with npm run test:agent', { category: 'workflow', importance: 3 });
    const duplicate = addNote(workspaceId, 'Tests run with npm run test:agent', { category: 'workflow', importance: 5, tags: ['tests'] });
    assert.equal(first.added, true);
    assert.equal(duplicate.added, false);
    assert.equal(duplicate.total, 1);
    assert.equal(readNotes(workspaceId)[0].importance, 5);
    assert.deepEqual(readNotes(workspaceId)[0].tags, ['tests']);

    assert.throws(
      () => addNote(workspaceId, 'NOVITA_API_KEY=sk_3-15Dg8Q_cYF5W04UTTXF8kaitaN6lHbD11dj-cGgp8'),
      /will not save a likely API key/
    );
    assert.throws(() => addNote(workspaceId, 'Private key: -----BEGIN RSA PRIVATE KEY-----'), /will not save/);
    assert.equal(readNotes(workspaceId).length, 1, 'rejected credentials were not persisted');

    if (process.platform !== 'win32') {
      const dirMode = fs.statSync(path.join(root, 'agent-memory')).mode & 0o777;
      const fileMode = fs.statSync(path.join(root, 'agent-memory', `${workspaceId}.json`)).mode & 0o777;
      assert.equal(dirMode, 0o700);
      assert.equal(fileMode, 0o600);
    }
  });
});

test('memory deletion and clear remove only the selected workspace notes', async () => {
  await withDataDir(() => {
    const a = addNote('ws-a', 'One durable project fact').note;
    addNote('ws-a', 'Another durable project fact');
    addNote('ws-b', 'A separate workspace fact');
    assert.equal(readNotes('ws-a').length, 2);
    assert.equal(clearNotes('ws-a'), undefined);
    assert.equal(readNotes('ws-a').length, 0);
    assert.equal(readNotes('ws-b').length, 1);
    assert.ok(a.id);
  });
});
