import type { ChatMessage, LlmRequest, LlmResponse } from '../../core/llm/types.js';
import type { Logger } from '../../core/log/types.js';
import type { LlmGateway } from '../../core/llm/types.js';
import type { Plan } from './plan.js';
import { PLAN_SCHEMA, parsePlan } from './plan.js';

export const PLAN_FAILED = 'plan_failed';
export type PlanOrFailed = Plan | typeof PLAN_FAILED;

/** Enough for a long answer; a reply cut off at the limit is asked for once more with the larger one. */
export const PLAN_TOKENS = 2_500;
export const PLAN_TOKENS_LONG = 6_000;

export interface PlanDeps {
  llm: LlmGateway;
  log: Logger;
  purpose?: string;
}

export function request(messages: readonly ChatMessage[], purpose = 'assistant.turn', maxOutputTokens = PLAN_TOKENS): LlmRequest {
  return { purpose, tier: 'standard', sensitivity: 'sensitive', messages, jsonSchema: PLAN_SCHEMA, maxOutputTokens };
}

/**
 * The model stopped at the output limit: the JSON starts but never closes, or the reply used (nearly) every token it
 * was allowed.
 */
export function looksTruncated(response: LlmResponse, limit: number): boolean {
  const text = response.text.trim();
  if (response.usage.outputTokens >= limit * 0.98) return true;
  const start = text.indexOf('{');
  if (start < 0) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of text.slice(start)) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
  }
  return depth > 0 || inString;
}

export async function requestPlan(messages: readonly ChatMessage[], deps: PlanDeps): Promise<PlanOrFailed> {
  let first = await deps.llm.complete(request(messages, deps.purpose));
  let parsed = parsePlan(first.text);
  if ('plan' in parsed) return parsed.plan;

  if (looksTruncated(first, PLAN_TOKENS)) {
    deps.log.info('assistant plan was cut off at the output limit; asking once with a larger one');
    first = await deps.llm.complete(request(messages, deps.purpose, PLAN_TOKENS_LONG));
    parsed = parsePlan(first.text);
    if ('plan' in parsed) return parsed.plan;
  }

  const retried = parsePlan(
    (
      await deps.llm.complete(
        request(
          [
            ...messages,
            { role: 'assistant', content: first.text },
            { role: 'user', content: `Your reply could not be used: ${parsed.error}. Reply again with one JSON object that matches the schema.` },
          ],
          deps.purpose,
          PLAN_TOKENS_LONG,
        ),
      )
    ).text,
  );
  if ('plan' in retried) return retried.plan;
  deps.log.warn('assistant plan invalid after retry', { error: retried.error });
  return PLAN_FAILED;
}
