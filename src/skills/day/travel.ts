import type { CalendarEvent, GeoPoint } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { hhmmOf, startMsOf } from './day-range.js';
import type { DayTexts } from './locale.js';
import { transitHandles } from './transit-job.js';

export const TRAVEL_JOB = 'day.travel';
const CHECK_SECONDS = 300;
const HORIZON_MINUTES = 180;
const PHONE_MAX_AGE_MINUTES = 60;
const WALK_LIMIT_KM = 1.2;
const WALK_MIN_PER_KM = 15;
const TRANSIT_BASE_MINUTES = 10;
const TRANSIT_MIN_PER_KM = 4;
const EARTH_RADIUS_KM = 6371;
const POINTS_KEY = 'travel.points';
const POINT_CAP = 50;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPoint(value: unknown): value is GeoPoint {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['lat'] === 'number' && typeof record['lng'] === 'number';
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Straight-line distance; road distance is longer, which the estimate below acknowledges. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rough door-to-door minutes: walking up close, otherwise transit plus a generous per-kilometre allowance. */
export function estimateMinutes(km: number): number {
  if (km < WALK_LIMIT_KM) return Math.max(1, Math.ceil(km * WALK_MIN_PER_KM));
  return Math.max(1, Math.ceil(TRANSIT_BASE_MINUTES + TRANSIT_MIN_PER_KM * km));
}

async function cachedPoint(ctx: PluginContext, event: CalendarEvent, location: string): Promise<GeoPoint | undefined> {
  const points = (await ctx.kv.get<Record<string, unknown>>(POINTS_KEY)) ?? {};
  const cached = points[event.id];
  if (isPoint(cached)) return cached;
  const places = ctx.tryUse(Contracts.places);
  if (places === undefined) return undefined;
  const point = await places.geocode(location);
  if (point === undefined) return undefined;
  const updated: Record<string, unknown> = { ...points, [event.id]: point };
  const keep = Object.keys(updated).slice(-POINT_CAP);
  await ctx.kv.set(POINTS_KEY, Object.fromEntries(keep.map((key) => [key, updated[key]])));
  return point;
}

function nextEvent(events: readonly CalendarEvent[], now: Date): CalendarEvent | undefined {
  const nowMs = now.getTime();
  const horizonMs = nowMs + HORIZON_MINUTES * 60_000;
  return events
    .filter((event) => {
      if (event.allDay) return false;
      if (event.location === undefined || event.location === '') return false;
      const startMs = startMsOf(event);
      return Number.isFinite(startMs) && startMs >= nowMs && startMs <= horizonMs;
    })
    .sort((left, right) => left.start.localeCompare(right.start))[0];
}

async function checkTravel(ctx: PluginContext, bufferMinutes: number, texts: DayTexts, now: Date): Promise<void> {
  const calendar = ctx.tryUse(Contracts.calendarRead);
  const phone = ctx.tryUse(Contracts.phoneSignals);
  if (calendar === undefined || phone === undefined) return;

  const horizon = new Date(now.getTime() + HORIZON_MINUTES * 60_000);
  let events: readonly CalendarEvent[];
  try {
    events = await calendar.listEvents({ from: now, to: horizon });
  } catch (error) {
    ctx.log.warn('day travel: calendar could not be loaded', { error: messageOf(error) });
    return;
  }
  const event = nextEvent(events, now);
  if (event === undefined || event.location === undefined) return;
  // the route card (browser agent, real timetables) already looks after it
  if (await transitHandles(ctx, event)) return;

  let origin: GeoPoint | undefined;
  try {
    origin = await phone.latestLocation(PHONE_MAX_AGE_MINUTES);
  } catch (error) {
    ctx.log.warn('day travel: phone location could not be read', { error: messageOf(error) });
    return;
  }
  if (origin === undefined) return;

  let destination: GeoPoint | undefined;
  try {
    destination = await cachedPoint(ctx, event, event.location);
  } catch (error) {
    ctx.log.warn('day travel: place could not be geocoded', { error: messageOf(error) });
    return;
  }
  if (destination === undefined) return;

  const route = await routeMinutes(ctx, origin, destination);
  const minutes = route?.minutes ?? estimateMinutes(haversineKm(origin, destination));
  const startMs = startMsOf(event);
  const leaveBy = startMs - (minutes + bufferMinutes) * 60_000;
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    ctx.log.warn('day travel: no notifier available');
    return;
  }
  const hhmm = hhmmOf(event.start, ctx.assistant.timezone) ?? event.start;
  // well ahead: how long it takes from here and when to leave, once per event
  if (now.getTime() < leaveBy) {
    if (leaveBy - now.getTime() > AHEAD_MS) return;
    const told = `travel.ahead:${event.id}:${event.start}`;
    if ((await ctx.kv.get<boolean>(told)) === true) return;
    await ctx.kv.set(told, true);
    const leave = hhmmOf(new Date(leaveBy).toISOString(), ctx.assistant.timezone) ?? '';
    await notifier.notify({ kind: 'day.travel', dedupeKey: `ahead:${event.id}`, text: texts.travelAhead(event.title, hhmm, event.location, minutes, leave, route?.mode) });
    return;
  }
  await notifier.notify({
    kind: 'day.travel',
    urgent: true,
    dedupeKey: event.id,
    text: `${texts.travelUrgent(event.title, hhmm, minutes)}\n${texts.travelNote}`,
  });
}

/** The heads-up comes when leaving is at most this far off. */
const AHEAD_MS = 60 * 60_000;

/** Real travel time when the route services are connected: transit first, then car. */
async function routeMinutes(ctx: PluginContext, from: GeoPoint, to: GeoPoint): Promise<{ minutes: number; mode: 'transit' | 'car' } | undefined> {
  const routes = ctx.tryUse(Contracts.routes);
  if (routes === undefined) return undefined;
  const transit = await routes.transit(from, to).catch(() => undefined);
  if (transit !== undefined) return { minutes: Math.ceil(transit.durationMin), mode: 'transit' };
  const car = await routes.car(from, to).catch(() => undefined);
  return car !== undefined ? { minutes: Math.ceil(car.durationMin), mode: 'car' } : undefined;
}

/** Registers the five-minute travel-time sweep. Capabilities are resolved on every run. */
export function registerTravel(ctx: PluginContext, bufferMinutes: number, texts: DayTexts): void {
  ctx.scheduler.add({
    name: TRAVEL_JOB,
    schedule: { kind: 'every', seconds: CHECK_SECONDS },
    run: (now) => checkTravel(ctx, bufferMinutes, texts, now),
  });
}
