import { describe, expect, it } from 'vitest';
import { mailReceiptParser } from '../../../src/skills/spending/parsers/mail-receipt.js';
import { parseNotice } from '../../../src/skills/spending/parsers/index.js';
import { notice } from './helpers.js';

const TZ = 'Asia/Seoul';

function mail(overrides: Parameters<typeof notice>[0]) {
  return notice({ source: 'mail', ...overrides });
}

describe('mail receipts', () => {
  it('reads a Korean receipt total and the display name', () => {
    const parsed = parseNotice(
      mail({
        sender: '카페 예시 <receipts@example.com>',
        title: '주문 완료',
        text: '주문하신 상품\n합계 12,300원',
      }),
      TZ,
    );
    expect(parsed).toMatchObject({ kind: 'approve', merchant: '카페 예시', amount: 12_300, currency: 'KRW' });
    expect(mailReceiptParser.accepts(mail({ title: '주문 완료', text: '' }))).toBe(true);
  });

  it('reads a USD total line in English and strips sender noise', () => {
    const parsed = parseNotice(
      mail({
        sender: 'Example Shop <no-reply@example.com>',
        title: 'Thanks for your purchase',
        text: 'Order confirmation\nTotal: US$12.34',
      }),
      TZ,
    );
    expect(parsed).toMatchObject({ merchant: 'Example Shop', amount: 12.34, currency: 'USD' });
  });

  it('treats a refund as a cancellation', () => {
    const parsed = parseNotice(
      mail({
        sender: 'Shop <billing@example.com>',
        title: 'Your receipt',
        text: 'Refund for order 12,300원',
      }),
      TZ,
    );
    expect(parsed).toMatchObject({ kind: 'cancel', merchant: 'Shop', amount: 12_300 });
  });

  it('falls back to the largest amount when no total line is labelled', () => {
    const parsed = parseNotice(
      mail({ sender: 'Shop <billing@example.com>', title: 'Receipt', text: '3,000원\n12,300원' }),
      TZ,
    );
    expect(parsed?.amount).toBe(12_300);
  });

  it('uses the domain label when the display name is only noise', () => {
    const parsed = parseNotice(
      mail({ sender: 'receipts@shop.example.com', title: 'Receipt', text: 'Total 12,300원' }),
      TZ,
    );
    expect(parsed?.merchant).toBe('example');
  });

  it.each([
    ['결제 예정 안내', '다음 달 결제 예정 금액은 12,300원이에요'],
    ['Upcoming charge', 'Your card will be charged US$12.34 next week'],
    ['광고', '이벤트 12,300원'],
    ['Newsletter', 'order confirmation for our newsletter'],
  ])('ignores marketing or upcoming-charge mail: %s', (title, text) => {
    expect(mailReceiptParser.accepts(mail({ title, text }))).toBe(false);
  });
});
