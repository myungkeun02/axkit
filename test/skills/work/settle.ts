/** Collects background task results in order; `next()` waits for the next one nobody has taken yet. */
export interface Settler {
  onSettled: (workId: string, output: unknown) => void;
  next<T = unknown>(): Promise<T>;
  readonly ids: string[];
}

export function settler(): Settler {
  const ready: unknown[] = [];
  const waiters: ((output: unknown) => void)[] = [];
  const ids: string[] = [];
  return {
    ids,
    onSettled(workId, output) {
      ids.push(workId);
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(output);
      else ready.push(output);
    },
    next<T>(): Promise<T> {
      if (ready.length > 0) return Promise.resolve(ready.shift() as T);
      return new Promise<T>((resolve) => waiters.push((output) => resolve(output as T)));
    },
  };
}
