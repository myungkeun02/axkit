import type { SpendCategory, TuningChange } from '../../core/contracts/index.js';
import { SPEND_CATEGORIES } from '../../core/contracts/index.js';

export type StoredVerdict = 'accepted' | 'rejected' | 'corrected';

/** A feedback event as stored. It never holds a message body; `label` is a short display name. */
export interface StoredFeedback {
  domain: string;
  subject: string;
  verdict: StoredVerdict;
  correction?: string;
  label?: string;
  /** ISO 8601 instant. */
  at: string;
}

export type ProposalReason =
  | { kind: 'notice'; rejections: number }
  | { kind: 'room'; rejections: number }
  | { kind: 'keyword'; token: string; category: SpendCategory; subjects: readonly string[]; count: number }
  | { kind: 'notice_volume'; noticeKind: string; perWeek: number }
  | { kind: 'feature_failures'; feature: string; perWeek: number; signature: string }
  | { kind: 'backlog'; open: number; limit: number; autoClosed: number; created: number; done: number }
  | { kind: 'no_effect'; of: string; baseline: number; after: number };

export type ProposalStatus = 'open' | 'applied' | 'declined';

export interface Proposal {
  id: string;
  change: TuningChange;
  reason: ProposalReason;
  createdAt: string;
  status: ProposalStatus;
  /** Signal this change is meant to lower ("failures:mail"); absent for feedback-only changes. */
  metric?: string;
  /** The metric's value when the proposal was made, so a later week can compare. */
  baseline?: number;
}

export interface MeasuredEffect {
  afterPerWeek: number;
  at: string;
  /** False when the metric did not fall (or was not zero already), which triggers a revert proposal. */
  effective?: boolean;
}

export interface AppliedChange {
  id: string;
  change: TuningChange;
  appliedAt: string;
  /** Negative feedback per week before the change, so the effect can be compared later. */
  baselinePerWeek: number;
  metric?: string;
  /** Metric value before applying; compared with the same metric a week later. */
  baseline?: number;
  measured?: MeasuredEffect;
  undoneAt?: string;
}

export interface DetectedChange {
  id: string;
  change: TuningChange;
  reason: ProposalReason;
  metric?: string;
  baseline?: number;
}

export interface TuningConfig {
  /** 0 = Sunday … 6 = Saturday, in the owner's time zone. */
  weekday: number;
  /** HH:MM in the owner's time zone. */
  at: string;
  /** Upper bound on proposals in one weekly notice; the owner still approves each one. */
  maxProposals: number;
}

const CATEGORIES: ReadonlySet<string> = new Set(SPEND_CATEGORIES);

export function isSpendCategory(value: string): value is SpendCategory {
  return CATEGORIES.has(value);
}
