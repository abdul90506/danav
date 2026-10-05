import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';
import { useEscapeToClose, useFocusTrap } from '../utils/useDismissOnOutside';

/** Never let the panel get uselessly thin, and never squeeze the chat to nothing. */
export const MIN_PREVIEW_WIDTH = 320;
export const MIN_CHAT_WIDTH = 340;

/** Keep the panel inside the window, leaving room for the chat beside it. */
export function clampPreviewWidth(width: number, viewportWidth: number): number {
  const max = Math.max(MIN_PREVIEW_WIDTH, viewportWidth - MIN_CHAT_WIDTH);
  return Math.round(Math.min(Math.max(width, MIN_PREVIEW_WIDTH), max));
}

/** The default split: a bit less than half, like the old fixed `lg:w-[46vw]`. */
export const defaultPreviewWidth = (viewportWidth: number) =>
  clampPreviewWidth(Math.round(viewportWidth * 0.46), viewportWidth);

/**
 * Where the panel edge lands for a pointer that started at `startX` and is now
 * at `currentX`.
 *
 * Dragging LEFT (currentX < startX) makes the panel WIDER — the edge follows the
 * pointer, it does not run away from it.
 */
export function dragWidth(
  startWidth: number,
  startX: number,
  currentX: number,
  viewportWidth: number
): number {
  return clampPreviewWidth(startWidth + (startX - currentX), viewportWidth);
}

/**
 * The URL to actually put in the frame.
 *
 * A preview URL is stable across rebuilds — same port, same host — so the
 * browser is free to answer a fresh navigation out of its own cache and the
 * panel keeps showing the page the agent has since replaced. Naming the load in
 * the query string makes every load a distinct request; the servers that serve
 * previews ignore unknown parameters. The fragment stays last, where it belongs.
 */
export function withCacheBust(url: string, token: string): string {
  const hashAt = url.indexOf('#');
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}__danav=${encodeURIComponent(token)}${hash}`;
}

interface PreviewPanelProps {
  url: string;
  title?: string;
  onClose: () => void;
  /** Desktop width in px; the user drags the divider to change it. */
  width: number;
  onWidthChange: (width: number) => void;
  /**
   * Bump to force a reload without changing the URL. The host raises it every
   * time a preview is opened or the agent announces a fresh one, so the panel
   * always navigates again instead of trusting whatever the frame already holds.
   */
  reloadKey?: number;
}

/** Desktop only: below `lg` the panel slides over the whole screen instead. */
function useIsDesktop(): boolean {
  const query = '(min-width: 1024px)';
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setIsDesktop(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
}

/**
 * The running app the agent built, docked on the right next to the chat.
 *
 * On a phone it slides over the whole screen (the chat stays underneath); on a
 * laptop it takes a share of the width and the chat keeps the rest, with a
 * divider you can drag to trade space between them. Because some servers refuse
 * to be framed, "Open in a new tab" is always one click away.
 */
const PreviewPanelInner: React.FC<PreviewPanelProps> = ({
  url, title, onClose, width, onWidthChange, reloadKey = 0,
}) => {
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const [dragging, setDragging] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  /**
   * Where the drag started and where the pointer is now — kept in a ref so a
   * pointermove never touches React state.
   *
   * This is the whole trick behind a divider that feels glued to the cursor:
   * the width is written straight onto the panel element at most once per
   * frame, and React is told about it exactly once, when the drag ends. A
   * `setState` per move would re-render the entire message list 60+ times a
   * second, which is what made the old divider trail behind the pointer.
   */
  const dragRef = useRef<{ pointerX: number; startWidth: number; pending: number; frame: number } | null>(null);
  const isDesktop = useIsDesktop();
  useEscapeToClose(onClose);
  useFocusTrap(asideRef, !isDesktop);

  const host = url.replace(/^https?:\/\//, '');
  /**
   * Names this particular load. `nonce` covers the Reload button, `reloadKey`
   * covers the host (opening the preview, a fresh preview from the agent, a
   * sandbox that has just been woken). Together they are unique per load, so
   * neither the frame key nor the request can collide with the one before it.
   */
  const loadToken = `${nonce}.${reloadKey}`;

  // Reset the loading state whenever we point at a new URL or reload. The
  // spinner waits a beat before it appears: a refresh of an already-loaded page
  // is usually done before anyone could read the word "Loading", and flashing it
  // on every agent turn would be pure noise.
  useEffect(() => {
    setLoading(true);
    setSlow(false);
    setShowLoading(false); // the delay restarts with every load
    const show = setTimeout(() => setShowLoading(true), 220);
    const late = setTimeout(() => setSlow(true), 4000);
    return () => {
      clearTimeout(show);
      clearTimeout(late);
    };
  }, [url, loadToken]);

  const reload = () => setNonce((n) => n + 1);
  const openInNewTab = () => window.open(url, '_blank', 'noopener,noreferrer');

  // ---- the divider ---------------------------------------------------------

  const beginDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Capture keeps the moves coming even when the cursor outruns the 8px grip.
    // It can throw for a pointer the browser no longer considers active, and a
    // failed capture must not cost us the drag.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the pointerup below still ends the drag */
    }
    dragRef.current = { pointerX: e.clientX, startWidth: width, pending: width, frame: 0 };
    setDragging(true);
  };

  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.pending = dragWidth(drag.startWidth, drag.pointerX, e.clientX, window.innerWidth);
    // Coalesce to one DOM write per frame. Anything more is work the screen
    // cannot show, and it is exactly what makes a drag feel heavy.
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      const d = dragRef.current;
      if (!d) return;
      d.frame = 0;
      if (asideRef.current) asideRef.current.style.width = `${d.pending}px`;
    });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.frame) cancelAnimationFrame(drag.frame);
    dragRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    // The one and only React update of the whole gesture, so the split the user
    // stopped on is what gets remembered.
    onWidthChange(drag.pending);
  };

  // While dragging, a text selection would fight the pointer and the iframe would
  // swallow the moves — so both are turned off for the duration.
  useEffect(() => {
    if (!dragging) return;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.userSelect = previous;
    };
  }, [dragging]);

  const onDividerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 80 : 20;
      if (e.key === 'ArrowLeft') onWidthChange(clampPreviewWidth(width + step, window.innerWidth));
      else if (e.key === 'ArrowRight') onWidthChange(clampPreviewWidth(width - step, window.innerWidth));
      else return;
      e.preventDefault();
    },
    [width, onWidthChange]
  );

  // The width is a live inline style on desktop; on mobile the class wins and the
  // panel covers the screen.
  //
  // `lg:relative`, NOT `lg:static`: relative takes part in the flex row exactly
  // like static does, but it also stays the containing block for the
  // absolutely-positioned divider. With `static` the divider would fly off to
  // some ancestor and there would be nothing to grab.
  return (
    <>
      {!isDesktop && (
        <div aria-hidden="true" onClick={onClose} className="fixed inset-0 z-30 bg-zinc-900/35 backdrop-blur-[1px] lg:hidden" />
      )}
      <aside
        ref={asideRef}
        // While a drag is in flight the ref holds the truth; React catches up on
        // release. At rest this is just the width the app remembers.
        style={isDesktop ? { width: dragging && dragRef.current ? dragRef.current.pending : width } : undefined}
        className="fixed lg:relative inset-y-0 right-0 z-40 flex flex-col h-full min-w-0 w-[min(96vw,720px)] lg:shrink-0 bg-white dark:bg-zinc-950 border-l border-zinc-200 dark:border-zinc-800 shadow-xl lg:shadow-none animate-in fade-in duration-150"
        data-testid="preview-panel"
        role={isDesktop ? undefined : 'dialog'}
        aria-modal={!isDesktop ? 'true' : undefined}
        aria-labelledby="preview-panel-title"
        aria-busy={loading}
      >
      {/* Drag the divider left to grow the preview, right to grow the chat. */}
      {isDesktop && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the preview"
          aria-valuemin={MIN_PREVIEW_WIDTH}
          aria-valuemax={Math.max(MIN_PREVIEW_WIDTH, window.innerWidth - MIN_CHAT_WIDTH)}
          aria-valuenow={width}
          aria-valuetext={`${width} pixels wide`}
          aria-keyshortcuts="ArrowLeft ArrowRight"
          tabIndex={0}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onDividerKeyDown}
          title="Drag to resize · double-click to reset"
          onDoubleClick={() => onWidthChange(defaultPreviewWidth(window.innerWidth))}
          className={`group absolute left-[-4px] top-0 bottom-0 z-20 hidden lg:flex w-2 cursor-col-resize touch-none items-center justify-center focus:outline-none ${
            dragging ? '' : 'focus-visible:bg-zinc-200/60 dark:focus-visible:bg-zinc-700/50'
          }`}
          data-testid="preview-resize-handle"
        >
          <span
            className={`w-[3px] rounded-full transition-colors ${
              dragging
                ? 'bg-zinc-500 dark:bg-zinc-400'
                : 'bg-zinc-200 dark:bg-zinc-700 group-hover:bg-zinc-400 dark:group-hover:bg-zinc-500 group-focus-visible:bg-zinc-400'
            }`}
            style={{ height: dragging ? '100%' : '2.5rem' }}
          />
        </div>
      )}

      {/* A hairline of a bar: title, host and three buttons on one 24px row. */}
      <div className="flex items-center gap-1.5 h-6 px-2 border-b border-zinc-200/80 dark:border-zinc-800">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
        <h2 id="preview-panel-title" className="shrink-0 max-w-[45%] truncate text-[12px] font-medium leading-none text-zinc-900 dark:text-zinc-100">
          {title || 'Preview'}
        </h2>
        <span className="flex-1 min-w-0 truncate text-[11px] leading-none text-zinc-400">{host}</span>

        <div className="flex items-center gap-px shrink-0">
          <button
            type="button"
            onClick={reload}
            className="p-0.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title="Reload preview"
            aria-label="Reload preview"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          </button>
          <button
            type="button"
            onClick={openInNewTab}
            className="p-0.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title="Open in a new tab"
            aria-label="Open in a new tab"
            data-testid="preview-open-tab"
          >
            <ExternalLink className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={onClose}
            data-dialog-initial-focus
            className="p-0.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title="Close preview"
            aria-label="Close preview"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 min-w-0 relative overflow-hidden bg-zinc-50 dark:bg-zinc-900">
        {loading && showLoading && (
          <div role="status" aria-live="polite" className="absolute inset-0 z-10 grid place-items-center px-6 text-center text-[12px] text-zinc-400">
            {slow ? (
              <span>
                Still loading… If nothing appears, the page may refuse to be embedded.{' '}
                <button type="button" onClick={openInNewTab} className="underline hover:text-zinc-600 dark:hover:text-zinc-200">
                  Open it in a new tab
                </button>
                .
              </span>
            ) : (
              'Loading preview…'
            )}
          </div>
        )}
        {/*
          The frame is exactly the panel: it has no intrinsic width of its own, so
          as the divider moves the embedded page sees a new viewport every frame
          and its own media queries re-flow with it. That is what makes the
          previewed site behave responsively at any split.

          The key carries the load token, so a new token remounts the frame — a
          real navigation — and the src carries it too, so the browser cannot
          answer that navigation from a cached copy of the previous build.
        */}
        <iframe
          key={`${url}#${loadToken}`}
          ref={frameRef}
          src={withCacheBust(url, loadToken)}
          title={title || 'Preview'}
          onLoad={() => {
            setLoading(false);
            setShowLoading(false);
          }}
          className={`block w-full h-full border-0 bg-white ${dragging ? 'pointer-events-none' : ''}`}
          referrerPolicy="no-referrer"
          allow="clipboard-write; fullscreen"
        />
      </div>
      </aside>
    </>
  );
};

/**
 * Memoised: an agent run re-renders the app on every streamed token, and with the
 * preview open that meant diffing the whole panel (iframe and all) hundreds of
 * times per answer. Every prop here is stable between runs, so React now skips it.
 */
export const PreviewPanel = React.memo(PreviewPanelInner);
PreviewPanel.displayName = 'PreviewPanel';
