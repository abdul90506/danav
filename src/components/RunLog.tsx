import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Hammer,
  MessageSquare,
  RefreshCw,
  Repeat,
  Search,
  Shuffle,
  Trash2,
  Wrench,
} from 'lucide-react';
import {
  clearTraces,
  getMemory,
  getTraceAnalysis,
  getTraceRun,
  listTraceChats,
  listTraceRuns,
  type MemoryNote,
  type MemoryStep,
  type TraceChatSummary,
  type TraceEvent,
  type TraceFinding,
  type TraceRunSummary,
} from '../services/agentApi';

/**
 * Everything the agent did, readable, without running anything.
 *
 * A run used to leave a summary line: when it went wrong there was no way to
 * see which instructions it was given, which tools it was offered and which it
 * was not, what it was thinking, which model answered each round after the
 * fallback moved it, what every tool was called with, what came back, or where
 * the tokens went. The server records all of that per chat, on disk, as it
 * happens — a restart changes nothing and a crashed run still leaves its
 * evidence. This is the window onto it.
 *
 * Three things are shown together because they answer one question between
 * them: the memory the agent is given before it starts, the faults a reading
 * of every run turned up, and the runs themselves end to end.
 */

const fmtTime = (ms: number) => new Date(ms).toLocaleString();
const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString();
const fmtDur = (ms?: number | null) => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

const asText = (value: unknown, max = 200_000): string => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
};

const EVENT_STYLE: Record<string, { label: string; tone: string; Icon: typeof Hammer }> = {
  run_start: { label: 'Run started', tone: 'text-sky-600 dark:text-sky-400', Icon: RefreshCw },
  instructions: { label: 'Instructions given', tone: 'text-violet-600 dark:text-violet-400', Icon: FileText },
  request: { label: 'Sent to model', tone: 'text-zinc-500', Icon: Repeat },
  response: { label: 'Model answered', tone: 'text-emerald-600 dark:text-emerald-400', Icon: Brain },
  tool: { label: 'Tool', tone: 'text-amber-600 dark:text-amber-400', Icon: Hammer },
  routing: { label: 'Routing', tone: 'text-fuchsia-600 dark:text-fuchsia-400', Icon: Shuffle },
  note: { label: 'Note', tone: 'text-zinc-500', Icon: FileText },
  error: { label: 'Error', tone: 'text-red-600 dark:text-red-400', Icon: AlertTriangle },
  run_end: { label: 'Run finished', tone: 'text-sky-600 dark:text-sky-400', Icon: RefreshCw },
  trace_truncated: { label: 'Recording truncated', tone: 'text-red-500', Icon: AlertTriangle },
};

/** The one-line headline for an event, so the timeline reads without unfolding. */
function headline(event: TraceEvent): string {
  switch (event.type) {
    case 'run_start': {
      const meta = (event.meta || {}) as Record<string, unknown>;
      const request = String(meta?.request || '');
      return `${String(meta?.requestedModel || 'model')} · ${request.slice(0, 140).replace(/\s+/g, ' ') || 'no request text'}`;
    }
    case 'instructions': {
      const tools = (event.tools as string[] | undefined)?.length ?? 0;
      const hidden = (event.hiddenTools as string[] | undefined)?.length ?? 0;
      return `${Number(event.systemPromptChars ?? 0).toLocaleString()} chars of system prompt · ${tools} tools offered${hidden ? ` · ${hidden} withheld` : ''}`;
    }
    case 'request':
      return `round ${event.round} · ${event.messageCount} messages · ${Number(event.chars || 0).toLocaleString()} chars`;
    case 'response': {
      const calls = (event.toolCalls as Array<{ name: string }> | undefined) || [];
      const usage = (event.usage || {}) as Record<string, number>;
      const tokens = usage.inputTokens || usage.outputTokens ? ` · ${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out` : '';
      const thought = String(event.thinking || '') ? ' · thought' : '';
      return `${event.model || 'model'}${tokens}${thought}${calls.length ? ` · wants ${calls.map((c) => c.name).join(', ')}` : ' · answered'}`;
    }
    case 'tool': {
      const args = (event.args || {}) as Record<string, unknown>;
      const subject = String(args.path || args.command || args.pattern || args.query || args.name || '').slice(0, 70);
      return `${event.name}${subject ? ` ${subject}` : ''} · ${event.ok ? 'ok' : event.denied ? 'denied' : 'failed'} · ${fmtDur(event.durationMs as number)}`;
    }
    case 'routing':
      return event.kind === 'attempt'
        ? `attempt ${event.attempt} · ${event.model} · key ${(Number(event.credentialIndex) || 0) + 1}/${event.credentialCount}${event.thinking ? ` · thinking ${event.thinking}` : ''}`
        : `${event.reason || 'retry'}${event.model ? ` → ${event.model}` : ''}`;
    case 'note':
      return event.kind === 'memory_given'
        ? `memory handed to the model · ${String(event.projectMemory || '').length} chars of project memory`
        : event.kind === 'task_memory'
          ? `task summary updated · ${String(event.text || '').length} chars`
          : String(event.kind || 'note');
    case 'error':
      return String(event.message || 'error');
    case 'run_end':
      return `${event.stopReason} · ${event.toolCalls} tool calls · ${fmtDur(event.durationMs as number)}`;
    default:
      return event.type;
  }
}

/** The body of an event, shown when it is unfolded — nothing summarised away. */
function details(event: TraceEvent): string {
  switch (event.type) {
    case 'run_start': {
      const meta = (event.meta || {}) as Record<string, unknown>;
      return [
        '--- the request, in full ---',
        String(meta.request || '(none)'),
        '',
        '--- run metadata ---',
        asText({ ...meta, request: undefined }),
      ].join('\n');
    }
    case 'instructions': {
      const defs = (event.toolDefinitions as Array<{ name: string; description: string; parameters: unknown }> | undefined) || [];
      const history = (event.history as Array<{ role: string; content: string }> | undefined) || [];
      return [
        `model: ${event.model} · thinking: ${event.thinkingLevel}`,
        `limits: ${asText(event.limits)}`,
        '',
        '--- system prompt, exactly as sent ---',
        String(event.systemPrompt || ''),
        '',
        `--- ${defs.length} tools offered, with the wording the model reads ---`,
        ...defs.map((d) => `• ${d.name}\n    ${String(d.description || '').replace(/\n/g, '\n    ')}\n    parameters: ${asText(d.parameters, 4000)}`),
        '',
        `--- withheld (callable, not advertised): ${((event.hiddenTools as string[]) || []).join(', ') || 'none'} ---`,
        '',
        `--- conversation inherited (${history.length} turns) ---`,
        ...history.map((m) => `[${m.role}] ${m.content}`),
      ].join('\n');
    }
    case 'request': {
      const added = (event.added as Array<{ role: string; content: unknown }> | undefined) || [];
      return [
        `round ${event.round} · model ${event.model} · ${event.messageCount} messages · ${event.chars} chars in the window`,
        '',
        `--- added to the transcript this round (${added.length}) ---`,
        ...added.map((m) => `[${m.role}]\n${asText(m.content)}`),
      ].join('\n');
    }
    case 'response':
      return [
        event.thinking ? `--- thinking (never shown in the chat) ---\n${event.thinking}\n` : '',
        event.text ? `--- text ---\n${event.text}` : '(no text)',
        (event.toolCalls as unknown[])?.length ? `\n--- tool calls ---\n${asText(event.toolCalls)}` : '',
        event.usage ? `\n--- usage ---\n${asText(event.usage)}` : '',
        event.finishReason ? `\n--- finish reason: ${event.finishReason} ---` : '',
      ].filter(Boolean).join('\n');
    case 'tool':
      return [
        `--- arguments ---\n${asText(event.args)}`,
        event.error ? `\n--- error ---\n${event.error}` : '',
        `\n--- result ---\n${String(event.output || '')}`,
      ].join('\n');
    case 'note':
      if (event.kind === 'memory_given') {
        return [
          '--- project memory given to the model ---',
          String(event.projectMemory || '(none)'),
          '',
          '--- workspace notes ---',
          String(event.workspaceNotes || '(none)'),
          '',
          '--- skills ---',
          String(event.skills || '(none)'),
        ].join('\n');
      }
      if (event.kind === 'task_memory') return String(event.text || '(empty)');
      return asText(event);
    default:
      return asText(event);
  }
}

function EventRow({ event, query }: { event: TraceEvent; query: string }) {
  const [open, setOpen] = useState(false);
  const style = EVENT_STYLE[event.type] || EVENT_STYLE.note;
  const { Icon } = style;
  const failed = event.type === 'error' || (event.type === 'tool' && event.ok === false && !event.denied);
  // A search is only useful if the hit opens itself; otherwise the match is
  // buried in a fold the reader has to guess at.
  useEffect(() => { if (query) setOpen(true); }, [query]);
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
        <pre className="max-h-[32rem] overflow-auto border-t border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] leading-[1.45] text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300 whitespace-pre-wrap break-words">
          {details(event)}
        </pre>
      )}
    </div>
  );
}

/** A long block of recorded prose, folded until asked for. */
function Foldable({ title, text, tone = 'violet' }: { title: string; text: string; tone?: 'violet' | 'zinc' }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
      >
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className={`text-[12px] font-medium ${tone === 'violet' ? 'text-violet-600 dark:text-violet-300' : 'text-zinc-700 dark:text-zinc-300'}`}>
          {title}
        </span>
        <span className="ml-auto text-[11px] text-zinc-400">{text.length.toLocaleString()} chars</span>
      </button>
      {open && (
        <pre className="max-h-96 overflow-auto border-t border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] leading-[1.5] text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300 whitespace-pre-wrap break-words">
          {text}
        </pre>
      )}
    </div>
  );
}

export interface RunLogProps {
  /** The chat whose runs open first; traces are filed per conversation. */
  chatId: string | null;
  /** The workspace whose project memory is shown alongside them. */
  workspaceId: string | null;
}

export default function RunLog({ chatId, workspaceId }: RunLogProps) {
  const [chats, setChats] = useState<TraceChatSummary[]>([]);
  const [activeChat, setActiveChat] = useState<string | null>(chatId);
  const [runs, setRuns] = useState<TraceRunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [following, setFollowing] = useState(false);
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [memoryBlock, setMemoryBlock] = useState('');
  const [projectBlock, setProjectBlock] = useState('');
  const [steps, setSteps] = useState<MemoryStep[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'tool' | 'model' | 'routing' | 'problem'>('all');
  const [query, setQuery] = useState('');
  const [findings, setFindings] = useState<TraceFinding[]>([]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  /** The highest sequence number already held, so a poll asks only for the tail. */
  const seenSeq = useRef(-1);

  useEffect(() => { setActiveChat(chatId); }, [chatId]);

  useEffect(() => {
    let cancelled = false;
    listTraceChats()
      .then((r) => { if (!cancelled) setChats(r.chats || []); })
      .catch(() => { if (!cancelled) setChats([]); });
    return () => { cancelled = true; };
  }, [chatId]);

  const refresh = useCallback(async () => {
    if (!activeChat) { setRuns([]); setFindings([]); return; }
    setLoading(true);
    setError('');
    try {
      const r = await listTraceRuns(activeChat);
      setRuns(r.runs || []);
      // The faults come from the same traces; failing to read them must not
      // hide the runs themselves.
      const a = await getTraceAnalysis(activeChat).catch(() => null);
      setFindings(a?.findings || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the run log');
    } finally {
      setLoading(false);
    }
  }, [activeChat]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!workspaceId) { setNotes([]); setMemoryBlock(''); setSteps([]); return; }
    let cancelled = false;
    getMemory(workspaceId, activeChat || undefined)
      .then((r) => {
        if (cancelled) return;
        setNotes(r.notes || []);
        setMemoryBlock(r.block || '');
        setProjectBlock(r.projectBlock || '');
        setSteps(r.steps || []);
      })
      .catch(() => { if (!cancelled) { setNotes([]); setMemoryBlock(''); setProjectBlock(''); setSteps([]); } });
    return () => { cancelled = true; };
  }, [workspaceId, activeChat, runs.length]);

  const openRun = useCallback(async (runId: string) => {
    if (!activeChat) return;
    if (selected === runId) { setSelected(null); setEvents([]); setFollowing(false); return; }
    setSelected(runId);
    setEvents([]);
    seenSeq.current = -1;
    try {
      const r = await getTraceRun(activeChat, runId);
      setEvents(r.events || []);
      seenSeq.current = (r.events || []).reduce((max, e) => Math.max(max, e.seq), -1);
      setFollowing(Boolean(r.live));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that run');
    }
  }, [activeChat, selected]);

  /**
   * Follow a run that is still going: ask only for events past the last one
   * held, every second and a half, and stop the moment run_end lands.
   */
  useEffect(() => {
    if (!following || !activeChat || !selected) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const r = await getTraceRun(activeChat, selected, seenSeq.current);
        if (cancelled) return;
        const fresh = r.events || [];
        if (fresh.length) {
          seenSeq.current = fresh.reduce((max, e) => Math.max(max, e.seq), seenSeq.current);
          setEvents((prev) => [...prev, ...fresh]);
        }
        if (!r.live) { setFollowing(false); void refresh(); }
      } catch {
        /* a poll that fails is retried on the next tick */
      }
    }, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [following, activeChat, selected, refresh]);

  const shown = useMemo(() => {
    let list = events;
    if (filter === 'tool') list = list.filter((e) => e.type === 'tool');
    else if (filter === 'model') list = list.filter((e) => e.type === 'request' || e.type === 'response' || e.type === 'instructions');
    else if (filter === 'routing') list = list.filter((e) => e.type === 'routing');
    else if (filter === 'problem') list = list.filter((e) => e.type === 'error' || (e.type === 'tool' && e.ok === false));
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    // Searched across the whole recorded event, not its headline: the reason a
    // run is being read is usually a string that only appears in a tool body.
    return list.filter((e) => JSON.stringify(e).toLowerCase().includes(needle));
  }, [events, filter, query]);

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
    const t = { runs: runs.length, toolCalls: 0, failures: 0, switches: 0, input: 0, output: 0, bytes: 0 };
    for (const r of runs) {
      t.toolCalls += r.toolCalls || 0;
      t.failures += r.failures || 0;
      t.switches += r.switched || 0;
      t.input += r.usage?.inputTokens || 0;
      t.output += r.usage?.outputTokens || 0;
      t.bytes += r.bytes || 0;
    }
    return t;
  }, [runs]);

  return (
    <div className="space-y-5">
      {/* ---- which chat ------------------------------------------------------ */}
      {chats.length > 0 && (
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-800 dark:text-zinc-200">
            <MessageSquare className="h-3.5 w-3.5 text-sky-500" /> Recorded chats
            <span className="font-normal text-zinc-400">— each one kept separately, on disk</span>
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {chats.slice(0, 12).map((chat) => (
              <button
                key={chat.chatId}
                type="button"
                onClick={() => { setActiveChat(chat.chatId); setSelected(null); setEvents([]); }}
                title={`${chat.chatId} · ${fmtTime(chat.updatedAt)} · ${fmtBytes(chat.bytes)}`}
                className={`max-w-[18rem] truncate rounded-md border px-2 py-1 text-left text-[11.5px] ${
                  activeChat === chat.chatId
                    ? 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
                    : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/40'
                }`}
              >
                {chat.label || chat.chatId}
                <span className="ml-1.5 text-[10px] text-zinc-400">{chat.runs}</span>
                {chat.chatId === chatId && <span className="ml-1 text-[10px] text-emerald-500">· open</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ---- project memory -------------------------------------------------- */}
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-800 dark:text-zinc-200">
          <Brain className="h-3.5 w-3.5 text-violet-500" /> Project memory
          <span className="font-normal text-zinc-400">— the text the agent is given about this project</span>
        </h3>
        <div className="space-y-1.5">
          <Foldable title="What this chat is told when it continues — word for word" text={memoryBlock} />
          <Foldable title="What a new chat in this workspace is told — word for word" text={projectBlock} tone="zinc" />
          {!memoryBlock && !projectBlock && (
            <p className="text-[12px] text-zinc-500">
              No project summary yet. It is written from finished runs — once the agent has done work here, the exact
              text it will be told appears above.
            </p>
          )}

          {steps.slice(0, 8).map((step) => (
            <div key={`${step.runId}-${step.id}`} className="rounded-lg border border-zinc-200 px-2.5 py-1.5 dark:border-zinc-800">
              <div className="flex items-baseline gap-2">
                <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-600 dark:bg-violet-950/40 dark:text-violet-300">
                  step · {step.source}
                </span>
                <span className="text-[12px] text-zinc-700 dark:text-zinc-300">{step.summary}</span>
                <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{fmtClock(step.at)}</span>
              </div>
              {step.steps?.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {step.steps.map((line, i) => (
                    <li key={i} className="text-[11.5px] text-zinc-600 dark:text-zinc-400">· {line}</li>
                  ))}
                </ul>
              )}
              {step.next && <p className="mt-1 text-[11.5px] text-sky-600 dark:text-sky-400">next: {step.next}</p>}
              {step.errors?.length > 0 && (
                <p className="mt-1 text-[11.5px] text-red-600 dark:text-red-400">avoid: {step.errors.join(' · ')}</p>
              )}
              {step.files?.length > 0 && (
                <p className="mt-1 flex flex-wrap gap-1 text-[11px]">
                  {step.files.map((file) => (
                    <span
                      key={file.path}
                      className={file.missing
                        ? 'rounded bg-red-50 px-1 text-red-500 line-through dark:bg-red-950/40 dark:text-red-400'
                        : 'rounded bg-zinc-100 px-1 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}
                      title={file.missing ? 'This file no longer exists — the memory is stale about it' : undefined}
                    >
                      {file.path}
                    </span>
                  ))}
                </p>
              )}
            </div>
          ))}

          {notes.slice(0, 6).map((note) => (
            <div key={note.id} className="rounded-lg border border-dashed border-zinc-200 px-2.5 py-1.5 dark:border-zinc-800">
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                {note.category || 'note'}
              </span>
              <span className="ml-2 text-[12px] text-zinc-700 dark:text-zinc-300">{note.text}</span>
            </div>
          ))}
        </div>
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
            <Wrench className="h-3.5 w-3.5 text-amber-500" /> Run log
            <span className="font-normal text-zinc-400">— every instruction, tool and answer, as it happened</span>
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
                  if (!activeChat) return;
                  await clearTraces(activeChat).catch(() => null);
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
            No agent runs recorded for this chat yet. Every run writes its full trace here — instructions, tools,
            thinking, model switches, errors — as it happens, and it survives a restart.
          </p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap gap-3 rounded-lg bg-zinc-50 px-3 py-2 text-[11.5px] text-zinc-600 dark:bg-zinc-900/60 dark:text-zinc-400">
              <span><strong className="text-zinc-800 dark:text-zinc-200">{totals.runs}</strong> runs</span>
              <span><strong className="text-zinc-800 dark:text-zinc-200">{totals.toolCalls}</strong> tool calls</span>
              <span><strong className={totals.failures ? 'text-red-600 dark:text-red-400' : 'text-zinc-800 dark:text-zinc-200'}>{totals.failures}</strong> failures</span>
              <span><strong className="text-zinc-800 dark:text-zinc-200">{totals.switches}</strong> model switches</span>
              <span><strong className="text-zinc-800 dark:text-zinc-200">{totals.input.toLocaleString()}</strong> in / <strong className="text-zinc-800 dark:text-zinc-200">{totals.output.toLocaleString()}</strong> out tokens</span>
              <span><strong className="text-zinc-800 dark:text-zinc-200">{fmtBytes(totals.bytes)}</strong> recorded</span>
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
                        : run.stopReason === 'running'
                          ? 'bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-300'
                          : run.stopReason === 'error'
                            ? 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300'
                            : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                    }`}>
                      {run.stopReason}
                    </span>
                  </button>

                  {selected === run.runId && (
                    <div className="border-t border-zinc-200 p-2.5 dark:border-zinc-800">
                      <div className="mb-2 flex flex-wrap items-center gap-1">
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
                        <span className="relative ml-1">
                          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-400" />
                          <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="find anything in this run"
                            className="w-48 rounded-md border border-zinc-200 bg-transparent py-0.5 pl-6 pr-2 text-[11px] text-zinc-700 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-300 dark:border-zinc-700 dark:text-zinc-200 dark:focus:ring-zinc-600"
                          />
                        </span>
                        {following && (
                          <span className="flex items-center gap-1 text-[11px] text-sky-500">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" /> live
                          </span>
                        )}
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
                        ) : shown.length === 0 ? (
                          <p className="px-1 py-2 text-[12px] text-zinc-500">Nothing in this run matches.</p>
                        ) : (
                          shown.map((event) => <EventRow key={event.seq} event={event} query={query} />)
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
