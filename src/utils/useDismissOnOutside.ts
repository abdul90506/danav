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
    // Tell the others, then listen for whichever of them opens next.
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: idRef.current }));
    const onOther = (event: Event) => {
      if ((event as CustomEvent).detail !== idRef.current) dismiss();
    };
    window.addEventListener(OPEN_EVENT, onOther);
    return () => window.removeEventListener(OPEN_EVENT, onOther);
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
