import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';

const slug = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'Use owner/name.');
const baseBranch = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'Invalid branch name.');

const repos = z
  .array(
    z.object({
      slug,
      path: z.string().min(1).refine((value) => isAbsolute(value), 'The clone path must be absolute.'),
      base: baseBranch.default('main'),
      test: z.array(z.string().min(1).max(200)).min(1).max(16).optional(),
      testTimeoutSeconds: z.number().int().min(30).max(7200).default(900),
    }),
  )
  .max(20)
  .default([]);

export const devConfigSchema = z.object({
  repos,
  coder: z.enum(['claude-cli', 'codex-cli', 'llm']).default('claude-cli'),
  coderCommand: z.string().min(1).max(500).optional(),
  coderTimeoutSeconds: z.number().int().min(60).max(7200).default(1200),
});

export type DevConfig = z.infer<typeof devConfigSchema>;
export type RepoConfig = z.infer<typeof repos>[number];
export type CoderKind = DevConfig['coder'];

export function findRepo(config: DevConfig, slug: string): RepoConfig | undefined {
  return config.repos.find((repo) => repo.slug === slug);
}

/** English because the model reads tool errors; `dev.repos` has the configured slugs. */
export function unknownRepoError(config: DevConfig, slug: string): Error {
  const configured = config.repos.map((repo) => repo.slug);
  return new Error(
    `Unknown repository "${slug}". Configured: ${configured.length === 0 ? 'none' : configured.join(', ')}.`,
  );
}

const DEFAULTS: DevConfig = devConfigSchema.parse({});

/** Reads the skill's own config section; an invalid section falls back to defaults with a warning. */
export function readDevConfig(ctx: PluginContext): DevConfig {
  const parsed = devConfigSchema.safeParse(ctx.config);
  if (parsed.success) return parsed.data;
  ctx.log.warn('dev-assist: invalid config, using defaults', { issues: parsed.error.issues.length });
  return DEFAULTS;
}
