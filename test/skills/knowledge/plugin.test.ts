import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { Fact, MemoryReader, ScanResult } from '../../../src/core/contracts/index.js';
import type { StoredLine } from '../../../src/skills/knowledge/store.js';
import { knowledgeSkill } from '../../../src/skills/knowledge/plugin.js';
import { createTestContext, ScriptedLlm } from '../../support/context.js';
import type { TestContextOptions } from '../../support/context.js';
import { line, MemoryDocFs } from './helpers.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');

async function setup(options: TestContextOptions = {}, pluginOptions: { dir?: string; fs?: MemoryDocFs } = {}) {
  const context = createTestContext(options);
  await knowledgeSkill(pluginOptions).setup(context.ctx);
  return context;
}

function scanResult(): ScanResult {
  return {
    profile: [
      line({
        area: 'profile',
        topic: 'role',
        key: 'role',
        text: '엔지니어',
        sources: ['scan:profile.md'],
        at: '2026-11-01T09:00:00+09:00',
      }),
    ],
    projects: [
      line({
        area: 'project',
        topic: 'Acme',
        key: 'purpose',
        text: '결제 앱',
        sources: ['scan:acme.md'],
        at: '2026-11-02T09:00:00+09:00',
      }),
    ],
  };
}

describe('knowledgeSkill', () => {
  it('provides both capabilities, registers the read-only tools and a daily rebuild', async () => {
    const context = await setup();

    expect(knowledgeSkill().manifest).toMatchObject({ id: 'skill.knowledge', kind: 'skill', title: 'Knowledge base' });
    expect(context.provided.has(Contracts.knowledgeProfile.id)).toBe(true);
    expect(context.provided.has(Contracts.knowledgeWrite.id)).toBe(true);
    expect(context.registry.list().map((tool) => tool.name).sort()).toEqual(['knowledge.read', 'knowledge.search']);
    expect(context.scheduler.jobs.get('knowledge.rebuild')?.schedule).toEqual({ kind: 'daily', at: '04:50' });
  });

  it('reads rebuildAt and falls back to defaults on invalid config', async () => {
    const configured = await setup({ config: { rebuildAt: '05:30' } });
    expect(configured.scheduler.jobs.get('knowledge.rebuild')?.schedule).toEqual({ kind: 'daily', at: '05:30' });

    const invalid = await setup({ config: { rebuildAt: '25:00' } });
    expect(invalid.scheduler.jobs.get('knowledge.rebuild')?.schedule).toEqual({ kind: 'daily', at: '04:50' });
  });

  it('writes documents when a directory and filesystem are given', async () => {
    const fs = new MemoryDocFs();
    const context = await setup({}, { dir: '/kb', fs });

    await context.ctx.use(Contracts.knowledgeWrite).replaceScan(scanResult());

    expect(fs.files.has('/kb/README.md')).toBe(true);
    expect(fs.files.has('/kb/프로필.md')).toBe(true);
    expect(fs.files.has('/kb/프로젝트/Acme.md')).toBe(true);
  });
});

describe('review answers', () => {
  it('applies a correction and keeps it when the source is scanned again', async () => {
    const context = await setup();
    const writer = context.ctx.use(Contracts.knowledgeWrite);
    const reader = context.ctx.use(Contracts.knowledgeProfile);
    await writer.replaceScan(scanResult());

    const [role] = await reader.reviewLines();
    expect(role).toBeDefined();
    await context.bus.emit('review.answer', {
      reviewId: 'knowledge.profile',
      itemId: role?.id ?? '',
      verdict: 'corrected',
      text: '시니어 엔지니어',
    });

    expect(await reader.summary(600)).toContain('시니어 엔지니어');

    await writer.replaceScan(scanResult());
    expect(await reader.summary(600)).toContain('시니어 엔지니어');
    expect(await reader.summary(600)).not.toContain('하는 일: 엔지니어. ');
  });

  it('keeps a tombstone across later scans', async () => {
    const context = await setup();
    const writer = context.ctx.use(Contracts.knowledgeWrite);
    const reader = context.ctx.use(Contracts.knowledgeProfile);
    await writer.replaceScan(scanResult());
    const [role] = await reader.reviewLines();

    await context.bus.emit('review.answer', {
      reviewId: 'knowledge.profile',
      itemId: role?.id ?? '',
      verdict: 'removed',
    });
    await writer.replaceScan(scanResult());

    const review = await reader.reviewLines();
    expect(review.some((item) => item.id === role?.id)).toBe(false);
  });

  it('ignores an empty correction, an unknown item and another review id', async () => {
    const context = await setup();
    const writer = context.ctx.use(Contracts.knowledgeWrite);
    const reader = context.ctx.use(Contracts.knowledgeProfile);
    await writer.replaceScan(scanResult());
    const [role] = await reader.reviewLines();

    await context.bus.emit('review.answer', {
      reviewId: 'knowledge.profile',
      itemId: role?.id ?? '',
      verdict: 'corrected',
      text: '   ',
    });
    await context.bus.emit('review.answer', { reviewId: 'knowledge.profile', itemId: 'missing', verdict: 'removed' });
    await context.bus.emit('review.answer', { reviewId: 'other.review', itemId: role?.id ?? '', verdict: 'removed' });

    expect(await reader.summary(600)).toContain('엔지니어');
    await expect(writer.correct('missing', 'x')).rejects.toThrow(/No knowledge line/);
  });
});

describe('memory import', () => {
  const facts: Fact[] = [
    {
      id: 'f1',
      subject: 'owner',
      text: '회의는 오전에 몰아서',
      source: { kind: 'chat' },
      at: '2026-11-17T08:00:00+09:00',
      strength: 1,
    },
    {
      id: 'f2',
      subject: 'owner',
      text: '이미 검토한 인터뷰 답변',
      source: { kind: 'interview', ref: 'review:abc' },
      at: '2026-11-16T08:00:00+09:00',
      strength: 1,
    },
    {
      id: 'f3',
      subject: 'owner',
      text: '약해진 기억',
      source: { kind: 'chat' },
      at: '2026-01-01T08:00:00+09:00',
      strength: 0.1,
    },
  ];

  async function memoryContext(options: TestContextOptions = {}) {
    const reader: MemoryReader = { recall: async () => facts };
    const llm = new ScriptedLlm(['{"areas":{"f1":"money"}}']);
    return setup({
      llm,
      ...options,
      capabilities: { [Contracts.memoryRead.id]: reader, ...(options.capabilities ?? {}) },
    });
  }

  it('imports qualifying facts on app.started and classifies them once', async () => {
    const context = await memoryContext();

    await context.bus.emit('app.started', { at: NOW });

    const stored = (await context.kv.get<StoredLine[]>('lines')) ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      area: 'money',
      topic: '나',
      text: '회의는 오전에 몰아서',
      sources: ['memory:chat'],
      origin: 'memory',
    });
    expect(await context.kv.get('areaCache')).toEqual({ f1: 'money' });

    const outcome = await context.ctx.tools.execute('knowledge.search', { query: '회의', limit: 5 });
    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') expect(outcome.output).toHaveLength(1);
  });

  it('does the same on the daily rebuild job', async () => {
    const context = await memoryContext();

    await context.scheduler.run('knowledge.rebuild', NOW);

    const stored = (await context.kv.get<StoredLine[]>('lines')) ?? [];
    expect(stored.map((entry) => entry.text)).toEqual(['회의는 오전에 몰아서']);
  });

  it('runs quietly when no memory capability is connected', async () => {
    const context = await setup();

    await expect(context.bus.emit('app.started', { at: NOW })).resolves.toBeUndefined();
    expect(await context.kv.get('lines')).toBeUndefined();
  });
});
