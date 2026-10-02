/**
 * What every workspace backend must do. The agent's tools talk only to this
 * interface, so "run it in a cloud sandbox" and "run it on this PC" are the
 * same code path above this line.
 *
 * All path arguments are ABSOLUTE and already resolved with `resolve()`.
 */
import path from 'node:path';
import { toPosix } from '../util.js';

export class WorkspaceError extends Error {
  constructor(message, code = 'workspace_error') {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

export class BaseWorkspace {
  /** @param {object} record persisted metadata (see store.js) */
  constructor(record) {
    this.record = record;
    this.id = record.id;
    this.kind = record.kind;
    this.name = record.name;
    this.root = record.root;
    /** Set per run: surfaces one-line notices (e.g. "sandbox was recreated") in the chat. */
    this.notify = () => {};
  }

  /** Commands run without asking unless the workspace opted into approvals. */
  get autoRun() {
    return this.record.autoRun !== false;
  }

  /** Posix, workspace-relative path for display; absolute if outside the root. */
  displayPath(abs) {
    const posixRoot = this.pathApi.resolve(this.root);
    const rel = this.pathApi.relative(posixRoot, abs);
    if (rel === '') return '.';
    if (rel.startsWith('..') || this.pathApi.isAbsolute(rel)) return toPosix(abs);
    return toPosix(rel);
  }

  /** `path` or `path.posix`, depending on the backend. */
  get pathApi() {
    return path;
  }

  // ---- to be implemented by backends -------------------------------------
  /* eslint-disable no-unused-vars */
  async init() { throw new Error('not implemented'); }
  resolve(p) { throw new Error('not implemented'); }
  /** -> { type: 'file' | 'dir' | null, size } */
  async stat(abs) { throw new Error('not implemented'); }
  /** -> { text, size, binary } ; throws WorkspaceError when missing or too big */
  async readText(abs, opts) { throw new Error('not implemented'); }
  async writeText(abs, text) { throw new Error('not implemented'); }
  /** -> { entries: [{ path, type, size }], truncated } (paths relative to `abs`) */
  async listTree(abs, opts) { throw new Error('not implemented'); }
  async remove(abs, opts) { throw new Error('not implemented'); }
  async move(from, to) { throw new Error('not implemented'); }
  async mkdirp(abs) { throw new Error('not implemented'); }
  /** -> { exitCode, output, timedOut, aborted, durationMs, truncated } */
  async exec(command, opts) { throw new Error('not implemented'); }
  /** -> { id, pid, output, exited, exitCode } */
  async startBackground(command, opts) { throw new Error('not implemented'); }
  /** -> { id, command, running, exitCode, output } */
  async readBackground(id, opts) { throw new Error('not implemented'); }
  async stopBackground(id) { throw new Error('not implemented'); }
  listBackground() { return []; }
  /**
   * listBackground() plus a live running/exit state. Async because a sandbox has to ask
   * the remote shell; a local workspace already knows. @returns {Promise<Array>}
   */
  async listBackgroundStatus() { return this.listBackground(); }
  async isPortOpen(port) { throw new Error('not implemented'); }
  async previewUrl(port) { throw new Error('not implemented'); }
  /** -> { matches: [{ path, line, text }], truncated } */
  async grep(opts) { throw new Error('not implemented'); }
  /** -> { files: [relPath], truncated } */
  async findFiles(opts) { throw new Error('not implemented'); }
  /** One paragraph for the system prompt: OS, shell, what is installed. */
  describeEnv() { return ''; }
  async dispose(opts) {}
  /* eslint-enable no-unused-vars */

  /** Safe summary for the UI (never secrets). */
  info() {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      root: this.root,
      autoRun: this.autoRun,
      sandboxId: this.record.sandboxId,
      createdAt: this.record.createdAt,
    };
  }
}

/** Dirs first, then names, comparing path segment by segment. */
export function sortEntries(entries) {
  const isDirAt = (e, i, parts) => i < parts.length - 1 || e.type === 'dir';
  return entries
    .map((e) => ({ e, parts: e.path.split('/') }))
    .sort((x, y) => {
      const n = Math.min(x.parts.length, y.parts.length);
      for (let i = 0; i < n; i++) {
        if (x.parts[i] === y.parts[i]) continue;
        const dx = isDirAt(x.e, i, x.parts);
        const dy = isDirAt(y.e, i, y.parts);
        if (dx !== dy) return dx ? -1 : 1;
        return x.parts[i].localeCompare(y.parts[i]);
      }
      return x.parts.length - y.parts.length;
    })
    .map((x) => x.e);
}
