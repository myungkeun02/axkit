import { z } from 'zod';
import type { GeoPoint, RouteOption, RouteSource } from '../../core/contracts/index.js';
import type { KoLifeDeps } from './deps.js';
import { keyOf } from './deps.js';
import { fetchJson, parseShape } from './http.js';
import { KO_SECRETS } from './secrets.js';

/**
 * D7 directions. Car: Kakao Mobility (same REST key as Kakao Local). Transit: ODsay `searchPubTransPathT`. Only
 * coordinates are sent, never event titles. Lines are thinned to at most ~200 points for the app's map.
 */
const MAX_POINTS = 200;

/** Seoul subway line colours by ODsay subwayCode; buses get a generic colour. */
const SUBWAY_COLORS: Record<number, string> = {
  1: '#0052A4', 2: '#00A84D', 3: '#EF7C1C', 4: '#00A5DE', 5: '#996CAC', 6: '#CD7C2F', 7: '#747F00', 8: '#E6186C', 9: '#BDB092',
  101: '#0090D2', 104: '#77C4A3', 109: '#D4003B', 116: '#F5A200', 112: '#77C4A3',
};
const BUS_COLOR = '#3D5BAB';

export function thin(points: readonly [number, number][], max = MAX_POINTS): [number, number][] {
  if (points.length <= max) return [...points];
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)] as [number, number]);
}

const CarResponse = z.object({
  routes: z.array(
    z.object({
      result_code: z.number(),
      summary: z.object({ distance: z.number(), duration: z.number(), fare: z.object({ taxi: z.number().optional(), toll: z.number().optional() }).partial().optional() }).optional(),
      sections: z.array(z.object({ roads: z.array(z.object({ vertexes: z.array(z.number()) })).optional() })).optional(),
    }),
  ),
});

const SubPath = z.object({
  trafficType: z.number(),
  sectionTime: z.number().optional(),
  distance: z.number().optional(),
  startName: z.string().optional(),
  endName: z.string().optional(),
  startX: z.number().optional(),
  startY: z.number().optional(),
  endX: z.number().optional(),
  endY: z.number().optional(),
  lane: z.array(z.object({ name: z.string().optional(), busNo: z.string().optional(), subwayCode: z.number().optional() })).optional(),
});
const TransitResponse = z.object({
  result: z
    .object({
      path: z.array(z.object({ info: z.object({ totalTime: z.number(), payment: z.number().optional(), totalDistance: z.number().optional() }), subPath: z.array(SubPath) })),
    })
    .optional(),
});

export class KoRoutes implements RouteSource {
  constructor(private readonly deps: KoLifeDeps) {}

  async car(from: GeoPoint, to: GeoPoint): Promise<RouteOption | undefined> {
    const key = await keyOf(this.deps, KO_SECRETS.kakaoRest);
    const params = new URLSearchParams({ origin: `${from.lng},${from.lat}`, destination: `${to.lng},${to.lat}`, priority: 'RECOMMEND' });
    const body = parseShape(CarResponse, await fetchJson(this.deps.fetch, `https://apis-navi.kakaomobility.com/v1/directions?${params}`, { headers: { authorization: `KakaoAK ${key}` } }), 'Kakao Mobility');
    const route = body.routes[0];
    if (route === undefined || route.result_code !== 0 || route.summary === undefined) return undefined;
    const points: [number, number][] = [];
    for (const section of route.sections ?? []) {
      for (const road of section.roads ?? []) for (let i = 0; i + 1 < road.vertexes.length; i += 2) points.push([road.vertexes[i] as number, road.vertexes[i + 1] as number]);
    }
    const minutes = Math.max(1, Math.round(route.summary.duration / 60));
    const km = Math.round(route.summary.distance / 100) / 10;
    const toll = route.summary.fare?.toll;
    return {
      mode: 'car',
      durationMin: minutes,
      distanceKm: km,
      ...(toll !== undefined && toll > 0 ? { tollKrw: toll } : {}),
      summary: `자동차 ${minutes}분 · ${km}km`,
      steps: [{ mode: 'car', label: '자동차', durationMin: minutes }],
      path: thin(points),
    };
  }

  async transit(from: GeoPoint, to: GeoPoint): Promise<RouteOption | undefined> {
    const key = await keyOf(this.deps, KO_SECRETS.odsay);
    const params = new URLSearchParams({ lang: '0', SX: String(from.lng), SY: String(from.lat), EX: String(to.lng), EY: String(to.lat), apiKey: key });
    const body = parseShape(TransitResponse, await fetchJson(this.deps.fetch, `https://api.odsay.com/v1/api/searchPubTransPathT?${params}`), 'ODsay');
    const best = body.result?.path[0];
    if (best === undefined) return undefined;
    const steps: RouteOption['steps'] = [];
    const points: [number, number][] = [[from.lng, from.lat]];
    for (const sub of best.subPath) {
      const minutes = Math.round(sub.sectionTime ?? 0);
      const lane = sub.lane?.[0];
      if (sub.trafficType === 1) steps.push({ mode: 'subway', label: `${lane?.name ?? '지하철'} ${sub.startName ?? ''}→${sub.endName ?? ''}`.trim(), durationMin: minutes, ...(lane?.name !== undefined ? { line: lane.name } : {}), color: SUBWAY_COLORS[lane?.subwayCode ?? 0] ?? '#888888' });
      else if (sub.trafficType === 2) steps.push({ mode: 'bus', label: `${lane?.busNo ?? '버스'}번 ${sub.startName ?? ''}→${sub.endName ?? ''}`.trim(), durationMin: minutes, ...(lane?.busNo !== undefined ? { line: lane.busNo } : {}), color: BUS_COLOR });
      else if (minutes > 0) steps.push({ mode: 'walk', label: '걷기', durationMin: minutes });
      if (sub.startX !== undefined && sub.startY !== undefined) points.push([sub.startX, sub.startY]);
      if (sub.endX !== undefined && sub.endY !== undefined) points.push([sub.endX, sub.endY]);
    }
    points.push([to.lng, to.lat]);
    const rides = steps.filter((step) => step.mode !== 'walk').map((step) => step.line ?? step.label);
    return {
      mode: 'transit',
      durationMin: Math.round(best.info.totalTime),
      distanceKm: Math.round((best.info.totalDistance ?? 0) / 100) / 10,
      ...(best.info.payment !== undefined ? { fareKrw: best.info.payment } : {}),
      summary: rides.length > 0 ? `${rides.join(' → ')} · ${Math.round(best.info.totalTime)}분` : `걸어서 ${Math.round(best.info.totalTime)}분`,
      steps,
      path: thin(points),
    };
  }
}
