/**
 * The auto-pause sweeper.
 *
 * Novita bills a sandbox for as long as it is RUNNING, so a forgotten one is
 * pure cost. Every `SWEEP_EVERY_MS` this looks at each app-managed sandbox
 * workspace and asks sandboxActivity "has this gone quiet long enough to put
 * down?". If so it pauses it — files and processes survive, the meter stops, and
 * the next message wakes it in about a second.
 *
 * Three deliberate limits on what it will touch:
 *   - a workspace with a run in flight is never paused (and the clock is reset);
 *   - a workspace whose record has `autoPause: false` is never paused;
 *   - a sandbox that no workspace claims (an orphan, or someone else's) is never
 *     touched. Those are the user's to manage by hand in the Sandboxes panel.
 */
import { listWorkspaceRecords } from './store.js';
import { markPaused, markRunning, reasonToPause, stateOf, touch } from './sandboxActivity.js';
import { listAccountSandboxes, pauseSandboxById } from './sandboxAdmin.js';

/** Often enough to be useful, rare enough to be free (the sweep is usually a no-op). */
const SWEEP_EVERY_MS = 15_000;

let timer = null;
let sweeping = false;

/**
 * On boot we know nothing about the remote state — the app may have been
 * restarted while a sandbox kept burning. One list call fixes that, and hands
 * every app-managed running sandbox a full idle window starting now.
 */
export async function seedRunningStates() {
  const { sandboxes } = await listAccountSandboxes();
  const owned = new Map(
    listWorkspaceRecords()
      .filter((r) => r.kind === 'sandbox' && r.sandboxId)
      .map((r) => [r.sandboxId, r])
  );
  let running = 0;
  for (const s of sandboxes) {
    const rec = owned.get(s.sandboxId);
    if (!rec) continue;
    if (s.state === 'running') {
      markRunning(rec.id);
      touch(rec.id);
      running++;
    } else {
      markPaused(rec.id);
    }
  }
  return running;
}

/**
 * One pass. Returns what it paused, so tests can assert on the decision without
 * a real sandbox. `pause` and `isBusy` are injectable for the same reason.
 */
export async function sweepIdleSandboxes({ now = Date.now(), isBusy = () => false, pause = pauseSandboxById } = {}) {
  if (sweeping) return []; // a slow API call must not stack up sweeps
  sweeping = true;
  try {
    const paused = [];
    for (const rec of listWorkspaceRecords()) {
      if (rec.kind !== 'sandbox' || !rec.sandboxId) continue;
      if (rec.autoPause === false) continue;
      if (isBusy(rec.id)) {
        touch(rec.id); // the run is still going: it is obviously not idle
        continue;
      }
      // Only act on a sandbox we have actually seen running. Without this every
      // sweep would fire an API call per workspace just to learn "still paused".
      if (stateOf(rec.id) !== 'running') continue;
      const reason = reasonToPause(rec.id, now);
      if (!reason) continue;

      try {
        const result = await pause(rec.sandboxId);
        if (result?.state === 'running') continue; // it refused; try again next sweep
        markPaused(rec.id);
        paused.push({ workspaceId: rec.id, sandboxId: rec.sandboxId, reason });
        console.log(`[sandbox] auto-paused ${rec.sandboxId} (${rec.name}) — ${reason === 'finished' ? 'the run finished' : 'idle'}`);
      } catch (err) {
        // A sandbox we cannot reach is not worth crashing the timer over.
        console.error(`[sandbox] could not auto-pause ${rec.sandboxId}:`, err?.message || err);
      }
    }
    return paused;
  } finally {
    sweeping = false;
  }
}

/** Start the timer. Returns the handle so callers can stop it. */
export function startIdlePauseSweeper({ isBusy = () => false, everyMs = SWEEP_EVERY_MS, seed = true } = {}) {
  stopIdlePauseSweeper();
  if (seed) {
    seedRunningStates().catch((err) => console.error('[sandbox] could not read the account sandboxes:', err?.message || err));
  }
  timer = setInterval(() => {
    sweepIdleSandboxes({ isBusy }).catch((err) => console.error('[sandbox] sweep failed:', err?.message || err));
  }, everyMs);
  timer.unref?.(); // never keep the process alive just for this
  return timer;
}

export function stopIdlePauseSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}

export const _isSweeping = () => sweeping;
