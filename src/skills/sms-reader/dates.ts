import type { DateSpec, TimeSpec } from '../../core/time/date-spec.js';

/** A date or time found in the text, with where it sits so the evidence can quote the exact words. */
export interface Found<T> {
  value: T;
  index: number;
  end: number;
}

const FULL_DATE = /(20\d{2})\s*(?:[.\-/]|년)\s*(\d{1,2})\s*(?:[.\-/]|월)\s*(\d{1,2})\s*일?/g;
const KO_MONTH_DAY = /(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
const NUM_MONTH_DAY = /(?<![\d.,/-])(\d{1,2})\s*[/.]\s*(\d{1,2})(?![\d.,/%]|\s*(?:원|%))(?:\s*\([월화수목금토일]\))?/g;
const RELATIVE: readonly [RegExp, number][] = [
  [/오늘|금일/g, 0],
  [/내일/g, 1],
  [/모레/g, 2],
];
const KO_TIME = /(오전|오후|낮|밤|저녁|새벽|아침)?\s*(?<!\d)(\d{1,2})\s*시(?!간)(?:\s*(\d{1,2})\s*분|\s*(반))?/g;
const CLOCK = /(오전|오후|AM|PM)?\s*(?<![\d.])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gi;

function valid(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** All dates the text states, earliest position first. Weekday names alone are not dates. */
export function findDates(text: string): Found<DateSpec>[] {
  const found: Found<DateSpec>[] = [];
  const taken: [number, number][] = [];
  const overlaps = (index: number, end: number): boolean => taken.some(([a, b]) => index < b && end > a);
  const add = (value: DateSpec, index: number, end: number): void => {
    if (overlaps(index, end)) return;
    taken.push([index, end]);
    found.push({ value, index, end });
  };
  for (const match of text.matchAll(FULL_DATE)) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (!valid(month, day)) continue;
    add({ kind: 'date', date: `${year}-${pad(month)}-${pad(day)}` }, match.index, match.index + match[0].length);
  }
  for (const pattern of [KO_MONTH_DAY, NUM_MONTH_DAY]) {
    for (const match of text.matchAll(pattern)) {
      const [month, day] = [Number(match[1]), Number(match[2])];
      if (!valid(month, day)) continue;
      add({ kind: 'month_day', month, day }, match.index, match.index + match[0].trimEnd().length);
    }
  }
  for (const [pattern, days] of RELATIVE) {
    for (const match of text.matchAll(pattern)) add({ kind: 'offset', days }, match.index, match.index + match[0].length);
  }
  return found.sort((a, b) => a.index - b.index);
}

function meridiemOf(word: string | undefined, hour: number): TimeSpec['meridiem'] {
  if (word === undefined || hour > 12) return 'unspecified';
  if (/오후|낮|밤|저녁|pm/i.test(word)) return 'pm';
  if (/오전|새벽|아침|am/i.test(word)) return 'am';
  return 'unspecified';
}

/** All clock times the text states ("오후 7시 30분", "19:30", "7시 반"). */
export function findTimes(text: string): Found<TimeSpec>[] {
  const found: Found<TimeSpec>[] = [];
  for (const match of text.matchAll(KO_TIME)) {
    const hour = Number(match[2]);
    const minute = match[4] !== undefined ? 30 : Number(match[3] ?? 0);
    if (hour > 24 || minute > 59) continue;
    const start = match[1] !== undefined ? match.index : match.index + match[0].indexOf(match[2] ?? '');
    found.push({ value: { hour: hour % 24, minute, meridiem: meridiemOf(match[1], hour) }, index: start, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(CLOCK)) {
    const hour = Number(match[2]);
    const minute = Number(match[3]);
    const start = match[1] !== undefined ? match.index : match.index + match[0].indexOf(match[2] ?? '');
    found.push({ value: { hour, minute, meridiem: meridiemOf(match[1], hour) }, index: start, end: match.index + match[0].length });
  }
  return found.sort((a, b) => a.index - b.index);
}

/** The exact words from `start` to `end`, trimmed: what a card quotes and the evidence check finds again. */
export function quote(text: string, start: number, end: number): string {
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

const NEAR = 40;

/**
 * The first date and the first time at most 40 characters after it (or before it), with one quote that covers both.
 * Without a time nearby the quote covers the date only.
 */
export function dateAndTime(text: string): { date: DateSpec; time?: TimeSpec; evidence: string } | undefined {
  const dates = findDates(text);
  const first = dates[0];
  if (first === undefined) return undefined;
  const time = findTimes(text).find((t) => (t.index >= first.end && t.index - first.end <= NEAR) || (t.end <= first.index && first.index - t.end <= NEAR));
  if (time === undefined) return { date: first.value, evidence: quote(text, first.index, first.end) };
  const start = Math.min(first.index, time.index);
  const end = Math.max(first.end, time.end);
  return { date: first.value, time: time.value, evidence: quote(text, start, end) };
}
