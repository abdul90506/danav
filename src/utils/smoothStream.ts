/**
 * SmoothStreamer provides fluid token-by-token streaming cadence
 * preventing bursty chunks without introducing latency or lag.
 */
export class SmoothStreamer {
  private queue: string[] = [];
  private onFlush: (flushedText: string) => void;
  private intervalId: any = null;
  private isEnded = false;
  private onDone?: () => void;

  constructor(onFlush: (text: string) => void, onDone?: () => void) {
    this.onFlush = onFlush;
    this.onDone = onDone;
  }

  public push(chunk: string) {
    if (!chunk) return;
    // Split into tokens: words, spaces, newlines, punctuation
    const tokens = chunk.match(/(\r\n|\r|\n|\s+|[^\s\w]+|[\w]+)/g) || [chunk];
    this.queue.push(...tokens);
    this.ensureLoop();
  }

  private ensureLoop() {
    if (this.intervalId !== null) return;

    this.intervalId = setInterval(() => {
      if (this.queue.length === 0) {
        if (this.isEnded) {
          this.stop();
          this.onDone?.();
        }
        return;
      }

      // Dynamic rate adjustment to stay in sync with the model:
      // Small queue: 1 token / tick (~60fps)
      // Medium queue: 2-3 tokens / tick
      // Large queue: scale up proportionally so it never falls behind
      let tokensToEmit = 1;
      if (this.queue.length > 40) {
        tokensToEmit = Math.ceil(this.queue.length / 4);
      } else if (this.queue.length > 20) {
        tokensToEmit = 3;
      } else if (this.queue.length > 8) {
        tokensToEmit = 2;
      }

      const batch = this.queue.splice(0, tokensToEmit).join('');
      this.onFlush(batch);

      if (this.queue.length === 0 && this.isEnded) {
        this.stop();
        this.onDone?.();
      }
    }, 16);
  }

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
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
