import { z } from 'zod';
import { SPEND_CATEGORIES } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export function minutesOfHhmm(hhmm: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (match === null) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

export const ruleFields = z.object({
  id: z.string().regex(SLUG).describe('Stable slug for the rule, e.g. "weekday_lunch".'),
  name: z.string().min(1).max(60).describe('Owner-facing rule name shown in the claim mail.'),
  categories: z.array(z.enum(SPEND_CATEGORIES)).min(1).max(15).optional().describe('Spend categories this rule covers.'),
  merchants: z.array(z.string().min(1).max(60)).min(1).max(20).optional().describe('Case-insensitive merchant substrings.'),
  weekdaysOnly: z.boolean().optional().describe('Match Monday to Friday in the owner time zone only.'),
  timeFrom: z.string().regex(HHMM).optional().describe('Earliest local time (HH:MM), inclusive.'),
  timeTo: z.string().regex(HHMM).optional().describe('Latest local time (HH:MM), inclusive; may not cross midnight.'),
  minAmount: z.number().nonnegative().optional().describe('Smallest home-currency amount, inclusive.'),
  maxAmount: z.number().nonnegative().optional().describe('Largest home-currency amount, inclusive.'),
  monthlyCap: z.number().positive().optional().describe('Monthly cap; entries over it are still listed but flagged.'),
});

export type RuleConfig = z.infer<typeof ruleFields>;

export const ruleSchema = ruleFields.superRefine((rule, ctx) => {
  if (
    rule.timeFrom !== undefined &&
    rule.timeTo !== undefined &&
    minutesOfHhmm(rule.timeFrom) > minutesOfHhmm(rule.timeTo)
  ) {
    ctx.addIssue({ code: 'custom', path: ['timeTo'], message: 'timeTo must not be earlier than timeFrom' });
  }
  if (rule.minAmount !== undefined && rule.maxAmount !== undefined && rule.minAmount > rule.maxAmount) {
    ctx.addIssue({ code: 'custom', path: ['maxAmount'], message: 'maxAmount must not be below minAmount' });
  }
});

const email = z.email();

export const expensesConfigSchema = z.object({
  rules: z.array(ruleSchema).max(30).default([]),
  claimTo: z.array(email).max(20).default([]),
  claimCc: z.array(email).max(20).default([]),
  companyLabel: z.string().min(1).max(80).optional(),
  summaryDay: z.number().int().min(1).max(28).default(1),
  summaryAt: z.string().regex(HHMM).default('09:00'),
});

export type ExpensesConfig = z.infer<typeof expensesConfigSchema>;

const DEFAULTS: ExpensesConfig = expensesConfigSchema.parse({});

export function readExpensesConfig(ctx: PluginContext): ExpensesConfig {
  const parsed = expensesConfigSchema.safeParse(ctx.config);
  if (parsed.success) return parsed.data;
  ctx.log.warn('expenses: invalid config, using defaults', { issues: parsed.error.issues.length });
  return DEFAULTS;
}
