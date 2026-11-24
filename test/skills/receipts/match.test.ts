import { describe, expect, it } from 'vitest';
import type { SpendEntry } from '../../../src/core/contracts/index.js';
import { matchSpend } from '../../../src/skills/receipts/match.js';
import type { ReceiptInfo } from '../../../src/skills/receipts/ocr-parse.js';
import { spendEntry } from './helpers.js';

const TIME_ZONE = 'Asia/Seoul';

const receipt: ReceiptInfo = {
  amount: 12_500,
  currency: 'KRW',
  merchant: '예시커피 강남점',
  date: '2026-11-15',
};

function entry(overrides: Partial<SpendEntry> = {}): SpendEntry {
  return spendEntry({
    amount: 12_500,
    originalAmount: 12_500,
    merchant: '예시커피 강남점',
    ...overrides,
  });
}

describe('matchSpend', () => {
  it('matches the same KRW amount within ±3 days', () => {
    const entries = [
      entry({ id: 'plus-three', at: '2026-11-18T12:00:00+09:00' }),
      entry({ id: 'minus-three', at: '2026-11-12T12:00:00+09:00' }),
      entry({ id: 'plus-four', at: '2026-11-19T00:00:00+09:00' }),
      entry({ id: 'wrong', at: '2026-11-15T12:00:00+09:00', amount: 13_000, originalAmount: 13_000 }),
    ];

    expect(matchSpend(receipt, entries, TIME_ZONE).map((entry) => entry.id)).toEqual([
      'plus-three',
      'minus-three',
    ]);
  });

  it('uses the charged amount when the receipt currency matches the entry currency', () => {
    const usd = entry({
      id: 'usd',
      at: '2026-11-15T12:00:00+09:00',
      amount: 17_000,
      currency: 'USD',
      originalAmount: 12.5,
    });
    const other = entry({
      id: 'home',
      at: '2026-11-15T12:00:00+09:00',
      amount: 99,
      currency: 'EUR',
      originalAmount: 12.5,
    });

    expect(matchSpend({ amount: 12.5, currency: 'USD', date: '2026-11-15' }, [usd, other], TIME_ZONE)).toEqual([usd]);
    expect(matchSpend({ amount: 12.5, currency: 'EUR', date: '2026-11-15' }, [usd], TIME_ZONE)).toEqual([]);
  });

  it('applies a 1 KRW tolerance for KRW and 0.01 elsewhere', () => {
    const krw = entry({ id: 'krw', at: '2026-11-15T12:00:00+09:00', amount: 12_500.5, originalAmount: 12_500.5 });
    expect(matchSpend({ amount: 12_500, currency: 'KRW', date: '2026-11-15' }, [krw], TIME_ZONE)).toEqual([krw]);

    const krwTooFar = entry({
      id: 'krw-far',
      at: '2026-11-15T12:00:00+09:00',
      amount: 12_501,
      originalAmount: 12_501,
    });
    expect(matchSpend({ amount: 12_500, currency: 'KRW', date: '2026-11-15' }, [krwTooFar], TIME_ZONE)).toEqual([]);

    const usd = entry({
      id: 'usd',
      at: '2026-11-15T12:00:00+09:00',
      amount: 42.505,
      currency: 'USD',
      originalAmount: 42.505,
    });
    expect(matchSpend({ amount: 42.5, currency: 'USD', date: '2026-11-15' }, [usd], TIME_ZONE)).toEqual([usd]);

    const usdTooFar = entry({
      id: 'usd-far',
      at: '2026-11-15T12:00:00+09:00',
      amount: 42.52,
      currency: 'USD',
      originalAmount: 42.52,
    });
    expect(matchSpend({ amount: 42.5, currency: 'USD', date: '2026-11-15' }, [usdTooFar], TIME_ZONE)).toEqual([]);
  });

  it('accepts any date when the receipt has none', () => {
    const entries = [
      entry({ id: 'old', at: '2020-01-01T12:00:00+09:00' }),
      entry({ id: 'new', at: '2026-11-17T12:00:00+09:00' }),
    ];

    const result = matchSpend({ amount: 12_500, currency: 'KRW' }, entries, TIME_ZONE);

    expect(result.map((entry) => entry.id).sort()).toEqual(['new', 'old']);
  });

  it('sorts by shared merchant tokens before date distance', () => {
    const entries = [
      entry({ id: 'none', merchant: '다른 가게', at: '2026-11-15T12:00:00+09:00' }),
      entry({ id: 'far', merchant: '예시커피', at: '2026-11-17T12:00:00+09:00' }),
      entry({ id: 'near', merchant: '예시커피', at: '2026-11-16T12:00:00+09:00' }),
      entry({ id: 'exact', merchant: '예시커피 강남점', at: '2026-11-12T12:00:00+09:00' }),
    ];

    expect(matchSpend(receipt, entries, TIME_ZONE).map((entry) => entry.id)).toEqual(['exact', 'near', 'far']);
  });

  it('returns at most three matches', () => {
    const entries = ['a', 'b', 'c', 'd'].map((id) =>
      entry({ id, merchant: '예시커피', at: '2026-11-15T12:00:00+09:00' }),
    );
    expect(matchSpend(receipt, entries, TIME_ZONE)).toHaveLength(3);
  });

  it('returns nothing without an amount to compare', () => {
    const entries = [entry({ id: 'a', at: '2026-11-15T12:00:00+09:00' })];
    expect(matchSpend({ merchant: '예시커피', date: '2026-11-15' }, entries, TIME_ZONE)).toEqual([]);
  });

  it('skips entries whose date cannot be read when the receipt has a date', () => {
    const entries = [entry({ id: 'broken', at: 'not-a-date' })];
    expect(matchSpend(receipt, entries, TIME_ZONE)).toEqual([]);
  });
});
