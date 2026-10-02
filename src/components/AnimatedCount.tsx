import React, { useEffect, useRef, useState } from 'react';

interface AnimatedCountProps {
  value: number;
  /** "+" or "−" shown in front. */
  sign: string;
  className?: string;
  /**
   * Start from 0 instead of from `value`. Used when the number first appears on a row that was already
   * on screen (the model delivered the whole file at once): it rolls up instead of popping in.
   */
  fromZero?: boolean;
  /** Tells the row whether the number is still rolling (the label keeps shimmering until it stops). */
  onAnimating?: (animating: boolean) => void;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A number that glides to its new value instead of jumping.
 * While a file is being written the target moves every ~150ms; this turns those steps into a smooth
 * count, and when a finished file's count arrives in one go it rolls up in under a second.
 */
export const AnimatedCount: React.FC<AnimatedCountProps> = ({ value, sign, className, fromZero, onAnimating }) => {
  const [shown, setShown] = useState(fromZero ? 0 : value);
  const shownRef = useRef(shown);
  const rafRef = useRef<number>(0);
  const cbRef = useRef(onAnimating);
  cbRef.current = onAnimating;

  useEffect(() => {
    const from = shownRef.current;
    if (from === value) return;
    if (prefersReducedMotion()) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const delta = Math.abs(value - from);
    // growing counts take as long as they need to look smooth (but never feel slow); corrections are quick
    const duration = value > from ? Math.min(900, Math.max(220, delta * 18)) : 240;
    const t0 = performance.now();
    cbRef.current?.(true);
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = p >= 1 ? value : Math.round(from + (value - from) * eased);
      shownRef.current = v;
      setShown(v);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else cbRef.current?.(false);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value]);

  // never leave the row "animating" if this unmounts mid-roll
  useEffect(() => () => cbRef.current?.(false), []);

  return (
    <span className={className} data-count={value}>
      {sign}
      {shown}
    </span>
  );
};
