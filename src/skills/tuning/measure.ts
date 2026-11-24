import type { TuningChange } from '../../core/contracts/index.js';
import { normalizeText } from './detect.js';
import type { StoredFeedback } from './types.js';

const DAY_MS = 86_400_000;
const BASELINE_DAYS = 14;
const EFFECT_DAYS = 7;

/** Rejected cards (and merchant corrections for a learned keyword) that the change was meant to reduce. */
export function isNegativeFor(item: StoredFeedback, change: TuningChange): boolean {
  if (item.domain !== change.domain) return false;
  if (item.verdict !== 'rejected' && item.verdict !== 'corrected') return false;
  if (change.domain === 'spend.category' && change.action === 'set') {
    if (item.verdict !== 'corrected' || item.label === undefined) return false;
    return normalizeText(item.label).includes(normalizeText(change.subject));
  }
  return item.subject === change.subject;
}

function countBetween(
  feedback: readonly StoredFeedback[],
  change: TuningChange,
  from: Date,
  to: Date,
): number {
  let count = 0;
  for (const item of feedback) {
    const at = Date.parse(item.at);
    if (at <= from.getTime() || at > to.getTime()) continue;
    if (isNegativeFor(item, change)) count += 1;
  }
  return count;
}

/** Negative feedback in the 14 days before applying, per week. */
export function baselinePerWeek(feedback: readonly StoredFeedback[], change: TuningChange, appliedAt: Date): number {
  const from = new Date(appliedAt.getTime() - BASELINE_DAYS * DAY_MS);
  return Math.round((countBetween(feedback, change, from, appliedAt) / 2) * 10) / 10;
}

/** Negative feedback in the 7 days after applying, per week. */
export function afterPerWeek(feedback: readonly StoredFeedback[], change: TuningChange, appliedAt: Date): number {
  const to = new Date(appliedAt.getTime() + EFFECT_DAYS * DAY_MS);
  return countBetween(feedback, change, appliedAt, to);
}
