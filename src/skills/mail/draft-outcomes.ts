import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { maskForModel } from '../../core/text/mask.js';
import { ownText } from './style.js';

const DRAFTS_KEY = 'drafts';
const CASES_KEY = 'eval-cases';
const MAX_DRAFTS = 500;
const MAX_CASES = 200;
/** Not sent within a week: it counts as not used. */
const UNSENT_MS = 7 * 24 * 60 * 60 * 1000;
/** As close as this to what was sent: sent as is (whitespace and a word or two aside). */
export const AS_IS = 0.9;

const DraftSchema = z.object({
  draftId: z.string(),
  messageId: z.string(),
  threadId: z.string(),
  kind: z.string(),
  body: z.string(),
  at: z.string(),
  outcome: z.enum(['pending', 'as-is', 'edited', 'unsent']),
  similarity: z.number().optional(),
  checkedAt: z.string().optional(),
});
export type DraftRecord = z.infer<typeof DraftSchema>;

const CaseSchema = z.object({ kind: z.string(), mail: z.string(), ours: z.string(), sent: z.string(), at: z.string() });
/** A real mail, the assistant's draft and what the owner sent: the local test set. Masked. */
export type EvalCase = z.infer<typeof CaseSchema>;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** Dice overlap of the words (0–1): 1 = the same words, 0 = nothing in common. */
export function similarity(left: string, right: string): number {
  const a = words(left);
  const b = words(right);
  if (a.length === 0 && b.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of b) {
    const n = counts.get(word) ?? 0;
    if (n > 0) {
      shared += 1;
      counts.set(word, n - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

async function load<T>(ctx: PluginContext, key: string, schema: z.ZodType<T>): Promise<T[]> {
  const parsed = z.array(schema).safeParse(await ctx.kv.get<unknown>(key));
  return parsed.success ? parsed.data : [];
}

export async function recordDraft(ctx: PluginContext, draft: Omit<DraftRecord, 'outcome' | 'at'>): Promise<void> {
  const list = await load(ctx, DRAFTS_KEY, DraftSchema);
  list.push({ ...draft, body: draft.body.slice(0, 4_000), at: ctx.clock.now().toISOString(), outcome: 'pending' });
  await ctx.kv.set(DRAFTS_KEY, list.slice(-MAX_DRAFTS));
}

/**
 * For each automatic draft still pending: what the owner sent in that thread afterwards. Close to the draft = sent as
 * is; different = edited (the pair becomes a test case and a lesson for the style guide); nothing after a week = unsent.
 */
export async function checkOutcomes(ctx: PluginContext): Promise<{ edits: { ours: string; sent: string }[]; checked: number }> {
  const mail = ctx.tryUse(Contracts.mailRead);
  if (mail === undefined) return { edits: [], checked: 0 };
  const list = await load(ctx, DRAFTS_KEY, DraftSchema);
  const pending = list.filter((item) => item.outcome === 'pending');
  if (pending.length === 0) return { edits: [], checked: 0 };
  const sent = await mail.search({ text: 'in:sent', sinceHours: 24 * 14, limit: 100 }).catch(() => []);
  const cases = await load(ctx, CASES_KEY, CaseSchema);
  const edits: { ours: string; sent: string }[] = [];
  const now = ctx.clock.now();
  let checked = 0;
  for (const item of pending) {
    const reply = sent.filter((summary) => summary.threadId === item.threadId && summary.receivedAt.getTime() > Date.parse(item.at)).sort((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime())[0];
    if (reply === undefined) {
      if (now.getTime() - Date.parse(item.at) > UNSENT_MS) {
        item.outcome = 'unsent';
        item.checkedAt = now.toISOString();
        checked += 1;
      }
      continue;
    }
    const message = await mail.read(reply.id).catch(() => undefined);
    if (message === undefined) continue;
    const owners = ownText(message.body);
    const score = similarity(item.body, owners);
    item.similarity = Math.round(score * 100) / 100;
    item.outcome = score >= AS_IS ? 'as-is' : 'edited';
    item.checkedAt = now.toISOString();
    checked += 1;
    if (item.outcome === 'edited') edits.push({ ours: item.body, sent: owners });
    const original = await mail.read(item.messageId).catch(() => undefined);
    if (original !== undefined) {
      cases.push({ kind: item.kind, mail: maskForModel(`From: ${original.from}\nSubject: ${original.subject}\n\n${ownText(original.body)}`).slice(0, 3_000), ours: maskForModel(item.body), sent: maskForModel(owners).slice(0, 3_000), at: now.toISOString() });
    }
  }
  await ctx.kv.set(DRAFTS_KEY, list);
  await ctx.kv.set(CASES_KEY, cases.slice(-MAX_CASES));
  return { edits, checked };
}

export interface DraftStats {
  /** Last 30 days. */
  drafted: number;
  asIs: number;
  edited: number;
  unsent: number;
  pending: number;
  /** Mean similarity of drafts that were sent (0–1). */
  closeness?: number;
  byKind: Record<string, { drafted: number; asIs: number }>;
}

export async function draftStats(ctx: PluginContext): Promise<DraftStats> {
  const since = ctx.clock.now().getTime() - 30 * 24 * 60 * 60 * 1000;
  const list = (await load(ctx, DRAFTS_KEY, DraftSchema)).filter((item) => Date.parse(item.at) >= since);
  const sent = list.filter((item) => item.similarity !== undefined);
  const byKind: DraftStats['byKind'] = {};
  for (const item of list) {
    const entry = byKind[item.kind] ?? { drafted: 0, asIs: 0 };
    entry.drafted += 1;
    if (item.outcome === 'as-is') entry.asIs += 1;
    byKind[item.kind] = entry;
  }
  return {
    drafted: list.length,
    asIs: list.filter((item) => item.outcome === 'as-is').length,
    edited: list.filter((item) => item.outcome === 'edited').length,
    unsent: list.filter((item) => item.outcome === 'unsent').length,
    pending: list.filter((item) => item.outcome === 'pending').length,
    ...(sent.length > 0 ? { closeness: Math.round((sent.reduce((sum, item) => sum + (item.similarity ?? 0), 0) / sent.length) * 100) / 100 } : {}),
    byKind,
  };
}

export async function evalCases(ctx: PluginContext): Promise<EvalCase[]> {
  return await load(ctx, CASES_KEY, CaseSchema);
}
