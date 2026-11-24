import type { Plugin } from '../../core/plugin/types.js';
import { homeCurrency } from './config.js';
import { watchTexts } from './locale.js';
import { WatchStore } from './store.js';
import { SWEEP_JOB, SWEEP_SECONDS, sweepWatches } from './sweep.js';
import { watchAddTool } from './tool-add.js';
import { watchCheckTool } from './tool-check.js';
import { watchListTool } from './tool-list.js';
import { watchRemoveTool } from './tool-remove.js';

/**
 * Watches a price, a restock or a page. Every outside source is optional and resolved on each check, so the skill
 * starts even when the price or web connector is absent.
 */
export function watchSkill(): Plugin {
  return {
    manifest: {
      id: 'skill.watch',
      kind: 'skill',
      title: 'Watch prices, stock and pages',
    },
    async setup(ctx) {
      const store = new WatchStore(ctx.kv, ctx.log);
      await store.load();
      const texts = watchTexts(ctx.assistant.language);
      const currency = homeCurrency(ctx);
      const timeZone = ctx.assistant.timezone;
      const deps = { ctx, store, texts, currency };

      ctx.registerTool(watchAddTool({ ...deps, timeZone }));
      ctx.registerTool(watchListTool({ ...deps, timeZone }));
      ctx.registerTool(watchRemoveTool(deps));
      ctx.registerTool(watchCheckTool({ ...deps, timeZone }));

      ctx.scheduler.add({
        name: SWEEP_JOB,
        schedule: { kind: 'every', seconds: SWEEP_SECONDS },
        run: async (now) => {
          await sweepWatches({ ...deps, now });
        },
      });
    },
  };
}
