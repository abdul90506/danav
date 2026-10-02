/**
 * Per-workspace memory: short notes the agent writes for its future self.
 *
 * A fresh run knows nothing but the files, the chat and this. So when the agent learns something that
 * will matter next time — "tests run with `npm test -- --run`", "the user wants Roman Urdu answers",
 * "we chose SQLite over Postgres because…" — it saves a note, and every later run opens with these
 * notes already in its prompt. Stored per workspace under server/data/agent-memory (never in the
 * project itself, so it can't pollute a repo), and visible/deletable from the Files panel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, dataDir } from './config.js';
import { genId } from './util.js';

const MAX_NOTES = 60;
const MAX_NOTE_CHARS = 400;

const dir = () => path.join(dataDir(), 'agent-memory');
const fileFor = (workspaceId) => path.join(dir(), `${String(workspaceId).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function readNotes(workspaceId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(workspaceId), 'utf8'));
    return Array.isArray(parsed.notes) ? parsed.notes.filter((n) => n && typeof n.text === 'string') : [];
  } catch {
    return [];
  }
}

function writeNotes(workspaceId, notes) {
  fs.mkdirSync(dir(), { recursive: true });
  atomicWrite(fileFor(workspaceId), JSON.stringify({ notes }, null, 2));
}

/**
 * @returns {{ note: object, added: boolean, duplicateOf?: string, total: number }}
 */
export function addNote(workspaceId, text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
  if (clean.length < 4) throw new Error('A note needs at least a few words.');
  const notes = readNotes(workspaceId);
  const key = norm(clean);
  // the same fact, or one that already contains it, is not saved twice
  const dup = notes.find((n) => norm(n.text) === key || norm(n.text).includes(key));
  if (dup) return { note: dup, added: false, duplicateOf: dup.id, total: notes.length };
  const note = { id: genId('n'), text: clean, createdAt: Date.now() };
  // a longer version of an older note replaces it
  const kept = notes.filter((n) => !key.includes(norm(n.text)));
  kept.push(note);
  const trimmed = kept.slice(-MAX_NOTES);
  writeNotes(workspaceId, trimmed);
  return { note, added: true, total: trimmed.length };
}

/** Remove by id, or every note containing a phrase. @returns how many were removed */
export function removeNotes(workspaceId, { id, contains } = {}) {
  const notes = readNotes(workspaceId);
  const needle = contains ? norm(contains) : null;
  const kept = notes.filter((n) => !((id && n.id === id) || (needle && norm(n.text).includes(needle))));
  if (kept.length !== notes.length) writeNotes(workspaceId, kept);
  return notes.length - kept.length;
}

export function clearNotes(workspaceId) {
  try {
    fs.rmSync(fileFor(workspaceId), { force: true });
  } catch {
    /* nothing to clear */
  }
}

/** The notes as the prompt shows them (newest last; the oldest are dropped first if there are too many). */
export function memoryForPrompt(workspaceId, maxChars = 6000) {
  const lines = readNotes(workspaceId).map((n) => `- ${n.text}`);
  while (lines.length > 1 && lines.join('\n').length > maxChars) lines.shift();
  return lines.join('\n');
}
