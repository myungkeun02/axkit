import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { KvDocStore } from '../../../src/core/docs/kv-doc-store.js';
import { docsSkill } from '../../../src/skills/docs/plugin.js';
import { fileNameOf, mirrorDocs } from '../../../src/skills/docs/mirror.js';
import type { MirrorFs } from '../../../src/skills/docs/mirror.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-18T09:00:00+09:00');

class MemoryFs implements MirrorFs {
  readonly files = new Map<string, string>();
  readonly dirs: string[] = [];
  writes = 0;
  async mkdir(dir: string): Promise<void> {
    this.dirs.push(dir);
  }
  async read(file: string): Promise<string | undefined> {
    return this.files.get(file);
  }
  async write(file: string, data: string): Promise<void> {
    this.writes += 1;
    this.files.set(file, data);
  }
}

async function seeded(): Promise<KvDocStore> {
  const docs = new KvDocStore(new MapKeyValueStore(), () => NOW);
  await docs.upsert({
    id: 'company:team:ops',
    kind: 'team',
    scope: 'team:ops',
    title: '운영',
    body: '일정·문서 정리',
    author: { kind: 'policy', id: 'config' },
    basedOnFacts: ['f1'],
  });
  await docs.append('company:team:ops', { text: '첫 작업 끝', author: { kind: 'agent', id: 'member:ops' }, sources: [] });
  return docs;
}

describe('docs skill', () => {
  it('lists, shows and verifies documents through tools', async () => {
    const docs = await seeded();
    await docs.flagFact('f1', '출시 전');
    const test = createTestContext({ now: NOW, capabilities: { [Contracts.docs.id]: docs } });
    await docsSkill().setup(test.ctx);

    const listed = await test.ctx.tools.execute('knowledge.docs', { needsReview: true });
    expect(listed).toMatchObject({ status: 'done', output: { docs: [{ id: 'company:team:ops', needsReview: true }] } });

    const shown = await test.ctx.tools.execute('knowledge.doc_show', { id: 'company:team:ops' });
    expect(shown.status === 'done' && JSON.stringify(shown.output)).toContain('다시 확인 필요: 출시 전');

    expect((await test.ctx.tools.execute('knowledge.doc_verify', { id: 'company:team:ops' })).status).toBe('done');
    expect((await docs.get('company:team:ops'))?.needsReview).toBe(false);
  });

  it('mirrors documents as Markdown files and rewrites only changed ones', async () => {
    const docs = await seeded();
    const fs = new MemoryFs();
    expect(await mirrorDocs(docs, '/k/docs', '확인 필요', fs)).toBe(1);
    const text = fs.files.get(`/k/docs/${fileNameOf('company:team:ops')}`);
    expect(text).toContain('# 운영');
    expect(text).toContain('첫 작업 끝 (member:ops)');
    expect(await mirrorDocs(docs, '/k/docs', '확인 필요', fs)).toBe(0);
    expect(fileNameOf('company:team:ops')).toBe('company__team__ops.md');
  });

  it('registers the mirror job only with a folder', async () => {
    const without = createTestContext({ now: NOW });
    await docsSkill().setup(without.ctx);
    expect(without.scheduler.jobs.has('docs.mirror')).toBe(false);

    const fs = new MemoryFs();
    const test = createTestContext({ now: NOW, capabilities: { [Contracts.docs.id]: await seeded() } });
    await docsSkill({ dir: '/k/docs', fs }).setup(test.ctx);
    await test.scheduler.run('docs.mirror', NOW);
    expect(fs.writes).toBe(1);
  });
});
