import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { TripSegment } from '../../../src/skills/trip/types.js';
import { destinationYmd } from '../../../src/skills/trip/checklist.js';
import { FakeNotifier, FakePlaces, FakeWeather, NOW, segment, setupTrip } from './helpers.js';

const SEED: TripSegment[] = [
  segment({
    id: 'f1',
    kind: 'flight',
    title: 'KE123',
    start: '2026-11-20T08:30:00+09:00',
    startText: '2026-11-20T08:30',
    from: 'ICN',
    to: 'NRT',
  }),
  segment({
    id: 's1',
    kind: 'stay',
    title: '도쿄 호텔',
    start: '2026-11-20T15:00:00+09:00',
    end: '2026-11-23T11:00:00+09:00',
    startText: '2026-11-20T15:00',
    place: '도쿄',
  }),
];

async function checklistSetup(options: {
  now?: Date;
  seed?: TripSegment[];
  config?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  language?: string;
} = {}) {
  const notifier = new FakeNotifier();
  const context = await setupTrip({
    now: options.now ?? NOW,
    seed: options.seed ?? SEED,
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.language !== undefined ? { assistant: { language: options.language } } : {}),
    capabilities: { [Contracts.notifier.id]: notifier, ...(options.capabilities ?? {}) },
  });
  return { context, notifier };
}

describe('trip.checklist', () => {
  it('sends the D-3 checklist with the timeline and per-kind items', async () => {
    const { context, notifier } = await checklistSetup();

    await context.scheduler.run('trip.checklist', NOW);

    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0]!;
    expect(notice).toMatchObject({ kind: 'trip.checklist', dedupeKey: 'f1:3' });
    expect(notice.text).toContain('D-3 도쿄 (11/20~11/23)');
    expect(notice.text).toContain('- 11/20 08:30 항공 ICN→NRT KE123');
    expect(notice.text).toContain('- 11/20 15:00 숙소 도쿄 호텔');
    expect(notice.text).toContain('준비물');
    expect(notice.text).toContain('- 신분증');
    expect(notice.text).toContain('- 충전기');
    expect(notice.text).toContain('- 예약 내역 확인');
    expect(notice.text).toContain('여권');
    expect(notice.text).toContain('온라인 체크인');
    expect(notice.text).toContain('국제선은 출발 2~3시간 전');
    expect(notice.text).toContain('숙소 체크인 시간과 주소 확인');
  });

  it('stays quiet on other days', async () => {
    const { context, notifier } = await checklistSetup();

    await context.scheduler.run('trip.checklist', new Date('2026-11-18T09:00:00+09:00'));

    expect(notifier.notices).toHaveLength(0);
  });

  it('does not repeat the same checklist for one trip and day', async () => {
    const { context, notifier } = await checklistSetup();

    await context.scheduler.run('trip.checklist', NOW);
    await context.scheduler.run('trip.checklist', NOW);

    expect(notifier.notices).toHaveLength(1);
  });

  it('sends D-1 with a weather line when places and weather answer', async () => {
    const places = new FakePlaces({ 도쿄: { lat: 35.68, lng: 139.69 } });
    const weather = new FakeWeather({ sky: '맑음', tempC: 12, rainChance: 20, observedAt: NOW });
    const { context, notifier } = await checklistSetup({
      capabilities: { [Contracts.places.id]: places, [Contracts.weather.id]: weather },
    });

    await context.scheduler.run('trip.checklist', new Date('2026-11-19T09:00:00+09:00'));

    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0]!;
    expect(notice.dedupeKey).toBe('f1:1');
    expect(notice.text).toContain('도쿄 날씨: 맑음, 12°C, 강수 20%');
    expect(places.geocodes).toEqual(['도쿄']);
    expect(weather.days).toEqual(['2026-11-20']);
    expect(weather.asked).toHaveLength(1);
  });

  it('skips D-1 weather when the source can only tell today', async () => {
    const places = new FakePlaces({ 도쿄: { lat: 35.68, lng: 139.69 } });
    const todayOnly = { today: async () => ({ sky: '맑음', observedAt: NOW }) };
    const { context, notifier } = await checklistSetup({
      capabilities: { [Contracts.places.id]: places, [Contracts.weather.id]: todayOnly },
    });

    await context.scheduler.run('trip.checklist', new Date('2026-11-19T09:00:00+09:00'));

    expect(notifier.notices[0]?.text).not.toContain('날씨:');
  });

  it('skips the weather line when the weather service fails', async () => {
    const places = new FakePlaces({ 도쿄: { lat: 35.68, lng: 139.69 } });
    const weather = new FakeWeather(undefined);
    const { context, notifier } = await checklistSetup({
      capabilities: { [Contracts.places.id]: places, [Contracts.weather.id]: weather },
    });

    await context.scheduler.run('trip.checklist', new Date('2026-11-19T09:00:00+09:00'));

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.text).not.toContain('날씨:');
  });

  it('skips the weather line when no weather capability exists', async () => {
    const { context, notifier } = await checklistSetup();

    await context.scheduler.run('trip.checklist', new Date('2026-11-19T09:00:00+09:00'));

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.text).not.toContain('날씨:');
  });

  it('does not add weather on D-3 even when it is available', async () => {
    const places = new FakePlaces({ 도쿄: { lat: 35.68, lng: 139.69 } });
    const weather = new FakeWeather({ sky: '맑음', tempC: 12, observedAt: NOW });
    const { context, notifier } = await checklistSetup({
      capabilities: { [Contracts.places.id]: places, [Contracts.weather.id]: weather },
    });

    await context.scheduler.run('trip.checklist', NOW);

    expect(places.geocodes).toEqual([]);
    expect(notifier.notices[0]?.text).not.toContain('날씨:');
  });

  it('honours a custom remindDays list', async () => {
    const { context, notifier } = await checklistSetup({ config: { remindDays: [3] } });

    await context.scheduler.run('trip.checklist', new Date('2026-11-19T09:00:00+09:00'));

    expect(notifier.notices).toHaveLength(0);
  });

  it('writes the checklist in English when the owner uses English', async () => {
    const { context, notifier } = await checklistSetup({ language: 'en' });

    await context.scheduler.run('trip.checklist', NOW);

    const notice = notifier.notices[0]!;
    expect(notice.text).toContain('D-3 도쿄 (11/20–11/23)');
    expect(notice.text).toContain('Checklist');
    expect(notice.text).toContain('Passport');
    expect(notice.text).toContain('Stay check-in time and address');
  });

  it('stays quiet without a notifier', async () => {
    const context = await setupTrip({ seed: SEED });

    await expect(context.scheduler.run('trip.checklist', NOW)).resolves.toBeUndefined();
  });
});

describe('destinationYmd', () => {
  it('prefers the printed check-in date of the first stay', () => {
    const trip = {
      id: 'f1', name: 'Tokyo', start: '', end: '', startYmd: '2026-11-20', endYmd: '2026-11-22',
      segments: [segment(), segment({ id: 's1', kind: 'stay', startText: '2026-11-21 15:00', start: '2026-11-21T15:00:00+09:00' })],
    };
    expect(destinationYmd(trip)).toBe('2026-11-21');
  });

  it('falls back to the first day of the trip', () => {
    const trip = { id: 'f1', name: 'Tokyo', start: '', end: '', startYmd: '2026-11-20', endYmd: '2026-11-20', segments: [segment()] };
    expect(destinationYmd(trip)).toBe('2026-11-20');
  });
});
