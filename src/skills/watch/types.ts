import { z } from 'zod';

export const WATCH_KINDS = ['price', 'restock', 'page'] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];
export type MoneyCurrency = 'KRW' | 'USD';

export const DEFAULT_EVERY_MINUTES = 360;
export const MIN_EVERY_MINUTES = 30;
export const MAX_EVERY_MINUTES = 10_080;
export const MAX_WATCHES = 50;
export const MAX_PAGE_LINES = 200;

export interface WatchLast {
  price?: number | undefined;
  mall?: string | undefined;
  offerUrl?: string | undefined;
  inStock?: boolean | undefined;
  hash?: string | undefined;
  /** Capped at MAX_PAGE_LINES so the kv value stays bounded. */
  lines?: string[] | undefined;
  checkedAt: string;
}

export interface Watch {
  id: string;
  kind: WatchKind;
  label: string;
  query?: string | undefined;
  url?: string | undefined;
  targetPrice?: number | undefined;
  everyMinutes: number;
  createdAt: string;
  failures: number;
  nextAt: string;
  last?: WatchLast | undefined;
}

const lastSchema = z.object({
  price: z.number().optional(),
  mall: z.string().optional(),
  offerUrl: z.string().optional(),
  inStock: z.boolean().optional(),
  hash: z.string().optional(),
  lines: z.array(z.string()).max(MAX_PAGE_LINES).optional(),
  checkedAt: z.string(),
});

export const watchSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(WATCH_KINDS),
  label: z.string().min(1),
  query: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  targetPrice: z.number().optional(),
  everyMinutes: z.number().int().min(MIN_EVERY_MINUTES).max(MAX_EVERY_MINUTES),
  createdAt: z.string(),
  failures: z.number().int().min(0),
  nextAt: z.string(),
  last: lastSchema.optional(),
});

export function clampEvery(minutes: number | undefined): number {
  if (minutes === undefined) return DEFAULT_EVERY_MINUTES;
  return Math.min(MAX_EVERY_MINUTES, Math.max(MIN_EVERY_MINUTES, Math.round(minutes)));
}
