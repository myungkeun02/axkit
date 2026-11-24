import { describe, expect, it } from 'vitest';
import { receiptFromText } from '../../../src/skills/receipts/ocr-parse.js';

describe('receiptFromText — Korean', () => {
  it('reads a Vision-like multi-line receipt with a glued date and time', () => {
    const text = [
      '영수증',
      '가맹점: 예시커피 강남점',
      '2026-11-1514:32',
      '아메리카노 2 9,000',
      '합계 12,500원',
      '카드 승인 완료',
    ].join('\n');

    expect(receiptFromText(text)).toEqual({
      amount: 12_500,
      currency: 'KRW',
      merchant: '예시커피 강남점',
      date: '2026-11-15',
    });
  });

  it('prefers a labelled total over other numbers', () => {
    const text = ['단가 9,000원', '아메리카노 2 18,000원', '받을금액 20,000원'].join('\n');
    expect(receiptFromText(text)).toMatchObject({ amount: 20_000, currency: 'KRW' });
  });

  it('understands 총액, 총 결제, 결제금액 and 승인금액 labels', () => {
    expect(receiptFromText('총액 1,000원')).toMatchObject({ amount: 1_000, currency: 'KRW' });
    expect(receiptFromText('총 결제 2,000원')).toMatchObject({ amount: 2_000, currency: 'KRW' });
    expect(receiptFromText('결제금액 3,000원')).toMatchObject({ amount: 3_000, currency: 'KRW' });
    expect(receiptFromText('승인금액 4,000원')).toMatchObject({ amount: 4_000, currency: 'KRW' });
  });

  it('reads merchant labels, a dotted date and a spaced time', () => {
    const text = ['결제금액 8,000원', '상호 예시마트', '2026.11.15 14:32'].join('\n');
    expect(receiptFromText(text)).toEqual({
      amount: 8_000,
      currency: 'KRW',
      merchant: '예시마트',
      date: '2026-11-15',
    });
  });

  it('reads a slash date and a Korean date with 년/월/일', () => {
    expect(receiptFromText('2026/11/15\n합계 1,000원').date).toBe('2026-11-15');
    expect(receiptFromText('2026년 11월 15일\n합계 1,000원').date).toBe('2026-11-15');
  });

  it('falls back to the first non-numeric line for the merchant', () => {
    const text = ['영수증', '예시마트', '2026-11-15', '합계 7,500원'].join('\n');
    expect(receiptFromText(text).merchant).toBe('예시마트');
  });

  it('does not take a generic heading as the merchant', () => {
    const text = ['영수증', '2026-11-15', '합계 12,500원', '카드 승인 완료'].join('\n');
    expect(receiptFromText(text).merchant).toBeUndefined();
  });

  it('ignores an impossible calendar date', () => {
    expect(receiptFromText('2026-02-31\n합계 1,000원').date).toBeUndefined();
  });
});

describe('receiptFromText — English', () => {
  it('reads an amount due in a currency code and a month-name date', () => {
    const text = ['Example Coffee', 'Receipt', 'Nov 15, 2026', 'Amount due: USD 42.50'].join('\n');
    expect(receiptFromText(text)).toEqual({
      amount: 42.5,
      currency: 'USD',
      merchant: 'Example Coffee',
      date: '2026-11-15',
    });
  });

  it('reads a Store label, a dollar total and a slash date', () => {
    const text = ['Store: Example Coffee', 'Total $19.99', '2026/11/15'].join('\n');
    expect(receiptFromText(text)).toEqual({
      amount: 19.99,
      currency: 'USD',
      merchant: 'Example Coffee',
      date: '2026-11-15',
    });
  });

  it('reads a bare grand total without a currency symbol', () => {
    expect(receiptFromText('Grand total 123.45')).toEqual({ amount: 123.45 });
  });

  it('reads a comma-separated dollar amount', () => {
    expect(receiptFromText('Total: $1,234.56')).toEqual({ amount: 1234.56, currency: 'USD' });
  });

  it('does not read a date on a total line as an amount', () => {
    expect(receiptFromText('Total: 2026-11-15')).toEqual({ date: '2026-11-15' });
    expect(receiptFromText('Grand total 2026-11-15 42.50')).toEqual({ amount: 42.5, date: '2026-11-15' });
  });

  it('uses a Merchant label over the first line', () => {
    const text = ['Receipt', 'Merchant: Example Coffee', 'Total $5.00'].join('\n');
    expect(receiptFromText(text).merchant).toBe('Example Coffee');
  });
});

describe('receiptFromText — empty input', () => {
  it('returns no fields when nothing matches', () => {
    expect(receiptFromText('')).toEqual({});
    expect(receiptFromText('감사합니다')).toEqual({});
  });
});
