import { useEffect, type RefObject } from 'react';

/**
 * One revealed thing at a time: a popover closes when the pointer goes down
 * anywhere outside it, or when Escape is pressed.
 *
 * Every menu that appears on click needs this, and every menu that forgets it
 * leaves the user clicking the same little button again to get rid of it.
 *
 * @param ref      element that contains BOTH the trigger and the popover
 * @param open     whether the popover is currently showing
 * @param onDismiss called once when the user dismisses it
 */
export function useDismissOnOutside(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const node = ref.current;
      if (node && event.target instanceof Node && !node.contains(event.target)) onDismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, onDismiss]);
}
