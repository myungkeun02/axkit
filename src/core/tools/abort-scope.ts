import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<AbortSignal>();

/**
 * Runs a tool with its stop signal in scope, so HTTP helpers deep below it (a connector's request function) stop
 * when the tool times out, without every method having to thread the signal through.
 */
export function runWithAbortSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return scope.run(signal, work);
}

/** The stop signal of the tool call this code runs in, if any. */
export function currentAbortSignal(): AbortSignal | undefined {
  return scope.getStore();
}

/** The caller's own signal combined with the one in scope; undefined when neither exists. */
export function scopedSignal(own: AbortSignal | null | undefined): AbortSignal | undefined {
  const ambient = currentAbortSignal();
  if (own === null || own === undefined) return ambient;
  if (ambient === undefined || ambient === own) return own;
  return AbortSignal.any([own, ambient]);
}
