import { useCallback, useRef } from 'react';

/**
 * One function identity for the whole life of the component, while every call
 * still lands on the newest implementation.
 *
 * React.memo does real work in this app: while an answer streams, the whole app
 * re-renders on every token, and the message list is only skipped when every
 * prop keeps its identity. An inline arrow — `onRetry={() => retry()}` — is a
 * new function on every render, so it silently defeats that and re-renders every
 * message (markdown and all) per token. This is the one-line fix.
 */
export function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  // Latest-ref pattern: the assignment belongs to render, so an event that fires
  // between renders can never call the previous implementation.
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
