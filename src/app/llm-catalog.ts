import type { Config } from '../core/config/schema.js';
import type { LlmRoute, Sensitivity, Tier } from '../core/llm/types.js';

/**
 * AIs the owner can connect from the app with only a key. Prices are USD per million tokens for the budget (one rate
 * per provider, the middle model's), so the daily and monthly limits stay roughly right.
 */
export interface CatalogEntry {
  id: string;
  label: string;
  kind: 'anthropic' | 'openai-compatible';
  baseUrl: string;
  secret: string;
  priceIn: number;
  priceOut: number;
  /** DeepSeek runs abroad under other rules: sensitive personal data stays with the other AIs. */
  maxSensitivity: Sensitivity;
  models: readonly { model: string; tiers: readonly Tier[] }[];
  help: { ko: string; en: string };
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'anthropic',
    label: 'Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    secret: 'llm.anthropic.api-key',
    priceIn: 2,
    priceOut: 10,
    maxSensitivity: 'sensitive',
    models: [
      { model: 'claude-fable-5-2', tiers: ['deep'] },
      { model: 'claude-opus-5-5', tiers: ['deep'] },
      { model: 'claude-sonnet-5-5', tiers: ['standard'] },
      { model: 'claude-haiku-5-5', tiers: ['fast', 'cheap'] },
    ],
    help: { ko: 'platform.claude.com 에서 API 키를 만들 수 있어요.', en: 'Create an API key at platform.claude.com.' },
  },
  {
    id: 'openai',
    label: 'ChatGPT',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    secret: 'llm.openai.api-key',
    priceIn: 1.25,
    priceOut: 10,
    maxSensitivity: 'sensitive',
    models: [
      { model: 'gpt-5', tiers: ['deep', 'standard'] },
      { model: 'gpt-5-mini', tiers: ['fast', 'cheap'] },
    ],
    help: { ko: 'platform.openai.com 에서 API 키를 만들 수 있어요.', en: 'Create an API key at platform.openai.com.' },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    secret: 'llm.deepseek.api-key',
    priceIn: 0.27,
    priceOut: 1.1,
    maxSensitivity: 'masked',
    models: [
      { model: 'deepseek-reasoner', tiers: ['deep'] },
      { model: 'deepseek-chat', tiers: ['standard', 'fast', 'cheap'] },
    ],
    help: {
      ko: 'platform.deepseek.com 에서 키를 만들 수 있어요. 민감한 개인정보는 다른 AI가 맡아요.',
      en: 'Create a key at platform.deepseek.com. Sensitive personal data stays with the other AIs.',
    },
  },
];

export type ProviderConfig = Config['llm']['providers'][number];

/** The provider config a catalog entry becomes, unless the owner's config already defines that id. */
export function catalogProvider(entry: CatalogEntry): ProviderConfig {
  return { id: entry.id, kind: entry.kind, baseUrl: entry.baseUrl, apiKeySecret: entry.secret, priceIn: entry.priceIn, priceOut: entry.priceOut };
}

export function catalogRoutes(entry: CatalogEntry): LlmRoute[] {
  return entry.models.map((m) => ({ providerId: entry.id, model: m.model, tiers: m.tiers, maxSensitivity: entry.maxSensitivity }));
}

/** One small, free call that proves the key works. Never logs or returns the key. */
export async function checkKey(
  provider: ProviderConfig,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'ok' | 'rejected' | 'unreachable'> {
  const base = (provider.baseUrl ?? (provider.kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
  const url = provider.kind === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
  const headers: Record<string, string> =
    provider.kind === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` };
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (response.ok) return 'ok';
    return response.status === 401 || response.status === 403 ? 'rejected' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}
