import { useEffect, useRef, type RefObject } from 'react';

/**
 * One revealed thing at a time: a popover closes when the pointer goes down
 * anywhere outside it, when Escape is pressed, or when a DIFFERENT popover is
 * opened — the last one wins, so the user never has to close a menu before
 * opening the next one.
 *
 * Nested details are allowed (a trail can contain an open action row). Escape
 * closes the most recently opened surface first, rather than collapsing every
 * accordion in the chain at once.
 *
 * @param ref      element that contains BOTH the trigger and the popover
 * @param open     whether the popover is currently showing
 * @param onDismiss called once when the user dismisses it
 */

/** Broadcast on open; every other open popover closes when it sees an id that is not its own. */
const OPEN_EVENT = 'blackdesi:popover-open';
let surfaceSeq = 0;
/** How many dismissible surfaces are open right now — see `hasOpenPopover`. */
let openPopovers = 0;
/** Open order lets nested surfaces answer Escape one at a time. */
let openSurfaceOrder: string[] = [];

function registerSurface(id: string): void {
  if (!openSurfaceOrder.includes(id)) openPopovers += 1;
  openSurfaceOrder = openSurfaceOrder.filter((openId) => openId !== id);
  openSurfaceOrder.push(id);
}

function unregisterSurface(id: string): void {
  if (!openSurfaceOrder.includes(id)) return;
  openSurfaceOrder = openSurfaceOrder.filter((openId) => openId !== id);
  openPopovers = Math.max(0, openPopovers - 1);
}

function isTopSurface(id: string): boolean {
  return openSurfaceOrder[openSurfaceOrder.length - 1] === id;
}

/**
 * Is anything revealed at this moment (a menu, an action row's detail, an open
 * thought, a web tool's output)?
 *
 * Escape belongs to whatever is open first. The app also uses Escape to stop a
 * running agent turn, and without this the two fight: a user pressing Escape to
 * put a panel away would stop their own run instead.
 */
export function hasOpenPopover(): boolean {
  return openPopovers > 0;
}

export function useDismissOnOutside(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void
): void {
  const idRef = useRef('');
  if (!idRef.current) idRef.current = `surface-${++surfaceSeq}`;
  // The callback is usually an inline arrow: keeping it in a ref means the
  // listeners are not torn down and re-added on every render of the caller.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const dismiss = () => dismissRef.current();

  useEffect(() => {
    if (!open) return;
    registerSurface(idRef.current);
    // Tell the others, then listen for whichever of them opens next.
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { id: idRef.current, node: ref.current } }));
    const onOther = (event: Event) => {
      const detail = (event as CustomEvent).detail as { id: string; node: Node | null } | undefined;
      if (!detail || detail.id === idRef.current) return;
      // A panel opened INSIDE this one belongs to it: the work row's trail holds
      // the action rows, and opening a diff in there must not close the trail
      // that was just opened to read it.
      const node = ref.current;
      if (node && detail.node && node.contains(detail.node)) return;
      dismiss();
    };
    window.addEventListener(OPEN_EVENT, onOther);
    return () => {
      unregisterSurface(idRef.current);
      window.removeEventListener(OPEN_EVENT, onOther);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const node = ref.current;
      if (node && event.target instanceof Node && !node.contains(event.target)) dismiss();
    };
    const onKey = (event: Event) => {
      const keyboardEvent = event as globalThis.KeyboardEvent;
      if (keyboardEvent.key !== 'Escape' || !isTopSurface(idRef.current)) return;
      dismiss();
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open]);
}

/**
 * Escape closes this surface, and the app knows it is up.
 *
 * Menus use `useDismissOnOutside` above; a modal or a full panel does not want
 * "clicking outside closes it" (it is the page while it is open), but it does
 * want the same Escape — and it has to count as revealed, or the key would close
 * the dialog and stop a running agent turn at the same time.
 */
export function useEscapeToClose(onClose: () => void, enabled = true): void {
  const idRef = useRef('');
  if (!idRef.current) idRef.current = `surface-${++surfaceSeq}`;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    registerSurface(idRef.current);
    const onKey = (event: Event) => {
      const keyboardEvent = event as globalThis.KeyboardEvent;
      if (keyboardEvent.key !== 'Escape' || !isTopSurface(idRef.current)) return;
      closeRef.current();
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      unregisterSurface(idRef.current);
      document.removeEventListener('keydown', onKey);
    };
  }, [enabled]);
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Keep keyboard focus inside a revealed modal/drawer, and return it on close. */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return;
    const container = ref.current;
    if (!container) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const getFocusable = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
        if (element.matches(':disabled') || element.closest('[hidden], [aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      });

    const preferred = container.querySelector<HTMLElement>('[data-dialog-initial-focus]');
    if (!container.contains(document.activeElement)) {
      const first = preferred || getFocusable()[0] || container;
      first.focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!container.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [enabled, ref]);
}
