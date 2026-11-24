import { z } from 'zod';
import type { KeyValueStore } from '../../core/store/types.js';
import type { DocEntry } from './types.js';
import { DOC_KINDS } from './types.js';

export const MONTH_CAP = 1_000;
export const SEEN_CAP = 5_000;
const SEEN_KEY = 'seen';

const entrySchema = z.object({
  id: z.string(),
  mailId: z.string(),
  kind: z.enum(DOC_KINDS),
  subject: z.string(),
  from: z.string(),
  at: z.string(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  merchant: z.string().optional(),
  merchantKey: z.string().optional(),
  files: z.array(z.string()),
});

function docsKey(ym: string): string {
  return `docs:${ym}`;
}

function toEntry(value: unknown): DocEntry | undefined {
  const parsed = entrySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  return {
    id: data.id,
    mailId: data.mailId,
    kind: data.kind,
    subject: data.subject,
    from: data.from,
    at: data.at,
    files: data.files,
    ...(data.amount !== undefined ? { amount: data.amount } : {}),
    ...(data.currency !== undefined ? { currency: data.currency } : {}),
    ...(data.merchant !== undefined ? { merchant: data.merchant } : {}),
    ...(data.merchantKey !== undefined ? { merchantKey: data.merchantKey } : {}),
  };
}

export async function loadMonth(kv: KeyValueStore, ym: string): Promise<DocEntry[]> {
  const stored = await kv.get<unknown>(docsKey(ym));
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((value) => {
    const entry = toEntry(value);
    return entry === undefined ? [] : [entry];
  });
}

/** Appends one document to its month index, keeping the newest 1000 entries. */
export async function addEntry(kv: KeyValueStore, ym: string, entry: DocEntry): Promise<void> {
  const entries = await loadMonth(kv, ym);
  const next = [...entries, entry].sort((left, right) => left.at.localeCompare(right.at));
  await kv.set(docsKey(ym), next.length > MONTH_CAP ? next.slice(next.length - MONTH_CAP) : next);
}

export async function loadSeen(kv: KeyValueStore): Promise<string[]> {
  const stored = await kv.get<unknown>(SEEN_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.filter((value): value is string => typeof value === 'string' && value !== '');
}

/** Records scanned mail ids, keeping the newest 5000 so a long-running vault stays bounded. */
export async function addSeen(kv: KeyValueStore, ids: readonly string[]): Promise<void> {
  const seen = new Set(await loadSeen(kv));
  for (const id of ids) {
    if (id !== '') seen.add(id);
  }
  const list = [...seen];
  await kv.set(SEEN_KEY, list.length > SEEN_CAP ? list.slice(list.length - SEEN_CAP) : list);
}
