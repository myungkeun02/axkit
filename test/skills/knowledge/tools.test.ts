import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import type { ToolRunContext } from '../../../src/core/tools/types.js';
import { KnowledgeBuilder } from '../../../src/skills/knowledge/builder.js';
import { knowledgeTexts } from '../../../src/skills/knowledge/locale.js';
import { KnowledgeStore } from '../../../src/skills/knowledge/store.js';
import { knowledgeReadTool, knowledgeSearchTool } from '../../../src/skills/knowledge/tools.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';
import { line } from './helpers.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');
const texts = knowledgeTexts('ko');
const call: ToolRunContext = { log: silentLogger, signal: new AbortController().signal, call: { grounding: [] } };

async function setup(lines: Parameters<KnowledgeStore['replaceOrigin']>[1] = []) {
  const kv = new MapKeyValueStore();
  const store = new KnowledgeStore(kv);
  await store.load();
  await store.replaceOrigin('scan', lines);
  const builder = new KnowledgeBuilder({
    store,
    kv,
    writer: undefined,
    texts,
    clock: new FakeClock(NOW),
    timeZone: 'Asia/Seoul',
    log: silentLogger,
  });
  await builder.rebuild();
  return { store, builder };
}

const workLine = line({
  area: 'work',
  topic: '회사',
  key: 'w1',
  text: '회의 준비와 일정',
  sources: ['memory:chat'],
  at: '2026-11-10T09:00:00+09:00',
});
const hobbyLine = line({
  area: 'life',
  topic: '나',
  key: 'h1',
  text: '주말 등산',
  sources: ['memory:calendar:c1'],
  at: '2026-11-11T09:00:00+09:00',
});

describe('knowledge.search', () => {
  it('ranks by token overlap, drops zero-overlap lines and cites the document', async () => {
    const { store } = await setup([workLine, hobbyLine]);
    const tool = knowledgeSearchTool({ store, texts });

    const hits = await tool.run({ query: '회의 준비', limit: 5 }, call);

    expect(hits).toEqual([
      {
        doc: '분야/일.md',
        topic: '회사',
        text: '회의 준비와 일정',
        sources: ['memory:chat'],
        date: '2026-11-10',
      },
    ]);
  });

  it('puts the line with more matching words first and respects the limit', async () => {
    const { store } = await setup([workLine, hobbyLine]);
    const tool = knowledgeSearchTool({ store, texts });

    const hits = await tool.run({ query: '회의 등산 준비', limit: 1 }, call);

    expect(hits.map((hit) => hit.text)).toEqual(['회의 준비와 일정']);
  });

  it('never returns a tombstoned line', async () => {
    const { store } = await setup([workLine]);
    await store.correct(store.visible()[0]?.id ?? '', undefined, NOW.toISOString());
    const tool = knowledgeSearchTool({ store, texts });

    expect(await tool.run({ query: '회의', limit: 5 }, call)).toEqual([]);
  });
});

describe('knowledge.read', () => {
  it('returns a rendered document and clips it to 8000 characters', async () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      line({
        area: 'profile',
        topic: 'role',
        key: `role-${index}`,
        text: '긴 설명 '.repeat(40),
        at: `2026-11-${String((index % 9) + 1).padStart(2, '0')}T09:00:00+09:00`,
      }),
    );
    const { builder } = await setup(many);
    const tool = knowledgeReadTool({ builder });

    const readme = await tool.run({ doc: 'README' }, call);
    expect(readme.doc).toBe('README');
    expect(readme.markdown).toContain('# 지식 문서');

    const profile = await tool.run({ doc: 'profile' }, call);
    expect(profile.markdown).toHaveLength(8_000);
  });

  it('lists available documents when the name is unknown', async () => {
    const { builder } = await setup([workLine]);
    const tool = knowledgeReadTool({ builder });

    await expect(tool.run({ doc: '없는문서' }, call)).rejects.toThrow(/Unknown knowledge document.*README/);
  });
});
