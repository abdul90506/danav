import React from 'react';
import { AlertTriangle, Check, Copy, RotateCcw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  /** Shown as "… could not be displayed", e.g. "The chat". Defaults to "The app". */
  label?: string;
  /**
   * Render only this subtree's fallback instead of a full-page one. Used where a
   * panel can fail without taking the window with it.
   */
  inline?: boolean;
  onReset?: () => void;
}

interface State {
  error: Error | null;
  info: string;
  copied: boolean;
  /** Changing this remounts the subtree, which is what "Try again" needs to do. */
  attempt: number;
}

/**
 * Catches a render crash instead of letting React unmount the whole tree.
 *
 * Without one of these, a single bad property anywhere below the root replaces
 * the entire window with a blank white page and no explanation — the user
 * cannot tell a crash from a hang, and has no reason to believe their chats
 * survived. They did: conversations are written to localStorage as they change,
 * so the honest and useful thing to say is that reloading costs nothing.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: '', copied: false, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep it in the console too: the fallback is for the user, this is for
    // whoever opens devtools afterwards.
    console.error('[blackdesi] render crashed:', error, info.componentStack);
    this.setState({ info: info.componentStack || '' });
  }

  private reset = () => {
    this.props.onReset?.();
    this.setState((s) => ({ error: null, info: '', copied: false, attempt: s.attempt + 1 }));
  };

  private copy = async () => {
    const { error, info } = this.state;
    const report = [
      `BlackDesi error: ${error?.name}: ${error?.message}`,
      `When: ${new Date().toISOString()}`,
      `Page: ${typeof location !== 'undefined' ? location.href : 'unknown'}`,
      '',
      error?.stack || '(no stack)',
      '',
      'Component stack:',
      info.trim() || '(none)',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      // Clipboard is refused in a sandboxed frame; the textarea fallback is the
      // same one the rest of the app uses.
      const area = document.createElement('textarea');
      area.value = report;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch { /* nothing else to try */ }
      area.remove();
    }
    this.setState({ copied: true });
    setTimeout(() => this.setState({ copied: false }), 1800);
  };

  render() {
    const { error, copied } = this.state;
    const { children, label = 'The app', inline } = this.props;
    if (!error) return <React.Fragment key={this.state.attempt}>{children}</React.Fragment>;

    const body = (
      <div className={`w-full ${inline ? '' : 'max-w-md'} rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 shadow-sm`}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <AlertTriangle size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
              {label} could not be displayed
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              Something in this screen hit an error while rendering.{' '}
              <span className="text-zinc-500 dark:text-zinc-500">
                Your chats are saved as they change, so reloading will not lose them.
              </span>
            </p>
            <p className="mt-2 break-words rounded-lg bg-zinc-50 dark:bg-zinc-800/60 px-2.5 py-1.5 font-mono text-[11.5px] text-zinc-600 dark:text-zinc-400">
              {error.name}: {error.message || '(no message)'}
            </p>

            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={this.reset}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 dark:bg-zinc-100 px-3 py-1.5 text-[12.5px] font-medium text-white dark:text-zinc-900 hover:opacity-90 cursor-pointer"
              >
                <RotateCcw size={13} aria-hidden="true" /> Try again
              </button>
              {!inline && (
                <button
                  type="button"
                  onClick={() => location.reload()}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-[12.5px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  Reload the page
                </button>
              )}
              <button
                type="button"
                onClick={this.copy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-[12.5px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer"
              >
                {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy details'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );

    if (inline) return <div className="p-4">{body}</div>;
    return (
      <div role="alert" className="grid min-h-screen w-full place-items-center bg-zinc-50 dark:bg-zinc-950 p-6">
        {body}
      </div>
    );
  }
}
