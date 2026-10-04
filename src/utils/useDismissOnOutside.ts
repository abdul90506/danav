import { useEffect, useRef, type RefObject } from 'react';

/**
 * One revealed thing at a time: a popover closes when the pointer goes down
 * anywhere outside it, when Escape is pressed, or when a DIFFERENT popover is
 * opened — the last one wins, so the user never has to close a menu before
 * opening the next one.
 *
 * Every menu that appears on click needs this, and every menu that forgets it
 * leaves the user clicking the same little button again to get rid of it, or
 * staring at two menus at once.
 *
 * @param ref      element that contains BOTH the trigger and the popover
 * @param open     whether the popover is currently showing
 * @param onDismiss called once when the user dismisses it
 */

/** Broadcast on open; every other open popover closes when it sees an id that is not its own. */
const OPEN_EVENT = 'danav:popover-open';
let popoverSeq = 0;
/** How many dismissible surfaces are open right now — see `hasOpenPopover`. */
let openPopovers = 0;

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
  if (!idRef.current) idRef.current = `popover-${++popoverSeq}`;
  // The callback is usually an inline arrow: keeping it in a ref means the
  // listeners are not torn down and re-added on every render of the caller.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const dismiss = () => dismissRef.current();

  useEffect(() => {
    if (!open) return;
    openPopovers += 1;
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
      openPopovers = Math.max(0, openPopovers - 1);
      window.removeEventListener(OPEN_EVENT, onOther);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const node = ref.current;
      if (node && event.target instanceof Node && !node.contains(event.target)) dismiss();
    };
    const onKey = (event: Event) => {
      if ((event as globalThis.KeyboardEvent).key === 'Escape') dismiss();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
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
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    openPopovers += 1;
    const onKey = (event: Event) => {
      if ((event as globalThis.KeyboardEvent).key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      openPopovers = Math.max(0, openPopovers - 1);
      document.removeEventListener('keydown', onKey);
    };
  }, [enabled]);
}
