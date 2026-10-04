/**
 * The project's own history, for an agent that has to reason about code it did
 * not write.
 *
 * Everything here is READ-ONLY git: status, log, blame, diff. Nothing in this
 * file can move a branch, discard a change or write to the index, because an
 * agent asking "why is this like this?" must never be able to rewrite the answer.
 * Commands run through the workspace (local machine or cloud sandbox), so the
 * same code works in both; a workspace that is not a repository simply answers
 * "no history" instead of failing a run.
 *
 * The value over `run_command` with raw git is the shaping: blame is grouped into
 * the commits that actually touched stretches of lines (line-by-line blame is
 * unreadable and wastes tokens), diffs get a per-file summary before any hunks,
 * and everything is bounded. A model that asks "who last changed this function,
 * and when" gets a handful of lines, not a wall.
 */
import { shQuote } from './util.js';

/** Repo detection is asked often and changes rarely; a few seconds of memory is safe. */
const REPO_TTL_MS = 30_000;
const repoCache = new Map(); // ws id + root -> { at, value }

/**
 * The cache key is the workspace identity AND its root, never the id alone.
 * Two workspaces can legitimately share an id (the same workspace mounted at a
 * new path, or a test that reuses one), and an answer cached for a repository
 * that no longer exists at that path turns every later lookup into
 * "outside repository" failures. Caught by the suite, which reuses ids.
 */
const repoKey = (ws) => `${ws.id || ''}::${ws.root}`;

/**
 * Run one read-only git command.
 *
 * `-c core.quotepath=false` keeps non-ASCII paths readable, `--no-pager` stops a
 * pager from swallowing the output, `-c color.ui=false` keeps ANSI escapes out of
 * the model's context, and `safe.directory` is only ever relaxed (never set) after
 * git itself has refused to read a repository — which is the common sandbox case
 * where the checkout belongs to another user. It is a read, so relaxing it cannot
 * change anything.
 */
export async function runGit(ws, args, { cwd, timeoutMs = 15_000 } = {}) {
  const base = ['git', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '--no-pager'];
  const command = [...base, ...args].join(' ');
  const run = (cmd) => ws.exec(cmd, { cwd: cwd || ws.root, timeoutMs });
  let res;
  try {
    res = await run(command);
  } catch (err) {
    return { ok: false, out: '', exitCode: null, error: String(err?.message || err) };
  }
  const out = String(res?.output ?? '');
  const exitCode = Number.isFinite(res?.exitCode) ? res.exitCode : null;
  if (exitCode !== 0 && /dubious ownership/i.test(out)) {
    const relaxed = await run(`git -c safe.directory='*' -c core.quotepath=false -c color.ui=false --no-pager ${args.join(' ')}`).catch(() => null);
    if (relaxed && relaxed.exitCode === 0) return { ok: true, out: String(relaxed.output ?? ''), exitCode: 0 };
  }
  return { ok: exitCode === 0, out, exitCode, error: exitCode === 0 ? null : out.trim().split('\n')[0] || `git exited with ${exitCode}` };
}

/** Is this workspace a git repository (work tree), and where is its root? */
export async function gitRoot(ws) {
  const key = repoKey(ws);
  const hit = repoCache.get(key);
  if (hit && Date.now() - hit.at < REPO_TTL_MS) return hit.value;
  const value = await (async () => {
    const inside = await runGit(ws, ['rev-parse', '--is-inside-work-tree'], { timeoutMs: 8_000 });
    // Not a repo, no git binary, or a timeout: all mean "there is no history here".
    if (!inside.ok || !/true/i.test(inside.out)) return null;
    const top = await runGit(ws, ['rev-parse', '--show-toplevel'], { timeoutMs: 8_000 });
    return top.ok ? top.out.trim() || ws.root : ws.root;
  })();
  repoCache.set(key, { at: Date.now(), value });
  return value;
}

/** Forget the cached answer (used when a command changes the tree, e.g. `git init`). */
export function forgetRepo(ws) {
  repoCache.delete(repoKey(ws));
}

const clean = (s) => String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '').trim();

/** Parse `git status --porcelain=v1 -b` into counts and the file list. */
function parseStatus(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  const out = { branchLine: '', ahead: 0, behind: 0, upstream: '', files: [], modified: 0, staged: 0, untracked: 0 };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      out.branchLine = line.slice(3).trim();
      const track = /\[(.+)\]/.exec(out.branchLine);
      if (track) {
        const ahead = /ahead (\d+)/.exec(track[1]);
        const behind = /behind (\d+)/.exec(track[1]);
        out.ahead = ahead ? Number(ahead[1]) : 0;
        out.behind = behind ? Number(behind[1]) : 0;
      }
      const dots = /^(\S+?)\.\.\.(\S+)/.exec(out.branchLine.split(' [')[0]);
      if (dots) out.upstream = dots[2];
      continue;
    }
    if (line.startsWith('!!')) continue; // ignored
    const code = line.slice(0, 2);
    const path = line.slice(3).replace(/^"|"$/g, '');
    out.files.push({ code, path });
    if (code === '??') out.untracked += 1;
    else {
      if (code[0] !== ' ' && code[0] !== '?') out.staged += 1;
      if (code[1] === 'M' || code[1] === 'D' || code[0] === 'M') out.modified += 1;
    }
  }
  return out;
}

/**
 * Everything a run needs to know about where it is standing.
 *
 * @returns {Promise<null | {root:string, branch:string, detached:boolean, head:null|{sha:string,date:string,subject:string},
 *   clean:boolean, dirty:{modified:number,staged:number,untracked:number,ahead:number,behind:number,upstream:string,files:Array<{code:string,path:string}>},
 *   recent:Array<{sha:string,date:string,author:string,subject:string}>, empty:boolean}>}
 */
export async function readRepoState(ws, { recent = 6 } = {}) {
  const root = await gitRoot(ws);
  if (!root) return null;

  const [branchRes, headRes, statusRes, logRes] = await Promise.all([
    runGit(ws, ['symbolic-ref', '--short', '-q', 'HEAD']),
    runGit(ws, ['log', '-1', '--date=short', '--format=%h%x09%ad%x09%s']),
    runGit(ws, ['status', '--porcelain=v1', '-b']),
    recent > 0 ? runGit(ws, ['log', '-n', String(recent), '--date=short', '--format=%h%x09%ad%x09%an%x09%s']) : Promise.resolve({ ok: true, out: '' }),
  ]);

  const branch = branchRes.ok ? clean(branchRes.out).split('\n')[0] : '';
  const headFields = headRes.ok ? clean(headRes.out).split('\t') : [];
  const head = headFields.length >= 3 ? { sha: headFields[0], date: headFields[1], subject: headFields[2] } : null;
  const status = parseStatus(statusRes.out);
  const recentCommits = String(logRes.out || '')
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((parts) => parts.length >= 4 && /^[0-9a-f]{4,}$/i.test(parts[0]))
    .map(([sha, date, author, subject]) => ({ sha, date, author, subject }));

  const dirty = {
    modified: status.modified,
    staged: status.staged,
    untracked: status.untracked,
    ahead: status.ahead,
    behind: status.behind,
    upstream: status.upstream,
    files: status.files,
  };
  return {
    root,
    branch: branch || (head ? '(detached HEAD)' : ''),
    detached: !branch && Boolean(head),
    head,
    empty: !head,
    clean: !status.files.length,
    dirty,
    recent: recentCommits,
    branchLine: status.branchLine,
  };
}

/**
 * The prompt block. A few lines that answer "where am I" before the model asks.
 *
 * The last section names the three history questions the tools answer, because a
 * capability the model does not know it has is a capability it does not have.
 */
export function formatRepoState(state, { maxCommits = 5, maxFiles = 8 } = {}) {
  if (!state) return '';
  const lines = [];
  const where = state.branch ? `branch ${state.branch}` : 'no branch yet';
  const sha = state.head ? `${state.head.sha} "${clip(state.head.subject, 90)}"` : 'no commits yet';
  lines.push(`${where} · HEAD ${sha}`);
  if (state.clean) {
    lines.push('Working tree clean — everything is committed.');
  } else {
    const bits = [];
    if (state.dirty.modified) bits.push(`${state.dirty.modified} modified`);
    if (state.dirty.staged) bits.push(`${state.dirty.staged} staged`);
    if (state.dirty.untracked) bits.push(`${state.dirty.untracked} untracked`);
    const track = state.dirty.upstream
      ? ` · ${state.dirty.upstream}${state.dirty.ahead ? `, ${state.dirty.ahead} ahead` : ''}${state.dirty.behind ? `, ${state.dirty.behind} behind` : ''}`
      : '';
    lines.push(`Uncommitted: ${bits.join(', ') || `${state.dirty.files.length} changed`}${track}`);
    const shown = state.dirty.files.slice(0, maxFiles).map((f) => `${f.code} ${f.path}`);
    if (shown.length) lines.push(`  ${shown.join('\n  ')}${state.dirty.files.length > shown.length ? `\n  … and ${state.dirty.files.length - shown.length} more` : ''}`);
  }
  if (state.recent.length) {
    lines.push(
      `Recent commits (newest first):\n` +
        state.recent
          .slice(0, maxCommits)
          .map((c) => `  ${c.sha} ${c.date} ${clip(c.subject, 78)}`)
          .join('\n')
    );
  }
  lines.push(
    'History is available without running git yourself: repo_history view="log" for the commits that touched a file, view="blame" for who last changed a function or a line range, view="diff" to see exactly what changed in the working tree (including your own edits so far).'
  );
  return lines.join('\n');
}

/** Commits that touched a path — or the whole repository, newest first. */
export async function gitLog(ws, { path: relPath, limit = 12, rev } = {}) {
  const root = await gitRoot(ws);
  if (!root) return { ok: false, reason: 'not-a-repo' };
  const args = ['log', '-n', String(Math.max(1, Math.min(80, limit))), '--date=short', '--format=%h%x09%ad%x09%an%x09%s'];
  if (rev) args.push(String(rev));
  if (relPath) args.push('--', relPath);
  const res = await runGit(ws, args);
  if (!res.ok) {
    // An empty repository, or a path git cannot resolve: both are answers, not crashes.
    if (/does not have any commits|unknown revision|bad revision/i.test(res.out)) return { ok: true, entries: [], empty: true };
    return { ok: false, reason: res.error || 'git log failed' };
  }
  const entries = String(res.out)
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 4)
    .map(([sha, date, author, subject]) => ({ sha, date, author, subject }));
  return { ok: true, entries, empty: !entries.length };
}

/** `git show <sha>` summary for one commit, bounded. */
export async function gitShow(ws, sha, { maxLines = 120 } = {}) {
  const root = await gitRoot(ws);
  if (!root) return { ok: false, reason: 'not-a-repo' };
  const res = await runGit(ws, ['show', '--stat', '--date=short', '--format=%h%x09%ad%x09%an%x09%s%n%n%b', String(sha)], { timeoutMs: 20_000 });
  if (!res.ok) return { ok: false, reason: res.error || 'git show failed' };
  const text = String(res.out);
  return { ok: true, text: text.split('\n').slice(0, maxLines).join('\n'), truncated: text.split('\n').length > maxLines };
}

/**
 * Who last touched these lines, grouped.
 *
 * Line-by-line blame is the wrong shape for a model: 40 consecutive lines from one
 * commit is ONE fact ("this function arrived in a1b2c3d"), and printing it 40 times
 * costs context and hides the boundary. Consecutive runs of the same commit are
 * therefore merged, and each block is reported with its line range.
 */
export async function gitBlame(ws, { path: relPath, start, end } = {}) {
  const root = await gitRoot(ws);
  if (!root) return { ok: false, reason: 'not-a-repo' };
  if (!relPath) return { ok: false, reason: 'no-path' };
  const range = Number.isFinite(start) && Number.isFinite(end) ? ['-L', `${start},${end}`] : [];
  const res = await runGit(ws, ['blame', '--line-porcelain', ...range, '--', relPath], { timeoutMs: 25_000 });
  if (!res.ok) {
    if (/no such path|does not exist|has only \d+ lines|no matches/i.test(res.out)) return { ok: false, reason: 'bad-range', detail: res.out.trim().split('\n')[0] };
    return { ok: false, reason: res.error || 'git blame failed' };
  }

  const blocks = [];
  let current = null;
  const commitInfo = new Map(); // sha -> { author, time, summary }
  let pending = null; // sha of the porcelain header line
  let lineNo = null;
  for (const raw of String(res.out).split('\n')) {
    const header = /^([0-9a-f]{7,40}) \d+ (\d+)(?: \d+)?$/.exec(raw);
    if (header) {
      pending = header[1];
      lineNo = Number(header[2]);
      continue;
    }
    if (!pending) continue;
    if (raw.startsWith('author ')) {
      const info = commitInfo.get(pending) || {};
      info.author = raw.slice(7).trim();
      commitInfo.set(pending, info);
      continue;
    }
    if (raw.startsWith('author-time ')) {
      const info = commitInfo.get(pending) || {};
      info.time = Number(raw.slice(12).trim());
      commitInfo.set(pending, info);
      continue;
    }
    if (raw.startsWith('summary ')) {
      const info = commitInfo.get(pending) || {};
      info.summary = raw.slice(8).trim();
      commitInfo.set(pending, info);
      continue;
    }
    if (raw.startsWith('\t')) {
      const info = commitInfo.get(pending) || {};
      const text = raw.slice(1);
      if (current && current.sha === pending && lineNo === current.end + 1) {
        current.end = lineNo;
        current.lines += 1;
        if (current.sample.length < 1 && text.trim()) current.sample = [text.trim()];
      } else {
        current = { sha: pending, start: lineNo, end: lineNo, lines: 1, author: info.author || '', time: info.time || null, summary: info.summary || '', sample: text.trim() ? [text.trim()] : [] };
        blocks.push(current);
      }
      continue;
    }
  }
  return { ok: true, blocks, root };
}

/**
 * What changed in the working tree (and index) against a revision.
 *
 * The shape is deliberate: a per-file summary first — the answer to "what did I
 * touch?" — and hunks only while they fit in the budget the caller gave. A model
 * reviewing its own work needs the second, and a model checking the size of a
 * change only needs the first.
 */
export async function gitDiff(ws, { path: relPath, rev = 'HEAD', staged = false, maxLines = 400, maxChars = 14_000 } = {}) {
  const root = await gitRoot(ws);
  if (!root) return { ok: false, reason: 'not-a-repo' };

  const scope = [];
  if (relPath) scope.push('--', relPath);
  const statArgs = ['diff', ...(staged ? ['--cached'] : [rev]), '--numstat', ...scope];
  const statRes = await runGit(ws, statArgs);
  if (!statRes.ok) {
    const emptyRepo = /unknown revision|bad revision|ambiguous argument|does not have any commits/i.test(statRes.out);
    if (emptyRepo) return { ok: true, files: [], text: '', empty: true, reason: 'no commits yet' };
    return { ok: false, reason: statRes.error || 'git diff failed' };
  }
  const files = String(statRes.out)
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 3)
    .map(([added, removed, file]) => ({ file, added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed), binary: added === '-' }));

  const totalLines = files.reduce((n, f) => n + (f.added || 0) + (f.removed || 0), 0);
  if (!files.length) return { ok: true, files: [], text: '', empty: true };

  let text = '';
  let truncated = false;
  if (totalLines <= maxLines && !files.every((f) => f.binary)) {
    const diffRes = await runGit(ws, ['diff', ...(staged ? ['--cached'] : [rev]), '--no-color', '-U2', ...scope], { timeoutMs: 25_000 });
    text = String(diffRes.out || '');
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n… [diff truncated — ask for one path to see it in full]`;
      truncated = true;
    }
  } else {
    truncated = true;
  }

  // Untracked files are real work that `git diff` cannot show at all.
  const status = await runGit(ws, ['status', '--porcelain=v1']);
  const untracked = String(status.out || '')
    .split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).replace(/^"|"$/g, ''));

  return { ok: true, files, text, truncated, untracked, totalLines };
}

const clip = (s, n) => {
  const t = clean(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** "a1b2c3d — 2026-09-30 by Ada: fix the retry loop" for one blame block. */
export function formatBlameBlock(block) {
  const date = block.time ? new Date(block.time * 1000).toISOString().slice(0, 10) : 'unknown date';
  const span = block.start === block.end ? `L${block.start}` : `L${block.start}-${block.end}`;
  return `${span} (${block.lines} line${block.lines === 1 ? '' : 's'}) — ${block.sha.slice(0, 8)}, ${date}${block.author ? `, ${block.author}` : ''}: ${clip(block.summary || '(no message)', 90)}`;
}
