import type { ChatMessage, LlmProvider, LlmRequest, LlmResponse } from '../types.js';
import type { DeadlineConfig } from './deadline.js';
import { HTTP_DEADLINES_MS, deadlineFor, withDeadline } from './deadline.js';
import { httpError } from './http-error.js';

interface AnthropicOptions {
  id: string;
  apiKey: string;
  baseUrl?: string;
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
  fetch?: typeof fetch;
  /** Per-attempt deadline (request and body read), in ms; one number or one per tier. */
  timeoutMs?: DeadlineConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function buildSystem(messages: readonly ChatMessage[], schema: Record<string, unknown> | undefined): string {
  const parts = messages.filter((message) => message.role === 'system').map((message) => message.content);
  if (schema !== undefined) {
    parts.push(`Respond with a single JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}`);
  }
  return parts.join('\n\n');
}

/** Models whose thinking cannot be turned off (Claude 5 generation): effort is the only control. */
const THINKING_MODEL = /claude-(fable|mythos|opus|sonnet|haiku)-5/;
const EFFORT: Record<LlmRequest['tier'], 'low' | 'medium' | 'high'> = { cheap: 'low', fast: 'low', standard: 'medium', deep: 'high' };
const THINKING_ROOM: Record<LlmRequest['tier'], number> = { cheap: 1_024, fast: 1_024, standard: 4_096, deep: 8_192 };

export function createAnthropicProvider(opts: AnthropicOptions): LlmProvider {
  const baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const priceIn = opts.priceInPerMTok ?? 0;
  const priceOut = opts.priceOutPerMTok ?? 0;

  return {
    id: opts.id,
    async complete(model: string, request: LlmRequest): Promise<LlmResponse> {
      const system = buildSystem(request.messages, request.jsonSchema);
      const messages = request.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({ role: message.role, content: message.content }));
      const thinks = THINKING_MODEL.test(model);
      const body: Record<string, unknown> = {
        model,
        // these models always think first, and thinking counts toward max_tokens: room for it keeps the answer whole
        max_tokens: (request.maxOutputTokens ?? 1024) + (thinks ? THINKING_ROOM[request.tier] : 0),
        messages,
        // how hard to think follows the tier: quick jobs stay quick and cheap
        ...(thinks ? { output_config: { effort: EFFORT[request.tier] } } : {}),
      };
      if (system.length > 0) body.system = system;

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      };
      const timeoutMs = deadlineFor(request.tier, opts.timeoutMs, HTTP_DEADLINES_MS);
      const data: unknown = await withDeadline(timeoutMs, request.signal, async (signal) => {
        const response = await doFetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal });
        if (!response.ok) throw await httpError(response);
        return (await response.json()) as unknown;
      });
      if (!isRecord(data)) throw new Error('Malformed response from LLM provider');
      // a declined request has no usable text: the gateway moves on to the next route
      if (data.stop_reason === 'refusal') throw new Error('The model declined this request (refusal).');
      const blocks = Array.isArray(data.content) ? data.content : [];
      let text = '';
      for (const block of blocks) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
          text += block.text;
        }
      }

      const usage = isRecord(data.usage) ? data.usage : {};
      const inputTokens = numberOrZero(usage.input_tokens);
      const outputTokens = numberOrZero(usage.output_tokens);
      return {
        text,
        providerId: opts.id,
        model,
        usage: {
          inputTokens,
          outputTokens,
          costUsd: (inputTokens / 1e6) * priceIn + (outputTokens / 1e6) * priceOut,
        },
      };
    },
  };
}
