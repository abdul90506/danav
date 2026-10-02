import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Brain, ChevronRight, Cloud, Laptop, Loader2, RefreshCw, Trash2, X } from 'lucide-react';
import type { AgentWorkspace } from '../types';
import { clearMemory, deleteMemoryNote, getFile, getMemory, getTree, type MemoryNote, type TreeEntry } from '../services/agentApi';
import { FileTypeIcon } from './FileTypeIcon';

interface WorkspacePanelProps {
  workspace: AgentWorkspace;
  /** Bumps whenever the agent finished something that may have changed files. */
  refreshToken: number;
  onClose: () => void;
}

const MAX_LINES = 5000;

/** Read-only view of what is in the workspace: a lazy folder tree and a file viewer. */
export const WorkspacePanel: React.FC<WorkspacePanelProps> = ({ workspace, refreshToken, onClose }) => {
  const [tree, setTree] = useState<Record<string, TreeEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState<{ path: string; text: string; binary: boolean; truncated: boolean; size: number } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [view, setView] = useState<'files' | 'memory'>('files');
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const openRef = useRef(open);
  openRef.current = open;

  const loadDir = useCallback(
    async (dir: string) => {
      const res = await getTree(workspace.id, dir);
      setTree((prev) => ({ ...prev, [dir]: res.entries }));
    },
    [workspace.id]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all(['.', ...openRef.current].map((d) => loadDir(d).catch(() => undefined)));
      await loadDir('.');
    } catch (e: any) {
      setError(e?.message || 'Could not read the workspace.');
    } finally {
      setLoading(false);
    }
  }, [loadDir]);

  const loadNotes = useCallback(async () => {
    try {
      setNotes((await getMemory(workspace.id)).notes);
    } catch {
      /* memory is optional */
    }
  }, [workspace.id]);

  // new workspace: start over
  useEffect(() => {
    setView('files');
    loadNotes();
    setTree({});
    setOpen(new Set());
    setFile(null);
    refresh();
  }, [workspace.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // the agent changed something: refresh (debounced) and re-read the open file
  useEffect(() => {
    if (refreshToken === 0) return;
    const t = setTimeout(() => {
      loadNotes();
      refresh();
      setFile((f) => {
        if (f) openFile(f.path, true);
        return f;
      });
    }, 350);
    return () => clearTimeout(t);
  }, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleDir = async (path: string) => {
    const next = new Set(open);
    if (next.has(path)) {
      next.delete(path);
      setOpen(next);
      return;
    }
    next.add(path);
    setOpen(next);
    if (!tree[path]) {
      try {
        await loadDir(path);
      } catch (e: any) {
        setError(e?.message || 'Could not open that folder.');
      }
    }
  };

  const openFile = async (path: string, quiet = false) => {
    if (!quiet) setFileLoading(true);
    try {
      const r = await getFile(workspace.id, path);
      setFile({ path: r.path, text: r.text, binary: r.binary, truncated: r.truncated, size: r.size });
    } catch (e: any) {
      if (!quiet) setError(e?.message || 'Could not open that file.');
    } finally {
      setFileLoading(false);
    }
  };

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const entries = tree[dir];
    if (!entries) return null;
    if (entries.length === 0 && depth === 0) {
      return <div className="px-4 py-6 text-[12.5px] text-zinc-400">This workspace is empty. Ask the agent to build something.</div>;
    }
    return entries.map((e) => {
      const isDir = e.type === 'dir';
      const expanded = isDir && open.has(e.path);
      const name = e.name.split('/').pop() || e.name;
      return (
        <React.Fragment key={e.path}>
          <button
            type="button"
            onClick={() => (isDir ? toggleDir(e.path) : openFile(e.path))}
            className="w-full flex items-center gap-1.5 pr-3 py-[3px] text-left text-[12.5px] hover:bg-zinc-100 dark:hover:bg-zinc-800/70 rounded-md"
            style={{ paddingLeft: 10 + depth * 14 }}
          >
            {isDir ? (
              <>
                <ChevronRight className={`w-3 h-3 shrink-0 text-zinc-400 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                <FileTypeIcon path={e.name} isDir open={expanded} />
              </>
            ) : (
              <>
                <span className="w-3 shrink-0" />
                <FileTypeIcon path={e.name} />
              </>
            )}
            <span className="truncate text-zinc-700 dark:text-zinc-200">{name}</span>
            {!isDir && e.size !== undefined && <span className="ml-auto pl-2 text-[10.5px] text-zinc-400 shrink-0">{e.size < 1024 ? `${e.size} B` : `${(e.size / 1024).toFixed(1)} KB`}</span>}
          </button>
          {expanded && renderDir(e.path, depth + 1)}
        </React.Fragment>
      );
    });
  };

  const lines = file && !file.binary ? file.text.split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const shown = lines.slice(0, MAX_LINES);
  const gutter = String(shown.length).length;

  return (
    <aside
      className="fixed lg:static inset-y-0 right-0 z-40 w-[min(92vw,400px)] lg:w-[380px] shrink-0 flex flex-col h-full bg-white dark:bg-zinc-950 border-l border-zinc-200 dark:border-zinc-800 shadow-xl lg:shadow-none animate-in slide-in-from-right-4 duration-150"
      data-testid="workspace-panel"
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-200/80 dark:border-zinc-800">
        {file ? (
          <button onClick={() => setFile(null)} className="p-1 rounded-md text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800" title="Back to files">
            <ArrowLeft className="w-4 h-4" />
          </button>
        ) : workspace.kind === 'sandbox' ? (
          <Cloud className="w-4 h-4 text-zinc-400 ml-1" />
        ) : (
          <Laptop className="w-4 h-4 text-zinc-400 ml-1" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-900 dark:text-zinc-100 truncate">
            {file && <FileTypeIcon path={file.path} />}
            <span className="truncate">{file ? file.path : workspace.name}</span>
          </div>
          <div className="text-[10.5px] text-zinc-400 truncate">{file ? `${file.size} bytes${file.truncated ? ' · truncated' : ''}` : workspace.root}</div>
        </div>
        <button
          onClick={() => {
            setFile(null);
            setView((v) => (v === 'memory' ? 'files' : 'memory'));
          }}
          className={`relative p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 ${view === 'memory' ? 'text-zinc-900 dark:text-zinc-100 bg-zinc-100 dark:bg-zinc-800' : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}`}
          title="What the agent remembers about this workspace"
          data-testid="memory-toggle"
        >
          <Brain className="w-3.5 h-3.5" />
          {notes.length > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-[3px] rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-[9px] leading-[14px] text-center font-medium">{notes.length}</span>}
        </button>
        <button onClick={refresh} className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800" title="Refresh">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
        <button onClick={onClose} className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800" title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      {error && <div className="mx-3 mt-2 p-2 rounded-lg text-[12px] bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">{error}</div>}

      <div className="flex-1 min-h-0 overflow-auto panel-scroll">
        {view === 'memory' && !file ? (
          <div className="p-3 text-[12.5px]" data-testid="memory-view">
            <p className="text-zinc-500 dark:text-zinc-400 leading-relaxed mb-3">
              Notes the agent saved for itself. They are shown to it at the start of every run in this workspace.
            </p>
            {notes.length === 0 && <div className="text-zinc-400 py-4">Nothing remembered yet. The agent adds notes as it learns how your project works.</div>}
            <ul className="space-y-1.5">
              {notes.map((n) => (
                <li key={n.id} className="group flex items-start gap-2 rounded-lg px-2.5 py-2 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200/70 dark:border-zinc-800">
                  <span className="flex-1 text-zinc-700 dark:text-zinc-200 leading-snug">{n.text}</span>
                  <button
                    onClick={async () => setNotes((await deleteMemoryNote(workspace.id, n.id)).notes)}
                    className="shrink-0 p-1 rounded text-zinc-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    title="Forget this"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            {notes.length > 1 && (
              <button onClick={async () => setNotes((await clearMemory(workspace.id)).notes)} className="mt-3 text-[11.5px] text-zinc-400 hover:text-rose-500">
                Forget everything
              </button>
            )}
          </div>
        ) : file ? (
          fileLoading ? (
            <div className="p-4 text-[12.5px] text-zinc-400">Loading…</div>
          ) : file.binary ? (
            <div className="p-4 text-[12.5px] text-zinc-400">This is a binary file — it can't be shown as text.</div>
          ) : (
            <div className="py-2 text-[12px] leading-[1.35rem] font-mono" data-testid="file-viewer">
              {shown.map((l, i) => (
                <div key={i} className="flex whitespace-pre">
                  <span className="shrink-0 text-right pl-3 pr-3 text-zinc-400/80 select-none" style={{ width: `${gutter + 2}ch` }}>{i + 1}</span>
                  <span className="pr-4 text-zinc-800 dark:text-zinc-200">{l || ' '}</span>
                </div>
              ))}
              {(lines.length > MAX_LINES || file.truncated) && <div className="px-4 py-2 text-zinc-400">… file continues (showing the first {MAX_LINES} lines)</div>}
            </div>
          )
        ) : (
          <div className="py-1.5 px-1.5" data-testid="file-tree">
            {renderDir('.', 0)}
          </div>
        )}
      </div>
    </aside>
  );
};
