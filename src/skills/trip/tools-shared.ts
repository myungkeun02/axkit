import type { TripToolDeps } from './deps.js';
import { dateRangeOf, tripName } from './format.js';
import type { TripTexts } from './locale.js';
import type { SegmentKind, Trip, TripSegment } from './types.js';

export type { TripToolDeps };

export interface SegmentView {
  id: string;
  kind: SegmentKind;
  title: string;
  start: string;
  end?: string;
  startText: string;
  place?: string;
  from?: string;
  to?: string;
  reference?: string;
}

export interface TripView {
  id: string;
  name: string;
  start: string;
  end: string;
  dates: string;
  segments: SegmentView[];
}

export function segmentView(segment: TripSegment): SegmentView {
  return {
    id: segment.id,
    kind: segment.kind,
    title: segment.title,
    start: segment.start,
    startText: segment.startText,
    ...(segment.end !== undefined ? { end: segment.end } : {}),
    ...(segment.place !== undefined ? { place: segment.place } : {}),
    ...(segment.from !== undefined ? { from: segment.from } : {}),
    ...(segment.to !== undefined ? { to: segment.to } : {}),
    ...(segment.reference !== undefined ? { reference: segment.reference } : {}),
  };
}

export function tripView(trip: Trip, texts: TripTexts): TripView {
  return {
    id: trip.id,
    name: tripName(trip, texts),
    start: trip.start,
    end: trip.end,
    dates: dateRangeOf(trip, texts),
    segments: trip.segments.map(segmentView),
  };
}
