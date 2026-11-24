import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

const llmRoute = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  tiers: z.array(z.enum(['fast', 'standard', 'deep', 'cheap'])).min(1),
  maxSensitivity: z.enum(['public', 'masked', 'sensitive']),
});

const llmProvider = z.object({
  id: z.string().min(1),
  /** Anthropic, any OpenAI-compatible API, or a logged-in subscription CLI. */
  kind: z.enum(['anthropic', 'openai-compatible', 'claude-cli', 'codex-cli']),
  baseUrl: z.url().optional(),
  /** Keychain secret name holding the API key; omitted for local servers and subscription CLIs. */
  apiKeySecret: z.string().optional(),
  /** Executable for CLI kinds; defaults to "claude" or "codex". */
  command: z.string().min(1).optional(),
  /** USD per million tokens, for the budget. Local models and subscription CLIs are 0. */
  priceIn: z.number().nonnegative().default(0),
  priceOut: z.number().nonnegative().default(0),
});

/**
 * ~/.ax-kit/config.json. Holds names and choices only. Secrets live in the Keychain and are referenced by name.
 */
export const ConfigSchema = z.object({
  version: z.literal(1),
  assistant: z.object({
    /** The name the owner picked for their assistant. */
    name: z.string().trim().min(1).max(40),
    language: z.enum(['ko', 'en']).default('ko'),
    /** How the assistant speaks: polite (Korean 해요체), formal (합쇼체), casual (반말). */
    tone: z.enum(['polite', 'formal', 'casual']).default('polite'),
    /** What the assistant calls the owner; empty means no name. */
    ownerName: z.string().trim().max(40).optional(),
    /** IANA zone, e.g. "Asia/Seoul". */
    timezone: z.string().min(1),
    /** Non-urgent notices wait until `to`. The range may cross midnight (23:00 → 07:00). */
    quietHours: z.object({ from: hhmm, to: hhmm }).optional(),
  }),
  owner: z
    .object({
      /** Discord user id of the only person whose messages count as instructions. Needed when Discord is a channel. */
      discordUserId: z.string().regex(/^\d{5,25}$/).optional(),
    })
    .default({}),
  /** Where the owner talks to the assistant: Discord, the phone app (no Discord at all), or both. */
  channel: z.enum(['discord', 'app', 'both']).default('discord'),
  policy: z
    .object({
      confirmWrites: z.boolean().default(false),
      expiresMinutes: z.number().int().min(1).max(1440).default(30),
    })
    .default({ confirmWrites: false, expiresMinutes: 30 }),
  llm: z
    .object({
      providers: z.array(llmProvider).default([]),
      routes: z.array(llmRoute).default([]),
      budget: z
        .object({ dailyUsd: z.number().nonnegative().default(1), monthlyUsd: z.number().nonnegative().default(20) })
        .default({ dailyUsd: 1, monthlyUsd: 20 }),
    })
    .default({ providers: [], routes: [], budget: { dailyUsd: 1, monthlyUsd: 20 } }),
  /** Days to keep LLM usage rows and audit entries; older rows are pruned once a day. */
  retention: z
    .object({
      usageDays: z.number().int().min(31).max(3650).default(400),
      auditDays: z.number().int().min(30).max(3650).default(365),
    })
    .default({ usageDays: 400, auditDays: 365 }),
  /** Proactive messages: a daily total for non-urgent notices; the rest are folded into one evening message. */
  notify: z
    .object({
      dailyBudget: z.number().int().min(0).max(500).default(20),
      digestAt: hhmm.default('20:00'),
    })
    .default({ dailyBudget: 20, digestAt: '20:00' }),
  /** Per-plugin switch and settings, keyed by plugin id. */
  plugins: z
    .record(z.string(), z.object({ enabled: z.boolean().default(true) }).catchall(z.unknown()))
    .default({}),
}).superRefine((config, issue) => {
  if (config.channel !== 'app' && config.owner.discordUserId === undefined) {
    issue.addIssue({ code: 'custom', path: ['owner', 'discordUserId'], message: 'needed when the channel includes Discord' });
  }
});

export type Config = z.infer<typeof ConfigSchema>;

export function usesDiscord(config: Pick<Config, 'channel'>): boolean {
  return config.channel !== 'app';
}

export function usesApp(config: Pick<Config, 'channel'>): boolean {
  return config.channel !== 'discord';
}
export type ConfigInput = z.input<typeof ConfigSchema>;
