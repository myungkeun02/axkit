import { describe, expect, it } from 'vitest';
import { findAmounts } from '../../../src/skills/spending/parsers/amount.js';

function single(text: string) {
  const found = findAmounts(text);
  expect(found).toHaveLength(1);
  return found[0];
}

describe('findAmounts', () => {
  it('finds KRW in all common shapes', () => {
    expect(single('12,345원')).toMatchObject({ amount: 12345, currency: 'KRW' });
    expect(single('₩12,345')).toMatchObject({ amount: 12345, currency: 'KRW' });
    expect(single('KRW 12,345')).toMatchObject({ amount: 12345, currency: 'KRW' });
  });

  it('finds USD before and after the number', () => {
    expect(single('$12.34')).toMatchObject({ amount: 12.34, currency: 'USD' });
    expect(single('US$12.34')).toMatchObject({ amount: 12.34, currency: 'USD' });
    expect(single('USD 12.34')).toMatchObject({ amount: 12.34, currency: 'USD' });
    expect(single('12.34 USD')).toMatchObject({ amount: 12.34, currency: 'USD' });
  });

  it('finds EUR, JPY and GBP', () => {
    expect(single('€20.50')).toMatchObject({ amount: 20.5, currency: 'EUR' });
    expect(single('EUR 20.50')).toMatchObject({ amount: 20.5, currency: 'EUR' });
    expect(single('¥1,200')).toMatchObject({ amount: 1200, currency: 'JPY' });
    expect(single('1,200円')).toMatchObject({ amount: 1200, currency: 'JPY' });
    expect(single('£9.99')).toMatchObject({ amount: 9.99, currency: 'GBP' });
    expect(single('GBP 9.99')).toMatchObject({ amount: 9.99, currency: 'GBP' });
  });

  it('returns every amount in text order with its position', () => {
    const found = findAmounts('USD 12.34 (원화 17,276원)');
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ currency: 'USD', index: 0 });
    expect(found[1]).toMatchObject({ currency: 'KRW', amount: 17276 });
    expect(found[0]!.index).toBeLessThan(found[1]!.index);
  });
});
