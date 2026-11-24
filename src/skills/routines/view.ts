import { z } from 'zod';
import type { AppView } from '../../core/contracts/device-api.js';
import { ViewInputError } from '../../core/contracts/device-api.js';
import { Contracts } from '../../core/contracts/index.js';
import type { RoutineDeps } from './run.js';
import { scheduleLabel } from './schedule.js';
import { MAX_ROUTINES } from './store.js';
import { removeRoutine, setEnabled } from './tools.js';

const toggleSchema = z.object({ id: z.string().min(1).max(40), enabled: z.boolean() });
const removeSchema = z.object({ id: z.string().min(1).max(40) });

/** `views/routines`: the owner's routines, with plain schedule labels; toggle and remove are reversible edits. */
export function routinesView(deps: RoutineDeps): AppView {
  const { ctx, store, followUps, korean } = deps;
  return {
    name: 'routines',
    version: 1,
    async read() {
      const bots = new Map(((await ctx.tryUse(Contracts.bots)?.list().catch(() => [])) ?? []).map((bot) => [bot.id, bot.name]));
      const routines = (await store.live()).map((routine) => ({
        id: routine.id,
        title: routine.title,
        instruction: routine.instruction,
        schedule: routine.schedule,
        scheduleLabel: scheduleLabel(routine.schedule, korean),
        ...(routine.bot !== undefined ? { bot: { id: routine.bot, name: bots.get(routine.bot) ?? routine.bot } } : {}),
        enabled: routine.enabled,
        createdAt: routine.createdAt,
        ...(routine.lastRun !== undefined ? { lastRun: routine.lastRun } : {}),
        ...(routine.lastResult !== undefined ? { lastResult: routine.lastResult } : {}),
        ...(routine.lastOk !== undefined ? { lastOk: routine.lastOk } : {}),
      }));
      const pending = (await followUps.all()).map((item) => ({ bot: { id: item.bot, name: bots.get(item.bot) ?? item.bot }, what: item.what, dueAt: item.dueAt }));
      return { routines, followUps: pending, limit: MAX_ROUTINES };
    },
    actions: {
      async toggle(body) {
        const parsed = toggleSchema.safeParse(body);
        if (!parsed.success) throw new ViewInputError('id, enabled');
        const updated = await setEnabled(deps, parsed.data.id, parsed.data.enabled);
        if (updated === undefined) throw new ViewInputError('id');
        return { id: updated.id, enabled: updated.enabled };
      },
      async remove(body) {
        const parsed = removeSchema.safeParse(body);
        if (!parsed.success) throw new ViewInputError('id');
        const removed = await removeRoutine(deps, parsed.data.id);
        if (removed === undefined) throw new ViewInputError('id');
        return { id: removed.id, removed: true };
      },
    },
  };
}
