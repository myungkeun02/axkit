import { randomUUID } from 'node:crypto';
import type { MailMessage, MailSummary } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { TripDeps } from './deps.js';
import { detectBooking } from './detect.js';
import type { ExtractedSegment } from './extract.js';
import { extractBooking } from './extract.js';
import { groupTrips } from './group.js';
import type { TripSegment } from './types.js';

export const SCAN_JOB = 'trip.scan';
const STATE_KEY = 'scan.state';
const SEARCH_LIMIT = 20;
const MAX_MODEL_CALLS = 10;
const LOOKBACK_HOURS = 72;
const FIRST_LOOKBACK_HOURS = 720;
const PRUNE_DAYS = 60;
const DAY_MS = 86_400_000;

interface ScanState {
  startedAt: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toSegment(segment: ExtractedSegment, mailId: string): TripSegment {
  return { id: randomUUID().slice(0, 8), mailId, ...segment };
}

async function pruneEnded(ctx: PluginContext, deps: TripDeps, now: Date): Promise<void> {
  const trips = groupTrips(deps.store.all(), deps.timeZone);
  if (trips.length === 0) return;
  const cutoff = now.getTime() - PRUNE_DAYS * DAY_MS;
  const keep = trips.filter((trip) => Date.parse(trip.end) >= cutoff).flatMap((trip) => trip.segments);
  if (keep.length === deps.store.all().length) return;
  try {
    await deps.store.setAll(keep);
  } catch (error) {
    ctx.log.warn('trip scan: could not prune old trips', { error: messageOf(error) });
  }
}

async function notifyCancelled(ctx: PluginContext, deps: TripDeps, mailId: string): Promise<void> {
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    ctx.log.warn('trip scan: cancellation recorded but no notifier is available');
    return;
  }
  await notifier.notify({ kind: 'trip.cancelled', dedupeKey: mailId, text: deps.texts.cancelApplied });
}

/** Reads one booking mail into segments, or applies its cancellation. */
async function processMail(
  ctx: PluginContext,
  deps: TripDeps,
  mail: MailMessage,
  signal: 'booking' | 'cancel',
  now: Date,
): Promise<void> {
  const extracted = await extractBooking({ llm: ctx.llm, mail, now, timeZone: deps.timeZone });
  if (extracted.status === 'error') {
    ctx.log.warn('trip scan: extraction failed; will retry on the next scan', { mailId: mail.id });
    return;
  }
  if (extracted.status === 'invalid') {
    ctx.log.warn('trip scan: model answer was not usable JSON', { mailId: mail.id });
    await deps.store.markSeen(mail.id);
    return;
  }

  if (signal === 'cancel' || extracted.cancelled) {
    const references = extracted.segments
      .map((segment) => segment.reference)
      .filter((reference): reference is string => reference !== undefined);
    const removed = await deps.store.removeByReferences(references);
    if (removed.length > 0) await notifyCancelled(ctx, deps, mail.id);
    await deps.store.markSeen(mail.id);
    return;
  }

  await deps.store.add(extracted.segments.map((segment) => toSegment(segment, mail.id)));
  await deps.store.markSeen(mail.id);
}

async function runScan(ctx: PluginContext, deps: TripDeps, now: Date): Promise<void> {
  await pruneEnded(ctx, deps, now);

  const mailReader = ctx.tryUse(Contracts.mailRead);
  if (mailReader === undefined) return;

  const state = await ctx.kv.get<ScanState>(STATE_KEY);
  const firstRun = state === undefined;
  let summaries: readonly MailSummary[];
  try {
    summaries = await mailReader.search({
      text: deps.texts.mailQuery,
      sinceHours: firstRun ? FIRST_LOOKBACK_HOURS : LOOKBACK_HOURS,
      limit: SEARCH_LIMIT,
    });
  } catch (error) {
    ctx.log.warn('trip scan: mail search failed', { error: messageOf(error) });
    return;
  }
  if (firstRun) await ctx.kv.set(STATE_KEY, { startedAt: now.toISOString() });

  let calls = 0;
  for (const summary of summaries) {
    if (calls >= MAX_MODEL_CALLS) break;
    if (deps.store.hasSeen(summary.id)) continue;

    let mail: MailMessage;
    try {
      mail = await mailReader.read(summary.id);
    } catch (error) {
      ctx.log.warn('trip scan: mail could not be read', { mailId: summary.id, error: messageOf(error) });
      continue;
    }

    const signal = detectBooking({ from: mail.from, subject: mail.subject, body: mail.body });
    if (signal === undefined) {
      await deps.store.markSeen(mail.id);
      continue;
    }
    calls += 1;
    await processMail(ctx, deps, mail, signal, now);
  }
}

/** Registers the hourly booking-mail scan. Capabilities are resolved on every run. */
export function registerTripScan(ctx: PluginContext, deps: TripDeps, scanSeconds: number): void {
  ctx.scheduler.add({
    name: SCAN_JOB,
    schedule: { kind: 'every', seconds: scanSeconds },
    run: (now) => runScan(ctx, deps, now),
  });
}
