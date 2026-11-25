import { z } from 'zod';
import type { GeoPoint, WeatherReport, WeatherSource } from '../../core/contracts/index.js';
import { MissingKeyError } from '../../core/contracts/index.js';
import { openMeteo } from './open-meteo.js';
import { airQuality, normalizeSido } from './air.js';
import type { KoLifeDeps } from './deps.js';
import { keyOf } from './deps.js';
import { forecastBase, kmaGrid, kstWall, ultraBase } from './grid.js';
import { fetchJson, parseShape } from './http.js';
import type { KakaoPlaces } from './kakao.js';
import { KO_SECRETS } from './secrets.js';

const FORECAST_URL =
  'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst';
const ULTRA_URL =
  'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst';

const Envelope = z.object({
  response: z.object({
    header: z.object({ resultCode: z.string() }),
    body: z
      .object({ items: z.object({ item: z.array(z.unknown()) }) })
      .optional(),
  }),
});

const Item = z.object({
  category: z.string(),
  fcstDate: z.string().optional(),
  fcstTime: z.string().optional(),
  fcstValue: z.union([z.string(), z.number()]).optional(),
  obsrValue: z.union([z.string(), z.number()]).optional(),
});

type KmaItem = z.infer<typeof Item>;

const SKY_WORDS: Readonly<Record<string, string>> = {
  '1': '맑음',
  '3': '구름많음',
  '4': '흐림',
};

const PTY_WORDS: Readonly<Record<string, string>> = {
  '1': '비',
  '2': '비/눈',
  '3': '눈',
  '4': '소나기',
};

function valueOf(item: KmaItem): string | undefined {
  const value = item.fcstValue ?? item.obsrValue;
  return value === undefined ? undefined : String(value);
}

function numberValue(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringOf(item: KmaItem | undefined): string | undefined {
  return item === undefined ? undefined : valueOf(item);
}

function numberOf(item: KmaItem | undefined): number | undefined {
  return numberValue(stringOf(item));
}

function timeMinutes(item: KmaItem): number | undefined {
  const raw = item.fcstTime;
  if (raw === undefined || raw.length !== 4) return undefined;
  return Number(raw.slice(0, 2)) * 60 + Number(raw.slice(2));
}

function nearest(items: readonly KmaItem[], category: string, minutes: number): KmaItem | undefined {
  let best: KmaItem | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (item.category !== category) continue;
    const at = timeMinutes(item);
    if (at === undefined) continue;
    const distance = Math.abs(at - minutes);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return best;
}

function firstOf(items: readonly KmaItem[], category: string): KmaItem | undefined {
  return items.find((item) => item.category === category);
}

function maxOf(items: readonly KmaItem[], category: string): number | undefined {
  const values = items
    .filter((item) => item.category === category)
    .map((item) => numberValue(valueOf(item)))
    .filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : Math.max(...values);
}

function tempRange(items: readonly KmaItem[]): { min?: number; max?: number } {
  const values = items
    .filter((item) => item.category === 'TMP')
    .map((item) => numberValue(valueOf(item)))
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return {};
  return { min: Math.min(...values), max: Math.max(...values) };
}

async function fetchItems(
  deps: KoLifeDeps,
  url: string,
  params: URLSearchParams,
): Promise<KmaItem[]> {
  const response = await fetchJson(deps.fetch, `${url}?${params}`);
  const body = parseShape(Envelope, response, 'KMA');
  if (body.response.header.resultCode !== '00') {
    throw new Error('The weather service rejected the request.');
  }
  const raw = body.response.body?.items.item;
  if (raw === undefined) throw new Error('KMA returned an unexpected response.');
  const items: KmaItem[] = [];
  for (const entry of raw) {
    const parsed = Item.safeParse(entry);
    if (parsed.success) items.push(parsed.data);
  }
  return items;
}

function requestParams(key: string, base: { baseDate: string; baseTime: string }, nx: number, ny: number): URLSearchParams {
  return new URLSearchParams({
    serviceKey: key,
    pageNo: '1',
    numOfRows: '1000',
    dataType: 'JSON',
    base_date: base.baseDate,
    base_time: base.baseTime,
    nx: String(nx),
    ny: String(ny),
  });
}

const MIDDAY_MINUTES = 12 * 60;

/** A forecast for `ymd` (KST date); today uses the current time and observation, a later date its midday slot. */
function buildReport(forecast: readonly KmaItem[], ultra: readonly KmaItem[], now: Date, ymd?: string): WeatherReport {
  const wall = kstWall(now);
  const target = ymd ?? wall.ymd;
  const today = forecast.filter((item) => item.fcstDate === target);
  const minutes = target === wall.ymd ? wall.hh * 60 + wall.mm : MIDDAY_MINUTES;

  const pty = nearest(today, 'PTY', minutes);
  const sky = nearest(today, 'SKY', minutes);
  const observed = target === wall.ymd ? ultra.find((item) => item.category === 'T1H') : undefined;
  const range = tempRange(today);
  const maxC = numberOf(firstOf(today, 'TMX')) ?? range.max;
  const minC = numberOf(firstOf(today, 'TMN')) ?? range.min;
  const tempC = numberOf(observed) ?? numberOf(nearest(today, 'TMP', minutes));
  const rainChance = maxOf(today, 'POP');

  return {
    sky: PTY_WORDS[stringOf(pty) ?? ''] ?? SKY_WORDS[stringOf(sky) ?? ''] ?? '',
    ...(tempC !== undefined ? { tempC } : {}),
    ...(minC !== undefined ? { minC } : {}),
    ...(maxC !== undefined ? { maxC } : {}),
    ...(rainChance !== undefined ? { rainChance } : {}),
    observedAt: now,
  };
}

/** KMA short-term forecast plus the current observation, with air quality when a region is known. */
export class KmaWeather implements WeatherSource {
  constructor(
    private readonly deps: KoLifeDeps,
    private readonly kakao: Pick<KakaoPlaces, 'regionOf'>,
    private readonly sido: string | undefined,
  ) {}

  async today(point: GeoPoint): Promise<WeatherReport> {
    const key = await this.keyOrNone();
    if (key === undefined) {
      const report = await openMeteo(this.deps.fetch, point, this.deps.clock.now());
      if (report === undefined) throw new Error('No weather for this place.');
      return report;
    }
    const now = this.deps.clock.now();
    const { nx, ny } = kmaGrid(point.lat, point.lng);
    const forecast = await fetchItems(
      this.deps,
      FORECAST_URL,
      requestParams(key, forecastBase(now), nx, ny),
    );
    const ultra = await fetchItems(
      this.deps,
      ULTRA_URL,
      requestParams(key, ultraBase(now), nx, ny),
    ).catch(() => []);
    const report = buildReport(forecast, ultra, now);
    const air = await this.airOf(point);
    return air === undefined ? report : { ...report, air };
  }

  /** KMA's short-term forecast reaches about three days ahead; a later date has no report. */
  async forecast(point: GeoPoint, ymd: string): Promise<WeatherReport | undefined> {
    const key = await this.keyOrNone();
    if (key === undefined) return openMeteo(this.deps.fetch, point, this.deps.clock.now(), ymd);
    const now = this.deps.clock.now();
    const compact = ymd.replaceAll('-', '');
    if (compact === kstWall(now).ymd) return this.today(point);
    const { nx, ny } = kmaGrid(point.lat, point.lng);
    const items = await fetchItems(this.deps, FORECAST_URL, requestParams(key, forecastBase(now), nx, ny));
    if (!items.some((item) => item.fcstDate === compact)) return undefined;
    return buildReport(items, [], now, compact);
  }

  /** The public-data key, or undefined before the owner adds it: then the keyless Open-Meteo answers instead. */
  private async keyOrNone(): Promise<string | undefined> {
    try {
      return await keyOf(this.deps, KO_SECRETS.dataGoKr);
    } catch (error) {
      if (error instanceof MissingKeyError) return undefined;
      throw error;
    }
  }

  private async airOf(point: GeoPoint): Promise<WeatherReport['air'] | undefined> {
    try {
      const region = this.sido ?? (await this.kakao.regionOf(point));
      const sido = normalizeSido(region);
      if (sido === undefined) return undefined;
      return await airQuality(this.deps, sido);
    } catch {
      return undefined;
    }
  }
}
