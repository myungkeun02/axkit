import { describe, expect, it } from 'vitest';
import {
  cleanMerchant,
  merchantKey,
  merchantsMatch,
  stripCardNumbers,
} from '../../../src/skills/spending/normalize.js';

describe('merchantKey', () => {
  it('ignores case, punctuation and company words', () => {
    expect(merchantKey('Example, Inc.')).toBe('example');
    expect(merchantKey('EXAMPLE')).toBe('example');
    expect(merchantKey('Cafe Example LLC')).toBe('cafeexample');
    expect(merchantKey('주식회사 카페 예시')).toBe('카페예시');
    expect(merchantKey('(주)테스트 유한회사')).toBe('테스트');
    expect(merchantKey('㈜테스트')).toBe('테스트');
  });

  it('drops spaces but keeps letters and digits', () => {
    expect(merchantKey('카페 예시')).toBe('카페예시');
    expect(merchantKey('GS 25')).toBe('gs25');
  });
});

describe('stripCardNumbers', () => {
  it('removes star-masked and plain card numbers', () => {
    expect(stripCardNumbers('카드 1234-****-****-5678 승인')).not.toMatch(/\d/);
    expect(stripCardNumbers('1234*5678')).not.toMatch(/\d/);
    expect(stripCardNumbers('1234567890123456')).not.toMatch(/\d/);
    expect(stripCardNumbers('1234-5678-9012-3456')).not.toMatch(/\d/);
  });

  it('keeps dates and comma-grouped amounts', () => {
    expect(stripCardNumbers('2026-11-17')).toBe('2026-11-17');
    expect(stripCardNumbers('11/02 12:34 12,300원')).toBe('11/02 12:34 12,300원');
  });
});

describe('cleanMerchant', () => {
  it('collapses whitespace and caps the length', () => {
    expect(cleanMerchant('  스타벅스   강남점  ')).toBe('스타벅스 강남점');
    expect(cleanMerchant('가'.repeat(60))).toHaveLength(40);
  });
});

describe('merchantsMatch', () => {
  it('treats equal keys and containing keys as the same merchant', () => {
    expect(merchantsMatch('스타벅스', '스타벅스')).toBe(true);
    expect(merchantsMatch('스타벅스', '스타벅스강남점')).toBe(true);
    expect(merchantsMatch('스타', '스타벅스')).toBe(false);
    expect(merchantsMatch('', '')).toBe(false);
  });
});
