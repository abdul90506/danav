import React, { useEffect, useState } from 'react';
import { Check, Cloud, ExternalLink, Laptop, Loader2, X } from 'lucide-react';
import type { AgentConfig, AgentWorkspace } from '../types';
import { createWorkspace, saveNovitaKey } from '../services/agentApi';
import { useEscapeToClose } from '../utils/useDismissOnOutside';

interface WorkspaceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  config: AgentConfig | null;
  /** Called after a workspace was created (and the Novita key, if one was entered, saved). */
  onCreated: (workspace: AgentWorkspace) => void;
  onConfigChanged: () => void;
}

const field =
  'w-full h-9 px-3 text-[13px] bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-400 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400';

/** "New workspace": a cloud sandbox (Novita) or a folder on this machine. */
export const WorkspaceDialog: React.FC<WorkspaceDialogProps> = ({ isOpen, onClose, config, onCreated, onConfigChanged }) => {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'sandbox' | 'local'>('sandbox');
  const [folder, setFolder] = useState('');
  const [askFirst, setAskFirst] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setFolder('');
    setApiKey('');
    setError('');
    setBusy(false);
    setKind('sandbox');
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setAskFirst(kind === 'local');
  }, [kind]);

  // Escape closes it — unless the dialog is mid-save. Shared rule: see useEscapeToClose.
  useEscapeToClose(() => {
    if (!busy) onClose();
  }, isOpen);

  if (!isOpen) return null;

  const needsKey = kind === 'sandbox' && !config?.novita.configured;
  const defaultDir = config?.local.workspacesDir || '~/danav-workspaces';

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      if (needsKey) {
        if (!apiKey.trim()) throw new Error('Paste your Novita API key first.');
        await saveNovitaKey(apiKey.trim());
        setApiKey('');
        onConfigChanged();
      }
      const ws = await createWorkspace({
        name: name.trim() || undefined,
        kind,
        path: kind === 'local' && folder.trim() ? folder.trim() : undefined,
        autoRun: kind === 'local' ? !askFirst : true,
      });
      onCreated(ws);
    } catch (e: any) {
      setError(e?.message || 'Could not create the workspace.');
    } finally {
      setBusy(false);
    }
  };

  const option = (value: 'sandbox' | 'local', title: string, desc: string, Icon: React.ElementType) => (
    <button
      type="button"
      onClick={() => setKind(value)}
      className={`flex-1 text-left p-3 rounded-xl border transition-colors ${
        kind === value
          ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-50 dark:bg-zinc-800/60'
          : 'border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
      }`}
      data-testid={`kind-${value}`}
    >
      <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
        <Icon className="w-4 h-4 text-zinc-500" />
        {title}
        {kind === value && <Check className="w-3.5 h-3.5 ml-auto" />}
      </div>
      <p className="mt-1 text-[12px] leading-snug text-zinc-500 dark:text-zinc-400">{desc}</p>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/40 backdrop-blur-sm animate-in fade-in duration-150" onMouseDown={() => !busy && onClose()}>
      <div
        className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="New workspace"
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-200/80 dark:border-zinc-800">
          <h2 className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">New workspace</h2>
          <button onClick={onClose} disabled={busy} className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-[12px] font-medium text-zinc-600 dark:text-zinc-300 mb-1.5">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-project" className={field} autoFocus data-testid="ws-name" />
          </div>

          <div>
            <label className="block text-[12px] font-medium text-zinc-600 dark:text-zinc-300 mb-1.5">Where should the agent work?</label>
            <div className="flex gap-2">
              {option('sandbox', 'Cloud sandbox', 'An isolated Linux computer from Novita. Safe to experiment in; web apps get a public preview link.', Cloud)}
              {option('local', 'This machine', 'A folder on the computer running Danav — files appear right on your disk.', Laptop)}
            </div>
          </div>

          {kind === 'sandbox' && (
            <div className="text-[12px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
              {config?.novita.configured ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <Check className="w-3.5 h-3.5" /> Novita is connected{config.novita.source === 'env' ? ' (from .env)' : ''}.
                </span>
              ) : (
                <>
                  <label className="block text-[12px] font-medium text-zinc-600 dark:text-zinc-300 mb-1.5">Novita API key</label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk_…"
                    className={`${field} font-mono`}
                    autoComplete="off"
                    data-testid="novita-key"
                  />
                  <p className="mt-1.5">
                    Stored on this server only (never sent to the browser or the AI model).{' '}
                    <a href="https://novita.ai/settings/key-management" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 underline hover:text-zinc-800 dark:hover:text-zinc-200">
                      Get a key <ExternalLink className="w-3 h-3" />
                    </a>
                  </p>
                </>
              )}
            </div>
          )}

          {kind === 'local' && (
            <div className="space-y-3">
              <div>
                <label className="block text-[12px] font-medium text-zinc-600 dark:text-zinc-300 mb-1.5">
                  Folder <span className="font-normal text-zinc-400">(optional)</span>
                </label>
                <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={`${defaultDir}/${name.trim() ? name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-') : 'my-project'}`} className={`${field} font-mono text-[12px]`} data-testid="ws-folder" />
                <p className="mt-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">
                  {config?.local.allowAnyPath
                    ? 'Any absolute folder works. Leave empty to create a new one.'
                    : `Leave empty to create a new folder in ${defaultDir}. To open any folder, start Danav with DANAV_ALLOW_ANY_LOCAL_PATH=1.`}
                </p>
              </div>
              <label className="flex items-start gap-2 text-[12px] text-zinc-700 dark:text-zinc-300 cursor-pointer">
                <input type="checkbox" checked={askFirst} onChange={(e) => setAskFirst(e.target.checked)} className="mt-0.5 accent-zinc-800" />
                <span>
                  Ask me before running commands
                  <span className="block text-[12px] text-zinc-400">Recommended — commands run as you, on your real machine.</span>
                </span>
              </label>
            </div>
          )}

          {error && (
            <div className="p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 text-[12px] text-rose-700 dark:text-rose-300" data-testid="ws-error">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900">
          <button onClick={onClose} disabled={busy} className="h-8 px-3 rounded-lg text-[12px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="h-8 px-4 rounded-lg text-[12px] font-medium bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 inline-flex items-center gap-1.5 disabled:opacity-70"
            data-testid="ws-create"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {busy ? (kind === 'sandbox' ? 'Starting sandbox…' : 'Creating…') : needsKey ? 'Connect & create' : 'Create workspace'}
          </button>
        </div>
      </div>
    </div>
  );
};
