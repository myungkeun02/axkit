import type { GeoPoint, ParcelStatus, ParcelTracker, Place, PlaceSource, PriceOffer, PriceSearch } from '../../core/contracts/index.js';
import { MissingKeyError } from '../../core/contracts/index.js';
import type { WebAgent } from '../../core/contracts/web-agent.js';

/**
 * The same services read from the web through the owner's browser agent (Aside), for when the owner has not added
 * the service's key: Naver Map for places, a carrier's tracking page for parcels, Naver Shopping for prices. Look
 * only, never a sign-in or a form. Slower than the APIs (a run takes tens of seconds), so answers are cached.
 */
type Agent = () => WebAgent | undefined;

const TIMEOUT_MIN = 3;
const GEO_TTL_MS = 24 * 3_600_000;

function jsonIn(answer: string): unknown {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(answer.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

// eslint-disable-next-line no-control-regex -- page text: control characters are stripped
const str = (value: unknown, max = 120): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.replace(/[\u0000-\u001f<>`]/g, ' ').trim().slice(0, max) : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.replace(/[,원\s]/g, ''))) ? Number(value.replace(/[,원\s]/g, '')) : undefined);

async function look(agent: Agent, task: string, site?: string): Promise<Record<string, unknown> | undefined> {
  const web = agent();
  if (web === undefined) return undefined;
  const result = await web.run({ task, mode: 'look', timeoutMinutes: TIMEOUT_MIN, ...(site !== undefined ? { site } : {}) }).catch(() => undefined);
  return result?.ok === true ? record(jsonIn(result.answer)) : undefined;
}

function near(point: GeoPoint | undefined): string {
  return point === undefined ? '' : ` (위도 ${point.lat.toFixed(5)}, 경도 ${point.lng.toFixed(5)} 근처)`;
}

export class AsidePlaces implements PlaceSource {
  private readonly points = new Map<string, { at: number; point: GeoPoint | undefined }>();

  constructor(private readonly agent: Agent, private readonly now: () => number) {}

  async search(query: string, opts: { near?: GeoPoint; limit: number }): Promise<Place[]> {
    const limit = Math.min(Math.max(opts.limit, 1), 10);
    const data = await look(
      this.agent,
      `네이버 지도에서 "${query.slice(0, 60)}"을(를)${near(opts.near)} 검색해 읽기만 해 줘(로그인·제출 없이). 가까운 순으로 ${String(limit)}곳. ` +
        '답은 JSON 하나만: {"places":[{"name":이름,"address":주소,"category":분류,"lat":위도,"lng":경도,"distanceM":거리미터}]}. 못 찾으면 {"places":[]}.',
      'map.naver.com',
    );
    const list = Array.isArray(data?.places) ? data.places : [];
    return list.slice(0, limit).flatMap((item): Place[] => {
      const row = record(item);
      const name = str(row?.name, 60);
      const lat = num(row?.lat);
      const lng = num(row?.lng);
      if (row === undefined || name === undefined) return [];
      const distance = num(row.distanceM);
      const category = str(row.category, 60);
      return [{ name, address: str(row.address, 120) ?? '', point: { lat: lat ?? opts.near?.lat ?? 0, lng: lng ?? opts.near?.lng ?? 0 }, ...(category !== undefined ? { category } : {}), ...(distance !== undefined ? { distanceM: distance } : {}) }];
    });
  }

  /** A place's coordinates; a miss is remembered for a day too, so a sweep does not ask again every few minutes. */
  async geocode(text: string): Promise<GeoPoint | undefined> {
    const key = text.trim().toLowerCase();
    const cached = this.points.get(key);
    if (cached !== undefined && this.now() - cached.at < GEO_TTL_MS) return cached.point;
    const data = await look(this.agent, `네이버 지도에서 "${text.slice(0, 80)}"을(를) 찾아 위치를 읽기만 해 줘. 답은 JSON 하나만: {"lat":위도,"lng":경도}. 못 찾으면 {}.`, 'map.naver.com');
    const lat = num(data?.lat);
    const lng = num(data?.lng);
    const point = lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined;
    this.points.set(key, { at: this.now(), point });
    return point;
  }
}

const CARRIERS = [
  { code: 'cj', name: 'CJ대한통운' },
  { code: 'post', name: '우체국택배' },
  { code: 'hanjin', name: '한진택배' },
  { code: 'lotte', name: '롯데택배' },
  { code: 'logen', name: '로젠택배' },
  { code: 'coupang', name: '쿠팡 로켓배송' },
  { code: 'cvs', name: 'CU 편의점택배' },
  { code: 'gs', name: 'GS Postbox 택배' },
  { code: 'kyungdong', name: '경동택배' },
  { code: 'daesin', name: '대신택배' },
];

export class AsideParcel implements ParcelTracker {
  constructor(private readonly agent: Agent) {}

  async carriers(): Promise<{ code: string; name: string }[]> {
    return CARRIERS;
  }

  async track(carrierCode: string, invoice: string): Promise<ParcelStatus> {
    const carrier = CARRIERS.find((item) => item.code === carrierCode)?.name ?? carrierCode;
    const digits = invoice.replace(/[^\dA-Za-z-]/g, '').slice(0, 30);
    const data = await look(
      this.agent,
      `${carrier} 배송 조회 페이지(안 되면 네이버 "택배 조회")에서 운송장 ${digits}을(를) 조회해 읽기만 해 줘. ` +
        '답은 JSON 하나만: {"state":지금 상태,"delivered":배송완료면 true,"lastEvent":{"at":"YYYY-MM-DD HH:MM","where":장소,"what":내용}}. 못 찾으면 {}.',
    );
    const state = str(data?.state, 40);
    if (data === undefined || state === undefined) throw new Error(`${carrier} 운송장 ${digits}을(를) 찾지 못했어요.`);
    const last = record(data.lastEvent);
    const at = str(last?.at, 30);
    const where = str(last?.where, 60);
    const what = str(last?.what, 80);
    return {
      carrier,
      invoice: digits,
      state,
      delivered: data.delivered === true,
      ...(at !== undefined && what !== undefined ? { lastEvent: { at, where: where ?? '', what } } : {}),
    };
  }
}

export class AsidePrices implements PriceSearch {
  constructor(private readonly agent: Agent) {}

  async lowest(query: string, limit: number): Promise<PriceOffer[]> {
    const count = Math.min(Math.max(limit, 1), 10);
    const data = await look(
      this.agent,
      `네이버 쇼핑에서 "${query.slice(0, 60)}"을(를) 낮은 가격순으로 찾아 읽기만 해 줘(로그인·구매 없이). 상위 ${String(count)}개. ` +
        '답은 JSON 하나만: {"offers":[{"title":상품명,"priceKrw":가격(숫자),"mall":판매처,"url":주소}]}. 못 찾으면 {"offers":[]}.',
      'shopping.naver.com',
    );
    const list = Array.isArray(data?.offers) ? data.offers : [];
    return list.slice(0, count).flatMap((item): PriceOffer[] => {
      const row = record(item);
      const title = str(row?.title, 100);
      const price = num(row?.priceKrw);
      const url = str(row?.url, 400);
      if (title === undefined || price === undefined || url === undefined || !url.startsWith('https://')) return [];
      return [{ title, priceKrw: Math.round(price), mall: str(row?.mall, 40) ?? '', url }];
    });
  }
}

/** The key's service first; with no key, the browser agent (when there is one). */
export function keyOrWeb<T extends object>(primary: T, web: T, agent: Agent): T {
  return new Proxy(primary, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver) as unknown;
      if (typeof original !== 'function') return original;
      const fallback = Reflect.get(web, prop) as unknown;
      return async (...args: unknown[]) => {
        try {
          return await (original as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } catch (error) {
          if (!(error instanceof MissingKeyError) || agent() === undefined || typeof fallback !== 'function') throw error;
          return (fallback as (...a: unknown[]) => Promise<unknown>).apply(web, args);
        }
      };
    },
  });
}
