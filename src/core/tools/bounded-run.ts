import { runWithAbortSignal } from './abort-scope.js';

export class ToolTimeoutError extends Error {
  constructor(
    readonly toolName: string,
    readonly timeoutMs: number,
  ) {
    super(`Tool ${toolName} timed out after ${Math.round(timeoutMs / 1000)}s and was stopped; it may not have finished.`);
    this.name = 'ToolTimeoutError';
  }
}

/**
 * Runs a tool with a stop signal that fires after `timeoutMs`, and stops waiting at that moment even when the tool
 * ignores the signal. The signal is also put in scope for connector HTTP helpers.
 */
export async function runBounded<T>(name: string, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let fire: (error: ToolTimeoutError) => void = () => undefined;
  const timedOut = new Promise<never>((_, reject) => {
    fire = reject;
  });
  timedOut.catch(() => undefined);
  const timer = setTimeout(() => {
    const error = new ToolTimeoutError(name, timeoutMs);
    controller.abort(error);
    fire(error);
  }, timeoutMs);
  try {
    const running = runWithAbortSignal(controller.signal, () => work(controller.signal));
    // A tool that settles after the deadline must not surface as an unhandled rejection.
    running.catch(() => undefined);
    return await Promise.race([running, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
