import { z } from 'zod';
import { Contracts } from '../../../core/contracts/index.js';
import type { AppView, DeviceApi } from '../../../core/contracts/device-api.js';
import { ViewInputError, ownerInputError } from '../../../core/contracts/device-api.js';
import type { LlmControl } from '../../../core/contracts/llm-control.js';
import type { Tier } from '../../../core/llm/types.js';
import type { PluginContext } from '../../../core/plugin/types.js';

/** R12: the app's letters for the gateway's tiers, strongest first. */
const LETTERS: Record<Tier, 'S' | 'A' | 'B' | 'C'> = { deep: 'S', standard: 'A', fast: 'B', cheap: 'C' };
const TIER_OF: Record<string, Tier> = { S: 'deep', A: 'standard', B: 'fast', C: 'cheap' };
const DAYS = 7;

const TIER_TEXT = {
  ko: { deep: '가장 똑똑해요 · 비싸요', standard: '보통이에요 · 대부분의 일', fast: '빠르고 싸요 · 간단한 일', cheap: '가장 싸요 · 작은 모델·맥 안 모델' },
  en: { deep: 'Smartest · costly', standard: 'Everyday work', fast: 'Fast and cheap', cheap: 'Cheapest · small or local models' },
} as const;

const PURPOSE_LABELS: Record<string, { ko: string; en: string }> = {
  assistant: { ko: '비서 대화', en: 'Assistant chat' },
  recordings: { ko: '회의록 정리', en: 'Meeting notes' },
  browser: { ko: '웹사이트 대신 하기', en: 'Browsing for you' },
  company: { ko: '회사 팀 일', en: 'Company teams' },
  knowledge: { ko: '문서 정리', en: 'Organizing documents' },
  onboarding: { ko: '처음 문서 살펴보기', en: 'First document scan' },
  spending: { ko: '지출 분류', en: 'Spending' },
  day: { ko: '하루 정리', en: 'Daily help' },
  dev: { ko: '코드 작업', en: 'Code work' },
  memory: { ko: '기억 정리', en: 'Memory' },
  chat: { ko: '메시지 살펴보기', en: 'Messages' },
  phone: { ko: '문자 살펴보기', en: 'Texts' },
  trip: { ko: '여행 정리', en: 'Trips' },
};

/** "bot.dev.x" → "bot.dev", everything else → its first word, which is what the owner picks a tier for. */
export function purposeGroup(purpose: string): string {
  const parts = purpose.split('.');
  return parts[0] === 'bot' && parts[1] !== undefined ? `bot.${parts[1]}` : (parts[0] ?? purpose);
}

export function providersView(control: LlmControl): AppView {
  return {
    name: 'providers',
    version: 1,
    async read() {
      return { providers: await control.providers() };
    },
  };
}

/** Separate routes, not view actions, so a key never sits in a view body, a log line or an audit detail. */
export function registerProviderRoutes(api: DeviceApi, control: () => LlmControl | undefined): void {
  const keyBody = z.object({ apiKey: z.string().min(1).max(400) });
  api.route('POST', 'providers/:id/key', async (request) => {
    const llm = control();
    const parsed = keyBody.safeParse(request.body);
    if (llm === undefined || !parsed.success) return { status: 400, body: { error: 'shape' } };
    const result = await llm.connect(request.params.id ?? '', parsed.data.apiKey);
    return result.ok ? { status: 200, body: { ok: true, status: result.status, detail: result.detail } } : { status: 400, body: { ok: false, error: 'key', message: result.reason } };
  });
  api.route('POST', 'providers/:id/disconnect', async (request) => {
    const llm = control();
    if (llm === undefined) return { status: 400, body: { error: 'shape' } };
    return (await llm.disconnect(request.params.id ?? '')) ? { status: 200, body: { ok: true } } : { status: 400, body: { ok: false, error: 'not_editable' } };
  });
}

const rankBody = z.object({ tier: z.enum(['S', 'A', 'B', 'C']), order: z.array(z.string().min(1).max(200)).max(50) });
const purposeBody = z.object({ id: z.string().regex(/^[a-z0-9_-]+(\.[a-z0-9_-]+)?$/).max(80), tier: z.enum(['S', 'A', 'B', 'C']).nullable() });

export function modelTiersView(ctx: PluginContext, control: LlmControl): AppView {
  const lang = ctx.assistant.language === 'en' ? 'en' : 'ko';
  return {
    name: 'modeltiers',
    version: 1,
    async read() {
      const since = new Date(ctx.clock.now().getTime() - DAYS * 86_400_000);
      const rows = (await ctx.tryUse(Contracts.usage)?.byPurposeModel?.(since).catch(() => [])) ?? [];
      const chosen = await control.purposeTiers();
      const harness = await control.harnessState();
      const purposes = new Map<string, { calls: number; asked: Map<Tier, number> }>();
      const touch = (id: string): { calls: number; asked: Map<Tier, number> } => {
        const found = purposes.get(id);
        if (found !== undefined) return found;
        const fresh = { calls: 0, asked: new Map<Tier, number>() };
        purposes.set(id, fresh);
        return fresh;
      };
      for (const row of rows) {
        const entry = touch(purposeGroup(row.purpose));
        entry.calls += row.calls;
        if (row.tier === 'deep' || row.tier === 'standard' || row.tier === 'fast' || row.tier === 'cheap') entry.asked.set(row.tier, (entry.asked.get(row.tier) ?? 0) + row.calls + row.failures);
      }
      const bots = (await ctx.tryUse(Contracts.bots)?.list().catch(() => [])) ?? [];
      for (const bot of bots) touch(`bot.${bot.id}`);
      for (const id of chosen.keys()) touch(id);
      touch('assistant');
      return {
        ...(harness.changes[0] !== undefined ? { changedAt: harness.changes[0].at } : {}),
        changes: harness.changes.slice(0, 10).map((change) => ({ at: change.at, text: change.text })),
        tiers: (await control.tiers()).map((row) => ({
          id: LETTERS[row.tier],
          label: lang === 'en' ? `Tier ${LETTERS[row.tier]}` : `${LETTERS[row.tier]} 등급`,
          summary: TIER_TEXT[lang][row.tier],
          models: row.models,
        })),
        purposes: [...purposes.entries()]
          .map(([id, entry]) => {
            const bot = id.startsWith('bot.') ? bots.find((item) => `bot.${item.id}` === id) : undefined;
            const asked = [...entry.asked.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'standard';
            const tier = chosen.get(id) ?? harness.autoPurposes[id] ?? asked;
            return {
              id,
              label: bot?.name ?? PURPOSE_LABELS[id]?.[lang] ?? id,
              ...(bot?.role !== undefined ? { detail: bot.role } : {}),
              tier: LETTERS[tier],
              chosen: chosen.has(id),
              calls7d: entry.calls,
            };
          })
          .sort((a, b) => b.calls7d - a.calls7d || a.label.localeCompare(b.label)),
      };
    },
    actions: {
      async rank(body) {
        const parsed = rankBody.safeParse(body);
        if (!parsed.success) throw new ViewInputError('rank needs {tier, order}');
        const tier = TIER_OF[parsed.data.tier] as Tier;
        if (!(await control.rank(tier, parsed.data.order))) throw ownerInputError(lang === 'en' ? 'The order must list the same models' : '같은 모델을 순서만 바꿔 보내 주세요');
        return { tier: parsed.data.tier, order: parsed.data.order };
      },
      async purpose(body) {
        const parsed = purposeBody.safeParse(body);
        if (!parsed.success) throw new ViewInputError('purpose needs {id, tier}');
        await control.setPurpose(parsed.data.id, parsed.data.tier === null ? null : (TIER_OF[parsed.data.tier] as Tier));
        return { id: parsed.data.id, tier: parsed.data.tier };
      },
    },
  };
}
