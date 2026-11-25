import { describe, expect, it } from 'vitest';
import type { CalendarEvent, GeoPoint, KnownPlaces } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { lunchNudge } from '../../../src/skills/day/lunch.js';
import { placesOf } from '../../../src/skills/day/places.js';
import { createTestContext } from '../../support/context.js';

const NOON = new Date('2026-11-25T11:45:00+09:00'); // a Wednesday
const WORK: GeoPoint = { lat: 37.5, lng: 127.03 };
const HOME: GeoPoint = { lat: 37.6, lng: 126.9 };

function setup(opts: { at: GeoPoint; events?: CalendarEvent[]; known?: KnownPlaces }) {
  const notices: { text: string }[] = [];
  const context = createTestContext({
    now: NOON,
    capabilities: {
      [Contracts.notifier.id]: { notify: async (notice: { text: string }) => void notices.push(notice) },
      [Contracts.phoneSignals.id]: { latestLocation: async () => ({ ...opts.at, at: NOON }), dayTotals: async () => ({}), lastSeen: async () => NOON },
      [Contracts.calendarRead.id]: { listEvents: async () => opts.events ?? [] },
      [Contracts.places.id]: {
        search: async () => [{ name: '김밥천국', address: '', point: WORK, category: '음식점 > 분식', distanceM: 120 }],
        geocode: async () => undefined,
      },
    },
  });
  const places = { get: async () => opts.known ?? { home: HOME, work: WORK } };
  return { ...context, notices, places };
}

describe('lunch nudge', () => {
  it('at work with a free lunch: says so with places nearby, once a day', async () => {
    const context = setup({ at: WORK });
    expect(await lunchNudge(context.ctx, NOON, context.places)).toBe('sent');
    expect(context.notices[0]?.text).toBe('점심 드셔야죠! 점심시간에 약속이 없어요.\n근처 식당:\n- 김밥천국 (분식, 120m)');
    expect(await lunchNudge(context.ctx, NOON, context.places)).toBe('skipped');
  });

  it('says nothing at home or with lunch on the calendar', async () => {
    expect(await lunchNudge(setup({ at: HOME }).ctx, NOON, setup({ at: HOME }).places)).toBe('skipped');
    const busy = setup({ at: WORK, events: [{ id: 'e1', title: '점심 미팅', start: '2026-11-25T12:00:00+09:00', end: '2026-11-25T13:00:00+09:00', allDay: false }] });
    expect(await lunchNudge(busy.ctx, NOON, busy.places)).toBe('skipped');
    expect(busy.notices).toHaveLength(0);
  });

  it('learns home from nights and work from weekday hours', () => {
    const cells = { a: { ...HOME, night: 9, day: 0 }, b: { ...WORK, night: 0, day: 12 }, c: { lat: 1, lng: 1, night: 1, day: 1 } };
    expect(placesOf(cells)).toEqual({ home: HOME, work: WORK });
  });
});
