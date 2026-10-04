import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, Cloud, Copy, Loader2, Pause, Play, RefreshCw, Server, Trash2, X, Zap,
} from 'lucide-react';
import type { AgentConfig, SandboxState, SandboxSummary, SandboxTotals } from '../types';
import { killSandbox, listSandboxes, pauseSandbox, resumeSandbox, updateWorkspace } from '../services/agentApi';
import { useEscapeToClose } from '../utils/useDismissOnOutside';

interface SandboxManagerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  config: AgentConfig | null;
  /** A sandbox changed: the app should re-read its workspaces. */
  onChanged: () => void;
  /** A run is in flight in this workspace — do not let the user pull the rug. */
  busyWorkspaceId?: string | null;
}

type Filter = 'all' | 'running' | 'paused';

const EMPTY_TOTALS: SandboxTotals = { all: 0, running: 0, paused: 0, orphans: 0 };

/** "2m 10s" — a countdown, so it must be readable at a glance and never negative. */
function untilText(at: number | null, now: number): string | null {
  if (!at) return null;
  const ms = at - now;
  if (ms <= 0) return 'any moment';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "21m ago" / "just now" */
function agoText(at: number | null, now: number): string | null {
  if (!at) return null;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STATE_STYLE: Record<SandboxState, { dot: string; text: string; label: string }> = {
  running: { dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', label: 'Running' },
  paused: { dot: 'bg-zinc-400 dark:bg-zinc-500', text: 'text-zinc-500 dark:text-zinc-400', label: 'Paused' },
  gone: { dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400', label: 'Deleted' },
};

const btn =
  'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-medium border transition-colors disabled:opacity-50 disabled:cursor-default';

/**
 * Every sandbox in the Novita account — not just the ones this app still
 * remembers. A running sandbox bills by the second, and leftovers from old
 * sessions are invisible from the agent's own workspace list, so this is the
 * place to notice them and put them to sleep.
 */
export const SandboxManagerDialog: React.FC<SandboxManagerDialogProps> = ({
  isOpen, onClose, config, onChanged, busyWorkspaceId,
}) => {
  const [sandboxes, setSandboxes] = useState<SandboxSummary[]>([]);
  const [totals, setTotals] = useState<SandboxTotals>(EMPTY_TOTALS);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  /** sandboxId currently being paused / resumed / deleted. */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** sandboxId awaiting delete confirmation. */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** Drives the "sleeps in …" countdowns without re-fetching. */
  const [now, setNow] = useState(() => Date.now());
  const openRef = useRef(isOpen);
  openRef.current = isOpen;

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await listSandboxes();
      setSandboxes(res.sandboxes);
      setTotals(res.totals);
      setConfigured(res.configured);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not read the sandboxes from Novita.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Opening the dialog: fetch fresh, then keep it live while it is on screen.
  useEffect(() => {
    if (!isOpen) return;
    setFilter('all');
    setConfirmId(null);
    setError('');
    void load();
    const poll = setInterval(() => {
      if (openRef.current) void load(true);
    }, 10_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [isOpen, load]);

  // Escape closes it — unless an action is in flight. Registered through the shared
  // rule so the key does not also reach the chat and stop a running turn.
  useEscapeToClose(() => {
    if (!busyId) onClose();
  }, isOpen);

  /** Run one action, then re-read the account so the list is never stale. */
  const act = async (sandboxId: string, fn: () => Promise<unknown>) => {
    setBusyId(sandboxId);
    setError('');
    try {
      await fn();
      onChanged();
    } catch (e: any) {
      setError(e?.message || 'That did not work.');
    } finally {
      setBusyId(null);
      setConfirmId(null);
      await load(true);
    }
  };

  const toggleAutoPause = async (w: SandboxSummary) => {
    if (!w.workspaceId) return;
    setBusyId(w.sandboxId);
    setError('');
    try {
      await updateWorkspace(w.workspaceId, { autoPause: !w.autoPause });
      onChanged();
    } catch (e: any) {
      setError(e?.message || 'Could not change the auto-pause setting.');
    } finally {
      setBusyId(null);
      await load(true);
    }
  };

  const copyId = async (sandboxId: string) => {
    try {
      await navigator.clipboard.writeText(sandboxId);
      setCopiedId(sandboxId);
      setTimeout(() => setCopiedId((c) => (c === sandboxId ? null : c)), 1400);
    } catch {
      /* clipboard blocked: the id is selectable anyway */
    }
  };

  const shown = useMemo(
    () => (filter === 'all' ? sandboxes : sandboxes.filter((s) => s.state === filter)),
    [sandboxes, filter]
  );

  const policy = config?.sandbox;
  const idleLabel = policy ? `${Math.round(policy.idlePauseSeconds / 60)} min` : 'a few minutes';
  const graceLabel = policy ? `${policy.runGraceSeconds}s` : 'a minute';

  if (!isOpen) return null;

  const chip = (key: Filter, label: string, count: number, tone = '') => (
    <button
      type="button"
      onClick={() => setFilter(key)}
      className={`h-6 px-2 rounded-full text-[11px] font-medium border transition-colors ${
        filter === key
          ? 'bg-zinc-900 text-white border-transparent dark:bg-zinc-100 dark:text-zinc-900'
          : `bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${tone}`
      }`}
      data-testid={`sandbox-filter-${key}`}
    >
      {label} {count}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/40 backdrop-blur-sm animate-in fade-in duration-150"
      onMouseDown={() => !busyId && onClose()}
      data-testid="sandbox-dialog"
    >
      <div
        className="w-full max-w-2xl max-h-[88vh] flex flex-col bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Sandboxes"
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-200/80 dark:border-zinc-800">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">Sandboxes</h2>
            <p className="text-[12px] text-zinc-500 dark:text-zinc-400 truncate">
              Everything in your Novita account — including ones Danav no longer tracks.
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => load()}
              disabled={loading}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              title="Refresh"
              data-testid="sandbox-refresh"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </button>
            <button
              onClick={onClose}
              disabled={!!busyId}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* What the auto-pause policy actually does — otherwise a sleeping
            sandbox looks like a bug. */}
        <div className="px-5 py-2.5 border-b border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/60">
          <div className="flex items-start gap-2 text-[12px] leading-snug text-zinc-600 dark:text-zinc-300">
            <Zap className="w-3.5 h-3.5 mt-[1px] shrink-0 text-amber-500" />
            <p>
              Sandboxes bill while <span className="font-medium">running</span>. Danav pauses the ones it manages after{' '}
              <span className="font-medium">{idleLabel}</span> with no activity, or <span className="font-medium">{graceLabel}</span>{' '}
              after a run finishes — whichever comes first. Paused sandboxes keep their files and cost nothing.
            </p>
          </div>
          {totals.orphans > 0 && (
            <div className="flex items-start gap-2 mt-1.5 text-[12px] leading-snug text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 mt-[1px] shrink-0" />
              <p>
                {totals.orphans} running sandbox{totals.orphans === 1 ? '' : 'es'} belong to no workspace here. They are never
                auto-paused — pause or delete them below.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 px-5 py-2.5 border-b border-zinc-200/80 dark:border-zinc-800">
          {chip('all', 'All', totals.all)}
          {chip('running', 'Running', totals.running, 'text-emerald-700 dark:text-emerald-400')}
          {chip('paused', 'Paused', totals.paused)}
        </div>

        {error && (
          <div className="mx-5 mt-3 p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 text-[12px] text-rose-700 dark:text-rose-300" data-testid="sandbox-error">
            {error}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto panel-scroll p-3 space-y-2">
          {!configured && (
            <div className="p-4 text-center text-[12px] text-zinc-500 dark:text-zinc-400">
              No Novita API key yet. Create a cloud workspace first — the key is asked for there.
            </div>
          )}

          {configured && !loading && shown.length === 0 && (
            <div className="p-6 text-center text-[12px] text-zinc-400">
              {filter === 'all' ? 'No sandboxes in this account.' : `No ${filter} sandboxes.`}
            </div>
          )}

          {shown.map((s) => {
            const style = STATE_STYLE[s.state];
            const busy = busyId === s.sandboxId;
            const runBusy = Boolean(s.workspaceId && s.workspaceId === busyWorkspaceId);
            const sleepsIn = s.state === 'running' && s.autoPause ? untilText(s.endAt, now) : null;
            const spec = [s.cpuCount ? `${s.cpuCount} vCPU` : null, s.memoryMB ? `${s.memoryMB} MB` : null]
              .filter(Boolean)
              .join(' · ');

            return (
              <div
                key={s.sandboxId}
                className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 px-3 py-2.5"
                data-testid={`sandbox-row-${s.sandboxId}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${style.dot} ${s.state === 'running' ? 'animate-pulse' : ''}`} />
                  <span className={`text-[12px] font-medium shrink-0 ${style.text}`}>{style.label}</span>

                  <span className="flex items-center gap-1.5 min-w-0 text-[12px] text-zinc-800 dark:text-zinc-100">
                    {s.isDanav ? (
                      <Cloud className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
                    ) : (
                      <Server className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
                    )}
                    <span className="truncate font-medium">{s.workspaceName || s.name || s.templateId || 'sandbox'}</span>
                  </span>

                  {s.isDanav && (
                    <span className="shrink-0 px-1.5 py-[1px] rounded text-[10px] font-medium bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
                      Danav
                    </span>
                  )}
                  {!s.managed && s.isDanav && (
                    <span className="shrink-0 px-1.5 py-[1px] rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400">
                      no workspace
                    </span>
                  )}

                  <span className="ml-auto flex items-center gap-1 shrink-0">
                    {s.state === 'running' ? (
                      <button
                        type="button"
                        disabled={busy || runBusy}
                        onClick={() => act(s.sandboxId, () => pauseSandbox(s.sandboxId))}
                        title={runBusy ? 'The agent is running in this sandbox' : 'Pause — stops billing, keeps files and processes'}
                        className={`${btn} text-zinc-700 dark:text-zinc-200 border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800`}
                        data-testid={`sandbox-pause-${s.sandboxId}`}
                      >
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pause className="w-3.5 h-3.5" />}
                        Pause
                      </button>
                    ) : s.state === 'paused' ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => act(s.sandboxId, () => resumeSandbox(s.sandboxId))}
                        title="Resume — wakes in about a second"
                        className={`${btn} text-zinc-700 dark:text-zinc-200 border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800`}
                        data-testid={`sandbox-resume-${s.sandboxId}`}
                      >
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                        Resume
                      </button>
                    ) : null}

                    {confirmId === s.sandboxId ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => act(s.sandboxId, () => killSandbox(s.sandboxId))}
                          className={`${btn} text-white bg-rose-600 hover:bg-rose-700 border-transparent`}
                          data-testid={`sandbox-confirm-delete-${s.sandboxId}`}
                        >
                          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                          Delete for good
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmId(null)}
                          className={`${btn} text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800`}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={busy || runBusy || s.state === 'gone'}
                        onClick={() => setConfirmId(s.sandboxId)}
                        title={runBusy ? 'The agent is running in this sandbox' : 'Terminate and delete its disk (cannot be undone)'}
                        className={`${btn} text-zinc-400 border-transparent hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40`}
                        data-testid={`sandbox-delete-${s.sandboxId}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </span>
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                  <button
                    type="button"
                    onClick={() => copyId(s.sandboxId)}
                    className="inline-flex items-center gap-1 font-mono hover:text-zinc-800 dark:hover:text-zinc-200"
                    title="Copy the sandbox id"
                  >
                    {s.sandboxId}
                    {copiedId === s.sandboxId ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3 opacity-60" />}
                  </button>
                  {spec && <span>· {spec}</span>}
                  {s.state === 'running' && agoText(s.startedAt, now) && <span>· started {agoText(s.startedAt, now)}</span>}
                  {sleepsIn && <span className="text-amber-600 dark:text-amber-400">· sleeps in {sleepsIn}</span>}
                </div>

                {s.managed && s.workspaceId && (
                  <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 cursor-pointer w-fit">
                    <input
                      type="checkbox"
                      checked={s.autoPause !== false}
                      disabled={busy}
                      onChange={() => toggleAutoPause(s)}
                      className="accent-zinc-800 dark:accent-zinc-200"
                      data-testid={`sandbox-autopause-${s.sandboxId}`}
                    />
                    Pause automatically when idle
                  </label>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900 text-[11px] text-zinc-500 dark:text-zinc-400">
          Novita also pauses a sandbox on its own after {policy ? `${policy.timeoutMinutes} min` : 'a while'} without activity.
          Deleting destroys the sandbox's disk — its files are gone.
        </div>
      </div>
    </div>
  );
};
