import type { ChatMessage, LlmProvider, LlmRequest, LlmResponse } from '../types.js';
import type { DeadlineConfig } from './deadline.js';
import { HTTP_DEADLINES_MS, deadlineFor, withDeadline } from './deadline.js';
import { httpError } from './http-error.js';

interface OpenAiCompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
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

function withSchema(messages: readonly ChatMessage[], schema: Record<string, unknown>): ChatMessage[] {
  const hint = `Respond with a single JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}`;
  const copy = messages.map((message) => ({ ...message }));
  const index = copy.findIndex((message) => message.role === 'system');
  if (index >= 0) {
    const existing = copy[index];
    if (existing !== undefined) copy[index] = { ...existing, content: `${existing.content}\n\n${hint}` };
    return copy;
  }
  copy.unshift({ role: 'system', content: hint });
  return copy;
}

export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions): LlmProvider {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const priceIn = opts.priceInPerMTok ?? 0;
  const priceOut = opts.priceOutPerMTok ?? 0;

  return {
    id: opts.id,
    async complete(model: string, request: LlmRequest): Promise<LlmResponse> {
      const messages = request.jsonSchema !== undefined
        ? withSchema(request.messages, request.jsonSchema)
        : request.messages.map((message) => ({ ...message }));
      const body: Record<string, unknown> = { model, messages };
      if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
      if (request.jsonSchema !== undefined) body.response_format = { type: 'json_object' };

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.apiKey !== undefined) headers.authorization = `Bearer ${opts.apiKey}`;

      const timeoutMs = deadlineFor(request.tier, opts.timeoutMs, HTTP_DEADLINES_MS);
      const data: unknown = await withDeadline(timeoutMs, request.signal, async (signal) => {
        const response = await doFetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
        if (!response.ok) throw await httpError(response);
        return (await response.json()) as unknown;
      });
      if (!isRecord(data)) throw new Error('Malformed response from LLM provider');
      const choices = Array.isArray(data.choices) ? data.choices : [];
      const first = choices[0];
      const message = isRecord(first) ? first.message : undefined;
      const content = isRecord(message) ? message.content : undefined;
      if (typeof content !== 'string') throw new Error('Malformed response from LLM provider');

      const usage = isRecord(data.usage) ? data.usage : {};
      const inputTokens = numberOrZero(usage.prompt_tokens);
      const outputTokens = numberOrZero(usage.completion_tokens);
      return {
        text: content,
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
