import { useEffect, useRef, useState } from 'react';

/**
 * Animate a number upward, one step at a time, instead of snapping to it.
 *
 * A diff count is the most informative thing on a work row, and when it simply
 * appears there is nothing to read: the eye registers "a number" and moves on.
 * Climbing from 0 makes the size of the change legible — a +6 and a +600 feel
 * different while they are counting, which is the whole point.
 *
 * The climb is clock-driven, never frame-counted. requestAnimationFrame is not
 * a reliable 60Hz (a busy render or a background tab stretches it), so the
 * elapsed time decides the value and a dropped frame costs smoothness, never
 * correctness: the last frame always lands exactly on the target.
 *
 * Pace: about 55ms per unit, floored at 260ms so even +1 is a beat rather than
 * a flicker, and capped at 1100ms so a 2000-line file does not hold the row
 * hostage. Under roughly 20 units that works out to a genuine one-by-one tick;
 * above it the step grows, because counting 2000 lines singly would take half a
 * minute. Nothing ever jumps straight to the final value.
 */

/** Milliseconds the counter spends on each unit, before the clamps below. */
const MS_PER_UNIT = 55;
/** Even +1 gets a visible beat. */
const MIN_DURATION = 260;
/** A huge diff still finishes in about a second. */
const MAX_DURATION = 1100;

const clamp = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** rAF in the browser, a timer everywhere else (tests, SSR). */
const schedule: (cb: (t: number) => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number;

const cancel: (id: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? (id) => cancelAnimationFrame(id)
    : (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);

/**
 * The value to display for `target` on this frame.
 *
 * Exported for testing: the curve is pure, so it can be checked at exact
 * timestamps without a browser or a clock.
 */
export function countUpValue(from: number, target: number, elapsedMs: number): number {
  const distance = target - from;
  if (distance <= 0) return target;
  const duration = clamp(distance * MS_PER_UNIT, MIN_DURATION, MAX_DURATION);
  if (elapsedMs >= duration) return target;
  if (elapsedMs <= 0) return from;
  // Linear: a diff count is a quantity, not a motion, so easing would make the
  // same number of lines appear to arrive at an uneven rate.
  return from + Math.floor((distance * elapsedMs) / duration);
}

/**
 * Count up to `target`.
 *
 * `animateOnMount` is what separates work happening now from work already done.
 * A live row starts at 0 and climbs, which is the whole point. A finished row —
 * history being re-rendered when a chat is reopened — shows its real number at
 * once: replaying fifty old diffs as animations would be noise, and it would
 * also mean a static render briefly tells the reader "+0" when the truth is
 * "+137".
 *
 * A target that grows mid-climb (a file still being written) is picked up from
 * wherever the counter has reached, so the number never restarts or stutters. A
 * target that drops — a different run reusing the row — snaps, because counting
 * down would read as the work being undone.
 */
export function useCountUp(target: number | undefined, animateOnMount = true): number | undefined {
  const [shown, setShown] = useState(target === undefined || !animateOnMount ? target : 0);
  const frame = useRef<number | null>(null);
  // Read inside the frame loop without making it a dependency.
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    if (target === undefined) {
      setShown(undefined);
      return;
    }
    const from = shownRef.current ?? 0;
    if (target <= from || prefersReducedMotion()) {
      setShown(target);
      return;
    }

    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const tick = (now: number) => {
      frame.current = null;
      const next = countUpValue(from, target, now - start);
      setShown(next);
      if (next < target) frame.current = schedule(tick);
    };
    frame.current = schedule(tick);

    return () => {
      if (frame.current !== null) {
        cancel(frame.current);
        frame.current = null;
      }
    };
  }, [target]);

  return shown;
}
