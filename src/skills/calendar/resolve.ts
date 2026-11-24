import type { DateSpec, TimeSpec, Weekday } from '../../core/time/date-spec.js';
import { resolveDate, resolveTime } from '../../core/time/date-spec.js';
import type { CalendarTexts } from './locale.js';

export interface ResolvedWhen {
  ymd: string;
  weekday: Weekday;
  hhmm?: string;
  /** English guesses from core/time/date-spec; non-empty means the owner should confirm. */
  guesses: string[];
}

/** Resolves the owner's stated day and time with the injected clock and the owner's zone. */
export function resolveWhen(
  date: DateSpec,
  time: TimeSpec | undefined,
  now: Date,
  timeZone: string,
): ResolvedWhen {
  const resolved = resolveDate(date, now, timeZone);
  const guesses = resolved.guess === undefined ? [] : [resolved.guess];
  if (time === undefined) return { ymd: resolved.ymd, weekday: resolved.weekday, guesses };
  const clock = resolveTime(time);
  if (clock.guess !== undefined) guesses.push(clock.guess);
  return { ymd: resolved.ymd, weekday: resolved.weekday, hhmm: clock.hhmm, guesses };
}

/** Localized reason for an approval card, or undefined when nothing was guessed. */
export function guessNote(guesses: readonly string[], texts: CalendarTexts): string | undefined {
  if (guesses.length === 0) return undefined;
  const labels = guesses.map((guess) => texts.guesses[guess] ?? texts.uncertain);
  return [...new Set(labels)].join('; ');
}
