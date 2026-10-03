import React, { useEffect, useRef, useState } from 'react';

interface AnimatedCountProps {
  value: number;
  /** "+" or "−" shown in front. */
  sign: string;
  className?: string;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A number that glides to its new value instead of stepping to it.
 *
 * It never invents a value. Every target it rolls towards is one the server
 * actually sent — a real reading of the file's length on disk — and it STARTS on
 * the first value it is given, so a row opens on "+0" and climbs from there. It
 * is the shape of the count that is smoothed, never the count itself.
 */
export const AnimatedCount: React.FC<AnimatedCountProps> = ({ value, sign, className }) => {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const from = shownRef.current;
    if (from === value) return;
    if (prefersReducedMotion()) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const delta = Math.abs(value - from);
    // A growing count takes as long as it needs to look smooth (but never feels slow);
    // a correction is quick.
    const duration = value > from ? Math.min(700, Math.max(160, delta * 14)) : 200;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = p >= 1 ? value : Math.round(from + (value - from) * eased);
      shownRef.current = v;
      setShown(v);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value]);

  return (
    <span className={className} data-count={value}>
      {sign}
      {shown}
    </span>
  );
};
