import type { LlmProvider, LlmRequest } from '../core/llm/types.js';

/**
 * A tiny test set run once on each newly found model before it is placed: valid JSON, a plain Korean sentence, and
 * following an exact instruction. Three short calls (about 100 output tokens each); results decide how far down the
 * tier a model goes and are shown in its note.
 */
export interface EvalResult {
  passed: number;
  total: number;
  ms: number;
  costUsd: number;
}

interface EvalCase {
  id: string;
  prompt: string;
  check: (text: string) => boolean;
}

const CASES: readonly EvalCase[] = [
  {
    id: 'json',
    prompt: 'Return only this JSON object with the value filled in, nothing else: {"sum": <2 + 3>}',
    check: (text) => {
      const match = /\{[\s\S]*\}/.exec(text);
      try {
        return match !== null && (JSON.parse(match[0]) as { sum?: unknown }).sum === 5;
      } catch {
        return false;
      }
    },
  },
  {
    id: 'korean',
    prompt: '다음 내용을 한국어 한 문장으로 짧게 요약해 줘: 회의에서 다음 주 금요일까지 결제 화면 설계안을 만들기로 했다.',
    check: (text) => /[가-힣]/.test(text) && /금요일/.test(text) && text.trim().length <= 200,
  },
  {
    id: 'exact',
    prompt: '다른 말 없이 "바나나" 한 단어만 답해.',
    check: (text) => text.replace(/["'.。\s]/g, '') === '바나나',
  },
];

export async function evaluateModel(provider: LlmProvider, model: string, now: () => number = Date.now): Promise<EvalResult> {
  let passed = 0;
  let ms = 0;
  let costUsd = 0;
  for (const item of CASES) {
    const request: LlmRequest = { purpose: 'llm.eval', tier: 'fast', sensitivity: 'public', messages: [{ role: 'user', content: item.prompt }], maxOutputTokens: 120 };
    const started = now();
    try {
      const response = await provider.complete(model, request);
      costUsd += response.usage.costUsd;
      if (item.check(response.text)) passed += 1;
    } catch {
      // a failed call is a failed case
    }
    ms += now() - started;
  }
  return { passed, total: CASES.length, ms: Math.round(ms / CASES.length), costUsd: Math.round(costUsd * 10_000) / 10_000 };
}

/** Where a model goes after its test: two of three or better keeps its place; worse drops it one tier. */
export function afterEval(tiers: readonly ('deep' | 'standard' | 'fast' | 'cheap')[], result: EvalResult): { tiers: ('deep' | 'standard' | 'fast' | 'cheap')[]; note: string } {
  const seconds = (result.ms / 1000).toFixed(1);
  if (result.passed * 3 >= result.total * 2) return { tiers: [...tiers], note: `시험 ${result.total}개 중 ${result.passed}개 통과 · 평균 ${seconds}초` };
  const order = ['deep', 'standard', 'fast', 'cheap'] as const;
  const lowered = [...new Set(tiers.map((tier) => order[Math.min(3, order.indexOf(tier) + 1)] ?? 'cheap'))];
  return { tiers: lowered, note: `시험 ${result.total}개 중 ${result.passed}개만 통과해서 한 등급 낮췄어요` };
}
