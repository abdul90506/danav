/**
 * One living summary per project, instead of a pile of per-run notes.
 *
 * What the agent used to be told about a project was a transcript: every run's
 * headline, every task's step checkpoints, all of it from every chat that had
 * ever touched the workspace, retrieved by keyword match. It was long, it
 * repeated itself, it mixed one chat's half-finished plan into another chat's
 * first question, and when the files it described were deleted it carried on
 * describing them. The honest version of that information is much smaller: a
 * few lines saying what this project is, what has been built, what was decided
 * and what to avoid.
 *
 * So this keeps exactly that — one summary document per workspace, rewritten
 * after every run from the run's own evidence. No extra model call: a run
 * already knows which files it changed, which plan items it finished, what it
 * concluded and which tools failed on it, and that is all the summary is made
 * of. It is checked against the live file listing each time, so a project
 * whose files were deleted stops being described as though they were there.
 *
 * Step-by-step memory is a different thing and belongs to the chat that
 * produced it, not to the project; that stays in the run journal, keyed by
 * task, and is never handed to a different chat.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDataDir } from './config.js';

/** Lines kept per section. Past this, the oldest go. */
const MAX_DONE = 10;
const MAX_DECISIONS = 6;
const MAX_GOTCHAS = 5;
const MAX_CHECKS = 4;
/** The whole rendered summary, as handed to the model. */
const MAX_TEXT = 2200;

const root = () => {
  ensureDataDir();
  const dir = path.join(dataDir(), 'project-memory');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const fileFor = (workspaceId) =>
  path.join(root(), `${String(workspaceId ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'}.json`);

const clean = (value, max = 200) => {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Case-insensitive de-duplication that keeps the newest wording of a line. */
function mergeLines(existing, incoming, cap) {
  const out = new Map();
  for (const line of [...(existing || []), ...(incoming || [])]) {
    const text = clean(line);
    if (!text) continue;
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) continue;
    out.delete(key);
    out.set(key, text);
  }
  return [...out.values()].slice(-cap);
}

const empty = (workspaceId) => ({
  workspaceId,
  updatedAt: 0,
  runs: 0,
  overview: '',
  done: [],
  decisions: [],
  gotchas: [],
  checks: [],
  open: '',
  files: [],
  emptiedAt: 0,
});

export function readProjectMemory(workspaceId) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(workspaceId), 'utf8'));
    return { ...empty(workspaceId), ...raw, workspaceId };
  } catch {
    return empty(workspaceId);
  }
}

function write(workspaceId, memory) {
  try {
    const file = fileFor(workspaceId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(memory, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* Memory is an aid; failing to save it must not fail the run. */
  }
  return memory;
}

/**
 * What a run proves about the project, in sentences.
 *
 * Deliberately plain: "created index.html", "renamed the site owner to Wahab".
 * The plan items a run actually completed are the best description of what was
 * done that exists anywhere, and they cost nothing — the agent wrote them.
 */
function sentencesFrom(run) {
  const done = [];
  for (const item of run.plan || []) {
    if (item?.status === 'completed' && item.content) done.push(clean(item.content, 160));
  }
  // A run with no checklist still changed files, and that is worth one line.
  if (!done.length && (run.changed || []).length) {
    const names = run.changed.slice(0, 4).map((f) => f.path).join(', ');
    const more = run.changed.length > 4 ? `, +${run.changed.length - 4} more` : '';
    done.push(clean(`changed ${names}${more}`, 160));
  }
  const decisions = (run.findings || []).map((f) => clean(f, 160)).filter(Boolean);
  const gotchas = (run.toolErrors || [])
    .map((e) => clean(`${e.tool}: ${e.message}`, 160))
    .filter(Boolean);
  const failedChecks = (run.checks || [])
    .filter((c) => c && c.passed === false)
    .map((c) => clean(`${c.name} was failing${c.diagnostic ? `: ${c.diagnostic}` : ''}`, 160));
  // How this project is verified is project knowledge, not step history: it is
  // the same command tomorrow, in any chat, and rediscovering it costs a run.
  const checks = (run.checks || [])
    .filter((c) => c && c.passed)
    .map((c) => clean(`${c.name} passed`, 120));
  const open = (run.plan || []).find((item) => item?.status && item.status !== 'completed')?.content || '';
  return { done, decisions, gotchas: [...gotchas, ...failedChecks], checks, open: clean(open, 160) };
}

/**
 * A one-line description of the project, from what is in it.
 *
 * Only ever derived from the live listing, so it cannot outlive the files.
 */
function overviewFrom(live, previous) {
  const names = live?.files instanceof Set ? [...live.files] : null;
  if (!names) return previous || '';
  const top = names.filter((n) => !n.includes('/'));
  if (!top.length) return '';
  const has = (re) => names.some((n) => re.test(n));
  const kind =
    has(/^index\.html$/i) ? 'a website'
    : has(/^package\.json$/i) ? 'a Node project'
    : has(/^(requirements\.txt|pyproject\.toml)$/i) ? 'a Python project'
    : has(/\.(c|cpp|rs|go|java)$/i) ? 'a compiled project'
    : 'a set of files';
  const shown = top.slice(0, 6).join(', ');
  return clean(`${kind} — ${shown}${top.length > 6 ? `, +${top.length - 6} more at the top level` : ''}`, 220);
}

/**
 * Fold one finished run into the project's summary.
 *
 * `live` is the workspace listing taken during the run: `files` are the paths
 * that exist, `dirs` the folders that were actually read. It is the only thing
 * allowed to contradict what memory claims — and when it shows an empty
 * workspace, the whole summary is retired rather than carried forward, because
 * every sentence in it was about files that are gone.
 */
export function updateProjectMemory(workspaceId, { run, live = null } = {}) {
  if (!workspaceId || !run) return null;
  const previous = readProjectMemory(workspaceId);

  const listed = live?.files instanceof Set ? live.files : null;
  if (listed && listed.size === 0) {
    // Everything that was here is gone. Saying so is useful; pretending the
    // old summary still describes the project is not.
    return write(workspaceId, {
      ...empty(workspaceId),
      updatedAt: Date.now(),
      runs: previous.runs + 1,
      emptiedAt: Date.now(),
      overview: 'The workspace is empty — everything that had been built here was deleted.',
    });
  }

  const { done, decisions, gotchas, checks, open } = sentencesFrom(run);
  const touched = (run.changed || []).map((f) => f.path);

  const gone = (file) => {
    if (!listed || !(live?.dirs instanceof Set)) return false;
    const parts = String(file || '').split('/').filter(Boolean);
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      const parent = i === 0 ? '.' : prefix;
      prefix = i === 0 ? parts[0] : `${prefix}/${parts[i]}`;
      if (!live.dirs.has(parent)) return false;
      if (!listed.has(prefix)) return true;
    }
    return false;
  };

  const next = {
    workspaceId,
    updatedAt: Date.now(),
    runs: previous.runs + 1,
    overview: overviewFrom(live, previous.overview),
    // A sentence naming only files that no longer exist describes work that no
    // longer exists.
    done: mergeLines(previous.done, done, MAX_DONE)
      .filter((line) => !/\b[\w./-]+\.\w{1,5}\b/.test(line)
        || line.match(/\b[\w./-]+\.\w{1,5}\b/g).some((name) => !gone(name))),
    decisions: mergeLines(previous.decisions, decisions, MAX_DECISIONS),
    gotchas: mergeLines(previous.gotchas, gotchas, MAX_GOTCHAS),
    checks: mergeLines(previous.checks, checks, MAX_CHECKS),
    open,
    files: [...new Set([...(previous.files || []), ...touched])]
      .filter((file) => !gone(file))
      .slice(-20),
    emptiedAt: previous.emptiedAt || 0,
  };
  return write(workspaceId, next);
}

/** Forget everything about a project, on request. */
export function clearProjectMemory(workspaceId) {
  try {
    fs.rmSync(fileFor(workspaceId), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The summary as the model receives it.
 *
 * Short on purpose. Every line here is paid for on every request of every run,
 * so it carries what changes the agent's behaviour — what this is, what is
 * already done, what was decided, what bites — and nothing else.
 */
export function renderProjectMemory(memory) {
  const mem = memory || {};
  const parts = [];
  if (mem.overview) parts.push(`This project: ${mem.overview}`);
  if (mem.done?.length) {
    parts.push('Already done here (do not redo without checking):');
    for (const line of mem.done.slice(-MAX_DONE)) parts.push(`- ${line}`);
  }
  if (mem.decisions?.length) {
    parts.push('Established:');
    for (const line of mem.decisions.slice(-MAX_DECISIONS)) parts.push(`- ${line}`);
  }
  if (mem.checks?.length) {
    parts.push('Verified here before:');
    for (const line of mem.checks.slice(-MAX_CHECKS)) parts.push(`- ${line}`);
  }
  if (mem.gotchas?.length) {
    parts.push('Known to bite:');
    for (const line of mem.gotchas.slice(-MAX_GOTCHAS)) parts.push(`- ${line}`);
  }
  if (mem.open) parts.push(`Left open last time: ${mem.open}`);
  if (!parts.length) return '';
  const text = parts.join('\n');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}
