import type { Weekday } from '../../core/time/date-spec.js';
import type { CalendarTexts } from './locale.js';

const WEEKDAY_BY_INDEX: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface LocalParts {
  ymd: string;
  hhmm: string;
}

/** Weekday of a calendar date, independent of the machine's time zone. */
export function weekdayOfYmd(ymd: string): Weekday {
  const [year, month, day] = ymd.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return 'sun';
  const index = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return WEEKDAY_BY_INDEX[index] ?? 'sun';
}

/** "11월 20일 (금)" or "Nov 20 (Fri)". */
export function formatDate(ymd: string, texts: CalendarTexts): string {
  const [, month, day] = ymd.split('-').map(Number);
  const monthLabel = texts.months[(month ?? 1) - 1] ?? String(month);
  const weekday = texts.weekdays[weekdayOfYmd(ymd)];
  return texts.language === 'ko'
    ? `${monthLabel} ${String(day)}일 (${weekday})`
    : `${monthLabel} ${String(day)} (${weekday})`;
}

function zonedParts(iso: string, timeZone: string): LocalParts {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    const [date = '', time = ''] = iso.split('T');
    return { ymd: date.slice(0, 10), hhmm: time.slice(0, 5) };
  }
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const values: Record<string, string> = {};
  for (const part of format.formatToParts(instant)) values[part.type] = part.value;
  return {
    ymd: `${values.year ?? ''}-${values.month ?? ''}-${values.day ?? ''}`,
    hhmm: `${values.hour ?? ''}:${values.minute ?? ''}`,
  };
}

/** Readable local range for an event: "11월 20일 (금) 15:00–16:00" or "11월 20일 (금) 종일". */
export function formatEventLocal(
  event: { start: string; end: string; allDay: boolean },
  timeZone: string,
  texts: CalendarTexts,
): string {
  if (event.allDay) return `${formatDate(event.start.slice(0, 10), texts)} ${texts.allDay}`;
  const start = zonedParts(event.start, timeZone);
  const end = zonedParts(event.end, timeZone);
  return `${formatDate(start.ymd, texts)} ${start.hhmm}${texts.timeSeparator}${end.hhmm}`;
}

/** "11월 20일 (금) 15:00" for a single local moment. */
export function formatMoment(ymd: string, hhmm: string | undefined, texts: CalendarTexts): string {
  return hhmm === undefined ? formatDate(ymd, texts) : `${formatDate(ymd, texts)} ${hhmm}`;
}
