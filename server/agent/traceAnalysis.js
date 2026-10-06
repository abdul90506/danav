/**
 * Reading the flight recorder back as a list of problems.
 *
 * A trace answers "what happened". The question that actually leads to a fix
 * is "what went wrong, and how often" — and nobody finds that by scrolling
 * thousands of events. These are the faults worth catching, each one written
 * as something that can be acted on: the tool that keeps failing the same way,
 * the file read four times, the round that cost 40k tokens to produce one tool
 * call, the fallback that spent the run hopping between models.
 *
 * Every finding points at the evidence (run id, event sequence numbers) so the
 * UI can jump straight to it rather than asserting something unverifiable.
 */

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

const shortArgs = (args) => {
  try {
    const text = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  } catch {
    return '';
  }
};

/** The first line of an error, which is the part that identifies it. */
const errorKey = (text) =>
  String(text || '')
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);

/**
 * Findings for ONE run.
 *
 * @param {{runId: string, events: Array<object>}} run
 * @returns {Array<{id,severity,title,detail,count,runId,seqs,hint}>}
 */
export function analyzeRun({ runId, events }) {
  const found = [];
  const add = (finding) => found.push({ runId, ...finding });

  const tools = events.filter((e) => e.type === 'tool');
  const requests = events.filter((e) => e.type === 'request');
  const responses = events.filter((e) => e.type === 'response');
  const routing = events.filter((e) => e.type === 'routing');
  const errors = events.filter((e) => e.type === 'error');
  const end = events.find((e) => e.type === 'run_end');

  // ---- tools that failed, grouped by the reason -----------------------------
  const failures = new Map();
  for (const event of tools) {
    if (event.ok !== false || event.denied) continue;
    const key = `${event.name}::${errorKey(event.error || event.output)}`;
    const entry = failures.get(key) || { name: event.name, reason: errorKey(event.error || event.output), seqs: [] };
    entry.seqs.push(event.seq);
    failures.set(key, entry);
  }
  for (const entry of failures.values()) {
    add({
      id: `tool-failed:${entry.name}:${entry.reason}`,
      severity: entry.seqs.length > 1 ? 'high' : 'medium',
      title: `${entry.name} failed${entry.seqs.length > 1 ? ` ${entry.seqs.length} times` : ''}`,
      detail: entry.reason || 'no reason was recorded',
      count: entry.seqs.length,
      seqs: entry.seqs,
      hint: entry.seqs.length > 1
        ? 'The same call failed the same way more than once — the agent retried instead of changing approach.'
        : 'One failure. Worth reading if the run went off course afterwards.',
    });
  }

  // ---- the same call, made again, with the same arguments -------------------
  const repeats = new Map();
  for (const event of tools) {
    const key = `${event.name}:${shortArgs(event.args)}`;
    const entry = repeats.get(key) || { name: event.name, args: shortArgs(event.args), seqs: [] };
    entry.seqs.push(event.seq);
    repeats.set(key, entry);
  }
  for (const entry of repeats.values()) {
    if (entry.seqs.length < 2) continue;
    add({
      id: `repeat:${entry.name}:${entry.args}`,
      severity: entry.seqs.length >= 3 ? 'high' : 'medium',
      title: `${entry.name} called ${entry.seqs.length}× with identical arguments`,
      detail: entry.args,
      count: entry.seqs.length,
      seqs: entry.seqs,
      hint: 'Each repeat costs a whole round. Either the first result was lost to context trimming, or the agent did not use what it already had.',
    });
  }

  // ---- the same file examined again and again -------------------------------
  const reads = new Map();
  for (const event of tools) {
    if (!['read_file', 'file_outline'].includes(event.name)) continue;
    const path = typeof event.args?.path === 'string' ? event.args.path : '';
    if (!path) continue;
    const entry = reads.get(path) || { path, seqs: [] };
    entry.seqs.push(event.seq);
    reads.set(path, entry);
  }
  for (const entry of reads.values()) {
    if (entry.seqs.length < 3) continue;
    add({
      id: `reread:${entry.path}`,
      severity: entry.seqs.length >= 4 ? 'high' : 'medium',
      title: `${entry.path} was read ${entry.seqs.length} times`,
      detail: 'One file, several reads in a single run.',
      count: entry.seqs.length,
      seqs: entry.seqs,
      hint: 'The pinned "Already examined" block should have made the later reads unnecessary. If it did not, the ranges did not overlap — or the block was not reaching the model.',
    });
  }

  // ---- the fallback moving the run between models ---------------------------
  const models = [...new Set(requests.map((r) => r.model).concat(responses.map((r) => r.model)).filter(Boolean))];
  const switches = routing.filter((r) => r.kind === 'retry' && /switching to/i.test(String(r.reason || '')));
  if (switches.length) {
    add({
      id: 'model-switches',
      severity: switches.length >= 3 ? 'high' : 'low',
      title: `The fallback changed model ${switches.length}×`,
      detail: `${models.join(' → ') || 'unknown'} — ${[...new Set(switches.map((s) => String(s.reason)))].slice(0, 3).join('; ')}`,
      count: switches.length,
      seqs: switches.map((s) => s.seq),
      hint: 'Each switch replaces the model mid-task. Check the run still knew what it had already examined after the change.',
    });
  }

  // ---- retries that were not switches: a provider refusing work -------------
  const retries = routing.filter((r) => r.kind === 'retry' && !/switching to/i.test(String(r.reason || '')));
  if (retries.length >= 2) {
    add({
      id: 'provider-retries',
      severity: retries.length >= 5 ? 'high' : 'medium',
      title: `${retries.length} provider retries`,
      detail: [...new Set(retries.map((r) => String(r.reason || '').slice(0, 80)))].slice(0, 3).join('; '),
      count: retries.length,
      seqs: retries.map((r) => r.seq),
      hint: 'Time spent waiting on the provider, not on the task. Many retries on one key usually means the per-key budget is wrong.',
    });
  }

  // ---- tokens: where the context actually went ------------------------------
  const biggest = [...requests].sort((a, b) => (b.chars || 0) - (a.chars || 0))[0];
  if (biggest && (biggest.chars || 0) > 120_000) {
    add({
      id: 'large-context',
      severity: (biggest.chars || 0) > 300_000 ? 'high' : 'medium',
      title: `One request carried ${Math.round((biggest.chars || 0) / 1000)}k characters`,
      detail: `Round ${biggest.round} sent ${biggest.messageCount} messages.`,
      count: 1,
      seqs: [biggest.seq],
      hint: 'A request this size is mostly re-sent history. Removing a round saves more than trimming instructions.',
    });
  }

  // ---- rounds that produced nothing at all ----------------------------------
  const empty = responses.filter((r) => !String(r.text || '').trim() && !(r.toolCalls || []).length);
  if (empty.length) {
    add({
      id: 'empty-rounds',
      severity: 'medium',
      title: `${empty.length} round${empty.length === 1 ? '' : 's'} produced no text and no tool call`,
      detail: 'The model was asked, answered nothing, and the round was spent.',
      count: empty.length,
      seqs: empty.map((r) => r.seq),
      hint: 'Usually a reasoning model spending its whole turn thinking, or a provider returning an empty choice.',
    });
  }

  // ---- the slowest single tool call -----------------------------------------
  const slowest = [...tools].sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))[0];
  if (slowest && (slowest.durationMs || 0) > 30_000) {
    add({
      id: `slow-tool:${slowest.name}`,
      severity: (slowest.durationMs || 0) > 120_000 ? 'high' : 'low',
      title: `${slowest.name} took ${Math.round((slowest.durationMs || 0) / 1000)}s`,
      detail: shortArgs(slowest.args),
      count: 1,
      seqs: [slowest.seq],
      hint: 'One call holding up the run. A command with no timeout is the usual cause.',
    });
  }

  // ---- the run itself ending badly ------------------------------------------
  for (const event of errors) {
    add({
      id: `run-error:${errorKey(event.message)}`,
      severity: 'high',
      title: 'The run hit an error',
      detail: errorKey(event.message),
      count: 1,
      seqs: [event.seq],
      hint: 'Everything before this event is the context that produced it.',
    });
  }
  if (!end) {
    add({
      id: 'no-run-end',
      severity: 'high',
      title: 'This run never finished',
      detail: 'No run_end event was written — the process died or the run was killed.',
      count: 1,
      seqs: [],
      hint: 'The last events in the trace are what it was doing when it stopped.',
    });
  } else if (end.stopReason && !['completed', 'aborted'].includes(end.stopReason)) {
    add({
      id: `stopped:${end.stopReason}`,
      severity: end.stopReason === 'error' ? 'high' : 'medium',
      title: `Stopped early: ${end.stopReason}`,
      detail: `${end.steps || 0} steps, ${end.toolCalls || 0} tool calls.`,
      count: 1,
      seqs: [end.seq],
      hint: end.stopReason === 'no_progress'
        ? 'The loop caught the run repeating itself.'
        : 'A budget ran out before the work did.',
    });
  }

  return found.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count);
}

/**
 * The same analysis across every run of a chat, with the repeats merged.
 *
 * A fault that shows up in one run is an incident; the same fault in five runs
 * is the thing to go and fix. Merging makes that difference visible at a
 * glance, and keeps every run id so the evidence is still one click away.
 */
export function analyzeChat(runs) {
  const merged = new Map();
  for (const run of runs) {
    for (const finding of analyzeRun(run)) {
      const existing = merged.get(finding.id);
      if (!existing) {
        merged.set(finding.id, { ...finding, runs: [finding.runId], occurrences: finding.count });
        continue;
      }
      if (!existing.runs.includes(finding.runId)) existing.runs.push(finding.runId);
      existing.occurrences += finding.count;
      // The worst case is the one worth reporting.
      if (SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[existing.severity]) existing.severity = finding.severity;
    }
  }
  return [...merged.values()].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.runs.length - a.runs.length ||
      b.occurrences - a.occurrences
  );
}
