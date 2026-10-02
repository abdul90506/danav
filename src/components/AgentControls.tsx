import React, { useEffect, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, Cloud, FolderTree, Laptop, Plus, Trash2 } from 'lucide-react';
import type { AgentWorkspace } from '../types';

interface AgentControlsProps {
  enabled: boolean;
  onToggle: () => void;
  workspaces: AgentWorkspace[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onToggleAutoRun: (id: string, autoRun: boolean) => void;
  filesOpen: boolean;
  onToggleFiles: () => void;
  /** An agent run is in progress: switching or deleting a workspace is locked. */
  busy?: boolean;
}

const KindIcon: React.FC<{ kind: AgentWorkspace['kind']; className?: string }> = ({ kind, className = 'w-3.5 h-3.5' }) =>
  kind === 'sandbox' ? <Cloud className={className} /> : <Laptop className={className} />;

/**
 * The row above the message box: the Agent switch and, when it is on, the
 * workspace the agent works in (a cloud sandbox or a folder on this machine).
 */
export const AgentControls: React.FC<AgentControlsProps> = ({
  enabled, onToggle, workspaces, activeWorkspaceId, onSelectWorkspace, onCreate, onDelete,
  onToggleAutoRun, filesOpen, onToggleFiles, busy,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const active = workspaces.find((w) => w.id === activeWorkspaceId) || null;

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirmDelete(null);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const pill = enabled
    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-transparent'
    : 'bg-white/70 dark:bg-zinc-900/60 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-800 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800';

  return (
    <div className="flex items-center gap-1.5 flex-wrap px-1 pb-2 select-none" data-testid="agent-controls">
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        aria-pressed={enabled}
        title={enabled ? 'Agent mode is on — it can create files and run commands in a workspace' : 'Turn on Agent mode: let the AI build things in a workspace'}
        className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11.5px] font-medium border transition-colors disabled:cursor-default ${pill}`}
      >
        <Bot className="w-3.5 h-3.5" />
        <span>Agent</span>
      </button>

      {enabled && (
        <div className="relative" ref={ref}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11.5px] font-medium border transition-colors ${
              active
                ? 'text-zinc-700 dark:text-zinc-200 border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                : 'text-amber-700 dark:text-amber-300 border-amber-300/70 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10'
            }`}
            data-testid="workspace-chip"
          >
            {active ? <KindIcon kind={active.kind} className="w-3.5 h-3.5 text-zinc-400" /> : null}
            <span className="max-w-[160px] truncate">{active ? active.name : 'Choose a workspace'}</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>

          {menuOpen && (
            <div className="absolute left-0 bottom-full mb-1.5 z-50 w-72 py-1 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 text-xs animate-in fade-in duration-100">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide font-semibold text-zinc-400">Workspaces</div>
              {workspaces.length === 0 && <div className="px-3 py-2 text-zinc-400">No workspace yet. Create one to start.</div>}

              <div className="max-h-56 overflow-y-auto panel-scroll">
                {workspaces.map((w) => (
                  <div key={w.id} className="group flex items-center gap-1 pr-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        onSelectWorkspace(w.id);
                        setMenuOpen(false);
                      }}
                      className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-60 rounded-md"
                    >
                      <KindIcon kind={w.kind} className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-zinc-800 dark:text-zinc-100 font-medium">{w.name}</span>
                        <span className="block truncate text-[10.5px] text-zinc-400">
                          {w.kind === 'sandbox' ? 'Cloud sandbox' : 'This machine'} · {w.root}
                        </span>
                      </span>
                      {w.id === activeWorkspaceId && <Check className="w-3.5 h-3.5 shrink-0 text-zinc-700 dark:text-zinc-200" />}
                    </button>
                    {confirmDelete === w.id ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          onDelete(w.id);
                          setConfirmDelete(null);
                        }}
                        className="px-1.5 h-6 rounded-md text-[10.5px] font-medium text-white bg-rose-600 hover:bg-rose-700"
                      >
                        {w.kind === 'sandbox' ? 'Delete sandbox' : 'Remove'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDelete(w.id)}
                        title={w.kind === 'sandbox' ? 'Delete this workspace and its sandbox' : 'Remove from the list (your files stay on disk)'}
                        className="p-1.5 rounded-md text-zinc-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {active && (
                <label className="flex items-center gap-2 px-3 py-2 mt-1 border-t border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!active.autoRun}
                    onChange={(e) => onToggleAutoRun(active.id, !e.target.checked)}
                    className="accent-zinc-800"
                  />
                  <span>Ask before running commands</span>
                </label>
              )}

              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onCreate();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 border-t border-zinc-100 dark:border-zinc-800 text-zinc-800 dark:text-zinc-100 font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
                data-testid="new-workspace"
              >
                <Plus className="w-3.5 h-3.5" />
                New workspace…
              </button>
            </div>
          )}
        </div>
      )}

      {enabled && active && (
        <button
          type="button"
          onClick={onToggleFiles}
          aria-pressed={filesOpen}
          className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11.5px] font-medium border transition-colors ${
            filesOpen
              ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 border-zinc-300 dark:border-zinc-700'
              : 'bg-white/70 dark:bg-zinc-900/60 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-800 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
          title="Browse the workspace files"
        >
          <FolderTree className="w-3.5 h-3.5" />
          <span>Files</span>
        </button>
      )}

      {enabled && active && !active.autoRun && (
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">asks before running commands</span>
      )}
    </div>
  );
};
