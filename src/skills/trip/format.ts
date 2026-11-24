import { looksInternational } from './group.js';
import type { TripTexts } from './locale.js';
import { parsePrinted } from './parse.js';
import type { Trip, TripSegment } from './types.js';

/** "MM/DD" or "MM/DD HH:MM" from the printed local booking text. */
export function stampOf(startText: string): string {
  const printed = parsePrinted(startText);
  if (printed === undefined) return startText;
  const md = `${printed.ymd.slice(5, 7)}/${printed.ymd.slice(8, 10)}`;
  return printed.hhmm === undefined ? md : `${md} ${printed.hhmm}`;
}

export function tripName(trip: Trip, texts: TripTexts): string {
  return trip.name === '' ? texts.untitledTrip : trip.name;
}

export function dateRangeOf(trip: Trip, texts: TripTexts): string {
  return texts.dateRange(trip.startYmd, trip.endYmd);
}

export function segmentLine(segment: TripSegment, texts: TripTexts): string {
  const parts = [`- ${stampOf(segment.startText)}`, texts.kindLabels[segment.kind]];
  if (segment.from !== undefined && segment.to !== undefined) parts.push(`${segment.from}→${segment.to}`);
  else if (segment.to !== undefined) parts.push(`→${segment.to}`);
  else if (segment.place !== undefined && !segment.title.includes(segment.place)) parts.push(segment.place);
  parts.push(segment.title);
  return parts.join(' ');
}

export function itineraryLines(trip: Trip, texts: TripTexts): string[] {
  return trip.segments.map((segment) => segmentLine(segment, texts));
}

export function tripText(trip: Trip, texts: TripTexts): string {
  return [texts.tripTitle(tripName(trip, texts), dateRangeOf(trip, texts)), ...itineraryLines(trip, texts)].join(
    '\n',
  );
}

export function checklistItems(trip: Trip, texts: TripTexts): string[] {
  const items = [...texts.baseChecklist];
  const kinds = new Set(trip.segments.map((segment) => segment.kind));
  if (kinds.has('flight')) {
    const international = trip.segments.some((segment) => segment.kind === 'flight' && looksInternational(segment));
    items.push(...texts.flightChecklist(international));
  }
  if (kinds.has('train') || kinds.has('bus')) items.push(texts.trainChecklist);
  if (kinds.has('stay')) items.push(texts.stayChecklist);
  if (kinds.has('car')) items.push(texts.carChecklist);
  if (kinds.has('event')) items.push(texts.eventChecklist);
  return items;
}

/** A D-N notice: header, optional weather, timeline, then the checklist. */
export function checklistNotice(trip: Trip, days: number, texts: TripTexts, weather?: string): string {
  const lines = [texts.header(days, tripName(trip, texts), dateRangeOf(trip, texts))];
  if (weather !== undefined) lines.push(weather);
  lines.push(...itineraryLines(trip, texts));
  lines.push('');
  lines.push(texts.checklistTitle);
  lines.push(...checklistItems(trip, texts).map((item) => `- ${item}`));
  return lines.join('\n');
}
