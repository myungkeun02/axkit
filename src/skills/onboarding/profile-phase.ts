import { createHash } from 'node:crypto';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ProfileInput } from './fallback.js';
import type { OnboardingTexts } from './locale.js';
import type { RunStateStore } from './state.js';
import { synthesize } from './synthesize.js';
import { buildHierarchy, mergeHierarchy } from './hierarchy.js';
import type { PickedProject } from './projects.js';

export interface ProfileStep {
  ctx: PluginContext;
  state: RunStateStore;
  texts: OnboardingTexts;
  input: ProfileInput;
  daily: boolean;
  now: Date;
  /** Projects the owner picked; each becomes its own document under its company. */
  picked?: readonly PickedProject[];
  display?: (path: string) => string;
  onProject?: (done: number, total: number) => void;
}

export interface ProfileStepOutcome {
  /** True when a new profile went to the knowledge base. */
  saved: boolean;
  added: number;
  retired: number;
}

/** Everything the profile is built from; the same inputs would give the same profile. */
export function profileFingerprint(input: ProfileInput): string {
  const hash = createHash('sha256');
  const summaries = input.summaries.map((s) => `${s.kind}\u0001${s.path}\u0001${s.modifiedAt}\u0001${s.summary}`).sort();
  for (const part of [...summaries, ...input.stats, ...input.signals.map((l) => `${l.source}\u0001${l.text}`)]) {
    hash.update(part).update('\u0000');
  }
  return hash.digest('hex').slice(0, 32);
}

/**
 * Synthesizes and saves the profile. A daily run with unchanged inputs costs no model call, and a code-only
 * fallback (model unavailable or over budget) never overwrites a profile a model wrote earlier.
 */
export async function buildProfile(step: ProfileStep): Promise<ProfileStepOutcome> {
  const none: ProfileStepOutcome = { saved: false, added: 0, retired: 0 };
  const fingerprint = profileFingerprint(step.input);
  const previous = step.state.current;
  if (step.daily && previous.fingerprint === fingerprint) return none;

  // Hundreds of résumés would crowd everything else out of the profile: they count as one line (the talent pack keeps them).
  const resumes = step.input.summaries.filter((summary) => summary.docType === 'resume').length;
  const input =
    resumes === 0
      ? step.input
      : { ...step.input, summaries: step.input.summaries.filter((summary) => summary.docType !== 'resume'), stats: [...step.input.stats, step.texts.resumeStat(resumes)] };
  const picked = step.picked ?? [];
  // Even with nothing picked, the work map makes companies and projects out of the folders.
  const hierarchy =
    picked.length === 0 && input.summaries.length === 0
      ? undefined
      : await buildHierarchy(picked, input, {
          llm: step.ctx.llm,
          log: step.ctx.log,
          texts: step.texts,
          now: step.now,
          display: step.display ?? ((path) => path),
          ...(step.onProject !== undefined ? { onProject: step.onProject } : {}),
        });
  const overall = await synthesize({ llm: step.ctx.llm, log: step.ctx.log }, hierarchy?.input ?? input, step.texts, step.now);
  const synthesis = hierarchy === undefined ? overall : { ...overall, result: mergeHierarchy(overall.result, hierarchy) };
  if (synthesis.by === 'code' && previous.profileBy === 'model') {
    step.ctx.log.info('onboarding: kept the model-written profile; this run only had the code fallback');
    return none;
  }

  const writer = step.ctx.tryUse(Contracts.knowledgeWrite);
  if (writer === undefined) {
    step.ctx.log.warn('onboarding: no knowledge writer is available; the profile was not saved');
    return none;
  }
  const counts = await writer.replaceScan(synthesis.result);
  await step.state.markProfile(synthesis.by, fingerprint);
  return { saved: true, ...counts };
}

/** The first finished look sends the "제가 이해한 당신" card. */
export async function startReview(ctx: PluginContext, state: RunStateStore, texts: OnboardingTexts): Promise<void> {
  const profile = ctx.tryUse(Contracts.knowledgeProfile);
  const review = ctx.tryUse(Contracts.ownerReview);
  if (profile === undefined || review === undefined) return;
  try {
    const items = await profile.reviewLines();
    await review.start({ id: 'knowledge.profile', title: texts.reviewTitle, items });
    await state.markReviewSent(ctx.clock.now().toISOString());
  } catch (error) {
    ctx.log.warn('onboarding: the review card could not be started', { error: error instanceof Error ? error.name : 'unknown' });
  }
}
