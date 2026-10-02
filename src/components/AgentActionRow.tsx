import React, { useEffect, useState } from 'react';
import { ChevronRight, Circle, CircleCheck, CircleDot, ExternalLink } from 'lucide-react';
import type { AgentAction, AgentDiffHunk } from '../types';
import { actionLabel, formatRanges, isLive, isWorking } from '../agent/format';
import { AnimatedCount } from './AnimatedCount';
import { FileTypeIcon } from './FileTypeIcon';

/**
 * One thing the agent did, as a plain line of text — no card, no status box:
 *
 *   Creating  📄 index.html  +77 −98        (the whole label shimmers while it runs)
 *   Analyzed  📄 App.tsx  L1–L120
 *   Ran  $ npm install  · 4.2s              (click to see the output)
 */

/** Long paths keep their tail: "…/components/AgentActionRow.tsx". */
const shortPath = (p: string, max = 56) => (p.length <= max ? p : `…${p.slice(p.length - (max - 1))}`);

const lastLines = (text = '', n = 3) =>
  text
    .replace(/\s+$/, '')
    .split('\n')
    .slice(-n);

/** While a finished write's numbers are still rolling up, its verb keeps the present tense. */
const PRESENT: Record<string, string> = { Created: 'Creating', Rewrote: 'Creating', Edited: 'Editing', Appended: 'Appending', Replaced: 'Replacing' };

interface RowProps {
  action: AgentAction;
  onApproval?: (action: AgentAction, allow: boolean, always: boolean) => void;
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

const Details: React.FC<{ action: AgentAction }> = ({ action }) => {
  const r = action.result;
  const showError = action.status === 'error' && action.error && action.error !== 'Stopped' && action.error !== 'Interrupted' && !(r && typeof r.exitCode === 'number');

  return (
    <div className="mt-1 mb-1.5 ml-0.5 pl-3 border-l-2 border-zinc-200/80 dark:border-zinc-800 animate-in fade-in duration-150">
      {r?.hunks && r.hunks.length > 0 && <Diff hunks={r.hunks} />}

      {r?.changes && (r.changes.length > 1 || action.tool === 'replace_in_files') &&
        r.changes.map((f) => (
          <div key={f.path} className="mb-2 last:mb-0">
            <div className="flex items-center gap-1.5 text-[12px] leading-5 mb-0.5">
              <FileTypeIcon path={f.path} />
              <span className="font-medium text-zinc-800 dark:text-zinc-100 truncate">{f.path}</span>
              {f.ranges && f.ranges.length > 0 && <span className="font-mono text-[11px] text-zinc-400">{formatRanges(f.ranges, 3)}</span>}
              {f.added > 0 && <span className="font-mono text-emerald-600 dark:text-emerald-400">+{f.added}</span>}
              {f.removed > 0 && <span className="font-mono text-rose-500 dark:text-rose-400">−{f.removed}</span>}
              {f.edits && f.edits > 1 && <span className="text-zinc-400">· {f.edits} edits</span>}
            </div>
            {f.hunks && f.hunks.length > 0 && <Diff hunks={f.hunks} />}
          </div>
        ))}

      {action.output && (
        <pre className="panel-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 font-mono text-zinc-600 dark:text-zinc-400">
          {action.output.trimEnd()}
        </pre>
      )}

      {r?.todos && r.todos.length > 0 && (
        <ul className="space-y-1 text-[12.5px]">
          {r.todos.map((t, i) => (
            <li key={i} className="flex items-start gap-1.5">
              {t.status === 'completed' ? (
                <CircleCheck className="w-3.5 h-3.5 mt-[3px] shrink-0 text-emerald-500" />
              ) : t.status === 'in_progress' ? (
                <CircleDot className="w-3.5 h-3.5 mt-[3px] shrink-0 text-sky-500" />
              ) : (
                <Circle className="w-3.5 h-3.5 mt-[3px] shrink-0 text-zinc-400" />
              )}
              <span className={t.status === 'completed' ? 'text-zinc-400 line-through' : 'text-zinc-700 dark:text-zinc-300'}>
                {t.content}
              </span>
            </li>
          ))}
        </ul>
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

      {showError && (
        <pre className="panel-scroll max-h-56 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 font-mono text-rose-600 dark:text-rose-400">
          {action.error}
        </pre>
      )}
    </div>
  );
};

export const AgentActionRow: React.FC<RowProps> = React.memo(({ action, onApproval }) => {
  const [open, setOpen] = useState(false);
  // Was this row on screen while it was live? Then a number that shows up late (the model sent the whole
  // file at once) rolls up from 0 instead of popping in; rows loaded from history simply show their numbers.
  const [sawLive, setSawLive] = useState(isLive(action));
  useEffect(() => {
    if (isLive(action)) setSawLive(true);
  }, [action.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const [addRolling, setAddRolling] = useState(false);
  const [remRolling, setRemRolling] = useState(false);
  const settling = (addRolling || remRolling) && action.status === 'done' && sawLive;
  const label = actionLabel(action);
  if (settling) label.verb = PRESENT[label.verb] ?? label.verb;
  const live = isWorking(action) || settling; // shimmer = working on it right now (or its numbers are still rolling in)
  const queued = action.status === 'queued';
  const awaiting = action.status === 'awaiting_approval';
  const failedTool = label.verb.startsWith("Couldn't") || label.verb.includes('failed') || label.verb.startsWith('Preview not');
  const muted = action.status === 'denied' || label.verb === 'Stopped' || label.verb === 'Interrupted';

  const verbTone = failedTool
    ? 'text-rose-600 dark:text-rose-400'
    : muted || queued
      ? 'text-zinc-400 dark:text-zinc-500'
      : 'text-zinc-500 dark:text-zinc-400';

  const tail = live && action.output && (action.tool === 'run_command' || action.tool === 'read_process_output') ? lastLines(action.output, 3) : [];
  const previewUrl = action.result?.url;

  const labelContent = (
    <span className={`inline-flex items-center gap-1.5 min-w-0 ${live ? 'agent-shimmer' : ''}`}>
      <span className={`shrink-0 ${live ? '' : verbTone}`}>{label.verb}</span>

      {label.target && label.targetKind === 'command' && (
        <span className={`font-mono text-[12px] truncate ${live ? '' : queued ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-700 dark:text-zinc-300'}`} title={label.target}>
          <span className={live ? '' : 'text-zinc-400'}>$ </span>
          {label.target}
        </span>
      )}
      {label.target && label.targetKind === 'pattern' && (
        <span className={`font-mono text-[12px] truncate ${live ? '' : queued ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-700 dark:text-zinc-300'}`} title={label.target}>
          “{label.target}”
        </span>
      )}
      {label.target && (label.targetKind === 'file' || label.targetKind === 'dir') && (
        <>
          <FileTypeIcon path={label.iconPath ?? label.target} isDir={label.targetKind === 'dir'} className={`w-4 h-4 ${live || queued ? 'opacity-50' : ''}`} />
          <span className={`truncate font-medium ${live ? '' : queued ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-100'}`} title={label.target}>
            {shortPath(label.target)}
          </span>
        </>
      )}
      {label.target && (label.targetKind === 'url' || label.targetKind === 'text') && (
        <span className={`truncate font-medium ${live ? '' : queued ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-100'}`} title={label.target}>
          {label.target}
        </span>
      )}
    </span>
  );

  const clickable = label.expandable;

  return (
    <div className="agent-row">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-h-[26px] text-[13px] leading-6 select-none">
        <button
          type="button"
          onClick={() => clickable && setOpen((v) => !v)}
          disabled={!clickable}
          aria-expanded={clickable ? open : undefined}
          className={`group inline-flex items-center gap-1.5 min-w-0 max-w-full overflow-hidden text-left ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
        >
          {labelContent}

          {label.lines && <span className="shrink-0 font-mono text-[11.5px] text-zinc-400 dark:text-zinc-500">{label.lines}</span>}
          {label.added !== undefined && label.added > 0 && (
            <AnimatedCount
              value={label.added}
              sign="+"
              fromZero={sawLive}
              onAnimating={setAddRolling}
              className="shrink-0 font-mono text-[12px] tabular-nums text-emerald-600 dark:text-emerald-400"
            />
          )}
          {label.removed !== undefined && label.removed > 0 && (
            <AnimatedCount
              value={label.removed}
              sign="−"
              fromZero={sawLive}
              onAnimating={setRemRolling}
              className="shrink-0 font-mono text-[12px] tabular-nums text-rose-500 dark:text-rose-400"
            />
          )}
          {label.chips?.map((c) => (
            <span key={c} className="shrink-0 font-mono text-[11px] text-zinc-500 dark:text-zinc-400 px-1.5 rounded bg-zinc-100 dark:bg-zinc-800">
              {c}
            </span>
          ))}
          {label.meta && (
            <span className={`shrink-0 max-w-[28rem] truncate text-[12px] ${label.exitFailed ? 'text-rose-500 dark:text-rose-400' : 'text-zinc-400 dark:text-zinc-500'}`}>
              · {label.meta}
            </span>
          )}
          {clickable && (
            <ChevronRight
              className={`w-3 h-3 shrink-0 text-zinc-400 transition-transform duration-150 group-hover:text-zinc-600 dark:group-hover:text-zinc-300 ${open ? 'rotate-90' : ''}`}
            />
          )}
        </button>

        {previewUrl && action.tool === 'get_preview_url' && (
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-1 text-[12px] text-sky-600 dark:text-sky-400 hover:underline"
          >
            <span className="max-w-[260px] truncate">{previewUrl.replace(/^https?:\/\//, '')}</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        )}

        {awaiting && onApproval && (
          <span className="shrink-0 inline-flex items-center gap-1 ml-1">
            <button type="button" onClick={() => onApproval(action, true, false)}
              className="px-2 h-6 rounded-md text-[11.5px] font-medium bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
              Allow
            </button>
            <button type="button" onClick={() => onApproval(action, true, true)}
              className="px-2 h-6 rounded-md text-[11.5px] text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              Always allow
            </button>
            <button type="button" onClick={() => onApproval(action, false, false)}
              className="px-2 h-6 rounded-md text-[11.5px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
              Deny
            </button>
          </span>
        )}
      </div>

      {isWorking(action) && action.progress?.tail && action.progress.tail.length > 0 && (
        <div className="ml-0.5 pl-3 border-l-2 border-zinc-200/80 dark:border-zinc-800 font-mono text-[11.5px] leading-[1.15rem] text-zinc-400 dark:text-zinc-500" data-testid="live-tail">
          {action.progress.tail.map((l, i) => (
            <div key={i} className="truncate whitespace-pre">{l || ' '}</div>
          ))}
        </div>
      )}

      {tail.length > 0 && (
        <div className="ml-0.5 pl-3 border-l-2 border-zinc-200/80 dark:border-zinc-800 font-mono text-[11.5px] leading-[1.15rem] text-zinc-400 dark:text-zinc-500">
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
