import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';

const configSchema = z.object({
  /** One cheap masked model call when the code rules are unsure. Off = rules only. */
  model: z.boolean().default(true),
  /** How often followed parcels are looked up again. */
  parcelCheckMinutes: z.number().int().min(30).max(1_440).default(120),
});

export type SmsReaderConfig = z.infer<typeof configSchema>;

const DEFAULTS: SmsReaderConfig = configSchema.parse({});

export function readSmsReaderConfig(ctx: PluginContext): SmsReaderConfig {
  const parsed = configSchema.safeParse(ctx.config);
  if (parsed.success) return parsed.data;
  ctx.log.warn('sms-reader: invalid config, using defaults', { issues: parsed.error.issues.length });
  return DEFAULTS;
}
