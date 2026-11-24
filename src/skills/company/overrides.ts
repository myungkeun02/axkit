import type { TuningChange } from '../../core/contracts/feedback.js';
import type { Unsubscribe } from '../../core/events/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import { effectiveLimits } from './limits.js';
import type { CompanyConfig, CompanyLimits } from './types.js';

const KEY = 'limits:overrides';

const NUMERIC_KEYS: readonly (keyof CompanyLimits)[] = [
  'maxOpen',
  'maxOpenPerTeam',
  'maxAgeHours',
  'ownerWaitDays',
  'maxRevisions',
  'maxSteps',
];

function isLimitKey(subject: string): subject is keyof CompanyLimits {
  return (NUMERIC_KEYS as readonly string[]).includes(subject);
}

function parseOverrides(raw: unknown): Partial<CompanyLimits> {
  if (raw === null || typeof raw !== 'object') return {};
  const result: Partial<CompanyLimits> = {};
  for (const key of NUMERIC_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  return result;
}

/** Self-tuning's approved limit changes; effectiveLimits only lets them tighten the config. */
export class CompanyOverrides {
  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<Partial<CompanyLimits>> {
    return parseOverrides(await this.kv.get<unknown>(KEY));
  }

  async limits(config: CompanyConfig): Promise<CompanyLimits> {
    return effectiveLimits(config, await this.load());
  }

  async apply(change: TuningChange): Promise<void> {
    if (change.domain !== 'company.limits' || !isLimitKey(change.subject)) return;
    const current = await this.load();
    if (change.action === 'unmute') {
      const next: Partial<CompanyLimits> = {};
      for (const key of NUMERIC_KEYS) {
        if (key !== change.subject && current[key] !== undefined) next[key] = current[key];
      }
      await this.kv.set(KEY, next);
      return;
    }
    if (change.action !== 'set' || change.value === undefined) return;
    const value = Number(change.value);
    if (!Number.isFinite(value) || value < 0) return;
    await this.kv.set(KEY, { ...current, [change.subject]: Math.trunc(value) });
  }
}

export function listenOverrides(ctx: PluginContext, overrides: CompanyOverrides): Unsubscribe {
  return ctx.bus.on('tuning.apply', async (change) => {
    await overrides.apply(change);
  });
}
