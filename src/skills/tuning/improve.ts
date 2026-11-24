import type { BacklogSnapshot, TuningChange } from '../../core/contracts/index.js';
import { changeKey, withId } from './change.js';
import { detectChanges } from './detect.js';
import type { WeeklySignals } from './signals.js';
import type { DetectedChange, ProposalReason, StoredFeedback } from './types.js';

const DAY_MS = 86_400_000;
const ACCEPT_WINDOW_DAYS = 14;

const MIN_NOTICE_VOLUME = 30;
const MIN_FAILURES = 10;
const MIN_AUTO_CLOSED = 3;
const MIN_CREATED = 5;
const BACKLOG_STEP = 2;

export interface ProposeInput {
  signals: WeeklySignals;
  feedback: readonly StoredFeedback[];
  now: Date;
  /** Changes already open, applied or declined. */
  existing: readonly TuningChange[];
  limit: number;
  /** Reverts of ineffective changes; counted first so they are never pushed out by newer ideas. */
  reverts?: readonly DetectedChange[];
}

interface FailureGroup {
  count: number;
  signatures: Map<string, number>;
}

function featureFailureChanges(signals: WeeklySignals): DetectedChange[] {
  const groups = new Map<string, FailureGroup>();
  for (const item of signals.failures) {
    const group = groups.get(item.feature) ?? { count: 0, signatures: new Map<string, number>() };
    group.count += item.count;
    group.signatures.set(item.signature, (group.signatures.get(item.signature) ?? 0) + item.count);
    groups.set(item.feature, group);
  }

  const paused = new Set(signals.pauses.map((item) => item.feature));
  const ordered = [...groups.entries()].sort(
    ([leftFeature, left], [rightFeature, right]) =>
      right.count - left.count || leftFeature.localeCompare(rightFeature),
  );

  const found: DetectedChange[] = [];
  for (const [feature, group] of ordered) {
    if (group.count < MIN_FAILURES || paused.has(feature)) continue;
    const top = [...group.signatures.entries()].sort(
      ([leftSignature, left], [rightSignature, right]) =>
        right - left || leftSignature.localeCompare(rightSignature),
    )[0];
    if (top === undefined) continue;
    const change = withId({ domain: 'feature', subject: feature, action: 'mute' });
    const reason: ProposalReason = {
      kind: 'feature_failures',
      feature,
      perWeek: group.count,
      signature: top[0],
    };
    found.push({ id: change.id, change, reason, metric: `failures:${feature}`, baseline: group.count });
  }
  return found;
}

function backlogPressure(snapshot: BacklogSnapshot): boolean {
  if (snapshot.autoClosedInWeek >= MIN_AUTO_CLOSED) return true;
  return snapshot.createdInWeek >= MIN_CREATED && snapshot.doneInWeek * 2 < snapshot.createdInWeek;
}

function backlogChanges(signals: WeeklySignals): DetectedChange[] {
  const snapshot = signals.backlog;
  if (snapshot === undefined || snapshot.openLimit <= 1 || !backlogPressure(snapshot)) return [];
  const value = String(Math.max(1, snapshot.openLimit - BACKLOG_STEP));
  const change = withId({ domain: 'company.limits', subject: 'maxOpen', action: 'set', value });
  const reason: ProposalReason = {
    kind: 'backlog',
    open: snapshot.open,
    limit: snapshot.openLimit,
    autoClosed: snapshot.autoClosedInWeek,
    created: snapshot.createdInWeek,
    done: snapshot.doneInWeek,
  };
  return [
    { id: change.id, change, reason, metric: 'backlog.autoclosed', baseline: snapshot.autoClosedInWeek },
  ];
}

function acceptedRecently(feedback: readonly StoredFeedback[], kind: string, now: Date): boolean {
  const cutoff = now.getTime() - ACCEPT_WINDOW_DAYS * DAY_MS;
  return feedback.some(
    (item) =>
      item.domain === 'notice' &&
      item.subject === kind &&
      item.verdict === 'accepted' &&
      Date.parse(item.at) >= cutoff,
  );
}

function noticeVolumeChanges(
  signals: WeeklySignals,
  feedback: readonly StoredFeedback[],
  now: Date,
): DetectedChange[] {
  const ordered = signals.notices
    .map((item) => ({ ...item, volume: item.sent + item.digested }))
    .sort((left, right) => right.volume - left.volume || left.kind.localeCompare(right.kind));

  const found: DetectedChange[] = [];
  for (const item of ordered) {
    if (item.volume < MIN_NOTICE_VOLUME || acceptedRecently(feedback, item.kind, now)) continue;
    const change = withId({ domain: 'notice', subject: item.kind, action: 'mute' });
    const reason: ProposalReason = { kind: 'notice_volume', noticeKind: item.kind, perWeek: item.volume };
    found.push({ id: change.id, change, reason, metric: `notice:${item.kind}`, baseline: item.volume });
  }
  return found;
}

/** The metric a change is meant to lower; undefined for feedback-only changes. */
export function metricOf(change: TuningChange): string | undefined {
  if (change.domain === 'notice' && change.action !== 'set') return `notice:${change.subject}`;
  if (change.domain === 'feature' && change.action !== 'set') return `failures:${change.subject}`;
  if (change.domain === 'company.limits' && change.action === 'set') return 'backlog.autoclosed';
  return undefined;
}

/** Current value of a metric, or undefined when the source itself is missing. */
export function metricValue(metric: string, signals: WeeklySignals): number | undefined {
  if (metric.startsWith('notice:')) {
    const kind = metric.slice('notice:'.length);
    const found = signals.notices.find((item) => item.kind === kind);
    return found === undefined ? 0 : found.sent + found.digested;
  }
  if (metric.startsWith('failures:')) {
    const feature = metric.slice('failures:'.length);
    return signals.failures
      .filter((item) => item.feature === feature)
      .reduce((sum, item) => sum + item.count, 0);
  }
  if (metric === 'backlog.autoclosed') return signals.backlog?.autoClosedInWeek;
  return undefined;
}

/** Deterministic proposals from one week of signals; every rule carries the metric it is meant to lower. */
export function proposeImprovements(input: ProposeInput): DetectedChange[] {
  const limit = Math.max(0, input.limit);
  const found: DetectedChange[] = [];
  const keys = new Set(input.existing.map(changeKey));

  const add = (items: readonly DetectedChange[]): void => {
    for (const item of items) {
      const key = changeKey(item.change);
      if (keys.has(key)) continue;
      keys.add(key);
      found.push(item);
    }
  };

  add(input.reverts ?? []);
  add(featureFailureChanges(input.signals));
  add(backlogChanges(input.signals));
  add(noticeVolumeChanges(input.signals, input.feedback, input.now));

  const excluded = [...input.existing, ...found.map((item) => item.change)];
  add(detectChanges({ feedback: input.feedback, now: input.now, existing: excluded, limit }));

  return found.slice(0, limit);
}
