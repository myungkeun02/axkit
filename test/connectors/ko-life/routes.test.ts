import { describe, expect, it } from 'vitest';
import { KoRoutes, thin } from '../../../src/connectors/ko-life/routes.js';
import { fakeFetch, header, makeDeps } from './helpers.js';

const A = { lat: 37.55, lng: 126.92 };
const B = { lat: 37.5, lng: 127.03 };

describe('Kakao car and ODsay transit routes (D7)', () => {
  it('reads car time, distance, toll and the road line', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      routes: [{ result_code: 0, summary: { distance: 12_340, duration: 1_860, fare: { taxi: 15_000, toll: 1_200 } }, sections: [{ roads: [{ vertexes: [126.92, 37.55, 127, 37.52, 127.03, 37.5] }] }] }],
    }));
    const car = await new KoRoutes(makeDeps(fetch, { secrets: { 'ko.kakao.rest-key': 'k' } })).car(A, B);
    expect(car).toMatchObject({ mode: 'car', durationMin: 31, distanceKm: 12.3, tollKrw: 1200, path: [[126.92, 37.55], [127, 37.52], [127.03, 37.5]] });
    expect(header(calls[0], 'authorization')).toBe('KakaoAK k');
    expect(calls[0]?.url.searchParams.get('origin')).toBe('126.92,37.55');
  });

  it('reads transit steps with line colours, fare and stops', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      result: {
        path: [{
          info: { totalTime: 38, payment: 1400, totalDistance: 11_000 },
          subPath: [
            { trafficType: 3, sectionTime: 5 },
            { trafficType: 1, sectionTime: 25, startName: '홍대입구', endName: '강남', lane: [{ name: '수도권 2호선', subwayCode: 2 }], startX: 126.92, startY: 37.55, endX: 127.02, endY: 37.49 },
            { trafficType: 3, sectionTime: 8 },
          ],
        }],
      },
    }));
    const transit = await new KoRoutes(makeDeps(fetch, { secrets: { 'ko.odsay.key': 'o' } })).transit(A, B);
    expect(transit).toMatchObject({ mode: 'transit', durationMin: 38, fareKrw: 1400, distanceKm: 11 });
    expect(transit?.steps.map((s) => s.mode)).toEqual(['walk', 'subway', 'walk']);
    expect(transit?.steps[1]).toMatchObject({ color: '#00A84D', line: '수도권 2호선' });
    expect(transit?.summary).toContain('수도권 2호선');
    expect(calls[0]?.url.searchParams.get('apiKey')).toBe('o');
  });

  it('asks for a key with plain steps when it is missing, and thins long lines', async () => {
    const { fetch } = fakeFetch(() => ({}));
    await expect(new KoRoutes(makeDeps(fetch)).transit(A, B)).rejects.toThrow();
    expect(thin(Array.from({ length: 1000 }, (_, i) => [i, i] as [number, number]))).toHaveLength(200);
  });
});
