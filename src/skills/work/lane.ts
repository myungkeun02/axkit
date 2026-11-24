/**
 * One-at-a-time queue for long tasks. A lane can be shared by key (the one browser on this Mac), so a browser task
 * and an errand never drive it at the same time even though they come from different plugins.
 */
export class Lane {
  private readonly waiting: (() => Promise<void>)[] = [];
  private active = false;
  private idleWaiters: (() => void)[] = [];
  /** The running task is done with the browser itself but keeps it for a page handed to the owner. */
  holdingForOwner = false;

  /** Tasks ahead of a new one: the running task plus the queue. */
  get ahead(): number {
    return this.waiting.length + (this.active ? 1 : 0);
  }

  /** Tasks waiting behind the running one. */
  get queued(): number {
    return this.waiting.length;
  }

  get busy(): boolean {
    return this.active;
  }

  /** Queues `task`; returns how many were ahead of it. A task's own errors are its business: they never stop the lane. */
  enqueue(task: () => Promise<void>): number {
    const ahead = this.ahead;
    this.waiting.push(task);
    if (!this.active) void this.drain();
    return ahead;
  }

  /** Resolves once nothing runs or waits. */
  idle(): Promise<void> {
    if (!this.active && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    this.active = true;
    for (let next = this.waiting.shift(); next !== undefined; next = this.waiting.shift()) {
      try {
        await next();
      } catch {
        // the task reports its own failure
      }
    }
    this.active = false;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

const shared = new WeakMap<object, Lane>();

/** The lane for `key` (e.g. the BrowserAgent instance), created on first use. */
export function sharedLane(key: object): Lane {
  let lane = shared.get(key);
  if (lane === undefined) {
    lane = new Lane();
    shared.set(key, lane);
  }
  return lane;
}
