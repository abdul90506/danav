/**
 * "Allow this command?" — pending approvals for workspaces that don't auto-run.
 *
 * The agent loop parks a Promise here and streams an `awaiting_approval` action
 * to the chat; the user's click arrives on POST /api/agent/approvals/:key.
 * Unanswered requests are denied (never silently allowed): after a timeout, or
 * when the run is stopped.
 */
const pending = new Map(); // key -> { resolve, timer, onAbort, signal }

/** @returns {Promise<boolean>} true = allowed */
export function requestApproval(key, { signal, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const settle = (allow) => {
      const entry = pending.get(key);
      if (!entry) return;
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener('abort', entry.onAbort);
      pending.delete(key);
      resolve(allow);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    const onAbort = () => settle(false);
    if (signal?.aborted) return resolve(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(key, { resolve: settle, timer, onAbort, signal });
  });
}

/** @returns {boolean} whether a request with that key was waiting */
export function resolveApproval(key, allow) {
  const entry = pending.get(key);
  if (!entry) return false;
  entry.resolve(Boolean(allow));
  return true;
}

/** Deny everything still waiting for a run (used when the run ends). */
export function cancelApprovalsFor(prefix) {
  for (const [key, entry] of [...pending]) if (key.startsWith(prefix)) entry.resolve(false);
}

export const pendingApprovalCount = () => pending.size;
