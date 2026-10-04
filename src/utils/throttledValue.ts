import { useEffect, useRef, useState } from 'react';

/**
 * A value that follows its source, but no faster than `intervalMs`.
 *
 * Streaming answers arrive once per animation frame — up to sixty times a
 * second — and every one of those frames re-parses the whole answer to markdown.
 * The cost of that parse grows with the answer, so a long reply spends more and
 * more of each frame doing the same work over again, which is exactly when the
 * interface starts to feel heavy.
 *
 * Reading the text thirty times a second is indistinguishable from reading it
 * sixty times a second (the text simply arrives in slightly larger steps), and
 * it halves the work. While the stream is running the value is throttled; the
 * moment it stops, the newest value is taken immediately, so the answer is never
 * left showing an older version of itself.
 */
export function useThrottledValue<T>(value: T, intervalMs: number, throttle: boolean): T {
  const [shown, setShown] = useState(value);
  const latestRef = useRef(value);
  latestRef.current = value;
  const lastAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const clear = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    if (!throttle) {
      clear();
      lastAtRef.current = performance.now();
      setShown(latestRef.current);
      return;
    }

    const elapsed = performance.now() - lastAtRef.current;
    if (elapsed >= intervalMs) {
      clear();
      lastAtRef.current = performance.now();
      setShown(latestRef.current);
      return;
    }
    if (timerRef.current !== null) return; // one timer is enough; it reads the newest value
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      lastAtRef.current = performance.now();
      setShown(latestRef.current);
    }, intervalMs - elapsed);
  }, [value, intervalMs, throttle]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  return shown;
}
