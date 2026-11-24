import { describe, expect, it } from 'vitest';
import {
  dateMentioned,
  evidenceFound,
  normalizeText,
  timeMentioned,
} from '../../../src/core/time/evidence.js';
import type { DateSpec, TimeSpec } from '../../../src/core/time/date-spec.js';

describe('normalizeText', () => {
  it('lower-cases, strips quotes and collapses whitespace', () => {
    expect(normalizeText('  “Today”\n ')).toBe('today');
    expect(normalizeText("'내일'  회의")).toBe('내일 회의');
    expect(normalizeText('ＡＢＣ')).toBe('ａｂｃ');
  });

  it('normalizes Hangul to NFC', () => {
    expect(normalizeText('내일')).toBe('내일');
  });
});

describe('evidenceFound', () => {
  it('finds normalized evidence in any grounding entry', () => {
    expect(evidenceFound('모레', ['오늘은 바빠요', '모레 회의가 있어요'])).toBe(true);
    expect(evidenceFound('  Mina  ', ['안녕 Mina'])).toBe(true);
    expect(evidenceFound('“금요일”', ['금요일에 봐요'])).toBe(true);
  });

  it('rejects missing evidence and evidence shorter than two characters', () => {
    expect(evidenceFound('없는 말', ['다른 문장'])).toBe(false);
    expect(evidenceFound('m', ['m'])).toBe(false);
    expect(evidenceFound('', ['아무 말'])).toBe(false);
  });
});

describe('dateMentioned', () => {
  const cases: [DateSpec, string, boolean][] = [
    [{ kind: 'offset', days: 0 }, '오늘 오후에 볼까요', true],
    [{ kind: 'offset', days: 0 }, '금일 마감', true],
    [{ kind: 'offset', days: 0 }, 'tonight', true],
    [{ kind: 'offset', days: 0 }, '내일 아침', false],
    [{ kind: 'offset', days: 1 }, '내일 아침', true],
    [{ kind: 'offset', days: 1 }, '낼 봐요', true],
    [{ kind: 'offset', days: 1 }, 'tomorrow', true],
    [{ kind: 'offset', days: 1 }, '오늘', false],
    [{ kind: 'offset', days: 2 }, '모레', true],
    [{ kind: 'offset', days: 2 }, 'the day after tomorrow', true],
    [{ kind: 'offset', days: 2 }, '2일 뒤', true],
    [{ kind: 'offset', days: 2 }, 'in 2 days', true],
    [{ kind: 'offset', days: 3 }, '글피', true],
    [{ kind: 'offset', days: 3 }, '3일 후', true],
    [{ kind: 'offset', days: -1 }, '어제', true],
    [{ kind: 'offset', days: -1 }, 'yesterday', true],
    [{ kind: 'offset', days: 5 }, '5일 후에', true],
    [{ kind: 'offset', days: 5 }, 'in 5 days', true],
    [{ kind: 'offset', days: 5 }, '4일 뒤', false],
    [{ kind: 'offset', days: 5 }, '5일 전', false],
    [{ kind: 'offset', days: 5 }, '15일 후', false],
  ];

  it.each(cases)('checks relative day evidence for %j', (spec, evidence, expected) => {
    expect(dateMentioned(spec, evidence)).toBe(expected);
  });

  const weekdayCases: [DateSpec, string, boolean][] = [
    [{ kind: 'weekday', weekday: 'fri', week: 'nearest' }, '금요일에 만나요', true],
    [{ kind: 'weekday', weekday: 'fri', week: 'nearest' }, '금욜에 보자', true],
    [{ kind: 'weekday', weekday: 'fri', week: 'nearest' }, '(금) 약속', true],
    [{ kind: 'weekday', weekday: 'fri', week: 'nearest' }, 'friday', true],
    [{ kind: 'weekday', weekday: 'fri', week: 'nearest' }, 'Fri.', true],
    [{ kind: 'weekday', weekday: 'fri', week: 'nearest' }, '목요일', false],
    [{ kind: 'weekday', weekday: 'mon', week: 'nearest' }, 'check the monitor', false],
    [{ kind: 'weekday', weekday: 'tue', week: 'next' }, '다음 주 화요일', true],
    [{ kind: 'weekday', weekday: 'tue', week: 'next' }, '다음주 화욜', true],
    [{ kind: 'weekday', weekday: 'tue', week: 'next' }, 'next tuesday', true],
    [{ kind: 'weekday', weekday: 'tue', week: 'next' }, '화요일', false],
    [{ kind: 'weekday', weekday: 'wed', week: 'this' }, '수요일', true],
    [{ kind: 'weekday', weekday: 'wed', week: 'this' }, '이번 주 수요일', true],
    [{ kind: 'weekday', weekday: 'sun', week: 'nearest' }, '일요일', true],
  ];

  it.each(weekdayCases)('checks weekday evidence for %j', (spec, evidence, expected) => {
    expect(dateMentioned(spec, evidence)).toBe(expected);
  });

  const dayCases: [DateSpec, string, boolean][] = [
    [{ kind: 'date', date: '2026-11-20' }, '11월 20일', true],
    [{ kind: 'date', date: '2026-11-20' }, '2026-11-20에 봐요', true],
    [{ kind: 'date', date: '2026-11-20' }, '11/20', true],
    [{ kind: 'date', date: '2026-11-20' }, '11.20', true],
    [{ kind: 'date', date: '2026-11-20' }, '11-20', true],
    [{ kind: 'date', date: '2026-11-20' }, 'November 20th', true],
    [{ kind: 'date', date: '2026-11-20' }, '20 November', true],
    [{ kind: 'date', date: '2026-11-20' }, '11/21', false],
    [{ kind: 'date', date: '2026-11-02' }, '11월 12일', false],
    [{ kind: 'date', date: '2026-11-02' }, '2일', true],
    [{ kind: 'month_day', month: 11, day: 20 }, '11월 20일', true],
    [{ kind: 'month_day', month: 11, day: 20 }, 'on 11/20', true],
    [{ kind: 'month_day', month: 11, day: 20 }, 'November 20', true],
    [{ kind: 'month_day', month: 11, day: 20 }, '20일', true],
    [{ kind: 'month_day', month: 11, day: 20 }, '21일', false],
  ];

  it.each(dayCases)('checks month/day evidence for %j', (spec, evidence, expected) => {
    expect(dateMentioned(spec, evidence)).toBe(expected);
  });
});

describe('timeMentioned', () => {
  const cases: [TimeSpec, string, boolean][] = [
    [{ hour: 3, minute: 0, meridiem: 'pm' }, '3시', true],
    [{ hour: 3, minute: 0, meridiem: 'pm' }, '15:00', true],
    [{ hour: 3, minute: 0, meridiem: 'pm' }, '3pm', true],
    [{ hour: 3, minute: 0, meridiem: 'pm' }, '3 pm', true],
    [{ hour: 3, minute: 0, meridiem: 'pm' }, '오후 3시에', true],
    [{ hour: 3, minute: 0, meridiem: 'pm' }, '3am', false],
    [{ hour: 3, minute: 0, meridiem: 'pm' }, '15:30', false],
    [{ hour: 3, minute: 0, meridiem: 'pm' }, '4시', false],
    [{ hour: 15, minute: 0, meridiem: 'unspecified' }, '15시', true],
    [{ hour: 15, minute: 0, meridiem: 'unspecified' }, '15:00', true],
    [{ hour: 15, minute: 0, meridiem: 'unspecified' }, '오후 세 시', true],
    [{ hour: 9, minute: 30, meridiem: 'am' }, '09:30', true],
    [{ hour: 9, minute: 30, meridiem: 'am' }, '9:30', true],
    [{ hour: 9, minute: 0, meridiem: 'am' }, '9:30', false],
    [{ hour: 3, minute: 30, meridiem: 'pm' }, '3시 반', true],
    [{ hour: 3, minute: 30, meridiem: 'pm' }, '15:30', true],
    [{ hour: 3, minute: 30, meridiem: 'pm' }, '15:00', false],
  ];

  it.each(cases)('checks clock evidence for %j', (spec, evidence, expected) => {
    expect(timeMentioned(spec, evidence)).toBe(expected);
  });

  const nativeHours: [number, string][] = [
    [1, '한 시'],
    [2, '두시'],
    [3, '세시'],
    [4, '네시'],
    [5, '다섯시'],
    [6, '여섯시'],
    [7, '일곱시'],
    [8, '여덟시'],
    [9, '아홉시'],
    [10, '열시'],
    [11, '열한시'],
    [12, '열두시'],
  ];

  it.each(nativeHours)('understands the Korean native hour %s', (hour, evidence) => {
    expect(timeMentioned({ hour, minute: 0, meridiem: hour === 12 ? 'pm' : 'am' }, evidence)).toBe(true);
  });

  it('understands noon and midnight words only in the right half of the day', () => {
    expect(timeMentioned({ hour: 12, minute: 0, meridiem: 'pm' }, '정오')).toBe(true);
    expect(timeMentioned({ hour: 12, minute: 0, meridiem: 'pm' }, 'noon')).toBe(true);
    expect(timeMentioned({ hour: 12, minute: 0, meridiem: 'pm' }, 'afternoon')).toBe(false);
    expect(timeMentioned({ hour: 12, minute: 0, meridiem: 'am' }, '자정')).toBe(true);
    expect(timeMentioned({ hour: 12, minute: 0, meridiem: 'am' }, 'midnight')).toBe(true);
    expect(timeMentioned({ hour: 12, minute: 0, meridiem: 'am' }, 'noon')).toBe(false);
  });

  it('does not confuse an hour inside a longer number', () => {
    expect(timeMentioned({ hour: 3, minute: 0, meridiem: 'am' }, '13시')).toBe(false);
    expect(timeMentioned({ hour: 3, minute: 0, meridiem: 'am' }, '13:00')).toBe(false);
  });
});

describe('evidence agreement (review fixes)', () => {
  it('rejects this-week weekday when the words say next week', () => {
    expect(dateMentioned({ kind: 'weekday', weekday: 'fri', week: 'this' }, '다음 주 금요일')).toBe(false);
    expect(dateMentioned({ kind: 'weekday', weekday: 'fri', week: 'nearest' }, 'next friday')).toBe(false);
    expect(dateMentioned({ kind: 'weekday', weekday: 'fri', week: 'next' }, '다음 주 금요일')).toBe(true);
  });

  it('requires minutes to be stated when not on the hour', () => {
    expect(timeMentioned({ hour: 3, minute: 45, meridiem: 'pm' }, '3시에 만나')).toBe(false);
    expect(timeMentioned({ hour: 3, minute: 45, meridiem: 'pm' }, '3시 45분에 만나')).toBe(true);
    expect(timeMentioned({ hour: 3, minute: 30, meridiem: 'pm' }, '세 시 반')).toBe(true);
    expect(timeMentioned({ hour: 15, minute: 30, meridiem: 'unspecified' }, '15:30')).toBe(true);
  });
});
