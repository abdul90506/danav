/**
 * Creating, opening and deleting workspaces. One live instance per workspace id
 * is kept so a sandbox connection (and background-process table) is shared by
 * every chat that uses it.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceError } from './base.js';
import { LocalWorkspace, isInside } from './local.js';
import { SandboxWorkspace } from './sandbox.js';
import { allowAnyLocalPath, getNovitaKey, workspacesDir } from '../config.js';
import {
  addWorkspaceRecord, getWorkspaceRecord, listWorkspaceRecords, removeWorkspaceRecord,
  updateWorkspaceRecord,
} from '../store.js';
import { genId, slugify } from '../util.js';
import { clearNotes } from '../memory.js';
import { clearRunJournal } from '../journal.js';
import { dropIndex } from '../codeindex.js';
import { forgetRepo } from '../githistory.js';
import { forget } from '../sandboxActivity.js';

const instances = new Map();
const SANDBOX_BASE = '/home/user';

function makeInstance(record) {
  return record.kind === 'sandbox' ? new SandboxWorkspace(record) : new LocalWorkspace(record);
}

/** Persisted records, safe to send to the browser (no secrets are ever stored on them). */
export function listWorkspaceInfos() {
  return listWorkspaceRecords().map(publicInfo);
}

export function publicInfo(record) {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    root: record.root,
    autoRun: record.autoRun !== false,
    sandboxId: record.sandboxId,
    /** Pause this sandbox once it has been idle for a while (sandboxes only). */
    autoPause: record.kind === 'sandbox' ? record.autoPause !== false : false,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function uniqueSlug(base, taken) {
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

async function validateLocalPath(input) {
  const abs = path.resolve(String(input));
  if (!path.isAbsolute(String(input))) {
    throw new WorkspaceError('The folder path must be absolute (for example /home/me/project or C:\\Projects\\app).', 'bad_path');
  }
  if (abs === path.parse(abs).root) throw new WorkspaceError('A filesystem root cannot be a workspace.', 'bad_path');
  if (abs === path.resolve(os.homedir())) {
    throw new WorkspaceError('Your whole home folder cannot be a workspace — pick (or create) a project folder inside it.', 'bad_path');
  }
  if (!allowAnyLocalPath() && !isInside(workspacesDir(), abs)) {
    throw new WorkspaceError(
      `For safety, local workspaces must live inside ${workspacesDir()}. ` +
        'Set DANAV_ALLOW_ANY_LOCAL_PATH=1 (and restart) to open any folder.',
      'path_not_allowed'
    );
  }
  return abs;
}

/**
 * @param {{ name?: string, kind: 'sandbox'|'local', path?: string, autoRun?: boolean }} opts
 */
export async function createWorkspace({ name, kind, path: customPath, autoRun } = {}) {
  if (kind !== 'sandbox' && kind !== 'local') throw new WorkspaceError('kind must be "sandbox" or "local".', 'bad_request');

  const existing = listWorkspaceRecords();
  const cleanName = String(name || '').trim().slice(0, 60) || `project-${existing.length + 1}`;
  const record = {
    id: genId('ws'),
    name: cleanName,
    kind,
    autoRun: autoRun === undefined ? kind === 'sandbox' : Boolean(autoRun),
    // Sandboxes bill while running, so auto-pause is ON unless the user opts out.
    autoPause: kind === 'sandbox' ? true : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (kind === 'sandbox') {
    if (!getNovitaKey()) {
      throw new WorkspaceError('Add your Novita API key first (NOVITA_API_KEY in .env, or paste it in the dialog).', 'no_key');
    }
    const taken = new Set(existing.filter((w) => w.kind === 'sandbox').map((w) => path.posix.basename(w.root)));
    record.root = path.posix.join(SANDBOX_BASE, uniqueSlug(slugify(cleanName), taken));
  } else if (customPath && String(customPath).trim()) {
    record.root = await validateLocalPath(String(customPath).trim());
  } else {
    const taken = new Set(existing.filter((w) => w.kind === 'local').map((w) => path.basename(w.root)));
    let slug = uniqueSlug(slugify(cleanName), taken);
    // never adopt a folder that already exists by accident
    for (let n = 2; await fsp.stat(path.join(workspacesDir(), slug)).then(() => true, () => false); n++) {
      slug = `${slugify(cleanName)}-${n}`;
    }
    record.root = path.join(workspacesDir(), slug);
  }

  const instance = makeInstance(record);
  await instance.init(); // creates the folder / the sandbox; throws a friendly WorkspaceError on failure
  // Only now (init succeeded) does the workspace become a saved record. The live
  // instance keeps its connection and picks up the stored copy.
  instance.record = addWorkspaceRecord({ ...instance.record, root: record.root });
  instances.set(instance.id, instance);
  return instance;
}

/** The live workspace for an id (connecting lazily). Throws if unknown. */
export async function openWorkspace(id) {
  let ws = instances.get(id);
  const record = getWorkspaceRecord(id);
  if (!record) {
    instances.delete(id);
    throw new WorkspaceError('That workspace no longer exists. Create or pick another one.', 'not_found');
  }
  if (!ws) {
    ws = makeInstance(record);
    instances.set(id, ws);
  } else {
    ws.record = { ...ws.record, ...record }; // pick up edits such as autoRun
  }
  return ws;
}

export function updateWorkspace(id, patch) {
  const allowed = {};
  if (typeof patch.autoRun === 'boolean') allowed.autoRun = patch.autoRun;
  if (typeof patch.autoPause === 'boolean') allowed.autoPause = patch.autoPause;
  if (typeof patch.name === 'string' && patch.name.trim()) allowed.name = patch.name.trim().slice(0, 60);
  const rec = updateWorkspaceRecord(id, allowed);
  if (!rec) throw new WorkspaceError('Workspace not found.', 'not_found');
  const live = instances.get(id);
  if (live) {
    live.record = { ...live.record, ...rec };
    live.name = rec.name;
  }
  return publicInfo(rec);
}

export async function deleteWorkspace(id, { deleteFiles = false } = {}) {
  const record = getWorkspaceRecord(id);
  if (!record) throw new WorkspaceError('Workspace not found.', 'not_found');
  const ws = instances.get(id) || makeInstance(record);
  try {
    await ws.dispose({ deleteFiles });
  } finally {
    instances.delete(id);
    removeWorkspaceRecord(id);
    clearNotes(id);
    clearRunJournal(id);
    dropIndex(id);
    forgetRepo(ws);
    forget(id); // stop the idle sweeper tracking a workspace that no longer exists
  }
}

export const _instances = instances;
