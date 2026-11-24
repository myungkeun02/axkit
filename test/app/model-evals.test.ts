import { describe, expect, it } from 'vitest';
import { afterEval, evaluateModel } from '../../src/app/model-evals.js';
import type { LlmProvider } from '../../src/core/llm/types.js';
import { RoutingLlmGateway } from '../../src/core/llm/gateway.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { KvBotDirectory } from '../../src/core/bots/directory.js';
import { buildTeam, resizeTeam } from '../../src/core/bots/teams.js';
import { MapKeyValueStore } from '../core/helpers.js';

describe('model test set', () => {
  it('scores a model on JSON, Korean and exact answers', async () => {
    const good: LlmProvider = {
      id: 'g',
      complete: async (_m, request) => {
        const p = String(request.messages[0]?.content);
        const text = p.includes('JSON') ? '{"sum": 5}' : p.includes('요약') ? '다음 주 금요일까지 결제 화면 설계안을 만든다.' : '바나나';
        return { text, providerId: 'g', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } };
      },
    };
    expect(await evaluateModel(good, 'm')).toMatchObject({ passed: 3, total: 3, costUsd: 0.003 });
    const bad: LlmProvider = { id: 'b', complete: async () => ({ text: 'Sure! Here you go.', providerId: 'b', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }) };
    const result = await evaluateModel(bad, 'm');
    expect(result.passed).toBe(0);
    expect(afterEval(['deep'], result).tiers).toEqual(['standard']);
    expect(afterEval(['fast', 'cheap'], { ...result, passed: 2 }).tiers).toEqual(['fast', 'cheap']);
  });

  it('rotates the first provider in a spread tier', async () => {
    const seen: string[] = [];
    const make = (id: string): LlmProvider => ({ id, complete: async (model) => (seen.push(id), { text: 'ok', providerId: id, model, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }) });
    const gateway = new RoutingLlmGateway({
      providers: [make('a'), make('b')],
      routes: [{ providerId: 'a', model: 'x', tiers: ['fast'], maxSensitivity: 'sensitive' }, { providerId: 'b', model: 'y', tiers: ['fast'], maxSensitivity: 'sensitive' }],
      budget: { dailyUsd: 10, monthlyUsd: 100 },
      ledger: { record: async () => undefined, spentUsd: async () => 0 },
      timeZone: 'UTC',
      log: silentLogger,
    });
    const call = () => gateway.complete({ purpose: 'p', tier: 'fast', sensitivity: 'public', messages: [] });
    await call();
    await call();
    expect(seen).toEqual(['a', 'a']);
    gateway.setSpread(new Set(['fast']));
    await call();
    await call();
    expect(seen.slice(2)).toEqual(['a', 'b']);
  });

  it('resizes a team without deleting anyone', async () => {
    const directory = new KvBotDirectory(new MapKeyValueStore(), () => new Date());
    await buildTeam(directory, { group: 'g', name: 'Ops', kind: 'general', origin: 'owner' }, true, new Date());
    await resizeTeam(directory, 'team-ops', 4, 1, true, 'owner');
    let bots = await directory.list();
    expect(bots.filter((b) => b.team === 'team-ops' && b.status !== 'off').map((b) => b.id).sort()).toEqual(['ops-lead', 'ops-review', 'ops-s1', 'ops-s2', 'ops-s3', 'ops-s4']);
    await resizeTeam(directory, 'team-ops', 2, 0, true, 'owner');
    bots = await directory.list();
    expect(bots.find((b) => b.id === 'ops-s4')?.status).toBe('off');
    expect((await directory.teams())[0]).toMatchObject({ staffCount: 2, reviewerCount: 0, decidedBy: 'owner' });
  });
});
