import { z } from 'zod';
import type { Plugin } from '../../core/plugin/types.js';
import type { Tool } from '../../core/tools/types.js';
import { checkMail, checkPage } from './checks.js';
import type { StandingOrder } from './store.js';
import { DEFAULT_DAYS, OrderStore, SOURCES, newsUrl } from './store.js';

const JOB = 'standing.check';
const DAY_MS = 24 * 60 * 60 * 1000;

const addInput = z.object({
  text: z.string().trim().min(1).max(200).describe('The owner’s request in their words, e.g. "토스 iOS 채용 공고 나오면 알려줘".'),
  source: z.enum(SOURCES).describe('mail = new mail in the inbox; web = one page to watch (give url); news = a news search (give query).'),
  condition: z.string().trim().min(2).max(300).describe('What exactly counts, in plain words: who/what/which words.'),
  url: z.string().url().max(1000).optional(),
  query: z.string().trim().min(1).max(120).optional(),
  days: z.number().int().min(1).max(365).optional().describe(`How long to keep watching; default ${DEFAULT_DAYS} days.`),
});
const removeInput = z.object({ id: z.string().min(1).max(20) });

function shown(order: StandingOrder): Record<string, unknown> {
  return { id: order.id, text: order.text, source: order.source, condition: order.condition, ...(order.url !== undefined && order.source === 'web' ? { url: order.url } : {}), ...(order.query !== undefined ? { query: order.query } : {}), until: order.until.slice(0, 10), hits: order.hits, active: order.active, ...(order.lastHitAt !== undefined ? { lastHit: order.lastHitAt.slice(0, 10) } : {}) };
}

/**
 * Standing orders: "X 나오면 알려줘" kept watching until it happens or the order ends — new mail as it is triaged, and
 * a page or a news search every hour. It only tells the owner; anything to do about it goes through chat as usual.
 */
export function standingSkill(): Plugin {
  return {
    manifest: { id: 'skill.standing', kind: 'skill', title: 'Standing orders (let me know when…)' },
    async setup(ctx) {
      const store = new OrderStore(ctx.kv);
      await store.load();
      const korean = ctx.assistant.language !== 'en';
      const add: Tool<z.infer<typeof addInput>, Record<string, unknown>> = {
        name: 'standing.add',
        description: 'Keep watching for something the owner wants to hear about ("X 나오면 알려줘", "OO한테 메일 오면 바로 알려줘", "그 페이지에 공지 올라오면"). Tells the owner when it happens.',
        input: addInput,
        effects: ['write'],
        describe: (input) => `${korean ? '계속 지켜보기' : 'Watch for'}: ${input.text}`,
        async run(input) {
          if (input.source === 'web' && input.url === undefined) throw new Error('A web order needs the page url');
          if (input.source === 'news' && input.query === undefined) throw new Error('A news order needs a search query');
          const now = ctx.clock.now();
          const url = input.source === 'news' && input.query !== undefined ? newsUrl(input.query, korean) : input.url;
          const order = await store.add({
            text: input.text,
            source: input.source,
            condition: input.condition,
            ...(url !== undefined ? { url } : {}),
            ...(input.query !== undefined ? { query: input.query } : {}),
            createdAt: now.toISOString(),
            until: new Date(now.getTime() + (input.days ?? DEFAULT_DAYS) * DAY_MS).toISOString(),
          });
          // a page learns what is already there right away, so only what appears from now on counts
          if (order.source !== 'mail') await checkPage(ctx, store, order).catch(() => 0);
          return shown(order);
        },
      };
      const list: Tool<Record<string, never>, Record<string, unknown>> = {
        name: 'standing.list',
        description: 'The standing orders the assistant keeps watching for, with how often each fired.',
        input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
        effects: ['read'],
        async run() {
          return { orders: store.active(ctx.clock.now()).map(shown) };
        },
      };
      const remove: Tool<z.infer<typeof removeInput>, Record<string, unknown>> = {
        name: 'standing.remove',
        description: 'Stop watching for one standing order.',
        input: removeInput,
        effects: ['write'],
        async run(input) {
          const order = await store.update(input.id, (item) => {
            item.active = false;
          });
          return order === undefined ? { found: false } : { found: true, removed: order.text };
        },
      };
      ctx.registerTool(add);
      ctx.registerTool(list);
      ctx.registerTool(remove);

      ctx.bus.on('mail.triaged', async (mail) => {
        await checkMail(ctx, store, mail).catch(() => 0);
      });
      ctx.scheduler.add({
        name: JOB,
        label: korean ? '지켜보기 확인' : 'Standing orders',
        schedule: { kind: 'every', seconds: 3600 },
        run: async () => {
          const now = ctx.clock.now();
          await store.expire(now);
          for (const order of store.active(now).filter((item) => item.source !== 'mail')) await checkPage(ctx, store, order).catch(() => 0);
        },
      });
    },
  };
}
