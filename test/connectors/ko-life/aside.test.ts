import { describe, expect, it } from 'vitest';
import { MissingKeyError } from '../../../src/core/contracts/index.js';
import type { PlaceSource } from '../../../src/core/contracts/index.js';
import type { WebAgent, WebRunInput } from '../../../src/core/contracts/web-agent.js';
import { AsideParcel, AsidePlaces, AsidePrices, keyOrWeb } from '../../../src/connectors/ko-life/aside.js';

function agent(answers: string[]): { web: WebAgent; tasks: WebRunInput[] } {
  const tasks: WebRunInput[] = [];
  return { tasks, web: { label: 'fake', run: async (input) => (tasks.push(input), { ok: true, answer: answers.shift() ?? '{}' }) } };
}

describe('Aside in place of missing keys', () => {
  it('finds places near a point on Naver Map, look only', async () => {
    const { web, tasks } = agent(['결과: {"places":[{"name":"김밥천국","address":"서울 강남구","category":"분식","lat":37.5,"lng":127.03,"distanceM":"120"}]}']);
    const places = new AsidePlaces(() => web, () => 0);
    expect(await places.search('음식점', { near: { lat: 37.5, lng: 127.03 }, limit: 4 })).toEqual([{ name: '김밥천국', address: '서울 강남구', category: '분식', point: { lat: 37.5, lng: 127.03 }, distanceM: 120 }]);
    expect(tasks[0]).toMatchObject({ mode: 'look', site: 'map.naver.com' });
  });

  it('remembers a geocode miss for a day', async () => {
    const { web, tasks } = agent(['{}']);
    const places = new AsidePlaces(() => web, () => 0);
    expect(await places.geocode('어딘가')).toBeUndefined();
    expect(await places.geocode('어딘가')).toBeUndefined();
    expect(tasks).toHaveLength(1);
  });

  it('tracks a parcel and lists the lowest prices', async () => {
    const { web } = agent(['{"state":"배송중","delivered":false,"lastEvent":{"at":"2026-11-25 09:10","where":"강남","what":"배송 출발"}}', '{"offers":[{"title":"무선 이어폰","priceKrw":"39,900","mall":"A몰","url":"https://shop.example/1"},{"title":"가짜","priceKrw":1,"mall":"B","url":"javascript:x"}]}']);
    expect(await new AsideParcel(() => web).track('cj', '1234-5678')).toMatchObject({ carrier: 'CJ대한통운', state: '배송중', delivered: false, lastEvent: { what: '배송 출발' } });
    expect(await new AsidePrices(() => web).lowest('무선 이어폰', 5)).toEqual([{ title: '무선 이어폰', priceKrw: 39900, mall: 'A몰', url: 'https://shop.example/1' }]);
  });

  it('uses the key service first and Aside only when the key is missing', async () => {
    const { web } = agent(['{"lat":37.1,"lng":127.1}']);
    const withKey: PlaceSource = { search: async () => [], geocode: async () => ({ lat: 1, lng: 2 }) };
    const noKey: PlaceSource = { search: async () => [], geocode: async () => { throw new MissingKeyError('ko.kakao.rest-key', 'guide'); } };
    const aside = new AsidePlaces(() => web, () => 0);
    expect(await keyOrWeb(withKey, aside, () => web).geocode('x')).toEqual({ lat: 1, lng: 2 });
    expect(await keyOrWeb(noKey, aside, () => web).geocode('x')).toEqual({ lat: 37.1, lng: 127.1 });
    await expect(keyOrWeb(noKey, aside, () => undefined).geocode('y')).rejects.toBeInstanceOf(MissingKeyError);
  });
});
