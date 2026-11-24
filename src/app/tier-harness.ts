import type { ConfirmChoice } from '../core/policy/types.js';
import type { OwnerQuestions } from '../core/policy/questions.js';
import type { UsageReader } from '../core/contracts/usage.js';
import type { Tier, UsageLedger } from '../core/llm/types.js';
import type { Logger } from '../core/log/types.js';
import type { SecretReader } from '../core/secrets/types.js';
import { purposeGroup } from '../channels/app/views/ai.js';
import { CATALOG } from './llm-catalog.js';
import type { AppLlmControl, LineupModel, LlmSettings } from './llm-control.js';
import { family, isChatModel, listModels, newer, newestPerFamily, placeModel } from './model-rules.js';
import { afterEval, evaluateModel } from './model-evals.js';
import type { EvalResult } from './model-evals.js';
import { makeProvider } from './llm-providers.js';

/**
 * The tier harness (owner request): keeps the S/A/B/C lineup current by itself and spreads the work by what it costs.
 * - Discovery: each connected AI's own model list, daily and right after a connect; rules place each model.
 * - Review, weekly: 30 days of calls, failures and cost per purpose. Over budget → low-risk purposes one tier down
 *   (cheaper, applied with a note). Failing often → one tier up, and a new S model → asked once on a card.
 * - The owner's own order or purpose tier is never touched. Every change is logged in plain words for the app.
 */
const TIERS: readonly Tier[] = ['deep', 'standard', 'fast', 'cheap'];
const LETTER: Record<Tier, string> = { deep: 'S', standard: 'A', fast: 'B', cheap: 'C' };
const MAX_MODELS = 12;
const REVIEW_DAYS = 7;
const MIN_CALLS = 10;
const FAIL_RATE = 0.2;
/** Purposes where a cheaper model is fine when money is short (never a bot's own work or the main chat). */
const LOW_RISK = /^(knowledge|spending|memory|day|chat|phone|onboarding|trip)$/;

export interface TierHarnessOptions {
  control: AppLlmControl;
  secrets: SecretReader;
  usage: () => UsageReader | undefined;
  questions: () => OwnerQuestions | undefined;
  now: () => Date;
  log: Logger;
  fetch?: typeof fetch;
  /** Test calls count against the budget like any other. */
  ledger?: Pick<UsageLedger, 'record'>;
  /** Runs the small test set on a new model; tests replace it, `false` turns it off. */
  evaluate?: ((providerId: string, model: string, key: string) => Promise<EvalResult | undefined>) | false;
}

const MAX_EVALS = 6;

function label(id: string): string {
  return CATALOG.find((entry) => entry.id === id)?.label ?? id;
}

function up(tier: Tier): Tier {
  return TIERS[Math.max(0, TIERS.indexOf(tier) - 1)] ?? tier;
}

function down(tier: Tier): Tier {
  return TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(tier) + 1)] ?? tier;
}

export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d.getTime() - start.getTime()) / 86_400_000 + 1) / 7)).padStart(2, '0')}`;
}

export class TierHarness {
  constructor(private readonly opts: TierHarnessOptions) {}

  /** Reads the provider's model list and folds it into the lineup. `initial`: the owner just connected it. */
  async discover(id: string, key?: string, initial = false): Promise<string[]> {
    const provider = this.opts.control.providerConfig(id);
    if (provider?.apiKeySecret === undefined) return [];
    const secret = key ?? (await this.opts.secrets.get(provider.apiKeySecret).catch(() => undefined));
    if (secret === undefined || secret === '') return [];
    const listed = await listModels(provider, secret, this.opts.fetch);
    if (listed === undefined) return [];
    const chat = newestPerFamily(listed.filter(isChatModel)).slice(0, MAX_MODELS);
    // an empty answer is a hiccup, not a provider with no models: keep the lineup as it is
    if (chat.length === 0) return [];
    const settings = await this.opts.control.settings();
    const before = settings.lineup?.[id] ?? [];
    const at = this.opts.now().toISOString();
    const changes: string[] = [];
    // new models get the small test set first (a few per run, to keep it cheap)
    const scores = new Map<string, EvalResult>();
    const evaluate = this.opts.evaluate === false ? undefined : (this.opts.evaluate ?? ((provider: string, model: string, secretKey: string) => this.defaultEval(provider, model, secretKey)));
    if (evaluate !== undefined) {
      for (const model of chat.filter((item) => !before.some((known) => known.model === item)).slice(0, MAX_EVALS)) {
        const result = await evaluate(id, model, secret).catch(() => undefined);
        if (result !== undefined) scores.set(model, result);
      }
    }
    const lineup: LineupModel[] = chat.map((model) => {
      const known = before.find((item) => item.model === model);
      if (known !== undefined) return known;
      const rule = placeModel(model);
      const score = scores.get(model);
      const tested = score === undefined ? undefined : afterEval(rule.tiers, score);
      const place = { tiers: tested?.tiers ?? rule.tiers, note: tested === undefined ? rule.note : `${rule.note}, ${tested.note}` };
      const fresh = !initial && before.length > 0;
      const pending = fresh && place.tiers.includes('deep');
      if (fresh && !pending) changes.push(`${label(id)}의 새 모델 ${model}을 ${place.tiers.map((t) => LETTER[t]).join('·')}에 넣었어요 (${place.note})`);
      return {
        model,
        tiers: place.tiers,
        note: fresh ? `새로 나온 모델, ${place.note}` : place.note,
        at,
        ...(pending ? { pending: true } : {}),
        ...(score !== undefined ? { score: { passed: score.passed, total: score.total, ms: score.ms } } : {}),
      };
    });
    for (const gone of before.filter((item) => !chat.includes(item.model))) changes.push(`${label(id)}의 ${gone.model}은 더 이상 목록에 없어 뺐어요`);
    if (initial || before.length === 0) changes.unshift(`${label(id)}를 연결해서 모델 ${lineup.length}개를 등급표에 넣었어요`);
    await this.opts.control.harnessWrite((current) => this.reorder({ ...current, lineup: { ...current.lineup, [id]: lineup } }, id), changes);
    return changes;
  }

  /** Within a tier the owner has not ordered: a newer version of a family goes ahead of the older one. */
  private reorder(settings: LlmSettings, providerId: string): LlmSettings {
    const autoOrder = { ...settings.autoOrder };
    const models = (settings.lineup?.[providerId] ?? []).filter((item) => item.pending !== true && item.declined !== true);
    for (const tier of TIERS) {
      if (settings.order?.[tier] !== undefined) continue;
      const ids = models.filter((item) => item.tiers.includes(tier)).map((item) => `${providerId}/${item.model}`);
      const existing = (autoOrder[tier] ?? []).filter((id) => !id.startsWith(`${providerId}/`) || ids.includes(id));
      const merged = [...existing, ...ids.filter((id) => !existing.includes(id))];
      const score = (id: string): number => {
        const found = models.find((item) => `${providerId}/${item.model}` === id)?.score;
        return found === undefined ? 0.5 : found.passed / Math.max(1, found.total);
      };
      merged.sort((a, b) => {
        const ma = a.split('/')[1] ?? a;
        const mb = b.split('/')[1] ?? b;
        if (family(ma) === family(mb)) return newer(mb, ma);
        // a model that did worse on the test set goes behind one that did better
        return a.startsWith(`${providerId}/`) && b.startsWith(`${providerId}/`) ? score(b) - score(a) : 0;
      });
      autoOrder[tier] = merged;
    }
    return { ...settings, autoOrder };
  }

  private async defaultEval(providerId: string, model: string, key: string): Promise<EvalResult | undefined> {
    const provider = this.opts.control.providerConfig(providerId);
    if (provider === undefined) return undefined;
    const result = await evaluateModel(makeProvider(provider, key), model);
    await this.opts.ledger?.record({ at: this.opts.now(), purpose: 'llm.eval', providerId, model, usage: { inputTokens: 0, outputTokens: 0, costUsd: result.costUsd } }).catch(() => undefined);
    return result;
  }

  async discoverAll(): Promise<void> {
    for (const entry of CATALOG) await this.discover(entry.id).catch(() => []);
  }

  /** Weekly: shift purposes by cost and failures, and ask once about the bigger changes. */
  async review(force = false): Promise<string[]> {
    const settings = await this.opts.control.settings();
    const now = this.opts.now();
    if (!force && settings.reviewedAt !== undefined && now.getTime() - Date.parse(settings.reviewedAt) < REVIEW_DAYS * 86_400_000) return [];
    const rows = (await this.opts.usage()?.byPurposeModel?.(new Date(now.getTime() - 30 * 86_400_000)).catch(() => [])) ?? [];
    const stats = new Map<string, { calls: number; failures: number; tiers: Map<Tier, number> }>();
    for (const row of rows) {
      const id = purposeGroup(row.purpose);
      const entry = stats.get(id) ?? { calls: 0, failures: 0, tiers: new Map<Tier, number>() };
      entry.calls += row.calls;
      entry.failures += row.failures;
      if (row.tier === 'deep' || row.tier === 'standard' || row.tier === 'fast' || row.tier === 'cheap') entry.tiers.set(row.tier, (entry.tiers.get(row.tier) ?? 0) + row.calls);
      stats.set(id, entry);
    }
    const overBudget = await this.opts.control.overBudget();
    const autoPurposes = { ...settings.autoPurposes };
    const applied: string[] = [];
    const ups: { id: string; to: Tier }[] = [];
    for (const [id, entry] of stats) {
      if (settings.purposes?.[id] !== undefined) continue;
      const current = autoPurposes[id] ?? [...entry.tiers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'standard';
      const total = entry.calls + entry.failures;
      if (total >= MIN_CALLS && entry.failures / total > FAIL_RATE && current !== 'deep') ups.push({ id, to: up(current) });
      else if (overBudget && LOW_RISK.test(id) && current !== 'cheap') {
        autoPurposes[id] = down(current);
        applied.push(`예산이 빠듯해서 '${id}'를 ${LETTER[current]}에서 ${LETTER[down(current)]}로 낮췄어요`);
      }
    }
    // load: when one AI does almost all of a tier's work and another can take it, they take turns
    const spread = { ...settings.spread };
    const lineup = await this.opts.control.tiers();
    for (const tier of TIERS) {
      if (settings.order?.[tier] !== undefined) continue;
      const providers = new Set(lineup.find((row) => row.tier === tier)?.models.filter((model) => model.available).map((model) => model.id.split('/')[0]) ?? []);
      const calls = new Map<string, number>();
      for (const row of rows) if (row.tier === tier) calls.set(row.providerId, (calls.get(row.providerId) ?? 0) + row.calls);
      const total = [...calls.values()].reduce((sum, n) => sum + n, 0);
      const top = [...calls.entries()].sort((a, b) => b[1] - a[1])[0];
      const dominant = top !== undefined && total >= MIN_CALLS * 3 && top[1] / total > 0.8;
      const should = providers.size >= 2 && dominant;
      if (should && spread[tier] !== true) applied.push(`${LETTER[tier]} 등급 일이 ${label(top[0])}에 몰려서 연결된 AI들이 번갈아 맡게 했어요`);
      if (providers.size < 2 && spread[tier] === true) applied.push(`${LETTER[tier]} 등급에 AI가 하나뿐이라 번갈아 맡기기를 껐어요`);
      if (should) spread[tier] = true;
      else if (providers.size < 2) spread[tier] = false;
    }
    const pending = Object.entries(settings.lineup ?? {}).flatMap(([provider, list]) => list.filter((item) => item.pending === true).map((item) => ({ provider, item })));
    await this.opts.control.harnessWrite((current) => ({ ...current, autoPurposes, spread, reviewedAt: now.toISOString() }), applied);
    if (ups.length > 0 || pending.length > 0) void this.propose(isoWeek(now), ups, pending);
    return applied;
  }

  /** One card a week at most (R15 topic), for changes that cost more: purposes moving up, new S models. */
  private async propose(week: string, ups: readonly { id: string; to: Tier }[], pending: readonly { provider: string; item: LineupModel }[]): Promise<void> {
    const questions = this.opts.questions();
    if (questions === undefined) return;
    const lines = [
      ...ups.map((u) => `'${u.id}'가 자주 실패해서 ${LETTER[u.to]} 등급으로 올리기`),
      ...pending.map((p) => `${label(p.provider)}의 새 모델 ${p.item.model}을 S 1순위로 쓰기`),
    ];
    const choices: ConfirmChoice[] = [
      { id: 'apply', label: '그렇게 바꾸기', tone: 'primary', detail: '조금 더 비싼 모델을 써요', means: 'approved' },
      { id: 'keep', label: '지금 그대로', tone: 'danger', detail: '바꾸지 않아요', means: 'denied' },
      { id: 'later', label: '나중에', means: 'later' },
    ];
    const answer = await questions.ask({
      topic: `tiers:review:${week}`,
      summary: '등급표를 이렇게 바꿀까요?',
      note: `AI 등급표를 점검했어요(지난 30일 사용량·실패·비용). ${lines.join(' / ')}`.slice(0, 400),
      choices,
      askedBy: 'core.tiers',
    }).catch(() => undefined);
    if (answer?.status !== 'answered') return;
    const yes = answer.means === 'approved';
    await this.opts.control.harnessWrite((current) => {
      const lineup = { ...current.lineup };
      for (const p of pending) lineup[p.provider] = (lineup[p.provider] ?? []).map((item) => (item.model === p.item.model ? { ...item, pending: false, ...(yes ? {} : { declined: true }) } : item));
      const autoPurposes = { ...current.autoPurposes };
      if (yes) for (const u of ups) if (current.purposes?.[u.id] === undefined) autoPurposes[u.id] = u.to;
      const autoOrder = { ...current.autoOrder };
      if (yes && current.order?.deep === undefined) autoOrder.deep = [...pending.map((p) => `${p.provider}/${p.item.model}`), ...(autoOrder.deep ?? []).filter((id) => !pending.some((p) => id === `${p.provider}/${p.item.model}`))];
      return { ...current, lineup, autoPurposes, autoOrder };
    }, yes ? lines.map((line) => `오너가 승인: ${line}`) : ['오너가 등급표를 그대로 두기로 했어요']);
  }
}
