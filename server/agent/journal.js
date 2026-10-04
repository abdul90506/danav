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
const dir = () => path.join(dataDir(), 'agent-runs');

/** A stable opaque key for one assistant turn; raw prompts and message IDs are never journaled. */
export function taskKeyFor(value) {
  const source = String(value ?? '').trim().slice(0, 200);
  return source ? `task-${createHash('sha256').update(source).digest('hex').slice(0, 24)}` : '';
}
const fileFor = (workspaceId) => path.join(dir(), `${String(workspaceId ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'}.json`);

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
  const taskKey = typeof raw.taskKey === 'string' && /^task-[a-f0-9]{24}$/.test(raw.taskKey) ? raw.taskKey : '';
  return {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 80) : genId('jr'),
    taskKey,
    at: Number.isFinite(raw.at) ? raw.at : Date.now(),
    findings,
    toolErrors,
    stopReason: typeof raw.stopReason === 'string' ? raw.stopReason.slice(0, 40) : 'completed',
    changed,
    checks,
    failures: Number.isFinite(raw.failures) ? Math.max(0, Math.min(100, Math.floor(raw.failures))) : 0,
    plan,
    interrupted,
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

/** Store bounded evidence: changed paths/counts, recognized checks, plan state, and short findings. */
export function recordRun(workspaceId, raw) {
  const run = cleanRun({ ...raw, id: genId('jr'), at: Date.now() });
  if (!run) return null;
  const unfinished = run.stopReason !== 'completed' && run.stopReason !== 'aborted';
  if (!run.changed.length && !run.checks.length && !run.failures && !unfinished && !run.plan.length && !run.interrupted.length && !run.findings.length && !run.toolErrors.length) return null;
  ensureDataDir();
  const journalDir = dir();
  fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(journalDir, 0o700); } catch { /* best effort on unusual filesystems */ }
  }
  const previous = readRunJournal(workspaceId, MAX_RUNS).filter((entry) => entry.id !== run.id);
  // Several short runs can finish within the same millisecond; keep file order monotonic.
  run.at = Math.max(run.at, (previous[0]?.at || 0) + 1);
  const runs = [...previous, run].sort((a, b) => a.at - b.at).slice(-MAX_RUNS);
  atomicWrite(fileFor(workspaceId), JSON.stringify({ version: 2, runs }, null, 2), 0o600);
  return run;
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
  const words = new Set(normalizeQuery(query).split(' ').filter((w) => w.length > 2));
  const ranked = runs.map((run) => {
    const searchable = normalizeQuery([
      ...run.changed.map((f) => f.path),
      ...run.checks.map((c) => `${c.name} ${c.diagnostic || ''}`),
      ...run.findings,
      ...run.toolErrors.flatMap((item) => [item.tool, item.message]),
      ...run.plan.map((item) => item.content),
    ].join(' '));
    let relevance = 0;
    for (const word of words) if (searchable.includes(word)) relevance += Math.min(3, word.length / 3);
    return { run, relevance };
  }).sort((a, b) => b.relevance - a.relevance || b.run.at - a.run.at);

  const selected = new Map();
  if (handoff) selected.set(handoff.id, handoff);
  else selected.set(runs[0].id, runs[0]);
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
    const plan = handoff.plan || [];
    const open = plan.filter((item) => item.status !== 'completed');
    if (open.length) {
      addLine('- Checklist saved for this exact continued task:');
      for (const item of plan) {
        if (!addLine(`  ${item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]'} ${item.content}`)) break;
      }
      addLine('  Completed items are done; continue from the first open step rather than repeating work.');
    }
    if (handoff.findings.length && used < cap) {
      addLine('- Findings retained from this task (compact notes, not a substitute for checking mutable facts):');
      for (const finding of handoff.findings) if (!addLine(`  - ${finding}`)) break;
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

  const includedFindings = new Set(handoff?.findings.map((finding) => finding.normalize('NFKC').toLowerCase()) || []);
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
    if (parts.length > 1 || !lines.length) addLine(`- ${parts.join(' · ')}`);

    // On an ordinary task, retrieve only findings that actually match its words;
    // on Continue, the exact task checkpoint above already carries them all.
    if (sameHandoff) continue;
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
