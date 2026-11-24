import { z } from 'zod';
import type { Schedule } from '../../core/scheduler/types.js';
import { wallClock } from '../../core/scheduler/next-run.js';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const at = z
  .string()
  .transform((value) => (/^\d:\d\d$/.test(value) ? `0${value}` : value))
  .pipe(z.string().regex(HHMM, 'expected HH:MM (24h), e.g. "09:00"'));

/** When a routine runs, in the owner's time zone. */
export const routineScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), at }),
  z.object({ kind: z.literal('weekly'), day: z.enum(WEEKDAYS), at }),
  z.object({ kind: z.literal('every'), hours: z.number().int().min(1).max(24) }),
]);
export type RoutineSchedule = z.infer<typeof routineScheduleSchema>;

/** Also takes the short text forms a model tends to write: "daily 09:00", "weekly mon 09:00", "every 3 hours". */
export function scheduleFromText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim().toLowerCase();
  const daily = /^daily\s+(\d{1,2}:\d\d)$/.exec(text);
  if (daily !== null) return { kind: 'daily', at: daily[1] };
  const weekly = /^weekly\s+([a-z]{3})\s+(\d{1,2}:\d\d)$/.exec(text);
  if (weekly !== null) return { kind: 'weekly', day: weekly[1], at: weekly[2] };
  const every = /^every\s+(\d{1,2})\s*(?:h|hours?)$/.exec(text);
  if (every !== null) return { kind: 'every', hours: Number(every[1]) };
  return value;
}

export const scheduleInput = z.preprocess(scheduleFromText, routineScheduleSchema);

/** The scheduler job behind a routine. A weekly routine is a daily job that checks the day itself. */
export function jobSchedule(schedule: RoutineSchedule): Schedule {
  if (schedule.kind === 'every') return { kind: 'every', seconds: schedule.hours * 3600 };
  return { kind: 'daily', at: schedule.at as `${number}:${number}` };
}

/** Whether a run due at `due` should go ahead (false only for a weekly routine on another day). */
export function dueOn(schedule: RoutineSchedule, due: Date, timeZone: string): boolean {
  if (schedule.kind !== 'weekly') return true;
  return wallClock(due, timeZone).weekday.toLowerCase().slice(0, 3) === schedule.day;
}

const KO_DAYS: Record<Weekday, string> = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' };
const EN_DAYS: Record<Weekday, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

function koTime(value: string): string {
  const [hh = 0, mm = 0] = value.split(':').map(Number);
  const half = hh < 12 ? '오전' : '오후';
  const hour = hh % 12 === 0 ? 12 : hh % 12;
  return mm === 0 ? `${half} ${hour}시` : `${half} ${hour}시 ${mm}분`;
}

/** "매일 오전 9시", "매주 월요일 오후 2시 30분", "3시간마다". */
export function scheduleLabel(schedule: RoutineSchedule, korean: boolean): string {
  if (schedule.kind === 'every') return korean ? `${schedule.hours}시간마다` : `Every ${schedule.hours} h`;
  if (schedule.kind === 'daily') return korean ? `매일 ${koTime(schedule.at)}` : `Every day at ${schedule.at}`;
  return korean ? `매주 ${KO_DAYS[schedule.day]}요일 ${koTime(schedule.at)}` : `Every ${EN_DAYS[schedule.day]} at ${schedule.at}`;
}
