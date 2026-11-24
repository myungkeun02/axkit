import { describe, expect, it } from 'vitest';
import { MissingKeyError } from '../../../src/core/contracts/index.js';
import { KakaoPlaces } from '../../../src/connectors/ko-life/kakao.js';
import { KO_SECRETS } from '../../../src/connectors/ko-life/secrets.js';
import { fakeFetch, header, makeDeps } from './helpers.js';

const KAKAO = { [KO_SECRETS.kakaoRest]: 'test-rest-key' };

const DOC = {
  place_name: '예시 약국',
  category_name: '의료,건강 > 약국',
  road_address_name: '서울특별시 중구 예시로 1',
  address_name: '서울특별시 중구 예시동',
  distance: '140',
  phone: '02-000-0000',
  place_url: 'https://place.example.com/1',
  x: '126.9780',
  y: '37.5665',
};

function placesWith(handler: Parameters<typeof fakeFetch>[0], secrets: Record<string, string> = KAKAO) {
  const fake = fakeFetch(handler);
  return { places: new KakaoPlaces(makeDeps(fake.fetch, { secrets })), calls: fake.calls };
}

describe('KakaoPlaces.search', () => {
  it('sends the KakaoAK header and parses keyword documents', async () => {
    const { places, calls } = placesWith(() => ({ documents: [DOC] }));

    const found = await places.search('약국', { limit: 5 });

    expect(header(calls[0], 'authorization')).toBe('KakaoAK test-rest-key');
    expect(calls[0]?.url.pathname).toBe('/v2/local/search/keyword.json');
    expect(calls[0]?.url.searchParams.get('query')).toBe('약국');
    expect(calls[0]?.url.searchParams.get('size')).toBe('5');
    expect(calls[0]?.url.searchParams.get('x')).toBeNull();
    expect(found).toEqual([
      {
        name: '예시 약국',
        address: '서울특별시 중구 예시로 1',
        point: { lat: 37.5665, lng: 126.978 },
        category: '의료,건강 > 약국',
        phone: '02-000-0000',
        url: 'https://place.example.com/1',
      },
    ]);
  });

  it('asks for a distance-sorted search around a point', async () => {
    const { places, calls } = placesWith(() => ({ documents: [DOC] }));

    await places.search('약국', { near: { lat: 37.5, lng: 127 }, limit: 30 });

    const params = calls[0]?.url.searchParams;
    expect(params?.get('x')).toBe('127');
    expect(params?.get('y')).toBe('37.5');
    expect(params?.get('sort')).toBe('distance');
    expect(params?.get('radius')).toBe('2000');
    expect(params?.get('size')).toBe('15');
  });

  it('skips documents without usable coordinates', async () => {
    const { places } = placesWith(() => ({
      documents: [{ ...DOC, x: 'not-a-number', y: '37.5' }, DOC],
    }));

    const found = await places.search('약국', { limit: 5 });

    expect(found).toHaveLength(1);
  });

  it('throws MissingKeyError with the Korean guide when the key is absent', async () => {
    const { places } = placesWith(() => ({ documents: [] }), {});

    await expect(places.search('약국', { limit: 5 })).rejects.toBeInstanceOf(MissingKeyError);
    await expect(places.search('약국', { limit: 5 })).rejects.toMatchObject({
      secretName: KO_SECRETS.kakaoRest,
      guide: expect.stringContaining('ax-kit secret set ko.kakao.rest-key'),
    });
  });
});

describe('KakaoPlaces.geocode', () => {
  it('uses an address hit first', async () => {
    const { places, calls } = placesWith((url) => {
      expect(url.pathname).toContain('/search/address.json');
      return { documents: [{ address_name: '서울특별시 중구', x: '126.978', y: '37.5665' }] };
    });

    await expect(places.geocode('서울시청')).resolves.toEqual({ lat: 37.5665, lng: 126.978 });
    expect(calls).toHaveLength(1);
  });

  it('falls back to keyword search when the address call fails', async () => {
    const { places, calls } = placesWith((url) => {
      if (url.pathname.includes('address.json')) return new Response('nope', { status: 500 });
      return { documents: [DOC] };
    });

    await expect(places.geocode('예시 약국')).resolves.toEqual({ lat: 37.5665, lng: 126.978 });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      '/v2/local/search/address.json',
      '/v2/local/search/keyword.json',
    ]);
  });

  it('returns undefined when neither search finds a place', async () => {
    const { places } = placesWith(() => ({ documents: [] }));
    await expect(places.geocode('없는 곳')).resolves.toBeUndefined();
  });
});

describe('KakaoPlaces.regionOf', () => {
  it('prefers the administrative (H) region name', async () => {
    const { places, calls } = placesWith((url) => {
      expect(url.pathname).toBe('/v2/local/geo/coord2regioncode.json');
      expect(url.searchParams.get('x')).toBe('126.978');
      expect(url.searchParams.get('y')).toBe('37.5665');
      return {
        documents: [
          { region_type: 'B', address_name: '서울특별시 중구 태평로1가' },
          { region_type: 'H', address_name: '서울특별시 중구 명동' },
        ],
      };
    });

    await expect(places.regionOf({ lat: 37.5665, lng: 126.978 })).resolves.toBe(
      '서울특별시 중구 명동',
    );
    expect(calls).toHaveLength(1);
  });
});
