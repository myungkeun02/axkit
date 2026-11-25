import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = z.string().regex(HHMM);

const waterSchema = z.object({
  everyMinutes: z.number().int().min(15).max(720).default(120),
  from: time.default('10:00'),
  to: time.default('20:00'),
});

const medSchema = z.object({
  name: z.string().min(1).max(60),
  at: time,
});

const healthSchema = z.object({
  stepGoal: z.number().int().min(0).max(100_000).default(6_000),
  water: z.union([z.literal(false), waterSchema]).default(false),
  meds: z.array(medSchema).max(20).default([]),
});

export type HealthSettings = z.infer<typeof healthSchema>;
export type WaterSettings = z.infer<typeof waterSchema>;
export type MedSettings = z.infer<typeof medSchema>;

/** Moments the assistant may speak first. The day ones are on; spending stays off until the owner turns it on. */
const nudgesSchema = z.object({
  /** An event starts in 30–60 minutes and the data holds something to prepare. */
  beforeEvent: z.boolean().default(true),
  /** Late morning and late afternoon: what is left today. */
  midday: z.boolean().default(true),
  /** A payment much larger than the same category usually is. */
  spend: z.boolean().default(false),
  /** Lines these nudges may send per owner-zone day and per rolling hour. */
  perDay: z.number().int().min(1).max(30).default(4),
  perHour: z.number().int().min(1).max(10).default(1),
  /** A payment is unusual at this many times the category median (90 days, at least 5 samples). */
  spendRatio: z.number().min(1.5).max(20).default(3),
});

export type NudgeSettings = z.infer<typeof nudgesSchema>;

const configSchema = z.object({
  prep: z.boolean().default(true),
  travel: z.boolean().default(true),
  /** A meeting with a video link (Meet, Zoom, Teams): its join link ten minutes before. */
  meetLinks: z.boolean().default(true),
  /** Route cards through the browser agent (Naver/Kakao maps): rides, when to leave, and the next departures before leaving. */
  transit: z.boolean().default(true),
  /** Weekdays at work with nothing over lunch: "점심 드셔야죠!" and places nearby. */
  lunch: z.boolean().default(true),
  /** Learns home and work from the phone's location (for lunch and the briefing's weather). */
  places: z.boolean().default(true),
  close: z.boolean().default(true),
  replies: z.boolean().default(true),
  voice: z.boolean().default(true),
  /** false switches health off; an object configures it and leaves it on. */
  health: z.union([z.boolean(), healthSchema]).default(true),
  prepAt: time.default('20:00'),
  closeAt: time.default('21:30'),
  repliesAt: time.default('17:30'),
  travelBufferMinutes: z.number().int().min(0).max(180).default(15),
  /** Judge prep and close cards first: one fitted line, the card alone, or silence. Off keeps the fixed cards. */
  situational: z.boolean().default(false),
  nudges: nudgesSchema.default(nudgesSchema.parse({})),
});

export type DayConfig = z.infer<typeof configSchema>;

const DEFAULTS: DayConfig = configSchema.parse({});

export function readDayConfig(ctx: PluginContext): DayConfig {
  const parsed = configSchema.safeParse(ctx.config);
  if (parsed.success) return parsed.data;
  ctx.log.warn('day: invalid config, using defaults', { issues: parsed.error.issues.length });
  return DEFAULTS;
}

export function healthSettings(config: DayConfig): HealthSettings | undefined {
  if (config.health === false) return undefined;
  if (config.health === true) return healthSchema.parse({});
  return config.health;
}
