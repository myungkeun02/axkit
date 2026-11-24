/** A running task's hold on its key. */
export interface QueueSlot {
  /**
   * Gives the key to the next task while `wait` runs (a card waiting for the owner), then takes it back ahead of every
   * task queued later, so the suspended task still finishes before newer ones start.
   */
  suspend<T>(wait: () => Promise<T>): Promise<T>;
}

interface Lane {
  waiting: (() => void)[];
}

/**
 * One queue per conversation key: a task starts only after the previous task with the same key settled or suspended.
 * Different keys run side by side.
 */
export class KeyedQueue {
  /** A key is held while it has a lane; waiting tasks are handed the key in order. */
  private readonly lanes = new Map<string, Lane>();
  private running = 0;
  private readonly settled = new Set<() => void>();

  private acquire(key: string, front = false): Promise<void> {
    const lane = this.lanes.get(key);
    if (lane === undefined) {
      this.lanes.set(key, { waiting: [] });
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      if (front) lane.waiting.unshift(resolve);
      else lane.waiting.push(resolve);
    });
  }

  private release(key: string): void {
    const lane = this.lanes.get(key);
    if (lane === undefined) return;
    const next = lane.waiting.shift();
    if (next !== undefined) next();
    else this.lanes.delete(key);
  }

  run<T>(key: string, task: (slot: QueueSlot) => Promise<T>): Promise<T> {
    this.running += 1;
    const slot: QueueSlot = {
      suspend: async <R>(wait: () => Promise<R>): Promise<R> => {
        this.release(key);
        try {
          return await wait();
        } finally {
          await this.acquire(key, true);
        }
      },
    };
    const result = this.acquire(key).then(async () => {
      try {
        return await task(slot);
      } finally {
        this.release(key);
      }
    });
    const done = (): void => {
      this.running -= 1;
      if (this.running === 0) for (const notify of [...this.settled]) notify();
    };
    void result.then(done, done);
    return result;
  }

  /** Tasks queued, running or suspended. */
  get size(): number {
    return this.running;
  }

  /** Resolves when every task queued so far has settled, or after `timeoutMs`; true when everything settled. */
  async idle(timeoutMs: number): Promise<boolean> {
    if (this.running === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let notify: (() => void) | undefined;
    try {
      return await new Promise<boolean>((resolve) => {
        notify = () => resolve(true);
        this.settled.add(notify);
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (notify !== undefined) this.settled.delete(notify);
    }
  }
}
