/**
 * Persistent, per-workspace agent memory.
 *
 * Memories are compact, structured notes rather than hidden model state. They
 * survive restarts, can be inspected/deleted in the Files panel, are ranked
 * against the current request, and are never treated as more authoritative
 * than the user's current instructions or the safety rules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, dataDir, ensureDataDir } from './config.js';
import { genId } from './util.js';

const MAX_NOTES = 120;
const MAX_NOTE_CHARS = 400;
const CATEGORIES = new Set(['preference', 'project', 'decision', 'workflow', 'gotcha', 'other']);
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have', 'how',
  'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'please', 'that', 'the', 'their',
  'this', 'to', 'use', 'we', 'what', 'when', 'where', 'which', 'with', 'you', 'your',
  'aur', 'hai', 'hain', 'hum', 'is', 'ka', 'kar', 'ke', 'ki', 'ko', 'kya', 'mein', 'me', 'mera',
  'meri', 'mujhe', 'na', 'par', 'se', 'ye', 'yeh', 'wo', 'woh',
]);

const dir = () => path.join(dataDir(), 'agent-memory');
const safeWorkspaceId = (workspaceId) => String(workspaceId ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown';
const fileFor = (workspaceId) => path.join(dir(), `${safeWorkspaceId(workspaceId)}.json`);
const norm = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Memory must never become a second place where API keys or passwords are kept.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\b(?:sk|pk|rk)_[A-Za-z0-9][A-Za-z0-9_-]{17,}\b/i,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/i,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\b[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|PASSWD|SECRET|TOKEN)[A-Z0-9_]*\s*[:=]\s*["']?[^\s"']{8,}/i,
];

export function looksLikeSecret(text) {
  const s = String(text ?? '');
  return SECRET_PATTERNS.some((re) => re.test(s));
}

function normalizeCategory(value) {
  const category = String(value || 'project').toLowerCase();
  return CATEGORIES.has(category) ? category : 'other';
}

function normalizeImportance(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 3;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32))
    .filter(Boolean))].slice(0, 8);
}

function normalizeNote(n) {
  if (!n || typeof n.text !== 'string' || !n.text.trim() || looksLikeSecret(n.text)) return null;
  const now = Date.now();
  return {
    id: typeof n.id === 'string' && n.id ? n.id : genId('n'),
    text: n.text.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS),
    createdAt: Number.isFinite(n.createdAt) ? n.createdAt : now,
    updatedAt: Number.isFinite(n.updatedAt) ? n.updatedAt : (Number.isFinite(n.createdAt) ? n.createdAt : now),
    category: normalizeCategory(n.category),
    importance: normalizeImportance(n.importance),
    tags: normalizeTags(n.tags),
  };
}

export function readNotes(workspaceId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(workspaceId), 'utf8'));
    return Array.isArray(parsed.notes) ? parsed.notes.map(normalizeNote).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeNotes(workspaceId, notes) {
  ensureDataDir();
  const memoryDir = dir();
  fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(memoryDir, 0o700); } catch { /* best effort on unusual filesystems */ }
  }
  atomicWrite(fileFor(workspaceId), JSON.stringify({ version: 2, notes }, null, 2), 0o600);
}

function tokenize(text) {
  return new Set(norm(text).split(' ').filter((word) => word.length > 1 && !STOP_WORDS.has(word)));
}

function scoreNote(note, query, queryTokens) {
  const noteTokens = tokenize(`${note.text} ${note.tags.join(' ')}`);
  let lexical = 0;
  for (const word of queryTokens) {
    if (noteTokens.has(word)) lexical += word.length >= 6 ? 3 : 2;
  }
  const phrase = norm(query);
  if (phrase.length >= 8 && norm(note.text).includes(phrase)) lexical += 4;
  const ageDays = Math.max(0, (Date.now() - note.updatedAt) / 86_400_000);
  const recency = Math.max(0, 1.5 - ageDays / 90);
  const importance = note.importance * 0.45;
  // User preferences are useful across tasks (language, accessibility, style).
  const preference = note.category === 'preference' ? 2.5 : 0;
  return { note, lexical, score: lexical + importance + recency + preference };
}

/** Search older workspace memories when a relevant note was not in the prompt. */
export function searchNotes(workspaceId, query, limit = 8) {
  const q = String(query || '').trim();
  const queryTokens = tokenize(q);
  if (!queryTokens.size) return [];
  return readNotes(workspaceId)
    .map((note) => scoreNote(note, q, queryTokens))
    .filter((item) => item.lexical > 0)
    .sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt)
    .slice(0, Math.max(1, Math.min(20, Math.floor(Number(limit) || 8))))
    .map(({ note }) => note);
}

/**
 * @returns {{ note: object, added: boolean, duplicateOf?: string, total: number }}
 */
export function addNote(workspaceId, text, metadata = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
  if (clean.length < 4) throw new Error('A note needs at least a few words.');
  if (looksLikeSecret(clean)) throw new Error('Memory will not save a likely API key, token, password, or private key. Save a redacted summary instead.');

  const notes = readNotes(workspaceId);
  const key = norm(clean);
  const category = normalizeCategory(metadata.category);
  const importance = normalizeImportance(metadata.importance);
  const tags = normalizeTags(metadata.tags);
  const duplicate = notes.find((n) => {
    if (norm(n.text) === key) return true;
    const a = norm(n.text);
    const shorter = Math.min(a.length, key.length);
    return shorter >= 28 && (a.includes(key) || key.includes(a));
  });
  if (duplicate) {
    const updated = {
      ...duplicate,
      text: clean.length > duplicate.text.length ? clean : duplicate.text,
      category: metadata.category === undefined ? duplicate.category : category,
      importance: metadata.importance === undefined ? duplicate.importance : Math.max(duplicate.importance, importance),
      tags: metadata.tags === undefined ? duplicate.tags : [...new Set([...duplicate.tags, ...tags])].slice(0, 8),
      updatedAt: Date.now(),
    };
    const next = notes.map((n) => n.id === duplicate.id ? updated : n);
    writeNotes(workspaceId, next);
    return { note: updated, added: false, duplicateOf: duplicate.id, total: next.length };
  }

  const note = {
    id: genId('n'), text: clean, createdAt: Date.now(), updatedAt: Date.now(),
    category, importance, tags,
  };
  const kept = [...notes, note]
    .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
    .slice(0, MAX_NOTES)
    .sort((a, b) => a.createdAt - b.createdAt);
  writeNotes(workspaceId, kept);
  return { note, added: true, total: kept.length };
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

/** Relevant notes first; keep the best durable preferences even when wording differs. */
export function memoryForPrompt(workspaceId, maxChars = 6000, query = '') {
  const notes = readNotes(workspaceId);
  if (!notes.length) return '';
  const q = String(query || '');
  const queryTokens = tokenize(q);
  const ranked = notes.map((note) => scoreNote(note, q, queryTokens));
  const preferences = ranked
    .filter((item) => item.note.category === 'preference')
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  const relevant = queryTokens.size
    ? ranked.filter((item) => item.lexical > 0).sort((a, b) => b.score - a.score)
    : ranked.sort((a, b) => b.score - a.score);
  const chosen = new Map();
  for (const item of [...preferences, ...relevant]) chosen.set(item.note.id, item.note);

  const cap = Math.max(0, Math.floor(Number(maxChars) || 0));
  const lines = [];
  let used = 0;
  for (const note of chosen.values()) {
    const line = `- [${note.category} · priority ${note.importance}/5] ${note.text}`;
    const remaining = cap - used - (lines.length ? 1 : 0);
    if (remaining <= 0) break;
    const clipped = line.length > remaining ? `${line.slice(0, Math.max(0, remaining - 1))}…` : line;
    lines.push(clipped);
    used += clipped.length + (lines.length > 1 ? 1 : 0);
    if (used >= cap) break;
  }
  return lines.join('\n');
}
