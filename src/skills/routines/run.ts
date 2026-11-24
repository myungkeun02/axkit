import { Contracts } from '../../core/contracts/index.js';
import type { RunnerResult } from '../../core/contracts/assistant.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { maskForModel } from '../../core/text/mask.js';
import { LlmError } from '../../core/llm/types.js';
import { isTransientNetworkError } from '../../core/scheduler/backoff.js';
import { dueOn, jobSchedule, scheduleLabel } from './schedule.js';
import type { FollowUpStore, Routine, RoutineStore } from './store.js';
import { isLive } from './store.js';

const MAX_FAILURES = 3;
const MAX_RESULT = 500;
const MAX_POST = 1500;

export interface RoutineDeps {
  ctx: PluginContext;
  store: RoutineStore;
  followUps: FollowUpStore;
  korean: boolean;
}

export const jobName = (id: string): string => `routine.${id}`;

/** The AI itself could not run (budget used up, no model, provider down, assistant not up): not the routine's fault. */
export class AiUnavailable extends Error {
  override readonly name = 'AiUnavailable';
}

/** Whether a failed run is an outage of the AI or the network, which must not count toward pausing a routine. */
export function isOutage(error: unknown): boolean {
  if (error instanceof AiUnavailable) return true;
  if (error instanceof LlmError) return error.code === 'over_budget' || error.code === 'no_route' || error.code === 'provider_failed';
  return isTransientNetworkError(error);
}

/** One turn through the assistant (or a bot), posted where the owner reads it. Throws when it could not run. */
export async function runOnce(deps: RoutineDeps, input: { text: string; bot?: string; source: string; title: string }): Promise<RunnerResult> {
  const { ctx, korean } = deps;
  const runner = ctx.tryUse(Contracts.assistantRunner);
  if (runner === undefined) throw new AiUnavailable('the assistant is not running');
  const result = await runner.run({ text: input.text, source: input.source, ...(input.bot !== undefined ? { bot: input.bot } : {}) });
  if (!result.ok) {
    if (result.reason !== undefined && result.reason !== 'invalid_plan') throw new AiUnavailable(result.text);
    throw new Error(result.text);
  }
  const text = result.text.trim().slice(0, MAX_POST);
  if (result.bot !== undefined) {
    await ctx.bus.emit('bots.message', { bot: result.bot, text });
  } else {
    const header = korean ? `[루틴] ${input.title}` : `[Routine] ${input.title}`;
    await ctx
      .tryUse(Contracts.notifier)
      ?.notify({ kind: 'routines.result', text: `${header}\n${text}` })
      .catch(() => undefined);
  }
  await ctx
    .tryUse(Contracts.workLog)
    ?.add({ at: ctx.clock.now(), title: input.title, kind: 'routine', ...(result.bot !== undefined ? { bot: result.bot } : {}), detail: text.slice(0, 300) })
    .catch(() => undefined);
  return result;
}

/**
 * A routine's scheduled run: skipped when paused, removed or not its weekday; three failures in a row pause it.
 * A run that failed because the AI was out (budget, provider down) is recorded but not counted.
 */
export async function runRoutine(deps: RoutineDeps, id: string, due: Date): Promise<void> {
  const { ctx, store, korean } = deps;
  const routine = await store.get(id);
  if (routine === undefined || !isLive(routine) || !routine.enabled) return;
  if (!dueOn(routine.schedule, due, ctx.assistant.timezone)) return;
  try {
    const result = await runOnce(deps, { text: routine.instruction, source: `routine:${id}`, title: routine.title, ...(routine.bot !== undefined ? { bot: routine.bot } : {}) });
    await store.update(id, (r) => {
      r.lastRun = ctx.clock.now().toISOString();
      r.lastResult = result.text.trim().slice(0, MAX_RESULT);
      r.lastOk = true;
      r.failures = 0;
    });
  } catch (error) {
    const message = maskForModel(error instanceof Error ? error.message : String(error)).slice(0, 200);
    const outage = isOutage(error);
    const updated = await store.update(id, (r) => {
      r.lastRun = ctx.clock.now().toISOString();
      r.lastResult = message;
      r.lastOk = false;
      if (outage) return;
      r.failures = (r.failures ?? 0) + 1;
      if (r.failures >= MAX_FAILURES) r.enabled = false;
    });
    if (!outage && updated !== undefined && !updated.enabled) {
      const text = korean
        ? `"${updated.title}" 루틴이 세 번 연속 제대로 되지 않아서 잠시 멈췄어요. 앱의 루틴 화면에서 다시 켤 수 있어요.`
        : `The routine "${updated.title}" failed three times in a row, so I paused it. You can turn it back on in the app.`;
      await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'routines.paused', text, dedupeKey: id }).catch(() => undefined);
    }
    // the scheduler records the failed run too
    throw error;
  }
}

/** Puts a routine on the scheduler once; later runs read the routine fresh, so pause and remove need no re-register. */
export function registerRoutine(deps: RoutineDeps, registered: Set<string>, routine: Routine): void {
  if (registered.has(routine.id) || !isLive(routine)) return;
  registered.add(routine.id);
  deps.ctx.scheduler.add({
    name: jobName(routine.id),
    label: `${deps.korean ? '루틴' : 'Routine'}: ${routine.title} (${scheduleLabel(routine.schedule, deps.korean)})`,
    schedule: jobSchedule(routine.schedule),
    run: (due) => runRoutine(deps, routine.id, due),
  });
}
