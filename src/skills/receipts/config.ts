import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const configSchema = z.object({
  monthEndAt: z.string().regex(HHMM).default('20:30'),
  missingMin: z.number().nonnegative().optional(),
  scan: z.boolean().default(true),
});

export type ReceiptsConfig = z.infer<typeof configSchema>;

const DEFAULTS: ReceiptsConfig = configSchema.parse({});
const KRW_MISSING_MIN = 30_000;
const OTHER_MISSING_MIN = 30;

export function readReceiptsConfig(ctx: PluginContext): ReceiptsConfig {
  const parsed = configSchema.safeParse(ctx.config);
  if (parsed.success) return parsed.data;
  ctx.log.warn('receipts: invalid config, using defaults', { issues: parsed.error.issues.length });
  return DEFAULTS;
}

export function missingMinimum(config: ReceiptsConfig, homeCurrency: string): number {
  if (config.missingMin !== undefined) return config.missingMin;
  return homeCurrency.toUpperCase() === 'KRW' ? KRW_MISSING_MIN : OTHER_MISSING_MIN;
}
