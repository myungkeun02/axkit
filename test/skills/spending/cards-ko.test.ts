import { describe, expect, it } from 'vitest';
import type { PaymentNotice } from '../../../src/core/contracts/index.js';
import { CARD_COMPANIES } from '../../../src/skills/spending/parsers/cards-ko.js';
import { parseNotice } from '../../../src/skills/spending/parsers/index.js';
import { notice } from './helpers.js';

const TZ = 'Asia/Seoul';
const RECEIVED = new Date('2026-11-17T09:00:00+09:00');

function sms(text: string, at: Date = RECEIVED): PaymentNotice {
  return notice({ text, at });
}

describe('Korean card notices', () => {
  it.each(CARD_COMPANIES.map((company) => [company.card]))(
    'parses a %s SMS with the Web발신 prefix',
    (card) => {
      const parsed = parseNotice(
        sms(`[Web발신] ${card}(1234)승인 12,300원(일시불)11/02 12:34 스타벅스 누적 456,780원`),
        TZ,
      );

      expect(parsed).toMatchObject({
        kind: 'approve',
        merchant: '스타벅스',
        amount: 12_300,
        currency: 'KRW',
        card,
      });
      expect(parsed?.at.toISOString()).toBe(new Date('2026-11-02T12:34:00+09:00').toISOString());
    },
  );

  it('accepts a company in the SMS sender and in an app name', () => {
    const fromSender = parseNotice(
      notice({ source: 'sms', sender: '삼성카드', text: '승인 12,300원 11/02 12:34 스타벅스', at: RECEIVED }),
      TZ,
    );
    expect(fromSender).toMatchObject({ card: '삼성카드', merchant: '스타벅스' });

    const fromApp = parseNotice(
      notice({
        source: 'app',
        sender: '현대카드',
        title: '결제 알림',
        text: '승인 12,300원 11/02 12:34 카페 예시',
        at: RECEIVED,
      }),
      TZ,
    );
    expect(fromApp).toMatchObject({ card: '현대카드', merchant: '카페 예시' });
  });

  it('accepts a company in a chat room title', () => {
    const parsed = parseNotice(
      notice({ source: 'chat', sender: '롯데카드', text: '승인 12,300원 11/02 12:34 김밥천국', at: RECEIVED }),
      TZ,
    );
    expect(parsed).toMatchObject({ card: '롯데카드', merchant: '김밥천국' });
  });

  it('marks a cancellation and keeps the amount positive', () => {
    const parsed = parseNotice(sms('신한카드(1234)취소 12,300원 11/02 12:34 스타벅스'), TZ);
    expect(parsed).toMatchObject({ kind: 'cancel', amount: 12_300 });
  });

  it('reads an installment plan in months', () => {
    const parsed = parseNotice(sms('신한카드(1234)승인 12,300원(3개월)11/02 12:34 스타벅스'), TZ);
    expect(parsed?.installmentMonths).toBe(3);
  });

  it('keeps the charged currency overseas and records a stated home amount', () => {
    const withHome = parseNotice(
      sms('신한카드(1234)승인 해외 USD 12.34 (원화 17,276원) 11/02 12:34 스타벅스'),
      TZ,
    );
    expect(withHome).toMatchObject({
      amount: 12.34,
      currency: 'USD',
      statedHomeAmount: 17_276,
      merchant: '스타벅스',
    });

    const withoutHome = parseNotice(sms('신한카드(1234)승인 해외 USD 12.34 11/02 12:34 스타벅스'), TZ);
    expect(withoutHome).toMatchObject({ amount: 12.34, currency: 'USD' });
    expect(withoutHome?.statedHomeAmount).toBeUndefined();
  });

  it.each([
    '인증번호 123456',
    '거절 12,300원',
    '한도초과 12,300원',
    '미승인 12,300원',
    '결제예정 12,300원',
    '명세서 12,300원',
    '청구예정 12,300원',
    '이벤트 안내',
    '혜택 안내',
    '(광고) 12,300원',
  ])('ignores non-payment text: %s', (text) => {
    expect(parseNotice(sms(`현대카드(1234) ${text} 11/02 12:34 스타벅스`), TZ)).toBeUndefined();
  });

  it('rolls the year back when a New Year notice carries a December stamp', () => {
    const parsed = parseNotice(
      notice({
        text: '현대카드(1234)승인 12,300원 12/31 23:00 스타벅스',
        at: new Date('2026-01-01T09:00:00+09:00'),
      }),
      TZ,
    );
    expect(parsed?.at.toISOString()).toBe(new Date('2025-12-31T23:00:00+09:00').toISOString());
  });

  it('keeps a January stamp in the received year', () => {
    const parsed = parseNotice(
      notice({
        text: '현대카드(1234)승인 12,300원 01/02 08:00 스타벅스',
        at: new Date('2026-01-02T09:00:00+09:00'),
      }),
      TZ,
    );
    expect(parsed?.at.toISOString()).toBe(new Date('2026-01-02T08:00:00+09:00').toISOString());
  });

  it('uses the received time when no stamp is printed', () => {
    const parsed = parseNotice(sms('현대카드(1234)승인 12,300원 가맹점: 스타벅스'), TZ);
    expect(parsed?.at.toISOString()).toBe(RECEIVED.toISOString());
  });
});
