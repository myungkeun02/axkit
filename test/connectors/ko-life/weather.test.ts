import { describe, expect, it } from 'vitest';

import { KmaWeather } from '../../../src/connectors/ko-life/kma.js';
import { KO_SECRETS } from '../../../src/connectors/ko-life/secrets.js';
import { envelope, fakeFetch, makeDeps, NOW } from './helpers.js';

const SEOUL = { lat: 37.5665, lng: 126.978 };

function forecastItems(overrides: Record<string, string> = {}): unknown[] {
  const value = (category: string, fallback: string): string => overrides[category] ?? fallback;
  return [
    { category: 'TMP', fcstDate: '20261117', fcstTime: '0900', fcstValue: '11' },
    { category: 'TMP', fcstDate: '20261117', fcstTime: '1200', fcstValue: '14' },
    { category: 'TMX', fcstDate: '20261117', fcstTime: '1500', fcstValue: '15' },
    { category: 'TMN', fcstDate: '20261117', fcstTime: '0600', fcstValue: '4' },
    { category: 'SKY', fcstDate: '20261117', fcstTime: '0900', fcstValue: value('SKY', '1') },
    { category: 'PTY', fcstDate: '20261117', fcstTime: '0900', fcstValue: value('PTY', '0') },
    { category: 'POP', fcstDate: '20261117', fcstTime: '1200', fcstValue: '10' },
    { category: 'POP', fcstDate: '20261117', fcstTime: '1500', fcstValue: '30' },
  ];
}

const ULTRA_ENVELOPE = envelope([{ category: 'T1H', obsrValue: '12', baseDate: '20261117' }]);
const AIR_ENVELOPE = {
  response: {
    header: { resultCode: '00' },
    body: {
      items: [
        { pm10Value: '25', pm25Value: '12' },
        { pm10Value: '35', pm25Value: '18' },
        { pm10Value: '-', pm25Value: '-' },
      ],
    },
  },
};

interface Options {
  forecast?: unknown;
  ultra?: unknown;
  air?: unknown;
  secrets?: Record<string, string>;
  sido?: string | undefined;
  region?: () => Promise<string | undefined>;
}

function weatherWith(opts: Options = {}) {
  const secrets = opts.secrets ?? { [KO_SECRETS.dataGoKr]: 'data-key' };
  const fake = fakeFetch((url) => {
    if (url.href.includes('getVilageFcst')) return opts.forecast ?? envelope(forecastItems());
    if (url.href.includes('getUltraSrtNcst')) return opts.ultra ?? ULTRA_ENVELOPE;
    if (url.href.includes('getCtprvnRltmMesureDnsty')) return opts.air ?? AIR_ENVELOPE;
    return new Response('unexpected', { status: 404 });
  });
  const deps = makeDeps(fake.fetch, { secrets });
  const kakao = {
    regionOf: opts.region ?? (async () => '서울특별시 중구 명동'),
  };
  return { weather: new KmaWeather(deps, kakao, opts.sido), calls: fake.calls, deps };
}

describe('KmaWeather.today', () => {
  it('combines the forecast, the current observation and air quality', async () => {
    const { weather, calls } = weatherWith();

    const report = await weather.today(SEOUL);

    expect(report).toEqual({
      sky: '맑음',
      tempC: 12,
      minC: 4,
      maxC: 15,
      rainChance: 30,
      air: { grade: '좋음', pm10: 30, pm25: 15 },
      observedAt: NOW,
    });
    const forecastCall = calls.find((call) => call.url.href.includes('getVilageFcst'));
    expect(forecastCall?.url.searchParams.get('base_time')).toBe('0800');
    expect(forecastCall?.url.searchParams.get('base_date')).toBe('20261117');
    expect(forecastCall?.url.searchParams.get('nx')).toBe('60');
    expect(forecastCall?.url.searchParams.get('ny')).toBe('127');
    expect(forecastCall?.url.searchParams.get('dataType')).toBe('JSON');
    const ultraCall = calls.find((call) => call.url.href.includes('getUltraSrtNcst'));
    expect(ultraCall?.url.searchParams.get('base_time')).toBe('0800');
  });

  it('prefers precipitation words over the sky code', async () => {
    const { weather } = weatherWith({
      forecast: envelope(forecastItems({ PTY: '1', SKY: '1' })),
    });

    await expect(weather.today(SEOUL)).resolves.toMatchObject({ sky: '비' });
  });

  it('falls back to the forecast temperature when the observation fails', async () => {
    const { weather } = weatherWith({
      ultra: () => new Response('down', { status: 503 }),
    });

    await expect(weather.today(SEOUL)).resolves.toMatchObject({ tempC: 11 });
  });

  it('keeps the weather when air quality fails', async () => {
    const { weather } = weatherWith({ air: () => new Response('down', { status: 500 }) });

    const report = await weather.today(SEOUL);

    expect(report.sky).toBe('맑음');
    expect(report.air).toBeUndefined();
  });

  it('uses the configured sido without asking Kakao for a region', async () => {
    let called = false;
    const { weather } = weatherWith({
      sido: '서울',
      region: async () => {
        called = true;
        return '서울특별시 중구';
      },
    });

    const report = await weather.today(SEOUL);

    expect(called).toBe(false);
    expect(report.air).toEqual({ grade: '좋음', pm10: 30, pm25: 15 });
  });

  it('drops air quality when no Korean region can be resolved', async () => {
    const { weather } = weatherWith({ region: async () => undefined });

    const report = await weather.today(SEOUL);

    expect(report.sky).toBe('맑음');
    expect(report.air).toBeUndefined();
  });

  it('without the data.go.kr key, answers from the keyless Open-Meteo', async () => {
    const fake = fakeFetch((url) =>
      url.href.startsWith('https://api.open-meteo.com/')
        ? Response.json({ current: { temperature_2m: 7.6, weather_code: 3 }, daily: { time: ['2026-11-17'], weather_code: [3], temperature_2m_max: [11.2], temperature_2m_min: [2.4], precipitation_probability_max: [20] } })
        : new Response('unexpected', { status: 404 }),
    );
    const weather = new KmaWeather(makeDeps(fake.fetch, { secrets: {} }), { regionOf: async () => '서울특별시' }, undefined);
    expect(await weather.today(SEOUL)).toMatchObject({ sky: '흐림', tempC: 8, minC: 2, maxC: 11, rainChance: 20 });
  });

  it('rejects an unexpected response shape without echoing the body', async () => {
    const { weather } = weatherWith({ forecast: { unexpected: 'secret-token' } });

    await expect(weather.today(SEOUL)).rejects.toThrow('KMA returned an unexpected response.');
    await expect(weather.today(SEOUL)).rejects.not.toThrow('secret-token');
  });
});

describe('KmaWeather.forecast', () => {
  const tomorrow = [
    ...forecastItems(),
    { category: 'TMP', fcstDate: '20261118', fcstTime: '1200', fcstValue: '8' },
    { category: 'TMX', fcstDate: '20261118', fcstTime: '1500', fcstValue: '10' },
    { category: 'TMN', fcstDate: '20261118', fcstTime: '0600', fcstValue: '2' },
    { category: 'SKY', fcstDate: '20261118', fcstTime: '1200', fcstValue: '4' },
    { category: 'PTY', fcstDate: '20261118', fcstTime: '1200', fcstValue: '1' },
    { category: 'POP', fcstDate: '20261118', fcstTime: '1200', fcstValue: '70' },
  ];

  it('reports the requested date at midday, without today’s observation', async () => {
    const { weather, calls } = weatherWith({ forecast: envelope(tomorrow) });

    const report = await weather.forecast(SEOUL, '2026-11-18');

    expect(report).toEqual({ sky: '비', tempC: 8, minC: 2, maxC: 10, rainChance: 70, observedAt: NOW });
    expect(calls.some((call) => call.url.href.includes('getUltraSrtNcst'))).toBe(false);
  });

  it('returns undefined past the forecast range', async () => {
    const { weather } = weatherWith({ forecast: envelope(tomorrow) });
    await expect(weather.forecast(SEOUL, '2026-11-25')).resolves.toBeUndefined();
  });
});
