import type { LlmProviderPreset } from './setup-llm.js';

export type LlmCheck = { ok: true } | { ok: false; reason: string };

/** One quick look per provider before setup saves it: the model list answers without spending any tokens. */
export async function checkProvider(provider: LlmProviderPreset, key: string | undefined, fetchImpl: typeof fetch = fetch, model?: string): Promise<LlmCheck> {
  const timeout = AbortSignal.timeout(10_000);
  try {
    if (provider.kind === 'anthropic') {
      const response = await fetchImpl('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' }, signal: timeout });
      return answer(response.status);
    }
    if (provider.kind === 'openai-compatible' && provider.baseUrl !== undefined) {
      const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(provider.baseUrl);
      const response = await fetchImpl(`${provider.baseUrl.replace(/\/+$/, '')}/models`, { headers: key !== undefined ? { authorization: `Bearer ${key}` } : {}, signal: timeout });
      if (!local || !response.ok || model === undefined) return answer(response.status);
      // a local server answers even without the model: say which one to pull
      const body = (await response.json().catch(() => ({}))) as { data?: { id?: string }[] };
      const ids = (body.data ?? []).map((item) => item.id ?? '');
      return ids.some((id) => id === model || id.startsWith(`${model}:`)) ? { ok: true } : { ok: false, reason: `이 컴퓨터에 ${model} 모델이 없어요. 터미널에서 \`ollama pull ${model}\`을 실행해 주세요.` };
    }
    return { ok: true };
  } catch {
    return provider.baseUrl?.startsWith('http://127.0.0.1') === true
      ? { ok: false, reason: 'Ollama가 켜져 있지 않아요. Ollama 앱을 설치하고 켠 뒤 다시 골라 주세요 (https://ollama.com).' }
      : { ok: false, reason: '인터넷에 연결되지 않았거나 AI 서비스에 닿지 않아요. 연결을 확인하고 다시 해 주세요.' };
  }
}

function answer(status: number): LlmCheck {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 401 || status === 403) return { ok: false, reason: 'API 키가 맞지 않아요. 키를 다시 복사해서 넣어 주세요.' };
  if (status === 402 || status === 429) return { ok: false, reason: '키는 맞는데 잔액이나 사용 한도가 부족해요. 그 서비스의 결제·한도 화면을 확인해 주세요.' };
  return { ok: false, reason: `AI 서비스가 지금 답하지 않아요 (${status}). 잠시 뒤 다시 해 주세요.` };
}
