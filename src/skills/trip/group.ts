import { ymdOf } from '../../core/time/local-day.js';
import type { Trip, TripSegment } from './types.js';

const CHAIN_HOURS = 36;
const CHAIN_MS = CHAIN_HOURS * 3_600_000;
const LATIN = /[A-Za-z]/;

function startMs(segment: TripSegment): number {
  const ms = Date.parse(segment.start);
  return Number.isFinite(ms) ? ms : 0;
}

function endMs(segment: TripSegment): number {
  const ms = segment.end !== undefined ? Date.parse(segment.end) : Number.NaN;
  return Number.isFinite(ms) ? Math.max(ms, startMs(segment)) : startMs(segment);
}

/** Destination is what the owner recognises: the stay place, else where the first ride lands, else the title. */
function destination(segments: readonly TripSegment[]): string {
  const stay = segments.find((segment) => segment.kind === 'stay' && segment.place !== undefined);
  if (stay?.place !== undefined) return stay.place;
  const ride = segments.find(
    (segment) => (segment.kind === 'flight' || segment.kind === 'train') && segment.to !== undefined,
  );
  if (ride?.to !== undefined) return ride.to;
  return segments[0]?.title ?? '';
}

/** A flight whose printed route uses Latin letters or airport codes looks international. */
export function looksInternational(segment: TripSegment): boolean {
  if (segment.kind !== 'flight') return false;
  return [segment.from, segment.to].some((value) => value !== undefined && LATIN.test(value));
}

function lastEnding(segments: readonly TripSegment[]): TripSegment {
  let last = segments[0] as TripSegment;
  for (const segment of segments) {
    if (endMs(segment) >= endMs(last)) last = segment;
  }
  return last;
}

/** Pure: sorts by start and chains a segment while it starts within 36 hours of the trip's coverage end. */
export function groupTrips(segments: readonly TripSegment[], timeZone: string): Trip[] {
  const sorted = [...segments].sort((left, right) => startMs(left) - startMs(right) || left.id.localeCompare(right.id));
  const trips: Trip[] = [];
  let current: TripSegment[] = [];
  let coverage = 0;

  const flush = (): void => {
    const first = current[0];
    if (first === undefined) return;
    const last = lastEnding(current);
    trips.push({
      id: first.id,
      name: destination(current),
      start: first.start,
      end: last.end ?? last.start,
      startYmd: ymdOf(new Date(startMs(first)), timeZone),
      endYmd: ymdOf(new Date(endMs(last)), timeZone),
      segments: current,
    });
  };

  for (const segment of sorted) {
    const start = startMs(segment);
    const end = endMs(segment);
    if (current.length > 0 && start <= coverage + CHAIN_MS) {
      current.push(segment);
      coverage = Math.max(coverage, end);
      continue;
    }
    flush();
    current = [segment];
    coverage = end;
  }
  flush();
  return trips;
}
