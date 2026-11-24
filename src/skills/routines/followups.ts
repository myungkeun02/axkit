import type { FollowUp } from './store.js';
import type { RoutineDeps } from './run.js';
import { isOutage, runOnce } from './run.js';

/** A claim older than this belongs to a run that died with the server; the follow-up is due again. */
export const CLAIM_LEASE_MS = 30 * 60_000;
const RETRY_BASE_MS = 10 * 60_000;
const RETRY_MAX_MS = 6 * 3_600_000;
/** Failed attempts (outages not counted) before a follow-up is given up. */
export const MAX_FOLLOW_UP_ATTEMPTS = 5;

/** Wait before the next attempt after `attempts` failures: 10 min, 20, 40 ... up to 6 h. */
export function followUpRetryMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

function claimable(item: FollowUp, now: number): boolean {
  if (Date.parse(item.dueAt) > now) return false;
  return item.claimedAt === undefined || now - Date.parse(item.claimedAt) >= CLAIM_LEASE_MS;
}

/**
 * Runs every follow-up that is due. Each is claimed durably first (so a second tick does not run it twice) and is
 * removed only once its turn ran and the result was posted; a failed one goes back with a later due time, so a crash
 * or a model outage never loses it.
 */
export async function runDueFollowUps(deps: RoutineDeps): Promise<void> {
  const { ctx, followUps, korean } = deps;
  const claimedAt = ctx.clock.now().toISOString();
  const now = Date.parse(claimedAt);
  const due = await followUps.edit((items) => {
    const claimed: FollowUp[] = [];
    const next = items.map((item) => {
      if (!claimable(item, now)) return item;
      const marked = { ...item, claimedAt };
      claimed.push(marked);
      return marked;
    });
    return { items: next, result: claimed };
  });
  for (const item of due) {
    const text = korean
      ? `예전에 남겨 둔 일을 다시 확인해 주세요: ${item.what}\n지금 어떻게 됐는지 짧게 알려 주세요.`
      : `Check again on what you left pending: ${item.what}\nSay briefly where it stands now.`;
    const mine = (other: FollowUp): boolean => other.id === item.id && other.claimedAt === claimedAt;
    try {
      await runOnce(deps, { text, bot: item.bot, source: `followup:${item.id}`, title: `${korean ? '후속 확인' : 'Follow-up'}: ${item.what}` });
      await followUps.edit((items) => ({ items: items.filter((other) => !mine(other)), result: undefined }));
    } catch (error) {
      const outage = isOutage(error);
      ctx.log.warn('routines: follow-up failed; will retry', { bot: item.bot, outage, error: error instanceof Error ? error.message : 'error' });
      await releaseAfterFailure(deps, mine, outage).catch(() => undefined);
    }
  }
}

async function releaseAfterFailure(deps: RoutineDeps, mine: (item: FollowUp) => boolean, outage: boolean): Promise<void> {
  const now = deps.ctx.clock.now().getTime();
  const dropped = await deps.followUps.edit((items) => {
    let gaveUp: FollowUp | undefined;
    const next: FollowUp[] = [];
    for (const item of items) {
      if (!mine(item)) {
        next.push(item);
        continue;
      }
      const attempts = (item.attempts ?? 0) + (outage ? 0 : 1);
      if (attempts >= MAX_FOLLOW_UP_ATTEMPTS) {
        gaveUp = item;
        continue;
      }
      const released: FollowUp = { ...item, attempts, dueAt: new Date(now + followUpRetryMs(Math.max(1, attempts))).toISOString() };
      delete released.claimedAt;
      next.push(released);
    }
    return { items: next, result: gaveUp };
  });
  if (dropped !== undefined) {
    deps.ctx.log.warn('routines: follow-up gave up after repeated failures', { bot: dropped.bot });
  }
}
