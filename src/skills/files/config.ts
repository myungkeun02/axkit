import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';

const configSchema = z.object({
  /** How often the index job rescans the connectors. */
  indexSeconds: z.number().int().min(60).max(86_400).default(3_600),
});

export type FilesConfig = z.infer<typeof configSchema>;

const DEFAULTS: FilesConfig = configSchema.parse({});

export function readFilesConfig(ctx: PluginContext): FilesConfig {
  const parsed = configSchema.safeParse(ctx.config);
  if (parsed.success) return parsed.data;
  ctx.log.warn('files: invalid config, using defaults', { issues: parsed.error.issues.length });
  return DEFAULTS;
}
