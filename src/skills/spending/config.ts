import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';

const CURRENCY = /^[A-Za-z]{3}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = z.string().regex(HHMM);

const KO_RATES: Readonly<Record<string, number>> = {
  USD: 1400,
  EUR: 1500,
  JPY: 9.5,
  GBP: 1750,
  CNY: 195,
};

function schemaFor(language: string) {
  const homeCurrency = language === 'ko' ? 'KRW' : 'USD';
  return z.object({
    homeCurrency: z
      .string()
      .regex(CURRENCY)
      .transform((value) => value.toUpperCase())
      .default(homeCurrency),
    fxRates: z.record(z.string(), z.number().positive()).default(homeCurrency === 'KRW' ? { ...KO_RATES } : {}),
    mailScan: z.boolean().default(true),
    mailScanSeconds: z.number().int().min(60).max(86_400).default(1800),
    modelLabels: z.boolean().default(true),
    reportAt: time.default('09:00'),
    monthEndAt: time.default('20:00'),
    largeAmount: z.number().positive().max(1_000_000_000_000).default(language === 'ko' ? 100_000 : 100),
    subscriptions: z.boolean().default(true),
    renewalAt: time.default('09:30'),
    renewalNoticeDays: z.number().int().min(1).max(14).default(3),
  });
}

export type SpendingConfig = z.infer<ReturnType<typeof schemaFor>>;

export function defaultSpendingConfig(language: string): SpendingConfig {
  return schemaFor(language).parse({});
}

/** Invalid config never stops the skill: it warns without echoing values and runs with the defaults. */
export function readSpendingConfig(ctx: PluginContext): SpendingConfig {
  const schema = schemaFor(ctx.assistant.language);
  const parsed = schema.safeParse(ctx.config);
  if (parsed.success) return parsed.data;
  ctx.log.warn('spending: invalid config, using defaults', { issues: parsed.error.issues.length });
  return schema.parse({});
}
