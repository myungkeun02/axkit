import type { GeoPoint, KnownPlaces, KnownPlacesSource } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { haversineKm } from './travel.js';

export const PLACES_JOB = 'day.places';
const SAMPLES_KEY = 'places.samples';
const EVERY_SECONDS = 30 * 60;
/** About 300 m: one cell is "the same place". */
const CELL_DEG = 0.003;
/** Times seen before a place counts as home or work. */
const MIN_SEEN = 3;
const MAX_CELLS = 200;

interface Cell {
  lat: number;
  lng: number;
  night: number;
  day: number;
}

function hourAndWeekday(at: Date, timeZone: string): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((part) => part.type === 'weekday')?.value ?? '');
  return { hour, weekday };
}

function cellKey(point: GeoPoint): string {
  return `${String(Math.round(point.lat / CELL_DEG))}:${String(Math.round(point.lng / CELL_DEG))}`;
}

/** Most-seen night cell is home, most-seen weekday-working-hours cell is work. */
export function placesOf(cells: Readonly<Record<string, Cell>>): KnownPlaces {
  const list = Object.values(cells);
  const best = (field: 'night' | 'day'): GeoPoint | undefined => {
    const top = [...list].sort((a, b) => b[field] - a[field])[0];
    return top !== undefined && top[field] >= MIN_SEEN ? { lat: top.lat, lng: top.lng } : undefined;
  };
  const home = best('night');
  const work = best('day');
  return { ...(home !== undefined ? { home } : {}), ...(work !== undefined ? { work } : {}) };
}

/** Within `km` of a known place. */
export function near(point: GeoPoint, place: GeoPoint | undefined, km: number): boolean {
  return place !== undefined && haversineKm(point, place) <= km;
}

/** One sample: where the phone is now, counted as night (22–6 h) or working hours (weekdays 10–17 h). */
export async function samplePlace(ctx: PluginContext, now: Date): Promise<void> {
  const phone = ctx.tryUse(Contracts.phoneSignals);
  if (phone === undefined) return;
  const location = await phone.latestLocation(30).catch(() => undefined);
  if (location === undefined) return;
  const { hour, weekday } = hourAndWeekday(now, ctx.assistant.timezone);
  const night = hour >= 22 || hour < 6;
  const working = weekday >= 1 && weekday <= 5 && hour >= 10 && hour < 17;
  if (!night && !working) return;
  const cells = (await ctx.kv.get<Record<string, Cell>>(SAMPLES_KEY)) ?? {};
  const key = cellKey(location);
  const cell = cells[key] ?? { lat: location.lat, lng: location.lng, night: 0, day: 0 };
  cells[key] = { ...cell, night: cell.night + (night ? 1 : 0), day: cell.day + (working ? 1 : 0) };
  const kept = Object.entries(cells).sort(([, a], [, b]) => b.night + b.day - (a.night + a.day)).slice(0, MAX_CELLS);
  await ctx.kv.set(SAMPLES_KEY, Object.fromEntries(kept));
}

/** Learns home and work from the phone and offers them to other skills (the briefing's weather, lunch). */
export function registerPlaces(ctx: PluginContext): KnownPlacesSource {
  const source: KnownPlacesSource = { get: async () => placesOf((await ctx.kv.get<Record<string, Cell>>(SAMPLES_KEY)) ?? {}) };
  ctx.provide(Contracts.knownPlaces, source);
  ctx.scheduler.add({ name: PLACES_JOB, schedule: { kind: 'every', seconds: EVERY_SECONDS }, run: (now) => samplePlace(ctx, now) });
  return source;
}

export { hourAndWeekday };
