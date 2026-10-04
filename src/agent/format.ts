import type { AgentAction, Message } from '../types';

/**
 * How an action reads in the chat — the plain sentence behind
 *
 *   Creating  📄 index.html  +77 −98
 *   Analyzed  📄 App.tsx  L1–L120
 *   Ran       npm install
 *
 * Kept free of React so the wording rules are testable.
 */

export interface ActionLabel {
  verb: string;
  target?: string;
  targetKind?: 'file' | 'dir' | 'command' | 'pattern' | 'url' | 'text';
  /** "L34–L52" */
  lines?: string;
  added?: number;
  removed?: number;
  /** Muted trailing text: "8 matches in 3 files", "exit 1", "2.3s" */
  meta?: string;
  /** Short badge-like strings (ports, process ids). */
  chips?: string[];
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
    !(a.tool === 'run_command' && r && typeof r.exitCode === 'number');
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
      // A listing of the workspace root has no path worth printing: "." on its own
      // is punctuation, not information. The row then reads "Listed 8 items".
      const listed = r?.path || args.path || '';
      const isRoot = listed === '' || listed === '.' || listed === './' || listed === '/';
      return base('Listing', 'Listed', {
        target: isRoot ? undefined : listed,
        targetKind: 'dir',
        meta: !live && r ? plural(r.count ?? 0, 'item') : undefined,
      });
    }

    case 'read_file': {
      const start = r?.startLine ?? args.startLine;
      const end = r?.endLine ?? args.endLine;
      return base('Analyzing', 'Analyzed', {
        target: r?.path || args.path,
        targetKind: 'file',
        lines: r?.ranges?.length ? formatRanges(r.ranges, 4) : start && end ? (start === end ? `L${start}` : `L${start}–L${end}`) : undefined,
        meta: !live && r?.truncated ? `of ${r.totalLines}` : undefined,
      });
    }

    case 'write_file': {
      return base('Creating', r?.created === false ? 'Rewrote' : 'Created', {
        target: r?.path || args.path,
        targetKind: 'file',
        /*
          The count comes from the finished write, never from the live buffer: a
          number that is still growing is an estimate, and an estimate that later
          changes is a number the reader watched lie to them.
        */
        added: r?.added,
        removed: (r?.removed ?? 0) > 0 ? r?.removed : undefined,
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
      const fileCount = r?.changes?.length ?? 0;
      const manyFiles = fileCount > 1;
      const liveEdits = typeof args.edits === 'number' && args.edits > 1 ? plural(args.edits, 'edit') : undefined;
      return base('Editing', 'Edited', {
        target: r?.path || args.path,
        targetKind: 'file',
        lines: live || manyFiles ? undefined : formatRanges(r?.ranges),
        added: r?.added,
        removed: r?.removed,
        meta: live
          ? liveEdits
          : manyFiles
            ? `${fileCount} files · ${plural(n ?? fileCount, 'edit')}`
            : n && n > 1
              ? plural(n, 'edit')
              : undefined,
        expandable: !live && Boolean(r?.hunks?.length || r?.changes?.some((f) => f.hunks?.length)),
      });
    }

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
          expandable: !live && Boolean(a.output),
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
        expandable: Boolean(a.output) || toolFailed,
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
        meta: !live && r?.count !== undefined ? plural(r.count, 'result') : undefined,
      });

    case 'fetch_url':
      return base('Reading', 'Read', { target: hostOf(r?.url || args.url), targetKind: 'url', meta: !live ? r?.title : undefined });

    case 'image_search':
      return base('Finding images of', 'Found images of', {
        target: r?.query || args.query,
        targetKind: 'text',
        meta: !live && r?.count !== undefined ? plural(r.count, 'image') : undefined,
        expandable: !live && Boolean(r?.images?.length),
      });

    case 'update_plan':
      return base('Updating plan', 'Updated plan', {
        meta: r?.total ? `${r.done ?? 0}/${r.total} done` : undefined,
        expandable: Boolean(r?.todos?.length),
      });

    default:
      return base('Running', 'Ran', { target: a.tool, targetKind: 'text' });
  }
}

/**
 * The single line under a finished turn: how long it took, how much it did, and
 * what it changed. Plain text, one tone — no badges, no coloured counters.
 */
export function workedSummary(run?: {
  durationMs?: number;
  toolCalls?: number;
  changed?: Array<{ path: string; added: number; removed: number }>;
}): string | undefined {
  if (!run) return undefined;
  // No work, no line: a turn that only talked is not a turn that worked. (Its own
  // stop notice, if it has one, is said separately.)
  if (!run.toolCalls && !(run.changed || []).length) return undefined;
  const bits: string[] = [];
  const time = formatDuration(run.durationMs);
  if (time) bits.push(`Worked for ${time}`);
  if (run.toolCalls) bits.push(`${run.toolCalls} action${run.toolCalls === 1 ? '' : 's'}`);
  const changed = run.changed || [];
  if (changed.length) {
    const added = changed.reduce((n, c) => n + c.added, 0);
    const removed = changed.reduce((n, c) => n + c.removed, 0);
    const files = `${changed.length} file${changed.length === 1 ? '' : 's'}`;
    const counts = [added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' ');
    bits.push(counts ? `${files} ${counts}` : files);
  }
  return bits.length ? bits.join(' · ') : undefined;
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

/**
 * Which family a tool belongs to, for the work trail.
 *
 * The trail is a summary, not a log: four reads in a row are one line — "4 files
 * analyzed" — and the four rows sit one click behind it. Grouping is by what the
 * tools did, so a mixed run of reads and searches still reads as two honest lines
 * instead of one vague one.
 */
const TRAIL_KINDS: Record<string, string> = {
  read_file: 'analyze',
  file_outline: 'analyze',
  list_dir: 'explore',
  file_search: 'explore',
  grep_search: 'explore',
  run_command: 'run',
  list_processes: 'process',
  read_process_output: 'process',
  stop_process: 'process',
  write_file: 'change',
  append_file: 'change',
  edit_file: 'change',
  multi_edit: 'change',
  replace_in_files: 'change',
  web_search: 'web',
  fetch_url: 'web',
  image_search: 'web',
  remember: 'memory',
  forget: 'memory',
  search_memory: 'memory',
  update_plan: 'plan',
  delegate_task: 'delegate',
};

export function trailKind(tool: string): string {
  return TRAIL_KINDS[tool] || 'other';
}

/** "4 files analyzed", "2 commands run", "1 place explored". */
export function trailGroupLabel(kind: string, count: number): string {
  const n = count;
  const s = n === 1 ? '' : 's';
  switch (kind) {
    case 'analyze':
      return `${n} file${s} analyzed`;
    case 'explore':
      return `${n} place${s} explored`;
    case 'run':
      return `${n} command${s} run`;
    case 'process':
      return `${n} process step${s}`;
    case 'change':
      return `${n} file${s} changed`;
    case 'web':
      return `${n} web lookup${s}`;
    case 'memory':
      return `${n} memory step${s}`;
    case 'plan':
      return `${n} plan update${s}`;
    case 'delegate':
      return `${n} subagent task${s}`;
    default:
      return `${n} step${s}`;
  }
}
