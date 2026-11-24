import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { registerRoutine } from './run.js';
import { runDueFollowUps } from './followups.js';
import type { RoutineDeps } from './run.js';
import { FollowUpStore, RoutineStore } from './store.js';
import { followUpTool, routineTools } from './tools.js';
import { routinesView } from './view.js';

/** How often due follow-ups are picked up. */
const FOLLOW_UP_CHECK_SECONDS = 300;

/**
 * Standing orders: the owner says "매일 아침 9시에 X 해줘" and it happens. Each routine is one scheduler job that runs
 * an assistant (or bot, or team) turn with the owner's words, through the same tools, cards and kill switch.
 */
export function routinesSkill(): Plugin {
  return {
    manifest: { id: 'skill.routines', kind: 'skill', title: 'Routines' },
    async setup(ctx) {
      const deps: RoutineDeps = {
        ctx,
        store: new RoutineStore(ctx.kv),
        followUps: new FollowUpStore(ctx.kv),
        korean: ctx.assistant.language !== 'en',
      };
      const registered = new Set<string>();
      for (const routine of await deps.store.live()) registerRoutine(deps, registered, routine);
      for (const tool of routineTools(deps, registered)) ctx.registerTool(tool);
      ctx.registerTool(followUpTool(deps));
      ctx.scheduler.add({
        name: 'routines.followups',
        label: deps.korean ? '봇 후속 확인' : 'Bot follow-ups',
        schedule: { kind: 'every', seconds: FOLLOW_UP_CHECK_SECONDS },
        run: () => runDueFollowUps(deps),
      });
      ctx.bus.on('app.started', () => {
        const views = ctx.tryUse(Contracts.appViews);
        views?.register(routinesView(deps));
        views?.addFeature?.('routines');
      });
    },
  };
}
