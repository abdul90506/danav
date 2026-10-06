import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Gauge, Loader2, RefreshCw } from 'lucide-react';

/**
 * What is left of today's request budget.
 *
 * A Gemini key is budgeted per MODEL, so eight keys across four models is
 * thirty-two separate allowances, not one. That is impossible to hold in your
 * head and it is the number that decides whether the next message works, so it
 * is shown in full: the totals big, each model under them, and each key's own
 * minute and day behind one click.
 */

export interface QuotaKey {
  credentialIndex: number;
  rpm: number;
  rpd: number;
  minuteUsed: number;
  dayUsed: number;
  minuteLeft: number;
  dayLeft: number;
  cooling: boolean;
  available: boolean;
  /** Null means "not until the daily reset", which is a different wait. */
  readyInMs: number | null;
}

export interface QuotaModel {
  model: string;
  rpm: number;
  rpd: number;
  /** True once the provider has stated these numbers itself. */
  confirmed: boolean;
  /** The provider called this model busy; it is skipped for this long. */
  busyInMs: number;
  minuteUsed: number;
  minuteLimit: number;
  dayUsed: number;
  dayLimit: number;
  keysAvailable: number;
  readyInMs: number | null;
  keys: QuotaKey[];
}

export interface QuotaProvider {
  providerId: string;
  name: string;
  credentialCount: number;
  day: string;
  resetsAt: string;
  resetsAtMs: number;
  minuteUsed: number;
  minuteLimit: number;
  dayUsed: number;
  dayLimit: number;
  models: QuotaModel[];
}

/** Green while there is room, amber when it is nearly gone, red when it is. */
export function barTone(used: number, limit: number): string {
  if (limit <= 0) return 'bg-zinc-300 dark:bg-zinc-700';
  const left = (limit - used) / limit;
  if (left <= 0) return 'bg-rose-500';
  if (left < 0.25) return 'bg-amber-500';
  return 'bg-emerald-500';
}

const pct = (used: number, limit: number) =>
  limit <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((used / limit) * 100)));

/** A wait, in the largest unit that is still honest about it. */
export function waitLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'the daily reset';
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function Bar({ used, limit }: { used: number; limit: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${barTone(used, limit)}`}
        style={{ width: `${pct(used, limit)}%` }}
      />
    </div>
  );
}

function Totals({ label, used, limit }: { label: string; used: number; limit: number }) {
  return (
    <div className="flex-1">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</span>
        <span className="font-mono text-[13px] tabular-nums text-zinc-800 dark:text-zinc-100">
          {used.toLocaleString()} <span className="text-zinc-400">/ {limit.toLocaleString()}</span>
        </span>
      </div>
      <Bar used={used} limit={limit} />
    </div>
  );
}

/** One key's remaining minute and day on one model. */
function KeyCell({ entry }: { entry: QuotaKey }) {
  const spentToday = entry.dayLeft <= 0;
  const tone = entry.available
    ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/20 dark:bg-emerald-500/5'
    : spentToday
      ? 'border-rose-200 bg-rose-50/60 dark:border-rose-500/20 dark:bg-rose-500/5'
      : 'border-amber-200 bg-amber-50/60 dark:border-amber-500/20 dark:bg-amber-500/5';
  const state = entry.available
    ? 'ready'
    : spentToday
      ? 'done for today'
      : `back in ${waitLabel(entry.readyInMs)}`;
  return (
    <div className={`rounded-lg border px-2 py-1.5 ${tone}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
          Key {entry.credentialIndex + 1}
        </span>
        <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{state}</span>
      </div>
      <div className="mt-0.5 font-mono text-[11px] tabular-nums text-zinc-700 dark:text-zinc-200">
        {entry.minuteLeft}/{entry.rpm} <span className="text-zinc-400">min</span>
        {' · '}
        {entry.dayLeft}/{entry.rpd} <span className="text-zinc-400">day</span>
      </div>
    </div>
  );
}

export function QuotaPanel() {
  const [providers, setProviders] = useState<QuotaProvider[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/quota', { headers: { Accept: 'application/json' } });
      const body = await res.json();
      if (!res.ok || !body?.success) throw new Error(body?.error || `HTTP ${res.status}`);
      setProviders(body.providers || []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the quota ledger.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // The per-minute window is the fast-moving half, so a five-second refresh
    // is enough to watch a key recover without polling for the sake of it.
    const timer = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(timer);
  }, [load]);

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (error) {
    return <p className="text-[13px] text-rose-600 dark:text-rose-400">{error}</p>;
  }
  if (!providers) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-zinc-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the request ledger…
      </p>
    );
  }
  if (!providers.length) {
    return (
      <p className="text-[13px] text-zinc-500 dark:text-zinc-400">
        No provider has request limits turned on yet. Switch on{' '}
        <strong>Spread requests across keys and models</strong> for a provider in Providers &amp; Models, and its
        per-key, per-model budget appears here.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {providers.map((provider) => (
        <div key={provider.providerId} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-zinc-500" />
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">{provider.name}</span>
              <span className="text-[12px] text-zinc-500">
                {provider.credentialCount} key{provider.credentialCount === 1 ? '' : 's'} ·{' '}
                {provider.models.length} model{provider.models.length === 1 ? '' : 's'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => { void load(); }}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>

          <div className="mb-4 flex gap-5">
            <Totals label="Requests this minute" used={provider.minuteUsed} limit={provider.minuteLimit} />
            <Totals label="Requests today" used={provider.dayUsed} limit={provider.dayLimit} />
          </div>

          <div className="space-y-1">
            {provider.models.map((model) => {
              const rowKey = `${provider.providerId}:${model.model}`;
              const open = expanded.has(rowKey);
              const exhausted = model.keysAvailable === 0;
              return (
                <div key={model.model} className="rounded-lg">
                  <button
                    type="button"
                    onClick={() => toggle(rowKey)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-3 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  >
                    <ChevronRight
                      className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[13px] text-zinc-700 dark:text-zinc-300" title={model.model}>
                          {model.model.replace(/^models\//, '')}
                        </span>
                        <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-zinc-500">
                          {model.dayUsed}/{model.dayLimit} today · {model.minuteUsed}/{model.minuteLimit} now
                        </span>
                      </div>
                      <Bar used={model.dayUsed} limit={model.dayLimit} />
                    </div>
                    {model.busyInMs > 0 && (
                      <span
                        className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
                        title="The provider says this model is under heavy demand. Danav steps over it and uses another one; it is not using up your allowance."
                      >
                        busy {Math.ceil(model.busyInMs / 1000)}s
                      </span>
                    )}
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] tabular-nums ${
                        exhausted
                          ? 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400'
                          : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                      }`}
                      title={`${model.keysAvailable} of ${provider.credentialCount} keys can take a request right now (${model.rpm}/min, ${model.rpd}/day each — ${model.confirmed ? 'as stated by the provider' : 'assumed until the provider says otherwise'})`}
                    >
                      {exhausted ? `back in ${waitLabel(model.readyInMs)}` : `${model.keysAvailable}/${provider.credentialCount} free`}
                    </span>
                  </button>
                  {open && (
                    <div className="grid grid-cols-2 gap-1.5 px-1.5 pb-2 pl-7 sm:grid-cols-4">
                      {model.keys.map((entry) => (
                        <KeyCell key={entry.credentialIndex} entry={entry} />
                      ))}
                      <p className="col-span-2 text-[10.5px] text-zinc-400 sm:col-span-4">
                        {model.confirmed
                          ? `${model.rpm} a minute and ${model.rpd} a day per key, as stated by the provider when it last refused a request.`
                          : `${model.rpm} a minute and ${model.rpd} a day per key is an assumption. Danav never refuses to send on an assumption — if it is wrong, the provider says so and the real figure is learned from the refusal.`}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p className="mt-3 text-[11.5px] text-zinc-400 dark:text-zinc-500">
            Every key has its own allowance on every model, so the totals are all of them added together. Pick{' '}
            <strong>Auto</strong> in the model menu to let Danav choose a pair that still has room. Today&apos;s counts
            reset in {waitLabel(provider.resetsAtMs - Date.now())}, at {provider.resetsAt}.
          </p>
        </div>
      ))}
    </div>
  );
}
