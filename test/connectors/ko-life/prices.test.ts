import { describe, expect, it } from 'vitest';
import { MissingKeyError } from '../../../src/core/contracts/index.js';
import { NaverPriceSearch, plainText } from '../../../src/connectors/ko-life/naver-shop.js';
import { KO_SECRETS } from '../../../src/connectors/ko-life/secrets.js';
import { fakeFetch, header, makeDeps } from './helpers.js';

const SECRETS = {
  [KO_SECRETS.naverClientId]: 'client-id',
  [KO_SECRETS.naverClientSecret]: 'client-secret',
};

const ITEMS = {
  items: [
    { title: '<b>무선</b> 이어폰', link: 'https://shop.example.com/1', lprice: '39000', mallName: '예시몰' },
    { title: '무선 이어폰 &amp; 케이스', link: 'https://shop.example.com/2', lprice: '19000', mallName: '다른몰' },
    { title: '중고 이어폰', link: 'https://shop.example.com/3', lprice: '0', mallName: '중고몰' },
    { title: '이어폰', link: 'https://shop.example.com/4', lprice: 'abc', mallName: '이상몰' },
  ],
};

function pricesWith(handler: Parameters<typeof fakeFetch>[0], secrets: Record<string, string> = SECRETS) {
  const fake = fakeFetch(handler);
  return { prices: new NaverPriceSearch(makeDeps(fake.fetch, { secrets })), calls: fake.calls };
}

describe('plainText', () => {
  it('strips tags and decodes HTML entities', () => {
    expect(plainText('<b>무선</b> 이어폰 &amp; 케이스')).toBe('무선 이어폰 & 케이스');
  });
});

describe('NaverPriceSearch.lowest', () => {
  it('sends both Naver headers and the shopping parameters', async () => {
    const { prices, calls } = pricesWith(() => ITEMS);

    await prices.lowest('무선 이어폰', 5);

    expect(header(calls[0], 'x-naver-client-id')).toBe('client-id');
    expect(header(calls[0], 'x-naver-client-secret')).toBe('client-secret');
    expect(calls[0]?.url.searchParams.get('query')).toBe('무선 이어폰');
    expect(calls[0]?.url.searchParams.get('display')).toBe('20');
    expect(calls[0]?.url.searchParams.get('exclude')).toBe('used:rental:cbshop');
  });

  it('drops unpriced items and sorts by price ascending', async () => {
    const { prices } = pricesWith(() => ITEMS);

    const offers = await prices.lowest('무선 이어폰', 5);

    expect(offers).toEqual([
      { title: '무선 이어폰 & 케이스', priceKrw: 19000, mall: '다른몰', url: 'https://shop.example.com/2' },
      { title: '무선 이어폰', priceKrw: 39000, mall: '예시몰', url: 'https://shop.example.com/1' },
    ]);
  });

  it('caps the result at the requested limit', async () => {
    const { prices } = pricesWith(() => ITEMS);
    await expect(prices.lowest('무선 이어폰', 1)).resolves.toHaveLength(1);
  });

  it('throws MissingKeyError for either Naver secret', async () => {
    const { prices } = pricesWith(() => ITEMS, { [KO_SECRETS.naverClientId]: 'client-id' });

    await expect(prices.lowest('무선 이어폰', 5)).rejects.toBeInstanceOf(MissingKeyError);
    await expect(prices.lowest('무선 이어폰', 5)).rejects.toMatchObject({
      secretName: KO_SECRETS.naverClientSecret,
      guide: expect.stringContaining('ax-kit secret set ko.naver.client-secret'),
    });
  });

  it('rejects a malformed response without echoing it', async () => {
    const { prices } = pricesWith(() => ({ items: 'not-an-array', token: 'secret' }));

    await expect(prices.lowest('무선 이어폰', 5)).rejects.toThrow(
      'Naver Shopping returned an unexpected response.',
    );
  });
});
