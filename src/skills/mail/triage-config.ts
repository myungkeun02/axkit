import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';

const triageSchema = z.object({
  enabled: z.boolean().default(true),
  /** New mail is looked at this often; only new mail costs a model call. */
  everyMinutes: z.number().int().min(1).max(1440).default(2),
  /**
   * Reply drafts are written without asking first (a draft stays in the mailbox and can be deleted); only sending asks.
   * Off: the older "답장 초안을 만들어 둘까요?" card comes first.
   */
  autoDraft: z.boolean().default(true),
  /** Normal mail is collected and sent as one digest at most this often. */
  digestHours: z.number().min(1).max(24).default(3),
  /** Addresses ("mina@example.com") or domains ("@example.com") triage never looks at. */
  quietSenders: z.array(z.string().min(1).max(200)).max(500).default([]),
});

export type TriageConfig = z.infer<typeof triageSchema>;

const DEFAULTS: TriageConfig = triageSchema.parse({});

/** Reads `plugins["skill.mail"].triage`; a broken section falls back to the defaults with a warning. */
export function readTriageConfig(ctx: PluginContext): TriageConfig {
  const raw = ctx.config['triage'];
  if (raw === undefined) return DEFAULTS;
  const parsed = triageSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  ctx.log.warn('mail triage: invalid config, using defaults', { issues: parsed.error.issues.length });
  return DEFAULTS;
}

/** "Mina <MINA@example.com>" → "mina@example.com". */
export function bareAddress(address: string): string {
  const match = /<([^>]+)>/.exec(address);
  return (match?.[1] ?? address).trim().toLowerCase();
}

/** True when the sender matches a quiet address or a quiet "@domain". */
export function isQuietSender(from: string, quiet: readonly string[]): boolean {
  const address = bareAddress(from);
  if (address === '') return false;
  return quiet.some((entry) => {
    const wanted = entry.trim().toLowerCase();
    if (wanted === '') return false;
    return wanted.startsWith('@') ? address.endsWith(wanted) : address === bareAddress(wanted);
  });
}
