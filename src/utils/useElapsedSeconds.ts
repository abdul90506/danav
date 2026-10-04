import { useEffect, useState } from 'react';

/**
 * Seconds on the clock for one piece of work — the whole turn, not each step.
 *
 * Ticking is a one-second interval, and only while the work is actually running;
 * a finished turn stops the timer rather than leaving one behind on every message
 * in the transcript.
 */
export function useElapsedSeconds(running: boolean, startAt?: number | null): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) {
      setSeconds(0);
      return;
    }
    const from = startAt || Date.now();
    const tick = () => setSeconds(Math.max(0, Math.round((Date.now() - from) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running, startAt]);
  return seconds;
}
