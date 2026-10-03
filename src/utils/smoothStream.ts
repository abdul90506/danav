/**
 * SmoothStreamer gives streamed text a fluid, continuous cadence.
 *
 * Providers differ wildly: some emit a token at a time, others (Vyce/agnes,
 * Gemini) dump a whole answer in a single frame. Rendering that raw produces
 * either a jerky "burst" of words or a long stall followed by a wall of text.
 *
 * This class sits between the socket and the UI and drains a queue at an
 * adaptive rate:
 *
 *   - the target rate is proportional to how much is waiting (queue * 12),
 *     clamped to [60, 1000] tokens per second, so a big backlog speeds up but
 *     never turns into one jump;
 *   - the actual rate eases toward that target, so speed changes are gradual
 *     rather than snapping between slow and fast;
 *   - emission happens once per animation frame with a fractional budget, so
 *     the output is continuous (≈1 token/frame at the floor) instead of chunky.
 *
 * A slow provider (few tokens waiting) passes through at its own pace with no
 * added latency; a fast one is paced out smoothly over a fraction of a second.
 * At equilibrium the rate matches the arrival rate on its own — the queue stops
 * growing without us ever having to know how fast the provider really is.
 */

/** Slowest we ever drain: about one token per animation frame. */
const MIN_RATE = 60; // tokens / second
/** Fastest we ever drain: a big dump still finishes in well under a second. */
const MAX_RATE = 1000; // tokens / second
/** How much waiting output multiplies into the target rate. */
const QUEUE_FACTOR = 12;
/** Per-frame easing toward the target rate (0..1). Keeps speed changes soft. */
const RAMP = 0.18;
/** Never let a stalled tab hand us a huge dt after it wakes up. */
const MAX_DT = 0.05; // seconds

const clamp = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value;

/** rAF in the browser, a timer everywhere else (tests, SSR). */
const schedule: (cb: (t: number) => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number;

const cancel: (id: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? (id) => cancelAnimationFrame(id)
    : (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);

export class SmoothStreamer {
  private queue: string[] = [];
  private onFlush: (flushedText: string) => void;
  private onDone?: () => void;
  private frameId: number | null = null;
  private isEnded = false;
  private lastTime = 0;
  /** Fractional carry so the per-frame budget never rounds tokens away. */
  private budget = 0;
  /** Current eased drain rate, in tokens per second. */
  private rate = MIN_RATE;

  constructor(onFlush: (text: string) => void, onDone?: () => void) {
    this.onFlush = onFlush;
    this.onDone = onDone;
  }

  public push(chunk: string) {
    if (!chunk) return;
    // Split into tokens: words, spaces, newlines, punctuation.
    const tokens = chunk.match(/(\r\n|\r|\n|\s+|[^\s\w]+|[\w]+)/g) || [chunk];
    this.queue.push(...tokens);
    this.ensureLoop();
  }

  private ensureLoop() {
    if (this.frameId !== null) return;
    this.lastTime = 0;
    this.frameId = schedule(this.tick);
  }

  private tick = (now: number) => {
    this.frameId = null;

    // First tick after a push() has no previous timestamp; treat it as one
    // frame so the very first token appears immediately (no perceived latency).
    const dt = this.lastTime ? Math.min(MAX_DT, (now - this.lastTime) / 1000) : 1 / 60;
    this.lastTime = now;

    if (this.queue.length === 0) {
      // Nothing waiting: rest the rate so the next burst starts calm again.
      this.rate = MIN_RATE;
      this.budget = 0;
      if (this.isEnded) {
        this.onDone?.();
        return;
      }
      return; // idle — the loop restarts on the next push()
    }

    // Ease the rate toward a target that scales with the backlog.
    const target = clamp(this.queue.length * QUEUE_FACTOR, MIN_RATE, MAX_RATE);
    this.rate += (target - this.rate) * RAMP;

    this.budget += this.rate * dt;
    let count = Math.floor(this.budget);
    if (count <= 0) {
      this.frameId = schedule(this.tick);
      return;
    }
    this.budget -= count;

    if (count >= this.queue.length) count = this.queue.length;
    const batch = this.queue.splice(0, count).join('');
    this.onFlush(batch);

    if (this.queue.length === 0 && this.isEnded) {
      this.onDone?.();
      return;
    }
    this.frameId = schedule(this.tick);
  };

  public finish() {
    this.isEnded = true;
    if (this.queue.length === 0) {
      this.stop();
      this.onDone?.();
    }
  }

  public flushImmediate() {
    if (this.queue.length > 0) {
      const remaining = this.queue.join('');
      this.queue = [];
      this.onFlush(remaining);
    }
    this.stop();
    this.onDone?.();
  }

  public stop() {
    if (this.frameId !== null) {
      cancel(this.frameId);
      this.frameId = null;
    }
  }
}
