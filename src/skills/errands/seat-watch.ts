import { Contracts } from '../../core/contracts/index.js';
import type { Logger } from '../../core/log/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import { TRAIN_SITES, seatCheckGoal } from './goals.js';
import { reportDetails, saysYes } from './report.js';
import type { ErrandDeps } from './run.js';
import type { SeatWatch } from './types.js';
import { MAX_SEAT_WATCHES, MIN_SEAT_WATCH_MINUTES, seatWatchSchema } from './types.js';

const KEY = 'seat-watches';
export const SEAT_SWEEP_JOB = 'errands.seat-watch';
/** The job wakes every 5 minutes; each watch still waits its own ≥10 minutes, and one check runs per wake. */
export const SEAT_SWEEP_SECONDS = 300;
/** Never two checks closer than this, whatever the schedule does (a restart, a manual run). */
export const MIN_GAP_MS = 5 * 60_000;
const MAX_FAILURES = 3;

export class SeatWatchStore {
  private items: SeatWatch[] = [];

  constructor(
    private readonly kv: KeyValueStore,
    private readonly log: Logger,
  ) {}

  async load(): Promise<void> {
    const raw = await this.kv.get<unknown>(KEY);
    this.items = [];
    if (!Array.isArray(raw)) return;
    for (const candidate of raw) {
      const parsed = seatWatchSchema.safeParse(candidate);
      if (parsed.success) this.items.push(parsed.data);
      else this.log.warn('errands: dropping an unreadable seat watch');
    }
    this.items = this.items.slice(0, MAX_SEAT_WATCHES);
  }

  all(): readonly SeatWatch[] {
    return this.items;
  }

  async add(watch: SeatWatch): Promise<boolean> {
    if (this.items.length >= MAX_SEAT_WATCHES) return false;
    this.items.push(watch);
    await this.persist();
    return true;
  }

  async update(watch: SeatWatch): Promise<void> {
    const index = this.items.findIndex((item) => item.id === watch.id);
    if (index < 0) return;
    this.items[index] = watch;
    await this.persist();
  }

  async remove(id: string): Promise<SeatWatch | undefined> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const [removed] = this.items.splice(index, 1);
    await this.persist();
    return removed;
  }

  private persist(): Promise<void> {
    return this.kv.set(KEY, this.items);
  }
}

export interface SweepDeps extends ErrandDeps {
  store: SeatWatchStore;
  /** When the last check started (in memory); guards the minimum gap. */
  lastCheck: { at: number | undefined };
}

async function notify(deps: SweepDeps, kind: string, text: string, dedupeKey: string, urgent = false): Promise<void> {
  const notifier = deps.ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) return;
  try {
    await notifier.notify({ kind, text, dedupeKey, ...(urgent ? { urgent } : {}) });
  } catch (error) {
    deps.ctx.log.warn('errands: notice failed', { kind, error: error instanceof Error ? error.name : 'error' });
  }
}

async function stopped(deps: SweepDeps): Promise<boolean> {
  const kill = deps.ctx.tryUse(Contracts.killSwitch);
  if (kill === undefined) return false;
  try {
    return (await kill.state()).stopped;
  } catch {
    return true;
  }
}

const at = (now: Date, minutes: number): string => new Date(now.getTime() + minutes * 60_000).toISOString();

/**
 * One wake of the seat watch: ends watches past their end, then checks at most one due watch with a read-only
 * search. A seat only notifies (the owner books through errands.train); a login or robot check ends the watch.
 */
export async function sweepSeatWatches(deps: SweepDeps, now: Date): Promise<'checked' | 'idle'> {
  for (const watch of [...deps.store.all()]) {
    if (Date.parse(watch.endsAt) > now.getTime()) continue;
    await deps.store.remove(watch.id);
    await notify(deps, 'errands.seat_watch', deps.texts.watchEnded(watch), `${watch.id}:ended`);
  }
  if (await stopped(deps)) return 'idle';
  if (deps.lastCheck.at !== undefined && now.getTime() - deps.lastCheck.at < MIN_GAP_MS) return 'idle';
  const due = deps.store
    .all()
    .filter((watch) => Date.parse(watch.nextAt) <= now.getTime())
    .sort((a, b) => a.nextAt.localeCompare(b.nextAt))[0];
  if (due === undefined) return 'idle';
  // the owner's own live page holds the browser: wait for the next wake instead of competing for it
  if (deps.ctx.tryUse(Contracts.browserLive)?.state().live === true) return 'idle';

  deps.lastCheck.at = now.getTime();
  // the next time is written before the check, so a crash or a slow run never makes checks closer together
  const every = Math.max(MIN_SEAT_WATCH_MINUTES, due.everyMinutes);
  const scheduled: SeatWatch = { ...due, nextAt: at(now, every), lastCheckedAt: now.toISOString() };
  await deps.store.update(scheduled);
  await checkOne(deps, scheduled, now, every);
  return 'checked';
}

async function checkOne(deps: SweepDeps, watch: SeatWatch, now: Date, every: number): Promise<void> {
  let result;
  try {
    result = await deps.agent.run({ goal: seatCheckGoal(watch.train), startUrl: TRAIN_SITES[watch.train.operator] });
  } catch {
    result = { status: 'failed' as const, summary: '' };
  }
  if (result.status === 'needs_human') {
    // a login, captcha or queue is never worked around: the watch ends here
    await deps.store.remove(watch.id);
    await notify(deps, 'errands.seat_watch', deps.texts.watchBlocked(watch), `${watch.id}:blocked`);
    return;
  }
  if (result.status === 'failed') {
    const failures = watch.failures + 1;
    if (failures >= MAX_FAILURES) {
      await deps.store.remove(watch.id);
      await notify(deps, 'errands.seat_watch', deps.texts.watchFailing(watch), `${watch.id}:failing`);
      return;
    }
    await deps.store.update({ ...watch, failures, nextAt: at(now, Math.min(every * 2 ** failures, 120)) });
    return;
  }
  const details = reportDetails(result.summary);
  if (saysYes(details['SEATS'])) {
    await deps.store.remove(watch.id);
    await notify(deps, 'errands.seat', deps.texts.watchFound(watch, details), `${watch.id}:found`, true);
    return;
  }
  if (watch.failures > 0) await deps.store.update({ ...watch, failures: 0 });
}
