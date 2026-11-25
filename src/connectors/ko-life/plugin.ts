import { z } from 'zod';
import type { TransitArrival, TransitSource } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { Plugin, PluginContext } from '../../core/plugin/types.js';
import type { KoLifeDeps } from './deps.js';
import { KakaoPlaces } from './kakao.js';
import { KoRoutes } from './routes.js';
import { KmaWeather } from './kma.js';
import { koLifeTexts } from './locale.js';
import { NaverPriceSearch } from './naver-shop.js';
import { KO_SECRET_NAMES } from './secrets.js';
import { AsideParcel, AsidePlaces, AsidePrices, keyOrWeb } from './aside.js';
import type { ParcelTracker, PlaceSource, PriceSearch } from '../../core/contracts/index.js';
import { SeoulTransit } from './seoul-transit.js';
import { SweetTracker } from './sweettracker.js';
import { isSeoulTransitCity, TagoBusArrivals } from './tago.js';
import type { TagoCityConfig } from './tago.js';

export interface KoLifeConnectorOptions {
  /** Tests inject a fake; production uses global fetch. */
  fetch?: typeof fetch;
  /** Overrides the plugin config `sido` for air quality. */
  sido?: string;
}

const ConfigSchema = z.object({
  sido: z.string().min(1).optional(),
  transitCity: z.string().min(1).optional(),
  transitCityCode: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)])
    .optional(),
});

function sidoOf(ctx: PluginContext, override: string | undefined): string | undefined {
  if (override !== undefined) return override;
  const parsed = ConfigSchema.safeParse(ctx.config);
  return parsed.success ? parsed.data.sido : undefined;
}

function transitCityOf(ctx: PluginContext): TagoCityConfig | undefined {
  const parsed = ConfigSchema.safeParse(ctx.config);
  if (!parsed.success) return undefined;
  const { transitCity, transitCityCode } = parsed.data;
  if (transitCity === undefined && transitCityCode === undefined) return undefined;
  return {
    ...(transitCity !== undefined ? { city: transitCity } : {}),
    ...(transitCityCode !== undefined ? { cityCode: transitCityCode } : {}),
  };
}

/** Subway always comes from Seoul open data; bus comes from TAGO outside Seoul. */
class CompositeTransit implements TransitSource {
  constructor(
    private readonly fallback: TransitSource,
    private readonly tago: TagoBusArrivals,
  ) {}

  arrivals(query: { stop: string; kind: 'bus' | 'subway' }): Promise<TransitArrival[]> {
    return query.kind === 'bus' ? this.tago.arrivals(query.stop) : this.fallback.arrivals(query);
  }
}

/** Korean public services: places, weather, transit, parcels and lowest prices. */
export function koLifeConnector(opts: KoLifeConnectorOptions = {}): Plugin {
  return {
    manifest: {
      id: 'connector.ko-life',
      kind: 'connector',
      title: 'Korean life services',
      secrets: KO_SECRET_NAMES,
    },
    setup(ctx) {
      const deps: KoLifeDeps = {
        fetch: opts.fetch ?? globalThis.fetch,
        secrets: ctx.secrets,
        clock: ctx.clock,
        kv: ctx.kv,
        texts: koLifeTexts(ctx.assistant.language),
      };
      const places = new KakaoPlaces(deps);
      const weather = new KmaWeather(deps, places, sidoOf(ctx, opts.sido));
      const seoul = new SeoulTransit(deps);
      const city = transitCityOf(ctx);
      const transit =
        city !== undefined && !isSeoulTransitCity(city)
          ? new CompositeTransit(seoul, new TagoBusArrivals(deps, city))
          : seoul;

      // no key for a service: the owner's browser agent (Aside) reads the same thing from the web
      const agent = () => ctx.tryUse(Contracts.webAgent);
      ctx.provide(Contracts.places, keyOrWeb<PlaceSource>(places, new AsidePlaces(agent, () => ctx.clock.now().getTime()), agent));
      ctx.provide(Contracts.routes, new KoRoutes(deps));
      ctx.provide(Contracts.weather, weather);
      ctx.provide(Contracts.transit, transit);
      ctx.provide(Contracts.parcel, keyOrWeb<ParcelTracker>(new SweetTracker(deps), new AsideParcel(agent), agent));
      ctx.provide(Contracts.prices, keyOrWeb<PriceSearch>(new NaverPriceSearch(deps), new AsidePrices(agent), agent));
    },
  };
}
