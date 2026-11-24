import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { KeyValueStore } from '../../core/store/types.js';

const KEY = 'orders';
export const MAX_ORDERS = 30;
const MAX_SEEN = 400;
export const DEFAULT_DAYS = 90;

export const SOURCES = ['mail', 'web', 'news'] as const;
export type OrderSource = (typeof SOURCES)[number];

const OrderSchema = z.object({
  id: z.string(),
  /** The owner's words ("토스에서 iOS 채용 공고 나오면 알려줘"). */
  text: z.string(),
  source: z.enum(SOURCES),
  /** What counts as a hit, in plain words for the judge. */
  condition: z.string(),
  /** web: the page; news: built from the query. */
  url: z.string().optional(),
  query: z.string().optional(),
  createdAt: z.string(),
  /** ISO 8601: after this the order ends by itself. */
  until: z.string(),
  hits: z.number().int().nonnegative(),
  lastHitAt: z.string().optional(),
  lastCheckedAt: z.string().optional(),
  /** Hashes of lines already seen on the page, so only new ones are judged. */
  seen: z.array(z.string()),
  /** The first look at a page only learns what is there. */
  seeded: z.boolean(),
  active: z.boolean(),
});
export type StandingOrder = z.infer<typeof OrderSchema>;

export function lineHash(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 12);
}

/** Google News search as a feed: the stripped page text lists one headline per line. */
export function newsUrl(query: string, korean: boolean): string {
  const params = new URLSearchParams({ q: query, hl: korean ? 'ko' : 'en', gl: korean ? 'KR' : 'US', ceid: korean ? 'KR:ko' : 'US:en' });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

/** Standing orders, in the skill's own store. */
export class OrderStore {
  private orders: StandingOrder[] = [];

  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<void> {
    const parsed = z.array(OrderSchema).safeParse(await this.kv.get<unknown>(KEY));
    this.orders = parsed.success ? parsed.data : [];
  }

  list(): readonly StandingOrder[] {
    return this.orders;
  }

  active(now: Date, source?: OrderSource): StandingOrder[] {
    return this.orders.filter((order) => order.active && Date.parse(order.until) > now.getTime() && (source === undefined || order.source === source));
  }

  async add(order: Omit<StandingOrder, 'id' | 'hits' | 'seen' | 'seeded' | 'active'>): Promise<StandingOrder> {
    if (this.orders.filter((item) => item.active).length >= MAX_ORDERS) throw new Error(`At most ${MAX_ORDERS} standing orders; remove one first`);
    const full: StandingOrder = { ...order, id: lineHash(`${order.text}|${order.createdAt}`).slice(0, 8), hits: 0, seen: [], seeded: order.source === 'mail', active: true };
    this.orders.push(full);
    await this.save();
    return full;
  }

  async update(id: string, change: (order: StandingOrder) => void): Promise<StandingOrder | undefined> {
    const order = this.orders.find((item) => item.id === id);
    if (order === undefined) return undefined;
    change(order);
    order.seen = order.seen.slice(-MAX_SEEN);
    await this.save();
    return order;
  }

  /** Ends orders past their date; returns the ones that just ended. */
  async expire(now: Date): Promise<StandingOrder[]> {
    const ended = this.orders.filter((order) => order.active && Date.parse(order.until) <= now.getTime());
    for (const order of ended) order.active = false;
    if (ended.length > 0) await this.save();
    return ended;
  }

  private async save(): Promise<void> {
    await this.kv.set(KEY, this.orders.filter((order) => order.active).concat(this.orders.filter((order) => !order.active).slice(-20)));
  }
}
