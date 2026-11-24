/** Model calls per purpose, for budgets of a feature group (company mode) and the improvement loop. */
export interface PurposeUsage {
  purpose: string;
  calls: number;
  failures: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Capability "core.usage". Subscription CLIs cost 0 but still count calls and tokens. */
export interface UsageReader {
  /** Grouped by purpose; `prefix` keeps purposes that start with it ("company."). */
  byPurpose(since: Date, prefix?: string): Promise<PurposeUsage[]>;
  /** Grouped by provider and model. */
  byModel?(since: Date): Promise<ModelUsage[]>;
  /** Calls in fixed buckets of `stepMs` from the epoch, oldest first; callers regroup them into local days or hours. */
  timeline?(since: Date, stepMs: number): Promise<UsageBucket[]>;
  /** Grouped by purpose, provider, model and requested tier (null for calls recorded before tiers were kept). */
  byPurposeModel?(since: Date): Promise<PurposeModelUsage[]>;
  /** Successful calls per bucket, purpose and model (D8: each day split by model and by bot). */
  timelineSplit?(since: Date, stepMs: number): Promise<SplitBucket[]>;
}

export interface SplitBucket {
  startMs: number;
  purpose: string;
  model: string;
  calls: number;
  costUsd: number;
}

export interface UsageBucket {
  /** Start of the bucket, epoch ms. */
  startMs: number;
  calls: number;
  failures: number;
  costUsd: number;
}

export interface PurposeModelUsage {
  purpose: string;
  providerId: string;
  model: string;
  tier: string | null;
  calls: number;
  failures: number;
  costUsd: number;
}

export interface ModelUsage {
  providerId: string;
  model: string;
  calls: number;
  failures: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}
