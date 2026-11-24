import type { CalendarEvent, SpendEntry } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { NudgeSettings } from './config.js';
import { dueDay, hhmmOf, minutesOfDay, todayDay, tomorrowDay } from './day-range.js';
import type { DayTexts } from './locale.js';
import { judgeSituation } from './situational.js';
import type { SituationKind } from './situational.js';

export const NUDGES_JOB = 'day.nudges';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Every number the nudges decide on, so tests reference them instead of copying magic values. */
export const NUDGE_RULES = {
  everySeconds: 120,
  beforeFromMs: 30 * MINUTE_MS,
  beforeToMs: 60 * MINUTE_MS,
  /** Model calls per tick, per trigger: a slow model never blocks the next tick for long. */
  maxCallsPerTick: 2,
  /** A payment first seen later than this is old news and is passed over without a model call. */
  freshMs: 6 * HOUR_MS,
  spendBaselineDays: 90,
  spendBaselineMinSamples: 5,
  /** Judged moments are remembered this long so the same moment is never judged twice. */
  seenKeepMs: 3 * DAY_MS,
} as const;

/** Owner-zone windows [from, to) for the midday check; each runs once a day. */
export const MIDDAY_SLOTS = [
  { name: 'noon', from: 11 * 60 + 30, to: 13 * 60 + 30 },
  { name: 'afternoon', from: 15 * 60 + 30, to: 16 * 60 + 45 },
] as const;

const SENT_KEY = 'nudges.sent';
const SEEN_KEY = 'nudges.seen';
const SPEND_CURSOR_KEY = 'nudges.spendCursor';

function clip(text: string, max: number): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.name : 'error';
}

/** Daily and hourly caps for nudges, kept in the store so a restart does not hand out a fresh allowance. */
export class NudgeLimiter {
  constructor(
    private readonly ctx: PluginContext,
    private readonly settings: NudgeSettings,
  ) {}

  async canSend(now: Date): Promise<boolean> {
    const sent = await this.sent(now);
    const t = now.getTime();
    const dayStart = todayDay(now, this.ctx.assistant.timezone).from.getTime();
    const today = sent.filter((at) => at >= dayStart).length;
    const lastHour = sent.filter((at) => t - at < HOUR_MS).length;
    return today < this.settings.perDay && lastHour < this.settings.perHour;
  }

  async add(now: Date): Promise<void> {
    const sent = await this.sent(now);
    await this.ctx.kv.set(SENT_KEY, [...sent, now.getTime()]);
  }

  async seen(key: string): Promise<boolean> {
    const stamps = (await this.ctx.kv.get<Record<string, number>>(SEEN_KEY)) ?? {};
    return stamps[key] !== undefined;
  }

  async markSeen(key: string, now: Date): Promise<void> {
    const stored = (await this.ctx.kv.get<Record<string, number>>(SEEN_KEY)) ?? {};
    const stamps: Record<string, number> = {};
    for (const [entry, at] of Object.entries(stored)) {
      if (now.getTime() - at < NUDGE_RULES.seenKeepMs) stamps[entry] = at;
    }
    stamps[key] = now.getTime();
    await this.ctx.kv.set(SEEN_KEY, stamps);
  }

  private async sent(now: Date): Promise<number[]> {
    const stored = (await this.ctx.kv.get<number[]>(SENT_KEY)) ?? [];
    return stored.filter((at) => typeof at === 'number' && now.getTime() - at < 2 * DAY_MS);
  }
}

interface NudgeDeps {
  ctx: PluginContext;
  settings: NudgeSettings;
  texts: DayTexts;
  limiter: NudgeLimiter;
}

/**
 * One judged moment. The key is recorded whatever the outcome (sent, skipped, failed) so it is never judged again;
 * a failed judgment sends nothing. Returns false when the caps stop further calls this tick.
 */
async function judgeAndSend(
  deps: NudgeDeps,
  kind: SituationKind,
  key: string,
  facts: string,
  now: Date,
): Promise<boolean> {
  if (!(await deps.limiter.canSend(now))) return false;
  await deps.limiter.markSeen(key, now);
  const situation = await judgeSituation(deps.ctx, { kind, facts }, deps.texts);
  deps.ctx.log.info('day: nudge judged', { kind, outcome: situation === undefined ? 'failed' : situation.send ? 'send' : 'skip' });
  if (situation === undefined || !situation.send || situation.text === null) return true;
  const notifier = deps.ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) return true;
  const result = await notifier.notify({ kind: `day.nudge.${kind}`, dedupeKey: key, text: situation.text });
  if (result !== 'dropped') await deps.limiter.add(now);
  return true;
}

// ---------------------------------------------------------------- before an event

async function eventFacts(deps: NudgeDeps, event: CalendarEvent): Promise<string[]> {
  const { ctx } = deps;
  const extra: string[] = [];
  if (event.location !== undefined && event.location !== '') extra.push(`location: ${clip(event.location, 100)}`);
  if (event.attendees !== undefined && event.attendees.length > 0) {
    extra.push(`attendees: ${event.attendees.slice(0, 6).map((name) => clip(name, 40)).join(', ')}`);
  }

  const people = ctx.tryUse(Contracts.peopleRead);
  for (const attendee of event.attendees?.slice(0, 4) ?? []) {
    if (people === undefined) break;
    try {
      const person = await people.find(attendee);
      for (const commitment of person?.commitments ?? []) {
        if (!commitment.done) extra.push(`open promise to ${clip(attendee, 40)}: ${clip(commitment.text, 120)}`);
      }
    } catch (error) {
      ctx.log.warn('day nudges: people lookup failed', { error: messageOf(error) });
    }
  }
  const mail = ctx.tryUse(Contracts.mailRead);
  if (mail !== undefined) {
    try {
      const found = await mail.search({ text: event.title, sinceHours: 336, limit: 2 });
      const subjects = found.map((entry) => clip(entry.subject, 80)).filter((subject) => subject !== '');
      if (subjects.length > 0) extra.push(`related mail: ${subjects.join(', ')}`);
    } catch (error) {
      ctx.log.warn('day nudges: related mail could not be loaded', { error: messageOf(error) });
    }
  }
  return extra;
}

/** Events starting in 30–60 minutes, judged once each, and only when something beyond title and time is known. */
export async function beforeEventNudges(deps: NudgeDeps, now: Date): Promise<void> {
  const calendar = deps.ctx.tryUse(Contracts.calendarRead);
  if (calendar === undefined) return;
  const from = new Date(now.getTime() + NUDGE_RULES.beforeFromMs);
  const to = new Date(now.getTime() + NUDGE_RULES.beforeToMs);
  const events = await calendar.listEvents({ from, to });
  let calls = 0;
  for (const event of events) {
    if (event.allDay) continue;
    const start = Date.parse(event.start);
    if (!Number.isFinite(start) || start < from.getTime() || start > to.getTime()) continue;
    const key = `before:${event.id}:${event.start}`;
    if (await deps.limiter.seen(key)) continue;
    const extra = await eventFacts(deps, event);
    if (extra.length === 0) {
      await deps.limiter.markSeen(key, now);
      continue;
    }
    if (calls >= NUDGE_RULES.maxCallsPerTick) break;
    calls += 1;
    const time = hhmmOf(event.start, deps.ctx.assistant.timezone) ?? event.start;
    const facts = [`title: ${clip(event.title, 100)}`, `starts: ${time}`, ...extra].join('\n');
    if (!(await judgeAndSend(deps, 'event.before', key, facts, now))) break;
  }
}

// ---------------------------------------------------------------- midday check

/** Twice a day: what is left today and what is due soon. Nothing left means no model call. */
export async function middayCheck(deps: NudgeDeps, now: Date): Promise<void> {
  const timeZone = deps.ctx.assistant.timezone;
  const minutes = minutesOfDay(now, timeZone);
  const slot = MIDDAY_SLOTS.find((entry) => minutes >= entry.from && minutes < entry.to);
  if (slot === undefined) return;
  const today = todayDay(now, timeZone);
  const key = `midday:${slot.name}:${today.ymd}`;
  if (await deps.limiter.seen(key)) return;

  const lines: string[] = [];
  const calendar = deps.ctx.tryUse(Contracts.calendarRead);
  if (calendar !== undefined) {
    try {
      const events = await calendar.listEvents({ from: now, to: today.to });
      for (const event of events.filter((entry) => !entry.allDay).slice(0, 5)) {
        const where = event.location !== undefined && event.location !== '' ? ` (${clip(event.location, 60)})` : '';
        lines.push(`left today: ${hhmmOf(event.start, timeZone) ?? event.start} ${clip(event.title, 80)}${where}`);
      }
    } catch (error) {
      deps.ctx.log.warn('day nudges: calendar could not be loaded', { error: messageOf(error) });
    }
  }
  const todo = deps.ctx.tryUse(Contracts.todoRead);
  if (todo !== undefined) {
    try {
      const tomorrow = tomorrowDay(now, timeZone).ymd;
      const open = (await todo.open()).filter((item) => {
        const day = dueDay(item.due, timeZone);
        return !item.done && day !== undefined && day <= tomorrow;
      });
      for (const item of open.slice(0, 3)) {
        const day = dueDay(item.due, timeZone) ?? '';
        lines.push(`due soon: ${clip(item.text, 80)} (${day < today.ymd ? 'overdue' : day})`);
      }
    } catch (error) {
      deps.ctx.log.warn('day nudges: to-dos could not be loaded', { error: messageOf(error) });
    }
  }
  if (lines.length === 0) {
    await deps.limiter.markSeen(key, now);
    return;
  }
  await judgeAndSend(deps, 'day.midday', key, lines.join('\n'), now);
}

// ---------------------------------------------------------------- unusual payment

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** True when the entry is at least `ratio` times its category's median over the last 90 days. */
export function isUnusualSpend(entry: SpendEntry, history: readonly SpendEntry[], ratio: number): boolean {
  if (entry.amount <= 0 || entry.excluded === true) return false;
  const since = Date.parse(entry.at) - NUDGE_RULES.spendBaselineDays * DAY_MS;
  const samples = history
    .filter((other) => other.id !== entry.id && other.category === entry.category && other.amount > 0)
    .filter((other) => {
      const at = Date.parse(other.at);
      return at >= since && at < Date.parse(entry.at);
    })
    .map((other) => other.amount);
  if (samples.length < NUDGE_RULES.spendBaselineMinSamples) return false;
  return entry.amount >= ratio * median(samples);
}

/** New payments far above their category's usual size. Ordinary payments cost no model call. */
export async function spendNudges(deps: NudgeDeps, now: Date): Promise<void> {
  const spend = deps.ctx.tryUse(Contracts.spendRead);
  if (spend === undefined) return;
  const stored = await deps.ctx.kv.get<string>(SPEND_CURSOR_KEY);
  if (stored === undefined) {
    // first run: never replay old payments as if they were new
    await deps.ctx.kv.set(SPEND_CURSOR_KEY, now.toISOString());
    return;
  }
  const cursor = new Date(stored);
  const history = await spend.entries({
    from: new Date(cursor.getTime() - NUDGE_RULES.spendBaselineDays * DAY_MS),
    to: now,
  });
  const fresh = history
    .filter((entry) => Date.parse(entry.at) > cursor.getTime())
    .sort((left, right) => left.at.localeCompare(right.at));
  let calls = 0;
  let handled: string | undefined;
  for (const entry of fresh) {
    const key = `spend:${entry.id}`;
    const old = now.getTime() - Date.parse(entry.at) > NUDGE_RULES.freshMs;
    if (old || (await deps.limiter.seen(key)) || !isUnusualSpend(entry, history, deps.settings.spendRatio)) {
      handled = entry.at;
      continue;
    }
    if (calls >= NUDGE_RULES.maxCallsPerTick || !(await deps.limiter.canSend(now))) break;
    calls += 1;
    handled = entry.at;
    const usual = median(
      history.filter((other) => other.category === entry.category && other.id !== entry.id && other.amount > 0).map((other) => other.amount),
    );
    const facts = [
      `merchant: ${clip(entry.merchant, 80)}`,
      `amount: ${entry.amount} ${spend.homeCurrency()}`,
      `category: ${entry.category}`,
      `usual for this category (median, 90 days): ${Math.round(usual)} ${spend.homeCurrency()}`,
      `at: ${hhmmOf(entry.at, deps.ctx.assistant.timezone) ?? entry.at}`,
    ].join('\n');
    await judgeAndSend(deps, 'spend.unusual', key, facts, now);
  }
  if (handled !== undefined) await deps.ctx.kv.set(SPEND_CURSOR_KEY, handled);
}

// ---------------------------------------------------------------- job

/** One interval job for every enabled nudge, each step isolated. Nothing on means no job at all. */
export function registerNudges(ctx: PluginContext, settings: NudgeSettings, texts: DayTexts): void {
  if (!(settings.beforeEvent || settings.midday || settings.spend)) return;
  const deps: NudgeDeps = { ctx, settings, texts, limiter: new NudgeLimiter(ctx, settings) };
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      ctx.log.warn('day: nudge step failed', { name, error: messageOf(error) });
    }
  };
  ctx.scheduler.add({
    name: NUDGES_JOB,
    schedule: { kind: 'every', seconds: NUDGE_RULES.everySeconds },
    async run(now) {
      if (settings.beforeEvent) await step('before-event', () => beforeEventNudges(deps, now));
      if (settings.midday) await step('midday', () => middayCheck(deps, now));
      if (settings.spend) await step('spend', () => spendNudges(deps, now));
    },
  });
}
