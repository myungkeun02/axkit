import { z } from 'zod';
import { DEFAULT_FILE_RULES } from '../../core/files/filter.js';
import type { FileRules } from '../../core/files/filter.js';
import type { Logger } from '../../core/log/types.js';

const MAX_ALLOWED_BYTES = 5_000_000;

const configSchema = z.object({
  folders: z.array(z.string().trim().min(1)).max(50).default([]),
  extensions: z.array(z.string().trim().min(1)).max(50).optional(),
  maxBytes: z.number().int().min(1).max(MAX_ALLOWED_BYTES).default(DEFAULT_FILE_RULES.maxBytes),
  exclude: z.array(z.string()).max(100).default([]),
  includeHidden: z.boolean().default(false),
});

export interface LocalFilesSettings {
  folders: readonly string[];
  rules: FileRules;
  includeHidden: boolean;
}

function normalizeExtensions(extensions: readonly string[]): string[] {
  return extensions.map((value) => value.toLowerCase().replace(/^\./, '')).filter((value) => value !== '');
}

export function readLocalFilesSettings(config: Readonly<Record<string, unknown>>, log: Logger): LocalFilesSettings {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    log.warn('local-files: invalid config, nothing will be listed', { issues: parsed.error.issues.length });
    return { folders: [], rules: DEFAULT_FILE_RULES, includeHidden: false };
  }
  const extensions =
    parsed.data.extensions === undefined ? [...DEFAULT_FILE_RULES.extensions] : normalizeExtensions(parsed.data.extensions);
  return {
    folders: parsed.data.folders,
    rules: { extensions, maxBytes: parsed.data.maxBytes, exclude: parsed.data.exclude },
    includeHidden: parsed.data.includeHidden,
  };
}
