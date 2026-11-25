import type { CalendarEvent, PersonSummary } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { hhmmOf, tomorrowDay } from './day-range.js';
import type { DayTexts } from './locale.js';
import { judgedCard } from './situational.js';

export const PREP_JOB = 'day.prep';
const MAX_MAIL = 2;
const MAX_COMMITMENTS = 2;
const MAIL_LOOKBACK_HOURS = 336;

function eventLine(event: CalendarEvent, texts: DayTexts, timeZone: string): string {
  const location = (event.location !== undefined && event.location !== '' ? ` ${texts.locationMark}${event.location}` : '') + (event.calendar !== undefined && event.calendar !== '' ? ` [${event.calendar}]` : '');
  if (event.allDay) return `${texts.allDay} ${event.title}${location}`;
  const time = hhmmOf(event.start, timeZone);
  return `${time ?? event.start} ${event.title}${location}`;
}

async function mailSubjects(ctx: PluginContext, title: string): Promise<string[]> {
  const mail = ctx.tryUse(Contracts.mailRead);
  if (mail === undefined) return [];
  try {
    const found = await mail.search({ text: title, sinceHours: MAIL_LOOKBACK_HOURS, limit: MAX_MAIL });
    return found.map((summary) => summary.subject).filter((subject) => subject !== '').slice(0, MAX_MAIL);
  } catch (error) {
    ctx.log.warn('day prep: related mail could not be loaded', { error: messageOf(error) });
    return [];
  }
}

function personName(person: PersonSummary, attendee: string): string {
  return person.names[0] ?? attendee;
}

async function commitmentLines(ctx: PluginContext, event: CalendarEvent, texts: DayTexts): Promise<string[]> {
  const people = ctx.tryUse(Contracts.peopleRead);
  if (people === undefined || event.attendees === undefined) return [];
  const lines: string[] = [];
  for (const attendee of event.attendees) {
    if (lines.length >= MAX_COMMITMENTS) break;
    try {
      const person = await people.find(attendee);
      if (person === undefined) continue;
      for (const commitment of person.commitments) {
        if (commitment.done || lines.length >= MAX_COMMITMENTS) continue;
        lines.push(texts.prepCommitment(personName(person, attendee), commitment.text));
      }
    } catch (error) {
      ctx.log.warn('day prep: people lookup failed', { attendee, error: messageOf(error) });
    }
  }
  return lines;
}

async function eventBlock(ctx: PluginContext, event: CalendarEvent, texts: DayTexts, timeZone: string): Promise<string[]> {
  const lines = [eventLine(event, texts, timeZone)];
  if (event.location !== undefined && event.location !== '') lines.push(`  ${texts.prepLocationCheck}`);
  else if (!event.allDay) lines.push(`  ${texts.prepLocationMissing}`);
  lines.push(...(await commitmentLines(ctx, event, texts)));
  const subjects = await mailSubjects(ctx, event.title);
  if (subjects.length > 0) lines.push(`  ${texts.prepRelatedMail(subjects.join(', '))}`);
  return lines;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Registers the evening prep notice for the next day's calendar. */
export function registerPrep(ctx: PluginContext, at: string, texts: DayTexts, situational = false): void {
  ctx.scheduler.add({
    name: PREP_JOB,
    schedule: { kind: 'daily', at: at as `${number}:${number}` },
    async run(now) {
      const calendar = ctx.tryUse(Contracts.calendarRead);
      if (calendar === undefined) return;
      const day = tomorrowDay(now, ctx.assistant.timezone);
      let events: readonly CalendarEvent[];
      try {
        events = await calendar.listEvents({ from: day.from, to: day.to });
      } catch (error) {
        ctx.log.warn('day prep: calendar could not be loaded', { error: messageOf(error) });
        return;
      }
      if (events.length === 0) return;

      const sorted = [...events].sort((left, right) => left.start.localeCompare(right.start));
      const lines = [texts.prepTitle];
      for (const event of sorted) {
        lines.push(...(await eventBlock(ctx, event, texts, ctx.assistant.timezone)));
      }

      const notifier = ctx.tryUse(Contracts.notifier);
      if (notifier === undefined) {
        ctx.log.warn('day prep: no notifier available');
        return;
      }
      const card = lines.join('\n');
      const text = situational ? await judgedCard(ctx, 'day.prep', card, texts) : card;
      if (text === undefined) return;
      await notifier.notify({ kind: 'day.prep', dedupeKey: day.ymd, text });
    },
  });
}
