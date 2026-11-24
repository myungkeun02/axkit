import type { Weekday } from '../../core/time/date-spec.js';
import type { TodoTexts } from './locale.js';

const WEEKDAY_BY_INDEX: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function weekdayOfYmd(ymd: string): Weekday {
  const [year, month, day] = ymd.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return 'sun';
  const index = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return WEEKDAY_BY_INDEX[index] ?? 'sun';
}

/** "11월 20일 (금)" or "Nov 20 (Fri)". */
export function formatDate(ymd: string, texts: TodoTexts): string {
  const [, month, day] = ymd.split('-').map(Number);
  const monthLabel = texts.months[(month ?? 1) - 1] ?? String(month);
  const weekday = texts.weekdays[weekdayOfYmd(ymd)];
  return texts.language === 'ko'
    ? `${monthLabel} ${String(day)}일 (${weekday})`
    : `${monthLabel} ${String(day)} (${weekday})`;
}

/** "11월 20일 (금) 15:00", or the date alone when no time was given. */
export function formatMoment(ymd: string, hhmm: string | undefined, texts: TodoTexts): string {
  return hhmm === undefined ? formatDate(ymd, texts) : `${formatDate(ymd, texts)} ${hhmm}`;
}
