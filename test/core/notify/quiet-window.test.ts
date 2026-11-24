import { describe, expect, it } from 'vitest';
import { isQuietAt, quietWindowEnd } from '../../../src/core/notify/quiet-window.js';

const NIGHT = { from: '22:00', to: '07:00' };
const LUNCH = { from: '12:00', to: '13:00' };
const SEOUL = 'Asia/Seoul';

function seoul(hhmm: string, day = 17): Date {
  return new Date(`2026-11-${day}T${hhmm}:00+09:00`);
}

describe('isQuietAt', () => {
  it('is never quiet without quiet hours', () => {
    expect(isQuietAt(undefined, seoul('23:00'), SEOUL)).toBe(false);
  });

  it('handles a window that crosses midnight', () => {
    expect(isQuietAt(NIGHT, seoul('23:00'), SEOUL)).toBe(true);
    expect(isQuietAt(NIGHT, seoul('00:30'), SEOUL)).toBe(true);
    expect(isQuietAt(NIGHT, seoul('06:59'), SEOUL)).toBe(true);
    expect(isQuietAt(NIGHT, seoul('07:00'), SEOUL)).toBe(false);
    expect(isQuietAt(NIGHT, seoul('21:59'), SEOUL)).toBe(false);
    expect(isQuietAt(NIGHT, seoul('12:00'), SEOUL)).toBe(false);
  });

  it('handles a window inside one day', () => {
    expect(isQuietAt(LUNCH, seoul('12:00'), SEOUL)).toBe(true);
    expect(isQuietAt(LUNCH, seoul('12:59'), SEOUL)).toBe(true);
    expect(isQuietAt(LUNCH, seoul('13:00'), SEOUL)).toBe(false);
    expect(isQuietAt(LUNCH, seoul('11:59'), SEOUL)).toBe(false);
  });

  it('treats identical from and to as never quiet', () => {
    expect(isQuietAt({ from: '09:00', to: '09:00' }, seoul('09:00'), SEOUL)).toBe(false);
  });

  it('reads the clock in the given time zone', () => {
    const at = new Date('2026-11-17T14:30:00Z'); // 23:30 in Seoul, 14:30 in UTC
    expect(isQuietAt(NIGHT, at, SEOUL)).toBe(true);
    expect(isQuietAt(NIGHT, at, 'UTC')).toBe(false);
  });

  it('rejects malformed times', () => {
    expect(() => isQuietAt({ from: '7:00', to: '08:00' }, seoul('07:30'), SEOUL)).toThrow(RangeError);
    expect(() => isQuietAt({ from: '22:00', to: '25:00' }, seoul('23:00'), SEOUL)).toThrow(RangeError);
  });
});

describe('quietWindowEnd', () => {
  it('returns the next morning for a window that crosses midnight', () => {
    const end = quietWindowEnd(NIGHT, seoul('23:00'), SEOUL);
    expect(end.toISOString()).toBe('2026-11-17T22:00:00.000Z'); // 2026-11-18 07:00 KST
  });

  it('returns today for a window inside one day', () => {
    const end = quietWindowEnd(LUNCH, seoul('12:30'), SEOUL);
    expect(end.toISOString()).toBe('2026-11-17T04:00:00.000Z'); // 13:00 KST
  });

  it('rejects a window that never applies', () => {
    expect(() => quietWindowEnd({ from: '09:00', to: '09:00' }, seoul('09:00'), SEOUL)).toThrow(RangeError);
  });
});
