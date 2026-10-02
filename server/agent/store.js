/**
 * Persistent list of agent workspaces: `server/data/agent-workspaces.json`
 * (gitignored). Holds only metadata — a sandbox id, a folder path, a name —
 * never keys and never file contents.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, dataDir, ensureDataDir } from './config.js';

let cache = null;
let cacheFile = null;

const file = () => path.join(dataDir(), 'agent-workspaces.json');

function load() {
  const f = file();
  if (cache && cacheFile === f) return cache;
  cacheFile = f;
  try {
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    cache = parsed && Array.isArray(parsed.workspaces) ? parsed : { workspaces: [] };
  } catch {
    cache = { workspaces: [] };
  }
  return cache;
}

function save() {
  ensureDataDir();
  atomicWrite(file(), JSON.stringify(cache, null, 2));
}

const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);

export const listWorkspaceRecords = () => load().workspaces.map(copy);
export const getWorkspaceRecord = (id) => copy(load().workspaces.find((w) => w.id === id));

export function addWorkspaceRecord(record) {
  load().workspaces.push(record);
  save();
  return copy(record);
}

export function updateWorkspaceRecord(id, patch) {
  const rec = load().workspaces.find((w) => w.id === id);
  if (!rec) return null;
  Object.assign(rec, patch, { updatedAt: Date.now() });
  save();
  return copy(rec);
}

export function removeWorkspaceRecord(id) {
  const data = load();
  const before = data.workspaces.length;
  data.workspaces = data.workspaces.filter((w) => w.id !== id);
  if (data.workspaces.length !== before) save();
  return data.workspaces.length !== before;
}

/** Test helper: forget the in-memory copy so the next call re-reads the file. */
export function _resetStoreCache() {
  cache = null;
  cacheFile = null;
}
