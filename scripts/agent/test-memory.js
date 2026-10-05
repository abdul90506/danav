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
    const secretTag = 'NOVITA_API_KEY=test_memory_secret_token_123456789012345';
    assert.throws(
      () => addNote(workspaceId, 'Keep project settings in the local config file', { tags: [secretTag] }),
      /will not save a tag containing/
    );
    const memoryFile = path.join(root, 'agent-memory', `${workspaceId}.json`);
    assert.doesNotMatch(fs.readFileSync(memoryFile, 'utf8'), /test_memory_secret_token/);

    // Files written by older versions may already have credential-bearing tags.
    // Reads must hide and scrub them, not echo them through the memory API.
    const saved = readNotes(workspaceId)[0];
    fs.writeFileSync(memoryFile, JSON.stringify({ version: 2, notes: [{ ...saved, tags: [secretTag] }] }));
    assert.deepEqual(readNotes(workspaceId)[0].tags, []);
    assert.doesNotMatch(fs.readFileSync(memoryFile, 'utf8'), /test_memory_secret_token/);
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

test('memory ranking: rare words and shared stems beat common ones', async () => {
  await withDataDir(() => {
    const ws = 'ws-rank';
    addNote(ws, 'Run the tests with npm test before every commit.', { category: 'workflow', importance: 3 });
    addNote(ws, 'Tests are also run in CI with npm test -- --coverage.', { category: 'workflow', importance: 3 });
    addNote(ws, 'The tests folder has fixtures that take a minute to build.', { category: 'gotcha', importance: 3 });
    addNote(ws, 'The session cookie is signed by src/auth/session.ts, not the legacy auth store.', { category: 'project', importance: 3, tags: ['auth'] });
    addNote(ws, 'Deploys go through the release workflow in .github/workflows.', { category: 'workflow', importance: 3 });

    // A rare, specific word must outrank a word that is everywhere.
    const sessionNotes = searchNotes(ws, 'fix the session cookie', 3).map((n) => n.text);
    assert.match(sessionNotes[0], /session cookie/);

    // A shared stem still finds the note ("auth" -> authentication / auth store).
    const authNotes = searchNotes(ws, 'auth store cleanup', 3).map((n) => n.text);
    assert.ok(authNotes.some((t) => /legacy auth store/.test(t)), JSON.stringify(authNotes));

    // A tag hit counts for more than an ordinary word.
    const tagged = searchNotes(ws, 'auth', 5).map((n) => n.text);
    assert.match(tagged[0], /legacy auth store/);

    // Common words alone do not drag in unrelated notes.
    assert.equal(searchNotes(ws, 'hello there friend', 5).length, 0);

    // The prompt sees the same ranking.
    const prompt = memoryForPrompt(ws, 6000, 'the session cookie is broken');
    assert.match(prompt, /session cookie/);
  });
});
