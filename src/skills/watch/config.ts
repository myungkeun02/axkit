import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';
import type { MoneyCurrency } from './types.js';

const schema = z.object({ currency: z.enum(['KRW', 'USD']).optional() });

/** Home currency for target prices and messages; defaults from the assistant language. */
export function homeCurrency(ctx: PluginContext): MoneyCurrency {
  const fallback: MoneyCurrency = ctx.assistant.language === 'ko' ? 'KRW' : 'USD';
  const parsed = schema.safeParse(ctx.config);
  if (!parsed.success) {
    ctx.log.warn('watch: invalid config, using the language default');
    return fallback;
  }
  return parsed.data.currency ?? fallback;
}
