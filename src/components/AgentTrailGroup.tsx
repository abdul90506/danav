import React, { useCallback, useMemo, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { AgentAction } from '../types';
import { AgentActionRow } from './AgentActionRow';
import { createPanelStore, usePanelOpen } from './panels';
import { isWorkSummaryAction, summarizeWorkActions } from '../agent/format';
import { useDismissOnOutside } from '../utils/useDismissOnOutside';

/** Only one nested activity group is open at a time, chat-wide. */
const groupStore = createPanelStore();

interface TrailProps {
  /** Stable prefix for group ids: one message's trail cannot clash with another's. */
  trailId: string;
  actions: AgentAction[];
  /** A finished run is compact; a live run shows the real rows as they arrive. */
  grouped?: boolean;
  onApproval?: (action: AgentAction, allow: boolean, always: boolean) => void | Promise<void>;
  onOpenPreview?: (url: string, title?: string) => void;
}

type TrailEntry =
  | { type: 'group'; id: string; label: string; actions: AgentAction[] }
  | { type: 'action'; action: AgentAction };

const GroupRow: React.FC<{
  id: string;
  label: string;
  actions: AgentAction[];
  onApproval?: (action: AgentAction, allow: boolean, always: boolean) => void | Promise<void>;
  onOpenPreview?: (url: string, title?: string) => void;
}> = ({ id, label, actions, onApproval, onOpenPreview }) => {
  const open = usePanelOpen(groupStore, id);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => groupStore.close(), []);
  useDismissOnOutside(rootRef, open, close);
  const toggle = useCallback(
    () => (groupStore.get() === id ? groupStore.close() : groupStore.set(id)),
    [id]
  );

  return (
    <div ref={rootRef} className="my-1">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`trail-group-${id}`}
        title={label}
        className="group/group flex w-full min-w-0 items-center rounded-md px-1.5 py-1 text-left transition-colors hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40"
      >
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
          <span className="min-w-0 max-w-full truncate text-[13px] leading-5 text-zinc-600 transition-colors group-hover/group:text-zinc-900 dark:text-zinc-300 dark:group-hover/group:text-zinc-100">
            {label}
          </span>
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-150 group-hover/group:text-zinc-700 dark:text-zinc-500 dark:group-hover/group:text-zinc-200 ${open ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
        </span>
      </button>

      {open && (
        <div id={`trail-group-${id}`} className="mt-1 ml-2.5 min-w-0 space-y-1 border-l border-zinc-200/70 pl-3 animate-in fade-in duration-150 dark:border-zinc-800">
          {actions.map((action) => (
            <AgentActionRow key={action.id} action={action} onApproval={onApproval} onOpenPreview={onOpenPreview} />
          ))}
        </div>
      )}
    </div>
  );
};

export const AgentTrail: React.FC<TrailProps> = ({ trailId, actions, grouped = true, onApproval, onOpenPreview }) => {
  const entries = useMemo<TrailEntry[]>(() => {
    const out: TrailEntry[] = [];
    let batch: AgentAction[] = [];

    const flush = () => {
      if (!batch.length) return;
      const label = summarizeWorkActions(batch);
      if (label) {
        const first = batch[0].id;
        const last = batch[batch.length - 1].id;
        out.push({ type: 'group', id: `${trailId}:${first}:${last}`, label, actions: batch });
      } else {
        batch.forEach((action) => out.push({ type: 'action', action }));
      }
      batch = [];
    };

    for (const action of actions) {
      if (isWorkSummaryAction(action)) {
        batch.push(action);
      } else {
        flush();
        out.push({ type: 'action', action });
      }
    }
    flush();
    return out;
  }, [actions, trailId]);

  // A live run is read step by step; only completed trails are collapsed into summaries.
  if (!grouped) {
    return (
      <div className="space-y-px">
        {actions.map((action) => (
          <AgentActionRow key={action.id} action={action} onApproval={onApproval} onOpenPreview={onOpenPreview} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {entries.map((entry) => entry.type === 'group' ? (
        <GroupRow
          key={entry.id}
          id={entry.id}
          label={entry.label}
          actions={entry.actions}
          onApproval={onApproval}
          onOpenPreview={onOpenPreview}
        />
      ) : (
        <AgentActionRow
          key={entry.action.id}
          action={entry.action}
          onApproval={onApproval}
          onOpenPreview={onOpenPreview}
        />
      ))}
    </div>
  );
};
