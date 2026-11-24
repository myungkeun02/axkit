import { z } from 'zod';
import type { Tool } from '../../core/tools/types.js';
import type { SummaryCache } from './cache.js';
import type { RunCounts, RunReason, RunStatus, ScanPhase } from './state.js';
import type { RunStateStore } from './state.js';

const input = z.object({});
export type OnboardingStatusInput = z.infer<typeof input>;

export interface OnboardingStatus {
  status: RunStatus;
  phase: ScanPhase;
  reason?: RunReason;
  counts: RunCounts;
  firstDoneAt?: string;
  reviewSentAt?: string;
  error?: string;
  /** Cached one-line summaries, not lines of knowledge. */
  summaries: number;
}

/** Tool "onboarding.status": read-only progress and cache size. */
export function onboardingStatusTool(deps: {
  state: RunStateStore;
  cache: SummaryCache;
}): Tool<OnboardingStatusInput, OnboardingStatus> {
  return {
    name: 'onboarding.status',
    description: 'Show the first-look scan status: phase, counts, failures and how many summaries are cached.',
    input,
    effects: ['read'],
    async run() {
      const state = deps.state.current;
      return {
        status: state.status,
        phase: state.phase,
        counts: { ...state.counts },
        summaries: deps.cache.size,
        ...(state.reason !== undefined ? { reason: state.reason } : {}),
        ...(state.firstDoneAt !== undefined ? { firstDoneAt: state.firstDoneAt } : {}),
        ...(state.reviewSentAt !== undefined ? { reviewSentAt: state.reviewSentAt } : {}),
        ...(state.error !== undefined ? { error: state.error } : {}),
      };
    },
  };
}
