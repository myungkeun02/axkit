import { z } from 'zod';
import type { Tool } from '../../core/tools/types.js';
import { performCheck } from './check.js';
import type { WatchDeps } from './deps.js';
import { watchView } from './view.js';
import type { WatchView } from './view.js';

const input = z.object({
  id: z.string().min(1).max(80).describe('Watch id from watch.list.'),
});

export type WatchCheckInput = z.infer<typeof input>;

export type WatchCheckOutput =
  | { status: 'ok'; message: string; notified: boolean; watch: WatchView }
  | { status: 'failed'; message: string; watch: WatchView }
  | { status: 'skipped'; message: string }
  | { status: 'not_found'; message: string };

export interface WatchCheckDeps extends WatchDeps {
  timeZone: string;
}

export function watchCheckTool(deps: WatchCheckDeps): Tool<WatchCheckInput, WatchCheckOutput> {
  return {
    name: 'watch.check_now',
    description: 'Check one watch immediately and return the result. It may send the same alert the sweep would.',
    input,
    effects: ['read'],
    async run(value) {
      const watch = deps.store.get(value.id);
      if (watch === undefined) return { status: 'not_found', message: deps.texts.notFound(value.id) };
      const result = await performCheck(
        { ctx: deps.ctx, store: deps.store, texts: deps.texts, currency: deps.currency, now: deps.ctx.clock.now() },
        watch,
      );
      const view = { texts: deps.texts, currency: deps.currency, timeZone: deps.timeZone };
      switch (result.status) {
        case 'ok':
          return {
            status: 'ok',
            message: result.summary,
            notified: result.alert !== undefined,
            watch: watchView(result.watch, view),
          };
        case 'failed':
          return { status: 'failed', message: result.summary, watch: watchView(result.watch, view) };
        case 'skipped':
          return { status: 'skipped', message: result.summary };
      }
    },
  };
}
