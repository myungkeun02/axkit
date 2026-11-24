import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = z.string().regex(HHMM);

const configSchema = z.object({
  scan: z.boolean().default(true),
  scanSeconds: z.number().int().min(300).max(86_400).default(3_600),
  checklistAt: time.default('09:00'),
  remindDays: z.array(z.number().int().min(0).max(14)).max(7).default([3, 1]),
});

export type TripConfig = z.infer<typeof configSchema>;

const DEFAULTS: TripConfig = configSchema.parse({});

export function readTripConfig(ctx: PluginContext): TripConfig {
  const parsed = configSchema.safeParse(ctx.config);
  if (parsed.success) return parsed.data;
  ctx.log.warn('trip: invalid config, using defaults', { issues: parsed.error.issues.length });
  return DEFAULTS;
}
