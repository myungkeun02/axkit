import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const PickedSchema = z.object({
  path: z.string().trim().min(1),
  name: z.string().trim().min(1).max(80),
  company: z.string().trim().min(1).max(80),
  /** "github.com/owner/repo" when the project is a git repository with an origin. */
  remote: z.string().trim().max(200).optional(),
});

const ConfigSchema = z.object({
  folders: z.array(z.string().trim().min(1)).max(30).default([]),
  /** Projects the owner picked (setup or the app): each gets its own knowledge document and a dev team. */
  projects: z.array(PickedSchema).max(200).default([]),
  /** Claude Code and Codex sessions in the picked projects are read and summarized. */
  sessions: z.boolean().default(true),
  /** "deep": the first look reads everything it may (slow, thorough); "quick": the older small sample. */
  depth: z.enum(['deep', 'quick']).default('deep'),
  drive: z.boolean().default(true),
  signals: z.boolean().default(true),
  autoStart: z.boolean().default(true),
  dailyAt: z.string().regex(HHMM).default('04:30'),
  maxSummariesPerRun: z.number().int().min(0).max(500).default(60),
  excerptBytes: z.number().int().min(500).max(20_000).default(6_000),
  driveLimit: z.number().int().min(0).max(500).default(100),
  consentAt: z.string().optional(),
});

export type OnboardingConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_ONBOARDING_CONFIG: OnboardingConfig = ConfigSchema.parse({});

export function readOnboardingConfig(ctx: PluginContext): OnboardingConfig {
  const parsed = ConfigSchema.safeParse(ctx.config);
  if (parsed.success) return parsed.data;
  ctx.log.warn('onboarding: invalid config, using defaults', { issues: parsed.error.issues.length });
  return DEFAULT_ONBOARDING_CONFIG;
}
