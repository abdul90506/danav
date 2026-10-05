/**
 * A workspace that lives in a Novita Agent Sandbox (https://novita.ai): an
 * isolated Linux micro-VM the agent can fill with files, run commands in, and
 * expose web servers from — safe to let an AI loose in.
 *
 * Lifecycle: the sandbox is created with `onTimeout: 'pause'` + `autoResume`,
 * and its timeout is pushed forward on every use. When you stop using it, it
 * PAUSES (files and processes preserved, compute billing stops) instead of
 * dying, and the next message wakes it in about a second.
 *
 * Three layers make sure it actually does stop:
 *   1. the idle sweeper (server/agent/idlePause.js) pauses it within a couple of
 *      minutes of the last activity — this is the one that normally fires;
 *   2. the run grace clock pauses it shortly after a run finishes;
 *   3. Novita's own `timeoutMs` is the backstop if this server dies.
 */
import path from 'node:path';
import { BaseWorkspace, WorkspaceError, sortEntries } from './base.js';
import { getNovitaKey, limits } from '../config.js';
import { forget, markPaused, markRunning, touch } from '../sandboxActivity.js';
import { updateWorkspaceRecord } from '../store.js';
import {
  IGNORED_DIRS, NON_INTERACTIVE_ENV, cleanTerminalText, formatBytes, genId, hasGlobChars,
  looksBinary, matchesGlob, shQuote,
} from '../util.js';

const posix = path.posix;
const MAX_CAPTURE_CHARS = 400_000;
const KEEPALIVE_EVERY_MS = 25_000;
const BG_DIR = '/tmp/danav-bg';

let sdkPromise = null;

/** Loaded lazily so the server starts (and the rest of the app works) without the SDK. */
export function loadNovitaSdk() {
  if (!sdkPromise) {
    sdkPromise = import('novita-sandbox').catch(() => {
      sdkPromise = null;
      throw new WorkspaceError(
        'The "novita-sandbox" package is not installed. Run `npm install` in the Danav folder.',
        'sdk_missing'
      );
    });
  }
  return sdkPromise;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errName = (err) => err?.constructor?.name || err?.name || '';
const isNotFound = (err) => /NotFound/i.test(errName(err)) || /does not exist|not found/i.test(String(err?.message));

/**
 * Turn any Novita SDK error into a WorkspaceError the UI can show. Exported so
 * the account-level admin routes (pause / resume / delete a sandbox) report
 * failures in exactly the same words as the agent's own workspace code.
 */
export function wrapNovitaError(err) {
  if (err instanceof WorkspaceError) return err;
  const name = errName(err);
  const msg = String(err?.message || err);
  if (name === 'AuthenticationError') return new WorkspaceError('Novita rejected the API key (401). Check NOVITA_API_KEY.', 'auth');
  if (name === 'RateLimitError') return new WorkspaceError('Novita is rate-limiting this key. Wait a moment and retry.', 'rate_limit');
  if (name === 'NotEnoughSpaceError') return new WorkspaceError('The sandbox disk is full.', 'no_space');
  if (name === 'FileNotFoundError') return new WorkspaceError(msg, 'not_found');
  if (name === 'TimeoutError') return new WorkspaceError('The sandbox did not answer in time.', 'timeout');
  // A 400 means WE sent something Novita would not accept (usually a malformed
  // sandbox id). Reporting that as a 502 "sandbox error" would blame the wrong
  // side, so it keeps its real meaning.
  if (name === 'InvalidArgumentError' || /^\s*400\b/.test(msg)) {
    return new WorkspaceError(`Novita rejected that request: ${msg}`, 'bad_request');
  }
  return new WorkspaceError(`Sandbox error: ${msg}`, 'sandbox_error');
}

/** A sandbox id that no longer exists is the common, expected case — not a crash. */
export const isSandboxGone = (err) =>
  /NotFound/i.test(errName(err)) || /not found|does not exist/i.test(String(err?.message || err));

const SANDBOX_ENV_NOTE =
  'Cloud sandbox: Debian 12 Linux, running as root, ~2 vCPU, ~0.5 GB RAM, ~20 GB disk, internet access. ' +
  'Usually preinstalled: Node 20 + npm, Python 3.11 + pip, git, curl, gcc, make. ' +
  'Not preinstalled: ripgrep, zip, tree (apt-get works if you really need them). ' +
  'Memory is small: prefer light tooling (Vite, plain HTML/JS, Flask…) and avoid heavy builds. ' +
  'Each run_command is a fresh bash; web servers must be started with background=true.';

export class SandboxWorkspace extends BaseWorkspace {
  constructor(record) {
    super(record);
    this.root = posix.resolve(record.root);
    this.sbx = null;
    this._ensuring = null;
    this._lastKeepAlive = 0;
  }

  get pathApi() {
    return posix;
  }

  // ---- connection ---------------------------------------------------------

  async init() {
    const sbx = await this.sandbox();
    try {
      await sbx.files.makeDir(this.root);
    } catch (err) {
      throw this.wrap(err);
    }
  }

  /** The live sandbox: connects, resumes, or recreates as needed, and extends its timeout. */
  sandbox() {
    if (!this._ensuring) {
      this._ensuring = this._ensure()
        .then((sbx) => {
          // Every sandbox operation funnels through here, so this is the one place
          // that has to know "the workspace is in use". The idle sweeper relies on
          // it: without this it would happily pause a sandbox mid-tool-call.
          touch(this.id);
          markRunning(this.id);
          return sbx;
        })
        .finally(() => {
          this._ensuring = null;
        });
    }
    return this._ensuring;
  }

  /**
   * Forget the cached connection. The next use reconnects — which also RESUMES a
   * paused sandbox — so this is how we react to the sandbox being paused or
   * killed behind our back (by the idle sweeper, or from the Sandboxes panel).
   */
  invalidate() {
    this.sbx = null;
    this._lastKeepAlive = 0;
  }

  /** Pause it now. `false` means it was already paused (or gone). */
  async pauseNow() {
    const id = this.record.sandboxId;
    if (!id) return false;
    const { Sandbox } = await loadNovitaSdk();
    try {
      const did = await Sandbox.pause(id, { apiKey: getNovitaKey() });
      this.invalidate();
      markPaused(this.id);
      return did;
    } catch (err) {
      if (isSandboxGone(err)) {
        this.invalidate();
        markPaused(this.id);
        return false;
      }
      throw this.wrap(err);
    }
  }

  /** Wake it up. Connecting to a paused sandbox resumes it. */
  async resume() {
    this.invalidate(); // force a real connect: setTimeout on a paused sandbox does nothing
    await this.sandbox();
    return true;
  }

  /** What Novita says this sandbox is doing right now. */
  async remoteState() {
    const id = this.record.sandboxId;
    if (!id) return null;
    const { Sandbox } = await loadNovitaSdk();
    try {
      const info = await Sandbox.getInfo(id, { apiKey: getNovitaKey() });
      const state = info.state === 'paused' ? 'paused' : 'running';
      if (state === 'paused') markPaused(this.id);
      else markRunning(this.id);
      return { state, endAt: info.endAt ? new Date(info.endAt).getTime() : null };
    } catch (err) {
      if (isSandboxGone(err)) {
        markPaused(this.id);
        return { state: 'gone', endAt: null };
      }
      throw this.wrap(err);
    }
  }

  async _ensure() {
    const apiKey = getNovitaKey();
    if (!apiKey) {
      throw new WorkspaceError(
        'No Novita API key is configured. Add NOVITA_API_KEY to .env, or paste it in the workspace dialog.',
        'no_key'
      );
    }
    const { Sandbox } = await loadNovitaSdk();
    const timeoutMs = limits.sandboxTimeoutMs();

    if (this.sbx) {
      if (Date.now() - this._lastKeepAlive < KEEPALIVE_EVERY_MS) return this.sbx;
      try {
        await this.sbx.setTimeout(timeoutMs);
        this._lastKeepAlive = Date.now();
        return this.sbx;
      } catch {
        this.sbx = null; // fall through and reconnect
      }
    }

    if (this.record.sandboxId) {
      try {
        this.sbx = await Sandbox.connect(this.record.sandboxId, { apiKey, timeoutMs });
        this._lastKeepAlive = Date.now();
        return this.sbx;
      } catch (err) {
        if (errName(err) === 'AuthenticationError') throw this.wrap(err);
        this.notify('The previous sandbox had expired, so a fresh one was created. Files from before are gone.');
      }
    }

    try {
      this.sbx = await Sandbox.create('base', {
        apiKey,
        timeoutMs,
        metadata: { app: 'danav', workspace: this.id },
        lifecycle: { onTimeout: 'pause', autoResume: true },
      });
    } catch (err) {
      throw this.wrap(err);
    }
    this._lastKeepAlive = Date.now();
    this.persist({ sandboxId: this.sbx.sandboxId, procs: [], procSeq: 0 });
    try {
      await this.sbx.files.makeDir(this.root);
    } catch {
      /* created lazily by the first write otherwise */
    }
    return this.sbx;
  }

  /**
   * Keep the live record current, and write it through to the store when the
   * workspace is already saved (during creation it is not saved yet).
   */
  persist(patch) {
    Object.assign(this.record, patch);
    updateWorkspaceRecord(this.id, patch);
  }

  wrap(err) {
    return wrapNovitaError(err);
  }

  // ---- paths --------------------------------------------------------------

  /** The sandbox is disposable and isolated, so absolute paths anywhere are allowed. */
  resolve(p = '.') {
    const input = String(p ?? '.').replace(/\0/g, '').replace(/\\/g, '/').trim() || '.';
    return posix.resolve(this.root, input);
  }

  // ---- low-level command helper ------------------------------------------

  /** Quick foreground command; never throws on a non-zero exit. */
  async execRaw(command, { cwd, envs = {}, timeoutMs = 60_000 } = {}) {
    const sbx = await this.sandbox();
    try {
      const r = await sbx.commands.run(command, { cwd, envs: { ...NON_INTERACTIVE_ENV, ...envs }, timeoutMs });
      return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode ?? 0 };
    } catch (err) {
      if (typeof err?.exitCode === 'number') {
        return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.exitCode };
      }
      throw this.wrap(err);
    }
  }

  // ---- files --------------------------------------------------------------

  async stat(abs) {
    const sbx = await this.sandbox();
    try {
      const info = await sbx.files.getInfo(abs);
      const modifiedTime = info.modifiedTime instanceof Date ? info.modifiedTime.getTime() : Number.NaN;
      return {
        type: info.type === 'dir' ? 'dir' : 'file',
        size: info.size ?? 0,
        ...(Number.isFinite(modifiedTime) ? { mtimeMs: modifiedTime } : {}),
      };
    } catch (err) {
      if (isNotFound(err)) return { type: null, size: 0 };
      throw this.wrap(err);
    }
  }

  async readText(abs, { maxBytes = 5 * 1024 * 1024 } = {}) {
    const st = await this.stat(abs);
    if (!st.type) throw new WorkspaceError(`File not found: ${this.displayPath(abs)}`, 'not_found');
    if (st.type === 'dir') throw new WorkspaceError(`${this.displayPath(abs)} is a directory, not a file.`, 'is_dir');
    if (st.size > maxBytes) {
      throw new WorkspaceError(`${this.displayPath(abs)} is ${formatBytes(st.size)}, which is too large to open as text here.`, 'too_large');
    }
    const sbx = await this.sandbox();
    try {
      const bytes = await sbx.files.read(abs, { format: 'bytes' });
      if (looksBinary(bytes)) return { text: '', size: st.size, binary: true };
      return { text: new TextDecoder('utf-8').decode(bytes), size: st.size, binary: false };
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async writeText(abs, text) {
    const sbx = await this.sandbox();
    try {
      await sbx.files.write(abs, text); // creates parent folders
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async mkdirp(abs) {
    const sbx = await this.sandbox();
    try {
      await sbx.files.makeDir(abs);
    } catch (err) {
      if (!/exist/i.test(String(err?.message))) throw this.wrap(err);
    }
  }

  async remove(abs, { recursive = false } = {}) {
    if (abs === '/' || abs === this.root) throw new WorkspaceError('Refusing to delete the workspace root itself.', 'denied');
    const st = await this.stat(abs);
    if (!st.type) throw new WorkspaceError(`Not found: ${this.displayPath(abs)}`, 'not_found');
    if (st.type === 'dir' && !recursive) {
      const sbx = await this.sandbox();
      const items = await sbx.files.list(abs);
      if (items.length > 0) {
        throw new WorkspaceError(`${this.displayPath(abs)} is a non-empty directory. Pass recursive=true to delete it.`, 'not_empty');
      }
    }
    await this.execRaw('rm -rf -- "$DANAV_P"', { envs: { DANAV_P: abs } });
    return { type: st.type };
  }

  async move(from, to) {
    if (!(await this.stat(from)).type) throw new WorkspaceError(`Not found: ${this.displayPath(from)}`, 'not_found');
    if ((await this.stat(to)).type) throw new WorkspaceError(`Destination already exists: ${this.displayPath(to)}`, 'exists');
    const sbx = await this.sandbox();
    try {
      await this.mkdirp(posix.dirname(to));
      await sbx.files.rename(from, to);
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async listTree(abs, { depth = 1, maxEntries = 300 } = {}) {
    const st = await this.stat(abs);
    if (!st.type) throw new WorkspaceError(`Not found: ${this.displayPath(abs)}`, 'not_found');
    if (st.type === 'file') throw new WorkspaceError(`${this.displayPath(abs)} is a file, not a directory.`, 'not_dir');
    const prune = [...IGNORED_DIRS].map((n) => `-name ${shQuote(n)}`).join(' -o ');
    const cmd =
      `find "$DANAV_P" -mindepth 1 -maxdepth ${Math.max(1, Math.min(6, depth))} ` +
      `\\( -type d \\( ${prune} \\) -printf '%y\\t0\\t%P\\n' -prune \\) -o -printf '%y\\t%s\\t%P\\n' 2>/dev/null ` +
      `| head -n ${maxEntries + 1}`;
    const r = await this.execRaw(cmd, { envs: { DANAV_P: abs } });
    const lines = r.stdout.split('\n').filter(Boolean);
    const truncated = lines.length > maxEntries;
    const entries = lines.slice(0, maxEntries).map((line) => {
      const [y, size, ...rest] = line.split('\t');
      return { path: rest.join('\t'), type: y === 'd' ? 'dir' : y === 'l' ? 'link' : 'file', size: y === 'd' ? undefined : Number(size) };
    });
    return { entries: sortEntries(entries), truncated };
  }

  async grep({ pattern, path: abs, glob, ignoreCase = false, maxResults = 100 }) {
    const st = await this.stat(abs);
    if (!st.type) throw new WorkspaceError(`Not found: ${this.displayPath(abs)}`, 'not_found');
    const isFile = st.type === 'file';
    const dir = isFile ? posix.dirname(abs) : abs;
    const target = isFile ? posix.basename(abs) : '.';
    const excludes = isFile ? '' : [...IGNORED_DIRS].map((n) => `--exclude-dir=${shQuote(n)}`).join(' ');
    const include = glob && !glob.includes('/') ? `--include=${shQuote(glob)}` : '';
    // Same rule as the local workspace: an invalid pattern is searched literally
    // (grep -F) rather than failing, and the caller is told which one it was.
    let literal = false;
    try { new RegExp(pattern); } catch { literal = true; }
    // -H forces "path:line:text" whether the target is a file or a directory.
    const cmd =
      `cd "$DANAV_D" && { grep -rnIH${literal ? 'F' : 'P'} ${ignoreCase ? '-i ' : ''}${include} ${excludes} --max-count=100 ` +
      `-e "$DANAV_PAT" -- ${shQuote(target)} 2>&1 | head -n ${maxResults * 3 + 5}; exit \${PIPESTATUS[0]}; }`;
    const r = await this.execRaw(cmd, { envs: { DANAV_D: dir, DANAV_PAT: pattern } });

    const matches = [];
    const errors = [];
    for (const line of r.stdout.split('\n')) {
      if (!line) continue;
      const m = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(line);
      if (!m) {
        errors.push(line);
        continue;
      }
      const relative = posix.relative(this.root, posix.join(dir, m[1]));
      if (glob && glob.includes('/') && !matchesGlob(glob, relative)) continue;
      matches.push({ path: relative, line: Number(m[2]), text: m[3].replace(/\r$/, '').slice(0, 300).trimEnd() });
    }
    const truncated = matches.length > maxResults;
    if (matches.length === 0 && errors.length > 0 && r.exitCode === 2) {
      throw new WorkspaceError(`grep failed: ${errors.slice(0, 2).join(' ').slice(0, 300)}`, 'bad_pattern');
    }
    return { matches: matches.slice(0, maxResults), truncated, literal };
  }

  async findFiles({ pattern, path: abs, maxResults = 200 }) {
    const prune = [...IGNORED_DIRS].map((n) => `-name ${shQuote(n)}`).join(' -o ');
    const cmd = `find "$DANAV_D" \\( -type d \\( ${prune} \\) -prune \\) -o -type f -printf '%P\\n' 2>/dev/null | head -n 20000`;
    const r = await this.execRaw(cmd, { envs: { DANAV_D: abs } });
    const useGlob = hasGlobChars(pattern);
    const needle = pattern.toLowerCase();
    const files = [];
    let truncated = false;
    for (const sub of r.stdout.split('\n')) {
      if (!sub) continue;
      const rel = posix.relative(this.root, posix.join(abs, sub));
      const hit = useGlob ? matchesGlob(pattern, rel, { caseInsensitive: true }) : rel.toLowerCase().includes(needle);
      if (!hit) continue;
      files.push(rel);
      if (files.length >= maxResults) {
        truncated = true;
        break;
      }
    }
    return { files, truncated };
  }

  // ---- commands -----------------------------------------------------------

  async exec(command, { cwd, timeoutMs = 120_000, onData, signal, envs = {} } = {}) {
    const sbx = await this.sandbox();
    const started = Date.now();
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const runId = genId('run');
    const chunks = [];
    let size = 0;
    let truncated = false;
    const onChunk = (d) => {
      if (size < MAX_CAPTURE_CHARS) {
        chunks.push(d);
        size += d.length;
      } else {
        truncated = true;
      }
      try { onData?.(cleanTerminalText(d)); } catch { /* UI callback must never break the run */ }
    };

    let handle;
    try {
      // `timeout` runs the command in its own process group and kills the WHOLE
      // group on expiry, so a hung `npm test` can't leave children behind.
      handle = await sbx.commands.run(`timeout -k 3 ${seconds} bash -c "$DANAV_CMD"`, {
        background: true,
        timeoutMs: 0,
        cwd: cwd || this.root,
        envs: { ...NON_INTERACTIVE_ENV, ...envs, DANAV_CMD: command, DANAV_RUN: runId },
        onStdout: onChunk,
        onStderr: onChunk,
      });
    } catch (err) {
      throw this.wrap(err);
    }

    let aborted = false;
    const killRun = async () => {
      handle.kill().catch(() => {});
      // The handle only signals the wrapper shell. Kill everything that inherited our run id.
      await this.execRaw(
        'for p in /proc/[0-9]*; do tr "\\0" "\\n" < $p/environ 2>/dev/null | grep -qx "DANAV_RUN=$DANAV_RUN_ID" && kill -KILL ${p#/proc/} 2>/dev/null; done; true',
        { envs: { DANAV_RUN_ID: runId }, timeoutMs: 15_000 }
      ).catch(() => {});
    };
    const onAbort = () => {
      aborted = true;
      killRun();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const guard = setTimeout(killRun, timeoutMs + 20_000);

    let exitCode = 0;
    try {
      const r = await handle.wait();
      exitCode = r.exitCode ?? 0;
    } catch (err) {
      if (typeof err?.exitCode === 'number') exitCode = err.exitCode;
      else throw this.wrap(err);
    } finally {
      clearTimeout(guard);
      signal?.removeEventListener('abort', onAbort);
    }

    const durationMs = Date.now() - started;
    const timedOut = !aborted && (exitCode === 124 || (exitCode === 137 && durationMs >= timeoutMs - 500));
    return { exitCode, output: cleanTerminalText(chunks.join('')), timedOut, aborted, durationMs, truncated };
  }

  procs() {
    return Array.isArray(this.record.procs) ? this.record.procs : [];
  }

  async startBackground(command, { cwd, waitMs = 2500 } = {}) {
    const seq = (this.record.procSeq || 0) + 1;
    const id = `bg-${seq}`;
    const base = `${BG_DIR}/${id}`;
    // setsid: its own session, so it survives the SDK connection, and `kill -- -pid` reaches children.
    // `( … &)` matters: with a bare `A && B &` the whole list becomes a background subshell
    // that keeps the SDK's stdout pipe open, and this call would hang until its timeout.
    const launcher =
      `mkdir -p ${BG_DIR} && ` +
      `(setsid bash -c 'echo $$ > "$1"; bash -c "$DANAV_CMD"; echo $? > "$2"' _ ${base}.pid ${base}.exit ` +
      `> ${base}.log 2>&1 < /dev/null &) ; ` +
      `for i in $(seq 1 30); do [ -s ${base}.pid ] && break; sleep 0.1; done; cat ${base}.pid`;
    const r = await this.execRaw(launcher, { cwd: cwd || this.root, envs: { DANAV_CMD: command } });
    const pid = Number(r.stdout.trim().split('\n').pop());
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new WorkspaceError(`Could not start the background process: ${(r.stderr || r.stdout).slice(0, 200)}`, 'start_failed');
    }
    const procs = [...this.procs(), { id, pid, command, startedAt: Date.now() }].slice(-20);
    this.persist({ procs, procSeq: seq });

    await sleep(waitMs);
    const status = await this.readBackground(id, { tail: 40 });
    return { id, pid, output: status.output, exited: !status.running, exitCode: status.exitCode };
  }

  async readBackground(id, { tail = 60 } = {}) {
    const proc = this.procs().find((p) => p.id === id);
    if (!proc) {
      throw new WorkspaceError(`No background process "${id}". Known: ${this.procs().map((p) => p.id).join(', ') || 'none'}.`, 'not_found');
    }
    const base = `${BG_DIR}/${id}`;
    const cmd =
      `if [ -f ${base}.exit ]; then echo "STATUS exited $(cat ${base}.exit)"; ` +
      `elif kill -0 $(cat ${base}.pid 2>/dev/null) 2>/dev/null; then echo "STATUS running"; else echo "STATUS gone"; fi; ` +
      `tail -n ${Math.max(1, Math.min(500, tail))} ${base}.log 2>/dev/null`;
    const r = await this.execRaw(cmd);
    const [first, ...rest] = r.stdout.split('\n');
    const m = /^STATUS (running|exited|gone)(?: (\d+))?/.exec(first || '');
    return {
      id,
      command: proc.command,
      running: m?.[1] === 'running',
      exitCode: m?.[1] === 'exited' ? Number(m[2]) : null,
      output: cleanTerminalText(rest.join('\n')).trimEnd(),
    };
  }

  async stopBackground(id) {
    const proc = this.procs().find((p) => p.id === id);
    if (!proc) throw new WorkspaceError(`No background process "${id}".`, 'not_found');
    await this.execRaw(
      `kill -TERM -- -${Number(proc.pid)} 2>/dev/null; sleep 1; kill -KILL -- -${Number(proc.pid)} 2>/dev/null; true`
    );
    return { id, stopped: true };
  }

  listBackground() {
    return this.procs().map((p) => ({ id: p.id, pid: p.pid, command: p.command, startedAt: p.startedAt }));
  }

  /**
   * Whether each process is alive, in ONE round trip: without this the agent could list the
   * servers it started but not tell a running one from one that died on its first request.
   */
  async listBackgroundStatus() {
    const procs = this.listBackground();
    if (!procs.length) return [];
    const probe = procs
      .map((p) => {
        const base = `${BG_DIR}/${p.id}`;
        return `if [ -f ${base}.exit ]; then echo "${p.id} EXITED $(cat ${base}.exit 2>/dev/null)"; ` +
          `elif kill -0 $(cat ${base}.pid 2>/dev/null) 2>/dev/null; then echo "${p.id} RUNNING"; ` +
          `else echo "${p.id} GONE"; fi`;
      })
      .join('; ');
    const state = new Map();
    try {
      const r = await this.execRaw(probe);
      for (const line of String(r.stdout || '').split('\n')) {
        const m = /^(\S+)\s+(RUNNING|EXITED|GONE)(?:\s+(\d+))?/.exec(line.trim());
        if (m) state.set(m[1], { running: m[2] === 'RUNNING', exitCode: m[2] === 'EXITED' ? Number(m[3]) : null });
      }
    } catch {
      /* the ids and commands are still worth showing */
    }
    return procs.map((p) => ({ ...p, ...(state.get(p.id) || {}) }));
  }

  async isPortOpen(port) {
    const r = await this.execRaw(`(exec 3<>/dev/tcp/127.0.0.1/${Number(port)}) 2>/dev/null && echo open || echo closed`);
    return r.stdout.includes('open');
  }

  async previewUrl(port) {
    const sbx = await this.sandbox();
    const host = await sbx.getHost(Number(port));
    return `https://${host}`;
  }

  describeEnv() {
    return SANDBOX_ENV_NOTE;
  }

  async dispose() {
    const id = this.record.sandboxId;
    forget(this.id); // stop the idle sweeper before the sandbox stops existing
    if (!id) return;
    try {
      const sbx = this.sbx || (await (await loadNovitaSdk()).Sandbox.connect(id, { apiKey: getNovitaKey() }));
      await sbx.kill();
    } catch {
      /* already gone — that is the goal */
    }
    this.sbx = null;
  }
}
