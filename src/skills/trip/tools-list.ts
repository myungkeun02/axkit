import { z } from 'zod';
import type { Tool } from '../../core/tools/types.js';
import { ymdOf } from '../../core/time/local-day.js';
import { tripText } from './format.js';
import { groupTrips } from './group.js';
import type { TripSegment } from './types.js';
import type { TripToolDeps, TripView } from './tools-shared.js';
import { tripView } from './tools-shared.js';

const listInput = z.object({
  past: z.boolean().optional().describe('Include trips that already ended. Defaults to false.'),
});

const showInput = z.object({
  tripId: z.string().min(1).max(100).describe('Trip id from trips.list, such as a segment id.'),
});

export type TripsListInput = z.infer<typeof listInput>;
export type TripsShowInput = z.infer<typeof showInput>;

export interface TripsListOutput {
  trips: TripView[];
}

export interface TripReference {
  segmentId: string;
  title: string;
  reference: string;
}

export interface TripsShowOutput {
  tripId: string;
  name: string;
  start: string;
  end: string;
  dates: string;
  text: string;
  references: TripReference[];
}

/** Tool "trips.list": upcoming trips, or all stored trips when `past` is true. */
export function tripsListTool(deps: TripToolDeps): Tool<TripsListInput, TripsListOutput> {
  return {
    name: 'trips.list',
    description:
      'List trips found in booking mail. By default only trips that have not ended yet; set past=true to include old ones.',
    input: listInput,
    effects: ['read'],
    async run(input) {
      const today = ymdOf(deps.now(), deps.timeZone);
      const trips = groupTrips(deps.store.all(), deps.timeZone);
      const visible = trips.filter((trip) => input.past === true || trip.endYmd >= today);
      return { trips: visible.map((trip) => tripView(trip, deps.texts)) };
    },
  };
}

/** Tool "trips.show": one itinerary with booking references. */
export function tripsShowTool(deps: TripToolDeps): Tool<TripsShowInput, TripsShowOutput> {
  return {
    name: 'trips.show',
    description: 'Show one trip itinerary and its booking references.',
    input: showInput,
    effects: ['read'],
    async run(input) {
      const trip = groupTrips(deps.store.all(), deps.timeZone).find((candidate) => candidate.id === input.tripId);
      if (trip === undefined) throw new Error(`No trip with id ${input.tripId}`);
      const view = tripView(trip, deps.texts);
      const referenced = trip.segments.filter(
        (segment): segment is TripSegment & { reference: string } => segment.reference !== undefined,
      );
      const parts = [tripText(trip, deps.texts)];
      if (referenced.length > 0) {
        parts.push(referenced.map((segment) => deps.texts.referenceLine(segment.title, segment.reference)).join('\n'));
      }
      return {
        tripId: view.id,
        name: view.name,
        start: view.start,
        end: view.end,
        dates: view.dates,
        text: parts.join('\n'),
        references: referenced.map((segment) => ({
          segmentId: segment.id,
          title: segment.title,
          reference: segment.reference,
        })),
      };
    },
  };
}
