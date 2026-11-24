import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BOT_ID } from '../../core/contracts/bots.js';
import { Contracts } from '../../core/contracts/index.js';
import type { Tool } from '../../core/tools/types.js';
import { jobName, registerRoutine } from './run.js';
import type { RoutineDeps } from './run.js';
import { scheduleInput, scheduleLabel } from './schedule.js';
import { MAX_ROUTINES, isLive } from './store.js';
import type { Routine } from './store.js';

const ROUTINE_ID = /^[a-z0-9]{6,16}$/;
const MAX_FOLLOW_HOURS = 72;

const addInput = z.object({
  title: z.string().trim().min(1).max(60).describe('Short name the owner sees, e.g. "아침 메일 정리".'),
  instruction: z.string().trim().min(1).max(1000).describe("What to do each time, in the owner's own words, complete enough to do alone."),
  schedule: scheduleInput.describe(
    'One of {"kind":"daily","at":"09:00"}, {"kind":"weekly","day":"mon","at":"09:00"} (day: mon..sun), {"kind":"every","hours":3} (1-24). Times are 24h in the owner\'s time zone.',
  ),
  bot: z.string().regex(BOT_ID).optional().describe('Bot id when a specialist bot (or its team) should do it.'),
});

export interface RoutineView {
  id: string;
  title: string;
  schedule: string;
  bot?: string;
  enabled: boolean;
  lastRun?: string;
  lastResult?: string;
}

function brief(routine: Routine, korean: boolean): RoutineView {
  return {
    id: routine.id,
    title: routine.title,
    schedule: scheduleLabel(routine.schedule, korean),
    ...(routine.bot !== undefined ? { bot: routine.bot } : {}),
    enabled: routine.enabled,
    ...(routine.lastRun !== undefined ? { lastRun: routine.lastRun } : {}),
    ...(routine.lastResult !== undefined ? { lastResult: routine.lastResult.slice(0, 200) } : {}),
  };
}

export function routineTools(deps: RoutineDeps, registered: Set<string>): Tool[] {
  const { ctx, store, korean } = deps;
  const add: Tool<z.infer<typeof addInput>, RoutineView> = {
    name: 'routines.add',
    description: 'Set up a routine: something the owner wants done again and again on a schedule ("매일 아침 9시에 X 해줘").',
    input: addInput,
    effects: ['write'],
    describe: (value) => `${korean ? '루틴 추가' : 'Add routine'}: ${value.title} (${scheduleLabel(value.schedule, korean)})`,
    async run(value) {
      if (value.bot !== undefined) {
        const bot = await ctx.tryUse(Contracts.bots)?.get(value.bot);
        if (bot === undefined || bot.status === 'off') throw new Error(`No active bot "${value.bot}"`);
      }
      const routine = await store.edit((routines) => {
        if (routines.filter(isLive).length >= MAX_ROUTINES) throw new Error(`At most ${MAX_ROUTINES} routines; remove one first`);
        const made: Routine = {
          id: randomUUID().replace(/-/g, '').slice(0, 10),
          title: value.title,
          instruction: value.instruction,
          schedule: value.schedule,
          ...(value.bot !== undefined ? { bot: value.bot } : {}),
          enabled: true,
          createdAt: ctx.clock.now().toISOString(),
        };
        routines.push(made);
        return made;
      });
      registerRoutine(deps, registered, routine);
      return brief(routine, korean);
    },
  };
  const list: Tool<object, { routines: RoutineView[]; limit: number }> = {
    name: 'routines.list',
    description: "List the owner's routines with their schedule and last result.",
    input: z.object({}),
    effects: ['read'],
    async run() {
      return { routines: (await store.live()).map((routine) => brief(routine, korean)), limit: MAX_ROUTINES };
    },
  };
  const pauseInput = z.object({ id: z.string().regex(ROUTINE_ID), paused: z.boolean().default(true).describe('false turns it back on.') });
  const pause: Tool<z.infer<typeof pauseInput>, RoutineView> = {
    name: 'routines.pause',
    description: 'Pause a routine (or turn it back on with paused=false).',
    input: pauseInput,
    effects: ['write'],
    describe: (value) => `${value.paused ? (korean ? '루틴 멈춤' : 'Pause routine') : korean ? '루틴 다시 켬' : 'Resume routine'}: ${value.id}`,
    async run(value) {
      const updated = await setEnabled(deps, value.id, !value.paused);
      if (updated === undefined) throw new Error(`No routine "${value.id}"`);
      return brief(updated, korean);
    },
  };
  const removeInput = z.object({ id: z.string().regex(ROUTINE_ID) });
  const remove: Tool<z.infer<typeof removeInput>, { removed: string }> = {
    name: 'routines.remove',
    description: 'Remove a routine for good (it stops running).',
    input: removeInput,
    effects: ['write'],
    describe: (value) => `${korean ? '루틴 삭제' : 'Remove routine'}: ${value.id}`,
    async run(value) {
      const removed = await removeRoutine(deps, value.id);
      if (removed === undefined) throw new Error(`No routine "${value.id}"`);
      return { removed: removed.title };
    },
  };
  return [add, list, pause, remove] as Tool[];
}

export async function setEnabled(deps: RoutineDeps, id: string, enabled: boolean): Promise<Routine | undefined> {
  return await deps.store.update(id, (routine) => {
    routine.enabled = enabled;
    // turning it back on starts the failure count over
    if (enabled) routine.failures = 0;
  });
}

export async function removeRoutine(deps: RoutineDeps, id: string): Promise<Routine | undefined> {
  const removed = await deps.store.update(id, (routine) => {
    routine.enabled = false;
    routine.removedAt = deps.ctx.clock.now().toISOString();
  });
  // off the jobs screen and the timers now, not at the next restart
  if (removed !== undefined) deps.ctx.scheduler.remove?.(jobName(id));
  return removed;
}

const followInput = z.object({
  bot: z.string().regex(BOT_ID).describe('Your own bot id.'),
  what: z.string().trim().min(1).max(300).describe('What is still pending and what to check, in one sentence.'),
  in_hours: z.number().min(1).max(MAX_FOLLOW_HOURS).describe('When to check again, in hours (1-72).'),
});

/** A bot leaves itself one check for later when its work is waiting on something. */
export function followUpTool(deps: RoutineDeps): Tool<z.infer<typeof followInput>, { bot: string; dueAt: string }> {
  const { ctx, followUps, korean } = deps;
  return {
    name: 'bots.follow_up',
    description: 'When a bot\'s work is still pending (waiting for a reply, a build, a date), schedule one check later: the bot runs again then and reports in its room. One pending check per bot.',
    input: followInput,
    effects: ['write'],
    describe: (value) => `${korean ? `${value.in_hours}시간 뒤 다시 확인` : `Check again in ${value.in_hours} h`}: ${value.what}`,
    async run(value) {
      const bot = await ctx.tryUse(Contracts.bots)?.get(value.bot);
      if (bot === undefined || bot.status === 'off') throw new Error(`No active bot "${value.bot}"`);
      const now = ctx.clock.now();
      const dueAt = new Date(now.getTime() + value.in_hours * 3_600_000).toISOString();
      return await followUps.edit((items) => {
        // the one being run right now (claimed) is about to go: a bot rescheduling its own check is allowed
        if (items.some((item) => item.bot === value.bot && item.claimedAt === undefined)) throw new Error(`${value.bot} already has a pending follow-up`);
        const item = { id: randomUUID().slice(0, 8), bot: value.bot, what: value.what, dueAt, createdAt: now.toISOString() };
        return { items: [...items, item], result: { bot: bot.name, dueAt } };
      });
    },
  };
}
