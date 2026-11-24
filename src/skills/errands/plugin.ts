import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { BackgroundTasks } from '../work/background.js';
import { errandTexts } from './locale.js';
import { SEAT_SWEEP_JOB, SEAT_SWEEP_SECONDS, SeatWatchStore, sweepSeatWatches } from './seat-watch.js';
import { restaurantTool } from './tool-restaurant.js';
import { seatWatchListTool, seatWatchStopTool, seatWatchTool } from './tool-seat-watch.js';
import { shopTool } from './tool-shop.js';
import { trainTool } from './tool-train.js';

/**
 * 생활 심부름: train seats, a restaurant table and a cart, prepared on the owner's own browser up to the button
 * that commits. The browser harness refuses payment and final buttons in code; login, payment, consent and
 * captcha are always the owner's. Every errand asks on a card first.
 */
export interface ErrandsOptions {
  /** Called with each finished errand's raw output (tests). */
  onSettled?: (workId: string, output: unknown) => void;
}

export function errandsSkill(options: ErrandsOptions = {}): Plugin {
  return {
    manifest: {
      id: 'skill.errands',
      kind: 'skill',
      title: 'Everyday errands (trains, tables, carts)',
      needs: [Contracts.browser],
    },
    async setup(ctx) {
      const agent = ctx.use(Contracts.browser);
      const store = new SeatWatchStore(ctx.kv, ctx.log);
      await store.load();
      // the same queue as browser.task on this browser, so two errands never drive it at once
      const tasks = new BackgroundTasks({
        ctx,
        kind: 'errand',
        noticeKind: 'errands.task',
        laneKey: agent,
        handoff: () => ctx.tryUse(Contracts.browserLive),
        ...(options.onSettled !== undefined ? { onSettled: options.onSettled } : {}),
      });
      await tasks.load();
      const deps = { ctx, agent, texts: errandTexts, tasks };
      const sweepDeps = { ...deps, store, lastCheck: { at: undefined } };

      ctx.registerTool(trainTool(deps));
      ctx.registerTool(restaurantTool(deps));
      ctx.registerTool(shopTool(deps));
      ctx.registerTool(seatWatchTool(sweepDeps));
      ctx.registerTool(seatWatchListTool(sweepDeps));
      ctx.registerTool(seatWatchStopTool(sweepDeps));

      ctx.scheduler.add({
        name: SEAT_SWEEP_JOB,
        label: '기차 빈자리 감시',
        schedule: { kind: 'every', seconds: SEAT_SWEEP_SECONDS },
        run: async (now) => {
          await sweepSeatWatches(sweepDeps, now);
        },
      });
    },
  };
}
