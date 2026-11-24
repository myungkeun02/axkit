import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import type { AppView } from '../../core/contracts/device-api.js';
import type { ModelUsage, PurposeUsage, SplitBucket, UsageBucket } from '../../core/contracts/usage.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { dayRange, minutesOfDay, monthOf, monthRange, ymdOf, ymdPlus } from '../../core/time/local-day.js';
import type { AppEventLog } from './log.js';
import type { AppEvent } from './protocol.js';

export interface UsageBudget {
  dailyUsd: number;
  monthlyUsd: number;
}

const periodSchema = z.enum(['day', 'week', 'month']).catch('day');

function rate<T extends { calls: number; failures: number }>(row: T): T & { failureRate: number } {
  const total = row.calls + row.failures;
  return { ...row, failureRate: total === 0 ? 0 : Math.round((row.failures / total) * 1000) / 1000 };
}

function totals(rows: readonly PurposeUsage[]) {
  const sum = rows.reduce(
    (acc, row) => ({
      calls: acc.calls + row.calls,
      failures: acc.failures + row.failures,
      costUsd: acc.costUsd + row.costUsd,
      inputTokens: acc.inputTokens + row.inputTokens,
      outputTokens: acc.outputTokens + row.outputTokens,
    }),
    { calls: 0, failures: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
  );
  return rate({ ...sum, costUsd: Math.round(sum.costUsd * 10_000) / 10_000 });
}

/** 15 minutes divides every UTC offset in use, so the buckets regroup exactly into local hours and days. */
const BUCKET_MS = 15 * 60_000;

interface DailyPoint {
  date: string;
  calls: number;
  failures: number;
  costUsd: number;
  byModel?: Record<string, { calls: number; costUsd: number }>;
  byBot?: Record<string, { calls: number; costUsd: number }>;
}

/** D8: each point's calls split by model and by bot ("main" = the assistant); the parts add up to the point. */
export function splitPoints(points: DailyPoint[], split: readonly SplitBucket[], zone: string, hourly: boolean): DailyPoint[] {
  const key = (at: Date): string => (hourly ? hourKey(at, zone) : ymdOf(at, zone));
  const byDate = new Map(points.map((point) => [point.date, point]));
  const add = (map: Record<string, { calls: number; costUsd: number }>, id: string, row: SplitBucket): void => {
    const entry = map[id] ?? { calls: 0, costUsd: 0 };
    entry.calls += row.calls;
    entry.costUsd = Math.round((entry.costUsd + row.costUsd) * 10_000) / 10_000;
    map[id] = entry;
  };
  for (const point of points) {
    point.byModel = {};
    point.byBot = {};
  }
  for (const row of split) {
    const point = byDate.get(key(new Date(row.startMs)));
    if (point?.byModel === undefined || point.byBot === undefined) continue;
    add(point.byModel, row.model, row);
    add(point.byBot, row.purpose.startsWith('bot.') ? (row.purpose.split('.')[1] ?? 'main') : 'main', row);
  }
  return points;
}

function hourKey(at: Date, zone: string): string {
  const hour = Math.floor(minutesOfDay(at, zone) / 60);
  return `${ymdOf(at, zone)}T${String(hour).padStart(2, '0')}:00`;
}

/**
 * Local days (or hours for `day`) from `since` to now, every slot present so a chart has no gaps. Buckets come from
 * the ledger in UTC; each is placed by its start in the owner's zone.
 */
export function dailyPoints(buckets: readonly UsageBucket[], since: Date, now: Date, zone: string, hourly: boolean): DailyPoint[] {
  const points = new Map<string, DailyPoint>();
  const key = (at: Date): string => (hourly ? hourKey(at, zone) : ymdOf(at, zone));
  const step = hourly ? 3_600_000 : 86_400_000;
  // Walking by fixed steps can skip a slot on a DST day; the second pass from the buckets fills it.
  for (let at = since.getTime(); at <= now.getTime(); at += step) {
    const slot = key(new Date(at));
    points.set(slot, { date: slot, calls: 0, failures: 0, costUsd: 0 });
  }
  const today = key(now);
  if (!points.has(today)) points.set(today, { date: today, calls: 0, failures: 0, costUsd: 0 });
  for (const bucket of buckets) {
    const slot = key(new Date(bucket.startMs));
    const point = points.get(slot) ?? { date: slot, calls: 0, failures: 0, costUsd: 0 };
    point.calls += bucket.calls;
    point.failures += bucket.failures;
    point.costUsd = Math.round((point.costUsd + bucket.costUsd) * 10_000) / 10_000;
    points.set(slot, point);
  }
  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** AI usage by period, model and purpose (docs/APP-PROTOCOL.md §5.2). */
export function usageView(ctx: PluginContext, budget: UsageBudget | undefined): AppView {
  return {
    name: 'usage',
    version: 1,
    async read(query) {
      const reader = ctx.use(Contracts.usage);
      const period = periodSchema.parse(query.get('period') ?? 'day');
      const now = ctx.clock.now();
      const zone = ctx.assistant.timezone;
      const today = ymdOf(now, zone);
      const since =
        period === 'day' ? dayRange(today, zone).from
        : period === 'week' ? dayRange(ymdPlus(today, -6), zone).from
        : monthRange(monthOf(now, zone), zone).from;
      const byPurpose = await reader.byPurpose(since);
      const byModel: ModelUsage[] = (await reader.byModel?.(since)) ?? [];
      const buckets = await reader.timeline?.(since, BUCKET_MS);
      // R8: bot turns run as "bot.<id>…", so each bot's share is its purpose prefix
      const bots = (await ctx.tryUse(Contracts.bots)?.list().catch(() => [])) ?? [];
      const perBot = new Map<string, { calls: number; failures: number; costUsd: number }>();
      for (const row of byPurpose.filter((item) => item.purpose.startsWith('bot.'))) {
        const id = row.purpose.split('.')[1] ?? '';
        const entry = perBot.get(id) ?? { calls: 0, failures: 0, costUsd: 0 };
        entry.calls += row.calls;
        entry.failures += row.failures;
        entry.costUsd = Math.round((entry.costUsd + row.costUsd) * 10_000) / 10_000;
        perBot.set(id, entry);
      }
      const byBot = [...perBot.entries()]
        .map(([botId, entry]) => ({ botId, name: bots.find((bot) => bot.id === botId)?.name ?? botId, ...entry }))
        .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
      return {
        byBot,
        period,
        since: since.toISOString(),
        until: now.toISOString(),
        totals: totals(byPurpose),
        byModel: byModel.map(rate),
        byPurpose: byPurpose.map(rate),
        daily:
          buckets === undefined
            ? []
            : splitPoints(dailyPoints(buckets, since, now, zone, period === 'day'), (await reader.timelineSplit?.(since, BUCKET_MS)) ?? [], zone, period === 'day'),
        budget: budget ?? null,
      };
    },
  };
}

function openCards(events: readonly AppEvent[]) {
  const closed = new Set(events.flatMap((event) => (event.type === 'card_closed' ? [event.cardId] : [])));
  return events.flatMap((event) =>
    event.type === 'card' && !closed.has(event.cardId)
      ? [{ cardId: event.cardId, summary: event.summary, effects: event.effects, effectLabels: event.effectLabels,
          ...(event.note !== undefined ? { note: event.note } : {}), expiresAt: event.expiresAt }]
      : [],
  );
}

/** Cards waiting for the owner; deciding stays on `POST cards/<id>`. */
/** Monday (owner's zone) of the week a time falls in, as YYYY-MM-DD. */
function weekOf(at: Date, zone: string): string {
  const ymd = ymdOf(at, zone);
  const day = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return ymdPlus(ymd, -((day + 6) % 7));
}

/**
 * Cards waiting for the owner; deciding stays on `POST cards/<id>`. D8 `history`: the last 8 weeks of cards asked and
 * how they were answered, and what ran under a standing rule without a card.
 */
export function approvalsView(log: AppEventLog, ctx?: PluginContext): AppView {
  return {
    name: 'approvals',
    version: 1,
    async read() {
      const events: AppEvent[] = [];
      for (let after = 0; ; ) {
        const page = await log.after(after, 500);
        events.push(...page);
        if (page.length < 500) break;
        after = page.at(-1)?.seq ?? after;
      }
      if (ctx === undefined) return { cards: openCards(events) };
      const zone = ctx.assistant.timezone;
      const now = ctx.clock.now();
      const weeks = new Map<string, { week: string; asked: number; approved: number; denied: number; written: number; auto: number }>();
      const thisWeek = weekOf(now, zone);
      for (let n = 7; n >= 0; n -= 1) {
        const week = ymdPlus(thisWeek, -7 * n);
        weeks.set(week, { week, asked: 0, approved: 0, denied: 0, written: 0, auto: 0 });
      }
      const seen = new Set<string>();
      for (const event of events) {
        const row = weeks.get(weekOf(new Date(event.at), zone));
        if (row === undefined) continue;
        if (event.type === 'card' && !seen.has(event.cardId)) {
          seen.add(event.cardId);
          row.asked += 1;
        }
        if (event.type === 'card_closed') {
          if (event.state === 'approved') row.approved += 1;
          else if (event.state === 'denied') row.denied += 1;
          else if (event.state === 'edit' && event.answer !== undefined) row.written += 1;
        }
      }
      const first = [...weeks.keys()][0] ?? thisWeek;
      const work = (await ctx.tryUse(Contracts.workLog)?.between(new Date(`${first}T00:00:00Z`), now, 2000).catch(() => [])) ?? [];
      for (const entry of work.filter((item) => item.kind === 'auto')) {
        const row = weeks.get(weekOf(new Date(entry.at), zone));
        if (row !== undefined) row.auto += 1;
      }
      return { cards: openCards(events), history: { weeks: [...weeks.values()] } };
    },
  };
}

export function improvementsView(ctx: PluginContext): AppView {
  return {
    name: 'improvements',
    version: 1,
    async read() {
      const docs = ctx.use(Contracts.docs);
      const all = [...(await docs.list({ kind: 'improvement' })), ...(await docs.list({ kind: 'changelog' }))];
      all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return {
        docs: all.slice(0, 50).map((doc) => ({
          id: doc.id,
          title: doc.title,
          body: doc.body,
          updatedAt: doc.updatedAt,
          needsReview: doc.needsReview,
          entries: doc.entries.slice(-20).map((entry) => ({ at: entry.at, text: entry.text, author: entry.author })),
        })),
      };
    },
  };
}

export function healthView(ctx: PluginContext): AppView {
  return {
    name: 'health',
    version: 1,
    async read() {
      const now = ctx.clock.now();
      const findings = await ctx.use(Contracts.health).runAll(now);
      return { checkedAt: now.toISOString(), findings };
    },
  };
}
