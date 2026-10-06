/**
 * Look before you leap — enforced, not requested.
 *
 * A system prompt can ask a model to inspect something before it changes it.
 * Nothing in a prompt makes it obey, and "the agent deleted a folder it had
 * never opened" is not a prompt problem: it is a missing invariant.
 *
 * This module is that invariant. Every run keeps a small ledger of what the
 * agent has actually looked at — files it opened, directories it listed, files
 * it created itself — and a mutating call whose target is not in the ledger is
 * refused *before it runs*. The refusal is handed back as the tool's result, so
 * the model reads precisely which evidence is missing and can go and get it.
 * For a whole-file overwrite or append, it separately requires complete contents
 * visible through read_file in this run; a path, outline, symbol or partial range
 * is not enough. Partial reads are accumulated only when they cover one file version.
 *
 * The rule is deliberately general: the same check covers deleting a folder,
 * moving a file and a destructive shell command, and the ledger is fed by the
 * tools themselves rather than by any one code path, so a new tool inherits it
 * instead of having to remember to opt in.
 */
import { createHash } from 'node:crypto';
import { IGNORED_DIRS, toPosix } from './util.js';

/** Nothing is inspected past this many entries — a huge tree is not worth the wait. */
const MAX_WALK = 3000;

/** Strong, bounded-content identity used to detect a file changing after it was read. */
export function fileVersion(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** Stable-enough metadata for avoiding a full reread after each live-write chunk. */
export function workspaceStatFingerprint(stat) {
  if (!stat?.type) return 'missing';
  const stamp = [stat.mtimeMs, stat.ctimeMs, stat.ino, stat.dev]
    .map((value) => Number.isFinite(value) ? String(value) : '')
    .join(':');
  if (!stamp.replace(/:/g, '')) return null;
  return `${stat.type}:${stat.size ?? ''}:${stamp}`;
}

/**
 * The per-run state every tool reads through ctx.state.
 *
 * It lived inline in the loop, which made the toolset unusable without
 * hand-rebuilding the exact same object — tools reach into readFiles, ledger,
 * changed and the rest directly, so a missing field is a crash deep inside a
 * tool rather than an obvious mistake at the call site. Defining the shape once
 * means the loop and the toolset's own fallback cannot drift apart.
 */
export function createRunState(overrides = {}) {
  return {
    readFiles: new Set(),
    plan: [],
    findings: [],
    toolErrors: [],
    changed: new Map(),
    singleEdits: new Map(),
    checks: [],
    toolFailures: 0,
    parkedBodies: new Set(),
    subagentCalls: 0,
    /** Files being written straight to disk while the model writes them (see tools.liveWrite). */
    liveWriters: [],
    committedWrites: new Set(),
    /**
     * What the agent has actually looked at this run. Filled in by the tools,
     * read by the policy gate before a mutating call is allowed to run.
     * "Look before you leap" as an invariant, not as advice.
     */
    ledger: createLedger(),
    ...overrides,
  };
}

export function createLedger() {
  return {
    /** Files the agent has opened, or seen named in a listing. */
    seen: new Set(),
    /** Files whose complete, visible contents were read (partial ranges are tracked separately). */
    read: new Set(),
    /** Visible line ranges gathered by read_file: abs -> { version, totalLines, ranges }. */
    readRanges: new Map(),
    /** Source versions associated with reads, so ranges from changed content never combine. */
    readVersions: new Map(),
    /** Last exact contents this run wrote/owns, so its own writes are not mistaken for stale reads. */
    ownedVersions: new Map(),
    /** Directories whose contents were really read: abs -> the depth that was read. */
    listed: new Map(),
    /** Files this run created or rewrote: the agent knows these by construction. */
    owned: new Set(),
  };
}

/** The run's ledger, created on first use so no caller has to remember to make one. */
function ledgerOf(state) {
  if (!state) return null;
  return state.ledger || (state.ledger = createLedger());
}

/** The agent saw this file; only complete visible contents authorize a full overwrite. */
export function observeFile(state, abs, { complete = false, version = null } = {}) {
  if (!abs) return false;
  const led = ledgerOf(state);
  if (!led) return false;
  led.seen.add(abs);
  const fingerprint = typeof version === 'string' && version ? version : null;
  if (fingerprint) {
    const previous = led.ownedVersions.get(abs) || led.readVersions.get(abs) || led.readRanges.get(abs)?.version;
    if (previous && previous !== fingerprint) {
      led.read.delete(abs);
      led.readRanges.delete(abs);
      led.readVersions.delete(abs);
      led.owned.delete(abs);
      led.ownedVersions.delete(abs);
    }
  }
  if (complete) {
    led.read.add(abs);
    if (fingerprint) led.readVersions.set(abs, fingerprint);
    led.readRanges.delete(abs);
    return true;
  }
  return false;
}

/** Record a range the model actually received; ranges from different file versions never combine. */
export function observeFileRange(state, abs, { startLine, endLine, totalLines, version = null } = {}) {
  if (!abs) return false;
  const led = ledgerOf(state);
  if (!led) return false;
  const fingerprint = typeof version === 'string' && version ? version : null;
  observeFile(state, abs, { version: fingerprint });
  const total = Number(totalLines);
  const start = Number(startLine);
  const end = Number(endLine);
  if (total === 0 && start === 0 && end === 0) return observeFile(state, abs, { complete: true, version: fingerprint });
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > total) return false;
  if (start === 1 && end === total) return observeFile(state, abs, { complete: true, version: fingerprint });
  // Without a stable source version, isolated ranges are still useful evidence for
  // removal, but cannot safely be combined into proof of a complete file read.
  if (!fingerprint) return false;

  let record = led.readRanges.get(abs);
  if (!record || record.version !== fingerprint || record.totalLines !== total) {
    record = { version: fingerprint, totalLines: total, ranges: [] };
  }
  const ranges = [...record.ranges, [start, end]].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  record.ranges = merged;
  led.readRanges.set(abs, record);
  if (merged.length === 1 && merged[0][0] === 1 && merged[0][1] >= total) {
    return observeFile(state, abs, { complete: true, version: fingerprint });
  }
  return false;
}

/** Whether the run has the full visible file contents needed to safely replace/append it. */
export function hasInspectedContent(state, abs) {
  const led = state?.ledger;
  return Boolean(led && (led.read?.has(abs) || led.owned?.has(abs)));
}

/**
 * The agent read the contents of this directory.
 *
 * `entries` is the flat listing `listTree` returned. A subdirectory counts as
 * listed only when the listing actually descended into it — knowing that a
 * folder exists is not knowing what is in it, and for a recursive delete the
 * difference is the whole point. A truncated listing proves nothing about the
 * folders it cut off, so none of them are marked.
 */
export function observeListing(ws, state, abs, entries, { truncated = false, depth = 1 } = {}) {
  const led = ledgerOf(state);
  if (!led || !abs || !ws) return;
  led.listed.set(abs, Math.max(led.listed.get(abs) || 0, depth));
  for (const e of entries) {
    const childAbs = ws.pathApi.join(abs, e.path);
    led.seen.add(childAbs);
    if (truncated || e.type !== 'dir') continue;
    // The listing only reached into it if something below it came back too.
    const prefix = `${e.path}/`;
    if (entries.some((o) => o.path.startsWith(prefix))) led.listed.set(childAbs, Math.max(led.listed.get(childAbs) || 0, depth));
  }
}

/** The agent wrote/moved this file itself; optionally remember its exact current contents. */
export function observeOwned(state, abs, { content, version } = {}) {
  if (!abs) return false;
  const led = ledgerOf(state);
  if (!led) return false;
  led.owned.add(abs);
  led.read.delete(abs);
  led.readRanges.delete(abs);
  led.readVersions.delete(abs);
  const fingerprint = typeof version === 'string' && version
    ? version
    : typeof content === 'string' ? fileVersion(content) : null;
  if (fingerprint) led.ownedVersions.set(abs, fingerprint);
  else led.ownedVersions.delete(abs);
  return true;
}

/** The exact version that currently authorizes replacing this existing file, if known. */
export function expectedFileVersion(state, abs) {
  const led = state?.ledger;
  if (!led) return null;
  if (led.owned?.has(abs)) return led.ownedVersions?.get(abs) || led.readVersions?.get(abs) || null;
  return led.read?.has(abs) ? led.readVersions?.get(abs) || null : null;
}

/**
 * A move the shell performed is a file the run now owns under a new name: the
 * destination inherits whatever the source was known by, and the old path stops
 * existing. Without this, moving a file with `mv` and then touching it again
 * would look like touching a stranger.
 */
export async function observeShellMove(ws, state, from, to) {
  const led = ledgerOf(state);
  if (!led || !ws) return null;
  const absFrom = await resolveIn(ws, from);
  const absTo = await resolveIn(ws, to);
  if (!absFrom || !absTo || absFrom === absTo) return null;
  const stTo = await ws.stat(absTo).catch(() => null);
  if (!stTo?.type) return null; // the move did not land where we expected
  // `mv file folder` puts the file INSIDE the folder, not on top of it.
  const landed =
    stTo.type === 'dir' && (await ws.stat(absFrom).catch(() => null))?.type === 'file'
      ? ws.pathApi.join(absTo, ws.pathApi.basename(absFrom))
      : absTo;
  // Whatever it landed on, the run put it there: it knows the file by construction
  // and must not have to read it back before touching it again. Carry its known
  // version across the rename so a later external edit is still detectable.
  const knownVersion = led.ownedVersions.get(absFrom) || led.readVersions.get(absFrom) || led.readRanges.get(absFrom)?.version || null;
  observeOwned(state, landed, knownVersion ? { version: knownVersion } : {});
  if (led.seen.has(absFrom)) led.seen.add(landed);
  const depth = led.listed.get(absFrom);
  if (depth) led.listed.set(landed, Math.max(led.listed.get(landed) || 0, depth));
  led.seen.delete(absFrom);
  led.owned.delete(absFrom);
  led.ownedVersions.delete(absFrom);
  led.read.delete(absFrom);
  led.readRanges.delete(absFrom);
  led.readVersions.delete(absFrom);
  led.listed.delete(absFrom);
  return landed;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const known = (led, abs) => Boolean(led && (led.seen.has(abs) || led.owned.has(abs)));

/**
 * A folder whose whole purpose is to be regenerated (`node_modules`, `dist`,
 * `.cache`…). Seeing what it IS is enough to remove it — nobody inspects every
 * package, and the listing tool does not descend into these either.
 */
const disposable = (ws, abs) => IGNORED_DIRS.has(ws.pathApi.basename(abs));

/** Commands that remove or empty files. Nothing else is second-guessed. */
const REMOVING_COMMAND = [
  /(?:^|[|&;]\s*|\bsudo\s+)\s*(?:rm|rmdir|rd|del|erase|shred|unlink|truncate)\b/i,
  /\bRemove-Item\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+rm\b/i,
];

/**
 * Commands that move or rename things. Anchored to a command position (start, or
 * after a `;`/`&&`/`|`/`sudo`) so that a call like `node -e "os.rename(...)"` is
 * not mistaken for the shell's own `mv`.
 */
const MOVING_COMMAND = /(?:^|[|&;]\s*|\bsudo\s+|\bgit\s+)\s*(?:mv|move|ren|rename|Move-Item)\b/i;

/**
 * The paths a removing command names. Heuristic on purpose: it only has to
 * recognise what it can *resolve*. Flags, globs, substitutions and anything it
 * cannot turn into a real path inside the workspace are skipped rather than
 * guessed at, so an unrecognised command is never blocked by mistake.
 */
export function removalTargets(command) {
  const text = String(command || '');
  if (!REMOVING_COMMAND.some((re) => re.test(text))) return [];
  const out = [];
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^["']|["']$/g, '').replace(/[;,]$/, '');
    if (!token || token.startsWith('-')) continue;
    if (/^[|&;<>]+$/.test(token)) continue; // a shell operator, not a path
    if (/[|&;<>]/.test(token)) continue; // redirections and chains gluing paths together
    if (/^\/[a-z]+$/i.test(token)) continue; // a `del /s` style switch
    if (/[$`*?{}()]/.test(token)) continue; // substitution, glob, brace expansion, subshell
    if (/^(rm|rmdir|rd|del|erase|shred|unlink|truncate|Remove-Item|git|clean|rm)$/i.test(token)) continue;
    out.push(token);
  }
  return out.slice(0, 12);
}

/** The workspace root, or a filesystem root — the one removal nothing protects by itself. */
const isRootPath = (ws, abs) => {
  const a = toPosix(String(abs || '')).replace(/\/+$/, '');
  const r = toPosix(String(ws.root || '')).replace(/\/+$/, '');
  return !a || a === '/' || /^[a-z]:$/i.test(a) || a === r;
};

/** The move words themselves, so the parser never mistakes one for a path. */
const MOVE_WORDS = /^(mv|move|ren|rename|Move-Item|sudo|git)$/i;

/**
 * The source/destination pairs a moving command names, or [] when it cannot be
 * read confidently. The same rule as removals: a glob, a substitution or a
 * redirection is skipped rather than guessed at, so an unrecognised command is
 * never blocked by mistake.
 */
export function movingTargets(command) {
  const text = String(command || '');
  if (!MOVING_COMMAND.test(text)) return [];
  const pairs = [];
  for (const segment of text.split(/&&|\|\||;|\|/)) {
    if (!MOVING_COMMAND.test(segment.trim())) continue;
    const operands = [];
    for (const raw of segment.trim().split(/\s+/)) {
      const token = raw.replace(/^["']|["']$/g, '').replace(/[;,]$/, '');
      if (!token || token.startsWith('-') || MOVE_WORDS.test(token)) continue;
      if (/[|&;<>]/.test(token)) continue;
      if (/[$`*?{}()!]/.test(token)) continue;
      operands.push(token);
    }
    // `mv [-flags] source... destination`
    if (operands.length >= 2) pairs.push({ from: operands[0], to: operands[operands.length - 1] });
  }
  return pairs.slice(0, 8);
}

const resolveIn = async (ws, p) => {
  try {
    return typeof ws.safePath === 'function' ? await ws.safePath(p) : ws.resolve(p);
  } catch {
    return null;
  }
};

const missing = (list, max = 4) => {
  const shown = list.slice(0, max).map((p) => `\`${p}\``).join(', ');
  return list.length > max ? `${shown} and ${list.length - max} more` : shown;
};

/**
 * "list `a/`, `b/` and read `c.js`" — a folder and a file need different
 * evidence, and the agent should not have to guess which it is being asked for.
 */
function howToInspect(list) {
  const dirs = list.filter((p) => p.endsWith('/'));
  const files = list.filter((p) => !p.endsWith('/'));
  const parts = [];
  if (dirs.length) parts.push(`list ${dirs.map((p) => `\`${p}\``).join(', ')}`);
  if (files.length) parts.push(`read ${files.map((p) => `\`${p}\``).join(', ')}`);
  return parts.join(', and ');
}

/**
 * Everything under `dirAbs` that a recursive delete would remove without the
 * agent ever having looked at it. Mirrors `listTree` exactly — the same ignored
 * folders are not descended into — so a folder the agent legitimately cannot
 * see inside is never demanded of it.
 */
async function uninspected(ws, dirAbs, led, budget) {
  let entries;
  let truncated = false;
  try {
    const listing = await ws.listTree(dirAbs, { depth: 1, maxEntries: 1000 });
    if (!listing || !Array.isArray(listing.entries)) return { unknown: true, paths: [] };
    entries = listing.entries;
    truncated = Boolean(listing.truncated);
  } catch {
    return { unknown: true, paths: [] };
  }
  // A partial listing cannot establish that the omitted files were inspected.
  if (truncated) return { unknown: true, paths: [] };
  const found = [];
  for (const e of entries) {
    if (budget.n <= 0) return { unknown: true, paths: [] };
    budget.n--;
    const childAbs = ws.pathApi.join(dirAbs, e.path);
    if (e.type === 'dir') {
      if (IGNORED_DIRS.has(e.path)) continue; // listTree does not descend either
      if (!led.listed.has(childAbs)) {
        found.push(`${ws.displayPath(childAbs)}/`);
        continue;
      }
      const deeper = await uninspected(ws, childAbs, led, budget);
      if (deeper.unknown) return { unknown: true, paths: [] };
      found.push(...deeper.paths);
    } else if (!known(led, childAbs)) {
      found.push(ws.displayPath(childAbs));
    }
  }
  return { unknown: false, paths: found };
}

const refusal = (message, ui) => ({ message, ui });

// ---------------------------------------------------------------------------
// Answering the question instead of asking it
// ---------------------------------------------------------------------------

/** Bounds on the automatic look: enough to know what is there, never a full read. */
const AUTO_TREE_DEPTH = 6;
const AUTO_TREE_ENTRIES = 400;
const AUTO_FOLDERS = 3;
const AUTO_FILES = 6;
const AUTO_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The gate always asks the same thing — "do you know what this command is about
 * to remove or replace?" — and the honest answer is a look, not a refusal. So
 * when the run has not looked yet, it looks here: the folders are listed and the
 * files are read, bounded, and what was found goes into the tool's own result so
 * the model still learns what it is about to touch.
 *
 * Nothing is relaxed: the inspection really happens, on the real workspace, and
 * a look that cannot be completed (a truncated listing, a huge or binary file)
 * returns null, which leaves the caller refusing exactly as it did before.
 *
 * @returns a one-line note for the tool result, or null when the look failed.
 */
async function lookFirst(ws, state, folders, files) {
  const seen = [];
  for (const rel of folders.slice(0, AUTO_FOLDERS)) {
    const abs = await resolveIn(ws, rel);
    if (!abs) return null;
    try {
      const { entries, truncated } = await ws.listTree(abs, { depth: AUTO_TREE_DEPTH, maxEntries: AUTO_TREE_ENTRIES });
      observeListing(ws, state, abs, entries, { truncated, depth: AUTO_TREE_DEPTH });
      if (truncated) return null; // an incomplete listing is not an inspection
      const named = entries.filter((e) => e.type !== 'dir').map((e) => e.path);
      const shown = named.slice(0, 6).map((p) => `\`${p}\``).join(', ');
      seen.push(
        `listed \`${ws.displayPath(abs)}/\` — ${named.length} file${named.length === 1 ? '' : 's'}${
          named.length ? ` (${shown}${named.length > 6 ? ', …' : ''})` : ''
        }`
      );
    } catch {
      return null;
    }
  }
  for (const rel of files.slice(0, AUTO_FILES)) {
    const abs = await resolveIn(ws, rel);
    if (!abs) return null;
    try {
      const st = await ws.stat(abs);
      if (!st?.type || st.type === 'dir') continue; // nothing there to look at
      if (Number.isFinite(st.size) && st.size > AUTO_FILE_BYTES) return null;
      const r = await ws.readText(abs);
      if (r.binary) return null;
      observeFile(state, abs, { version: fileVersion(r.text) });
      const lines = String(r.text || '').split('\n');
      const first = (lines.find((line) => line.trim()) || '').trim().slice(0, 70);
      seen.push(`read \`${ws.displayPath(abs)}\` — ${lines.length} line${lines.length === 1 ? '' : 's'}${first ? `, starts ${JSON.stringify(first)}` : ''}`);
    } catch {
      return null;
    }
  }
  if (!seen.length) return null;
  return `Looked first, because this run had not: ${seen.join(' · ')}.`;
}

/** Read a stable current version; retry if metadata shows a concurrent change during the read. */
export async function currentFileVersion(ws, abs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const before = await ws.stat(abs);
      if (before?.type !== 'file') return null;
      const read = await ws.readText(abs);
      if (read.binary) return null;
      const after = await ws.stat(abs);
      const beforeStamp = workspaceStatFingerprint(before);
      const afterStamp = workspaceStatFingerprint(after);
      if (beforeStamp && afterStamp && beforeStamp !== afterStamp) continue;
      return fileVersion(read.text);
    } catch {
      return null;
    }
  }
  return null;
}

const staleWriteRefusal = (name, shown) => refusal(
  `Refused: ${name} was not run. \`${shown}\` changed after the version you read, or its current version could not be verified. Read the whole current file with read_file, reconcile the intended change, then retry.`,
  { kind: 'write', path: shown, blocked: true }
);

/**
 * May this call run?
 *
 * @returns {null | { message: string, ui: object }} null when it may.
 */
export async function checkAction({ workspace: ws, state, name, args }) {
  const led = ledgerOf(state);
  if (!led || !ws || !args) return null;

  if (name === 'write_file' || name === 'append_file') {
    const pathText = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : '';
    if (!pathText) return null; // argument validation owns a missing/invalid path
    const abs = await resolveIn(ws, pathText);
    if (!abs) return null;
    const st = await ws.stat(abs).catch(() => null);
    if (st?.type !== 'file') return null; // a new file has nothing to overwrite
    const shown = ws.displayPath(abs);
    if (!hasInspectedContent(state, abs)) {
      return refusal(
        `Refused: ${name} was not run. \`${shown}\` already exists, but its complete contents have not been read in this run. Use read_file to show the whole file (read every range if it is clipped); file_outline or a partial read is not enough. For a targeted change, use edit_file or multi_edit. Then retry.`,
        { kind: 'write', path: shown, blocked: true }
      );
    }

    // A streamed write is allowed to change the file before the final tool call.
    // It carries its own expected partial version and checks it before each write;
    // do not compare that draft against the original read hash here.
    const activeWriter = [...(state.liveWriters || [])].reverse().find((writer) =>
      writer?.abs === abs
      && !state.committedWrites?.has(writer)
      && typeof writer.isCurrent === 'function'
      && !writer.isConflicted?.()
    );
    const expected = expectedFileVersion(state, abs);
    if (activeWriter && (!expected || !activeWriter.expectedVersion || expected === activeWriter.expectedVersion)) {
      try {
        if (await activeWriter.isCurrent()) return null;
      } catch {
        /* fall through to a fresh workspace read */
      }
    }

    if (expected && (await currentFileVersion(ws, abs)) !== expected) return staleWriteRefusal(name, shown);
    return null;
  }

  if (name === 'run_command') {
    /**
     * Everything this command touches that the run has not inspected yet, worked
     * out from the command text alone. Called twice: once to find out whether a
     * look is needed, and again afterwards to check that it actually settled the
     * question. A move is a removal's quiet cousin — the file that disappears is
     * replaced by one under a new name, and moving ONTO a file throws that file
     * away — so both halves are collected here.
     */
    const unseenTargets = async () => {
      const dirs = [];
      const files = [];
      const roots = [];
      const addDir = (abs) => dirs.push({ rel: ws.displayPath(abs), shown: `${ws.displayPath(abs)}/` });
      const addFile = (abs, shown = null) => files.push({ rel: shown || ws.displayPath(abs), shown: shown || ws.displayPath(abs) });

      for (const { from, to } of movingTargets(args.command)) {
        const absFrom = await resolveIn(ws, from);
        if (!absFrom) continue;
        if (isRootPath(ws, absFrom)) {
          roots.push(from);
          continue;
        }
        const stFrom = await ws.stat(absFrom).catch(() => null);
        if (!stFrom?.type) continue; // nothing there: the shell's own error is the honest answer
        if (stFrom.type === 'file') {
          if (!known(led, absFrom)) addFile(absFrom);
        } else if (!led.listed.has(absFrom)) {
          addDir(absFrom);
        }
        const absTo = await resolveIn(ws, to);
        if (!absTo || absTo === absFrom) continue;
        const stTo = await ws.stat(absTo).catch(() => null);
        if (stTo?.type === 'file' && !known(led, absTo)) addFile(absTo);
      }

      for (const target of removalTargets(args.command)) {
        const abs = await resolveIn(ws, target);
        if (!abs) continue;
        if (isRootPath(ws, abs)) {
          roots.push(target);
          continue;
        }
        const st = await ws.stat(abs).catch(() => null);
        if (!st?.type) continue; // nothing there to lose
        if (st.type === 'dir') {
          if (!led.listed.has(abs)) {
            addDir(abs);
            continue;
          }
          if (disposable(ws, abs)) continue;
          const { unknown, paths } = await uninspected(ws, abs, led, { n: MAX_WALK });
          if (unknown) {
            // Do not turn an incomplete walk into an empty "nothing to inspect" result.
            // Keep the target itself pending so the automatic look retries it and, if
            // still incomplete, the normal refusal explains what the agent must do.
            addDir(abs);
          } else {
            for (const p of paths) {
              if (p.endsWith('/')) dirs.push({ rel: p.slice(0, -1), shown: p });
              else files.push({ rel: p, shown: p });
            }
          }
          continue;
        }
        if (!known(led, abs)) addFile(abs);
      }

      const unique = (list) => [...new Map(list.map((x) => [x.shown, x])).values()];
      return { roots, dirs: unique(dirs), files: unique(files) };
    };

    let need = await unseenTargets();
    if (need.roots.length) {
      return refusal(
        `Refused: the command was not run. \`${need.roots[0]}\` is the workspace itself — not a folder inside it — and removing or moving it would take everything in it with it. ` +
          `Name the files or folders you actually mean instead, or, if the whole workspace is finished with, say so to the user and let them deal with it.`,
        { kind: 'command', command: String(args.command || ''), blocked: true }
      );
    }
    if (need.dirs.length || need.files.length) {
      const note = await lookFirst(ws, state, need.dirs.map((d) => d.rel), need.files.map((f) => f.rel));
      if (note) {
        need = await unseenTargets();
        if (!need.roots.length && !need.dirs.length && !need.files.length) return { allow: true, note };
      }
      const list = [...need.dirs.map((d) => d.shown), ...need.files.map((f) => f.shown)];
      const what = movingTargets(args.command).length ? 'would be moved or replaced' : 'would be removed';
      return refusal(
        `Refused: the command was not run. It ${what} ${missing(list)}, which ${list.length === 1 ? 'has' : 'have'} not been inspected in this run, ` +
          `and looking it up automatically was not possible (too large, or the listing came back incomplete). ` +
          `${howToInspect(list)} first, so the change is one you can see and describe, then run the command again.`,
        { kind: 'command', command: String(args.command || ''), blocked: true }
      );
    }
  }

  return null;
}
