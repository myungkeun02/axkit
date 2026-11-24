import { describe, expect, it } from 'vitest';
import { LedgerStore } from '../../../src/skills/spending/ledger.js';
import type { NewSpendEntry } from '../../../src/skills/spending/ledger.js';
import { monthRange } from '../../../src/core/time/local-day.js';
import { MapKeyValueStore } from '../../core/helpers.js';

const TZ = 'Asia/Seoul';
const BASE = new Date('2026-11-17T09:00:00+09:00');

function newEntry(overrides: Partial<NewSpendEntry> = {}): NewSpendEntry {
  return {
    at: BASE,
    merchant: '스타벅스',
    merchantKey: '스타벅스',
    amount: 12_300,
    currency: 'KRW',
    originalAmount: 12_300,
    source: 'sms',
    category: 'cafe',
    categorySource: 'rule',
    ...overrides,
  };
}

function at(minutesFromBase: number): Date {
  return new Date(BASE.getTime() + minutesFromBase * 60_000);
}

async function setup(): Promise<{ store: MapKeyValueStore; ledger: LedgerStore }> {
  const store = new MapKeyValueStore();
  return { store, ledger: new LedgerStore(store, TZ) };
}

function entriesOf(store: MapKeyValueStore, month: string): Promise<unknown> {
  return store.get(`entries:${month}`);
}

describe('LedgerStore.add', () => {
  it('adds an entry, shards it by owner month and remembers its ref', async () => {
    const { store, ledger } = await setup();
    const result = await ledger.add(newEntry({ ref: 'sms:1' }));

    expect(result.status).toBe('added');
    expect(result.entry).toMatchObject({ merchant: '스타벅스', amount: 12_300, source: 'sms' });
    expect(await entriesOf(store, '2026-11')).toHaveLength(1);
    expect(await ledger.hasRef('sms:1')).toBe(true);
    expect(await ledger.monthsTouched()).toEqual(['2026-11']);
  });

  it('skips the same ref twice', async () => {
    const { ledger } = await setup();
    await ledger.add(newEntry({ ref: 'sms:1' }));
    const second = await ledger.add(newEntry({ ref: 'sms:1', at: at(120) }));

    expect(second.status).toBe('duplicate');
    expect(await ledger.list(monthRange('2026-11', TZ))).toHaveLength(1);
  });

  it('keeps one entry when SMS and chat announce the same payment five minutes apart', async () => {
    const { ledger } = await setup();
    const first = await ledger.add(newEntry({ source: 'sms' }));
    const second = await ledger.add(newEntry({ source: 'chat', at: at(5) }));

    expect(first.status).toBe('added');
    expect(second.status).toBe('duplicate');
    expect(await ledger.list(monthRange('2026-11', TZ))).toHaveLength(1);
  });

  it('does not merge two different merchants at the same amount', async () => {
    const { ledger } = await setup();
    await ledger.add(newEntry({ merchant: '스타벅스', merchantKey: '스타벅스' }));
    const second = await ledger.add(
      newEntry({ merchant: '투썸', merchantKey: '투썸', at: at(5) }),
    );

    expect(second.status).toBe('added');
    expect(await ledger.list(monthRange('2026-11', TZ))).toHaveLength(2);
  });

  it('keeps an approval and its cancellation as separate signed entries', async () => {
    const { ledger } = await setup();
    await ledger.add(newEntry());
    const cancelled = await ledger.add(
      newEntry({ amount: -12_300, originalAmount: -12_300, at: at(5) }),
    );

    expect(cancelled.status).toBe('added');
    const entries = await ledger.list(monthRange('2026-11', TZ));
    expect(entries.map((entry) => entry.amount)).toEqual([12_300, -12_300]);
  });

  it('marks the card entry when the receipt mail arrives later', async () => {
    const { ledger } = await setup();
    const card = await ledger.add(newEntry({ ref: 'sms:1' }));
    const mail = await ledger.add(newEntry({ source: 'mail', at: at(60), ref: 'mail:m1' }));

    expect(mail.status).toBe('merged');
    expect(mail.entry.id).toBe(card.entry.id);
    expect(mail.entry.hasReceipt).toBe(true);
    expect(mail.entry.source).toBe('sms');
    expect(await ledger.hasRef('mail:m1')).toBe(true);
    expect(await ledger.list(monthRange('2026-11', TZ))).toHaveLength(1);
  });

  it('replaces the mail entry fields when the card notice arrives later', async () => {
    const { ledger } = await setup();
    const mail = await ledger.add(newEntry({ source: 'mail', at: at(-60), ref: 'mail:m1' }));
    const card = await ledger.add(
      newEntry({ source: 'sms', at: BASE, card: '신한카드', ref: 'sms:1' }),
    );

    expect(card.status).toBe('merged');
    expect(card.entry.id).toBe(mail.entry.id);
    expect(card.entry).toMatchObject({ source: 'sms', card: '신한카드', hasReceipt: true });
    expect(await ledger.list(monthRange('2026-11', TZ))).toHaveLength(1);
  });
});

describe('LedgerStore reads and updates', () => {
  it('lists only the requested range, ascending, and gets one entry', async () => {
    const { ledger } = await setup();
    const october = await ledger.add(newEntry({ at: new Date('2026-10-15T12:00:00+09:00'), merchant: '이마트', merchantKey: '이마트' }));
    await ledger.add(newEntry({ at: new Date('2026-11-01T08:00:00+09:00') }));
    await ledger.add(newEntry({ at: new Date('2026-11-20T08:00:00+09:00'), merchant: '투썸', merchantKey: '투썸' }));

    const november = await ledger.list(monthRange('2026-11', TZ));
    expect(november).toHaveLength(2);
    expect(november[0]!.at < november[1]!.at).toBe(true);

    const found = await ledger.get(october.entry.id);
    expect(found).toMatchObject({ merchant: '이마트' });
  });

  it('moves an entry between month shards when its date is patched', async () => {
    const { ledger } = await setup();
    const created = await ledger.add(newEntry({ at: new Date('2026-11-30T23:00:00+09:00') }));
    const updated = await ledger.update(created.entry.id, {
      at: new Date('2026-12-01T01:00:00+09:00').toISOString(),
    });

    expect(updated?.at).toBe(new Date('2026-12-01T01:00:00+09:00').toISOString());
    expect(await ledger.list(monthRange('2026-11', TZ))).toHaveLength(0);
    expect(await ledger.list(monthRange('2026-12', TZ))).toHaveLength(1);
  });

  it('peeks an entry for a confirmation card hint', async () => {
    const { ledger } = await setup();
    const created = await ledger.add(newEntry());
    await ledger.list(monthRange('2026-11', TZ));

    expect(ledger.peek(created.entry.id)?.merchant).toBe('스타벅스');
    expect(ledger.peek('missing')).toBeUndefined();
  });
});
