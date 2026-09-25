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
  /** Resolves once the job leaves the queue/running set for ANY reason
   * (completed, failed, or cancelled) — including the case where the caller
   * coalesced onto an already-in-flight job. */
  settled: Promise<void>;
  resolveSettled: () => void;
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
   *
   * `promise` settles when the work is actually done (or definitively
   * abandoned) — never earlier. A coalesced request resolves with the job it
   * joined, so callers can safely use it to observe completion.
   */
  enqueue(
    id: string,
    priority: JobPriority,
    run: (signal: AbortSignal) => Promise<void>,
  ): { promise: Promise<void> } {
    const existing = this.inflight.get(id);
    if (existing) {
      // Already queued/running at the same or higher priority — join it.
      // A more urgent request bumps the queued item in place; creating a
      // second item for the same id (the old behaviour) left the first one
      // queued as well, so the work ran twice.
      if (existing.priority > priority) existing.priority = priority;
      return { promise: existing.settled };
    }
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const item: QueueItem = {
      id,
      priority,
      seq: ++this.seqCounter,
      run,
      controller,
      settled,
      resolveSettled,
    };
    this.inflight.set(id, item);
    this.queue.push(item);
    this.pump();
    return { promise: settled };
  }

  /** Cancel a queued or running job by id. */
  cancel(id: string) {
    const item = this.inflight.get(id);
    if (!item) return;
    item.controller.abort();
    this.queue = this.queue.filter((q) => q !== item);
    this.inflight.delete(id);
    // A RUNNING job keeps its concurrency slot until it actually settles.
    // Freeing the slot here (the old behaviour) started a replacement while
    // the aborted job was still running, so cancelling during a batch of
    // thumbnail/ffmpeg jobs RAISED peak concurrent work instead of lowering
    // it — exactly what the cap exists to prevent. Cooperative abort ends
    // the job promptly on its own.
    if (!this.active.has(item)) item.resolveSettled();
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
        item.resolveSettled();
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
          item.resolveSettled();
          this.pump();
        });
    }
  }
}

/** App-wide scheduler instance (module-level: jobs outlive component remounts). */
export const jobs = new JobManager();
