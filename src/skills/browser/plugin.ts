import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { z } from 'zod';
import { BackgroundTasks } from '../work/background.js';
import { autoAuthSchema } from './auto-auth.js';
import { LiveHub } from './live-hub.js';
import { browserTexts } from './locale.js';
import { browserOpenTool } from './tool-open.js';
import { browserReadTool } from './tool-read.js';
import { browserTaskTool } from './tool-task.js';

const configSchema = z.object({ autoAuth: autoAuthSchema.default(autoAuthSchema.parse({})) });

export interface BrowserSkillOptions {
  /** Called with each finished background task's raw output (tests). */
  onSettled?: (workId: string, output: unknown) => void;
}

/** Browser errands on the owner's own browser. It stops at logins, payments and consent screens. */
export function browserSkill(options: BrowserSkillOptions = {}): Plugin {
  return {
    manifest: {
      id: 'skill.browser',
      kind: 'skill',
      title: 'Browser errands',
      needs: [Contracts.browser],
    },
    async setup(ctx) {
      const parsed = configSchema.safeParse(ctx.config);
      if (!parsed.success) ctx.log.warn('browser: invalid autoAuth config, auto-auth stays off');
      const autoAuth = parsed.success ? parsed.data.autoAuth : undefined;
      const agent = ctx.use(Contracts.browser);
      // the owner's own taps from the app, on a page a handoff left; only adapters that can draw a page offer it
      const live =
        agent.openLive !== undefined
          ? new LiveHub({ agent, clock: ctx.clock, log: ctx.log, killSwitch: () => ctx.tryUse(Contracts.killSwitch) })
          : undefined;
      if (live !== undefined) {
        ctx.provide(Contracts.browserLive, live);
        ctx.bus.on('app.stopping', () => live.shutdown());
      }
      // one queue per browser: errands on the same browser wait their turn too
      const tasks = new BackgroundTasks({
        ctx,
        kind: 'browser',
        noticeKind: 'browser.task',
        laneKey: agent,
        ...(live !== undefined ? { handoff: () => live } : {}),
        ...(options.onSettled !== undefined ? { onSettled: options.onSettled } : {}),
      });
      await tasks.load();
      const deps = {
        ctx,
        agent,
        tasks,
        texts: browserTexts(ctx.assistant.language),
        ...(autoAuth?.enabled === true ? { autoAuth } : {}),
        ...(live !== undefined ? { live } : {}),
      };
      ctx.registerTool(browserReadTool(deps));
      ctx.registerTool(browserTaskTool(deps));
      ctx.registerTool(browserOpenTool(deps));
    },
  };
}
