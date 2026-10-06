import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight, Circle, CircleCheck, CircleDot, ExternalLink, Folder, Loader2, PanelRight } from 'lucide-react';
import type { AgentAction, AgentDiffHunk } from '../types';
import { actionLabel, formatRanges, isWorking } from '../agent/format';
import { FileTypeIcon } from './FileTypeIcon';
import { createPanelStore, usePanelOpen } from './panels';
import { useDismissOnOutside } from '../utils/useDismissOnOutside';
import { useCountUp } from '../utils/useCountUp';
import { SearchSourceStack } from './SearchSourceStack';

/**
 * One thing the agent did, as a plain line of text — no card, no status box:
 *
 *   Edited  📄 prompt.js  +1 -1
 *   Analyzed  📄 App.tsx  #L1-120
 *   Ran  npm install                         (click to see the command output)
 */

/**
 * The +added / -removed pair, counted up from zero rather than printed.
 *
 * Both hooks run unconditionally so this stays a legal hook site inside a list;
 * whether a number is *shown* is decided afterwards.
 */
function DiffCount({
  added,
  removed,
  className = '',
  showZero = false,
  animate = true,
}: {
  added?: number;
  removed?: number;
  className?: string;
  showZero?: boolean;
  /** Climb from zero. False for a row that was already finished when it mounted. */
  animate?: boolean;
}) {
  const liveAdded = useCountUp(added, animate);
  const liveRemoved = useCountUp(removed, animate);
  return (
    <>
      {added !== undefined && (showZero || added > 0) && (
        <span className={`font-mono tabular-nums text-emerald-600 dark:text-emerald-400 ${className}`}>
          +{liveAdded ?? 0}
        </span>
      )}
      {removed !== undefined && removed > 0 && (
        <span className={`font-mono tabular-nums text-rose-500 dark:text-rose-400 ${className}`}>
          -{liveRemoved ?? 0}
        </span>
      )}
    </>
  );
}

/** Long paths keep their tail: "…/components/AgentActionRow.tsx". */
const shortPath = (p: string, max = 56) => (p.length <= max ? p : `…${p.slice(p.length - (max - 1))}`);

const lastLines = (text = '', n = 3) =>
  text
    .replace(/\s+$/, '')
    .split('\n')
    .slice(-n);

const safeHttpUrl = (value?: string): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
};

interface RowProps {
  action: AgentAction;
  onApproval?: (action: AgentAction, allow: boolean, always: boolean) => void | Promise<void>;
  /** Show this URL in the docked preview panel instead of a new tab. */
  onOpenPreview?: (url: string, title?: string) => void;
}

const Diff: React.FC<{ hunks: AgentDiffHunk[] }> = ({ hunks }) => (
  <div className="panel-scroll max-h-72 overflow-auto rounded-sm text-[12px] leading-[1.35rem] font-mono">
    {hunks.map((h, hi) => (
      <div key={hi} className={hi > 0 ? 'mt-1 pt-1 border-t border-dashed border-zinc-200 dark:border-zinc-800' : ''}>
        {h.lines.map((l, li) => {
          const tone =
            l.t === '+'
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : l.t === '-'
                ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
                : 'text-zinc-500 dark:text-zinc-500';
          return (
            <div key={li} className={`flex whitespace-pre ${tone}`}>
              <span className="w-9 shrink-0 pr-2 text-right text-zinc-400/80 select-none">{l.t === '-' ? l.o : l.n}</span>
              <span className="w-3 shrink-0 select-none">{l.t === ' ' ? '' : l.t}</span>
              <span className="pr-3">{l.s || ' '}</span>
            </div>
          );
        })}
      </div>
    ))}
  </div>
);

const isCommandAction = (action: AgentAction) => action.tool === 'run_command' || action.tool === 'run_checks';

export const CommandDetails: React.FC<{ action: AgentAction }> = ({ action }) => {
  const lines = String(action.output || '').split(/\r?\n/);
  if (lines[0]?.startsWith('$ ')) lines.shift();
  const output = lines.join('\n')
    .replace(/\n?\[(?:exit code \d+|stopped by the user|timed out after [^\]]+)\]\s*$/i, '')
    .trimEnd();
  const result = action.result;
  const command = String(result?.command || action.args?.command || 'Command');
  const cwd = String(result?.cwd || action.args?.cwd || '.');
  const status = action.status === 'running' || action.status === 'pending'
    ? 'running'
    : result?.timedOut
      ? 'timed out'
      : result?.aborted
        ? 'stopped'
        : typeof result?.exitCode === 'number'
          ? result.exitCode === 0 ? 'finished' : `exit ${result.exitCode}`
          : typeof result?.passed === 'boolean'
            ? result.passed ? 'passed' : 'failed'
            : action.status === 'done' ? 'finished' : action.status === 'error' ? 'failed' : '';
  const failed = result?.timedOut || result?.aborted || result?.passed === false || (typeof result?.exitCode === 'number' && result.exitCode !== 0);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200/80 bg-white/70 dark:border-zinc-800 dark:bg-zinc-900/60" data-testid="command-details">
      <div className="flex min-w-0 items-center gap-1.5 border-b border-zinc-200/70 px-2.5 py-2 text-[11px] dark:border-zinc-800">
        <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
        <span className="min-w-0 max-w-[35%] truncate text-zinc-500 dark:text-zinc-400" title={cwd}>{cwd}</span>
        <ChevronRight className="h-3 w-3 shrink-0 text-zinc-400" aria-hidden="true" />
        <code className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300" title={command}>{command}</code>
        {status ? <span className={`shrink-0 text-[10px] ${failed ? 'text-rose-500 dark:text-rose-400' : 'text-zinc-400 dark:text-zinc-500'}`}>{status}</span> : null}
      </div>
      <pre className="panel-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words bg-zinc-50/70 px-3 py-2.5 text-[11.5px] leading-[1.35rem] font-mono text-zinc-600 dark:bg-zinc-950/30 dark:text-zinc-400">
        {output || (action.status === 'running' || action.status === 'pending' ? '(no output yet)' : '(no output)')}
      </pre>
    </div>
  );
};

const Details: React.FC<{ action: AgentAction }> = ({ action }) => {
  const r = action.result;
  const recovered = action.status === 'error' && r?.recovered === true;
  const commandAction = isCommandAction(action);
  const showError =
    action.status === 'error' && action.error && action.error !== 'Stopped' && action.error !== 'Interrupted' &&
    !recovered && !(r && typeof r.exitCode === 'number');

  return (
    <div className={`mt-1 mb-1.5 animate-in fade-in duration-150 ${commandAction ? 'ml-0' : 'ml-0.5 pl-3 border-l-2 border-zinc-200/80 dark:border-zinc-800'}`}>
      {commandAction ? <CommandDetails action={action} /> : null}
      {r?.markdown && (action.tool === 'fetch_url' || action.tool === 'web_search') ? (
        <div className="panel-scroll max-h-[65vh] max-w-3xl overflow-y-auto overscroll-y-contain pr-3 pl-3 py-2 border-l-2 border-zinc-200/70 dark:border-zinc-800/70 text-zinc-600 dark:text-zinc-300 text-[12px] leading-relaxed whitespace-normal break-words select-text [&_h1]:mb-2 [&_h1]:mt-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1 [&_a]:text-sky-700 [&_a]:underline [&_a]:decoration-sky-500/40 [&_a]:underline-offset-2 dark:[&_a]:text-sky-300 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-300 [&_blockquote]:pl-3 dark:[&_blockquote]:border-zinc-700 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-zinc-100 [&_pre]:p-2 dark:[&_pre]:bg-zinc-900 [&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1 dark:[&_code]:bg-zinc-900 [&_pre_code]:bg-transparent [&_pre_code]:p-0">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={defaultUrlTransform}
            components={{
              a: ({ href, children }) => href
                ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                : <>{children}</>,
              img: ({ src, alt }) => src
                ? <img src={src} alt={alt || ''} loading="lazy" className="my-2 max-h-80 max-w-full rounded-md object-contain" />
                : null,
            }}
          >
            {r.markdown}
          </ReactMarkdown>
        </div>
      ) : null}
      {r?.hunks && r.hunks.length > 0 && <Diff hunks={r.hunks} />}

      {r?.changes && (r.changes.length > 1 || action.tool === 'replace_in_files') &&
        r.changes.map((f) => (
          <div key={f.path} className="mb-2 last:mb-0">
            <div className="flex items-center gap-1.5 text-[12px] leading-5 mb-0.5">
              <FileTypeIcon path={f.path} />
              <span className="font-medium text-zinc-800 dark:text-zinc-100 truncate">{f.path}</span>
              {f.ranges && f.ranges.length > 0 && <span className="font-mono text-[11px] text-zinc-400">{formatRanges(f.ranges, 3)}</span>}
              <DiffCount added={f.added} removed={f.removed} animate={false} />
              {f.edits && f.edits > 1 && <span className="text-zinc-400">· {f.edits} edits</span>}
            </div>
            {f.hunks && f.hunks.length > 0 && <Diff hunks={f.hunks} />}
          </div>
        ))}

      {!commandAction && action.output && (
        <pre className="panel-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 font-mono text-zinc-600 dark:text-zinc-400">
          {action.output.trimEnd()}
        </pre>
      )}

      {r?.todos && r.todos.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Plan</div>
          <ul className="space-y-1.5 text-[12px] leading-5">
            {r.todos.map((t, i) => (
              <li key={i} className="flex min-w-0 items-start gap-2">
                {/* Shape and weight carry status; the plan stays neutral. */}
                {t.status === 'completed' ? (
                  <CircleCheck aria-hidden="true" className="mt-[3px] h-3.5 w-3.5 shrink-0 text-zinc-500 dark:text-zinc-400" />
                ) : t.status === 'in_progress' ? (
                  <CircleDot aria-hidden="true" className="mt-[3px] h-3.5 w-3.5 shrink-0 text-zinc-800 dark:text-zinc-100" />
                ) : (
                  <Circle aria-hidden="true" className="mt-[3px] h-3.5 w-3.5 shrink-0 text-zinc-300 dark:text-zinc-600" />
                )}
                <span
                  className={`min-w-0 break-words ${
                    t.status === 'completed'
                      ? 'text-zinc-400 line-through decoration-zinc-300 dark:decoration-zinc-700'
                      : t.status === 'in_progress'
                        ? 'font-medium text-zinc-900 dark:text-zinc-100'
                        : 'text-zinc-600 dark:text-zinc-400'
                  }`}
                >
                  {t.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {r?.findings && r.findings.length > 0 && (
        <div className="mt-2 pt-2 border-t border-zinc-200/70 dark:border-zinc-800">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
            Useful task findings
          </div>
          <ul className="space-y-1 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
            {r.findings.map((finding, i) => <li key={i}>· {finding}</li>)}
          </ul>
        </div>
      )}

      {r?.images && r.images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {r.images.map((img) => (
            <a key={img.url} href={img.url} target="_blank" rel="noopener noreferrer" title={img.title}
               className="block w-20 h-20 rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
              <img src={img.thumbnail || img.url} alt={img.title} loading="lazy" className="w-full h-full object-cover"
                   onError={(e) => ((e.currentTarget as HTMLElement).style.display = 'none')} />
            </a>
          ))}
        </div>
      )}

      {r?.check && r.check.ok === false && (
        <pre className="panel-scroll max-h-40 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 font-mono text-rose-600 dark:text-rose-400">
          Syntax error in {r.check.path} ({r.check.lang}): {r.check.message}
        </pre>
      )}

      {recovered && (
        <pre className="panel-scroll max-h-56 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 font-mono text-amber-600 dark:text-amber-400">
          {action.error}
        </pre>
      )}

      {showError && (
        <pre className="panel-scroll max-h-56 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 font-mono text-rose-600 dark:text-rose-400">
          {action.error}
        </pre>
      )}
    </div>
  );
};

/**
 * One action's detail open at a time, chat-wide: opening another row's detail (or
 * clicking anywhere outside this one) closes this one, so a long transcript never
 * ends up with a column of half-expanded boxes.
 */
const detailStore = createPanelStore();

export const AgentActionRow: React.FC<RowProps> = React.memo(({ action, onApproval, onOpenPreview }) => {
  const open = usePanelOpen(detailStore, action.id);
  const rowRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => detailStore.close(), []);
  useDismissOnOutside(rowRef, open, close);
  const setOpen = useCallback(
    (next: boolean | ((was: boolean) => boolean)) => {
      const was = detailStore.get() === action.id;
      const value = typeof next === 'function' ? (next as (was: boolean) => boolean)(was) : next;
      detailStore.set(value ? action.id : null);
    },
    [action.id]
  );

  const approvalKey = action.approval?.key;
  const approvalIdentity = `${action.id}:${approvalKey || ''}`;
  const approvalIdentityRef = useRef(approvalIdentity);
  const approvalRequestRef = useRef<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalSent, setApprovalSent] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  useEffect(() => {
    if (approvalIdentityRef.current === approvalIdentity) return;
    approvalIdentityRef.current = approvalIdentity;
    approvalRequestRef.current = null;
    setApprovalBusy(false);
    setApprovalSent(false);
    setApprovalError('');
  }, [approvalIdentity]);

  const submitApproval = async (allow: boolean, always: boolean) => {
    if (!onApproval || !approvalKey || approvalRequestRef.current === approvalKey || approvalSent) return;
    approvalRequestRef.current = approvalKey;
    setApprovalBusy(true);
    setApprovalError('');
    try {
      await onApproval(action, allow, always);
      if (approvalRequestRef.current === approvalKey) setApprovalSent(true);
    } catch {
      if (approvalRequestRef.current === approvalKey) setApprovalError('Could not send that choice. Try again.');
    } finally {
      if (approvalRequestRef.current === approvalKey) {
        approvalRequestRef.current = null;
        setApprovalBusy(false);
      }
    }
  };

  const label = actionLabel(action);
  const live = isWorking(action); // shimmer = working on it right now
  const queued = action.status === 'queued';
  const awaiting = action.status === 'awaiting_approval';
  const failedTool = label.verb.startsWith("Couldn't") || label.verb.includes('failed') || label.verb.startsWith('Preview not');
  const muted = action.status === 'denied' || label.verb === 'Stopped' || label.verb === 'Interrupted';
  // A refusal is neither a crash nor a success: the run stopped the agent so it
  // could look first. Amber, so it reads as a redirection.
  const refused = action.status === 'blocked';
  const recovered = action.status === 'error' && action.result?.recovered === true;

  // A parked body is the same kind of news: nothing is lost, the run needs one
  // more step. Amber, so it does not read as a crash.
  const verbTone = refused || recovered
    ? 'text-amber-600 dark:text-amber-400'
    : failedTool
      ? 'text-rose-600 dark:text-rose-400'
      : muted || queued
        ? 'text-zinc-400 dark:text-zinc-500'
        : 'text-zinc-500 dark:text-zinc-400';

  const tail = live && action.output && (action.tool === 'run_command' || action.tool === 'read_process_output') ? lastLines(action.output, 3) : [];
  const previewUrl = action.result?.url;
  const fetchedPageUrl = action.tool === 'fetch_url' && action.status === 'done' && action.result?.markdown
    ? safeHttpUrl(action.result.url || action.args?.url)
    : undefined;
  const fetchedPageSite = (() => {
    try { return new URL(fetchedPageUrl || '').hostname.replace(/^www\./i, ''); } catch { return ''; }
  })();
  const sourceRange = action.tool === 'read_file' && label.lines
    ? `#${label.lines.replace(/L(\d+)–L(\d+)/g, 'L$1-$2')}`
    : undefined;

  const labelContent = (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      <span className={`shrink-0 font-medium ${live ? 'agent-shimmer' : verbTone}`}>{label.verb}</span>

      {label.fileChanges?.map((change) => (
        <span key={change.path} className="inline-flex min-w-0 max-w-[18rem] items-center gap-1">
          <FileTypeIcon path={change.path} className="h-3.5 w-3.5 shrink-0 opacity-80" />
          <span className={`truncate text-[12px] font-medium ${live ? 'agent-shimmer' : queued ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-700 dark:text-zinc-300'}`} title={change.path}>
            {shortPath(change.path, 38)}
          </span>
          <DiffCount added={change.added} removed={change.removed} className="shrink-0 text-[12px]" showZero animate={live} />
        </span>
      ))}
      {!label.fileChanges && label.fileTargets?.slice(0, 2).map((target) => (
        <span key={target} className="inline-flex min-w-0 max-w-[14rem] items-center gap-1">
          <FileTypeIcon path={target} className="h-3.5 w-3.5 shrink-0 opacity-80" />
          <span className={`truncate text-[12px] font-medium ${live ? 'agent-shimmer' : queued ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-700 dark:text-zinc-300'}`} title={target}>
            {shortPath(target, 38)}
          </span>
        </span>
      ))}
      {!label.fileChanges && label.fileTargets && label.fileTargets.length > 2 ? (
        <span className="shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">+{label.fileTargets.length - 2} more</span>
      ) : null}

      {label.target && label.targetKind === 'command' && (
        <span className="inline-flex min-w-0 max-w-full items-center" title={label.target}>
          <span className={`min-w-0 truncate font-mono text-[12.5px] ${live ? 'agent-shimmer' : queued ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-700 dark:text-zinc-300'}`}>
            {label.target}
          </span>
        </span>
      )}
      {label.target && label.targetKind === 'pattern' && (
        <span className={`truncate font-mono text-[12px] ${live ? 'agent-shimmer' : queued ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-700 dark:text-zinc-300'}`} title={label.target}>
          “{label.target}”
        </span>
      )}
      {label.target && (label.targetKind === 'file' || label.targetKind === 'dir') && (
        <>
          <FileTypeIcon
            path={label.iconPath ?? label.target}
            isDir={label.targetKind === 'dir'}
            className={`h-4 w-4 shrink-0 ${live || queued ? 'opacity-60' : ''}`}
          />
          <span
            className={`${label.targetKind === 'dir' ? 'min-w-0 max-w-full whitespace-normal leading-4' : 'min-w-0 max-w-full truncate'} font-medium ${live ? 'agent-shimmer' : queued ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-100'}`}
            title={label.target}
            style={label.targetKind === 'dir' ? { overflowWrap: 'anywhere' } : undefined}
          >
            {label.targetKind === 'dir' ? label.target : shortPath(label.target)}
          </span>
        </>
      )}
      {label.target && (label.targetKind === 'url' || label.targetKind === 'text') && (
        <span className={`min-w-0 max-w-full truncate font-medium ${live ? 'agent-shimmer' : queued ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-100'}`} title={label.target}>
          {label.target}
        </span>
      )}
      {action.tool === 'web_search' ? <SearchSourceStack sources={action.result?.sources} className="ml-0.5" /> : null}
    </span>
  );

  const clickable = label.expandable;

  return (
    <div className="agent-row" ref={rowRef}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-h-[27px] text-[13.5px] leading-6 select-none">
        <button
          type="button"
          onClick={() => clickable && setOpen((v) => !v)}
          disabled={!clickable}
          aria-expanded={clickable ? open : undefined}
          className={`group inline-flex items-center gap-1.5 min-w-0 max-w-full overflow-hidden text-left ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
        >
          {labelContent}

          {sourceRange && <span className="shrink-0 font-mono text-[12.5px] text-zinc-400 dark:text-zinc-500">{sourceRange}</span>}
          {/* Live values are disk-confirmed; settled values come from the final tool result. */}
          {!label.fileChanges && (
            <DiffCount added={label.added} removed={label.removed} className="shrink-0 text-[12.5px]" showZero animate={live} />
          )}
          {label.chips?.map((c) => (
            <span key={c} className="shrink-0 font-mono text-[12px] text-zinc-400 dark:text-zinc-500">
              {c}
            </span>
          ))}
          {label.meta && (
            <span className={`shrink-0 max-w-[28rem] truncate text-[12.5px] ${label.exitFailed ? 'text-rose-500 dark:text-rose-400' : 'text-zinc-400 dark:text-zinc-500'}`}>
              · {label.meta}
            </span>
          )}
          {clickable && (
            <ChevronRight
              className={`w-3.5 h-3.5 shrink-0 text-zinc-400 transition-transform duration-150 group-hover:text-zinc-600 dark:group-hover:text-zinc-300 ${open ? 'rotate-90' : ''}`}
            />
          )}
        </button>

        {fetchedPageUrl && (
          <a
            href={fetchedPageUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${fetchedPageSite || 'source page'} in a new tab`}
            title={action.result?.title ? `Open ${action.result.title}` : `Open ${fetchedPageSite}`}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}

        {previewUrl && action.tool === 'get_preview_url' && (
          <span className="shrink-0 inline-flex items-center gap-0.5">
            {onOpenPreview ? (
              <>
                {/* The URL itself opens the panel — that is what "give me the
                    link" means here. A new tab stays one small click away for
                    pages that refuse to be framed. */}
                <button
                  type="button"
                  onClick={() => onOpenPreview(previewUrl, action.result?.title)}
                  className="inline-flex items-center gap-1.5 pl-2 pr-1.5 h-6 rounded-md rounded-r-none text-[12px] font-medium bg-emerald-50 dark:bg-emerald-500/10 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-500/30 border-r-0 transition-colors cursor-pointer"
                  title="Open it in the panel next to the chat"
                  data-testid="open-preview-panel"
                >
                  <PanelRight className="w-3.5 h-3.5 shrink-0" />
                  <span>Preview</span>
                  <span className="max-w-[200px] truncate font-normal opacity-80">{previewUrl.replace(/^https?:\/\//, '')}</span>
                </button>
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center h-6 px-1.5 rounded-md rounded-l-none bg-emerald-50 dark:bg-emerald-500/10 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-500/30 border-l-0 transition-colors"
                  title="Open in a new tab"
                >
                  <ExternalLink className="w-3 h-3" />
                </a>
              </>
            ) : (
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[12px] text-sky-600 dark:text-sky-400 hover:underline"
                title="Open in a new tab"
              >
                <span className="max-w-[220px] truncate">{previewUrl.replace(/^https?:\/\//, '')}</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </span>
        )}

        {awaiting && onApproval && action.approval && (
          <span className="shrink-0 inline-flex flex-wrap items-center gap-1 ml-1">
            {approvalBusy ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400" role="status">
                <Loader2 className="w-3 h-3 animate-spin" /> Sending choice…
              </span>
            ) : approvalSent ? (
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400" role="status" aria-live="polite">
                Choice sent — waiting for the agent…
              </span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void submitApproval(true, false)}
                  disabled={approvalBusy}
                  className="px-2 h-6 rounded-md text-[12px] font-medium bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 disabled:opacity-50"
                >
                  Allow
                </button>
                <button
                  type="button"
                  onClick={() => void submitApproval(true, true)}
                  disabled={approvalBusy}
                  className="px-2 h-6 rounded-md text-[12px] text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
                >
                  Always allow
                </button>
                <button
                  type="button"
                  onClick={() => void submitApproval(false, false)}
                  disabled={approvalBusy}
                  className="px-2 h-6 rounded-md text-[12px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 disabled:opacity-50"
                >
                  Deny
                </button>
              </>
            )}
            {approvalError && <span className="text-[11px] text-rose-600 dark:text-rose-400" role="alert">{approvalError}</span>}
          </span>
        )}
      </div>

      {isWorking(action) && action.progress?.tail && action.progress.tail.length > 0 && (
        <div className="ml-0.5 pl-3 border-l-2 border-zinc-200/80 dark:border-zinc-800 font-mono text-[12px] leading-[1.15rem] text-zinc-400 dark:text-zinc-500" data-testid="live-tail">
          {action.progress.tail.map((l, i) => (
            <div key={i} className="truncate whitespace-pre">{l || ' '}</div>
          ))}
        </div>
      )}

      {tail.length > 0 && (
        <div className="ml-0.5 pl-3 border-l-2 border-zinc-200/80 dark:border-zinc-800 font-mono text-[12px] leading-[1.15rem] text-zinc-400 dark:text-zinc-500">
          {tail.map((l, i) => (
            <div key={i} className="truncate">{l || ' '}</div>
          ))}
        </div>
      )}

      {open && clickable && <Details action={action} />}
    </div>
  );
});
AgentActionRow.displayName = 'AgentActionRow';
