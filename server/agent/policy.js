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
 *
 * The rule is deliberately general: the same check covers deleting a folder,
 * moving a file and a destructive shell command, and the ledger is fed by the
 * tools themselves rather than by any one code path, so a new tool inherits it
 * instead of having to remember to opt in.
 */
import { IGNORED_DIRS, toPosix } from './util.js';

/** Nothing is inspected past this many entries — a huge tree is not worth the wait. */
const MAX_WALK = 3000;

export function createLedger() {
  return {
    /** Files the agent has opened, or seen named in a listing. */
    seen: new Set(),
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

/** The agent opened this file, or saw it named in a listing. */
export function observeFile(state, abs) {
  if (abs) ledgerOf(state)?.seen.add(abs);
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

/** The agent wrote this file itself this run, so it does not have to read it back. */
export function observeOwned(state, abs) {
  if (abs) ledgerOf(state)?.owned.add(abs);
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
  try {
    ({ entries } = await ws.listTree(dirAbs, { depth: 1, maxEntries: 1000 }));
  } catch {
    return { unknown: true, paths: [] };
  }
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

/**
 * May this call run?
 *
 * @returns {null | { message: string, ui: object }} null when it may.
 */
export async function checkAction({ workspace: ws, state, name, args }) {
  const led = ledgerOf(state);
  if (!led || !ws || !args) return null;

  if (name === 'move_file') {
    const abs = await resolveIn(ws, String(args.from || ''));
    if (!abs) return null;
    const st = await ws.stat(abs).catch(() => null);
    if (!st?.type || known(led, abs)) return null;
    const shown = ws.displayPath(abs);
    return refusal(
      `Refused: nothing was moved. \`${shown}\` has not been opened in this run — read it, or list the folder it is in, so you know you are moving the right thing.`,
      { kind: 'move', from: shown, to: toPosix(String(args.to || '')), blocked: true }
    );
  }

  if (name === 'run_command') {
    const targets = removalTargets(args.command);
    if (!targets.length) return null;
    const unseen = [];
    const roots = [];
    for (const t of targets) {
      const abs = await resolveIn(ws, t);
      if (!abs) continue;
      if (isRootPath(ws, abs)) {
        roots.push(t);
        continue;
      }
      const st = await ws.stat(abs).catch(() => null);
      if (!st?.type) continue; // nothing there to lose
      if (st.type === 'dir') {
        if (!led.listed.has(abs)) {
          unseen.push(`${ws.displayPath(abs)}/`);
          continue;
        }
        if (disposable(ws, abs)) continue;
        const { unknown, paths } = await uninspected(ws, abs, led, { n: MAX_WALK });
        if (!unknown && paths.length) unseen.push(...paths.map((p) => p));
        continue;
      }
      if (!known(led, abs)) unseen.push(ws.displayPath(abs));
    }
    if (roots.length) {
      return refusal(
        `Refused: the command was not run. \`${roots[0]}\` is the workspace itself — not a folder inside it — and removing it would take everything in it with it. ` +
          `Remove the specific files or folders you mean instead, or, if the whole workspace is finished with, say so to the user and let them delete it.`,
        { kind: 'command', command: String(args.command || ''), blocked: true }
      );
    }
    if (!unseen.length) return null;
    const list = [...new Set(unseen)];
    return refusal(
      `Refused: the command was not run. It would remove ${missing(list)}, which ${list.length === 1 ? 'has' : 'have'} not been inspected in this run. ` +
        `${howToInspect(list)} first, so the removal is one you can see and describe, then run the command again.`,
      { kind: 'command', command: String(args.command || ''), blocked: true }
    );
  }

  return null;
}
