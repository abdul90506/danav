/**
 * A workspace that is a folder on the machine running BlackDesi — your PC when you
 * run it locally.
 *
 * File tools are confined to the workspace root (symlinks included). Commands
 * can't be truly confined, so they run in the root, with the app's own secrets
 * stripped from their environment, and — unless the workspace opted into auto-run —
 * only after the user approves them in the chat.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BaseWorkspace, WorkspaceError, sortEntries } from './base.js';
import {
  IGNORED_DIRS, NON_INTERACTIVE_ENV, cleanTerminalText, formatBytes, hasGlobChars,
  looksBinary, matchesGlob, sanitizedEnv, toPosix,
} from '../util.js';

const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const MAX_CAPTURE_CHARS = 400_000;
const MAX_BG_BUFFER = 200_000;
/** Folders with credentials in them: never reachable through the file tools. */
const DENIED_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.kube']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const isInside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

function shellFor(command) {
  if (process.platform === 'win32') {
    if (process.env.BLACKDESI_SHELL === 'cmd') {
      return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command], name: 'cmd.exe' };
    }
    return {
      file: 'powershell.exe',
      args: [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        // surface a native command's exit code instead of PowerShell's generic 1
        `${command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`,
      ],
      name: 'PowerShell',
    };
  }
  if (fs.existsSync('/bin/bash')) return { file: '/bin/bash', args: ['-lc', command], name: 'bash' };
  return { file: '/bin/sh', args: ['-c', command], name: 'sh' };
}

function childEnv() {
  return { ...sanitizedEnv(), ...NON_INTERACTIVE_ENV };
}

/** Kill a whole process tree, not just the shell we started. */
function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, signal);
      if (signal !== 'SIGKILL') {
        setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        }, 1500).unref();
      }
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

export class LocalWorkspace extends BaseWorkspace {
  constructor(record) {
    super(record);
    this.root = path.resolve(record.root);
    this.realRoot = this.root;
    this.procs = new Map();
    this.procSeq = 0;
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    this.realRoot = await fsp.realpath(this.root);
  }

  // ---- paths --------------------------------------------------------------

  resolve(p = '.') {
    const raw = String(p ?? '.');
    // A NUL can never be part of a real path. Stripping it silently answered a
    // request for "a\\0b.txt" by creating "ab.txt" and reporting success under the
    // rewritten name -- a different file from the one that was asked for.
    if (raw.includes('\0')) {
      throw new WorkspaceError(`Path "${raw.replace(/\0/g, '\\0')}" contains a NUL character, which no file name can hold.`, 'invalid_path');
    }
    const input = raw.trim() || '.';
    const abs = path.resolve(this.root, input);
    if (!isInside(this.root, abs)) {
      throw new WorkspaceError(
        `Path "${p}" is outside the workspace. Everything must stay inside ${this.root}.`,
        'outside_workspace'
      );
    }
    const segments = path.relative(this.root, abs).split(path.sep);
    if (segments.some((s) => DENIED_SEGMENTS.has(s))) {
      throw new WorkspaceError(`Access to "${p}" is blocked (credentials folder).`, 'denied');
    }
    return abs;
  }

  /** Same as resolve(), but also follows symlinks so a link can't point out of the root. */
  async safePath(p) {
    const abs = this.resolve(p);
    let probe = abs;
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        if (!isInside(this.realRoot, real)) {
          throw new WorkspaceError(`"${p}" resolves outside the workspace through a symlink.`, 'outside_workspace');
        }
        break;
      } catch (err) {
        if (err instanceof WorkspaceError) throw err;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    return abs;
  }

  // ---- files --------------------------------------------------------------

  async stat(abs) {
    try {
      const st = await fsp.stat(abs);
      return {
        type: st.isDirectory() ? 'dir' : 'file',
        size: st.size,
        mtimeMs: st.mtimeMs,
        ctimeMs: st.ctimeMs,
        ino: st.ino,
        dev: st.dev,
      };
    } catch {
      return { type: null, size: 0 };
    }
  }

  async readText(abs, { maxBytes = MAX_EDIT_BYTES } = {}) {
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      throw new WorkspaceError(`File not found: ${this.displayPath(abs)}`, 'not_found');
    }
    if (st.isDirectory()) throw new WorkspaceError(`${this.displayPath(abs)} is a directory, not a file.`, 'is_dir');
    if (st.size > maxBytes) {
      throw new WorkspaceError(
        `${this.displayPath(abs)} is ${formatBytes(st.size)}, which is too large to open as text here.`,
        'too_large'
      );
    }
    const buf = await fsp.readFile(abs);
    if (looksBinary(buf)) return { text: '', size: st.size, binary: true };
    return { text: buf.toString('utf8'), size: st.size, binary: false };
  }

  async writeText(abs, text) {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text, 'utf8');
  }

  async mkdirp(abs) {
    await fsp.mkdir(abs, { recursive: true });
  }

  async remove(abs, { recursive = false } = {}) {
    if (path.resolve(abs) === this.root) throw new WorkspaceError('Refusing to delete the workspace root itself.', 'denied');
    const st = await this.stat(abs);
    if (!st.type) throw new WorkspaceError(`Not found: ${this.displayPath(abs)}`, 'not_found');
    if (st.type === 'dir' && !recursive) {
      const items = await fsp.readdir(abs);
      if (items.length > 0) {
        throw new WorkspaceError(`${this.displayPath(abs)} is a non-empty directory. Pass recursive=true to delete it.`, 'not_empty');
      }
    }
    await fsp.rm(abs, { recursive: true, force: true });
    return { type: st.type };
  }

  async move(from, to) {
    if (!(await this.stat(from)).type) throw new WorkspaceError(`Not found: ${this.displayPath(from)}`, 'not_found');
    if ((await this.stat(to)).type) throw new WorkspaceError(`Destination already exists: ${this.displayPath(to)}`, 'exists');
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
  }

  async listTree(abs, { depth = 1, maxEntries = 300 } = {}) {
    const st = await this.stat(abs);
    if (!st.type) throw new WorkspaceError(`Not found: ${this.displayPath(abs)}`, 'not_found');
    if (st.type === 'file') throw new WorkspaceError(`${this.displayPath(abs)} is a file, not a directory.`, 'not_dir');
    const entries = [];
    let truncated = false;
    const visit = async (dir, level) => {
      let items;
      try {
        items = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err) {
        throw new WorkspaceError(`Cannot read ${this.displayPath(dir)}: ${err.code || err.message}`, 'read_failed');
      }
      for (const it of items) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        const full = path.join(dir, it.name);
        const isDir = it.isDirectory();
        let size;
        if (!isDir) size = await fsp.stat(full).then((s) => s.size).catch(() => undefined);
        entries.push({
          path: toPosix(path.relative(abs, full)),
          type: isDir ? 'dir' : it.isSymbolicLink() ? 'link' : 'file',
          size,
        });
        if (isDir && level < depth && !IGNORED_DIRS.has(it.name)) await visit(full, level + 1);
      }
    };
    await visit(abs, 1);
    return { entries: sortEntries(entries), truncated };
  }

  async *walk(startAbs, { ignore = true } = {}) {
    const st = await fsp.stat(startAbs);
    if (st.isFile()) {
      yield { abs: startAbs, rel: toPosix(path.relative(this.root, startAbs)), size: st.size };
      return;
    }
    const stack = [startAbs];
    while (stack.length) {
      const dir = stack.pop();
      let items;
      try {
        items = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      const subdirs = [];
      for (const it of items) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          if (ignore && IGNORED_DIRS.has(it.name)) continue;
          if (DENIED_SEGMENTS.has(it.name)) continue;
          subdirs.push(full);
        } else if (it.isFile()) {
          const s = await fsp.stat(full).catch(() => null);
          if (s) yield { abs: full, rel: toPosix(path.relative(this.root, full)), size: s.size };
        }
      }
      for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
    }
  }

  async grep({ pattern, path: abs, glob, ignoreCase = false, maxResults = 100 }) {
    const flags = ignoreCase ? 'i' : '';
    let re;
    // A pattern that is not a valid regular expression (a model searching for
    // "foo(bar" or "a[0]") is matched literally instead of failing — but the
    // caller is told, so "not a valid regex" is never reported as "no matches".
    let literal = false;
    try {
      re = new RegExp(pattern, flags);
    } catch {
      literal = true;
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    }
    const matches = [];
    let truncated = false;
    for await (const file of this.walk(abs)) {
      if (glob && !matchesGlob(glob, file.rel)) continue;
      if (file.size > 1_000_000) continue;
      const buf = await fsp.readFile(file.abs).catch(() => null);
      if (!buf || looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        matches.push({ path: file.rel, line: i + 1, text: lines[i].replace(/\r$/, '').slice(0, 300).trimEnd() });
        if (matches.length >= maxResults) {
          truncated = true;
          return { matches, truncated, literal };
        }
      }
    }
    return { matches, truncated, literal };
  }

  async findFiles({ pattern, path: abs, maxResults = 200 }) {
    const useGlob = hasGlobChars(pattern);
    const needle = pattern.toLowerCase();
    const files = [];
    let truncated = false;
    for await (const file of this.walk(abs)) {
      const hit = useGlob ? matchesGlob(pattern, file.rel, { caseInsensitive: true }) : file.rel.toLowerCase().includes(needle);
      if (!hit) continue;
      files.push(file.rel);
      if (files.length >= maxResults) {
        truncated = true;
        break;
      }
    }
    return { files, truncated };
  }

  // ---- commands -----------------------------------------------------------

  async exec(command, { cwd, timeoutMs = 120_000, onData, signal } = {}) {
    const workDir = cwd || this.root;
    const { file, args } = shellFor(command);
    const started = Date.now();

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(file, args, {
          cwd: workDir,
          env: childEnv(),
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        return resolve({ exitCode: 127, output: `Could not start the shell: ${err.message}`, timedOut: false, aborted: false, durationMs: 0 });
      }

      const chunks = [];
      let size = 0;
      let truncated = false;
      let settled = false;
      let timedOut = false;
      let aborted = false;

      const onChunk = (buf) => {
        if (settled) return; // a background grandchild may keep writing; just drain it
        const text = buf.toString('utf8');
        if (size < MAX_CAPTURE_CHARS) {
          chunks.push(text);
          size += text.length;
        } else {
          truncated = true;
        }
        try { onData?.(cleanTerminalText(text)); } catch { /* UI callback must never break the run */ }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);

      const finish = (exitCode, extra = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        let output = cleanTerminalText(chunks.join(''));
        if (extra) output += (output && !output.endsWith('\n') ? '\n' : '') + extra;
        resolve({ exitCode, output, timedOut, aborted, durationMs: Date.now() - started, truncated });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);
      const onAbort = () => {
        aborted = true;
        killTree(child, 'SIGKILL');
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', (err) => finish(127, `Could not start the shell: ${err.message}`));
      // `close` means every pipe is drained: the normal, immediate path.
      child.on('close', (code, sig) => finish(code ?? (sig ? 137 : 1)));
      // A server started with `&` keeps the pipes open for as long as it lives, so
      // `close` would never fire. Give output a moment to flush after `exit`, then go.
      child.on('exit', (code, sig) => {
        setTimeout(() => finish(code ?? (sig ? 137 : 1)), 400);
      });
    });
  }

  async startBackground(command, { cwd, waitMs = 2500 } = {}) {
    const id = `bg-${++this.procSeq}`;
    const { file, args } = shellFor(command);
    const child = spawn(file, args, {
      cwd: cwd || this.root,
      env: childEnv(),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const proc = { id, pid: child.pid, command, startedAt: Date.now(), buf: '', exited: false, exitCode: null, child };
    const onChunk = (b) => {
      proc.buf += b.toString('utf8');
      if (proc.buf.length > MAX_BG_BUFFER) proc.buf = proc.buf.slice(-MAX_BG_BUFFER);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', (code) => {
      proc.exited = true;
      proc.exitCode = code;
    });
    child.on('error', (err) => {
      proc.exited = true;
      proc.exitCode = 127;
      proc.buf += `\n${err.message}`;
    });
    this.procs.set(id, proc);

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !proc.exited) await sleep(100);
    return {
      id,
      pid: proc.pid,
      output: cleanTerminalText(proc.buf).slice(-4000),
      exited: proc.exited,
      exitCode: proc.exitCode,
    };
  }

  async readBackground(id, { tail = 60 } = {}) {
    const proc = this.procs.get(id);
    if (!proc) throw new WorkspaceError(`No background process "${id}". Known: ${[...this.procs.keys()].join(', ') || 'none'}.`, 'not_found');
    const lines = cleanTerminalText(proc.buf).split('\n');
    return {
      id,
      command: proc.command,
      running: !proc.exited,
      exitCode: proc.exitCode,
      output: lines.slice(-tail).join('\n'),
    };
  }

  async stopBackground(id) {
    const proc = this.procs.get(id);
    if (!proc) throw new WorkspaceError(`No background process "${id}".`, 'not_found');
    if (!proc.exited) killTree(proc.child);
    await sleep(300);
    return { id, stopped: true };
  }

  listBackground() {
    return [...this.procs.values()].map((p) => ({
      id: p.id, pid: p.pid, command: p.command, running: !p.exited, exitCode: p.exitCode, startedAt: p.startedAt,
    }));
  }

  isPortOpen(port) {
    return new Promise((resolve) => {
      const sock = net.connect({ port: Number(port), host: '127.0.0.1' });
      const done = (ok) => {
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(800, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  }

  async previewUrl(port) {
    return `http://localhost:${port}`;
  }

  describeEnv() {
    const shell = shellFor('').name;
    return (
      `Local machine: ${os.type()} ${os.release()} (${os.arch()}), shell: ${shell}, Node ${process.version}. ` +
      `Commands run as the current user inside ${this.root}. ` +
      (process.platform === 'win32'
        ? 'Use PowerShell syntax (not bash) and backslash-safe paths; common Unix tools like grep/find/sed may be missing — prefer the dedicated tools.'
        : 'Standard Unix tools are available.')
    );
  }

  async dispose({ deleteFiles = false } = {}) {
    for (const p of this.procs.values()) if (!p.exited) killTree(p.child, 'SIGKILL');
    this.procs.clear();
    if (deleteFiles) await fsp.rm(this.root, { recursive: true, force: true });
  }
}
