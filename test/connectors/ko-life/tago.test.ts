import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { FakeClock } from '../../core/helpers.js';
import { koLifeConnector } from '../../../src/connectors/ko-life/plugin.js';
import { KO_SECRETS } from '../../../src/connectors/ko-life/secrets.js';
import { isSeoulTransitCity, TagoBusArrivals } from '../../../src/connectors/ko-life/tago.js';
import type { TagoCityConfig } from '../../../src/connectors/ko-life/tago.js';
import { createTestContext } from '../../support/context.js';
import { envelope, fakeFetch, makeDeps } from './helpers.js';
import type { Route } from './helpers.js';

const DAY_MS = 86_400_000;

const CITY_LIST = envelope([
  { citycode: '25', cityname: '대전광역시' },
  { citycode: '26', cityname: '부산광역시' },
]);
const STOPS = envelope([{ nodeid: 'DB1', nodenm: '대전역', nodeno: '12' }]);
const ARRIVALS = envelope([
  { routeno: 102, arrtime: 190, arrprevstationcnt: 2, nodenm: '대전역' },
  { routeno: '701', arrtime: 60, arrprevstationcnt: 1, nodenm: '대전역' },
]);

function dataGoKrRoute(url: URL): unknown {
  if (url.pathname.endsWith('/getCtyCodeList')) return CITY_LIST;
  if (url.pathname.endsWith('/getSttnNoList')) return STOPS;
  if (url.pathname.endsWith('/getSttnAcctoArvlPrearngeInfoList')) return ARRIVALS;
  throw new Error(`unexpected URL ${url.pathname}`);
}

function tagoWith(route: Route, city: TagoCityConfig, clock = new FakeClock(new Date('2026-11-17T09:00:00+09:00'))) {
  const fake = fakeFetch(route);
  const deps = makeDeps(fake.fetch, { secrets: { [KO_SECRETS.dataGoKr]: 'data-key' }, clock });
  return { tago: new TagoBusArrivals(deps, city), calls: fake.calls, clock };
}

function count(fake: { calls: { url: URL }[] }, suffix: string): number {
  return fake.calls.filter((call) => call.url.pathname.endsWith(suffix)).length;
}

describe('TagoBusArrivals city resolution', () => {
  it('resolves a city name, caches the list and reads arrivals', async () => {
    const harness = tagoWith(dataGoKrRoute, { city: '대전' });

    const arrivals = await harness.tago.arrivals('대전역');

    expect(arrivals).toEqual([
      { route: '102', minutes: 3, message: '3분 후 (2정거장 전)', stop: '대전역' },
      { route: '701', minutes: 1, message: '1분 후 (1정거장 전)', stop: '대전역' },
    ]);
    expect(count(harness, '/getCtyCodeList')).toBe(1);
    expect(harness.calls[1]?.url.searchParams.get('cityCode')).toBe('25');
    expect(harness.calls[1]?.url.searchParams.get('nodeNm')).toBe('대전역');
    expect(harness.calls[1]?.url.searchParams.get('serviceKey')).toBe('data-key');

    await harness.tago.arrivals('대전역');
    expect(count(harness, '/getCtyCodeList')).toBe(1);
  });

  it('refreshes the city list after seven days', async () => {
    const harness = tagoWith(dataGoKrRoute, { city: '대전' });
    await harness.tago.arrivals('대전역');

    await harness.clock.advance(8 * DAY_MS);
    await harness.tago.arrivals('대전역');

    expect(count(harness, '/getCtyCodeList')).toBe(2);
  });

  it('uses a numeric city code without asking for the city list', async () => {
    const harness = tagoWith(dataGoKrRoute, { cityCode: 25 });

    await harness.tago.arrivals('대전역');

    expect(count(harness, '/getCtyCodeList')).toBe(0);
    expect(harness.calls[0]?.url.searchParams.get('cityCode')).toBe('25');
  });

  it('reports an unknown city by name without a URL', async () => {
    const harness = tagoWith(dataGoKrRoute, { city: '없는도시' });

    const error = await harness.tago.arrivals('대전역').catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('없는도시');
    expect(String(error)).not.toContain('serviceKey');
    expect(String(error)).not.toContain('apis.data.go.kr');
  });
});

describe('TagoBusArrivals rows', () => {
  function singleRoutes(items: { stops: unknown; arrivals: unknown }): Route {
    return (url) => {
      if (url.pathname.endsWith('/getSttnNoList')) {
        return { response: { header: { resultCode: '00' }, body: { items: items.stops } } };
      }
      return { response: { header: { resultCode: '00' }, body: { items: items.arrivals } } };
    };
  }

  it('accepts single row objects instead of arrays', async () => {
    const harness = tagoWith(
      singleRoutes({
        stops: { item: { nodeid: 'DB1', nodenm: '대전역' } },
        arrivals: { item: { routeno: 102, arrtime: 120, arrprevstationcnt: 0, nodenm: '대전역' } },
      }),
      { cityCode: 25 },
    );

    await expect(harness.tago.arrivals('대전역')).resolves.toEqual([
      { route: '102', minutes: 2, message: '2분 후 (0정거장 전)', stop: '대전역' },
    ]);
  });

  it('treats empty items as no arrivals', async () => {
    const harness = tagoWith(
      singleRoutes({ stops: '', arrivals: '' }),
      { cityCode: 25 },
    );

    await expect(harness.tago.arrivals('대전역')).resolves.toEqual([]);
    expect(count(harness, '/getSttnNoList')).toBe(1);
  });

  it('returns nothing when the stop name does not match', async () => {
    const harness = tagoWith(
      singleRoutes({ stops: { item: [{ nodeid: 'DB1', nodenm: '대전역' }] }, arrivals: '' }),
      { cityCode: 25 },
    );

    await expect(harness.tago.arrivals('서대전역')).resolves.toEqual([]);
    expect(count(harness, '/getSttnAcctoArvlPrearngeInfoList')).toBe(0);
  });

  it('rejects a non-zero result code without leaking the URL', async () => {
    const harness = tagoWith(
      () => ({ response: { header: { resultCode: '30', resultMsg: 'bad key' }, body: { items: '' } } }),
      { cityCode: 25 },
    );

    await expect(harness.tago.arrivals('대전역')).rejects.toThrow('TAGO stops rejected the request.');
  });
});

describe('composite transit routing', () => {
  function fullRoute(url: URL): unknown {
    if (url.hostname === 'apis.data.go.kr') return dataGoKrRoute(url);
    if (url.pathname.includes('/realtimeStationArrival')) {
      return { realtimeArrivalList: [{ subwayId: '1002', arvlMsg2: '3번째 전', barvlDt: '180' }] };
    }
    if (url.pathname.endsWith('/getStationByName')) {
      return { msgHeader: { headerCd: '0' }, msgBody: { itemList: [{ arsId: '12345', stNm: '시청앞' }] } };
    }
    if (url.pathname.endsWith('/getStationByUid')) {
      return {
        msgHeader: { headerCd: '0' },
        msgBody: { itemList: [{ rtNm: '402', arrmsg1: '3분후[2번째 전]', stationNm: '시청앞' }] },
      };
    }
    throw new Error(`unexpected URL ${url.pathname}`);
  }

  async function connector(config: Record<string, unknown>) {
    const fake = fakeFetch(fullRoute);
    const context = createTestContext({ config, now: new Date('2026-11-17T09:00:00+09:00') });
    await context.secrets.set(KO_SECRETS.dataGoKr, 'data-key');
    await context.secrets.set(KO_SECRETS.seoulData, 'seoul-key');
    await koLifeConnector({ fetch: fake.fetch }).setup(context.ctx);
    return { transit: context.ctx.use(Contracts.transit), calls: fake.calls };
  }

  it('sends buses outside Seoul to TAGO while keeping the Seoul subway', async () => {
    const { transit, calls } = await connector({ transitCity: '대전' });

    const buses = await transit.arrivals({ stop: '대전역', kind: 'bus' });
    const subway = await transit.arrivals({ stop: '시청', kind: 'subway' });

    expect(buses[0]).toMatchObject({ route: '102', minutes: 3 });
    expect(subway[0]).toMatchObject({ route: '2호선', minutes: 3 });
    expect(calls.some((call) => call.url.hostname === 'apis.data.go.kr')).toBe(true);
    expect(calls.some((call) => call.url.hostname === 'swopenapi.seoul.go.kr')).toBe(true);
  });

  it('sends Seoul buses to the Seoul API', async () => {
    const { transit, calls } = await connector({ transitCity: '서울특별시' });

    const buses = await transit.arrivals({ stop: '시청앞', kind: 'bus' });

    expect(buses[0]).toMatchObject({ route: '402', minutes: 3 });
    expect(calls.some((call) => call.url.hostname === 'ws.bus.go.kr')).toBe(true);
    expect(calls.some((call) => call.url.hostname === 'apis.data.go.kr')).toBe(false);
  });

  it('treats Seoul names and code 11 as Seoul', () => {
    expect(isSeoulTransitCity({ city: '서울' })).toBe(true);
    expect(isSeoulTransitCity({ city: 'Seoul' })).toBe(true);
    expect(isSeoulTransitCity({ cityCode: 11 })).toBe(true);
    expect(isSeoulTransitCity({ city: '부산' })).toBe(false);
    expect(isSeoulTransitCity({ cityCode: 26 })).toBe(false);
  });
});
