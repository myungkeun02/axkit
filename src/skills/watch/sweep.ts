import type { CheckDeps } from './check.js';
import { performCheck } from './check.js';
import type { Watch } from './types.js';

export const SWEEP_JOB = 'watch.sweep';
export const SWEEP_SECONDS = 900;
const MAX_PER_SWEEP = 5;

function isDue(watch: Watch, now: Date): boolean {
  const at = Date.parse(watch.nextAt);
  return Number.isNaN(at) || at <= now.getTime();
}

/** Runs due checks one after another, at most five per sweep. */
export async function sweepWatches(deps: CheckDeps): Promise<number> {
  const due = deps.store
    .all()
    .filter((watch) => isDue(watch, deps.now))
    .sort((a, b) => a.nextAt.localeCompare(b.nextAt))
    .slice(0, MAX_PER_SWEEP);

  for (const watch of due) {
    await performCheck(deps, watch);
  }
  return due.length;
}
