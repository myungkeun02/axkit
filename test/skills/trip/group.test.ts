import { describe, expect, it } from 'vitest';
import { groupTrips, looksInternational } from '../../../src/skills/trip/group.js';
import { segment } from './helpers.js';

const TIME_ZONE = 'Asia/Seoul';

const outbound = segment({
  id: 'f1',
  kind: 'flight',
  title: 'KE123',
  start: '2026-12-01T08:30:00+09:00',
  startText: '2026-12-01T08:30',
  from: 'ICN',
  to: 'NRT',
});

const stay = segment({
  id: 's1',
  kind: 'stay',
  title: '도쿄 호텔',
  start: '2026-12-01T15:00:00+09:00',
  end: '2026-12-04T11:00:00+09:00',
  startText: '2026-12-01T15:00',
  place: '도쿄',
});

const inbound = segment({
  id: 'f2',
  kind: 'flight',
  title: 'KE124',
  start: '2026-12-04T18:00:00+09:00',
  startText: '2026-12-04T18:00',
  from: 'NRT',
  to: 'ICN',
});

describe('groupTrips', () => {
  it('chains a flight, a stay and a return flight into one trip', () => {
    const trips = groupTrips([inbound, stay, outbound], TIME_ZONE);

    expect(trips).toHaveLength(1);
    const trip = trips[0]!;
    expect(trip.id).toBe('f1');
    expect(trip.name).toBe('도쿄');
    expect(trip.startYmd).toBe('2026-12-01');
    expect(trip.endYmd).toBe('2026-12-04');
    expect(trip.segments.map((item) => item.id)).toEqual(['f1', 's1', 'f2']);
  });

  it('keeps two trips a week apart separate', () => {
    const next = segment({
      id: 'f3',
      kind: 'flight',
      title: 'KE125',
      start: '2026-12-11T08:30:00+09:00',
      startText: '2026-12-11T08:30',
      to: '오사카',
    });

    const trips = groupTrips([outbound, stay, inbound, next], TIME_ZONE);

    expect(trips).toHaveLength(2);
    expect(trips[1]?.name).toBe('오사카');
  });

  it('chains a next start within 36 hours of the previous end', () => {
    const late = segment({
      id: 'f2',
      kind: 'flight',
      title: 'next day',
      start: '2026-12-02T18:00:00+09:00',
      startText: '2026-12-02T18:00',
    });
    const earlier = groupTrips([outbound, late], TIME_ZONE);
    expect(earlier).toHaveLength(1);

    const tooLate = groupTrips(
      [outbound, { ...late, start: '2026-12-03T09:00:00+09:00', startText: '2026-12-03T09:00' }],
      TIME_ZONE,
    );
    expect(tooLate).toHaveLength(2);
  });

  it('uses the first ride destination when there is no stay', () => {
    const trips = groupTrips([outbound, inbound], TIME_ZONE);
    expect(trips[0]?.name).toBe('NRT');
  });

  it('falls back to the first title when nothing names a destination', () => {
    const event = segment({ id: 'e1', kind: 'event', title: '전시회' });
    expect(groupTrips([event], TIME_ZONE)[0]?.name).toBe('전시회');
  });

  it('uses the latest end for the trip end', () => {
    const trips = groupTrips([outbound, stay], TIME_ZONE);
    expect(trips[0]?.end).toBe('2026-12-04T11:00:00+09:00');
  });

  it('returns nothing for no segments', () => {
    expect(groupTrips([], TIME_ZONE)).toEqual([]);
  });
});

describe('looksInternational', () => {
  it('recognizes a Latin airport route', () => {
    expect(looksInternational(outbound)).toBe(true);
  });

  it('treats a Korean route as domestic', () => {
    expect(looksInternational(segment({ from: '김포', to: '제주' }))).toBe(false);
  });

  it('only applies to flights', () => {
    expect(looksInternational(segment({ kind: 'train', from: 'Seoul', to: 'Busan' }))).toBe(false);
  });
});
