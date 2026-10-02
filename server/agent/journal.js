/** A small, private, deterministic workspace activity journal (no prompts or file bodies). */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, dataDir, ensureDataDir } from './config.js';
import { genId } from './util.js';

const MAX_RUNS = 30;
const MAX_CHANGED_FILES = 20;
const MAX_CHECKS = 12;
const dir = () => path.join(dataDir(), 'agent-runs');
const fileFor = (workspaceId) => path.join(dir(), `${String(workspaceId ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'}.json`);

function cleanRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const changed = Array.isArray(raw.changed)
    ? raw.changed.filter((f) => f && typeof f.path === 'string').slice(0, MAX_CHANGED_FILES).map((f) => ({
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
      }))
    : [];
  return {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 80) : genId('jr'),
    at: Number.isFinite(raw.at) ? raw.at : Date.now(),
    stopReason: typeof raw.stopReason === 'string' ? raw.stopReason.slice(0, 40) : 'completed',
    changed,
    checks,
    failures: Number.isFinite(raw.failures) ? Math.max(0, Math.min(100, Math.floor(raw.failures))) : 0,
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

/** Store evidence only: changed paths/counts, recognized check labels, and outcome. */
export function recordRun(workspaceId, raw) {
  const run = cleanRun({ ...raw, id: genId('jr'), at: Date.now() });
  if (!run) return null;
  if (!run.changed.length && !run.checks.length && !run.failures && run.stopReason === 'completed') return null;
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
  atomicWrite(fileFor(workspaceId), JSON.stringify({ version: 1, runs }, null, 2), 0o600);
  return run;
}

const normalizeQuery = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Query-aware summary for the model; never includes user prompts, outputs, or secrets. */
export function recentRunsForPrompt(workspaceId, query = '', maxChars = 3000, limit = 8) {
  const runs = readRunJournal(workspaceId, MAX_RUNS);
  if (!runs.length) return '';
  const words = new Set(normalizeQuery(query).split(' ').filter((w) => w.length > 2));
  const ranked = runs.map((run) => {
    const searchable = normalizeQuery([
      ...run.changed.map((f) => f.path),
      ...run.checks.map((c) => c.name),
    ].join(' '));
    let relevance = 0;
    for (const word of words) if (searchable.includes(word)) relevance += Math.min(3, word.length / 3);
    return { run, relevance };
  }).sort((a, b) => b.relevance - a.relevance || b.run.at - a.run.at);

  // Always keep the newest evidence, even if an older entry shares a file name with this request.
  const selected = new Map();
  selected.set(runs[0].id, runs[0]);
  for (const item of ranked) {
    if (selected.size >= Math.max(1, Math.min(12, limit))) break;
    selected.set(item.run.id, item.run);
  }
  const entries = [...selected.values()].sort((a, b) => b.at - a.at);
  const lines = [];
  let used = 0;
  const cap = Math.max(0, Math.floor(Number(maxChars) || 0));
  for (const run of entries) {
    const changed = run.changed.length
      ? `changed ${run.changed.slice(0, 5).map((f) => `${f.path} (+${f.added} −${f.removed})`).join(', ')}${run.changed.length > 5 ? `, +${run.changed.length - 5} more files` : ''}`
      : '';
    const checks = run.checks.length
      ? `checks: ${run.checks.slice(0, 4).map((c) => `${c.name} ${c.passed ? 'passed' : c.aborted ? 'stopped' : c.timedOut ? 'timed out' : `failed${c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ''}`}`).join(', ')}`
      : '';
    const parts = [new Date(run.at).toISOString().slice(0, 10), run.stopReason, changed, checks, run.failures ? `${run.failures} tool failure${run.failures === 1 ? '' : 's'}` : '']
      .filter(Boolean);
    const line = `- ${parts.join(' · ')}`;
    const remaining = cap - used - (lines.length ? 1 : 0);
    if (remaining <= 0) break;
    const clipped = line.length > remaining ? `${line.slice(0, Math.max(0, remaining - 1))}…` : line;
    lines.push(clipped);
    used += clipped.length + (lines.length > 1 ? 1 : 0);
    if (used >= cap) break;
  }
  return lines.join('\n');
}
