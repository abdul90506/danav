import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Hammer,
  RefreshCw,
  Repeat,
  Shuffle,
  Trash2,
} from 'lucide-react';
import {
  clearTraces,
  getMemory,
  getTraceAnalysis,
  getTraceRun,
  listTraceRuns,
  type MemoryNote,
  type MemoryRun,
  type TraceEvent,
  type TraceFinding,
  type TraceRunSummary,
} from '../services/agentApi';

/**
 * What the agent actually did, readable.
 *
 * A run used to leave a summary line and nothing else: when it went wrong
 * there was no way to see which instructions it had, which model answered each
 * round after the fallback moved it, what every tool was called with, or where
 * the tokens went. The server records all of that per chat now; this is the
 * window onto it — plus the project memory the run carries between sessions,
 * which was equally invisible.
 */

const fmtTime = (ms: number) => new Date(ms).toLocaleString();
const fmtDur = (ms?: number | null) => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const asText = (value: unknown, max = 4000): string => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
};

const EVENT_STYLE: Record<string, { label: string; tone: string; Icon: typeof Hammer }> = {
  run_start: { label: 'Run started', tone: 'text-sky-600 dark:text-sky-400', Icon: RefreshCw },
  instructions: { label: 'Instructions given', tone: 'text-violet-600 dark:text-violet-400', Icon: FileText },
  request: { label: 'Request to model', tone: 'text-zinc-500', Icon: Repeat },
  response: { label: 'Model answered', tone: 'text-emerald-600 dark:text-emerald-400', Icon: Brain },
  tool: { label: 'Tool', tone: 'text-amber-600 dark:text-amber-400', Icon: Hammer },
  routing: { label: 'Routing', tone: 'text-fuchsia-600 dark:text-fuchsia-400', Icon: Shuffle },
  note: { label: 'Note', tone: 'text-zinc-500', Icon: FileText },
  error: { label: 'Error', tone: 'text-red-600 dark:text-red-400', Icon: AlertTriangle },
  run_end: { label: 'Run finished', tone: 'text-sky-600 dark:text-sky-400', Icon: RefreshCw },
};

/** The one-line headline for an event, so the timeline reads without unfolding. */
function headline(event: TraceEvent): string {
  switch (event.type) {
    case 'run_start': {
      const meta = (event.meta || {}) as Record<string, any>;
      return `${meta?.requestedModel || 'model'} · ${String(meta?.request || '').slice(0, 120) || 'no request text'}`;
    }
    case 'instructions':
      return `${event.systemPromptChars ?? 0} chars of system prompt · ${(event.tools as string[] | undefined)?.length ?? 0} tools offered`;
    case 'request':
      return `round ${event.round} · ${event.messageCount} messages · ${event.chars} chars`;
    case 'response': {
      const calls = (event.toolCalls as Array<{ name: string }> | undefined) || [];
      const usage = (event.usage || {}) as Record<string, number>;
      const tokens = usage.inputTokens || usage.outputTokens ? ` · ${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out` : '';
      return `${event.model || 'model'}${tokens}${calls.length ? ` · wants ${calls.map((c) => c.name).join(', ')}` : ' · answered'}`;
    }
    case 'tool':
      return `${event.name} · ${event.ok ? 'ok' : event.denied ? 'denied' : 'failed'} · ${fmtDur(event.durationMs as number)}`;
    case 'routing':
      return event.kind === 'attempt'
        ? `attempt ${event.attempt} · ${event.model} · key ${(Number(event.credentialIndex) || 0) + 1}/${event.credentialCount}`
        : `${event.reason || 'retry'}`;
    case 'error':
      return String(event.message || 'error');
    case 'run_end':
      return `${event.stopReason} · ${event.toolCalls} tool calls · ${fmtDur(event.durationMs as number)}`;
    default:
      return event.type;
  }
}

/** The body of an event, shown when it is unfolded. */
function details(event: TraceEvent): string {
  switch (event.type) {
    case 'instructions':
      return [
        `model: ${event.model}`,
        `limits: ${asText(event.limits)}`,
        `tools: ${(event.tools as string[] | undefined)?.join(', ')}`,
        '',
        '--- system prompt, exactly as sent ---',
        String(event.systemPrompt || ''),
      ].join('\n');
    case 'request':
      return asText(event.added, 20000);
    case 'response':
      return [
        event.text ? `--- text ---\n${event.text}` : '(no text)',
        (event.toolCalls as unknown[])?.length ? `\n--- tool calls ---\n${asText(event.toolCalls, 8000)}` : '',
        event.usage ? `\n--- usage ---\n${asText(event.usage)}` : '',
      ].filter(Boolean).join('\n');
    case 'tool':
      return [
        `--- arguments ---\n${asText(event.args, 6000)}`,
        event.error ? `\n--- error ---\n${event.error}` : '',
        `\n--- result ---\n${String(event.output || '')}`,
      ].join('\n');
    default:
      return asText(event, 12000);
  }
}

function EventRow({ event }: { event: TraceEvent }) {
  const [open, setOpen] = useState(false);
  const style = EVENT_STYLE[event.type] || EVENT_STYLE.note;
  const { Icon } = style;
  const failed = event.type === 'error' || (event.type === 'tool' && event.ok === false && !event.denied);
  return (
    <div className={`rounded-lg border ${failed ? 'border-red-200 dark:border-red-900/50' : 'border-zinc-200 dark:border-zinc-800'}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
      >
        <ChevronRight className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${failed ? 'text-red-500' : style.tone}`} />
        <span className="min-w-0 flex-1">
          <span className={`text-[11px] font-semibold uppercase tracking-wide ${failed ? 'text-red-500' : style.tone}`}>
            {style.label}
          </span>
          <span className="ml-2 text-[12px] text-zinc-700 dark:text-zinc-300 break-words">{headline(event)}</span>
        </span>
        <span className="shrink-0 pt-0.5 font-mono text-[10px] text-zinc-400">+{fmtDur(event.ms)}</span>
      </button>
      {open && (
        <pre className="max-h-96 overflow-auto border-t border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] leading-[1.45] text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300 whitespace-pre-wrap break-words">
          {details(event)}
        </pre>
      )}
    </div>
  );
}

export interface RunLogProps {
  /** The chat whose runs are shown; traces are filed per conversation. */
  chatId: string | null;
  /** The workspace whose project memory is shown alongside them. */
  workspaceId: string | null;
}

export default function RunLog({ chatId, workspaceId }: RunLogProps) {
  const [runs, setRuns] = useState<TraceRunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [memoryRuns, setMemoryRuns] = useState<MemoryRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'tool' | 'model' | 'routing' | 'problem'>('all');
  const [findings, setFindings] = useState<TraceFinding[]>([]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!chatId) { setRuns([]); return; }
    setLoading(true);
    setError('');
    try {
      const r = await listTraceRuns(chatId);
      setRuns(r.runs || []);
      // The faults are computed from the same traces; a failure to read them
      // must not hide the runs themselves.
      const a = await getTraceAnalysis(chatId).catch(() => null);
      setFindings(a?.findings || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the run log');
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!workspaceId) { setNotes([]); setMemoryRuns([]); return; }
    let cancelled = false;
    getMemory(workspaceId)
      .then((r) => { if (!cancelled) { setNotes(r.notes || []); setMemoryRuns(r.runs || []); } })
      .catch(() => { if (!cancelled) { setNotes([]); setMemoryRuns([]); } });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const openRun = useCallback(async (runId: string) => {
    if (!chatId) return;
    if (selected === runId) { setSelected(null); setEvents([]); return; }
    setSelected(runId);
    setEvents([]);
    try {
      const r = await getTraceRun(chatId, runId);
      setEvents(r.events || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that run');
    }
  }, [chatId, selected]);

  const shown = useMemo(() => {
    if (filter === 'all') return events;
    if (filter === 'tool') return events.filter((e) => e.type === 'tool');
    if (filter === 'model') return events.filter((e) => e.type === 'request' || e.type === 'response' || e.type === 'instructions');
    if (filter === 'routing') return events.filter((e) => e.type === 'routing');
    return events.filter((e) => e.type === 'error' || (e.type === 'tool' && e.ok === false));
  }, [events, filter]);

  /** The open run as one plain-text document: every event, top to bottom. */
  const asPlainText = useCallback(() => {
    const lines = [`# Run ${selected}`, ''];
    for (const event of events) {
      lines.push(`## +${fmtDur(event.ms)}  ${(EVENT_STYLE[event.type] || EVENT_STYLE.note).label}  —  ${headline(event)}`);
      const body = details(event).trim();
      if (body) lines.push(body, '');
    }
    return lines.join('\n');
  }, [events, selected]);

  const copyRun = useCallback(async () => {
    const text = asPlainText();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // A sandboxed frame refuses the clipboard. Say so instead of pretending.
      setError('Copying is blocked in this frame — select the text in an expanded event and press Ctrl+C.');
    }
  }, [asPlainText]);

  const totals = useMemo(() => {
    const t = { runs: runs.length, toolCalls: 0, failures: 0, switches: 0, input: 0, output: 0 };
    for (const r of runs) {
      t.toolCalls += r.toolCalls || 0;
      t.failures += r.failures || 0;
      t.switches += r.switched || 0;
      t.input += r.usage?.inputTokens || 0;
      t.output += r.usage?.outputTokens || 0;
    }
    return t;
  }, [runs]);

  return (
    <div className="space-y-5">
      {/* ---- project memory -------------------------------------------------- */}
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-800 dark:text-zinc-200">
          <Brain className="h-3.5 w-3.5 text-violet-500" /> Project memory
          <span className="font-normal text-zinc-400">— what the agent carries between runs</span>
        </h3>
        {notes.length === 0 && memoryRuns.length === 0 ? (
          <p className="text-[12px] text-zinc-500">
            Nothing remembered for this workspace yet. The agent writes a note when it learns something that should outlive one run.
          </p>
        ) : (
          <div className="space-y-1.5">
            {notes.slice(0, 8).map((note) => (
              <div key={note.id} className="rounded-lg border border-zinc-200 px-2.5 py-1.5 dark:border-zinc-800">
                <div className="flex items-baseline gap-2">
                  <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-600 dark:bg-violet-950/40 dark:text-violet-300">
                    {note.category || 'note'}
                  </span>
                  <span className="text-[12px] text-zinc-700 dark:text-zinc-300">{note.text}</span>
                </div>
              </div>
            ))}
            {memoryRuns.slice(0, 4).map((run) => (
              <div key={run.id} className="rounded-lg border border-dashed border-zinc-200 px-2.5 py-1.5 text-[11.5px] text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                {fmtTime(run.at)} · {run.stopReason} · {run.changed.length} file{run.changed.length === 1 ? '' : 's'} changed
                {run.failures ? ` · ${run.failures} failure${run.failures === 1 ? '' : 's'}` : ''}
                {run.changed.length ? ` — ${run.changed.slice(0, 3).map((c) => c.path).join(', ')}` : ''}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---- what went wrong ------------------------------------------------- */}
      {findings.length > 0 && (
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-800 dark:text-zinc-200">
            <AlertTriangle className="h-3.5 w-3.5 text-red-500" /> What went wrong
            <span className="font-normal text-zinc-400">— found by reading every run of this chat</span>
          </h3>
          <div className="space-y-1.5">
            {findings.slice(0, 12).map((finding) => (
              <div
                key={finding.id}
                className={`rounded-lg border px-2.5 py-1.5 ${
                  finding.severity === 'high'
                    ? 'border-red-200 bg-red-50/40 dark:border-red-900/50 dark:bg-red-950/20'
                    : finding.severity === 'medium'
                      ? 'border-amber-200 bg-amber-50/40 dark:border-amber-900/50 dark:bg-amber-950/20'
                      : 'border-zinc-200 dark:border-zinc-800'
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    finding.severity === 'high'
                      ? 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300'
                      : finding.severity === 'medium'
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                        : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                  }`}>
                    {finding.severity}
                  </span>
                  <span className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">{finding.title}</span>
                  {(finding.runs?.length || 0) > 1 && (
                    <span className="text-[11px] text-zinc-500">in {finding.runs?.length} runs</span>
                  )}
                </div>
                {finding.detail && (
                  <p className="mt-0.5 break-words font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{finding.detail}</p>
                )}
                <p className="mt-0.5 text-[11px] text-zinc-500">{finding.hint}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- the runs -------------------------------------------------------- */}
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-zinc-800 dark:text-zinc-200">
            <Hammer className="h-3.5 w-3.5 text-amber-500" /> Run log
            <span className="font-normal text-zinc-400">— this chat only, kept on disk across restarts</span>
          </h3>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
            {runs.length > 0 && (
              <button
                type="button"
                onClick={async () => {
                  if (!chatId) return;
                  await clearTraces(chatId).catch(() => null);
                  setSelected(null);
                  setEvents([]);
                  void refresh();
                }}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
              >
                <Trash2 className="h-3 w-3" /> Clear
              </button>
            )}
          </div>
        </div>

        {error && <p className="mb-2 text-[12px] text-red-600 dark:text-red-400">{error}</p>}

        {runs.length === 0 ? (
          <p className="text-[12px] text-zinc-500">
            No agent runs recorded for this chat yet. Every run writes its full trace here — instructions, tools, model
            switches, errors — as it happens.
          </p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap gap-3 rounded-lg bg-zinc-50 px-3 py-2 text-[11.5px] text-zinc-600 dark:bg-zinc-900/60 dark:text-zinc-400">
              <span><strong className="text-zinc-800 dark:text-zinc-200">{totals.runs}</strong> runs</span>
              <span><strong className="text-zinc-800 dark:text-zinc-200">{totals.toolCalls}</strong> tool calls</span>
              <span><strong className={totals.failures ? 'text-red-600 dark:text-red-400' : 'text-zinc-800 dark:text-zinc-200'}>{totals.failures}</strong> failures</span>
              <span><strong className="text-zinc-800 dark:text-zinc-200">{totals.switches}</strong> model switches</span>
              <span><strong className="text-zinc-800 dark:text-zinc-200">{totals.input.toLocaleString()}</strong> in / <strong className="text-zinc-800 dark:text-zinc-200">{totals.output.toLocaleString()}</strong> out tokens</span>
            </div>

            <div className="space-y-1.5">
              {runs.map((run) => (
                <div key={run.runId} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <button
                    type="button"
                    onClick={() => void openRun(run.runId)}
                    className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                  >
                    <ChevronRight className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${selected === run.runId ? 'rotate-90' : ''}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-zinc-800 dark:text-zinc-200">
                        {run.request || '(no request text)'}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-zinc-500">
                        {fmtTime(run.startedAt)} · {fmtDur(run.durationMs)} · {run.rounds} rounds · {run.toolCalls} tools
                        {run.failures ? <span className="text-red-500"> · {run.failures} failed</span> : null}
                        {run.switched ? <span className="text-fuchsia-500"> · {run.switched} model switch{run.switched === 1 ? '' : 'es'}</span> : null}
                        {' · '}{run.modelsUsed.join(' → ') || run.model}
                        {' · '}{fmtBytes(run.bytes)}
                      </span>
                    </span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      run.stopReason === 'completed'
                        ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : run.stopReason === 'incomplete' || run.stopReason === 'error'
                          ? 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300'
                          : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                    }`}>
                      {run.stopReason}
                    </span>
                  </button>

                  {selected === run.runId && (
                    <div className="border-t border-zinc-200 p-2.5 dark:border-zinc-800">
                      <div className="mb-2 flex flex-wrap gap-1">
                        {(['all', 'model', 'tool', 'routing', 'problem'] as const).map((key) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setFilter(key)}
                            className={`rounded-md px-2 py-0.5 text-[11px] ${
                              filter === key
                                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                                : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                            }`}
                          >
                            {key === 'problem' ? 'errors only' : key}
                          </button>
                        ))}
                        <span className="ml-auto self-center text-[11px] text-zinc-400">
                          {shown.length} of {events.length} events
                        </span>
                        <button
                          type="button"
                          onClick={() => void copyRun()}
                          disabled={events.length === 0}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          title="Copy this whole run as plain text"
                        >
                          {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                          {copied ? 'Copied' : 'Copy all'}
                        </button>
                      </div>
                      <div className="space-y-1">
                        {events.length === 0 ? (
                          <p className="px-1 py-2 text-[12px] text-zinc-500">Reading the trace…</p>
                        ) : (
                          shown.map((event) => <EventRow key={event.seq} event={event} />)
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
