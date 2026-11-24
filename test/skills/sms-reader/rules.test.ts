import { describe, expect, it } from 'vitest';
import { findDates, findTimes } from '../../../src/skills/sms-reader/dates.js';
import { checkAnswer } from '../../../src/skills/sms-reader/model.js';
import { orgOf, readByRules } from '../../../src/skills/sms-reader/rules.js';

// All messages below are made up: example businesses, fake numbers.
describe('sms-reader code rules', () => {
  it('reads a confirmed reservation with the quoted date and time', () => {
    const result = readByRules('[Web발신]\n[예시치과] 홍길동님 12월 3일(수) 오후 2시 30분 진료 예약이 확정되었습니다.', '0212345678');
    expect(result).toEqual({
      status: 'sure',
      found: {
        kind: 'reservation',
        status: 'confirmed',
        org: '예시치과',
        date: { kind: 'month_day', month: 12, day: 3 },
        time: { hour: 2, minute: 30, meridiem: 'pm' },
        evidence: '12월 3일(수) 오후 2시 30분',
      },
    });
  });

  it('reads changed and cancelled reservations, with the place', () => {
    const changed = readByRules('[예시식당] 예약이 변경되었습니다. 일시: 2026.12.24 19:00 장소: 예시점 2층', '15880000');
    expect(changed).toMatchObject({
      status: 'sure',
      found: { status: 'changed', date: { kind: 'date', date: '2026-12-24' }, time: { hour: 19, minute: 0 }, place: '예시점 2층', evidence: '2026.12.24 19:00' },
    });
    expect(readByRules('[예시미용실] 11/28 예약이 취소되었습니다', undefined)).toMatchObject({ found: { status: 'cancelled', evidence: '11/28' } });
  });

  it('reads courier and tracking number', () => {
    expect(readByRules('[CJ대한통운] 상품이 배송 출발했습니다. 운송장번호 : 6123-4567-8901', '15881255')).toEqual({
      status: 'sure',
      found: { kind: 'parcel', carrier: 'CJ대한통운', invoice: '612345678901' },
    });
    expect(readByRules('[우체국택배] 등기번호 6012345678901 오늘 배달 예정', undefined)).toMatchObject({ found: { carrier: '우체국택배', invoice: '6012345678901' } });
    // a delivery notice without a number has nothing to follow
    expect(readByRules('[CJ대한통운] 상품이 문 앞에 배송 완료되었습니다. 문의 1588-1255', '15881255').status).toBe('none');
  });

  it('reads bill amount and due date', () => {
    expect(readByRules('[KT] 11월 이용요금 52,300원 납부기한 12월 25일까지', '114')).toEqual({
      status: 'sure',
      found: { kind: 'bill', payee: 'KT', amount: 52300, due: { kind: 'month_day', month: 12, day: 25 }, evidence: '12월 25일' },
    });
    expect(readByRules('[예시관리사무소] 관리비 청구금액 213,450원, 납기일 2026-12-10', undefined)).toMatchObject({
      found: { kind: 'bill', amount: 213450, due: { kind: 'date', date: '2026-12-10' } },
    });
  });

  it('leaves card approvals to the spending skill and is unsure without the key facts', () => {
    expect(readByRules('[예시카드] 승인 홍*동 12,000원 일시불 11/23 14:02 예시카페', '15880000').status).toBe('none');
    expect(readByRules('예약 관련해서 연락드립니다', undefined)).toEqual({ status: 'unsure', hint: 'reservation' });
    expect(readByRules('[예시가스] 이번 달 요금 청구서가 발행되었어요', undefined)).toEqual({ status: 'unsure', hint: 'bill' });
    expect(readByRules('안녕하세요 잘 지내시죠', undefined).status).toBe('none');
  });

  it('a bill word beats a reservation word; a reservation beats a plain price', () => {
    expect(readByRules('[예시은행] 자동이체 예약 55,000원 12/10 출금 예정', undefined)).toMatchObject({ found: { kind: 'bill' } });
    expect(readByRules('[예시시네마] 12월 5일 19:30 예매 완료 12,000원', undefined)).toMatchObject({ found: { kind: 'reservation' } });
  });

  it('finds org labels, dates and times without taking durations or amounts', () => {
    expect(orgOf('[Web발신] [예시치과] 안내', undefined)).toBe('예시치과');
    expect(orgOf('안내', '010-1234-5678')).toBeUndefined();
    expect(findTimes('3시간 걸려요')).toHaveLength(0);
    expect(findDates('1.5%와 3/4원')).toHaveLength(0);
  });
});

describe('sms-reader model answer checks', () => {
  const text = '[예시정비소] 차량 점검 예약은 다음 주 화요일 오전 10시예요';

  it('keeps a reservation whose date the message states', () => {
    const answer = { kind: 'reservation', org: '예시정비소', date: { kind: 'weekday', weekday: 'tue', week: 'next' }, time: { hour: 10, minute: 0, meridiem: 'am' }, evidence: '다음 주 화요일 오전 10시' };
    expect(checkAnswer(answer, text)).toMatchObject({ kind: 'reservation', status: 'confirmed', org: '예시정비소' });
  });

  it('drops invented dates, foreign quotes, unwritten amounts and orgs', () => {
    expect(checkAnswer({ kind: 'reservation', date: { kind: 'offset', days: 1 }, evidence: '내일' }, text)).toEqual({ kind: 'other' });
    expect(checkAnswer({ kind: 'reservation', date: { kind: 'weekday', weekday: 'wed', week: 'next' }, evidence: '다음 주 화요일' }, text)).toEqual({ kind: 'other' });
    expect(checkAnswer({ kind: 'bill', amount: 99000 }, '요금 청구 9,900원')).toEqual({ kind: 'other' });
    expect(checkAnswer({ kind: 'bill', amount: 9900, org: '가짜회사' }, '요금 청구 9,900원')).toEqual({ kind: 'bill', amount: 9900 });
    expect(checkAnswer('not json', text)).toEqual({ kind: 'other' });
  });
});
