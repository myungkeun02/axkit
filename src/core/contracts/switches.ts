import type { AuthorKind } from './docs.js';

/**
 * Pause switches with a mandatory end, and a per-feature breaker. The original assistant kept pauses in a general
 * key-value table with no end or owner; one mail pause stayed on for 27 days and a broken reader failed 7,058 times.
 */
export interface PauseInput {
  /** Why, in one line the owner can read. */
  reason: string;
  /** Required: a pause without an end is not accepted. At most 30 days ahead. */
  until: Date;
  by: { kind: AuthorKind; id: string };
}

export interface PauseState {
  feature: string;
  reason: string;
  /** ISO 8601. */
  until: string;
  byKind: AuthorKind;
  by: string;
  createdAt: string;
  /** True when the breaker set it, not a person. */
  auto: boolean;
}

/** Capability "core.switches". */
export interface FeatureSwitches {
  pause(feature: string, input: PauseInput): Promise<PauseState>;
  resume(feature: string): Promise<void>;
  /** An expired pause is removed and reported as not paused. */
  pausedState(feature: string): Promise<PauseState | undefined>;
  list(): Promise<PauseState[]>;
}

export interface FailureReport {
  /** Plugin id or a finer name: "skill.company", "connector.discord-app.read". */
  feature: string;
  /** Short, stable class of the error ("timeout", "login_expired", "http_503"). Never a message body. */
  signature: string;
}

export interface FailureCount {
  feature: string;
  signature: string;
  count: number;
}

/** Capability "core.feature-health": same failure N times in a row pauses the feature and tells the owner once. */
export interface FeatureHealth {
  recordFailure(report: FailureReport): Promise<'counted' | 'paused'>;
  /** A success resets the run of failures for that feature. */
  recordSuccess(feature: string): Promise<void>;
  /** Failures recorded since `since`, grouped. For the weekly improvement loop. */
  failures(since: Date): Promise<FailureCount[]>;
}
