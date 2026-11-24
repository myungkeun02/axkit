import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tool } from '../../core/tools/types.js';
import { parsePrinted, toInstant } from './parse.js';
import type { TripSegment } from './types.js';
import { SEGMENT_KINDS } from './types.js';
import type { SegmentView, TripToolDeps } from './tools-shared.js';
import { segmentView } from './tools-shared.js';

const printedTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/)
  .describe('Local date "YYYY-MM-DD" or date-time "YYYY-MM-DDTHH:MM" as printed on the booking.');

const addInput = z.object({
  kind: z.enum(SEGMENT_KINDS).describe('Segment kind: flight, train, bus, stay, car, event or other.'),
  title: z.string().min(1).max(120).describe('Short title as printed, such as a flight number or hotel name.'),
  start: printedTime,
  end: printedTime.optional().describe('End date or time, for a stay or an event. Omit when there is none.'),
  place: z.string().min(1).max(120).optional().describe('Place name or address.'),
  reference: z.string().min(1).max(60).optional().describe('Booking reference or confirmation number.'),
});

const removeInput = z.object({
  segmentId: z.string().min(1).max(100).describe('Segment id from trips.show or trips.list.'),
});

export type TripsAddInput = z.infer<typeof addInput>;
export type TripsRemoveInput = z.infer<typeof removeInput>;

export interface TripsRemoveOutput {
  segmentId: string;
  removed: true;
}

function instantOf(value: string, field: string, timeZone: string): string {
  const printed = parsePrinted(value);
  if (printed === undefined) throw new Error(`Invalid ${field} date: ${value}`);
  return toInstant(printed, timeZone);
}

/** Tool "trips.add": a segment the owner adds by hand, printed local time interpreted in the owner zone. */
export function tripsAddTool(deps: TripToolDeps): Tool<TripsAddInput, SegmentView> {
  return {
    name: 'trips.add',
    description:
      'Add one trip segment by hand. Times are printed local time and are interpreted in the owner zone.',
    input: addInput,
    effects: ['write'],
    describe: (input) => deps.texts.addSegmentLabel(deps.texts.kindLabels[input.kind], input.title, input.start),
    async run(input) {
      const start = instantOf(input.start, 'start', deps.timeZone);
      let end: string | undefined;
      if (input.end !== undefined) {
        end = instantOf(input.end, 'end', deps.timeZone);
        if (Date.parse(end) < Date.parse(start)) throw new Error('End is before start');
      }
      const segment: TripSegment = {
        id: randomUUID().slice(0, 8),
        mailId: 'manual',
        kind: input.kind,
        title: input.title,
        start,
        startText: input.start,
        ...(end !== undefined ? { end } : {}),
        ...(input.place !== undefined ? { place: input.place } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
      };
      await deps.store.add([segment]);
      return segmentView(segment);
    },
  };
}

/** Tool "trips.remove_segment": deletion always asks the owner, so describe names the segment. */
export function tripsRemoveTool(deps: TripToolDeps): Tool<TripsRemoveInput, TripsRemoveOutput> {
  return {
    name: 'trips.remove_segment',
    description: 'Delete one trip segment permanently.',
    input: removeInput,
    effects: ['delete'],
    describe: (input) => deps.texts.removeSegmentLabel(deps.store.get(input.segmentId)?.title ?? input.segmentId),
    async run(input) {
      const removed = await deps.store.removeById(input.segmentId);
      if (removed === undefined) throw new Error(`No segment with id ${input.segmentId}`);
      return { segmentId: removed.id, removed: true };
    },
  };
}
