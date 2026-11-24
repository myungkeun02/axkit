import { describe, expect, it } from 'vitest';
import {
  addMinutes,
  dateSpecSchema,
  resolveDate,
  resolveTime,
  timeSpecSchema,
  zonedIso,
} from '../../../src/core/time/date-spec.js';
import type { DateSpec } from '../../../src/core/time/date-spec.js';

const NOW = new Date('2026-11-17T09:00:00+09:00'); // Tuesday
const ZONE = 'Asia/Seoul';

function date(spec: DateSpec) {
  return resolveDate(spec, NOW, ZONE);
}

describe('resolveDate', () => {
  it('keeps an explicit date as stated', () => {
    expect(date({ kind: 'date', date: '2026-11-20' })).toEqual({ ymd: '2026-11-20', weekday: 'fri' });
    expect(date({ kind: 'date', date: '2026-11-17' })).toEqual({ ymd: '2026-11-17', weekday: 'tue' });
  });

  it('flags an explicit date in the past', () => {
    expect(date({ kind: 'date', date: '2026-11-16' })).toEqual({
      ymd: '2026-11-16',
      weekday: 'mon',
      guess: 'date is in the past',
    });
  });

  it('rejects malformed or impossible dates', () => {
    expect(() => date({ kind: 'date', date: '2026-02-30' })).toThrow(RangeError);
    expect(() => date({ kind: 'date', date: '2026-1-1' })).toThrow(RangeError);
  });

  it('resolves day offsets around today', () => {
    expect(date({ kind: 'offset', days: 0 })).toEqual({ ymd: '2026-11-17', weekday: 'tue' });
    expect(date({ kind: 'offset', days: 1 })).toEqual({ ymd: '2026-11-18', weekday: 'wed' });
    expect(date({ kind: 'offset', days: 2 })).toEqual({ ymd: '2026-11-19', weekday: 'thu' });
    expect(date({ kind: 'offset', days: -1 })).toEqual({ ymd: '2026-11-16', weekday: 'mon' });
    expect(date({ kind: 'offset', days: 60 })).toEqual({ ymd: '2027-01-16', weekday: 'sat' });
  });

  it('rejects offsets outside the allowed range', () => {
    expect(() => date({ kind: 'offset', days: 61 })).toThrow(RangeError);
    expect(() => date({ kind: 'offset', days: -8 })).toThrow(RangeError);
    expect(() => date({ kind: 'offset', days: 1.5 })).toThrow(RangeError);
  });

  it('resolves this week on a Monday-first week', () => {
    expect(date({ kind: 'weekday', weekday: 'fri', week: 'this' })).toEqual({ ymd: '2026-11-20', weekday: 'fri' });
    expect(date({ kind: 'weekday', weekday: 'tue', week: 'this' })).toEqual({ ymd: '2026-11-17', weekday: 'tue' });
    expect(date({ kind: 'weekday', weekday: 'mon', week: 'this' })).toEqual({
      ymd: '2026-11-16',
      weekday: 'mon',
      guess: 'already passed this week',
    });
    expect(date({ kind: 'weekday', weekday: 'sun', week: 'this' })).toEqual({ ymd: '2026-11-22', weekday: 'sun' });
  });

  it('resolves next week as the following Monday-Sunday week', () => {
    expect(date({ kind: 'weekday', weekday: 'tue', week: 'next' })).toEqual({ ymd: '2026-11-24', weekday: 'tue' });
    expect(date({ kind: 'weekday', weekday: 'mon', week: 'next' })).toEqual({ ymd: '2026-11-23', weekday: 'mon' });
    expect(date({ kind: 'weekday', weekday: 'sun', week: 'next' })).toEqual({ ymd: '2026-11-29', weekday: 'sun' });
  });

  it('resolves nearest as the next occurrence, today included', () => {
    expect(date({ kind: 'weekday', weekday: 'tue', week: 'nearest' })).toEqual({
      ymd: '2026-11-17',
      weekday: 'tue',
      guess: 'today or next week',
    });
    expect(date({ kind: 'weekday', weekday: 'fri', week: 'nearest' })).toEqual({ ymd: '2026-11-20', weekday: 'fri' });
    expect(date({ kind: 'weekday', weekday: 'mon', week: 'nearest' })).toEqual({ ymd: '2026-11-23', weekday: 'mon' });
  });

  it('resolves a month and day in this year or the next', () => {
    expect(date({ kind: 'month_day', month: 11, day: 20 })).toEqual({ ymd: '2026-11-20', weekday: 'fri' });
    expect(date({ kind: 'month_day', month: 11, day: 17 })).toEqual({ ymd: '2026-11-17', weekday: 'tue' });
    expect(date({ kind: 'month_day', month: 11, day: 16 })).toEqual({
      ymd: '2027-11-16',
      weekday: 'tue',
      guess: 'year inferred',
    });
  });

  it('moves a leap day to the next year that has one', () => {
    const result = date({ kind: 'month_day', month: 2, day: 29 });
    expect(result.ymd).toBe('2028-02-29');
    expect(result.weekday).toBe('tue');
    expect(result.guess).toBe('year inferred');
  });

  it('rejects impossible month and day combinations', () => {
    expect(() => date({ kind: 'month_day', month: 2, day: 30 })).toThrow(RangeError);
    expect(() => date({ kind: 'month_day', month: 4, day: 31 })).toThrow(RangeError);
    expect(() => date({ kind: 'month_day', month: 13, day: 1 })).toThrow(RangeError);
    expect(() => date({ kind: 'month_day', month: 0, day: 1 })).toThrow(RangeError);
  });
});

describe('resolveTime', () => {
  it('converts a stated AM/PM without a guess', () => {
    expect(resolveTime({ hour: 3, minute: 0, meridiem: 'pm' })).toEqual({ hhmm: '15:00' });
    expect(resolveTime({ hour: 9, minute: 30, meridiem: 'am' })).toEqual({ hhmm: '09:30' });
    expect(resolveTime({ hour: 12, minute: 0, meridiem: 'am' })).toEqual({ hhmm: '00:00' });
    expect(resolveTime({ hour: 12, minute: 0, meridiem: 'pm' })).toEqual({ hhmm: '12:00' });
  });

  it('keeps an unambiguous 24-hour time as stated', () => {
    expect(resolveTime({ hour: 0, minute: 0, meridiem: 'unspecified' })).toEqual({ hhmm: '00:00' });
    expect(resolveTime({ hour: 15, minute: 45, meridiem: 'unspecified' })).toEqual({ hhmm: '15:45' });
  });

  it('guesses AM/PM for an unstated hour between 1 and 12', () => {
    expect(resolveTime({ hour: 3, minute: 0, meridiem: 'unspecified' })).toEqual({
      hhmm: '15:00',
      guess: 'AM/PM not stated',
    });
    expect(resolveTime({ hour: 6, minute: 15, meridiem: 'unspecified' })).toEqual({
      hhmm: '18:15',
      guess: 'AM/PM not stated',
    });
    expect(resolveTime({ hour: 9, minute: 30, meridiem: 'unspecified' })).toEqual({
      hhmm: '09:30',
      guess: 'AM/PM not stated',
    });
    expect(resolveTime({ hour: 12, minute: 0, meridiem: 'unspecified' })).toEqual({
      hhmm: '12:00',
      guess: 'AM/PM not stated',
    });
  });

  it('rejects hours and minutes out of range', () => {
    expect(() => resolveTime({ hour: 24, minute: 0, meridiem: 'unspecified' })).toThrow(RangeError);
    expect(() => resolveTime({ hour: 10, minute: 60, meridiem: 'unspecified' })).toThrow(RangeError);
    expect(() => resolveTime({ hour: 0, minute: 0, meridiem: 'am' })).toThrow(RangeError);
    expect(() => resolveTime({ hour: 13, minute: 0, meridiem: 'pm' })).toThrow(RangeError);
  });
});

describe('zonedIso', () => {
  it('writes the zone offset for the requested wall time', () => {
    expect(zonedIso('2026-11-20', '15:00', 'Asia/Seoul')).toBe('2026-11-20T15:00:00+09:00');
    expect(zonedIso('2026-07-01', '12:00', 'America/New_York')).toBe('2026-07-01T12:00:00-04:00');
    expect(zonedIso('2026-12-01', '12:00', 'America/New_York')).toBe('2026-12-01T12:00:00-05:00');
    expect(zonedIso('2026-01-15', '08:05', 'UTC')).toBe('2026-01-15T08:05:00+00:00');
  });

  it('picks the earlier offset for an ambiguous hour', () => {
    expect(zonedIso('2026-11-01', '01:30', 'America/New_York')).toBe('2026-11-01T01:30:00-04:00');
  });

  it('round-trips through Date', () => {
    const iso = zonedIso('2026-11-20', '15:00', 'Asia/Seoul');
    expect(new Date(iso).toISOString()).toBe('2026-11-20T06:00:00.000Z');
  });

  it('rejects invalid input', () => {
    expect(() => zonedIso('2026-11-20', '25:00', 'Asia/Seoul')).toThrow(RangeError);
    expect(() => zonedIso('2026-02-30', '10:00', 'Asia/Seoul')).toThrow(RangeError);
    expect(() => zonedIso('2026-11-20', '10:00', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('addMinutes', () => {
  it('adds within a day', () => {
    expect(addMinutes('2026-11-20', '15:00', 45)).toEqual({ ymd: '2026-11-20', hhmm: '15:45' });
  });

  it('rolls over midnight in both directions', () => {
    expect(addMinutes('2026-11-20', '23:30', 60)).toEqual({ ymd: '2026-11-21', hhmm: '00:30' });
    expect(addMinutes('2026-11-20', '00:10', -20)).toEqual({ ymd: '2026-11-19', hhmm: '23:50' });
    expect(addMinutes('2026-12-31', '23:59', 1)).toEqual({ ymd: '2027-01-01', hhmm: '00:00' });
  });

  it('rejects invalid dates and times', () => {
    expect(() => addMinutes('2026-13-01', '10:00', 0)).toThrow(RangeError);
    expect(() => addMinutes('2026-11-20', '10:60', 0)).toThrow(RangeError);
    expect(() => addMinutes('2026-11-20', '10:00', 0.5)).toThrow(RangeError);
  });
});

describe('schemas', () => {
  it('accept and reject date specs', () => {
    expect(dateSpecSchema.parse({ kind: 'offset', days: 1 })).toEqual({ kind: 'offset', days: 1 });
    expect(dateSpecSchema.parse({ kind: 'weekday', weekday: 'fri', week: 'next' })).toEqual({
      kind: 'weekday',
      weekday: 'fri',
      week: 'next',
    });
    expect(dateSpecSchema.safeParse({ kind: 'offset', days: 100 }).success).toBe(false);
    expect(dateSpecSchema.safeParse({ kind: 'weekday', weekday: 'someday', week: 'next' }).success).toBe(false);
  });

  it('accept and reject time specs', () => {
    expect(timeSpecSchema.parse({ hour: 3, minute: 0, meridiem: 'pm' })).toEqual({
      hour: 3,
      minute: 0,
      meridiem: 'pm',
    });
    expect(timeSpecSchema.safeParse({ hour: 24, minute: 0, meridiem: 'pm' }).success).toBe(false);
    expect(timeSpecSchema.safeParse({ hour: 3, minute: 0, meridiem: 'later' }).success).toBe(false);
  });
});
