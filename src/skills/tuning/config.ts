import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';
import type { TuningConfig } from './types.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const schema = z.object({
  weekday: z.number().int().min(0).max(6).default(0),
  at: z.string().regex(HHMM).default('19:00'),
  maxProposals: z.number().int().min(1).max(5).default(3),
});

/** Invalid config never stops the skill: warn without echoing values and run with the defaults. */
export function readTuningConfig(ctx: PluginContext): TuningConfig {
  const parsed = schema.safeParse(ctx.config);
  if (parsed.success) return parsed.data;
  ctx.log.warn('tuning: invalid config, using defaults', { issues: parsed.error.issues.length });
  return schema.parse({});
}
