import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { daySkill } from '../../../src/skills/day/plugin.js';
import { createTestContext } from '../../support/context.js';
import { FakeCalendarReader, FakeNotifier, FakePhone, FakePlaces } from './helpers.js';

const NOW = new Date('2026-11-17T08:50:00+09:00');

const meeting: CalendarEvent = {
  id: 'e1',
  title: '팀 회의',
  start: '2026-11-17T09:00:00+09:00',
  end: '2026-11-17T10:00:00+09:00',
  allDay: false,
  location: '본관 3층',
};

async function setup(options: { events?: CalendarEvent[]; phone?: FakePhone; places?: FakePlaces; config?: Record<string, unknown> } = {}) {
  const notifier = new FakeNotifier();
  const calendar = new FakeCalendarReader(() => options.events ?? [meeting]);
  const phone = options.phone ?? new FakePhone({ lat: 37.5, lng: 127, at: NOW });
  const places = options.places ?? new FakePlaces({ '본관 3층': { lat: 37.51, lng: 127 } });
  const context = createTestContext({
    now: NOW,
    ...(options.config !== undefined ? { config: options.config } : {}),
    capabilities: {
      [Contracts.notifier.id]: notifier,
      [Contracts.calendarRead.id]: calendar,
      [Contracts.phoneSignals.id]: phone,
      [Contracts.places.id]: places,
    },
  });
  await daySkill().setup(context.ctx);
  return { notifier, calendar, phone, places, ...context };
}

describe('day.travel', () => {
  it('warns urgently when the walk would only just make it', async () => {
    const { notifier, scheduler } = await setup();

    await scheduler.run('day.travel', NOW);

    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice?.kind).toBe('day.travel');
    expect(notice?.urgent).toBe(true);
    expect(notice?.dedupeKey).toBe('e1');
    expect(notice?.text).toContain('지금 출발하면 맞춰요: 팀 회의 09:00, 약 17분');
    expect(notice?.text).toContain('대략적인 추정');
  });

  it('uses transit time for longer distances', async () => {
    const { notifier, scheduler } = await setup({
      phone: new FakePhone({ lat: 37.5, lng: 127, at: NOW }),
      places: new FakePlaces({ '본관 3층': { lat: 37.52, lng: 127 } }),
    });

    await scheduler.run('day.travel', NOW);
    expect(notifier.notices[0]?.text).toContain('약 19분');
  });

  it('while there is still time, says once how long it takes and when to leave (not urgent)', async () => {
    const { notifier, scheduler } = await setup({ config: { travelBufferMinutes: 0 } });
    const early = new Date('2026-11-17T08:40:00+09:00');

    await scheduler.run('day.travel', early);
    await scheduler.run('day.travel', early);
    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.urgent).not.toBe(true);
    expect(notifier.notices[0]?.text).toContain('쯤 출발하면 돼요');
  });

  it('stays quiet while leaving is more than an hour off', async () => {
    const { notifier, scheduler } = await setup({ config: { travelBufferMinutes: 0 } });
    await scheduler.run('day.travel', new Date('2026-11-17T06:30:00+09:00'));
    expect(notifier.notices).toHaveLength(0);
  });

  it('skips events without a location', async () => {
    const withoutLocation: CalendarEvent = {
      id: 'e1',
      title: '팀 회의',
      start: '2026-11-17T09:00:00+09:00',
      end: '2026-11-17T10:00:00+09:00',
      allDay: false,
    };
    const { notifier, scheduler } = await setup({ events: [withoutLocation] });

    await scheduler.run('day.travel', NOW);
    expect(notifier.notices).toHaveLength(0);
  });

  it('skips silently when the phone has no location', async () => {
    const { notifier, scheduler } = await setup({ phone: new FakePhone(undefined) });

    await scheduler.run('day.travel', NOW);
    expect(notifier.notices).toHaveLength(0);
  });

  it('skips silently when the place cannot be geocoded', async () => {
    const { notifier, scheduler } = await setup({ places: new FakePlaces({}) });

    await scheduler.run('day.travel', NOW);
    expect(notifier.notices).toHaveLength(0);
  });

  it('never warns for an event that already started', async () => {
    const { notifier, scheduler } = await setup({
      events: [{ ...meeting, start: '2026-11-17T08:00:00+09:00', end: '2026-11-17T08:30:00+09:00' }],
    });

    await scheduler.run('day.travel', NOW);
    expect(notifier.notices).toHaveLength(0);
  });

  it('caches the geocoded point per event id', async () => {
    const { places, scheduler } = await setup();

    await scheduler.run('day.travel', NOW);
    await scheduler.run('day.travel', NOW);

    expect(places.geocodes).toEqual(['본관 3층']);
  });
});
