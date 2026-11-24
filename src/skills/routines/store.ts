import type { KeyValueStore } from '../../core/store/types.js';
import type { RoutineSchedule } from './schedule.js';

export const MAX_ROUTINES = 30;
const MAX_TOMBSTONES = 50;
const KEY = 'routines';

export interface Routine {
  id: string;
  title: string;
  instruction: string;
  schedule: RoutineSchedule;
  bot?: string;
  enabled: boolean;
  /** ISO 8601. */
  createdAt: string;
  lastRun?: string;
  lastResult?: string;
  lastOk?: boolean;
  /** Failed runs in a row; three pause the routine. */
  failures?: number;
  /** Set by `routines.remove`: kept as a tombstone, never run again. */
  removedAt?: string;
}

export const isLive = (routine: Routine): boolean => routine.removedAt === undefined;

/** All routines in one kv entry; writes are queued so two quick edits never lose each other. */
export class RoutineStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: KeyValueStore) {}

  async all(): Promise<Routine[]> {
    return (await this.kv.get<Routine[]>(KEY)) ?? [];
  }

  async live(): Promise<Routine[]> {
    return (await this.all()).filter(isLive);
  }

  async get(id: string): Promise<Routine | undefined> {
    return (await this.all()).find((routine) => routine.id === id);
  }

  /** Applies `change` to the list and saves it; `change` may throw to refuse. */
  edit<T>(change: (routines: Routine[]) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const routines = await this.all();
      const result = change(routines);
      const dead = routines.filter((routine) => !isLive(routine));
      const drop = new Set(dead.slice(0, Math.max(0, dead.length - MAX_TOMBSTONES)));
      await this.kv.set(KEY, routines.filter((routine) => !drop.has(routine)));
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Changes one live routine; undefined when there is none with that id. */
  async update(id: string, patch: (routine: Routine) => void): Promise<Routine | undefined> {
    return await this.edit((routines) => {
      const found = routines.find((routine) => routine.id === id && isLive(routine));
      if (found !== undefined) patch(found);
      return found === undefined ? undefined : { ...found };
    });
  }
}

export interface FollowUp {
  id: string;
  bot: string;
  what: string;
  /** ISO 8601. */
  dueAt: string;
  createdAt: string;
  /** ISO 8601; set while a run has it, so another tick leaves it alone. A stale claim (crash) is picked up again. */
  claimedAt?: string;
  /** Failed runs so far (AI outages not counted); each pushes `dueAt` further out. */
  attempts?: number;
}

const FOLLOW_KEY = 'followups';

/** One-shot checks a bot asked for; at most one pending per bot. */
export class FollowUpStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: KeyValueStore) {}

  async all(): Promise<FollowUp[]> {
    return (await this.kv.get<FollowUp[]>(FOLLOW_KEY)) ?? [];
  }

  edit<T>(change: (items: FollowUp[]) => { items: FollowUp[]; result: T }): Promise<T> {
    const next = this.queue.then(async () => {
      const { items, result } = change(await this.all());
      await this.kv.set(FOLLOW_KEY, items);
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
