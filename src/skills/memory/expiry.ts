import type { Fact } from '../../core/contracts/memory.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { ymdOf } from '../../core/time/local-day.js';
import type { FactStore, StoredFact } from './facts.js';
import { toFact } from './facts.js';
import type { MemoryTexts } from './locale.js';

export const EXPIRY_JOB = 'memory.expiry';
export const EXPIRY_AT = '08:50';
export const EXPIRED_CHECK_ID = 'memory.expired';

// "출시 전이라", "이번 주까지" and similar phrases mean the fact carries an end the owner has not stated yet.
const KO_TIME_LIMITED = /(전이라|전까지|까지는|이번 ?주|이번 ?달|당분간|임시로|일단은|지금은|아직)/;
const EN_TIME_LIMITED = /\b(until|for now|this week|this month|temporarily|not yet|before (the )?launch)\b/i;

/** True when the wording suggests the fact only holds for a while. */
export function isTimeLimited(text: string): boolean {
  return KO_TIME_LIMITED.test(text) || EN_TIME_LIMITED.test(text);
}

function payloadOf(fact: StoredFact): { id: string; subject: string; text: string; reason: 'date' | 'event' } {
  return {
    id: fact.id,
    subject: fact.subject,
    text: fact.text,
    reason: fact.expiredReason === 'event' ? 'event' : 'date',
  };
}

async function emitExpired(ctx: PluginContext, facts: readonly StoredFact[]): Promise<void> {
  for (const fact of facts) {
    await ctx.bus.emit('memory.fact_expired', payloadOf(fact));
  }
}

/** Registers the daily end-of-validity sweep, the `memory.expiry` capability and its health check. */
export function registerExpiry(ctx: PluginContext, store: FactStore, texts: MemoryTexts): void {
  ctx.scheduler.add({
    name: EXPIRY_JOB,
    schedule: { kind: 'daily', at: EXPIRY_AT },
    async run(now) {
      const today = ymdOf(now, ctx.assistant.timezone);
      await emitExpired(ctx, store.expireDue(today));
    },
  });

  ctx.provide(Contracts.memoryExpiry, {
    expired: async () => store.expiredFacts().map((fact) => toFact(fact, ctx.clock.now())),
    eventHappened: async (event: string): Promise<Fact[]> => {
      const ended = store.expireEvent(event);
      await emitExpired(ctx, ended);
      return ended.map((fact) => toFact(fact, ctx.clock.now()));
    },
  });

  ctx.tryUse(Contracts.health)?.register({
    id: EXPIRED_CHECK_ID,
    async run() {
      const expired = store.expiredFacts();
      const first = expired[0]?.text ?? '';
      return [
        {
          id: EXPIRED_CHECK_ID,
          area: 'knowledge',
          ok: expired.length === 0,
          line: expired.length === 0 ? texts.expiredFactsNone : texts.expiredFactsLine(expired.length, first),
          ...(expired.length > 0 ? { fix: texts.expiredFactsFix } : {}),
        },
      ];
    },
  });
}
