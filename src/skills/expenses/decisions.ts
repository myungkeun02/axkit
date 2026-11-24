import { z } from 'zod';
import type { KeyValueStore } from '../../core/store/types.js';

export type ClaimDecision = 'claim' | 'personal';

export interface DecisionRecord {
  decision: ClaimDecision;
  ruleId?: string;
  at: string;
}

export interface DecisionLookup {
  entry(id: string): Promise<DecisionRecord | undefined>;
  merchant(key: string): Promise<DecisionRecord | undefined>;
}

export interface MarkDecisionInput {
  entryId?: string;
  merchantKey?: string;
  decision: ClaimDecision;
  ruleId?: string;
  at: Date;
}

export const ENTRY_KEY = 'entry';
export const MERCHANT_KEY = 'merchant';
export const MAX_DECISIONS = 3000;

const recordSchema = z.object({
  decision: z.enum(['claim', 'personal']),
  ruleId: z.string().min(1).max(60).optional(),
  at: z.string().min(1),
});

const storeSchema = z.record(z.string(), recordSchema);
type Store = Record<string, DecisionRecord>;

function emptyStore(): Store {
  // Null prototype so a merchant key such as "__proto__" stays an ordinary key.
  return Object.create(null) as Store;
}

async function read(kv: KeyValueStore, key: string): Promise<Store> {
  const raw = await kv.get<unknown>(key);
  if (raw === undefined) return emptyStore();
  const parsed = storeSchema.safeParse(raw);
  if (!parsed.success) return emptyStore();
  const store = emptyStore();
  for (const [name, record] of Object.entries(parsed.data)) {
    store[name] = {
      decision: record.decision,
      ...(record.ruleId !== undefined ? { ruleId: record.ruleId } : {}),
      at: record.at,
    };
  }
  return store;
}

function put(store: Store, key: string, record: DecisionRecord): Store {
  const next = emptyStore();
  for (const [name, value] of Object.entries(store)) next[name] = value;
  next[key] = record;
  return next;
}

function prune(store: Store): Store {
  const keys = Object.keys(store);
  if (keys.length <= MAX_DECISIONS) return store;
  const sorted = [...keys].sort((left, right) => {
    const byTime = (store[left]?.at ?? '').localeCompare(store[right]?.at ?? '');
    return byTime !== 0 ? byTime : left.localeCompare(right);
  });
  const keep = new Set(sorted.slice(sorted.length - MAX_DECISIONS));
  const next = emptyStore();
  for (const key of keys) {
    const value = store[key];
    if (keep.has(key) && value !== undefined) next[key] = value;
  }
  return next;
}

/** Learned claim/personal decisions per entry and per merchant, bounded to the newest 3000 keys each. */
export class DecisionStore implements DecisionLookup {
  constructor(private readonly kv: KeyValueStore) {}

  async entry(id: string): Promise<DecisionRecord | undefined> {
    return (await read(this.kv, ENTRY_KEY))[id];
  }

  async merchant(key: string): Promise<DecisionRecord | undefined> {
    return (await read(this.kv, MERCHANT_KEY))[key];
  }

  async mark(input: MarkDecisionInput): Promise<void> {
    const record: DecisionRecord = {
      decision: input.decision,
      ...(input.ruleId !== undefined ? { ruleId: input.ruleId } : {}),
      at: input.at.toISOString(),
    };
    if (input.entryId !== undefined && input.entryId !== '') {
      await this.kv.set(ENTRY_KEY, prune(put(await read(this.kv, ENTRY_KEY), input.entryId, record)));
    }
    if (input.merchantKey !== undefined && input.merchantKey !== '') {
      await this.kv.set(MERCHANT_KEY, prune(put(await read(this.kv, MERCHANT_KEY), input.merchantKey, record)));
    }
  }
}
