import { describe, expect, it } from 'vitest';
import type { FileEntry, FileSource } from '../../../src/core/contracts/files.js';
import { Proposals, changesOf, findFile, learnApplyTool } from '../../../src/skills/knowledge/learn.js';
import { lineId } from '../../../src/skills/knowledge/ids.js';
import { KnowledgeStore } from '../../../src/skills/knowledge/store.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { line } from './helpers.js';

const entry = (name: string): FileEntry => ({ id: `id-${name}`, name, path: `Drive/${name}`, size: 1, modifiedAt: '2026-11-24T00:00:00Z' });
const source = (label: string, names: string[]): FileSource => ({ label, list: async () => [], readText: async () => '', recent: async () => names.map(entry) });

async function storeWith(...lines: ReturnType<typeof line>[]) {
  const store = new KnowledgeStore(new MapKeyValueStore());
  await store.load();
  if (lines.length > 0) await store.replaceOrigin('scan', lines);
  return store;
}

describe('learning from a file the owner chose', () => {
  it('finds the file by name on Drive, exact before partial and without the extension', async () => {
    const sources = [source('local', ['사업계획 초안.md']), source('drive', ['2026 사업계획.gdoc', '사업계획'])];
    expect((await findFile(sources, { name: '사업계획' }))?.entry.name).toBe('사업계획');
    expect((await findFile(sources, { name: '2026 사업계획' }))?.entry.name).toBe('2026 사업계획.gdoc');
    expect(await findFile(sources, { name: '없는 파일' })).toBeUndefined();
  });

  it('shows what changes, asks on a card, and keeps the lines after the next scan', async () => {
    const store = await storeWith(line({ area: 'profile', topic: 'role', key: 'title', text: '팀장' }));
    const proposals = new Proposals(() => 1_000);
    const proposal = proposals.add('사업계획', [
      { area: 'profile', topic: 'role', key: 'title', text: '사업본부장', sources: ['Drive: 사업계획'], at: 'x' },
      { area: 'project', topic: '신사업', key: 'goal', text: '내년 상반기 출시', sources: ['Drive: 사업계획'], at: 'x' },
    ], store);
    expect(changesOf(proposal)).toEqual([
      { n: 1, doc: '프로필', text: '사업본부장', before: '팀장' },
      { n: 2, doc: '프로젝트 · 신사업', text: '내년 상반기 출시' },
    ]);
    let rebuilt = 0;
    const tool = learnApplyTool({ store, proposals, rebuild: async () => void (rebuilt += 1) });
    const input = { proposal_id: proposal.id, skip: [2] };
    expect(tool.uncertainty?.(input, { grounding: [] })).toBeDefined();
    expect(tool.describe?.(input)).toContain('1. [프로필] 사업본부장 (지금: 팀장)');
    expect(tool.describe?.(input)).not.toContain('신사업');
    expect(await tool.run(input, {} as never)).toMatchObject({ added: 1 });
    expect(rebuilt).toBe(1);
    await store.replaceOrigin('scan', [line({ area: 'profile', topic: 'role', key: 'title', text: '팀장' })]);
    expect(store.get(lineId('profile', 'role', 'title'))).toMatchObject({ text: '사업본부장', origin: 'file' });
    expect(tool.reject?.(input, { grounding: [] })).toContain('사라졌어요');
  });

  it('never writes over a line the owner corrected', async () => {
    const store = await storeWith(line({ area: 'profile', topic: 'role', key: 'title', text: '팀장' }));
    await store.correct(lineId('profile', 'role', 'title'), '대표', 'now');
    const result = await store.addFileLines([{ area: 'profile', topic: 'role', key: 'title', text: '본부장', sources: ['Drive: x'], at: 'x' }]);
    expect(result).toEqual({ added: 0, kept: [lineId('profile', 'role', 'title')] });
    expect(store.get(lineId('profile', 'role', 'title'))?.text).toBe('대표');
  });
});
