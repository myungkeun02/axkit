import type { Logger } from '../log/types.js';
import type { PendingMessages, Undelivered } from './pending.js';
import type { OutgoingMessage, Replier } from './types.js';

/** 5 s, 30 s, 2 min, 10 min, 30 min; past that the entry waits for the next start. */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 1_800_000];

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A replier that never throws: what a channel refused is collected for a later retry. */
export function collectingReplier(replier: Replier, log: Logger): { replier: Replier; failed: Undelivered[] } {
  const failed: Undelivered[] = [];
  return {
    failed,
    replier: {
      async reply(to, message: OutgoingMessage) {
        try {
          await replier.reply(to, message);
        } catch (error) {
          log.warn('reply delivery failed; kept for a retry', { error: reasonOf(error) });
          failed.push({ to, message });
        }
      },
    },
  };
}

/**
 * Delivers replies a channel refused, with a bounded backoff. The pending entry stays until every reply got through,
 * so a restart in between still delivers it.
 */
export class DeliveryRetry {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(
    private readonly opts: {
      pending: PendingMessages;
      replier: () => Replier | undefined;
      log: Logger;
      delaysMs?: readonly number[];
    },
  ) {}

  schedule(id: string, attempt = 0): void {
    const delays = this.opts.delaysMs ?? RETRY_DELAYS_MS;
    const delay = delays[attempt];
    if (this.stopped || delay === undefined || this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.attempt(id).then((done) => {
        if (!done) this.schedule(id, attempt + 1);
      });
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /** Tries every waiting reply once; true when nothing is left. */
  async attempt(id: string): Promise<boolean> {
    const replier = this.opts.replier();
    const waiting = await this.opts.pending.outbox(id).catch(() => [] as Undelivered[]);
    if (replier === undefined) return waiting.length === 0;
    const left: Undelivered[] = [];
    for (const item of waiting) {
      try {
        await replier.reply(item.to, item.message);
      } catch (error) {
        this.opts.log.warn('reply delivery retry failed', { id, error: reasonOf(error) });
        left.push(item);
      }
    }
    if (left.length === 0) await this.opts.pending.finish(id).catch(() => undefined);
    else await this.opts.pending.undelivered(id, left).catch(() => undefined);
    return left.length === 0;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
