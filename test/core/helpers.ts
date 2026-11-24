import type { Clock } from '../../src/core/scheduler/types.js';
import type { KeyValueStore } from '../../src/core/store/types.js';

interface FakeTimer {
  at: number;
  fn: () => void;
  cancelled: boolean;
}

export async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

export class FakeClock implements Clock {
  private current: number;
  private readonly timers: FakeTimer[] = [];

  constructor(start: Date | number = 0) {
    this.current = typeof start === 'number' ? start : start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer: FakeTimer = { at: this.current + ms, fn, cancelled: false };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    (handle as FakeTimer).cancelled = true;
  }

  /** A Mac sleep: the wall clock moves on while pending timers (monotonic) stand still, so they fire `ms` late. */
  sleep(ms: number): void {
    this.current += ms;
    for (const timer of this.timers) timer.at += ms;
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.cancelled = true;
      this.current = Math.max(this.current, due.at);
      due.fn();
      this.timers.splice(this.timers.indexOf(due), 1);
      await flush();
    }
    this.current = target;
    await flush();
  }
}

export class MapKeyValueStore implements KeyValueStore {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export function namespaceFactory(): (namespace: string) => KeyValueStore {
  const stores = new Map<string, KeyValueStore>();
  return (namespace: string): KeyValueStore => {
    let store = stores.get(namespace);
    if (store === undefined) {
      store = new MapKeyValueStore();
      stores.set(namespace, store);
    }
    return store;
  };
}
