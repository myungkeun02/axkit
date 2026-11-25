import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { calendarTexts } from './locale.js';
import { addEventTool } from './tools-add.js';
import { calendarsTool, listEventsTool } from './tools-list.js';

/** Calendar skill: list events and create events over the calendar capabilities. */
export function calendarSkill(): Plugin {
  return {
    manifest: {
      id: 'skill.calendar',
      kind: 'skill',
      title: 'Calendar',
      needs: [Contracts.calendarRead, Contracts.calendarWrite],
    },
    setup(ctx) {
      const deps = {
        reader: ctx.use(Contracts.calendarRead),
        writer: ctx.use(Contracts.calendarWrite),
        now: () => ctx.clock.now(),
        timeZone: ctx.assistant.timezone,
        texts: calendarTexts(ctx.assistant.language),
      };
      ctx.registerTool(listEventsTool(deps));
      ctx.registerTool(addEventTool(deps));
      ctx.registerTool(calendarsTool(deps));
    },
  };
}
