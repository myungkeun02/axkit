import { describe, expect, it } from 'vitest';
import type { TripSegment } from '../../../src/skills/trip/types.js';
import type { TripView } from '../../../src/skills/trip/tools-shared.js';
import { FakeConfirmer } from '../../support/context.js';
import { doneOutput, segment, setupTrip, storedSegments } from './helpers.js';

const UPCOMING: TripSegment[] = [
  segment({
    id: 'f1',
    kind: 'flight',
    title: 'KE123',
    start: '2026-12-01T08:30:00+09:00',
    startText: '2026-12-01T08:30',
    from: 'ICN',
    to: 'NRT',
    reference: 'ABC123',
  }),
  segment({
    id: 's1',
    kind: 'stay',
    title: '도쿄 호텔',
    start: '2026-12-01T15:00:00+09:00',
    end: '2026-12-04T11:00:00+09:00',
    startText: '2026-12-01T15:00',
    place: '도쿄',
  }),
  segment({
    id: 'f2',
    kind: 'flight',
    title: 'KE124',
    start: '2026-12-04T18:00:00+09:00',
    startText: '2026-12-04T18:00',
    from: 'NRT',
    to: 'ICN',
  }),
];

const PAST: TripSegment[] = [
  segment({
    id: 'p1',
    kind: 'train',
    title: 'KTX 101',
    start: '2026-11-01T08:30:00+09:00',
    startText: '2026-11-01T08:30',
    reference: 'OLD1',
  }),
];

async function execute(context: Awaited<ReturnType<typeof setupTrip>>, name: string, input: unknown) {
  return context.ctx.tools.execute(name, input, { grounding: [] });
}

describe('trips.list', () => {
  it('lists only upcoming trips by default', async () => {
    const context = await setupTrip({ seed: [...PAST, ...UPCOMING] });

    const output = doneOutput<{ trips: TripView[] }>(await execute(context, 'trips.list', {}));

    expect(output.trips.map((trip) => trip.id)).toEqual(['f1']);
    expect(output.trips[0]).toMatchObject({ name: '도쿄', dates: '12/01~12/04', start: '2026-12-01T08:30:00+09:00' });
    expect(output.trips[0]?.segments).toHaveLength(3);
  });

  it('includes ended trips when past is true', async () => {
    const context = await setupTrip({ seed: [...PAST, ...UPCOMING] });

    const output = doneOutput<{ trips: TripView[] }>(await execute(context, 'trips.list', { past: true }));

    expect(output.trips.map((trip) => trip.id)).toEqual(['p1', 'f1']);
  });

  it('returns an empty list when nothing is stored', async () => {
    const context = await setupTrip();

    const output = doneOutput<{ trips: TripView[] }>(await execute(context, 'trips.list', {}));

    expect(output.trips).toEqual([]);
  });
});

describe('trips.show', () => {
  it('renders the itinerary and its references', async () => {
    const context = await setupTrip({ seed: UPCOMING });

    const output = doneOutput<{
      tripId: string;
      name: string;
      dates: string;
      text: string;
      references: { segmentId: string; title: string; reference: string }[];
    }>(await execute(context, 'trips.show', { tripId: 'f1' }));

    expect(output.tripId).toBe('f1');
    expect(output.name).toBe('도쿄');
    expect(output.dates).toBe('12/01~12/04');
    expect(output.text).toContain('도쿄 (12/01~12/04)');
    expect(output.text).toContain('- 12/01 08:30 항공 ICN→NRT KE123');
    expect(output.text).toContain('예약번호 ABC123');
    expect(output.references).toEqual([{ segmentId: 'f1', title: 'KE123', reference: 'ABC123' }]);
  });

  it('fails for an unknown trip id', async () => {
    const context = await setupTrip({ seed: UPCOMING });

    const outcome = await execute(context, 'trips.show', { tripId: 'nope' });

    expect(outcome).toEqual({ status: 'failed', error: 'No trip with id nope' });
  });
});

describe('trips.add', () => {
  it('adds a manual segment in the owner zone and describes it on the card', async () => {
    const context = await setupTrip();

    const view = doneOutput<{ id: string; start: string; startText: string; place?: string }>(
      await execute(context, 'trips.add', {
        kind: 'car',
        title: 'Nissan Note',
        start: '2026-12-02T10:00',
        place: '나리타',
        reference: 'CAR1',
      }),
    );

    expect(view).toMatchObject({ start: '2026-12-02T10:00:00+09:00', startText: '2026-12-02T10:00', place: '나리타' });
    const stored = await storedSegments(context);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: view.id, mailId: 'manual', kind: 'car', reference: 'CAR1' });
    expect(
      context.registry.get('trips.add')?.describe?.({ kind: 'car', title: 'Nissan Note', start: '2026-12-02T10:00' }),
    ).toBe('여행 일정 추가: 렌터카 Nissan Note (2026-12-02T10:00)');
  });

  it('accepts a date-only start and a later end', async () => {
    const context = await setupTrip();

    const view = doneOutput<{ start: string; end?: string }>(
      await execute(context, 'trips.add', {
        kind: 'stay',
        title: '도쿄 호텔',
        start: '2026-12-01',
        end: '2026-12-04',
      }),
    );

    expect(view.start).toBe('2026-12-01T00:00:00+09:00');
    expect(view.end).toBe('2026-12-04T00:00:00+09:00');
  });

  it('rejects an impossible date', async () => {
    const context = await setupTrip();

    const outcome = await execute(context, 'trips.add', { kind: 'stay', title: '숙소', start: '2026-02-30' });

    expect(outcome).toEqual({ status: 'failed', error: 'Invalid start date: 2026-02-30' });
    expect(await storedSegments(context)).toHaveLength(0);
  });

  it('rejects an end before the start', async () => {
    const context = await setupTrip();

    const outcome = await execute(context, 'trips.add', {
      kind: 'stay',
      title: '숙소',
      start: '2026-12-04T15:00',
      end: '2026-12-01T11:00',
    });

    expect(outcome).toEqual({ status: 'failed', error: 'End is before start' });
  });
});

describe('trips.remove_segment', () => {
  it('asks before deleting and names the segment', async () => {
    const confirmer = new FakeConfirmer('approved');
    const context = await setupTrip({ seed: UPCOMING, confirmer });

    const output = doneOutput<{ segmentId: string; removed: true }>(
      await execute(context, 'trips.remove_segment', { segmentId: 'f1' }),
    );

    expect(output).toEqual({ segmentId: 'f1', removed: true });
    expect(confirmer.requests[0]?.effects).toEqual(['delete']);
    expect(confirmer.requests[0]?.summary).toBe('여행 일정 삭제: KE123');
    expect((await storedSegments(context)).map((item) => item.id)).toEqual(['s1', 'f2']);
  });

  it('keeps the segment when the owner denies', async () => {
    const context = await setupTrip({ seed: UPCOMING, confirmer: new FakeConfirmer('denied') });

    const outcome = await execute(context, 'trips.remove_segment', { segmentId: 'f1' });

    expect(outcome).toEqual({ status: 'denied' });
    expect(await storedSegments(context)).toHaveLength(3);
  });

  it('fails for an unknown segment id', async () => {
    const context = await setupTrip({ seed: UPCOMING, confirmer: new FakeConfirmer('approved') });

    const outcome = await execute(context, 'trips.remove_segment', { segmentId: 'nope' });

    expect(outcome).toEqual({ status: 'failed', error: 'No segment with id nope' });
  });
});
