import { Contracts } from '../../core/contracts/index.js';
import type {
  ConversationRef,
  HandleResult,
  MessageHandler,
  Replier,
} from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { choicesOf, nextQuestion, questionMessage } from './ask.js';
import type { InterviewTexts } from './locale.js';
import type { ProgressStore } from './progress.js';
import type { InterviewQuestion } from './questions.js';
import { SKIP_OPTION } from './questions.js';

const ANSWER_PRIORITY = 80;
const TRIGGER_PRIORITY = 85;
const ANSWER_CHOICE = /^\(choice:\s*interview:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)\)$/;

const REQUESTS: readonly RegExp[] = [
  /^(?:인터뷰|질문\s*해\s*줘|나에\s*대해(?:서)?\s*물어봐|나\s*좀\s*물어봐)[\s!?.~]*$/,
  /^(?:interview|ask\s+me\s+questions?|ask\s+about\s+me|ask\s+me\s+about\s+me)[\s!?.]*$/i,
];

export function isInterviewRequest(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && REQUESTS.some((pattern) => pattern.test(trimmed));
}

export interface InterviewDeps {
  ctx: PluginContext;
  questions: readonly InterviewQuestion[];
  texts: InterviewTexts;
  progress: ProgressStore;
}

async function replyNext(
  deps: InterviewDeps,
  opener: string,
  conversation: ConversationRef,
  replier: Replier,
): Promise<HandleResult> {
  const next = nextQuestion(deps.questions, deps.progress);
  if (next === undefined) {
    await replier.reply(conversation, { text: `${opener}\n\n${deps.texts.finished}` });
    return 'handled';
  }
  await replier.reply(conversation, {
    text: `${opener}\n\n${next.text}`,
    choices: choicesOf(next, deps.texts),
  });
  return 'handled';
}

async function storeAnswer(deps: InterviewDeps, questionId: string, fact: string): Promise<void> {
  const memory = deps.ctx.tryUse(Contracts.memoryWrite);
  if (memory === undefined) {
    deps.ctx.log.warn('interview: no memory writer is available; the answer was not saved');
    return;
  }
  try {
    await memory.remember({
      subject: 'owner',
      text: fact,
      source: { kind: 'interview', ref: questionId },
      halfLifeDays: 365,
    });
  } catch (error) {
    deps.ctx.log.warn('interview: the answer could not be remembered', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Buttons from the interview questions; any other choice is passed to the next handler. */
export function interviewAnswerHandler(deps: InterviewDeps): MessageHandler {
  return {
    id: 'interview.answers',
    priority: ANSWER_PRIORITY,
    async handle(message, replier) {
      if (!message.fromOwner) return 'pass';
      const match = ANSWER_CHOICE.exec(message.text.trim());
      if (match === null || match[1] === undefined || match[2] === undefined) return 'pass';
      const questionId = match[1];
      const optionId = match[2];
      const question = deps.questions.find((candidate) => candidate.id === questionId);
      if (question === undefined) return 'pass';

      if (optionId === SKIP_OPTION) {
        await deps.progress.skip(questionId);
        return replyNext(deps, deps.texts.skipped, message.conversation, replier);
      }
      const option = question.options.find((candidate) => candidate.id === optionId);
      if (option === undefined) return 'pass';

      await storeAnswer(deps, questionId, option.fact);
      await deps.progress.answer(questionId, option.id);
      return replyNext(deps, deps.texts.thanks, message.conversation, replier);
    },
  };
}

/** "인터뷰", "질문해 줘", "ask me questions": asks the next unanswered question. */
export function interviewTriggerHandler(deps: InterviewDeps): MessageHandler {
  return {
    id: 'interview.trigger',
    priority: TRIGGER_PRIORITY,
    async handle(message, replier) {
      if (!message.fromOwner) return 'pass';
      if (!isInterviewRequest(message.text)) return 'pass';
      const next = nextQuestion(deps.questions, deps.progress);
      if (next === undefined) {
        await replier.reply(message.conversation, { text: deps.texts.finished });
        return 'handled';
      }
      await deps.progress.markAsked(next.id);
      await replier.reply(message.conversation, questionMessage(next, deps.texts));
      return 'handled';
    },
  };
}
