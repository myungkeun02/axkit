import type { Tier } from '../core/llm/types.js';

/**
 * Where a model sits in the S/A/B/C lineup, decided by rules from its name family and size, never by asking the model
 * itself. Each placement comes with one plain Korean line saying why, shown in the app.
 */
export interface Placement {
  tiers: Tier[];
  note: string;
}

/** Chat models only: embeddings, images, speech and moderation endpoints are not for routing. */
const NOT_CHAT = /embed|whisper|tts|audio|dall-e|image|moderation|realtime|transcribe|search|similarity|edit|babbage|davinci|instruct|computer-use|codex-mini-latest/i;

export function isChatModel(id: string): boolean {
  return !NOT_CHAT.test(id);
}

const RULES: readonly { test: RegExp; tiers: Tier[]; why: string }[] = [
  { test: /fable|mythos|opus|-pro\b|reasoner|^o\d(?!-mini)|-max\b/i, tiers: ['deep'], why: '가장 똑똑한 계열이라 S' },
  { test: /nano|lite|tiny|\b[1-8]b\b|small/i, tiers: ['cheap'], why: '작고 싼 모델이라 C' },
  { test: /haiku|mini|flash/i, tiers: ['fast', 'cheap'], why: '빠르고 싼 계열이라 B·C' },
  { test: /sonnet|gpt-\d|chat|large|medium/i, tiers: ['standard', 'fast'], why: '보통 일에 알맞은 계열이라 A·B' },
];

export function placeModel(id: string): Placement {
  const rule = RULES.find((item) => item.test.test(id));
  return rule === undefined ? { tiers: ['standard'], note: '계열을 몰라 A 맨 뒤에 뒀어요' } : { tiers: rule.tiers, note: rule.why };
}

/** "claude-opus-5-5" → [5, 5]; "gpt-5.1-mini" → [5, 1]. Used to put a newer model of the same family first. */
export function versionOf(id: string): number[] {
  return (id.match(/\d+(?:[.-]\d+)*/)?.[0] ?? '0').split(/[.-]/).map(Number).filter((n) => n < 1000);
}

export function family(id: string): string {
  return id.replace(/[-.]?\d+(?:[.-]\d+)*/g, '').replace(/-(latest|preview)$/, '');
}

export function newer(a: string, b: string): number {
  const va = versionOf(a);
  const vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
    const d = (va[i] ?? 0) - (vb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Of several versions of one family, only the newest two are worth routing to (older ones stay out of the lineup). */
export function newestPerFamily(ids: readonly string[], keep = 1): string[] {
  const byFamily = new Map<string, string[]>();
  for (const id of ids) byFamily.set(family(id), [...(byFamily.get(family(id)) ?? []), id]);
  return [...byFamily.values()].flatMap((list) => [...list].sort((a, b) => newer(b, a)).slice(0, keep));
}

/** The provider's own model list: OpenAI-compatible `/models` or Anthropic `/v1/models`. Undefined when unreachable. */
export async function listModels(
  provider: { kind: string; baseUrl?: string | undefined },
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | undefined> {
  const anthropic = provider.kind === 'anthropic';
  const base = (provider.baseUrl ?? (anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
  try {
    const response = await fetchImpl(anthropic ? `${base}/v1/models?limit=100` : `${base}/models`, {
      headers: anthropic ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string' && id.length <= 80);
  } catch {
    return undefined;
  }
}
