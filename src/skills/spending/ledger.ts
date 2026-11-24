import { randomUUID } from 'node:crypto';
import type { CategorySource, PaymentNoticeSource, SpendCategory, SpendEntry } from '../../core/contracts/index.js';
import type { KeyValueStore } from '../../core/store/types.js';
import { monthOf, monthPlus } from '../../core/time/local-day.js';
import { merchantsMatch } from './normalize.js';

export interface NewSpendEntry {
  at: Date;
  merchant: string;
  merchantKey: string;
  /** Home-currency amount; negative for a cancellation. */
  amount: number;
  currency: string;
  /** Charged amount; negative for a cancellation. */
  originalAmount: number;
  fxEstimated?: boolean;
  card?: string;
  source: PaymentNoticeSource | 'manual';
  category: SpendCategory;
  categorySource: CategorySource;
  installmentMonths?: number;
  hasReceipt?: boolean;
  excluded?: boolean;
  /** Stable id of the source message, used to ignore the same message twice. */
  ref?: string;
}

export interface AddResult {
  status: 'added' | 'duplicate' | 'merged';
  entry: SpendEntry;
}

interface StoredEntry extends SpendEntry {
  ref?: string;
}

const MONTHS_KEY = 'months';
const REFS_KEY = 'refs';
const MONTH_CAP = 3000;
const REF_CAP = 5000;
const CARD_SOURCES: ReadonlySet<string> = new Set(['sms', 'app', 'chat']);
const DUPLICATE_MS = 30 * 60_000;
const RECEIPT_MS = 3 * 86_400_000;

const shardKey = (month: string): string => `entries:${month}`;

function toSpendEntry(entry: StoredEntry): SpendEntry {
  const copy: StoredEntry = { ...entry };
  delete copy.ref;
  return copy;
}

/** Month-sharded ledger in the plugin key-value store; card numbers never enter it. */
export class LedgerStore {
  private readonly cache = new Map<string, StoredEntry>();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly timeZone: string,
  ) {}

  private monthOf(at: Date | string): string {
    return monthOf(typeof at === 'string' ? new Date(at) : at, this.timeZone);
  }

  private async months(): Promise<string[]> {
    const stored = await this.kv.get<string[]>(MONTHS_KEY);
    return Array.isArray(stored) ? stored : [];
  }

  private async rememberMonth(month: string): Promise<void> {
    const months = await this.months();
    if (months.includes(month)) return;
    await this.kv.set(MONTHS_KEY, [...months, month].sort());
  }

  private async shard(month: string): Promise<StoredEntry[]> {
    const stored = await this.kv.get<StoredEntry[]>(shardKey(month));
    const entries = Array.isArray(stored) ? stored : [];
    for (const entry of entries) this.cache.set(entry.id, entry);
    return entries;
  }

  private async saveShard(month: string, entries: StoredEntry[]): Promise<void> {
    const kept = entries.length > MONTH_CAP
      ? [...entries].sort((left, right) => left.at.localeCompare(right.at)).slice(-MONTH_CAP)
      : entries;
    for (const entry of kept) this.cache.set(entry.id, entry);
    await this.kv.set(shardKey(month), kept);
    await this.rememberMonth(month);
  }

  private async refs(): Promise<string[]> {
    const stored = await this.kv.get<string[]>(REFS_KEY);
    return Array.isArray(stored) ? stored : [];
  }

  async hasRef(ref: string): Promise<boolean> {
    return (await this.refs()).includes(ref);
  }

  private async rememberRef(ref: string | undefined): Promise<void> {
    if (ref === undefined || ref === '') return;
    const refs = await this.refs();
    if (refs.includes(ref)) return;
    await this.kv.set(REFS_KEY, [...refs, ref].slice(-REF_CAP));
  }

  /** Synchronous hint for confirmation cards, filled by earlier reads. */
  peek(id: string): SpendEntry | undefined {
    const entry = this.cache.get(id);
    return entry === undefined ? undefined : toSpendEntry(entry);
  }

  async get(id: string): Promise<SpendEntry | undefined> {
    const found = await this.locate(id);
    return found === undefined ? undefined : toSpendEntry(found.entry);
  }

  async list(range: { from: Date; to: Date }): Promise<SpendEntry[]> {
    const first = this.monthOf(range.from);
    const last = this.monthOf(new Date(Math.max(range.from.getTime(), range.to.getTime() - 1)));
    const known = await this.months();
    const entries: StoredEntry[] = [];
    for (let month = first; month <= last; month = monthPlus(month, 1)) {
      if (known.includes(month)) entries.push(...(await this.shard(month)));
    }
    return entries
      .filter((entry) => {
        const at = Date.parse(entry.at);
        return at >= range.from.getTime() && at < range.to.getTime();
      })
      .sort((left, right) => left.at.localeCompare(right.at))
      .map(toSpendEntry);
  }

  async monthsTouched(): Promise<string[]> {
    return this.months();
  }

  async add(candidate: NewSpendEntry): Promise<AddResult> {
    if (candidate.ref !== undefined && (await this.hasRef(candidate.ref))) {
      const existing = await this.findByRef(candidate.ref);
      return { status: 'duplicate', entry: existing ?? toSpendEntry(this.create(candidate)) };
    }

    const nearby = await this.list({
      from: new Date(candidate.at.getTime() - RECEIPT_MS),
      to: new Date(candidate.at.getTime() + RECEIPT_MS),
    });
    const sorted = nearby
      .filter((entry) => entry.excluded !== true)
      .sort(
        (left, right) =>
          Math.abs(Date.parse(left.at) - candidate.at.getTime()) -
          Math.abs(Date.parse(right.at) - candidate.at.getTime()),
      );

    for (const other of sorted) {
      const gap = Math.abs(Date.parse(other.at) - candidate.at.getTime());
      if (other.currency.toUpperCase() !== candidate.currency.toUpperCase()) continue;
      if (other.originalAmount !== candidate.originalAmount) continue;
      if (Math.sign(other.amount) !== Math.sign(candidate.amount)) continue;
      if (!merchantsMatch(other.merchantKey, candidate.merchantKey)) continue;

      const otherIsCard = CARD_SOURCES.has(other.source);
      const candidateIsCard = CARD_SOURCES.has(candidate.source);
      if (otherIsCard && candidateIsCard && gap <= DUPLICATE_MS) {
        await this.rememberRef(candidate.ref);
        return { status: 'duplicate', entry: other };
      }
      if (gap <= RECEIPT_MS && (other.source === 'mail' || candidate.source === 'mail') && (otherIsCard || candidateIsCard)) {
        const updated = other.source === 'mail' ? this.cardOverMail(other, candidate) : { ...other, hasReceipt: true };
        await this.replaceStored(other, updated);
        await this.rememberRef(candidate.ref);
        return { status: 'merged', entry: toSpendEntry(updated) };
      }
    }

    const entry = this.create(candidate);
    await this.appendStored(entry);
    await this.rememberRef(candidate.ref);
    return { status: 'added', entry: toSpendEntry(entry) };
  }

  async update(id: string, patch: Partial<Omit<SpendEntry, 'id'>>): Promise<SpendEntry | undefined> {
    const found = await this.locate(id);
    if (found === undefined) return undefined;
    const updated: StoredEntry = { ...found.entry, ...patch, id: found.entry.id };
    await this.replaceStored(found.entry, updated);
    return toSpendEntry(updated);
  }

  private create(candidate: NewSpendEntry): StoredEntry {
    const entry: StoredEntry = {
      id: randomUUID().slice(0, 8),
      at: candidate.at.toISOString(),
      merchant: candidate.merchant,
      merchantKey: candidate.merchantKey,
      amount: candidate.amount,
      currency: candidate.currency,
      originalAmount: candidate.originalAmount,
      source: candidate.source,
      category: candidate.category,
      categorySource: candidate.categorySource,
    };
    if (candidate.fxEstimated !== undefined) entry.fxEstimated = candidate.fxEstimated;
    if (candidate.card !== undefined) entry.card = candidate.card;
    if (candidate.installmentMonths !== undefined) entry.installmentMonths = candidate.installmentMonths;
    if (candidate.hasReceipt !== undefined) entry.hasReceipt = candidate.hasReceipt;
    if (candidate.excluded !== undefined) entry.excluded = candidate.excluded;
    if (candidate.ref !== undefined) entry.ref = candidate.ref;
    return entry;
  }

  private cardOverMail(mail: StoredEntry, card: NewSpendEntry): StoredEntry {
    const merged: StoredEntry = {
      id: mail.id,
      at: card.at.toISOString(),
      merchant: card.merchant,
      merchantKey: card.merchantKey,
      amount: card.amount,
      currency: card.currency,
      originalAmount: card.originalAmount,
      source: card.source,
      category: card.category,
      categorySource: card.categorySource,
      hasReceipt: true,
    };
    if (card.fxEstimated !== undefined) merged.fxEstimated = card.fxEstimated;
    if (card.card !== undefined) merged.card = card.card;
    if (card.installmentMonths !== undefined) merged.installmentMonths = card.installmentMonths;
    if (mail.excluded !== undefined) merged.excluded = mail.excluded;
    return merged;
  }

  private async appendStored(entry: StoredEntry): Promise<void> {
    const month = this.monthOf(entry.at);
    await this.saveShard(month, [...(await this.shard(month)), entry]);
  }

  private async replaceStored(oldEntry: StoredEntry, updated: StoredEntry): Promise<void> {
    const oldMonth = this.monthOf(oldEntry.at);
    const newMonth = this.monthOf(updated.at);
    if (oldMonth === newMonth) {
      const entries = (await this.shard(oldMonth)).map((entry) => (entry.id === updated.id ? updated : entry));
      await this.saveShard(oldMonth, entries);
      return;
    }
    await this.saveShard(oldMonth, (await this.shard(oldMonth)).filter((entry) => entry.id !== updated.id));
    await this.appendStored(updated);
  }

  private async locate(id: string): Promise<{ entry: StoredEntry; month: string } | undefined> {
    for (const month of await this.months()) {
      const entry = (await this.shard(month)).find((candidate) => candidate.id === id);
      if (entry !== undefined) return { entry, month };
    }
    return undefined;
  }

  private async findByRef(ref: string): Promise<SpendEntry | undefined> {
    for (const month of await this.months()) {
      const entry = (await this.shard(month)).find((candidate) => candidate.ref === ref);
      if (entry !== undefined) return toSpendEntry(entry);
    }
    return undefined;
  }
}
