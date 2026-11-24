import { inverseChange } from './change.js';
import { metricOf, metricValue } from './improve.js';
import { afterPerWeek } from './measure.js';
import type { WeeklySignals } from './signals.js';
import type { AppliedChange, DetectedChange, StoredFeedback } from './types.js';

const DAY_MS = 86_400_000;
const MEASURE_AFTER_DAYS = 7;

export interface Measurement {
  id: string;
  change: AppliedChange['change'];
  baseline: number;
  after: number;
  effective: boolean;
}

function effective(baseline: number, after: number): boolean {
  return after < baseline || (baseline === 0 && after === 0);
}

/** Measures an applied change at least a week old; undefined while it is too young or unmeasurable. */
export function measureChange(
  record: AppliedChange,
  signals: WeeklySignals,
  feedback: readonly StoredFeedback[],
  now: Date,
): Measurement | undefined {
  if (record.measured !== undefined || record.undoneAt !== undefined) return undefined;
  const appliedAt = new Date(record.appliedAt);
  if (now.getTime() - appliedAt.getTime() < MEASURE_AFTER_DAYS * DAY_MS) return undefined;

  const baseline = record.baseline ?? record.baselinePerWeek;
  if (record.metric !== undefined) {
    const after = metricValue(record.metric, signals);
    if (after === undefined) return undefined;
    return { id: record.id, change: record.change, baseline, after, effective: effective(baseline, after) };
  }

  const after = afterPerWeek(feedback, record.change, appliedAt);
  return { id: record.id, change: record.change, baseline, after, effective: effective(baseline, after) };
}

/** A proposal to undo a change that did not lower its metric. */
export function revertProposal(measurement: Measurement): DetectedChange {
  const change = inverseChange(measurement.change);
  const metric = metricOf(measurement.change) ?? metricOf(change);
  return {
    id: change.id,
    change,
    reason: {
      kind: 'no_effect',
      of: measurement.id,
      baseline: measurement.baseline,
      after: measurement.after,
    },
    ...(metric !== undefined ? { metric } : {}),
    baseline: measurement.after,
  };
}
