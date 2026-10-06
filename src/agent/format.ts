import type { AgentAction, Message } from '../types';

/**
 * How an action reads in the chat — the plain sentence behind
 *
 *   Edited  📄 prompt.js  +1 -1
 *   Analyzed  📄 App.tsx  #L1-120
 *   Ran       npm install
 *
 * Kept free of React so the wording rules are testable.
 */

export interface ActionLabel {
  verb: string;
  target?: string;
  targetKind?: 'file' | 'dir' | 'command' | 'pattern' | 'url' | 'text';
  /** Source line range, rendered as "#L34-52" in a file row. */
  lines?: string;
  added?: number;
  removed?: number;
  /** Muted trailing text: "8 matches in 3 files", "exit 1", "2.3s" */
  meta?: string;
  /** Short badge-like strings (ports, process ids). */
  chips?: string[];
  /** Paths for one multi-file edit, shown by name instead of the vague "2 files changed". */
  fileTargets?: string[];
  /** Per-file changes keep a multi-file edit's inline counts truthful. */
  fileChanges?: Array<{ path: string; added: number; removed: number }>;
  /** Path to take the file icon from, when the displayed text is not itself a path (e.g. "a → b"). */
  iconPath?: string;
  /** Something to reveal on click (output, diff, checklist, error). */
  expandable: boolean;
  /** The command ran but exited non-zero: information, shown in red. */
  exitFailed?: boolean;
}

export const isLive = (a: AgentAction) =>
  a.status === 'pending' || a.status === 'queued' || a.status === 'running' || a.status === 'awaiting_approval';

/** Shimmer only while something is actually being worked on (not while it waits its turn). */
export const isWorking = (a: AgentAction) => a.status === 'pending' || a.status === 'running';

/** "L34–L52", "L7", "L2–L4, L30 +2 more" */
export function formatRanges(ranges?: Array<[number, number]>, max = 3): string | undefined {
  if (!ranges || ranges.length === 0) return undefined;
  const one = ([a, b]: [number, number]) => (a === b ? `L${a}` : `L${a}–L${b}`);
  const shown = ranges.slice(0, max).map(one).join(', ');
  return ranges.length > max ? `${shown} +${ranges.length - max} more` : shown;
}

/**
 * A stopwatch reading, in whole seconds — the same unit the running clock uses, so
 * the number that ticks under a live turn is the number the finished line reports.
 * Under a second there is nothing worth saying, and the caller gets nothing.
 */
export function formatDuration(ms?: number): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 1000) return undefined;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const firstLine = (s?: string, n = 140) => {
  const line = String(s || '').split('\n').find((l) => l.trim()) || '';
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};
const hostOf = (url?: string) => {
  try {
    return new URL(url || '').hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** past-tense failure wording per tool, used when the TOOL itself failed */
const FAILED: Record<string, string> = {
  write_file: "Couldn't create",
  append_file: "Couldn't append to",
  replace_in_files: 'Replace failed:',
  edit_file: "Couldn't edit",
  multi_edit: "Couldn't edit",
  read_file: "Couldn't read",
  file_outline: "Couldn't outline",
  remember: "Couldn't save a note:",
  forget: "Couldn't forget",
  list_dir: "Couldn't list",
  grep_search: 'Search failed:',
  file_search: 'Search failed:',
  run_command: "Couldn't run",
  list_processes: "Couldn't list processes",
  read_process_output: "Couldn't read logs of",
  stop_process: "Couldn't stop",
  get_preview_url: 'Preview not ready on',
  web_search: 'Web search failed:',
  fetch_url: "Couldn't read",
  image_search: 'Image search failed:',
  update_plan: "Couldn't update plan",
  repo_status: "Couldn't read the repository",
  repo_history: "Couldn't read the history",
  run_checks: 'Checks failed:',
};

export function actionLabel(a: AgentAction): ActionLabel {
  return decorate(a, rawLabel(a));
}

/** Facts about the RESULT that matter whatever the tool: a failed syntax check, a write that was cut off. */
function decorate(a: AgentAction, label: ActionLabel): ActionLabel {
  const r = a.result;
  if (a.status !== 'done' || !r) return label;
  const extra: string[] = [];
  if (r.partial) extra.push('cut off — carrying on');
  if (r.check && r.check.ok === false) {
    extra.push('syntax error');
    label.exitFailed = true;
    label.expandable = true;
  }
  if (extra.length) label.meta = [label.meta, ...extra].filter(Boolean).join(' · ');
  return label;
}

function rawLabel(a: AgentAction): ActionLabel {
  const live = isLive(a);
  const r = a.result;
  const args = a.args || {};
  const toolFailed =
    a.status === 'error' &&
    a.error !== 'Stopped' &&
    a.error !== 'Interrupted' &&
    // A result carrying an exit code means the command ran and the process said no:
    // that is a row ("Ran checks · exit 1"), not a failed tool with an error string.
    !(r && typeof r.exitCode === 'number');
  const err = toolFailed ? firstLine(a.error) : undefined;

  const settled = a.status === 'error' && (a.error === 'Stopped' || a.error === 'Interrupted');

  const base = (verbLive: string, verbDone: string, extra: Partial<ActionLabel> = {}): ActionLabel => {
    if (settled) {
      // The turn ended while this was in flight: "Stopped  $ npm install", not "Couldn't run …".
      return { ...extra, verb: a.error as string, added: undefined, removed: undefined, lines: undefined, meta: undefined, expandable: Boolean(extra.expandable && a.output) };
    }
    if (a.status === 'denied') {
      return { verb: 'Skipped', ...extra, meta: 'not allowed', expandable: false, added: undefined, removed: undefined, lines: undefined };
    }
    if (r?.recovered) {
      // The call arrived without a usable path, so its body was parked instead of
      // lost. Nothing failed: the file exists, it just has no destination yet.
      return {
        verb: 'Saved',
        target: r.path,
        targetKind: 'file',
        meta: 'waiting for a path',
        added: undefined,
        removed: undefined,
        lines: undefined,
        expandable: false,
      };
    }
    if (a.status === 'blocked') {
      // Refused by the run, not by the user and not by a bug: the agent tried to
      // change something it had never looked at. It gets told what to read, so
      // this reads as a redirection rather than a crash.
      return {
        verb: 'Refused',
        ...extra,
        meta: firstLine(a.error) || 'not inspected yet',
        added: undefined,
        removed: undefined,
        lines: undefined,
        expandable: Boolean(a.error && a.error.length > 0),
      };
    }
    if (toolFailed) {
      return {
        verb: FAILED[a.tool] || 'Failed',
        ...extra,
        added: undefined,
        removed: undefined,
        lines: undefined,
        meta: err || undefined,
        expandable: Boolean(a.error && a.error.length > 0),
      };
    }
    return { verb: live ? verbLive : verbDone, expandable: false, ...extra };
  };

  switch (a.tool) {
    case 'list_dir': {
      // Prefer the absolute target for the activity row so a root listing never
      // collapses to a mysterious "."; old saved actions fall back to the known path.
      const listed = r?.fullPath || r?.path || args.path || '.';
      return base('Exploring', 'Explored', {
        target: listed,
        targetKind: 'dir',
        meta: !live && typeof r?.count === 'number' && r.count > 0 ? plural(r.count, 'item') : undefined,
      });
    }

    case 'read_file': {
      const start = r?.startLine ?? args.startLine;
      const end = r?.endLine ?? args.endLine;
      const repeated = r?.repeated === true;
      return base('Analyzing', repeated ? 'Already read' : 'Analyzed', {
        target: r?.path || args.path,
        targetKind: 'file',
        lines: r?.ranges?.length ? formatRanges(r.ranges, 4) : start && end ? (start === end ? `L${start}` : `L${start}–L${end}`) : undefined,
        meta: !live && r?.truncated ? `of ${r.totalLines}` : undefined,
      });
    }

    case 'write_file': {
      // Live progress is emitted only after the writer confirms a disk snapshot;
      // never substitute the model's still-growing argument buffer here.
      const added = live ? a.progress?.added : r?.added;
      const removed = live ? a.progress?.removed : r?.removed;
      return base('Creating', r?.created === false ? 'Rewrote' : 'Created', {
        target: r?.path || args.path,
        targetKind: 'file',
        added,
        removed: (removed ?? 0) > 0 ? removed : undefined,
        expandable: !live && Boolean(r?.hunks?.length),
      });
    }

    case 'append_file': {
      return base('Appending', 'Appended', {
        target: r?.path || args.path,
        targetKind: 'file',
        added: r?.added,
        expandable: !live && Boolean(r?.hunks?.length),
      });
    }

    case 'replace_in_files': {
      const shown = `${r?.pattern ?? args.pattern ?? ''} → ${r?.replacement ?? args.replacement ?? ''}`;
      return base('Replacing', r?.dryRun ? 'Previewed replacing' : 'Replaced', {
        target: shown,
        targetKind: 'pattern',
        meta:
          !live && r
            ? r.count
              ? `${plural(r.count, 'replacement')} in ${plural(r.fileCount ?? 0, 'file')}`
              : 'no matches'
            : undefined,
        expandable: !live && Boolean(r?.changes?.length),
      });
    }

    case 'edit_file':
    case 'multi_edit': {
      const n = r?.edits;
      const fileTargets = [...new Set((r?.changes || []).map((file) => file.path).filter(Boolean))];
      const manyFiles = fileTargets.length > 1;
      const liveEdits = typeof args.edits === 'number' && args.edits > 1 ? plural(args.edits, 'edit') : undefined;
      return base('Editing', 'Edited', {
        target: manyFiles ? undefined : r?.path || args.path || fileTargets[0],
        targetKind: 'file',
        ...(manyFiles ? { fileTargets, fileChanges: r?.changes?.map((file) => ({ path: file.path, added: file.added, removed: file.removed })) } : {}),
        lines: live || manyFiles ? undefined : formatRanges(r?.ranges),
        added: r?.added,
        removed: r?.removed,
        meta: live
          ? liveEdits
          : n && n > 1
            ? plural(n, 'edit')
            : undefined,
        expandable: !live && Boolean(r?.hunks?.length || r?.changes?.some((f) => f.hunks?.length)),
      });
    }

    case 'load_skill':
      return base('Loading skill', 'Loaded skill', {
        target: r?.name || args.name,
        targetKind: 'text',
        meta: !live ? r?.path : undefined,
        expandable: false,
      });

    case 'remember':
      return base('Remembering', 'Remembered', {
        target: r?.note || args.note,
        targetKind: 'text',
        meta: !live && r && r.saved === false ? 'already saved' : undefined,
      });

    case 'forget':
      return base('Forgetting', 'Forgot', {
        target: args.contains || args.id,
        targetKind: 'text',
        meta: !live && r ? plural(r.count ?? 0, 'note') : undefined,
      });

    case 'find_symbol': {
      return base('Looking up', 'Looked up', {
        target: args.name || args.pattern,
        targetKind: 'text',
        meta: !live && r ? `${r.definitions || 0} defined · ${r.references || 0} used in ${r.files || 0} file${r.files === 1 ? '' : 's'}` : undefined,
        expandable: false,
      });
    }

    case 'relevant_files': {
      return base('Ranking files for', 'Ranked files for', {
        target: args.query,
        targetKind: 'text',
        meta: !live && r ? `${r.count} file${r.count === 1 ? '' : 's'}` : undefined,
        expandable: false,
      });
    }

    case 'code_map': {
      return base('Mapping', 'Mapped', {
        target: args.path && args.path !== '.' ? args.path : 'the project',
        targetKind: args.path && args.path !== '.' ? 'dir' : 'text',
        meta: !live && r ? `${r.count} file${r.count === 1 ? '' : 's'}${r.symbols ? ` · ${r.symbols} definitions` : ''}` : undefined,
        expandable: false,
      });
    }

    case 'file_outline':
      return base('Outlining', 'Outlined', {
        target: r?.path || args.path,
        targetKind: 'file',
        meta: !live && r ? plural(r.count ?? 0, 'symbol') : undefined,
      });

    case 'grep_search':
      return base('Searching', 'Searched', {
        target: r?.pattern || args.pattern,
        targetKind: 'pattern',
        meta: !live && r ? (r.count ? `${plural(r.count, 'match', 'matches')} in ${plural(r.files ?? 0, 'file')}` : 'no matches') : undefined,
      });

    case 'file_search':
      return base('Finding files', 'Found files', {
        target: r?.pattern || args.pattern,
        targetKind: 'pattern',
        meta: !live && r ? (r.count ? plural(r.count, 'file') : 'none') : undefined,
      });

    case 'run_command': {
      const background = Boolean(args.background || r?.kind === 'background');
      const command = r?.command || args.command;
      if (a.status === 'awaiting_approval') {
        return { verb: 'Waiting for approval to run', target: a.approval?.command || command, targetKind: 'command', expandable: false };
      }
      if (background) {
        const chips = [r?.id, ...(r?.ports || []).map((p) => `:${p}`)].filter(Boolean) as string[];
        return base('Starting', r?.reused ? 'Already running' : r?.exited ? 'Started (exited)' : 'Started', {
          target: command,
          targetKind: 'command',
          chips: live ? undefined : chips,
          expandable: Boolean(command) || Boolean(a.output),
        });
      }
      const code = r?.exitCode;
      const exitFailed = !live && typeof code === 'number' && code !== 0;
      const bits: string[] = [];
      if (!live && r?.timedOut) bits.push('timed out');
      else if (!live && r?.aborted) bits.push('stopped');
      else if (exitFailed) bits.push(`exit ${code}`);
      // No per-command seconds here: how long the run took is said once, at the
      // end of the turn, and a stopwatch after every row is just noise.
      return base('Running', 'Ran', {
        target: command,
        targetKind: 'command',
        meta: bits.join(' · ') || undefined,
        exitFailed: exitFailed || Boolean(r?.timedOut),
        expandable: Boolean(command) || Boolean(a.output) || toolFailed,
      });
    }

    case 'repo_status':
      return base('Reading the repository', 'Read the repository', {
        target: r?.branch || undefined,
        targetKind: 'text',
        meta: !live && r ? (r.repo === false ? 'not a repository' : r.dirty ? `${r.dirty} uncommitted` : 'clean') : undefined,
        expandable: false,
      });

    case 'repo_history': {
      const view = String(args.view || 'log');
      const verb = view === 'blame' ? ['Tracing', 'Traced'] : view === 'diff' ? ['Reviewing', 'Reviewed'] : ['Reading history of', 'Read history of'];
      const target = args.path || (view === 'diff' ? 'uncommitted changes' : 'the repository');
      const meta =
        !live && r
          ? view === 'log'
            ? plural(r.count ?? 0, 'commit')
            : view === 'blame'
              ? plural(r.blocks ?? 0, 'block')
              : `${r.files ?? 0} file${r.files === 1 ? '' : 's'}${typeof r.added === 'number' ? ` +${r.added} −${r.removed}` : ''}`
          : undefined;
      return base(verb[0], verb[1], { target, targetKind: view === 'diff' ? 'text' : args.path ? 'file' : 'text', meta, expandable: false });
    }

    case 'run_checks': {
      const names = String(r?.command || args.only || 'project checks');
      const failed = r && r.passed === false;
      const bits: string[] = [];
      if (!live && r?.timedOut) bits.push('timed out');
      else if (!live && failed) bits.push(`exit ${r?.exitCode ?? '?'}`);
      return base('Running checks', failed ? 'Ran checks' : 'Checks passed', {
        target: names,
        targetKind: 'command',
        meta: !live && r ? [r.checks ? plural(r.checks, 'check') : undefined, ...bits].filter(Boolean).join(' · ') || undefined : undefined,
        exitFailed: Boolean(failed),
        expandable: Boolean(names) || Boolean(a.output) || Boolean(failed),
      });
    }

    case 'list_processes':
      return base('Checking processes', 'Listed processes', {
        meta: !live && r ? (r.count ? `${plural(r.count, 'process')}${r.running ? `, ${r.running} running` : ', none running'}` : 'none') : undefined,
        expandable: Boolean(a.output),
      });

    case 'read_process_output':
      return base('Checking logs of', 'Checked logs of', {
        target: r?.id || args.id,
        targetKind: 'text',
        meta: !live && r ? (r.running ? 'running' : 'exited') : undefined,
        expandable: Boolean(a.output),
      });

    case 'stop_process':
      return base('Stopping', 'Stopped', { target: r?.id || args.id, targetKind: 'text' });

    case 'get_preview_url':
      return base('Opening preview of port', 'Preview ready on port', {
        target: String(r?.port ?? args.port ?? ''),
        targetKind: 'text',
      });

    case 'web_search':
      return base('Searching the web for', 'Searched the web for', {
        target: r?.query || args.query,
        targetKind: 'text',
        expandable: Boolean(r?.markdown),
      });

    case 'fetch_url':
      return base('Reading', 'Read', {
        target: hostOf(r?.url || args.url),
        targetKind: 'url',
        meta: !live ? r?.title : undefined,
        expandable: Boolean(r?.markdown),
      });

    case 'image_search':
      return base('Finding images of', 'Found images of', {
        target: r?.query || args.query,
        targetKind: 'text',
        meta: !live && r?.count !== undefined ? plural(r.count, 'image') : undefined,
        expandable: !live && Boolean(r?.images?.length),
      });

    case 'update_plan':
      return base('Updating plan', 'Updated plan', {
        meta: [r?.total ? `${r.done ?? 0}/${r.total} done` : undefined, r?.summary || undefined].filter(Boolean).join(' · ') || undefined,
        expandable: Boolean(r?.todos?.length || r?.findings?.length),
      });

    default:
      return base('Running', 'Ran', { target: a.tool, targetKind: 'text' });
  }
}

/** The compact duration used by the Worked row: seconds below a minute, whole minutes after. */
function workedDuration(ms?: number): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 1000) return undefined;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

/** 48320 -> "48.3k". Exact below 1000, because "900 tokens" reads better than "0.9k". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 100 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`;
}

/**
 * What a run cost, for the work row: "48.3k tokens".
 *
 * Input and output are added together because that is the number that answers
 * "was that expensive?". The split is worth keeping for the tooltip — a run that
 * is nearly all input is a run that re-sent its conversation too many times.
 */
export function usageSummary(usage?: { inputTokens?: number; outputTokens?: number }): string | undefined {
  const input = Number(usage?.inputTokens) || 0;
  const output = Number(usage?.outputTokens) || 0;
  const total = input + output;
  if (!total) return undefined;
  return `${formatTokens(total)} tokens`;
}

/** The same thing spelled out, for a title attribute. */
export function usageDetail(usage?: { inputTokens?: number; outputTokens?: number; rounds?: number }): string | undefined {
  const input = Number(usage?.inputTokens) || 0;
  const output = Number(usage?.outputTokens) || 0;
  if (!input && !output) return undefined;
  const rounds = Number(usage?.rounds) || 0;
  const parts = [`${input.toLocaleString()} in`, `${output.toLocaleString()} out`];
  if (rounds) parts.push(`${rounds} round${rounds === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** A restrained, human status for the work row; file-level details stay in the trail. */
export function workedSummary(run?: {
  durationMs?: number;
  toolCalls?: number;
  changed?: Array<{ path: string; added: number; removed: number }>;
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}): string | undefined {
  if (!run || (!run.toolCalls && !(run.changed || []).length)) return undefined;
  const time = workedDuration(run.durationMs);
  const spent = usageSummary(run.usage);
  const withCost = (head: string) => (spent ? `${head} · ${spent}` : head);
  if (run.stopReason === 'aborted' || run.stopReason === 'error') {
    return withCost(time ? `Stopped after ${time}` : 'Work stopped');
  }
  if (run.stopReason && run.stopReason !== 'completed') {
    return withCost(time ? `Paused after ${time}` : 'Work paused');
  }
  return withCost(time ? `Worked for ${time}` : 'Work complete');
}

/**
 * The totals for a run's changed files.
 *
 * The run already carried this and nothing in the chat ever showed it, so after
 * a run finished the one question it did not answer was the obvious one: which
 * of my files did you touch? Returns undefined when nothing changed, so a
 * read-only run stays silent rather than announcing "0 files".
 */
export function changedTotals(changed?: Array<{ path: string; added: number; removed: number }>):
  { files: number; added: number; removed: number; label: string } | undefined {
  if (!changed?.length) return undefined;
  let added = 0;
  let removed = 0;
  for (const f of changed) {
    added += f.added || 0;
    removed += f.removed || 0;
  }
  return {
    files: changed.length,
    added,
    removed,
    label: `${changed.length} file${changed.length === 1 ? '' : 's'} changed`,
  };
}

/**
 * What a whole conversation has cost so far, summed over its agent runs.
 *
 * Per-run figures answer "was that expensive?"; this answers the question that
 * actually decides whether to start a new chat — the one nobody could answer
 * before, because the numbers were only ever shown one run at a time. Messages
 * from a provider that reports nothing simply do not count, so the total is a
 * floor rather than a guess.
 */
export function conversationUsage(
  messages: Array<{ agentRun?: { usage?: { inputTokens?: number; outputTokens?: number; rounds?: number } } }>
): { inputTokens: number; outputTokens: number; rounds: number; runs: number } | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let rounds = 0;
  let runs = 0;
  for (const m of messages) {
    const u = m.agentRun?.usage;
    if (!u) continue;
    inputTokens += u.inputTokens || 0;
    outputTokens += u.outputTokens || 0;
    rounds += u.rounds || 0;
    runs += 1;
  }
  return runs ? { inputTokens, outputTokens, rounds, runs } : undefined;
}

export function stopNotice(reason?: string): string | undefined {
  switch (reason) {
    case 'aborted':
      return 'Stopped.';
    case 'step_limit':
      return 'Reached the step limit for one run — press Continue to carry on.';
    case 'time_limit':
      return 'Reached the time limit for one run — press Continue to carry on.';
    case 'repeated_failures':
      return 'Stopped after the same step kept failing.';
    case 'no_progress':
      return 'Stopped: the same call kept returning the same answer.';
    default:
      return undefined;
  }
}

/**
 * One-line summaries of what the agent already did, sent along with each turn so
 * it remembers across messages without replaying whole tool transcripts.
 */
export function collectActivity(messages: Message[], max = 60): string[] {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.blocks) continue;
    for (const b of m.blocks) {
      if (b.type !== 'action') continue;
      const a = b.action;
      const r = a.result;
      if (a.status === 'denied') {
        lines.push(`run_command (denied by user): ${r?.command || a.args?.command || ''}`.trim());
        continue;
      }
      switch (a.tool) {
        case 'write_file':
          if (a.status === 'done') lines.push(`${r?.created === false ? 'rewrote' : 'created'} ${r?.path || a.args?.path} (+${r?.added ?? 0} −${r?.removed ?? 0})`);
          break;
        case 'edit_file':
        case 'multi_edit':
          if (a.status === 'done') {
            if (r?.changes && r.changes.length > 1) for (const f of r.changes) lines.push(`edited ${f.path} (+${f.added} −${f.removed})`);
            else lines.push(`edited ${r?.path || a.args?.path} (+${r?.added ?? 0} −${r?.removed ?? 0})`);
          }
          break;
        case 'append_file':
          if (a.status === 'done') lines.push(`appended to ${r?.path || a.args?.path} (+${r?.added ?? 0})`);
          break;
        case 'replace_in_files':
          if (a.status === 'done' && !r?.dryRun) lines.push(`replaced "${r?.pattern}" with "${r?.replacement}" in ${r?.fileCount ?? '?'} files`);
          break;
        case 'run_command':
          lines.push(`ran \`${(r?.command || a.args?.command || '').slice(0, 160)}\` → ${r?.kind === 'background' ? `background ${r?.id || ''}` : `exit ${r?.exitCode ?? '?'}`}`);
          break;
        case 'run_checks':
          lines.push(`checked the project (\`${(r?.command || 'project checks').slice(0, 120)}\`) → ${r?.passed === false ? `exit ${r?.exitCode ?? '?'}` : 'passed'}`);
          break;
        case 'repo_status':
          if (a.status === 'done') lines.push(`read the repository state${r?.branch ? ` (branch ${r.branch})` : ''}${typeof r?.dirty === 'number' && r.dirty ? `, ${r.dirty} uncommitted` : ''}`);
          break;
        case 'load_skill':
          if (a.status === 'done') lines.push(`loaded project skill ${r?.name || a.args?.name || ''}${r?.path ? ` from ${r.path}` : ''}`.trim());
          break;
        case 'repo_history':
          if (a.status === 'done') lines.push(`read ${r?.view || 'log'} history${a.args?.path ? ` of ${a.args.path}` : ''}`);
          break;
        case 'get_preview_url':
          if (a.status === 'done') lines.push(`preview: ${r?.url}`);
          break;
        default:
          break;
      }
    }
  }
  return lines.slice(-max);
}

/** Tool calls that the Worked trail folds into chronological Explore / Run groups. */
const WORK_EXPLORATION_TOOLS = new Set([
  'read_file', 'file_outline', 'find_symbol', 'relevant_files', 'code_map',
  'list_dir', 'file_search', 'grep_search',
]);
const WORK_COMMAND_TOOLS = new Set(['run_command', 'run_checks']);

export function isWorkSummaryAction(action: AgentAction): boolean {
  if (action.status === 'denied' || action.status === 'blocked' || (action.status === 'error' && !action.result)) return false;
  return WORK_EXPLORATION_TOOLS.has(action.tool) || WORK_COMMAND_TOOLS.has(action.tool);
}

/**
 * Summarize only facts returned by the real tool calls. Known paths are counted
 * once; search/index tools contribute their reported file counts. Commands stay
 * separate from edits, which remain visible inline in the activity trail.
 */
export function summarizeWorkActions(actions: AgentAction[]): string | undefined {
  const paths = new Set<string>();
  let reportedFiles = 0;
  let reportedFilesTruncated = false;
  let listedFolders = 0;
  let listedFoldersTruncated = false;
  let listedItems = 0;
  let listedItemsTruncated = false;
  const emptyFolderPaths = new Set<string>();
  let hasExploration = false;
  let commands = 0;

  for (const action of actions) {
    if (!isWorkSummaryAction(action)) continue;
    const result = action.result;
    if (!result) continue;

    if (WORK_COMMAND_TOOLS.has(action.tool)) {
      commands += 1;
      continue;
    }

    hasExploration = true;
    const path = result.path || action.args?.path;
    if ((action.tool === 'read_file' || action.tool === 'file_outline') && typeof path === 'string' && path.trim()) {
      paths.add(path);
    }

    if (action.tool === 'list_dir') {
      if (typeof result.fileCount === 'number') {
        reportedFiles = Math.max(reportedFiles, result.fileCount);
        reportedFilesTruncated ||= Boolean(result.truncated);
      } else if (typeof result.count === 'number') {
        listedItems = Math.max(listedItems, result.count);
        listedItemsTruncated ||= Boolean(result.truncated);
      }
      if (typeof result.directoryCount === 'number') {
        listedFolders = Math.max(listedFolders, result.directoryCount);
        listedFoldersTruncated ||= Boolean(result.truncated);
      }
      const directory = result.fullPath || result.path || action.args?.path;
      const listedCount = typeof result.count === 'number'
        ? result.count
        : typeof result.fileCount === 'number' && typeof result.directoryCount === 'number'
          ? result.fileCount + result.directoryCount
          : undefined;
      if (typeof directory === 'string' && directory.trim() && listedCount === 0) {
        emptyFolderPaths.add(directory);
      }
      continue;
    }

    const count = action.tool === 'grep_search' || action.tool === 'find_symbol'
      ? result.files
      : ['file_search', 'relevant_files', 'code_map'].includes(action.tool)
        ? result.count
        : undefined;
    if (typeof count === 'number' && Number.isFinite(count)) {
      reportedFiles = Math.max(reportedFiles, count);
      reportedFilesTruncated ||= Boolean(result.truncated);
    }
  }

  const fileCount = Math.max(paths.size, reportedFiles);
  const fileCountIsPartial = reportedFilesTruncated && fileCount > 0;
  const folderCountIsPartial = listedFoldersTruncated && listedFolders > 0;
  const itemCountIsPartial = listedItemsTruncated && listedItems > 0;
  const parts: string[] = [];
  if (fileCount > 0) {
    const count = fileCountIsPartial ? `${fileCount}+` : String(fileCount);
    parts.push(`Explored ${count} ${fileCount === 1 ? 'file' : 'files'}`);
  } else if (listedFolders > 0) {
    const count = folderCountIsPartial ? `${listedFolders}+` : String(listedFolders);
    parts.push(`Explored ${count} ${listedFolders === 1 ? 'folder' : 'folders'}`);
  } else if (listedItems > 0) {
    const count = itemCountIsPartial ? `${listedItems}+` : String(listedItems);
    parts.push(`Explored ${count} ${listedItems === 1 ? 'item' : 'items'}`);
  } else if (emptyFolderPaths.size > 0) {
    parts.push(emptyFolderPaths.size === 1 ? 'Explored an empty folder' : `Explored ${emptyFolderPaths.size} empty folders`);
  } else if (hasExploration) parts.push('Explored code');
  if (commands > 0) parts.push(`${parts.length ? 'ran' : 'Ran'} ${plural(commands, 'command')}`);
  return parts.length ? parts.join(', ') : undefined;
}
