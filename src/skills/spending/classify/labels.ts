import type { SpendCategory } from '../../../core/contracts/index.js';
import { SPEND_CATEGORIES } from '../../../core/contracts/index.js';
import type { KeyValueStore } from '../../../core/store/types.js';

interface StoredLabel {
  category?: SpendCategory;
  at: string;
}

type RawLabels = Record<string, StoredLabel | string>;

interface LabelRecord {
  category?: SpendCategory;
  at: string;
}

const OWNER_KEY = 'labels:owner';
const MODEL_KEY = 'labels:model';
const KEYWORD_KEY = 'labels:keywords';
const CAP = 3000;
const CATEGORIES: ReadonlySet<string> = new Set(SPEND_CATEGORIES);

export function isSpendCategory(value: string): value is SpendCategory {
  return CATEGORIES.has(value);
}

function isCategory(value: string): value is SpendCategory {
  return isSpendCategory(value);
}

function normalizeKeyword(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function normalize(raw: StoredLabel | string): LabelRecord | undefined {
  if (typeof raw === 'string') return isCategory(raw) ? { category: raw, at: '' } : undefined;
  if (raw === null || typeof raw !== 'object') return undefined;
  const at = typeof raw.at === 'string' ? raw.at : '';
  if (raw.category === undefined) return { at };
  return isCategory(raw.category) ? { category: raw.category, at } : undefined;
}

function prune(labels: Record<string, LabelRecord>): Record<string, LabelRecord> {
  const keys = Object.keys(labels);
  if (keys.length <= CAP) return labels;
  const keep = new Set(
    keys
      .sort((left, right) => (labels[left]?.at ?? '').localeCompare(labels[right]?.at ?? ''))
      .slice(-CAP),
  );
  const result: Record<string, LabelRecord> = {};
  for (const key of keys) {
    const value = labels[key];
    if (value !== undefined && keep.has(key)) result[key] = value;
  }
  return result;
}

/** Owner labels and keyword rules are explicit corrections; model labels are cached guesses. All are capped. */
export class LabelStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => Date,
  ) {}

  private async read(key: string): Promise<Record<string, LabelRecord>> {
    const raw = await this.kv.get<RawLabels>(key);
    const result: Record<string, LabelRecord> = {};
    if (raw === undefined || raw === null || typeof raw !== 'object') return result;
    for (const [merchant, value] of Object.entries(raw)) {
      const record = normalize(value);
      if (record !== undefined) result[merchant] = record;
    }
    return result;
  }

  private async write(key: string, record: Record<string, LabelRecord>): Promise<void> {
    await this.kv.set(key, prune(record));
  }

  async owner(merchantKey: string): Promise<SpendCategory | undefined> {
    return (await this.read(OWNER_KEY))[merchantKey]?.category;
  }

  async model(merchantKey: string): Promise<SpendCategory | undefined> {
    return (await this.read(MODEL_KEY))[merchantKey]?.category;
  }

  async hasModelRecord(merchantKey: string): Promise<boolean> {
    return Object.hasOwn(await this.read(MODEL_KEY), merchantKey);
  }

  async setOwner(merchantKey: string, category: SpendCategory): Promise<void> {
    const labels = await this.read(OWNER_KEY);
    labels[merchantKey] = { category, at: this.now().toISOString() };
    await this.write(OWNER_KEY, labels);
  }

  async setModel(merchantKey: string, category: SpendCategory): Promise<void> {
    const labels = await this.read(MODEL_KEY);
    labels[merchantKey] = { category, at: this.now().toISOString() };
    await this.write(MODEL_KEY, labels);
  }

  /** Remembers that the model was asked but had no label, so the same names are not sent again. */
  async markModelAsked(merchantKey: string): Promise<void> {
    const labels = await this.read(MODEL_KEY);
    if (Object.hasOwn(labels, merchantKey)) return;
    labels[merchantKey] = { at: this.now().toISOString() };
    await this.write(MODEL_KEY, labels);
  }

  /** Owner keyword rules from tuning. The longest matching keyword wins. */
  async keywordFor(merchantKey: string): Promise<SpendCategory | undefined> {
    const rules = await this.read(KEYWORD_KEY);
    const matches = Object.entries(rules)
      .filter(([keyword, record]) => keyword !== '' && record.category !== undefined && merchantKey.includes(keyword))
      .sort(([left], [right]) => right.length - left.length || left.localeCompare(right));
    return matches[0]?.[1].category;
  }

  async setKeyword(keyword: string, category: SpendCategory): Promise<void> {
    const normalized = normalizeKeyword(keyword);
    if (normalized === '') return;
    const rules = await this.read(KEYWORD_KEY);
    rules[normalized] = { category, at: this.now().toISOString() };
    await this.write(KEYWORD_KEY, rules);
  }

  async removeKeyword(keyword: string): Promise<void> {
    const normalized = normalizeKeyword(keyword);
    const rules = await this.read(KEYWORD_KEY);
    if (!Object.hasOwn(rules, normalized)) return;
    const kept: Record<string, LabelRecord> = {};
    for (const [key, value] of Object.entries(rules)) {
      if (key !== normalized) kept[key] = value;
    }
    await this.write(KEYWORD_KEY, kept);
  }
}
