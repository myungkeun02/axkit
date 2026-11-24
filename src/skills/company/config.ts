import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';
import type { CompanyConfig } from './types.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const tier = z.enum(['fast', 'standard', 'deep', 'cheap']);

const team = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().min(1).max(300),
  scope: z.array(z.string().trim().min(1).max(40)).max(40).default([]),
  lead: z.object({ tier: tier.default('standard') }).default({ tier: 'standard' }),
  member: z.object({ tier: tier.default('fast') }).default({ tier: 'fast' }),
  sensitivity: z.enum(['public', 'masked', 'sensitive']).default('masked'),
  kind: z.enum(['general', 'dev']).default('general'),
  repo: z.string().min(1).max(200).optional(),
  channel: z.string().regex(/^\d{5,25}$/).optional(),
});

const schema = z.object({
  teams: z.array(team).max(12).default([]),
  limits: z
    .object({
      maxOpen: z.number().int().min(1).max(50).default(6),
      maxOpenPerTeam: z.number().int().min(1).max(20).default(2),
      maxAgeHours: z.number().int().min(1).max(24 * 30).default(72),
      ownerWaitDays: z.number().int().min(1).max(30).default(7),
      maxRevisions: z.number().int().min(0).max(3).default(1),
      maxSteps: z.number().int().min(1).max(8).default(4),
    })
    .default({ maxOpen: 6, maxOpenPerTeam: 2, maxAgeHours: 72, ownerWaitDays: 7, maxRevisions: 1, maxSteps: 4 }),
  dailyUsd: z.number().nonnegative().max(100).default(0.3),
  reportAt: z.string().regex(HHMM).default('18:00'),
  prefix: z.string().trim().min(1).max(20).default('회사'),
  mailIntake: z
    .object({
      enabled: z.boolean().default(false),
      query: z.string().max(200).default(''),
      everyMinutes: z.number().int().min(10).max(1440).default(30),
    })
    .default({ enabled: false, query: '', everyMinutes: 30 }),
});

export type CompanyConfigInput = z.input<typeof schema>;

export function parseCompanyConfig(raw: unknown): CompanyConfig {
  const parsed = schema.parse(raw);
  const ids = new Set<string>();
  for (const item of parsed.teams) {
    if (ids.has(item.id)) throw new Error(`Duplicate team id: ${item.id}`);
    ids.add(item.id);
    if (item.kind === 'dev' && item.repo === undefined) throw new Error(`Dev team ${item.id} needs a repo`);
  }
  return parsed as CompanyConfig;
}

/** Invalid config never stops the app: company mode stays idle with no teams and says why in the log. */
export function readCompanyConfig(ctx: PluginContext): CompanyConfig {
  try {
    return parseCompanyConfig(ctx.config);
  } catch (error) {
    ctx.log.warn('company: invalid config, no teams', { error: error instanceof Error ? error.message : 'invalid' });
    return parseCompanyConfig({});
  }
}
