import { describe, expect, it } from 'vitest';
import { AppLlmControl } from '../../src/app/llm-control.js';
import { placeModel, newestPerFamily } from '../../src/app/model-rules.js';
import { TierHarness, isoWeek } from '../../src/app/tier-harness.js';
import { checkComposition, decideComposition, defaultComposition } from '../../src/core/bots/composition.js';
import { parseConfig } from '../../src/core/config/load.js';
import type { PurposeModelUsage } from '../../src/core/contracts/usage.js';
import { RoutingLlmGateway } from '../../src/core/llm/gateway.js';
import type { LlmGateway, LlmProvider, UsageLedger } from '../../src/core/llm/types.js';
import { MemoryAuditLog, silentLogger } from '../../src/core/log/console-logger.js';
import type { OwnerQuestions } from '../../src/core/policy/questions.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { MapKeyValueStore } from '../core/helpers.js';

const NOW = new Date('2026-11-19T00:00:00Z');

function setup(models: string[], spent = 0, passed = 3) {
  const seen: string[] = [];
  const local: LlmProvider = {
    id: 'mac',
    async complete(model, request) {
      seen.push(`${model}/${request.tier}`);
      return { text: 'ok', providerId: 'mac', model, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  };
  const config = parseConfig({ version: 1, assistant: { name: '비서', timezone: 'Asia/Seoul' }, channel: 'app', llm: { providers: [{ id: 'mac', kind: 'claude-cli' }], routes: [{ providerId: 'mac', model: 'cli', tiers: ['deep', 'standard', 'fast'], maxSensitivity: 'sensitive' }], budget: { dailyUsd: 1, monthlyUsd: 20 } } });
  const ledger: UsageLedger = { record: async () => undefined, spentUsd: async () => spent };
  const gateway = new RoutingLlmGateway({ providers: [local], routes: config.llm.routes, budget: { dailyUsd: 100, monthlyUsd: 1000 }, ledger, timeZone: 'Asia/Seoul', log: silentLogger });
  const secrets = new MemorySecretStore({});
  const list = { models };
  const fakeFetch = (async (url: string) => (url.includes('/models') ? new Response(JSON.stringify({ data: list.models.map((id) => ({ id })) })) : new Response('{}'))) as unknown as typeof fetch;
  const holder: { harness?: TierHarness } = {};
  const control = new AppLlmControl({ config, secrets, gateway, kv: new MapKeyValueStore(), audit: new MemoryAuditLog(), ledger, now: () => NOW, fetch: fakeFetch, onConnected: async (id, key) => await holder.harness?.discover(id, key, true) });
  const asked: string[] = [];
  const questions = { ask: async (request: { topic: string }) => (asked.push(request.topic), { status: 'answered', choice: 'apply', means: 'approved', reused: false }) } as unknown as OwnerQuestions;
  const rows: PurposeModelUsage[] = [];
  holder.harness = new TierHarness({ control, secrets, usage: () => ({ byPurpose: async () => [], byPurposeModel: async () => rows }), questions: () => questions, now: () => NOW, log: silentLogger, fetch: fakeFetch, evaluate: async () => ({ passed, total: 3, ms: 1200, costUsd: 0 }) });
  return { control, gateway, harness: holder.harness, list, asked, rows, seen };
}

describe('tier C and the tier harness', () => {
  it('runs C on B until a cheap model exists', async () => {
    const { gateway, seen } = setup([]);
    await gateway.complete({ purpose: 'x', tier: 'cheap', sensitivity: 'public', messages: [] });
    expect(seen).toEqual(['cli/cheap']);
  });

  it('places models by family, newest first', () => {
    expect(placeModel('claude-opus-5-5').tiers).toEqual(['deep']);
    expect(placeModel('claude-haiku-5-5').tiers).toEqual(['fast', 'cheap']);
    expect(placeModel('gpt-5-nano').tiers).toEqual(['cheap']);
    expect(newestPerFamily(['claude-opus-4-8', 'claude-opus-5-5', 'claude-sonnet-5'])).toEqual(['claude-opus-5-5', 'claude-sonnet-5']);
  });

  it('adds every usable model on connect, holds a later new S model for the owner, and logs changes', async () => {
    const { control, harness, list, asked } = setup(['claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'text-embedding-3']);
    await control.connect('anthropic', 'sk-ant-1234567890abcdef');
    const tiers = await control.tiers();
    expect(tiers.find((t) => t.tier === 'deep')?.models.map((m) => m.id)).toContain('anthropic/claude-opus-5');
    expect(tiers.find((t) => t.tier === 'cheap')?.models.map((m) => m.id)).toEqual(['anthropic/claude-haiku-5-5']);
    expect(JSON.stringify(tiers)).not.toContain('embedding');
    expect(tiers.find((t) => t.tier === 'deep')?.models.find((m) => m.id === 'anthropic/claude-opus-5')?.note).toContain('S');
    expect((await control.harnessState()).changes[0]?.text).toContain('Claude를 연결해서 모델 3개');

    list.models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
    await harness.discover('anthropic');
    let deep = (await control.tiers()).find((t) => t.tier === 'deep')?.models.map((m) => m.id);
    expect(deep).not.toContain('anthropic/claude-opus-5-5');
    await harness.review(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toEqual([`tiers:review:${isoWeek(NOW)}`]);
    deep = (await control.tiers()).find((t) => t.tier === 'deep')?.models.map((m) => m.id);
    expect(deep?.[0]).toBe('anthropic/claude-opus-5-5');
  });

  it('moves low-risk purposes down when over budget, never one the owner chose', async () => {
    const { control, harness, rows } = setup([], 100);
    rows.push({ purpose: 'spending.category', providerId: 'mac', model: 'cli', tier: 'standard', calls: 30, failures: 0, costUsd: 1 });
    rows.push({ purpose: 'knowledge.classify', providerId: 'mac', model: 'cli', tier: 'standard', calls: 30, failures: 0, costUsd: 1 });
    rows.push({ purpose: 'bot.dev', providerId: 'mac', model: 'cli', tier: 'deep', calls: 30, failures: 0, costUsd: 1 });
    await control.setPurpose('knowledge', 'deep');
    await harness.review(true);
    const state = await control.harnessState();
    expect(state.autoPurposes).toEqual({ spending: 'fast' });
    expect(state.changes[0]?.text).toContain("'spending'");
    expect(await harness.review()).toEqual([]);
  });
});

describe('test set, load spreading and team resize', () => {
  it('drops a model that fails the test set one tier and says why', async () => {
    const { control } = setup(['claude-opus-5-5', 'claude-haiku-5-5'], 0, 1);
    await control.connect('anthropic', 'sk-ant-1234567890abcdef');
    const tiers = await control.tiers();
    expect(tiers.find((t) => t.tier === 'deep')?.models.map((m) => m.id)).toEqual(['mac/cli']);
    expect(tiers.find((t) => t.tier === 'standard')?.models.find((m) => m.id === 'anthropic/claude-opus-5-5')?.note).toContain('1개만 통과');
  });

  it('lets connected AIs take turns when one does almost all of a tier, and never in a tier the owner ordered', async () => {
    const { control, harness, rows, gateway } = setup(['claude-sonnet-5-5']);
    await control.connect('anthropic', 'sk-ant-1234567890abcdef');
    rows.push({ purpose: 'assistant.turn', providerId: 'mac', model: 'cli', tier: 'standard', calls: 90, failures: 0, costUsd: 0 });
    await harness.review(true);
    expect((await control.harnessState()).changes[0]?.text).toContain('번갈아');
    const routes = gateway.describe().routes.filter((r) => r.tiers.includes('standard')).map((r) => r.providerId);
    expect(new Set(routes)).toEqual(new Set(['mac', 'anthropic']));
    await control.rank('standard', ['anthropic/claude-sonnet-5-5', 'mac/cli']);
    const settings = await control.settings();
    expect(settings.order?.standard).toBeDefined();
  });

  it('offers one resize when work piles up, only for teams the harness sized', async () => {
    const { resizeFor } = await import('../../src/core/bots/team-health.js');
    const team = { id: 'team-x', group: 'g', name: 'X', kind: 'general' as const, tiers: { lead: 'A' as const, staff: 'B' as const }, lead: 'x-lead', staffCount: 3, reviewerCount: 0, decidedBy: 'ai' as const, createdAt: '' };
    const run = (over: object) => ({ at: NOW.toISOString(), tasks: 3, failed: 0, wantedMore: false, overlapped: false, ...over });
    expect(resizeFor(team, [run({}), run({}), run({}), run({}), run({})], NOW, true)).toBeUndefined();
    expect(resizeFor(team, [run({ wantedMore: true }), run({ overlapped: true }), run({ wantedMore: true }), run({}), run({})], NOW, true)).toMatchObject({ staffCount: 4, reviewerCount: 0 });
    expect(resizeFor(team, [run({ failed: 2 }), run({ failed: 2 }), run({ failed: 1 }), run({}), run({})], NOW, true)).toMatchObject({ staffCount: 3, reviewerCount: 1 });
    expect(resizeFor({ ...team, decidedBy: 'owner' }, [run({ wantedMore: true }), run({ wantedMore: true }), run({ wantedMore: true }), run({}), run({})], NOW, true)).toBeUndefined();
  });
});

describe('team composition harness (R16)', () => {
  const input = { name: '결제', purpose: '결제 화면 코드', kind: 'general' as const, overBudget: false, korean: true };
  it('enforces ranges, a reviewer on risky work at least as strong as the lead, and one tier down over budget', () => {
    const checked = checkComposition({ staffCount: 9, reviewerCount: 0, tiers: { lead: 'S', staff: 'B', reviewer: 'C' }, reason: '많이 맡겨요' }, input);
    expect(checked).toMatchObject({ staffCount: 6, reviewerCount: 1, tiers: { lead: 'S', staff: 'B', reviewer: 'S' } });
    expect(checked.reason).toContain('검수 1명을 더했어요');
    const cheap = checkComposition({ staffCount: 2, reviewerCount: 1, tiers: { lead: 'A', staff: 'C', reviewer: 'A' }, reason: 'r' }, { ...input, overBudget: true });
    // the lead stays on S even over budget; risky work keeps the reviewer as strong as the lead
    expect(cheap.tiers).toEqual({ lead: 'S', staff: 'C', reviewer: 'S' });
    expect(defaultComposition({ ...input, name: '여행', purpose: '여행 계획' })).toMatchObject({ staffCount: 3, reviewerCount: 0 });
  });

  it('falls back to the rules when the model answers badly', async () => {
    const llm: LlmGateway = { complete: async () => ({ text: 'no json', providerId: 'f', model: 'm', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }) };
    expect(await decideComposition(llm, input)).toMatchObject({ reviewerCount: 1, tiers: { lead: 'S', reviewer: 'S' } });
  });
});
