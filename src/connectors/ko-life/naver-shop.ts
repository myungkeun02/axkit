import { z } from 'zod';
import type { PriceOffer, PriceSearch } from '../../core/contracts/index.js';
import type { KoLifeDeps } from './deps.js';
import { keyOf } from './deps.js';
import { fetchJson, parseShape } from './http.js';
import { KO_SECRETS } from './secrets.js';

const SEARCH_URL = 'https://openapi.naver.com/v1/search/shop.json';
const DISPLAY = 20;

const Search = z.object({ items: z.array(z.unknown()) });

const ShopItem = z.object({
  title: z.string(),
  link: z.string().optional(),
  lprice: z.union([z.string(), z.number()]),
  mallName: z.string().optional(),
});

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
};

export function plainText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|quot|#39|lt|gt|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Naver Shopping search: read-only, lowest price first, used and rental listings are not requested. */
export class NaverPriceSearch implements PriceSearch {
  constructor(private readonly deps: KoLifeDeps) {}

  async lowest(query: string, limit: number): Promise<PriceOffer[]> {
    const clientId = await keyOf(this.deps, KO_SECRETS.naverClientId);
    const clientSecret = await keyOf(this.deps, KO_SECRETS.naverClientSecret);
    const params = new URLSearchParams({
      query,
      display: String(DISPLAY),
      sort: 'sim',
      exclude: 'used:rental:cbshop',
    });
    const response = await fetchJson(this.deps.fetch, `${SEARCH_URL}?${params}`, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
    });
    const body = parseShape(Search, response, 'Naver Shopping');
    const offers: PriceOffer[] = [];
    for (const raw of body.items) {
      const parsed = ShopItem.safeParse(raw);
      if (!parsed.success) continue;
      const priceKrw = Number(parsed.data.lprice);
      if (!Number.isFinite(priceKrw) || priceKrw <= 0) continue;
      offers.push({
        title: plainText(parsed.data.title),
        priceKrw,
        mall: plainText(parsed.data.mallName ?? ''),
        url: parsed.data.link ?? '',
      });
    }
    return offers.sort((left, right) => left.priceKrw - right.priceKrw).slice(0, limit);
  }
}
