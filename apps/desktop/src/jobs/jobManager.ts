/**
 * Central background-job scheduler.
 *
 * Every expensive asynchronous task (waveform decoding, thumbnail fetches,
 * future preview renders) goes through here so that:
 *  - the user's current intent wins (priority + generation),
 *  - obsolete work is cancelled (AbortSignal, cooperative),
 *  - the UI thread is never blocked (jobs are async; heavy Rust work stays
 *    in Rust via invoke),
 *  - repeated identical requests collapse onto one in-flight job.
 *
 * Priority order (lower runs first):
 *   0 scrub   1 playback   2 visible media   3 background cache
 */

export type JobPriority = 0 | 1 | 2 | 3;

type QueueItem = {
  id: string;
  priority: JobPriority;
  seq: number;
  run: (signal: AbortSignal) => Promise<void>;
  controller: AbortController;
};

const CONCURRENCY = 2;

export class JobManager {
  private queue: QueueItem[] = [];
  private active = new Set<QueueItem>();
  private seqCounter = 0;
  /** id → in-flight item; enqueue() with the same id collapses onto it. */
  private inflight = new Map<string, QueueItem>();

  /**
   * Enqueue (or coalesce) a job. Cancelling the returned handle aborts the
   * signal and drops the job if it has not started; a running job receives
   * the abort and is expected to stop its work cooperatively.
   */
  enqueue(
    id: string,
    priority: JobPriority,
    run: (signal: AbortSignal) => Promise<void>,
  ): { cancelled: boolean; promise: Promise<void> } {
    const existing = this.inflight.get(id);
    if (existing) {
      if (existing.priority <= priority) {
        // Already queued/running at same or higher priority — keep it.
        return { cancelled: false, promise: existing.controller.signal.aborted ? Promise.resolve() : Promise.resolve() };
      }
      // New request is more urgent: bump its priority in the queue.
      existing.priority = priority;
    }
    const controller = new AbortController();
    const item: QueueItem = {
      id,
      priority,
      seq: ++this.seqCounter,
      run,
      controller,
    };
    this.inflight.set(id, item);
    this.queue.push(item);
    this.pump();
    return {
      cancelled: false,
      promise: new Promise<void>((resolve) => {
        const check = () => {
          if (item.controller.signal.aborted || !this.inflight.has(id)) {
            resolve();
          } else {
            setTimeout(check, 50);
          }
        };
        if (this.active.has(item)) resolve();
        else setTimeout(check, 50);
      }),
    };
  }

  /** Cancel a queued or running job by id. */
  cancel(id: string) {
    const item = this.inflight.get(id);
    if (!item) return;
    item.controller.abort();
    this.queue = this.queue.filter((q) => q !== item);
    this.inflight.delete(id);
    // Active jobs finish their current await, then see the aborted signal
    // and must not enqueue follow-ups; slot frees on completion.
    if (this.active.has(item)) {
      // Allow a replacement to start immediately.
      this.active.delete(item);
      this.pump();
    }
  }

  cancelAll() {
    for (const item of [...this.inflight.values()]) {
      this.cancel(item.id);
    }
  }

  private pump() {
    while (this.active.size < CONCURRENCY && this.queue.length > 0) {
      // Highest priority (lowest number), then oldest request.
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const item = this.queue.shift();
      if (!item) return;
      if (item.controller.signal.aborted) {
        this.inflight.delete(item.id);
        continue;
      }
      this.active.add(item);
      void item
        .run(item.controller.signal)
        .catch(() => undefined)
        .finally(() => {
          this.active.delete(item);
          if (this.inflight.get(item.id) === item) {
            this.inflight.delete(item.id);
          }
          this.pump();
        });
    }
  }
}

/** App-wide scheduler instance (module-level: jobs outlive component remounts). */
export const jobs = new JobManager();
