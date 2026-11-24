import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = z.string().regex(HHMM);

const configSchema = z.object({
  repliesAt: time.default('18:00'),
  olderThanHours: z.number().int().min(1).max(168).default(3),
  appointments: z.boolean().default(true),
  appointmentSeconds: z.number().int().min(30).max(86_400).default(600),
  /** Also look for appointments in text messages the phone forwards (phone.sms). Off until the owner turns it on. */
  sms: z.boolean().default(false),
});

export type ChatInboxConfig = z.infer<typeof configSchema>;

const DEFAULTS: ChatInboxConfig = configSchema.parse({});

export function readChatInboxConfig(ctx: PluginContext): ChatInboxConfig {
  const parsed = configSchema.safeParse(ctx.config);
  if (parsed.success) return parsed.data;
  ctx.log.warn('chat-inbox: invalid config, using defaults', { issues: parsed.error.issues.length });
  return DEFAULTS;
}
