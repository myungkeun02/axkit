import type { Plugin } from '../../core/plugin/types.js';
import { registerTripChecklist } from './checklist.js';
import { readTripConfig } from './config.js';
import type { TripDeps } from './deps.js';
import { tripTexts } from './locale.js';
import { registerTripScan } from './scan.js';
import { TripStore } from './store.js';
import { tripsAddTool, tripsRemoveTool } from './tools-edit.js';
import { tripsListTool, tripsShowTool } from './tools-list.js';

/** Trip skill: booking mails become itineraries, D-3/D-1 checklists and lookup tools. */
export function tripSkill(): Plugin {
  return {
    manifest: {
      id: 'skill.trip',
      kind: 'skill',
      title: 'Trips',
    },
    async setup(ctx) {
      const config = readTripConfig(ctx);
      const texts = tripTexts(ctx.assistant.language);
      const store = new TripStore(ctx.kv);
      await store.load();

      const deps: TripDeps = { store, texts, timeZone: ctx.assistant.timezone };
      const toolDeps = { ...deps, now: () => ctx.clock.now() };
      ctx.registerTool(tripsListTool(toolDeps));
      ctx.registerTool(tripsShowTool(toolDeps));
      ctx.registerTool(tripsAddTool(toolDeps));
      ctx.registerTool(tripsRemoveTool(toolDeps));

      registerTripChecklist(ctx, { ...deps, remindDays: config.remindDays }, config.checklistAt);
      if (config.scan) registerTripScan(ctx, deps, config.scanSeconds);
    },
  };
}
