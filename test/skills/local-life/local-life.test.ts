import { describe, expect, it } from 'vitest';
import type {
  GeoPoint,
  ParcelStatus,
  ParcelTracker,
  PhoneDayTotals,
  PhoneLocation,
  PhoneSignals,
  Place,
  PlaceSource,
  PriceOffer,
  PriceSearch,
  TransitArrival,
  TransitSource,
  WeatherReport,
  WeatherSource,
} from '../../../src/core/contracts/index.js';
import { Contracts, MissingKeyError } from '../../../src/core/contracts/index.js';
import { localLifeSkill } from '../../../src/skills/local-life/plugin.js';
import type { TestContextOptions } from '../../support/context.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');
const SEOUL: GeoPoint = { lat: 37.5665, lng: 126.978 };

const REPORT: WeatherReport = {
  sky: '맑음',
  tempC: 12,
  minC: 3,
  maxC: 13,
  rainChance: 20,
  air: { grade: '보통', pm10: 45 },
  observedAt: NOW,
};

class FakeWeather implements WeatherSource {
  readonly points: GeoPoint[] = [];
  constructor(private value: WeatherReport | Error = REPORT) {}
  async today(point: GeoPoint): Promise<WeatherReport> {
    this.points.push(point);
    if (this.value instanceof Error) throw this.value;
    return this.value;
  }
}

class FakePlaces implements PlaceSource {
  readonly geocoded: string[] = [];
  readonly searches: { query: string; near?: GeoPoint; limit: number }[] = [];
  geocodeResult: GeoPoint | Error | undefined = SEOUL;
  results: Place[] = [];

  async search(query: string, opts: { near?: GeoPoint; limit: number }): Promise<Place[]> {
    this.searches.push({ query, ...(opts.near !== undefined ? { near: opts.near } : {}), limit: opts.limit });
    return this.results;
  }

  async geocode(text: string): Promise<GeoPoint | undefined> {
    this.geocoded.push(text);
    if (this.geocodeResult instanceof Error) throw this.geocodeResult;
    return this.geocodeResult;
  }
}

class FakePhone implements PhoneSignals {
  constructor(private readonly location: PhoneLocation | undefined) {}
  async latestLocation(): Promise<PhoneLocation | undefined> {
    return this.location;
  }
  async dayTotals(): Promise<PhoneDayTotals> {
    return {};
  }
  async lastSeen(): Promise<Date | undefined> {
    return undefined;
  }
}

class FakeTransit implements TransitSource {
  readonly queries: { stop: string; kind: 'bus' | 'subway' }[] = [];
  arrivalsValue: TransitArrival[] | Error = [];
  async arrivals(query: { stop: string; kind: 'bus' | 'subway' }): Promise<TransitArrival[]> {
    this.queries.push(query);
    if (this.arrivalsValue instanceof Error) throw this.arrivalsValue;
    return this.arrivalsValue;
  }
}

class FakeParcel implements ParcelTracker {
  carriersValue: { code: string; name: string }[] | Error = [
    { code: '11', name: '가온택배' },
    { code: '12', name: '한빛택배' },
  ];
  readonly tracked: { carrier: string; invoice: string }[] = [];
  status: ParcelStatus = {
    carrier: '11',
    invoice: '99',
    state: '배송중',
    delivered: false,
  };

  async carriers(): Promise<{ code: string; name: string }[]> {
    if (this.carriersValue instanceof Error) throw this.carriersValue;
    return this.carriersValue;
  }

  async track(carrierCode: string, invoice: string): Promise<ParcelStatus> {
    this.tracked.push({ carrier: carrierCode, invoice });
    return { ...this.status, carrier: carrierCode, invoice };
  }
}

class FakePrices implements PriceSearch {
  readonly queries: { query: string; limit: number }[] = [];
  offers: PriceOffer[] = [];
  async lowest(query: string, limit: number): Promise<PriceOffer[]> {
    this.queries.push({ query, limit });
    return this.offers;
  }
}

interface SetupOptions {
  config?: Record<string, unknown>;
  weather?: FakeWeather;
  places?: FakePlaces;
  phone?: FakePhone;
  transit?: FakeTransit;
  parcel?: FakeParcel;
  prices?: FakePrices;
}

async function setup(opts: SetupOptions = {}) {
  const weather = opts.weather ?? new FakeWeather();
  const places = opts.places ?? new FakePlaces();
  const transit = opts.transit ?? new FakeTransit();
  const parcel = opts.parcel ?? new FakeParcel();
  const prices = opts.prices ?? new FakePrices();
  const capabilities: Record<string, unknown> = {
    [Contracts.weather.id]: weather,
    [Contracts.places.id]: places,
    [Contracts.transit.id]: transit,
    [Contracts.parcel.id]: parcel,
    [Contracts.prices.id]: prices,
    ...(opts.phone !== undefined ? { [Contracts.phoneSignals.id]: opts.phone } : {}),
  };
  const testOptions: TestContextOptions = {
    now: NOW,
    capabilities,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
  };
  const context = createTestContext(testOptions);
  await localLifeSkill().setup(context.ctx);
  return { ...context, weather, places, transit, parcel, prices };
}

async function execute(context: Awaited<ReturnType<typeof setup>>, name: string, input: unknown) {
  const outcome = await context.ctx.tools.execute(name, input);
  if (outcome.status !== 'done') throw new Error(`unexpected outcome: ${outcome.status}`);
  return outcome.output as Record<string, unknown>;
}

const PHONE_LOCATION: PhoneLocation = { lat: 37.5, lng: 127, label: '지금 있는 곳', at: NOW };

describe('life.weather location rule', () => {
  it('uses the phone location when the owner names no place', async () => {
    const context = await setup({ phone: new FakePhone(PHONE_LOCATION) });

    const output = await execute(context, 'life.weather', {});

    expect(output).toMatchObject({
      status: 'ok',
      location: { lat: 37.5, lng: 127, source: 'phone', label: '지금 있는 곳' },
      weather: { sky: '맑음', tempC: 12, minC: 3, maxC: 13, rainChance: 20, observedAt: NOW.toISOString() },
    });
    expect(context.weather.points).toEqual([{ lat: 37.5, lng: 127 }]);
  });

  it('falls back to the configured home when the phone has no recent location', async () => {
    const context = await setup({
      config: { home: { lat: 37.51, lng: 127.02, label: '집' } },
    });

    const output = await execute(context, 'life.weather', {});

    expect(output).toMatchObject({ status: 'ok', location: { source: 'home', label: '집' } });
    expect(context.weather.points).toEqual([{ lat: 37.51, lng: 127.02 }]);
  });

  it('asks the owner when neither a phone location nor a home is known', async () => {
    const context = await setup();

    const output = await execute(context, 'life.weather', {});

    expect(output.status).toBe('need_location');
    expect(output.question).toContain('어느 동네');
    expect(context.weather.points).toEqual([]);
  });

  it('geocodes a place the owner named', async () => {
    const context = await setup({ phone: new FakePhone(PHONE_LOCATION) });

    const output = await execute(context, 'life.weather', { place: '서울시청' });

    expect(context.places.geocoded).toEqual(['서울시청']);
    expect(output).toMatchObject({ status: 'ok', location: { source: 'said', label: '서울시청' } });
  });

  it('reports a place that cannot be geocoded', async () => {
    const places = new FakePlaces();
    places.geocodeResult = undefined;
    const context = await setup({ places });

    const output = await execute(context, 'life.weather', { place: '없는 곳' });

    expect(output).toMatchObject({ status: 'place_not_found', place: '없는 곳' });
  });

  it('turns a missing key into a needs_key answer with the guide', async () => {
    const weather = new FakeWeather(new MissingKeyError('ko.data-go-kr.key', '키를 넣어 주세요'));
    const context = await setup({ weather, phone: new FakePhone(PHONE_LOCATION) });

    const output = await execute(context, 'life.weather', {});

    expect(output).toEqual({
      status: 'needs_key',
      secret: 'ko.data-go-kr.key',
      guide: '키를 넣어 주세요',
    });
  });
});

describe('life.places', () => {
  it('searches around a place name', async () => {
    const places = new FakePlaces();
    places.results = [
      { name: '예시 약국', address: '서울특별시 중구', point: SEOUL, distanceM: 120 },
    ];
    const context = await setup({ places });

    const output = await execute(context, 'life.places', { query: '약국', near: '서울시청' });

    expect(places.geocoded).toEqual(['서울시청']);
    expect(places.searches[0]).toMatchObject({ query: '약국', near: SEOUL, limit: 5 });
    expect(output).toMatchObject({ status: 'ok', places: places.results });
  });

  it('reports a missing key from geocoding', async () => {
    const places = new FakePlaces();
    places.geocodeResult = new MissingKeyError('ko.kakao.rest-key', '카카오 키');
    const context = await setup({ places });

    const output = await execute(context, 'life.places', { query: '약국', near: '서울시청' });

    expect(output).toMatchObject({ status: 'needs_key', secret: 'ko.kakao.rest-key' });
  });
});

describe('life.transit', () => {
  it('returns arrivals with the Seoul-only note', async () => {
    const transit = new FakeTransit();
    transit.arrivalsValue = [
      { route: '2호선', minutes: 3, message: '3번째 전', stop: '시청역' },
    ];
    const context = await setup({ transit });

    const output = await execute(context, 'life.transit', { stop: '시청역', kind: 'subway' });

    expect(transit.queries).toEqual([{ stop: '시청역', kind: 'subway' }]);
    expect(output).toMatchObject({ status: 'ok', arrivals: transit.arrivalsValue });
    expect(output.note).toContain('서울');
  });

  it('says nothing was found and repeats the Seoul limit', async () => {
    const context = await setup();

    const output = await execute(context, 'life.transit', { stop: '없는 정류장', kind: 'bus' });

    expect(output.status).toBe('no_results');
    expect(output.note).toContain('다른 지역은 아직 지원하지 않아요');
  });
});

describe('life.parcel', () => {
  it('fuzzy-matches a carrier name before tracking', async () => {
    const parcel = new FakeParcel();
    const context = await setup({ parcel });

    const output = await execute(context, 'life.parcel', { carrier: '가온', invoice: '1234' });

    expect(parcel.tracked).toEqual([{ carrier: '11', invoice: '1234' }]);
    expect(output).toMatchObject({ status: 'ok', parcel: { carrier: '가온택배', invoice: '1234' } });
  });

  it('matches a carrier by code', async () => {
    const parcel = new FakeParcel();
    const context = await setup({ parcel });

    await execute(context, 'life.parcel', { carrier: '12', invoice: '1234' });

    expect(parcel.tracked[0]?.carrier).toBe('12');
  });

  it('lists carriers when nothing matches', async () => {
    const context = await setup();

    const output = await execute(context, 'life.parcel', { carrier: '없는택배', invoice: '1234' });

    expect(output).toMatchObject({
      status: 'carrier_not_found',
      carriers: ['가온택배 (11)', '한빛택배 (12)'],
    });
  });

  it('turns a missing key into needs_key', async () => {
    const parcel = new FakeParcel();
    parcel.carriersValue = new MissingKeyError('ko.sweettracker.key', '택배 키');
    const context = await setup({ parcel });

    const output = await execute(context, 'life.parcel', { carrier: '가온', invoice: '1234' });

    expect(output).toMatchObject({ status: 'needs_key', secret: 'ko.sweettracker.key' });
  });
});

describe('life.price', () => {
  it('defaults to five offers', async () => {
    const prices = new FakePrices();
    prices.offers = [{ title: '예시 이어폰', priceKrw: 19000, mall: '예시몰', url: 'https://example.com/1' }];
    const context = await setup({ prices });

    const output = await execute(context, 'life.price', { query: '이어폰' });

    expect(prices.queries).toEqual([{ query: '이어폰', limit: 5 }]);
    expect(output).toMatchObject({ status: 'ok', offers: prices.offers });
  });

  it('passes an explicit limit and rejects more than ten', async () => {
    const context = await setup();

    await execute(context, 'life.price', { query: '이어폰', limit: 3 });
    const outcome = await context.ctx.tools.execute('life.price', { query: '이어폰', limit: 11 });

    expect(outcome.status).toBe('invalid_input');
  });

  it('reports no results', async () => {
    const context = await setup();

    const output = await execute(context, 'life.price', { query: '없는 물건' });

    expect(output.status).toBe('no_results');
  });
});
