import { describe, expect, it } from 'vitest';
import { detectBooking } from '../../../src/skills/trip/detect.js';

function detect(subject: string, body = '', from = 'booking@example.com') {
  return detectBooking({ subject, body, from });
}

describe('booking mail detection', () => {
  it('recognizes a Korean booking confirmation', () => {
    expect(detect('예약 확인', '예약번호 ABC123')).toBe('booking');
  });

  it('recognizes a booking word in the body only', () => {
    expect(detect('여행 안내', '탑승권을 첨부했어요')).toBe('booking');
  });

  it('recognizes a cancellation mail before booking wording', () => {
    expect(detect('예약 취소 안내', '예약이 확정되었던 KE123편이 취소되었습니다')).toBe('cancel');
  });

  it('ignores a Korean promotion', () => {
    expect(detect('항공권 특가 광고', '지금 예약하면 할인')).toBeUndefined();
  });

  it('recognizes an English booking confirmation', () => {
    expect(detect('Booking confirmation for your trip', 'Confirmation number: ABC123')).toBe('booking');
  });

  it('recognizes an English cancellation', () => {
    expect(detect('Your booking has been cancelled', 'We cancelled flight KE123')).toBe('cancel');
  });

  it('ignores an English newsletter', () => {
    expect(detect('Newsletter: your trip deals', 'A deal for your next trip')).toBeUndefined();
  });

  it('ignores unrelated mail', () => {
    expect(detect('주간 회의 자료', '내일 회의 준비 부탁드려요')).toBeUndefined();
  });

  it('reads only the first 2000 body characters', () => {
    expect(detect('안내', `${'x'.repeat(2_100)} 예약 확인`)).toBeUndefined();
  });

  it('uses the sender as part of the signal', () => {
    expect(detect('안내', '본문', 'booking confirmation <noreply@example.com>')).toBe('booking');
  });
});
