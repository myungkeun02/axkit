import { describe, expect, it } from 'vitest';
import {
  classifyDocument,
  cleanMerchant,
  merchantKeyOf,
  moneyOf,
  preferredMoney,
} from '../../../src/skills/receipts/classify.js';

describe('classifyDocument', () => {
  it('classifies a Korean receipt and prefers the 합계 line', () => {
    const doc = classifyDocument({
      subject: '결제 완료 안내',
      from: '"카페 예시" <billing@example.com>',
      body: '주문 금액 3,000원\n합계 12,345원\n감사합니다.',
    });

    expect(doc).toEqual({
      kind: 'receipt',
      amount: 12_345,
      currency: 'KRW',
      merchant: '카페 예시',
      merchantKey: '카페예시',
    });
  });

  it('classifies an English invoice with a dollar amount', () => {
    const doc = classifyDocument({
      subject: 'Invoice INV-2026-11',
      from: 'Example Billing <billing@example.com>',
      body: 'Amount due: $12.34',
    });

    expect(doc).toMatchObject({ kind: 'invoice', amount: 12.34, currency: 'USD', merchant: 'Example Billing' });
  });

  it('classifies a signature request as a contract', () => {
    const doc = classifyDocument({
      subject: 'Please sign: service agreement',
      from: 'DocuSign <dse@example.com>',
      body: 'Review the contract and sign it.',
    });

    expect(doc).toMatchObject({ kind: 'contract', merchant: 'DocuSign', merchantKey: 'docusign' });
  });

  it('classifies a Korean contract and a statement', () => {
    expect(
      classifyDocument({ subject: '전자계약 서명 요청', from: '계약팀 <contract@example.com>', body: '' })?.kind,
    ).toBe('contract');
    expect(
      classifyDocument({ subject: '11월 이용명세서', from: 'Example Card <notice@example.com>', body: '' })?.kind,
    ).toBe('statement');
  });

  it('ignores marketing mail in both languages', () => {
    expect(
      classifyDocument({ subject: '[광고] 특가 할인', from: '샵 <shop@example.com>', body: '영수증 이벤트' }),
    ).toBeUndefined();
    expect(
      classifyDocument({ subject: 'Weekly newsletter', from: 'Shop <shop@example.com>', body: 'unsubscribe here' }),
    ).toBeUndefined();
  });

  it('ignores mail that is not a document', () => {
    expect(
      classifyDocument({ subject: '안녕하세요', from: '민수 <minsu@example.com>', body: '내일 봬요.' }),
    ).toBeUndefined();
  });

  it('reads the first 2000 body characters only', () => {
    const doc = classifyDocument({
      subject: '안내',
      from: 'Example <example@example.com>',
      body: `${'x'.repeat(2_001)}\n영수증`,
    });
    expect(doc).toBeUndefined();
  });
});

describe('cleanMerchant and merchantKeyOf', () => {
  it('drops quotes and company suffixes', () => {
    expect(cleanMerchant('"카페 예시" <billing@example.com>')).toBe('카페 예시');
    expect(merchantKeyOf('Example, Inc.')).toBe('example');
    expect(merchantKeyOf('(주)카페 예시')).toBe('카페예시');
    expect(merchantKeyOf('Globex Co., Ltd.')).toBe('globex');
  });

  it('has no merchant for an address-only sender', () => {
    expect(cleanMerchant('billing@example.com')).toBeUndefined();
  });
});

describe('moneyOf', () => {
  it('reads won, symbol, code-after and code-before forms', () => {
    expect(moneyOf('합계 ₩12,345')).toEqual({ amount: 12_345, currency: 'KRW' });
    expect(moneyOf('Total: 12.34 USD')).toEqual({ amount: 12.34, currency: 'USD' });
    expect(moneyOf('EUR 99.00')).toEqual({ amount: 99, currency: 'EUR' });
    expect(moneyOf('결제 7,000원')).toEqual({ amount: 7_000, currency: 'KRW' });
  });

  it('prefers a total line over an earlier amount', () => {
    expect(preferredMoney('3,000원\n총 결제금액 12,345원')).toEqual({ amount: 12_345, currency: 'KRW' });
  });
});
