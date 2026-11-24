import { z } from 'zod';
import type { WeatherReport } from '../../core/contracts/index.js';
import type { KoLifeDeps } from './deps.js';
import { keyOf } from './deps.js';
import { fetchJson, parseShape } from './http.js';
import { KO_SECRETS } from './secrets.js';

const AIR_URL =
  'https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty';

const Envelope = z.object({
  response: z.object({
    header: z.object({ resultCode: z.string() }),
    body: z.object({ items: z.array(z.unknown()) }),
  }),
});

const Station = z.object({
  pm10Value: z.union([z.string(), z.number()]).optional(),
  pm25Value: z.union([z.string(), z.number()]).optional(),
});

const SIDO: Readonly<Record<string, string>> = {
  서울특별시: '서울',
  부산광역시: '부산',
  대구광역시: '대구',
  인천광역시: '인천',
  광주광역시: '광주',
  대전광역시: '대전',
  울산광역시: '울산',
  세종특별자치시: '세종',
  경기도: '경기',
  강원특별자치도: '강원',
  강원도: '강원',
  충청북도: '충북',
  충청남도: '충남',
  전북특별자치도: '전북',
  전라북도: '전북',
  전라남도: '전남',
  경상북도: '경북',
  경상남도: '경남',
  제주특별자치도: '제주',
};

const SHORT_SIDO = new Set(Object.values(SIDO));

/** "서울특별시 중구" and "서울" both become "서울"; unknown regions return undefined. */
export function normalizeSido(region: string | undefined): string | undefined {
  if (region === undefined) return undefined;
  const token = region.trim().split(/\s+/)[0] ?? '';
  if (token === '') return undefined;
  return SIDO[token] ?? (SHORT_SIDO.has(token) ? token : undefined);
}

function numbers(values: readonly unknown[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) out.push(parsed);
  }
  return out;
}

function average(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

const GRADE_RANK: Readonly<Record<string, number>> = {
  좋음: 0,
  보통: 1,
  나쁨: 2,
  매우나쁨: 3,
  '매우 나쁨': 3,
};

function gradePm10(value: number): string {
  if (value <= 30) return '좋음';
  if (value <= 80) return '보통';
  if (value <= 150) return '나쁨';
  return '매우나쁨';
}

function gradePm25(value: number): string {
  if (value <= 15) return '좋음';
  if (value <= 35) return '보통';
  if (value <= 75) return '나쁨';
  return '매우나쁨';
}

function worse(left: string, right: string): string {
  return (GRADE_RANK[right] ?? 0) > (GRADE_RANK[left] ?? 0) ? right : left;
}

/** Air quality for a 시도. Throws on service errors; the weather caller decides to ignore them. */
export async function airQuality(
  deps: KoLifeDeps,
  sido: string,
): Promise<WeatherReport['air'] | undefined> {
  const key = await keyOf(deps, KO_SECRETS.dataGoKr);
  const params = new URLSearchParams({
    serviceKey: key,
    returnType: 'json',
    numOfRows: '200',
    pageNo: '1',
    sidoName: sido,
    ver: '1.0',
  });
  const response = await fetchJson(deps.fetch, `${AIR_URL}?${params}`);
  const body = parseShape(Envelope, response, 'AirKorea');
  if (body.response.header.resultCode !== '00') {
    throw new Error('AirKorea rejected the request.');
  }

  const stations: z.infer<typeof Station>[] = [];
  for (const raw of body.response.body.items) {
    const parsed = Station.safeParse(raw);
    if (parsed.success) stations.push(parsed.data);
  }
  const pm10 = average(numbers(stations.map((station) => station.pm10Value)));
  const pm25 = average(numbers(stations.map((station) => station.pm25Value)));
  if (pm10 === undefined && pm25 === undefined) return undefined;

  const grade =
    pm10 !== undefined && pm25 !== undefined
      ? worse(gradePm10(pm10), gradePm25(pm25))
      : pm10 !== undefined
        ? gradePm10(pm10)
        : gradePm25(pm25 as number);

  return {
    grade,
    ...(pm10 !== undefined ? { pm10 } : {}),
    ...(pm25 !== undefined ? { pm25 } : {}),
  };
}
