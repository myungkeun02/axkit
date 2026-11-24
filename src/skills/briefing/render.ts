import type { Choice, OutgoingMessage } from '../../core/conversation/types.js';
import type { CalendarEvent, MailSummary, WeatherReport } from '../../core/contracts/index.js';
import { wallClock } from '../../core/scheduler/next-run.js';
import type { BriefingData, BriefingTodo, Section } from './gather.js';
import type { BriefingTexts, SectionTexts } from './locale.js';

export interface RenderOptions {
  texts: BriefingTexts;
  timeZone: string;
  ownerName?: string;
}

const BULLET = '- ';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function clockTime(iso: string, timeZone: string): string | undefined {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return undefined;
  const wall = wallClock(instant, timeZone);
  return `${pad2(wall.hh)}:${pad2(wall.mm)}`;
}

function eventLine(event: CalendarEvent, texts: BriefingTexts, timeZone: string): string {
  if (event.allDay) return `${texts.allDay} ${event.title}`;
  const time = clockTime(event.start, timeZone);
  return time === undefined ? event.title : `${time} ${event.title}`;
}

function mailLine(mail: MailSummary): string {
  return `${mail.from} — ${mail.subject}`;
}

function todoLine(todo: BriefingTodo, texts: BriefingTexts): string {
  return todo.overdue ? `${todo.text} ${texts.overdueMark}` : todo.text;
}

function temperatureText(report: WeatherReport): string {
  if (report.maxC !== undefined && report.minC !== undefined) {
    return ` ${Math.round(report.maxC)}°/${Math.round(report.minC)}°`;
  }
  return report.tempC === undefined ? '' : ` ${Math.round(report.tempC)}°`;
}

function weatherLine(report: WeatherReport, texts: BriefingTexts): string {
  const dust =
    report.air === undefined ? '' : `, ${texts.dust} ${texts.airGrade(report.air.grade)}`;
  return `${texts.weather}: ${report.sky}${temperatureText(report)}${dust}`;
}

interface SectionLabels {
  empty: string;
  notConnected: string;
  failed: string;
}

function labels(texts: BriefingTexts, key: keyof SectionTexts): SectionLabels {
  return { empty: texts.empty[key], notConnected: texts.notConnected[key], failed: texts.failed[key] };
}

function sectionLines<T>(
  section: Section<T>,
  texts: SectionLabels,
  render: (item: T) => string,
): string[] {
  if (section.state === 'not_connected') return [texts.notConnected];
  if (section.state === 'failed') return [texts.failed];
  if (section.items.length === 0) return [texts.empty];
  return section.items.map((item) => `${BULLET}${render(item)}`);
}

function block(title: string, lines: readonly string[]): string {
  return [title, ...lines].join('\n');
}

function choiceOf(label: string): Choice {
  return { id: label, label };
}

/** Choices exist only for sections that actually have something to open. */
function choicesFor(data: BriefingData, texts: BriefingTexts): Choice[] {
  const choices: Choice[] = [];
  if (data.calendar.state === 'ok' && data.calendar.items.length > 0) choices.push(choiceOf(texts.choices.calendar));
  if (data.mail.state === 'ok' && data.mail.items.length > 0) choices.push(choiceOf(texts.choices.mail));
  if (data.todo.state === 'ok' && data.todo.items.length > 0) choices.push(choiceOf(texts.choices.todo));
  return choices;
}

/** Turns gathered data into the owner-facing message. Pure: no clock, no network. */
export function renderBriefing(data: BriefingData, opts: RenderOptions): OutgoingMessage {
  const { texts, timeZone } = opts;
  const greeting = texts.greeting(opts.ownerName, texts.date(data.date.month, data.date.day, data.date.weekday));

  const calendar = sectionLines(data.calendar, labels(texts, 'calendar'), (event) =>
    eventLine(event, texts, timeZone),
  );
  const mail = sectionLines(data.mail, labels(texts, 'mail'), mailLine);
  const todo = sectionLines(data.todo, labels(texts, 'todo'), (item) => todoLine(item, texts));

  const weather =
    data.weather?.state === 'ok' ? weatherLine(data.weather.report, texts) : undefined;

  const text = [
    greeting,
    ...(weather !== undefined ? [weather] : []),
    block(texts.titles.calendar, calendar),
    block(texts.titles.mail, mail),
    block(texts.titles.todo, todo),
  ].join('\n\n');

  const choices = choicesFor(data, texts);
  return { text, ...(choices.length > 0 ? { choices } : {}) };
}
