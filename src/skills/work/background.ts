import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrowserLiveHub, WorkItem, WorkStatus } from '../../core/contracts/index.js';
import { isActiveWork } from '../../core/contracts/index.js';
import type { ConversationRef, LiveHandoff } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { HandoffEnd } from './handoff.js';
import { handoffSettled } from './handoff.js';
import { Lane, sharedLane } from './lane.js';
import { mirrorWork, notifyOwner } from './report.js';
import { trimFinished } from './retention.js';
import type { WorkTexts } from './texts.js';
import { workTexts } from './texts.js';

const KEY = 'tasks';
const MAX_RECORDS = 30;
/** Running plus queued; past this new work is refused instead of pushing records out. */
const MAX_UNFINISHED = 20;

const originSchema = z.object({ channelId: z.string(), address: z.string() });
const recordSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  title: z.string(),
  status: z.enum(['queued', 'running', 'waiting', 'done', 'failed', 'interrupted']),
  phase: z.string().optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
  origin: originSchema.optional(),
  summary: z.string().optional(),
  link: z.string().optional(),
  /** The owner was told this one was interrupted by a restart. */
  told: z.boolean().optional(),
});
export type TaskRecord = z.infer<typeof recordSchema>;

/** What the owner hears when a task ends. */
export interface TaskOutcome {
  status: 'done' | 'failed' | 'waiting';
  text: string;
  link?: string;
  live?: LiveHandoff;
}

export interface TaskSpec<O> {
  title: string;
  origin?: ConversationRef;
  /** Hard limit for the background run. */
  timeoutMs: number;
  run(signal: AbortSignal): Promise<O>;
  outcome(output: O): TaskOutcome;
  failure(error: unknown): TaskOutcome;
  /** The starting turn's after-reply hook: the result waits for it, so it never arrives before "시작했어요". */
  afterTurn?: (work: () => Promise<void>) => void;
}

export interface StartedTask {
  workId: string;
  status: 'running' | 'queued';
  ahead: number;
  message: string;
}

export interface BackgroundOptions {
  ctx: PluginContext;
  /** "browser", "errand": the work kind and the id prefix. */
  kind: string;
  /** Notifier kind for results, e.g. "browser.task". */
  noticeKind: string;
  /** Tasks sharing a key share one queue across plugins (the one browser). */
  laneKey?: object;
  /**
   * The live page hub, when a `waiting` outcome may leave a page for the owner (`live`). The lane stays reserved
   * until that handoff is finished, goes stale or is stopped, so the next task cannot release the kept page.
   */
  handoff?: () => BrowserLiveHub | undefined;
  /** Called with each finished task's raw output (tests, and producers that keep more state). */
  onSettled?: (workId: string, output: unknown) => void;
}

/**
 * Long tasks the owner asked for, off the conversation turn: start, acknowledge right away, run one at a time, report
 * through the notifier. Records persist, so a restart turns what was running or queued into "interrupted" and the
 * owner hears about it once.
 */
export class BackgroundTasks {
  private readonly turnDone = new Map<string, Promise<void>>();
  private items: TaskRecord[] = [];
  private readonly lane: Lane;
  private readonly controllers = new Map<string, AbortController>();
  private stopping = false;
  readonly texts: WorkTexts;

  constructor(private readonly opts: BackgroundOptions) {
    this.lane = opts.laneKey !== undefined ? sharedLane(opts.laneKey) : new Lane();
    this.texts = workTexts(opts.ctx.assistant.language);
  }

  /** Reads the records, marks the unfinished ones interrupted and arms the one-time restart notice. */
  async load(): Promise<void> {
    const raw = await this.opts.ctx.kv.get<unknown>(KEY);
    const parsed = Array.isArray(raw) ? raw.flatMap((entry) => {
      const result = recordSchema.safeParse(entry);
      return result.success ? [result.data] : [];
    }) : [];
    const now = this.now();
    this.items = parsed.map((item) =>
      isActiveWork(item.status) && item.status !== 'waiting'
        ? { ...item, status: 'interrupted' as const, updatedAt: now, told: false }
        : item,
    );
    trimFinished(this.items, MAX_RECORDS, (item) => isActiveWork(item.status));
    await this.persist();
    this.opts.ctx.bus.on('app.started', () => this.tellInterrupted());
    this.opts.ctx.bus.on('app.stopping', () => {
      this.stopping = true;
      for (const controller of this.controllers.values()) controller.abort();
    });
  }

  all(): readonly TaskRecord[] {
    return this.items;
  }

  idle(): Promise<void> {
    return this.lane.idle();
  }

  async start<O>(spec: TaskSpec<O>): Promise<StartedTask> {
    const unfinished = this.items.filter((item) => item.status === 'running' || item.status === 'queued').length;
    if (unfinished >= MAX_UNFINISHED) throw new Error(this.texts.queueFull(unfinished));
    const id = `${this.opts.kind}_${randomUUID().slice(0, 8)}`;
    const now = this.now();
    const queued = this.lane.ahead > 0;
    const record: TaskRecord = {
      id,
      kind: this.opts.kind,
      title: spec.title,
      status: queued ? 'queued' : 'running',
      startedAt: now,
      updatedAt: now,
      ...(spec.origin !== undefined ? { origin: { channelId: spec.origin.channelId, address: spec.origin.address } } : {}),
    };
    await this.save(record);
    const turnDone = spec.afterTurn === undefined ? Promise.resolve() : new Promise<void>((resolve) => spec.afterTurn?.(async () => resolve()));
    this.turnDone.set(id, turnDone);
    const ahead = this.lane.enqueue(() => this.execute(id, spec));
    return {
      workId: id,
      status: ahead > 0 ? 'queued' : 'running',
      ahead,
      message:
        ahead === 0 ? this.texts.started(id) : this.lane.holdingForOwner ? this.texts.queuedBehindOwner(id) : this.texts.queued(id, ahead),
    };
  }

  private async execute<O>(id: string, spec: TaskSpec<O>): Promise<void> {
    const current = this.items.find((item) => item.id === id);
    if (current === undefined || this.stopping) return;
    await this.save({ ...current, status: 'running', updatedAt: this.now() });
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const timer = this.opts.ctx.clock.setTimeout(() => controller.abort(new Error('timed out')), spec.timeoutMs);
    let outcome: TaskOutcome;
    let output: unknown;
    try {
      output = await spec.run(controller.signal);
      // an adapter that resolves on abort: still a shutdown, not a failure
      if (this.stopping) return;
      outcome = spec.outcome(output as O);
    } catch (error) {
      // a shutdown leaves the record running; the next start marks it interrupted and tells the owner
      if (this.stopping) return;
      output = error;
      this.opts.ctx.log.warn('work: task failed', { id, title: current.title, error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300) });
      outcome = spec.failure(error);
    } finally {
      this.opts.ctx.clock.clearTimeout(timer);
      this.controllers.delete(id);
    }
    const latest = this.items.find((item) => item.id === id) ?? current;
    await this.save({
      ...latest,
      status: outcome.status,
      updatedAt: this.now(),
      summary: outcome.text.slice(0, 600),
      ...(outcome.link !== undefined ? { link: outcome.link } : {}),
    });
    const hub = outcome.status === 'waiting' && outcome.live !== undefined ? this.opts.handoff?.() : undefined;
    const holds = hub !== undefined && hub.state().pending !== undefined;
    const others = holds && this.lane.queued > 0 ? `\n\n${this.texts.othersWaiting(this.lane.queued)}` : '';
    // the turn that started it answers first ("시작했어요"); then the result
    await this.turnDone.get(id);
    this.turnDone.delete(id);
    await notifyOwner(this.opts.ctx, {
      kind: this.opts.noticeKind,
      text: `${outcome.text}${others}`,
      dedupeKey: `${id}:${outcome.status}`,
      ...(outcome.live !== undefined ? { live: outcome.live } : {}),
    });
    this.opts.onSettled?.(id, output);
    if (holds) await this.holdForOwner(id, hub);
  }

  /** Keeps the browser for the page handed to the owner; the queue goes on once that handoff is over. */
  private async holdForOwner(id: string, hub: BrowserLiveHub): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.lane.holdingForOwner = true;
    let end: HandoffEnd;
    try {
      end = await handoffSettled(hub, this.opts.ctx.clock, controller.signal);
    } finally {
      this.lane.holdingForOwner = false;
      this.controllers.delete(id);
    }
    // at shutdown the record stays "waiting"; the page is gone after a restart anyway
    if (this.stopping) return;
    const latest = this.items.find((item) => item.id === id);
    if (latest === undefined || latest.status !== 'waiting') return;
    const summary = end === 'done' ? {} : { summary: end === 'expired' ? this.texts.handoffExpired : this.texts.handoffCancelled };
    await this.save({ ...latest, status: end === 'done' ? 'done' : 'failed', updatedAt: this.now(), ...summary });
  }

  private async tellInterrupted(): Promise<void> {
    for (const item of this.items.filter((candidate) => candidate.status === 'interrupted' && candidate.told === false)) {
      await notifyOwner(this.opts.ctx, {
        kind: 'work.interrupted',
        text: this.texts.interrupted(item.title, undefined),
        dedupeKey: item.id,
      });
      await this.save({ ...item, told: true });
    }
  }

  private async save(record: TaskRecord): Promise<void> {
    const index = this.items.findIndex((item) => item.id === record.id);
    if (index >= 0) this.items[index] = record;
    else this.items.unshift(record);
    trimFinished(this.items, MAX_RECORDS, (item) => isActiveWork(item.status));
    await this.persist();
    await mirrorWork(this.opts.ctx, workItemOf(record));
  }

  private persist(): Promise<void> {
    return this.opts.ctx.kv.set(KEY, this.items);
  }

  private now(): string {
    return this.opts.ctx.clock.now().toISOString();
  }
}

export function workItemOf(record: TaskRecord): WorkItem {
  const status: WorkStatus = record.status;
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.phase !== undefined ? { phase: record.phase } : {}),
    ...(record.origin !== undefined ? { origin: record.origin } : {}),
    ...(record.summary !== undefined ? { summary: record.summary } : {}),
    ...(record.link !== undefined ? { link: record.link } : {}),
  };
}
