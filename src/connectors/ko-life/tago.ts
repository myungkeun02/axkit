import { z } from 'zod';
import type { TransitArrival } from '../../core/contracts/index.js';
import type { KoLifeDeps } from './deps.js';
import { keyOf } from './deps.js';
import { fetchJson, parseShape } from './http.js';
import { KO_SECRETS } from './secrets.js';

const BASE = 'https://apis.data.go.kr/1613000';
const CITY_URL = `${BASE}/BusSttnInfoInqireService/getCtyCodeList`;
const STOP_URL = `${BASE}/BusSttnInfoInqireService/getSttnNoList`;
const ARRIVAL_URL = `${BASE}/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList`;

const CITY_KEY = 'tago:cities';
const CITY_TTL_MS = 7 * 86_400_000;
const STOP_ROWS = '10';
const ARRIVAL_ROWS = '20';
const CITY_NAMES = ['서울', '서울특별시'] as const;

const Envelope = z.object({
  response: z.object({
    header: z.object({ resultCode: z.union([z.string(), z.number()]) }),
    body: z
      .object({
        items: z.unknown().optional(),
      })
      .optional(),
  }),
});

const CityRow = z.object({
  citycode: z.union([z.string(), z.number()]),
  cityname: z.string(),
});

const StopRow = z.object({
  nodeid: z.union([z.string(), z.number()]).optional(),
  nodenm: z.string().optional(),
  nodeno: z.union([z.string(), z.number()]).optional(),
});

const ArrivalRow = z.object({
  routeno: z.union([z.string(), z.number()]).optional(),
  arrtime: z.union([z.string(), z.number()]).optional(),
  arrprevstationcnt: z.union([z.string(), z.number()]).optional(),
  nodenm: z.string().optional(),
});

export interface TagoCityConfig {
  /** A city name such as "대전"; resolved through the TAGO city list. */
  city?: string;
  /** A numeric city code; skips the lookup. */
  cityCode?: number;
}

interface CachedCity {
  code: string;
  name: string;
}

/** Seoul runs on the Seoul open-data APIs even though TAGO also lists it. */
export function isSeoulTransitCity(city: TagoCityConfig): boolean {
  if (city.cityCode === 11) return true;
  const name = (city.city ?? '').trim().toLowerCase().replace(/\s+/g, '');
  return name === 'seoul' || (CITY_NAMES as readonly string[]).includes(name);
}

function textOf(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

function numberOf(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `items` arrives as "", a single row object, or a row array. */
function asItems(value: unknown): unknown[] {
  if (value === undefined || value === null || typeof value === 'string') return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const item = record['item'];
  if (item === undefined || item === null || typeof item === 'string') {
    return 'item' in record ? [] : [value];
  }
  return Array.isArray(item) ? item : [item];
}

function itemsOf(body: unknown, service: string): unknown[] {
  const parsed = parseShape(Envelope, body, service);
  if (String(parsed.response.header.resultCode) !== '00') {
    throw new Error(`${service} rejected the request.`);
  }
  return asItems(parsed.response.body?.items);
}

function cachedCities(value: unknown): { at: string; items: CachedCity[] } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record['at'] !== 'string' || !Array.isArray(record['items'])) return undefined;
  const items: CachedCity[] = [];
  for (const raw of record['items']) {
    if (typeof raw !== 'object' || raw === null) continue;
    const city = raw as Record<string, unknown>;
    if (typeof city['code'] === 'string' && typeof city['name'] === 'string') {
      items.push({ code: city['code'], name: city['name'] });
    }
  }
  return { at: record['at'], items };
}

function compact(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

/** Bus arrivals for a city TAGO covers (everything outside Seoul). */
export class TagoBusArrivals {
  constructor(
    private readonly deps: KoLifeDeps,
    private readonly city: TagoCityConfig,
  ) {}

  async arrivals(stop: string): Promise<TransitArrival[]> {
    const query = stop.trim();
    if (query === '') throw new Error('A stop name is required.');
    const cityCode = await this.cityCode();
    const key = await keyOf(this.deps, KO_SECRETS.dataGoKr);
    const station = await this.findStop(key, cityCode, query);
    if (station === undefined) return [];
    const rows = await this.arrivalRows(key, cityCode, station.id);
    const arrivals: TransitArrival[] = [];
    for (const raw of rows) {
      const parsed = ArrivalRow.safeParse(raw);
      if (!parsed.success) continue;
      const route = textOf(parsed.data.routeno);
      const seconds = numberOf(parsed.data.arrtime);
      if (route === undefined || seconds === undefined) continue;
      const minutes = Math.round(seconds / 60);
      const stations = numberOf(parsed.data.arrprevstationcnt);
      arrivals.push({
        route,
        minutes,
        message: this.deps.texts.tagoArrival(minutes, stations),
        stop: textOf(parsed.data.nodenm) ?? station.name,
      });
    }
    return arrivals;
  }

  private async cityCode(): Promise<string> {
    if (this.city.cityCode !== undefined) return String(this.city.cityCode);
    const name = this.city.city?.trim();
    if (name === undefined || name === '') throw new Error(this.deps.texts.tagoCityMissing);
    const key = await keyOf(this.deps, KO_SECRETS.dataGoKr);
    const wanted = compact(name);
    const cities = await this.cities(key);
    const found =
      cities.find((candidate) => compact(candidate.name) === wanted) ??
      cities.find((candidate) => compact(candidate.name).includes(wanted));
    if (found === undefined) throw new Error(this.deps.texts.tagoCityUnknown(name));
    return found.code;
  }

  private async cities(key: string): Promise<CachedCity[]> {
    const stored = cachedCities(await this.deps.kv.get<unknown>(CITY_KEY));
    if (stored !== undefined) {
      const age = this.deps.clock.now().getTime() - Date.parse(stored.at);
      if (Number.isFinite(age) && age >= 0 && age < CITY_TTL_MS) return stored.items;
    }

    const params = new URLSearchParams({ serviceKey: key, _type: 'json' });
    const body = await fetchJson(this.deps.fetch, `${CITY_URL}?${params}`);
    const items = itemsOf(body, 'TAGO city list').flatMap((raw) => {
      const parsed = CityRow.safeParse(raw);
      if (!parsed.success) return [];
      const code = textOf(parsed.data.citycode);
      const name = textOf(parsed.data.cityname);
      return code === undefined || name === undefined ? [] : [{ code, name }];
    });
    await this.deps.kv.set(CITY_KEY, { at: this.deps.clock.now().toISOString(), items });
    return items;
  }

  private async findStop(
    key: string,
    cityCode: string,
    query: string,
  ): Promise<{ id: string; name: string } | undefined> {
    const params = new URLSearchParams({
      serviceKey: key,
      cityCode,
      nodeNm: query,
      numOfRows: STOP_ROWS,
      _type: 'json',
    });
    const body = await fetchJson(this.deps.fetch, `${STOP_URL}?${params}`);
    const wanted = query.toLowerCase();
    for (const raw of itemsOf(body, 'TAGO stops')) {
      const parsed = StopRow.safeParse(raw);
      if (!parsed.success) continue;
      const id = textOf(parsed.data.nodeid);
      const name = textOf(parsed.data.nodenm);
      if (id === undefined || name === undefined) continue;
      if (name.toLowerCase().includes(wanted)) return { id, name };
    }
    return undefined;
  }

  private async arrivalRows(key: string, cityCode: string, nodeId: string): Promise<unknown[]> {
    const params = new URLSearchParams({
      serviceKey: key,
      cityCode,
      nodeId,
      numOfRows: ARRIVAL_ROWS,
      _type: 'json',
    });
    const body = await fetchJson(this.deps.fetch, `${ARRIVAL_URL}?${params}`);
    return itemsOf(body, 'TAGO bus arrivals');
  }
}
