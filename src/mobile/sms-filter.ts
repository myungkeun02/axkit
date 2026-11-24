import { extractOneTimeCode, isCardApproval, isSpam } from './locale-ko-rules.js';

/**
 * - silent: verification codes and card approvals are useful locally but must not reach chat.
 * - spam: dropped without a model call.
 * - undefined: the caller may ask the model whether the owner has to do something.
 */
export type MessageRuleVerdict = 'silent' | 'spam';

export function ruleVerdict(text: string, sender: string | undefined): MessageRuleVerdict | undefined {
  if (extractOneTimeCode(text) !== undefined || isCardApproval(text)) return 'silent';
  if (isSpam(text, sender)) return 'spam';
  return undefined;
}
