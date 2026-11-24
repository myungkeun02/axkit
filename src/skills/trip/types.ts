export const SEGMENT_KINDS = ['flight', 'train', 'bus', 'stay', 'car', 'event', 'other'] as const;

export type SegmentKind = (typeof SEGMENT_KINDS)[number];

/** One booking segment found in mail or added by hand. Times are ISO strings in the owner's zone. */
export interface TripSegment {
  id: string;
  mailId: string;
  kind: SegmentKind;
  title: string;
  start: string;
  end?: string;
  /** Printed date or date-time text as it appeared on the booking, kept for display across time zones. */
  startText: string;
  place?: string;
  from?: string;
  to?: string;
  reference?: string;
}

/** Segments chained into one journey. `id` is the first segment's id, so the trip name stays stable. */
export interface Trip {
  id: string;
  /** Destination: first stay place, else a flight/train destination, else the first title. */
  name: string;
  start: string;
  end: string;
  startYmd: string;
  endYmd: string;
  segments: TripSegment[];
}
