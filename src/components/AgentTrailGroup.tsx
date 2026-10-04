import React, { useCallback, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { AgentAction } from '../types';
import { AgentActionRow } from './AgentActionRow';
import { createPanelStore, usePanelOpen } from './panels';
import { trailGroupLabel, trailKind } from '../agent/format';

/**
 * A run's actions, the way a run is worth reading: as a few lines, not a log.
 *
 * Four reads become "4 files analyzed"; two commands become "2 commands run". The
 * rows themselves are still there, one click behind the line that sums them up —
 * and a single action needs no summary, so it stays a row of its own.
 *
 * Grouping is by what the tools did, not by which tool ran: a read, a search and a
 * read make "2 files analyzed" and "1 place explored", in the order each first
 * happened. On a finished turn nothing inside a group is in the tree until the
 * group is opened, so a trail with a hundred rows behind it opens instantly.
 */
const groupStore = createPanelStore();

interface TrailProps {
  /** Stable prefix for group ids: one message's trail cannot clash with another's. */
  trailId: string;
  actions: AgentAction[];
  /**
   * Whether to sum the actions up by kind. A finished run reads best as "2 files
   * analyzed"; a run that is still going is watched step by step, so its rows are
   * shown as they happen instead of being counted behind a line whose number keeps
   * changing under the reader's eyes.
   */
  grouped?: boolean;
  onApproval?: (action: AgentAction, allow: boolean, always: boolean) => void;
  onOpenPreview?: (url: string, title?: string) => void;
}

const GroupRow: React.FC<{
  id: string;
  label: string;
  actions: AgentAction[];
  onApproval?: (action: AgentAction, allow: boolean, always: boolean) => void;
  onOpenPreview?: (url: string, title?: string) => void;
}> = ({ id, label, actions, onApproval, onOpenPreview }) => {
  const open = usePanelOpen(groupStore, id);
  const toggle = useCallback(
    () => (groupStore.get() === id ? groupStore.close() : groupStore.set(id)),
    [id]
  );

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group/group inline-flex items-center gap-1.5 py-0.5 -mx-1 px-1 max-w-full text-left cursor-pointer rounded hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors"
      >
        <span className="text-[13px] leading-6 text-zinc-500 dark:text-zinc-400 group-hover/group:text-zinc-700 dark:group-hover/group:text-zinc-200 transition-colors">
          {label}
        </span>
        <ChevronRight
          className={`w-3.5 h-3.5 shrink-0 text-zinc-400 dark:text-zinc-500 transition-transform duration-150 group-hover/group:text-zinc-600 dark:group-hover/group:text-zinc-300 ${
            open ? 'rotate-90' : ''
          }`}
        />
      </button>

      {open && (
        <div className="mt-0.5 ml-1 pl-2.5 border-l border-zinc-200 dark:border-zinc-800 animate-in fade-in duration-150">
          {actions.map((a) => (
            <AgentActionRow key={a.id} action={a} onApproval={onApproval} onOpenPreview={onOpenPreview} />
          ))}
        </div>
      )}
    </div>
  );
};

export const AgentTrail: React.FC<TrailProps> = ({ trailId, actions, grouped = true, onApproval, onOpenPreview }) => {
  /** Groups in the order they first happened, each holding the actions that belong to it. */
  const groups = useMemo(() => {
    const out: Array<{ kind: string; actions: AgentAction[] }> = [];
    const byKind = new Map<string, number>();
    for (const action of actions) {
      const kind = trailKind(action.tool);
      const at = byKind.get(kind);
      if (at === undefined) {
        byKind.set(kind, out.length);
        out.push({ kind, actions: [action] });
      } else {
        out[at].actions.push(action);
      }
    }
    return out;
  }, [actions]);

  /** A live run is read step by step; a finished one is read as a summary. */
  if (!grouped) {  // the prop, not the list below
    return (
      <div className="space-y-px">
        {actions.map((a) => (
          <AgentActionRow key={a.id} action={a} onApproval={onApproval} onOpenPreview={onOpenPreview} />
        ))}
      </div>
    );
  }

  return (
    <div>
      {groups.map((entry) =>
        entry.actions.length === 1 ? (
          <AgentActionRow
            key={entry.actions[0].id}
            action={entry.actions[0]}
            onApproval={onApproval}
            onOpenPreview={onOpenPreview}
          />
        ) : (
          <GroupRow
            key={`${trailId}:${entry.kind}`}
            id={`${trailId}:${entry.kind}`}
            label={trailGroupLabel(entry.kind, entry.actions.length)}
            actions={entry.actions}
            onApproval={onApproval}
            onOpenPreview={onOpenPreview}
          />
        )
      )}
    </div>
  );
};

/** One "lines written" row open at a time, chat-wide. */
const noteStore = createPanelStore();

/**
 * The lines the agent said while it worked, folded into one row.
 *
 * Commentary is not the work: in the trail it would read as a wall of paragraphs
 * between the rows that matter, and on screen it used to sit above the run and
 * then disappear into it. Folded, it is out of the way and still there — the same
 * bargain the actions themselves get.
 */
export const TrailNotes: React.FC<{ id: string; notes: string[] }> = ({ id, notes }) => {
  const open = usePanelOpen(noteStore, id);
  const toggle = useCallback(() => (noteStore.get() === id ? noteStore.close() : noteStore.set(id)), [id]);
  const label = `${notes.length} line${notes.length === 1 ? '' : 's'} written`;

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group/note inline-flex items-center gap-1.5 py-0.5 -mx-1 px-1 max-w-full text-left cursor-pointer rounded hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors"
      >
        <span className="text-[13px] leading-6 text-zinc-500 dark:text-zinc-400 group-hover/note:text-zinc-700 dark:group-hover/note:text-zinc-200 transition-colors">
          {label}
        </span>
        <ChevronRight
          className={`w-3.5 h-3.5 shrink-0 text-zinc-400 dark:text-zinc-500 transition-transform duration-150 group-hover/note:text-zinc-600 dark:group-hover/note:text-zinc-300 ${
            open ? 'rotate-90' : ''
          }`}
        />
      </button>

      {open && (
        <div className="mt-0.5 ml-1 pl-2.5 border-l border-zinc-200 dark:border-zinc-800 space-y-1 animate-in fade-in duration-150">
          {notes.map((note, i) => (
            <p key={i} className="text-[12.5px] leading-[1.4rem] text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap select-text">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
};
