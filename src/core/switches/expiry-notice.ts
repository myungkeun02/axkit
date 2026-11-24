import type { Notifier } from '../contracts/notify.js';
import type { FeatureSwitches, PauseState } from '../contracts/switches.js';
import type { Job } from '../scheduler/types.js';

const DAY_MS = 86_400_000;

export interface PauseExpiryOptions {
  switches: FeatureSwitches;
  notifier: () => Notifier | undefined;
  now: () => Date;
  text: (state: PauseState) => string;
}

/** Once a day, reminds the owner about pauses that end within the next 24 hours. */
export function pauseExpiryJob(opts: PauseExpiryOptions): Job {
  return {
    name: 'core.pause-expiry',
    schedule: { kind: 'daily', at: '09:00' },
    async run(): Promise<void> {
      const nowMs = opts.now().getTime();
      const states = await opts.switches.list();
      for (const state of states) {
        const untilMs = new Date(state.until).getTime();
        if (untilMs <= nowMs || untilMs > nowMs + DAY_MS) continue;
        const notifier = opts.notifier();
        if (notifier === undefined) continue;
        await notifier.notify({
          kind: 'core.pause-expiry',
          dedupeKey: `${state.feature}:${state.until}`,
          text: opts.text(state),
        });
      }
    },
  };
}
