export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Thrown when a service needs a key the owner has not added yet. The guide says where to get it. */
export class MissingKeyError extends Error {
  constructor(
    readonly secretName: string,
    readonly guide: string,
  ) {
    super(`Missing key: ${secretName}`);
    this.name = 'MissingKeyError';
  }
}

export interface Place {
  name: string;
  address: string;
  point: GeoPoint;
  category?: string;
  phone?: string;
  url?: string;
  /** Straight-line distance from the search center, when one was given. */
  distanceM?: number;
}

/** Capability "life.places". */
/** One way to get from A to B (D7). `path` is a thinned line of [lng, lat] points for the map. */
export interface RouteOption {
  mode: 'transit' | 'car' | 'walk';
  durationMin: number;
  distanceKm: number;
  fareKrw?: number;
  tollKrw?: number;
  summary: string;
  steps: { mode: 'walk' | 'subway' | 'bus' | 'car'; label: string; durationMin: number; line?: string; color?: string }[];
  path: [number, number][];
}

/** Capability "life.routes": car directions (Kakao Mobility) and public transit (ODsay), keys on the Mac only. */
export interface RouteSource {
  car(from: GeoPoint, to: GeoPoint): Promise<RouteOption | undefined>;
  transit(from: GeoPoint, to: GeoPoint): Promise<RouteOption | undefined>;
}

export interface PlaceSource {
  search(query: string, opts: { near?: GeoPoint; limit: number }): Promise<Place[]>;
  geocode(text: string): Promise<GeoPoint | undefined>;
}

export interface WeatherReport {
  /** Short words from the service ("맑음", "비"). */
  sky: string;
  tempC?: number;
  minC?: number;
  maxC?: number;
  rainChance?: number;
  /** Air quality grade words from the service ("좋음", "나쁨"), with raw values when present. */
  air?: { grade: string; pm10?: number; pm25?: number };
  observedAt: Date;
}

/** Where the owner usually sleeps and works, learned from the phone's location over the days. */
export interface KnownPlaces {
  home?: GeoPoint;
  work?: GeoPoint;
}

/** Capability "life.known-places" (skill.day learns them). */
export interface KnownPlacesSource {
  get(): Promise<KnownPlaces>;
}

/** Capability "life.weather". */
export interface WeatherSource {
  today(point: GeoPoint): Promise<WeatherReport>;
  /**
   * The forecast for one local date (YYYY-MM-DD) at that place. Undefined when the date is past the service's range.
   * Optional: a source without it can only say today's weather.
   */
  forecast?(point: GeoPoint, ymd: string): Promise<WeatherReport | undefined>;
}

export interface TransitArrival {
  route: string;
  /** Minutes until arrival; undefined when the service gives only a text. */
  minutes?: number;
  message: string;
  stop: string;
}

/** Capability "life.transit". `stop` is a stop or station name the owner said. */
export interface TransitSource {
  arrivals(query: { stop: string; kind: 'bus' | 'subway' }): Promise<TransitArrival[]>;
}

export interface ParcelStatus {
  carrier: string;
  invoice: string;
  state: string;
  lastEvent?: { at: string; where: string; what: string };
  delivered: boolean;
}

/** Capability "life.parcel". */
export interface ParcelTracker {
  carriers(): Promise<{ code: string; name: string }[]>;
  track(carrierCode: string, invoice: string): Promise<ParcelStatus>;
}

export interface PriceOffer {
  title: string;
  priceKrw: number;
  mall: string;
  url: string;
}

/** Capability "life.prices". Read only: it never buys. */
export interface PriceSearch {
  lowest(query: string, limit: number): Promise<PriceOffer[]>;
}
