import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import type { Plugin, PluginContext } from '../../core/plugin/types.js';
import { choicesOf, nextQuestion, shouldAskDaily } from './ask.js';
import { interviewAnswerHandler, interviewTriggerHandler } from './handlers.js';
import { interviewTexts } from './locale.js';
import { ProgressStore } from './progress.js';
import { interviewQuestions } from './questions.js';
import { createOwnerReview } from './review.js';
import { ownerReviewHandler } from './review-handlers.js';
import { interviewReviewTexts } from './review-locale.js';
import { ReviewStore } from './review-store.js';

const JOB_NAME = 'interview.daily';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_AT = '19:30';

const ConfigSchema = z.object({
  askAt: z.string().regex(HHMM).default(DEFAULT_AT),
});

function askAtOf(ctx: PluginContext): `${number}:${number}` {
  const parsed = ConfigSchema.safeParse(ctx.config);
  if (parsed.success) return parsed.data.askAt as `${number}:${number}`;
  ctx.log.warn('interview: invalid config, using defaults', { issues: parsed.error.issues.length });
  return DEFAULT_AT;
}

/** Interview skill: a short multiple-choice questionnaire about the owner, stored as facts. */
export function interviewSkill(): Plugin {
  return {
    manifest: {
      id: 'skill.interview',
      kind: 'skill',
      title: 'Interview',
    },
    async setup(ctx) {
      const texts = interviewTexts(ctx.assistant.language);
      const questions = interviewQuestions(ctx.assistant.language);
      const progress = new ProgressStore(ctx.kv);
      await progress.load();
      const deps = { ctx, questions, texts, progress };

      const reviewTexts = interviewReviewTexts(ctx.assistant.language);
      const reviewStore = new ReviewStore(ctx.kv);
      await reviewStore.load(ctx.clock.now());
      const reviewDeps = { ctx, texts: reviewTexts, store: reviewStore };

      ctx.provide(Contracts.ownerReview, createOwnerReview(reviewDeps));
      ctx.registerHandler(ownerReviewHandler(reviewDeps));

      ctx.registerHandler(interviewAnswerHandler(deps));
      ctx.registerHandler(interviewTriggerHandler(deps));

      ctx.scheduler.add({
        name: JOB_NAME,
        schedule: { kind: 'daily', at: askAtOf(ctx) },
        async run() {
          if (!shouldAskDaily(questions, progress)) return;
          const next = nextQuestion(questions, progress);
          if (next === undefined) return;
          const notifier = ctx.tryUse(Contracts.notifier);
          if (notifier === undefined) {
            ctx.log.warn('interview: no notifier is available; the daily question was skipped');
            return;
          }
          await notifier.notify({
            kind: 'interview.question',
            text: next.text,
            choices: choicesOf(next, texts),
            dedupeKey: `interview:${next.id}`,
          });
          await progress.markAsked(next.id);
        },
      });

      let starting = false;
      ctx.bus.on('app.started', async () => {
        if (starting) return;
        starting = true;
        try {
          if (progress.introduced) return;
          const notifier = ctx.tryUse(Contracts.notifier);
          if (notifier === undefined) {
            ctx.log.warn('interview: no notifier is available; the intro was skipped');
            return;
          }
          await notifier.notify({ kind: 'interview.intro', text: texts.intro });
          const next = nextQuestion(questions, progress);
          if (next !== undefined) {
            await notifier.notify({
              kind: 'interview.question',
              text: next.text,
              choices: choicesOf(next, texts),
              dedupeKey: `interview:${next.id}`,
            });
            await progress.markAsked(next.id);
          }
          await progress.markIntroduced();
        } finally {
          starting = false;
        }
      });
    },
  };
}
