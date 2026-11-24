import { z } from 'zod';
import type { CalendarEvent } from '../../../core/contracts/calendar.js';
import type { GeoPoint, PlaceSource, RouteOption } from '../../../core/contracts/index.js';
import { Contracts } from '../../../core/contracts/index.js';
import type { AppView } from '../../../core/contracts/device-api.js';
import { ViewInputError, ownerInputError } from '../../../core/contracts/device-api.js';
import type { PluginContext } from '../../../core/plugin/types.js';
import { dayRange, ymdOf } from '../../../core/time/local-day.js';

/**
 * D7: where each event is (`geo`, found from its place text with Kakao Local) and how to get there through the day
 * (`views/routes`: home → first timed event → next…, car by Kakao Mobility, transit by ODsay). Keys stay on the Mac;
 * the app only draws what this returns. Results are cached per day and recomputed when that day's events change.
 */
const NOT_A_PLACE = /온라인|online|zoom|meet\.google|teams|webex|https?:\/\/|전화|화상/i;
const BUFFER_MIN = 5;
const LOOKUPS_PER_READ = 5;

export interface Geo extends GeoPoint {
  address?: string;
}

/** Place text → coordinates, cached forever (a miss is cached too, so a bad place is not searched every read). */
export class GeoCache {
  constructor(
    private readonly ctx: PluginContext,
    private readonly places: () => PlaceSource | undefined,
  ) {}

  async peek(place: string | undefined): Promise<Geo | undefined | null> {
    if (place === undefined || place.trim() === '' || NOT_A_PLACE.test(place)) return null;
    return (await this.ctx.kv.get<Geo | null>(`geo.${place.trim().toLowerCase()}`)) ?? undefined;
  }

  async lookup(place: string | undefined): Promise<Geo | undefined> {
    const cached = await this.peek(place);
    if (cached === null) return undefined;
    if (cached !== undefined) return cached;
    const source = this.places();
    if (source === undefined || place === undefined) return undefined;
    const found = (await source.search(place.trim(), { limit: 1 }).catch(() => []))[0];
    const geo: Geo | null = found === undefined ? null : { lat: found.point.lat, lng: found.point.lng, ...(found.address !== '' ? { address: found.address } : {}) };
    await this.ctx.kv.set(`geo.${place.trim().toLowerCase()}`, geo);
    return geo ?? undefined;
  }

  /** Adds `geo` to events that have a findable place; a few new searches per call, the rest come from the cache. */
  async decorate<T extends { place?: string }>(events: T[]): Promise<(T & { geo?: Geo })[]> {
    let budget = LOOKUPS_PER_READ;
    const out: (T & { geo?: Geo })[] = [];
    for (const event of events) {
      let geo = await this.peek(event.place);
      if (geo === undefined && budget > 0) {
        budget -= 1;
        geo = (await this.lookup(event.place)) ?? null;
      }
      out.push(geo !== undefined && geo !== null ? { ...event, geo } : event);
    }
    return out;
  }
}

interface Home extends GeoPoint {
  name: string;
  address?: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The faster way; transit when it is within five minutes of the car. */
export function recommend(options: RouteOption[]): number {
  const transit = options.findIndex((option) => option.mode === 'transit');
  const car = options.findIndex((option) => option.mode === 'car');
  if (transit < 0) return car;
  if (car < 0) return transit;
  return (options[transit]?.durationMin ?? 0) - (options[car]?.durationMin ?? 0) <= BUFFER_MIN ? transit : car;
}

const dateSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const homeSchema = z.union([z.object({ query: z.string().trim().min(2).max(100) }), z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), name: z.string().max(40).optional() })]);

export function routesView(ctx: PluginContext, geo: GeoCache): AppView {
  const zone = ctx.assistant.timezone;
  const korean = ctx.assistant.language !== 'en';
  return {
    name: 'routes',
    version: 1,
    async read(query) {
      const parsed = dateSchema.safeParse(Object.fromEntries(query));
      if (!parsed.success) throw new ViewInputError('shape');
      const date = parsed.data.date ?? ymdOf(ctx.clock.now(), zone);
      const home = await ctx.kv.get<Home>('routes.home');
      const routes = ctx.tryUse(Contracts.routes);
      const calendar = ctx.tryUse(Contracts.calendarRead);
      const base = { date, provider: 'kakao+odsay' };
      if (home === undefined) return { ...base, origin: null, legs: [], note: korean ? '집 위치를 먼저 정해 주세요.' : 'Set your home location first.' };
      const events: CalendarEvent[] = calendar === undefined ? [] : (await calendar.listEvents(dayRange(date, zone)).catch(() => [])).filter((event) => !event.allDay).sort((a, b) => a.start.localeCompare(b.start));
      const placed = (await geo.decorate(events.map((event) => ({ ...event, ...(event.location !== undefined ? { place: event.location } : {}) })))).filter((event): event is typeof event & { geo: Geo } => event.geo !== undefined);
      const fingerprint = JSON.stringify([home.lat, home.lng, placed.map((event) => [event.id, event.start, event.end, event.geo.lat, event.geo.lng])]);
      const cached = await ctx.kv.get<{ fingerprint: string; data: Record<string, unknown> }>(`routes.day.${date}`);
      if (cached?.fingerprint === fingerprint) return cached.data;
      const legs = [];
      let from: { name: string; lat: number; lng: number; end?: string } = { name: home.name, lat: home.lat, lng: home.lng };
      for (const event of placed) {
        const to = { name: event.location ?? event.title, lat: event.geo.lat, lng: event.geo.lng, ...(event.geo.address !== undefined ? { address: event.geo.address } : {}) };
        const options = routes === undefined ? [] : (await Promise.all([routes.transit(from, to).catch(() => undefined), routes.car(from, to).catch(() => undefined)])).filter((option): option is RouteOption => option !== undefined);
        const arriveBy = Date.parse(event.start);
        const best = recommend(options);
        const withTimes = options.map((option, index) => ({ ...option, leaveAt: iso(arriveBy - (option.durationMin + BUFFER_MIN) * 60_000), ...(index === best ? { recommended: true } : {}) }));
        const leave = withTimes[best]?.leaveAt;
        const late = from.end !== undefined && leave !== undefined && Date.parse(from.end) > Date.parse(leave);
        legs.push({
          eventId: event.id,
          title: event.title,
          arriveBy: event.start,
          from: { name: from.name, lat: from.lat, lng: from.lng },
          to,
          options: withTimes,
          ...(late ? { note: korean ? '앞 일정이 끝나기 전에 나가야 해요.' : 'You need to leave before the previous event ends.' } : options.length === 0 ? { note: korean ? '길을 찾지 못했어요.' : 'No route found.' } : {}),
        });
        from = { name: to.name, lat: to.lat, lng: to.lng, end: event.end };
      }
      const data = { ...base, origin: { name: home.name, lat: home.lat, lng: home.lng }, legs };
      await ctx.kv.set(`routes.day.${date}`, { fingerprint, data });
      return data;
    },
    actions: {
      /** The owner's home, once: a place to search ("서울 마포구 …") or coordinates. Reversible, their own data. */
      async setHome(body) {
        const parsed = homeSchema.safeParse(body);
        if (!parsed.success) throw new ViewInputError('setHome needs {query} or {lat, lng}');
        let home: Home;
        if ('query' in parsed.data) {
          const found = (await ctx.tryUse(Contracts.places)?.search(parsed.data.query, { limit: 1 }).catch(() => []))?.[0];
          if (found === undefined) throw ownerInputError(korean ? '그 주소를 찾지 못했어요.' : 'Could not find that address.');
          home = { name: korean ? '집' : 'Home', lat: found.point.lat, lng: found.point.lng, ...(found.address !== '' ? { address: found.address } : {}) };
        } else {
          home = { name: parsed.data.name ?? (korean ? '집' : 'Home'), lat: parsed.data.lat, lng: parsed.data.lng };
        }
        await ctx.kv.set('routes.home', home);
        return { home };
      },
    },
  };
}
