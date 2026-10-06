/** A small, private, deterministic workspace activity journal (no prompts or file bodies). */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { looksLikeSecret } from './memory.js';
import { atomicWrite, dataDir, ensureDataDir } from './config.js';
import { genId } from './util.js';

const MAX_RUNS = 30;
const MAX_CHANGED_FILES = 20;
const MAX_CHECKS = 12;
const MAX_PLAN_ITEMS = 25;
const MAX_FINDINGS = 8;
const MAX_TOOL_ERRORS = 8;
/** Files read and searches run, kept so a continued run does not repeat them. */
const MAX_EXPLORED = 24;
const MAX_TASK_MEMORIES = 12;
const dir = () => path.join(dataDir(), 'agent-runs');

/** A stable opaque key for one assistant turn; raw prompts and message IDs are never journaled. */
export function taskKeyFor(value) {
  const source = String(value ?? '').trim().slice(0, 200);
  return source ? `task-${createHash('sha256').update(source).digest('hex').slice(0, 24)}` : '';
}
const fileFor = (workspaceId) => path.join(dir(), `${String(workspaceId ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'}.json`);

const compactText = (value, max) => {
  if (typeof value !== 'string' || looksLikeSecret(value)) return '';
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return text && !looksLikeSecret(text) ? text : '';
};

function cleanMemoryPath(value) {
  if (typeof value !== 'string') return '';
  const target = value.replace(/\\/g, '/').trim();
  if (!target || target.length > 240 || target.startsWith('/') || /^[a-zA-Z]:/.test(target) || target.split('/').includes('..')) return '';
  if (/(^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.pypirc|id_rsa|id_ed25519|credentials?(?:\.json)?|secrets?)(?:\/|$)/i.test(target)) return '';
  return compactText(target, 180);
}

function cleanMemoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const summary = compactText(raw.summary, 360);
  if (!summary) return null;
  const list = (value, maxItems, maxChars) => {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.slice(0, maxItems * 3).flatMap((item) => {
      const text = compactText(item, maxChars);
      const key = text.normalize('NFKC').toLowerCase();
      if (!text || seen.has(key)) return [];
      seen.add(key);
      return [text];
    }).slice(0, maxItems);
  };
  const files = Array.isArray(raw.files)
    ? [...new Set(raw.files.map(cleanMemoryPath).filter(Boolean))].slice(0, 6)
    : [];
  const id = typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(raw.id) ? raw.id : genId('tm');
  return {
    id,
    at: Number.isFinite(raw.at) ? raw.at : Date.now(),
    summary,
    facts: list(raw.facts, 4, 160),
    decisions: list(raw.decisions, 3, 160),
    errors: list(raw.errors, 3, 180),
    files,
    steps: list(raw.steps, 5, 220),
    next: compactText(raw.next, 200),
    source: raw.source === 'model' ? 'model' : 'local',
  };
}

function cleanRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const changed = Array.isArray(raw.changed)
    ? raw.changed.filter((f) => f && typeof f.path === 'string' && !looksLikeSecret(f.path)).slice(0, MAX_CHANGED_FILES).map((f) => ({
        path: f.path.slice(0, 240),
        added: Number.isFinite(f.added) ? Math.max(0, f.added) : 0,
        removed: Number.isFinite(f.removed) ? Math.max(0, f.removed) : 0,
      }))
    : [];
  const checks = Array.isArray(raw.checks)
    ? raw.checks.filter((c) => c && typeof c.name === 'string').slice(0, MAX_CHECKS).map((c) => ({
        name: c.name.slice(0, 80),
        passed: c.passed === true,
        ...(Number.isFinite(c.exitCode) ? { exitCode: c.exitCode } : {}),
        ...(c.timedOut === true ? { timedOut: true } : {}),
        ...(c.aborted === true ? { aborted: true } : {}),
        ...(typeof c.diagnostic === 'string' && !looksLikeSecret(c.diagnostic) ? { diagnostic: c.diagnostic.replace(/\s+/g, ' ').trim().slice(0, 260) } : {}),
      }))
    : [];
  // The checklist the run was working from. It is task state written by the
  // model itself, and it is what makes "continue" continue instead of restart.
  // Files whose write was still in flight when the run stopped. They were rolled
  // back, so the next run must not assume the half-written content is on disk.
  const interrupted = Array.isArray(raw.interrupted)
    ? raw.interrupted.filter((p) => typeof p === 'string' && p && !looksLikeSecret(p)).slice(0, 8).map((p) => p.slice(0, 240))
    : [];
  const plan = Array.isArray(raw.plan)
    ? raw.plan
        .filter((t) => t && typeof t.content === 'string' && !looksLikeSecret(t.content))
        .slice(0, MAX_PLAN_ITEMS)
        .map((t) => ({
          content: t.content.slice(0, 200),
          status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending',
        }))
    : [];
  const seenFindings = new Set();
  const findings = Array.isArray(raw.findings)
    ? raw.findings.slice(0, 24).flatMap((value) => {
        if (typeof value !== 'string' || looksLikeSecret(value)) return [];
        const text = value.replace(/\s+/g, ' ').trim().slice(0, 280);
        const key = text.normalize('NFKC').toLowerCase();
        if (text.length < 8 || looksLikeSecret(text) || seenFindings.has(key)) return [];
        seenFindings.add(key);
        return [text];
      }).slice(0, MAX_FINDINGS)
    : [];
  const seenErrors = new Set();
  const toolErrors = Array.isArray(raw.toolErrors)
    ? raw.toolErrors.slice(0, 24).flatMap((item) => {
        if (!item || typeof item.tool !== 'string' || typeof item.message !== 'string' || looksLikeSecret(item.message)) return [];
        const tool = item.tool.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
        const message = item.message.replace(/\s+/g, ' ').trim().slice(0, 220);
        const key = `${tool}:${message}`.toLowerCase();
        if (!tool || message.length < 4 || looksLikeSecret(message) || seenErrors.has(key)) return [];
        seenErrors.add(key);
        return [{ tool, message }];
      }).slice(-MAX_TOOL_ERRORS)
    : [];
  // What the run looked at. Changed files were already remembered; the reading
  // and searching that led to them was not, so a continued run had no way to
  // know the ground had been covered and simply covered it again.
  const seenExplored = new Set();
  const explored = Array.isArray(raw.explored)
    ? raw.explored.flatMap((value) => {
        if (typeof value !== 'string' || looksLikeSecret(value)) return [];
        const text = value.replace(/\s+/g, ' ').trim().slice(0, 200);
        const key = text.normalize('NFKC').toLowerCase();
        if (!text || seenExplored.has(key)) return [];
        seenExplored.add(key);
        return [text];
      }).slice(-MAX_EXPLORED)
    : [];
  const taskKey = typeof raw.taskKey === 'string' && /^task-[a-f0-9]{24}$/.test(raw.taskKey) ? raw.taskKey : '';
  const runId = typeof raw.runId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(raw.runId) ? raw.runId : '';
  const memories = Array.isArray(raw.memories)
    ? raw.memories.slice(-MAX_TASK_MEMORIES).map(cleanMemoryEntry).filter(Boolean)
    : [];
  return {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 80) : genId('jr'),
    runId,
    taskKey,
    at: Number.isFinite(raw.at) ? raw.at : Date.now(),
    memories,
    findings,
    toolErrors,
    stopReason: typeof raw.stopReason === 'string' ? raw.stopReason.slice(0, 40) : 'completed',
    changed,
    checks,
    failures: Number.isFinite(raw.failures) ? Math.max(0, Math.min(100, Math.floor(raw.failures))) : 0,
    plan,
    interrupted,
    explored,
  };
}

export function readRunJournal(workspaceId, limit = 12) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(workspaceId), 'utf8'));
    const runs = Array.isArray(parsed.runs) ? parsed.runs.map(cleanRun).filter(Boolean) : [];
    return runs
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(1, Math.min(MAX_RUNS, Math.floor(Number(limit) || 12))));
  } catch {
    return [];
  }
}

/** Remove the private checkpoint when its workspace is deleted. */
export function clearRunJournal(workspaceId) {
  try { fs.rmSync(fileFor(workspaceId), { force: true }); } catch { /* best effort */ }
}

function persistRuns(workspaceId, runs) {
  ensureDataDir();
  const journalDir = dir();
  fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(journalDir, 0o700); } catch { /* best effort on unusual filesystems */ }
  }
  atomicWrite(fileFor(workspaceId), JSON.stringify({ version: 2, runs }, null, 2), 0o600);
}

function saveRunUpdate(workspaceId, run, previousRuns) {
  const previous = previousRuns.filter((entry) => entry.id !== run.id && (!run.runId || entry.runId !== run.runId));
  // Several short runs can finish within the same millisecond; keep file order monotonic.
  run.at = Math.max(Date.now(), (previous[0]?.at || 0) + 1);
  const runs = [...previous, run].sort((a, b) => a.at - b.at).slice(-MAX_RUNS);
  persistRuns(workspaceId, runs);
  return run;
}

/** Store bounded evidence: changed paths/counts, recognized checks, plan state, and short findings. */
export function recordRun(workspaceId, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const previousRuns = readRunJournal(workspaceId, MAX_RUNS);
  const requestedRunId = typeof raw.runId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(raw.runId) ? raw.runId : '';
  const existing = requestedRunId ? previousRuns.find((entry) => entry.runId === requestedRunId) : null;
  const run = cleanRun({
    ...(existing || {}),
    ...raw,
    id: existing?.id || genId('jr'),
    runId: requestedRunId || existing?.runId || '',
    memories: Array.isArray(raw.memories) && raw.memories.length ? raw.memories : (existing?.memories || []),
    explored: Array.isArray(raw.explored) && raw.explored.length ? raw.explored : (existing?.explored || []),
    at: Date.now(),
  });
  if (!run) return null;
  // A run the user stopped is the one they are most likely to continue, so it is
  // never dropped for having produced no artefacts: "I explored these files and
  // was cut off" is exactly the memory Continue needs. Only a completed run that
  // genuinely did nothing is discarded.
  const unfinished = run.stopReason !== 'completed';
  if (!run.changed.length && !run.checks.length && !run.failures && !unfinished && !run.plan.length
    && !run.interrupted.length && !run.findings.length && !run.toolErrors.length && !run.memories.length
    && !run.explored.length) return null;
  return saveRunUpdate(workspaceId, run, previousRuns);
}

/** Upsert one redacted task-step note without storing prompts, file bodies, or raw tool output. */
export function upsertRunMemory(workspaceId, { runId, taskKey = '', entry } = {}) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(runId)) return null;
  const memory = cleanMemoryEntry(entry);
  if (!memory) return null;
  const previousRuns = readRunJournal(workspaceId, MAX_RUNS);
  const existing = previousRuns.find((run) => run.runId === runId);
  const run = cleanRun(existing || {
    id: genId('jr'), runId, taskKey, stopReason: 'running', at: Date.now(),
  });
  if (!run) return null;
  run.taskKey ||= typeof taskKey === 'string' && /^task-[a-f0-9]{24}$/.test(taskKey) ? taskKey : '';
  run.memories = [...run.memories.filter((item) => item.id !== memory.id), memory]
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_TASK_MEMORIES);
  return saveRunUpdate(workspaceId, run, previousRuns);
}

const normalizeQuery = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const clipLine = (value, max = 180) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * Query-aware summary for the model; never includes user prompts, outputs, or secrets.
 *
 * `resume` changes the telling, not the facts. A run being picked up mid-task must
 * read as work in progress — "the checklist you set is still open", "a write was
 * rolled back" — never as "a previous run was stopped". A model told it was
 * interrupted starts by re-checking the world; a model told what it already did
 * carries on from there.
 */
export function recentRunsForPrompt(workspaceId, query = '', maxChars = 3000, limit = 8, { resume = false, taskKey = '' } = {}) {
  const requestedCap = Number(maxChars);
  const cap = Number.isFinite(requestedCap) ? Math.max(0, Math.min(20_000, Math.floor(requestedCap))) : 0;
  if (!cap) return '';
  const requestedLimit = Number(limit);
  const maxEntries = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(12, Math.floor(requestedLimit))) : 8;
  const runs = readRunJournal(workspaceId, MAX_RUNS);
  if (!runs.length) return '';
  const taskRuns = taskKey ? runs.filter((run) => run.taskKey === taskKey) : [];
  // A checklist is task state, not workspace state. Only the exact run being
  // continued may hand one forward; a different chat/task must never inherit it.
  const handoff = resume ? taskRuns[0] || null : null;
  // The newest run of a task is often the thinnest — a run that was stopped
  // seconds in, or a Continue that only re-read a file. Its own plan/findings
  // may be empty while the run before it holds everything that was learned, so
  // the checklist and the notes come from the newest run that actually has
  // them, not merely the newest run.
  const newestWith = (pick) => taskRuns.map(pick).find((value) => value && value.length) || [];
  const handoffPlan = handoff ? newestWith((run) => run.plan) : [];
  const handoffFindings = handoff
    ? [...new Map(taskRuns.flatMap((run) => run.findings).map((f) => [f.normalize('NFKC').toLowerCase(), f])).values()]
    : [];
  const handoffMemories = handoff
    ? [...new Map(taskRuns.flatMap((run) => run.memories).sort((a, b) => a.at - b.at).map((item) => [
        JSON.stringify([item.summary, item.facts, item.decisions, item.errors, item.files, item.steps, item.next]), item,
      ])).values()].slice(-MAX_TASK_MEMORIES)
    : [];
  const words = new Set(normalizeQuery(query).split(' ').filter((w) => w.length > 2));
  const ranked = runs.map((run) => {
    const searchable = normalizeQuery([
      ...run.changed.map((f) => f.path),
      ...run.checks.map((c) => `${c.name} ${c.diagnostic || ''}`),
      ...run.findings,
      ...run.toolErrors.flatMap((item) => [item.tool, item.message]),
      ...run.plan.map((item) => item.content),
      ...run.memories.flatMap((item) => [item.summary, ...item.facts, ...item.decisions, ...item.errors, item.next, ...item.files, ...(item.steps || [])]),
    ].join(' '));
    let relevance = 0;
    for (const word of words) if (searchable.includes(word)) relevance += Math.min(3, word.length / 3);
    return { run, relevance };
  }).sort((a, b) => b.relevance - a.relevance || b.run.at - a.run.at);

  const selected = new Map();
  // Every run of the task being continued is relevant by definition — the work
  // it did is the thing Continue has to not repeat. Ranking them against the
  // user's words would drop them, because "Continue." has no words to match.
  if (handoff) for (const run of taskRuns.slice(0, maxEntries)) selected.set(run.id, run);
  // Do not inject the newest workspace run into an unrelated task. If the user
  // supplied no searchable words, the latest entry is the only useful default.
  else if (!words.size) selected.set(runs[0].id, runs[0]);
  for (const item of ranked) {
    if (selected.size >= maxEntries) break;
    if (item.relevance > 0) selected.set(item.run.id, item.run);
  }
  const entries = [...selected.values()].sort((a, b) => b.at - a.at);
  const lines = [];
  let used = 0;
  const addLine = (value) => {
    const text = String(value || '');
    const remaining = cap - used - (lines.length ? 1 : 0);
    if (remaining <= 0) return false;
    const line = text.length > remaining ? `${text.slice(0, Math.max(0, remaining - 1))}…` : text;
    lines.push(line);
    used += line.length + (lines.length > 1 ? 1 : 0);
    return line.length === text.length;
  };

  if (handoff) {
    const plan = handoffPlan;
    const open = plan.filter((item) => item.status !== 'completed');
    if (plan.length) {
      addLine('- Checklist saved for this exact continued task:');
      for (const item of plan) {
        if (!addLine(`  ${item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]'} ${item.content}`)) break;
      }
      // A checklist with nothing open still has to be reported. Staying silent
      // reads as "there was no plan", and the run starts the task over.
      addLine(open.length
        ? '  Completed items are done; continue from the first open step rather than repeating work.'
        : '  Every step was marked done. Verify that before redoing any of it; the user may be asking for something beyond this list.');
    }
    if (handoffFindings.length && used < cap) {
      addLine('- Findings retained from this task (compact notes, not a substitute for checking mutable facts):');
      for (const finding of handoffFindings) if (!addLine(`  - ${finding}`)) break;
    }
    if (handoffMemories.length && used < cap) {
      addLine('- Concise task-step memories carried across this exact task (verify mutable facts against current files):');
      for (const memory of handoffMemories.slice(-4)) {
        const parts = [];
        if (memory.steps?.length) parts.push(`steps: ${memory.steps.slice(-5).map((step) => clipLine(step, 100)).join(' → ')}`);
        else if (memory.files.length) parts.push(`files: ${memory.files.slice(0, 4).join(', ')}`);
        if (memory.summary) parts.push(`summary: ${clipLine(memory.summary, 100)}`);
        if (memory.facts.length) parts.push(`fact: ${clipLine(memory.facts[0], 100)}`);
        if (memory.decisions.length) parts.push(`decision: ${clipLine(memory.decisions[0], 90)}`);
        if (memory.errors.length) parts.push(`avoid: ${clipLine(memory.errors[0], 100)}`);
        if (memory.next) parts.push(`next: ${clipLine(memory.next, 100)}`);
        if (!addLine(`  - ${clipLine(parts.join(' · '), 900)}`)) break;
      }
    }
    const exploredAll = [...new Set(taskRuns.flatMap((run) => run.explored))];
    if (exploredAll.length && used < cap) {
      addLine('- Already looked at on this task (do not re-read or re-search these unless the file changed since):');
      for (const item of exploredAll.slice(-MAX_EXPLORED)) if (!addLine(`  - ${item}`)) break;
    }
    if (handoff.toolErrors.length && used < cap) {
      addLine('- Earlier tool failures (do not repeat the same call unchanged; adapt to this result):');
      for (const failure of handoff.toolErrors) if (!addLine(`  ${failure.tool}: ${failure.message}`)) break;
    }
    if (handoff.interrupted.length && used < cap) {
      const files = handoff.interrupted.map((p) => `\`${p}\``).join(', ');
      addLine(`- A write to ${files} was rolled back; those files are unchanged by that interrupted write and must be re-written if still needed.`);
    }
  }

  const includedFindings = new Set(handoffFindings.map((finding) => finding.normalize('NFKC').toLowerCase()));
  const includedErrors = new Set(handoff?.toolErrors.map((failure) => `${failure.tool}:${failure.message}`.normalize('NFKC').toLowerCase()) || []);
  for (const run of entries) {
    if (used >= cap) break;
    const changed = run.changed.length
      ? `changed ${run.changed.slice(0, 5).map((file) => `${file.path} (+${file.added} −${file.removed})`).join(', ')}${run.changed.length > 5 ? `, +${run.changed.length - 5} more files` : ''}`
      : '';
    const checks = run.checks.length
      ? `checks: ${run.checks.slice(0, 4).map((check) => {
          const status = check.passed ? 'passed' : check.aborted ? 'stopped' : check.timedOut ? 'timed out' : `failed${check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ''}`;
          const diagnostic = !check.passed && check.diagnostic ? `: ${clipLine(check.diagnostic, 120)}` : '';
          return `${check.name} ${status}${diagnostic}`;
        }).join(', ')}`
      : '';
    const sameHandoff = Boolean(handoff && run.id === handoff.id);
    const sameTask = Boolean(taskKey && run.taskKey === taskKey);
    const parts = [new Date(run.at).toISOString().slice(0, 10), resume && sameTask ? '' : run.stopReason, changed, checks, run.failures ? `${run.failures} tool failure${run.failures === 1 ? '' : 's'}` : '']
      .filter(Boolean);
    if (parts.length > 1 || !lines.length) addLine(`- ${resume && sameTask ? 'Earlier in this task: ' : ''}${parts.join(' · ')}`);

    // Task-step summaries are retrieved only when their content matches this
    // request. They are hints, not current workspace truth.
    if (sameHandoff) continue;
    const matchingMemories = run.memories.map((memory) => {
      const searchable = normalizeQuery([memory.summary, ...memory.facts, ...memory.decisions, ...memory.errors, memory.next, ...memory.files, ...(memory.steps || [])].join(' '));
      const relevance = [...words].reduce((score, word) => score + (searchable.includes(word) ? Math.min(3, word.length / 3) : 0), 0);
      return { memory, relevance };
    }).filter((item) => item.relevance > 0).sort((a, b) => b.relevance - a.relevance || b.memory.at - a.memory.at).slice(0, 2);
    for (const { memory } of matchingMemories) {
      const parts = [memory.summary];
      if (memory.facts.length) parts.push(`facts: ${memory.facts.slice(0, 2).join('; ')}`);
      if (memory.decisions.length) parts.push(`decisions: ${memory.decisions.slice(0, 1).join('; ')}`);
      if (memory.errors.length) parts.push(`avoid repeating: ${memory.errors.slice(0, 1).join('; ')}`);
      if (memory.files.length) parts.push(`files: ${memory.files.slice(0, 3).join(', ')}`);
      if (sameTask && memory.steps?.length) parts.push(`steps: ${memory.steps.slice(-2).join(' → ')}`);
      if (memory.next) parts.push(`next: ${memory.next}`);
      if (!addLine(`- Earlier task memory, verify against current files: ${clipLine(parts.join(' · '), 340)}`)) break;
    }
    for (const finding of run.findings) {
      const key = finding.normalize('NFKC').toLowerCase();
      if (includedFindings.has(key) || !words.size || ![...words].some((word) => normalizeQuery(finding).includes(word))) continue;
      if (!addLine(`- Earlier finding, verify against current files: ${finding}`)) break;
      includedFindings.add(key);
    }
    for (const failure of run.toolErrors) {
      const key = `${failure.tool}:${failure.message}`.normalize('NFKC').toLowerCase();
      const searchableError = normalizeQuery(`${failure.tool} ${failure.message}`);
      if (includedErrors.has(key) || !words.size || ![...words].some((word) => searchableError.includes(word))) continue;
      if (!addLine(`- Earlier failed attempt; do not repeat unchanged: ${failure.tool} — ${failure.message}`)) break;
      includedErrors.add(key);
    }
  }
  return lines.join('\n');
}
