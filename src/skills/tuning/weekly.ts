import { Contracts } from '../../core/contracts/index.js';
import type { Notice } from '../../core/contracts/index.js';
import type { Logger } from '../../core/log/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { weekdayOf, ymdOf } from '../../core/time/local-day.js';
import { measureChange, revertProposal } from './effect.js';
import type { Measurement } from './effect.js';
import { proposeImprovements } from './improve.js';
import type { TuningTexts } from './locale.js';
import type { ImprovementRecord } from './record.js';
import { collectSignals } from './signals.js';
import type { WeeklySignals } from './signals.js';
import type { TuningStore } from './store.js';
import type { DetectedChange, TuningConfig } from './types.js';

export const TUNING_JOB = 'tuning.weekly';

const DAY_MS = 86_400_000;
const FEEDBACK_DAYS = 60;
const LOOKBACK_DAYS = 30;
const MIN_PURPOSE_TOTAL = 20;
const FAILURE_RATE = 0.25;
const MAX_FINDING_LINES = 5;

export interface WeeklyDeps {
  store: TuningStore;
  config: TuningConfig;
  texts: TuningTexts;
  timeZone: string;
  log: Logger;
  record: ImprovementRecord;
}

async function measureWeek(
  deps: WeeklyDeps,
  signals: WeeklySignals,
  now: Date,
): Promise<Measurement[]> {
  const applied = await deps.store.applied();
  const feedback = await deps.store.since(new Date(now.getTime() - FEEDBACK_DAYS * DAY_MS));
  const measurements: Measurement[] = [];
  for (const record of applied) {
    const measurement = measureChange(record, signals, feedback, now);
    if (measurement !== undefined) measurements.push(measurement);
  }
  return measurements;
}

async function proposeForWeek(
  deps: WeeklyDeps,
  signals: WeeklySignals,
  measurements: readonly Measurement[],
  now: Date,
): Promise<DetectedChange[]> {
  const feedback = await deps.store.since(new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS));
  const [proposals, applied] = await Promise.all([deps.store.proposals(), deps.store.applied()]);
  const existing = [...proposals.map((item) => item.change), ...applied.map((item) => item.change)];
  const reverts = measurements.filter((item) => !item.effective).map((item) => revertProposal(item));
  return proposeImprovements({
    signals,
    feedback,
    now,
    existing,
    limit: deps.config.maxProposals,
    reverts,
  });
}

function checkLines(deps: WeeklyDeps, signals: WeeklySignals): string[] {
  const lines = signals.findings.slice(0, MAX_FINDING_LINES).map((finding) => finding.line);
  for (const usage of signals.models) {
    const total = usage.calls + usage.failures;
    if (total < MIN_PURPOSE_TOTAL) continue;
    // Calls and failures are disjoint counts in the usage reader, so the rate is over both.
    if (usage.failures / total < FAILURE_RATE) continue;
    lines.push(deps.texts.modelLine(usage.purpose, usage.failures, usage.calls));
  }
  if (signals.expiredFacts > 0) lines.push(deps.texts.expiredFactsLine(signals.expiredFacts));
  return lines;
}

function buildText(
  deps: WeeklyDeps,
  measurements: readonly Measurement[],
  detected: readonly DetectedChange[],
  checks: readonly string[],
): string {
  const lines = [deps.texts.weeklyTitle];
  if (measurements.length > 0) {
    lines.push(
      '',
      deps.texts.measuredHeading,
      ...measurements.map((item) => deps.texts.measuredLine(item.change, item.baseline, item.after)),
    );
  }
  if (detected.length > 0) {
    lines.push(
      '',
      deps.texts.proposalHeading,
      ...detected.map((item, index) =>
        deps.texts.proposalLine(index + 1, deps.texts.proposalReason(item.reason, item.change.subject)),
      ),
    );
  }
  if (checks.length > 0) {
    lines.push('', deps.texts.checkHeading, ...checks.map((line) => `- ${line}`));
  }
  return lines.join('\n');
}

function toProposal(item: DetectedChange, now: Date) {
  return {
    id: item.id,
    change: item.change,
    reason: item.reason,
    createdAt: now.toISOString(),
    status: 'open' as const,
    ...(item.metric !== undefined ? { metric: item.metric } : {}),
    ...(item.baseline !== undefined ? { baseline: item.baseline } : {}),
  };
}

/** Runs on the configured weekday only; the scheduler has daily kinds, so every other day is a no-op. */
export async function runWeekly(ctx: PluginContext, deps: WeeklyDeps, now: Date): Promise<void> {
  if (weekdayOf(now, deps.timeZone) !== deps.config.weekday) return;

  const signals = await collectSignals(ctx, deps.store, now);
  const measurements = await measureWeek(deps, signals, now);
  const detected = await proposeForWeek(deps, signals, measurements, now);
  const checks = checkLines(deps, signals);
  if (measurements.length === 0 && detected.length === 0 && checks.length === 0) return;

  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    deps.log.warn('tuning: weekly report skipped without a notifier');
    return;
  }

  const choices = detected.flatMap((item) => [
    { id: `tuning.apply:${item.id}`, label: deps.texts.apply },
    { id: `tuning.skip:${item.id}`, label: deps.texts.skip },
  ]);
  const notice: Notice = {
    kind: TUNING_JOB,
    dedupeKey: `${TUNING_JOB}:${ymdOf(now, deps.timeZone)}`,
    text: buildText(deps, measurements, detected, checks),
    ...(choices.length > 0 ? { choices } : {}),
  };
  const result = await notifier.notify(notice);
  if (result === 'dropped') return;

  for (const measurement of measurements) {
    await deps.store.markMeasured(measurement.id, {
      afterPerWeek: measurement.after,
      at: now.toISOString(),
      effective: measurement.effective,
    });
    await deps.record.measured(measurement.change, measurement.baseline, measurement.after, measurement.effective);
  }
  await deps.store.addProposals(detected.map((item) => toProposal(item, now)));
  for (const item of detected) {
    await deps.record.proposed(deps.texts.proposalReason(item.reason, item.change.subject));
  }
}

export function registerWeekly(ctx: PluginContext, deps: WeeklyDeps): void {
  ctx.scheduler.add({
    name: TUNING_JOB,
    schedule: { kind: 'daily', at: deps.config.at as `${number}:${number}` },
    async run(now) {
      await runWeekly(ctx, deps, now);
    },
  });
}
