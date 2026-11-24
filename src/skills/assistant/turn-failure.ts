import type { RunnerFailure } from '../../core/contracts/assistant.js';
import type { CompletedTool } from '../../core/conversation/types.js';
import { LlmError } from '../../core/llm/types.js';
import type { AssistantTexts } from './locale.js';
import { wrapData } from './render.js';

export function llmErrorText(error: LlmError, texts: AssistantTexts): string {
  switch (error.code) {
    case 'over_budget':
      // the gateway names which budget ran out ("Monthly budget of $… reached")
      return /^monthly/i.test(error.message) ? texts.overBudgetMonthly : texts.overBudget;
    case 'no_route':
      return texts.noRoute;
    case 'provider_failed':
      return texts.providerFailed;
  }
}

/**
 * Tools ran, then planning failed: the reply says what was actually done, from the tool results, instead of hiding
 * it behind an error line.
 */
export function partialReply(ran: readonly CompletedTool[], texts: AssistantTexts, cause?: string): string {
  const lines = ran.slice(-6).map((tool) => `- ${tool.name}${tool.message !== '' ? `: ${tool.message}` : ''}`);
  return [texts.partialHead, ...lines, ...(cause !== undefined ? [cause] : []), texts.partialTail].join('\n');
}

/** The note a replayed turn gets: these already ran before the restart. */
export function resumeNote(done: readonly CompletedTool[]): string {
  const lines = done.map((tool) => JSON.stringify({ tool: tool.name, effects: tool.effects, result: tool.message }));
  return [
    'A restart interrupted this turn. These tool calls already ran and finished before it:',
    wrapData('done_before_restart', lines.join('\n')),
    'Do not run them again. Continue from there: finish what is left, then tell the owner what was done.',
  ].join('\n');
}

export { LlmError };

/** Why a model call failed, in the runner's words. */
export function llmFailure(error: LlmError): RunnerFailure {
  switch (error.code) {
    case 'over_budget':
      return 'over_budget';
    case 'no_route':
      return 'no_model';
    case 'provider_failed':
      return 'provider_down';
  }
}
