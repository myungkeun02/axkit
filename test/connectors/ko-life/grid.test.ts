import { describe, expect, it } from 'vitest';
import { forecastBase, kmaGrid, ultraBase } from '../../../src/connectors/ko-life/grid.js';

describe('kmaGrid', () => {
  it('maps Seoul City Hall to the official grid point 60, 127', () => {
    expect(kmaGrid(37.5665, 126.978)).toEqual({ nx: 60, ny: 127 });
  });

  it('maps other known Korean points', () => {
    expect(kmaGrid(35.1796, 129.0756)).toEqual({ nx: 98, ny: 76 });
    expect(kmaGrid(33.4996, 126.5312)).toEqual({ nx: 53, ny: 38 });
  });
});

describe('forecastBase', () => {
  it('waits for the 10-minute delay after a slot', () => {
    expect(forecastBase(new Date('2026-11-17T05:09:00+09:00'))).toEqual({
      baseDate: '20261117',
      baseTime: '0200',
    });
    expect(forecastBase(new Date('2026-11-17T05:10:00+09:00'))).toEqual({
      baseDate: '20261117',
      baseTime: '0500',
    });
  });

  it('uses the previous day 23:00 before the first slot is ready', () => {
    expect(forecastBase(new Date('2026-11-17T02:05:00+09:00'))).toEqual({
      baseDate: '20261116',
      baseTime: '2300',
    });
    expect(forecastBase(new Date('2026-11-17T02:10:00+09:00'))).toEqual({
      baseDate: '20261117',
      baseTime: '0200',
    });
  });

  it('rolls the date across a month boundary', () => {
    expect(forecastBase(new Date('2026-12-01T01:30:00+09:00'))).toEqual({
      baseDate: '20261130',
      baseTime: '2300',
    });
  });
});

describe('ultraBase', () => {
  it('uses the previous hour until 40 minutes past', () => {
    expect(ultraBase(new Date('2026-11-17T09:39:00+09:00'))).toEqual({
      baseDate: '20261117',
      baseTime: '0800',
    });
    expect(ultraBase(new Date('2026-11-17T09:40:00+09:00'))).toEqual({
      baseDate: '20261117',
      baseTime: '0900',
    });
  });

  it('rolls back to the previous day just after midnight', () => {
    expect(ultraBase(new Date('2026-11-17T00:20:00+09:00'))).toEqual({
      baseDate: '20261116',
      baseTime: '2300',
    });
    expect(ultraBase(new Date('2026-11-17T00:45:00+09:00'))).toEqual({
      baseDate: '20261117',
      baseTime: '0000',
    });
  });
});
