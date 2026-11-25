import { describe, expect, it } from 'vitest';
import type { FileEntry, FileSource } from '../../core/contracts/files.js';
import type { Clock } from '../../core/scheduler/types.js';
import { driveView } from './drive-view.js';

const NOW = new Date('2026-11-24T12:00:00+09:00');
const clock = { now: () => NOW, setTimeout, clearTimeout } as unknown as Clock;
const entry = (name: string, modifiedAt: string): FileEntry => ({ id: name, name, path: `Drive/Plans/${name}`, size: 1, modifiedAt });
const source = (label: string, entries: FileEntry[] | Error, title?: string): FileSource => ({
  label,
  ...(title !== undefined ? { title } : {}),
  list: async () => [],
  readText: async () => '',
  recent: async () => {
    if (entries instanceof Error) throw entries;
    return entries;
  },
});

type Blocks = { kind: string; title?: string; text?: string; rows?: { title: string; detail?: string; message?: string }[] }[];

describe('drive view', () => {
  it('shows every account newest first, grouped by day, with the account when there are several', async () => {
    const view = driveView({
      sources: () => [
        source('local', [entry('skip.md', '2026-11-24T02:00:00Z')]),
        source('drive', [entry('plan.gdoc', '2026-11-23T01:00:00Z')]),
        source('drive:a2', [entry('budget.xlsx', '2026-11-24T01:00:00Z')], 'Google Drive · work@y.test'),
      ],
      clock,
      timeZone: 'Asia/Seoul',
    });
    const { blocks } = (await view.read(new URLSearchParams())) as { blocks: Blocks };
    const lists = blocks.filter((block) => block.kind === 'list' && block.title !== undefined);
    expect(lists.map((list) => list.title)).toEqual(['오늘 · 1건', '어제 · 1건']);
    expect(lists[0]?.rows?.[0]).toMatchObject({ title: 'budget.xlsx', detail: 'Drive/Plans · work@y.test' });
    expect(lists[1]?.rows?.[0]?.message).toContain('plan.gdoc');
    expect(JSON.stringify(blocks)).not.toContain('skip.md');
  });

  it('says which account could not be read and explains when Drive is not connected', async () => {
    const view = driveView({ sources: () => [source('drive', [entry('a', '2026-11-24T01:00:00Z')]), source('drive:a2', new Error('x'), 'Google Drive · work@y.test')], clock, timeZone: 'Asia/Seoul' });
    expect(JSON.stringify(await view.read(new URLSearchParams()))).toContain('work@y.test의 드라이브를 지금 읽지 못했어요');
    const none = driveView({ sources: () => [], clock, timeZone: 'Asia/Seoul' });
    expect(JSON.stringify(await none.read(new URLSearchParams()))).toContain('연결돼 있지 않아요');
  });
});
