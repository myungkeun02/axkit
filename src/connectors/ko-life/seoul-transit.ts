import { z } from 'zod';
import type { TransitArrival, TransitSource } from '../../core/contracts/index.js';
import type { KoLifeDeps } from './deps.js';
import { keyOf } from './deps.js';
import { fetchJson, parseShape } from './http.js';
import { KO_SECRETS } from './secrets.js';

const SUBWAY_URL = 'https://swopenapi.seoul.go.kr/api/subway';
const BUS_STATION_URL = 'https://ws.bus.go.kr/api/rest/stationinfo/getStationByName';
const BUS_ARRIVAL_URL = 'https://ws.bus.go.kr/api/rest/stationinfo/getStationByUid';
const MAX_ARRIVALS = 10;

const LINE_NAMES: Readonly<Record<string, string>> = {
  '1001': '1호선',
  '1002': '2호선',
  '1003': '3호선',
  '1004': '4호선',
  '1005': '5호선',
  '1006': '6호선',
  '1007': '7호선',
  '1008': '8호선',
  '1009': '9호선',
  '1063': '경의중앙선',
  '1065': '공항철도',
  '1067': '경춘선',
  '1075': '수인분당선',
  '1077': '신분당선',
  '1092': '우이신설선',
  '1032': 'GTX-A',
};

const SubwayResponse = z.object({
  realtimeArrivalList: z.array(z.unknown()).optional(),
  errorMessage: z.unknown().optional(),
});

const SubwayArrival = z.object({
  subwayId: z.string().optional(),
  trainLineNm: z.string().optional(),
  arvlMsg2: z.string().optional(),
  barvlDt: z.string().optional(),
});

const BusEnvelope = z.object({
  msgHeader: z.object({ headerCd: z.union([z.string(), z.number()]).optional() }).optional(),
  msgBody: z.object({ itemList: z.array(z.unknown()).optional() }).optional(),
});

const BusStation = z.object({
  arsId: z.union([z.string(), z.number()]).optional(),
  stNm: z.string().optional(),
});

const BusArrival = z.object({
  rtNm: z.string().optional(),
  adirection: z.string().optional(),
  arrmsg1: z.string().optional(),
  arrmsg2: z.string().optional(),
  stationNm: z.string().optional(),
});

const text = (value: string | number | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
};

function minutesFromText(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /(\d+)\s*분/.exec(value);
  if (match?.[1] === undefined) return undefined;
  return Number(match[1]);
}

function minutesFromSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed / 60) : undefined;
}

/** Seoul bus and subway only; other regions have no open real-time API yet. */
export class SeoulTransit implements TransitSource {
  constructor(private readonly deps: KoLifeDeps) {}

  async arrivals(query: { stop: string; kind: 'bus' | 'subway' }): Promise<TransitArrival[]> {
    return query.kind === 'subway' ? this.subway(query.stop) : this.bus(query.stop);
  }

  private async subway(stop: string): Promise<TransitArrival[]> {
    const key = await keyOf(this.deps, KO_SECRETS.seoulData);
    const station = stop.replace(/\s*역$/, '').trim();
    if (station === '') throw new Error('A station name is required.');
    const url = `${SUBWAY_URL}/${encodeURIComponent(key)}/json/realtimeStationArrival/0/${MAX_ARRIVALS}/${encodeURIComponent(station)}`;
    const body = parseShape(SubwayResponse, await fetchJson(this.deps.fetch, url), 'Seoul subway');
    if (body.realtimeArrivalList === undefined) {
      throw new Error('Seoul subway returned an unexpected response.');
    }
    const arrivals: TransitArrival[] = [];
    for (const raw of body.realtimeArrivalList) {
      const parsed = SubwayArrival.safeParse(raw);
      if (!parsed.success) continue;
      const line = text(parsed.data.subwayId);
      const message = text(parsed.data.arvlMsg2) ?? text(parsed.data.trainLineNm) ?? '';
      const minutes = minutesFromSeconds(text(parsed.data.barvlDt));
      arrivals.push({
        route: line === undefined ? '지하철' : (LINE_NAMES[line] ?? line),
        ...(minutes !== undefined ? { minutes } : {}),
        message,
        stop,
      });
    }
    return arrivals;
  }

  private async bus(stop: string): Promise<TransitArrival[]> {
    const key = await keyOf(this.deps, KO_SECRETS.dataGoKr);
    const stationParams = new URLSearchParams({
      serviceKey: key,
      stSrch: stop,
      resultType: 'json',
    });
    const stationBody = await this.busEnvelope(`${BUS_STATION_URL}?${stationParams}`);
    const station = stationBody.itemList
      .map((raw) => BusStation.safeParse(raw))
      .find((parsed) => parsed.success && text(parsed.data.arsId) !== undefined);
    if (station === undefined || !station.success) return [];
    const arsId = text(station.data.arsId);
    if (arsId === undefined) return [];

    const arrivalParams = new URLSearchParams({
      ServiceKey: key,
      arsId,
      resultType: 'json',
    });
    const arrivalBody = await this.busEnvelope(`${BUS_ARRIVAL_URL}?${arrivalParams}`);
    const arrivals: TransitArrival[] = [];
    for (const raw of arrivalBody.itemList) {
      const parsed = BusArrival.safeParse(raw);
      if (!parsed.success) continue;
      const route = text(parsed.data.rtNm) ?? text(parsed.data.adirection) ?? '버스';
      const message = text(parsed.data.arrmsg1) ?? '';
      const minutes = minutesFromText(message);
      arrivals.push({
        route,
        ...(minutes !== undefined ? { minutes } : {}),
        message,
        stop: text(parsed.data.stationNm) ?? stop,
      });
      if (arrivals.length >= MAX_ARRIVALS) break;
    }
    return arrivals;
  }

  private async busEnvelope(url: string): Promise<{ itemList: readonly unknown[] }> {
    const body = parseShape(BusEnvelope, await fetchJson(this.deps.fetch, url), 'Seoul bus');
    const code = body.msgHeader?.headerCd;
    if (code !== undefined && String(code) !== '0') {
      throw new Error('The Seoul bus service rejected the request.');
    }
    return { itemList: body.msgBody?.itemList ?? [] };
  }
}
