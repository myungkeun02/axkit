import type { DateSpec, TimeSpec, Weekday } from './date-spec.js';
import {
  KOREAN_HOUR_WORDS,
  MIDNIGHT_WORDS,
  MONTH_NAMES_EN,
  NEXT_WEEK_WORDS,
  NOON_WORDS,
  OFFSET_WORDS,
  WEEKDAY_WORDS,
} from './words.js';

const QUOTES = /["'“”‘’]/g;

/** NFC, lower case, no quotes, single spaces: the form both evidence and grounding are compared in. */
export function normalizeText(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(QUOTES, '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWord(text: string, word: string): boolean {
  if (!/[a-z]/.test(word)) return text.includes(word);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`).test(text);
}

function hasAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => hasWord(text, word));
}

/** True when the quoted evidence appears in what the turn is grounded on. Evidence shorter than 2 chars is ignored. */
export function evidenceFound(evidence: string, grounding: readonly string[]): boolean {
  const needle = normalizeText(evidence);
  if (needle.length < 2) return false;
  return grounding.some((entry) => normalizeText(entry).includes(needle));
}

function parseDateString(value: string): { month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  return { month: Number(match[2]), day: Number(match[3]) };
}

function numericMonthDay(month: number, day: number, text: string): boolean {
  return new RegExp(`(^|[^0-9])0?${month}\\s*[/.\\-]\\s*0?${day}([^0-9]|$)`).test(text);
}

function englishMonthDay(month: number, day: number, text: string): boolean {
  const names = MONTH_NAMES_EN[month - 1] ?? [];
  const dayPattern = `0?${day}(?:st|nd|rd|th)?`;
  return names.some((name) => {
    const monthFirst = new RegExp(`(^|[^a-z])${escapeRegExp(name)}\\s+${dayPattern}([^0-9]|$)`);
    const dayFirst = new RegExp(`(^|[^0-9])${dayPattern}\\s+(?:of\\s+)?${escapeRegExp(name)}([^a-z]|$)`);
    return monthFirst.test(text) || dayFirst.test(text);
  });
}

function dayMentioned(month: number, day: number, text: string): boolean {
  if (new RegExp(`(^|[^0-9])${day}\\s*일`).test(text)) return true;
  return numericMonthDay(month, day, text) || englishMonthDay(month, day, text);
}

function offsetMentioned(days: number, text: string): boolean {
  const words = OFFSET_WORDS[days];
  if (words !== undefined && hasAny(text, words)) return true;
  if (days <= 0) return false;
  if (new RegExp(`(^|[^0-9])${days}\\s*일\\s*(후|뒤)`).test(text)) return true;
  return new RegExp(`(^|[^a-z0-9])in\\s+${days}\\s*days?([^a-z]|$)`).test(text);
}

function weekdayMentioned(weekday: Weekday, week: 'this' | 'next' | 'nearest', text: string): boolean {
  const words = WEEKDAY_WORDS[weekday];
  const hit = hasAny(text, words.ko) || words.en.some((word) => hasWord(text, word));
  if (!hit) return false;
  // "다음 주 금요일" read as this week's Friday is the classic off-by-a-week mistake: the words must agree.
  return hasAny(text, NEXT_WEEK_WORDS) === (week === 'next');
}

/** True when the owner's words name the day the spec points at. */
export function dateMentioned(spec: DateSpec, evidence: string): boolean {
  const text = normalizeText(evidence);
  switch (spec.kind) {
    case 'offset':
      return offsetMentioned(spec.days, text);
    case 'weekday':
      return weekdayMentioned(spec.weekday, spec.week, text);
    case 'date': {
      const parsed = parseDateString(spec.date);
      if (text.includes(normalizeText(spec.date))) return true;
      return parsed !== undefined && dayMentioned(parsed.month, parsed.day, text);
    }
    case 'month_day':
      return dayMentioned(spec.month, spec.day, text);
  }
}

function resolvedHour(spec: TimeSpec): number {
  if (spec.meridiem === 'am') return spec.hour % 12;
  if (spec.meridiem === 'pm') return (spec.hour % 12) + 12;
  return spec.hour;
}

function numericClock(text: string, hour: number, minute: number): boolean {
  return new RegExp(`(^|[^0-9])0?${hour}:0?${minute}([^0-9]|$)`).test(text);
}

function hourBeforeUnit(text: string, hour: number, unit: '시' | 'h'): boolean {
  if (unit === '시') return new RegExp(`(^|[^0-9])0?${hour}\\s*시`).test(text);
  return new RegExp(`(^|[^0-9])0?${hour}\\s*h([^a-z]|$)`).test(text);
}

function nativeHour(text: string): number | undefined {
  const words = KOREAN_HOUR_WORDS.map((entry) => entry.word).join('|');
  const match = new RegExp(`(^|[^가-힣])(${words})\\s*시`).exec(text);
  if (match === null || match[2] === undefined) return undefined;
  return KOREAN_HOUR_WORDS.find((entry) => entry.word === match[2])?.hour;
}

function meridiemHour(text: string, hour: number, meridiem: TimeSpec['meridiem']): boolean {
  const match = new RegExp(`(^|[^0-9])0?${hour}\\s*(am|pm)([^a-z]|$)`).exec(text);
  if (match === null) return false;
  return meridiem === 'unspecified' || match[2] === meridiem;
}

function minuteMentioned(text: string, minute: number): boolean {
  if (minute === 0) return true;
  if (minute === 30 && /반/.test(text)) return true;
  if (new RegExp(`(^|[^0-9])0?${minute}\\s*분`).test(text)) return true;
  return new RegExp(`:0?${minute}([^0-9]|$)`).test(text);
}

/** True when the owner's words name the clock time (hour and, when not on the hour, minutes) the spec points at. */
export function timeMentioned(spec: TimeSpec, evidence: string): boolean {
  const text = normalizeText(evidence);
  if (!minuteMentioned(text, spec.minute)) return false;
  const hour24 = resolvedHour(spec);
  if (hour24 === 12 && hasAny(text, NOON_WORDS)) return true;
  if (hour24 === 0 && hasAny(text, MIDNIGHT_WORDS)) return true;
  const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24;
  if (numericClock(text, spec.hour, spec.minute) || numericClock(text, hour24, spec.minute)) return true;
  if (hourBeforeUnit(text, spec.hour, '시') || hourBeforeUnit(text, hour24, '시')) return true;
  if (nativeHour(text) === hour12) return true;
  if (meridiemHour(text, hour12, spec.meridiem)) return true;
  return hourBeforeUnit(text, hour24, 'h');
}
