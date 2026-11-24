import type { Notice, NoticeDelivered, NoticeMuter, NoticeResult, Notifier, OwnerChannel } from '../contracts/notify.js';
import type { OutgoingMessage } from '../conversation/types.js';
import type { Logger } from '../log/types.js';
import type { Clock } from '../scheduler/types.js';
import type { KeyValueStore } from '../store/types.js';
import { ymdOf } from '../time/local-day.js';
import { NoticeAcceptance } from './acceptance.js';
import { DailyNoticeBudget } from './budget.js';
import { buildDigestMessage, DigestQueue } from './digest.js';
import type { HeldEntry } from './held-queue.js';
import { backoffMs, FOLD_OVER, HeldQueue, isFoldable, MAX_SEND_ATTEMPTS, messageOf, nextWake, planFlush } from './held-queue.js';
import type { QuietHours } from './quiet-window.js';
import { isQuietAt, quietWindowEnd } from './quiet-window.js';
import { KvNoticeStats } from './stats.js';

const MUTED_KEY = 'notify.muted';
const HOUR_MS = 3_600_000;
const DEFAULT_CAP = 6;
const DEFAULT_DAILY_BUDGET = 20;
const DEFAULT_DEDUPE_HOURS = 12;
const DEFAULT_DIGEST_TITLE = (count: number): string => `Notices folded into one (${count})`;
const DEFAULT_OVERNIGHT_TITLE = (count: number): string => `밤사이 소식 ${count}건이에요.`;

export interface QuietNotifierOptions {
  /** Resolved lazily: the channel plugin may start after the notifier. */
  channel: () => OwnerChannel | undefined;
  clock: Clock;
  timeZone: string;
  quietHours?: QuietHours;
  /** Holds the queue and dedupe stamps so a restart does not re-send or lose notices. */
  kv: KeyValueStore;
  log: Logger;
  perKindHourlyCap?: number;
  dedupeHours?: number;
  /** Non-urgent notices delivered or held per day; 0 turns the budget off. */
  dailyBudget?: number;
  /** Text for the one evening message; the app passes the owner's language. */
  digestTitle?: (count: number) => string;
  /** Title of the one message that carries several notices held overnight ("밤사이 소식"). */
  overnightTitle?: (count: number) => string;
  /** Called once a notice (or a folded message) actually reached the owner; the app emits "notice.delivered". */
  onDelivered?: (event: NoticeDelivered) => void | Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every proactive message goes through here: dedupe, per-kind cap, daily budget, quiet hours, then the
 * owner's channel. While quiet, or after a failed send, notices wait in the key-value store and one clock timer
 * retries them; nothing is lost because a channel was briefly down.
 */
export class QuietHoursNotifier implements Notifier, NoticeMuter {
  private readonly cap: number;
  private readonly dailyBudget: number;
  private readonly digestTitle: (count: number) => string;
  private readonly overnightTitle: (count: number) => string;
  private readonly budget: DailyNoticeBudget;
  private readonly digest: DigestQueue;
  private readonly held: HeldQueue;
  private readonly acceptance: NoticeAcceptance;
  readonly stats: KvNoticeStats;
  private timer: unknown;
  private timerAt: number | undefined;
  private stopped = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly opts: QuietNotifierOptions) {
    this.cap = opts.perKindHourlyCap ?? DEFAULT_CAP;
    this.dailyBudget = opts.dailyBudget ?? DEFAULT_DAILY_BUDGET;
    this.digestTitle = opts.digestTitle ?? DEFAULT_DIGEST_TITLE;
    this.overnightTitle = opts.overnightTitle ?? DEFAULT_OVERNIGHT_TITLE;
    this.budget = new DailyNoticeBudget(opts.kv, opts.timeZone);
    this.digest = new DigestQueue(opts.kv);
    this.held = new HeldQueue(opts.kv);
    this.acceptance = new NoticeAcceptance(opts.kv, (opts.dedupeHours ?? DEFAULT_DEDUPE_HOURS) * HOUR_MS);
    this.stats = new KvNoticeStats(opts.kv, opts.timeZone);
  }

  notify(notice: Notice): Promise<NoticeResult> {
    return this.serial(() => this.handle(notice));
  }

  /** Sends everything over the daily budget or hourly cap as one message; during quiet hours the queue waits. */
  flushDigest(): Promise<NoticeResult | 'empty'> {
    return this.serial(() => this.runDigest());
  }

  /** Loads a queue persisted before a restart and either re-arms or flushes it. */
  restore(): Promise<void> {
    return this.serial(() => this.flush());
  }

  async mute(kind: string): Promise<void> {
    const muted = new Set(await this.muted());
    muted.add(kind);
    await this.opts.kv.set(MUTED_KEY, [...muted]);
  }

  async unmute(kind: string): Promise<void> {
    const muted = (await this.muted()).filter((entry) => entry !== kind);
    await this.opts.kv.set(MUTED_KEY, muted);
  }

  async muted(): Promise<readonly string[]> {
    return (await this.opts.kv.get<string[]>(MUTED_KEY)) ?? [];
  }

  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  isQuiet(at: Date): boolean {
    return isQuietAt(this.opts.quietHours, at, this.opts.timeZone);
  }

  private async handle(notice: Notice): Promise<NoticeResult> {
    const now = this.opts.clock.now();
    const nowMs = now.getTime();
    const urgent = notice.urgent === true;
    if (!urgent && (await this.muted()).includes(notice.kind)) {
      await this.stats.count(now, notice.kind, 'dropped');
      return 'dropped';
    }
    if (await this.acceptance.isDuplicate(notice, nowMs)) {
      await this.stats.count(now, notice.kind, 'dropped');
      return 'dropped';
    }
    // A card with buttons is a question waiting for the owner; folding it into text would drop the buttons.
    const foldable = isFoldable(notice);
    const overCap = !(await this.acceptance.underCap(notice, nowMs, this.cap));
    if (overCap && !foldable) {
      // waits out the cap window and then goes intact, buttons and handoff included
      const retryAt = await this.acceptance.capFreesAt(notice.kind, nowMs);
      await this.acceptance.accept(notice, nowMs);
      await this.hold({ notice, attempts: 0, retryAt });
      await this.stats.count(now, notice.kind, 'held');
      return 'held';
    }
    if (overCap || (foldable && (await this.isOverBudget(now)))) {
      await this.acceptance.accept(notice, nowMs);
      await this.digest.push(notice);
      await this.stats.count(now, notice.kind, 'digested');
      if (!overCap) await this.stats.markOverBudget(now);
      return 'held';
    }
    if (!urgent) await this.budget.add(ymdOf(now, this.opts.timeZone));
    await this.acceptance.accept(notice, nowMs);
    if (!urgent && this.isQuiet(now)) {
      await this.hold({ notice, attempts: 0 });
      await this.stats.count(now, notice.kind, 'held');
      return 'held';
    }
    if (await this.send(notice.kind, messageOf(notice), urgent)) {
      await this.delivered(notice.kind, notice.text);
      await this.stats.count(now, notice.kind, 'sent');
      return 'sent';
    }
    // the channel was down: keep it and try again, instead of losing it
    await this.hold({ notice, attempts: 1, retryAt: nowMs + backoffMs(1) });
    await this.stats.count(now, notice.kind, 'held');
    return 'held';
  }

  private async isOverBudget(at: Date): Promise<boolean> {
    if (this.dailyBudget <= 0) return false;
    return (await this.budget.usedAt(at)) >= this.dailyBudget;
  }

  private async hold(entry: HeldEntry): Promise<void> {
    await this.held.push(entry);
    this.rearm(await this.held.all());
  }

  /** True when at least one channel took the message. */
  private async send(kind: string, message: OutgoingMessage, urgent: boolean): Promise<boolean> {
    let channel: OwnerChannel | undefined;
    try {
      channel = this.opts.channel();
    } catch (error) {
      this.opts.log.error('notifier: owner channel could not be resolved', { kind, error: errorMessage(error) });
      return false;
    }
    if (channel === undefined) {
      this.opts.log.warn('notifier: no owner channel is available', { kind });
      return false;
    }
    try {
      await channel.send(message, { kind, ...(urgent ? { urgent: true } : {}) });
    } catch (error) {
      this.opts.log.error('notifier: sending failed', { kind, error: errorMessage(error) });
      return false;
    }
    return true;
  }

  private async delivered(kind: string, text: string): Promise<void> {
    const listener = this.opts.onDelivered;
    if (listener === undefined) return;
    try {
      await listener({ kind, text, at: this.opts.clock.now().toISOString() });
    } catch (error) {
      this.opts.log.warn('notifier: delivered listener failed', { kind, error: errorMessage(error) });
    }
  }

  private async runDigest(): Promise<NoticeResult | 'empty'> {
    const entries = await this.digest.all();
    if (entries.length === 0) return 'empty';
    if (this.isQuiet(this.opts.clock.now())) return 'held';
    const text = buildDigestMessage(this.digestTitle, entries);
    if (!(await this.send('digest', { text }, false))) return 'dropped';
    await this.digest.clear();
    await this.delivered('digest', text);
    return 'sent';
  }

  private async flush(): Promise<void> {
    if (this.stopped) return;
    const entries = await this.held.all();
    if (entries.length === 0) return;
    const now = this.opts.clock.now();
    const plan = planFlush(entries, now.getTime(), this.isQuiet(now));
    for (const entry of plan.expired) await this.stats.count(now, entry.notice.kind, 'dropped');
    const failed: HeldEntry[] = [];
    const folded = plan.due.filter((entry) => isFoldable(entry.notice));
    const fold = folded.length > FOLD_OVER;
    if (fold) {
      const text = buildDigestMessage(this.overnightTitle, folded.map(({ notice }) => notice));
      if (await this.send('overnight', { text }, false)) await this.delivered('overnight', text);
      else failed.push(...folded);
    }
    for (const entry of plan.due) {
      if (fold && isFoldable(entry.notice)) continue;
      const urgent = entry.notice.urgent === true;
      if (await this.send(entry.notice.kind, messageOf(entry.notice), urgent)) await this.delivered(entry.notice.kind, entry.notice.text);
      else failed.push(entry);
    }
    // only what was not delivered stays (flush runs in the serial lane, so nothing was queued meanwhile)
    const remaining = [...plan.waiting, ...failed.flatMap((entry) => this.retryOf(entry, now))];
    await this.held.write(remaining);
    this.rearm(remaining);
  }

  private retryOf(entry: HeldEntry, now: Date): HeldEntry[] {
    const attempts = entry.attempts + 1;
    if (attempts > MAX_SEND_ATTEMPTS) {
      this.opts.log.error('notifier: giving up on a notice after repeated failures', { kind: entry.notice.kind, attempts });
      void this.stats.count(now, entry.notice.kind, 'dropped').catch(() => undefined);
      return [];
    }
    return [{ notice: entry.notice, attempts, retryAt: now.getTime() + backoffMs(attempts) }];
  }

  private rearm(entries: readonly HeldEntry[]): void {
    if (this.stopped) return;
    const now = this.opts.clock.now();
    const quiet = this.opts.quietHours;
    const quietEnd = quiet !== undefined && this.isQuiet(now) ? quietWindowEnd(quiet, now, this.opts.timeZone).getTime() : undefined;
    const wake = nextWake(entries, quietEnd);
    if (wake === undefined) {
      this.disarm();
      return;
    }
    if (this.timer !== undefined && this.timerAt !== undefined && this.timerAt <= wake) return;
    this.disarm();
    this.timerAt = wake;
    this.timer = this.opts.clock.setTimeout(() => {
      this.timer = undefined;
      this.timerAt = undefined;
      void this.serial(() => this.flush());
    }, Math.max(0, wake - now.getTime()));
  }

  private disarm(): void {
    if (this.timer === undefined) return;
    this.opts.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = undefined;
  }

  /** One notice at a time, so dedupe and queue writes see each other. */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
