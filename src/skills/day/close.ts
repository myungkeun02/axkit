import type { CalendarEvent, TodoItem } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { dueDay, hhmmOf, startMsOf, todayDay, tomorrowDay } from './day-range.js';
import type { DayTexts } from './locale.js';
import { judgedCard } from './situational.js';

export const CLOSE_JOB = 'day.close';
const MAX_OPEN_TODOS = 5;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safe<T>(load: () => Promise<T>, ctx: PluginContext, what: string): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    ctx.log.warn(`day close: ${what} could not be loaded`, { error: messageOf(error) });
    return undefined;
  }
}

function dueMark(due: string | undefined, today: string, tomorrow: string, texts: DayTexts): string {
  if (due === undefined) return '';
  if (due < today) return ` ${texts.markOverdue}`;
  if (due === today) return ` ${texts.markToday}`;
  if (due === tomorrow) return ` ${texts.markTomorrow}`;
  return '';
}

function selectOpen(items: readonly TodoItem[], today: string, tomorrow: string, timeZone: string): TodoItem[] {
  return items
    .filter((item) => !item.done)
    .map((item) => ({ item, day: dueDay(item.due, timeZone) }))
    .filter((entry): entry is { item: TodoItem; day: string } => entry.day !== undefined && entry.day <= tomorrow)
    .sort((left, right) => left.day.localeCompare(right.day))
    .slice(0, MAX_OPEN_TODOS)
    .map((entry) => entry.item);
}

function firstTimed(events: readonly CalendarEvent[]): CalendarEvent | undefined {
  return events
    .filter((event) => !event.allDay && Number.isFinite(startMsOf(event)))
    .sort((left, right) => left.start.localeCompare(right.start))[0];
}

/** Registers the deterministic evening close-out summary. */
export function registerClose(ctx: PluginContext, at: string, texts: DayTexts, situational = false): void {
  ctx.scheduler.add({
    name: CLOSE_JOB,
    schedule: { kind: 'daily', at: at as `${number}:${number}` },
    async run(now) {
      const timeZone = ctx.assistant.timezone;
      const today = todayDay(now, timeZone);
      const tomorrow = tomorrowDay(now, timeZone);
      const calendar = ctx.tryUse(Contracts.calendarRead);
      const todo = ctx.tryUse(Contracts.todoRead);
      const phone = ctx.tryUse(Contracts.phoneSignals);

      const [events, completed, open, tomorrowEvents, totals] = await Promise.all([
        calendar === undefined
          ? Promise.resolve(undefined)
          : safe(() => calendar.listEvents({ from: today.from, to: today.to }), ctx, 'calendar'),
        todo === undefined ? Promise.resolve(undefined) : safe(() => todo.doneSince(today.from), ctx, 'completed to-dos'),
        todo === undefined ? Promise.resolve(undefined) : safe(() => todo.open(), ctx, 'to-dos'),
        calendar === undefined
          ? Promise.resolve(undefined)
          : safe(() => calendar.listEvents({ from: tomorrow.from, to: tomorrow.to }), ctx, 'tomorrow calendar'),
        phone === undefined ? Promise.resolve(undefined) : safe(() => phone.dayTotals(today.ymd), ctx, 'phone totals'),
      ]);

      const lines = [texts.closeTitle];
      const counts: string[] = [];
      if (events !== undefined) counts.push(texts.closeEventCount(events.length));
      if (completed !== undefined) counts.push(texts.closeCompletedCount(completed.length));
      if (counts.length > 0) lines.push(counts.join(' · '));

      if (open !== undefined) {
        const selected = selectOpen(open, today.ymd, tomorrow.ymd, timeZone);
        if (selected.length === 0) {
          lines.push(texts.noOpenTodos);
        } else {
          lines.push(texts.openTodosTitle);
          for (const item of selected) {
            const day = dueDay(item.due, timeZone);
            lines.push(`- ${item.text}${dueMark(day, today.ymd, tomorrow.ymd, texts)}`);
          }
        }
      }

      if (tomorrowEvents !== undefined) {
        const first = firstTimed(tomorrowEvents);
        const time = first === undefined ? undefined : hhmmOf(first.start, timeZone);
        lines.push(
          first === undefined
            ? texts.noTomorrowEvent
            : texts.tomorrowFirst(`${time ?? first.start} ${first.title}`),
        );
      }

      if (totals?.steps !== undefined) lines.push(texts.stepsLine(totals.steps));

      const notifier = ctx.tryUse(Contracts.notifier);
      if (notifier === undefined) {
        ctx.log.warn('day close: no notifier available');
        return;
      }
      const card = lines.join('\n');
      const text = situational ? await judgedCard(ctx, 'day.close', card, texts) : card;
      if (text === undefined) return;
      await notifier.notify({ kind: 'day.close', dedupeKey: today.ymd, text });
    },
  });
}
