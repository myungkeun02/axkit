import type { CalendarEvent } from '../../core/contracts/index.js';
import type { WebAgent } from '../../core/contracts/web-agent.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { ymdOf } from '../../core/time/local-day.js';
import { meetLinkIn } from '../../core/text/meet-link.js';
import { minutesOfDay } from './day-range.js';
import type { Departure, Route } from './transit-route.js';
import { buildTransitTask, cleanText, formatCard, formatDeparture, parseRoutes, recommendDeparture } from './transit-route.js';

export const TRANSIT_JOB = 'day.transit';
const EVERY_SECONDS = 5 * 60;
/** Lookups (each one a browser run) per local day, cards and live checks together. */
export const DAILY_LOOKUP_CAP = 5;
const HORIZON_MS = 24 * 3_600_000;
const BUFFER_MIN = 10;
/** The "지금 나가시면 돼요" message comes this long before the recommended departure. */
const REMIND_LEAD_MIN = 10;
const LOOKUP_TIMEOUT_MIN = 5;
const MAX_CARDS = 2;
/** Unprompted cards only between 08:00 and 22:00 local time. */
const ACTIVE_FROM_MIN = 8 * 60;
const ACTIVE_TO_MIN = 22 * 60;
const HOME_ASKED = 'transit.home-asked';
const HOME_FACT = /^\s*(?:집|출발지|집 근처|길안내 출발지)\s*(?:[:：=]|은|는)\s*(.+?)\s*(?:이야|예요|이에요|입니다)?[.!]?\s*$/;
const NOT_PHYSICAL = /(https?:\/\/|www\.|\bzoom\b|줌|meet\.google|구글\s*밋|\bteams\b|팀즈|webex|온라인|화상|비대면|\bonline\b|\bvirtual\b|\bremote\b|전화|통화|\bcall\b)/i;

/** A real place to travel to: not empty, not a link, not "online" or a call. */
export function isPhysicalLocation(location: string | undefined): boolean {
  const t = (location ?? '').trim();
  return t.length >= 2 && !NOT_PHYSICAL.test(t) && meetLinkIn(t) === undefined;
}

interface TransitState {
  fp: string;
  cards: number;
  route?: Route;
  departAt?: string;
  reminded?: boolean;
  /** Origin text the route was looked up from. */
  origin?: string;
}

const stateKey = (event: CalendarEvent): string => `transit:${event.id}`;
const fpOf = (event: CalendarEvent): string => `${event.start}|${(event.location ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}`;

/** Whether the transit job looks after this event (the rough travel heads-up then stays quiet). */
export async function transitHandles(ctx: PluginContext, event: CalendarEvent): Promise<boolean> {
  return (await ctx.kv.get<TransitState>(stateKey(event))) !== undefined;
}

async function used(ctx: PluginContext, now: Date): Promise<number> {
  return (await ctx.kv.get<number>(`transit.used:${ymdOf(now, ctx.assistant.timezone)}`)) ?? 0;
}

async function count(ctx: PluginContext, now: Date): Promise<void> {
  await ctx.kv.set(`transit.used:${ymdOf(now, ctx.assistant.timezone)}`, (await used(ctx, now)) + 1);
}

/** The owner's stated home base ("집은 정자역이야, 기억해"), never guessed. */
async function homeBase(ctx: PluginContext): Promise<string | undefined> {
  const facts = await ctx.tryUse(Contracts.memoryRead)?.recall({ text: '집 출발지', subject: 'owner', limit: 20 }).catch(() => []);
  for (const fact of facts ?? []) {
    const match = HOME_FACT.exec(fact.text.split('\n')[0] ?? '');
    const value = cleanText(match?.[1] ?? '', 80);
    if (value !== '') return value;
  }
  return undefined;
}

/** The phone's place (an event within 3 hours) > the previous event that day > the stated home. */
async function originOf(ctx: PluginContext, event: CalendarEvent, events: readonly CalendarEvent[], now: Date): Promise<{ text: string; note?: string } | undefined> {
  const start = Date.parse(event.start);
  if (start - now.getTime() < 3 * 3_600_000) {
    const here = await ctx.tryUse(Contracts.phoneSignals)?.latestLocation(30).catch(() => undefined);
    const label = cleanText(here?.label ?? '', 80);
    if (label !== '') return { text: label, note: `출발: 지금 계신 곳(${label})` };
  }
  const zone = ctx.assistant.timezone;
  const prev = events
    .filter((other) => other.id !== event.id && !other.allDay && isPhysicalLocation(other.location))
    .filter((other) => Date.parse(other.end) <= start && start - Date.parse(other.end) < 3 * 3_600_000 && ymdOf(new Date(other.end), zone) === ymdOf(new Date(start), zone))
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0];
  if (prev?.location !== undefined) return { text: cleanText(prev.location, 80), note: `출발: 앞 일정 장소(${cleanText(prev.location, 40)})` };
  const home = await homeBase(ctx);
  return home !== undefined ? { text: home, note: `출발: 집(${home})` } : undefined;
}

async function lookup(agent: WebAgent, task: string): Promise<Route[] | undefined> {
  const result = await agent.run({ task, mode: 'look', timeoutMinutes: LOOKUP_TIMEOUT_MIN }).catch(() => undefined);
  if (result === undefined || !result.ok) return undefined;
  return parseRoutes(result.answer);
}

async function tell(ctx: PluginContext, text: string, dedupeKey: string, urgent = false): Promise<void> {
  await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'day.transit', text, dedupeKey, ...(urgent ? { urgent: true } : {}) }).catch(() => undefined);
}

/**
 * One sweep: the next appointment with a real place gets a route card (rides, when to leave); a changed time or place
 * gets one updated card; ten minutes before leaving, a fresh look at the next departures. At most one browser run
 * per sweep and five a day.
 */
export async function transitSweep(ctx: PluginContext, now: Date): Promise<void> {
  const agent = ctx.tryUse(Contracts.webAgent);
  const calendar = ctx.tryUse(Contracts.calendarRead);
  if (agent === undefined || calendar === undefined) return;
  const zone = ctx.assistant.timezone;
  const dayStart = new Date(now.getTime() - 12 * 3_600_000);
  const events = await calendar.listEvents({ from: dayStart, to: new Date(now.getTime() + HORIZON_MS) }).catch(() => []);
  const ahead = events.filter((event) => !event.allDay && Date.parse(event.start) > now.getTime() && isPhysicalLocation(event.location)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  // 1. leaving soon: the live look comes first
  for (const event of ahead) {
    const state = await ctx.kv.get<TransitState>(stateKey(event));
    if (state?.route === undefined || state.departAt === undefined || state.reminded === true) continue;
    const departAt = Date.parse(state.departAt);
    if (now.getTime() < departAt - REMIND_LEAD_MIN * 60_000) continue;
    await ctx.kv.set(stateKey(event), { ...state, reminded: true });
    let route = state.route;
    let live = false;
    if ((await used(ctx, now)) < DAILY_LOOKUP_CAP && state.origin !== undefined) {
      await count(ctx, now);
      const fresh = await lookup(agent, buildTransitTask({ from: state.origin, to: event.location ?? '', departAt: new Date(Math.max(departAt, now.getTime())), timeZone: zone }));
      if (fresh?.[0] !== undefined) {
        route = fresh[0];
        live = true;
      }
    }
    await tell(ctx, formatDeparture(event.title, new Date(event.start), route, now, live, zone), `transit-go:${event.id}:${event.start}`, true);
    return;
  }

  // 2. a card for the next appointment that has none, or whose time or place changed
  const minutes = minutesOfDay(now, zone);
  if (minutes < ACTIVE_FROM_MIN || minutes >= ACTIVE_TO_MIN) return;
  for (const event of ahead) {
    const state = await ctx.kv.get<TransitState>(stateKey(event));
    const fp = fpOf(event);
    if (state !== undefined && (state.fp === fp || state.cards >= MAX_CARDS)) continue;
    if ((await used(ctx, now)) >= DAILY_LOOKUP_CAP) return;
    const origin = await originOf(ctx, event, events, now);
    if (origin === undefined) {
      if ((await ctx.kv.get<boolean>(HOME_ASKED)) !== true) {
        await ctx.kv.set(HOME_ASKED, true);
        await tell(ctx, '🚇 길 안내 출발지로 쓸 집 근처 역이나 동을 알려 주세요 (예: "집은 정자역이야, 기억해")', 'transit-home');
      }
      return;
    }
    await count(ctx, now);
    const startAt = new Date(event.start);
    const routes = (await lookup(agent, buildTransitTask({ from: origin.text, to: event.location ?? '', arriveBy: new Date(startAt.getTime() - BUFFER_MIN * 60_000), timeZone: zone }))) ?? [];
    const best = routes[0];
    const departure: Departure | undefined = best !== undefined ? recommendDeparture(startAt, best, BUFFER_MIN, zone) : undefined;
    const cards = (state?.cards ?? 0) + 1;
    await ctx.kv.set(stateKey(event), {
      fp,
      cards,
      origin: origin.text,
      ...(best !== undefined ? { route: best } : {}),
      ...(departure !== undefined ? { departAt: departure.departAt.toISOString() } : {}),
    } satisfies TransitState);
    await tell(
      ctx,
      formatCard({ title: event.title, startAt, routes, ...(departure !== undefined ? { departure } : {}), ...(origin.note !== undefined ? { originNote: origin.note } : {}), update: state !== undefined, timeZone: zone }),
      `transit-card:${event.id}:${String(cards)}`,
    );
    return;
  }
}

/** Registers the five-minute sweep; one sweep at a time (a browser run can take minutes). */
export function registerTransit(ctx: PluginContext): void {
  let running = false;
  ctx.scheduler.add({
    name: TRANSIT_JOB,
    schedule: { kind: 'every', seconds: EVERY_SECONDS },
    async run(now) {
      if (running) return;
      running = true;
      try {
        await transitSweep(ctx, now);
      } finally {
        running = false;
      }
    },
  });
}
