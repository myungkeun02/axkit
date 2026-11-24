import { describe, expect, it } from 'vitest';
import { MissingKeyError } from '../../../src/core/contracts/index.js';
import { KO_SECRETS } from '../../../src/connectors/ko-life/secrets.js';
import { SeoulTransit } from '../../../src/connectors/ko-life/seoul-transit.js';
import { fakeFetch, makeDeps } from './helpers.js';

function transitWith(
  handler: Parameters<typeof fakeFetch>[0],
  secrets: Record<string, string> = {
    [KO_SECRETS.seoulData]: 'seoul-key',
    [KO_SECRETS.dataGoKr]: 'data-key',
  },
) {
  const fake = fakeFetch(handler);
  return { transit: new SeoulTransit(makeDeps(fake.fetch, { secrets })), calls: fake.calls };
}

describe('SeoulTransit subway', () => {
  it('parses real-time arrivals and converts seconds to minutes', async () => {
    const { transit, calls } = transitWith(() => ({
      realtimeArrivalList: [
        {
          subwayId: '1002',
          trainLineNm: '성수행 - 성수방면',
          arvlMsg2: '성수행 - 성수방면 3번째 전',
          barvlDt: '180',
        },
        { subwayId: '1002', arvlMsg2: '전역 출발', barvlDt: '0' },
        { subwayId: '1009', arvlMsg2: '', barvlDt: '' },
      ],
    }));

    const arrivals = await transit.arrivals({ stop: '시청역', kind: 'subway' });

    expect(decodeURIComponent(calls[0]?.url.pathname ?? '')).toContain(
      '/realtimeStationArrival/0/10/시청',
    );
    expect(arrivals).toEqual([
      {
        route: '2호선',
        minutes: 3,
        message: '성수행 - 성수방면 3번째 전',
        stop: '시청역',
      },
      { route: '2호선', minutes: 0, message: '전역 출발', stop: '시청역' },
      { route: '9호선', message: '', stop: '시청역' },
    ]);
  });

  it('throws MissingKeyError for the Seoul data key', async () => {
    const { transit } = transitWith(() => ({ realtimeArrivalList: [] }), {});

    await expect(transit.arrivals({ stop: '시청', kind: 'subway' })).rejects.toBeInstanceOf(
      MissingKeyError,
    );
    await expect(transit.arrivals({ stop: '시청', kind: 'subway' })).rejects.toMatchObject({
      secretName: KO_SECRETS.seoulData,
    });
  });

  it('rejects a response with no arrival list', async () => {
    const { transit } = transitWith(() => ({ errorMessage: { code: 'INFO-200' } }));
    await expect(transit.arrivals({ stop: '시청', kind: 'subway' })).rejects.toThrow(
      'Seoul subway returned an unexpected response.',
    );
  });
});

describe('SeoulTransit bus', () => {
  function busHandler(seen: URL[]): (url: URL) => unknown {
    return (url) => {
      seen.push(url);
      if (url.pathname.endsWith('/getStationByName')) {
        return {
          msgHeader: { headerCd: '0' },
          msgBody: { itemList: [{ stId: '123', arsId: '23456', stNm: '시청앞' }] },
        };
      }
      return {
        msgHeader: { headerCd: '0' },
        msgBody: {
          itemList: [
            {
              rtNm: '간선 402',
              adirection: '양재역',
              arrmsg1: '3분후[2번째 전]',
              arrmsg2: '12분후[4번째 전]',
              stationNm: '시청앞',
            },
          ],
        },
      };
    };
  }

  it('resolves a station name to arsId and reads the first bus', async () => {
    const seen: URL[] = [];
    const { transit } = transitWith(busHandler(seen));

    const arrivals = await transit.arrivals({ stop: '시청앞', kind: 'bus' });

    expect(seen[0]?.searchParams.get('stSrch')).toBe('시청앞');
    expect(seen[0]?.searchParams.get('serviceKey')).toBe('data-key');
    expect(seen[1]?.searchParams.get('arsId')).toBe('23456');
    expect(seen[1]?.searchParams.get('ServiceKey')).toBe('data-key');
    expect(arrivals).toEqual([
      { route: '간선 402', minutes: 3, message: '3분후[2번째 전]', stop: '시청앞' },
    ]);
  });

  it('returns an empty list when no station matches', async () => {
    const { transit } = transitWith(() => ({
      msgHeader: { headerCd: '0' },
      msgBody: { itemList: [] },
    }));

    await expect(transit.arrivals({ stop: '없는 정류장', kind: 'bus' })).resolves.toEqual([]);
  });

  it('throws MissingKeyError for the data.go.kr key', async () => {
    const { transit } = transitWith(() => ({}), {});

    await expect(transit.arrivals({ stop: '시청앞', kind: 'bus' })).rejects.toMatchObject({
      secretName: KO_SECRETS.dataGoKr,
    });
  });
});
