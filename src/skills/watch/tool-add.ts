import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tool } from '../../core/tools/types.js';
import type { WatchDeps } from './deps.js';
import type { Watch } from './types.js';
import { clampEvery, MAX_EVERY_MINUTES, MIN_EVERY_MINUTES } from './types.js';
import { conditionOf, siteName, watchView } from './view.js';
import type { WatchView } from './view.js';

const input = z
  .object({
    kind: z.enum(['price', 'restock', 'page']).describe('What to watch: a price, a restock, or page text changes.'),
    query: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Product search words. For price only, and exactly one of query or url.'),
    url: z
      .url()
      .max(2048)
      .optional()
      .describe('Public http(s) page. Required for restock and page, or for a price watched on one page.'),
    targetPrice: z
      .number()
      .finite()
      .positive()
      .optional()
      .describe('Alert at or below this price, in the home currency. Price kind only.'),
    label: z.string().min(1).max(80).optional().describe('Short name shown in alerts; defaults to the query or site.'),
    everyMinutes: z
      .number()
      .int()
      .min(MIN_EVERY_MINUTES)
      .max(MAX_EVERY_MINUTES)
      .optional()
      .describe('Check interval in minutes (30–10080); defaults to 360.'),
  })
  .superRefine((value, ctx) => {
    const hasQuery = value.query !== undefined;
    const hasUrl = value.url !== undefined;
    if (value.kind === 'price') {
      if (hasQuery === hasUrl) {
        ctx.addIssue({
          code: 'custom',
          path: ['query'],
          message: 'Price watches need exactly one of query or url.',
        });
      }
    } else if (!hasUrl || hasQuery) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'Restock and page watches need a URL and no query.',
      });
    }
    if (value.kind !== 'price' && value.targetPrice !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['targetPrice'], message: 'Only price watches have a target price.' });
    }
    if (value.url !== undefined) {
      let protocol = '';
      try {
        protocol = new URL(value.url).protocol;
      } catch {
        protocol = '';
      }
      if (protocol !== 'http:' && protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', path: ['url'], message: 'The URL must start with http or https.' });
      }
    }
  });

export type WatchAddInput = z.infer<typeof input>;

export type WatchAddOutput =
  | { status: 'ok'; message: string; watch: WatchView }
  | { status: 'limit'; message: string };

export interface WatchAddDeps extends WatchDeps {
  timeZone: string;
}

function defaultLabel(value: WatchAddInput): string {
  if (value.label !== undefined) return value.label;
  if (value.query !== undefined) return value.query;
  if (value.url !== undefined) {
    const site = siteName(value.url);
    if (site !== '') return site;
  }
  return value.kind;
}

function buildWatch(value: WatchAddInput, id: string, nowIso: string): Watch {
  return {
    id,
    kind: value.kind,
    label: defaultLabel(value),
    ...(value.query !== undefined ? { query: value.query } : {}),
    ...(value.url !== undefined ? { url: value.url } : {}),
    ...(value.targetPrice !== undefined ? { targetPrice: value.targetPrice } : {}),
    everyMinutes: clampEvery(value.everyMinutes),
    createdAt: nowIso,
    failures: 0,
    nextAt: nowIso,
  };
}

export function watchAddTool(deps: WatchAddDeps): Tool<WatchAddInput, WatchAddOutput> {
  return {
    name: 'watch.add',
    description:
      'Start watching a price, a restock or a page change. Read-only on the outside world: it never buys or books. ' +
      'The first check runs at the next sweep.',
    input,
    effects: ['write'],
    describe(value) {
      return deps.texts.addDescription(defaultLabel(value), conditionOf(value, deps.texts, deps.currency));
    },
    async run(value) {
      const now = deps.ctx.clock.now();
      let id = `w_${randomUUID().slice(0, 8)}`;
      while (deps.store.get(id) !== undefined) id = `w_${randomUUID().slice(0, 8)}`;
      const watch = buildWatch(value, id, now.toISOString());
      const added = await deps.store.add(watch);
      if (!added) return { status: 'limit', message: deps.texts.limitReached };
      return {
        status: 'ok',
        message: deps.texts.added(watch.label, conditionOf(watch, deps.texts, deps.currency)),
        watch: watchView(watch, {
          texts: deps.texts,
          currency: deps.currency,
          timeZone: deps.timeZone,
        }),
      };
    },
  };
}
