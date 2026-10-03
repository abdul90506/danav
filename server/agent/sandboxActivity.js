/**
 * When did we last use a sandbox, and is it time to pause it?
 *
 * A Novita sandbox bills for compute while it is RUNNING. A paused one keeps its
 * files AND its processes and costs nothing, and waking it takes about a second.
 * So the rule is: never leave one running with nobody using it.
 *
 * Two clocks, whichever expires first:
 *
 *   IDLE      nothing touched the workspace for `sandboxIdlePauseMs`.
 *   FINISHED  a run just ended and nothing happened for `sandboxRunGraceMs`.
 *
 * The second one exists because "the agent finished its work" is a much stronger
 * "we are done here" signal than mere silence, so it earns a shorter clock. Any
 * activity at all resets both, and a workspace with a run in flight is never
 * paused (the sweeper checks that separately).
 *
 * This module is deliberately dependency-free apart from config: `sandbox.js`
 * imports it on the hot path (every single sandbox operation), so it must not
 * pull in the SDK or the workspace registry.
 */
import { limits } from './config.js';

/** workspaceId -> { lastActivity: number, runEndedAt: number } */
const clock = new Map();
/** workspaceId -> 'running' | 'paused' — what we last saw the remote doing. */
const states = new Map();

function entry(id) {
  let e = clock.get(id);
  if (!e) {
    e = { lastActivity: Date.now(), runEndedAt: 0 };
    clock.set(id, e);
  }
  return e;
}

/** Someone used this workspace (a tool ran, a file was read, a preview was opened). */
export function touch(id, at = Date.now()) {
  if (!id) return;
  const e = entry(id);
  e.lastActivity = at;
  e.runEndedAt = 0; // activity: the short "run just finished" clock no longer applies
}

/** An agent run ended. Starts the short grace clock as well as the idle one. */
export function noteRunFinished(id, at = Date.now()) {
  if (!id) return;
  const e = entry(id);
  e.lastActivity = at;
  e.runEndedAt = at;
}

/** The remote state we last observed, or null if we have never seen this one. */
export const stateOf = (id) => states.get(id) || null;
export const markRunning = (id) => id && states.set(id, 'running');
export const markPaused = (id) => id && states.set(id, 'paused');

/** Workspace deleted: stop tracking it. */
export function forget(id) {
  clock.delete(id);
  states.delete(id);
}

/**
 * Which clock (if either) has expired for this workspace.
 * @returns {'idle' | 'finished' | null}
 */
export function reasonToPause(id, now = Date.now()) {
  const e = clock.get(id);
  if (!e) return null; // never used in this process: not ours to judge
  if (now - e.lastActivity >= limits.sandboxIdlePauseMs()) return 'idle';
  if (e.runEndedAt && now - e.runEndedAt >= limits.sandboxRunGraceMs()) return 'finished';
  return null;
}

/** How long until this workspace would be paused, for the UI. null = never (unused). */
export function msUntilPause(id, now = Date.now()) {
  const e = clock.get(id);
  if (!e) return null;
  const deadlines = [e.lastActivity + limits.sandboxIdlePauseMs()];
  if (e.runEndedAt) deadlines.push(e.runEndedAt + limits.sandboxRunGraceMs());
  return Math.max(0, Math.min(...deadlines) - now);
}

/** Test helper: forget every clock and state. */
export function _reset() {
  clock.clear();
  states.clear();
}
