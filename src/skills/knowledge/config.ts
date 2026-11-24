import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const configSchema = z.object({
  /** When the daily rebuild folds new facts into the documents. */
  rebuildAt: z.string().regex(TIME).default('04:50'),
  profileChars: z.number().int().min(200).max(2_000).default(600),
  minStrength: z.number().min(0).max(1).default(0.2),
});

export type KnowledgeConfig = z.infer<typeof configSchema>;

const DEFAULTS: KnowledgeConfig = configSchema.parse({});

export function readKnowledgeConfig(ctx: PluginContext): KnowledgeConfig {
  const parsed = configSchema.safeParse(ctx.config);
  if (parsed.success) return parsed.data;
  ctx.log.warn('knowledge: invalid config, using defaults', { issues: parsed.error.issues.length });
  return DEFAULTS;
}
