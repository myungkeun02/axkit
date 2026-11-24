import { z } from 'zod';
import type { GeoPoint, Place, PlaceSource } from '../../core/contracts/index.js';
import type { KoLifeDeps } from './deps.js';
import { keyOf } from './deps.js';
import { fetchJson, parseShape } from './http.js';
import { KO_SECRETS } from './secrets.js';

const BASE = 'https://dapi.kakao.com/v2/local';
const RADIUS_M = 2_000;
const MAX_SIZE = 15;

const coord = z.union([z.string(), z.number()]).transform((value) => String(value));

const KeywordDoc = z.object({
  place_name: z.string(),
  category_name: z.string().optional(),
  road_address_name: z.string().optional(),
  address_name: z.string().optional(),
  distance: z.union([z.string(), z.number()]).optional(),
  phone: z.string().optional(),
  place_url: z.string().optional(),
  x: coord,
  y: coord,
});

const KeywordResponse = z.object({ documents: z.array(z.unknown()) });

const AddressDoc = z.object({ address_name: z.string().optional(), x: coord, y: coord });

const AddressResponse = z.object({ documents: z.array(z.unknown()) });

const RegionResponse = z.object({
  documents: z.array(
    z.object({ region_type: z.string().optional(), address_name: z.string().optional() }),
  ),
});

function finite(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function categoryWords(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const words = raw
    .split('>')
    .map((word) => word.trim())
    .filter((word) => word !== '')
    .slice(-2);
  return words.length === 0 ? undefined : words.join(' > ');
}

function toPlace(doc: z.infer<typeof KeywordDoc>, center: GeoPoint | undefined): Place | undefined {
  const lat = finite(doc.y);
  const lng = finite(doc.x);
  if (lat === undefined || lng === undefined) return undefined;
  const address = doc.road_address_name || doc.address_name;
  const distance = doc.distance === undefined ? undefined : Number(doc.distance);
  const category = categoryWords(doc.category_name);
  return {
    name: doc.place_name,
    address: address ?? '',
    point: { lat, lng },
    ...(category !== undefined ? { category } : {}),
    ...(doc.phone !== undefined && doc.phone !== '' ? { phone: doc.phone } : {}),
    ...(doc.place_url !== undefined && doc.place_url !== '' ? { url: doc.place_url } : {}),
    ...(center !== undefined && distance !== undefined && Number.isFinite(distance)
      ? { distanceM: Math.round(distance) }
      : {}),
  };
}

/** Kakao Local: keyword search, address/keyword geocoding and coordinate → region name. */
export class KakaoPlaces implements PlaceSource {
  constructor(private readonly deps: KoLifeDeps) {}

  async search(query: string, opts: { near?: GeoPoint; limit: number }): Promise<Place[]> {
    const key = await keyOf(this.deps, KO_SECRETS.kakaoRest);
    const params = new URLSearchParams({
      query,
      size: String(Math.max(1, Math.min(MAX_SIZE, opts.limit))),
    });
    if (opts.near !== undefined) {
      params.set('x', String(opts.near.lng));
      params.set('y', String(opts.near.lat));
      params.set('radius', String(RADIUS_M));
      params.set('sort', 'distance');
    }
    const response = await fetchJson(this.deps.fetch, `${BASE}/search/keyword.json?${params}`, {
      headers: { Authorization: `KakaoAK ${key}` },
    });
    const body = parseShape(KeywordResponse, response, 'Kakao Local');
    const places: Place[] = [];
    for (const raw of body.documents) {
      const parsed = KeywordDoc.safeParse(raw);
      if (!parsed.success) continue;
      const place = toPlace(parsed.data, opts.near);
      if (place !== undefined) places.push(place);
    }
    return places;
  }

  async geocode(text: string): Promise<GeoPoint | undefined> {
    const key = await keyOf(this.deps, KO_SECRETS.kakaoRest);
    const address = await this.addressPoint(key, text).catch(() => undefined);
    if (address !== undefined) return address;
    const keyword = await this.search(text, { limit: 1 }).catch(() => []);
    return keyword[0]?.point;
  }

  /** Administrative region name for air quality ("서울특별시 중구 태평로1가"). */
  async regionOf(point: GeoPoint): Promise<string | undefined> {
    const key = await keyOf(this.deps, KO_SECRETS.kakaoRest);
    const params = new URLSearchParams({ x: String(point.lng), y: String(point.lat) });
    const response = await fetchJson(
      this.deps.fetch,
      `${BASE}/geo/coord2regioncode.json?${params}`,
      { headers: { Authorization: `KakaoAK ${key}` } },
    );
    const body = parseShape(RegionResponse, response, 'Kakao Local');
    const hit =
      body.documents.find((doc) => doc.region_type === 'H') ?? body.documents[0];
    const name = hit?.address_name?.trim();
    return name === undefined || name === '' ? undefined : name;
  }

  private async addressPoint(key: string, text: string): Promise<GeoPoint | undefined> {
    const params = new URLSearchParams({ query: text, size: '1' });
    const response = await fetchJson(
      this.deps.fetch,
      `${BASE}/search/address.json?${params}`,
      { headers: { Authorization: `KakaoAK ${key}` } },
    );
    const body = parseShape(AddressResponse, response, 'Kakao Local');
    const parsed = AddressDoc.safeParse(body.documents[0]);
    if (!parsed.success) return undefined;
    const lat = finite(parsed.data.y);
    const lng = finite(parsed.data.x);
    return lat === undefined || lng === undefined ? undefined : { lat, lng };
  }
}
