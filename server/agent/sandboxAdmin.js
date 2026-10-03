/**
 * Account-level view of Novita Agent Sandboxes.
 *
 * The agent only ever knows about the sandboxes IT created, and it remembers
 * them one workspace at a time. But a Novita account accumulates sandboxes from
 * earlier sessions, from deleted workspaces, and from anything else sharing the
 * key — and every running one is burning CPU and RAM. This module is the
 * account-wide view: list them all, and pause / resume / delete any of them.
 *
 * Everything here returns plain serializable objects; nothing reaches the
 * browser that could leak the API key.
 */
import { getNovitaKey, limits } from './config.js';
import { forget, markPaused, markRunning, touch } from './sandboxActivity.js';
import { getWorkspaceRecord, listWorkspaceRecords, updateWorkspaceRecord } from './store.js';
import { WorkspaceError } from './workspaces/base.js';
import { _instances } from './workspaces/index.js';
import { isSandboxGone, loadNovitaSdk, wrapNovitaError } from './workspaces/sandbox.js';

/** Paginated list; this is a safety cap, not a page size. */
const MAX_SANDBOXES = 200;

const requireKey = () => {
  const apiKey = getNovitaKey();
  if (!apiKey) {
    throw new WorkspaceError(
      'No Novita API key is configured. Add NOVITA_API_KEY to .env, or paste it in the workspace dialog.',
      'no_key'
    );
  }
  return apiKey;
};

/** `platform_metadata_*` is Novita's own bookkeeping; it is noise in the UI. */
function tidyMetadata(metadata) {
  const out = {};
  for (const [k, v] of Object.entries(metadata || {})) {
    if (k.startsWith('platform_metadata_') || k === 'resource_pools') continue;
    out[k] = v;
  }
  return out;
}

const ms = (d) => (d ? new Date(d).getTime() : null);

/** Every workspace that claims a given sandbox id (normally zero or one). */
function workspaceIndex() {
  const bySandboxId = new Map();
  for (const rec of listWorkspaceRecords()) {
    if (rec.kind === 'sandbox' && rec.sandboxId) bySandboxId.set(rec.sandboxId, rec);
  }
  return bySandboxId;
}

/** One `SandboxInfo` from the SDK -> the shape the UI consumes. */
export function normalizeSandbox(info, bySandboxId = new Map()) {
  const workspace = bySandboxId.get(info.sandboxId) || null;
  const metadata = tidyMetadata(info.metadata);
  return {
    sandboxId: info.sandboxId,
    state: info.state === 'paused' ? 'paused' : 'running',
    templateId: info.templateId || null,
    name: info.name || null,
    cpuCount: info.cpuCount ?? null,
    memoryMB: info.memoryMB ?? null,
    startedAt: ms(info.startedAt),
    endAt: ms(info.endAt),
    metadata,
    /** Created by Danav (any session, even if its workspace is long gone). */
    isDanav: metadata.app === 'danav',
    /** A Danav workspace in THIS app still points at it. */
    managed: Boolean(workspace),
    workspaceId: workspace?.id || null,
    workspaceName: workspace?.name || null,
    /** The app-created sandbox this workspace currently owns. */
    autoPause: workspace ? workspace.autoPause !== false : null,
  };
}

/**
 * Every sandbox in the Novita account — not just the ones this app created.
 * @param {{ state?: 'running' | 'paused' }} [opts]
 */
export async function listAccountSandboxes({ state } = {}) {
  const apiKey = requireKey();
  const { Sandbox } = await loadNovitaSdk();
  const bySandboxId = workspaceIndex();

  const pager = Sandbox.list({ apiKey, limit: 100, ...(state ? { query: { state: [state] } } : {}) });
  const all = [];
  for (;;) {
    const page = await pager.nextItems().catch((err) => {
      throw wrapNovitaError(err);
    });
    all.push(...page);
    if (!pager.hasNext || all.length >= MAX_SANDBOXES) break;
  }

  const sandboxes = all.slice(0, MAX_SANDBOXES).map((info) => normalizeSandbox(info, bySandboxId));
  return {
    sandboxes,
    totals: {
      all: sandboxes.length,
      running: sandboxes.filter((s) => s.state === 'running').length,
      paused: sandboxes.filter((s) => s.state === 'paused').length,
      /** Running, and not owned by any workspace in this app: pure waste. */
      orphans: sandboxes.filter((s) => s.state === 'running' && !s.managed).length,
    },
  };
}

/** Live instance holding this sandbox, if any — it caches a now-stale handle. */
function liveInstanceFor(sandboxId) {
  for (const ws of _instances.values()) {
    if (ws.record?.sandboxId === sandboxId && typeof ws.invalidate === 'function') return ws;
  }
  return null;
}

async function getInfoOrGone(sandboxId, apiKey) {
  const { Sandbox } = await loadNovitaSdk();
  try {
    return await Sandbox.getInfo(sandboxId, { apiKey });
  } catch (err) {
    if (isSandboxGone(err)) return null;
    throw wrapNovitaError(err);
  }
}

/** Pause one sandbox. Safe to call on an already-paused one. */
export async function pauseSandboxById(sandboxId) {
  const apiKey = requireKey();
  const { Sandbox } = await loadNovitaSdk();
  const bySandboxId = workspaceIndex();
  const record = bySandboxId.get(sandboxId) || null;

  let didPause;
  try {
    didPause = await Sandbox.pause(sandboxId, { apiKey });
  } catch (err) {
    if (isSandboxGone(err)) {
      if (record) {
        updateWorkspaceRecord(record.id, { sandboxId: null, procs: [], procSeq: 0 });
        forget(record.id);
      }
      return { sandboxId, state: 'gone', changed: false };
    }
    throw wrapNovitaError(err);
  }

  liveInstanceFor(sandboxId)?.invalidate();
  if (record) markPaused(record.id);
  const info = await getInfoOrGone(sandboxId, apiKey);
  return { sandboxId, state: info ? normalizeSandbox(info, bySandboxId).state : 'gone', changed: didPause };
}

/** Resume one sandbox (connecting to a paused sandbox wakes it). */
export async function resumeSandboxById(sandboxId) {
  const apiKey = requireKey();
  const { Sandbox } = await loadNovitaSdk();
  const bySandboxId = workspaceIndex();
  const record = bySandboxId.get(sandboxId) || null;

  try {
    await Sandbox.connect(sandboxId, { apiKey, timeoutMs: limits.sandboxTimeoutMs() });
  } catch (err) {
    if (isSandboxGone(err)) {
      if (record) {
        updateWorkspaceRecord(record.id, { sandboxId: null, procs: [], procSeq: 0 });
        forget(record.id);
      }
      return { sandboxId, state: 'gone', changed: false };
    }
    throw wrapNovitaError(err);
  }

  liveInstanceFor(sandboxId)?.invalidate();
  if (record) {
    // Resuming is a deliberate act by the user: give it a full idle window before
    // the sweeper is allowed to put it back to sleep.
    touch(record.id);
    markRunning(record.id);
  }
  const info = await getInfoOrGone(sandboxId, apiKey);
  return { sandboxId, state: info ? normalizeSandbox(info, bySandboxId).state : 'gone', changed: true };
}

/**
 * Terminate one sandbox for good. Its disk is destroyed — this cannot be undone.
 *
 * If a workspace in this app owned it, the workspace is kept but detached, so
 * the next run quietly creates a fresh sandbox instead of failing on a dead id.
 */
export async function killSandboxById(sandboxId) {
  const apiKey = requireKey();
  const { Sandbox } = await loadNovitaSdk();
  const record = workspaceIndex().get(sandboxId) || null;

  let killed;
  try {
    killed = await Sandbox.kill(sandboxId, { apiKey });
  } catch (err) {
    if (isSandboxGone(err)) killed = false;
    else throw wrapNovitaError(err);
  }

  const live = liveInstanceFor(sandboxId);
  live?.invalidate();
  if (record) {
    updateWorkspaceRecord(record.id, { sandboxId: null, procs: [], procSeq: 0 });
    forget(record.id);
    // Keep the live instance's record in step with the store.
    if (live) live.record = { ...live.record, sandboxId: null, procs: [], procSeq: 0 };
  }
  return { sandboxId, state: 'gone', changed: Boolean(killed), detachedWorkspaceId: record?.id || null };
}

/** One sandbox, normalized (used by the workspace status chip). */
export async function getAccountSandbox(sandboxId) {
  const apiKey = requireKey();
  const info = await getInfoOrGone(sandboxId, apiKey);
  if (!info) return { sandboxId, state: 'gone' };
  return normalizeSandbox(info, workspaceIndex());
}

/** The sandbox a workspace currently owns, with its live remote state. */
export async function workspaceSandboxStatus(workspaceId) {
  const record = getWorkspaceRecord(workspaceId);
  if (!record) return { workspaceId, state: 'missing', sandboxId: null };
  if (record.kind !== 'sandbox') return { workspaceId, state: 'local', sandboxId: null };
  if (!record.sandboxId) return { workspaceId, state: 'none', sandboxId: null };
  // Without a key we can still say WHICH sandbox it is, just not how it is doing.
  if (!getNovitaKey()) return { workspaceId, state: 'unknown', sandboxId: record.sandboxId };
  const info = await getAccountSandbox(record.sandboxId);
  return { workspaceId, sandboxId: record.sandboxId, ...info, autoPause: record.autoPause !== false };
}
