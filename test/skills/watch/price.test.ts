import { describe, expect, it } from 'vitest';
import { extractPrice } from '../../../src/skills/watch/price.js';
import { extractKrw } from '../../../src/skills/watch/price-ko.js';
import { extractUsd } from '../../../src/skills/watch/price-en.js';
import { inStockOf } from '../../../src/skills/watch/restock.js';
import { addedLines, hashLines, normalizedLines } from '../../../src/skills/watch/page-diff.js';

describe('Korean price extraction', () => {
  it('prefers a price right after a sale label', () => {
    expect(extractKrw('판매가 12,900원\n정가 19,000원')).toBe(12_900);
    expect(extractKrw('할인가: ₩ 8,400')).toBe(8_400);
  });

  it('reads the next line when the label has no number', () => {
    expect(extractKrw('최저가\n89,000원')).toBe(89_000);
    expect(extractKrw('SALE\n12,900원\n9,900원')).toBe(12_900);
  });

  it('skips a crossed 정가 line when a sale price exists', () => {
    expect(extractKrw('판매가\n정가 19,000원\n12,900원')).toBe(12_900);
  });

  it('falls back to the smallest plausible price', () => {
    expect(extractKrw('₩ 9,900 ~ ₩ 12,000')).toBe(9_900);
    expect(extractKrw('50원 200원')).toBe(200);
  });

  it('ignores dates, times and years', () => {
    expect(extractKrw('2026년 11월 17일 09:30\n15,000원')).toBe(15_000);
    expect(extractKrw('2026-11-17\n12,900원')).toBe(12_900);
  });

  it('returns nothing when there is no plausible price', () => {
    expect(extractKrw('2026년 11월 17일\n50원')).toBeUndefined();
  });
});

describe('US price extraction', () => {
  it('prefers a price right after a sale label', () => {
    expect(extractUsd('Price: $1,299.00\nList price $1,499.00')).toBe(1_299);
    expect(extractUsd('Sale\n$89.99')).toBe(89.99);
  });

  it('falls back to the smallest plausible price', () => {
    expect(extractUsd('$12.99 $9.99')).toBe(9.99);
  });

  it('ignores values under one dollar and years', () => {
    expect(extractUsd('$0.50\n2026\n$15.00')).toBe(15);
  });

  it('returns nothing when there is no plausible price', () => {
    expect(extractUsd('sold out')).toBeUndefined();
  });
});

describe('extractPrice', () => {
  it('uses the home currency extractor first and the other as fallback', () => {
    expect(extractPrice('판매가 12,900원', 'KRW')).toBe(12_900);
    expect(extractPrice('Price: $12.99', 'USD')).toBe(12.99);
    expect(extractPrice('Price: $12.99', 'KRW')).toBe(12.99);
  });
});

describe('restock words', () => {
  it('treats sold-out wording as out of stock', () => {
    for (const text of ['품절', '일시 품절', '재고 없음', '판매 종료', '입고 예정', 'Sold out', 'Out of stock', 'Currently unavailable', 'Notify me when available']) {
      expect(inStockOf(text)).toBe(false);
    }
  });

  it('treats everything else as purchasable', () => {
    expect(inStockOf('구매 가능')).toBe(true);
    expect(inStockOf('장바구니에 담기')).toBe(true);
  });
});

describe('page lines', () => {
  it('trims, collapses spaces and drops blanks and date stamps', () => {
    expect(normalizedLines('  a   b  \n\n2026-11-17\n09:30\n2026년 11월 17일\n11월 17일\n오후 3:20\nc')).toEqual([
      'a b',
      'c',
    ]);
  });

  it('drops ISO, English and AM/PM stamps', () => {
    expect(
      normalizedLines(
        '2026-11-17T09:30:00Z\n2026-11-17 09:30:00+09:00\nNov 17, 2026\nNovember 17th, 2026 9:30 AM\n9:30 PM\nshipped',
      ),
    ).toEqual(['shipped']);
  });

  it('diffs added lines without duplicates', () => {
    expect(addedLines(['a', 'b'], ['a', 'b', 'c', 'c', 'd'])).toEqual(['c', 'd']);
  });

  it('hashes the same lines to the same value', () => {
    expect(hashLines(['a', 'b'])).toBe(hashLines(['a', 'b']));
    expect(hashLines(['a', 'b'])).not.toBe(hashLines(['a', 'c']));
  });
});
