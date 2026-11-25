import type { ProposedSchedule } from '../../core/contracts/org.js';
import { wallClock } from '../../core/scheduler/next-run.js';
import type { Activity } from './activity.js';
import type { CachedSummary } from './cache.js';

export type RecurringSource = 'calendar' | 'sent' | 'mail' | 'file';

/** Work that came back on a rhythm, with the numbers that show it. */
export interface Recurring {
  source: RecurringSource;
  /** One real example ("[주간보고] 11월 3주차"). */
  label: string;
  count: number;
  schedule: ProposedSchedule;
  /** "매주 월 10:00", "매월 말일". */
  rhythm: string;
  /** ISO 8601 of the newest one. */
  last: string;
  /** One line a person can check. */
  evidence: string;
}

interface Hit {
  label: string;
  at: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_COUNT = 3;
const MAX_FOUND = 40;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const KO_DAY: Record<string, string> = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' };
const PREFIX = /^\s*((re|fw|fwd|답장|회신|전달)\s*[:：]\s*)+/i;
const DATES: readonly RegExp[] = [
  /\d+\s*(주차|회차|분기|주|차|회)/g,
  /\d{2,4}\s*[-./년]\s*\d{1,2}\s*([-./]\s*\d{1,2}|월\s*\d{1,2}\s*일|월(?![가-힣]))?/g,
  /\d{1,2}\s*월\s*(\d{1,2}\s*일)?/g,
  /(?<![a-z])(q[1-4]|h[12]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?![a-z])/gi,
  /(?<![a-z])(v|ver)\s*\d+(\.\d+)*/gi,
  /\d+/g,
  /(?<![가-힣])(주차|회차)(?![가-힣])/g,
];

/** "[주간보고] 2026년 11월 3주차_v2.docx" → "[주간보고] _" → "주간보고": what stays when dates and numbers go. */
export function normalizeTitle(text: string): string {
  let value = text.replace(PREFIX, '').replace(/\.[a-z0-9]{2,5}$/i, '').toLowerCase();
  for (const pattern of DATES) value = value.replace(pattern, ' ');
  value = value.replace(/[[\](){}<>_\-–—.,:;/\\|~'"`#*+=!?]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /[a-z가-힣]{2,}/.test(value) ? value : '';
}

function hhmm(clock: { hh: number; mm: number }): string {
  return `${String(clock.hh).padStart(2, '0')}:${String(Math.floor(clock.mm / 30) * 30).padStart(2, '0')}`;
}

function mode<T>(values: readonly T[]): { value: T; share: number } | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const best = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  return best === undefined ? undefined : { value: best[0], share: best[1] / values.length };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** The rhythm of a set of times, or undefined when it has none (or stopped a while ago). */
export function rhythmOf(times: readonly Date[], now: Date, timeZone: string, korean: boolean, withTime: boolean): { schedule: ProposedSchedule; rhythm: string } | undefined {
  const sorted = [...times].sort((left, right) => left.getTime() - right.getTime());
  const last = sorted.at(-1);
  if (last === undefined || sorted.length < MIN_COUNT) return undefined;
  const gaps = sorted.slice(1).map((time, index) => (time.getTime() - (sorted[index]?.getTime() ?? 0)) / DAY_MS).filter((gap) => gap > 0.2);
  if (gaps.length < MIN_COUNT - 1) return undefined;
  const gap = median(gaps);
  const clocks = sorted.map((time) => wallClock(time, timeZone));
  const at = withTime ? (mode(clocks.map(hhmm))?.value ?? '09:00') : '09:00';
  const silent = (now.getTime() - last.getTime()) / DAY_MS;
  if (gap <= 1.5 && sorted.length >= 10 && silent <= 14) return { schedule: { kind: 'daily', at }, rhythm: korean ? `매일 ${at}` : `daily ${at}` };
  if (gap >= 5 && gap <= 16 && silent <= 45) {
    const day = mode(clocks.map((clock) => clock.weekday.toLowerCase().slice(0, 3)));
    const weekday = DAYS.find((candidate) => candidate === day?.value) ?? 'mon';
    const every = gap > 10 ? (korean ? '격주' : 'every other week, ') : korean ? '매주' : 'weekly';
    return { schedule: { kind: 'weekly', day: weekday, at }, rhythm: korean ? `${every} ${KO_DAY[weekday] ?? weekday} ${withTime ? at : ''}`.trim() : `${every} ${weekday} ${withTime ? at : ''}`.trim() };
  }
  if (gap >= 24 && gap <= 38 && silent <= 75) {
    const days = clocks.map((clock) => clock.d);
    const late = days.filter((day) => day >= 25).length / days.length >= 0.6;
    const day = late ? -1 : (mode(days)?.value ?? 1);
    const when = korean ? (day === -1 ? '말일' : `${day}일`) : day === -1 ? 'last day' : `day ${day}`;
    return { schedule: { kind: 'monthly', day, at }, rhythm: korean ? `매월 ${when}` : `monthly, ${when}` };
  }
  return undefined;
}

function hitsBy<T>(items: readonly T[], title: (item: T) => string, at: (item: T) => Date | undefined): Map<string, Hit[]> {
  const groups = new Map<string, Hit[]>();
  for (const item of items) {
    const label = title(item).trim();
    const when = at(item);
    const key = normalizeTitle(label);
    if (key === '' || when === undefined || Number.isNaN(when.getTime())) continue;
    const list = groups.get(key) ?? [];
    list.push({ label, at: when });
    groups.set(key, list);
  }
  return groups;
}

function evidenceOf(source: RecurringSource, label: string, count: number, rhythm: string, korean: boolean): string {
  const quoted = `'${label.slice(0, 40)}'`;
  if (!korean) return `${{ calendar: 'calendar', sent: 'sent mail', mail: 'mail', file: 'files' }[source]} ${quoted} ×${count} · ${rhythm}`;
  if (source === 'calendar') return `캘린더 ${quoted} ${count}번 · ${rhythm}`;
  if (source === 'sent') return `보낸 메일 ${quoted} ${count}통 · ${rhythm}`;
  if (source === 'mail') return `받은 메일 ${quoted} ${count}통 · ${rhythm}`;
  return `문서 ${quoted} 등 ${count}개 · ${rhythm} 새로 만들어짐`;
}

/**
 * Regular meetings, reports sent on a rhythm, mail that keeps coming, and documents made again every week or month
 * (weekly reports, monthly closing), found by code from the titles and times; nothing is guessed from one example.
 */
export function findRecurring(input: { activity?: Activity; summaries: readonly CachedSummary[] }, now: Date, timeZone: string, korean: boolean): Recurring[] {
  const found: Recurring[] = [];
  const consider = (source: RecurringSource, groups: Map<string, Hit[]>, withTime: boolean, distinct: boolean): void => {
    for (const hits of groups.values()) {
      const labels = new Set(hits.map((hit) => hit.label));
      if (hits.length < MIN_COUNT || (distinct && labels.size < MIN_COUNT)) continue;
      const shape = rhythmOf(hits.map((hit) => hit.at), now, timeZone, korean, withTime);
      if (shape === undefined) continue;
      const newest = hits.reduce((best, hit) => (hit.at > best.at ? hit : best));
      found.push({ source, label: newest.label, count: hits.length, ...shape, last: newest.at.toISOString(), evidence: evidenceOf(source, newest.label, hits.length, shape.rhythm, korean) });
    }
  };
  const activity = input.activity;
  const timed = (activity?.events ?? []).filter((event) => !event.allDay && Date.parse(event.start) <= now.getTime() + 30 * DAY_MS);
  consider('calendar', hitsBy(timed, (event) => event.title, (event) => new Date(event.start)), true, false);
  consider('sent', hitsBy((activity?.mails ?? []).filter((mail) => mail.sent), (mail) => mail.subject, (mail) => new Date(mail.at)), false, false);
  consider('mail', hitsBy((activity?.mails ?? []).filter((mail) => !mail.sent), (mail) => mail.subject, (mail) => new Date(mail.at)), false, true);
  const files = input.summaries.filter((summary) => summary.kind === 'file' || summary.kind === 'drive');
  consider('file', hitsBy(files, (summary) => summary.title, (summary) => new Date(summary.modifiedAt)), false, true);
  const rank: Record<RecurringSource, number> = { calendar: 0, sent: 1, file: 2, mail: 3 };
  return found.sort((left, right) => rank[left.source] - rank[right.source] || right.count - left.count).slice(0, MAX_FOUND);
}
