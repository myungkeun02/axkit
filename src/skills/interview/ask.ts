import type { Choice, OutgoingMessage } from '../../core/conversation/types.js';
import type { InterviewTexts } from './locale.js';
import type { ProgressStore } from './progress.js';
import type { InterviewQuestion } from './questions.js';
import { SKIP_OPTION } from './questions.js';

export function choiceId(questionId: string, optionId: string): string {
  return `interview:${questionId}:${optionId}`;
}

/** The first question the owner has neither answered nor skipped. */
export function nextQuestion(
  questions: readonly InterviewQuestion[],
  progress: ProgressStore,
): InterviewQuestion | undefined {
  return questions.find(
    (question) => progress.answeredOption(question.id) === undefined && !progress.isSkipped(question.id),
  );
}

export function choicesOf(question: InterviewQuestion, texts: InterviewTexts): Choice[] {
  return [
    ...question.options.map((option) => ({
      id: choiceId(question.id, option.id),
      label: option.label,
    })),
    { id: choiceId(question.id, SKIP_OPTION), label: texts.skip },
  ];
}

export function questionMessage(question: InterviewQuestion, texts: InterviewTexts): OutgoingMessage {
  return { text: question.text, choices: choicesOf(question, texts) };
}

/** The daily ask waits while the last question is unanswered, and while the owner is skipping. */
export function shouldAskDaily(
  questions: readonly InterviewQuestion[],
  progress: ProgressStore,
): boolean {
  if (progress.dailyPaused) return false;
  const last = progress.lastAsked;
  if (last !== undefined && !progress.isResolved(last)) return false;
  return nextQuestion(questions, progress) !== undefined;
}
