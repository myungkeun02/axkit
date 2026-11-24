import type { Clock } from '../scheduler/types.js';
import type { QuietHours } from './quiet-window.js';
import { isQuietAt, quietWindowEnd } from './quiet-window.js';

/** The owner wrote this recently: they are awake, so a question in the middle of the night is not a surprise. */
const AWAKE_WITHIN_MS = 15 * 60_000;

/** Holds proactive question cards until the owner's quiet hours end. */
export interface QuietGate {
  shouldWait(): boolean;
  /** Resolves when the quiet window closes (at once when it is not quiet). */
  wait(): Promise<void>;
}

export interface QuietGateOptions {
  clock: Clock;
  timeZone: string;
  quietHours?: QuietHours;
  /** The owner's last message on any channel. */
  ownerActiveAt?: () => Date | undefined;
}

export function quietGate(opts: QuietGateOptions): QuietGate {
  const shouldWait = (): boolean => {
    const now = opts.clock.now();
    if (!isQuietAt(opts.quietHours, now, opts.timeZone)) return false;
    const active = opts.ownerActiveAt?.();
    return active === undefined || now.getTime() - active.getTime() > AWAKE_WITHIN_MS;
  };
  return {
    shouldWait,
    wait: () =>
      new Promise<void>((resolve) => {
        const quiet = opts.quietHours;
        const now = opts.clock.now();
        if (quiet === undefined || !isQuietAt(quiet, now, opts.timeZone)) {
          resolve();
          return;
        }
        const delay = Math.max(0, quietWindowEnd(quiet, now, opts.timeZone).getTime() - now.getTime());
        opts.clock.setTimeout(resolve, delay);
      }),
  };
}
