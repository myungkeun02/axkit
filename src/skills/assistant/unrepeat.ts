import type { ChatMessage, LlmGateway } from '../../core/llm/types.js';
import type { Logger } from '../../core/log/types.js';
import type { ConversationMemory } from './memory-shape.js';
import type { PlanOrFailed } from './plan-request.js';
import { PLAN_FAILED, requestPlan } from './plan-request.js';

const REPEAT = 0.9;
const REPEAT_NOTE =
  'Your reply is nearly the same as your previous one. Do not repeat yourself: answer what is new in the owner’s last message, or say in one short sentence that it is already covered and what you can do next.';

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((word) => word !== '');
}

/** Word overlap (0–1). */
export function overlap(left: string, right: string): number {
  const a = words(left);
  const b = words(right);
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of b) {
    const n = counts.get(word) ?? 0;
    if (n > 0) {
      shared += 1;
      counts.set(word, n - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

interface RepeatInput {
  message: { text: string };
  memory: ConversationMemory;
  deps: { llm: LlmGateway; log: Logger; purpose?: string };
}

/**
 * The same answer twice in a row (the owner said something new, the reply did not change) is asked for again once,
 * with a note; a second near-copy is kept rather than looping.
 */
export async function unrepeat(plan: PlanOrFailed, messages: readonly ChatMessage[], input: RepeatInput): Promise<PlanOrFailed> {
  if (plan === PLAN_FAILED || plan.question !== null) return plan;
  // proactive notices are not the assistant's own last answer
  const turns = input.memory.turns.filter((turn) => !turn.text.startsWith('[알림]'));
  const lastReply = [...turns].reverse().find((turn) => turn.role === 'assistant')?.text;
  const lastOwner = [...turns].reverse().find((turn) => turn.role === 'owner')?.text;
  if (lastReply === undefined || plan.reply.trim().length < 20) return plan;
  if (overlap(plan.reply, lastReply) < REPEAT || (lastOwner !== undefined && overlap(lastOwner, input.message.text) >= REPEAT)) return plan;
  input.deps.log.info('assistant: the reply repeated the last one; asking once more');
  const again = await requestPlan([...messages, { role: 'assistant', content: JSON.stringify(plan) }, { role: 'user', content: REPEAT_NOTE }], input.deps).catch((): PlanOrFailed => PLAN_FAILED);
  return again === PLAN_FAILED || again.tool_calls.length > 0 ? plan : again;
}
