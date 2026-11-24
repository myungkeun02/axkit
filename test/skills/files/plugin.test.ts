import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { filesSkill } from '../../../src/skills/files/plugin.js';
import { createTestContext } from '../../support/context.js';
import type { TestContextOptions } from '../../support/context.js';
import { FakeFileSource, entry } from './helpers.js';

async function setup(options: TestContextOptions = {}, source = new FakeFileSource('local')) {
  const context = createTestContext({
    ...options,
    capabilities: { [Contracts.filesLocal.id]: source, ...(options.capabilities ?? {}) },
  });
  await filesSkill().setup(context.ctx);
  return { ...context, source };
}

describe('filesSkill', () => {
  it('registers the index job, the read-only tools and the owner-only share tool', async () => {
    const { scheduler, registry } = await setup();

    expect(scheduler.jobs.get('files.index')?.schedule).toEqual({ kind: 'every', seconds: 3_600 });
    expect(registry.list().map((tool) => tool.name).sort()).toEqual([
      'files.changes',
      'files.find',
      'files.read',
      'files.search',
      'files.share_to_app',
    ]);
    const effects = Object.fromEntries(registry.list().map((tool) => [tool.name, tool.effects.join(',')]));
    expect(effects).toEqual({
      'files.changes': 'read',
      'files.find': 'read',
      'files.read': 'read',
      'files.search': 'read',
      'files.share_to_app': 'write',
    });
  });

  it('reads indexSeconds from config and falls back on invalid values', async () => {
    const configured = await setup({ config: { indexSeconds: 600 } });
    expect(configured.scheduler.jobs.get('files.index')?.schedule).toEqual({ kind: 'every', seconds: 600 });

    const invalid = await setup({ config: { indexSeconds: 5 } });
    expect(invalid.scheduler.jobs.get('files.index')?.schedule).toEqual({ kind: 'every', seconds: 3_600 });
  });

  it('has no required capabilities so it starts with either source alone', () => {
    expect(filesSkill().manifest.needs).toBeUndefined();
    expect(filesSkill().manifest).toMatchObject({ id: 'skill.files', kind: 'skill', title: 'Files' });
  });

  it('indexes a connected source and answers search through the tools', async () => {
    const source = new FakeFileSource('local').add(
      entry({ id: 'plan.md', modifiedAt: '2026-11-17T01:00:00.000Z' }),
      'The plan mentions 회의록 and a deadline.',
    );
    const { ctx, scheduler } = await setup({}, source);

    await scheduler.run('files.index', new Date('2026-11-17T12:00:00.000Z'));
    const outcome = await ctx.tools.execute('files.search', { query: '회의록', limit: 5 });

    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') {
      expect(outcome.output).toEqual([
        expect.objectContaining({ source: 'local', id: 'plan.md', path: 'Files/plan.md' }),
      ]);
    }
  });
});
