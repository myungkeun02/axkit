import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { wallClock } from '../../core/scheduler/next-run.js';

const KEY = 'coder-runs';
/** Coding runs a day per feature: each can take many minutes of a subscription CLI. */
export const CODER_RUNS_PER_DAY = 24;

/**
 * Whether a coding run (Claude Code / Codex CLI) may start now: not while everything is stopped, not past the AI
 * budget, and at most a day's worth of runs. CLI usage is not metered like API calls, so it is counted here.
 * Returns why not, in plain words, or undefined when it may run (and counts it).
 */
export async function coderGate(ctx: PluginContext, runs = 1): Promise<string | undefined> {
  const stop = await ctx.tryUse(Contracts.killSwitch)?.state().catch(() => ({ stopped: true, reason: 'could not read the stop switch' }));
  if (stop?.stopped === true) return `전체 멈춤이 켜져 있어서 코드 작업을 시작하지 않았어요${stop.reason !== undefined ? ` (${stop.reason})` : ''}. ax-kit resume으로 다시 켤 수 있어요.`;
  if ((await ctx.tryUse(Contracts.llmControl)?.overBudget().catch(() => false)) === true) return '오늘(또는 이번 달) AI 예산을 다 써서 코드 작업을 시작하지 않았어요.';
  const wall = wallClock(ctx.clock.now(), ctx.assistant.timezone);
  const day = `${wall.y}-${wall.m}-${wall.d}`;
  const stored = (await ctx.kv.get<{ day: string; count: number }>(KEY)) ?? { day, count: 0 };
  const count = stored.day === day ? stored.count : 0;
  if (count + runs > CODER_RUNS_PER_DAY) return `오늘 코드 작업을 ${CODER_RUNS_PER_DAY}번 해서 내일 이어서 할게요.`;
  await ctx.kv.set(KEY, { day, count: count + runs });
  return undefined;
}
